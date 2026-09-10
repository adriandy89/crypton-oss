import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@crypton/db';
import { CacheService, DbService } from 'src/libs';
import { PURGE_SCOPES, type PurgeScope } from './dtos';

/** Filas por lote. Un DELETE gigante bloquea la tabla y satura el WAL. */
const BATCH = 5_000;

/**
 * Tope de lotes por peticion: 10 x 5.000 = 50.000 filas.
 *
 * El del worker es 40 porque corre en un cron al que no le espera nadie. Esto
 * responde a una peticion HTTP, y el `TimeoutInterceptor` global la corta a los
 * 80 segundos: pasarse de ahi le daria al administrador un error mientras el
 * borrado sigue por dentro, que es la peor combinacion posible. Con 50.000 se
 * queda holgadamente dentro; si queda mas, se dice y se vuelve a pulsar.
 */
const MAX_BATCHES = 10;

/**
 * Cerrojo PROPIO, distinto del que toma el cron del worker.
 *
 * La primera version compartia `crypton:lock:retention` con `retention.service.ts`
 * para que las dos purgas no compitiesen. Era un error: el worker lo toma cada
 * hora con un TTL de 55 minutos y NO lo suelta al acabar —lo deja expirar—, asi
 * que este endpoint habria respondido 503 durante 55 de cada 60 minutos, y
 * ademas culpando a Redis.
 *
 * Que las dos purgas coincidan es inocuo, y por eso se puede separar: las dos
 * borran por `id IN (SELECT ... LIMIT)`, asi que si una se lleva antes las filas
 * que la otra habia elegido, el DELETE de la segunda afecta a menos y termina.
 * No hay dos escritores peleando por la misma fila, solo trabajo que ya estaba
 * hecho.
 *
 * Lo que este cerrojo si evita es que dos administradores —o el mismo dando dos
 * veces al boton— lancen la misma purga a la vez.
 */
const LOCK_KEY = 'crypton:lock:maintenance';
const LOCK_SEG = 120;

/**
 * Los estados en los que el motor tiene el bot en la mano.
 *
 * Se escribe como SQL porque entra dentro de un `$executeRaw`, y en minusculas
 * no: son los valores del enum de Postgres.
 */
const VIVOS = Prisma.sql`('STARTING','RUNNING','PAUSED','STOPPING')`;

/** Un ambito purgable: que tabla, por que fecha, con que suelo y que respeta. */
interface Ambito {
  tabla: string;
  /** Suelo de dias. El servidor lo impone; la pantalla solo lo enseña. */
  sueloDias: number;
  /** La variable que gobierna la purga AUTOMATICA de esta tabla, para enseñarla. */
  variable: string;
  porDefecto: number;
  descripcion: string;
}

const AMBITOS: Record<PurgeScope, Ambito> = {
  BOT_SNAPSHOTS: {
    tabla: 'bot_snapshots',
    sueloDias: 15,
    variable: 'RETENTION_SNAPSHOT_DAYS',
    porDefecto: 30,
    descripcion: 'La serie por minuto de cada bot. Solo alimenta las gráficas.',
  },
  BOT_EVENTS: {
    tabla: 'bot_events',
    sueloDias: 15,
    variable: 'RETENTION_EVENT_DAYS',
    porDefecto: 90,
    descripcion: 'La bitácora de cada bot. Los ERROR y CRITICAL no se purgan aquí.',
  },
  BOT_COMMANDS: {
    tabla: 'bot_commands',
    sueloDias: 15,
    variable: 'RETENTION_COMMAND_DAYS',
    porDefecto: 90,
    descripcion: 'Comandos ya ejecutados. Los pendientes son trabajo por hacer, no historial.',
  },
  PORTFOLIO_SNAPSHOTS: {
    tabla: 'portfolio_snapshots',
    sueloDias: 15,
    variable: 'RETENTION_PORTFOLIO_DAYS',
    porDefecto: 365,
    descripcion: 'La curva de cartera. Solo de usuarios sin ningún bot en marcha.',
  },
  BACKTESTS: {
    tabla: 'backtest_runs',
    sueloDias: 15,
    variable: '(ninguna)',
    porDefecto: 0,
    descripcion: 'Simulaciones sobre velas y sus fills. Hoy no las purga ningún cron.',
  },
  ACTIVITY_LOG: {
    tabla: 'activity_log',
    sueloDias: 90,
    variable: 'RETENTION_AUDIT_DAYS',
    porDefecto: 180,
    descripcion: 'La bitácora de la plataforma. Las filas CRITICAL no se purgan nunca.',
  },
};

/**
 * Purga manual de históricos (spec 034).
 *
 * La regla que gobierna todo este fichero, y la razón de que el `WHERE` de cada
 * ámbito sea más largo de lo que parecería necesario:
 *
 *   **Ninguna purga puede tocar una fila que pertenezca a un bot en marcha.**
 *
 * No es cautela decorativa. Los snapshots de un bot que está operando son la
 * gráfica que su dueño mira ahora mismo, y sus eventos recientes son lo que
 * consulta cuando algo va raro. El cron automático sí los purga —con ventanas
 * largas y fijas, decididas en un despliegue—; una persona pulsando un botón con
 * un selector a quince días es otra cosa.
 *
 * Lo demás que protege:
 *
 * · Un **suelo** por ámbito que el servidor impone. La bitácora lo tiene en 90
 *   días, y ese número es la respuesta a una pregunta incómoda: un administrador
 *   con un botón para borrar `activity_log` puede borrar el rastro de sus
 *   propias acciones. El suelo y la protección de los `CRITICAL` acotan eso; la
 *   propia purga queda registrada como acción crítica.
 * · Los `bot_events` `ERROR` y `CRITICAL` y las filas `CRITICAL` de la bitácora
 *   **no se borran nunca desde aquí**, elija lo que elija quien pulse. Son justo
 *   los que se van a mirar cuando algo salga mal.
 * · Se **cuenta antes de borrar**, y contar no borra.
 */
@Injectable()
export class AdminMaintenanceService {
  private readonly logger = new Logger(AdminMaintenanceService.name);

  constructor(
    private readonly db: DbService,
    private readonly cache: CacheService,
    private readonly config: ConfigService,
  ) {}

  /** Qué hay guardado y con qué reglas, para pintar la pantalla. */
  async estado() {
    const ambitos = await Promise.all(
      PURGE_SCOPES.map(async (scope) => {
        const def = AMBITOS[scope];
        return {
          scope,
          tabla: def.tabla,
          descripcion: def.descripcion,
          sueloDias: def.sueloDias,
          /** La retención automática vigente. `0` = purga desactivada. */
          retencionAutomaticaDias:
            def.porDefecto === 0 ? null : Number(this.config.get(def.variable, def.porDefecto)),
          variable: def.variable,
          filas: await this.total(scope),
        };
      }),
    );
    return { ambitos };
  }

  /**
   * Cuántas filas caerían. NO borra.
   *
   * Existe porque esto no tiene deshacer: quien va a pulsar el botón tiene que
   * ver el número antes, y tiene que ser el número de verdad —el mismo `WHERE`
   * que usará el borrado, no una estimación parecida.
   */
  async contar(scope: PurgeScope, days: number): Promise<number> {
    this.assertSuelo(scope, days);
    const rows = await this.db.$queryRaw<{ n: bigint }[]>`
      SELECT count(*)::bigint AS n FROM (${this.seleccion(scope, days, false)}) AS purgables`;
    return Number(rows[0]?.n ?? 0);
  }

  async purgar(scope: PurgeScope, days: number): Promise<{ borradas: number; completo: boolean }> {
    this.assertSuelo(scope, days);

    // Marca propia de esta peticion: es lo que permite soltar el cerrojo solo si
    // sigue siendo nuestro. Sin ella, una purga que se pasara del TTL borraria al
    // salir el cerrojo que otra acabara de tomar.
    const marca = randomUUID();
    const tomado = await this.cache.setnx(LOCK_KEY, marca, LOCK_SEG);
    if (!tomado) {
      // Sin Redis, `setnx` devuelve false igual que si estuviera cogido: se
      // prefiere NO ejecutar, como hace `LeaseService.tryLock` en el worker.
      throw new ServiceUnavailableException(
        'Hay otra purga en curso (o Redis no responde). Inténtalo en un minuto.',
      );
    }

    try {
      let borradas = 0;
      let completo = true;
      for (let i = 0; i < MAX_BATCHES; i++) {
        const n = await this.db.$executeRaw`
          DELETE FROM ${Prisma.raw(`"${AMBITOS[scope].tabla}"`)}
          WHERE id IN (${this.seleccion(scope, days, true)})`;
        borradas += n;
        if (n < BATCH) break;
        // Se agotó el tope y aún quedaban: se dice, en vez de dejar creer que
        // la tabla quedó limpia.
        if (i === MAX_BATCHES - 1) completo = false;
      }
      this.logger.log(`Purga manual de ${scope} (>${days} d): ${borradas} fila(s).`);
      return { borradas, completo };
    } finally {
      // Solo si sigue siendo nuestro: si el TTL venció a mitad de purga, el
      // cerrojo que hay ahí puede ser de otro y borrarlo sería quitárselo.
      if ((await this.cache.get<string>(LOCK_KEY)) === marca) {
        await this.cache.del(LOCK_KEY);
      }
    }
  }

  /** Cuánto hay guardado que sea purgable en algún momento. Sin corte de fecha. */
  private async total(scope: PurgeScope): Promise<number> {
    const rows = await this.db.$queryRaw<{ n: bigint }[]>`
      SELECT count(*)::bigint AS n FROM (${this.seleccion(scope, 0, false)}) AS purgables`;
    return Number(rows[0]?.n ?? 0);
  }

  private assertSuelo(scope: PurgeScope, days: number): void {
    const suelo = AMBITOS[scope].sueloDias;
    if (days < suelo) {
      throw new BadRequestException(
        `${AMBITOS[scope].tabla} no se puede purgar por debajo de ${suelo} días.`,
      );
    }
  }

  /**
   * El `SELECT` de las filas purgables. **Uno solo**, y lo usan tanto el recuento
   * como el borrado.
   *
   * Que sean el mismo no es economía de líneas: es la única forma de que el
   * número que se le enseña a quien va a pulsar el botón sea el número de filas
   * que realmente van a desaparecer. Dos consultas parecidas se separan a la
   * tercera vez que alguien toca una de las dos.
   */
  private seleccion(scope: PurgeScope, days: number, conLimite: boolean): Prisma.Sql {
    const corte = new Date(Date.now() - days * 86_400_000);
    const limite = conLimite ? Prisma.sql`LIMIT ${BATCH}` : Prisma.empty;

    // La exclusión que gobierna el spec, escrita una vez.
    const deBotParado = Prisma.sql`bot_id NOT IN (SELECT id FROM bots WHERE status IN ${VIVOS})`;

    switch (scope) {
      case 'BOT_SNAPSHOTS':
        return Prisma.sql`
          SELECT id FROM bot_snapshots
          WHERE taken_at < ${corte} AND ${deBotParado}
          ${limite}`;

      case 'BOT_EVENTS':
        // Los ERROR y CRITICAL quedan fuera pase lo que pase: son los que se van
        // a mirar cuando algo salga mal, y el cron ya los conserva un año.
        return Prisma.sql`
          SELECT id FROM bot_events
          WHERE created_at < ${corte}
            AND severity IN ('DEBUG','INFO','WARN')
            AND ${deBotParado}
          ${limite}`;

      case 'BOT_COMMANDS':
        // Por `executed_at` y no por `created_at`: lo que se purga es trabajo
        // hecho. Un comando sin ejecutar es trabajo pendiente, por viejo que sea.
        return Prisma.sql`
          SELECT id FROM bot_commands
          WHERE executed_at IS NOT NULL AND executed_at < ${corte}
            AND ${deBotParado}
          ${limite}`;

      case 'PORTFOLIO_SNAPSHOTS':
        // Aquí el ancla es el USUARIO, no el bot: la curva de cartera de alguien
        // que está operando es la que ve en su pantalla, y purgarla a quince días
        // le dejaría el selector de un año rotulando un corte que no es.
        return Prisma.sql`
          SELECT id FROM portfolio_snapshots
          WHERE taken_at < ${corte}
            AND user_id NOT IN (SELECT DISTINCT user_id FROM bots WHERE status IN ${VIVOS})
          ${limite}`;

      case 'BACKTESTS':
        // Sin exclusión por bot: un backtest corre sobre velas guardadas y no
        // toca ningún bot ni ninguna posición. Sus fills caen en cascada.
        return Prisma.sql`
          SELECT id FROM backtest_runs
          WHERE created_at < ${corte}
          ${limite}`;

      case 'ACTIVITY_LOG':
        // No se filtra por bot: la bitácora es transversal y hacerlo no
        // significaría nada. Lo que la protege es el suelo de 90 días y que los
        // CRITICAL no se tocan.
        return Prisma.sql`
          SELECT id FROM activity_log
          WHERE created_at < ${corte} AND severity <> 'CRITICAL'
          ${limite}`;
    }
  }
}

import { randomUUID } from 'node:crypto';
import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type RedisClientType } from 'redis';
import { AuditOutcome, EventSeverity } from '@crypton/shared';
import { AuditService } from '../libs';

/**
 * Arrendamiento (lease) de bots.
 *
 * Un bot solo puede tener UN dueño a la vez. Si dos workers ejecutaran el mismo
 * bot, ambos verían "falta la seguridad 3" y ambos la colocarían: posición
 * duplicada y capital comprometido al doble sin que nadie lo pidiera.
 *
 * El lease vive en Redis con TTL corto y se renueva en segundo plano. Si un
 * worker muere —o se queda colgado y deja de renovar— el lease caduca solo y
 * otro worker adopta el bot. No hace falta ningún proceso que detecte la caída.
 *
 * La liberación usa un script Lua de comparar-y-borrar: sin él, un worker que
 * volviera en sí tras una pausa larga podría borrar el lease que otro ya
 * hubiera adquirido legítimamente.
 */

const RELEASE_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
else
  return 0
end`;

/**
 * Renueva TODOS los leases del proceso en una sola ida y vuelta.
 *
 * Antes era un bucle con un `eval` por bot. Con mil bots y cinco milisegundos
 * de latencia eso son cinco segundos de los diez que hay de margen antes de que
 * el TTL caduque: el propio mecanismo que evita el doble dueño se convertía en
 * la causa de perderlo.
 *
 * Devuelve la lista de índices que NO se pudieron renovar (el lease ya es de
 * otro), para que el llamante suelte esos bots y solo esos.
 */
const RENEW_ALL_SCRIPT = `
local perdidos = {}
for i, key in ipairs(KEYS) do
  if redis.call('get', key) == ARGV[1] then
    redis.call('pexpire', key, ARGV[2])
  else
    perdidos[#perdidos + 1] = i
  end
end
return perdidos`;

const leaseKey = (botId: string): string => `crypton:lease:bot:${botId}`;

/** Cuántas claves entran en un script de renovación. */
const RENEW_BATCH = 200;

@Injectable()
export class LeaseService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(LeaseService.name);
  private client!: RedisClientType;

  /** Identidad de ESTE proceso. Cambia en cada arranque a propósito. */
  readonly workerId = `worker-${process.pid}-${randomUUID().slice(0, 8)}`;

  private ttlMs = 30_000;
  private renewTimer: NodeJS.Timeout | null = null;
  private readonly held = new Set<string>();
  /** Momento de la última renovación CONFIRMADA por Redis. */
  private lastConfirmedRenew = Date.now();

  /**
   * Se avisa al motor de los bots que hay que soltar ya.
   *
   * Lo pone `EngineService` al arrancar. Sin esto, el aviso de "he perdido el
   * lease" tardaba hasta un barrido entero en surtir efecto.
   */
  onLeaseLost: (botIds: string[], reason: string) => void = () => undefined;

  constructor(
    private readonly config: ConfigService,
    private readonly audit: AuditService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.ttlMs = Number(this.config.get('WORKER_LEASE_TTL_MS', 30_000));
    this.client = createClient({
      url: this.config.get<string>('REDIS_URL', 'redis://localhost:6379'),
      password: this.config.get<string>('REDIS_PASSWORD'),
    }) as RedisClientType;
    this.client.on('error', (e) => this.logger.error('Redis (lease): ' + e.message));
    await this.client.connect();

    // Se renueva a un tercio del TTL: deja margen para dos fallos seguidos de
    // red antes de que el lease caduque y otro worker se lleve el bot.
    this.renewTimer = setInterval(() => void this.renewAll(), Math.floor(this.ttlMs / 3));
    this.logger.log(`Leases activos como ${this.workerId} (TTL ${this.ttlMs} ms)`);
  }

  /**
   * Se libera en `onApplicationShutdown`, que es lo ÚLTIMO que ejecuta Nest.
   *
   * Estaba en `onModuleDestroy`, que corre ANTES de que el motor cierre sus
   * runners: se soltaban los leases mientras los bots seguían operando, así que
   * otro worker podía adoptarlos y ejecutarlos en paralelo durante ese hueco.
   * Justo las órdenes duplicadas que el lease existe para impedir.
   *
   * El orden correcto es siempre: runners fuera → leases sueltos.
   */
  async onApplicationShutdown(): Promise<void> {
    if (this.renewTimer) clearInterval(this.renewTimer);
    this.renewTimer = null;
    // Liberar al apagar acorta el relevo: sin esto habría que esperar al TTL.
    await Promise.allSettled([...this.held].map((botId) => this.release(botId)));
    await this.client?.quit().catch(() => undefined);
  }

  /** Intenta adquirir el lease. false = otro worker ya lo tiene. */
  async acquire(botId: string): Promise<boolean> {
    const ok = await this.client.set(leaseKey(botId), this.workerId, {
      NX: true,
      PX: this.ttlMs,
    });
    if (ok) this.held.add(botId);
    return ok !== null;
  }

  async release(botId: string): Promise<void> {
    this.held.delete(botId);
    try {
      await this.client.eval(RELEASE_SCRIPT, {
        keys: [leaseKey(botId)],
        arguments: [this.workerId],
      });
    } catch (e) {
      this.logger.warn(`No se pudo liberar el lease de ${botId}: ${(e as Error).message}`);
    }
  }

  holds(botId: string): boolean {
    return this.held.has(botId);
  }

  /**
   * Cerrojo con caducidad para tareas que solo debe hacer UN worker.
   *
   * Vive aquí porque este servicio ya es el dueño de los cerrojos distribuidos
   * del proceso y de su conexión a Redis. Lo usa el resumen diario de Telegram:
   * con `@Cron` a secas corría en todos los workers y cada usuario recibía
   * tantos resúmenes como réplicas hubiera levantadas.
   *
   * No se renueva ni se libera: el TTL es la ventana de exclusión, y para una
   * tarea que se ejecuta una vez al día eso es exactamente lo que hace falta.
   */
  async tryLock(name: string, ttlMs: number): Promise<boolean> {
    try {
      const ok = await this.client.set(`crypton:lock:${name}`, this.workerId, {
        NX: true,
        PX: ttlMs,
      });
      return ok !== null;
    } catch (e) {
      // Sin Redis no se puede garantizar la exclusión. Se prefiere NO ejecutar:
      // duplicar avisos es peor que saltarse uno.
      this.logger.warn(`No se pudo tomar el cerrojo ${name}: ${(e as Error).message}`);
      return false;
    }
  }

  heldBots(): string[] {
    return [...this.held];
  }

  get count(): number {
    return this.held.size;
  }

  /**
   * Renueva todos los leases del proceso, por lotes y en un solo script.
   *
   * Dos cosas se deciden aquí:
   *
   * · Los que se han perdido —porque este proceso estuvo detenido más que el
   *   TTL— se sacan de la lista y se avisa al motor para que pare sus runners.
   *
   * · Si Redis no responde durante más de un TTL entero, se sueltan TODOS. Sin
   *   esto, un corte de Redis de cuarenta segundos dejaba caducar los leases al
   *   otro lado —otro worker los adoptaba— mientras este seguía creyendo que
   *   eran suyos y operando: cerebro dividido, con los dos mandando órdenes.
   *   Ante la duda se prefiere parar a duplicar.
   */
  private async renewAll(): Promise<void> {
    const ids = [...this.held];
    if (ids.length === 0) {
      this.lastConfirmedRenew = Date.now();
      return;
    }

    const perdidos: string[] = [];
    try {
      for (let i = 0; i < ids.length; i += RENEW_BATCH) {
        const lote = ids.slice(i, i + RENEW_BATCH);
        const result = (await this.client.eval(RENEW_ALL_SCRIPT, {
          keys: lote.map(leaseKey),
          arguments: [this.workerId, String(this.ttlMs)],
        })) as number[];
        for (const idx of result ?? []) {
          const botId = lote[idx - 1]; // Lua indexa desde 1.
          if (botId) perdidos.push(botId);
        }
      }
      this.lastConfirmedRenew = Date.now();
    } catch (e) {
      this.logger.error(`Error renovando leases: ${(e as Error).message}`);
      const sinConfirmar = Date.now() - this.lastConfirmedRenew;
      if (sinConfirmar > this.ttlMs) {
        this.logger.error(
          `Sin confirmar leases desde hace ${sinConfirmar} ms (TTL ${this.ttlMs}): ` +
            'se sueltan todos los bots para no operar con un lease que ya puede ser de otro.',
        );
        const todos = [...this.held];
        this.held.clear();
        // La protección contra cerebro dividido: sin este registro, el
        // incidente más grave del motor —soltar TODOS los bots porque no se
        // puede confirmar que sus leases sigan siendo nuestros— solo existía
        // como una línea en stdout de un contenedor sin rotación.
        this.audit.record({
          action: 'worker.leases_released_all',
          severity: EventSeverity.CRITICAL,
          outcome: AuditOutcome.ERROR,
          message: 'Redis inalcanzable más de un TTL: se sueltan todos los bots.',
          meta: { bots: todos.length, sinConfirmarMs: sinConfirmar, ttlMs: this.ttlMs },
        });
        this.onLeaseLost(todos, 'Redis inalcanzable más de un TTL');
      }
      return;
    }

    if (perdidos.length > 0) {
      for (const botId of perdidos) this.held.delete(botId);
      this.logger.warn(`${perdidos.length} lease(s) perdido(s): se detienen sus runners.`);
      // Un lease adoptado por otro worker es el escenario en el que dos
      // procesos pueden haber operado el mismo bot: queda por escrito.
      this.audit.record({
        action: 'worker.leases_lost',
        severity: EventSeverity.WARN,
        outcome: AuditOutcome.ERROR,
        message: 'Leases adoptados por otro worker.',
        meta: { bots: perdidos.length },
      });
      this.onLeaseLost(perdidos, 'lease adoptado por otro worker');
    }
  }
}

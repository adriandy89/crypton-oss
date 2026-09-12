import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { BotStatus, Prisma } from '@crypton/db';
import { ActorKind, AuditOutcome, EventSeverity } from '@crypton/shared';
import { AuditService, BUS_CHANNELS, BusService, DbService, PageDto, PageMetaDto } from 'src/libs';
import { BotsService } from '../bots';
import type { AdminBotRow } from './admin.types';
import { ADMIN_COMMANDS, type AdminBotCommandDto, type AdminBotsQueryDto } from './dtos';

/** Cuantos usuarios como mucho resuelve el atajo de «buscame por correo». */
const MAX_DUEÑOS = 50;

@Injectable()
export class AdminBotsService {
  constructor(
    private readonly db: DbService,
    private readonly bots: BotsService,
    private readonly bus: BusService,
    private readonly audit: AuditService,
  ) {}

  /**
   * El dueño de un bot, y solo eso: un `select` de una columna.
   *
   * Es la pieza que permite que la consola reutilice `BotsService` ENTERO sin
   * tocarle una linea a `mustOwn`. Con el `user_id` de verdad en la mano, cada
   * lectura se pide como la pediria su dueño y la comprobacion de propiedad
   * sigue siendo cierta en lugar de relajada.
   *
   * La alternativa era admitir un `userId` nulo en `mustOwn`. No se hizo a
   * proposito: ese parametro es el UNICO sitio donde vive la propiedad de un
   * bot, hay quince llamadas que dependen de que sea obligatorio, y en cuanto
   * aceptase `undefined` un `mustOwn(user?.id, id)` en cualquier ruta de usuario
   * normal compilaria y devolveria el bot de cualquiera, sin excepcion y sin
   * registro. Ningun test de los que hay se enteraria.
   *
   * Cuesta una consulta de mas por peticion. En una consola que usa una persona
   * eso no se nota; un agujero de aislamiento si.
   */
  private async ownerOf(botId: string): Promise<string> {
    const bot = await this.db.bot.findUnique({
      where: { id: botId },
      select: { user_id: true },
    });
    if (!bot) throw new NotFoundException('Bot no encontrado.');
    return bot.user_id;
  }

  async list(query: AdminBotsQueryDto): Promise<PageDto<AdminBotRow>> {
    const where = await this.buildWhere(query);
    if (where === null) {
      // El filtro por correo no caso con nadie: no hay por que preguntar por bots.
      return new PageDto([], new PageMetaDto({ pageOptions: query, itemCount: 0 }));
    }
    const skip = (query.page - 1) * query.limit;

    const [rows, itemCount] = await Promise.all([
      this.db.bot.findMany({
        where,
        orderBy: { [query.sortBy ?? 'created_at']: query.sortOrder },
        take: query.limit,
        skip,
        select: {
          ...BOT_SELECT,
          user: { select: { id: true, email: true, name: true, disabled: true } },
          exchange_account: { select: { paper: true, testnet: true } },
        },
      }),
      this.db.bot.count({ where }),
    ]);

    return new PageDto(
      rows.map((r) => toRow(r)),
      new PageMetaDto({ pageOptions: query, itemCount }),
    );
  }

  async detail(botId: string) {
    const owner = await this.ownerOf(botId);
    const [bot, dueño] = await Promise.all([
      this.bots.detail(owner, botId),
      this.db.user.findUnique({
        where: { id: owner },
        select: { id: true, email: true, name: true, disabled: true },
      }),
    ]);

    // `BotsService.detail()` devuelve la fila cruda de Prisma con `...bot`, asi
    // que estos tres llegan en snake_case mientras que las metricas calculadas
    // llegan en camelCase. La pantalla de administracion los pinta —el aviso de
    // error es LA razon por la que un administrador abre este detalle— y leyendo
    // el nombre camelCase salian siempre `undefined`, sin fallar ni avisar.
    //
    // Se normalizan AQUI y no en `BotsService`: alli cambiaria el contrato del
    // endpoint que ya consume la app de los usuarios. Anotado como 033/F-02.
    return {
      ...bot,
      lastError: bot.last_error,
      startedAt: bot.started_at,
      lastTickAt: bot.last_tick_at,
      owner: dueño,
    };
  }

  // Las lecturas de historico: mismo patron, resolver dueño y delegar. Ninguno
  // de estos metodos abre adaptador ni descifra nada — los que si lo hacen
  // (`capital`, `preview`, `readWallet`) no estan expuestos, y este modulo ni
  // siquiera importa `ExchangeAccountsModule` para que no puedan estarlo.
  async orders(botId: string, limit?: number, offset?: number) {
    return this.bots.orders(await this.ownerOf(botId), botId, limit, offset);
  }

  async fills(botId: string, limit?: number, offset?: number) {
    return this.bots.fills(await this.ownerOf(botId), botId, limit, offset);
  }

  async cycles(botId: string, limit?: number, offset?: number) {
    return this.bots.cycles(await this.ownerOf(botId), botId, limit, offset);
  }

  async events(botId: string, limit?: number, offset?: number) {
    return this.bots.events(await this.ownerOf(botId), botId, limit, offset);
  }

  async revisions(botId: string, limit?: number, offset?: number) {
    return this.bots.revisions(await this.ownerOf(botId), botId, limit, offset);
  }

  async levels(botId: string) {
    return this.bots.levels(await this.ownerOf(botId), botId);
  }

  /**
   * Un comando de CONTENCION sobre el bot de otra persona.
   *
   * Lo que hace esto y no hace `BotsService.command()` es decidir el permiso: el
   * vocabulario recortado, quien firma la fila y el aviso al dueño.
   */
  async command(admin: { id: string }, botId: string, dto: AdminBotCommandDto) {
    const owner = await this.ownerOf(botId);

    // Segunda puerta, redundante con el `@IsIn(ADMIN_COMMANDS)` del DTO y
    // deliberada: aquel protege ESTA ruta, esto protege el metodo el dia que otro
    // controlador lo llame. Una validacion que solo vive en el borde se cae en
    // cuanto el borde se mueve.
    if (!ADMIN_COMMANDS.includes(dto.command)) {
      throw new ForbiddenException(
        'Un administrador solo puede pausar o parar conservando la posicion. ' +
          'Nada que cierre la posicion, realice el resultado o retire el stop-loss.',
      );
    }

    const res = await this.bots.command(
      owner,
      botId,
      { command: dto.command },
      { requestedBy: admin.id },
    );

    // La fila con el `bot_id` puesto, y a mano.
    //
    // Sin esto la columna quedaria a null: `audit.interceptor.ts` solo la rellena
    // cuando la accion empieza por `bot.`, y esta empieza por `admin.`. Perder la
    // correlacion con `bot_events` es perder media investigacion. Ademas este es
    // el unico sitio que conoce al dueño ya resuelto, y ese dato es justo el que
    // hace util la fila. Va sin `@Audit` A PROPOSITO: que nadie lo «arregle».
    await this.audit.recordNow({
      actor: ActorKind.ADMIN,
      actorId: admin.id,
      botId,
      action: 'admin.bot.command',
      severity: EventSeverity.WARN,
      outcome: AuditOutcome.OK,
      message: `${dto.command} sobre un bot ajeno: ${dto.reason}`,
      meta: { command: dto.command, ownerId: owner, reason: dto.reason },
    });

    // Y se avisa al DUEÑO, en directo.
    //
    // El `bot_events` que escribe la API no se publica en el bus —solo lo hace el
    // worker con los suyos—, asi que sin esto el dueño no se enteraria de que le
    // han pausado el bot hasta que abriese esa pantalla. En una plataforma no
    // custodial, que un tercero toque tu bot y no te enteres es indefendible.
    //
    // Y durante un tiempo NO se enteraba, por dos motivos a la vez (spec 046,
    // R-27): el notificador descartaba todo evento cuyo origen no fuera el suyo
    // —y el de la API no es el de ningun worker—, y ademas esto se publicaba sin
    // `severity` ni `message`, de modo que la via generica, que exige WARN o
    // mas, tampoco lo habria entregado. `entregaForzada` arregla lo primero y
    // estas dos claves lo segundo. El texto va aqui y no en el notificador
    // porque es el unico sitio que sabe QUE se hizo y POR QUE.
    await this.bus
      .publish(BUS_CHANNELS.BOT_EVENTS, {
        userId: owner,
        botId,
        type: 'ADMIN_COMMAND',
        entregaForzada: true,
        data: {
          command: dto.command,
          reason: dto.reason,
          severity: EventSeverity.WARN,
          message: `Soporte ha ejecutado ${dto.command} sobre este bot: ${dto.reason}`,
        },
      })
      .catch(() => undefined);

    return res;
  }

  /**
   * El `where` del listado global. `null` = el filtro por correo no caso con
   * nadie, y entonces no hay nada que preguntarle a `bots`.
   */
  private async buildWhere(query: AdminBotsQueryDto): Promise<Prisma.BotWhereInput | null> {
    const where: Prisma.BotWhereInput = {};

    if (query.userId) {
      where.user_id = query.userId;
    } else if (query.email) {
      // En DOS pasos y no con un `where: { user: { email: ... } }`, que Prisma
      // convierte en una subconsulta correlacionada sobre `users` ejecutada dos
      // veces —filas y total—. Asi el listado consulta `bots` por `user_id`, que
      // es una columna indexada. El tope acota el coste pase lo que pase.
      const dueños = await this.db.user.findMany({
        where: { email: { startsWith: query.email, mode: 'insensitive' } },
        select: { id: true },
        take: MAX_DUEÑOS,
      });
      if (dueños.length === 0) return null;
      where.user_id = { in: dueños.map((u) => u.id) };
    }

    if (query.venue) where.venue = query.venue;
    if (query.symbol) where.symbol = query.symbol;
    if (query.strategy) where.strategy = query.strategy;
    if (query.status) where.status = query.status;
    if (query.dryRun !== undefined) where.dry_run = query.dryRun;
    if (query.withError) where.last_error = { not: null };

    return where;
  }
}

/** Las columnas de `bots` que el listado llega a leer. */
const BOT_SELECT = {
  id: true,
  name: true,
  venue: true,
  symbol: true,
  strategy: true,
  status: true,
  direction: true,
  leverage: true,
  margin_mode: true,
  dry_run: true,
  total_investment: true,
  last_error: true,
  started_at: true,
  last_tick_at: true,
  created_at: true,
  updated_at: true,
} as const;

/**
 * La fila publica de un bot.
 *
 * El parametro enumera lo que entra: si mañana se añade una columna sensible a
 * `bots`, este mapper no la conoce y no puede publicarla por descuido. El
 * `total_investment` sale con `toFixed()` porque es dinero y el dinero viaja
 * como `string` (invariante 1); dejar salir el `Decimal` seria confiar la
 * serializacion de un importe a lo que decida `decimal.js`.
 */
function toRow(b: {
  id: string;
  name: string;
  venue: AdminBotRow['venue'];
  symbol: string;
  strategy: AdminBotRow['strategy'];
  status: BotStatus;
  direction: AdminBotRow['direction'];
  leverage: number;
  margin_mode: AdminBotRow['marginMode'];
  dry_run: boolean;
  total_investment: { toFixed(): string };
  last_error: string | null;
  started_at: Date | null;
  last_tick_at: Date | null;
  created_at: Date;
  updated_at: Date | null;
  user: { id: string; email: string; name: string; disabled: boolean };
  exchange_account: { paper: boolean; testnet: boolean };
}): AdminBotRow {
  return {
    id: b.id,
    name: b.name,
    owner: b.user,
    venue: b.venue,
    symbol: b.symbol,
    strategy: b.strategy,
    status: b.status,
    direction: b.direction,
    leverage: b.leverage,
    marginMode: b.margin_mode,
    dryRun: b.dry_run,
    paper: b.exchange_account.paper,
    testnet: b.exchange_account.testnet,
    totalInvestment: b.total_investment.toFixed(),
    lastError: b.last_error,
    startedAt: b.started_at?.toISOString() ?? null,
    lastTickAt: b.last_tick_at?.toISOString() ?? null,
    createdAt: b.created_at.toISOString(),
    updatedAt: b.updated_at?.toISOString() ?? null,
  };
}

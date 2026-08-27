import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { DryRunState } from '@crypton/exchange-core';
import { DbService } from '../libs';

/**
 * Estado guardado, con el epoch con el que se leyó.
 *
 * El epoch viaja con el estado y no aparte porque es lo único que hace segura
 * la escritura: quien guarda tiene que devolver el mismo que cargó.
 */
export interface LoadedPaperState {
  state: DryRunState | null;
  epoch: number;
  /** Capital de partida del bot, para cuando todavía no hay estado. */
  startingBalance: string;
}

/**
 * El sandbox de un bot simulado, guardado.
 *
 * Existe porque la simulación vivía SOLO en la memoria del `DryRunAdapter`: un
 * reinicio del worker —o que otro worker adoptara el bot tras un reequilibrado
 * de leases— devolvía el saldo al de partida y borraba posiciones y órdenes,
 * mientras `bot_orders`, `bot_fills` y `bot_cycles` seguían en la base. El bot
 * quedaba discutiendo con su propio libro, y quien estaba probando la
 * plataforma ANTES de poner dinero veía un motor que parecía roto.
 *
 * Cuelga del BOT y no de la cuenta, y esa es la diferencia que lo hace correcto:
 * los leases del motor son por bot, así que con el estado colgado de la cuenta
 * dos bots simulados en procesos distintos escribían aquí a la vez —hacía falta
 * una columna de dueño solo para detectarlo—. Colgado del bot, el lease que ya
 * protege `bot_orders` y `bot_cycles` protege también esto, sin vigilancia
 * añadida.
 */
@Injectable()
export class PaperStateStore {
  private readonly logger = new Logger(PaperStateStore.name);

  constructor(
    private readonly db: DbService,
    private readonly config: ConfigService,
  ) {}

  async load(botId: string): Promise<LoadedPaperState> {
    const bot = await this.db.bot.findUniqueOrThrow({
      where: { id: botId },
      select: {
        paper_state: true,
        exchange_account: { select: { paper_balance: true } },
      },
    });

    // El capital de partida es de la CONEXIÓN y vale para cada uno de sus bots
    // simulados: es «con cuánto empieza cada prueba», no un saldo compartido.
    //
    // Solo las conexiones de simulación lo tienen. Un bot simulado sobre una
    // conexión REAL no tiene ninguno que mirar, y ahí manda `DRY_RUN_BALANCE`,
    // que es donde ese valor ha vivido siempre: la variable sigue en el compose
    // y en los dos `.env.example`, y dejar de leerla habría cambiado en silencio
    // el saldo de quien la tuviera puesta.
    const startingBalance =
      bot.exchange_account.paper_balance?.toFixed() ??
      this.config.get<string>('DRY_RUN_BALANCE', '10000');
    const row = bot.paper_state;
    if (!row) return { state: null, epoch: 0, startingBalance };

    return {
      epoch: row.epoch,
      startingBalance,
      state: {
        balance: row.balance.toFixed(),
        realizedPnl: row.realized_pnl.toFixed(),
        feesPaid: row.fees_paid.toFixed(),
        seq: row.seq,
        // Se guardaron tal y como los volcó el simulador, así que vuelven tal
        // cual. El tipo de Prisma para JSON es deliberadamente opaco y aquí es
        // donde se le devuelve su forma.
        positions: (row.positions ?? []) as unknown as DryRunState['positions'],
        orders: (row.orders ?? []) as unknown as DryRunState['orders'],
      },
    };
  }

  /**
   * Epoch actual del sandbox, sin traerse el estado entero.
   *
   * Sirve para lo que hace `AccountHub` antes de reutilizar un simulador que
   * lleva un rato ocioso: comprobar que sigue siendo el bueno. Es una fila
   * diminuta y solo se pregunta al adoptar un bot, no en cada tick.
   */
  async epochOf(botId: string): Promise<number> {
    const row = await this.db.paperState.findUnique({
      where: { bot_id: botId },
      select: { epoch: true },
    });
    return row?.epoch ?? 0;
  }

  /**
   * Guarda el estado, salvo que la simulación se haya reiniciado por medio.
   *
   * El `epoch` es lo que resuelve la carrera: un adaptador que todavía viva en
   * este worker se cierra por inactividad hasta treinta segundos después de que
   * el usuario pulse «reiniciar», y sin esta comprobación su última escritura
   * resucitaba el estado que se acababa de tirar. Devuelve false cuando ha
   * descartado, para que quien llama sepa que su adaptador ya no manda.
   */
  async save(botId: string, epoch: number, state: DryRunState): Promise<boolean> {
    // Los importes llegan ya normalizados por el simulador (`toFixed`), asi que
    // se pasan tal cual: Prisma acepta la cadena para una columna Decimal.
    const data = {
      balance: state.balance,
      realized_pnl: state.realizedPnl,
      fees_paid: state.feesPaid,
      seq: state.seq,
      positions: state.positions as never,
      orders: state.orders as never,
    };

    // `updateMany` y no `upsert` porque el epoch tiene que entrar en el WHERE:
    // un upsert por clave primaria escribiría igualmente pasando por encima del
    // reinicio.
    const { count } = await this.db.paperState.updateMany({
      where: { bot_id: botId, epoch },
      data,
    });
    if (count > 0) return true;

    // No había fila todavía: es la primera vez que este bot guarda estado. Si el
    // epoch ya no es el que se cargó, la fila SÍ existe y el `create` choca
    // contra la clave primaria — que es justo lo que se quiere.
    try {
      await this.db.paperState.create({ data: { bot_id: botId, epoch, ...data } });
      return true;
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === 'P2002') {
        this.logger.debug(`Sandbox de ${botId.slice(0, 8)} descartado: la simulación se reinició.`);
        return false;
      }
      // El bot ya no existe: lo borraron mientras su simulador seguia vivo. No
      // es un fallo que reintentar, es un sandbox que ya no tiene dueño.
      if (code === 'P2003') {
        this.logger.debug(`El bot ${botId.slice(0, 8)} ya no existe: su sandbox no se guarda.`);
        return false;
      }
      throw e;
    }
  }
}

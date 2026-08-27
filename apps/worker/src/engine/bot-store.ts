import { Injectable, Logger } from '@nestjs/common';
import {
  D,
  Decimal,
  type CycleState,
  type DesiredOrder,
  type Fill,
  type MarketSpec,
  type OrderAck,
  type VenueOrder,
} from '@crypton/shared';
import {
  ENTRY_KINDS,
  QTY_EPSILON,
  botShortId,
  cycleAfterFill,
  parseCoid,
} from '@crypton/strategy-core';
import type {
  BotStatus,
  Direction,
  LevelKind,
  MarginMode,
  OrderKind,
  OrderSide,
  StrategyKind,
  Venue,
} from '@crypton/db';
import { BUS_CHANNELS, BusService, DbService } from '../libs';

/**
 * Cliente dentro de una transacción de Prisma.
 *
 * Se deriva del propio `DbService` en vez de escribirlo a mano para que
 * añadir un modelo al esquema no obligue a tocar este tipo.
 */
type TxClient = Parameters<Parameters<DbService['$transaction']>[0]>[0];

export interface BotRecord {
  id: string;
  user_id: string;
  exchange_account_id: string;
  venue: Venue;
  symbol: string;
  strategy: StrategyKind;
  direction: Direction;
  leverage: number;
  margin_mode: MarginMode;
  config_version: number;
  dry_run: boolean;
  total_investment: Decimal | { toString(): string };
}

export interface RiskGuards {
  maxNotionalPerBot: string | null;
  maxDailyLoss: string | null;
  killSwitchDrawdownPct: string | null;
  liquidationAlertPct: string | null;
  /**
   * Estos dos faltaban, y la pantalla de límites promete que «se comprueban al
   * crear un bot Y EN CADA CICLO DEL MOTOR». Solo era cierto para el notional
   * por bot: un bot creado antes de que su dueño pusiera un tope seguía
   * corriendo con su apalancamiento viejo indefinidamente, porque arrancarlo
   * tampoco revalida la configuración.
   */
  maxLeverage: number | null;
  maxTotalNotional: string | null;
}

// `ENTRY_KINDS` y `QTY_EPSILON` estaban definidos aquí y también dentro de la
// aritmética del ciclo. Ahora viven en `strategy-core`, con el cálculo que los
// usa: dos umbrales de «posición plana» que puedan divergir es la peor forma de
// tener uno.

/**
 * Toda la persistencia del motor.
 *
 * Está separada del runner por una razón concreta: el runner es la lógica de
 * "qué hacer" y debe poder leerse de un tirón; esto es el "dónde queda escrito"
 * y tiene su propia complejidad —idempotencia, contabilidad del ciclo, cierre
 * de ciclos— que merece vivir aparte.
 */
/** Cuánto vale la pérdida diaria de un usuario antes de recalcularla. */
const DAILY_PNL_TTL_MS = 20_000;

/**
 * Medianoche en la zona del usuario, expresada en hora absoluta.
 *
 * Se usa el desfase que `Intl` reporta para ESA zona en este momento, así que
 * el corte del día es el que el usuario tiene en su reloj y no el del
 * contenedor —que en Docker es UTC y no coincide con casi nadie.
 */
function startOfDay(timezone: string | null | undefined): Date {
  const now = new Date();
  if (!timezone) {
    const midnight = new Date(now);
    midnight.setHours(0, 0, 0, 0);
    return midnight;
  }
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).formatToParts(now);
    const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? 0);
    // Diferencia entre la hora local del usuario y la UTC, en milisegundos.
    const asUtc = Date.UTC(
      get('year'),
      get('month') - 1,
      get('day'),
      get('hour') % 24,
      get('minute'),
      get('second'),
    );
    const offset = asUtc - now.getTime();
    return new Date(Date.UTC(get('year'), get('month') - 1, get('day')) - offset);
  } catch {
    // Zona desconocida: se cae a la del proceso en vez de fallar. Un límite
    // diario que se corta a la hora equivocada es malo; no comprobarlo, peor.
    const midnight = new Date(now);
    midnight.setHours(0, 0, 0, 0);
    return midnight;
  }
}

@Injectable()
export class BotStore {
  private readonly logger = new Logger(BotStore.name);
  private readonly dailyLoss = new Map<string, { value: Decimal; at: number }>();
  private readonly dailyLossByBot = new Map<string, { value: Decimal; at: number }>();
  private readonly totalNotional = new Map<string, { value: Decimal; at: number }>();

  constructor(
    private readonly db: DbService,
    private readonly bus: BusService,
  ) {}

  // ═══════════════════════════════════════════════════════════════
  // Estado del bot
  // ═══════════════════════════════════════════════════════════════

  async setStatus(
    botId: string,
    status: BotStatus,
    opts: { error?: string; clearError?: boolean } = {},
  ): Promise<void> {
    await this.db.bot.update({
      where: { id: botId },
      data: {
        status,
        ...(opts.clearError ? { last_error: null } : {}),
        ...(opts.error ? { last_error: opts.error } : {}),
        ...(status === 'STOPPED' ? { stopped_at: new Date() } : {}),
      },
    });
  }

  /**
   * Latido del bot en la tabla `bots`.
   *
   * `force` existe porque este UPDATE se hacía en CADA tick de CADA bot: con
   * mil bots latiendo cada quince segundos son sesenta y siete escrituras por
   * segundo sobre la misma tabla, y todas para mover una marca de tiempo que
   * nadie mira con esa precisión. Ahora se escribe una vez por minuto, o antes
   * si la nota —que sí es visible en la app— ha cambiado.
   */
  async touchTick(botId: string, note: string | null, force: boolean): Promise<void> {
    if (!force) return;
    await this.db.bot.update({
      where: { id: botId },
      data: { last_tick_at: new Date(), note },
    });
  }

  /**
   * Registra un evento y lo publica en el bus.
   *
   * Las dos cosas siempre juntas: la fila es la verdad auditable y el mensaje
   * es lo que hace que el móvil se entere al instante. Publicar sin guardar
   * dejaría eventos que se pierden si nadie está mirando.
   */
  async event(
    bot: { id: string; user_id: string },
    type: string,
    severity: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'CRITICAL',
    message: string,
    payload?: Record<string, unknown>,
  ): Promise<void> {
    await this.db.botEvent.create({
      data: {
        bot_id: bot.id,
        type,
        severity,
        message,
        payload: (payload ?? null) as never,
      },
    });
    await this.bus
      .publish(BUS_CHANNELS.BOT_EVENTS, {
        userId: bot.user_id,
        botId: bot.id,
        type,
        data: { severity, message, ...(payload ?? {}) },
      })
      .catch(() => undefined);
  }

  // ═══════════════════════════════════════════════════════════════
  // Órdenes
  // ═══════════════════════════════════════════════════════════════

  findOrderByCoid(clientOrderId: string) {
    return this.db.botOrder.findUnique({
      where: { client_order_id: clientOrderId },
    });
  }

  /**
   * Ids de cliente de las órdenes que este bot tiene vivas.
   *
   * Es lo que permite cancelar SOLO lo propio en vez de barrer el símbolo o la
   * cuenta entera. Se lee de la base y no del libro del venue a propósito:
   * aquí está la constancia de todo lo que este bot mandó, incluidas las que
   * quedaron PENDING sin acuse y que en el libro pueden estar o no.
   *
   * `keepProtective` deja fuera el STOP_LOSS. Lo piden las rutas que cancelan
   * SIN cerrar la posición: barrerlo también dejaba la posición apalancada
   * desnuda justo cuando el bot deja de vigilarla —al pausar por una guarda de
   * riesgo, que es cuando más falta hace—. El stop vive en el venue, así que
   * sigue protegiendo aunque el motor se caiga entero.
   */
  async liveOrderCoids(botId: string, opts?: { keepProtective?: boolean }): Promise<string[]> {
    const rows = await this.db.botOrder.findMany({
      where: {
        bot_id: botId,
        status: { in: ['PENDING', 'OPEN', 'PARTIALLY_FILLED'] },
        ...(opts?.keepProtective ? { level_kind: { not: 'STOP_LOSS' } } : {}),
      },
      select: { client_order_id: true },
    });
    return rows.map((r) => r.client_order_id);
  }

  /**
   * Ids en espacio de venue que este bot ha emitido en los ciclos dados.
   *
   * Es la fuente autoritativa para reconocer huérfanas: toda orden del motor
   * se registra ANTES de salir hacia el venue, así que un id que no esté aquí
   * no es nuestro. Sostiene la consulta el índice (bot_id, cycle_seq).
   */
  async ownVenueClientIds(botId: string, cycleSeqs: number[]): Promise<string[]> {
    const seqs = cycleSeqs.filter((s) => s >= 0);
    if (seqs.length === 0) return [];
    const rows = await this.db.botOrder.findMany({
      where: { bot_id: botId, cycle_seq: { in: seqs }, venue_client_id: { not: null } },
      select: { venue_client_id: true },
    });
    return rows.map((r) => r.venue_client_id as string);
  }

  /** Marca como canceladas las órdenes cuya cancelación se acaba de confirmar. */
  async markCoidsCanceled(botId: string, clientOrderIds: string[]): Promise<void> {
    if (clientOrderIds.length === 0) return;
    await this.db.botOrder
      .updateMany({
        where: {
          bot_id: botId,
          client_order_id: { in: clientOrderIds },
          status: { in: ['PENDING', 'OPEN', 'PARTIALLY_FILLED'] },
        },
        data: { status: 'CANCELED', closed_at: new Date() },
      })
      .catch(() => undefined);
  }

  /**
   * Spec vigente del mercado, tal y como la mantiene el cron de la API.
   *
   * El runner la relee cada cierto tiempo: en Hyperliquid el tick depende de la
   * magnitud del precio, así que la retícula de un activo cambia sola cuando
   * cruza una potencia de diez.
   *
   * La red forma parte de la clave: el tick y el step de testnet no son los de
   * mainnet, y redondear con los que no son deja al bot mandando órdenes que el
   * venue rechaza una por una con un «invalid price» que no explica nada.
   */
  async marketSpec(venue: Venue, symbol: string, testnet: boolean): Promise<MarketSpec> {
    const m = await this.db.market.findUniqueOrThrow({
      where: { venue_testnet_symbol: { venue, testnet, symbol } },
    });
    return {
      venue: m.venue,
      symbol: m.symbol,
      canonical: m.canonical,
      base: m.base,
      quote: m.quote,
      tickSize: m.tick_size.toString(),
      stepSize: m.step_size.toString(),
      minNotional: m.min_notional?.toString() ?? null,
      minQty: m.min_qty?.toString() ?? null,
      maxQty: m.max_qty?.toString() ?? null,
      maxLeverage: m.max_leverage,
      priceDecimals: m.price_decimals,
      qtyDecimals: m.qty_decimals,
      active: m.active,
    };
  }

  /**
   * Deja constancia de la orden ANTES de mandarla al venue.
   *
   * Es la mitad de la garantía de idempotencia: si el proceso muere entre esta
   * escritura y la respuesta del exchange, al reiniciar hay una fila PENDING
   * que dice "puede que esta orden exista", y la reconciliación lo resuelve
   * mirando el libro real. Lo intolerable sería lo contrario: haber mandado una
   * orden sin ninguna constancia de ello.
   */
  async upsertPendingOrder(input: {
    botId: string;
    cycleSeq: number;
    order: DesiredOrder;
    venueClientId: string;
  }): Promise<void> {
    const { botId, cycleSeq, order, venueClientId } = input;
    const data = {
      bot_id: botId,
      client_order_id: order.clientOrderId,
      venue_client_id: venueClientId,
      level_kind: order.levelKind as LevelKind,
      level_index: order.levelIndex,
      cycle_seq: cycleSeq,
      side: order.side as OrderSide,
      kind: order.type as OrderKind,
      price: order.price,
      qty: order.qty,
      reduce_only: order.reduceOnly,
      status: 'PENDING' as const,
      raw_error: null,
    };
    // El update SÍ resetea `filled_qty`: la fila representa la ENCARNACIÓN
    // vigente del id, no su historia. Un id reutilizado (recotización del
    // market maker, nivel de retícula que vuelve) arranca de cero; arrastrar lo
    // ejecutado por encarnaciones anteriores marcaba la nueva como COMPLETA
    // cuando apenas había empezado, y a partir de ahí el motor la daba por
    // hecha y no la volvía a colocar. La historia completa no se pierde: vive
    // en `bot_fills`, que es de donde sale la contabilidad del ciclo.
    await this.db.botOrder.upsert({
      where: { client_order_id: order.clientOrderId },
      create: data,
      update: { ...data, filled_qty: 0, closed_at: null },
    });
  }

  async confirmOrder(clientOrderId: string, ack: OrderAck): Promise<void> {
    await this.db.botOrder.update({
      where: { client_order_id: clientOrderId },
      data: {
        venue_order_id: ack.venueOrderId || null,
        status: ack.status,
        raw_error: null,
      },
    });
  }

  async rejectOrder(clientOrderId: string, error: string): Promise<void> {
    await this.db.botOrder
      .update({
        where: { client_order_id: clientOrderId },
        data: { status: 'REJECTED', raw_error: error, closed_at: new Date() },
      })
      .catch(() => undefined);
  }

  /**
   * `botId` es obligatorio, y no es defensa en profundidad: sin él esto
   * corrompía datos de OTRO usuario.
   *
   * `venue_order_id` no es único ni lleva índice, y los espacios de
   * identificadores son por venue: un `oid` de Hyperliquid y un `orderId` de
   * Aster pueden coincidir. Sin filtrar por bot, cancelar una orden marcaba
   * como CANCELED la fila viva de otro — que seguía en el libro del venue. Su
   * reconciliador la daba por perdida y la reponía, duplicando posición.
   */
  async markOrderCanceled(botId: string, venueOrderId: string): Promise<void> {
    await this.db.botOrder
      .updateMany({
        where: {
          bot_id: botId,
          venue_order_id: venueOrderId,
          status: { in: ['PENDING', 'OPEN', 'PARTIALLY_FILLED'] },
        },
        data: { status: 'CANCELED', closed_at: new Date() },
      })
      .catch(() => undefined);
  }

  /** Refleja en la fila lo que el venue dice de la orden. */
  async syncOrderState(botId: string, order: VenueOrder): Promise<void> {
    if (!order.clientOrderId) return;
    await this.db.botOrder
      .updateMany({
        where: { bot_id: botId, venue_client_id: order.clientOrderId },
        data: {
          venue_order_id: order.venueOrderId,
          status: order.status,
          filled_qty: order.filledQty,
          avg_price: order.avgPrice,
          ...(order.status === 'FILLED' || order.status === 'CANCELED'
            ? { closed_at: new Date() }
            : {}),
        },
      })
      .catch(() => undefined);
  }

  // ═══════════════════════════════════════════════════════════════
  // Ejecuciones y ciclo
  // ═══════════════════════════════════════════════════════════════

  /**
   * Guarda una ejecución. Devuelve el id CANÓNICO de la orden a la que
   * pertenece, o null si no es de este bot o ya estaba registrada.
   *
   * Devuelve el id canónico y no un booleano porque el fill llega con el id en
   * espacio de VENUE —un hash en Hyperliquid, un entero en Lighter— y nada de
   * lo que viene después sabe leer eso: la contabilidad del ciclo parsea el id
   * para saber qué nivel se ejecutó, y la memoria de GridMart también. Antes
   * se parseaba el id del venue tal cual: en Hyperliquid y Lighter NUNCA se
   * reconocía, así que el ciclo no anotaba entradas ni niveles llenos, el
   * ancla no se fijaba y GridMart no apuntaba ninguna recompra. Solo Aster,
   * que conserva el id legible, funcionaba como se esperaba.
   *
   * La deduplicación se apoya en el índice único de `venue_fill_id` y no en una
   * comprobación previa: entre el SELECT y el INSERT cabe otra reconexión que
   * traiga el mismo mensaje, y solo la restricción de la base cierra esa
   * ventana de verdad.
   */
  async recordFill(botId: string, fill: Fill): Promise<string | null> {
    const order = fill.clientOrderId
      ? await this.db.botOrder.findFirst({
          where: {
            bot_id: botId,
            OR: [{ venue_client_id: fill.clientOrderId }, { client_order_id: fill.clientOrderId }],
          },
        })
      : await this.db.botOrder.findFirst({
          where: { bot_id: botId, venue_order_id: fill.venueOrderId },
        });

    if (!order) return null; // La ejecución no es de este bot.

    try {
      await this.db.botFill.create({
        data: {
          bot_order_id: order.id,
          venue_fill_id: fill.venueFillId,
          side: fill.side as OrderSide,
          price: fill.price,
          qty: fill.qty,
          fee: fill.fee,
          fee_asset: fill.feeAsset,
          is_taker: fill.isTaker,
          executed_at: new Date(fill.ts),
        },
      });
    } catch (e) {
      // Violación de unicidad = ya lo teníamos. Es el camino esperado tras una
      // reconexión, no un error.
      if ((e as { code?: string }).code === 'P2002') return null;
      throw e;
    }

    // El acumulado se INCREMENTA en la base, no se lee-suma-escribe aquí: dos
    // ejecuciones de la misma orden llegando a la vez leían el mismo valor y la
    // segunda pisaba a la primera.
    const updated = await this.db.botOrder.update({
      where: { id: order.id },
      data: { filled_qty: { increment: fill.qty }, avg_price: fill.price },
      select: { filled_qty: true, qty: true },
    });

    if (D(updated.filled_qty.toString()).gte(updated.qty.toString())) {
      await this.db.botOrder.update({
        where: { id: order.id },
        data: { status: 'FILLED', closed_at: new Date() },
      });
    } else {
      await this.db.botOrder.update({
        where: { id: order.id },
        data: { status: 'PARTIALLY_FILLED' },
      });
    }

    return order.client_order_id;
  }

  /**
   * Anota una ejecución de LIQUIDACIÓN, que no es de ninguna orden nuestra.
   *
   * Cuando un venue liquida, cierra la posición con una orden suya: la ejecución
   * que manda no lleva ningún id que `recordFill` pueda reconocer, así que la
   * descartaba. La posición desaparecía del venue y la contabilidad del bot
   * seguía enseñando la de antes — la pérdida no llegaba nunca a
   * `bot_cycles.realized_pnl` ni a la gráfica.
   *
   * Se le crea una orden SINTÉTICA porque `bot_fills` exige una a la que
   * colgarse, y además es lo correcto de cara al usuario: en el historial se ve
   * POR QUÉ se cerró la posición en lugar de que se esfume sin explicación.
   *
   * El `client_order_id` se deriva del BOT y del id de la ejecución, y ahí está
   * la deduplicación: una reentrega —el barrido REST después del WebSocket, sin
   * ir más lejos— choca contra `uq_bot_order_coid` y se descarta.
   *
   * El bot entra en el id por la misma razón que en `makeCoid`: esa columna es
   * única a nivel GLOBAL y el id de ejecución de un venue no lo es. En Aster el
   * `t` del trade es único por SÍMBOLO, así que dos bots de la misma cuenta
   * liquidados a la vez podían chocar, y el perdedor se descartaba entero —sin
   * fila, sin PnL, sin pausa y sin aviso— creyendo que era un duplicado.
   *
   * No tiene el formato de un coid nuestro a propósito: `parseCoid` devuelve
   * null y `applyFillToCycle` lo trata como lo que es, un cambio de posición sin
   * nivel.
   */
  async recordLiquidation(botId: string, fill: Fill, cycleSeq: number): Promise<string | null> {
    // 64 es el ancho de la columna. `liq:` más 16 hex del bot más el separador
    // dejan 43 para el id de la ejecución, de sobra para los tres venues —donde
    // son numéricos— y para el simulador.
    const coid = `liq:${botShortId(botId)}:${fill.venueFillId}`.slice(0, 64);
    try {
      await this.db.$transaction(async (tx) => {
        const order = await tx.botOrder.create({
          data: {
            bot_id: botId,
            client_order_id: coid,
            // SIN `venue_order_id`, y no es un olvido. `recordFill` busca por él
            // cuando la ejecución no trae client id —que es justo el caso de una
            // liquidación en Hyperliquid—, así que guardarlo hacía que el
            // SEGUNDO trozo de la misma liquidación casara con esta orden y
            // tomara el camino normal: el fill que remata la posición se
            // colaba sin pasar por `afterLiquidation`, y el stop loss que la
            // primera parte había conservado no lo retiraba nadie.
            level_kind: 'LIQUIDATION',
            // Sin nivel: no es un peldaño de la escalera y no debe ocupar
            // ninguno. `LIQUIDATION` tampoco está en `ENTRY_KINDS`, así que no
            // cuenta como entrada ni marca índice.
            level_index: 0,
            cycle_seq: cycleSeq,
            side: fill.side as OrderSide,
            kind: 'MARKET',
            price: fill.price,
            qty: fill.qty,
            filled_qty: fill.qty,
            avg_price: fill.price,
            status: 'FILLED',
            reduce_only: true,
            placed_at: new Date(fill.ts),
            closed_at: new Date(fill.ts),
          },
          select: { id: true },
        });
        await tx.botFill.create({
          data: {
            bot_order_id: order.id,
            venue_fill_id: fill.venueFillId,
            side: fill.side as OrderSide,
            price: fill.price,
            qty: fill.qty,
            fee: fill.fee,
            fee_asset: fill.feeAsset,
            is_taker: fill.isTaker,
            executed_at: new Date(fill.ts),
          },
        });
      });
      return coid;
    } catch (e) {
      // Ya estaba: es el camino esperado cuando la misma liquidación llega por
      // el stream y por el barrido, no un error.
      if ((e as { code?: string }).code === 'P2002') return null;
      throw e;
    }
  }

  /**
   * Contabilidad del ciclo tras una ejecución.
   *
   * Mantiene cantidad neta, precio medio y PnL realizado con la misma lógica
   * que un exchange: al aumentar se promedia ponderando por cantidad; al
   * reducir se realiza contra el medio. Cuando la cantidad vuelve a cero, el
   * ciclo se cierra y se abre el siguiente con su cooldown.
   *
   * Todo ocurre dentro de UNA transacción con la fila del ciclo bloqueada. El
   * cerrojo del runner ya serializa las ejecuciones de un bot dentro de un
   * proceso y el lease garantiza un solo proceso por bot, así que esto es la
   * tercera línea de defensa — pero es la única que sigue en pie si alguna de
   * las dos anteriores falla, y lo que se corrompe si falla es el precio medio
   * y el PnL. Se paga.
   */
  async applyFillToCycle(
    botId: string,
    cycle: CycleState,
    fill: Fill,
    opts: { recycleLevelOnExit?: boolean; trackMmStats?: boolean } = {},
  ): Promise<CycleState> {
    const outcome = await this.db.$transaction(async (tx) => {
      // `FOR UPDATE` sobre el ciclo abierto: cualquier otra transacción que
      // quiera tocarlo espera aquí en vez de leer un valor que está a punto de
      // quedar obsoleto.
      const locked = await tx.$queryRaw<{ id: bigint }[]>`
        SELECT id FROM bot_cycles
        WHERE bot_id = ${botId} AND closed_at IS NULL
        ORDER BY seq DESC
        LIMIT 1
        FOR UPDATE`;
      if (locked.length === 0) return null;

      const dbCycle = await tx.botCycle.findUniqueOrThrow({
        where: { id: locked[0].id },
      });

      // La aritmética la hace `cycleAfterFill`, en `strategy-core`. Aquí solo
      // queda el bloqueo, leer la fila y escribirla: lo que de verdad es de la
      // base. El cálculo se mudó porque tiene un SEGUNDO consumidor —el
      // backtest— y dos copias de la contabilidad del dinero divergen.
      const r = cycleAfterFill(
        cycle,
        {
          qty: D(dbCycle.qty.toString()),
          averageEntry: dbCycle.average_entry ? D(dbCycle.average_entry.toString()) : null,
          realizedPnl: D(dbCycle.realized_pnl.toString()),
          fees: D(dbCycle.fees.toString()),
          entriesFilled: dbCycle.entries_filled,
          filledLevelIndexes: dbCycle.filled_level_indexes,
          anchorPrice: dbCycle.anchor_price ? D(dbCycle.anchor_price.toString()) : null,
          lastEntryAt: dbCycle.last_entry_at ? dbCycle.last_entry_at.getTime() : null,
        },
        fill,
        { recycleLevelOnExit: opts.recycleLevelOnExit },
        Date.now(),
      );

      if (opts.trackMmStats) {
        await this.bumpMmStats(tx, botId, fill, r.matched, r.reduced);
      }

      const { totals, accDelta } = r;
      const isEntry = totals.entriesFilled > dbCycle.entries_filled;
      const averageEntry = totals.averageEntry ?? D(fill.price);

      if (!r.closed) {
        await tx.botCycle.update({
          where: { id: dbCycle.id },
          data: {
            qty: totals.qty.toFixed(),
            average_entry: averageEntry.toFixed(),
            realized_pnl: totals.realizedPnl.toFixed(),
            fees: totals.fees.toFixed(),
            entries_filled: totals.entriesFilled,
            last_entry_at: isEntry ? new Date(fill.ts) : dbCycle.last_entry_at,
            filled_level_indexes: totals.filledLevelIndexes,
            ...(totals.anchorPrice ? { anchor_price: totals.anchorPrice.toFixed() } : {}),
          },
        });

        return { closed: false as const, accDelta, state: r.cycle };
      }

      // La secuencia del ciclo siguiente sale de la BASE, no del scratch: la
      // fila es la autoridad y el scratch solo su reflejo.
      const nextSeq = dbCycle.seq + 1;
      const cooldownMinutes = Number(r.cycle.scratch.cooldownMinutes ?? 0);
      const cooldownUntil = r.cycle.cooldownUntil ? new Date(r.cycle.cooldownUntil) : null;

      await tx.botCycle.update({
        where: { id: dbCycle.id },
        data: {
          closed_at: new Date(),
          qty: '0',
          average_entry: averageEntry.toFixed(),
          exit_avg: fill.price,
          realized_pnl: totals.realizedPnl.toFixed(),
          fees: totals.fees.toFixed(),
          entries_filled: totals.entriesFilled,
        },
      });
      await tx.botCycle.create({
        data: {
          bot_id: botId,
          seq: nextSeq,
          filled_level_indexes: [],
          cooldown_until: cooldownUntil,
          scratch: { cycleSeq: nextSeq, cooldownMinutes } as never,
        },
      });

      return {
        closed: true as const,
        accDelta,
        closedSeq: dbCycle.seq,
        closedPnl: totals.realizedPnl,
        state: { ...r.cycle, scratch: { cycleSeq: nextSeq, cooldownMinutes } },
      };
    });

    if (!outcome) return cycle;

    // El evento se publica FUERA de la transacción: dentro, un aviso lento
    // mantendría la fila del ciclo bloqueada más de lo necesario, y si la
    // transacción acabara revirtiendo ya habríamos anunciado algo que no pasó.
    if (outcome.closed) {
      const bot = await this.db.bot
        .findUnique({ where: { id: botId }, select: { user_id: true } })
        .catch(() => null);
      if (bot) {
        // Se acaba de realizar resultado: la pérdida diaria cacheada de este
        // usuario ya no vale, y de ella depende una guarda de riesgo.
        this.forgetDailyLoss(bot.user_id, botId);
        await this.event(
          { id: botId, user_id: bot.user_id },
          'CYCLE_CLOSED',
          'INFO',
          `Ciclo #${outcome.closedSeq} cerrado con ${outcome.closedPnl.toFixed(2)} de resultado.`,
          { realizedPnl: outcome.closedPnl.toFixed(), seq: outcome.closedSeq },
        ).catch(() => undefined);
      }
    }

    return outcome.state;
  }

  /**
   * Contadores de market making, dentro de la MISMA transacción que el ciclo.
   *
   * Va aquí y no en un servicio aparte por una razón concreta: si el ciclo se
   * escribe y los contadores no, la ficha del bot y su historial dejan de
   * cuadrar sin que nada falle. Compartir transacción hace que o entran los dos
   * o no entra ninguno.
   *
   * Es un `upsert` y no un `update` porque la fila no se crea al nacer el bot:
   * un bot que nunca ejecuta nada no necesita una fila de estadísticas.
   */
  private async bumpMmStats(
    tx: TxClient,
    botId: string,
    fill: Fill,
    matched: Decimal,
    reduced: boolean,
  ): Promise<void> {
    const buy = fill.side === 'BUY' ? 1 : 0;
    const taker = fill.isTaker ? 1 : 0;
    const fee = D(fill.fee);
    const executedAt = new Date(fill.ts);

    await tx.botMmStat.upsert({
      where: { bot_id: botId },
      create: {
        bot_id: botId,
        fills: 1,
        buy_fills: buy,
        sell_fills: 1 - buy,
        maker_fills: 1 - taker,
        taker_fills: taker,
        // Un par casado se cierra cuando una ejecución REDUCE posición. No es
        // lo mismo que `bot_cycles`: ahí un ciclo solo se cierra al volver a
        // plana, y un market maker con inventario permanente no cerraría
        // ninguno en meses aunque esté casando compras y ventas sin parar.
        closed_cycles: reduced ? 1 : 0,
        gross_matched_profit: matched.toFixed(),
        fees_paid: fee.toFixed(),
        last_fill_at: executedAt,
      },
      update: {
        fills: { increment: 1 },
        buy_fills: { increment: buy },
        sell_fills: { increment: 1 - buy },
        maker_fills: { increment: 1 - taker },
        taker_fills: { increment: taker },
        closed_cycles: { increment: reduced ? 1 : 0 },
        gross_matched_profit: { increment: matched.toFixed() },
        fees_paid: { increment: fee.toFixed() },
        last_fill_at: executedAt,
      },
    });
  }

  /**
   * Marcas de agua del bot: mayor inventario y mayor margen vistos nunca.
   *
   * Son el denominador de «efficiency» y de la APR. Sin ellas, un bot que solo
   * tuvo capital diez minutos parecería infinitamente rentable, y uno que
   * acumuló mucho inventario y lo deshizo parecería no haber corrido riesgo.
   *
   * Se escribe solo cuando el máximo SUBE. Con un `update` incondicional en
   * cada snapshot serían cuatro escrituras por minuto y bot para no cambiar
   * nada el 99 % de las veces.
   */
  async trackMmPeaks(botId: string, inventory: Decimal, margin: Decimal): Promise<void> {
    const current = await this.db.botMmStat.findUnique({
      where: { bot_id: botId },
      select: { peak_inventory: true, peak_margin: true },
    });

    const prevInv = D(current?.peak_inventory?.toString() ?? 0);
    const prevMar = D(current?.peak_margin?.toString() ?? 0);
    const nextInv = Decimal.max(prevInv, inventory.abs());
    const nextMar = Decimal.max(prevMar, margin.abs());
    if (current && nextInv.eq(prevInv) && nextMar.eq(prevMar)) return;
    // Sin fila y sin nada que anotar no se crea nada: un bot que aún no ha
    // inmovilizado margen no necesita una fila de ceros, y con el latido de
    // cada minuto serían una escritura por bot y minuto para no decir nada.
    if (!current && nextInv.isZero() && nextMar.isZero()) return;

    await this.db.botMmStat
      .upsert({
        where: { bot_id: botId },
        create: {
          bot_id: botId,
          peak_inventory: nextInv.toFixed(),
          peak_margin: nextMar.toFixed(),
        },
        update: {
          peak_inventory: nextInv.toFixed(),
          peak_margin: nextMar.toFixed(),
        },
      })
      // El bot puede haberse borrado entre la lectura y la escritura: perder
      // una marca de agua no justifica tumbar el tick.
      .catch(() => undefined);
  }

  async saveCycleScratch(botId: string, scratch: Record<string, unknown>): Promise<void> {
    await this.db.botCycle.updateMany({
      where: { bot_id: botId, closed_at: null },
      data: { scratch: scratch as never },
    });
  }

  async saveCycleAnchor(
    botId: string,
    anchorPrice: string | null,
    filledLevelIndexes: number[],
  ): Promise<void> {
    await this.db.botCycle.updateMany({
      where: { bot_id: botId, closed_at: null },
      data: {
        anchor_price: anchorPrice,
        filled_level_indexes: filledLevelIndexes,
      },
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // Métricas y riesgo
  // ═══════════════════════════════════════════════════════════════

  async saveSnapshot(
    botId: string,
    s: {
      markPrice: string;
      positionQty: string;
      averageEntry: string | null;
      unrealizedPnl: string;
      realizedPnlAcc: string;
      marginUsed: string;
      liquidationPrice: string | null;
      openOrders: number;
    },
  ): Promise<void> {
    const equity = D(s.realizedPnlAcc).plus(s.unrealizedPnl);
    await this.db.botSnapshot.create({
      data: {
        bot_id: botId,
        equity: equity.toFixed(),
        position_qty: s.positionQty,
        average_entry: s.averageEntry,
        mark_price: s.markPrice,
        unrealized_pnl: s.unrealizedPnl,
        realized_pnl_acc: s.realizedPnlAcc,
        margin_used: s.marginUsed,
        liquidation_price: s.liquidationPrice,
        open_orders: s.openOrders,
      },
    });
  }

  /**
   * Caída acumulada en % sobre el capital asignado al bot.
   *
   * El equity lo trae quien llama, que lo tiene EXACTO en ese instante. Antes
   * se leía del último snapshot, que es el del tick anterior: el kill-switch
   * decidía con datos de hace quince segundos y hacía una consulta más por bot
   * y tick para conseguirlos.
   */
  drawdownPct(totalInvestment: string, equity: string): Decimal | null {
    const invested = D(totalInvestment);
    if (invested.lte(0)) return null;
    const e = D(equity);
    return e.gte(0) ? D(0) : e.abs().div(invested).mul(100);
  }

  /**
   * Pérdida realizada hoy por el usuario, con caché corta.
   *
   * Es un dato POR USUARIO y se recalculaba por bot y por tick: un usuario con
   * veinte bots hacía veinte agregaciones idénticas cada quince segundos.
   *
   * El día se corta en la zona horaria del usuario y no en la del contenedor.
   * `setHours(0,0,0,0)` sobre la hora del servidor hacía que un límite diario
   * se reiniciara a una hora arbitraria para quien no viviera en UTC.
   */
  async todayRealizedPnl(userId: string): Promise<Decimal> {
    const cached = this.dailyLoss.get(userId);
    if (cached && Date.now() - cached.at < DAILY_PNL_TTL_MS) return cached.value;

    const user = await this.db.user.findUnique({
      where: { id: userId },
      select: { timezone: true },
    });
    const cycles = await this.db.botCycle.findMany({
      where: {
        bot: { user_id: userId },
        closed_at: { gte: startOfDay(user?.timezone) },
      },
      select: { realized_pnl: true },
    });
    const value = cycles.reduce((acc, c) => acc.plus(c.realized_pnl.toString()), D(0));
    this.dailyLoss.set(userId, { value, at: Date.now() });
    return value;
  }

  /**
   * Resultado realizado hoy por UN bot, con la misma caché corta.
   *
   * Es distinto de `todayRealizedPnl`, que agrega toda la cuenta: un bot puede
   * fundirse el capital que se le asignó sin acercarse al tope global del
   * usuario, y es justo ese caso el que corta `maxDailyLossPct`.
   *
   * El corte del día sale de la zona horaria del usuario, igual que el global:
   * si no, un límite diario se reiniciaría a una hora arbitraria para quien no
   * viva en UTC.
   */
  async todayRealizedPnlForBot(botId: string, userId: string): Promise<Decimal> {
    const cached = this.dailyLossByBot.get(botId);
    if (cached && Date.now() - cached.at < DAILY_PNL_TTL_MS) return cached.value;

    const user = await this.db.user.findUnique({
      where: { id: userId },
      select: { timezone: true },
    });
    const cycles = await this.db.botCycle.findMany({
      where: { bot_id: botId, closed_at: { gte: startOfDay(user?.timezone) } },
      select: { realized_pnl: true },
    });
    const value = cycles.reduce((acc, c) => acc.plus(c.realized_pnl.toString()), D(0));
    this.dailyLossByBot.set(botId, { value, at: Date.now() });
    return value;
  }

  /**
   * Notional comprometido por TODOS los bots vivos del usuario.
   *
   * Replica lo que hace `RiskService.currentTotalNotional` en la API, que es lo
   * que produce el 403 al crear un bot. Aquí hace falta porque ese tope no se
   * revisaba en ejecución —solo el de por bot—, y la pantalla de límites promete
   * que se comprueba en cada ciclo del motor.
   *
   * Con la misma caché corta que la pérdida diaria y consultado al ritmo de la
   * persistencia, no en cada tick: es una consulta por usuario, no cambia entre
   * dos ticks seguidos, y cobrarla a cada tick de cada bot sería pagar mucho por
   * saber lo mismo.
   */
  async totalNotionalOfUser(userId: string): Promise<Decimal> {
    const cached = this.totalNotional.get(userId);
    if (cached && Date.now() - cached.at < DAILY_PNL_TTL_MS) return cached.value;

    const bots = await this.db.bot.findMany({
      where: { user_id: userId, status: { in: ['STARTING', 'RUNNING', 'PAUSED'] } },
      select: { total_investment: true, leverage: true },
    });
    const value = bots.reduce(
      (acc, b) => acc.plus(D(b.total_investment.toString()).mul(b.leverage)),
      D(0),
    );
    this.totalNotional.set(userId, { value, at: Date.now() });
    return value;
  }

  /** Invalida la caché de pérdida diaria: se llama al cerrarse un ciclo. */
  private forgetDailyLoss(userId: string, botId: string): void {
    this.dailyLoss.delete(userId);
    this.dailyLossByBot.delete(botId);
  }

  // ═══════════════════════════════════════════════════════════════
  // Carga
  // ═══════════════════════════════════════════════════════════════

  /**
   * Contrasta el ciclo abierto con la posición REAL del venue y lo corrige.
   *
   * Hace falta porque el barrido de ejecuciones al adoptar solo retrocede diez
   * minutos: si el worker estuvo caído más tiempo —un despliegue malo, un ciclo
   * de reinicios, la liberación de leases por un corte de Redis—, esas
   * ejecuciones no las ingiere NADIE, nunca, y el ciclo se queda contando una
   * cantidad que ya no existe. Hasta ahora nada comparaba las dos cifras.
   *
   * Qué se puede reconstruir y qué no:
   *
   *  - `qty` sale del venue, que es la fuente de verdad de este motor.
   *  - Los niveles ejecutados salen del ESTADO de las órdenes, no del ledger de
   *    ejecuciones: el estado sí se resincroniza contra el libro aunque los
   *    mensajes de ejecución se perdieran, así que sobrevive al hueco.
   *  - El PnL realizado del hueco NO se puede reconstruir: las ejecuciones que
   *    lo componen no las vio nadie. Por eso quien llama avisa en vez de
   *    corregir en silencio — y de ese acumulado depende el kill-switch.
   */
  async repairCycleFromVenue(
    botId: string,
    venueQty: string,
    recycleLevelOnExit: boolean,
  ): Promise<{ before: string; after: string; entriesFilled: number; indexes: number[] } | null> {
    const cycle = await this.db.botCycle.findFirst({
      where: { bot_id: botId, closed_at: null },
      orderBy: { seq: 'desc' },
    });
    if (!cycle) return null;

    const before = D(cycle.qty.toString()).abs();
    const after = D(venueQty).abs();
    if (before.minus(after).abs().lt(QTY_EPSILON)) return null;

    const orders = await this.db.botOrder.findMany({
      where: {
        bot_id: botId,
        cycle_seq: cycle.seq,
        status: { in: ['FILLED', 'PARTIALLY_FILLED'] },
      },
      select: { level_index: true, level_kind: true },
    });

    const indexes = new Set<number>();
    for (const o of orders) if (ENTRY_KINDS.has(o.level_kind)) indexes.add(o.level_index);
    // Misma regla que en `applyFillToCycle`: donde la estrategia recicla el
    // nivel al salir (Grid Classic), vender lo devuelve a disponible.
    if (recycleLevelOnExit) {
      for (const o of orders) if (o.level_kind === 'GRID_SELL') indexes.delete(o.level_index);
    }

    // Una orden por peldaño, así que contar peldaños ejecutados es contar
    // entradas. No coincide con el ledger cuando una orden se ejecutó a
    // trozos, pero el ledger es justo lo que está incompleto aquí.
    const entriesFilled = indexes.size;
    const sorted = [...indexes].sort((a, b) => a - b);

    await this.db.botCycle.update({
      where: { id: cycle.id },
      data: {
        qty: after.toFixed(),
        filled_level_indexes: sorted,
        entries_filled: entriesFilled,
      },
    });

    return { before: before.toFixed(), after: after.toFixed(), entriesFilled, indexes: sorted };
  }

  /**
   * Garantiza que hay un ciclo abierto y lo devuelve como CycleState.
   * Se llama al adoptar un bot: si el worker anterior murió a mitad de ciclo,
   * este lo recoge tal y como estaba.
   */
  async ensureCycle(botId: string, cooldownMinutes: number): Promise<CycleState> {
    let cycle = await this.db.botCycle.findFirst({
      where: { bot_id: botId, closed_at: null },
      orderBy: { seq: 'desc' },
    });

    if (!cycle) {
      const last = await this.db.botCycle.findFirst({
        where: { bot_id: botId },
        orderBy: { seq: 'desc' },
        select: { seq: true },
      });
      const seq = (last?.seq ?? 0) + 1;
      cycle = await this.db.botCycle.create({
        data: {
          bot_id: botId,
          seq,
          filled_level_indexes: [],
          scratch: { cycleSeq: seq, cooldownMinutes } as never,
        },
      });
    }

    // El acumulado del bot se calcula UNA vez, al adoptarlo: a partir de ahí lo
    // mantiene `applyFillToCycle` de forma incremental. Recalcularlo en cada
    // tick sería una agregación sobre todo el histórico del bot por cada
    // latido de cada bot.
    const closed = await this.db.botCycle.aggregate({
      where: { bot_id: botId, closed_at: { not: null } },
      _sum: { realized_pnl: true },
    });
    const realizedPnlAcc = D(closed._sum.realized_pnl?.toString() ?? 0).plus(
      cycle.realized_pnl.toString(),
    );

    const scratch = (cycle.scratch as Record<string, unknown>) ?? {};
    return {
      cycleId: String(cycle.id),
      startedAt: cycle.opened_at.getTime(),
      entriesFilled: cycle.entries_filled,
      lastEntryAt: cycle.last_entry_at?.getTime() ?? null,
      filledLevelIndexes: cycle.filled_level_indexes,
      cooldownUntil: cycle.cooldown_until?.getTime() ?? null,
      realizedPnl: cycle.realized_pnl.toString(),
      realizedPnlAcc: realizedPnlAcc.toFixed(),
      averageEntry: cycle.average_entry?.toString() ?? null,
      anchorPrice: cycle.anchor_price?.toString() ?? null,
      scratch: { cycleSeq: cycle.seq, cooldownMinutes, ...scratch },
    };
  }
}

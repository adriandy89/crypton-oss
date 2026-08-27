import { D, Decimal, type CycleState, type Fill, type LevelKind } from '@crypton/shared';
import { parseCoid } from './client-order-id';

/**
 * La aritmética del dinero de un ciclo, sin base de datos.
 *
 * Vivía dentro de la transacción de `BotStore.applyFillToCycle`, y ahí no la
 * podía usar nadie más. El backtest la necesita palabra por palabra —precio
 * medio ponderado, resultado realizado, cierre de ciclo— y reimplementarla
 * habría dejado **dos verdades sobre el dinero**: el día que divergieran, el
 * backtest mentiría exactamente sobre lo único que se le pregunta.
 *
 * Ahora `BotStore` se queda con lo que sí es suyo —el `FOR UPDATE`, leer la fila
 * y escribirla— y delega el cálculo aquí. Es la misma separación que ya tienen
 * `plan()` y `reconcile()`: decidir es puro, persistir no.
 */

/**
 * Niveles que ABREN o aumentan posición. Los demás son salidas.
 *
 * El conjunto es de `string` y no de `LevelKind` a propósito: quien pregunta no
 * siempre tiene ese tipo. La base guarda además `LIQUIDATION` —un nivel
 * sintético que ninguna estrategia emite, y que existe solo para poder anotar
 * una liquidación del venue—, así que el enum de Prisma es MÁS ancho que el de
 * `shared`. Con un conjunto tipado, preguntarle por `LIQUIDATION` no compila; con
 * uno de cadenas responde lo que es verdad: no, no es una entrada.
 */
export const ENTRY_KINDS: ReadonlySet<string> = new Set<LevelKind>([
  'BASE',
  'SAFETY',
  'GRID_BUY',
  'QUOTE_BID',
  'QUOTE_ASK',
]);

/**
 * Por debajo de esto la posición cuenta como plana.
 *
 * Sin umbral, un residuo de redondeo del venue dejaba el ciclo abierto para
 * siempre y el siguiente no llegaba a empezar nunca.
 */
export const QTY_EPSILON = D('0.00000001');

/** Los totales del ciclo tal y como están guardados. Todo en decimal exacto. */
export interface CycleTotals {
  qty: Decimal;
  averageEntry: Decimal | null;
  realizedPnl: Decimal;
  fees: Decimal;
  entriesFilled: number;
  filledLevelIndexes: number[];
  anchorPrice: Decimal | null;
  lastEntryAt: number | null;
}

export interface CycleFillOutcome {
  /** Los totales DESPUÉS del fill. Es lo que hay que escribir. */
  totals: CycleTotals;
  /** El estado que ve la estrategia en el siguiente `plan()`. */
  cycle: CycleState;
  /** La posición ha vuelto a plana: toca cerrar y abrir el siguiente. */
  closed: boolean;
  /**
   * Lo que este fill añade al acumulado DEL BOT.
   *
   * Es la diferencia entre el realizado del ciclo antes y después, no el total
   * del ciclo. Sumar el total era el doble conteo que describe el comentario de
   * `CycleState.realizedPnlAcc`: se contaba una vez por cada fill posterior, y
   * de esa cifra sale el drawdown que dispara el kill-switch.
   */
  accDelta: Decimal;
  /**
   * Diferencial capturado por ESTE fill, antes de comisiones.
   *
   * Es el «grid profit» de la ficha de market making, y se separa del realizado
   * a propósito: `realizedPnl` ya lleva la comisión descontada, así que con solo
   * esa cifra no hay forma de saber si un bot gana poco porque cotiza estrecho o
   * porque el venue se está llevando lo que gana.
   */
  matched: Decimal;
  /**
   * ¿Ha REDUCIDO posición este fill? Es lo que cierra un par casado.
   *
   * Va como bandera propia y no se deduce de que `matched` sea distinto de cero:
   * una salida exactamente al precio medio de entrada cierra el par igual, y con
   * la deducción no se habría contado.
   */
  reduced: boolean;
}

export interface CycleFillOptions {
  /**
   * La venta de un nivel LIBERA el nivel (Grid Classic): comprar abajo, vender
   * arriba y REPETIR exige que el índice vendido vuelva a estar disponible.
   *
   * Solo bajo bandera: en GridMart las seguridades comparten espacio de índices
   * con la rejilla de ventas, y liberar aquí borraría la marca de una seguridad
   * ya comprada — se recompraría sola.
   */
  recycleLevelOnExit?: boolean;
  /** Minutos de espera antes de que el ciclo siguiente pueda abrir. */
  cooldownMinutes?: number;
}

export function cycleAfterFill(
  cycle: CycleState,
  totals: CycleTotals,
  fill: Fill,
  opts: CycleFillOptions,
  now: number,
): CycleFillOutcome {
  const parsed = fill.clientOrderId ? parseCoid(fill.clientOrderId) : null;
  const levelKind = parsed?.kind ?? null;
  const isEntry = levelKind ? ENTRY_KINDS.has(levelKind) : false;

  const signed = fill.side === 'BUY' ? D(fill.qty) : D(fill.qty).neg();
  const prevQty = totals.qty;
  const nextQty = prevQty.plus(signed);
  const prevAvg = totals.averageEntry ?? D(fill.price);
  const prevRealized = totals.realizedPnl;

  let averageEntry = prevAvg;
  let realized = prevRealized.minus(fill.fee);
  let matched = D(0);
  let reduced = false;

  if (prevQty.isZero() || prevQty.s === signed.s) {
    // Abre o aumenta: media ponderada por cantidad.
    const totalCost = prevAvg.mul(prevQty.abs()).plus(D(fill.price).mul(fill.qty));
    averageEntry = nextQty.isZero() ? D(fill.price) : totalCost.div(nextQty.abs());
  } else {
    // Reduce: la parte cerrada realiza resultado contra el medio.
    const closing = Decimal.min(D(fill.qty), prevQty.abs());
    const direction = prevQty.gt(0) ? D(1) : D(-1);
    matched = D(fill.price).minus(prevAvg).mul(closing).mul(direction);
    realized = realized.plus(matched);
    reduced = true;
    // Si el fill da la vuelta a la posición, lo que queda abre a este precio.
    if (!nextQty.isZero() && nextQty.s !== prevQty.s) averageEntry = D(fill.price);
  }

  const accDelta = realized.minus(prevRealized);

  const filledIndexes = new Set(totals.filledLevelIndexes);
  if (isEntry && parsed) filledIndexes.add(parsed.levelIndex);
  if (opts.recycleLevelOnExit && parsed?.kind === 'GRID_SELL') {
    filledIndexes.delete(parsed.levelIndex);
  }

  const anchor = totals.anchorPrice ?? (isEntry && levelKind === 'BASE' ? D(fill.price) : null);
  const entriesFilled = totals.entriesFilled + (isEntry ? 1 : 0);
  const fees = totals.fees.plus(fill.fee);
  const flat = nextQty.abs().lt(QTY_EPSILON);

  const nextTotals: CycleTotals = {
    qty: flat ? D(0) : nextQty,
    averageEntry,
    realizedPnl: realized,
    fees,
    entriesFilled,
    filledLevelIndexes: [...filledIndexes],
    anchorPrice: anchor,
    lastEntryAt: isEntry ? fill.ts : totals.lastEntryAt,
  };

  if (!flat) {
    return {
      totals: nextTotals,
      cycle: {
        ...cycle,
        entriesFilled,
        lastEntryAt: isEntry ? fill.ts : cycle.lastEntryAt,
        filledLevelIndexes: [...filledIndexes],
        averageEntry: averageEntry.toFixed(),
        anchorPrice: anchor?.toFixed() ?? cycle.anchorPrice,
        realizedPnl: realized.toFixed(),
        realizedPnlAcc: D(cycle.realizedPnlAcc).plus(accDelta).toFixed(),
      },
      closed: false,
      accDelta,
      matched,
      reduced,
    };
  }

  const cooldownMinutes = Number(
    opts.cooldownMinutes ?? (cycle.scratch['cooldownMinutes'] as number) ?? 0,
  );
  const cooldownUntil = cooldownMinutes > 0 ? now + cooldownMinutes * 60_000 : null;
  const nextSeq = Number(cycle.scratch['cycleSeq'] ?? 1) + 1;

  return {
    totals: nextTotals,
    cycle: {
      cycleId: null,
      startedAt: now,
      entriesFilled: 0,
      lastEntryAt: null,
      filledLevelIndexes: [],
      cooldownUntil,
      // El ciclo nuevo empieza a cero; el acumulado del bot arrastra lo de este
      // fill y nada más.
      realizedPnl: '0',
      realizedPnlAcc: D(cycle.realizedPnlAcc).plus(accDelta).toFixed(),
      averageEntry: null,
      anchorPrice: null,
      scratch: { cycleSeq: nextSeq, cooldownMinutes },
    },
    closed: true,
    accDelta,
    matched,
    reduced,
  };
}

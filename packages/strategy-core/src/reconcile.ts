import {
  D,
  type DesiredOrder,
  type LevelKind,
  type MarketSpec,
  type VenueOrder,
} from '@crypton/shared';
import { botShortId, makeCoid, parseCoid } from './client-order-id';

/**
 * Reconciliación declarativa: el corazón del motor.
 *
 * El runner no ejecuta pasos imperativos ("ahora coloca la seguridad 3"). En
 * cada tick calcula el conjunto de órdenes que DEBERÍA existir y lo compara con
 * las que hay de verdad en el venue. Solo se ejecuta la diferencia.
 *
 * Todo lo bueno del motor sale de esta única decisión:
 *
 *   · Se autorrepara. Un reinicio, una desconexión del WebSocket, una orden
 *     cancelada a mano desde la web del DEX — al siguiente tick vuelve a
 *     converger sin código especial para cada caso.
 *   · Los cambios de configuración en caliente salen gratis: cambia lo que
 *     devuelve `plan()` y el diff hace el resto. No hay una rutina de migración
 *     por parámetro.
 *   · Es testeable sin exchange: entran dos listas, sale un plan.
 */

export interface OrderReplacement {
  existing: VenueOrder;
  desired: DesiredOrder;
  /** Qué cambió; se registra en el evento para poder auditarlo después. */
  reason: 'PRICE' | 'QTY' | 'BOTH';
}

export interface ReconcilePlan {
  toPlace: DesiredOrder[];
  toCancel: VenueOrder[];
  toReplace: OrderReplacement[];
  /** Órdenes que ya están como deben: no se tocan. */
  unchanged: number;
  /** Órdenes ajenas al bot que se han dejado en paz a propósito. */
  foreign: number;
}

export interface ReconcileInput {
  botId: string;
  cycleSeq: number;
  desired: DesiredOrder[];
  actual: VenueOrder[];
  market: MarketSpec;
  /** Traduce el id canónico al formato del venue. */
  encode: (canonical: string) => string;
  /**
   * Ids en espacio de venue que este bot HA emitido de verdad, leídos de la
   * base de datos (`bot_orders.venue_client_id` de los dos últimos ciclos).
   *
   * Cuando se pasa, es AUTORITATIVO: toda orden que el motor haya mandado
   * quedó registrada ANTES de salir hacia el venue —esa es la garantía de
   * `place()`—, así que un id que no esté aquí no puede ser nuestro. Con él, la
   * clasificación es exacta y no cuesta ni un hash.
   *
   * Sin él, la función reconstruye por fuerza bruta los ids POSIBLES (miles de
   * hashes por llamada): vale para tests y usos sueltos, no para el camino
   * caliente.
   */
  ownIds?: ReadonlySet<string>;
}

/**
 * Índice máximo de nivel que puede emitir una estrategia.
 *
 * Tiene que cubrir el MAYOR índice real: Grid admite 200 niveles y TDCA usa el
 * número de compra como índice, con tope de 500 por ciclo. El barrido de
 * huérfanas estaba fijado en 64: en los venues de id opaco —Hyperliquid,
 * Lighter—, toda orden por encima se clasificaba como ajena y no se cancelaba
 * NUNCA. Quedaba viva en el libro, inmovilizando margen y fuera de toda
 * contabilidad.
 */
const MAX_LEVEL_INDEX = 512;

/** Índices fuera de la escalera: el cierre manual usa el 999. */
const SPECIAL_LEVEL_INDEXES = [999];

const LEVEL_KINDS: LevelKind[] = [
  'BASE',
  'SAFETY',
  'GRID_BUY',
  'GRID_SELL',
  'TAKE_PROFIT',
  'STOP_LOSS',
  'QUOTE_BID',
  'QUOTE_ASK',
];

/**
 * Todos los ids que este bot pudo haber emitido, en espacio de venue.
 *
 * Hyperliquid convierte el id en hash y Lighter en entero, y ninguna de las dos
 * transformaciones se puede invertir. La única forma de reconocer una orden
 * propia allí es reconstruir los ids posibles y buscar el candidato.
 *
 * Se cubre el ciclo anterior además del actual: justo después de cerrar uno
 * pueden quedar órdenes vivas de la tanda previa que hay que cancelar.
 */
export function buildOwnIdSet(
  botId: string,
  cycleSeq: number,
  encode: (canonical: string) => string,
): Set<string> {
  const ids = new Set<string>();
  for (const seq of [cycleSeq, cycleSeq - 1]) {
    if (seq < 0) continue;
    for (const kind of LEVEL_KINDS) {
      for (let i = 0; i <= MAX_LEVEL_INDEX; i++) {
        ids.add(encode(makeCoid(botId, seq, kind, i)));
      }
      for (const i of SPECIAL_LEVEL_INDEXES) {
        ids.add(encode(makeCoid(botId, seq, kind, i)));
      }
    }
  }
  return ids;
}

export function reconcile(input: ReconcileInput): ReconcilePlan {
  const { desired, actual, market, encode } = input;
  // `botShortId` y no una copia local: había aquí una tercera definición del
  // prefijo, con su propio `slice(0, 8)` fijo. Tres copias de la misma regla
  // era una de más incluso antes de que cambiara.
  const prefix = botShortId(input.botId);

  // Se compara en ESPACIO DE VENUE: los ids canónicos se codifican y se cotejan
  // contra los que devuelve el exchange. Así no hace falta ninguna tabla de
  // correspondencias, y un worker recién arrancado reconoce sus propias órdenes.
  const desiredByVenueId = new Map<string, DesiredOrder>();
  for (const order of desired) {
    desiredByVenueId.set(encode(order.clientOrderId), order);
  }

  const actualByVenueId = new Map<string, VenueOrder>();
  let foreign = 0;

  // Con `ownIds` del llamante, la pertenencia es una consulta exacta a lo que
  // este bot mandó de verdad. Sin él, la fuerza bruta se construye COMO MUCHO
  // una vez por llamada y solo si aparece una orden que no se reconozca de
  // entrada — antes se reconstruía entera, miles de hashes, por CADA orden
  // desconocida.
  let cachedOwnIds: ReadonlySet<string> | null = input.ownIds ?? null;
  const ownIds = (): ReadonlySet<string> =>
    (cachedOwnIds ??= buildOwnIdSet(input.botId, input.cycleSeq, encode));

  for (const order of actual) {
    if (!order.clientOrderId) {
      // Sin id de cliente no puede ser nuestra: la puso el usuario a mano o
      // viene de otra herramienta. Se deja intacta.
      foreign++;
      continue;
    }
    // Si el id es uno de los que deseamos, es nuestro sin más comprobación.
    if (desiredByVenueId.has(order.clientOrderId)) {
      actualByVenueId.set(order.clientOrderId, order);
      continue;
    }
    // Si no, hay que decidir si es una orden nuestra ya obsoleta (que toca
    // cancelar) o de un tercero (que hay que respetar).
    if (isOurs(order.clientOrderId, prefix, ownIds())) {
      actualByVenueId.set(order.clientOrderId, order);
    } else {
      foreign++;
    }
  }

  const toPlace: DesiredOrder[] = [];
  const toReplace: OrderReplacement[] = [];
  let unchanged = 0;

  for (const [venueId, want] of desiredByVenueId) {
    const have = actualByVenueId.get(venueId);
    if (!have) {
      toPlace.push(want);
      continue;
    }

    const priceChanged = !samePrice(have.price, want.price, market);
    // La cantidad se compara contra lo que QUEDA vivo, no contra la original:
    // una orden parcialmente ejecutada sigue siendo correcta aunque su tamaño
    // inicial ya no coincida con lo deseado.
    const remaining = D(have.qty).minus(have.filledQty);
    const qtyChanged = !sameQty(remaining.toFixed(), want.qty, market);

    if (priceChanged || qtyChanged) {
      toReplace.push({
        existing: have,
        desired: want,
        reason: priceChanged && qtyChanged ? 'BOTH' : priceChanged ? 'PRICE' : 'QTY',
      });
    } else {
      unchanged++;
    }
  }

  // Huérfanas: órdenes nuestras que ya no aparecen en el plan. Ocurre al cerrar
  // un ciclo, al cambiar la configuración o al salirse el precio del rango.
  const toCancel: VenueOrder[] = [];
  for (const [venueId, order] of actualByVenueId) {
    if (!desiredByVenueId.has(venueId)) toCancel.push(order);
  }

  return { toPlace, toCancel, toReplace, unchanged, foreign };
}

/**
 * ¿Es nuestra esta orden?
 *
 * En los venues que conservan el id legible (Aster) basta con mirar el prefijo.
 * En los que lo transforman —Hyperliquid lo convierte en hash, Lighter en
 * entero— no hay forma de invertirlo, así que se busca en el conjunto de ids
 * que este bot pudo haber emitido, construido con `makeCoid`: la MISMA función
 * que los genera.
 *
 * Aquí hubo una copia a mano del prefijo y de la tabla de códigos de nivel. Al
 * pasar el prefijo de 8 a 16 caracteres, esa copia siguió generando ids de 8 y
 * dejó de reconocer las órdenes propias en los venues de id opaco: el bot daba
 * por ajenas sus propias órdenes y no las cancelaba nunca.
 */
function isOurs(venueClientId: string, prefix: string, ownIds: ReadonlySet<string>): boolean {
  const parsed = parseCoid(venueClientId);
  if (parsed) {
    // Comparación por el lado corto: una orden colocada antes de que el prefijo
    // pasara de 8 a 16 caracteres sigue siendo nuestra y hay que reconocerla.
    // Se compara siempre contra el prefijo de ESTE bot, así que un bot ajeno no
    // se cuela por aquí.
    const width = Math.min(parsed.botShort.length, prefix.length);
    return parsed.botShort.slice(0, width) === prefix.slice(0, width);
  }
  return ownIds.has(venueClientId);
}

/**
 * Comparación con tolerancia de medio tick.
 *
 * Sin tolerancia, la diferencia de redondeo entre lo que calculamos y lo que el
 * venue devuelve haría que cada tick cancelara y recolocara la escalera entera:
 * el bot perdería su prioridad en el libro sin ganar absolutamente nada.
 */
function samePrice(a: string, b: string, market: MarketSpec): boolean {
  const tolerance = D(market.tickSize).div(2);
  return D(a).minus(b).abs().lte(tolerance);
}

function sameQty(a: string, b: string, market: MarketSpec): boolean {
  const tolerance = D(market.stepSize).div(2);
  return D(a).minus(b).abs().lte(tolerance);
}

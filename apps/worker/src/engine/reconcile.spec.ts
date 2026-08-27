import { Venue, type DesiredOrder, type MarketSpec, type VenueOrder } from '@crypton/shared';
import { codecFor, hyperliquidCodec } from '@crypton/exchange-core';
import { buildOwnIdSet, makeCoid, reconcile } from '@crypton/strategy-core';
const BOT_ID = '1a2b3c4d-0000-0000-0000-000000000000';
const MARKET: MarketSpec = {
  venue: Venue.HYPERLIQUID,
  symbol: 'BTC',
  canonical: 'BTC/USDC',
  base: 'BTC',
  quote: 'USDC',
  tickSize: '0.1',
  stepSize: '0.001',
  minNotional: '10',
  minQty: null,
  maxQty: null,
  maxLeverage: 40,
  priceDecimals: 1,
  qtyDecimals: 3,
  active: true,
};
/** Codec de identidad: mantiene los tests legibles. */
const identity = (canonical: string): string => canonical;
const want = (over: Partial<DesiredOrder> = {}): DesiredOrder => ({
  clientOrderId: makeCoid(BOT_ID, 1, 'SAFETY', 1),
  levelKind: 'SAFETY',
  levelIndex: 1,
  side: 'BUY',
  type: 'POST_ONLY',
  price: '99.0',
  qty: '1.000',
  reduceOnly: false,
  ...over,
});
const have = (over: Partial<VenueOrder> = {}): VenueOrder => ({
  venue: Venue.HYPERLIQUID,
  symbol: 'BTC',
  clientOrderId: makeCoid(BOT_ID, 1, 'SAFETY', 1),
  venueOrderId: 'v-1',
  side: 'BUY',
  type: 'LIMIT',
  price: '99.0',
  qty: '1.000',
  filledQty: '0',
  avgPrice: null,
  status: 'OPEN',
  reduceOnly: false,
  createdAt: 0,
  ...over,
});
const run = (desired: DesiredOrder[], actual: VenueOrder[], encode = identity) =>
  reconcile({ botId: BOT_ID, cycleSeq: 1, desired, actual, market: MARKET, encode });
describe('reconcile', () => {
  it('con el libro vacío, coloca todo lo deseado', () => {
    const plan = run([want()], []);
    expect(plan.toPlace).toHaveLength(1);
    expect(plan.toCancel).toHaveLength(0);
    expect(plan.unchanged).toBe(0);
  });
  it('lo que ya está como debe, no se toca', () => {
    const plan = run([want()], [have()]);
    expect(plan.toPlace).toHaveLength(0);
    expect(plan.toCancel).toHaveLength(0);
    expect(plan.toReplace).toHaveLength(0);
    expect(plan.unchanged).toBe(1);
  });
  it('reemplaza cuando cambia el precio', () => {
    const plan = run([want({ price: '98.0' })], [have({ price: '99.0' })]);
    expect(plan.toReplace).toHaveLength(1);
    expect(plan.toReplace[0].reason).toBe('PRICE');
  });
  it('reemplaza cuando cambia la cantidad', () => {
    const plan = run([want({ qty: '2.000' })], [have({ qty: '1.000' })]);
    expect(plan.toReplace).toHaveLength(1);
    expect(plan.toReplace[0].reason).toBe('QTY');
  });
  it('marca BOTH cuando cambian las dos cosas', () => {
    const plan = run([want({ price: '98.0', qty: '2.000' })], [have()]);
    expect(plan.toReplace[0].reason).toBe('BOTH');
  });
  it('una diferencia por debajo de medio tick NO provoca churn', () => {
    // Sin esta tolerancia, el redondeo del venue haría que cada tick cancelara
    // y recolocara la escalera entera, perdiendo prioridad en el libro.
    const plan = run([want({ price: '99.04' })], [have({ price: '99.0' })]);
    expect(plan.toReplace).toHaveLength(0);
    expect(plan.unchanged).toBe(1);
  });
  it('compara contra lo que QUEDA vivo, no contra el tamaño original', () => {
    // Una orden de 3 con 2 ya ejecutados sigue siendo correcta si se desea 1.
    const plan = run([want({ qty: '1.000' })], [have({ qty: '3.000', filledQty: '2.000' })]);
    expect(plan.toReplace).toHaveLength(0);
    expect(plan.unchanged).toBe(1);
  });
  it('cancela nuestras órdenes que ya no están en el plan', () => {
    const orphan = have({
      clientOrderId: makeCoid(BOT_ID, 1, 'SAFETY', 7),
      venueOrderId: 'v-7',
    });
    const plan = run([want()], [have(), orphan]);
    expect(plan.toCancel).toHaveLength(1);
    expect(plan.toCancel[0].venueOrderId).toBe('v-7');
  });
  it('NO toca las órdenes sin id de cliente: son del usuario', () => {
    // El usuario puede operar a mano en la misma cuenta. Cancelarle sus órdenes
    // sería el peor efecto colateral posible.
    const manual = have({ clientOrderId: null, venueOrderId: 'manual-1' });
    const plan = run([want()], [have(), manual]);
    expect(plan.toCancel).toHaveLength(0);
    expect(plan.foreign).toBe(1);
  });
  it('NO toca las órdenes de OTRO bot en la misma cuenta', () => {
    const otherBot = have({ clientOrderId: 'deadbeef.1.S1', venueOrderId: 'other-1' });
    const plan = run([want()], [have(), otherBot]);
    expect(plan.toCancel).toHaveLength(0);
    expect(plan.foreign).toBe(1);
  });
  it('reconoce órdenes del ciclo anterior y las cancela', () => {
    // Al cerrar un ciclo pueden quedar vivas órdenes de la tanda previa: si no
    // se reconocieran como nuestras, se quedarían en el libro para siempre.
    const previous = have({
      clientOrderId: makeCoid(BOT_ID, 0, 'SAFETY', 2),
      venueOrderId: 'prev-1',
    });
    const plan = run([want()], [have(), previous]);
    expect(plan.toCancel.map((o) => o.venueOrderId)).toEqual(['prev-1']);
  });
  describe('con ids codificados por el venue (Hyperliquid)', () => {
    const encode = hyperliquidCodec.encode;
    it('reconoce sus propias órdenes tras un reinicio del worker', () => {
      // Este es EL caso de la prueba de caos: el worker arranca de cero, no
      // tiene nada en memoria, y debe identificar como suyas las órdenes que ya
      // están en el libro comparando en espacio de venue.
      const coid = makeCoid(BOT_ID, 1, 'SAFETY', 1);
      const inBook = have({ clientOrderId: encode(coid) });
      const plan = run([want({ clientOrderId: coid })], [inBook], encode);
      expect(plan.unchanged).toBe(1);
      expect(plan.toPlace).toHaveLength(0);
      expect(plan.toCancel).toHaveLength(0);
    });
    it('detecta las que faltan y las repone', () => {
      // Dos órdenes deseadas, solo una en el libro (la otra la canceló alguien
      // desde la web del DEX): la reconciliación repone exactamente esa.
      const a = makeCoid(BOT_ID, 1, 'SAFETY', 1);
      const b = makeCoid(BOT_ID, 1, 'SAFETY', 2);
      const plan = run(
        [want({ clientOrderId: a }), want({ clientOrderId: b, levelIndex: 2, price: '97.0' })],
        [have({ clientOrderId: encode(a) })],
        encode,
      );
      expect(plan.unchanged).toBe(1);
      expect(plan.toPlace.map((o) => o.clientOrderId)).toEqual([b]);
    });
    it('cancela sus huérfanas aunque el id sea un hash irreversible', () => {
      const orphanCoid = makeCoid(BOT_ID, 1, 'GRID_SELL', 3);
      const plan = run(
        [want()],
        [have({ clientOrderId: encode(orphanCoid), venueOrderId: 'orph' })],
        encode,
      );
      expect(plan.toCancel.map((o) => o.venueOrderId)).toEqual(['orph']);
    });
    it('sigue respetando lo ajeno con ids opacos', () => {
      const foreign = have({ clientOrderId: '0x' + 'ab'.repeat(16), venueOrderId: 'f' });
      const plan = run([want()], [foreign], encode);
      expect(plan.toCancel).toHaveLength(0);
      expect(plan.foreign).toBe(1);
    });
  });
  it('el codec de cada venue produce ids distintos para el mismo nivel', () => {
    const coid = makeCoid(BOT_ID, 1, 'SAFETY', 1);
    const ids = [Venue.HYPERLIQUID, Venue.LIGHTER, Venue.ASTER].map((v) =>
      codecFor(v).encode(coid),
    );
    expect(new Set(ids).size).toBe(3);
  });
  it('escenario completo: colocar, mantener, reemplazar y cancelar a la vez', () => {
    const keep = makeCoid(BOT_ID, 1, 'SAFETY', 1);
    const move = makeCoid(BOT_ID, 1, 'SAFETY', 2);
    const add = makeCoid(BOT_ID, 1, 'SAFETY', 3);
    const gone = makeCoid(BOT_ID, 1, 'SAFETY', 9);
    const plan = run(
      [
        want({ clientOrderId: keep, price: '99.0' }),
        want({ clientOrderId: move, levelIndex: 2, price: '96.0' }),
        want({ clientOrderId: add, levelIndex: 3, price: '94.0' }),
      ],
      [
        have({ clientOrderId: keep, venueOrderId: 'keep' }),
        have({ clientOrderId: move, venueOrderId: 'move', price: '97.0' }),
        have({ clientOrderId: gone, venueOrderId: 'gone' }),
      ],
    );
    expect(plan.unchanged).toBe(1);
    expect(plan.toReplace.map((r) => r.existing.venueOrderId)).toEqual(['move']);
    expect(plan.toPlace.map((o) => o.clientOrderId)).toEqual([add]);
    expect(plan.toCancel.map((o) => o.venueOrderId)).toEqual(['gone']);
  });
});
describe('reconocimiento de órdenes propias en venues de id opaco', () => {
  const hlEncode = codecFor(Venue.HYPERLIQUID).encode;
  /**
   * El barrido de huérfanas estaba fijado en 64 niveles mientras Grid Classic
   * admite 200. En Hyperliquid y Lighter el id se transforma con un hash que no
   * se puede invertir, así que la única forma de reconocer una orden propia es
   * reconstruir los candidatos — y por encima del nivel 64 no se reconstruía
   * ninguno. El resultado: esas órdenes se daban por ajenas y no se cancelaban
   * NUNCA, quedándose vivas en el libro e inmovilizando margen.
   */
  it('reconoce una orden de nivel alto (por encima del antiguo tope de 64)', () => {
    const alta = have({
      clientOrderId: hlEncode(makeCoid(BOT_ID, 1, 'GRID_BUY', 150)),
      venueOrderId: 'v-alta',
    });
    const plan = run([], [alta], hlEncode);
    expect(plan.toCancel).toHaveLength(1);
    expect(plan.foreign).toBe(0);
  });
  it('sigue respetando las órdenes de otros', () => {
    const ajena = have({ clientOrderId: hlEncode('otrobot0000cafe.1.GB3'), venueOrderId: 'v-x' });
    const plan = run([], [ajena], hlEncode);
    expect(plan.toCancel).toHaveLength(0);
    expect(plan.foreign).toBe(1);
  });
  it('reconoce el cierre manual, que usa el índice 999 fuera de la escalera', () => {
    const cierre = have({
      clientOrderId: hlEncode(makeCoid(BOT_ID, 1, 'TAKE_PROFIT', 999)),
      venueOrderId: 'v-cierre',
    });
    const plan = run([], [cierre], hlEncode);
    expect(plan.toCancel).toHaveLength(1);
  });
  it('cubre el ciclo anterior: al cerrar uno quedan órdenes de la tanda previa', () => {
    const ids = buildOwnIdSet(BOT_ID, 5, hlEncode);
    expect(ids.has(hlEncode(makeCoid(BOT_ID, 5, 'SAFETY', 3)))).toBe(true);
    expect(ids.has(hlEncode(makeCoid(BOT_ID, 4, 'SAFETY', 3)))).toBe(true);
    expect(ids.has(hlEncode(makeCoid(BOT_ID, 3, 'SAFETY', 3)))).toBe(false);
  });
  it('acepta el conjunto ya calculado y no lo recalcula', () => {
    const ids = buildOwnIdSet(BOT_ID, 1, hlEncode);
    let encodes = 0;
    const contando = (c: string): string => {
      encodes++;
      return hlEncode(c);
    };
    const plan = reconcile({
      botId: BOT_ID,
      cycleSeq: 1,
      desired: [],
      actual: [have({ clientOrderId: hlEncode(makeCoid(BOT_ID, 1, 'GRID_BUY', 10)) })],
      market: MARKET,
      encode: contando,
      ownIds: ids,
    });
    expect(plan.toCancel).toHaveLength(1);
    // Sin el conjunto precalculado esto serían miles de hashes por cada orden
    // desconocida, en cada tick y de cada bot.
    expect(encodes).toBe(0);
  });
});

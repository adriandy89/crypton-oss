import {
  D,
  StrategyKind,
  Venue,
  candleSpanMs,
  type BacktestOperacionView,
  type BacktestParams,
  type BotContext,
  type Candle,
  type CandleInterval,
  type DesiredState,
  type HistorialOperaciones,
  type MarginMode,
  type PlaceOrderRequest,
} from '@crypton/shared';
import { DryRunAdapter } from '@crypton/exchange-core';
import {
  etiquetarTripleBarrera,
  getStrategy,
  makeCoid,
  serieNumerica,
  vaciarCacheAnalisis,
} from '@crypton/strategy-core';
import { runReplay } from './engine';
import {
  BOT_CANAL,
  CINCO_MIN,
  COSTES_CANAL,
  MERCADO_CANAL,
  PARAMS_CANAL,
  configCanal,
  mercadoCanal,
  partirCanal,
} from './testing-canal';

/**
 * Spec 058. El canal con IA en el replay: las mismas piezas que en el motor
 * —estrategia, juez, simulador— y las reglas de sus tasas base, para que un
 * backtest no valide una ventaja que las tasas que ve la IA no tienen.
 */

const RUPTURAS = [40, 55, 70, 85, 100, 115];

function replay(
  candles: Candle[],
  o: {
    warmup?: Candle[];
    config?: Record<string, unknown>;
    params?: Partial<BacktestParams>;
    venue?: Venue;
  } = {},
) {
  const venue = o.venue ?? Venue.HYPERLIQUID;
  return runReplay({
    botId: BOT_CANAL,
    strategy: StrategyKind.AI_CHANNEL,
    config: configCanal(o.config),
    venue,
    market: { ...MERCADO_CANAL, venue },
    interval: '5m',
    candles,
    ...(o.warmup ? { warmup: o.warmup } : {}),
    params: { ...PARAMS_CANAL, ...o.params },
  });
}

const indiceDe = (velas: readonly Candle[], ts: number): number =>
  velas.findIndex((v) => v.t <= ts && ts < v.t + CINCO_MIN);

/** Una vela a mano, con los precios redondeados como los de la serie. */
const velaA = (t: number, o: number, h: number, l: number, c: number): Candle => ({
  t,
  o: o.toFixed(4),
  h: h.toFixed(4),
  l: l.toFixed(4),
  c: c.toFixed(4),
  v: '10',
});

/** La etiqueta de una operación: su entrada, su stop y su objetivo, en las mismas velas. */
function etiquetaDe(velas: readonly Candle[], op: BacktestOperacionView, maxVelas: number) {
  return etiquetarTripleBarrera(
    serieNumerica(velas),
    indiceDe(velas, op.entradaEn),
    op.lado,
    Number(op.precioEntrada),
    Number(op.stop),
    Number(op.objetivos[0]),
    maxVelas,
    COSTES_CANAL,
  );
}

/** Sustituye `plan` de la estrategia real para mirar o tocar lo que devuelve. */
function espiarPlan(f: (ctx: BotContext, plan: DesiredState) => DesiredState) {
  const s = getStrategy(StrategyKind.AI_CHANNEL);
  const original = s.plan.bind(s);
  return jest.spyOn(s, 'plan').mockImplementation((ctx: BotContext) => f(ctx, original(ctx)));
}

beforeEach(() => {
  vaciarCacheAnalisis();
});
afterEach(() => {
  jest.restoreAllMocks();
});

describe('el canal con IA etiqueta como sus tasas base', () => {
  it.each<[string, number, string[]]>([
    ['objetivos y stops', 3, ['OBJETIVO', 'STOP']],
    ['cierres por tiempo y stops', 2, ['CIERRE', 'STOP']],
  ])(
    'cada operación sale donde y como dice su triple barrera: %s',
    async (_caso, maxHoldBars, salidas) => {
      const { warmup, candles } = partirCanal(
        mercadoCanal({ horasRango: 120, rupturas: RUPTURAS }),
      );
      const out = await replay(candles, {
        warmup,
        config: { takeProfitSchemes: 'MEDIA', maxHoldBars },
      });

      expect(out.operaciones.length).toBeGreaterThan(20);
      expect(new Set(out.operaciones.map((o) => o.salida))).toEqual(new Set(salidas));
      for (const op of out.operaciones) {
        // La barrera de tiempo, en velas de 5 min: las de 15 de la configuración.
        const e = etiquetaDe(candles, op, maxHoldBars * 3);
        expect({ resultado: e?.resultado, vela: e?.salida }).toEqual({
          resultado: op.salida === 'CIERRE' ? 'TIEMPO' : op.salida,
          vela: indiceDe(candles, op.salidaEn),
        });
        // El replay mide contra el riesgo PLANEADO y la etiqueta contra el de
        // la entrada real: la diferencia es la de esos dos precios.
        expect(Math.abs(e!.r - op.r)).toBeLessThan(0.1);
      }
    },
  );

  describe('con una operación conocida', () => {
    const { warmup, candles } = partirCanal(mercadoCanal({ horasRango: 60 }));
    const config = { takeProfitSchemes: 'MEDIA' };
    let op: BacktestOperacionView;
    let k: number;
    let largo: boolean;
    let entrada: number;
    let stop: number;
    let objetivo: number;

    beforeAll(async () => {
      vaciarCacheAnalisis();
      const base = await replay(candles, { warmup, config });
      op = base.operaciones[0];
      k = indiceDe(candles, op.entradaEn);
      largo = op.lado === 'LONG';
      entrada = Number(op.precioEntrada);
      stop = Number(op.stop);
      objetivo = Number(op.objetivos[0]);
    });

    /** Las velas de la base con las de `k + 1` en adelante cambiadas por `nuevas`. */
    const conVelas = (nuevas: ((t: number) => Candle)[]): Candle[] => [
      ...candles.slice(0, k + 1),
      ...nuevas.map((f, i) => f(candles[k + 1 + i].t)),
      ...candles.slice(k + 1 + nuevas.length),
    ];
    /** Un precio `d` veces la distancia del stop hacia el lado del objetivo. */
    const hacia = (base: number, d: number) => base + (largo ? d : -d);

    it('un hueco que salta el stop sale a la apertura, peor que −1R', async () => {
      const distancia = Math.abs(entrada - stop);
      const apertura = hacia(stop, -2 * distancia);
      const velas = conVelas([
        (t) => velaA(t, apertura, apertura + 0.01, apertura - 0.01, apertura),
      ]);

      const historiales: { now: number; h: HistorialOperaciones | undefined }[] = [];
      espiarPlan((ctx, plan) => {
        historiales.push({ now: ctx.now, h: ctx.historial });
        return plan;
      });

      // Con el tope diario en el 2 %, la pérdida del hueco (más de 2R, con R en
      // el 1 % del capital) cierra el día sin llegar a la pausa del 1,5.
      const out = await replay(velas, { warmup, config: { ...config, maxDailyLossPct: '2' } });

      const cerrada = out.operaciones[0];
      expect(cerrada.entradaEn).toBe(op.entradaEn);
      expect(cerrada.salida).toBe('STOP');
      const avisos = out.warnings.find((w) => w.startsWith('Avisos de la estrategia')) ?? '';
      // Uno por día UTC con el tope alcanzado, no uno por cada vela.
      expect(Number(/AI_DAY_STOP ×(\d+)/.exec(avisos)?.[1] ?? 0)).toBeGreaterThan(0);
      expect(Number(/AI_DAY_STOP ×(\d+)/.exec(avisos)?.[1] ?? 99)).toBeLessThanOrEqual(3);
      // Y el historial lo cuenta como el último stop.
      const tras = historiales.find((x) => x.now >= cerrada.salidaEn);
      expect(tras?.h?.ultimoStopEn).toBe(cerrada.salidaEn);
      const antes = historiales.filter((x) => x.now < cerrada.salidaEn);
      expect(antes.every((x) => x.h?.ultimoStopEn === null)).toBe(true);
      expect(indiceDe(velas, cerrada.salidaEn)).toBe(k + 1);
      // A la apertura, con el deslizamiento en contra: no al precio del stop.
      const esperado = Number(velas[k + 1].o) * (largo ? 1 - 0.0002 : 1 + 0.0002);
      expect(Number(cerrada.precioSalida)).toBeCloseTo(esperado, 6);
      // Al precio del stop habría sido −1R (con costes, −0,98).
      expect(cerrada.r).toBeLessThan(-2);
      const e = etiquetaDe(velas, cerrada, 72);
      expect(e?.resultado).toBe('STOP');
      expect(Math.abs(e!.r - cerrada.r)).toBeLessThan(0.1);
    });

    it('un hueco más allá de la liquidación liquida, y así queda registrado', async () => {
      // El doble de la distancia a la liquidación en aislado: 1/L − mantenimiento.
      const aLiquidacion = 1 / op.apalancamiento - PARAMS_CANAL.maintenanceMarginRate;
      const apertura = hacia(entrada, -2 * aLiquidacion * entrada);
      const velas = conVelas([
        (t) => velaA(t, apertura, apertura + 0.01, apertura - 0.01, apertura),
      ]);

      const out = await replay(velas, { warmup, config });

      expect(out.liquidations).toBe(1);
      expect(out.operaciones[0]).toMatchObject({ entradaEn: op.entradaEn, salida: 'LIQUIDACION' });
      // Como en el motor, una liquidación deja el bot parado.
      expect(out.operaciones).toHaveLength(1);
    });

    it('en la apertura solo se recoloca el stop: otra condicional no se toca', async () => {
      // Un objetivo condicional muy lejos, del lado bueno: la apertura siempre
      // queda «antes» de él, y recolocarlo lo haría saltar en el acto.
      espiarPlan((ctx, plan) => {
        if (!ctx.position || Number(ctx.position.qty) === 0) return plan;
        const qty = Math.abs(Number(ctx.position.qty)).toFixed(3);
        const lejos = hacia(entrada, entrada / 2).toFixed(2);
        const seq = Number(ctx.cycle.scratch.cycleSeq ?? 1);
        return {
          ...plan,
          orders: [
            ...plan.orders,
            {
              clientOrderId: makeCoid(BOT_CANAL, seq, 'TAKE_PROFIT', 7),
              levelKind: 'TAKE_PROFIT',
              levelIndex: 7,
              side: largo ? 'SELL' : 'BUY',
              type: 'MARKET',
              price: lejos,
              triggerPrice: lejos,
              intent: 'TP',
              qty,
              reduceOnly: true,
            },
          ],
        };
      });

      const out = await replay(candles, { warmup, config });

      expect(out.operaciones[0]).toMatchObject({
        entradaEn: op.entradaEn,
        salidaEn: op.salidaEn,
        salida: op.salida,
      });
    });

    it('un objetivo que el precio toca sin pasar no se llena', async () => {
      const toca = (t: number) =>
        largo
          ? velaA(t, entrada, objetivo, entrada - 0.02, entrada)
          : velaA(t, entrada, entrada + 0.02, objetivo, entrada);
      const pasa = (t: number) =>
        largo
          ? velaA(t, entrada, objetivo + 0.05, entrada - 0.02, objetivo)
          : velaA(t, entrada, entrada + 0.02, objetivo - 0.05, objetivo);
      const velas = conVelas([toca, toca, pasa]);

      const out = await replay(velas, { warmup, config });

      const cerrada = out.operaciones[0];
      expect(cerrada.salida).toBe('OBJETIVO');
      expect(indiceDe(velas, cerrada.salidaEn)).toBe(k + 3);
      expect(Number(cerrada.precioSalida)).toBeCloseTo(objetivo, 8);
      expect(etiquetaDe(velas, cerrada, 72)?.salida).toBe(k + 3);
    });

    it('con posición, la vela va primero hacia el stop aunque abra junto al objetivo', async () => {
      // Con el recorrido «más cercano primero» iría al objetivo: abre a un
      // centavo de él.
      const ambos = (t: number) =>
        largo
          ? velaA(t, objetivo - 0.01, objetivo + 0.05, stop - 0.05, entrada)
          : velaA(t, objetivo + 0.01, stop + 0.05, objetivo - 0.05, entrada);
      const velas = conVelas([ambos]);

      const out = await replay(velas, { warmup, config });

      expect(out.operaciones[0]).toMatchObject({ salida: 'STOP' });
      expect(indiceDe(velas, out.operaciones[0].salidaEn)).toBe(k + 1);
      expect(etiquetaDe(velas, out.operaciones[0], 72)?.resultado).toBe('STOP');
    });
  });
});

describe('el canal con IA en el replay, como en el motor', () => {
  const { warmup, candles } = partirCanal(mercadoCanal({ horasRango: 60 }));

  it('sin IA decide el juez, y el apalancamiento se fija en plano justo antes de cada entrada', async () => {
    const orden: string[] = [];
    const fijar = DryRunAdapter.prototype.setLeverage;
    jest.spyOn(DryRunAdapter.prototype, 'setLeverage').mockImplementation(function (
      this: DryRunAdapter,
      s: string,
      l: number,
      m: MarginMode,
    ) {
      orden.push(`L${l}`);
      return fijar.call(this, s, l, m);
    });
    const colocar = DryRunAdapter.prototype.placeOrder;
    jest.spyOn(DryRunAdapter.prototype, 'placeOrder').mockImplementation(function (
      this: DryRunAdapter,
      req: PlaceOrderRequest,
    ) {
      if (!req.reduceOnly) orden.push(`E${req.timeInForce}`);
      return colocar.call(this, req);
    });

    // En modo IA: el backtest no tiene a quién preguntar.
    const out = await replay(candles, { warmup, config: { decisionMode: 'IA' } });

    expect(out.warnings).toContain(
      'La IA no se consulta en el backtest: decide el juez de reglas, con el mismo perfil y los ' +
        'mismos límites. El resultado mide la herramienta y las reglas, no al modelo.',
    );
    expect(out.operaciones.length).toBeGreaterThan(3);
    const entradas = orden.flatMap((x, i) => (x.startsWith('E') ? [i] : []));
    const abierta = out.warnings.some((w) => w.includes('sigue abierta')) ? 1 : 0;
    expect(entradas).toHaveLength(out.operaciones.length + abierta);
    // Todas IOC, y cada una con su apalancamiento fijado justo antes.
    expect(entradas.every((i) => orden[i] === 'EIOC')).toBe(true);
    const fijados = entradas.map((i) => orden[i - 1]);
    expect(fijados.slice(0, out.operaciones.length)).toEqual(
      out.operaciones.map((o) => `L${o.apalancamiento}`),
    );
    const mmr = PARAMS_CANAL.maintenanceMarginRate;
    for (const o of out.operaciones) {
      expect(o.apalancamiento).toBeLessThanOrEqual(MERCADO_CANAL.maxLeverage);
      expect(o.setup).toBe('REBOTE');
      // La regla por stop, con el mantenimiento que liquida en el simulador: la
      // liquidación queda a tres stops o más (con un 1 % de holgura por el
      // precio de entrada real).
      const s = Math.abs(Number(o.precioEntrada) - Number(o.stop)) / Number(o.precioEntrada);
      expect(1 / o.apalancamiento - mmr).toBeGreaterThanOrEqual(3 * s * (1 + mmr) * 0.99);
    }
    // Con el perfil agresivo sale el escalonado: un breakeven por operación, no
    // uno por cada vela que dura.
    const avisos = out.warnings.find((w) => w.startsWith('Avisos de la estrategia')) ?? '';
    const breakevens = Number(/AI_BREAKEVEN ×(\d+)/.exec(avisos)?.[1] ?? 0);
    expect(breakevens).toBeGreaterThan(0);
    expect(breakevens).toBeLessThanOrEqual(out.operaciones.length + 1);
  });

  it('el plan solo ve velas cerradas, con el calentamiento dentro', async () => {
    const vistas: { now: number; series: [string, Candle[]][] }[] = [];
    espiarPlan((ctx, plan) => {
      vistas.push({ now: ctx.now, series: Object.entries(ctx.series ?? {}) });
      return plan;
    });

    await replay(candles, { warmup });

    // Una vez por vela, salvo en la espera tras un cierre (y más tras cada ejecución).
    expect(vistas.length).toBeGreaterThan(candles.length * 0.9);
    for (const v of vistas) {
      for (const [iv, velas] of v.series) {
        const ultima = velas[velas.length - 1];
        expect(ultima.t + candleSpanMs(iv as CandleInterval)).toBeLessThanOrEqual(v.now + 1);
      }
    }
    // Desde la primera vela, la serie de 1 h trae las horas del calentamiento.
    const primera = new Map(vistas[0].series);
    expect(primera.get('1h')?.length).toBe(310);
    expect(primera.get('5m')).toHaveLength(144);
    expect(primera.get('15m')).toHaveLength(1000);
  });

  it('cada serie, topada en lo que el venue sirve de una vez', async () => {
    const vistas: Map<string, Candle[]>[] = [];
    espiarPlan((ctx, plan) => {
      if (vistas.length === 0) vistas.push(new Map(Object.entries(ctx.series ?? {})));
      return plan;
    });

    // Lighter sirve 500 velas por petición: la de 15 min se queda en 497.
    await replay(candles.slice(0, 12), { warmup, venue: Venue.LIGHTER });

    expect(vistas[0].get('15m')).toHaveLength(497);
    expect(vistas[0].get('1h')).toHaveLength(310);
  });

  it('un calentamiento que se solapa con el rango no duplica velas', async () => {
    const limpio = await replay(candles, { warmup });
    const solapado = await replay(candles, { warmup: [...warmup, ...candles.slice(0, 24)] });
    expect(solapado.operaciones).toEqual(limpio.operaciones);
    expect(solapado.operaciones.length).toBeGreaterThan(0);
  });

  it('sin calentamiento no tiene con qué decidir al empezar, y lo avisa', async () => {
    const sin = await replay(candles);
    expect(sin.operaciones).toEqual([]);
    expect(
      sin.warnings.some((w) =>
        w.startsWith('Calentamiento corto: al empezar, la serie de 1h tiene 0'),
      ),
    ).toBe(true);

    const con = await replay(candles, { warmup });
    expect(con.operaciones.length).toBeGreaterThan(0);
    // Con 310 horas, solo la serie de 1 h va corta.
    const cortas = con.warnings.filter((w) => w.startsWith('Calentamiento corto'));
    expect(cortas).toEqual([
      'Calentamiento corto: al empezar, la serie de 1h tiene 310 de las 480 velas que pide la ' +
        'estrategia. Hasta completarla decide con menos histórico del que tendría en vivo.',
    ]);
  });

  it('el historial del día lleva lo cerrado', async () => {
    const vistos: { now: number; h: HistorialOperaciones | undefined }[] = [];
    const contextos: BotContext[] = [];
    espiarPlan((ctx, plan) => {
      vistos.push({ now: ctx.now, h: ctx.historial });
      if (contextos.length === 0) contextos.push(ctx);
      return plan;
    });

    const out = await replay(candles, { warmup });

    const primera = out.operaciones[0];
    const antes = vistos.filter((v) => v.now < primera.salidaEn);
    expect(antes.every((v) => v.h?.operacionesHoy === 0 && v.h?.ultimoCierreEn === null)).toBe(
      true,
    );
    const despues = vistos.find((v) => v.now >= primera.salidaEn)!;
    expect(despues.h).toMatchObject({
      operacionesHoy: 1,
      realizadoHoy: primera.resultado,
      realizadoTotal: primera.resultado,
      ultimoCierreEn: primera.salidaEn,
      rachaPerdidas: primera.r < 0 ? 1 : 0,
    });
    expect(despues.h?.dia).toBe(Math.floor(despues.now / 86_400_000) * 86_400_000);

    // Tras el segundo cierre, el último es ese y el total suma los dos.
    const segunda = out.operaciones[1];
    const trasSegunda = vistos.find((v) => v.now >= segunda.salidaEn)!;
    expect(trasSegunda.h).toMatchObject({
      ultimoCierreEn: segunda.salidaEn,
      realizadoTotal: D(primera.resultado).plus(segunda.resultado).toFixed(),
    });

    // Un tramo, de la ficha y con el mantenimiento del simulador, y ningún
    // límite de fuera: es un bot solo.
    expect(contextos[0].nivelesApalancamiento).toEqual([
      {
        desdeNocional: '0',
        maxApalancamiento: MERCADO_CANAL.maxLeverage,
        mantenimiento: PARAMS_CANAL.maintenanceMarginRate,
      },
    ]);
    expect(contextos[0].limites).toEqual({
      entradasPermitidas: true,
      maxApalancamientoUsuario: null,
      venueListo: true,
      motivo: null,
    });
    expect(contextos[0].decisionIa).toBeNull();
  });

  it('sin stop en el libro, el vigilante cierra la posición a mercado', async () => {
    const colocar = DryRunAdapter.prototype.placeOrder;
    jest.spyOn(DryRunAdapter.prototype, 'placeOrder').mockImplementation(function (
      this: DryRunAdapter,
      req: PlaceOrderRequest,
    ) {
      if (req.triggerPrice) return Promise.reject(new Error('stop no admitido'));
      return colocar.call(this, req);
    });

    const out = await replay(candles, { warmup });

    expect(out.operaciones.length).toBeGreaterThan(0);
    for (const o of out.operaciones) {
      expect(o).toMatchObject({ salida: 'CIERRE', salidaEn: o.entradaEn });
    }
    expect(out.warnings.some((w) => w.includes('se quedó sin stop'))).toBe(true);
    expect(out.warnings.some((w) => w.includes('stop no admitido'))).toBe(true);
  });

  it('el stop sale aunque no llegue al mínimo del venue; uno imposible, no', async () => {
    const encoger = (qty: string) =>
      espiarPlan((_ctx, plan) => ({
        ...plan,
        orders: plan.orders.map((o) => (o.levelKind === 'STOP_LOSS' ? { ...o, qty } : o)),
      }));

    // 0,05 × ~100 son 5 USDC, por debajo de los 10 del mercado.
    encoger('0.050');
    const pequeno = await replay(candles, { warmup });
    expect(pequeno.operaciones.length).toBeGreaterThan(0);
    expect(pequeno.warnings.some((w) => w.includes('se quedó sin stop'))).toBe(false);
    jest.restoreAllMocks();

    // Con cantidad cero no hay stop que mandar: el vigilante cierra.
    encoger('0');
    const imposible = await replay(candles, { warmup });
    expect(imposible.warnings.some((w) => w.includes('se quedó sin stop'))).toBe(true);
  });

  it('si la estrategia pide pausar, el replay se para ahí', async () => {
    let llamadas = 0;
    espiarPlan((_ctx, plan) => (++llamadas === 50 ? { ...plan, pausar: 'prueba' } : plan));

    const out = await replay(candles, { warmup });

    expect(out.equity.length).toBeLessThanOrEqual(50);
    expect(out.warnings.some((w) => w.includes('pausó el bot') && w.includes('prueba'))).toBe(true);
  });

  it('con posición ni se entra ni se toca el apalancamiento', async () => {
    const intruso = makeCoid(BOT_CANAL, 1, 'BASE', 77);
    espiarPlan((ctx, plan) => {
      if (!ctx.position || Number(ctx.position.qty) === 0) return plan;
      return {
        ...plan,
        apalancamiento: 3,
        orders: [
          ...plan.orders,
          {
            clientOrderId: intruso,
            levelKind: 'BASE',
            levelIndex: 77,
            side: 'BUY',
            type: 'LIMIT',
            timeInForce: 'IOC',
            price: ctx.ticker.ask,
            qty: '1',
            reduceOnly: false,
          },
        ],
      };
    });
    const fijados: number[] = [];
    const fijar = DryRunAdapter.prototype.setLeverage;
    jest.spyOn(DryRunAdapter.prototype, 'setLeverage').mockImplementation(function (
      this: DryRunAdapter,
      s: string,
      l: number,
      m: MarginMode,
    ) {
      fijados.push(l);
      return fijar.call(this, s, l, m);
    });
    const colocados: string[] = [];
    const colocar = DryRunAdapter.prototype.placeOrder;
    jest.spyOn(DryRunAdapter.prototype, 'placeOrder').mockImplementation(function (
      this: DryRunAdapter,
      req: PlaceOrderRequest,
    ) {
      colocados.push(req.clientOrderId);
      return colocar.call(this, req);
    });

    const out = await replay(candles, { warmup });

    expect(out.operaciones.length).toBeGreaterThan(0);
    expect(fijados).not.toContain(3);
    expect(colocados).not.toContain(intruso);
  });
});

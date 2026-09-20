import {
  BandaApalancamiento,
  EsquemaObjetivo,
  EstadoIntencion,
  LevelKind,
  MotivoRechazo,
  NivelConfianza,
  OrigenDecision,
  StrategyKind,
  TamanoOperacion,
  TipoCanal,
  TipoSetup,
  TipoStop,
  Veredicto,
  vistaCanalDe,
  type BotConfig,
  type BotContext,
  type DecisionIa,
  type EleccionOperacion,
  type LimitesExternos,
  type PlanOperacion,
  type Position,
} from '@crypton/shared';
import { vaciarCacheAnalisis } from '../canal/analisis';
import { DEFAULTS_CANAL } from '../canal/config';
import {
  CINCO_MIN,
  HORA,
  QUINCE_MIN,
  T0_CANAL,
  escenarioCanal,
  historiaConRango,
  historialDePrueba,
  senoidal,
} from '../canal/testing-canal';
import { makeCoid } from '../client-order-id';
import { validateCommon } from '../common';
import { getStrategy } from '../registry';
import { BASE_CONFIG, makeContext, makeMarket, makePosition, makeVenueOrder } from '../testing';
import {
  INDICE_CIERRE,
  MAX_INTENTOS_CIERRE,
  type CierreEnCurso,
  type OperacionGuardada,
} from './ai-channel';

const s = getStrategy(StrategyKind.AI_CHANNEL);
const BOT = '1a2b3c4d-0000-0000-0000-000000000000';
const SEQ = 3;
const coid = (kind: LevelKind, i: number) => makeCoid(BOT, SEQ, kind, i);
const MARKET = {
  tickSize: '0.01',
  stepSize: '0.001',
  priceDecimals: 2,
  qtyDecimals: 3,
  maxLeverage: 50,
  minNotional: '10',
};
const LIMITES: LimitesExternos = {
  entradasPermitidas: true,
  maxApalancamientoUsuario: null,
  venueListo: true,
  motivo: null,
};
const config = (extra: Record<string, unknown> = {}): BotConfig => ({
  ...BASE_CONFIG,
  ...s.defaults(),
  totalInvestment: '1000',
  ...extra,
});

beforeEach(() => vaciarCacheAnalisis());

// ── El contrato ─────────────────────────────────────────────────────────────

describe('AI_CHANNEL: el contrato', () => {
  it('declara los flags del canal y ninguno de los de las rejillas', () => {
    expect(s).toMatchObject({
      kind: StrategyKind.AI_CHANNEL,
      stopPropio: true,
      apalancamientoPorOperacion: true,
      reglaLiquidacion: 'POR_STOP',
      topeDiarioReanuda: true,
      consumeDecisionesIa: true,
    });
    expect(s.reusesOrderSlots).toBeUndefined();
    expect(s.keepCycleOnFlat).toBeUndefined();
    expect(s.candles).toBeUndefined();
  });

  it('pide 5 min, 15 min y 1 h; con estructura de 5 min, sin la de 15', () => {
    // La estructura se DERIVA: `ventanaCanal + 8 × 70`, las ventanas de
    // muestreo que necesitan las tasas base para llegar a evidencia MODERADA.
    // Antes eran mil velas planas, que en Hyperliquid pesan 37 contra un
    // depósito que valía 34 (spec 065).
    expect(s.series?.(config())).toEqual([
      { interval: '5m', bars: 144 },
      { interval: '15m', bars: 656 },
      { interval: '1h', bars: 480 },
    ]);
    expect(s.series?.(config({ structureInterval: '5m' }))).toEqual([
      { interval: '5m', bars: 656 },
      { interval: '1h', bars: 480 },
    ]);
  });

  it('y la ventana del canal la arrastra: con la ventana al máximo, más velas', () => {
    // Con un número plano, quien pusiera la ventana en 200 se quedaría en 57
    // muestras y perdería la banda MODERADA sin enterarse.
    const serie = s.series?.(config({ channelWindowBars: 200 }))?.find((x) => x.interval === '15m');
    expect(serie?.bars).toBe(760);
  });

  it('el nocional máximo: capital por múltiplo, por el tope de palanca y por el tope fijo', () => {
    expect(s.nocionalMaximo?.(config())).toBe('5000');
    expect(s.nocionalMaximo?.(config({ maxNotionalCap: '3000' }))).toBe('3000');
    expect(s.nocionalMaximo?.(config({ leverage: 2 }))).toBe('2000');
  });

  it('defaults() son los de DEFAULTS_CANAL, sin capital', () => {
    expect(s.defaults()).toEqual({ ...DEFAULTS_CANAL });
    expect(s.defaults()['totalInvestment']).toBeUndefined();
  });
});

// ── Validación y vista previa ──────────────────────────────────────────────

describe('AI_CHANNEL: validate', () => {
  const m = makeMarket();
  const errorEn = (cfg: BotConfig, field: string, market = m) =>
    s.validate(cfg, market).issues.some((i) => i.field === field && i.severity === 'ERROR');
  const avisoEn = (cfg: BotConfig, field: string) =>
    s.validate(cfg, m).issues.some((i) => i.field === field && i.severity === 'WARNING');

  it('los valores por defecto con capital valen, y a 25x por la regla del stop', () => {
    expect(s.validate(config(), m).ok).toBe(true);
    // La misma palanca en una rejilla la rechaza la regla del 5 %.
    const grid = getStrategy(StrategyKind.GRID_CLASSIC);
    const cfgGrid = {
      ...BASE_CONFIG,
      ...grid.defaults(),
      lowerPrice: '90',
      upperPrice: '110',
      gridLevels: 5,
      leverage: 25,
    };
    expect(grid.validate(cfgGrid as BotConfig, m).issues.some((i) => i.field === 'leverage')).toBe(
      true,
    );
  });

  it('el techo: 25x y el máximo del par', () => {
    expect(errorEn(config({ leverage: 26 }), 'leverage')).toBe(true);
    expect(errorEn(config({ leverage: 25 }), 'leverage', makeMarket({ maxLeverage: 20 }))).toBe(
      true,
    );
    expect(errorEn(config({ leverage: 20 }), 'leverage', makeMarket({ maxLeverage: 20 }))).toBe(
      false,
    );
  });

  it('solo margen aislado', () => {
    expect(errorEn(config({ marginMode: 'CROSS' }), 'marginMode')).toBe(true);
  });

  it('riesgo por operación hasta el 2 % y tope diario hasta el 6 %, nunca por debajo del riesgo', () => {
    expect(errorEn(config({ riskPerTradePct: '2.5' }), 'riskPerTradePct')).toBe(true);
    expect(errorEn(config({ riskPerTradePct: '2' }), 'riskPerTradePct')).toBe(false);
    expect(errorEn(config({ maxDailyLossPct: '7' }), 'maxDailyLossPct')).toBe(true);
    expect(errorEn(config({ maxDailyLossPct: '0.5' }), 'maxDailyLossPct')).toBe(true);
    expect(errorEn(config({ maxDailyLossPct: '1' }), 'maxDailyLossPct')).toBe(false);
  });

  it('las ventanas sin entradas tienen que estar bien escritas', () => {
    expect(errorEn(config({ noEntryWindowsUtc: 'por la mañana' }), 'noEntryWindowsUtc')).toBe(true);
    expect(
      errorEn(config({ noEntryWindowsUtc: '22:00-02:00, 13:25-13:45' }), 'noEntryWindowsUtc'),
    ).toBe(false);
  });

  it('un stop loss por porcentaje solo avisa: no se usa', () => {
    expect(avisoEn(config({ stopLossPct: '2' }), 'stopLossPct')).toBe(true);
    expect(errorEn(config({ stopLossPct: '2' }), 'stopLossPct')).toBe(false);
  });

  it('el capital tiene que llegar al mínimo del venue con el stop más ancho', () => {
    // 50 · 1 % = 0,5 de riesgo; con un stop del 1,5 % y costes, unos 31 de nocional.
    expect(errorEn(config({ totalInvestment: '50' }), 'totalInvestment')).toBe(false);
    expect(
      errorEn(
        config({ totalInvestment: '50' }),
        'totalInvestment',
        makeMarket({ minNotional: '100' }),
      ),
    ).toBe(true);
  });

  it('avisa de la ruptura fallida y del modo reglas', () => {
    expect(avisoEn(config({ allowedSetups: 'TODOS' }), 'allowedSetups')).toBe(true);
    expect(avisoEn(config({ decisionMode: 'REGLAS' }), 'decisionMode')).toBe(true);
    expect(avisoEn(config(), 'allowedSetups')).toBe(false);
  });
});

describe('validateCommon con la regla por stop', () => {
  const comun = (leverage: number, opciones = { reglaLiquidacion: 'POR_STOP' as const }) =>
    validateCommon({ ...BASE_CONFIG, leverage }, makeMarket(), opciones).filter(
      (i) => i.field === 'leverage',
    );

  it('no aplica el 5 % y pone el techo en 25x', () => {
    // El mercado de pruebas admite 40x con un mantenimiento del 1,25 %: la regla
    // del 5 % cortaría en 16x.
    expect(comun(25)).toEqual([]);
    expect(comun(26)).toEqual([expect.objectContaining({ severity: 'ERROR' })]);
    expect(comun(20, {} as never).some((i) => i.severity === 'ERROR')).toBe(true);
  });
});

describe('AI_CHANNEL: preview', () => {
  it('enseña los límites y una operación de ejemplo con el stop más ancho', () => {
    const p = s.preview(config(), makeMarket(), '100');
    expect(p.valid).toBe(true);
    expect(p.levels).toHaveLength(1);
    const textos = p.issues.map((i) => i.message).join(' | ');
    // 1 % de 1000 por operación y 6 % al día; hasta 5000 de nocional; 250 en un hueco.
    expect(textos).toMatch(/10\.00 por operación/);
    expect(textos).toMatch(/60\.00 al día/);
    expect(textos).toMatch(/nocional hasta 5000\.00/);
    expect(textos).toMatch(/como mucho 250\.00/);
    // Stop del 1,5 %, ATR de 1 h del 1 % y mantenimiento del 1,25 %: 1/(0,0125 + 0,045·1,0125) = 17x.
    expect(textos).toMatch(/baja a 17x/);
  });

  it('sin capital es inválida y no lanza', () => {
    expect(() => s.preview(s.defaults() as never, makeMarket(), '100')).not.toThrow();
    expect(s.preview(s.defaults() as never, makeMarket(), '100').valid).toBe(false);
  });
});

// ── Con posición ────────────────────────────────────────────────────────────

const AHORA = T0_CANAL + HORA;

function operacion(
  o: Partial<PlanOperacion> = {},
  extra: Partial<OperacionGuardada> = {},
): OperacionGuardada {
  const eleccion: EleccionOperacion = {
    veredicto: Veredicto.OPERAR,
    opcion: `REB-L-H${T0_CANAL}`,
    stop: TipoStop.AJUSTADO,
    objetivo: EsquemaObjetivo.ESCALONADO,
    apalancamiento: BandaApalancamiento.ALTA,
    tamano: TamanoOperacion.COMPLETO,
    confianza: NivelConfianza.ALTA,
  };
  const plan: PlanOperacion = {
    intentId: 'int-1',
    candidatoId: `REB-L-H${T0_CANAL}`,
    setup: TipoSetup.REBOTE,
    lado: 'LONG',
    eleccion,
    entradaReferencia: '100.02',
    entradaTope: '100.05',
    stop: '99.84',
    objetivos: [
      { precio: '101.4', cantidad: '18.754' },
      { precio: '102.45', cantidad: '12.503' },
    ],
    cantidad: '31.257',
    apalancamiento: 25,
    nocional: '3127.26285',
    riesgo: '9.9996925545',
    rNeto: 4.2,
    liquidacionEstimada: '97.02',
    huella: 'h',
    barT: T0_CANAL,
    canal: {
      tipo: TipoCanal.HORIZONTAL,
      soporte: '99.9',
      resistencia: '102.9',
      media: '101.4',
      pendientePorVela: 0,
      refT: T0_CANAL,
    },
    venceEn: AHORA + 6 * HORA,
    distanciaStop: 0.21 / 100.05,
    ...o,
  };
  return { plan, intento: 0, enviadaEn: AHORA - 60_000, ...extra };
}

interface OpcionesPosicion {
  qty?: string;
  entrada?: string;
  marca?: string;
  op?: OperacionGuardada | null;
  scratch?: Record<string, unknown>;
  config?: Record<string, unknown>;
  now?: number;
  posicion?: Partial<Position>;
  extra?: Partial<BotContext>;
}

function conPosicion(o: OpcionesPosicion = {}): BotContext {
  const op = o.op === undefined ? operacion() : o.op;
  const marca = o.marca ?? '100.5';
  const ctx = makeContext({
    strategy: StrategyKind.AI_CHANNEL,
    config: config(o.config),
    price: marca,
    position: {
      ...makePosition(o.qty ?? '31.257', o.entrada ?? '100.03', marca),
      leverage: 25,
      ...o.posicion,
    },
    cycle: {
      entriesFilled: 1,
      averageEntry: o.entrada ?? '100.03',
      scratch: { cycleSeq: SEQ, ...(op ? { op } : {}), ...o.scratch },
    },
    market: MARKET,
    now: o.now ?? AHORA,
  });
  return { ...ctx, ...o.extra };
}

const stopDe = (
  orden: { price: string; qty: string; side: string },
  precio: string,
  qty: string,
  side = 'SELL',
) => {
  expect(orden).toMatchObject({ price: precio, qty, side });
};

describe('AI_CHANNEL: con posición', () => {
  it('stop y los dos objetivos de la operación guardada, sin necesidad de velas', () => {
    const plan = s.plan(conPosicion());
    expect(plan.immediate).toEqual([]);
    expect(plan.orders).toEqual([
      {
        clientOrderId: coid(LevelKind.STOP_LOSS, 0),
        levelKind: LevelKind.STOP_LOSS,
        levelIndex: 0,
        side: 'SELL',
        type: 'MARKET',
        price: '99.84',
        triggerPrice: '99.84',
        qty: '31.257',
        reduceOnly: true,
      },
      {
        clientOrderId: coid(LevelKind.TAKE_PROFIT, 0),
        levelKind: LevelKind.TAKE_PROFIT,
        levelIndex: 0,
        side: 'SELL',
        type: 'LIMIT',
        timeInForce: 'GTC',
        price: '101.4',
        qty: '18.754',
        reduceOnly: true,
      },
      {
        clientOrderId: coid(LevelKind.TAKE_PROFIT, 1),
        levelKind: LevelKind.TAKE_PROFIT,
        levelIndex: 1,
        side: 'SELL',
        type: 'LIMIT',
        timeInForce: 'GTC',
        price: '102.45',
        qty: '12.503',
        reduceOnly: true,
      },
    ]);
    // La mayor posición vista se guarda: de ella salen los tramos.
    expect(plan.scratchPatch).toEqual({ op: { ...operacion(), maximo: '31.257' } });
    expect(plan.note).toMatch(/Largo en marcha/);
  });

  it('un llenado parcial reparte los objetivos en la misma proporción', () => {
    const plan = s.plan(conPosicion({ qty: '20' }));
    const tps = plan.orders.filter((o) => o.levelKind === LevelKind.TAKE_PROFIT);
    // 20 · 18,754 / 31,257 = 11,9998… → 11,999; el resto al segundo.
    expect(tps.map((o) => [o.price, o.qty])).toEqual([
      ['101.4', '11.999'],
      ['102.45', '8.001'],
    ]);
    stopDe(plan.orders[0], '99.84', '20.000');
  });

  /**
   * Spec 062, F-22. El reparto era de arriba abajo, asi que lo ejecutado se le
   * restaba siempre al SEGUNDO objetivo: con el primero cobrado a medias, el
   * primero se quedaba con toda la posicion y el segundo se cancelaba. La
   * operacion cobraba entera en el objetivo corto.
   */
  it('lo cobrado del primer objetivo no se le quita al segundo', () => {
    const vivida = operacion({}, { maximo: '31.257' });
    // Del primer tramo (18,754) se han cobrado 6,257: quedan 25.
    const plan = s.plan(conPosicion({ op: vivida, qty: '25' }));
    const tps = plan.orders.filter((o) => o.levelKind === LevelKind.TAKE_PROFIT);
    expect(tps.map((o) => [o.levelIndex, o.price, o.qty])).toEqual([
      [0, '101.4', '12.497'],
      [1, '102.45', '12.503'],
    ]);

    // Y con el primer tramo casi entero cobrado, el segundo conserva el suyo.
    const casi = s.plan(conPosicion({ op: vivida, qty: '13' }));
    expect(
      casi.orders
        .filter((o) => o.levelKind === LevelKind.TAKE_PROFIT)
        .map((o) => [o.levelIndex, o.qty]),
    ).toEqual([
      [0, '0.497'],
      [1, '12.503'],
    ]);
  });

  it('un resto que no llega al mínimo del venue se suma al otro objetivo', () => {
    const vivida = operacion({}, { maximo: '31.257' });
    // Quedan 12,533: 0,03 al primer objetivo son 3 USDC, por debajo del mínimo.
    const plan = s.plan(conPosicion({ op: vivida, qty: '12.533' }));
    expect(
      plan.orders
        .filter((o) => o.levelKind === LevelKind.TAKE_PROFIT)
        .map((o) => [o.levelIndex, o.qty]),
    ).toEqual([[1, '12.533']]);
  });

  it('un único objetivo lleva toda la posición', () => {
    const op = operacion({
      objetivos: [{ precio: '101.4', cantidad: '31.257' }],
      eleccion: { ...operacion().plan.eleccion, objetivo: EsquemaObjetivo.MEDIA },
    });
    const plan = s.plan(conPosicion({ op }));
    expect(plan.orders.map((o) => [o.levelKind, o.levelIndex, o.price, o.qty])).toEqual([
      [LevelKind.STOP_LOSS, 0, '99.84', '31.257'],
      [LevelKind.TAKE_PROFIT, 0, '101.4', '31.257'],
    ]);
  });

  describe('breakeven tras el primer objetivo', () => {
    const tras = operacion({}, { maximo: '31.257' });

    it('el stop pasa a la entrada más costes y solo queda el segundo objetivo', () => {
      const plan = s.plan(conPosicion({ op: tras, qty: '12.503', marca: '101.5' }));
      // 100,03 · (1 + (2·4,5 + 2)/10 000) = 100,140033 → hacia arriba, 100,15.
      expect(plan.orders.map((o) => [o.levelKind, o.levelIndex, o.price, o.qty])).toEqual([
        [LevelKind.STOP_LOSS, 0, '100.15', '12.503'],
        [LevelKind.TAKE_PROFIT, 1, '102.45', '12.503'],
      ]);
      expect(plan.scratchPatch).toEqual({
        op: { ...tras, tp1Hecho: true, stopBreakeven: '100.15' },
      });
      expect(plan.avisos).toEqual([
        expect.objectContaining({
          clave: 'breakeven:int-1',
          tipo: 'AI_BREAKEVEN',
          severidad: 'INFO',
        }),
      ]);
      expect(plan.note).toMatch(/\(breakeven\)/);
    });

    it('con la marca por debajo del breakeven, espera: un stop así saltaría al colocarlo', () => {
      const plan = s.plan(conPosicion({ op: tras, qty: '12.503', marca: '100.10' }));
      stopDe(plan.orders[0], '99.84', '12.503');
      expect(plan.scratchPatch).toEqual({ op: { ...tras, tp1Hecho: true } });
    });

    it('una vez puesto no vuelve atrás, aunque el precio baje', () => {
      const op = operacion({}, { maximo: '31.257', tp1Hecho: true, stopBreakeven: '100.15' });
      const plan = s.plan(conPosicion({ op, qty: '12.503', marca: '100.10' }));
      stopDe(plan.orders[0], '100.15', '12.503');
      expect(plan.immediate).toEqual([]);
      expect(plan.scratchPatch).toBeUndefined();
    });

    it('apagado, el stop no se mueve', () => {
      const plan = s.plan(
        conPosicion({
          op: tras,
          qty: '12.503',
          marca: '101.5',
          config: { breakevenAfterTp1: false },
        }),
      );
      stopDe(plan.orders[0], '99.84', '12.503');
    });
  });

  describe('salidas deterministas', () => {
    const cierre = (plan: ReturnType<typeof s.plan>) =>
      plan.scratchPatch?.['cierre'] as CierreEnCurso | undefined;

    it('por tiempo: a mercado, reduceOnly, con el stop puesto mientras tanto', () => {
      const op = operacion();
      const plan = s.plan(conPosicion({ now: op.plan.venceEn }));
      expect(plan.immediate).toEqual([
        {
          clientOrderId: coid(LevelKind.TAKE_PROFIT, INDICE_CIERRE),
          levelKind: LevelKind.TAKE_PROFIT,
          levelIndex: INDICE_CIERRE,
          side: 'SELL',
          type: 'MARKET',
          price: '100.50',
          qty: '31.257',
          reduceOnly: true,
        },
      ]);
      expect(plan.orders.map((o) => o.levelKind)).toEqual([LevelKind.STOP_LOSS]);
      expect(cierre(plan)).toEqual({ motivo: 'TIEMPO', intentos: 1, ultimoEn: op.plan.venceEn });
      expect(plan.avisos).toEqual([
        // La orden de salir va en INFO: el resultado lo avisa el motor al cerrar (spec 059).
        expect.objectContaining({ clave: 'salida:int-1', tipo: 'AI_CIERRE', severidad: 'INFO' }),
      ]);
    });

    it('reintenta cada 30 s con otro id, y a los 12 intentos avisa en CRITICAL', () => {
      const previo = (intentos: number, hace: number) => ({
        cierre: { motivo: 'TIEMPO', intentos, ultimoEn: AHORA - hace },
      });
      const pronto = s.plan(conPosicion({ scratch: previo(1, 10_000) }));
      expect(pronto.immediate).toEqual([]);
      expect(pronto.avisos).toBeUndefined();
      const luego = s.plan(conPosicion({ scratch: previo(1, 31_000) }));
      expect(luego.immediate.map((o) => o.clientOrderId)).toEqual([
        coid(LevelKind.TAKE_PROFIT, INDICE_CIERRE + 1),
      ]);
      expect(cierre(luego)).toEqual({ motivo: 'TIEMPO', intentos: 2, ultimoEn: AHORA });
      const agotado = s.plan(conPosicion({ scratch: previo(MAX_INTENTOS_CIERRE, 60_000) }));
      expect(agotado.immediate).toEqual([]);
      expect(agotado.avisos).toEqual([
        expect.objectContaining({ tipo: 'AI_CIERRE_FALLIDO', severidad: 'CRITICAL' }),
      ]);
      expect(agotado.orders.map((o) => o.levelKind)).toEqual([LevelKind.STOP_LOSS]);
    });

    it('el precio pasó el stop y el stop no saltó', () => {
      // 99,84 · (1 − 0,5 · 0,0021) = 99,735
      expect(cierre(s.plan(conPosicion({ marca: '99.70' })))?.motivo).toBe('STOP_NO_SALTO');
      expect(cierre(s.plan(conPosicion({ marca: '99.80' })))).toBeUndefined();
    });

    it('la liquidación del venue demasiado cerca del stop', () => {
      // Tiene que quedar medio stop por detrás: 99,84 − 100,03·0,0021·0,5 = 99,735.
      expect(cierre(s.plan(conPosicion({ posicion: { liquidationPrice: '99.8' } })))?.motivo).toBe(
        'LIQUIDACION',
      );
      expect(
        cierre(s.plan(conPosicion({ posicion: { liquidationPrice: '97.02' } }))),
      ).toBeUndefined();
    });

    it('el venue informa más apalancamiento del pedido', () => {
      expect(cierre(s.plan(conPosicion({ posicion: { leverage: 50 } })))?.motivo).toBe(
        'APALANCAMIENTO',
      );
    });

    describe('con velas', () => {
      const esc = escenarioCanal();
      const precio = String(esc.centro.toFixed(2));
      const alrededor = (soporte: number, resistencia: number) =>
        operacion(
          {
            stop: '100',
            canal: {
              tipo: TipoCanal.HORIZONTAL,
              soporte: String(soporte),
              resistencia: String(resistencia),
              media: String((soporte + resistencia) / 2),
              pendientePorVela: 0,
              refT: esc.fin - QUINCE_MIN,
            },
            venceEn: esc.fin + 6 * HORA,
          },
          { enviadaEn: esc.fin - 20 * 60_000 },
        );
      const ctx = (op: OperacionGuardada, series = esc.series, qty = '31.257') =>
        conPosicion({
          op,
          qty,
          marca: precio,
          now: esc.fin + 4000,
          extra: { series, historial: historialDePrueba() },
        });

      it('invalidación: la vela de 15 min cerró fuera del canal de la entrada', () => {
        // El último cierre de 15 min está 0,57 por debajo del centro.
        const fuera = alrededor(esc.centro + 2, esc.centro + 5);
        expect(cierre(s.plan(ctx(fuera)))?.motivo).toBe('INVALIDACION');
        const dentro = alrededor(esc.soporte, esc.resistencia);
        expect(cierre(s.plan(ctx(dentro)))).toBeUndefined();
      });

      it('la invalidación solo mira velas que cerraron después de la entrada', () => {
        const fuera = { ...alrededor(esc.centro + 2, esc.centro + 5), enviadaEn: esc.fin };
        expect(cierre(s.plan(ctx(fuera)))).toBeUndefined();
      });

      it('régimen: una tendencia en contra cierra; a favor, no', () => {
        const bajista = { ...esc.series, '1h': historiaConRango(7919, 480, 0, 1) };
        const largo = alrededor(esc.soporte, esc.resistencia);
        expect(cierre(s.plan(ctx(largo, bajista)))?.motivo).toBe('REGIMEN');
        const corto = operacion(
          {
            ...largo.plan,
            lado: 'SHORT',
            stop: '200',
            objetivos: [{ precio: '100', cantidad: '31.257' }],
          },
          { enviadaEn: largo.enviadaEn },
        );
        expect(cierre(s.plan(ctx(corto, bajista, '-31.257')))).toBeUndefined();
      });
    });
  });

  describe('posición huérfana', () => {
    it('sin operación guardada: stop de emergencia al máximo del stop y aviso CRITICAL', () => {
      const plan = s.plan(conPosicion({ op: null }));
      // 100,03 · 0,985 = 98,52955 → hacia arriba, 98,53.
      expect(plan.orders).toEqual([
        expect.objectContaining({
          clientOrderId: coid(LevelKind.STOP_LOSS, 0),
          side: 'SELL',
          price: '98.53',
          triggerPrice: '98.53',
          qty: '31.257',
          reduceOnly: true,
        }),
      ]);
      expect(plan.avisos).toEqual([
        expect.objectContaining({ clave: `huerfana:${SEQ}`, severidad: 'CRITICAL' }),
      ]);
    });

    it('más allá del stop de emergencia, a mercado', () => {
      const plan = s.plan(conPosicion({ op: null, marca: '98.00' }));
      expect(plan.immediate.map((o) => [o.clientOrderId, o.type, o.reduceOnly])).toEqual([
        [coid(LevelKind.TAKE_PROFIT, INDICE_CIERRE), 'MARKET', true],
      ]);
      expect((plan.scratchPatch?.['cierre'] as CierreEnCurso).motivo).toBe('HUERFANA');
    });

    /**
     * Spec 062, F-24. A 25x la liquidacion esta a un 2 % de la entrada: un stop
     * de emergencia al 1,5 —o al 3, o al 5— queda DETRAS, asi que no protegia
     * de nada. Se acota a dos tercios del camino, que es donde la guarda del
     * motor cierra.
     */
    it('el stop de emergencia no se pone detrás de la liquidación', () => {
      const plan = s.plan(conPosicion({ op: null, posicion: { liquidationPrice: '98.03' } }));
      // Camino 100,03 → 98,03; dos tercios: 98,6967 → hacia arriba, 98,70.
      expect(plan.orders[0]).toMatchObject({ price: '98.70', triggerPrice: '98.70' });
      expect(plan.avisos?.[0]?.mensaje).toMatch(/al 1.33 % de la entrada/);

      // Un corto, al revés.
      const corto = s.plan(
        conPosicion({ op: null, qty: '-31.257', posicion: { liquidationPrice: '102.03' } }),
      );
      expect(corto.orders[0]).toMatchObject({ side: 'BUY', price: '101.36' });
    });

    it('una operación del otro lado tampoco vale', () => {
      const plan = s.plan(conPosicion({ qty: '-31.257' }));
      // 100,03 · 1,015 = 101,53045 → hacia abajo, 101,53; el stop de un corto compra.
      expect(plan.orders[0]).toMatchObject({ side: 'BUY', price: '101.53' });
      expect(plan.avisos?.[0]?.severidad).toBe('CRITICAL');
    });
  });
});

// ── En plano ────────────────────────────────────────────────────────────────

const esc = escenarioCanal({ toque: true });
const PRECIO = (esc.soporte + 0.25).toFixed(2);
const DIA = esc.fin - (esc.fin % 86_400_000);
const BAR_T = esc.fin - CINCO_MIN;
const AHORA_PLANO = esc.fin + 4000;

interface OpcionesPlano {
  config?: Record<string, unknown>;
  scratch?: Record<string, unknown>;
  cycle?: Parameters<typeof makeContext>[0]['cycle'];
  historial?: BotContext['historial'] | null;
  limites?: LimitesExternos | null;
  decisionIa?: DecisionIa | null;
  ticker?: Parameters<typeof makeContext>[0]['ticker'];
  now?: number;
  series?: BotContext['series'] | null;
  openOrders?: Parameters<typeof makeContext>[0]['openOrders'];
}

function enPlano(o: OpcionesPlano = {}): BotContext {
  const ctx = makeContext({
    strategy: StrategyKind.AI_CHANNEL,
    config: config(o.config),
    price: PRECIO,
    market: MARKET,
    now: o.now ?? AHORA_PLANO,
    availableBalance: '1000',
    openOrders: o.openOrders,
    cycle: { ...o.cycle, scratch: { cycleSeq: SEQ, ...o.scratch } },
    ticker: {
      bid: PRECIO,
      ask: (Number(PRECIO) + 0.01).toFixed(2),
      mark: PRECIO,
      ...o.ticker,
    },
  });
  return {
    ...ctx,
    series: o.series === null ? undefined : (o.series ?? esc.series),
    historial: o.historial === null ? undefined : (o.historial ?? historialDePrueba({ dia: DIA })),
    limites: o.limites === null ? undefined : (o.limites ?? LIMITES),
    decisionIa: o.decisionIa ?? null,
    nivelesApalancamiento: [],
  };
}

const reglas = (extra: Record<string, unknown> = {}) => ({ decisionMode: 'REGLAS', ...extra });

/** La oferta de la vela del escenario, para fabricar decisiones de la IA. */
function oferta() {
  const plan = s.plan(enPlano());
  if (!plan.solicitudIa) throw new Error('sin solicitud');
  return plan.solicitudIa;
}

function decisionIa(
  o: Partial<DecisionIa> = {},
  eleccion: Partial<EleccionOperacion> = {},
): DecisionIa {
  const sol = oferta();
  const candidato = sol.snapshot.candidatos[0];
  return {
    intentId: 'ia-7',
    estado: EstadoIntencion.DECIDIDA,
    origen: OrigenDecision.IA,
    barT: sol.barT,
    huella: sol.huella,
    eleccion: {
      veredicto: Veredicto.OPERAR,
      opcion: candidato.id,
      stop: TipoStop.NORMAL,
      objetivo: EsquemaObjetivo.OPUESTO,
      apalancamiento: BandaApalancamiento.MEDIA,
      tamano: TamanoOperacion.MEDIO,
      confianza: NivelConfianza.ALTA,
      ...eleccion,
    },
    motivo: null,
    expiresAt: sol.expiresAt,
    cycleSeq: SEQ,
    ...o,
  };
}

describe('AI_CHANNEL: en plano, modo reglas', () => {
  it('el juez decide y sale la entrada IOC con su apalancamiento y la operación guardada', () => {
    const plan = s.plan(enPlano({ config: reglas() }));
    expect(plan.orders).toEqual([
      {
        clientOrderId: coid(LevelKind.BASE, 0),
        levelKind: LevelKind.BASE,
        levelIndex: 0,
        side: 'BUY',
        type: 'LIMIT',
        timeInForce: 'IOC',
        price: '128.07',
        qty: '15.858',
        reduceOnly: false,
      },
    ]);
    expect(plan.immediate).toEqual([]);
    expect(plan.apalancamiento).toBe(25);
    expect(plan.decision).toMatchObject({
      intentId: `reglas:${BOT}:${BAR_T}`,
      estado: EstadoIntencion.ACEPTADA,
      motivo: null,
      plan: { stop: '127.58', cantidad: '15.858', apalancamiento: 25, entradaTope: '128.07' },
    });
    const op = plan.scratchPatch?.['op'] as OperacionGuardada;
    expect(op).toEqual({ plan: plan.decision?.plan, intento: 0, enviadaEn: AHORA_PLANO });
    expect(plan.scratchPatch).toMatchObject({ intentos: 1, decididaEn: BAR_T });
    expect(plan.solicitudIa).toBeUndefined();
  });

  it('cada intento del ciclo usa su propio id de entrada', () => {
    const plan = s.plan(enPlano({ config: reglas(), scratch: { intentos: 1 } }));
    expect(plan.orders[0].clientOrderId).toBe(coid(LevelKind.BASE, 1));
    expect((plan.scratchPatch?.['op'] as OperacionGuardada).intento).toBe(1);
    expect(plan.scratchPatch?.['intentos']).toBe(2);
  });

  it('una vela se decide una sola vez', () => {
    const plan = s.plan(enPlano({ config: reglas(), scratch: { decididaEn: BAR_T } }));
    expect(plan.orders).toEqual([]);
    expect(plan.note).toMatch(/ya se decidió/);
  });

  it('la vela de la decisión tiene que cerrar después de la última salida', () => {
    const sinEsperas = reglas({ cooldownMinutes: 0, stopCooldownMinutes: 0 });
    const tras = historialDePrueba({ dia: DIA, ultimoCierreEn: esc.fin });
    const plan = s.plan(enPlano({ config: sinEsperas, historial: tras }));
    expect(plan.orders).toEqual([]);
    expect(plan.note).toMatch(/siguiente vela/);
    const antes = historialDePrueba({ dia: DIA, ultimoCierreEn: BAR_T });
    expect(s.plan(enPlano({ config: sinEsperas, historial: antes })).orders).toHaveLength(1);
  });

  it('solo observar: decide y lo registra, pero no opera', () => {
    const plan = s.plan(enPlano({ config: reglas({ observeOnly: true }) }));
    expect(plan.orders).toEqual([]);
    expect(plan.apalancamiento).toBeUndefined();
    expect(plan.decision).toMatchObject({
      estado: EstadoIntencion.RECHAZADA,
      motivo: MotivoRechazo.PUERTA,
      plan: { stop: '127.58' },
    });
    expect(plan.scratchPatch?.['op']).toBeUndefined();
    expect(plan.note).toMatch(/Solo observar/);
  });

  /**
   * Spec 062, F-23. La API recibe `config` como objeto libre y el lector
   * convertia lo que no era `true`/`false` en el valor por defecto:
   * `observeOnly: 1` dejaba operando de verdad al bot que su dueño creia en
   * «solo observar».
   */
  it('un interruptor que no es booleano se rechaza y se lee al lado seguro', () => {
    const cfg = config(reglas({ observeOnly: 1 }));
    expect(
      s
        .validate(cfg, makeMarket())
        .issues.some((i) => i.field === 'observeOnly' && i.severity === 'ERROR'),
    ).toBe(true);
    // Y si una configuracion guardada ya lo lleva, no opera.
    const plan = s.plan(enPlano({ config: reglas({ observeOnly: 1 }) }));
    expect(plan.orders).toEqual([]);
    expect(plan.note).toMatch(/Solo observar/);

    // Un `entriesEnabled` ilegible tampoco deja entrar.
    const sinEntradas = s.plan(enPlano({ config: reglas({ entriesEnabled: 'si' }) }));
    expect(sinEntradas.orders).toEqual([]);
  });

  it('plan() es pura', () => {
    const ctx = enPlano({ config: reglas() });
    expect(s.plan(ctx)).toEqual(s.plan(ctx));
  });
});

describe('AI_CHANNEL: en plano, modo IA', () => {
  it('sin decisión, deja la solicitud con la oferta y no opera', () => {
    const plan = s.plan(enPlano());
    expect(plan.orders).toEqual([]);
    expect(plan.decision).toBeUndefined();
    expect(plan.solicitudIa).toMatchObject({
      barT: BAR_T,
      expiresAt: BAR_T + CINCO_MIN + 60_000,
      huella: plan.solicitudIa?.snapshot.huella,
    });
    expect(plan.solicitudIa?.snapshot.candidatos).toHaveLength(1);
  });

  it('con una decisión válida, entra con los números de su elección', () => {
    const plan = s.plan(enPlano({ decisionIa: decisionIa() }));
    // Normal: 13,324 de cantidad, a la mitad 6,662; banda media de 7-25 → 16x.
    expect(plan.orders).toEqual([
      expect.objectContaining({
        clientOrderId: coid(LevelKind.BASE, 0),
        qty: '6.662',
        price: '128.07',
      }),
    ]);
    expect(plan.apalancamiento).toBe(16);
    expect(plan.decision).toMatchObject({
      intentId: 'ia-7',
      estado: EstadoIntencion.ACEPTADA,
      plan: { stop: '127.46', cantidad: '6.662', apalancamiento: 16, intentId: 'ia-7' },
    });
    expect(plan.solicitudIa).toBeUndefined();
    expect(plan.scratchPatch?.['decididaEn']).toBeUndefined();
  });

  it('mientras la IA piensa, espera sin volver a pedir', () => {
    for (const estado of [EstadoIntencion.SOLICITADA, EstadoIntencion.CONSULTANDO]) {
      const plan = s.plan(enPlano({ decisionIa: decisionIa({ estado, eleccion: null }) }));
      expect(plan.solicitudIa).toBeUndefined();
      expect(plan.orders).toEqual([]);
      expect(plan.note).toMatch(/Consultando/);
    }
  });

  it('si la IA ya no operó esta vela, no se vuelve a pedir', () => {
    const plan = s.plan(
      enPlano({
        decisionIa: decisionIa({ estado: EstadoIntencion.SIN_ENTRADA, motivo: 'poca ventaja' }),
      }),
    );
    expect(plan.solicitudIa).toBeUndefined();
    expect(plan.note).toMatch(/no operó en esta vela: poca ventaja/);
  });

  it('una decisión de otra vela o de otro ciclo no cuenta: se pide de nuevo', () => {
    const vieja = s.plan(enPlano({ decisionIa: decisionIa({ barT: BAR_T - CINCO_MIN }) }));
    expect(vieja.solicitudIa?.barT).toBe(BAR_T);
    expect(vieja.orders).toEqual([]);
    const otroCiclo = s.plan(enPlano({ decisionIa: decisionIa({ cycleSeq: SEQ - 1 }) }));
    expect(otroCiclo.solicitudIa?.barT).toBe(BAR_T);
  });

  it.each<
    [
      string,
      Partial<DecisionIa>,
      Partial<EleccionOperacion>,
      Record<string, unknown>,
      MotivoRechazo,
    ]
  >([
    ['caducada', { expiresAt: AHORA_PLANO }, {}, {}, MotivoRechazo.PLAZO],
    ['con otra huella', { huella: 'otra' }, {}, {}, MotivoRechazo.HUELLA],
    [
      'con menos confianza de la pedida',
      {},
      { confianza: NivelConfianza.MEDIA },
      { minAiConfidence: 'ALTA' },
      MotivoRechazo.OFERTA,
    ],
    ['que no quiere operar', {}, { veredicto: Veredicto.NO_OPERAR }, {}, MotivoRechazo.OFERTA],
    // El amplio no paga el mínimo de R en ningún objetivo: no está en la oferta.
    [
      'con una opción que no está disponible',
      {},
      { stop: TipoStop.AMPLIO },
      {},
      MotivoRechazo.OFERTA,
    ],
    ['con un candidato que no existe', {}, { opcion: 'REB-S-H1' }, {}, MotivoRechazo.OFERTA],
  ])('rechaza una decisión %s', (_, d, e, cfg, motivo) => {
    const plan = s.plan(enPlano({ decisionIa: decisionIa(d, e), config: cfg }));
    expect(plan.orders).toEqual([]);
    expect(plan.apalancamiento).toBeUndefined();
    expect(plan.decision).toEqual({
      intentId: 'ia-7',
      estado: EstadoIntencion.RECHAZADA,
      motivo,
      plan: null,
    });
    expect(plan.solicitudIa).toBeUndefined();
  });

  it('la confianza media reduce a la mitad aunque la decisión pida el tamaño completo', () => {
    // La API ya la guarda reducida; la estrategia no se fía (spec 059).
    const completo = { tamano: TamanoOperacion.COMPLETO, confianza: NivelConfianza.MEDIA };
    const plan = s.plan(enPlano({ decisionIa: decisionIa({}, completo) }));
    expect(plan.orders).toEqual([expect.objectContaining({ qty: '6.662' })]);
    expect(plan.decision?.plan?.eleccion).toMatchObject({
      tamano: TamanoOperacion.MEDIO,
      confianza: NivelConfianza.MEDIA,
    });
  });

  it('con confianza alta, el tamaño completo es la cantidad entera', () => {
    const plan = s.plan(
      enPlano({ decisionIa: decisionIa({}, { tamano: TamanoOperacion.COMPLETO }) }),
    );
    expect(plan.orders).toEqual([expect.objectContaining({ qty: '13.324' })]);
    expect(plan.decision?.plan?.eleccion.tamano).toBe(TamanoOperacion.COMPLETO);
  });
});

describe('AI_CHANNEL: la vista del mercado (spec 059)', () => {
  const apagadas = { entriesEnabled: false };

  it('en plano deja el régimen y el canal, con el primer toque', () => {
    const plan = s.plan(enPlano());
    const canal = plan.solicitudIa?.snapshot.canal;
    if (!canal) throw new Error('sin canal');
    expect(vistaCanalDe(plan.scratchPatch)).toEqual({
      barT: BAR_T,
      regimen: plan.solicitudIa?.snapshot.mercado.regimen,
      sentido: plan.solicitudIa?.snapshot.mercado.sentido,
      canal: {
        tipo: canal.tipo,
        calidad: canal.calidad,
        soporte: canal.soporte,
        resistencia: canal.resistencia,
        media: canal.media,
        pendientePorVela: canal.pendientePorVela,
        refT: canal.refT,
        desde: canal.refT - canal.duracionVelas * QUINCE_MIN,
      },
    });
  });

  it('no la reescribe si no ha cambiado, aunque la base cambie el orden de las claves', () => {
    const vista = s.plan(enPlano({ config: apagadas })).scratchPatch?.['vista'] as Record<
      string,
      unknown
    >;
    expect(vista).toBeDefined();
    const canal = vista['canal'] as Record<string, unknown>;
    const reordenada = {
      ...Object.fromEntries(Object.entries(vista).reverse()),
      canal: Object.fromEntries(Object.entries(canal).reverse()),
    };
    const plan = s.plan(enPlano({ config: apagadas, scratch: { vista: reordenada } }));
    expect(plan.note).toMatch(/Entradas apagadas/);
    expect(plan.scratchPatch).toBeUndefined();
  });

  it.each<[string, (v: Record<string, unknown>) => Record<string, unknown>]>([
    ['otra vela', (v) => ({ ...v, barT: BAR_T - CINCO_MIN })],
    ['otro régimen', (v) => ({ ...v, regimen: 'INDEFINIDO' })],
    ['otro sentido', (v) => ({ ...v, sentido: 'ALCISTA' })],
    ['sin canal', (v) => ({ ...v, canal: null })],
    ['otro soporte', (v) => ({ ...v, canal: { ...(v['canal'] as object), soporte: '1' } })],
    ['otra calidad', (v) => ({ ...v, canal: { ...(v['canal'] as object), calidad: 'C' } })],
    ['otro desde', (v) => ({ ...v, canal: { ...(v['canal'] as object), desde: null } })],
    ['una vista rota', () => ({ barT: 'x' })],
  ])('la reescribe con %s', (_, cambiar) => {
    const vista = s.plan(enPlano({ config: apagadas })).scratchPatch?.['vista'] as Record<
      string,
      unknown
    >;
    const plan = s.plan(enPlano({ config: apagadas, scratch: { vista: cambiar(vista) } }));
    expect(plan.scratchPatch?.['vista']).toEqual(vista);
  });

  it('sin canal, lo dice', () => {
    const recta = senoidal({
      n: 200,
      periodo: 8,
      amplitud: 0,
      deriva: 0.3,
      centro: esc.centro,
      desde: esc.fin - 200 * QUINCE_MIN,
    });
    const plan = s.plan(enPlano({ series: { ...esc.series, '15m': recta } }));
    expect(plan.note).toMatch(/Sin canal operable/);
    expect(vistaCanalDe(plan.scratchPatch)).toMatchObject({ barT: BAR_T, canal: null });
  });

  /**
   * Spec 062, F-47. La vista se anotaba DESPUES de las puertas del dia, asi que
   * durante la espera entre operaciones —quince minutos por defecto—, con el
   * tope diario alcanzado o en la racha de perdidas, la pantalla decia «Sin
   * analisis todavia» aunque el motor estuviera mirando el canal en cada vela.
   */
  it('las esperas del día no dejan la pantalla sin análisis', () => {
    const esperando = historialDePrueba({ dia: DIA, ultimoCierreEn: esc.fin - 60_000 });
    const plan = s.plan(enPlano({ historial: esperando }));
    expect(plan.note).toMatch(/Espera entre operaciones/);
    expect(vistaCanalDe(plan.scratchPatch)).toMatchObject({ barT: BAR_T });

    // Y con el tope diario del dia alcanzado, igual.
    const tope = historialDePrueba({ dia: DIA, realizadoHoy: '-60' });
    const conTope = s.plan(enPlano({ historial: tope }));
    expect(conTope.orders).toEqual([]);
    expect(vistaCanalDe(conTope.scratchPatch)).toMatchObject({ barT: BAR_T });
  });

  it('con velas viejas o sin historial no la toca', () => {
    expect(s.plan(enPlano({ historial: null })).scratchPatch).toBeUndefined();
    expect(s.plan(enPlano({ series: null })).scratchPatch).toBeUndefined();
    const vieja = s.plan(enPlano({ now: esc.fin + 20 * 60_000 }));
    expect(vieja.note).toMatch(/velas cerradas al día/);
    expect(vieja.scratchPatch).toBeUndefined();
  });
});

describe('AI_CHANNEL: la entrada enviada', () => {
  const op = (enviadaEn: number) => operacion({}, { enviadaEn, intento: 0 });

  it('espera mientras la IOC es reciente o sigue en el libro', () => {
    const reciente = s.plan(
      enPlano({ config: reglas(), scratch: { op: op(AHORA_PLANO - 5_000) } }),
    );
    expect(reciente.orders).toEqual([]);
    expect(reciente.decision).toBeUndefined();
    expect(reciente.note).toMatch(/esperando a que el venue/);
    const enLibro = s.plan(
      enPlano({
        config: reglas(),
        scratch: { op: op(AHORA_PLANO - 60_000) },
        openOrders: [makeVenueOrder(coid(LevelKind.BASE, 0), '128.07')],
      }),
    );
    expect(enLibro.decision).toBeUndefined();
    expect(enLibro.orders).toEqual([]);
  });

  it('con una ejecución ya contada pero sin posición a la vista, espera hasta 5 min', () => {
    const ciclo = { entriesFilled: 1, averageEntry: '128.05' };
    const pronto = s.plan(
      enPlano({ config: reglas(), scratch: { op: op(AHORA_PLANO - 60_000) }, cycle: ciclo }),
    );
    expect(pronto.decision).toBeUndefined();
    const tarde = s.plan(
      enPlano({ config: reglas(), scratch: { op: op(AHORA_PLANO - 6 * 60_000) }, cycle: ciclo }),
    );
    expect(tarde.decision?.estado).toBe(EstadoIntencion.RECHAZADA);
  });

  it('sin llenado, la decisión se descarta en su propio tick y la operación se borra', () => {
    const plan = s.plan(enPlano({ config: reglas(), scratch: { op: op(AHORA_PLANO - 60_000) } }));
    expect(plan.orders).toEqual([]);
    expect(plan.decision).toEqual({
      intentId: 'int-1',
      estado: EstadoIntencion.RECHAZADA,
      motivo: MotivoRechazo.VENUE,
      plan: null,
    });
    expect(plan.scratchPatch).toEqual({ op: null });
    expect(plan.avisos).toEqual([expect.objectContaining({ tipo: 'AI_ENTRY_DISCARDED' })]);
  });

  it('una operación que llegó a existir no se confunde con una IOC sin llenar', () => {
    // Se cerró fuera del bot (o su ejecución aún no se ha barrido): hubo posición,
    // así que `maximo` está puesto. Descartarla aquí inventa un «no se llenó».
    const vivida = operacion({}, { enviadaEn: AHORA_PLANO - 30 * 60_000, maximo: '31.257' });
    const plan = s.plan(enPlano({ config: reglas(), scratch: { op: vivida } }));
    expect(plan.orders).toEqual([]);
    expect(plan.decision).toBeUndefined();
    expect(plan.avisos).toBeUndefined();
    expect(plan.scratchPatch).toBeUndefined();
    expect(plan.note).toMatch(/ya no está en el venue/);
  });

  it('un cierre a medias de la operación anterior se limpia', () => {
    const plan = s.plan(
      enPlano({
        config: reglas(),
        scratch: { cierre: { motivo: 'TIEMPO', intentos: 1, ultimoEn: 0 } },
      }),
    );
    expect(plan.scratchPatch).toMatchObject({ cierre: null });
    expect(plan.orders).toHaveLength(1);
  });
});

describe('AI_CHANNEL: las puertas', () => {
  const cerrada = (ctx: BotContext, nota: RegExp) => {
    const plan = s.plan(ctx);
    expect(plan.orders).toEqual([]);
    expect(plan.solicitudIa).toBeUndefined();
    expect(plan.apalancamiento).toBeUndefined();
    expect(plan.note).toMatch(nota);
    return plan;
  };
  const h = (o: Parameters<typeof historialDePrueba>[0]) => historialDePrueba({ dia: DIA, ...o });

  it('sin historial, sin límites del motor o con ellos cerrados, no hay entradas', () => {
    cerrada(enPlano({ historial: null }), /historial/);
    cerrada(enPlano({ limites: null }), /límites del motor/);
    cerrada(
      enPlano({
        limites: { ...LIMITES, entradasPermitidas: false, motivo: 'interruptor apagado' },
      }),
      /cortadas: interruptor apagado/,
    );
    cerrada(
      enPlano({ limites: { ...LIMITES, venueListo: false, motivo: 'sin tramos de Aster' } }),
      /sin tramos de Aster/,
    );
    cerrada(enPlano({ config: { entriesEnabled: false } }), /Entradas apagadas/);
  });

  it('el tope diario cierra hasta las 00:00 UTC y avisa una vez al día', () => {
    const plan = cerrada(
      enPlano({ historial: h({ realizadoHoy: '-60' }) }),
      /Tope diario alcanzado/,
    );
    expect(plan.pausar).toBeUndefined();
    expect(plan.avisos).toEqual([
      expect.objectContaining({ clave: `tope-dia:${DIA}`, tipo: 'AI_DAY_STOP' }),
    ]);
  });

  it('al 1,5× del tope diario, pausa', () => {
    const plan = cerrada(enPlano({ historial: h({ realizadoHoy: '-90' }) }), /1,5 veces/);
    expect(plan.pausar).toMatch(/1,5 veces/);
  });

  it('el objetivo del día y el máximo de operaciones', () => {
    cerrada(
      enPlano({ config: { dailyProfitTargetPct: '2' }, historial: h({ realizadoHoy: '25' }) }),
      /Objetivo del día/,
    );
    expect(
      s.plan(
        enPlano({
          config: reglas({ dailyProfitTargetPct: '2' }),
          historial: h({ realizadoHoy: '15' }),
        }),
      ).orders,
    ).toHaveLength(1);
    cerrada(enPlano({ historial: h({ operacionesHoy: 8 }) }), /8 operaciones hoy/);
  });

  it('la racha de pérdidas espera lo configurado y luego deja entrar', () => {
    cerrada(
      enPlano({ historial: h({ rachaPerdidas: 3, ultimaPerdidaEn: AHORA_PLANO - 60 * 60_000 }) }),
      /3 pérdidas seguidas: espera de 60 min/,
    );
    const pasada = h({ rachaPerdidas: 3, ultimaPerdidaEn: AHORA_PLANO - 121 * 60_000 });
    expect(s.plan(enPlano({ config: reglas(), historial: pasada })).orders).toHaveLength(1);
  });

  it('las esperas tras un stop, entre operaciones y del ciclo', () => {
    cerrada(
      enPlano({ historial: h({ ultimoStopEn: AHORA_PLANO - 10 * 60_000 }) }),
      /tras el último stop: 20 min/,
    );
    cerrada(
      enPlano({ historial: h({ ultimoCierreEn: AHORA_PLANO - 10 * 60_000 }) }),
      /entre operaciones: 5 min/,
    );
    cerrada(
      enPlano({ cycle: { cooldownUntil: AHORA_PLANO + 60_000 } }),
      /entre operaciones: 1 min/,
    );
  });

  it('las ventanas sin entradas', () => {
    const minuto = Math.floor(AHORA_PLANO / 60_000) % 1440;
    const hhmm = (m: number) =>
      `${String(Math.floor((((m % 1440) + 1440) % 1440) / 60)).padStart(2, '0')}:${String(
        (((m % 1440) + 1440) % 1440) % 60,
      ).padStart(2, '0')}`;
    const ventana = `${hhmm(minuto - 1)}-${hhmm(minuto + 30)}`;
    cerrada(enPlano({ config: { noEntryWindowsUtc: ventana } }), /Ventana horaria/);
    cerrada(enPlano({ config: { noEntryWindowsUtc: 'nunca' } }), /mal escritas/);
    const otra = `${hhmm(minuto + 60)}-${hhmm(minuto + 90)}`;
    expect(s.plan(enPlano({ config: reglas({ noEntryWindowsUtc: otra }) })).orders).toHaveLength(1);
  });

  it('la caída máxima desde el pico pausa', () => {
    const plan = cerrada(
      enPlano({ historial: h({ picoRealizado: '200', realizadoTotal: '40' }) }),
      /Caída desde el máximo del 16\.00 %/,
    );
    expect(plan.pausar).toMatch(/Caída/);
  });

  it('series viejas, sin canal o con un régimen que no es de rango', () => {
    cerrada(enPlano({ now: esc.fin + 20 * 60_000 }), /velas cerradas al día/);
    const recta = senoidal({
      n: 200,
      periodo: 8,
      amplitud: 0,
      deriva: 0.3,
      centro: esc.centro,
      desde: esc.fin - 200 * QUINCE_MIN,
    });
    cerrada(enPlano({ series: { ...esc.series, '15m': recta } }), /Sin canal operable/);
    const bajista = { ...esc.series, '1h': historiaConRango(7919, 480, 0, 1) };
    cerrada(enPlano({ series: bajista }), /Régimen TENDENCIA BAJISTA/);
  });

  it('el spread y la ventana antes del cobro de funding', () => {
    cerrada(enPlano({ ticker: { ask: (Number(PRECIO) + 0.2).toFixed(2) } }), /Spread/);
    cerrada(enPlano({ ticker: { nextFundingAt: AHORA_PLANO + 5 * 60_000 } }), /funding en 5 min/);
    expect(
      s.plan(enPlano({ config: reglas(), ticker: { nextFundingAt: AHORA_PLANO + 20 * 60_000 } }))
        .orders,
    ).toHaveLength(1);
  });

  it('el funding en contra quita el lado que paga', () => {
    cerrada(enPlano({ ticker: { fundingRate: '0.0005' } }), /funding en contra/);
    // Con los largos cobrando, se entra.
    expect(
      s.plan(enPlano({ config: reglas(), ticker: { fundingRate: '-0.0005' } })).orders,
    ).toHaveLength(1);
  });

  it('un setup sin las confirmaciones pedidas se vigila, no se opera', () => {
    cerrada(enPlano({ config: { minConfirmations: 4 } }), /Vigilando REB-L-/);
  });
});

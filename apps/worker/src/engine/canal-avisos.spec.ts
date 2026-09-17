import { D, operacionCanalDe, type OperacionCanalVista, type Position } from '@crypton/shared';
import { makeCoid } from '@crypton/strategy-core';
import { avisoDeEntrada, eventoDeSalida, motivoDeSalida } from './canal-avisos';

/**
 * Los avisos de la operación del canal con IA (spec 059, CA-5): lo que dicen y
 * lo que llevan, que es lo que el notificador y la app enseñan.
 */

const BOT = '9c8d7e6f-0000-4000-8000-000000000000';
const VALE = '0123456789abcdef0123456789abcdef';
const T = 1_760_000_000_000;

const plan = (extra: Record<string, unknown> = {}) => ({
  intentId: 'ia-7',
  candidatoId: 'REB-L-H1',
  setup: 'REBOTE',
  lado: 'LONG',
  eleccion: {},
  entradaReferencia: '100.10',
  entradaTope: '100.20',
  stop: '99.50',
  objetivos: [
    { precio: '101.40', cantidad: '0.600' },
    { precio: '102.45', cantidad: '0.400' },
  ],
  cantidad: '1.000',
  apalancamiento: 16,
  nocional: '100.2',
  riesgo: '0.8123',
  rNeto: 1.876,
  liquidacionEstimada: '94.10',
  huella: 'h',
  barT: T,
  canal: {
    tipo: 'HORIZONTAL',
    soporte: '99.9',
    resistencia: '102.9',
    media: '101.4',
    pendientePorVela: 0,
    refT: T,
  },
  venceEn: T + 3_600_000,
  distanciaStop: 0.007,
  ...extra,
});

const operacion = (
  extraPlan: Record<string, unknown> = {},
  extraOp: Record<string, unknown> = {},
): OperacionCanalVista => {
  const op = operacionCanalDe({ op: { plan: plan(extraPlan), enviadaEn: T, ...extraOp } });
  if (!op) throw new Error('operación de prueba inválida');
  return op;
};

const posicion = (qty: string, entryPrice: string): Position => ({
  venue: 'HYPERLIQUID',
  symbol: 'SOL',
  qty,
  entryPrice,
  markPrice: entryPrice,
  unrealizedPnl: '0',
  leverage: 16,
  marginMode: 'ISOLATED',
  liquidationPrice: '94.1',
  marginUsed: '6',
});

describe('avisoDeEntrada', () => {
  it('con la posición real: lo que se llenó y a cuánto', () => {
    const a = avisoDeEntrada(operacion(), posicion('0.998', '100.18'), 'USDC', VALE);
    // 0,998 · 100,18 = 99,97964
    expect(a.message).toBe(
      'Entrada larga: 0.998 a 100.18 con 16x (nocional 99.98 USDC). Stop 99.50 · objetivos ' +
        '101.40 / 102.45 · riesgo 0.81 USDC · R 1.88 · liquidación estimada 94.10.',
    );
    expect(a.payload).toEqual({
      intentId: 'ia-7',
      vale: VALE,
      lado: 'LONG',
      cantidad: '0.998',
      precio: '100.18',
      apalancamiento: 16,
      stop: '99.50',
      objetivos: ['101.40', '102.45'],
      riesgo: '0.8123',
      rPlaneado: 1.876,
    });
  });

  it('sin posición a la vista, los números del plan; sin vale, sin botón', () => {
    const a = avisoDeEntrada(operacion(), null, 'USDT', null);
    expect(a.message).toMatch(/^Entrada larga: 1 a 100\.2 con 16x \(nocional 100\.20 USDT\)/);
    expect(a.payload).not.toHaveProperty('vale');
    const plana = avisoDeEntrada(operacion(), posicion('0', '0'), 'USDC', VALE);
    expect(plana.payload).toMatchObject({ cantidad: '1', precio: '100.2' });
  });

  it('un corto con un solo objetivo y sin liquidación estimada', () => {
    const a = avisoDeEntrada(
      operacion({
        lado: 'SHORT',
        objetivos: [{ precio: '98.00', cantidad: '1.000' }],
        liquidacionEstimada: null,
      }),
      posicion('-1', '100.2'),
      'USDC',
      VALE,
    );
    expect(a.message).toBe(
      'Entrada corta: 1 a 100.2 con 16x (nocional 100.20 USDC). Stop 99.50 · objetivo 98.00 · ' +
        'riesgo 0.81 USDC · R 1.88.',
    );
    expect(a.payload['cantidad']).toBe('1');
  });
});

describe('motivoDeSalida', () => {
  const coid = (kind: 'STOP_LOSS' | 'TAKE_PROFIT' | 'BASE', i: number) => makeCoid(BOT, 3, kind, i);

  it('por la orden que cerró', () => {
    expect(motivoDeSalida(coid('STOP_LOSS', 0), false, operacion(), null)).toBe('STOP');
    expect(
      motivoDeSalida(coid('STOP_LOSS', 0), false, operacion({}, { stopBreakeven: '100.3' }), null),
    ).toBe('BREAKEVEN');
    expect(motivoDeSalida(coid('TAKE_PROFIT', 0), false, operacion(), null)).toBe('OBJETIVO');
    expect(motivoDeSalida(coid('TAKE_PROFIT', 1), false, operacion(), null)).toBe('OBJETIVO');
    expect(motivoDeSalida(coid('TAKE_PROFIT', 499), false, null, null)).toBe('OBJETIVO');
  });

  it('un cierre a mercado de la estrategia lleva su motivo', () => {
    const cierre = { motivo: 'INVALIDACION', intentos: 1, ultimoEn: T };
    expect(motivoDeSalida(coid('TAKE_PROFIT', 500), false, operacion(), cierre)).toBe(
      'INVALIDACION',
    );
    expect(motivoDeSalida(coid('TAKE_PROFIT', 511), false, operacion(), { motivo: 'TIEMPO' })).toBe(
      'TIEMPO',
    );
    for (const raro of [null, 'TIEMPO', {}, { motivo: '' }, { motivo: 3 }]) {
      expect(motivoDeSalida(coid('TAKE_PROFIT', 500), false, operacion(), raro)).toBe('CIERRE');
    }
  });

  it('los cierres del runner, la liquidación y lo desconocido', () => {
    expect(motivoDeSalida(coid('TAKE_PROFIT', 999), false, operacion(), { motivo: 'TIEMPO' })).toBe(
      'CIERRE_MOTOR',
    );
    expect(motivoDeSalida(coid('TAKE_PROFIT', 900), false, null, null)).toBe('CIERRE_MOTOR');
    expect(motivoDeSalida(coid('TAKE_PROFIT', 899), false, null, null)).toBe('CIERRE');
    expect(motivoDeSalida('liq:9c8d7e6f:f-1', true, operacion(), null)).toBe('LIQUIDADA');
    expect(motivoDeSalida(coid('STOP_LOSS', 0), true, operacion(), null)).toBe('LIQUIDADA');
    expect(motivoDeSalida('ajena', false, operacion(), null)).toBe('CIERRE');
    expect(motivoDeSalida(null, false, operacion(), null)).toBe('CIERRE');
    expect(motivoDeSalida(coid('BASE', 0), false, operacion(), null)).toBe('CIERRE');
  });
});

describe('eventoDeSalida', () => {
  it('el resultado en la quote y en R, con el motivo', () => {
    const e = eventoDeSalida({ seq: 3, pnl: D('1.62') }, operacion(), 'OBJETIVO', 'USDC');
    // 1,62 / 0,8123 = 1,9943…
    expect(e).toEqual({
      type: 'AI_EXIT',
      severity: 'INFO',
      message: 'Operación cerrada (objetivo): +1.62 USDC (+1.99 R).',
      payload: { realizedPnl: '1.62', seq: 3, r: 1.9943, motivo: 'OBJETIVO', intentId: 'ia-7' },
    });
  });

  it('una pérdida, en negativo', () => {
    const e = eventoDeSalida({ seq: 4, pnl: D('-0.8123') }, operacion(), 'STOP', 'USDT');
    expect(e.message).toBe('Operación cerrada (stop): -0.81 USDT (-1.00 R).');
    expect(e.payload).toMatchObject({ realizedPnl: '-0.8123', r: -1 });
  });

  it('sin operación o sin riesgo, sin R', () => {
    const sin = eventoDeSalida({ seq: 5, pnl: D('0') }, null, 'CIERRE_MOTOR', 'USDC');
    expect(sin.message).toBe(
      'Operación cerrada (cierre a mercado por un comando o por el vigilante del stop): +0.00 USDC.',
    );
    expect(sin.payload).toMatchObject({ r: null, intentId: null });
    const cero = eventoDeSalida(
      { seq: 5, pnl: D('1') },
      operacion({ riesgo: '0' }),
      'OBJETIVO',
      'USDC',
    );
    expect(cero.payload['r']).toBeNull();
  });

  it('la liquidación avisa en WARN; un motivo nuevo se dice tal cual', () => {
    expect(
      eventoDeSalida({ seq: 1, pnl: D('-5') }, operacion(), 'LIQUIDADA', 'USDC'),
    ).toMatchObject({
      severity: 'WARN',
      message: 'Operación cerrada (liquidación): -5.00 USDC (-6.16 R).',
    });
    expect(
      eventoDeSalida({ seq: 1, pnl: D('1') }, operacion(), 'ALGO_NUEVO', 'USDC').message,
    ).toMatch(/^Operación cerrada \(algo_nuevo\)/);
    for (const [motivo, texto] of [
      ['TIEMPO', 'por tiempo'],
      ['INVALIDACION', 'el canal se rompió'],
      ['REGIMEN', 'el mercado giró a tendencia en contra'],
      ['BREAKEVEN', 'stop en breakeven'],
      ['STOP_NO_SALTO', 'el stop no saltó'],
    ]) {
      expect(
        eventoDeSalida({ seq: 1, pnl: D('0') }, operacion(), motivo, 'USDC').message,
      ).toContain(`(${texto})`);
    }
  });
});

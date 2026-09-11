import {
  ActivationMode,
  LevelKind,
  StrategyKind,
  type BotConfig,
  type DesiredState,
} from '@crypton/shared';
import { getStrategy } from '../registry';
import { BASE_CONFIG, makeContext, makeMarket, makePosition } from '../testing';
import { TTP_ARMED, TTP_PEAK } from '../trailing-take-profit';

/**
 * Seguimiento de beneficio (spec 043).
 *
 * El mecanismo ya tiene sus tests en `trailing-take-profit.spec.ts`: aqui se
 * comprueba lo PROPIO de la estrategia -cuando entra, con cuanto, y que no
 * entre dos veces- y que el cableado del mecanismo es el correcto.
 */

const MERCADO = { tickSize: '0.01', priceDecimals: 2, stepSize: '0.001', qtyDecimals: 3 };
const estrategia = getStrategy(StrategyKind.TRAILING_PROFIT);

const plan = (
  extra: Record<string, unknown> = {},
  ctxExtra: Record<string, unknown> = {},
): DesiredState =>
  estrategia.plan(
    makeContext({
      strategy: StrategyKind.TRAILING_PROFIT,
      config: {
        ...estrategia.defaults(),
        ...BASE_CONFIG,
        totalInvestment: '1000',
        leverage: 2,
        ...extra,
      },
      price: '100',
      market: MERCADO,
      ...ctxExtra,
    }),
  );

const entrada = (r: DesiredState) => r.orders.find((o) => o.levelKind === LevelKind.BASE);
const salida = (r: DesiredState) => r.orders.find((o) => o.levelKind === LevelKind.TAKE_PROFIT);

describe('trailingProfit — la entrada', () => {
  it('plana y sin condicion, abre a mercado', () => {
    const e = entrada(plan())!;
    expect(e.type).toBe('MARKET');
    expect(e.side).toBe('BUY');
    expect(e.reduceOnly).toBe(false);
  });

  it('el tamano es capital x apalancamiento, y ni un centimo mas', () => {
    // 1.000 de capital a 2x son 2.000 de nocional; a 100, 20 unidades.
    const e = entrada(plan())!;
    expect(Number(e.qty) * 100).toBeCloseTo(2000, 6);
  });

  it('el margen disponible manda si es menor', () => {
    // 300 disponibles a 2x son 600 de nocional, no 2.000.
    const e = entrada(plan({}, { availableBalance: '300' }))!;
    expect(Number(e.qty) * 100).toBeCloseTo(600, 6);
  });

  it('y el tope de exposicion manda si es el menor de los tres', () => {
    const e = entrada(plan({ maxNotionalCap: '250' }))!;
    expect(Number(e.qty) * 100).toBeCloseTo(250, 6);
  });

  it('en corto vende', () => {
    expect(entrada(plan({ direction: 'SHORT' }))!.side).toBe('SELL');
  });

  it('con condicion de entrada espera, y dice a que', () => {
    const r = plan({
      activationMode: ActivationMode.PRICE_BELOW,
      activationPrice: '90',
    });
    expect(entrada(r)).toBeUndefined();
    expect(r.note).toContain('90');
  });

  it('y entra en cuanto el precio la cumple', () => {
    const r = plan(
      { activationMode: ActivationMode.PRICE_BELOW, activationPrice: '90' },
      { price: '89' },
    );
    expect(entrada(r)).toBeDefined();
    expect(r.scratchPatch?.['armedAt']).toBeDefined();
  });

  it('respeta la espera entre operaciones', () => {
    const r = plan({}, { cycle: { cooldownUntil: 2_000_000 }, now: 1_000_000 });
    expect(entrada(r)).toBeUndefined();
    expect(r.note).toContain('espera');
  });

  it('NO reutiliza ids de orden, y eso es deliberado', () => {
    // Con `reusesOrderSlots` el motor permite recolocar un id que YA se
    // ejecuto: aqui seria una SEGUNDA entrada a mercado mientras la posicion
    // tarda en aparecer en `getPositions()`. Es la Critica del spec 041.
    expect(estrategia.reusesOrderSlots).toBeUndefined();
  });

  it('no pide velas: decide mirando el precio y nada mas', () => {
    expect(estrategia.candles).toBeUndefined();
  });
});

describe('trailingProfit — la salida', () => {
  const conPosicion = (precio: string, scratch: Record<string, unknown> = { cycleSeq: 1 }) =>
    plan({}, { position: makePosition('20', '100'), price: precio, cycle: { scratch } });

  it('por debajo del objetivo no hay salida de beneficio', () => {
    // Objetivo de fabrica: +15 % sobre 100 son 115.
    const r = conPosicion('110');
    expect(salida(r)).toBeUndefined();
    expect(r.note).toContain('115');
  });

  it('al cruzarlo aparece el disparador, con intencion de STOP', () => {
    const o = salida(conPosicion('115'))!;
    expect(o.price).toBe('113.85');
    expect(o.triggerPrice).toBe('113.85');
    expect(o.type).toBe('MARKET');
    expect(o.intent).toBe('SL');
    expect(o.reduceOnly).toBe(true);
    expect(o.qty).toBe('20.000');
  });

  it('sube con el maximo y NUNCA baja', () => {
    const armado = { cycleSeq: 1, [TTP_ARMED]: 1, [TTP_PEAK]: '130' };
    expect(salida(conPosicion('140', armado))!.price).toBe('138.60');
    expect(salida(conPosicion('120', armado))!.price).toBe('128.70');
  });

  it('cuenta el maximo visto solo por el stream', () => {
    const r = plan(
      {},
      {
        position: makePosition('20', '100'),
        price: '116',
        extremos: { alto: '130', bajo: '115' },
      },
    );
    expect(salida(r)!.price).toBe('128.70');
  });

  it('en corto es el espejo exacto', () => {
    const r = plan(
      { direction: 'SHORT' },
      { position: makePosition('-20', '100'), price: '85', cycle: { scratch: { cycleSeq: 1 } } },
    );
    const o = salida(r)!;
    expect(o.side).toBe('BUY');
    expect(o.price).toBe('85.85');
  });

  it('con posicion NO vuelve a entrar', () => {
    expect(entrada(conPosicion('115'))).toBeUndefined();
  });
});

describe('trailingProfit — lo que avisa al configurarlo', () => {
  const market = makeMarket(MERCADO);
  const cfg = (extra: Record<string, unknown> = {}) =>
    ({
      ...estrategia.defaults(),
      ...BASE_CONFIG,
      totalInvestment: '1000',
      ...extra,
    }) as unknown as BotConfig;

  it('nace con stop loss y con espera entre operaciones', () => {
    const d = estrategia.defaults();
    expect(d['stopLossPct']).toBe('5');
    expect(d['cooldownMinutes']).toBe(60);
  });

  it('avisa si le quitan el stop loss', () => {
    const r = estrategia.validate(cfg({ stopLossPct: null }), market);
    expect(r.issues.some((i) => i.field === 'stopLossPct' && i.severity === 'WARNING')).toBe(true);
  });

  it('avisa si el retroceso se come el objetivo entero', () => {
    const r = estrategia.validate(cfg({ takeProfitPct: '1', trailingCallbackPct: '2' }), market);
    expect(r.issues.some((i) => i.field === 'trailingCallbackPct')).toBe(true);
  });

  it('exige precio si hay condicion de entrada', () => {
    const r = estrategia.validate(cfg({ activationMode: ActivationMode.PRICE_ABOVE }), market);
    expect(r.issues.some((i) => i.field === 'activationPrice' && i.severity === 'ERROR')).toBe(
      true,
    );
  });

  it('la vista previa dice que el objetivo no es el precio de salida', () => {
    const p = estrategia.preview(cfg(), market, '100');
    expect(p.issues.some((i) => i.message.includes('113.85'))).toBe(true);
  });

  it('la vista previa se calcula sobre el precio de ENTRADA, no sobre el de hoy', () => {
    // Spec 044, F-03. Con el precio en 100 y la entrada condicionada a 80, la
    // vista previa pintaba entrada 100, cantidad 10 y objetivo 115. El bot
    // entrara en 80 con 12,5 y seguira desde 92: los cuatro numeros estaban mal
    // en la pantalla donde el usuario decide comprometer dinero.
    const p = estrategia.preview(
      cfg({
        leverage: 1,
        activationMode: ActivationMode.PRICE_BELOW,
        activationPrice: '80',
      }),
      market,
      '100',
    );
    expect(p.levels[0].price).toBe('80.00');
    expect(p.levels[0].qty).toBe('12.500');
    expect(p.takeProfitPrice).toBe('92.00');
    expect(p.issues.some((i) => i.message.includes('precio de entrada'))).toBe(true);
  });

  it('y sin condicion de entrada sigue siendo el de hoy', () => {
    const p = estrategia.preview(cfg({ leverage: 1 }), market, '100');
    expect(p.levels[0].price).toBe('100.00');
    expect(p.issues.some((i) => i.message.includes('precio de entrada'))).toBe(false);
  });
});

import { StrategyKind } from '@crypton/shared';
import { fidelityWarnings } from './warnings';

/**
 * Spec 001, F-65. Los avisos del backtest callaban lo que más engaña en un
 * market maker —que se recotiza una vez por vela— y prometían guardas por bot
 * que el replay no ejecuta.
 */
describe('fidelityWarnings', () => {
  const base = {
    source: 'BINANCE' as never,
    sourceSymbol: 'BTCUSDT',
    interval: '5m' as const,
    venue: 'HYPERLIQUID',
  };

  it('un market maker recibe el aviso de una recotización por vela', () => {
    const avisos = fidelityWarnings({
      ...base,
      strategy: StrategyKind.MARKET_MAKER_V2,
      config: {},
    });
    expect(avisos.some((a) => /una vez por vela/i.test(a))).toBe(true);
  });

  it('una rejilla no recibe los avisos del market maker', () => {
    const avisos = fidelityWarnings({ ...base, strategy: StrategyKind.GRID_CLASSIC, config: {} });
    expect(avisos.some((a) => /una vez por vela/i.test(a))).toBe(false);
  });

  it('una caducidad de órdenes menor que la vela cotiza en vela alterna, y se dice', () => {
    const avisos = fidelityWarnings({
      ...base,
      strategy: StrategyKind.MARKET_MAKER_V2,
      config: { orderMaxAgeSeconds: 120 },
    });
    expect(avisos.some((a) => /vela alterna/i.test(a) && /120 s/.test(a))).toBe(true);
    const sinCaducidad = fidelityWarnings({
      ...base,
      strategy: StrategyKind.MARKET_MAKER_V2,
      config: { orderMaxAgeSeconds: 0 },
    });
    expect(sinCaducidad.some((a) => /vela alterna/i.test(a))).toBe(false);
  });

  it('el canal con IA dice con qué reglas se mide y qué guardas no están (spec 058)', () => {
    const avisos = fidelityWarnings({ ...base, strategy: StrategyKind.AI_CHANNEL, config: {} });
    const reglas = avisos.find((a) => a.startsWith('Canal con IA: se mide')) ?? '';
    expect(reglas).toMatch(/pasa/);
    expect(reglas).toMatch(/hacia el stop/);
    expect(reglas).toMatch(/apertura/);
    const limites = avisos.find((a) => a.startsWith('Canal con IA: un solo tramo')) ?? '';
    expect(limites).toMatch(/funding/);
    expect(limites).toMatch(/1,5/);
    // Y a las demás estrategias no les llegan.
    const rejilla = fidelityWarnings({ ...base, strategy: StrategyKind.GRID_CLASSIC, config: {} });
    expect(rejilla.some((a) => a.startsWith('Canal con IA'))).toBe(false);
  });

  it('el aviso de guardas no promete guardas por bot', () => {
    const avisos = fidelityWarnings(base);
    const guardas = avisos.find((a) => /guardas/i.test(a)) ?? '';
    expect(guardas).toMatch(/del bot/i);
    expect(guardas).toMatch(/stop-loss/i);
  });
});

/**
 * El aviso que faltaba para los market makers (spec 071).
 *
 * El codigo ya decia en un comentario que «los market makers son los que mas
 * pierden con un plan() por vela», y luego anadia avisos propios para tendencia,
 * seguimiento, canal y bot de IA — y no para los dos que ese mismo comentario
 * senalaba como los peor reproducidos.
 *
 * El resultado practico: un usuario corre un backtest de market maker, ve
 * numeros rojos, y concluye que la estrategia no funciona. Medido, un MM V2
 * sobre ocho pares y 120 dias da -19,9 % en el replay, y la razon no es la
 * estrategia: es que el replay solo tiene PRECIOS, asi que una cotizacion se
 * ejecuta unicamente cuando el precio llega hasta ella. Todas las ejecuciones
 * que produce son de las que el mercado vino a por ti. Un market maker vive de
 * lo contrario.
 */
describe('Avisos de market maker (spec 071)', () => {
  const avisosDe = (strategy: StrategyKind, config: Record<string, unknown> = {}) =>
    fidelityWarnings({
      source: 'BINANCE',
      sourceSymbol: 'BTCUSDT',
      interval: '5m',
      venue: 'HYPERLIQUID',
      strategy,
      config,
    });

  it.each([StrategyKind.MARKET_MAKER, StrategyKind.MARKET_MAKER_V2])(
    '%s avisa, EN MAYUSCULAS, de que el backtest no puede decidir si gana',
    (kind) => {
      const avisos = avisosDe(kind);
      const principal = avisos.find((a) => a.includes('NO PUEDE DECIR'));

      expect(principal).toBeDefined();
      // Los tres hechos que impiden la conclusion equivocada.
      expect(principal).toContain('solo tiene precios');
      expect(principal).toContain('el mercado vino a por ti');
      expect(principal).toContain('NO es prueba de que la estrategia');
    },
  );

  it('y dice que lo que si sirve es un bot simulado en el venue', () => {
    const avisos = avisosDe(StrategyKind.MARKET_MAKER_V2);
    expect(avisos.some((a) => a.includes('SIMULADO en el venue'))).toBe(true);
  });

  /** El aviso general ya no afirma que el sesgo favorezca al market maker. */
  it('el aviso de la profundidad de libro no vende un sesgo que no es el dominante', () => {
    const avisos = avisosDe(StrategyKind.MARKET_MAKER_V2);
    const libro = avisos.find((a) => a.includes('Sin profundidad de libro'));

    expect(libro).toBeDefined();
    expect(libro).toContain('la falta de flujo pesa');
  });

  /** Y las demas estrategias no se llevan un aviso que no les toca. */
  it('una estrategia que no cotiza no recibe estos avisos', () => {
    const avisos = avisosDe(StrategyKind.GRID_CLASSIC);
    expect(avisos.some((a) => a.includes('NO PUEDE DECIR'))).toBe(false);
  });
});

/**
 * Lo que el replay SI puede medir de un market maker: la FORMA del resultado.
 *
 * Que la salida se calcule desde el precio de mercado y no desde el coste medio
 * no depende del flujo que falta — el bot pone su salida en el mismo sitio aqui
 * y en vivo—, asi que este aviso si habla de las cifras que el usuario tiene
 * delante, al reves que los tres de arriba (spec 071).
 */
describe('El aviso del sesgo por inventario apagado', () => {
  const avisosDe = (config: Record<string, unknown>) =>
    fidelityWarnings({
      source: 'BINANCE',
      sourceSymbol: 'BTCUSDT',
      interval: '5m',
      venue: 'HYPERLIQUID',
      strategy: StrategyKind.MARKET_MAKER_V2,
      config,
    });

  const hayAviso = (config: Record<string, unknown>) =>
    avisosDe(config).some((a) => a.includes('APAGADO el ajuste de precio por inventario'));

  it('avisa cuando esta apagado, con el numero medido', () => {
    const aviso = avisosDe({}).find((a) => a.includes('APAGADO el ajuste'));
    expect(aviso).toBeDefined();
    expect(aviso).toContain('48 %');
    expect(aviso).toContain('44 %');
  });

  it('calla cuando esta encendido de verdad', () => {
    expect(hayAviso({ inventoryPriceAdjustment: true, inventorySkewFactor: '1' })).toBe(false);
  });

  /**
   * Las dos formas de tenerlo apagado. El interruptor en true con el factor en
   * cero no hace nada, asi que un aviso que solo mirara el interruptor se
   * callaria justo cuando mas falta hace.
   */
  it.each([
    ['el interruptor apagado', { inventoryPriceAdjustment: false, inventorySkewFactor: '2' }],
    ['el factor en cero', { inventoryPriceAdjustment: true, inventorySkewFactor: '0' }],
    ['sin configurar ninguno de los dos', {}],
  ])('avisa con %s', (_, config) => {
    expect(hayAviso(config)).toBe(true);
  });
});

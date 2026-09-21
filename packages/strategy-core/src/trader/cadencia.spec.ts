import { aiTrader } from '../strategies/ai-trader';
import { CADENCIAS, PASO_CADENCIA, leerConfigTrader } from './config';
import { estadoTrader } from './estado';
import { espacioTrader } from './esqueletos';
import { entradaDePrueba, senalDePrueba } from './testing-trader';

/**
 * La cadencia de decision y la evidencia condicionada (spec 070).
 *
 * Los dos cambios salen de medir, no de opinar, y los numeros estan en el spec:
 * a 1 minuto BTC dio 8.719 toques y CERO ejecutables en 30 dias, y el rasgo que
 * mejor predice el resultado —el estiramiento— era justo el que el modelo
 * ignoraba.
 */

const cfg = (extra: Record<string, unknown> = {}) =>
  leerConfigTrader(
    {
      exchangeAccountId: 'a',
      symbol: 'TEST',
      totalInvestment: '1000',
      makerFeeBps: '0',
      takerFeeBps: '0',
      slippageBps: '2',
      ...extra,
    } as never,
    'LIGHTER',
  );

describe('La cadencia de decision (spec 070)', () => {
  it('por defecto son 15 minutos, que es lo medido como mejor', () => {
    expect(cfg().cadencia).toBe('15m');
  });

  /**
   * No es un olvido: 30 dias de BTC a 1 min dieron 8.719 toques y ninguno
   * ejecutable, porque el coste de ida y vuelta es FIJO en precio y el
   * recorrido encoge con la raiz del tiempo. Ofrecer un ajuste que da cero
   * operaciones medidas seria una trampa.
   */
  it('un minuto no se ofrece, y una configuracion que lo pida cae al defecto', () => {
    expect(CADENCIAS).not.toContain('1m');
    expect(cfg({ decisionInterval: '1m' }).cadencia).toBe('15m');
  });

  it.each([...CADENCIAS])('%s se acepta y trae su paso', (c) => {
    expect(cfg({ decisionInterval: c }).cadencia).toBe(c);
    expect(PASO_CADENCIA[c]).toBeGreaterThan(0);
  });

  it('el motor pide la serie de la cadencia y siempre la de una hora', () => {
    for (const c of CADENCIAS) {
      const series = aiTrader.series!({ decisionInterval: c } as never);
      const intervalos = series.map((s) => s.interval);
      expect(intervalos).toContain('1h');
      if (c !== '1h') expect(intervalos).toContain(c);
      // Sin pedir dos veces lo mismo: cada sondeo cuesta cupo del venue.
      expect(new Set(intervalos).size).toBe(intervalos.length);
    }
  });

  it('con cadencia de 5 min no se piden dos series iguales', () => {
    const series = aiTrader.series!({ decisionInterval: '5m' } as never);
    expect(series.map((s) => s.interval).sort()).toEqual(['1h', '5m']);
  });

  /**
   * Cambiar la cadencia cambia QUE SERIES pide el motor, y eso se decide al
   * arrancar el bot: en caliente dejaria al runner pidiendo unas y mirando
   * otras.
   */
  it('es COLD: no se puede cambiar con el bot en marcha', () => {
    const campo = aiTrader.meta.fields.find((f) => f.key === 'decisionInterval');
    expect(campo?.mutability).toBe('COLD');
  });
});

describe('El presupuesto de llamadas (spec 070)', () => {
  /**
   * Sube de 48 a 300. El 48 estaba calibrado para un modelo trescientas veces
   * mas caro; el maximo teorico a 5 min son 288 velas al dia.
   */
  it('cubre el maximo teorico de la cadencia mas rapida', () => {
    const velasAlDia = 86_400_000 / PASO_CADENCIA['5m'];
    expect(cfg().presupuestoIaDia).toBeGreaterThanOrEqual(velasAlDia);
  });

  it('y el formulario deja llegar hasta ahi', () => {
    const campo = aiTrader.meta.fields.find((f) => f.key === 'aiDailyCallBudget');
    expect(campo?.max).toBeGreaterThanOrEqual(288);
  });
});

describe('La evidencia condicionada al estiramiento (spec 070)', () => {
  const espacioCon = (tasas: unknown) =>
    espacioTrader(entradaDePrueba({ senal: senalDePrueba({ tasas: tasas as never }) }));

  it('el estado la enseña cuando hay muestra', () => {
    const e = estadoTrader(espacioCon(senalDePrueba().tasas), cfg());
    expect(e.history['at_this_stretch']).toContain('21 resolved cases');
  });

  /**
   * Sin muestra suficiente se DICE que no la hay, en vez de dar un porcentaje
   * de cuatro casos. Una tasa de cuatro casos no es una tasa.
   */
  it('y dice que no la hay cuando no la hay', () => {
    const sinSimilares = { ...senalDePrueba().tasas!, similares: null };
    const e = estadoTrader(espacioCon(sinSimilares), cfg());
    expect(e.history['at_this_stretch']).toContain('too few');
  });

  it('sin historico ninguno, el bloque sigue siendo legible', () => {
    const e = estadoTrader(espacioCon(null), cfg());
    expect(e.history['sample']).toContain('no usable record');
  });

  /** Sigue sin entrar ni un precio, ni el simbolo, ni una fecha. */
  it('no mete cifras con moneda ni el simbolo', () => {
    const e = estadoTrader(espacioCon(senalDePrueba().tasas), cfg());
    for (const v of Object.values(e.history)) {
      expect(v).not.toContain('TEST');
      expect(v).not.toMatch(/\$|USDC|USDT/);
    }
  });
});

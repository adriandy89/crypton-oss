import type { Candle } from '@crypton/shared';
import {
  CLAVES_INDICADOR,
  INDICADORES,
  esClaveIndicador,
  lineasDeIndicador,
} from './indicadores-vista';

/**
 * Spec 061. Lo que se prueba aquí no es la estadística —eso ya lo hace
 * `canal/estadistica.spec.ts` con lápiz— sino el envoltorio: que cada indicador
 * pide su cálculo con SUS parámetros, que las líneas salen con la longitud de
 * la serie y con hueco donde todavía no hay datos, y que el catálogo dice la
 * verdad sobre dónde se pinta cada uno.
 *
 * Las cifras esperadas están calculadas a mano en el comentario de cada caso.
 */

const CINCO_MIN = 300_000;
const T0 = Date.UTC(2026, 8, 17, 0, 0);

/** Vela con cierre `c`; la mecha se da explícita donde el caso la necesita. */
const vela = (i: number, c: number, h = c, l = c): Candle => ({
  t: T0 + i * CINCO_MIN,
  o: String(c),
  h: String(h),
  l: String(l),
  c: String(c),
  v: '1',
});

/** Serie de `n` velas con los cierres que devuelva `f`. */
const serie = (n: number, f: (i: number) => number): Candle[] =>
  Array.from({ length: n }, (_, i) => vela(i, f(i)));

describe('catálogo de indicadores', () => {
  it('son cinco, y cada uno dice dónde se pinta', () => {
    expect(CLAVES_INDICADOR).toEqual(['BOLLINGER', 'SMA50', 'EMA20', 'RSI', 'ATR']);
    expect(INDICADORES.BOLLINGER.panel).toBe('PRECIO');
    expect(INDICADORES.SMA50.panel).toBe('PRECIO');
    expect(INDICADORES.EMA20.panel).toBe('PRECIO');
    // Los de panel propio son los que se excluyen entre sí en la pantalla.
    expect(INDICADORES.RSI.panel).toBe('PROPIO');
    expect(INDICADORES.ATR.panel).toBe('PROPIO');
    expect(INDICADORES.RSI.guias).toEqual([30, 70]);
  });

  it('reconoce una clave guardada y rechaza cualquier otra cosa', () => {
    expect(esClaveIndicador('RSI')).toBe(true);
    for (const basura of ['MACD', '', null, 3, {}]) expect(esClaveIndicador(basura)).toBe(false);
  });
});

describe('lineasDeIndicador', () => {
  it('sin velas no devuelve nada', () => {
    for (const clave of CLAVES_INDICADOR) expect(lineasDeIndicador(clave, [])).toEqual([]);
  });

  it('cada línea tiene un punto por vela, con su instante', () => {
    const velas = serie(60, (i) => 100 + i);
    for (const clave of CLAVES_INDICADOR) {
      for (const linea of lineasDeIndicador(clave, velas)) {
        expect(linea.puntos).toHaveLength(60);
        expect(linea.puntos[0].t).toBe(T0);
        expect(linea.puntos[59].t).toBe(T0 + 59 * CINCO_MIN);
      }
    }
  });

  /**
   * Bollinger de 20 con 2σ sobre los cierres 1..20. La media es 10,5, y la
   * desviación POBLACIONAL de 1..n es raíz de (n²−1)/12 = raíz de 33,25 =
   * 5,76628…, así que la banda superior es 10,5 + 2·5,76628 = 22,0326 y la
   * inferior, −1,0326. Antes de la vela 20 no hay banda.
   */
  it('Bollinger: tres líneas, la media en medio y hueco hasta la vela 20', () => {
    const lineas = lineasDeIndicador(
      'BOLLINGER',
      serie(20, (i) => i + 1),
    );
    expect(lineas.map((l) => l.clave)).toEqual(['superior', 'media', 'inferior']);
    const [sup, media, inf] = lineas;
    expect(media.puntos[18].v).toBeNull();
    expect(media.puntos[19].v).toBeCloseTo(10.5, 10);
    expect(sup.puntos[19].v!).toBeCloseTo(22.0326, 4);
    expect(inf.puntos[19].v!).toBeCloseTo(-1.0326, 4);
  });

  /** Media de 50 sobre los cierres 1..50: la media de 1..50 es 25,5. */
  it('media 50: hueco hasta la vela 50 y ahí la media', () => {
    const [linea] = lineasDeIndicador(
      'SMA50',
      serie(50, (i) => i + 1),
    );
    expect(linea.clave).toBe('valor');
    expect(linea.puntos[48].v).toBeNull();
    expect(linea.puntos[49].v).toBeCloseTo(25.5, 10);
  });

  /** Con una serie plana, la exponencial vale el propio precio desde su semilla. */
  it('media exponencial 20: plana sobre una serie plana', () => {
    const [linea] = lineasDeIndicador(
      'EMA20',
      serie(25, () => 100),
    );
    expect(linea.puntos[18].v).toBeNull();
    expect(linea.puntos[19].v).toBeCloseTo(100, 10);
    expect(linea.puntos[24].v).toBeCloseTo(100, 10);
  });

  /** Una serie que solo sube no tiene pérdidas: el RSI de Wilder vale 100. */
  it('RSI 14: hueco al principio y 100 en una serie que solo sube', () => {
    const [linea] = lineasDeIndicador(
      'RSI',
      serie(20, (i) => 100 + i),
    );
    expect(linea.puntos[13].v).toBeNull();
    expect(linea.puntos[14].v).toBeCloseTo(100, 10);
  });

  /**
   * ATR 14 con cierres constantes y mecha de ±1: el rango verdadero de cada
   * vela es 2, así que su media también. La primera vela no tiene rango
   * verdadero —no hay cierre anterior—, de ahí que el primer valor sea el de la
   * vela 15.
   */
  it('ATR 14: la media del rango verdadero, con hueco en las primeras', () => {
    const velas = Array.from({ length: 20 }, (_, i) => vela(i, 100, 101, 99));
    const [linea] = lineasDeIndicador('ATR', velas);
    expect(linea.puntos[13].v).toBeNull();
    expect(linea.puntos[14].v).toBeCloseTo(2, 10);
  });

  it('una serie más corta que el periodo no rompe: solo huecos', () => {
    const cortas = serie(5, (i) => 100 + i);
    for (const clave of CLAVES_INDICADOR) {
      for (const linea of lineasDeIndicador(clave, cortas)) {
        expect(linea.puntos.every((p) => p.v === null)).toBe(true);
      }
    }
  });
});

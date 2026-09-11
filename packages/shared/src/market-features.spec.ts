import { eficienciaKaufman } from './market-features';

/**
 * La eficiencia de Kaufman vive en `shared` porque la usan DOS: el asesor,
 * sobre cierres horarios, para decidir con que configuracion nace un bot; y el
 * market maker, sobre sus propias muestras de precio, para decidir si deja de
 * cotizar contra la tendencia. Misma pregunta, entradas distintas — y hasta el
 * spec 039 eran dos implementaciones, o sea dos respuestas posibles.
 */
describe('eficienciaKaufman', () => {
  it('una linea recta vale 1, suba o baje', () => {
    expect(eficienciaKaufman([100, 101, 102, 103]).toFixed()).toBe('1');
    expect(eficienciaKaufman([103, 102, 101, 100]).toFixed()).toBe('1');
  });

  it('ir y venir sin avanzar vale 0', () => {
    // El terreno de una rejilla o de un market maker: mucho recorrido, ningun
    // avance.
    expect(eficienciaKaufman([100, 102, 100, 102, 100]).toFixed()).toBe('0');
  });

  it('un zigzag con tendencia queda en medio', () => {
    // Avanza 4 recorriendo 4+1+... : ni linea recta ni puro vaiven.
    const e = Number(eficienciaKaufman([100, 102, 101, 103, 102, 104]));
    expect(e).toBeGreaterThan(0.2);
    expect(e).toBeLessThan(0.8);
  });

  it('no se pronuncia sin datos suficientes ni sin recorrido', () => {
    expect(eficienciaKaufman([]).toFixed()).toBe('0');
    expect(eficienciaKaufman([100]).toFixed()).toBe('0');
    // Precio plano: recorrido cero, y dividir por cero daria NaN.
    expect(eficienciaKaufman([100, 100, 100]).toFixed()).toBe('0');
  });

  it('acepta cadenas, que es como viajan los precios', () => {
    expect(eficienciaKaufman(['100', '101', '102']).toFixed()).toBe('1');
  });
});

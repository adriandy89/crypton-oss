import { agregarVelas, type Candle } from './candle';

/**
 * La agregación de velas a un intervalo mayor (spec 057, F-04).
 *
 * El backtest la usa para dar a la estrategia velas de su intervalo cuando
 * reproduce uno menor. Lo que no puede pasar es entregar un cubo que aún no ha
 * cerrado —sería mirar al futuro— ni uno al que le falta su apertura.
 */

const MIN = 60_000;
const HORA = 60 * MIN;
const T0 = Date.UTC(2026, 8, 17, 10, 0, 0);

/** Velas de 15 min desde `desde`, una por cierre, con mechas de ±2. */
const velas15 = (cierres: number[], desde = T0): Candle[] =>
  cierres.map((c, i) => ({
    t: desde + i * 15 * MIN,
    o: String(c - 1),
    h: String(c + 2),
    l: String(c - 2),
    c: String(c),
    v: '1.5',
  }));

describe('agregarVelas (spec 057, F-04)', () => {
  it('agrupa en cubos alineados a la hora UTC', () => {
    const serie = velas15([10, 11, 12, 13, 20, 21, 22, 23]);
    expect(agregarVelas(serie, '15m', '1h', T0 + 2 * HORA)).toEqual([
      { t: T0, o: '9', h: '15', l: '8', c: '13', v: '6' },
      { t: T0 + HORA, o: '19', h: '25', l: '18', c: '23', v: '6' },
    ]);
  });

  it('solo entrega los cubos cerrados en `hasta`', () => {
    // A las 11:30 el cubo de las 11:00 va por la mitad: entregarlo sería mirar
    // al futuro.
    const serie = velas15([10, 11, 12, 13, 20, 21]);
    expect(agregarVelas(serie, '15m', '1h', T0 + HORA + 30 * MIN)?.map((v) => v.t)).toEqual([T0]);
  });

  it('descarta el cubo al que le falta su primera vela', () => {
    // La serie empieza a las 10:30: esa hora no tiene apertura.
    const serie = velas15([12, 13, 20, 21, 22, 23], T0 + 30 * MIN);
    expect(agregarVelas(serie, '15m', '1h', T0 + 2 * HORA)?.map((v) => v.t)).toEqual([T0 + HORA]);
  });

  it('un hueco en medio no invalida el cubo', () => {
    const serie = velas15([10, 11, 12, 13]).filter((_, i) => i !== 2);
    const [hora] = agregarVelas(serie, '15m', '1h', T0 + HORA)!;
    expect(hora).toMatchObject({ o: '9', h: '15', c: '13', v: '4.5' });
  });

  it('si una vela no trae volumen, el cubo tampoco', () => {
    const serie = velas15([10, 11, 12, 13]).map((v, i) => (i === 1 ? { ...v, v: null } : v));
    expect(agregarVelas(serie, '15m', '1h', T0 + HORA)![0].v).toBeNull();
  });

  it('el día empieza a las 00:00 UTC', () => {
    const DIA = Date.UTC(2026, 8, 17);
    const cuatroHoras = (desde: number, n: number): Candle[] =>
      Array.from({ length: n }, (_, i) => ({
        t: desde + i * 4 * HORA,
        o: '1',
        h: String(2 + i),
        l: '0.5',
        c: String(1 + i),
        v: '1',
      }));
    const [dia] = agregarVelas(cuatroHoras(DIA, 6), '4h', '1d', DIA + 24 * HORA)!;
    expect(dia).toMatchObject({ t: DIA, h: '7', c: '6', v: '6' });
    // Empezando a las 04:00, ese día no tiene apertura.
    expect(agregarVelas(cuatroHoras(DIA + 4 * HORA, 5), '4h', '1d', DIA + 24 * HORA)).toEqual([]);
  });

  it('con el mismo intervalo solo quita las que no han cerrado', () => {
    const serie = velas15([10, 11, 12]);
    expect(agregarVelas(serie, '15m', '15m', T0 + 30 * MIN)).toEqual(serie.slice(0, 2));
  });

  it('no agrega a un intervalo menor, no múltiplo, de semanas o de meses', () => {
    const serie = velas15([10, 11, 12, 13]);
    expect(agregarVelas(serie, '15m', '5m', T0 + HORA)).toBeNull();
    expect(agregarVelas(serie, '3m', '5m', T0 + HORA)).toBeNull();
    expect(agregarVelas(serie, '15m', '3d', T0 + HORA)).toBeNull();
    expect(agregarVelas(serie, '15m', '1w', T0 + HORA)).toBeNull();
    expect(agregarVelas(serie, '15m', '1M', T0 + HORA)).toBeNull();
  });
});

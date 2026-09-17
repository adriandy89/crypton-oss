import type { Candle } from '@crypton/shared';
import { atrSerie } from './estadistica';
import { recortarSerie, serieNumerica, type SerieNumerica } from './numeros';
import { swingsConfirmados } from './swings';
import { serieFresca, ultimaCerradaEsperada } from './velas';

/** Velas sin rango (máximo = mínimo = cierre), de minuto en minuto. */
const planas = (cierres: number[]): SerieNumerica =>
  serieNumerica(
    cierres.map((c, i) => ({
      t: i * 60_000,
      o: String(c),
      h: String(c),
      l: String(c),
      c: String(c),
      v: '1',
    })),
  );

/** Paseo aleatorio con semilla, para las propiedades. */
function paseo(n: number, semilla: number): Candle[] {
  let x = semilla;
  const azar = () => {
    x = (x * 16807) % 2147483647;
    return x / 2147483647;
  };
  let precio = 100;
  const velas: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const abre = precio;
    precio = Math.max(1, precio + (azar() - 0.5) * 2);
    const alto = Math.max(abre, precio) + azar();
    const bajo = Math.min(abre, precio) - azar();
    velas.push({
      t: i * 900_000,
      o: abre.toFixed(4),
      h: alto.toFixed(4),
      l: bajo.toFixed(4),
      c: precio.toFixed(4),
      v: '1',
    });
  }
  return velas;
}

describe('swingsConfirmados (spec 058)', () => {
  it('un zigzag limpio: cada giro se confirma cuando el precio se aleja θ', () => {
    // θ = 1,25 · 2 = 2,5
    const s = planas([100, 102, 104, 106, 108, 110, 108, 106, 104, 102, 100, 102, 104, 106]);
    const atr = new Float64Array(s.n).fill(2);
    expect(swingsConfirmados(s, atr)).toEqual([
      { tipo: 'BAJO', indice: 0, precio: 100, confirmadoEn: 2 },
      { tipo: 'ALTO', indice: 5, precio: 110, confirmadoEn: 7 },
      { tipo: 'BAJO', indice: 10, precio: 100, confirmadoEn: 12 },
    ]);
  });

  it('un movimiento menor que θ no es un giro', () => {
    const s = planas([100, 101, 102, 101, 100, 101, 102]);
    const atr = new Float64Array(s.n).fill(2);
    expect(swingsConfirmados(s, atr)).toEqual([]);
  });

  it('los giros alternan siempre', () => {
    const s = serieNumerica(paseo(600, 42));
    const giros = swingsConfirmados(s, atrSerie(s.h, s.l, s.c, 14));
    expect(giros.length).toBeGreaterThan(5);
    for (let i = 1; i < giros.length; i++) {
      expect(giros[i].tipo).not.toBe(giros[i - 1].tipo);
      expect(giros[i].indice).toBeGreaterThan(giros[i - 1].indice);
      expect(giros[i].confirmadoEn).toBeGreaterThan(giros[i].indice);
    }
  });

  it('NO REPINTA: sobre un prefijo da el resultado completo filtrado por su confirmación', () => {
    for (const semilla of [1, 7, 99, 12345, 777]) {
      const velas = paseo(400, semilla);
      const completa = serieNumerica(velas);
      const giros = swingsConfirmados(completa, atrSerie(completa.h, completa.l, completa.c, 14));
      for (const k of [20, 57, 150, 233, 399]) {
        const prefijo = serieNumerica(velas.slice(0, k));
        const parciales = swingsConfirmados(prefijo, atrSerie(prefijo.h, prefijo.l, prefijo.c, 14));
        expect(parciales).toEqual(giros.filter((g) => g.confirmadoEn < k));
      }
    }
  });

  it('recortar la serie no cambia sus valores', () => {
    const s = serieNumerica(paseo(50, 3));
    const r = recortarSerie(s, 10);
    expect(r.n).toBe(10);
    expect(r.c[9]).toBe(s.c[49]);
  });
});

describe('velas esperadas', () => {
  const QUINCE = 900_000;
  const DIEZ = Date.UTC(2026, 8, 17, 10, 0, 0);

  it('a las 10:15:05 la última cerrada es la de las 10:00', () => {
    expect(ultimaCerradaEsperada(DIEZ + QUINCE + 5_000, '15m')).toBe(DIEZ);
  });

  it('con gracia, en los segundos que siguen al cierre aún se espera la anterior', () => {
    expect(ultimaCerradaEsperada(DIEZ + QUINCE + 5_000, '15m', 10_000)).toBe(DIEZ - QUINCE);
  });

  it('una serie sin su última vela no es fresca pasada la gracia', () => {
    const velas: Candle[] = [{ t: DIEZ - QUINCE, o: '1', h: '1', l: '1', c: '1', v: '1' }];
    expect(serieFresca(velas, '15m', DIEZ + QUINCE + 5_000, 10_000)).toBe(true);
    expect(serieFresca(velas, '15m', DIEZ + QUINCE + 30_000, 10_000)).toBe(false);
    expect(serieFresca(undefined, '15m', DIEZ, 0)).toBe(false);
  });
});

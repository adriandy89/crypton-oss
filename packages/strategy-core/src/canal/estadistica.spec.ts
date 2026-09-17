import { D, type Candle } from '@crypton/shared';
import {
  adx,
  atrSerie,
  bollinger,
  cambiosDeSigno,
  chop,
  ema,
  eficiencia,
  mediaVidaOU,
  ols,
  olsParalelas,
  percentil,
  rma,
  rsi,
  sma,
  wilsonInferior,
} from './estadistica';
import { aDecimal, recortarSerie, serieNumerica } from './numeros';

/**
 * La estadística del canal (spec 058), contra cifras calculadas a mano. Cada
 * número de estos tests está hecho con lápiz en el comentario que lo acompaña.
 */

const lista = (x: Float64Array) => Array.from(x, (v) => (Number.isNaN(v) ? null : v));

describe('medias', () => {
  it('sma: la media de las últimas p', () => {
    expect(lista(sma([1, 2, 3, 4, 5], 3))).toEqual([null, null, 2, 3, 4]);
  });

  it('ema: sembrada con la simple y α = 2/(p+1)', () => {
    // α = 0,5: 0,5·4 + 0,5·2 = 3; 0,5·5 + 0,5·3 = 4
    expect(lista(ema([1, 2, 3, 4, 5], 3))).toEqual([null, null, 2, 3, 4]);
  });

  it('rma: la de Wilder, α = 1/p', () => {
    // (2·2 + 4)/3 = 2,6667; (2,6667·2 + 5)/3 = 3,4444
    const r = rma([1, 2, 3, 4, 5], 3);
    expect(r[2]).toBe(2);
    expect(r[3]).toBeCloseTo(8 / 3, 10);
    expect(r[4]).toBeCloseTo(31 / 9, 10);
  });

  it('los NaN del principio se saltan antes de sembrar', () => {
    const r = rma([Number.NaN, 1, 2, 3], 2);
    expect(lista(r)).toEqual([null, null, 1.5, 2.25]);
  });
});

describe('RSI de Wilder', () => {
  it('con subidas y bajadas alternas', () => {
    // Cambios +1, +1, −1, +1. Con p = 2:
    // i=2: ganancia 1, pérdida 0 → 100
    // i=3: ganancia 0,5, pérdida 0,5 → 50
    // i=4: ganancia 0,75, pérdida 0,25 → RS 3 → 75
    expect(lista(rsi([1, 2, 3, 2, 3], 2))).toEqual([null, null, 100, 50, 75]);
  });

  it('una serie plana da 50', () => {
    expect(rsi([5, 5, 5, 5], 2)[3]).toBe(50);
  });
});

describe('rango verdadero y ATR', () => {
  // (alto, bajo, cierre): (10,8,9) (11,9,10) (12,10,11) (13,9,12)
  // TR: 2, 2, 4 (la última abre hueco hacia abajo: 13 − 9)
  const h = [10, 11, 12, 13];
  const l = [8, 9, 10, 9];
  const c = [9, 10, 11, 12];

  it('ATR aritmético de los últimos p rangos', () => {
    expect(lista(atrSerie(h, l, c, 2))).toEqual([null, null, 2, 3]);
  });

  it('CHOP: 100·log10(ΣTR/rango)/log10(p)', () => {
    const r = chop(h, l, c, 2);
    // i=2: log10(4/3)/log10(2) · 100 = 41,504
    // i=3: log10(6/4)/log10(2) · 100 = 58,496
    expect(r[2]).toBeCloseTo(41.504, 3);
    expect(r[3]).toBeCloseTo(58.496, 3);
  });
});

describe('ADX', () => {
  it('una subida limpia da ADX alto y +DI por encima', () => {
    const n = 60;
    const c = Array.from({ length: n }, (_, i) => 100 + i);
    const h = c.map((x) => x + 0.5);
    const l = c.map((x) => x - 0.5);
    const r = adx(h, l, c, 14);
    expect(r.adx[n - 1]).toBeGreaterThan(40);
    expect(r.masDi[n - 1]).toBeGreaterThan(r.menosDi[n - 1]);
  });

  it('un zigzag sin dirección da ADX bajo', () => {
    const n = 80;
    const c = Array.from({ length: n }, (_, i) => 100 + (i % 2 === 0 ? 1 : -1));
    const h = c.map((x) => x + 1);
    const l = c.map((x) => x - 1);
    expect(adx(h, l, c, 14).adx[n - 1]).toBeLessThan(20);
  });

  it('empieza a valer en la vela 2p − 1', () => {
    const c = Array.from({ length: 40 }, (_, i) => 100 + i);
    const r = adx(c, c, c, 5).adx;
    expect(Number.isNaN(r[8])).toBe(true);
    expect(Number.isFinite(r[9])).toBe(true);
  });
});

describe('Bollinger, eficiencia y percentil', () => {
  it('bandas con desviación poblacional', () => {
    // media 2, σ = √(2/3) = 0,8165 → 3,633 / 0,367; anchura 3,266/2 = 1,633
    const b = bollinger([1, 2, 3], 3, 2);
    expect(b.media[2]).toBe(2);
    expect(b.superior[2]).toBeCloseTo(3.633, 3);
    expect(b.inferior[2]).toBeCloseTo(0.367, 3);
    expect(b.ancho[2]).toBeCloseTo(1.633, 3);
  });

  it('eficiencia: neto sobre recorrido', () => {
    // |2 − 1| / (1 + 1 + 1) = 1/3
    expect(eficiencia([1, 2, 1, 2], 3)[3]).toBeCloseTo(1 / 3, 10);
    expect(eficiencia([1, 2, 3, 4], 3)[3]).toBe(1);
  });

  it('percentil: los menores más la mitad de los iguales', () => {
    // 2 menores y 1 igual de 4: (2 + 0,5)/4 = 62,5
    expect(percentil(3, [1, 2, 3, 4])).toBe(62.5);
    expect(percentil(3, [1, Number.NaN, 5])).toBe(50);
    // Todos iguales: en el medio, no arriba.
    expect(percentil(7, [7, 7, 7, 7])).toBe(50);
  });
});

describe('rectas', () => {
  it('ols exacto', () => {
    expect(ols([0, 1, 2], [1, 3, 5])).toMatchObject({ pendiente: 2, ordenada: 1, r2: 1 });
  });

  it('ols con ruido', () => {
    // Sxy = 3, Sxx = 2 → 1,5; ordenada 7/3 − 1,5 = 0,8333; R² = 1 − 0,16667/4,66667
    const r = ols([0, 1, 2], [1, 2, 4])!;
    expect(r.pendiente).toBeCloseTo(1.5, 10);
    expect(r.ordenada).toBeCloseTo(0.8333, 4);
    expect(r.r2).toBeCloseTo(0.96429, 5);
  });

  it('paralelas: la pendiente común pondera los dos grupos', () => {
    // Grupo A: pendiente 1 (Sxy 2, Sxx 2); grupo B: pendiente 2 (Sxy 4, Sxx 2)
    // Común: 6/4 = 1,5; ordenadas 11 − 1,5 = 9,5 y 7 − 3 = 4
    const r = olsParalelas([0, 2], [10, 12], [1, 3], [5, 9])!;
    expect(r.pendiente).toBe(1.5);
    expect(r.ordenadaA).toBe(9.5);
    expect(r.ordenadaB).toBe(4);
    expect(r.propiaA).toBe(1);
    expect(r.propiaB).toBe(2);
  });
});

describe('media vida y Wilson', () => {
  it('una serie que se reduce a la mitad cada paso tiene media vida 1', () => {
    expect(mediaVidaOU([8, 4, 2, 1, 0.5])).toBeCloseTo(1, 10);
  });

  it('una serie que se aleja no revierte', () => {
    expect(mediaVidaOU([1, 2, 4, 8, 16])).toBeNull();
  });

  it('Wilson al 95 % de 60/100', () => {
    // (0,6 + 0,019208 − 1,96·√0,00249604) / 1,038416 = 0,5020
    expect(wilsonInferior(60, 100)).toBeCloseTo(0.502, 3);
    expect(wilsonInferior(0, 0)).toBe(0);
  });

  it('cambios de signo, sin contar los ceros', () => {
    expect(cambiosDeSigno([1, -1, 0, -2, 3, 0, 4, -1])).toBe(3);
  });
});

describe('la frontera con el dinero', () => {
  const velas: Candle[] = [
    { t: 0, o: '1.5', h: '2', l: '1', c: '1.75', v: '10' },
    { t: 60_000, o: '1.75', h: '3', l: '1.5', c: '2.5', v: null },
  ];

  it('serieNumerica pasa las velas a columnas', () => {
    const s = serieNumerica(velas);
    expect(s.n).toBe(2);
    expect(Array.from(s.c)).toEqual([1.75, 2.5]);
    expect(Number.isNaN(s.v[1])).toBe(true);
    expect(recortarSerie(s, 1).t).toEqual([60_000]);
  });

  it('aDecimal no deja pasar un número que nadie calculó', () => {
    expect(aDecimal(1.25).eq(D('1.25'))).toBe(true);
    expect(() => aDecimal(Number.NaN)).toThrow();
    expect(() => aDecimal(Number.POSITIVE_INFINITY)).toThrow();
  });
});

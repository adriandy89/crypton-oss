import {
  ladoDeDireccion,
  pctPrecioDeRoi,
  precioDeRoi,
  roiDePctPrecio,
  roiDePrecio,
  salidaPorRoi,
} from './roi';

/**
 * Los % de resultado, sobre el margen (spec 080). La fórmula es la de Binance:
 * «Long target price = Entry Price * ( ROI% / Leverage + 1 )» y «Short target
 * price = Entry Price * ( 1 - ROI% / Leverage )».
 */
describe('% sobre el margen', () => {
  it('la fórmula de Binance, en largo y en corto', () => {
    // 30 % del margen a 2× = 15 % del precio.
    expect(precioDeRoi('100', 30, 2, 'LONG').toFixed()).toBe('115');
    expect(precioDeRoi('100', 30, 2, 'SHORT').toFixed()).toBe('85');
  });

  it('una pérdida es un ROI negativo: el stop del 10 % a 5× está a un 2 % del precio', () => {
    expect(precioDeRoi('100', -10, 5, 'LONG').toFixed()).toBe('98');
    expect(precioDeRoi('100', -10, 5, 'SHORT').toFixed()).toBe('102');
  });

  it('a 1× el % del margen es el % del precio', () => {
    expect(precioDeRoi('100', 15, 1, 'LONG').toFixed()).toBe('115');
    expect(pctPrecioDeRoi(15, 1).toFixed()).toBe('15');
  });

  it('el caso del spec 079: un 15 % del precio a 15× era un 225 % del margen', () => {
    expect(roiDePctPrecio(15, 15).toFixed()).toBe('225');
    expect(pctPrecioDeRoi(225, 15).toFixed()).toBe('15');
    expect(roiDePrecio('84601', '71910.85', 15, 'SHORT').toFixed(0)).toBe('225');
  });

  it('ida y vuelta: el precio de un ROI devuelve ese ROI', () => {
    for (const lado of ['LONG', 'SHORT'] as const) {
      for (const L of [1, 2, 3, 7, 15, 40]) {
        for (const roi of [-80, -10, 0.5, 5, 30, 225]) {
          const p = precioDeRoi('84601', roi, L, lado);
          expect(roiDePrecio('84601', p, L, lado).toFixed(10)).toBe(roi.toFixed(10));
        }
      }
    }
  });

  it('un apalancamiento ausente o no positivo se trata como 1×', () => {
    expect(precioDeRoi('100', 10, 0, 'LONG').toFixed()).toBe('110');
    expect(pctPrecioDeRoi(10, -3).toFixed()).toBe('10');
  });

  it('NEUTRAL se trata como largo', () => {
    expect(ladoDeDireccion('NEUTRAL')).toBe('LONG');
    expect(precioDeRoi('100', 10, 2, 'NEUTRAL').toFixed()).toBe('105');
  });

  it('sin entrada no hay ROI', () => {
    expect(roiDePrecio('0', '10', 2, 'LONG').toFixed()).toBe('0');
  });
});

describe('salidaPorRoi (spec 080)', () => {
  it('el stop de fábrica del corto del 079: un 10 % del margen son 12 USDC', () => {
    // 0,02127 BTC en corto desde 84601 a 15×: el stop en 85165,01.
    const { precio, pnl } = salidaPorRoi('84601', '-0.02127', -10, 15, 'SHORT');
    expect(precio.toFixed(2)).toBe('85165.01');
    expect(pnl.toFixed(2)).toBe('-12.00');
  });

  it('un objetivo en largo gana su % sobre el margen de la posición', () => {
    // 2 BTC desde 100 a 4×: el margen es 50, y un 20 % son 10.
    const { precio, pnl } = salidaPorRoi('100', '2', 20, 4, 'LONG');
    expect(precio.toFixed()).toBe('105');
    expect(pnl.toFixed()).toBe('10');
  });
});

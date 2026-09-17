import { CalidadCanal, TipoCanal, type Candle } from '@crypton/shared';
import {
  calidadDe,
  calidadSuficiente,
  detectarCanal,
  nivelesEn,
  nivelTexto,
  puntuar,
  type ParametrosCanal,
} from './canales';
import { atrSerie } from './estadistica';
import { serieNumerica } from './numeros';
import { swingsConfirmados } from './swings';
import { QUINCE_MIN, recta, senoidal, vela } from './testing-canal';

/**
 * Los canales del spec 058, sobre series sintéticas cuyo resultado se sabe de
 * antemano:
 * - un seno de periodo 12 alrededor de 100, con amplitud 1 y mecha 0,05, tiene
 *   su soporte en 98,95 y su resistencia en 101,05;
 * - con deriva, el canal es el mismo pero inclinado.
 */

const PARAMS: ParametrosCanal = {
  ventana: 96,
  costeIdaVuelta: 0.1,
  tiposPermitidos: [TipoCanal.HORIZONTAL, TipoCanal.INCLINADO],
  invalidacionAtr: 0.35,
};

function detectar(velas: Candle[], p: Partial<ParametrosCanal> = {}) {
  const s = serieNumerica(velas);
  const atr = atrSerie(s.h, s.l, s.c, 14);
  return detectarCanal(s, swingsConfirmados(s, atr), atr[s.n - 1], { ...PARAMS, ...p });
}

describe('detectarCanal (spec 058)', () => {
  it('un rango limpio es un canal horizontal de calidad A', () => {
    const r = detectar(senoidal({ n: 200, periodo: 12 }));
    expect(r.canal).toMatchObject({
      tipo: TipoCanal.HORIZONTAL,
      calidad: CalidadCanal.A,
      soporte: '98.95',
      resistencia: '101.05',
      media: '100',
      pendientePorVela: 0,
      contencion: 1,
    });
    expect(r.canal!.toquesSoporte).toBeGreaterThanOrEqual(2);
    expect(r.canal!.toquesResistencia).toBeGreaterThanOrEqual(2);
    expect(r.canal!.anchuraAtr).toBeGreaterThanOrEqual(3);
    expect(r.canal!.anchuraAtr).toBeLessThanOrEqual(10);
    expect(r.invalidado).toBe(false);
    expect(r.falsoQuiebre).toBeNull();
  });

  it('un rango que deriva es un canal inclinado con su pendiente', () => {
    const r = detectar(senoidal({ n: 200, periodo: 12, deriva: 0.03 }));
    expect(r.canal?.tipo).toBe(TipoCanal.INCLINADO);
    expect(r.canal?.pendientePorVela).toBeCloseTo(0.03, 6);
    expect(r.canal?.r2).toBeGreaterThanOrEqual(0.6);
  });

  it('si solo se permiten horizontales, el que deriva no es canal', () => {
    const r = detectar(senoidal({ n: 200, periodo: 12, deriva: 0.03 }), {
      tiposPermitidos: [TipoCanal.HORIZONTAL],
    });
    expect(r.canal).toBeNull();
    expect(r.motivos.length).toBeGreaterThan(0);
  });

  it('una recta no es un canal', () => {
    const r = detectar(recta(200, 0.3));
    expect(r.canal).toBeNull();
  });

  it('con pocas velas no hay nada que buscar', () => {
    expect(detectar(senoidal({ n: 20, periodo: 12 })).motivos).toEqual(['DATOS']);
  });

  it('un rango demasiado estrecho para sus costes no se opera', () => {
    // Anchura 2,1 frente a un coste de ida y vuelta de 0,5: haría falta 10×.
    const r = detectar(senoidal({ n: 200, periodo: 12 }), { costeIdaVuelta: 0.5 });
    expect(r.canal).toBeNull();
    expect(r.motivos).toContain('ANCHURA_COSTE');
  });

  it('un cierre muy fuera del borde lo invalida', () => {
    const base = senoidal({ n: 198, periodo: 12 });
    const ultima = base[base.length - 1];
    const r = detectar([...base, vela(ultima.t + QUINCE_MIN, Number(ultima.c), 102.5)]);
    expect(r).toMatchObject({ canal: null, invalidado: true, motivos: ['INVALIDADO'] });
  });

  it('un cierre fuera por menos de un ATR que vuelve dentro es un falso quiebre', () => {
    const base = senoidal({ n: 196, periodo: 12 });
    const ultima = base[base.length - 1];
    const r = detectar([
      ...base,
      vela(ultima.t + QUINCE_MIN, Number(ultima.c), 98.7),
      vela(ultima.t + 2 * QUINCE_MIN, 98.7, 99.4),
    ]);
    expect(r.canal).not.toBeNull();
    // Por debajo del soporte: la operación que propone es un largo, con el stop
    // colgando del mínimo de la ruptura (98,7 − 0,05).
    expect(r.falsoQuiebre).toEqual({ lado: 'LONG', extremo: 98.65, indice: 196 });
  });

  it('una ruptura de más de un ATR no es falsa aunque el precio vuelva', () => {
    const base = senoidal({ n: 196, periodo: 12 });
    const ultima = base[base.length - 1];
    const r = detectar([
      ...base,
      vela(ultima.t + QUINCE_MIN, Number(ultima.c), 97.5),
      vela(ultima.t + 2 * QUINCE_MIN, 97.5, 99.4),
    ]);
    // Las dos velas grandes disparan el ATR y el rango deja de medir 3 ATR: ni
    // siquiera llega a la comprobación de la ruptura. Sea por una puerta o por
    // la invalidación, no queda canal ni falso quiebre que operar.
    expect(r.canal).toBeNull();
    expect(r.falsoQuiebre).toBeNull();
  });
});

describe('puntuación y niveles', () => {
  const ideal = {
    toques: 8,
    contencion: 1,
    anchuraAtr: 5,
    mediaVida: 0,
    duracion: 90,
    alternancias: 7,
    ultimoToqueHace: 0,
    r2: null,
  };

  it('un canal perfecto puntúa 100', () => {
    expect(puntuar(ideal)).toBe(100);
  });

  it('cada componente resta su parte', () => {
    // Contención en el mínimo (0,9): pierde sus 20.
    expect(puntuar({ ...ideal, contencion: 0.9 })).toBe(80);
    // Anchura a 10 ATR: 3 fuera del óptimo, pierde los 15.
    expect(puntuar({ ...ideal, anchuraAtr: 10 })).toBe(85);
    // Último toque hace 24 de 48: pierde la mitad de sus 10.
    expect(puntuar({ ...ideal, ultimoToqueHace: 24 })).toBe(95);
    // Inclinado con R² en el mínimo: pierde sus 10.
    expect(puntuar({ ...ideal, r2: 0.6 })).toBe(90);
  });

  it('calidad por tramos', () => {
    expect(calidadDe(75)).toBe(CalidadCanal.A);
    expect(calidadDe(74)).toBe(CalidadCanal.B);
    expect(calidadDe(60)).toBe(CalidadCanal.B);
    expect(calidadDe(45)).toBe(CalidadCanal.C);
    expect(calidadDe(44)).toBeNull();
    expect(calidadSuficiente(CalidadCanal.A, CalidadCanal.B)).toBe(true);
    expect(calidadSuficiente(CalidadCanal.C, CalidadCanal.B)).toBe(false);
  });

  it('los niveles de un inclinado se desplazan con el tiempo', () => {
    const canal = { soporte: '100', resistencia: '104', pendientePorVela: 0.5, refT: 0 };
    expect(nivelesEn(canal, 4 * QUINCE_MIN)).toEqual({
      soporte: 102,
      resistencia: 106,
      media: 104,
    });
    expect(nivelesEn({ ...canal, pendientePorVela: 0 }, 4 * QUINCE_MIN).soporte).toBe(100);
  });

  it('un nivel sale sin el ruido de la coma flotante', () => {
    expect(nivelTexto(98.95000000000002)).toBe('98.95');
    expect(nivelTexto(0.000123456789012345)).toBe('0.000123456789012');
  });
});

import { DEFAULTS_AGENTE } from '@crypton/strategy-core';
import { limitesDeEntrada, validarDefinicion } from './validacion';

/**
 * La definición de un agente antes de guardarla (spec 074, R-9 y R-10). Lo que
 * importa: nada se completa en silencio, y cada error dice su campo.
 */

const LIMITES = { capital: '1000', ...DEFAULTS_AGENTE };

describe('limitesDeEntrada', () => {
  it('los de fábrica con un capital valen', () => {
    const r = limitesDeEntrada(LIMITES);
    expect(r.errores).toEqual([]);
    expect(r.limites).toEqual(LIMITES);
  });

  it('un decimal puede llegar como número, y se guarda como cadena', () => {
    const r = limitesDeEntrada({ ...LIMITES, capital: 2500, riesgoPct: 0.75 });
    expect(r.limites).toMatchObject({ capital: '2500', riesgoPct: '0.75' });
  });

  it('no se completa nada: lo que falta es un error con su campo', () => {
    const { riesgoPct: _fuera, ...sin } = LIMITES;
    const r = limitesDeEntrada(sin);
    expect(r.limites).toBeNull();
    expect(r.errores).toEqual([
      { campo: 'limites.riesgoPct', mensaje: 'Tiene que ser un número.' },
    ]);
  });

  it('un campo que no es un límite se rechaza', () => {
    const r = limitesDeEntrada({ ...LIMITES, apalancamientoLibre: true });
    expect(r.errores).toEqual([
      { campo: 'limites.apalancamientoLibre', mensaje: 'No es un límite.' },
    ]);
  });

  it('los enteros tienen que ser números enteros, no cadenas', () => {
    const r = limitesDeEntrada({ ...LIMITES, maxVivas: '2', maxOperacionesDia: 2.5 });
    expect(r.errores.map((e) => e.campo)).toEqual([
      'limites.maxVivas',
      'limites.maxOperacionesDia',
    ]);
  });

  it('el sí o no es un booleano', () => {
    const r = limitesDeEntrada({ ...LIMITES, breakevenTrasTp1: 'si' });
    expect(r.errores.map((e) => e.campo)).toEqual(['limites.breakevenTrasTp1']);
  });

  it('pasa por la validación de dominio: rangos y lo que se contradice', () => {
    const fuera = limitesDeEntrada({ ...LIMITES, riesgoPct: '9' });
    expect(fuera.errores.map((e) => e.campo)).toEqual(['limites.riesgoPct']);
    const contradice = limitesDeEntrada({ ...LIMITES, maxVivas: 5, maxOperacionesDia: 4 });
    expect(contradice.errores.map((e) => e.campo)).toContain('limites.maxVivas');
    const sinCapital = limitesDeEntrada({ ...LIMITES, capital: '0' });
    expect(sinCapital.errores.map((e) => e.campo)).toEqual(['limites.capital']);
  });

  it('lo que no es un objeto no son límites', () => {
    for (const malo of [null, 'x', [], 7]) {
      expect(limitesDeEntrada(malo).errores).toEqual([
        { campo: 'limites', mensaje: 'Faltan los límites.' },
      ]);
    }
  });
});

describe('validarDefinicion', () => {
  const BUENA = {
    nombre: 'Tendencias',
    pares: ['BTC', 'ETH'],
    familias: ['TENDENCIA', 'RUPTURA'] as const,
    lados: ['LONG', 'SHORT'] as ('LONG' | 'SHORT')[],
  };
  const errores = (extra: Partial<typeof BUENA> | Record<string, unknown>, max = 12) =>
    validarDefinicion({ ...BUENA, familias: [...BUENA.familias], ...extra } as never, max).map(
      (e) => e.campo,
    );

  it('una definición buena no tiene errores', () => {
    expect(errores({})).toEqual([]);
  });

  it('el nombre, con algo y sin pasarse', () => {
    expect(errores({ nombre: '   ' })).toEqual(['nombre']);
    expect(errores({ nombre: 'x'.repeat(65) })).toEqual(['nombre']);
  });

  it('los pares: al menos uno, como mucho el tope, sin repetir y sin separadores', () => {
    expect(errores({ pares: [] })).toEqual(['pares']);
    expect(errores({ pares: ['A', 'B', 'C'] }, 2)).toEqual(['pares']);
    expect(errores({ pares: ['BTC', 'BTC'] })).toEqual(['pares']);
    for (const raro of ['BTC:ETH', 'A,B', 'A|B', 'con espacio', '']) {
      expect(errores({ pares: [raro] })).toContain('pares');
    }
  });

  it('las familias y los lados, sin repetir y sin vacío', () => {
    expect(errores({ familias: [] })).toEqual(['familias']);
    expect(errores({ familias: ['TENDENCIA', 'TENDENCIA'] })).toEqual(['familias']);
    expect(errores({ familias: ['CRUCE'] })).toEqual(['familias']);
    expect(errores({ lados: [] })).toEqual(['lados']);
    expect(errores({ lados: ['LONG', 'LONG'] })).toEqual(['lados']);
  });
});

import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { SetAiModeDto } from './dtos';

/**
 * El cuerpo de `PUT /admin/bots/:id/ai` (spec 053, H-04).
 *
 * `@IsOptional` se salta los validadores con `undefined` Y con `null`, y el
 * servicio solo distingue `undefined`: un `trigger: null` llegaba a una columna
 * `NOT NULL` y la API respondia un 500 sin explicar nada. Aqui se fija que
 * vaciar esos campos es un 400, y que el unico que SI se vacia —el intervalo,
 * que con `null` vuelve al de la estrategia— sigue pudiendo hacerlo.
 *
 * Mismas opciones que el `ValidationPipe` global de `main.ts`.
 */
const errores = (payload: Record<string, unknown>): string[] =>
  validateSync(plainToInstance(SetAiModeDto, payload), {
    whitelist: true,
    forbidNonWhitelisted: true,
  }).map((e) => e.property);

const valido = { mode: 'AUTO', reason: 'lo vigilo yo' };

describe('SetAiModeDto', () => {
  it('el minimo valido es el modo y el motivo', () => {
    expect(errores(valido)).toEqual([]);
  });

  it('el modo es obligatorio siempre', () => {
    expect(errores({ reason: 'lo vigilo yo' })).toContain('mode');
    expect(errores({ ...valido, mode: 'SIEMPRE' })).toContain('mode');
  });

  it('el motivo es obligatorio y tiene limites', () => {
    expect(errores({ mode: 'AUTO' })).toContain('reason');
    expect(errores({ ...valido, reason: 'no' })).toContain('reason');
    expect(errores({ ...valido, reason: 'x'.repeat(201) })).toContain('reason');
  });

  describe('el disparador', () => {
    it.each(['PERIODICO', 'OPERACION', 'AMBOS'])('%s vale', (trigger) => {
      expect(errores({ ...valido, trigger })).toEqual([]);
    });

    it('otro vocabulario no', () => {
      expect(errores({ ...valido, trigger: 'SIEMPRE' })).toContain('trigger');
    });

    it('null NO vale: la columna no admite vacio y respondia 500', () => {
      expect(errores({ ...valido, trigger: null })).toContain('trigger');
    });
  });

  describe('el permiso de recolocar', () => {
    it('true y false valen', () => {
      expect(errores({ ...valido, allowWarm: true })).toEqual([]);
      expect(errores({ ...valido, allowWarm: false })).toEqual([]);
    });

    it('null NO vale, por lo mismo que el disparador', () => {
      expect(errores({ ...valido, allowWarm: null })).toContain('allowWarm');
    });

    it('una cadena tampoco', () => {
      expect(errores({ ...valido, allowWarm: 'false' })).toContain('allowWarm');
    });
  });

  describe('el intervalo', () => {
    it.each([10, 30, 1440])('%i minutos valen', (reviewEveryMinutes) => {
      expect(errores({ ...valido, reviewEveryMinutes })).toEqual([]);
    });

    it.each([9, 1441, 10.5, 0])('%d no vale', (reviewEveryMinutes) => {
      expect(errores({ ...valido, reviewEveryMinutes })).toContain('reviewEveryMinutes');
    });

    it('null SI vale: es «el de la estrategia»', () => {
      expect(errores({ ...valido, reviewEveryMinutes: null })).toEqual([]);
    });
  });

  it('lo que la ruta no expone se rechaza, en vez de ignorarse', () => {
    // `daily_call_limit` existe en la tabla y no tiene mando: que nadie lo cuele.
    expect(errores({ ...valido, dailyCallLimit: 5 })).toContain('dailyCallLimit');
  });
});

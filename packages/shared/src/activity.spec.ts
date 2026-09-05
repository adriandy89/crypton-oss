import { fallosDe, resumenPorAccion } from './activity';

describe('resumenPorAccion', () => {
  it('una fila por acción con los tres resultados, ordenada por total y luego por nombre', () => {
    const out = resumenPorAccion([
      { action: 'bot.start', outcome: 'OK', count: 5 },
      { action: 'bot.start', outcome: 'ERROR', count: 2 },
      { action: 'auth.login', outcome: 'OK', count: 4 },
      { action: 'auth.login', outcome: 'DENIED', count: 3 },
      { action: 'risk.update', outcome: 'OK', count: 7 },
    ]);
    expect(out).toEqual([
      { action: 'auth.login', ok: 4, denied: 3, error: 0, total: 7 },
      { action: 'bot.start', ok: 5, denied: 0, error: 2, total: 7 },
      { action: 'risk.update', ok: 7, denied: 0, error: 0, total: 7 },
    ]);
  });

  it('un resultado desconocido cuenta en el total pero en ningún cubo, y un recuento ilegible se ignora', () => {
    const out = resumenPorAccion([
      { action: 'x', outcome: 'RARO', count: 2 },
      { action: 'x', outcome: 'OK', count: Number.NaN },
      { action: 'x', outcome: 'OK', count: 0 },
    ]);
    expect(out).toEqual([{ action: 'x', ok: 0, denied: 0, error: 0, total: 2 }]);
  });

  it('fallosDe suma lo denegado y lo fallido', () => {
    expect(
      fallosDe([
        { action: 'a', ok: 10, denied: 1, error: 2, total: 13 },
        { action: 'b', ok: 0, denied: 0, error: 4, total: 4 },
      ]),
    ).toBe(7);
  });
});

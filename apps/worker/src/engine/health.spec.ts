import { evaluarSalud, runnersAtascados } from './health';

/**
 * Spec 050. En la caída de Hyperliquid todos los runners del venue pasaron más
 * de cuatro latidos sin completar un tick, y con todos los bots en ese venue el
 * worker entero se marcaba enfermo: el proceso estaba bien, el que no respondía
 * era el venue.
 */
describe('runnersAtascados', () => {
  const LIMITE = 60_000;

  it('uno sin tick completo más allá del límite está atascado', () => {
    expect(
      runnersAtascados(
        [
          ['a', { msSinceLastTick: 70_000, esperandoAlVenue: false }],
          ['b', { msSinceLastTick: 1_000, esperandoAlVenue: false }],
        ],
        LIMITE,
      ),
    ).toEqual(['a']);
  });

  it('uno que espera a un venue caído no lo está', () => {
    expect(
      runnersAtascados([['a', { msSinceLastTick: 600_000, esperandoAlVenue: true }]], LIMITE),
    ).toEqual([]);
  });
});

/**
 * Spec 001, F-18. `/health` decía «sano» con cero runners, también cuando la
 * causa de tener cero runners era que Redis llevaba más de un TTL sin
 * contestar y el worker acababa de soltarlos todos.
 */
describe('evaluarSalud', () => {
  it('sin Redis no hay salud, tenga o no runners', () => {
    expect(evaluarSalud({ runners: 0, stalled: 0, leasesConfirmed: false })).toBe(false);
    expect(evaluarSalud({ runners: 5, stalled: 0, leasesConfirmed: false })).toBe(false);
  });

  it('un worker sin trabajo y con Redis vivo está sano', () => {
    expect(evaluarSalud({ runners: 0, stalled: 0, leasesConfirmed: true })).toBe(true);
  });

  it('con runners, solo enferma cuando están atascados todos', () => {
    expect(evaluarSalud({ runners: 5, stalled: 4, leasesConfirmed: true })).toBe(true);
    expect(evaluarSalud({ runners: 5, stalled: 5, leasesConfirmed: true })).toBe(false);
  });
});

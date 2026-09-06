import { evaluarSalud } from './health';

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

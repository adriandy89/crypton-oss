import { SUCESOS_INFORMATIVOS, agruparSucesos, tonoDeSuceso } from './chart-events';

/**
 * Los sucesos que llegan al gráfico (spec 005, CA-1).
 *
 * Lo que se fija: qué entra y qué no, que se agrupe por vela y por tono, que la
 * cuenta y los tipos sean los de verdad, y que salga en el orden que el motor
 * gráfico exige.
 */

const MIN = 60_000;
const HORA = 60 * MIN;
const T0 = 1_700_000_000_000 - (1_700_000_000_000 % HORA);
/** Velas de una hora: el cubo es el inicio de la hora. */
const porHora = (at: number) => Math.floor(at / HORA) * HORA;

const suceso = (type: string, severity: string, at: number) => ({ type, severity, at });

describe('tonoDeSuceso', () => {
  it('lo grave se pinta siempre, sea del tipo que sea', () => {
    expect(tonoDeSuceso({ type: 'LO_QUE_SEA', severity: 'WARN' })).toBe('warn');
    expect(tonoDeSuceso({ type: 'TICK_ERROR', severity: 'ERROR' })).toBe('warn');
    expect(tonoDeSuceso({ type: 'LIQUIDATED', severity: 'CRITICAL' })).toBe('warn');
  });

  it('de lo informativo solo entran los cuatro tipos que cambian la escalera', () => {
    for (const t of SUCESOS_INFORMATIVOS) {
      expect(tonoDeSuceso({ type: t, severity: 'INFO' })).toBe('info');
    }
    // Un FILL ya tiene su flecha desde el ledger; un DEBUG no le importa a nadie.
    expect(tonoDeSuceso({ type: 'FILL', severity: 'INFO' })).toBeNull();
    expect(tonoDeSuceso({ type: 'BOT_STARTED', severity: 'INFO' })).toBeNull();
    expect(tonoDeSuceso({ type: 'GRID_REANCHORED', severity: 'DEBUG' })).toBe('info');
  });
});

describe('agruparSucesos', () => {
  it('un marcador por vela y tono, con la cuenta y los tipos dentro', () => {
    const out = agruparSucesos(
      [
        suceso('ORDER_REJECTED', 'WARN', T0 + 5 * MIN),
        suceso('ORDER_RETRY', 'WARN', T0 + 20 * MIN),
        suceso('ORDER_REJECTED', 'WARN', T0 + 40 * MIN),
        suceso('SAFETY_ADDED', 'INFO', T0 + 30 * MIN),
        suceso('FILL', 'INFO', T0 + 31 * MIN),
      ],
      porHora,
    );
    expect(out).toEqual([
      { t: T0, tono: 'warn', tipos: ['ORDER_REJECTED', 'ORDER_RETRY'], count: 3 },
      { t: T0, tono: 'info', tipos: ['SAFETY_ADDED'], count: 1 },
    ]);
  });

  it('sale en orden temporal ascendente aunque llegue del revés, como sirve la API', () => {
    const out = agruparSucesos(
      [
        suceso('RISK_GUARD_TRIPPED', 'CRITICAL', T0 + 3 * HORA),
        suceso('GRID_REANCHORED', 'INFO', T0 + HORA),
        suceso('CONFIG_RELOADED', 'INFO', T0),
      ],
      porHora,
    );
    expect(out.map((g) => g.t)).toEqual([T0, T0 + HORA, T0 + 3 * HORA]);
  });

  it('con cien eventos en la misma vela salen como mucho dos marcadores', () => {
    const muchos = Array.from({ length: 100 }, (_, i) =>
      suceso(i % 2 ? 'ORDER_RETRY' : 'MARGIN_ADJUSTED', i % 2 ? 'WARN' : 'INFO', T0 + i * 100),
    );
    const out = agruparSucesos(muchos, porHora);
    expect(out).toHaveLength(2);
    expect(out[0].count + out[1].count).toBe(100);
  });

  it('un instante ilegible no produce un marcador sin sitio', () => {
    expect(agruparSucesos([suceso('ORDER_REJECTED', 'WARN', Number.NaN)], porHora)).toEqual([]);
  });
});

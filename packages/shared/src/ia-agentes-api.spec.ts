import { RETRASO_RONDA_MS, proximaRondaAgente } from './ia-agentes-api';

/** Cuándo mira un agente (spec 074): tras el cierre de cada vela de su intervalo. */
describe('proximaRondaAgente', () => {
  const t = (iso: string): number => Date.parse(iso);

  it('el cierre de la vela en curso, más el retraso', () => {
    expect(proximaRondaAgente(t('2026-09-24T10:07:00Z'), '15m')).toBe(
      t('2026-09-24T10:15:00Z') + RETRASO_RONDA_MS,
    );
    expect(proximaRondaAgente(t('2026-09-24T10:30:00Z'), '1h')).toBe(
      t('2026-09-24T11:00:00Z') + RETRASO_RONDA_MS,
    );
    expect(proximaRondaAgente(t('2026-09-24T01:00:00Z'), '4h')).toBe(
      t('2026-09-24T04:00:00Z') + RETRASO_RONDA_MS,
    );
  });

  it('tras una ronda, la siguiente es la de la vela siguiente', () => {
    // La ronda de las 11:00 corre a las 11:00:15 y deja la siguiente en las 12:00:15.
    const ronda = t('2026-09-24T11:00:00Z') + RETRASO_RONDA_MS;
    expect(proximaRondaAgente(ronda, '1h')).toBe(t('2026-09-24T12:00:00Z') + RETRASO_RONDA_MS);
  });

  it('el retraso da tiempo al venue a publicar la vela cerrada', () => {
    expect(RETRASO_RONDA_MS).toBeGreaterThanOrEqual(5_000);
    expect(RETRASO_RONDA_MS).toBeLessThan(60_000);
  });
});

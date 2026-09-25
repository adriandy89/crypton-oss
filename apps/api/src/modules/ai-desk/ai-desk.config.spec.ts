import { ConfigService } from '@nestjs/config';
import { AiDeskConfig } from './ai-desk.config';

const cfg = (valores: Record<string, string>): AiDeskConfig =>
  new AiDeskConfig({
    get: (k: string, def?: string) => valores[k] ?? def,
  } as unknown as ConfigService);

describe('AiDeskConfig — el plazo del modelo (spec 078)', () => {
  it('90 s de fábrica: con 20 s el razonamiento `medium` no cabía y cada ronda se cortaba', () => {
    expect(cfg({}).plazoLlamadaMs).toBe(90_000);
  });

  it('lo configurado manda, hasta el tope de 120 s del transporte', () => {
    expect(cfg({ AI_DESK_TIMEOUT_MS: '60000' }).plazoLlamadaMs).toBe(60_000);
    expect(cfg({ AI_DESK_TIMEOUT_MS: '200000' }).plazoLlamadaMs).toBe(120_000);
    expect(cfg({ AI_DESK_TIMEOUT_MS: 'mucho' }).plazoLlamadaMs).toBe(90_000);
  });
});

describe('AiDeskConfig — el cerrojo de lo que se lanza a mano (spec 078)', () => {
  it('un minuto entre dos, más lo que puede tardar el modelo', () => {
    expect(cfg({}).cerrojoManualS).toBe(150);
    expect(cfg({ AI_DESK_TIMEOUT_MS: '20000' }).cerrojoManualS).toBe(80);
    expect(cfg({ AI_DESK_TIMEOUT_MS: '45500' }).cerrojoManualS).toBe(106);
  });
});

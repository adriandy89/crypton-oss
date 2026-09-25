import { ConfigService } from '@nestjs/config';
import {
  OpenRouterClient,
  TOPE_DECISION_MS,
  avisoPlazo,
  plazoRecomendadoMs,
  presupuestoRazonamiento,
  type PeticionDecision,
} from './openrouter.client';

/**
 * La llamada de los agentes de IA (spec 074).
 *
 * Es la cuarta carga del cliente y comparte el cuerpo con la del canal. Lo que
 * se prueba aquí es lo que la hace OTRA: su interruptor, su modelo, su esfuerzo,
 * su caché y su título en el panel de OpenRouter, sin que encender o ajustar
 * una toque a las demás. El transporte y sus fallos ya los recorre
 * `openrouter.canal.spec.ts`.
 */

const configCon = (valores: Record<string, string>): ConfigService =>
  ({
    get: (k: string, def?: string) => valores[k] ?? def,
  }) as unknown as ConfigService;

const ENCENDIDO = { OPENROUTER_API_KEY: 'sk-or-mesa', AI_DESK_ENABLE: 'true' };

const peticion = (extra: Partial<PeticionDecision> = {}): PeticionDecision => ({
  esquema: { name: 'decision_agente', schema: { type: 'object' } },
  system: 'Eres el juez de un agente.',
  usuario: 'La oferta de la ronda.',
  limiteMs: 20_000,
  ...extra,
});

const USO = {
  prompt_tokens: 3000,
  completion_tokens: 500,
  cost: 0.0042,
  prompt_tokens_details: { cached_tokens: 2500, cache_write_tokens: 0 },
  completion_tokens_details: { reasoning_tokens: 300 },
};

const respuesta = (cuerpo: unknown, status = 200): Response =>
  new Response(JSON.stringify(cuerpo), { status });

const bien = () =>
  respuesta({
    choices: [{ finish_reason: 'stop', message: { content: '{"eleccion":"NINGUNA"}' } }],
    usage: USO,
  });

type Espia = jest.SpiedFunction<typeof fetch>;

function cuerpoDe(espia: Espia, llamada = 0): Record<string, unknown> {
  const init = espia.mock.calls[llamada][1];
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

const sistemaDe = (cuerpo: Record<string, unknown>): Record<string, unknown> =>
  (cuerpo['messages'] as { content: Record<string, unknown>[] }[])[0].content[0];

describe('los agentes de IA: interruptor y modelo', () => {
  let espia: Espia;
  beforeEach(() => {
    espia = jest.spyOn(globalThis, 'fetch');
  });
  afterEach(() => espia.mockRestore());

  it('apagados por defecto, sin llamar a nadie', async () => {
    const casos: Record<string, string>[] = [
      {},
      { AI_DESK_ENABLE: 'true' },
      { OPENROUTER_API_KEY: 'sk' },
      // El canal encendido no enciende a los agentes, aunque la llamada sea la misma.
      { OPENROUTER_API_KEY: 'sk', AI_CHANNEL_ENABLE: 'true' },
    ];
    for (const valores of casos) {
      const c = new OpenRouterClient(configCon(valores));
      expect(c.agentesDisponible).toBe(false);
      await expect(c.decidirAgente(peticion())).resolves.toMatchObject({
        contenido: null,
        uso: null,
        fallo: 'SIN_CLAVE',
        latenciaMs: 0,
        modelo: 'anthropic/claude-sonnet-5',
      });
    }
    expect(espia).not.toHaveBeenCalled();
  });

  it('independientes de las otras tres cargas, en los dos sentidos', () => {
    const clave = { OPENROUTER_API_KEY: 'sk' };
    const mesa = new OpenRouterClient(configCon({ ...clave, AI_DESK_ENABLE: 'true' }));
    expect([
      mesa.agentesDisponible,
      mesa.available,
      mesa.agentAvailable,
      mesa.canalDisponible,
    ]).toEqual([true, false, false, false]);

    const otras = new OpenRouterClient(
      configCon({
        ...clave,
        AI_ADVISOR_ENABLE: 'true',
        AI_AGENT_ENABLE: 'true',
        AI_CHANNEL_ENABLE: 'true',
      }),
    );
    expect(otras.agentesDisponible).toBe(false);
  });

  it('su modelo, sin heredar el de ninguna otra', () => {
    // `AI_AGENT_MODEL` es el del SUPERVISOR: el nombre se parece y es otra carga.
    const c = new OpenRouterClient(
      configCon({
        ...ENCENDIDO,
        OPENROUTER_MODEL: 'un/modelo-barato',
        AI_AGENT_MODEL: 'otro/modelo',
        AI_CHANNEL_MODEL: 'el/del-canal',
      }),
    );
    expect(c.agentesModelo).toBe('anthropic/claude-sonnet-5');
    const propio = new OpenRouterClient(configCon({ ...ENCENDIDO, AI_DESK_MODEL: 'x/y' }));
    expect(propio.agentesModelo).toBe('x/y');
  });
});

describe('los agentes de IA: la petición', () => {
  let espia: Espia;
  beforeEach(() => {
    espia = jest.spyOn(globalThis, 'fetch').mockResolvedValue(bien());
  });
  afterEach(() => espia.mockRestore());

  it('sale con su clave, su título, esquema estricto, proveedores que lo cumplen y caché de 1 h', async () => {
    const r = await new OpenRouterClient(configCon(ENCENDIDO)).decidirAgente(peticion());
    expect(r.fallo).toBeNull();
    expect(r.contenido).toBe('{"eleccion":"NINGUNA"}');
    expect(r.modelo).toBe('anthropic/claude-sonnet-5');
    expect(r.uso?.coste).toBe('0.0042');

    const cabeceras = new Headers(espia.mock.calls[0][1]?.headers);
    expect(cabeceras.get('Authorization')).toBe('Bearer sk-or-mesa');
    // Su propia línea en el panel de OpenRouter, en ASCII: una cabecera con un
    // carácter por encima de 255 no llega a salir.
    expect(cabeceras.get('X-Title')).toBe('Crypton AI desk');
    expect(cuerpoDe(espia)).toEqual({
      model: 'anthropic/claude-sonnet-5',
      max_tokens: 8000,
      reasoning: { effort: 'medium', exclude: true },
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'decision_agente', strict: true, schema: { type: 'object' } },
      },
      provider: { require_parameters: true },
      messages: [
        {
          role: 'system',
          content: [
            {
              type: 'text',
              text: 'Eres el juez de un agente.',
              cache_control: { type: 'ephemeral', ttl: '1h' },
            },
          ],
        },
        { role: 'user', content: 'La oferta de la ronda.' },
      ],
    });
  });

  it('su esfuerzo y su caché, sin tocar los del canal', async () => {
    const c = new OpenRouterClient(
      configCon({
        ...ENCENDIDO,
        AI_CHANNEL_ENABLE: 'true',
        AI_DESK_REASONING: 'high',
        AI_DESK_PROMPT_CACHE: 'off',
        AI_CHANNEL_REASONING: 'low',
        AI_CHANNEL_PROMPT_CACHE: '5m',
      }),
    );
    await c.decidirAgente(peticion());
    await c.decidirCanal(peticion());

    const agente = cuerpoDe(espia, 0);
    expect(agente['reasoning']).toEqual({ effort: 'high', exclude: true });
    expect(sistemaDe(agente)).toEqual({ type: 'text', text: 'Eres el juez de un agente.' });

    const canal = cuerpoDe(espia, 1);
    expect(canal['reasoning']).toEqual({ effort: 'low', exclude: true });
    expect(sistemaDe(canal)['cache_control']).toEqual({ type: 'ephemeral' });
    expect(new Headers(espia.mock.calls[1][1]?.headers).get('X-Title')).toBe('Crypton AI channel');
  });

  it('un valor fuera de lista se ignora y queda el de fábrica', async () => {
    await new OpenRouterClient(
      configCon({ ...ENCENDIDO, AI_DESK_REASONING: 'maximo', AI_DESK_PROMPT_CACHE: '24h' }),
    ).decidirAgente(peticion());
    const cuerpo = cuerpoDe(espia);
    expect(cuerpo['reasoning']).toEqual({ effort: 'medium', exclude: true });
    expect(sistemaDe(cuerpo)['cache_control']).toEqual({ type: 'ephemeral', ttl: '1h' });
  });

  it('el plazo es el de quien llama, hasta 120 s (spec 078)', async () => {
    // Con 25 s de tope, el razonamiento `medium` —hasta 4000 tokens— no cabía:
    // cada ronda se cortaba a los 20 s y se cobraba entera igualmente.
    const plazo = jest.spyOn(AbortSignal, 'timeout');
    try {
      const c = new OpenRouterClient(configCon(ENCENDIDO));
      await c.decidirAgente(peticion({ limiteMs: 90_000 }));
      await c.decidirAgente(peticion({ limiteMs: 200_000 }));
      await c.decidirAgente(peticion({ limiteMs: 7_000 }));
      expect(plazo.mock.calls[0][0]).toBeLessThanOrEqual(90_000);
      expect(plazo.mock.calls[0][0]).toBeGreaterThan(89_000);
      expect(plazo.mock.calls[1][0]).toBeLessThanOrEqual(TOPE_DECISION_MS);
      expect(plazo.mock.calls[1][0]).toBeGreaterThan(TOPE_DECISION_MS - 1_000);
      expect(plazo.mock.calls[2][0]).toBeLessThanOrEqual(7_000);
      expect(TOPE_DECISION_MS).toBe(120_000);
    } finally {
      plazo.mockRestore();
    }
  });

  it('un fallo dice por qué y lo que costó, como en el canal', async () => {
    espia.mockResolvedValue(
      respuesta({
        choices: [{ finish_reason: 'length', message: { content: '{"elec' } }],
        usage: USO,
      }),
    );
    const r = await new OpenRouterClient(configCon(ENCENDIDO)).decidirAgente(peticion());
    expect(r).toMatchObject({ contenido: null, fallo: 'TRUNCADA' });
    expect(r.uso?.coste).toBe('0.0042');
  });
});

describe('el plazo que necesita el razonamiento (spec 078)', () => {
  it('el presupuesto es el que reserva OpenRouter sobre max_tokens: 20, 50 y 80 %', () => {
    expect(presupuestoRazonamiento('low')).toBe(1_600);
    expect(presupuestoRazonamiento('medium')).toBe(4_000);
    expect(presupuestoRazonamiento('high')).toBe(6_400);
  });

  it('el plazo recomendado crece con el esfuerzo y nunca pasa del tope', () => {
    expect(plazoRecomendadoMs('low')).toBe(45_000);
    expect(plazoRecomendadoMs('medium')).toBe(90_000);
    expect(plazoRecomendadoMs('high')).toBe(TOPE_DECISION_MS);
  });

  it('avisa con los dos números cuando el plazo no deja terminar, y solo entonces', () => {
    // El incidente: 20 s con `medium`.
    const aviso = avisoPlazo('AI_DESK_TIMEOUT_MS', 20_000, 'medium');
    expect(aviso).toContain('AI_DESK_TIMEOUT_MS=20000');
    expect(aviso).toContain('4000 tokens');
    expect(aviso).toContain('90000');
    expect(avisoPlazo('AI_DESK_TIMEOUT_MS', 90_000, 'medium')).toBeNull();
    expect(avisoPlazo('AI_DESK_TIMEOUT_MS', 45_000, 'low')).toBeNull();
    expect(avisoPlazo('AI_DESK_TIMEOUT_MS', 44_999, 'low')).not.toBeNull();
    expect(avisoPlazo('AI_CHANNEL_TIMEOUT_MS', 120_000, 'high')).toBeNull();
    expect(avisoPlazo('AI_CHANNEL_TIMEOUT_MS', 90_000, 'high')).toContain('high');
  });

  it('cada carga dice su esfuerzo', () => {
    const c = new OpenRouterClient(
      configCon({ ...ENCENDIDO, AI_DESK_REASONING: 'low', AI_CHANNEL_REASONING: 'high' }),
    );
    expect(c.agentesEsfuerzo).toBe('low');
    expect(c.canalEsfuerzo).toBe('high');
    expect(new OpenRouterClient(configCon(ENCENDIDO)).agentesEsfuerzo).toBe('medium');
  });
});

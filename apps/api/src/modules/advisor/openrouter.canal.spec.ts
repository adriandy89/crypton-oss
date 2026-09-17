import { ConfigService } from '@nestjs/config';
import { OpenRouterClient, marcadorCache, usoDe, type PeticionCanal } from './openrouter.client';

/**
 * La llamada del canal con IA (spec 059).
 *
 * Lo que importa aquí no es lo que decide el modelo, sino lo que el lazo
 * necesita saber de cada llamada: si salió con su clave y su caché, lo que
 * costó, y por qué no sirvió cuando no sirvió. Un fallo cuenta para dormir las
 * consultas; un «no» no.
 */

const configCon = (valores: Record<string, string>): ConfigService =>
  ({
    get: (k: string, def?: string) => valores[k] ?? def,
  }) as unknown as ConfigService;

const ENCENDIDO = { OPENROUTER_API_KEY: 'sk-or-canal', AI_CHANNEL_ENABLE: 'true' };

const peticion = (extra: Partial<PeticionCanal> = {}): PeticionCanal => ({
  esquema: { name: 'decision_canal', schema: { type: 'object' } },
  system: 'Eres el juez del canal.',
  usuario: 'La oferta.',
  limiteMs: 20_000,
  ...extra,
});

const respuesta = (cuerpo: unknown, status = 200): Response =>
  new Response(JSON.stringify(cuerpo), { status });

const USO = {
  prompt_tokens: 2100,
  completion_tokens: 900,
  cost: 0.01234,
  prompt_tokens_details: { cached_tokens: 1800, cache_write_tokens: 0 },
  completion_tokens_details: { reasoning_tokens: 700 },
};

const bien = (content = '{"veredicto":"NO_OPERAR"}') =>
  respuesta({ choices: [{ finish_reason: 'stop', message: { content } }], usage: USO });

type Espia = jest.SpiedFunction<typeof fetch>;

function cuerpoDe(espia: Espia, llamada = 0): Record<string, unknown> {
  const init = espia.mock.calls[llamada][1];
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

describe('la IA del canal: interruptor y modelo', () => {
  let espia: Espia;
  beforeEach(() => {
    espia = jest.spyOn(globalThis, 'fetch');
  });
  afterEach(() => espia.mockRestore());

  it('apagada por defecto, sin llamar a nadie', async () => {
    const casos: Record<string, string>[] = [
      {},
      { AI_CHANNEL_ENABLE: 'true' },
      { OPENROUTER_API_KEY: 'sk' },
    ];
    for (const valores of casos) {
      const c = new OpenRouterClient(configCon(valores));
      expect(c.canalDisponible).toBe(false);
      await expect(c.decidirCanal(peticion())).resolves.toMatchObject({
        contenido: null,
        uso: null,
        fallo: 'SIN_CLAVE',
      });
    }
    expect(espia).not.toHaveBeenCalled();
  });

  it('independiente del asesor y del supervisor, en los dos sentidos', () => {
    const clave = { OPENROUTER_API_KEY: 'sk' };
    const canal = new OpenRouterClient(configCon({ ...clave, AI_CHANNEL_ENABLE: 'true' }));
    expect([canal.canalDisponible, canal.available, canal.agentAvailable]).toEqual([
      true,
      false,
      false,
    ]);
    const otros = new OpenRouterClient(
      configCon({ ...clave, AI_ADVISOR_ENABLE: 'true', AI_AGENT_ENABLE: 'true' }),
    );
    expect(otros.canalDisponible).toBe(false);
  });

  it('su modelo, sin heredar el de los otros', () => {
    const c = new OpenRouterClient(
      configCon({
        ...ENCENDIDO,
        OPENROUTER_MODEL: 'un/modelo-barato',
        AI_AGENT_MODEL: 'otro/modelo',
      }),
    );
    expect(c.canalModelo).toBe('anthropic/claude-sonnet-5');
    const propio = new OpenRouterClient(configCon({ ...ENCENDIDO, AI_CHANNEL_MODEL: 'x/y' }));
    expect(propio.canalModelo).toBe('x/y');
  });
});

describe('la IA del canal: la petición', () => {
  let espia: Espia;
  beforeEach(() => {
    espia = jest.spyOn(globalThis, 'fetch').mockResolvedValue(bien());
  });
  afterEach(() => espia.mockRestore());

  it('sale con su clave, su título, esquema estricto, proveedores que lo cumplen y caché de 1 h', async () => {
    const c = new OpenRouterClient(configCon(ENCENDIDO));
    const r = await c.decidirCanal(peticion());
    expect(r.fallo).toBeNull();
    expect(r.contenido).toBe('{"veredicto":"NO_OPERAR"}');
    expect(r.modelo).toBe('anthropic/claude-sonnet-5');
    expect(r.latenciaMs).toBeGreaterThanOrEqual(0);

    const init = espia.mock.calls[0][1];
    const cabeceras = new Headers(init?.headers);
    expect(cabeceras.get('Authorization')).toBe('Bearer sk-or-canal');
    expect(cabeceras.get('X-Title')).toBe('Crypton AI channel');
    expect(cuerpoDe(espia)).toEqual({
      model: 'anthropic/claude-sonnet-5',
      max_tokens: 8000,
      reasoning: { effort: 'medium', exclude: true },
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'decision_canal', strict: true, schema: { type: 'object' } },
      },
      provider: { require_parameters: true },
      messages: [
        {
          role: 'system',
          content: [
            {
              type: 'text',
              text: 'Eres el juez del canal.',
              cache_control: { type: 'ephemeral', ttl: '1h' },
            },
          ],
        },
        { role: 'user', content: 'La oferta.' },
      ],
    });
  });

  it('la caché de 5 min va sin ttl, y apagada no lleva marcador', async () => {
    await new OpenRouterClient(
      configCon({ ...ENCENDIDO, AI_CHANNEL_PROMPT_CACHE: '5m' }),
    ).decidirCanal(peticion());
    await new OpenRouterClient(
      configCon({ ...ENCENDIDO, AI_CHANNEL_PROMPT_CACHE: 'off' }),
    ).decidirCanal(peticion());
    const sistema = (llamada: number) =>
      (cuerpoDe(espia, llamada)['messages'] as { content: Record<string, unknown>[] }[])[0]
        .content[0];
    expect(sistema(0)['cache_control']).toEqual({ type: 'ephemeral' });
    expect(sistema(1)).toEqual({ type: 'text', text: 'Eres el juez del canal.' });
  });

  it('el razonamiento y la caché solo admiten sus valores', async () => {
    await new OpenRouterClient(
      configCon({ ...ENCENDIDO, AI_CHANNEL_REASONING: 'high' }),
    ).decidirCanal(peticion());
    await new OpenRouterClient(
      configCon({
        ...ENCENDIDO,
        AI_CHANNEL_REASONING: 'maximo',
        AI_CHANNEL_PROMPT_CACHE: '24h',
      }),
    ).decidirCanal(peticion());
    expect(cuerpoDe(espia, 0)['reasoning']).toEqual({ effort: 'high', exclude: true });
    const raro = cuerpoDe(espia, 1);
    expect(raro['reasoning']).toEqual({ effort: 'medium', exclude: true });
    const sistema = (raro['messages'] as { content: Record<string, unknown>[] }[])[0].content[0];
    expect(sistema['cache_control']).toEqual({ type: 'ephemeral', ttl: '1h' });
  });

  it('el plazo es el de quien llama, nunca más de 25 s', async () => {
    const plazo = jest.spyOn(AbortSignal, 'timeout');
    try {
      const c = new OpenRouterClient(configCon(ENCENDIDO));
      await c.decidirCanal(peticion({ limiteMs: 60_000 }));
      await c.decidirCanal(peticion({ limiteMs: 7_000 }));
      expect(plazo.mock.calls[0][0]).toBeLessThanOrEqual(25_000);
      expect(plazo.mock.calls[0][0]).toBeGreaterThan(24_000);
      expect(plazo.mock.calls[1][0]).toBeLessThanOrEqual(7_000);
    } finally {
      plazo.mockRestore();
    }
  });

  it('sin tiempo para un intento, no llama', async () => {
    const r = await new OpenRouterClient(configCon(ENCENDIDO)).decidirCanal(
      peticion({ limiteMs: 900 }),
    );
    expect(r).toMatchObject({ contenido: null, uso: null, fallo: 'TIEMPO' });
    expect(espia).not.toHaveBeenCalled();
  });

  it('lee el uso y el coste', async () => {
    const r = await new OpenRouterClient(configCon(ENCENDIDO)).decidirCanal(peticion());
    expect(r.uso).toEqual({
      tokensEntrada: 2100,
      tokensSalida: 900,
      tokensCacheLeidos: 1800,
      tokensCacheEscritos: 0,
      tokensRazonamiento: 700,
      coste: '0.01234',
    });
  });
});

describe('la IA del canal: por qué no sirvió', () => {
  let espia: Espia;
  beforeEach(() => {
    espia = jest.spyOn(globalThis, 'fetch');
  });
  afterEach(() => espia.mockRestore());

  const llamar = () => new OpenRouterClient(configCon(ENCENDIDO)).decidirCanal(peticion());

  it('un 401 no se reintenta', async () => {
    espia.mockResolvedValue(respuesta({ error: 'no' }, 401));
    await expect(llamar()).resolves.toMatchObject({ contenido: null, fallo: 'HTTP' });
    expect(espia).toHaveBeenCalledTimes(1);
  });

  it('un 503 se reintenta una vez, y si vuelve a fallar es HTTP', async () => {
    espia.mockResolvedValueOnce(respuesta({}, 503)).mockResolvedValueOnce(bien());
    await expect(llamar()).resolves.toMatchObject({ fallo: null });
    expect(espia).toHaveBeenCalledTimes(2);

    espia.mockReset();
    espia.mockResolvedValue(respuesta({}, 503));
    await expect(llamar()).resolves.toMatchObject({ contenido: null, fallo: 'HTTP' });
    expect(espia).toHaveBeenCalledTimes(2);
  });

  it.each<[string, unknown, string]>([
    ['un error dentro de un 200', { error: { code: 502, message: 'x' }, usage: USO }, 'HTTP'],
    ['una negativa', { choices: [{ message: { refusal: 'no' } }], usage: USO }, 'NEGATIVA'],
    [
      'una respuesta cortada',
      { choices: [{ finish_reason: 'length', message: { content: '{"ve' } }], usage: USO },
      'TRUNCADA',
    ],
    ['sin elección', { choices: [], usage: USO }, 'VACIA'],
  ])('%s: sin contenido, con lo que costó', async (_, cuerpo, fallo) => {
    espia.mockResolvedValue(respuesta(cuerpo));
    const r = await llamar();
    expect(r).toMatchObject({ contenido: null, fallo });
    expect(r.uso?.coste).toBe('0.01234');
  });

  it('un contenido vacío es una respuesta vacía', async () => {
    espia.mockResolvedValue(respuesta({ choices: [{ message: { content: null } }] }));
    await expect(llamar()).resolves.toMatchObject({ contenido: '', uso: null, fallo: 'VACIA' });
  });

  it('el tiempo agotado y la red', async () => {
    const tiempo = Object.assign(new Error('se acabó'), { name: 'TimeoutError' });
    espia.mockRejectedValueOnce(tiempo);
    await expect(llamar()).resolves.toMatchObject({ contenido: null, fallo: 'TIEMPO' });
    espia.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(llamar()).resolves.toMatchObject({ contenido: null, fallo: 'RED' });
    espia.mockRejectedValueOnce(new Error('ECONNRESET'));
    await expect(llamar()).resolves.toMatchObject({ contenido: null, fallo: 'RED' });
  });
});

describe('usoDe', () => {
  it('lo que no es un número finito y positivo cuenta como cero, y el coste como null', () => {
    expect(
      usoDe({
        prompt_tokens: -3,
        completion_tokens: 'mucho',
        cost: 'gratis',
        prompt_tokens_details: null,
      }),
    ).toEqual({
      tokensEntrada: 0,
      tokensSalida: 0,
      tokensCacheLeidos: 0,
      tokensCacheEscritos: 0,
      tokensRazonamiento: 0,
      coste: null,
    });
    expect(usoDe({ cost: -1 })?.coste).toBeNull();
    expect(usoDe({ cost: Number.NaN })?.coste).toBeNull();
    expect(usoDe(null)).toBeNull();
    expect(usoDe('x')).toBeNull();
  });

  it('el coste cruza a decimal sin notación científica', () => {
    expect(usoDe({ cost: 1e-7 })?.coste).toBe('0.0000001');
    expect(usoDe({ cost: 0 })?.coste).toBe('0');
    expect(usoDe({ cost: 0.1 + 0.2 })?.coste).toBe('0.30000000000000004');
    expect(usoDe({ prompt_tokens: 12.7 })?.tokensEntrada).toBe(12);
  });
});

describe('marcadorCache', () => {
  it('una hora, cinco minutos o nada', () => {
    expect(marcadorCache('1h')).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(marcadorCache('5m')).toEqual({ type: 'ephemeral' });
    expect(marcadorCache('off')).toBeUndefined();
  });
});

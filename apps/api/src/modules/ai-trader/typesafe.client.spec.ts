import type { ConfigService } from '@nestjs/config';
import { TypeSafeClient, choiceDe, noulDe, scoreDe, usoTypeSafeDe } from './typesafe.client';

/**
 * El transporte de TypeSafe (spec 069).
 *
 * Lo que prueban estos tests es el catálogo de desgracias: un proveedor que no
 * contesta, que contesta tarde, que contesta 529, o que contesta 200 con basura.
 * Ninguna de ellas puede acabar en una orden, y ninguna puede lanzar: quien
 * llama tiene una intención abierta que hay que cerrar pase lo que pase.
 */

const CLAVE = 'apikey_de_prueba_no_es_real';

function montar(entorno: Record<string, string> = {}) {
  const env: Record<string, string> = {
    AI_TRADER_ENABLE: 'true',
    TYPESAFE_AI_API_KEY: CLAVE,
    ...entorno,
  };
  const config = { get: (k: string, def?: string) => env[k] ?? def } as unknown as ConfigService;
  return new TypeSafeClient(config);
}

const preguntas = {
  action: { type: 'choice' as const, instructions: 'x', criteria: { A: 'a', B: 'b' } },
};

const peticion = { estado: { instrument: 'x' }, preguntas, limiteMs: 5_000 };

const respuesta = (cuerpo: unknown, status = 200): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => cuerpo,
    text: async () => JSON.stringify(cuerpo),
    body: { cancel: async () => undefined },
  }) as unknown as Response;

describe('TypeSafeClient: cuándo está disponible', () => {
  it('hace falta el interruptor Y la clave', () => {
    expect(montar().disponible).toBe(true);
    expect(montar({ AI_TRADER_ENABLE: 'false' }).disponible).toBe(false);
    expect(montar({ TYPESAFE_AI_API_KEY: '' }).disponible).toBe(false);
    expect(montar({ TYPESAFE_AI_API_KEY: '   ' }).disponible).toBe(false);
  });

  it('sin clave no se sale a la red siquiera', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as never;
    const r = await montar({ TYPESAFE_AI_API_KEY: '' }).preguntar(peticion);

    expect(r.fallo).toBe('SIN_CLAVE');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('TypeSafeClient: la tabla de fallos', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('una respuesta buena trae las respuestas y el uso', async () => {
    global.fetch = jest.fn(async () =>
      respuesta({
        answers: { action: { choice: 'A' } },
        usage: { input_tokens: 10, output_tokens: 4 },
      }),
    ) as never;
    const r = await montar().preguntar(peticion);

    expect(r.fallo).toBeNull();
    expect(r.answers).toEqual({ action: { choice: 'A' } });
    expect(r.uso).toEqual({ entrada: 10, salida: 4 });
    expect(r.modelo).toBe('jev-latest');
  });

  /** El 529 es transitorio y NO es culpa nuestra: merece su propia línea. */
  it('el 529 es SOBRECARGA, no un HTTP cualquiera', async () => {
    global.fetch = jest.fn(async () => respuesta({ error: 'overloaded' }, 529)) as never;
    expect((await montar().preguntar(peticion)).fallo).toBe('SOBRECARGA');
  });

  it.each([
    [401, 'HTTP'],
    [403, 'HTTP'],
    [422, 'HTTP'],
    [500, 'HTTP'],
  ])('el %i es %s', async (status, esperado) => {
    global.fetch = jest.fn(async () => respuesta({ error: 'x' }, status)) as never;
    expect((await montar().preguntar(peticion)).fallo).toBe(esperado);
  });

  it('un 200 sin mapa de respuestas es VACIA, no una decisión a medias', async () => {
    global.fetch = jest.fn(async () => respuesta({ usage: { input_tokens: 5 } })) as never;
    const r = await montar().preguntar(peticion);

    expect(r.fallo).toBe('VACIA');
    // El uso se conserva: una respuesta inútil también se factura.
    expect(r.uso).toEqual({ entrada: 5, salida: 0 });
  });

  it('el tiempo agotado es TIEMPO y no RED', async () => {
    global.fetch = jest.fn(async () => {
      const e = new Error('agotado');
      e.name = 'TimeoutError';
      throw e;
    }) as never;
    expect((await montar().preguntar(peticion)).fallo).toBe('TIEMPO');
  });

  /**
   * Un `TypeError` aquí no es una caída ajena: es una petición que no llegó a
   * salir porque la construimos mal. Se distingue para que un fallo permanente
   * nuestro no se disfrace de problema del proveedor.
   */
  it('un TypeError es RED, y se registra como error nuestro', async () => {
    global.fetch = jest.fn(async () => {
      throw new TypeError('cabecera ilegal');
    }) as never;
    expect((await montar().preguntar(peticion)).fallo).toBe('RED');
  });

  it('nunca lanza: quien llama tiene una intención que cerrar', async () => {
    global.fetch = jest.fn(async () => {
      throw new Error('lo que sea');
    }) as never;
    await expect(montar().preguntar(peticion)).resolves.toMatchObject({ fallo: 'RED' });
  });
});

describe('TypeSafeClient: los reintentos', () => {
  it('un 5xx se reintenta una vez; un 401 no', async () => {
    let n = 0;
    global.fetch = jest.fn(async () => {
      n++;
      return respuesta({ answers: { a: 1 } }, n === 1 ? 502 : 200);
    }) as never;
    expect((await montar().preguntar(peticion)).fallo).toBeNull();
    expect(n).toBe(2);

    n = 0;
    global.fetch = jest.fn(async () => {
      n++;
      return respuesta({ error: 'x' }, 401);
    }) as never;
    await montar().preguntar(peticion);
    expect(n).toBe(1);
  });

  /**
   * Un solo presupuesto para los dos intentos: dos esperas completas se
   * comerían el plazo de la intención entera y la decisión llegaría tarde.
   */
  it('con el presupuesto agotado no se intenta una segunda vez', async () => {
    let n = 0;
    global.fetch = jest.fn(async () => {
      n++;
      await new Promise((r) => setTimeout(r, 60));
      return respuesta({ error: 'x' }, 503);
    }) as never;
    await montar().preguntar({ ...peticion, limiteMs: 1_000 });
    expect(n).toBe(1);
  });
});

describe('Los lectores de la respuesta cruda', () => {
  it('una elección buena pasa; una clave que no se ofreció, no', () => {
    const buena = { choice: 'A', probabilities: { A: 0.7, B: 0.3 }, confidence: 0.4 };
    expect(choiceDe(buena, ['A', 'B'])).toEqual(buena);
    expect(choiceDe({ ...buena, choice: 'Z' }, ['A', 'B'])).toBeNull();
  });

  /**
   * Fuera de [0,1] se RECHAZA, no se recorta. Un proveedor que devuelve 1,4 no
   * está diciendo «mucha confianza»: está diciendo otra cosa, y recortarlo sería
   * inventarse lo que quiso decir.
   */
  it.each([-0.1, 1.4, Number.NaN, Number.POSITIVE_INFINITY])(
    'una confianza de %p se rechaza, no se recorta',
    (confidence) => {
      expect(choiceDe({ choice: 'A', probabilities: {}, confidence }, ['A'])).toBeNull();
    },
  );

  it('las probabilidades que no son números se descartan sin tirar la elección', () => {
    const r = choiceDe({ choice: 'A', probabilities: { A: 0.7, B: 'mucho' }, confidence: 0.4 }, [
      'A',
    ]);
    expect(r?.probabilities).toEqual({ A: 0.7 });
  });

  it('una probabilidad se lee envuelta o suelta, y fuera de rango se rechaza', () => {
    expect(noulDe({ noul: 0.42 })).toBe(0.42);
    expect(noulDe(0.42)).toBe(0.42);
    expect(noulDe({ noul: 1.2 })).toBeNull();
    expect(noulDe({ noul: 'alta' })).toBeNull();
    expect(noulDe(null)).toBeNull();
  });

  it('el uso se lee con los dos nombres, y sin nada es null', () => {
    expect(usoTypeSafeDe({ input_tokens: 3, output_tokens: 1 })).toEqual({ entrada: 3, salida: 1 });
    expect(usoTypeSafeDe({ prompt_tokens: 3, completion_tokens: 1 })).toEqual({
      entrada: 3,
      salida: 1,
    });
    expect(usoTypeSafeDe({})).toBeNull();
    expect(usoTypeSafeDe(null)).toBeNull();
  });
});

/**
 * La primitiva `score` (spec 071).
 *
 * Es la que faltaba y la que hace posible el experimento: un ESCALAR CONTINUO
 * se puede comparar con un umbral barato a tasa de aceptacion igualada, y una
 * categoria no. Ese fue el fallo estructural de los specs 069 y 070.
 */
describe('scoreDe', () => {
  const NIVELES = ['vuelve_enseguida', 'se_para_justo_ahi', 'sigue_dias'];

  it('lee una puntuacion bien formada', () => {
    const v = {
      score: 1.43,
      probabilities: { se_para_justo_ahi: 0.57, sigue_dias: 0.43 },
      confidence: 0.6,
    };
    expect(scoreDe(v, NIVELES)).toEqual(v);
  });

  /**
   * Fuera del rango de niveles se RECHAZA, no se recorta: un 4,2 sobre una
   * escala de tres no es «lo maximo», es otra cosa.
   */
  it.each([-0.1, 2.01, 9, Number.NaN, Number.POSITIVE_INFINITY])(
    'una puntuacion de %p se rechaza',
    (score) => {
      expect(scoreDe({ score, probabilities: {}, confidence: 0.5 }, NIVELES)).toBeNull();
    },
  );

  it('los extremos exactos si valen', () => {
    expect(scoreDe({ score: 0, probabilities: {}, confidence: 1 }, NIVELES)).not.toBeNull();
    expect(scoreDe({ score: 2, probabilities: {}, confidence: 1 }, NIVELES)).not.toBeNull();
  });

  it.each([
    ['sin confianza', { score: 1 }],
    ['con confianza fuera de rango', { score: 1, confidence: 1.4 }],
    ['sin puntuacion', { confidence: 0.5 }],
    ['que no es un objeto', 1.43],
    ['nulo', null],
  ])('%s se rechaza', (_caso, v) => {
    expect(scoreDe(v, NIVELES)).toBeNull();
  });

  it('sin niveles no hay escala contra la que validar', () => {
    expect(scoreDe({ score: 1, probabilities: {}, confidence: 0.5 }, [])).toBeNull();
  });
});

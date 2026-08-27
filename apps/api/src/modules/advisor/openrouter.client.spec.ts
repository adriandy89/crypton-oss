import { ConfigService } from '@nestjs/config';
import { OpenRouterClient } from './openrouter.client';
import { knobsSchema } from './prompt';

/**
 * El cliente del modelo.
 *
 * Lo que se prueba aqui no es que la IA acierte —eso no se puede probar— sino
 * las dos cosas de las que depende que la funcionalidad sea segura:
 *
 *   1. Que SIN configurar nada, el cliente esta apagado y no rompe nada. Es el
 *      caso por defecto en todo despliegue que no haya puesto la clave.
 *   2. Que una respuesta que no cumple el contrato se rechaza ENTERA en vez de
 *      repararse. Reparar la salida de un modelo que ya se ha salido del
 *      contrato es adivinar, y aqui lo que se adivina son parametros con dinero
 *      detras.
 */

const configCon = (valores: Record<string, string>): ConfigService =>
  ({
    get: (k: string, def?: string) => valores[k] ?? def,
  }) as unknown as ConfigService;

/** Acceso al parseador privado: es la superficie que de verdad hay que probar. */
const parse = (c: OpenRouterClient, raw: string): unknown =>
  (c as unknown as { parse(r: string): unknown }).parse(raw);

const perilla = (profile: string) => ({
  profile,
  leverage: 'MEDIA',
  coverage: 'MEDIA',
  spread: 'MEDIA',
  sizeGrowth: 'MEDIA',
  cadence: 'MEDIA',
  rationale: 'Porque sí.',
});

describe('cliente del modelo', () => {
  describe('apagado por defecto', () => {
    it('sin clave ni interruptor no esta disponible', () => {
      expect(new OpenRouterClient(configCon({})).available).toBe(false);
    });

    it('con el interruptor encendido pero sin clave, tampoco', () => {
      // Es el despiste tipico al desplegar. Tiene que degradar, no reventar.
      expect(new OpenRouterClient(configCon({ AI_ADVISOR_ENABLE: 'true' })).available).toBe(false);
    });

    it('con clave pero con el interruptor apagado, tampoco', () => {
      // El interruptor manda sobre la clave, y no al reves: es la forma de
      // apagar el gasto sin tener que borrar el secreto del despliegue.
      expect(new OpenRouterClient(configCon({ OPENROUTER_API_KEY: 'sk-or-x' })).available).toBe(
        false,
      );
    });

    it('con las dos cosas si esta disponible', () => {
      expect(
        new OpenRouterClient(
          configCon({
            AI_ADVISOR_ENABLE: 'true',
            OPENROUTER_API_KEY: 'sk-or-x',
          }),
        ).available,
      ).toBe(true);
    });

    it('estando apagado devuelve null sin llamar a nadie', async () => {
      const c = new OpenRouterClient(configCon({}));
      await expect(
        c.knobsFor('MARTINGALE', 'BTC', {
          mark: 64000,
          volAnnualPct: 70,
          atrPct1h: 0.6,
          atrPct1d: 4,
          rangePct30: 30,
          posInRange: 0.5,
          trendPct: 1,
          trend: 'LATERAL',
          efficiency: 0.3,
          worstDayPct: -7,
          tickBps: 1,
        }),
      ).resolves.toBeNull();
    });
  });

  describe('una respuesta que no cumple el contrato se rechaza entera', () => {
    const c = new OpenRouterClient(configCon({}));

    it('acepta la respuesta buena', () => {
      const bueno = JSON.stringify({
        propuestas: [perilla('PRUDENTE'), perilla('EQUILIBRADA'), perilla('AGRESIVA')],
      });
      const r = parse(c, bueno) as unknown[];
      expect(r).toHaveLength(3);
    });

    it.each([
      ['no es JSON', 'lo siento, no puedo ayudarte con eso'],
      ['faltan propuestas', '{}'],
      [
        'vienen dos en vez de tres',
        JSON.stringify({
          propuestas: [perilla('PRUDENTE'), perilla('AGRESIVA')],
        }),
      ],
      [
        'un perfil repetido',
        JSON.stringify({
          propuestas: [perilla('PRUDENTE'), perilla('PRUDENTE'), perilla('AGRESIVA')],
        }),
      ],
      [
        'un perfil inventado',
        JSON.stringify({
          propuestas: [perilla('TEMERARIA'), perilla('EQUILIBRADA'), perilla('AGRESIVA')],
        }),
      ],
      [
        'una banda inventada',
        JSON.stringify({
          propuestas: [
            { ...perilla('PRUDENTE'), leverage: 'EXTREMA' },
            perilla('EQUILIBRADA'),
            perilla('AGRESIVA'),
          ],
        }),
      ],
      [
        'una banda numerica en vez de enum',
        JSON.stringify({
          propuestas: [
            { ...perilla('PRUDENTE'), coverage: 20 },
            perilla('EQUILIBRADA'),
            perilla('AGRESIVA'),
          ],
        }),
      ],
    ])('rechaza cuando %s', (_caso, raw) => {
      expect(parse(c, raw)).toBeNull();
    });

    it('una explicacion que no es texto se descarta, no se convierte', () => {
      // `String({})` da «[object Object]», y esa cadena acabaria de explicacion
      // en una tarjeta. El `rationale` es lo unico del modelo que se pinta tal
      // cual, asi que o es texto o no es nada.
      const raro = JSON.stringify({
        propuestas: [
          { ...perilla('PRUDENTE'), rationale: { texto: 'hola' } },
          perilla('EQUILIBRADA'),
          perilla('AGRESIVA'),
        ],
      });
      const r = parse(c, raro) as { rationale: string }[];
      expect(r[0].rationale).toBe('');
    });

    it('recorta una explicacion desmedida en vez de fiarse del modelo', () => {
      const largo = JSON.stringify({
        propuestas: [
          { ...perilla('PRUDENTE'), rationale: 'x'.repeat(5000) },
          perilla('EQUILIBRADA'),
          perilla('AGRESIVA'),
        ],
      });
      const r = parse(c, largo) as { rationale: string }[];
      expect(r[0].rationale.length).toBe(240);
    });
  });

  describe('la peticion tiene que poder salir', () => {
    /** Acceso al constructor de cabeceras: es lo que rompia la llamada entera. */
    const headers = (c: OpenRouterClient): Record<string, string> =>
      (c as unknown as { headers(): Record<string, string> }).headers();

    it('las cabeceras se pueden mandar tal cual', () => {
      // El test que faltaba. Los valores de cabecera son ByteString: un guion
      // largo —lo natural al escribir un titulo en español— hace que `fetch`
      // LANCE y la peticion no llegue a salir. Y como el fallo caia en el catch
      // general, se registraba como un problema de red y la funcion servia
      // reglas para siempre mientras el cupo se seguia gastando.
      const c = new OpenRouterClient(
        configCon({
          AI_ADVISOR_ENABLE: 'true',
          OPENROUTER_API_KEY: 'sk-or-x',
          PUBLIC_APP_URL: 'https://example.invalid',
        }),
      );
      expect(() => new Headers(headers(c))).not.toThrow();
    });

    it('se queda con el PRIMER origen, no con la lista entera', () => {
      // `PUBLIC_APP_URL` es una lista separada por comas: la lee asi `main.ts`
      // para el CORS. Mandarla entera pondria «http://a,http://b» de referente.
      const c = new OpenRouterClient(
        configCon({
          AI_ADVISOR_ENABLE: 'true',
          OPENROUTER_API_KEY: 'sk-or-x',
          PUBLIC_APP_URL: 'https://example.invalid, http://localhost:8100',
        }),
      );
      expect(headers(c)['HTTP-Referer']).toBe('https://example.invalid');
    });

    it('un origen que no se puede mandar se sustituye, no se manda roto', () => {
      // Un dominio internacionalizado sin pasar por punycode.
      const c = new OpenRouterClient(
        configCon({
          AI_ADVISOR_ENABLE: 'true',
          OPENROUTER_API_KEY: 'sk-or-x',
          PUBLIC_APP_URL: 'https://cryptón.app',
        }),
      );
      expect(() => new Headers(headers(c))).not.toThrow();
      expect(headers(c)['HTTP-Referer']).toBe('https://example.invalid');
    });

    it('el esquema que se manda es JSON serializable', () => {
      // Un `undefined` o una referencia circular en el esquema haria que
      // `JSON.stringify` lanzara o dejara huecos, con el mismo final silencioso.
      const c = new OpenRouterClient(configCon({}));
      const cuerpo = (c as unknown as { body(a: string, b: string, f: unknown): unknown }).body(
        'GRIDMART',
        'BTC',
        {
          mark: 64000,
          volAnnualPct: 70,
          atrPct1h: 0.6,
          atrPct1d: 4,
          rangePct30: 30,
          posInRange: 0.5,
          trendPct: 1,
          trend: 'LATERAL',
          efficiency: 0.3,
          worstDayPct: -7,
          tickBps: 1,
        },
      );
      const texto = JSON.stringify(cuerpo);
      expect(JSON.parse(texto)).toEqual(cuerpo);
      // El tope debe ser ESTRICTAMENTE mayor que el presupuesto de razonamiento
      // que OpenRouter deriva de él (20 % con `effort: 'low'`), o la API protesta.
      const b = cuerpo as { max_tokens: number };
      expect(b.max_tokens).toBeGreaterThan(b.max_tokens * 0.2);
      // Sin esto, alrededor de un tercio de las peticiones podria acabar en un
      // proveedor que ignora el esquema.
      expect((cuerpo as { provider: { require_parameters: boolean } }).provider).toEqual({
        require_parameters: true,
      });
    });
  });

  describe('el esquema solo acota con enumeraciones', () => {
    // Documenta el motivo del diseno. En el formato de OpenAI —el que habla
    // OpenRouter— las restricciones numericas SI se soportan, asi que esto ya no
    // es una limitacion del proveedor: es una decision. El modelo no emite
    // numeros en absoluto, emite bandas, y los numeros los calcula un generador
    // determinista que ademas conoce la spec del mercado y los limites del
    // usuario —dos cosas que el modelo no ve—. Un `minimum` aqui significaria
    // que alguien ha vuelto a dejar al modelo poner cifras.
    it('no contiene restricciones numericas: el modelo no emite numeros', () => {
      const texto = JSON.stringify(knobsSchema());
      expect(texto).not.toContain('minimum');
      expect(texto).not.toContain('maximum');
      expect(texto).not.toContain('multipleOf');
    });

    it('cada perilla es una enumeracion cerrada', () => {
      const props = (knobsSchema() as any).properties.propuestas.items.properties;
      for (const clave of ['profile', 'leverage', 'coverage', 'spread', 'sizeGrowth', 'cadence']) {
        expect(Array.isArray(props[clave].enum)).toBe(true);
        expect(props[clave].enum.length).toBeGreaterThan(1);
      }
    });
  });
});

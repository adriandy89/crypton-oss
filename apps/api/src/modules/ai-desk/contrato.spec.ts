import { ofertaAgente } from '@crypton/strategy-core';
import {
  CLAVES_ENTRADA,
  MAX_TEXTO_AGENTE,
  esquemaEntrada,
  parseEntrada,
  validarEntrada,
} from './contrato';
import { candidatoDePrueba, salidaDePrueba } from './agentes.fixture-spec';

/**
 * El contrato de la decisión de entrada de un agente (spec 074, R-14, CA-5).
 *
 * Lo que sostiene la seguridad: el modelo solo puede devolver enumeraciones de
 * la oferta que tiene delante, cualquier desvío invalida la respuesta entera,
 * y la confianza solo reduce el tamaño.
 */

const LETRAS = ['A', 'B'];

const respuesta = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  opcion: 'A',
  stop: 'NORMAL',
  objetivo: 'ESCALONADO',
  apalancamiento: 'BAJA',
  tamano: 'COMPLETO',
  confianza: 'ALTA',
  motivo1: 'TENDENCIA_CLARA',
  motivo2: 'RECOMPENSA_BUENA',
  motivo3: 'NINGUNO',
  riesgo1: 'GIRO_DE_TENDENCIA',
  riesgo2: 'NINGUNO',
  texto: 'Retroceso ordenado en una tendencia con fuerza.',
  ...extra,
});

const texto = (o: Record<string, unknown>) => JSON.stringify(o);

describe('esquemaEntrada', () => {
  const { name, schema } = esquemaEntrada(LETRAS);

  function* nodos(n: unknown): Generator<Record<string, unknown>> {
    if (Array.isArray(n)) {
      for (const x of n) yield* nodos(x);
    } else if (typeof n === 'object' && n !== null) {
      const o = n as Record<string, unknown>;
      yield o;
      for (const v of Object.values(o)) yield* nodos(v);
    }
  }

  it('ni números, ni restricciones numéricas, ni uniones, ni objetos abiertos', () => {
    const prohibidas = [
      'minimum',
      'maximum',
      'exclusiveMinimum',
      'exclusiveMaximum',
      'multipleOf',
      'oneOf',
      'anyOf',
      'allOf',
      '$ref',
    ];
    for (const n of nodos(schema)) {
      expect(n['type']).not.toBe('number');
      expect(n['type']).not.toBe('integer');
      for (const p of prohibidas) expect(p in n).toBe(false);
      if (n['type'] === 'object') expect(n['additionalProperties']).toBe(false);
    }
    expect(name).toBe('decision_agente');
  });

  it('todas las claves obligatorias, y la opción solo admite las letras de la oferta', () => {
    expect(schema['required']).toEqual([...CLAVES_ENTRADA]);
    const props = schema['properties'] as Record<string, { enum?: string[] }>;
    expect(props['opcion'].enum).toEqual(['A', 'B', 'NINGUNA']);
    for (const clave of CLAVES_ENTRADA) {
      if (clave !== 'texto') expect(Array.isArray(props[clave].enum)).toBe(true);
    }
  });
});

describe('parseEntrada', () => {
  it('acepta la respuesta buena, sin relleno en los motivos', () => {
    expect(parseEntrada(texto(respuesta()), LETRAS)).toEqual({
      opcion: 'A',
      stop: 'NORMAL',
      objetivo: 'ESCALONADO',
      apalancamiento: 'BAJA',
      tamano: 'COMPLETO',
      confianza: 'ALTA',
      motivos: ['TENDENCIA_CLARA', 'RECOMPENSA_BUENA'],
      riesgos: ['GIRO_DE_TENDENCIA'],
      texto: 'Retroceso ordenado en una tendencia con fuerza.',
    });
  });

  it.each<[string, Record<string, unknown>]>([
    ['una letra que no se ofreció', { opcion: 'C' }],
    ['un stop que no existe', { stop: 'ENORME' }],
    ['un objetivo del canal', { objetivo: 'MEDIA' }],
    ['una banda de más', { apalancamiento: 'MAXIMA' }],
    ['un número donde va una enumeración', { tamano: 2 }],
    ['un motivo inventado', { motivo2: 'CORAZONADA' }],
    ['un texto que no es texto', { texto: 42 }],
    ['una clave de más', { precioDeEntrada: '65000' }],
  ])('rechaza entera %s', (_, extra) => {
    expect(parseEntrada(texto(respuesta(extra)), LETRAS)).toBeNull();
  });

  it('rechaza la que le falta una clave, y lo que no es JSON', () => {
    const { riesgo2: _fuera, ...sin } = respuesta();
    expect(parseEntrada(texto(sin), LETRAS)).toBeNull();
    expect(parseEntrada('no es json', LETRAS)).toBeNull();
    expect(parseEntrada('[1,2]', LETRAS)).toBeNull();
  });

  it('recorta el texto sin fiarse del modelo y sin partir un emoji', () => {
    const r = parseEntrada(texto(respuesta({ texto: `${'x'.repeat(199)}🤖 y más` })), LETRAS);
    expect(r?.texto.length).toBeLessThanOrEqual(MAX_TEXTO_AGENTE);
    expect(r?.texto).toBe('x'.repeat(199));
  });
});

describe('validarEntrada', () => {
  const oferta = ofertaAgente(salidaDePrueba());
  const leer = (extra: Record<string, unknown> = {}) => {
    const r = parseEntrada(texto(respuesta(extra)), LETRAS);
    if (!r) throw new Error('respuesta de prueba mal formada');
    return r;
  };

  it('la oferta de la prueba: A es la tendencia de BTC, B la ruptura de ETH', () => {
    expect(oferta.map((p) => [p.letra, p.candidato.simbolo])).toEqual([
      ['A', 'BTC'],
      ['B', 'ETH'],
    ]);
  });

  it('una elección buena, con el candidato por su id y no por la letra', () => {
    const v = validarEntrada(leer(), oferta);
    expect(v.motivo).toBeNull();
    expect(v.eleccion).toEqual({
      candidatoId: candidatoDePrueba().id,
      stop: 'NORMAL',
      objetivo: 'ESCALONADO',
      apalancamiento: 'BAJA',
      tamano: 'COMPLETO',
      confianza: 'ALTA',
    });
  });

  it('NINGUNA, y la confianza BAJA, no operan', () => {
    expect(validarEntrada(leer({ opcion: 'NINGUNA' }), oferta).motivo).toBe('NINGUNA');
    expect(validarEntrada(leer({ confianza: 'BAJA' }), oferta).motivo).toBe('NINGUNA');
  });

  it('lo que no está disponible dentro de la opción no opera', () => {
    // El AJUSTADO de la prueba no es viable.
    expect(validarEntrada(leer({ stop: 'AJUSTADO' }), oferta).motivo).toBe('OFERTA');
    const sinLejano = ofertaAgente(
      salidaDePrueba({
        pares: [
          {
            simbolo: 'BTC',
            mercado: null,
            candidatos: [
              candidatoDePrueba({
                stops: [
                  {
                    ...candidatoDePrueba().stops[1],
                    esquemasViables: ['MEDIA'],
                    bandas: candidatoDePrueba().stops[1].bandas.slice(0, 1),
                  },
                ],
              }),
            ],
            descartes: [],
          },
        ],
      }),
    );
    expect(validarEntrada(leer({ objetivo: 'LEJANO' }), sinLejano).motivo).toBe('OFERTA');
    expect(
      validarEntrada(leer({ objetivo: 'CERCANO', apalancamiento: 'ALTA' }), sinLejano).motivo,
    ).toBe('OFERTA');
    expect(validarEntrada(leer({ objetivo: 'CERCANO' }), sinLejano).motivo).toBeNull();
  });

  it('la confianza MEDIA ejecuta la mitad, y solo si la mitad sigue siendo una operación', () => {
    expect(validarEntrada(leer({ confianza: 'MEDIA' }), oferta).eleccion?.tamano).toBe('MEDIO');
    // El AMPLIO de la prueba no admite la mitad.
    expect(validarEntrada(leer({ confianza: 'MEDIA', stop: 'AMPLIO' }), oferta).motivo).toBe(
      'OFERTA',
    );
    // Con confianza ALTA y tamaño COMPLETO, el AMPLIO sí vale.
    expect(validarEntrada(leer({ stop: 'AMPLIO' }), oferta).motivo).toBeNull();
  });
});

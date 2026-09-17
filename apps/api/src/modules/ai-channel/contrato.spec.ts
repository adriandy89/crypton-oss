import {
  BandaApalancamiento,
  EsquemaObjetivo,
  MotivoCanal,
  MotivoConsulta,
  NivelConfianza,
  RiesgoCanal,
  TamanoOperacion,
  TipoStop,
  Veredicto,
  type CandidatoOperacion,
} from '@crypton/shared';
import {
  CLAVES_RESPUESTA,
  MAX_TEXTO,
  NINGUNA,
  esquemaDecision,
  etiquetaDe,
  parseDecision,
  validarEleccion,
} from './contrato';
import type { OfertaCanal } from './herramienta';
import { corto, largo, viable } from './oferta.fixture-spec';

/**
 * El contrato de la decisión del canal (spec 059, CA-1).
 *
 * Lo que se fija aquí es lo que sostiene la seguridad: el modelo solo puede
 * devolver enumeraciones de la oferta que tiene delante, y cualquier desvío
 * invalida la respuesta entera.
 */

const ETIQUETAS = ['A', 'B'];

const respuesta = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  veredicto: 'OPERAR',
  opcion: 'A',
  stop: 'AJUSTADO',
  objetivo: 'ESCALONADO',
  apalancamiento: 'MEDIA',
  tamano: 'COMPLETO',
  confianza: 'ALTA',
  motivo1: 'CANAL_CLARO',
  motivo2: 'RECOMPENSA_BUENA',
  motivo3: 'NINGUNO',
  riesgo1: 'RUPTURA',
  riesgo2: 'NINGUNO',
  motivo: 'Rebote limpio en un rango sólido.',
  ...extra,
});

const texto = (o: Record<string, unknown>) => JSON.stringify(o);

describe('esquemaDecision', () => {
  const { name, schema } = esquemaDecision(ETIQUETAS);

  /** Recorre el esquema entero. */
  function* nodos(n: unknown): Generator<Record<string, unknown>> {
    if (Array.isArray(n)) {
      for (const x of n) yield* nodos(x);
    } else if (typeof n === 'object' && n !== null) {
      const o = n as Record<string, unknown>;
      yield o;
      for (const v of Object.values(o)) yield* nodos(v);
    }
  }

  it('ni números, ni restricciones numéricas, ni uniones', () => {
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
      expect(['number', 'integer']).not.toContain(n['type']);
      for (const p of prohibidas) expect(n).not.toHaveProperty(p);
    }
  });

  it('un objeto cerrado con todas sus claves obligatorias', () => {
    expect(name).toBe('decision_canal');
    expect(schema['type']).toBe('object');
    expect(schema['additionalProperties']).toBe(false);
    const props = schema['properties'] as Record<string, Record<string, unknown>>;
    expect(Object.keys(props)).toEqual([...CLAVES_RESPUESTA]);
    expect(schema['required']).toEqual([...CLAVES_RESPUESTA]);
    for (const n of nodos(schema)) {
      if (n['type'] === 'object') expect(n['additionalProperties']).toBe(false);
    }
  });

  it('cada campo salvo el texto es un enum idéntico al vocabulario', () => {
    const props = schema['properties'] as Record<string, { type: string; enum?: string[] }>;
    const esperado: Record<string, string[]> = {
      veredicto: Object.values(Veredicto),
      opcion: ['A', 'B', NINGUNA],
      stop: Object.values(TipoStop),
      objetivo: Object.values(EsquemaObjetivo),
      apalancamiento: Object.values(BandaApalancamiento),
      tamano: Object.values(TamanoOperacion),
      confianza: Object.values(NivelConfianza),
      motivo1: Object.values(MotivoCanal),
      motivo2: Object.values(MotivoCanal),
      motivo3: Object.values(MotivoCanal),
      riesgo1: Object.values(RiesgoCanal),
      riesgo2: Object.values(RiesgoCanal),
    };
    for (const [clave, lista] of Object.entries(esperado)) {
      expect(props[clave]).toMatchObject({ type: 'string', enum: lista });
    }
    expect(props['motivo']).toEqual({ type: 'string', description: expect.any(String) });
  });

  it('las etiquetas son las de la oferta, y solo esas', () => {
    const props = (s: Record<string, unknown>) =>
      s['properties'] as Record<string, { enum: string[] }>;
    expect(props(esquemaDecision([]).schema)['opcion'].enum).toEqual([NINGUNA]);
    expect(props(esquemaDecision(['A', 'B', 'C']).schema)['opcion'].enum).toEqual([
      'A',
      'B',
      'C',
      NINGUNA,
    ]);
  });

  it('se puede mandar tal cual', () => {
    expect(JSON.parse(JSON.stringify(schema))).toEqual(schema);
  });

  it('las etiquetas neutras', () => {
    expect([0, 1, 2, 25].map(etiquetaDe)).toEqual(['A', 'B', 'C', 'Z']);
  });
});

describe('parseDecision', () => {
  it('acepta una respuesta buena y limpia los motivos', () => {
    const r = parseDecision(
      texto(respuesta({ motivo2: 'CANAL_CLARO', motivo3: 'COSTE_ALTO', riesgo2: 'RUPTURA' })),
      ETIQUETAS,
    );
    expect(r).toEqual({
      veredicto: 'OPERAR',
      opcion: 'A',
      stop: 'AJUSTADO',
      objetivo: 'ESCALONADO',
      apalancamiento: 'MEDIA',
      tamano: 'COMPLETO',
      confianza: 'ALTA',
      motivos: ['CANAL_CLARO', 'COSTE_ALTO'],
      riesgos: ['RUPTURA'],
      texto: 'Rebote limpio en un rango sólido.',
    });
  });

  it('no operar, con la opción que sea', () => {
    expect(
      parseDecision(texto(respuesta({ veredicto: 'NO_OPERAR', opcion: NINGUNA })), ETIQUETAS),
    ).toMatchObject({ veredicto: 'NO_OPERAR', opcion: NINGUNA });
    // Contradictorio pero inofensivo: no opera.
    expect(parseDecision(texto(respuesta({ veredicto: 'NO_OPERAR' })), ETIQUETAS)?.opcion).toBe(
      'A',
    );
  });

  it('todo NINGUNO deja las listas vacías', () => {
    const r = parseDecision(
      texto(
        respuesta({
          motivo1: 'NINGUNO',
          motivo2: 'NINGUNO',
          motivo3: 'NINGUNO',
          riesgo1: 'NINGUNO',
          riesgo2: 'NINGUNO',
        }),
      ),
      ETIQUETAS,
    );
    expect(r?.motivos).toEqual([]);
    expect(r?.riesgos).toEqual([]);
  });

  it('recorta el texto sin partir un emoji', () => {
    const largo = 'a'.repeat(MAX_TEXTO - 1) + '😀' + 'b'.repeat(50);
    const r = parseDecision(texto(respuesta({ motivo: largo })), ETIQUETAS);
    expect(r?.texto).toBe('a'.repeat(MAX_TEXTO - 1));
    const corto = parseDecision(texto(respuesta({ motivo: 'x'.repeat(500) })), ETIQUETAS);
    expect(corto?.texto).toHaveLength(MAX_TEXTO);
  });

  it.each<[string, string]>([
    ['no es JSON', 'lo siento'],
    ['es null', 'null'],
    ['es una lista', texto(respuesta()).replace(/^/, '[').replace(/$/, ']')],
    ['es un texto', '"OPERAR"'],
    ['falta una clave', texto({ ...respuesta(), riesgo2: undefined })],
    ['sobra una clave', texto(respuesta({ precio: '64000' }))],
    ['OPERAR sin opción', texto(respuesta({ opcion: NINGUNA }))],
    ['una opción que no se ofreció', texto(respuesta({ opcion: 'C' }))],
    ['un id en vez de una etiqueta', texto(respuesta({ opcion: 'REB-L-H1760000000000' }))],
    ['un veredicto en minúsculas', texto(respuesta({ veredicto: 'operar' }))],
    ['un stop inventado', texto(respuesta({ stop: 'MUY_AJUSTADO' }))],
    ['un esquema inventado', texto(respuesta({ objetivo: 'TODOS' }))],
    ['una banda numérica', texto(respuesta({ apalancamiento: 25 }))],
    ['un tamaño mayor', texto(respuesta({ tamano: 'DOBLE' }))],
    ['una confianza inventada', texto(respuesta({ confianza: 'TOTAL' }))],
    ['un motivo inventado', texto(respuesta({ motivo2: 'INTUICION' }))],
    ['un riesgo inventado', texto(respuesta({ riesgo2: 'NINGUNA' }))],
    ['un texto que no es texto', texto(respuesta({ motivo: { texto: 'hola' } }))],
    ['un texto numérico', texto(respuesta({ motivo: 3 }))],
    ['un texto nulo', texto(respuesta({ motivo: null }))],
  ])('rechaza entera una respuesta si %s', (_, raw) => {
    expect(parseDecision(raw, ETIQUETAS)).toBeNull();
  });

  it('sin oferta solo vale no operar', () => {
    expect(parseDecision(texto(respuesta()), [])).toBeNull();
    expect(
      parseDecision(texto(respuesta({ veredicto: 'NO_OPERAR', opcion: NINGUNA })), []),
    ).not.toBeNull();
  });
});

describe('validarEleccion', () => {
  const oferta = (...candidatos: CandidatoOperacion[]): OfertaCanal => {
    const porEtiqueta = new Map(candidatos.map((c, i) => [etiquetaDe(i), c] as const));
    return { etiquetas: [...porEtiqueta.keys()], porEtiqueta };
  };
  const conDos = oferta(largo(), corto());
  const leer = (extra: Record<string, unknown>) => {
    const r = parseDecision(texto(respuesta(extra)), ETIQUETAS);
    if (!r) throw new Error('respuesta de prueba inválida');
    return r;
  };

  it('no operar es no operar', () => {
    expect(validarEleccion(leer({ veredicto: 'NO_OPERAR' }), conDos, 'MEDIA')).toEqual({
      eleccion: null,
      motivo: MotivoConsulta.NO_OPERAR,
    });
  });

  it('con confianza alta, la elección tal cual y con el id del candidato', () => {
    expect(validarEleccion(leer({}), conDos, 'ALTA')).toEqual({
      motivo: null,
      eleccion: {
        veredicto: 'OPERAR',
        opcion: largo().id,
        stop: 'AJUSTADO',
        objetivo: 'ESCALONADO',
        apalancamiento: 'MEDIA',
        tamano: 'COMPLETO',
        confianza: 'ALTA',
      },
    });
  });

  it('la etiqueta B es el segundo candidato', () => {
    const r = validarEleccion(
      leer({ opcion: 'B', stop: 'NORMAL', objetivo: 'OPUESTO' }),
      conDos,
      'MEDIA',
    );
    expect(r.eleccion?.opcion).toBe(corto().id);
  });

  it('con confianza media, la mitad', () => {
    expect(validarEleccion(leer({ confianza: 'MEDIA' }), conDos, 'MEDIA').eleccion).toMatchObject({
      tamano: 'MEDIO',
      confianza: 'MEDIA',
    });
  });

  it('la mitad tiene que existir', () => {
    const b = { opcion: 'B', stop: 'NORMAL', objetivo: 'OPUESTO' };
    expect(validarEleccion(leer({ ...b, confianza: 'MEDIA' }), conDos, 'MEDIA').motivo).toBe(
      MotivoConsulta.OFERTA,
    );
    expect(validarEleccion(leer({ ...b, tamano: 'MEDIO' }), conDos, 'MEDIA').motivo).toBe(
      MotivoConsulta.OFERTA,
    );
    // Entero, con confianza alta, sí.
    expect(validarEleccion(leer(b), conDos, 'MEDIA').eleccion?.tamano).toBe('COMPLETO');
  });

  it.each<[string, Record<string, unknown>, 'MEDIA' | 'ALTA', MotivoConsulta]>([
    ['una etiqueta que no está en la oferta', { opcion: 'B' }, 'MEDIA', MotivoConsulta.OFERTA],
    ['un stop no disponible', { stop: 'AMPLIO' }, 'MEDIA', MotivoConsulta.OFERTA],
    [
      'un esquema que ese stop no admite',
      { stop: 'NORMAL', objetivo: 'OPUESTO' },
      'MEDIA',
      MotivoConsulta.OFERTA,
    ],
    ['confianza media con mínima alta', { confianza: 'MEDIA' }, 'ALTA', MotivoConsulta.CONFIANZA],
    ['confianza baja con mínima media', { confianza: 'BAJA' }, 'MEDIA', MotivoConsulta.CONFIANZA],
    // Lo que no está en la oferta pesa más que la confianza.
    [
      'un stop no disponible y poca confianza',
      { stop: 'AMPLIO', confianza: 'BAJA' },
      'MEDIA',
      MotivoConsulta.OFERTA,
    ],
  ])('rechaza %s', (_, extra, minima, motivo) => {
    expect(validarEleccion(leer(extra), oferta(largo()), minima)).toEqual({
      eleccion: null,
      motivo,
    });
  });

  it('una opción no disponible no vale aunque traiga esquemas y bandas', () => {
    // No debería existir —la herramienta vacía las listas de lo que no ofrece—,
    // pero la marca de disponible es la que manda.
    const incoherente = largo({
      stops: [{ ...viable(TipoStop.AJUSTADO, '64080.12'), viable: false, motivo: 'RR' }],
    });
    expect(validarEleccion(leer({}), oferta(incoherente), 'MEDIA')).toEqual({
      eleccion: null,
      motivo: MotivoConsulta.OFERTA,
    });
  });

  it('una banda que la opción no tiene', () => {
    const sinAlta = largo({
      stops: [
        {
          ...viable(TipoStop.AJUSTADO, '64080.12'),
          bandas: viable(TipoStop.AJUSTADO, '1').bandas.filter((b) => b.banda !== 'ALTA'),
        },
      ],
    });
    expect(validarEleccion(leer({ apalancamiento: 'ALTA' }), oferta(sinAlta), 'MEDIA').motivo).toBe(
      MotivoConsulta.OFERTA,
    );
    expect(validarEleccion(leer({ apalancamiento: 'BAJA' }), oferta(sinAlta), 'MEDIA').motivo).toBe(
      null,
    );
  });
});

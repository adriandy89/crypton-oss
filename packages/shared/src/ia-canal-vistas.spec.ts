import {
  BandaApalancamiento,
  EsquemaObjetivo,
  NivelConfianza,
  TamanoOperacion,
  TipoStop,
  Veredicto,
  claveValeCanal,
  eleccionEfectiva,
  esEleccionCanal,
  esEventoModoIa,
  esValeCanal,
  interruptorCerrado,
  type EleccionOperacion,
} from './ia-canal';
import {
  LAZO_VACIO,
  cifrasCanalDe,
  eleccionDe,
  falloDe,
  veredictoDe,
  insigniaCanal,
  lineasDelCanal,
  operacionCanalDe,
  rachaDePerdidas,
  respuestaModeloDe,
  resumenPlanDe,
  vistaCanalDe,
  type InterruptoresCanal,
  type LineasCanal,
} from './ia-canal-vistas';

const QUINCE = 900_000;
const T0 = 1_760_000_000_000;

const eleccion = (extra: Partial<EleccionOperacion> = {}): EleccionOperacion => ({
  veredicto: Veredicto.OPERAR,
  opcion: 'REB-L-H1',
  stop: TipoStop.NORMAL,
  objetivo: EsquemaObjetivo.ESCALONADO,
  apalancamiento: BandaApalancamiento.MEDIA,
  tamano: TamanoOperacion.COMPLETO,
  confianza: NivelConfianza.ALTA,
  ...extra,
});

describe('eleccionEfectiva', () => {
  it('con confianza alta, la elección tal cual', () => {
    const e = eleccion();
    expect(eleccionEfectiva(e)).toBe(e);
  });

  it('por debajo de alta, la mitad del tamaño', () => {
    for (const confianza of [NivelConfianza.MEDIA, NivelConfianza.BAJA]) {
      expect(eleccionEfectiva(eleccion({ confianza }))).toEqual(
        eleccion({ confianza, tamano: TamanoOperacion.MEDIO }),
      );
    }
  });

  it('nunca sube el tamaño', () => {
    const e = eleccion({ confianza: NivelConfianza.ALTA, tamano: TamanoOperacion.MEDIO });
    expect(eleccionEfectiva(e).tamano).toBe(TamanoOperacion.MEDIO);
  });
});

describe('interruptorCerrado', () => {
  it('solo off, con o sin comillas y sin mirar mayúsculas', () => {
    for (const cerrado of ['off', '"off"', ' OFF ', '"Off"']) {
      expect(interruptorCerrado(cerrado)).toBe(true);
    }
    for (const abierto of [null, '', 'on', '"on"', 'false', '0', 'offline', '" off"']) {
      expect(interruptorCerrado(abierto)).toBe(false);
    }
  });
});

describe('el vale y los eventos', () => {
  it('un vale son 32 hexadecimales en minúscula', () => {
    expect(esValeCanal('0123456789abcdef0123456789abcdef')).toBe(true);
    expect(esValeCanal('0123456789ABCDEF0123456789abcdef')).toBe(false);
    expect(esValeCanal('0123456789abcdef0123456789abcde')).toBe(false);
    expect(esValeCanal('0123456789abcdef0123456789abcdef0')).toBe(false);
    expect(esValeCanal('a1b2c3d4-e5f6-4789-8abc-def012345678')).toBe(false);
    expect(esValeCanal(42)).toBe(false);
    expect(claveValeCanal('ab')).toBe('ic:vale:ab');
  });

  it('el botón cabe en los 64 bytes de callback_data', () => {
    // Todo ASCII: la longitud es la de los bytes.
    const boton = `ic:${'f'.repeat(32)}:pausa`;
    expect(/^[ -~]+$/.test(boton)).toBe(true);
    expect(boton.length).toBeLessThanOrEqual(64);
  });

  it('los eventos del canal no son del Modo IA', () => {
    expect(esEventoModoIa('AI_SUGGESTION')).toBe(true);
    expect(esEventoModoIa('AI_FAILED')).toBe(true);
    for (const t of ['AI_ENTRY', 'AI_EXIT', 'AI_DECISION', 'AI_DAY_STOP', 'AI_CIERRE']) {
      expect(esEventoModoIa(t)).toBe(false);
    }
  });
});

const canalBruto = (extra: Record<string, unknown> = {}) => ({
  tipo: 'INCLINADO',
  calidad: 'B',
  soporte: '100',
  resistencia: '110',
  media: '105',
  pendientePorVela: 0.5,
  refT: T0,
  desde: T0 - 10 * QUINCE,
  ...extra,
});

describe('vistaCanalDe', () => {
  const scratch = (vista: unknown) => ({ cycleSeq: 3, vista });

  it('lee una vista completa', () => {
    const v = vistaCanalDe(
      scratch({ barT: T0, regimen: 'RANGO', sentido: null, canal: canalBruto() }),
    );
    expect(v).toEqual({
      barT: T0,
      regimen: 'RANGO',
      sentido: null,
      canal: {
        tipo: 'INCLINADO',
        calidad: 'B',
        soporte: '100',
        resistencia: '110',
        media: '105',
        pendientePorVela: 0.5,
        refT: T0,
        desde: T0 - 10 * QUINCE,
      },
    });
  });

  it('sin canal y con sentido', () => {
    expect(
      vistaCanalDe(scratch({ barT: T0, regimen: 'TENDENCIA', sentido: 'ALCISTA', canal: null })),
    ).toEqual({ barT: T0, regimen: 'TENDENCIA', sentido: 'ALCISTA', canal: null });
  });

  it('sin desde, null', () => {
    const v = vistaCanalDe(
      scratch({ barT: T0, regimen: 'RANGO', canal: canalBruto({ desde: undefined }) }),
    );
    expect(v?.canal?.desde).toBeNull();
    expect(v?.sentido).toBeNull();
  });

  it.each([
    ['sin scratch', null],
    ['sin vista', {}],
    ['barT raro', { vista: { barT: 'x', regimen: 'RANGO', canal: null } }],
    ['régimen desconocido', { vista: { barT: T0, regimen: 'LATERAL', canal: null } }],
    ['sentido desconocido', { vista: { barT: T0, regimen: 'RANGO', sentido: 'X', canal: null } }],
    [
      'nivel no numérico',
      { vista: { barT: T0, regimen: 'RANGO', canal: canalBruto({ soporte: 'a' }) } },
    ],
    [
      'nivel como número',
      { vista: { barT: T0, regimen: 'RANGO', canal: canalBruto({ media: 105 }) } },
    ],
    [
      'calidad desconocida',
      { vista: { barT: T0, regimen: 'RANGO', canal: canalBruto({ calidad: 'D' }) } },
    ],
    [
      'tipo desconocido',
      { vista: { barT: T0, regimen: 'RANGO', canal: canalBruto({ tipo: 'X' }) } },
    ],
    [
      'pendiente infinita',
      { vista: { barT: T0, regimen: 'RANGO', canal: canalBruto({ pendientePorVela: Infinity }) } },
    ],
    ['desde raro', { vista: { barT: T0, regimen: 'RANGO', canal: canalBruto({ desde: 'ayer' }) } }],
  ])('%s → null', (_, s) => {
    expect(vistaCanalDe(s)).toBeNull();
  });
});

const planBruto = (extra: Record<string, unknown> = {}) => ({
  intentId: 'int-1',
  candidatoId: 'REB-L-H1',
  setup: 'REBOTE',
  lado: 'LONG',
  eleccion: eleccion(),
  entradaReferencia: '100.1',
  entradaTope: '100.2',
  stop: '99.5',
  objetivos: [
    { precio: '105', cantidad: '0.6' },
    { precio: '109', cantidad: '0.4' },
  ],
  cantidad: '1',
  apalancamiento: 12,
  nocional: '100.2',
  riesgo: '0.8',
  rNeto: 2.1,
  liquidacionEstimada: '92',
  huella: 'h',
  barT: T0,
  canal: canalBruto({ desde: undefined, calidad: undefined }),
  venceEn: T0 + 24 * QUINCE,
  distanciaStop: 0.007,
  ...extra,
});

describe('operacionCanalDe', () => {
  it('lee la operación viva', () => {
    const op = operacionCanalDe({
      op: {
        plan: planBruto(),
        intento: 0,
        enviadaEn: T0 + 5,
        tp1Hecho: true,
        stopBreakeven: '100.3',
      },
    });
    expect(op?.plan.stop).toBe('99.5');
    expect(op?.enviadaEn).toBe(T0 + 5);
    expect(op?.tp1Hecho).toBe(true);
    expect(op?.stopBreakeven).toBe('100.3');
    expect(op?.lineas).toEqual({
      tipo: 'INCLINADO',
      soporte: '100',
      resistencia: '110',
      media: '105',
      pendientePorVela: 0.5,
      refT: T0,
      desde: null,
    });
  });

  it('sin breakeven ni TP1 hechos', () => {
    const op = operacionCanalDe({ op: { plan: planBruto(), enviadaEn: T0 } });
    expect(op?.tp1Hecho).toBe(false);
    expect(op?.stopBreakeven).toBeNull();
  });

  it.each([
    ['sin op', {}],
    ['op nula', { op: null }],
    ['sin enviadaEn', { op: { plan: planBruto() } }],
    ['lado raro', { op: { plan: planBruto({ lado: 'BUY' }), enviadaEn: T0 } }],
    ['setup raro', { op: { plan: planBruto({ setup: 'RUPTURA' }), enviadaEn: T0 } }],
    ['sin objetivos', { op: { plan: planBruto({ objetivos: [] }), enviadaEn: T0 } }],
    [
      'objetivo roto',
      { op: { plan: planBruto({ objetivos: [{ precio: 'x', cantidad: '1' }] }), enviadaEn: T0 } },
    ],
    ['stop numérico', { op: { plan: planBruto({ stop: 99.5 }), enviadaEn: T0 } }],
    ['apalancamiento texto', { op: { plan: planBruto({ apalancamiento: '12' }), enviadaEn: T0 } }],
    ['sin canal', { op: { plan: planBruto({ canal: null }), enviadaEn: T0 } }],
    ['sin riesgo', { op: { plan: planBruto({ riesgo: undefined }), enviadaEn: T0 } }],
    ['sin vencimiento', { op: { plan: planBruto({ venceEn: null }), enviadaEn: T0 } }],
  ])('%s → null', (_, s) => {
    expect(operacionCanalDe(s)).toBeNull();
  });

  it('resumenPlanDe saca lo esencial', () => {
    expect(resumenPlanDe(planBruto())).toEqual({
      lado: 'LONG',
      setup: 'REBOTE',
      entradaTope: '100.2',
      stop: '99.5',
      objetivos: ['105', '109'],
      cantidad: '1',
      apalancamiento: 12,
      riesgo: '0.8',
      rNeto: 2.1,
    });
    expect(resumenPlanDe(null)).toBeNull();
    expect(resumenPlanDe({ stop: '1' })).toBeNull();
  });
});

describe('lineasDelCanal', () => {
  const canal: LineasCanal = {
    tipo: 'INCLINADO',
    soporte: '100',
    resistencia: '110',
    media: '105',
    pendientePorVela: 0.5,
    refT: T0,
    desde: T0 - 2 * QUINCE,
  };

  it('desplaza los niveles con cada vela de 15 min, hacia atrás y hacia delante', () => {
    const tiempos = [T0 - 2 * QUINCE, T0, T0 + QUINCE / 2, T0 + 4 * QUINCE];
    const l = lineasDelCanal(canal, tiempos);
    expect(l.soporte).toEqual([
      { t: T0 - 2 * QUINCE, v: 99 },
      { t: T0, v: 100 },
      { t: T0 + QUINCE / 2, v: 100.25 },
      { t: T0 + 4 * QUINCE, v: 102 },
    ]);
    expect(l.resistencia.map((p) => p.v)).toEqual([109, 110, 110.25, 112]);
    expect(l.media.map((p) => p.v)).toEqual([104, 105, 105.25, 107]);
  });

  it('nada antes del primer toque ni después de hasta', () => {
    const tiempos = [T0 - 3 * QUINCE, T0 - 2 * QUINCE, T0, T0 + QUINCE];
    const l = lineasDelCanal(canal, tiempos, T0);
    expect(l.soporte.map((p) => p.t)).toEqual([T0 - 2 * QUINCE, T0]);
    expect(l.media).toHaveLength(2);
  });

  it('sin desde, en todas las velas; horizontal, plano', () => {
    const plano: LineasCanal = { ...canal, tipo: 'HORIZONTAL', pendientePorVela: 0, desde: null };
    const l = lineasDelCanal(plano, [T0 - 100 * QUINCE, T0 + 100 * QUINCE]);
    expect(l.soporte.map((p) => p.v)).toEqual([100, 100]);
    expect(l.resistencia.map((p) => p.v)).toEqual([110, 110]);
  });

  it('con decimales que un número no guarda, sin deriva', () => {
    const fino: LineasCanal = {
      ...canal,
      soporte: '0.1',
      resistencia: '0.3',
      pendientePorVela: 0.1,
      desde: null,
    };
    const l = lineasDelCanal(fino, [T0 + 2 * QUINCE]);
    expect(l.soporte[0].v).toBe(0.3);
    expect(l.resistencia[0].v).toBe(0.5);
    expect(l.media[0].v).toBe(0.4);
  });
});

describe('respuestaModeloDe', () => {
  const respuesta = {
    veredicto: 'OPERAR',
    opcion: 'A',
    stop: 'NORMAL',
    objetivo: 'MEDIA',
    apalancamiento: 'BAJA',
    tamano: 'COMPLETO',
    confianza: 'MEDIA',
    motivos: ['CANAL_CLARO'],
    riesgos: [],
    texto: 'Rebote limpio.',
  };

  it('la lee de dentro de la decisión', () => {
    expect(respuestaModeloDe({ ...eleccion(), respuesta })).toEqual(respuesta);
  });

  it.each([
    ['decisión de reglas', eleccion()],
    ['nula', null],
    ['motivos que no son lista', { respuesta: { ...respuesta, motivos: 'CANAL_CLARO' } }],
    ['riesgo no textual', { respuesta: { ...respuesta, riesgos: [1] } }],
    ['sin texto', { respuesta: { ...respuesta, texto: undefined } }],
    ['veredicto numérico', { respuesta: { ...respuesta, veredicto: 1 } }],
  ])('%s → null', (_, d) => {
    expect(respuestaModeloDe(d)).toBeNull();
  });
});

describe('eleccionDe', () => {
  it('la elección de arriba, sin la respuesta ni nada de más', () => {
    expect(eleccionDe({ ...eleccion(), respuesta: { opcion: 'A' }, extra: 1 })).toEqual(eleccion());
  });

  it.each<[string, unknown]>([
    ['nula', null],
    ['una lista', [eleccion()]],
    ['un fallo', { fallo: 'TIEMPO' }],
    ['sin opción', { ...eleccion(), opcion: '' }],
    ['una opción numérica', { ...eleccion(), opcion: 7 }],
    ['un veredicto raro', { ...eleccion(), veredicto: 'COMPRAR' }],
    ['un stop raro', { ...eleccion(), stop: 'MINIMO' }],
    ['un esquema raro', { ...eleccion(), objetivo: 'TODOS' }],
    ['una banda rara', { ...eleccion(), apalancamiento: 'EXTREMA' }],
    ['una banda numérica', { ...eleccion(), apalancamiento: 25 }],
    ['un tamaño raro', { ...eleccion(), tamano: 'DOBLE' }],
    ['una confianza rara', { ...eleccion(), confianza: 'TOTAL' }],
  ])('%s → null', (_, json) => {
    expect(eleccionDe(json)).toBeNull();
  });
});

describe('falloDe', () => {
  it('el motivo, si lo hay', () => {
    expect(falloDe({ fallo: 'TIEMPO' })).toBe('TIEMPO');
    expect(falloDe({ fallo: 'CONTRATO', bruto: '{' })).toBe('CONTRATO');
    for (const d of [null, 'TIEMPO', {}, { fallo: '' }, { fallo: 3 }, eleccion()]) {
      expect(falloDe(d)).toBeNull();
    }
  });
});

describe('insigniaCanal', () => {
  const interruptores = (extra: Partial<InterruptoresCanal> = {}): InterruptoresCanal => ({
    encendido: true,
    modelo: 'm',
    soloSombra: false,
    entradas: 'ABIERTAS',
    limiteBot: 48,
    limiteGlobal: 400,
    llamadasGlobalesHoy: 0,
    ...extra,
  });
  const ahora = T0;
  const pausado = { ...LAZO_VACIO, pausadoHasta: new Date(ahora + 60_000).toISOString() };

  it('de lo más grave a lo menos', () => {
    expect(insigniaCanal(interruptores(), LAZO_VACIO, ahora)).toBe('CONSULTA');
    expect(insigniaCanal(interruptores({ soloSombra: true }), LAZO_VACIO, ahora)).toBe('SOMBRA');
    expect(insigniaCanal(interruptores({ soloSombra: true }), pausado, ahora)).toBe('PAUSADA');
    expect(insigniaCanal(interruptores({ entradas: 'CERRADAS' }), pausado, ahora)).toBe('CORTADA');
    expect(insigniaCanal(interruptores({ entradas: 'DESCONOCIDO' }), LAZO_VACIO, ahora)).toBe(
      'CORTADA',
    );
    expect(
      insigniaCanal(interruptores({ encendido: false, entradas: 'CERRADAS' }), pausado, ahora),
    ).toBe('APAGADA');
  });

  /**
   * Spec 062, F-46. La pastilla solo miraba los interruptores del SERVIDOR:
   * decia «IA · canal» en un bot en modo reglas —donde no se consulta a
   * nadie— y en uno con sus propias entradas apagadas.
   */
  it('mira tambien el modo y las entradas del propio bot', () => {
    const reglas = { modo: 'REGLAS' as const, entradas: true };
    expect(insigniaCanal(interruptores(), LAZO_VACIO, ahora, reglas)).toBe('REGLAS');
    // Sus entradas apagadas mandan sobre el modo.
    expect(insigniaCanal(interruptores(), LAZO_VACIO, ahora, { ...reglas, entradas: false })).toBe(
      'CORTADA',
    );
    // Y lo del servidor sigue mandando sobre lo del bot.
    expect(insigniaCanal(interruptores({ encendido: false }), LAZO_VACIO, ahora, reglas)).toBe(
      'APAGADA',
    );
    expect(insigniaCanal(interruptores(), pausado, ahora, reglas)).toBe('PAUSADA');
    // En modo IA, como siempre.
    expect(insigniaCanal(interruptores(), LAZO_VACIO, ahora, { modo: 'IA', entradas: true })).toBe(
      'CONSULTA',
    );
  });

  it('una pausa vencida ya no cuenta', () => {
    const vencida = { ...LAZO_VACIO, pausadoHasta: new Date(ahora - 1).toISOString() };
    expect(insigniaCanal(interruptores(), vencida, ahora)).toBe('CONSULTA');
    const justo = { ...LAZO_VACIO, pausadoHasta: new Date(ahora).toISOString() };
    expect(insigniaCanal(interruptores(), justo, ahora)).toBe('CONSULTA');
  });
});

describe('rachaDePerdidas', () => {
  it('cuenta desde la más reciente hasta la primera que no pierde', () => {
    expect(rachaDePerdidas([])).toBe(0);
    expect(rachaDePerdidas(['-1', '-0.5', '2', '-3'])).toBe(2);
    expect(rachaDePerdidas(['0', '-1'])).toBe(0);
    expect(rachaDePerdidas(['-0.000000000000000001'])).toBe(1);
    expect(rachaDePerdidas(['-1', '-1', '-1'])).toBe(3);
  });
});

describe('cifrasCanalDe', () => {
  const setup = {
    setup: 'REBOTE',
    lado: 'LONG',
    n: 4,
    aciertos: 3,
    wilsonInferior: 0.3,
    rMedio: 0.5,
    esperanza: '1.2',
    factorBeneficio: 2.5,
    resultado: '4.8',
  };
  const ventana = {
    desde: T0,
    hasta: T0 + 1,
    operaciones: 4,
    resultado: '4.8',
    rTotal: 2,
    porSetup: [setup],
  };
  const operacion = {
    setup: 'REBOTE',
    lado: 'LONG',
    candidatoId: 'REB-L-H1',
    entradaEn: T0,
    salidaEn: T0 + 1,
    precioEntrada: '100',
    precioSalida: '101',
    stop: '99',
    objetivos: ['101'],
    apalancamiento: 5,
    riesgo: '1',
    resultado: '1',
    r: 1,
    rPlaneado: 1,
    salida: 'OBJETIVO',
  };
  const metrics = {
    netPnl: '4.8',
    porSetup: [setup],
    ventanas: [ventana],
    operaciones: [operacion],
  };

  it('saca las tres listas de las métricas guardadas', () => {
    expect(cifrasCanalDe(metrics)).toEqual({
      porSetup: [setup],
      ventanas: [ventana],
      operaciones: [operacion],
    });
  });

  it('sin porSetup no es un backtest del canal', () => {
    expect(cifrasCanalDe({ netPnl: '1' })).toBeNull();
    expect(cifrasCanalDe(null)).toBeNull();
    expect(cifrasCanalDe([])).toBeNull();
  });

  it('una lista con un elemento roto se descarta entera', () => {
    expect(cifrasCanalDe({ ...metrics, porSetup: [setup, { ...setup, n: '4' }] })).toBeNull();
    expect(
      cifrasCanalDe({ ...metrics, ventanas: [ventana, { ...ventana, porSetup: [{}] }] }),
    ).toEqual({
      porSetup: [setup],
      ventanas: [],
      operaciones: [operacion],
    });
    expect(
      cifrasCanalDe({ ...metrics, operaciones: [{ ...operacion, salida: 'MANUAL' }] })?.operaciones,
    ).toEqual([]);
    expect(
      cifrasCanalDe({ ...metrics, porSetup: [{ ...setup, factorBeneficio: null }] })?.porSetup,
    ).toHaveLength(1);
  });

  it('sin ventanas ni operaciones, listas vacías', () => {
    expect(cifrasCanalDe({ porSetup: [] })).toEqual({
      porSetup: [],
      ventanas: [],
      operaciones: [],
    });
  });
});

/**
 * Las dos estrategias con IA guardan su eleccion en la MISMA columna JSON. Lo
 * que separa una forma de otra son estos dos lectores, y lo que pasa cuando
 * fallan es que un bot ejecuta una decision que no era suya.
 */
describe('veredictoDe y esEleccionCanal (spec 069)', () => {
  const DEL_TRADER = {
    accion: 'TOMAR',
    confianza: 'ALTA',
    acuerdo: true,
    stop: 'MEDIDO',
    objetivo: 'EN_LA_MEDIA',
    tamano: 'COMPLETO',
  };
  const DEL_CANAL = {
    veredicto: 'OPERAR',
    opcion: 'A',
    stop: 'NORMAL',
    objetivo: 'MEDIA',
    apalancamiento: 'BAJA',
    tamano: 'COMPLETO',
    confianza: 'ALTA',
  };

  it('lee el veredicto del «Bot de IA»', () => {
    expect(veredictoDe(DEL_TRADER)).toEqual(DEL_TRADER);
  });

  it('las dos formas son excluyentes: ningun lector lee la del otro', () => {
    expect(veredictoDe(DEL_CANAL)).toBeNull();
    expect(eleccionDe(DEL_TRADER)).toBeNull();
  });

  it('y se distinguen por su forma, no por el nombre de la estrategia', () => {
    expect(esEleccionCanal(DEL_CANAL as never)).toBe(true);
    expect(esEleccionCanal(DEL_TRADER as never)).toBe(false);
  });

  /**
   * Viene de una columna JSON: lo que no encaja se lee como «sin eleccion», y
   * sin eleccion la estrategia no opera. Nunca se completa a medias.
   */
  it.each([
    ['sin accion', { ...DEL_TRADER, accion: undefined }],
    ['con una accion inventada', { ...DEL_TRADER, accion: 'COMPRAR_TODO' }],
    ['con el acuerdo como texto', { ...DEL_TRADER, acuerdo: 'si' }],
    ['con un stop que no existe', { ...DEL_TRADER, stop: 'ENORME' }],
    ['con confianza fuera de la lista', { ...DEL_TRADER, confianza: 0.9 }],
    ['que no es un objeto', 'TOMAR'],
    ['nulo', null],
  ])('%s se lee como sin eleccion', (_caso, json) => {
    expect(veredictoDe(json)).toBeNull();
  });
});

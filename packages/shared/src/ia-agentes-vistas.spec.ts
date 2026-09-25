import {
  AccionSeguimiento,
  EstadoTesis,
  FamiliaAgente,
  MotivoAgente,
  MotivoSeguimiento,
  ObjetivoAgente,
  RiesgoAgente,
  type PlanAgente,
} from './ia-agentes';
import {
  cambioSeguimientoDe,
  eleccionAgenteDe,
  planAgenteDe,
  rAhora,
  respuestaAgenteDe,
  respuestaSeguimientoDe,
  resultadoEnR,
  resultadoHipoteticoDe,
} from './ia-agentes-vistas';
import { BandaApalancamiento, NivelConfianza, TamanoOperacion, TipoStop } from './ia-canal';

const ELECCION = {
  candidatoId: 'BTC|TENDENCIA|LONG|1760000000000',
  stop: TipoStop.NORMAL,
  objetivo: ObjetivoAgente.ESCALONADO,
  apalancamiento: BandaApalancamiento.BAJA,
  tamano: TamanoOperacion.COMPLETO,
  confianza: NivelConfianza.ALTA,
};

const PLAN: PlanAgente = {
  version: 1,
  simbolo: 'BTC',
  familia: FamiliaAgente.TENDENCIA,
  lado: 'LONG',
  intervalo: '1h',
  eleccion: ELECCION,
  entradaReferencia: '100000',
  entradaTope: '100020',
  extremo: '99500',
  nivelIdea: null,
  stop: '99000',
  tp1: '101500',
  tp2: '103000',
  objetivos: [
    { precio: '101500', cantidad: '0.005' },
    { precio: '103000', cantidad: '0.005' },
  ],
  cantidad: '0.01',
  apalancamiento: 4,
  nocional: '1000.2',
  margen: '250.05',
  riesgo: '11.2',
  riesgoPctCapital: 0.49,
  rNeto: 1.9,
  liquidacionEstimada: '76000',
  distanciaStop: 0.0102,
  barT: 1_760_000_000_000,
  huella: '1760000000000|BTC|TENDENCIA|LONG',
  entradaHasta: 1_760_000_900_000,
  maxMinutos: 1440,
  breakevenTrasTp1: true,
  costes: { makerBps: 1.5, takerBps: 4.5, deslizamientoBps: 2 },
};

describe('eleccionAgenteDe', () => {
  it('acepta la forma del contrato e ignora lo de más', () => {
    expect(eleccionAgenteDe({ ...ELECCION, extra: 1 })).toEqual(ELECCION);
  });

  it('rechaza lo que no encaja', () => {
    expect(eleccionAgenteDe(null)).toBeNull();
    expect(eleccionAgenteDe({ ...ELECCION, candidatoId: '' })).toBeNull();
    // Un objetivo del canal no es un objetivo de agente.
    expect(eleccionAgenteDe({ ...ELECCION, objetivo: 'MEDIA' })).toBeNull();
    expect(eleccionAgenteDe({ ...ELECCION, tamano: 'DOBLE' })).toBeNull();
  });
});

describe('respuestaAgenteDe', () => {
  const r = {
    opcion: 'A',
    stop: TipoStop.NORMAL,
    objetivo: ObjetivoAgente.CERCANO,
    apalancamiento: BandaApalancamiento.MEDIA,
    tamano: TamanoOperacion.COMPLETO,
    confianza: NivelConfianza.MEDIA,
    motivos: [MotivoAgente.TENDENCIA_CLARA, MotivoAgente.RECOMPENSA_BUENA],
    riesgos: [RiesgoAgente.GIRO_DE_TENDENCIA],
    texto: 'Retroceso limpio a la media en una tendencia con fuerza.',
  };

  it('lee una respuesta bien formada', () => {
    expect(respuestaAgenteDe(r)).toEqual(r);
  });

  it('rechaza motivos repetidos o fuera de la lista', () => {
    expect(respuestaAgenteDe({ ...r, motivos: ['TENDENCIA_CLARA', 'TENDENCIA_CLARA'] })).toBeNull();
    expect(respuestaAgenteDe({ ...r, motivos: ['CANAL_CLARO'] })).toBeNull();
    expect(respuestaAgenteDe({ ...r, riesgos: 'LIQUIDEZ' })).toBeNull();
    expect(respuestaAgenteDe({ ...r, texto: 5 })).toBeNull();
  });
});

describe('respuestaSeguimientoDe', () => {
  const r = {
    accion: AccionSeguimiento.PROTEGER,
    tesis: EstadoTesis.DEBILITADA,
    confianza: NivelConfianza.ALTA,
    motivos: [MotivoSeguimiento.MOMENTO_EN_CONTRA],
    texto: 'El impulso se apaga cerca del objetivo.',
  };

  it('lee una respuesta bien formada', () => {
    expect(respuestaSeguimientoDe(r)).toEqual(r);
  });

  it('rechaza una acción que no existe', () => {
    expect(respuestaSeguimientoDe({ ...r, accion: 'AMPLIAR_STOP' })).toBeNull();
    expect(respuestaSeguimientoDe({ ...r, tesis: 'REGULAR' })).toBeNull();
  });
});

describe('planAgenteDe', () => {
  it('lee el plan que se guardó', () => {
    expect(planAgenteDe(JSON.parse(JSON.stringify(PLAN)))).toEqual(PLAN);
  });

  it('rechaza una versión desconocida o un campo que acaba en una orden mal formado', () => {
    expect(planAgenteDe({ ...PLAN, version: 2 })).toBeNull();
    expect(planAgenteDe({ ...PLAN, stop: 'NaN' })).toBeNull();
    expect(planAgenteDe({ ...PLAN, cantidad: 0.01 })).toBeNull();
    expect(planAgenteDe({ ...PLAN, lado: 'BUY' })).toBeNull();
    expect(planAgenteDe({ ...PLAN, tp2: undefined })).toBeNull();
    expect(planAgenteDe({ ...PLAN, nivelIdea: 5 })).toBeNull();
    expect(planAgenteDe({ ...PLAN, intervalo: '1m' })).toBeNull();
    expect(planAgenteDe({ ...PLAN, eleccion: { ...ELECCION, stop: 'ENORME' } })).toBeNull();
  });

  it('uno o dos objetivos, nunca cero ni tres', () => {
    expect(planAgenteDe({ ...PLAN, objetivos: [PLAN.objetivos[0]] })).not.toBeNull();
    expect(planAgenteDe({ ...PLAN, objetivos: [] })).toBeNull();
    const tres = [...PLAN.objetivos, { precio: '104000', cantidad: '0.001' }];
    expect(planAgenteDe({ ...PLAN, objetivos: tres })).toBeNull();
  });
});

describe('cambioSeguimientoDe: lo único que puede llegar a updateConfig', () => {
  it('el stop, la posición o los dos', () => {
    expect(cambioSeguimientoDe({ stopPrice: '99500' })).toEqual({ stopPrice: '99500' });
    expect(cambioSeguimientoDe({ positionCap: '0' })).toEqual({ positionCap: '0' });
    expect(cambioSeguimientoDe({ stopPrice: '99500', positionCap: '0.005' })).toEqual({
      stopPrice: '99500',
      positionCap: '0.005',
    });
  });

  it('cualquier otra clave invalida el cambio entero', () => {
    expect(cambioSeguimientoDe({ stopPrice: '99500', leverage: 20 })).toBeNull();
    expect(cambioSeguimientoDe({ tp1Price: '105000' })).toBeNull();
    expect(cambioSeguimientoDe({})).toBeNull();
    expect(cambioSeguimientoDe(['stopPrice'])).toBeNull();
  });

  it('ni negativos, ni un stop en cero, ni números sueltos', () => {
    expect(cambioSeguimientoDe({ positionCap: '-1' })).toBeNull();
    expect(cambioSeguimientoDe({ stopPrice: '0' })).toBeNull();
    expect(cambioSeguimientoDe({ stopPrice: 99500 })).toBeNull();
  });
});

describe('resultadoHipoteticoDe', () => {
  it('lee lo que se guardó y rechaza lo demás', () => {
    const h = { resultado: 'STOP', r: -1.08, en: 1_760_000_000_000 };
    expect(resultadoHipoteticoDe(h)).toEqual(h);
    expect(resultadoHipoteticoDe({ ...h, resultado: 'LIQUIDACION' })).toBeNull();
    expect(resultadoHipoteticoDe({ ...h, r: Number.NaN })).toBeNull();
  });
});

describe('rAhora y resultadoEnR', () => {
  it('sobre el riesgo inicial, con signo', () => {
    expect(rAhora('LONG', '100', '98', '103')).toBe(1.5);
    expect(rAhora('LONG', '100', '98', '99')).toBe(-0.5);
    expect(rAhora('SHORT', '100', '102', '97')).toBe(1.5);
    expect(rAhora('SHORT', '100', '102', '101')).toBe(-0.5);
  });

  it('sin distancia al stop no hay R', () => {
    expect(rAhora('LONG', '100', '100', '103')).toBeNull();
    expect(resultadoEnR('5', '0')).toBeNull();
  });

  it('el resultado realizado entre la pérdida al stop', () => {
    expect(resultadoEnR('-11.2', '11.2')).toBe(-1);
    expect(resultadoEnR('16.8', '11.2')).toBe(1.5);
  });
});

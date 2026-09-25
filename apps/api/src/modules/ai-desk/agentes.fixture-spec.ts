import type {
  CandidatoAgente,
  ContextoParAgente,
  OpcionStop,
  PlanAgente,
  SalidaAgente,
} from '@crypton/shared';

/** La vela de la ronda de prueba. */
export const BAR_T = 1_727_172_000_000;

/** El mercado de un par, en las unidades que ve el modelo. */
export function mercadoDePrueba(extra: Partial<ContextoParAgente> = {}): ContextoParAgente {
  return {
    regimen: 'TENDENCIA',
    sentido: 'ALCISTA',
    adx: 27.3,
    rsi: 55.1,
    atrPct: 0.84,
    percentilAncho: 35,
    distanciaMediaAtr: 0.4,
    pendienteMedia: 0.08,
    spreadBps: 1.2,
    fundingBps: 1,
    precio: '65000',
    atr: '546',
    frescas: true,
    ...extra,
  };
}

/** Una opción de stop viable, con sus tres bandas. */
export function opcionDePrueba(extra: Partial<OpcionStop> = {}): OpcionStop {
  return {
    tipo: 'NORMAL',
    precio: '64230',
    distancia: 0.012,
    viable: true,
    motivo: null,
    nocional: '6501.05',
    cantidad: '0.1',
    riesgo: '5',
    perdidaAlStop: '5',
    perdidaPorUnidad: '50',
    esquemasViables: ['MEDIA', 'ESCALONADO', 'OPUESTO'],
    bandas: [
      {
        banda: 'BAJA',
        apalancamiento: 3,
        margen: '2167.02',
        liquidacion: '43800',
        perdidaCatastrofica: '2167.02',
      },
      {
        banda: 'MEDIA',
        apalancamiento: 5,
        margen: '1300.21',
        liquidacion: '52400',
        perdidaCatastrofica: '1300.21',
      },
      {
        banda: 'ALTA',
        apalancamiento: 8,
        margen: '812.63',
        liquidacion: '57600',
        perdidaCatastrofica: '812.63',
      },
    ],
    apalancamientoMinimo: 1,
    apalancamientoMaximo: 8,
    rNetoTp1: 1.62,
    rNetoTp2: 3.4,
    costeR: 0.08,
    aciertoEquilibrioTp1: 0.38,
    aciertoEquilibrioTp2: 0.23,
    riesgoPctCapital: 0.5,
    medioViable: true,
    ...extra,
  };
}

/** Un candidato con sus tres stops: el ajustado no llega al mínimo del venue. */
export function candidatoDePrueba(extra: Partial<CandidatoAgente> = {}): CandidatoAgente {
  const simbolo = extra.simbolo ?? 'BTC';
  const familia = extra.familia ?? 'TENDENCIA';
  const lado = extra.lado ?? 'LONG';
  return {
    id: `${simbolo}|${familia}|${lado}|${BAR_T}`,
    simbolo,
    familia,
    lado,
    entradaReferencia: '65000',
    entradaTope: '65010.5',
    extremo: '64500',
    nivel: null,
    tp1: '66400',
    tp2: '67800',
    stops: [
      opcionDePrueba({
        tipo: 'AJUSTADO',
        viable: false,
        motivo: 'MINIMO',
        esquemasViables: [],
        bandas: [],
      }),
      opcionDePrueba(),
      opcionDePrueba({ tipo: 'AMPLIO', precio: '63900', distancia: 0.017, medioViable: false }),
    ],
    tasas: { n: 45, aciertos: 26, rMedio: 0.21, wilsonInferior: 0.43, evidencia: 'DEBIL' },
    descartes: [],
    ...extra,
  };
}

/**
 * La salida de una ronda con dos pares: BTC con una tendencia larga y ETH con
 * una ruptura corta —peor histórico, así que va segunda en la oferta—, y un
 * tercer par ocupado.
 */
export function salidaDePrueba(extra: Partial<SalidaAgente> = {}): SalidaAgente {
  const btc = candidatoDePrueba();
  const eth = candidatoDePrueba({
    simbolo: 'ETH',
    familia: 'RUPTURA',
    lado: 'SHORT',
    entradaReferencia: '3000',
    entradaTope: '2999.4',
    extremo: '3040',
    nivel: '3010',
    tp1: '2930',
    tp2: '2870',
    tasas: { n: 12, aciertos: 5, rMedio: -0.1, wilsonInferior: 0.2, evidencia: 'INSUFICIENTE' },
  });
  return {
    version: 1,
    barT: BAR_T,
    generadaEn: BAR_T + 3_615_000,
    intervalo: '1h',
    pares: [
      { simbolo: 'BTC', mercado: mercadoDePrueba(), candidatos: [btc], descartes: [] },
      {
        simbolo: 'ETH',
        mercado: mercadoDePrueba({
          regimen: 'COMPRESION',
          sentido: null,
          precio: '3000',
          atr: '25',
        }),
        candidatos: [eth],
        descartes: [],
      },
      { simbolo: 'SOL', mercado: null, candidatos: [], descartes: ['OCUPADO'] },
    ],
    uso: {
      perdidaHoyPct: 0,
      riesgoAbiertoPct: 0.5,
      topeDiarioPct: 2,
      operacionesHoy: 1,
      topeOperaciones: 4,
      vivas: 1,
      topeVivas: 2,
      rachaPerdidas: 0,
    },
    huella: `${BAR_T}|BTC|TENDENCIA|LONG|${BAR_T},ETH|RUPTURA|SHORT|${BAR_T}`,
    ...extra,
  };
}

/**
 * Lo que comparten los tests de los agentes (spec 074). Termina en
 * `-spec.ts` para que no entre en el build, como `oferta.fixture-spec.ts`.
 */

/** Un plan que el lector de shared da por bueno: un largo de BTC con dos objetivos. */
export function planDePrueba(extra: Partial<PlanAgente> = {}): PlanAgente {
  return {
    version: 1,
    simbolo: 'BTC',
    familia: 'TENDENCIA',
    lado: 'LONG',
    intervalo: '1h',
    eleccion: {
      candidatoId: 'BTC|TENDENCIA|LONG|1',
      stop: 'NORMAL',
      objetivo: 'ESCALONADO',
      apalancamiento: 'BAJA',
      tamano: 'COMPLETO',
      confianza: 'ALTA',
    },
    entradaReferencia: '100',
    entradaTope: '100.1',
    extremo: '95',
    nivelIdea: null,
    stop: '97',
    tp1: '105',
    tp2: '110',
    objetivos: [
      { precio: '105', cantidad: '0.5' },
      { precio: '110', cantidad: '0.5' },
    ],
    cantidad: '1',
    apalancamiento: 3,
    nocional: '100.1',
    margen: '33.37',
    riesgo: '5',
    riesgoPctCapital: 0.5,
    rNeto: 1.6,
    liquidacionEstimada: '70',
    distanciaStop: 0.03,
    barT: 1_727_000_000_000,
    huella: 'h',
    entradaHasta: 1_727_000_300_000,
    maxMinutos: 1440,
    breakevenTrasTp1: true,
    costes: { makerBps: 1.5, takerBps: 4.5, deslizamientoBps: 2 },
    ...extra,
  };
}

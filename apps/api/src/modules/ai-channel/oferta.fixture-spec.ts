import {
  BandaApalancamiento,
  EsquemaObjetivo,
  Evidencia,
  StrategyKind,
  TipoStop,
  Venue,
  type BotConfig,
  type CandidatoOperacion,
  type OpcionStop,
  type SalidaHerramienta,
} from '@crypton/shared';
import {
  DEFAULTS_CANAL,
  getStrategy,
  leerConfigCanal,
  type ConfigCanal,
} from '@crypton/strategy-core';

/**
 * Una herramienta del canal de prueba (spec 059), con valores absolutos que no
 * se pueden confundir con nada: si alguno aparece en el texto que ve el
 * modelo, es una fuga.
 *
 * Se llama `*-spec.ts` para que el build la deje fuera y jest no la tome por
 * un test.
 */

export const T_CANAL = 1_760_000_000_000;
export const BAR_T = 1_760_000_300_000;

/** Todo lo que el modelo no debe ver nunca. */
export const ABSOLUTOS = [
  '64321.987',
  '12.3456',
  '43.2109',
  '98.7654',
  '64111.111',
  '64555.555',
  '64333.333',
  '64123.45',
  '64125.67',
  '64098.76',
  '64333.33',
  '64488.88',
  '64080.12',
  '64060.34',
  '64010.99',
  '9876.54321',
  '0.15402',
  '12.3456789',
  '12.3399876',
  '80.1172',
  '1234.56',
  '617.28',
  '395.06',
  '61000.1',
  '62500.2',
  '63100.3',
  '4321.5',
  '7654.32109',
  '0.11977',
  '64799.01',
  '64600.11',
  '64650.22',
  '64700.33',
  '64400.44',
  '64200.55',
  'REB-L-',
  'FQ-S-',
  String(T_CANAL),
  String(BAR_T),
  'H1760',
  'huella-secreta',
];

export const CAPITAL = '4321.5';

const bandas = (margenes: [string, string, string], liqs: [string, string, string]) => [
  {
    banda: BandaApalancamiento.BAJA,
    apalancamiento: 8,
    margen: margenes[0],
    liquidacion: liqs[0],
    perdidaCatastrofica: margenes[0],
  },
  {
    banda: BandaApalancamiento.MEDIA,
    apalancamiento: 16,
    margen: margenes[1],
    liquidacion: liqs[1],
    perdidaCatastrofica: margenes[1],
  },
  {
    banda: BandaApalancamiento.ALTA,
    apalancamiento: 25,
    margen: margenes[2],
    liquidacion: liqs[2],
    perdidaCatastrofica: margenes[2],
  },
];

export const inviable = (tipo: TipoStop, precio: string, motivo: string): OpcionStop => ({
  tipo,
  precio,
  distancia: 0,
  viable: false,
  motivo,
  nocional: null,
  cantidad: null,
  riesgo: null,
  perdidaAlStop: null,
  perdidaPorUnidad: null,
  esquemasViables: [],
  bandas: [],
  apalancamientoMinimo: null,
  apalancamientoMaximo: null,
  rNetoTp1: null,
  rNetoTp2: null,
  costeR: null,
  aciertoEquilibrioTp1: null,
  aciertoEquilibrioTp2: null,
  riesgoPctCapital: null,
  medioViable: false,
});

export const viable = (
  tipo: TipoStop,
  precio: string,
  extra: Partial<OpcionStop> = {},
): OpcionStop => ({
  tipo,
  precio,
  distancia: 0.00071,
  viable: true,
  motivo: null,
  nocional: '9876.54321',
  cantidad: '0.15402',
  riesgo: '12.3456789',
  perdidaAlStop: '12.3399876',
  perdidaPorUnidad: '80.1172',
  esquemasViables: [EsquemaObjetivo.MEDIA, EsquemaObjetivo.ESCALONADO, EsquemaObjetivo.OPUESTO],
  bandas: bandas(['1234.56', '617.28', '395.06'], ['61000.1', '62500.2', '63100.3']),
  apalancamientoMinimo: 8,
  apalancamientoMaximo: 25,
  rNetoTp1: 1.87,
  rNetoTp2: 3.95,
  costeR: 0.21,
  aciertoEquilibrioTp1: 0.348,
  aciertoEquilibrioTp2: 0.202,
  riesgoPctCapital: 0.285,
  medioViable: true,
  ...extra,
});

/** El largo: un rebote listo con dos stops disponibles y el amplio fuera. */
export const largo = (extra: Partial<CandidatoOperacion> = {}): CandidatoOperacion => ({
  id: `REB-L-H${T_CANAL}`,
  setup: 'REBOTE',
  lado: 'LONG',
  estado: 'LISTO',
  confirmaciones: ['MECHA', 'RSI'],
  canalId: `H${T_CANAL}`,
  entradaReferencia: '64123.45',
  entradaTope: '64125.67',
  extremo: '64098.76',
  tp1: '64333.33',
  tp2: '64488.88',
  stops: [
    viable(TipoStop.AJUSTADO, '64080.12'),
    viable(TipoStop.NORMAL, '64060.34', {
      esquemasViables: [EsquemaObjetivo.MEDIA, EsquemaObjetivo.ESCALONADO],
    }),
    inviable(TipoStop.AMPLIO, '64010.99', 'STOP_ANCHO'),
  ],
  tasas: { n: 34, aciertos: 21, rMedio: 0.31, wilsonInferior: 0.452, evidencia: Evidencia.DEBIL },
  descartes: [],
  ...extra,
});

/** El corto: una ruptura fallida con solo el stop normal, que no admite medio tamaño. */
export const corto = (extra: Partial<CandidatoOperacion> = {}): CandidatoOperacion => ({
  id: `FQ-S-H${T_CANAL}`,
  setup: 'FALSO_QUIEBRE',
  lado: 'SHORT',
  estado: 'LISTO',
  confirmaciones: [],
  canalId: `H${T_CANAL}`,
  entradaReferencia: '64600.11',
  entradaTope: '64650.22',
  extremo: '64700.33',
  tp1: '64400.44',
  tp2: '64200.55',
  stops: [
    inviable(TipoStop.AJUSTADO, '64700.33', 'RR'),
    viable(TipoStop.NORMAL, '64799.01', {
      nocional: '7654.32109',
      cantidad: '0.11977',
      medioViable: false,
      esquemasViables: [EsquemaObjetivo.OPUESTO],
    }),
    inviable(TipoStop.AMPLIO, '64010.99', 'MINIMO'),
  ],
  tasas: null,
  descartes: [],
  ...extra,
});

/** Uno que no se puede ofrecer: le faltan confirmaciones. */
export const vigilando = (): CandidatoOperacion =>
  largo({ id: 'REB-L-H1759999000000', estado: 'VIGILANDO', descartes: ['CONFIRMACIONES'] });

export function salidaDePrueba(extra: Partial<SalidaHerramienta> = {}): SalidaHerramienta {
  return {
    version: 1,
    barT: BAR_T,
    generadaEn: BAR_T + 4000,
    mercado: {
      regimen: 'RANGO',
      sentido: null,
      adx1h: 17.23,
      chop1h: 61.4,
      chop15m: 58.2,
      percentilEficiencia: 22,
      percentilAncho: 45,
      ratioAtr: 1.03,
      atr5m: '12.3456',
      atr15m: '43.2109',
      atr1h: '98.7654',
      precio: '64321.987',
      spreadBps: 1.2,
      fundingBps: 0.4,
      frescas: true,
    },
    canal: {
      id: `H${T_CANAL}`,
      tipo: 'HORIZONTAL',
      calidad: 'B',
      puntuacion: 68,
      soporte: '64111.111',
      resistencia: '64555.555',
      media: '64333.333',
      pendientePorVela: 0,
      refT: T_CANAL,
      anchuraAtr: 5.6,
      toquesSoporte: 3,
      toquesResistencia: 2,
      contencion: 0.96,
      cruces: 5,
      mediaVidaVelas: 9,
      duracionVelas: 84,
      ultimoToqueHace: 1,
      r2: null,
    },
    candidatos: [largo(), corto(), vigilando()],
    uso: {
      perdidaHoyPct: 0.8,
      topeDiarioPct: 6,
      operacionesHoy: 1,
      topeOperaciones: 8,
      rachaPerdidas: 0,
    },
    huella: 'huella-secreta',
    ...extra,
  };
}

/** La configuración del bot con los valores por defecto, capital de prueba y cambios. */
export function configDePrueba(extra: Record<string, unknown> = {}): ConfigCanal {
  const bruta = {
    ...getStrategy(StrategyKind.AI_CHANNEL).defaults(),
    ...DEFAULTS_CANAL,
    totalInvestment: CAPITAL,
    allowedSetups: 'TODOS',
    ...extra,
  } as unknown as BotConfig;
  return leerConfigCanal(bruta, Venue.HYPERLIQUID);
}

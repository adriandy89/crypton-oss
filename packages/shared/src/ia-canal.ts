import type { PositionSide } from './enums';
// Import de SOLO TIPOS, y por eso el ciclo con `ia-trader.ts` es inocuo:
// TypeScript los borra al compilar y no queda dependencia en tiempo de
// ejecución. Las dos uniones de abajo viven aquí porque es aquí donde están
// `SolicitudIa` y `MarcaDecision`, que es lo que de verdad se amplía.
import type { EspacioTrader, PlanTrader, VeredictoTrader } from './ia-trader';

/**
 * El vocabulario del canal con IA (`AI_CHANNEL`, specs 058-059).
 *
 * El reparto de papeles que gobierna todo esto:
 * - un motor determinista (`strategy-core/src/canal`) detecta el rango o el
 *   canal y calcula TODOS los números de cada operación posible;
 * - la IA —o el juez de reglas— solo elige entre esas opciones, con
 *   enumeraciones;
 * - el worker vuelve a derivar la elección con datos frescos, la revalida y la
 *   ejecuta.
 *
 * Por eso aquí conviven dos clases de número:
 * - los precios, cantidades e importes viajan como `string` decimal y se operan
 *   con `Decimal` (invariante 1);
 * - las estadísticas adimensionales —R, porcentajes, puntuaciones, ADX— van
 *   como `number`, que es lo que son.
 */

// ── Enumeraciones ──────────────────────────────────────────────────────────

/** Régimen del mercado en 1 h, con la histéresis de `canal/regimen.ts`. */
export const RegimenMercado = {
  RANGO: 'RANGO',
  TENDENCIA: 'TENDENCIA',
  COMPRESION: 'COMPRESION',
  INDEFINIDO: 'INDEFINIDO',
} as const;
export type RegimenMercado = (typeof RegimenMercado)[keyof typeof RegimenMercado];

export const SentidoTendencia = { ALCISTA: 'ALCISTA', BAJISTA: 'BAJISTA' } as const;
export type SentidoTendencia = (typeof SentidoTendencia)[keyof typeof SentidoTendencia];

/**
 * Cómo se trazaron las dos líneas del canal.
 *
 * `HORIZONTAL` e `INCLINADO` salen de unir giros del precio: son niveles que el
 * mercado defendió de verdad. `BANDA` (spec 067) son las bandas de Bollinger,
 * que no son un nivel defendido sino una frontera estadística; de ahí que su
 * stop vaya más lejos y que no se le pidan las comprobaciones de pivotes.
 */
export const TipoCanal = {
  HORIZONTAL: 'HORIZONTAL',
  INCLINADO: 'INCLINADO',
  BANDA: 'BANDA',
} as const;
export type TipoCanal = (typeof TipoCanal)[keyof typeof TipoCanal];

export const CalidadCanal = { A: 'A', B: 'B', C: 'C' } as const;
export type CalidadCanal = (typeof CalidadCanal)[keyof typeof CalidadCanal];

export const TipoSetup = { REBOTE: 'REBOTE', FALSO_QUIEBRE: 'FALSO_QUIEBRE' } as const;
export type TipoSetup = (typeof TipoSetup)[keyof typeof TipoSetup];

/** Solo un setup `LISTO` es elegible; `VIGILANDO` se enseña y no se opera. */
export const EstadoSetup = { LISTO: 'LISTO', VIGILANDO: 'VIGILANDO' } as const;
export type EstadoSetup = (typeof EstadoSetup)[keyof typeof EstadoSetup];

export const Confirmacion = {
  MECHA: 'MECHA',
  RSI: 'RSI',
  DIVERGENCIA: 'DIVERGENCIA',
  VOLUMEN: 'VOLUMEN',
} as const;
export type Confirmacion = (typeof Confirmacion)[keyof typeof Confirmacion];

/** A 0,25, 0,5 y 1 ATR(15m) más allá del extremo, más medio spread. */
export const TipoStop = { AJUSTADO: 'AJUSTADO', NORMAL: 'NORMAL', AMPLIO: 'AMPLIO' } as const;
export type TipoStop = (typeof TipoStop)[keyof typeof TipoStop];

/**
 * Dónde se sale con beneficio.
 * - `MEDIA`: todo en la línea media.
 * - `OPUESTO`: todo cerca del borde opuesto.
 * - `ESCALONADO`: una parte en cada uno.
 */
export const EsquemaObjetivo = {
  MEDIA: 'MEDIA',
  ESCALONADO: 'ESCALONADO',
  OPUESTO: 'OPUESTO',
} as const;
export type EsquemaObjetivo = (typeof EsquemaObjetivo)[keyof typeof EsquemaObjetivo];

/**
 * El apalancamiento, como banda y no como número.
 *
 * La banda NO cambia lo que se pierde en el stop. Cambia el margen
 * inmovilizado, la distancia a la liquidación y la pérdida en un hueco, y las
 * tres quedan dentro de los topes por construcción.
 */
export const BandaApalancamiento = { BAJA: 'BAJA', MEDIA: 'MEDIA', ALTA: 'ALTA' } as const;
export type BandaApalancamiento = (typeof BandaApalancamiento)[keyof typeof BandaApalancamiento];

/** La confianza solo puede REDUCIR el tamaño: nunca hay una opción mayor. */
export const TamanoOperacion = { COMPLETO: 'COMPLETO', MEDIO: 'MEDIO' } as const;
export type TamanoOperacion = (typeof TamanoOperacion)[keyof typeof TamanoOperacion];

/** Cuánto dice el histórico: `INSUFICIENTE` < 20 casos, `DEBIL` ≤ 60, `MODERADA` > 60. */
export const Evidencia = {
  INSUFICIENTE: 'INSUFICIENTE',
  DEBIL: 'DEBIL',
  MODERADA: 'MODERADA',
} as const;
export type Evidencia = (typeof Evidencia)[keyof typeof Evidencia];

export const ModoDecision = { IA: 'IA', REGLAS: 'REGLAS' } as const;
export type ModoDecision = (typeof ModoDecision)[keyof typeof ModoDecision];

/** El perfil ordena preferencias; nunca afloja un límite. */
export const PerfilCanal = {
  PRUDENTE: 'PRUDENTE',
  EQUILIBRADA: 'EQUILIBRADA',
  AGRESIVA: 'AGRESIVA',
} as const;
export type PerfilCanal = (typeof PerfilCanal)[keyof typeof PerfilCanal];

export const Veredicto = { OPERAR: 'OPERAR', NO_OPERAR: 'NO_OPERAR' } as const;
export type Veredicto = (typeof Veredicto)[keyof typeof Veredicto];

export const NivelConfianza = { BAJA: 'BAJA', MEDIA: 'MEDIA', ALTA: 'ALTA' } as const;
export type NivelConfianza = (typeof NivelConfianza)[keyof typeof NivelConfianza];

/**
 * Estado de una intención de operación (`bot_ai_intents`). Calca
 * `AiIntentState` de Prisma valor a valor.
 *
 * Camino feliz: `SOLICITADA → CONSULTANDO → DECIDIDA → ACEPTADA → ABIERTA →
 * CERRADA`. Terminales sin operación: `SIN_ENTRADA`, `FALLIDA`, `RECHAZADA` y
 * `CADUCADA`.
 */
export const EstadoIntencion = {
  SOLICITADA: 'SOLICITADA',
  CONSULTANDO: 'CONSULTANDO',
  DECIDIDA: 'DECIDIDA',
  SIN_ENTRADA: 'SIN_ENTRADA',
  FALLIDA: 'FALLIDA',
  ACEPTADA: 'ACEPTADA',
  ABIERTA: 'ABIERTA',
  CERRADA: 'CERRADA',
  RECHAZADA: 'RECHAZADA',
  CADUCADA: 'CADUCADA',
} as const;
export type EstadoIntencion = (typeof EstadoIntencion)[keyof typeof EstadoIntencion];

/** Los que ya no cambian. */
export const ESTADOS_TERMINALES: readonly EstadoIntencion[] = [
  EstadoIntencion.SIN_ENTRADA,
  EstadoIntencion.FALLIDA,
  EstadoIntencion.CERRADA,
  EstadoIntencion.RECHAZADA,
  EstadoIntencion.CADUCADA,
];

export const OrigenDecision = { IA: 'IA', REGLAS: 'REGLAS' } as const;
export type OrigenDecision = (typeof OrigenDecision)[keyof typeof OrigenDecision];

/** Por qué no se ejecutó una decisión. Va a `bot_ai_intents.motivo`. */
export const MotivoRechazo = {
  /** El venue no aceptó el apalancamiento o la entrada. */
  VENUE: 'VENUE',
  /** Con datos frescos ya no cabe en los límites. */
  LIMITES: 'LIMITES',
  /** La vela o el candidato ya no son los de la decisión. */
  HUELLA: 'HUELLA',
  /** Se le pasó el plazo. */
  PLAZO: 'PLAZO',
  /** La elección no está en la oferta o no estaba disponible. */
  OFERTA: 'OFERTA',
  /** Una puerta del plan (régimen, horario, tope diario…) se cerró antes. */
  PUERTA: 'PUERTA',
  /** Un comando, una recarga, una pausa o un llenado la dejaron sin sentido. */
  ESTADO: 'ESTADO',
} as const;
export type MotivoRechazo = (typeof MotivoRechazo)[keyof typeof MotivoRechazo];

/**
 * Por qué la API cerró una solicitud sin una decisión que ejecutar (spec 059).
 *
 * Va a `bot_ai_intents.motivo`, como `MotivoRechazo` cuando la descarta el
 * worker. Las dos listas comparten `OFERTA` y `PLAZO`, con el mismo sentido.
 */
export const MotivoConsulta = {
  /** La IA del canal está apagada en el servidor, o falta la clave del modelo. */
  IA_APAGADA: 'IA_APAGADA',
  /** El dueño ya no es un administrador habilitado. */
  DUENO: 'DUENO',
  /** El bot no está en marcha, o ya no es de esta estrategia. */
  ESTADO_BOT: 'ESTADO_BOT',
  /** Demasiados fallos seguidos del modelo: las consultas duermen unas horas. */
  PAUSA_FALLOS: 'PAUSA_FALLOS',
  /** El interruptor global de entradas está cerrado. */
  INTERRUPTOR: 'INTERRUPTOR',
  /** Sin Redis no se leen el interruptor ni los cupos, y sin ellos no se llama. */
  REDIS: 'REDIS',
  /** El bot ha gastado sus llamadas del día. */
  CUPO_BOT: 'CUPO_BOT',
  /** La plataforma ha gastado sus llamadas del día. */
  CUPO_GLOBAL: 'CUPO_GLOBAL',
  /** El modelo prefirió no operar. */
  NO_OPERAR: 'NO_OPERAR',
  /** Lo elegido no estaba en la oferta, o no estaba disponible. */
  OFERTA: 'OFERTA',
  /** Menos confianza de la que pide el bot. */
  CONFIANZA: 'CONFIANZA',
  /**
   * El enrutado dice que sí pero una puerta de contexto lo veta (spec 069).
   *
   * Es propio del «Bot de IA»: sus tres preguntas de contexto se hacen en
   * aislamiento justamente para poder discrepar del enrutado. No es un fallo
   * —es la estadística de calibración que dice si las preguntas sirven de algo—
   * y por eso tiene su propia línea en vez de contarse como «oferta».
   */
  DESACUERDO: 'DESACUERDO',
  /** Modo sombra: la decisión se registra y no se ejecuta. */
  SOMBRA: 'SOMBRA',
  /** El modelo no contestó: error, tiempo agotado, negativa o respuesta cortada. */
  MODELO: 'MODELO',
  /** El modelo contestó algo que no cumple el contrato. */
  CONTRATO: 'CONTRATO',
  /** No quedaba tiempo para consultar, o la decisión llegó tarde. */
  PLAZO: 'PLAZO',
} as const;
export type MotivoConsulta = (typeof MotivoConsulta)[keyof typeof MotivoConsulta];

/**
 * Por qué decide el modelo lo que decide (spec 059). Una lista cerrada y no un
 * texto: se puede contar, pintar y comparar, y no trae cifras inventadas.
 */
export const MotivoCanal = {
  CANAL_CLARO: 'CANAL_CLARO',
  CANAL_JUSTO: 'CANAL_JUSTO',
  REGIMEN_RANGO: 'REGIMEN_RANGO',
  REGIMEN_DUDOSO: 'REGIMEN_DUDOSO',
  CONFIRMACIONES_FUERTES: 'CONFIRMACIONES_FUERTES',
  CONFIRMACIONES_JUSTAS: 'CONFIRMACIONES_JUSTAS',
  EVIDENCIA_FAVORABLE: 'EVIDENCIA_FAVORABLE',
  EVIDENCIA_ESCASA: 'EVIDENCIA_ESCASA',
  EVIDENCIA_DESFAVORABLE: 'EVIDENCIA_DESFAVORABLE',
  RECOMPENSA_BUENA: 'RECOMPENSA_BUENA',
  RECOMPENSA_POBRE: 'RECOMPENSA_POBRE',
  COSTE_ALTO: 'COSTE_ALTO',
  DIA_TENSO: 'DIA_TENSO',
  NINGUNO: 'NINGUNO',
} as const;
export type MotivoCanal = (typeof MotivoCanal)[keyof typeof MotivoCanal];

/** Lo que al modelo le preocupa de la operación. Cerrado, como los motivos. */
export const RiesgoCanal = {
  RUPTURA: 'RUPTURA',
  TENDENCIA_CERCANA: 'TENDENCIA_CERCANA',
  LIQUIDEZ: 'LIQUIDEZ',
  VOLATILIDAD: 'VOLATILIDAD',
  RACHA: 'RACHA',
  TOPE_DIARIO_CERCA: 'TOPE_DIARIO_CERCA',
  FUNDING: 'FUNDING',
  NINGUNO: 'NINGUNO',
} as const;
export type RiesgoCanal = (typeof RiesgoCanal)[keyof typeof RiesgoCanal];

/**
 * Los eventos propios del canal con IA (specs 058-059), en `bot_events.type`.
 *
 * En estos bots `AI_EXIT` sustituye a `CYCLE_CLOSED`: lleva lo mismo y además
 * el R y el motivo, y dos avisos por la misma salida serían ruido.
 */
export const EventoCanal = {
  /** La API respondió a una solicitud. Solo va a la línea de tiempo. */
  DECISION: 'AI_DECISION',
  /** La entrada se llenó: la operación está abierta. */
  ENTRADA: 'AI_ENTRY',
  /** La operación terminó, con su resultado. */
  SALIDA: 'AI_EXIT',
  /** La estrategia ordena cerrar a mercado: tiempo, invalidación, régimen… */
  CIERRE: 'AI_CIERRE',
  ENTRADA_DESCARTADA: 'AI_ENTRY_DISCARDED',
  TOPE_DIARIO: 'AI_DAY_STOP',
  BREAKEVEN: 'AI_BREAKEVEN',
  CIERRE_FALLIDO: 'AI_CIERRE_FALLIDO',
  POSICION_HUERFANA: 'AI_POSICION_HUERFANA',
  /** La operación se cerró fuera del bot y su ejecución no la vio nadie. */
  OPERACION_PERDIDA: 'AI_OPERACION_PERDIDA',
  SIN_STOP: 'SIN_STOP',
} as const;
export type EventoCanal = (typeof EventoCanal)[keyof typeof EventoCanal];

/**
 * Los eventos del Modo IA (spec 046). La app recarga su estado con ellos, y
 * solo con ellos: con todo el prefijo `AI_`, cada evento del canal con IA
 * provocaba recargas del Modo IA que no le tocaban.
 */
export const EVENTOS_MODO_IA: readonly string[] = [
  'AI_MODE',
  'AI_SUGGESTION',
  'AI_APPLIED',
  'AI_ADVICE',
  'AI_FAILED',
  'AI_DECISION_TAKEN',
];

export const esEventoModoIa = (tipo: string): boolean => EVENTOS_MODO_IA.includes(tipo);

// ── El botón de pausa de los avisos ────────────────────────────────────────

/**
 * `ic:<vale>:pausa`. El vale es opaco, como los del Modo IA: en
 * `callback_data` caben 64 bytes, y quien lo intercepte no debe poder deducir
 * de qué bot es.
 */
export const PREFIJO_BOTON_CANAL = 'ic';
export const ACCION_PAUSAR_CANAL = 'pausa';
/** El mensaje del bus con la pulsación, del poller a la API. */
export const PULSACION_PAUSA_CANAL = 'AI_CHANNEL_PAUSE';
/** Lo que dura un vale: el aviso se lee tarde, pero no días después. */
export const VIDA_VALE_CANAL_S = 24 * 3600;

/** Lo que guarda el vale: quién puede usarlo y sobre qué bot. */
export interface ValeCanal {
  userId: string;
  botId: string;
}

/** La clave de Redis del vale. Se canjea con `GETDEL`: una pulsación, una pausa. */
export const claveValeCanal = (vale: string): string => `ic:vale:${vale}`;

/** Un vale bien formado: 32 hexadecimales, un `randomUUID` sin guiones. */
export const esValeCanal = (v: unknown): v is string =>
  typeof v === 'string' && /^[0-9a-f]{32}$/.test(v);

// ── Lo que el motor le pasa a la estrategia ───────────────────────────────

/**
 * Un tramo de apalancamiento del venue para el par.
 *
 * `desdeNocional` es el nocional (en la quote) a partir del cual rige el tramo:
 * cuanto mayor la posición, menos apalancamiento y más mantenimiento.
 */
export interface NivelApalancamiento {
  desdeNocional: string;
  maxApalancamiento: number;
  /** Tasa de mantenimiento del tramo, en tanto por uno. */
  mantenimiento: number;
}

/**
 * Lo operado por el bot, con el día contado en UTC.
 *
 * Sale del libro de ciclos (`bot_cycles`): cada ciclo cerrado es una operación.
 */
export interface HistorialOperaciones {
  /** 00:00 UTC del día en curso, en ms. */
  dia: number;
  operacionesHoy: number;
  /** Resultado realizado del día, con comisiones, en la quote. */
  realizadoHoy: string;
  /** Pérdidas seguidas hasta la última operación cerrada, sin cortar por días. */
  rachaPerdidas: number;
  ultimoCierreEn: number | null;
  /** El último cierre con pérdida. De él cuenta la espera tras una racha. */
  ultimaPerdidaEn: number | null;
  /** El último cierre por el stop. De él cuenta `stopCooldownMinutes`. */
  ultimoStopEn: number | null;
  /** Resultado realizado acumulado del bot y su máximo histórico. */
  realizadoTotal: string;
  picoRealizado: string;
}

/**
 * El interruptor global de entradas del canal con IA, en Redis.
 *
 * `off` cierra las entradas de todos los bots del canal; sin la clave, quedan
 * abiertas. Con Redis caído, cerradas. Lo lee el worker en cada tick y lo
 * escribe la consola de administración (spec 059).
 */
export const CLAVE_INTERRUPTOR_CANAL = 'crypton:ai-channel:entries';

/**
 * ¿Cierra las entradas lo que hay en la clave del interruptor? Solo `off`, con
 * o sin comillas —la consola lo escribe como JSON y a mano se escribe tal
 * cual— y sin distinguir mayúsculas. Cualquier otra cosa, o nada, las deja
 * abiertas. Lo leen igual el worker y la API (spec 059).
 */
export function interruptorCerrado(texto: string | null): boolean {
  const valor = (texto ?? '')
    .trim()
    .replace(/^"(.*)"$/, '$1')
    .toLowerCase();
  return valor === 'off';
}

/** Lo que llega de fuera de la configuración y puede cerrar las entradas. */
export interface LimitesExternos {
  /** Interruptor global: `false` también con Redis caído. */
  entradasPermitidas: boolean;
  /** Tope de apalancamiento de la cuenta (`risk_limits.max_leverage`). */
  maxApalancamientoUsuario: number | null;
  /** Aster: tramos firmados leídos y cuenta unidireccional. */
  venueListo: boolean;
  /** Por qué está cerrado, si lo está. */
  motivo: string | null;
}

// ── Lo que calcula el motor ───────────────────────────────────────────────

export interface ContextoMercado {
  regimen: RegimenMercado;
  sentido: SentidoTendencia | null;
  adx1h: number;
  chop1h: number;
  chop15m: number;
  percentilEficiencia: number;
  percentilAncho: number;
  ratioAtr: number;
  /** ATR en unidades de precio. */
  atr5m: string;
  atr15m: string;
  atr1h: string;
  precio: string;
  spreadBps: number;
  /** Funding por periodo en puntos básicos, con signo; null si el venue no lo da. */
  fundingBps: number | null;
  /** false = falta la última vela esperada de alguna serie. */
  frescas: boolean;
}

export interface CanalDetectado {
  /** Estable dentro del canal: tipo y hora del primer toque. */
  id: string;
  tipo: TipoCanal;
  calidad: CalidadCanal;
  puntuacion: number;
  /** Niveles EN LA ÚLTIMA vela de 15 min; en un inclinado se mueven con el tiempo. */
  soporte: string;
  resistencia: string;
  media: string;
  /** Desplazamiento por vela de 15 min, en unidades de precio (0 si es horizontal). */
  pendientePorVela: number;
  /** Apertura de la vela de 15 min a la que se refieren los niveles. */
  refT: number;
  anchuraAtr: number;
  toquesSoporte: number;
  toquesResistencia: number;
  /** Fracción de cierres dentro, de 0 a 1. */
  contencion: number;
  cruces: number;
  mediaVidaVelas: number | null;
  duracionVelas: number;
  ultimoToqueHace: number;
  r2: number | null;
}

export interface ResumenTasas {
  n: number;
  aciertos: number;
  rMedio: number;
  /** Límite inferior de Wilson al 95 % del acierto. */
  wilsonInferior: number;
  evidencia: Evidencia;
}

export interface TasasBase extends ResumenTasas {
  /**
   * Las mismas tasas, pero solo de los toques con un **estiramiento parecido**
   * al de ahora (spec 070).
   *
   * Existe por una medición incómoda: sobre 498 decisiones reales, el rasgo que
   * mejor predecía el resultado era el estiramiento —y en dirección
   * contraintuitiva, cuanto más estirado peor—, y el modelo lo ignoraba por
   * completo. Decírselo seria meterle nuestro prior; darle la evidencia
   * condicionada le deja descubrirlo a él, que es lo que corresponde.
   *
   * `null` cuando no hay muestra suficiente: una tasa de cuatro casos no es una
   * tasa, es una anécdota con decimales.
   */
  similares: ResumenTasas | null;
  /** El estiramiento con el que se filtraron, en ATR. */
  estiramientoRef: number;
}

/** Una banda de apalancamiento con lo que supone. */
export interface BandaCalculada {
  banda: BandaApalancamiento;
  apalancamiento: number;
  margen: string;
  liquidacion: string | null;
  /** Lo que se pierde si el precio salta más allá de la liquidación: el margen. */
  perdidaCatastrofica: string;
}

export interface OpcionStop {
  tipo: TipoStop;
  precio: string;
  /** Distancia a la entrada tope, en tanto por uno. */
  distancia: number;
  viable: boolean;
  motivo: string | null;
  /** Los números solo existen si la opción es viable. */
  nocional: string | null;
  cantidad: string | null;
  riesgo: string | null;
  /** La pérdida al stop con comisiones y deslizamiento. */
  perdidaAlStop: string | null;
  /** La misma pérdida por unidad de moneda: la base para recalcular con otra cantidad. */
  perdidaPorUnidad: string | null;
  /** Los esquemas de objetivo cuyo objetivo más corto paga el mínimo de R. */
  esquemasViables: EsquemaObjetivo[];
  bandas: BandaCalculada[];
  apalancamientoMinimo: number | null;
  apalancamientoMaximo: number | null;
  rNetoTp1: number | null;
  rNetoTp2: number | null;
  costeR: number | null;
  aciertoEquilibrioTp1: number | null;
  aciertoEquilibrioTp2: number | null;
  /** La pérdida al stop sobre el capital, en %. */
  riesgoPctCapital: number | null;
  /**
   * Si la mitad del tamaño llega a los mínimos del venue (spec 059). La
   * confianza media reduce el tamaño a la mitad, y la oferta tiene que saber
   * si eso sigue siendo una operación.
   */
  medioViable: boolean;
}

export interface CandidatoOperacion {
  /** `REB-L-<canal>` · `FQ-S-<canal>`. Estable dentro del canal. */
  id: string;
  setup: TipoSetup;
  lado: PositionSide;
  estado: EstadoSetup;
  confirmaciones: Confirmacion[];
  canalId: string;
  /** El precio con el que se hizo el cálculo (ask o bid) y el tope de la IOC. */
  entradaReferencia: string;
  entradaTope: string;
  /** El extremo del toque, del que cuelgan los stops. */
  extremo: string;
  tp1: string;
  tp2: string;
  stops: OpcionStop[];
  tasas: ResumenTasas | null;
  /** Por qué no es elegible, si no lo es. */
  descartes: string[];
}

/** Uso del día frente a sus topes, para la herramienta y la nota. */
export interface UsoDelDia {
  perdidaHoyPct: number;
  topeDiarioPct: number;
  operacionesHoy: number;
  topeOperaciones: number;
  rachaPerdidas: number;
}

/** La salida de la herramienta: todo lo que la IA o el juez pueden mirar. */
export interface SalidaHerramienta {
  version: 1;
  /** Apertura de la última vela cerrada de 5 min en la que se basa. */
  barT: number;
  generadaEn: number;
  mercado: ContextoMercado;
  canal: CanalDetectado | null;
  candidatos: CandidatoOperacion[];
  uso: UsoDelDia;
  /** Identifica la oferta: la misma vela, el mismo canal y los mismos candidatos. */
  huella: string;
}

// ── La decisión y su ejecución ─────────────────────────────────────────────

/** Lo que eligen la IA o el juez. Solo enumeraciones. */
export interface EleccionOperacion {
  veredicto: Veredicto;
  /** Id de un candidato de la oferta, o `NINGUNA`. */
  opcion: string;
  stop: TipoStop;
  objetivo: EsquemaObjetivo;
  apalancamiento: BandaApalancamiento;
  tamano: TamanoOperacion;
  confianza: NivelConfianza;
}

/** Lo que devolvió el modelo, ya validado contra el contrato (spec 059). */
export interface RespuestaModeloCanal {
  veredicto: Veredicto;
  /** La etiqueta de la oferta (`A`, `B`…) o `NINGUNA`: el modelo no ve ids. */
  opcion: string;
  stop: TipoStop;
  objetivo: EsquemaObjetivo;
  apalancamiento: BandaApalancamiento;
  tamano: TamanoOperacion;
  confianza: NivelConfianza;
  /** Sin `NINGUNO` ni repetidos. */
  motivos: MotivoCanal[];
  riesgos: RiesgoCanal[];
  /** Una frase del modelo, sin cifras y de 200 caracteres como mucho. Texto ajeno. */
  texto: string;
}

/**
 * Lo que la API guarda en `bot_ai_intents.decision` (spec 059).
 *
 * Arriba va la elección EFECTIVA, que es la que ejecuta el worker: con el id
 * del candidato y el tamaño ya reducido por la confianza. El worker solo lee
 * esos campos. Dentro va lo que dijo el modelo, para poder explicarlo.
 */
export interface DecisionGuardada extends EleccionOperacion {
  respuesta: RespuestaModeloCanal;
}

/**
 * La elección que se ejecuta: la confianza solo puede REDUCIR el tamaño.
 *
 * Por debajo de `ALTA`, la mitad. La aplican la API al decidir y la estrategia
 * al usar la decisión, que es la segunda línea de defensa.
 */
export function eleccionEfectiva(e: EleccionOperacion): EleccionOperacion {
  return e.confianza === NivelConfianza.ALTA || e.tamano === TamanoOperacion.MEDIO
    ? e
    : { ...e, tamano: TamanoOperacion.MEDIO };
}

/**
 * Lo que eligió quien decide, sea cual sea la estrategia.
 *
 * El canal elige un candidato con sus parámetros; el «Bot de IA» emite un
 * veredicto sobre un único montaje (spec 069). Las dos formas viven en la misma
 * columna, así que quien las lee tiene que estrecharlas.
 */
export type EleccionDecision = EleccionOperacion | VeredictoTrader;

/**
 * ¿La elección es la del canal?
 *
 * Generoso hacia el canal a propósito, por el mismo incidente que `esPlanCanal`:
 * las dos formas comparten `stop`, `objetivo`, `tamano` y `confianza`, y leer
 * una del canal como si fuera del «Bot de IA» revienta al buscarle una `accion`
 * que no tiene. Se mira por las claves, nunca por el nombre de la estrategia:
 * así una intención viva de un bot al que le cambiaron la estrategia no se lee
 * de una forma por otra.
 */
export const esEleccionCanal = (e: EleccionDecision): e is EleccionOperacion =>
  typeof e === 'object' &&
  e !== null &&
  ('opcion' in e || 'apalancamiento' in e || 'veredicto' in e);

/** La intención vigente del bot, tal y como la ve la estrategia. */
export interface DecisionIa {
  intentId: string;
  estado: EstadoIntencion;
  origen: OrigenDecision;
  barT: number;
  huella: string;
  eleccion: EleccionDecision | null;
  motivo: string | null;
  expiresAt: number;
  cycleSeq: number;
}

/** Lo que el worker escribe como `SOLICITADA` y la API consulta (059). */
/**
 * Lo que una estrategia le ofrece a quien decide.
 *
 * Cada una tiene su forma: el canal ofrece candidatos con opciones, el «Bot de
 * IA» ofrece una matriz de nueve celdas (spec 068). El lazo de intenciones no
 * mira dentro — lo guarda como JSON y se lo devuelve a su estrategia—, así que
 * la unión es aquí y no hay que tocarlo a él para añadir la siguiente.
 */
export type OfertaDecision = SalidaHerramienta | EspacioTrader;

/** El plan que sale de una decisión. También uno por estrategia. */
export type PlanDecision = PlanOperacion | PlanTrader;

/**
 * ¿La oferta es la del canal?
 *
 * Las dos estrategias guardan la suya en la misma columna, así que quien la
 * lee tiene que estrecharla. Se distingue por una clave que solo tiene una de
 * las dos, no por el nombre de la estrategia: así un cambio de estrategia con
 * una intención viva no lee una forma por otra.
 */
export const esOfertaCanal = (o: OfertaDecision): o is SalidaHerramienta =>
  typeof o === 'object' && o !== null && 'candidatos' in o;

/**
 * Ídem para el plan.
 *
 * Mira **las dos** claves que solo tiene el canal, no una. Con una sola, un
 * plan del canal al que le faltara justo esa se leía como del «Bot de IA» y
 * reventaba al buscarle un veredicto que no tiene. Es barato ser generoso aquí.
 */
export const esPlanCanal = (p: PlanDecision): p is PlanOperacion =>
  typeof p === 'object' && p !== null && ('eleccion' in p || 'setup' in p);

/**
 * El identificador de lo elegido, sea cual sea la estrategia.
 *
 * El lazo de intenciones lo guarda en `bot_ai_intents.candidato_id` para poder
 * comparar decisiones entre modelos sin tener que saber de qué estrategia son.
 * El canal tiene candidatos con id; el «Bot de IA» tiene una celda de su
 * matriz, que se nombra por sus dos enumeraciones.
 */
export const candidatoDe = (p: PlanDecision): string =>
  esPlanCanal(p) ? p.candidatoId : `${p.veredicto.stop}|${p.veredicto.objetivo}`;

/** Lo que se guarda como «decisión»: la elección del canal o el veredicto. */
export const decisionDe = (p: PlanDecision): unknown => (esPlanCanal(p) ? p.eleccion : p.veredicto);

export interface SolicitudIa {
  barT: number;
  huella: string;
  expiresAt: number;
  snapshot: OfertaDecision;
}

/** Un objetivo de beneficio de la operación. */
export interface ObjetivoPlan {
  precio: string;
  cantidad: string;
}

/**
 * La operación con sus números, ya derivada de la elección. Es lo que se guarda
 * en `cycle.scratch.op` ANTES de mandar la entrada, y de lo que salen el stop,
 * los objetivos y las salidas aunque falten las velas.
 */
export interface PlanOperacion {
  intentId: string;
  candidatoId: string;
  setup: TipoSetup;
  lado: PositionSide;
  eleccion: EleccionOperacion;
  entradaReferencia: string;
  entradaTope: string;
  stop: string;
  objetivos: ObjetivoPlan[];
  cantidad: string;
  apalancamiento: number;
  nocional: string;
  riesgo: string;
  rNeto: number;
  liquidacionEstimada: string | null;
  huella: string;
  barT: number;
  /** El canal en el momento de entrar, para la invalidación. */
  canal: {
    tipo: TipoCanal;
    soporte: string;
    resistencia: string;
    media: string;
    pendientePorVela: number;
    refT: number;
    /** El primer toque, para dibujarlo (spec 059). Opcional: los planes del 058 no lo traen. */
    desde?: number;
  };
  /** La salida por tiempo: a partir de aquí se cierra a mercado. */
  venceEn: number;
  /** Distancia del stop en tanto por uno, para detectar un stop que no saltó. */
  distanciaStop: number;
}

/** Cómo marca la estrategia la intención que usa o descarta en este tick. */
export interface MarcaDecision {
  intentId: string;
  estado: typeof EstadoIntencion.ACEPTADA | typeof EstadoIntencion.RECHAZADA;
  motivo: MotivoRechazo | null;
  plan: PlanDecision | null;
}

/**
 * Un aviso que la estrategia quiere dar. El runner lo emite como evento una vez
 * por `clave`, así que una puerta cerrada tick tras tick avisa una vez.
 */
export interface AvisoEstrategia {
  clave: string;
  tipo: string;
  severidad: 'INFO' | 'WARN' | 'ERROR' | 'CRITICAL';
  mensaje: string;
}

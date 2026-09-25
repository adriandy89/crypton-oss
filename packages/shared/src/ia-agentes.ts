import { AiMode, type PositionSide } from './enums';
import {
  EsquemaObjetivo,
  ModoDecision,
  type BandaApalancamiento,
  type NivelConfianza,
  type ObjetivoPlan,
  type OpcionStop,
  type RegimenMercado,
  type SentidoTendencia,
  type TamanoOperacion,
  type TasasBase,
  type TipoStop,
} from './ia-canal';

/**
 * El vocabulario de los agentes de IA (spec 074).
 *
 * Un agente mira varios pares de una cuenta cada intervalo, propone operaciones
 * direccionales de una sola vez —entrada, stop nativo y uno o dos objetivos—,
 * las ejecuta como un bot `AGENT_TRADE` cuando se aprueban, les da seguimiento
 * mientras viven y mide todo lo que propone, lo tome o no.
 *
 * El reparto de papeles es el del canal con IA (specs 058-062), y es lo que
 * hace que se pueda confiar dinero real a esto:
 * - un motor determinista (`strategy-core/src/agentes`) calcula TODOS los
 *   números de cada operación posible, ya validados;
 * - la IA —o el juez de reglas— solo elige entre esas opciones, con
 *   enumeraciones (invariante 13);
 * - al aprobar se vuelve a calcular con el precio de ahora, y el bot nace por el
 *   camino de siempre (`validate`, `preview`, límites);
 * - las salidas nunca esperan al modelo: el stop y los objetivos son órdenes
 *   nativas del venue desde el primer momento.
 *
 * Los precios, cantidades e importes viajan como `string` decimal (invariante
 * 1); las estadísticas adimensionales —R, porcentajes, ADX— como `number`.
 */

// ── El agente ──────────────────────────────────────────────────────────────

/** Calca `AiDeskAgentState` de Prisma valor a valor. */
export const EstadoAgente = {
  ACTIVO: 'ACTIVO',
  /** No abre nada nuevo. El seguimiento de lo abierto sigue: solo reduce riesgo. */
  PAUSADO: 'PAUSADO',
  /** Retirado. Solo se archiva sin operaciones vivas, y no vuelve. */
  ARCHIVADO: 'ARCHIVADO',
} as const;
export type EstadoAgente = (typeof EstadoAgente)[keyof typeof EstadoAgente];

/** Por qué está en pausa un agente. Toda pausa la levanta una persona. */
export const MotivoPausaAgente = {
  /** Lo pausó su dueño. */
  MANUAL: 'MANUAL',
  /** Tocó su pérdida diaria. No se reanuda solo al día siguiente: lo decide su dueño. */
  PERDIDA_DIARIA: 'PERDIDA_DIARIA',
  /** El *kill switch* de su cuenta. */
  KILL_SWITCH: 'KILL_SWITCH',
  /** La cuenta dejó de servir: borrada, sin credencial o de otro dueño. */
  CUENTA: 'CUENTA',
} as const;
export type MotivoPausaAgente = (typeof MotivoPausaAgente)[keyof typeof MotivoPausaAgente];

/**
 * Los intervalos de un agente. Nunca un minuto: el spec 070 midió que con el
 * modelo en medio un ciclo de un minuto es aritméticamente imposible.
 */
export const INTERVALOS_AGENTE = ['15m', '30m', '1h', '4h'] as const;
export type IntervaloAgente = (typeof INTERVALOS_AGENTE)[number];

export const esIntervaloAgente = (v: unknown): v is IntervaloAgente =>
  typeof v === 'string' && (INTERVALOS_AGENTE as readonly string[]).includes(v);

/**
 * Las familias de operación que busca el motor, causales sobre la vela
 * cerrada (`strategy-core/src/agentes/familias.ts`):
 * - `TENDENCIA`: retroceso a la media en una tendencia con fuerza;
 * - `RUPTURA`: salida de un rango tras una compresión;
 * - `REVERSION`: toque de banda en un rango, con el RSI en un extremo.
 */
export const FamiliaAgente = {
  TENDENCIA: 'TENDENCIA',
  RUPTURA: 'RUPTURA',
  REVERSION: 'REVERSION',
} as const;
export type FamiliaAgente = (typeof FamiliaAgente)[keyof typeof FamiliaAgente];

export const FAMILIAS_AGENTE: readonly FamiliaAgente[] = [
  FamiliaAgente.TENDENCIA,
  FamiliaAgente.RUPTURA,
  FamiliaAgente.REVERSION,
];

/**
 * Los límites de un agente. Todos son del usuario y todos se validan juntos
 * (`strategy-core/src/agentes/limites.ts`, que tiene los valores de fábrica).
 *
 * Los porcentajes se cuentan sobre `capital`, que es lo que el usuario le
 * asigna al agente y no el saldo de la cuenta: así «0,5 % por operación» quiere
 * decir lo mismo el día que la cuenta ha ganado y el día que ha perdido.
 */
export interface LimitesAgente {
  /** La base de todos los porcentajes, en la quote. */
  capital: string;
  /** La pérdida al stop de una operación, con costes. */
  riesgoPct: string;
  /** La pérdida del día que pausa el agente, contando al stop lo que está abierto. */
  perdidaDiariaPct: string;
  maxVivas: number;
  maxOperacionesDia: number;
  apalancamientoMax: number;
  /** El margen aislado de una operación: lo que se pierde si salta la liquidación. */
  margenPct: string;
  /** La distancia máxima del stop a la entrada. */
  maxStopPct: string;
  /** Lo más que pueden llevarse comisiones y deslizamiento de 1R (spec 066). */
  maxCosteR: string;
  /** El primer objetivo, a tantas veces el coste de ida y vuelta como mínimo (spec 066). */
  minObjetivoCoste: number;
  /** Y a este porcentaje de la entrada como mínimo. */
  minObjetivoPct: string;
  /** Beneficio neto entre riesgo del objetivo que se use. */
  minRR: string;
  /** Tras un stop, minutos sin entrar en ESE par. */
  esperaStopMin: number;
  /** Pérdidas seguidas que cortan las entradas del agente… */
  maxPerdidasSeguidas: number;
  /** …durante estos minutos. */
  esperaRachaMin: number;
  /** Consultas al modelo al día. El servidor tiene su propio tope, y manda el menor. */
  consultasDia: number;
  /** Gasto en el modelo al día, en USD. */
  gastoDiaUsd: string;
  /** La parte de la posición que sale en el primer objetivo, en %. */
  fraccionTp1Pct: string;
  /** Tras el primer objetivo, el stop a la entrada más los costes. */
  breakevenTrasTp1: boolean;
  /** Pasadas estas velas del intervalo desde la entrada, se cierra a mercado. */
  maxVelasOperacion: number;
}

// ── La autonomía ───────────────────────────────────────────────────────────

/**
 * Las tres clases de acción, cada una con su autonomía (decisión del usuario
 * del 2026-09-24). Subir el riesgo o ensanchar un stop no es ninguna: no existe.
 */
export const ClaseAccion = {
  ENTRAR: 'ENTRAR',
  /** Ceñir el stop o reducir la posición. */
  REDUCIR: 'REDUCIR',
  CERRAR: 'CERRAR',
} as const;
export type ClaseAccion = (typeof ClaseAccion)[keyof typeof ClaseAccion];

/**
 * Qué hace el agente con cada clase, con el `AiMode` de siempre:
 * - `entrar`: `MANUAL` propone, `AUTO` ejecuta, `OFF` solo mide;
 * - `reducir` y `cerrar`: `MANUAL` propone, `AUTO` aplica, `OFF` nunca.
 */
export interface AutonomiaAgente {
  entrar: AiMode;
  reducir: AiMode;
  cerrar: AiMode;
}

/** De fábrica: entrar y cerrar los decide una persona; reducir el riesgo, no. */
export const AUTONOMIA_DE_FABRICA: Readonly<AutonomiaAgente> = {
  entrar: AiMode.MANUAL,
  reducir: AiMode.AUTO,
  cerrar: AiMode.MANUAL,
};

/** Lo que pasa de verdad con una acción, ya con los frenos del servidor. */
export const EfectoAccion = {
  /** Se ejecuta sin preguntar. */
  APLICA: 'APLICA',
  /** Se propone y espera a una persona. */
  PROPONE: 'PROPONE',
  /** Se registra y se mide, sin ofrecerse ni ejecutarse. */
  MIDE: 'MIDE',
  /** Ni se ofrece al modelo. */
  NUNCA: 'NUNCA',
} as const;
export type EfectoAccion = (typeof EfectoAccion)[keyof typeof EfectoAccion];

/**
 * Los frenos del servidor (`AI_DESK_FORCE_MANUAL`, `AI_DESK_DRY_RUN_ONLY` y
 * `AI_DESK_SHADOW_ONLY`). Se ofrecen apagados por decisión del usuario: son
 * para cortar algo raro sin redesplegar, no una segunda opinión sobre su
 * configuración.
 */
export interface FrenosAgentes {
  /** Todo lo automático pasa a propuesta. */
  forzarManual: boolean;
  /** Nada se ejecuta en una cuenta real. */
  soloSimulacion: boolean;
  /** Nada se ejecuta en ninguna cuenta: se registra y se mide. */
  soloSombra: boolean;
}

export const SIN_FRENOS: Readonly<FrenosAgentes> = {
  forzarManual: false,
  soloSimulacion: false,
  soloSombra: false,
};

/**
 * El efecto de una clase de acción. De lo más fuerte a lo más suave: la sombra
 * lo registra todo sin ejecutar nada; en real con «solo simulación» no se
 * entra y lo demás lo decide una persona; «forzar manual» convierte lo
 * automático en propuesta. Ningún freno convierte algo en automático.
 */
export function efectoDe(
  clase: ClaseAccion,
  autonomia: AutonomiaAgente,
  frenos: FrenosAgentes,
  cuentaReal: boolean,
): EfectoAccion {
  const modo =
    clase === ClaseAccion.ENTRAR
      ? autonomia.entrar
      : clase === ClaseAccion.REDUCIR
        ? autonomia.reducir
        : autonomia.cerrar;
  if (modo === AiMode.OFF) {
    return clase === ClaseAccion.ENTRAR ? EfectoAccion.MIDE : EfectoAccion.NUNCA;
  }
  if (frenos.soloSombra) return EfectoAccion.MIDE;
  if (frenos.soloSimulacion && cuentaReal) {
    return clase === ClaseAccion.ENTRAR ? EfectoAccion.MIDE : EfectoAccion.PROPONE;
  }
  if (frenos.forzarManual) return EfectoAccion.PROPONE;
  return modo === AiMode.AUTO ? EfectoAccion.APLICA : EfectoAccion.PROPONE;
}

// ── Lo que calcula el motor ───────────────────────────────────────────────

/** El mercado de un par en la vela de la ronda, en unidades que no delatan el par. */
export interface ContextoParAgente {
  regimen: RegimenMercado;
  sentido: SentidoTendencia | null;
  adx: number;
  rsi: number;
  /** El ATR del intervalo sobre el precio, en %. */
  atrPct: number;
  /** Percentil del ancho de Bollinger en la ventana, de 0 a 100: compresión cerca de 0. */
  percentilAncho: number;
  /** El cierre frente a la EMA20, en ATR y con signo. */
  distanciaMediaAtr: number;
  /** La pendiente de la EMA50, en ATR por vela y con signo. */
  pendienteMedia: number;
  spreadBps: number;
  /** Funding por periodo en puntos básicos, con signo; null si el venue no lo da. */
  fundingBps: number | null;
  precio: string;
  /** El ATR del intervalo, en unidades de precio. */
  atr: string;
  /** false = falta la última vela esperada. */
  frescas: boolean;
}

/**
 * Una operación posible, con todos sus números. Las opciones de stop son las
 * del canal (`OpcionStop`): la misma función las calcula, con las mismas tres
 * garantías de la cabecera de `canal/herramienta.ts`.
 */
export interface CandidatoAgente {
  /** `<símbolo>|<familia>|<lado>|<vela>`. Estable dentro de la vela. */
  id: string;
  simbolo: string;
  familia: FamiliaAgente;
  lado: PositionSide;
  /** El precio con el que se hizo el cálculo (ask o bid) y el tope de la IOC. */
  entradaReferencia: string;
  entradaTope: string;
  /** El extremo del que cuelgan los stops. */
  extremo: string;
  /** El nivel que sostiene la idea, si la familia tiene uno: el borde roto de una ruptura. */
  nivel: string | null;
  tp1: string;
  tp2: string;
  stops: OpcionStop[];
  tasas: TasasBase | null;
  /** Por qué no es elegible, si no lo es. */
  descartes: string[];
}

/** Lo que el motor vio en un par. */
export interface SalidaAgentePar {
  simbolo: string;
  mercado: ContextoParAgente | null;
  candidatos: CandidatoAgente[];
  /** Por qué el par entero no ofrece nada: ocupado, sin datos, en espera… */
  descartes: string[];
}

/** El uso del día frente a los límites. */
export interface UsoAgente {
  /** Lo realizado hoy, si se pierde, sobre el capital, en %. */
  perdidaHoyPct: number;
  /** Lo que perderían las operaciones vivas si saltaran sus stops, en %. */
  riesgoAbiertoPct: number;
  topeDiarioPct: number;
  operacionesHoy: number;
  topeOperaciones: number;
  vivas: number;
  topeVivas: number;
  rachaPerdidas: number;
}

/** La salida de la herramienta de una ronda: todo lo que la IA o el juez pueden mirar. */
export interface SalidaAgente {
  version: 1;
  /** Apertura de la última vela cerrada del intervalo. */
  barT: number;
  generadaEn: number;
  intervalo: IntervaloAgente;
  pares: SalidaAgentePar[];
  uso: UsoAgente;
  /** Identifica la oferta: la misma vela y los mismos candidatos elegibles. */
  huella: string;
}

// ── El contrato con el modelo ─────────────────────────────────────────────

/**
 * El objetivo, como lo ve el modelo. Por dentro es el esquema del canal: el
 * motor calcula los dos objetivos con la misma función y el modelo elige cuál
 * cobrar.
 */
export const ObjetivoAgente = {
  /** Todo en el primer objetivo. */
  CERCANO: 'CERCANO',
  /** Una parte en cada uno. */
  ESCALONADO: 'ESCALONADO',
  /** Todo en el segundo. */
  LEJANO: 'LEJANO',
} as const;
export type ObjetivoAgente = (typeof ObjetivoAgente)[keyof typeof ObjetivoAgente];

export const ESQUEMA_DE_OBJETIVO: Readonly<Record<ObjetivoAgente, EsquemaObjetivo>> = {
  [ObjetivoAgente.CERCANO]: EsquemaObjetivo.MEDIA,
  [ObjetivoAgente.ESCALONADO]: EsquemaObjetivo.ESCALONADO,
  [ObjetivoAgente.LEJANO]: EsquemaObjetivo.OPUESTO,
};

export const OBJETIVO_DE_ESQUEMA: Readonly<Record<EsquemaObjetivo, ObjetivoAgente>> = {
  [EsquemaObjetivo.MEDIA]: ObjetivoAgente.CERCANO,
  [EsquemaObjetivo.ESCALONADO]: ObjetivoAgente.ESCALONADO,
  [EsquemaObjetivo.OPUESTO]: ObjetivoAgente.LEJANO,
};

/** «Ninguna de las opciones»: la respuesta por defecto del contrato. */
export const OPCION_NINGUNA = 'NINGUNA';

/**
 * Cuántas operaciones se le enseñan al modelo en una ronda, como mucho. Con
 * doce pares, tres familias y dos lados podría haber decenas; una oferta así
 * no se lee, y cada línea de más es coste.
 */
export const MAX_OFERTA_AGENTE = 8;

/** La etiqueta de cada puesto de la oferta: `A`, `B`… El modelo no ve ids. */
export const LETRAS_OFERTA: readonly string[] = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

/** Por qué elige el modelo lo que elige. Una lista cerrada: se cuenta y no trae cifras. */
export const MotivoAgente = {
  TENDENCIA_CLARA: 'TENDENCIA_CLARA',
  TENDENCIA_DEBIL: 'TENDENCIA_DEBIL',
  RUPTURA_LIMPIA: 'RUPTURA_LIMPIA',
  RUPTURA_DUDOSA: 'RUPTURA_DUDOSA',
  RANGO_CLARO: 'RANGO_CLARO',
  RANGO_DUDOSO: 'RANGO_DUDOSO',
  MOMENTO_FAVORABLE: 'MOMENTO_FAVORABLE',
  MOMENTO_AGOTADO: 'MOMENTO_AGOTADO',
  EVIDENCIA_FAVORABLE: 'EVIDENCIA_FAVORABLE',
  EVIDENCIA_ESCASA: 'EVIDENCIA_ESCASA',
  EVIDENCIA_DESFAVORABLE: 'EVIDENCIA_DESFAVORABLE',
  RECOMPENSA_BUENA: 'RECOMPENSA_BUENA',
  RECOMPENSA_POBRE: 'RECOMPENSA_POBRE',
  COSTE_ALTO: 'COSTE_ALTO',
  VOLATILIDAD_ALTA: 'VOLATILIDAD_ALTA',
  DIA_TENSO: 'DIA_TENSO',
  NINGUNO: 'NINGUNO',
} as const;
export type MotivoAgente = (typeof MotivoAgente)[keyof typeof MotivoAgente];

/** Lo que al modelo le preocupa de la operación. Cerrado, como los motivos. */
export const RiesgoAgente = {
  FALSA_RUPTURA: 'FALSA_RUPTURA',
  GIRO_DE_TENDENCIA: 'GIRO_DE_TENDENCIA',
  RUPTURA_DEL_RANGO: 'RUPTURA_DEL_RANGO',
  LIQUIDEZ: 'LIQUIDEZ',
  VOLATILIDAD: 'VOLATILIDAD',
  RACHA: 'RACHA',
  TOPE_DIARIO_CERCA: 'TOPE_DIARIO_CERCA',
  FUNDING: 'FUNDING',
  CORRELACION: 'CORRELACION',
  NINGUNO: 'NINGUNO',
} as const;
export type RiesgoAgente = (typeof RiesgoAgente)[keyof typeof RiesgoAgente];

/** Lo que devolvió el modelo en una ronda de entrada, ya validado contra el contrato. */
export interface RespuestaModeloAgente {
  /** La etiqueta de la oferta (`A`, `B`…) o `NINGUNA`. */
  opcion: string;
  stop: TipoStop;
  objetivo: ObjetivoAgente;
  apalancamiento: BandaApalancamiento;
  tamano: TamanoOperacion;
  confianza: NivelConfianza;
  /** Sin `NINGUNO` ni repetidos. */
  motivos: MotivoAgente[];
  riesgos: RiesgoAgente[];
  /** Una frase del modelo, sin cifras y de 200 caracteres como mucho. Texto ajeno. */
  texto: string;
}

/**
 * Lo que se ejecuta: el candidato por su id —no por la letra— y el tamaño ya
 * reducido por la confianza (`eleccionEfectiva`). Solo enumeraciones.
 */
export interface EleccionAgente {
  candidatoId: string;
  stop: TipoStop;
  objetivo: ObjetivoAgente;
  apalancamiento: BandaApalancamiento;
  tamano: TamanoOperacion;
  confianza: NivelConfianza;
}

/**
 * La operación con sus números, derivada de la elección por el generador
 * (`strategy-core/src/agentes/propuesta.ts`). Se guarda en la propuesta al
 * proponer y otra vez, recalculada, al aprobar; de ella sale la configuración
 * del bot.
 */
export interface PlanAgente {
  version: 1;
  simbolo: string;
  familia: FamiliaAgente;
  lado: PositionSide;
  intervalo: IntervaloAgente;
  eleccion: EleccionAgente;
  entradaReferencia: string;
  entradaTope: string;
  extremo: string;
  /**
   * El nivel que sostiene la idea, si la familia tiene uno: el borde roto de
   * una ruptura. El seguimiento mira si el precio lo ha vuelto a cruzar.
   */
  nivelIdea: string | null;
  stop: string;
  /** Los dos objetivos del candidato: al recalcular se vuelven a repartir con ellos. */
  tp1: string;
  tp2: string;
  objetivos: ObjetivoPlan[];
  cantidad: string;
  apalancamiento: number;
  nocional: string;
  margen: string;
  /** La pérdida al stop con comisiones y deslizamiento: lo que vale 1R. */
  riesgo: string;
  riesgoPctCapital: number;
  /** El R neto si se cumplen los objetivos del plan. */
  rNeto: number;
  liquidacionEstimada: string | null;
  /** Distancia del stop a la entrada tope, en tanto por uno. */
  distanciaStop: number;
  barT: number;
  huella: string;
  /** Pasado este instante sin entrar, la operación ya no entra. */
  entradaHasta: number;
  /** La salida por tiempo, contada desde la entrada. */
  maxMinutos: number;
  breakevenTrasTp1: boolean;
  /** Los costes del cálculo: el breakeven y el R real se cuentan con ellos. */
  costes: { makerBps: number; takerBps: number; deslizamientoBps: number };
}

// ── El seguimiento ─────────────────────────────────────────────────────────

/**
 * Lo que el seguimiento puede hacer con una operación viva. Todas REDUCEN el
 * riesgo: ceñir el stop, reducir la posición o cerrarla. Solo se ofrecen las
 * válidas en ese momento (`strategy-core/src/agentes/seguimiento.ts`).
 */
export const AccionSeguimiento = {
  MANTENER: 'MANTENER',
  /** El stop a la entrada más los costes. */
  PROTEGER: 'PROTEGER',
  ASEGURAR_MEDIO_R: 'ASEGURAR_MEDIO_R',
  ASEGURAR_UN_R: 'ASEGURAR_UN_R',
  REDUCIR_TERCIO: 'REDUCIR_TERCIO',
  REDUCIR_MITAD: 'REDUCIR_MITAD',
  CERRAR: 'CERRAR',
} as const;
export type AccionSeguimiento = (typeof AccionSeguimiento)[keyof typeof AccionSeguimiento];

/** La clase de cada acción, que es la que decide su autonomía. Mantener no tiene. */
export const CLASE_DE_ACCION: Readonly<Record<AccionSeguimiento, ClaseAccion | null>> = {
  [AccionSeguimiento.MANTENER]: null,
  [AccionSeguimiento.PROTEGER]: ClaseAccion.REDUCIR,
  [AccionSeguimiento.ASEGURAR_MEDIO_R]: ClaseAccion.REDUCIR,
  [AccionSeguimiento.ASEGURAR_UN_R]: ClaseAccion.REDUCIR,
  [AccionSeguimiento.REDUCIR_TERCIO]: ClaseAccion.REDUCIR,
  [AccionSeguimiento.REDUCIR_MITAD]: ClaseAccion.REDUCIR,
  [AccionSeguimiento.CERRAR]: ClaseAccion.CERRAR,
};

/** La idea con la que se entró, mirada con las velas de ahora. */
export const EstadoTesis = {
  INTACTA: 'INTACTA',
  DEBILITADA: 'DEBILITADA',
  ROTA: 'ROTA',
} as const;
export type EstadoTesis = (typeof EstadoTesis)[keyof typeof EstadoTesis];

/** Qué despertó al seguimiento. */
export const DisparadorSeguimiento = {
  INTERVALO: 'INTERVALO',
  OBJETIVO_1: 'OBJETIVO_1',
  TESIS_ROTA: 'TESIS_ROTA',
  REGIMEN: 'REGIMEN',
  /** «Revisar ahora», desde la app. */
  MANUAL: 'MANUAL',
} as const;
export type DisparadorSeguimiento =
  (typeof DisparadorSeguimiento)[keyof typeof DisparadorSeguimiento];

export const MotivoSeguimiento = {
  TESIS_INTACTA: 'TESIS_INTACTA',
  TESIS_DEBILITADA: 'TESIS_DEBILITADA',
  TESIS_ROTA: 'TESIS_ROTA',
  MOMENTO_A_FAVOR: 'MOMENTO_A_FAVOR',
  MOMENTO_EN_CONTRA: 'MOMENTO_EN_CONTRA',
  OBJETIVO_CERCA: 'OBJETIVO_CERCA',
  BENEFICIO_EN_RIESGO: 'BENEFICIO_EN_RIESGO',
  TIEMPO_AGOTANDOSE: 'TIEMPO_AGOTANDOSE',
  REGIMEN_CAMBIADO: 'REGIMEN_CAMBIADO',
  VOLATILIDAD_ALTA: 'VOLATILIDAD_ALTA',
  NINGUNO: 'NINGUNO',
} as const;
export type MotivoSeguimiento = (typeof MotivoSeguimiento)[keyof typeof MotivoSeguimiento];

/**
 * Una acción ofrecida, con el cambio de configuración que la aplica. Solo
 * puede tocar dos campos del bot, y en un solo sentido: `stopPrice` más ceñido
 * y `positionCap` menor (`'0'` es cerrar).
 */
export interface OpcionSeguimiento {
  accion: AccionSeguimiento;
  clase: ClaseAccion | null;
  cambio: { stopPrice?: string; positionCap?: string };
  /** Lo que quedaría, para enseñarlo. */
  stopNuevo: string | null;
  posicionNueva: string | null;
  /** Lo que se perdería al stop tras aplicarla, en R del riesgo inicial. */
  riesgoRestanteR: number;
}

/**
 * Cómo va una operación viva, en unidades que no delatan el par ni el tamaño:
 * es lo que ve el modelo en el seguimiento y lo que enseña la app. 1R es la
 * distancia del stop INICIAL a la entrada.
 */
export interface EstadoOperacionAgente {
  rAhora: number;
  /** Lo más a favor y lo más en contra desde la entrada, en R. */
  mfeR: number;
  maeR: number;
  minutos: number;
  /** El tiempo pasado sobre el máximo de la operación, de 0 a 1 o más. */
  fraccionTiempo: number;
  tp1Hecho: boolean;
  /** El stop vigente en R desde la entrada: −1 al principio, 0 en la entrada. */
  stopR: number;
  /** La posición que queda sobre la que entró, de 0 a 1. */
  posicionFraccion: number;
  /** Lo que falta hasta el próximo objetivo, en R; null si no queda ninguno. */
  objetivoR: number | null;
  tesis: EstadoTesis;
  /** Qué ha visto el motor para juzgar la idea: se enseña tal cual. */
  motivosTesis: string[];
  regimen: RegimenMercado;
  sentido: SentidoTendencia | null;
}

/** Lo que devolvió el modelo en un seguimiento, ya validado contra el contrato. */
export interface RespuestaModeloSeguimiento {
  /** Una de las acciones ofrecidas; `MANTENER` siempre lo está. */
  accion: AccionSeguimiento;
  tesis: EstadoTesis;
  confianza: NivelConfianza;
  motivos: MotivoSeguimiento[];
  texto: string;
}

// ── Rondas, propuestas y acciones ─────────────────────────────────────────

/** Calca `AiDeskRoundKind` de Prisma. */
export const TipoRondaAgente = { ENTRADA: 'ENTRADA', SEGUIMIENTO: 'SEGUIMIENTO' } as const;
export type TipoRondaAgente = (typeof TipoRondaAgente)[keyof typeof TipoRondaAgente];

/** Calca `AiDeskRoundState` de Prisma. */
export const EstadoRondaAgente = {
  EN_CURSO: 'EN_CURSO',
  /** Decidió: una propuesta, una acción o nada que hacer. */
  COMPLETADA: 'COMPLETADA',
  /** Una barrera la paró antes de gastar. */
  SALTADA: 'SALTADA',
  /** El modelo no dio una respuesta utilizable. */
  FALLIDA: 'FALLIDA',
} as const;
export type EstadoRondaAgente = (typeof EstadoRondaAgente)[keyof typeof EstadoRondaAgente];

/**
 * En qué acabó una ronda. Las barreras van en el orden en que se miran
 * (spec 074, R-12): la primera que se cierra es la que se anota.
 */
export const MotivoRonda = {
  IA_APAGADA: 'IA_APAGADA',
  DUENO: 'DUENO',
  AGENTE: 'AGENTE',
  DORMIDO: 'DORMIDO',
  INTERRUPTOR: 'INTERRUPTOR',
  /** Sin Redis no se leen el interruptor ni los cupos, y sin ellos no se llama. */
  REDIS: 'REDIS',
  CUENTA: 'CUENTA',
  PERDIDA_DIARIA: 'PERDIDA_DIARIA',
  OPERACIONES_DIA: 'OPERACIONES_DIA',
  RACHA: 'RACHA',
  CAPACIDAD: 'CAPACIDAD',
  LIMITES_USUARIO: 'LIMITES_USUARIO',
  SIN_PARES: 'SIN_PARES',
  SIN_DATOS: 'SIN_DATOS',
  SIN_CANDIDATOS: 'SIN_CANDIDATOS',
  /** La misma oferta que la ronda anterior: preguntar otra vez sería pagar la misma respuesta. */
  HUELLA: 'HUELLA',
  CUPO_AGENTE: 'CUPO_AGENTE',
  CUPO_GLOBAL: 'CUPO_GLOBAL',
  GASTO: 'GASTO',
  /** El modelo o el juez prefirieron no operar. */
  NINGUNA: 'NINGUNA',
  /** Lo elegido no estaba en la oferta, o no estaba disponible. */
  OFERTA: 'OFERTA',
  /** Error, tiempo agotado, negativa o respuesta cortada. */
  MODELO: 'MODELO',
  /** Una respuesta que no cumple el contrato. */
  CONTRATO: 'CONTRATO',
  /**
   * Seguimiento: el bot de la operación no está en marcha. Un bot pausado por
   * una persona no se toca (R-23); uno parado o en error, tampoco.
   */
  BOT: 'BOT',
  /** Seguimiento: la operación ya tiene una acción esperando respuesta. */
  PENDIENTE: 'PENDIENTE',
  PROPUESTA: 'PROPUESTA',
  SOMBRA: 'SOMBRA',
  MANTENER: 'MANTENER',
  ACCION: 'ACCION',
  /** Algo inesperado a mitad de la ronda: el detalle va al log, y la ronda no deja nada a medias. */
  ERROR: 'ERROR',
} as const;
export type MotivoRonda = (typeof MotivoRonda)[keyof typeof MotivoRonda];

/**
 * Calca `AiDeskProposalState` de Prisma.
 *
 * Camino feliz: `PROPUESTA → APROBANDO → EJECUTANDO → ABIERTA → CERRADA`.
 * `APROBANDO` es el reclamo condicional: quien lo gana es el único que
 * recalcula y crea el bot, venga del botón, de la app o del automático.
 */
export const EstadoPropuestaAgente = {
  PROPUESTA: 'PROPUESTA',
  APROBANDO: 'APROBANDO',
  /** El bot existe y arrancó; la entrada aún no se ha visto llena. */
  EJECUTANDO: 'EJECUTANDO',
  ABIERTA: 'ABIERTA',
  CERRADA: 'CERRADA',
  /** El bot corrió y la entrada no se llenó. */
  SIN_ENTRADA: 'SIN_ENTRADA',
  RECHAZADA: 'RECHAZADA',
  CADUCADA: 'CADUCADA',
  /** La descartó el sistema: agente editado o pausado, par ocupado, interruptor… */
  DESCARTADA: 'DESCARTADA',
  FALLIDA: 'FALLIDA',
  /** Se registró para medirla, sin ofrecerla: solo medir o modo sombra. */
  SOMBRA: 'SOMBRA',
} as const;
export type EstadoPropuestaAgente =
  (typeof EstadoPropuestaAgente)[keyof typeof EstadoPropuestaAgente];

/** Las que ocupan su par: una operación viva por par y agente (R-20). */
export const PROPUESTAS_VIVAS: readonly EstadoPropuestaAgente[] = [
  EstadoPropuestaAgente.APROBANDO,
  EstadoPropuestaAgente.EJECUTANDO,
  EstadoPropuestaAgente.ABIERTA,
];

export const PROPUESTAS_TERMINALES: readonly EstadoPropuestaAgente[] = [
  EstadoPropuestaAgente.CERRADA,
  EstadoPropuestaAgente.SIN_ENTRADA,
  EstadoPropuestaAgente.RECHAZADA,
  EstadoPropuestaAgente.CADUCADA,
  EstadoPropuestaAgente.DESCARTADA,
  EstadoPropuestaAgente.FALLIDA,
  EstadoPropuestaAgente.SOMBRA,
];

/**
 * Las que llegaron a ser una operación en marcha: su bot se creó y arrancó. Es
 * el «tomadas» del resumen diario y de la tarjeta; lo aprobado que caducó al
 * recalcular o que no llegó a arrancar no cuenta.
 */
export const PROPUESTAS_EJECUTADAS: readonly EstadoPropuestaAgente[] = [
  EstadoPropuestaAgente.EJECUTANDO,
  EstadoPropuestaAgente.ABIERTA,
  EstadoPropuestaAgente.CERRADA,
  EstadoPropuestaAgente.SIN_ENTRADA,
];

/** Por qué una propuesta acabó donde acabó. */
export const MotivoPropuestaAgente = {
  CADUCIDAD: 'CADUCIDAD',
  /** Al recalcular, el precio ya había pasado el stop. */
  PRECIO_PASO_STOP: 'PRECIO_PASO_STOP',
  /** Al recalcular, el precio se había movido más de media distancia de stop. */
  PRECIO_MOVIDO: 'PRECIO_MOVIDO',
  /** Al recalcular, ya no cabía en los límites. */
  LIMITES: 'LIMITES',
  PAR_OCUPADO: 'PAR_OCUPADO',
  CAPACIDAD: 'CAPACIDAD',
  AGENTE_CAMBIADO: 'AGENTE_CAMBIADO',
  AGENTE_PAUSADO: 'AGENTE_PAUSADO',
  INTERRUPTOR: 'INTERRUPTOR',
  DUENO: 'DUENO',
  CUENTA: 'CUENTA',
  IA_APAGADA: 'IA_APAGADA',
  SIN_DATOS: 'SIN_DATOS',
  /** `BotsService.create` lo rechazó. */
  CREAR: 'CREAR',
  /** El `START` falló y el borrador se borró. */
  ARRANCAR: 'ARRANCAR',
  /** La rechazó su dueño. */
  PERSONA: 'PERSONA',
  SIN_LLENADO: 'SIN_LLENADO',
  SOLO_MEDIR: 'SOLO_MEDIR',
  SOLO_SOMBRA: 'SOLO_SOMBRA',
  SOLO_SIMULACION: 'SOLO_SIMULACION',
} as const;
export type MotivoPropuestaAgente =
  (typeof MotivoPropuestaAgente)[keyof typeof MotivoPropuestaAgente];

/** Cómo salió una operación cerrada. */
export const SalidaOperacionAgente = {
  OBJETIVO: 'OBJETIVO',
  STOP: 'STOP',
  /** Saltó un stop ya ceñido a la entrada o más allá. */
  STOP_PROTEGIDO: 'STOP_PROTEGIDO',
  TIEMPO: 'TIEMPO',
  /** La cerró o la redujo a cero el seguimiento. */
  SEGUIMIENTO: 'SEGUIMIENTO',
  /** Stop que no saltó, liquidación demasiado cerca o apalancamiento distinto. */
  SEGURIDAD: 'SEGURIDAD',
  /** Un comando de su dueño: parar y cerrar, pánico. */
  MANUAL: 'MANUAL',
  LIQUIDACION: 'LIQUIDACION',
  /** Se cerró fuera del bot y nadie vio su ejecución: sin R. */
  FUERA: 'FUERA',
} as const;
export type SalidaOperacionAgente =
  (typeof SalidaOperacionAgente)[keyof typeof SalidaOperacionAgente];

/** Calca `AiDeskActionState` de Prisma. */
export const EstadoAccionAgente = {
  PROPUESTA: 'PROPUESTA',
  APLICANDO: 'APLICANDO',
  APLICADA: 'APLICADA',
  RECHAZADA: 'RECHAZADA',
  CADUCADA: 'CADUCADA',
  /** Ya no tenía sentido: la operación cerró, o el stop ya estaba más ceñido. */
  DESCARTADA: 'DESCARTADA',
  FALLIDA: 'FALLIDA',
  /** Se registró sin aplicarse: modo sombra. */
  SOMBRA: 'SOMBRA',
} as const;
export type EstadoAccionAgente = (typeof EstadoAccionAgente)[keyof typeof EstadoAccionAgente];

/** El resultado hipotético de una operación por triple barrera, pesimista (R-25). */
export interface ResultadoHipotetico {
  resultado: 'OBJETIVO' | 'STOP' | 'TIEMPO';
  /** Con costes. */
  r: number;
  /** Apertura de la vela en la que se resolvió. */
  en: number;
}

/** Lo que dice una muestra de resultados en R. */
export interface EstadisticaR {
  n: number;
  /** R positivo. */
  aciertos: number;
  /** Límite inferior de Wilson al 95 % del acierto. */
  wilsonInferior: number;
  rMedio: number | null;
  /** t de Student del R medio; null con menos de dos casos o sin dispersión. */
  t: number | null;
  /** Por debajo de 30 casos cualquier conclusión es prematura, y la app lo dice. */
  muestraPequena: boolean;
}

/**
 * La tarjeta de resultados (R-25). Se hace por agente, y un agente es de una
 * sola cuenta: lo real y lo simulado nunca se suman en la misma tarjeta.
 * NADA lee la tarjeta para decidir: se enseña, y un test lo afirma.
 */
export interface TarjetaAgente {
  /** Propuestas que se ofrecieron, y en qué acabaron. */
  propuestas: number;
  tomadas: number;
  rechazadas: number;
  caducadas: number;
  /** Las operaciones cerradas, con su R real. */
  operaciones: EstadisticaR;
  /** Lo realizado por esas operaciones, con comisiones, en la quote. */
  resultado: string;
  /**
   * «¿Discrimina la IA?»: el R hipotético de lo que eligió frente a lo que tuvo
   * delante y no eligió. Si no se separan, el modelo no aporta (spec 070).
   */
  elegidas: EstadisticaR;
  noElegidas: EstadisticaR;
  /** «Tus descartes»: el R hipotético de lo que su dueño rechazó. */
  descartes: EstadisticaR;
  /** R real menos R hipotético en lo ejecutado: lo que se pierde al ejecutar. */
  brechaEjecucion: number | null;
  porFamilia: { familia: FamiliaAgente; lado: PositionSide; operaciones: EstadisticaR }[];
  /** Las operaciones cerradas por cómo salieron. */
  porSalida: { salida: SalidaOperacionAgente; n: number }[];
}

// ── Eventos ───────────────────────────────────────────────────────────────

/**
 * Los eventos de los agentes. Todos empiezan por `AGENT_`, nunca por `AI_`:
 * la app recarga el Modo IA y el canal con los suyos, y un evento de agente con
 * ese prefijo despertaría recargas que no le tocan.
 *
 * Los del agente los emite la API y no tienen bot (`data.agentId`); los de la
 * operación los emite su bot `AGENT_TRADE`, como cualquier otro evento de bot.
 */
export const EventoAgente = {
  /** Una propuesta nueva: con botones si se decide a mano. */
  PROPUESTA: 'AGENT_PROPOSAL',
  /** En qué acabó aprobar una propuesta, cuando lo pidió una persona. */
  RESULTADO_PROPUESTA: 'AGENT_PROPOSAL_RESULT',
  /** Una acción de seguimiento, propuesta o aplicada. */
  ACCION: 'AGENT_ACTION',
  PAUSADO: 'AGENT_PAUSED',
  /** Demasiados fallos del modelo seguidos: deja de consultar unas horas. */
  DORMIDO: 'AGENT_SLEEPING',
} as const;
export type EventoAgente = (typeof EventoAgente)[keyof typeof EventoAgente];

/** Los eventos del bot de una operación. */
export const EventoOperacionAgente = {
  ENTRADA: 'AGENT_ENTRY',
  SALIDA: 'AGENT_EXIT',
  ENTRADA_DESCARTADA: 'AGENT_ENTRY_DISCARDED',
  BREAKEVEN: 'AGENT_BREAKEVEN',
  STOP_CENIDO: 'AGENT_STOP_TIGHTENED',
  /** Una configuración pedía ensanchar el stop con la posición abierta, y se ignoró (R-2). */
  STOP_IGNORADO: 'AGENT_STOP_IGNORED',
  REDUCIDA: 'AGENT_REDUCED',
  CIERRE: 'AGENT_CIERRE',
  CIERRE_FALLIDO: 'AGENT_CIERRE_FALLIDO',
  /** Una posición en el par que no es de la operación: no se toca (R-5). */
  POSICION_AJENA: 'AGENT_FOREIGN_POSITION',
  OPERACION_PERDIDA: 'AGENT_OPERACION_PERDIDA',
} as const;
export type EventoOperacionAgente =
  (typeof EventoOperacionAgente)[keyof typeof EventoOperacionAgente];

export const esEventoAgente = (tipo: string): boolean => tipo.startsWith('AGENT_');

/**
 * Lo que llevan en `data` los eventos del agente —los que no tienen bot—, además
 * de la severidad y el mensaje. Con ello el notificador del worker los etiqueta
 * con el nombre del agente, reparte la entrega entre réplicas por propuesta o
 * por acción y pinta los botones si hay vale.
 */
export interface DatosEventoAgente {
  agentId: string;
  /** La propuesta de entrada, o la operación de la acción. */
  propuestaId?: string;
  /** La acción de seguimiento, en `AGENT_ACTION`. */
  accionId?: string;
  /** El vale de los botones. Sin él, el mensaje sale sin botones. */
  vale?: string;
  /** La acción propuesta: con `CERRAR`, los botones son cerrar o mantener. */
  accion?: AccionSeguimiento;
}

const textoNoVacio = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/**
 * Los datos de un evento de agente, o null si no traen agente. Lo opcional que
 * no tiene su forma se deja fuera en vez de invalidar el aviso entero: sin vale,
 * el aviso llega igual, solo que sin botones.
 */
export function datosEventoAgente(data: unknown): DatosEventoAgente | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;
  if (!textoNoVacio(d['agentId'])) return null;
  const accion = d['accion'];
  return {
    agentId: d['agentId'],
    ...(textoNoVacio(d['propuestaId']) ? { propuestaId: d['propuestaId'] } : {}),
    ...(textoNoVacio(d['accionId']) ? { accionId: d['accionId'] } : {}),
    ...(esValeAgente(d['vale']) ? { vale: d['vale'] } : {}),
    ...((Object.values(AccionSeguimiento) as unknown[]).includes(accion)
      ? { accion: accion as AccionSeguimiento }
      : {}),
  };
}

// ── Los botones de Telegram ────────────────────────────────────────────────

/**
 * `ag:<vale>:<verbo>`. El vale es opaco, como los del Modo IA y del canal: en
 * `callback_data` caben 64 bytes, y quien lo intercepte no debe poder deducir
 * de qué propuesta es. Un mensaje lleva un vale; sus botones comparten el vale
 * y cambian el verbo, así que la primera pulsación lo gasta.
 */
export const PREFIJO_BOTON_AGENTE = 'ag';

export const VerboAgente = {
  /** Ejecutar la propuesta o aplicar la acción. */
  SI: 'si',
  /** Descartarla. */
  NO: 'no',
  /** Cerrar la operación ya. */
  CIERRA: 'cierra',
} as const;
export type VerboAgente = (typeof VerboAgente)[keyof typeof VerboAgente];

/** El mensaje del bus con la pulsación, del poller a la API. */
export const PULSACION_AGENTE = 'AGENT_DECISION_TAKEN';

/** Lo que guarda el vale: quién puede usarlo y sobre qué. */
export interface ValeAgente {
  userId: string;
  agentId: string;
  /** La propuesta de entrada, o la operación de la acción. */
  propuestaId: string;
  /** La acción de seguimiento, si el mensaje es de una. */
  accionId: string | null;
}

/** La clave de Redis del vale. Se canjea con `GETDEL`: una pulsación, una decisión. */
export const claveValeAgente = (vale: string): string => `ag:vale:${vale}`;

/** Un vale bien formado: 32 hexadecimales, un `randomUUID` sin guiones. */
export const esValeAgente = (v: unknown): v is string =>
  typeof v === 'string' && /^[0-9a-f]{32}$/.test(v);

export const callbackAgente = (vale: string, verbo: VerboAgente): string =>
  `${PREFIJO_BOTON_AGENTE}:${vale}:${verbo}`;

/** El vale y el verbo de un `callback_data`, o null si no es un botón de agente bien formado. */
export function leerCallbackAgente(data: unknown): { vale: string; verbo: VerboAgente } | null {
  if (typeof data !== 'string') return null;
  const partes = data.split(':');
  if (partes.length !== 3 || partes[0] !== PREFIJO_BOTON_AGENTE) return null;
  const [, vale, verbo] = partes;
  if (!esValeAgente(vale)) return null;
  if (!(Object.values(VerboAgente) as string[]).includes(verbo)) return null;
  return { vale, verbo: verbo as VerboAgente };
}

// ── Los interruptores ──────────────────────────────────────────────────────

/**
 * El interruptor global de entradas de los agentes, en Redis. `off` cierra las
 * entradas de todos; sin la clave, quedan abiertas; con Redis caído, cerradas.
 * Se lee con `interruptorCerrado`, como el del canal. El seguimiento no mira
 * este interruptor: reducir el riesgo nunca se corta.
 */
export const CLAVE_INTERRUPTOR_AGENTES = 'crypton:ai-desk:entries';
/** El motivo con el que se cortaron, para enseñarlo: la consola lo exige al cortarlas. */
export const CLAVE_MOTIVO_INTERRUPTOR_AGENTES = 'crypton:ai-desk:entries:reason';

/** Los interruptores del servidor, tal y como los enseña la app. */
export interface InterruptoresAgentes {
  /** `AI_DESK_ENABLE`. Apagado, no corre ninguna ronda, tampoco en modo reglas. */
  encendido: boolean;
  /** Sin clave del modelo, solo corren los agentes en modo reglas. */
  modeloDisponible: boolean;
  modelo: string;
  /** El interruptor global de entradas; `DESCONOCIDO` si Redis no contesta. */
  entradas: 'ABIERTAS' | 'CERRADAS' | 'DESCONOCIDO';
  motivoEntradas: string | null;
  frenos: FrenosAgentes;
  limiteAgente: number;
  limiteGlobal: number;
  /** Llamadas de hoy de toda la plataforma; null si Redis no contesta. */
  llamadasGlobalesHoy: number | null;
}

/** Lo que la pastilla de un agente necesita saber de él. */
export interface EstadoInsigniaAgente {
  estado: EstadoAgente;
  /** ISO, o null si no duerme. */
  dormidoHasta: string | null;
  modo: ModoDecision;
  autonomia: AutonomiaAgente;
  /** La cuenta del agente es real, no la de simulación. */
  real: boolean;
}

/** Lo que dice la pastilla de un agente. */
export type InsigniaAgente =
  | 'ARCHIVADO'
  | 'PAUSADO'
  | 'APAGADO'
  | 'CORTADO'
  | 'SIN_MODELO'
  | 'DORMIDO'
  | 'MIDE'
  | 'REGLAS'
  | 'ACTIVO';

/**
 * El estado de un agente en una palabra, de lo más grave a lo menos. Lo que
 * cuenta es si va a abrir algo: un agente activo con el interruptor global
 * cerrado no está «activo» para quien lo mira.
 */
export function insigniaAgente(
  i: InterruptoresAgentes,
  a: EstadoInsigniaAgente,
  ahora: number,
): InsigniaAgente {
  if (a.estado === EstadoAgente.ARCHIVADO) return 'ARCHIVADO';
  if (a.estado === EstadoAgente.PAUSADO) return 'PAUSADO';
  if (!i.encendido) return 'APAGADO';
  if (i.entradas !== 'ABIERTAS') return 'CORTADO';
  const reglas = a.modo === ModoDecision.REGLAS;
  if (!reglas && !i.modeloDisponible) return 'SIN_MODELO';
  const dormido = a.dormidoHasta ? Date.parse(a.dormidoHasta) : Number.NaN;
  if (!reglas && Number.isFinite(dormido) && dormido > ahora) return 'DORMIDO';
  if (efectoDe(ClaseAccion.ENTRAR, a.autonomia, i.frenos, a.real) === EfectoAccion.MIDE) {
    return 'MIDE';
  }
  return reglas ? 'REGLAS' : 'ACTIVO';
}

import type { BotStatus, PositionSide, Venue } from './enums';
import type {
  AccionSeguimiento,
  AutonomiaAgente,
  ClaseAccion,
  EfectoAccion,
  EleccionAgente,
  EstadoAccionAgente,
  EstadoAgente,
  EstadoOperacionAgente,
  EstadoPropuestaAgente,
  EstadoRondaAgente,
  FamiliaAgente,
  InsigniaAgente,
  InterruptoresAgentes,
  IntervaloAgente,
  LimitesAgente,
  MotivoPausaAgente,
  PlanAgente,
  RespuestaModeloAgente,
  RespuestaModeloSeguimiento,
  ResultadoHipotetico,
  SalidaOperacionAgente,
  TarjetaAgente,
  TipoRondaAgente,
  UsoAgente,
} from './ia-agentes';
import { candleSpanMs } from './candle';
import type { ModoDecision } from './ia-canal';

/**
 * Lo que la API de los agentes (spec 074) le da a la app: la forma de cada
 * respuesta, en un solo sitio para los dos lados.
 *
 * Las cifras de dinero viajan como cadena decimal, como en el resto de la API;
 * las fechas, en ISO 8601.
 */

/** La cuenta de un agente, tal y como se enseña. */
export interface CuentaAgente {
  id: string;
  nombre: string;
  venue: Venue;
  /** La cuenta «Simulación»: nada sale al exchange. */
  simulacion: boolean;
  testnet: boolean;
  /**
   * Dinero de verdad: ni simulación ni testnet. Es lo que pide consentimiento y
   * lo que miran los frenos del servidor.
   */
  real: boolean;
}

/** Un agente. */
export interface AgenteVista {
  id: string;
  nombre: string;
  estado: EstadoAgente;
  motivoPausa: MotivoPausaAgente | null;
  cuenta: CuentaAgente;
  pares: string[];
  intervalo: IntervaloAgente;
  familias: FamiliaAgente[];
  lados: PositionSide[];
  modo: ModoDecision;
  limites: LimitesAgente;
  autonomia: AutonomiaAgente;
  /** Sube con cada edición: quien guarda dice sobre cuál editó. */
  version: number;
  proximaRonda: string | null;
  dormidoHasta: string | null;
  fallos: number;
  ultimoError: string | null;
  /** Consultas al modelo y su coste de hoy (UTC). */
  consultasHoy: number;
  costeHoy: string;
  /** Operaciones vivas y propuestas esperando a una persona. */
  vivas: number;
  pendientes: number;
  insignia: InsigniaAgente;
  creadoEn: string;
  archivadoEn: string | null;
}

/** La pestaña de agentes: los interruptores y los agentes de quien pregunta. */
export interface ResumenAgentes {
  interruptores: InterruptoresAgentes;
  agentes: AgenteVista[];
  /** Propuestas esperando a una persona, de todos sus agentes: la insignia de la pestaña. */
  pendientes: number;
  vivas: number;
  /** Los pares que puede mirar un agente, como mucho (`AI_DESK_MAX_WATCHLIST`). */
  maxPares: number;
}

/** Un agente con su día. */
export interface DetalleAgente {
  agente: AgenteVista;
  uso: UsoAgente;
  /** Lo más que puede perder hoy: su pérdida diaria, en la quote. */
  peorDia: string;
  /** Sus últimas rondas: lo que responde a «¿por qué no propone nada?». */
  rondas: RondaVista[];
}

/** Un par en una ronda: por qué no ofreció nada, o qué operaciones vio. */
export interface ParRondaVista {
  simbolo: string;
  descartes: string[];
  candidatos: {
    familia: FamiliaAgente;
    lado: PositionSide;
    elegible: boolean;
    letra: string | null;
  }[];
}

/** Una ronda de un agente, de entrada o de seguimiento. */
export interface RondaVista {
  id: string;
  tipo: TipoRondaAgente;
  /** Apertura de la vela en la que se basó. */
  barT: string;
  disparador: string;
  estado: EstadoRondaAgente;
  /** La barrera que la paró, o en qué acabó. */
  motivo: string | null;
  modo: ModoDecision;
  creadaEn: string;
  terminadaEn: string | null;
  modelo: string | null;
  latenciaMs: number | null;
  coste: string | null;
  /** Lo que eligió quien decidía —la IA o el juez— y lo que habría elegido el juez. */
  eleccion: EleccionAgente | null;
  juez: EleccionAgente | null;
  /** La respuesta del modelo, con su frase: texto ajeno. */
  respuesta: RespuestaModeloAgente | null;
  fallo: string | null;
  propuestaId: string | null;
  /** Lo que vio, par a par. Vacío cuando la retención ya lo vació. */
  pares: ParRondaVista[];
}

// ── Propuestas, operaciones y acciones ─────────────────────────────────────

/** Una acción de seguimiento sobre una operación. */
export interface AccionVista {
  id: string;
  accion: AccionSeguimiento;
  clase: ClaseAccion;
  estado: EstadoAccionAgente;
  motivo: string | null;
  /** Lo que deja: el stop nuevo, o la posición a la que reduce (`'0'` es cerrar). */
  stopNuevo: string | null;
  posicionNueva: string | null;
  /** Lo que se perdería si después salta el stop, en R del riesgo inicial. */
  riesgoRestanteR: number | null;
  /** La respuesta del modelo, con su frase: texto ajeno. null si decidió el juez. */
  respuesta: RespuestaModeloSeguimiento | null;
  caducaEn: string;
  decididaPor: string | null;
  decididaEn: string | null;
  creadaEn: string;
}

/**
 * La operación de una propuesta aprobada: su bot y cómo va. Lo de ahora sale
 * del último snapshot del bot y de lo que lleva el motor; al cerrar, lo
 * realizado.
 */
export interface OperacionVista {
  botId: string;
  estadoBot: BotStatus;
  abiertaEn: string | null;
  cerradaEn: string | null;
  salida: SalidaOperacionAgente | null;
  /** La entrada media, la marca y la posición que queda, del último snapshot. */
  entrada: string | null;
  marca: string | null;
  posicion: string | null;
  /** El stop que lleva el motor ahora mismo: el más ceñido visto. */
  stop: string | null;
  tp1Hecho: boolean;
  /**
   * Viva: el R con la marca sobre el riesgo inicial, sin comisiones (`rAhora`).
   * Cerrada: el R real, con comisiones.
   */
  r: number | null;
  /** Viva: realizado más no realizado del snapshot. Cerrada: lo realizado. En la quote. */
  resultado: string | null;
  /** Cuándo se tomó el snapshot de lo de ahora. */
  vistoEn: string | null;
  /** Cómo la vio el seguimiento la última vez que la miró. */
  revision: { en: string; estado: EstadoOperacionAgente } | null;
  /** La última acción del seguimiento, pendiente o no. */
  ultimaAccion: AccionVista | null;
}

/** Una propuesta de entrada y, si se aprobó, su operación. */
export interface PropuestaVista {
  id: string;
  agenteId: string;
  agente: string;
  /** Dinero de verdad cuando se propuso: lo simulado nunca se suma a esto. */
  real: boolean;
  simbolo: string;
  familia: FamiliaAgente;
  lado: PositionSide;
  estado: EstadoPropuestaAgente;
  motivo: string | null;
  /** El plan al proponer, y el recalculado con el precio de cuando se aprobó. */
  plan: PlanAgente | null;
  planFinal: PlanAgente | null;
  /** Lo que eligió quien decidía, y la respuesta del modelo (texto ajeno). */
  eleccion: EleccionAgente | null;
  respuesta: RespuestaModeloAgente | null;
  /** Si se propuso a una persona, se abrió sola o solo se midió. */
  efecto: EfectoAccion | null;
  caducaEn: string;
  decididaPor: string | null;
  decididaEn: string | null;
  creadaEn: string;
  /**
   * Qué habría pasado con el plan de la propuesta, se tomara o no: null
   * mientras las velas no lo resuelven, o si ya no se pudo medir.
   */
  hipotetico: ResultadoHipotetico | null;
  medidaEn: string | null;
  operacion: OperacionVista | null;
}

/** Una ronda de seguimiento: cómo vio la operación y qué eligió. */
export interface RevisionVista {
  id: string;
  disparador: string;
  estado: EstadoRondaAgente;
  /** La barrera que la paró, o en qué acabó. */
  motivo: string | null;
  modo: ModoDecision;
  creadaEn: string;
  modelo: string | null;
  coste: string | null;
  /** Cómo iba la operación. null si se paró antes de mirarla, o la retención lo vació. */
  operacion: EstadoOperacionAgente | null;
  /** Lo que se eligió, y lo que habría elegido el juez. */
  accion: AccionSeguimiento | null;
  juez: AccionSeguimiento | null;
  respuesta: RespuestaModeloSeguimiento | null;
  fallo: string | null;
}

/** Una propuesta con todo lo suyo: lo que vio, y su seguimiento. */
export interface DetallePropuesta {
  propuesta: PropuestaVista;
  /** La ronda que la propuso. */
  ronda: RondaVista | null;
  /** Las acciones del seguimiento, de la más nueva a la más vieja. */
  acciones: AccionVista[];
  /** Las últimas rondas de seguimiento, de la más nueva a la más vieja. */
  seguimiento: RevisionVista[];
}

/** La pestaña de propuestas: las que esperan a una persona, y las últimas. */
export interface ListaPropuestas {
  pendientes: PropuestaVista[];
  recientes: PropuestaVista[];
}

/** La pestaña de operaciones: las vivas, y las últimas terminadas. */
export interface ListaOperaciones {
  vivas: PropuestaVista[];
  terminadas: PropuestaVista[];
}

/** La tarjeta de un agente, con lo que ha costado preguntar al modelo. */
export interface ResultadosAgente {
  agenteId: string;
  nombre: string;
  real: boolean;
  archivado: boolean;
  tarjeta: TarjetaAgente;
  /** Consultas al modelo desde que existe, y su coste en USD. */
  consultas: number;
  coste: string;
}

/**
 * La pestaña de resultados: una tarjeta por agente, y las de todos juntos. Lo
 * real y lo simulado —simulación o testnet— nunca se suman: cada uno la suya,
 * y null si no hay agentes de ese tipo.
 */
export interface ResultadosAgentes {
  real: TarjetaAgente | null;
  simulado: TarjetaAgente | null;
  agentes: ResultadosAgente[];
}

/**
 * Lo que manda la app al crear o editar un agente. La API lo valida entero y
 * responde 400 con `{ message, errores: ErrorAgente[] }`, todos a la vez y
 * cada uno con su campo (`limites.<campo>` para un límite).
 */
export interface DefinicionAgenteEntrada {
  nombre: string;
  pares: string[];
  intervalo: IntervaloAgente;
  familias: FamiliaAgente[];
  lados: PositionSide[];
  modo: ModoDecision;
  /** Enteros como número y decimales como cadena, tal y como los tipa `LimitesAgente`. */
  limites: LimitesAgente;
  autonomia: AutonomiaAgente;
  /** En una cuenta real, al crear, al reanudar o al pasar «entrar» a automático. */
  consentimiento?: boolean;
  reason: string;
}

export interface CrearAgenteEntrada extends DefinicionAgenteEntrada {
  /** La cuenta del agente: fija tras crearlo. */
  exchangeAccountId: string;
}

export interface EditarAgenteEntrada extends DefinicionAgenteEntrada {
  /** La versión que se editó: si cambió entretanto, 409. */
  version: number;
}

/** En qué acabó aprobar o descartar una propuesta, venga de donde venga. */
export interface ResultadoDecisionAgente {
  propuestaId: string;
  estado: EstadoPropuestaAgente;
  motivo: string | null;
  botId: string | null;
  /** Una frase para la persona, sin jerga. */
  mensaje: string;
}

/** En qué acabó aplicar o descartar una acción, o cerrar una operación. */
export interface ResultadoAccionAgente {
  accionId: string | null;
  estado: string;
  motivo: string | null;
  mensaje: string;
}

/** Un error de validación de un agente, con el campo al que se refiere. */
export interface ErrorAgente {
  campo: string;
  mensaje: string;
}

/**
 * Cuánto se espera tras el cierre de una vela para mirarla: el venue tiene que
 * haberla publicado cerrada. Quince segundos sobran en los tres.
 */
export const RETRASO_RONDA_MS = 15_000;

/** La próxima ronda de entrada: el cierre de la vela en curso, más el retraso. */
export function proximaRondaAgente(ahora: number, intervalo: IntervaloAgente): number {
  const span = candleSpanMs(intervalo);
  return (Math.floor(ahora / span) + 1) * span + RETRASO_RONDA_MS;
}

/**
 * El vocabulario del «Bot de IA» (`AI_TRADER`, spec 068).
 *
 * Es hermano de `ia-canal.ts` y comparte su doctrina: aquí no hay ni un número
 * de decisión. Quien decide —el juez de reglas hoy, un modelo en el spec 069—
 * emite **enumeraciones**, y un generador determinista las traduce a precios y
 * cantidades en un solo sitio (`construirOperacionTrader`).
 *
 * La diferencia de forma con el canal no es estética. El proveedor del 069
 * evalúa todas las preguntas de una llamada **en paralelo y en aislamiento**:
 * una respuesta no puede informar a otra. Por eso aquí no hay «candidatos con
 * parámetros por candidato» sino **un único montaje** —la dirección la fija el
 * borde tocado— con dos elecciones ortogonales encima: hasta dónde va el stop y
 * hasta dónde va el objetivo.
 */
import type { PositionSide } from './enums';
import type { Evidencia, NivelConfianza, TamanoOperacion, TasasBase } from './ia-canal';

/**
 * Hasta dónde va el stop, en múltiplos de ATR(15m) más allá del extremo.
 *
 * El del medio, 2 ATR, es el que el spec 067 midió como ganador, y es el que se
 * aplica cuando quien decide se abstiene. Los otros dos no son «mejor» ni
 * «peor»: uno compra más tamaño y lo tira el ruido más a menudo, el otro compra
 * menos y sobrevive a más ruido.
 */
export const BucketStop = {
  CENIDO: 'CENIDO',
  MEDIDO: 'MEDIDO',
  HOLGADO: 'HOLGADO',
} as const;
export type BucketStop = (typeof BucketStop)[keyof typeof BucketStop];

/**
 * Hasta dónde va el objetivo, en fracción del camino de la entrada a la media.
 *
 * **El borde opuesto no está.** El spec 067 lo midió sobre este mismo mercado:
 * apuntar al borde contrario de una banda hundía el R medio de +0,28 a −0,21 y
 * el acierto del 42 % al 21 %, porque está a cuatro sigmas y llegar hasta él es
 * la travesía entera. Revertir a la media ES la operación. Se mata aquí, en el
 * vocabulario, y no en un filtro que alguien pueda aflojar luego.
 */
export const BucketObjetivo = {
  CORTO: 'CORTO',
  EN_LA_MEDIA: 'EN_LA_MEDIA',
  LARGO: 'LARGO',
} as const;
export type BucketObjetivo = (typeof BucketObjetivo)[keyof typeof BucketObjetivo];

/**
 * Qué hacer con el toque.
 *
 * Son tres y no dos a propósito. Las dos negativas significan cosas distintas
 * para el código: `ENTORNO_EQUIVOCADO` arma un enfriado que deja de preguntar
 * durante unas velas —y en el spec 069 eso es dinero que no se gasta—, mientras
 * que `ESPERAR` se salta solo esta vela.
 */
export const AccionTrader = {
  TOMAR: 'TOMAR',
  ESPERAR: 'ESPERAR',
  ENTORNO_EQUIVOCADO: 'ENTORNO_EQUIVOCADO',
} as const;
export type AccionTrader = (typeof AccionTrader)[keyof typeof AccionTrader];

/** Por qué una celda de la matriz no se ofrece, o por qué no hay operación. */
export const MotivoTrader = {
  /** El stop quedaría del lado equivocado de la entrada. */
  STOP_INVALIDO: 'STOP_INVALIDO',
  /** Más ancho que `maxStopPct`. */
  STOP_ANCHO: 'STOP_ANCHO',
  /** Comisiones y deslizamiento se comen más que `maxCostPerTradeR` del riesgo. */
  COSTE: 'COSTE',
  /** El objetivo no llega a `minTargetCostMultiple` veces el coste de ida y vuelta. */
  OBJETIVO_CORTO: 'OBJETIVO_CORTO',
  /** El objetivo no paga `minRewardRisk` veces lo arriesgado. */
  RR: 'RR',
  /** No llega a los mínimos del venue. */
  MINIMO: 'MINIMO',
  /** Ni el apalancamiento mínimo cabe en el margen permitido. */
  APALANCAMIENTO: 'APALANCAMIENTO',
  /** La liquidación no queda estrictamente detrás del stop. */
  LIQUIDACION: 'LIQUIDACION',
  /** Lo perdido hoy no deja sitio. */
  TOPE_DIARIO: 'TOPE_DIARIO',
  /** No hay margen libre. */
  SIN_MARGEN: 'SIN_MARGEN',
  /** Quien decide dijo que no. */
  NO_OPERAR: 'NO_OPERAR',
  /** Entorno equivocado: además arma el enfriado. */
  ENTORNO: 'ENTORNO',
  /** La confianza no llega al mínimo del dueño. */
  CONFIANZA: 'CONFIANZA',
  /** El enrutado dice que sí pero una puerta de contexto lo veta. */
  DESACUERDO: 'DESACUERDO',
  /** Ninguna celda de la matriz era viable. */
  OFERTA: 'OFERTA',
} as const;
export type MotivoTrader = (typeof MotivoTrader)[keyof typeof MotivoTrader];

/** Una celda de la matriz: una operación entera, valorada y ya validada. */
export interface EsqueletoTrader {
  stop: BucketStop;
  objetivo: BucketObjetivo;
  viable: boolean;
  motivo: MotivoTrader | null;
  /** La referencia y el tope de la IOC de entrada. */
  entradaReferencia: string;
  entradaTope: string;
  precioStop: string;
  precioObjetivo: string;
  /** Los números solo existen si la celda es viable. */
  cantidad: string | null;
  nocional: string | null;
  apalancamiento: number | null;
  perdidaAlStop: string | null;
  perdidaPorUnidad: string | null;
  liquidacion: string | null;
  /** Distancia del stop a la entrada, en tanto por uno. */
  distanciaStop: number;
  /** Parte del riesgo que se llevan comisiones y deslizamiento. */
  costeR: number;
  /** El objetivo, en veces el coste de ida y vuelta. */
  multiploCoste: number;
  rNeto: number;
  aciertoEquilibrio: number | null;
  riesgoPctCapital: number | null;
  /** Si la mitad del tamaño sigue llegando a los mínimos del venue. */
  medioViable: boolean;
}

/** Los rasgos de la vela, tal y como los mide el motor. Todos adimensionales. */
export interface SenalTrader {
  /** Borde tocado: `LONG` si fue el de abajo. `null` si no hubo toque. */
  lado: PositionSide | null;
  /** Posición dentro de la banda, de 0 (borde inferior) a 1 (superior). */
  porcentajeB: number;
  /** Distancia del cierre a la media, en ATR(15m). */
  estiramientoAtr: number;
  anchuraAtr: number;
  anchuraPct: number;
  /** Fracción de cierres dentro de la banda en la ventana. */
  contencion: number;
  cruces: number;
  mediaVidaVelas: number | null;
  /** Desplazamiento de la media por vela, en ATR. */
  derivaMediaAtr: number;
  mechaFraccion: number;
  cierreEnMitad: boolean;
  rsi2: number;
  rsi14: number;
  divergencia: boolean;
  volumenRatio: number;
  velasDesdeUltimoToque: number;
  adx1h: number;
  chop1h: number;
  /** Coste de ida y vuelta en unidades de precio. */
  idaVueltaPrecio: number;
  spreadBps: number;
  evidencia: Evidencia;
  /**
   * Las tasas medidas de toques comparables, por triple barrera.
   *
   * Probando el modelo con BTC real se vio que sin esto la pregunta del
   * histórico se quedaba clavada en 0,2-0,36: se le estaba pidiendo juzgar una
   * evidencia que no se le daba. `null` cuando no hay muestra suficiente.
   */
  tasas: TasasBase | null;
}

/** La oferta de una vela: la señal y las nueve celdas. */
export interface EspacioTrader {
  version: 1;
  barT: number;
  generadaEn: number;
  senal: SenalTrader;
  lado: PositionSide | null;
  /** Los niveles de la banda al ofrecer, que es de lo que cuelga la invalidación. */
  banda: { superior: string; media: string; inferior: string; refT: number };
  esqueletos: readonly EsqueletoTrader[];
  /** Identifica la oferta: la misma vela y las mismas celdas viables. */
  huella: string;
}

/** Una elección con su distribución y su confianza, como la devuelve el proveedor. */
export interface EleccionConfianza<T extends string> {
  clave: T;
  probabilidades: Readonly<Record<string, number>>;
  /** De 0 a 1: cuánto se concentra la distribución en una sola opción. */
  confianza: number;
}

/**
 * Lo que devuelve quien decide, en crudo.
 *
 * Los `number` de aquí son **opiniones**, no cantidades: probabilidades y
 * confianzas. No los toca nadie aguas abajo — pasan por `cuantiza()` a una
 * enumeración y se guardan en crudo solo como constancia. Ninguno llega jamás a
 * `Decimal` ni a `precision.ts`.
 */
export interface RespuestaTrader {
  accion: EleccionConfianza<AccionTrader>;
  /** ¿El mercado oscila alrededor de un centro? Probabilidad de que sí. */
  regimenRevierte: number;
  /** ¿La vela del toque parece agotamiento? Probabilidad de que sí. */
  toqueAgotamiento: number;
  /** ¿El histórico apoya este tipo de toque? Probabilidad de que sí. */
  historialApoya: number;
  /** ¿Hay razón clara para preferir un stop concreto? Si no, manda el defecto. */
  stopDeterminado: number;
  stop: EleccionConfianza<BucketStop>;
  objetivoDeterminado: number;
  objetivo: EleccionConfianza<BucketObjetivo>;
}

/**
 * La respuesta ya cuantizada: **solo enumeraciones**.
 *
 * Es lo único que ve `construirOperacionTrader`. La frontera entre los números
 * de opinión del proveedor y el resto del sistema está en `cuantiza()`, y hay
 * un test que lo comprueba.
 */
export interface VeredictoTrader {
  accion: AccionTrader;
  confianza: NivelConfianza;
  /** Las tres puertas de contexto están de acuerdo con el enrutado. */
  acuerdo: boolean;
  stop: BucketStop;
  objetivo: BucketObjetivo;
  tamano: TamanoOperacion;
}

/** Un objetivo del plan: cuánto se cierra y a qué precio. */
export interface ObjetivoTrader {
  precio: string;
  cantidad: string;
}

/** La operación construida: el único sitio donde las enumeraciones son números. */
export interface PlanTrader {
  intentId: string;
  lado: PositionSide;
  veredicto: VeredictoTrader;
  entradaReferencia: string;
  entradaTope: string;
  stop: string;
  objetivos: ObjetivoTrader[];
  cantidad: string;
  apalancamiento: number;
  nocional: string;
  riesgo: string;
  rNeto: number;
  liquidacionEstimada: string | null;
  huella: string;
  barT: number;
  /** La banda al entrar, para la invalidación. */
  banda: { superior: string; media: string; inferior: string; refT: number };
  /** La salida por tiempo: a partir de aquí se cierra a mercado. */
  venceEn: number;
  distanciaStop: number;
}

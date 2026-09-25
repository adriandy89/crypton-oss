import { DestroyRef, inject, signal, type Signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import type { EleccionAgente, ErrorAgente, InsigniaAgente, LimitesAgente } from '@crypton/shared';
import type { BadgeTone } from '../../shared/ui/ui-badge.component';
import { money, signed } from './format';

/**
 * Los agentes de IA en piezas puras (spec 074): los textos de su vocabulario y
 * lo poco que calcula la pantalla.
 *
 * Lo que decide algo —la pastilla, la tarjeta, el R— sale ya hecho del
 * servidor o de `shared`, con sus tests; aquí solo se le pone texto. Todo lo
 * que llega es texto de una columna que puede crecer antes que la app: un valor
 * que no está en los mapas se enseña tal cual (`textoDe`).
 */

export { textoDe } from './canal-ia';

type Mapa = Readonly<Record<string, string>>;

/** La pastilla de un agente: su texto, su tono y, si no abre nada, por qué. */
export const INSIGNIA_AGENTE: Readonly<
  Record<InsigniaAgente, { texto: string; tono: BadgeTone; porQue: string }>
> = {
  ACTIVO: { texto: 'activo', tono: 'up', porQue: '' },
  REGLAS: { texto: 'reglas', tono: 'brand', porQue: '' },
  MIDE: { texto: 'solo mide', tono: 'neutral', porQue: 'analiza y mide sin proponer nada' },
  DORMIDO: { texto: 'dormido', tono: 'warn', porQue: 'demasiados fallos del modelo seguidos' },
  SIN_MODELO: {
    texto: 'sin modelo',
    tono: 'warn',
    porQue: 'el servidor no tiene clave del modelo',
  },
  CORTADO: {
    texto: 'entradas cortadas',
    tono: 'warn',
    porQue: 'el interruptor global está cerrado',
  },
  APAGADO: { texto: 'apagado', tono: 'warn', porQue: 'los agentes están apagados en el servidor' },
  PAUSADO: { texto: 'en pausa', tono: 'warn', porQue: 'no abre nada; lo abierto sigue su curso' },
  ARCHIVADO: { texto: 'archivado', tono: 'neutral', porQue: 'retirado' },
};

export const MOTIVO_PAUSA: Mapa = {
  MANUAL: 'lo pausaste tú',
  PERDIDA_DIARIA: 'tocó su pérdida diaria',
  KILL_SWITCH: 'el kill switch de la cuenta',
  CUENTA: 'la cuenta dejó de servir',
};

export const FAMILIA: Mapa = {
  TENDENCIA: 'tendencia',
  RUPTURA: 'ruptura',
  REVERSION: 'reversión',
};

export const FAMILIA_AYUDA: Mapa = {
  TENDENCIA: 'Retroceso a la media en una tendencia con fuerza.',
  RUPTURA: 'Salida de un rango tras una compresión.',
  REVERSION: 'Toque de banda en un rango, con el RSI en un extremo.',
};

export const ladoTexto = (lado: string): string => (lado === 'SHORT' ? 'corto' : 'largo');

export const ESTADO_PROPUESTA: Mapa = {
  PROPUESTA: 'esperando',
  APROBANDO: 'abriéndose',
  EJECUTANDO: 'entrando',
  ABIERTA: 'abierta',
  CERRADA: 'cerrada',
  SIN_ENTRADA: 'no entró',
  RECHAZADA: 'descartada',
  CADUCADA: 'caducada',
  DESCARTADA: 'retirada',
  FALLIDA: 'fallida',
  SOMBRA: 'solo medida',
};

const TONO_PROPUESTA: Readonly<Partial<Record<string, BadgeTone>>> = {
  PROPUESTA: 'brand',
  APROBANDO: 'brand',
  EJECUTANDO: 'brand',
  ABIERTA: 'up',
  FALLIDA: 'down',
};

/** El tono de la pastilla de una propuesta: lo que espera o vive resalta; lo terminado, no. */
export const tonoPropuesta = (estado: string): BadgeTone => TONO_PROPUESTA[estado] ?? 'neutral';

export const MOTIVO_PROPUESTA: Mapa = {
  CADUCIDAD: 'nadie la aprobó a tiempo',
  PRECIO_PASO_STOP: 'al aprobarla, el precio ya había pasado el stop',
  PRECIO_MOVIDO: 'al aprobarla, el precio se había movido demasiado',
  LIMITES: 'al aprobarla, ya no cabía en los límites',
  PAR_OCUPADO: 'el par ya tenía una operación',
  CAPACIDAD: 'no había sitio para otra operación',
  AGENTE_CAMBIADO: 'el agente se editó',
  AGENTE_PAUSADO: 'el agente se pausó',
  INTERRUPTOR: 'las entradas estaban cortadas',
  DUENO: 'el dueño ya no es administrador',
  CUENTA: 'la cuenta no se podía usar',
  IA_APAGADA: 'los agentes estaban apagados en el servidor',
  SIN_DATOS: 'faltaban datos del mercado',
  CREAR: 'el bot no se pudo crear',
  ARRANCAR: 'el bot no arrancó',
  PERSONA: 'la descartaste',
  SIN_LLENADO: 'la entrada no se llenó',
  SOLO_MEDIR: 'el agente solo mide',
  SOLO_SOMBRA: 'el servidor está en modo sombra',
  SOLO_SIMULACION: 'el servidor solo deja operar en simulación',
  KILL_SWITCH: 'el kill switch de la cuenta',
};

export const SALIDA: Mapa = {
  OBJETIVO: 'objetivo',
  STOP: 'stop',
  STOP_PROTEGIDO: 'stop protegido',
  TIEMPO: 'tiempo',
  SEGUIMIENTO: 'seguimiento',
  SEGURIDAD: 'seguridad',
  MANUAL: 'a mano',
  LIQUIDACION: 'liquidación',
  FUERA: 'fuera del bot',
};

export const RESULTADO_HIPOTETICO: Mapa = {
  OBJETIVO: 'habría llegado al objetivo',
  STOP: 'habría saltado el stop',
  TIEMPO: 'habría cerrado por tiempo',
};

export const MOTIVO_RONDA: Mapa = {
  IA_APAGADA: 'agentes apagados en el servidor',
  DUENO: 'el dueño ya no es administrador',
  AGENTE: 'el agente no está activo',
  DORMIDO: 'dormido tras fallos del modelo',
  INTERRUPTOR: 'entradas cortadas',
  REDIS: 'sin Redis no se consulta',
  CUENTA: 'la cuenta no se puede usar',
  PERDIDA_DIARIA: 'tocó la pérdida diaria',
  OPERACIONES_DIA: 'ya hizo sus operaciones de hoy',
  RACHA: 'pausa tras una racha de pérdidas',
  CAPACIDAD: 'sin sitio para otra operación',
  LIMITES_USUARIO: 'tus límites de riesgo no dejan más bots',
  SIN_PARES: 'todos sus pares están ocupados',
  SIN_DATOS: 'sin datos frescos del mercado',
  SIN_CANDIDATOS: 'ninguna operación posible',
  HUELLA: 'lo mismo que la vez anterior',
  CUPO_AGENTE: 'sin consultas hoy para este agente',
  CUPO_GLOBAL: 'sin consultas hoy en la plataforma',
  GASTO: 'sin presupuesto del modelo hoy',
  NINGUNA: 'prefirió no operar',
  OFERTA: 'lo elegido ya no valía',
  MODELO: 'el modelo no respondió',
  CONTRATO: 'respuesta fuera del contrato',
  BOT: 'el bot no está en marcha',
  PENDIENTE: 'ya había una acción esperando',
  PROPUESTA: 'propuso una operación',
  SOMBRA: 'midió una operación',
  MANTENER: 'mantener',
  ACCION: 'propuso o aplicó un cambio',
  ERROR: 'error inesperado',
};

/** Por qué un par o un candidato no ofreció nada. */
export const DESCARTE: Mapa = {
  OCUPADO: 'ocupado',
  SIN_MERCADO: 'no está en el catálogo',
  SIN_TRAMOS: 'sin tramos de apalancamiento',
  ESPERA_STOP: 'en espera tras un stop',
  SIN_DATOS: 'sin datos',
  SIN_PRECIO: 'sin precio',
  VELAS_ANTIGUAS: 'velas atrasadas',
  SPREAD: 'spread ancho',
  SIN_OPCION_VIABLE: 'ninguna opción viable',
  ESPERANZA_NEGATIVA: 'histórico en contra',
};

export const ACCION: Mapa = {
  MANTENER: 'mantener',
  PROTEGER: 'stop a la entrada',
  ASEGURAR_MEDIO_R: 'asegurar ½ R',
  ASEGURAR_UN_R: 'asegurar 1 R',
  REDUCIR_TERCIO: 'reducir un tercio',
  REDUCIR_MITAD: 'reducir a la mitad',
  CERRAR: 'cerrar',
};

export const ESTADO_ACCION: Mapa = {
  PROPUESTA: 'esperando',
  APLICANDO: 'aplicándose',
  APLICADA: 'aplicada',
  RECHAZADA: 'descartada',
  CADUCADA: 'caducada',
  DESCARTADA: 'ya no hacía falta',
  FALLIDA: 'fallida',
  SOMBRA: 'solo medida',
};

export const DISPARADOR: Mapa = {
  INTERVALO: 'vela cerrada',
  OBJETIVO_1: 'primer objetivo',
  TESIS_ROTA: 'idea rota',
  REGIMEN: 'cambio de régimen',
  MANUAL: 'a mano',
};

export const TESIS: Mapa = { INTACTA: 'intacta', DEBILITADA: 'debilitada', ROTA: 'rota' };

export const MOTIVO_MODELO: Mapa = {
  TENDENCIA_CLARA: 'tendencia clara',
  TENDENCIA_DEBIL: 'tendencia débil',
  RUPTURA_LIMPIA: 'ruptura limpia',
  RUPTURA_DUDOSA: 'ruptura dudosa',
  RANGO_CLARO: 'rango claro',
  RANGO_DUDOSO: 'rango dudoso',
  MOMENTO_FAVORABLE: 'momento a favor',
  MOMENTO_AGOTADO: 'momento agotado',
  EVIDENCIA_FAVORABLE: 'histórico a favor',
  EVIDENCIA_ESCASA: 'poco histórico',
  EVIDENCIA_DESFAVORABLE: 'histórico en contra',
  RECOMPENSA_BUENA: 'buena recompensa',
  RECOMPENSA_POBRE: 'recompensa pobre',
  COSTE_ALTO: 'coste alto',
  VOLATILIDAD_ALTA: 'volatilidad alta',
  DIA_TENSO: 'día tenso',
  // Los del seguimiento.
  TESIS_INTACTA: 'idea intacta',
  TESIS_DEBILITADA: 'idea debilitada',
  TESIS_ROTA: 'idea rota',
  MOMENTO_A_FAVOR: 'momento a favor',
  MOMENTO_EN_CONTRA: 'momento en contra',
  OBJETIVO_CERCA: 'objetivo cerca',
  BENEFICIO_EN_RIESGO: 'beneficio en riesgo',
  TIEMPO_AGOTANDOSE: 'se acaba el tiempo',
  REGIMEN_CAMBIADO: 'régimen cambiado',
};

export const RIESGO_MODELO: Mapa = {
  FALSA_RUPTURA: 'falsa ruptura',
  GIRO_DE_TENDENCIA: 'giro de tendencia',
  RUPTURA_DEL_RANGO: 'ruptura del rango',
  LIQUIDEZ: 'liquidez',
  VOLATILIDAD: 'volatilidad',
  RACHA: 'racha de pérdidas',
  TOPE_DIARIO_CERCA: 'tope diario cerca',
  FUNDING: 'funding',
  CORRELACION: 'correlación',
};

const STOP: Mapa = { AJUSTADO: 'ajustado', NORMAL: 'normal', AMPLIO: 'amplio' };
const OBJETIVO: Mapa = { CERCANO: 'cercano', ESCALONADO: 'escalonado', LEJANO: 'lejano' };
const NIVEL: Mapa = { BAJA: 'baja', MEDIA: 'media', ALTA: 'alta' };
const TAMANO: Mapa = { COMPLETO: 'completo', MEDIO: 'medio' };

/** «stop normal · objetivo escalonado · apalancamiento bajo · tamaño completo · confianza alta». */
export function textoEleccionAgente(e: EleccionAgente | null): string {
  if (!e) return '';
  return [
    `stop ${STOP[e.stop] ?? e.stop}`,
    `objetivo ${OBJETIVO[e.objetivo] ?? e.objetivo}`,
    `apalancamiento ${NIVEL[e.apalancamiento] ?? e.apalancamiento}`,
    `tamaño ${TAMANO[e.tamano] ?? e.tamano}`,
    `confianza ${NIVEL[e.confianza] ?? e.confianza}`,
  ].join(' · ');
}

/** Lo que hace cada modo con cada clase de acción (`AiMode`). */
export const AUTONOMIA: Readonly<
  Record<'entrar' | 'reducir' | 'cerrar', readonly { valor: string; texto: string }[]>
> = {
  entrar: [
    { valor: 'MANUAL', texto: 'Te lo propone' },
    { valor: 'AUTO', texto: 'Entra solo' },
    { valor: 'OFF', texto: 'Solo mide' },
  ],
  reducir: [
    { valor: 'AUTO', texto: 'Lo hace solo' },
    { valor: 'MANUAL', texto: 'Te lo propone' },
    { valor: 'OFF', texto: 'Nunca' },
  ],
  cerrar: [
    { valor: 'MANUAL', texto: 'Te lo propone' },
    { valor: 'AUTO', texto: 'Cierra solo' },
    { valor: 'OFF', texto: 'Nunca' },
  ],
};

/** «+1,25 R», con signo; «—» sin dato. */
export function rTexto(r: number | null | undefined, decimales = 2): string {
  if (r === null || r === undefined || !Number.isFinite(r)) return '—';
  return `${signed(r, decimales)} R`;
}

/** «0,50 %», sin signo: un porcentaje que no es un resultado (el riesgo, un límite). */
export const porcentaje = (x: number | string | null | undefined, decimales = 2): string =>
  x === null || x === undefined || x === '' ? '—' : `${money(x, decimales)} %`;

export const tonoR = (r: number | null | undefined): BadgeTone =>
  r === null || r === undefined || r === 0 ? 'neutral' : r > 0 ? 'up' : 'down';

/** «caduca en 12 min», «caduca en 40 s» o «caducada». */
export function quedaTexto(caducaEn: string, ahora: number): string {
  const ms = Date.parse(caducaEn) - ahora;
  if (!(ms > 0)) return 'caducada';
  if (ms < 60_000) return `caduca en ${Math.ceil(ms / 1000)} s`;
  return `caduca en ${Math.ceil(ms / 60_000)} min`;
}

/**
 * Los errores de un 400 de la API de agentes, cada uno con su campo. Vacío si
 * el error no es de esa forma: entonces lo que se enseña es `errorText`.
 */
export function erroresAgente(e: unknown): ErrorAgente[] {
  if (!(e instanceof HttpErrorResponse) || e.status !== 400) return [];
  const cuerpo: unknown = e.error;
  if (typeof cuerpo !== 'object' || cuerpo === null) return [];
  const errores = (cuerpo as { errores?: unknown }).errores;
  if (!Array.isArray(errores)) return [];
  return errores.filter(
    (x): x is ErrorAgente =>
      typeof x === 'object' &&
      x !== null &&
      typeof (x as ErrorAgente).campo === 'string' &&
      typeof (x as ErrorAgente).mensaje === 'string',
  );
}

/**
 * Un reloj para las cuentas atrás: la hora de ahora, al paso que se pida. Se
 * llama en el constructor de un componente y se para con él.
 */
export function reloj(pasoMs = 15_000): Signal<number> {
  const ahora = signal(Date.now());
  const id = setInterval(() => ahora.set(Date.now()), pasoMs);
  inject(DestroyRef).onDestroy(() => clearInterval(id));
  return ahora.asReadonly();
}

/**
 * La ayuda de cada límite en el editor. El nombre sale de strategy-core
 * (`NOMBRES_LIMITES_AGENTE`), el mismo que usan los mensajes de validación.
 */
export const AYUDA_LIMITES: Readonly<Record<keyof LimitesAgente, string>> = {
  capital:
    'La base de todos los porcentajes: lo que le asignas al agente, no el saldo de la cuenta.',
  riesgoPct: 'Lo que se pierde si salta el stop de una operación, con costes.',
  perdidaDiariaPct:
    'Contando al stop lo que está abierto. Al tocarla, el agente se pausa hasta que lo reanudes.',
  maxVivas: 'Operaciones abiertas a la vez, como mucho.',
  maxOperacionesDia: 'Operaciones abiertas en un día UTC, como mucho.',
  apalancamientoMax: 'El tope de cada operación, aislada. El motor elige uno igual o menor.',
  margenPct: 'El margen aislado de una operación: lo que se pierde si salta la liquidación.',
  maxStopPct: 'La distancia máxima del stop a la entrada.',
  maxCosteR: 'Lo más que pueden llevarse comisiones y deslizamiento de 1 R.',
  minObjetivoCoste: 'El primer objetivo, a tantas veces el coste de ida y vuelta como poco.',
  minObjetivoPct: 'Y a este porcentaje de la entrada como poco.',
  minRR: 'El beneficio neto entre el riesgo, como poco.',
  fraccionTp1Pct: 'La parte de la posición que sale en el primer objetivo.',
  breakevenTrasTp1: 'Tras el primer objetivo, el stop pasa a la entrada más los costes.',
  maxVelasOperacion: 'Pasadas estas velas desde la entrada, se cierra a mercado.',
  esperaStopMin: 'Tras un stop, minutos sin volver a entrar en ese par.',
  maxPerdidasSeguidas: 'Pérdidas seguidas que cortan las entradas del agente…',
  esperaRachaMin: '…durante estos minutos.',
  consultasDia: 'Consultas al modelo al día. El servidor tiene su propio tope, y manda el menor.',
  gastoDiaUsd: 'El gasto en el modelo al día, en dólares.',
};

/** Los límites que son una cuenta —operaciones, minutos, velas—: viajan como número entero. */
export const LIMITES_ENTEROS: readonly {
  [K in keyof LimitesAgente]: LimitesAgente[K] extends number ? K : never;
}[keyof LimitesAgente][] = [
  'maxVivas',
  'maxOperacionesDia',
  'apalancamientoMax',
  'minObjetivoCoste',
  'esperaStopMin',
  'maxPerdidasSeguidas',
  'esperaRachaMin',
  'consultasDia',
  'maxVelasOperacion',
];

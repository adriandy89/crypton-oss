import {
  D,
  type AccionSeguimiento,
  type NivelConfianza,
  type OpcionSeguimiento,
  type PlanAgente,
} from '@crypton/shared';

/**
 * Los textos de los avisos de los agentes (spec 074, R-26). A diferencia de lo
 * que ve el modelo, estos los lee una persona antes de pulsar «Ejecutar», así
 * que llevan los precios y el riesgo en dinero: entrada, stop, objetivos, R,
 * cuánto se pierde si salta el stop y si es dinero de verdad.
 */

const LADO = { LONG: 'largo', SHORT: 'corto' } as const;

/** Un precio tal y como está en el plan: ya va en la retícula del venue. */
const precio = (p: string): string => D(p).toFixed();

/** La distancia del stop a la entrada, en % y con signo, como la lee una persona. */
function distanciaStop(plan: Pick<PlanAgente, 'entradaTope' | 'stop'>): string {
  const entrada = D(plan.entradaTope);
  if (!entrada.gt(0)) return '';
  const d = D(plan.stop).minus(entrada).div(entrada).mul(100);
  return ` (${d.gte(0) ? '+' : ''}${d.toFixed(2)} %)`;
}

export interface OpcionesTextoPropuesta {
  quote: string;
  /** Dinero de verdad: se dice al principio. */
  real: boolean;
  confianza: NivelConfianza;
  /** La frase del modelo, si decidió él. Texto ajeno. */
  texto: string | null;
  /** Lo que vive la propuesta, en minutos; null si se ejecuta sola. */
  vidaMin: number | null;
}

/** El mensaje de una propuesta de entrada. */
export function textoPropuesta(plan: PlanAgente, o: OpcionesTextoPropuesta): string {
  const cabeza =
    `${o.vidaMin === null ? 'Automático: abre ' : ''}${o.real ? 'DINERO REAL · ' : ''}` +
    `${plan.simbolo} ${LADO[plan.lado]} (${plan.familia}), confianza ${o.confianza}`;
  const objetivos = plan.objetivos.map((x) => precio(x.precio)).join(' / ');
  const lineas = [
    cabeza,
    `Entrada hasta ${precio(plan.entradaTope)} · stop ${precio(plan.stop)}${distanciaStop(plan)}`,
    `Objetivo${plan.objetivos.length > 1 ? 's' : ''} ${objetivos} · R neto ${plan.rNeto.toFixed(2)}`,
    `Riesgo ${D(plan.riesgo).toFixed(2)} ${o.quote} (${plan.riesgoPctCapital.toFixed(2)} % del ` +
      `capital) · ${plan.apalancamiento}x aislado`,
  ];
  if (o.texto) lineas.push(`«${o.texto}»`);
  if (o.vidaMin !== null) lineas.push(`Caduca en ${o.vidaMin} min.`);
  return lineas.join('\n');
}

/** Qué hace cada acción, para una persona. */
const ACCIONES: Readonly<Record<AccionSeguimiento, string>> = {
  MANTENER: 'mantener',
  PROTEGER: 'proteger la entrada',
  ASEGURAR_MEDIO_R: 'asegurar medio R',
  ASEGURAR_UN_R: 'asegurar 1 R',
  REDUCIR_TERCIO: 'reducir un tercio',
  REDUCIR_MITAD: 'reducir la mitad',
  CERRAR: 'cerrar la operación',
};

export interface OpcionesTextoAccion {
  simbolo: string;
  lado: 'LONG' | 'SHORT';
  /** La frase del modelo, si decidió él. Texto ajeno. */
  texto: string | null;
  /** Lo que vive la propuesta, en minutos; null si ya se aplicó. */
  vidaMin: number | null;
}

/** El mensaje de una acción de seguimiento, propuesta o aplicada. */
export function textoAccion(opcion: OpcionSeguimiento, o: OpcionesTextoAccion): string {
  const que = ACCIONES[opcion.accion];
  const detalle = opcion.stopNuevo
    ? ` · stop a ${precio(opcion.stopNuevo)}`
    : opcion.posicionNueva && opcion.posicionNueva !== '0'
      ? ` · queda ${D(opcion.posicionNueva).toFixed()} de posición`
      : '';
  const lineas = [
    `${o.simbolo} ${LADO[o.lado]}: ${o.vidaMin === null ? 'aplicado' : 'propone'} ${que}${detalle}`,
    `Si después salta el stop, se pierde ${opcion.riesgoRestanteR.toFixed(2)} R.`,
  ];
  if (o.texto) lineas.push(`«${o.texto}»`);
  if (o.vidaMin !== null) lineas.push(`Caduca en ${o.vidaMin} min.`);
  return lineas.join('\n');
}

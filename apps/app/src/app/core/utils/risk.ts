/**
 * El semáforo de la distancia a liquidación, en UN sitio.
 *
 * Tres pantallas y un componente lo pintan, y con los umbrales repartidos por
 * ellas se acaba con tres semáforos distintos para el mismo riesgo —que es lo
 * que pasó: la barra se ponía en rojo a partir del 10 % y la cifra de al lado
 * por debajo del 10 %, y a un 10,00 % exacto no coincidían.
 *
 * Los umbrales son los de siempre en la app (`bots-list`, `ui-risk-meter`): por
 * debajo del 25 % ámbar, por debajo del 10 % rojo. La barra satura al 40 %,
 * también como `ui-risk-meter`: más allá de eso la distancia deja de ser
 * información y pasa a ser una barra llena.
 */
export const LIQ_WARN_PCT = 25;
export const LIQ_DANGER_PCT = 10;
export const LIQ_SATURATION_PCT = 40;

/**
 * Los parámetros de `ui-meter` para pintar la distancia. `invert` porque aquí
 * MÁS es mejor; los umbrales van en la escala del nivel invertido
 * (`1 − d / 40`): 1 − 25/40 = 0,375 y 1 − 10/40 = 0,75. El componente compara
 * con `>` estricto, así que a un 10,00 % exacto barra y cifra dicen lo mismo.
 */
export const LIQ_METER = {
  total: LIQ_SATURATION_PCT,
  invert: true,
  warnAt: 1 - LIQ_WARN_PCT / LIQ_SATURATION_PCT,
  dangerAt: 1 - LIQ_DANGER_PCT / LIQ_SATURATION_PCT,
} as const;

/**
 * La distancia como número para la barra y el umbral. `null` si no aplica, y
 * null y no cero: un cero se leería como «a punto de liquidar».
 */
export function liqNum(pct: string | number | null | undefined): number | null {
  if (pct === null || pct === undefined || pct === '') return null;
  const d = Number(pct);
  return Number.isFinite(d) ? d : null;
}

/** El tono de la cifra: el mismo que devuelve `pnlColor()`, para las clases `c-*`. */
export function liqTone(
  pct: string | number | null | undefined,
): 'success' | 'warning' | 'danger' | 'medium' {
  const d = liqNum(pct);
  if (d === null) return 'medium';
  return d < LIQ_DANGER_PCT ? 'danger' : d < LIQ_WARN_PCT ? 'warning' : 'success';
}

/**
 * El semáforo del canal con IA no puede ser el de la distancia.
 *
 * A 25x la liquidación está SIEMPRE a un 2-4 % del precio, así que la barra
 * salía siempre en rojo y el aviso «a un 3 % de la liquidación» aparecía en
 * cada operación normal: dejaba de informar de nada (spec 062, F-44). Lo que
 * mira el motor en las estrategias con apalancamiento por operación es el
 * CAMINO recorrido de la entrada a la liquidación, y cierra a dos tercios. Eso
 * es lo que se pinta, con esos mismos umbrales.
 */
export const liqPorCamino = (strategy: string | null | undefined): boolean =>
  // La operación de un agente mide su liquidación igual: contra su stop (spec 074).
  strategy === 'AI_CHANNEL' || strategy === 'AGENT_TRADE';

export const CAMINO_WARN_PCT = 100 / 3;
export const CAMINO_DANGER_PCT = 200 / 3;

export const CAMINO_METER = {
  total: 100,
  invert: false,
  warnAt: CAMINO_WARN_PCT / 100,
  dangerAt: CAMINO_DANGER_PCT / 100,
} as const;

/** El camino recorrido de la entrada a la liquidación, en % (0-100). */
export function caminoNum(
  entrada: string | number | null | undefined,
  liquidacion: string | number | null | undefined,
  marca: string | number | null | undefined,
): number | null {
  const e = Number(entrada);
  const l = Number(liquidacion);
  const m = Number(marca);
  if (![e, l, m].every((n) => Number.isFinite(n) && n > 0)) return null;
  const camino = Math.abs(e - l);
  if (camino <= 0) return null;
  // La liquidación por debajo de la entrada es un largo; por encima, un corto.
  const recorrido = l < e ? e - m : m - e;
  return Math.min(100, Math.max(0, (recorrido / camino) * 100));
}

/** El tono del camino: verde hasta un tercio, ámbar hasta dos, rojo pasados. */
export function caminoTone(pct: number | null): 'success' | 'warning' | 'danger' | 'medium' {
  if (pct === null) return 'medium';
  return pct > CAMINO_DANGER_PCT ? 'danger' : pct > CAMINO_WARN_PCT ? 'warning' : 'success';
}

/** El camino de un bot, o null si su riesgo se mide con la distancia de siempre. */
export function caminoDeBot(b: {
  strategy?: string | null;
  averageEntry?: string | null;
  liquidationPrice?: string | null;
  markPrice?: string | null;
  positionValue?: string | null;
  positionQty?: string | null;
}): number | null {
  if (!liqPorCamino(b.strategy)) return null;
  // La marca: la del snapshot si viene y, si no, la que se deduce del valor de
  // la posición (|cantidad| × marca), que es lo que sirve el listado.
  const directa = Number(b.markPrice);
  let marca: number | null = Number.isFinite(directa) && directa > 0 ? directa : null;
  if (marca === null) {
    const valor = Number(b.positionValue);
    const qty = Math.abs(Number(b.positionQty));
    marca = Number.isFinite(valor) && Number.isFinite(qty) && qty > 0 ? valor / qty : null;
  }
  return caminoNum(b.averageEntry, b.liquidationPrice, marca);
}

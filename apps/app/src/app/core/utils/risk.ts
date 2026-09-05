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

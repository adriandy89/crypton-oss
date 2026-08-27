import type { OverlayKind } from './bot-overlay';

/**
 * Puente entre los tokens de `theme/variables.scss` y las opciones del motor
 * grafico.
 *
 * Los colores se LEEN del CSS en tiempo de ejecucion en vez de repetirse aqui.
 * Una segunda paleta escrita a mano es una paleta que se queda vieja: en cuanto
 * alguien tocara --pnl-up para ajustar el verde, el grafico seguiria pintando
 * el anterior y nadie se enteraria hasta verlos juntos.
 */

/** Lee una custom property del :root; devuelve `fallback` si no existe. */
function token(name: string, fallback: string): string {
  if (typeof getComputedStyle !== 'function') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

export interface ChartPalette {
  text: string;
  grid: string;
  border: string;
  crosshair: string;
  up: string;
  down: string;
  /** Marca. NO se usa para ninguna senal de precio; ver la nota de abajo. */
  brand: string;
  surface: string;
}

/**
 * La paleta del grafico.
 *
 * El violeta de marca (--brand) esta fuera de las senales a proposito.
 * `variables.scss` documenta que --ion-color-primary y --ion-color-success
 * llegaron a ser el mismo #2dd4a7 y un boton de marca era indistinguible de una
 * cifra en ganancia; en un grafico lleno de verde y rojo con significado, meter
 * un tercer color de marca reproduce el mismo problema.
 */
export function chartPalette(): ChartPalette {
  return {
    text: token('--text-2', '#9d98c0'),
    grid: token('--border-subtle', '#2e2b52'),
    border: token('--border-strong', '#413c6e'),
    crosshair: token('--brand-2', '#22d3ee'),
    up: token('--pnl-up', '#2dd4a7'),
    down: token('--pnl-down', '#f0616d'),
    brand: token('--brand', '#8b5cf6'),
    surface: token('--surface-base', '#141328'),
  };
}

/**
 * Colores de la capa de un bot sobre el grafico.
 *
 * Se teclea como `Record<OverlayKind, string>` y NO como una interfaz de campos
 * sueltos: asi, añadir un tipo de linea al overlay sin darle color es un error
 * de compilacion y no una linea que sale de color `undefined` en produccion.
 */
export type OverlayPalette = Record<OverlayKind, string> & {
  /** Texto sobre los rellenos claros de las etiquetas del eje. */
  onLight: string;
};

/**
 * Reparto de colores de la capa del bot.
 *
 * Las tres reglas que lo gobiernan, en orden de importancia:
 *
 *   1. VERDE ES GANAR Y ROJO ES PERDER, en el grafico igual que en el resto de
 *      la app. Por eso el take profit sigue siendo verde aunque sea una venta:
 *      es la salida en ganancia, y repintarlo de rojo por el lado de la orden
 *      invertiria la lectura que vale en las otras catorce pantallas.
 *   2. EL MOTIVO DE UNA LINEA SE DISTINGUE SIN COLOR. Cada senal lleva ademas
 *      su trazo —continuo, discontinuo, guion largo, punteado— porque una de
 *      cada doce personas no separa el rojo del verde, y porque en una captura
 *      en escala de grises el color no existe.
 *   3. EL STOP LOSS NO PUEDE PARECERSE A LA LIQUIDACION. Antes eran los dos
 *      rojo continuo: identicas. Y son justo las dos que peor sale confundir —
 *      una la pone el bot para protegerte y la otra te la ejecuta el exchange.
 *      El stop pasa al ambar, que ya es el tercer token de senal financiera del
 *      tema (`--signal-warn`), no es el violeta de marca, y con verde y rojo
 *      forma la triada segura para protanopia y deuteranopia.
 *
 * El violeta de marca (--brand) sigue fuera de todo esto; ver la nota de
 * `chartPalette()`.
 */
export function overlayPalette(p = chartPalette()): OverlayPalette {
  return {
    buy: p.up,
    sell: p.down,
    takeProfit: p.up,
    stopLoss: token('--signal-warn', '#f0b429'),
    average: p.crosshair,
    liquidation: p.down,
    onLight: token('--surface-base', '#141328'),
  };
}

/**
 * El mismo color, atenuado.
 *
 * Lo usan los niveles PLANIFICADOS: lo que los separa de una orden de verdad es
 * la intensidad y el punteado, nunca el tono — un nivel de seguridad planificado
 * sigue siendo una compra y tiene que leerse como tal.
 *
 * Concatena el alfa en hexadecimal en vez de usar `color-mix()` o convertir a
 * rgba: los tokens del tema son hex de seis digitos y el WebView de Android que
 * la app soporta no garantiza `color-mix()`.
 */
export function fade(color: string, alpha: number): string {
  const hex = color.trim();
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return hex;
  const a = Math.round(Math.min(Math.max(alpha, 0), 1) * 255)
    .toString(16)
    .padStart(2, '0');
  return `${hex}${a}`;
}

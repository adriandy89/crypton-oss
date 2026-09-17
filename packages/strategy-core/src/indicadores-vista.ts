import type { Candle } from '@crypton/shared';
import { atrSerie, bollinger, ema, rsi, sma } from './canal/estadistica';
import { serieNumerica } from './canal/numeros';

/**
 * Los indicadores que el gráfico de la app puede pintar sobre una serie de
 * velas (spec 061).
 *
 * Aquí no se calcula nada nuevo: se envuelve la estadística del motor del canal
 * (`canal/estadistica.ts`), que ya está probada con cifras a mano y es la misma
 * con la que el bot DECIDE. Ese es el motivo de que esto viva en un paquete y
 * no en la pantalla: la app no tiene un solo test, así que lo que se puede
 * decidir fuera de la vista se decide fuera (mismo criterio que
 * `shared/candle-paging.ts` y que `lineasDelCanal`).
 *
 * Los parámetros son FIJOS a propósito (spec 061): Bollinger 20 y 2σ, RSI 14,
 * ATR 14. Son los de siempre, los mismos que mira el régimen del canal, y
 * abrirlos a la configuración significaría mandos, estado guardado y una
 * explicación por cada uno para algo que casi nadie cambia.
 *
 * La vela VIVA no entra: llega al gráfico por otro camino y recalcular con cada
 * tick haría bailar la línea sobre una vela que aún no ha cerrado, que es justo
 * lo que la estadística causal del motor evita.
 */

export type ClaveIndicador = 'BOLLINGER' | 'SMA50' | 'EMA20' | 'RSI' | 'ATR';

/** Sobre el precio, o en un panel propio bajo él. */
export type PanelIndicador = 'PRECIO' | 'PROPIO';

export interface FichaIndicador {
  panel: PanelIndicador;
  /** Las líneas que dibuja, por su clave, en el orden en que se pintan. */
  lineas: readonly string[];
  /** Guías horizontales del panel propio; el RSI tiene las suyas en 30 y 70. */
  guias?: readonly number[];
  /** Velas que necesita antes de dar su primer valor; antes de eso, huecos. */
  minimo: number;
}

const PERIODO_BOLLINGER = 20;
const DESVIACIONES_BOLLINGER = 2;
const PERIODO_SMA = 50;
const PERIODO_EMA = 20;
const PERIODO_RSI = 14;
const PERIODO_ATR = 14;

/**
 * `Record` completo y no un `Partial`: añadir una clave sin ficha deja de
 * compilar, que es la misma garantía que usan las guías de estrategia y la
 * paleta de las capas.
 */
export const INDICADORES: Record<ClaveIndicador, FichaIndicador> = {
  BOLLINGER: {
    panel: 'PRECIO',
    lineas: ['superior', 'media', 'inferior'],
    minimo: PERIODO_BOLLINGER,
  },
  SMA50: { panel: 'PRECIO', lineas: ['valor'], minimo: PERIODO_SMA },
  EMA20: { panel: 'PRECIO', lineas: ['valor'], minimo: PERIODO_EMA },
  RSI: { panel: 'PROPIO', lineas: ['valor'], guias: [30, 70], minimo: PERIODO_RSI + 1 },
  ATR: { panel: 'PROPIO', lineas: ['valor'], minimo: PERIODO_ATR + 1 },
};

export const CLAVES_INDICADOR = Object.keys(INDICADORES) as readonly ClaveIndicador[];

/** Para leer una preferencia guardada sin fiarse de lo que hay escrito. */
export function esClaveIndicador(valor: unknown): valor is ClaveIndicador {
  return typeof valor === 'string' && valor in INDICADORES;
}

/** Un punto de una línea. `v: null` es hueco: el gráfico rompe la línea ahí. */
export interface PuntoIndicador {
  t: number;
  v: number | null;
}

export interface LineaIndicador {
  /** Cuál de las líneas de la ficha es esta. */
  clave: string;
  puntos: PuntoIndicador[];
}

/**
 * Los `NaN` de la estadística —donde todavía no hay datos suficientes— se
 * convierten en `null`, que es como el gráfico entiende un hueco. Sin esto se
 * pintaría una línea bajando a cero desde el borde izquierdo.
 */
function aPuntos(t: readonly number[], valores: Float64Array): PuntoIndicador[] {
  const puntos: PuntoIndicador[] = new Array<PuntoIndicador>(valores.length);
  for (let i = 0; i < valores.length; i++) {
    const v = valores[i];
    puntos[i] = { t: t[i], v: Number.isFinite(v) ? v : null };
  }
  return puntos;
}

/** Las líneas de un indicador sobre estas velas, ya listas para el gráfico. */
export function lineasDeIndicador(
  clave: ClaveIndicador,
  velas: readonly Candle[],
): LineaIndicador[] {
  if (velas.length === 0) return [];
  const s = serieNumerica(velas);
  switch (clave) {
    case 'BOLLINGER': {
      const b = bollinger(s.c, PERIODO_BOLLINGER, DESVIACIONES_BOLLINGER);
      return [
        { clave: 'superior', puntos: aPuntos(s.t, b.superior) },
        { clave: 'media', puntos: aPuntos(s.t, b.media) },
        { clave: 'inferior', puntos: aPuntos(s.t, b.inferior) },
      ];
    }
    case 'SMA50':
      return [{ clave: 'valor', puntos: aPuntos(s.t, sma(s.c, PERIODO_SMA)) }];
    case 'EMA20':
      return [{ clave: 'valor', puntos: aPuntos(s.t, ema(s.c, PERIODO_EMA)) }];
    case 'RSI':
      return [{ clave: 'valor', puntos: aPuntos(s.t, rsi(s.c, PERIODO_RSI)) }];
    case 'ATR':
      return [{ clave: 'valor', puntos: aPuntos(s.t, atrSerie(s.h, s.l, s.c, PERIODO_ATR)) }];
    default: {
      // Un indicador nuevo sin su rama no compila.
      const desconocido: never = clave;
      throw new Error(`Indicador desconocido: ${String(desconocido)}`);
    }
  }
}

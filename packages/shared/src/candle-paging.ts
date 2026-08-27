import { candleSpanMs, type Candle, type CandleInterval } from './candle';

/**
 * Paginación del gráfico hacia atrás en el tiempo.
 *
 * Todo aquí es PURO: entra el estado y una página de velas, sale el estado
 * siguiente. Vive en `shared` y no junto a la pantalla por un motivo muy
 * concreto: `apps/app` no tiene ni un solo test —su script es literalmente
 * «sin tests de UI por ahora»— y montar TestBed para esto sería
 * desproporcionado. Sacando la DECISIÓN de la vista, lo único que queda sin
 * cubrir es el cableado con el motor del gráfico, que necesitaría un lienzo real
 * para significar algo de todas formas.
 *
 * El servidor ya sabía hacer su parte desde el principio: `endMs` está validado
 * y `quantizeEnd` lo alinea al cierre de vela citando exactamente este caso de
 * uso. Lo único que faltaba era el lado del cliente.
 */

export interface HistoryState {
  /** La serie completa cargada. Ascendente por `t` y sin duplicados. */
  bars: Candle[];
  /** Páginas de pasado aceptadas. */
  pages: number;
  /**
   * El venue no tiene más pasado que dar. TERMINAL.
   *
   * Medido contra Hyperliquid: su histórico son las últimas 5000 velas del
   * intervalo pedido —3,5 días en 1m, 52 días en 15m, trece años en 1d— y al
   * pasarse no devuelve un error, devuelve un **array vacío**. Por eso «no hay
   * más» es un estado normal y no un fallo.
   */
  noMore: boolean;
  /** Se alcanzó NUESTRO techo, no el del venue. También terminal. */
  capped: boolean;
}

export interface HistoryLimits {
  interval: CandleInterval;
  /**
   * Velas por página.
   *
   * Tiene que ser un escalón exacto de los que el servidor admite
   * (`LIMIT_STEPS` = 2, 50, 150, 300, 600, 1000, 1500): `quantizeLimit` redondea
   * hacia ARRIBA y el valor redondeado entra en la clave de Redis, así que pedir
   * 250 cuesta la misma llamada al venue que 300 pero genera una entrada que no
   * comparte nadie — un fallo de caché garantizado y una llamada al DEX de
   * regalo.
   */
  pageBars: number;
  /** Techo de barras en memoria. Al alcanzarlo se deja de pedir. */
  maxBars: number;
  /** Techo de páginas por serie. La segunda red, por si `maxBars` sube. */
  maxPages: number;
}

export interface HistoryRequest {
  /** Fin del rango pedido. Es el `endMs` del endpoint de velas. */
  endMs: number;
  limit: number;
}

/** Estado inicial de una serie recién cargada. */
export function historyStateOf(bars: Candle[]): HistoryState {
  return { bars, pages: 0, noMore: false, capped: false };
}

/**
 * Qué pedir a continuación, o null si no hay que pedir nada.
 *
 * El `endMs` es el timestamp de la vela más antigua **tal cual**, sin restarle
 * un milisegundo ni un intervalo. Es deliberado: `quantizeEnd` redondea hacia
 * abajo al cierre de vela, así que `t` es la identidad mientras que `t - 1` cae
 * al bucket ANTERIOR y genera una segunda entrada de caché para la misma
 * ventana. Como el `endTime` de los venues es inclusivo, vuelve la vela frontera
 * repetida — y eso no es un desperdicio, es la comprobación de contigüidad que
 * usa `applyHistoryPage`.
 */
export function nextHistoryRequest(
  state: HistoryState,
  limits: HistoryLimits,
): HistoryRequest | null {
  if (state.noMore || state.capped) return null;
  // Sin serie no hay desde dónde retroceder: la carga inicial es de otro camino.
  if (state.bars.length === 0) return null;
  return { endMs: state.bars[0].t, limit: limits.pageBars };
}

/**
 * Incorpora una página de pasado.
 *
 * Las tres formas de terminar están aquí y ninguna es un error:
 *
 *   · página vacía  → el venue no tiene más (el muro de las 5000).
 *   · página que no aporta ni una vela nueva → el venue está devolviendo la
 *     misma ventana una y otra vez. Sin este corte, el gráfico pediría en bucle
 *     mientras el usuario siga arrastrando.
 *   · página que no encaja con lo que ya hay → hay un agujero. NO se pega:
 *     `bucketOf` busca por bisección sobre los timestamps de las barras para
 *     colocar los marcadores de ejecución, y con un hueco en medio los pondría
 *     al lado equivocado. Mejor parar y decir que no hay más contiguo.
 */
export function applyHistoryPage(
  state: HistoryState,
  page: Candle[],
  limits: HistoryLimits,
): HistoryState {
  if (page.length === 0) return { ...state, noMore: true };
  if (state.bars.length === 0) return { ...historyStateOf(page), pages: state.pages + 1 };

  const span = candleSpanMs(limits.interval);
  const primera = state.bars[0].t;
  const masNuevaDeLaPagina = page.reduce((max, c) => (c.t > max ? c.t : max), page[0].t);

  // Contigua o solapada. El caso normal es el solape de UNA vela, porque el
  // `endTime` del venue es inclusivo.
  if (masNuevaDeLaPagina < primera - span) return { ...state, noMore: true };

  const porTiempo = new Map<number, Candle>();
  for (const c of page) porTiempo.set(c.t, c);
  // Lo que ya había MANDA sobre lo que llega: la cola de la serie lleva la vela
  // en formación y los precios más frescos, y una página de pasado no tiene por
  // qué saber nada de eso.
  for (const c of state.bars) porTiempo.set(c.t, c);

  if (porTiempo.size === state.bars.length) return { ...state, noMore: true };

  const bars = [...porTiempo.values()].sort((a, b) => a.t - b.t);
  const pages = state.pages + 1;

  return {
    bars,
    pages,
    noMore: false,
    // El techo NO recorta: `liveBar`, la distancia a liquidación y el plegado de
    // ticks dependen todos de que la cola esté al día. Solo se deja de pedir.
    capped: bars.length >= limits.maxBars || pages >= limits.maxPages,
  };
}

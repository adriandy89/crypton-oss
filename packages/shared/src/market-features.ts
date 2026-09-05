/**
 * Rasgos de un mercado, calculados a partir de sus velas.
 *
 * Es el contrato de `GET /market-data/features` y la entrada del advisor. Vive
 * aqui, y no solo en la API, porque la app los pinta: es la franja que contesta
 * «¿este par es terreno de rejilla o me va a arrastrar?», que es la decision que
 * se toma delante del grafico. Los calcula `buildFeatures` en la API; aqui solo
 * esta la forma.
 */
export interface MarketFeatures {
  /** Precio de referencia con el que se calculo TODO lo demas. */
  mark: number;
  /** Volatilidad realizada anualizada, en %. */
  volAnnualPct: number;
  /** Recorrido tipico de una vela de 1 h, en % del precio. */
  atrPct1h: number;
  /** Recorrido tipico de una vela diaria, en % del precio. */
  atrPct1d: number;
  /** Amplitud del rango de los ultimos 30 dias, en %. */
  rangePct30: number;
  /** Donde cae el precio dentro de ese rango: 0 = suelo, 1 = techo. */
  posInRange: number;
  /** Signo y magnitud de la tendencia, en % de separacion entre medias. */
  trendPct: number;
  trend: 'ALCISTA' | 'BAJISTA' | 'LATERAL';
  /**
   * Eficiencia de Kaufman: recorrido neto sobre recorrido total.
   *
   * Cerca de 0 el precio va y viene —terreno de rejilla y de market maker—;
   * cerca de 1 se mueve en linea recta, que es donde una rejilla se queda
   * comprando todo el camino de bajada.
   */
  efficiency: number;
  /** La peor sesion diaria del periodo, en % (negativa). */
  worstDayPct: number;
  /** El tick del mercado en puntos basicos: el suelo real de un diferencial. */
  tickBps: number;
}

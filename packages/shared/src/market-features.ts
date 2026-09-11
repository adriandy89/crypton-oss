import { D, Decimal, type Numeric } from './money';

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

/**
 * Eficiencia de Kaufman: recorrido NETO sobre recorrido TOTAL, en [0, 1].
 *
 * 1 = línea recta, el mercado va a un sitio. 0 = ir y venir sin avanzar, que es
 * el terreno de una rejilla o de un market maker.
 *
 * Vive aquí, y no en cada sitio que la usa, porque la usan dos: el asesor la
 * calcula sobre cierres horarios para decidir con qué configuración nace un
 * bot, y el market maker la calcula sobre sus propias muestras de precio para
 * decidir si deja de cotizar contra la tendencia. Son entradas distintas y la
 * misma pregunta; tener dos implementaciones era tener dos respuestas (spec
 * 039).
 *
 * Devuelve 0 con menos de dos valores o sin recorrido: no se pronuncia.
 */
export function eficienciaKaufman(valores: readonly Numeric[]): Decimal {
  if (valores.length < 2) return D(0);
  let recorrido = D(0);
  for (let i = 1; i < valores.length; i++) {
    recorrido = recorrido.plus(
      D(valores[i])
        .minus(D(valores[i - 1]))
        .abs(),
    );
  }
  if (!recorrido.gt(0)) return D(0);
  const neto = D(valores[valores.length - 1])
    .minus(D(valores[0]))
    .abs();
  return neto.div(recorrido);
}

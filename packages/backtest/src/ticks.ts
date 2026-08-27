import { BarPath, D, Decimal, candleSpanMs } from '@crypton/shared';
import type { Candle, CandleInterval, MarketSpec, Ticker, Venue } from '@crypton/shared';

/**
 * De una vela a los precios que la recorrieron.
 *
 * Una vela dice cuatro números y no dice el ORDEN en que ocurrieron: nadie sabe
 * si el máximo llegó antes que el mínimo. Se emiten cuatro precios por vela
 * —apertura, un extremo, el otro, cierre— siguiendo la regla que se pida.
 *
 * Los tiempos van en `t`, `t+S/4`, `t+S/2` y `t+3S/4`. **Nunca en `t+S`**: ese ya
 * es el instante de la vela siguiente, y una ejecución con esa marca aparecería
 * fuera de su propia barra.
 */
export function tickPath(
  candle: Candle,
  interval: CandleInterval,
  path: BarPath,
): { ts: number; price: Decimal; role: 'open' | 'high' | 'low' | 'close' }[] {
  const span = candleSpanMs(interval);
  const o = D(candle.o);
  const h = D(candle.h);
  const l = D(candle.l);
  const c = D(candle.c);

  const primeroElMinimo =
    path === BarPath.PESSIMISTIC
      ? // El que más duele: si la vela sube, primero el suelo.
        c.gte(o)
      : // El más cercano a la apertura.
        o.minus(l).abs().lte(h.minus(o).abs());

  const extremos: { price: Decimal; role: 'high' | 'low' }[] = primeroElMinimo
    ? [
        { price: l, role: 'low' },
        { price: h, role: 'high' },
      ]
    : [
        { price: h, role: 'high' },
        { price: l, role: 'low' },
      ];

  return [
    { ts: candle.t, price: o, role: 'open' as const },
    { ts: candle.t + Math.floor(span / 4), ...extremos[0] },
    { ts: candle.t + Math.floor(span / 2), ...extremos[1] },
    { ts: candle.t + Math.floor((span * 3) / 4), price: c, role: 'close' as const },
  ];
}

/**
 * El ticker sintético de un precio. **Aquí se decide si el backtest sirve.**
 *
 * `DryRunAdapter.matchRestingOrders` ejecuta una COMPRA cuando el `ask` baja
 * hasta el límite y una VENTA cuando el `bid` sube hasta el suyo. Si en el tick
 * del mínimo se pusiera `ask = mínimo + medio diferencial`, una orden de compra
 * colocada EXACTAMENTE en el mínimo de la vela no se ejecutaría — aunque en el
 * mercado real el precio la tocó. Por eso en los extremos el lado que importa se
 * pega al extremo: `ask = mínimo` y `bid = máximo`. Así «tocar» significa aquí lo
 * mismo que en el venue.
 *
 * Y `mark` va también en el extremo, no en el punto medio: `checkLiquidation`
 * usa el precio de marca y los venues liquidan EN LA MECHA. Suavizarlo aquí
 * regalaría liquidaciones que en el venue sí ocurren.
 */
export function tickerAt(
  venue: Venue,
  market: MarketSpec,
  price: Decimal,
  role: 'open' | 'high' | 'low' | 'close',
  ts: number,
  spreadBps: number,
): Ticker {
  // Suelo de medio tick: por debajo, el diferencial no existe en ese mercado.
  const medio = Decimal.max(D(market.tickSize).div(2), price.mul(spreadBps).div(20_000));

  let bid: Decimal;
  let ask: Decimal;
  if (role === 'low') {
    bid = price.minus(medio.mul(2));
    ask = price;
  } else if (role === 'high') {
    bid = price;
    ask = price.plus(medio.mul(2));
  } else {
    bid = price.minus(medio);
    ask = price.plus(medio);
  }

  return {
    venue,
    symbol: market.symbol,
    last: price.toFixed(),
    bid: Decimal.max(bid, D(0)).toFixed(),
    ask: ask.toFixed(),
    mark: price.toFixed(),
    ts,
  };
}

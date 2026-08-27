import { D, type DesiredOrder, type MarketSpec } from '@crypton/shared';
import { VENUE_MARKETS } from '@crypton/strategy-core';
import { revisarOrden } from '@crypton/strategy-core';

/**
 * La puerta de salida, contra los DOCE mercados reales de los tres venues.
 *
 * El fallo que la hizo existir no fue exótico: a un BASE de 0,00196 BTC le
 * ejecutaron 0,00001 —una parcial, lo más normal del mundo—, la estrategia pidió
 * un take profit sobre esos 0,79 $, y Lighter lo rechazó tick tras tick hasta
 * que el cortacircuitos pausó el bot con la posición abierta y sin stop loss.
 *
 * Puede pasar en CUALQUIER venue y con CUALQUIER estrategia que tenga salida
 * sobre la posición, así que aquí se recorren todos. Las reglas del venue se
 * vuelven a derivar a mano —no con `normalizeOrder`, que es lo que la puerta usa
 * por dentro— para que esto compruebe algo en vez de repetir su criterio.
 */

/**
 * Redondeo al tick, a mano.
 *
 * Hace falta porque el motor SIEMPRE alinea el precio antes de mandar: comparar
 * contra el precio crudo diría que una orden perfectamente válida es inválida.
 * Se implementa aquí y no se importa de `precision.ts` por lo mismo que el resto
 * de este fichero: comprobar una cosa con ella misma no comprueba nada.
 */
function alTick(price: string, tick: string): string {
  return D(price).div(tick).toDecimalPlaces(0).mul(tick).toFixed();
}

/** ¿Cumple esta orden las reglas publicadas por el venue? Derivado a mano. */
function laAceptaElVenue(market: MarketSpec, priceCrudo: string, qty: string): boolean {
  const price = alTick(priceCrudo, market.tickSize);
  const p = D(price);
  const q = D(qty);
  if (q.lte(0) || p.lte(0)) return false;
  if (!q.div(market.stepSize).mod(1).isZero()) return false;
  if (!p.div(market.tickSize).mod(1).isZero()) return false;
  if (market.minQty && q.lt(market.minQty)) return false;
  if (market.maxQty && q.gt(market.maxQty)) return false;
  if (market.minNotional && p.mul(q).lt(market.minNotional)) return false;
  return true;
}

const salida = (qty: string, price: string): DesiredOrder =>
  ({
    clientOrderId: 'tp',
    levelKind: 'TAKE_PROFIT',
    levelIndex: 0,
    side: 'SELL',
    type: 'LIMIT',
    price,
    qty,
    reduceOnly: true,
  }) as DesiredOrder;

const entrada = (qty: string, price: string): DesiredOrder =>
  ({ ...salida(qty, price), levelKind: 'SAFETY', side: 'BUY', reduceOnly: false }) as DesiredOrder;

/** La cantidad más pequeña que ese venue sí aceptaría a ese precio. */
function minimoViable(market: MarketSpec, price: string): string {
  const step = D(market.stepSize);
  const porQty = market.minQty ? D(market.minQty) : step;
  const porNotional = market.minNotional ? D(market.minNotional).div(price) : D(0);
  const bruto = porQty.gt(porNotional) ? porQty : porNotional;
  // Hacia ARRIBA hasta el step: hacia abajo se quedaría por debajo del mínimo.
  return bruto.div(step).ceil().mul(step).toFixed();
}

describe('la puerta de salida, en los tres venues', () => {
  for (const { nombre, spec, mark } of VENUE_MARKETS) {
    describe(nombre, () => {
      const unStep = spec.stepSize;
      const minimo = minimoViable(spec, mark);

      it('una ejecución parcial de UN step no se manda mientras la escalera viva', () => {
        // Es el caso real, generalizado: la parcial más pequeña posible.
        const v = revisarOrden(spec, salida(unStep, mark), true);
        if (laAceptaElVenue(spec, mark, unStep)) {
          // En un venue donde un step ya cumple el mínimo, la salida es legítima.
          expect(v.motivo).toBe('OK');
          return;
        }
        expect(v.motivo).toBe('ESPERANDO_MINIMO');
        if (v.motivo === 'OK') throw new Error('inalcanzable');
        // INFO, no error: la posición sigue creciendo y esto se cura solo.
        expect(v.severidad).toBe('INFO');
      });

      it('la misma parcial SIN escalera viva se avisa como resto incerrable', () => {
        const v = revisarOrden(spec, salida(unStep, mark), false);
        if (laAceptaElVenue(spec, mark, unStep)) {
          expect(v.motivo).toBe('OK');
          return;
        }
        expect(v.motivo).toBe('RESTO_INCERRABLE');
        if (v.motivo === 'OK') throw new Error('inalcanzable');
        expect(v.severidad).toBe('WARN');
        expect(v.mensaje).toContain('desde el exchange');
      });

      it('en cuanto la posición alcanza el mínimo del venue, la salida SALE', () => {
        // Lo que tiene que ocurrir solo, sin que nadie toque nada.
        expect(revisarOrden(spec, salida(minimo, mark), true).motivo).toBe('OK');
        expect(revisarOrden(spec, salida(minimo, mark), false).motivo).toBe('OK');
      });

      it('una cantidad por debajo de un step nunca se manda, haya o no escalera', () => {
        const polvo = D(spec.stepSize).div(10).toFixed();
        for (const vivas of [true, false]) {
          expect(revisarOrden(spec, salida(polvo, mark), vivas).motivo).toBe('IMPOSIBLE');
        }
      });

      it('una ENTRADA por debajo del mínimo se descarta y se avisa', () => {
        const v = revisarOrden(spec, entrada(unStep, mark), true);
        if (laAceptaElVenue(spec, mark, unStep)) {
          expect(v.motivo).toBe('OK');
          return;
        }
        expect(v.motivo).toBe('ENTRADA_INVALIDA');
        if (v.motivo === 'OK') throw new Error('inalcanzable');
        expect(v.severidad).toBe('WARN');
      });

      it('la puerta NUNCA deja pasar algo que el venue rechazaría', () => {
        // La propiedad de fondo, barrida sobre un abanico de cantidades: si la
        // puerta dice OK, el venue tiene que aceptarla. Al revés no es simétrico
        // —una salida por debajo del mínimo se retiene a propósito—, pero un OK
        // sobre una orden imposible es exactamente el fallo que pausó el bot.
        const step = D(spec.stepSize);
        for (const mult of [0.1, 0.5, 1, 2, 5, 13, 100, 1000, 12345]) {
          const qty = step.mul(mult).toFixed();
          for (const orden of [salida(qty, mark), entrada(qty, mark)]) {
            for (const vivas of [true, false]) {
              if (revisarOrden(spec, orden, vivas).motivo === 'OK') {
                expect({ qty, aceptada: laAceptaElVenue(spec, mark, qty) }).toEqual({
                  qty,
                  aceptada: true,
                });
              }
            }
          }
        }
      });

      it('un maxQty declarado se respeta', () => {
        if (!spec.maxQty) return;
        const pasado = D(spec.maxQty).plus(spec.stepSize).toFixed();
        expect(revisarOrden(spec, entrada(pasado, mark), true).motivo).not.toBe('OK');
      });
    });
  }
});

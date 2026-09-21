/**
 * El dimensionado por tramos de apalancamiento (spec 068).
 *
 * Esto vivía dentro de `canal/opcionDeStop()` y lo usa ahora también el motor
 * del «Bot de IA». Se extrae en vez de copiarse por la razón de siempre en este
 * repo: **una copia en cada sitio es un sitio más donde olvidarse de arreglar
 * el siguiente fallo**. Y aquí eso importa más que de costumbre, porque estas
 * sesenta líneas deciden cuánto dinero entra en una orden.
 *
 * La lógica no cambia ni una coma respecto a lo que había. Lo que la sostiene
 * es la batería de `canal/herramienta.spec.ts`, incluida su prueba de
 * propiedad: si esta extracción se hubiera desviado, esos tests lo dirían.
 */
import {
  D,
  Decimal,
  apalancamientoPorStop,
  type MarketSpec,
  type NivelApalancamiento,
} from '@crypton/shared';
import { qy } from './common';

/** Lo que sale del dimensionado cuando hay sitio para una orden. */
export interface Dimension {
  cantidad: Decimal;
  nocional: Decimal;
  /** El menor apalancamiento que hace caber el nocional en el margen permitido. */
  lMin: number;
  lMax: number;
  mantenimiento: number;
}

export interface EntradaDimension {
  market: MarketSpec;
  niveles: readonly NivelApalancamiento[];
  /** El precio tope de la entrada: el nocional se mide con él. */
  tope: Decimal;
  /** Distancia del stop a la entrada, en tanto por uno. */
  distanciaStop: Decimal;
  /** ATR de 1 h dividido por el precio: lo que mira la regla de liquidación. */
  atr1hRelativo: Decimal;
  /** Lo que se puede perder en esta operación. */
  riesgo: Decimal;
  /** Pérdida por unidad de moneda al saltar el stop, comisiones incluidas. */
  perdidaPorUnidad: Decimal;
  capital: Decimal;
  multiploNocional: Decimal;
  topeNocional: Decimal | null;
  maxMargen: Decimal;
  colchonStops: number;
  /** Todos los techos de apalancamiento que apliquen, incluido el de la estrategia. */
  topesApalancamiento: number[];
  mantenimientoMercado: number;
}

/** Los tramos del venue, ordenados y con un tramo cero si el venue no lo da. */
export function tramosOrdenados(
  niveles: readonly NivelApalancamiento[],
  maxMercado: number,
  mantenimientoMercado: number,
): NivelApalancamiento[] {
  const orden = [...niveles].sort((a, b) => D(a.desdeNocional).comparedTo(b.desdeNocional));
  if (orden.length === 0 || D(orden[0].desdeNocional).gt(0)) {
    orden.unshift({
      desdeNocional: '0',
      maxApalancamiento: maxMercado,
      mantenimiento: mantenimientoMercado,
    });
  }
  return orden;
}

/** ¿Llega la orden a los mínimos del venue? */
export const llegaAlMinimo = (market: MarketSpec, cantidad: Decimal, precio: Decimal): boolean =>
  cantidad.gt(0) &&
  !(market.minQty && cantidad.lt(market.minQty)) &&
  !(market.minNotional && cantidad.mul(precio).lt(market.minNotional));

/**
 * Cuánta cantidad cabe, y con qué apalancamiento.
 *
 * El tramo depende del nocional, y el nocional del apalancamiento que permite
 * el tramo. Se calcula en cada tramo con SUS reglas y el nocional acotado a él,
 * y se queda el mayor. Iterar hasta que casen puede oscilar entre dos.
 */
export function dimensionar(
  e: EntradaDimension,
): { dim: Dimension; motivo: null } | { dim: null; motivo: 'APALANCAMIENTO' | 'MINIMO' } {
  const { market, tope } = e;

  // El stop de mercado tiene que cerrar la posición entera de una vez.
  const topesCantidad = [market.maxQty, market.maxMarketQty]
    .filter((q): q is string => !!q && D(q).gt(0))
    .map((q) => D(q));

  const tramos = tramosOrdenados(e.niveles, market.maxLeverage, e.mantenimientoMercado);
  let mejor: Dimension | null = null;
  let motivo: 'APALANCAMIENTO' | 'MINIMO' = 'APALANCAMIENTO';

  for (let i = 0; i < tramos.length; i++) {
    const tramo = tramos[i];
    const hasta = i + 1 < tramos.length ? D(tramos[i + 1].desdeNocional) : null;
    const lev = apalancamientoPorStop({
      distanciaStop: e.distanciaStop,
      atr1hRelativo: e.atr1hRelativo,
      liqBufferStops: e.colchonStops,
      mantenimiento: tramo.mantenimiento,
      topes: [...e.topesApalancamiento, tramo.maxApalancamiento, market.maxLeverage],
    });
    if (lev.maximo < 1) continue;

    const topes = [
      e.riesgo.div(e.perdidaPorUnidad).mul(tope),
      e.capital.mul(e.multiploNocional),
      e.capital.mul(lev.maximo),
    ];
    if (e.topeNocional) topes.push(e.topeNocional);
    if (hasta) topes.push(hasta);
    let objetivo = Decimal.min(...topes);
    let lMin = objetivo.div(e.maxMargen).toDecimalPlaces(0, Decimal.ROUND_CEIL).toNumber();
    if (lMin > lev.maximo) {
      // Ni al máximo cabe el margen: se reduce el nocional, no se sube la palanca.
      objetivo = e.maxMargen.mul(lev.maximo);
      lMin = lev.maximo;
    }
    lMin = Math.max(1, lMin);
    if (objetivo.lt(tramo.desdeNocional)) continue;

    let cantidad = D(qy(market, objetivo.div(tope)));
    for (const q of topesCantidad) if (cantidad.gt(q)) cantidad = D(qy(market, q));
    if (hasta && cantidad.mul(tope).gte(hasta)) cantidad = cantidad.minus(market.stepSize);
    if (!cantidad.gt(0)) {
      motivo = 'MINIMO';
      continue;
    }
    const nocional = cantidad.mul(tope);
    if (!mejor || nocional.gt(mejor.nocional)) {
      mejor = { cantidad, nocional, lMin, lMax: lev.maximo, mantenimiento: tramo.mantenimiento };
    }
  }

  if (!mejor) return { dim: null, motivo };
  if (!llegaAlMinimo(market, mejor.cantidad, tope)) return { dim: null, motivo: 'MINIMO' };
  return { dim: mejor, motivo: null };
}

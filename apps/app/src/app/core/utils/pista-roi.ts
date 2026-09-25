import { D, isFiniteNum, pctPrecioDeRoi, type Numeric } from '@crypton/shared';
import { money, price, signed } from './format';

/** Una salida que enseñar junto a un campo: su lado, su precio y su resultado. */
export interface SalidaPista {
  lado: 'LONG' | 'SHORT';
  precio: string;
  pnl: string;
}

/**
 * La pista de un campo de % sobre el margen (spec 080, D-4): lo que vale ese %
 * en precio y, cuando se sabe, dónde queda y cuánto es en dinero.
 *
 *   «= 0,67 % de precio · 85.165,0 (−12,00 USDC)»
 *
 * Así nadie tiene que hacer de cabeza la cuenta del apalancamiento, que es la
 * que no hizo el usuario del 079: leía «objetivo 15 %» sin saber que a 15× era
 * un +225 % de su margen. Las cifras llegan calculadas —de `buildPreview` al
 * crear, de `salidaPorRoi` con la posición abierta—; aquí solo se escriben.
 *
 * Vacía si el campo no tiene todavía un número positivo.
 */
export function pistaRoi(o: {
  roiPct: unknown;
  apalancamiento: unknown;
  salidas?: readonly SalidaPista[];
  decimales?: number | null;
  quote?: string;
  /** Lo que haya que añadir, como «con la escalera llena». */
  nota?: string;
}): string {
  if (!isFiniteNum(o.roiPct) || !D(o.roiPct as Numeric).gt(0)) return '';
  const apalancamiento = isFiniteNum(o.apalancamiento) ? (o.apalancamiento as Numeric) : 1;
  const enPrecio = pctPrecioDeRoi(o.roiPct as Numeric, apalancamiento);
  const partes = [`= ${money(enPrecio.toFixed(4), enPrecio.lt('0.1') ? 3 : 2)} % de precio`];
  const salidas = o.salidas ?? [];
  for (const s of salidas) {
    const lado = salidas.length > 1 ? (s.lado === 'SHORT' ? 'corto ' : 'largo ') : '';
    partes.push(`${lado}${price(s.precio, o.decimales)} (${signed(s.pnl)} ${o.quote ?? 'USDC'})`);
  }
  return partes.join(' · ') + (o.nota ? ` ${o.nota}` : '');
}

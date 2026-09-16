import { D, isFiniteNum, type FieldMeta, type Numeric } from '@crypton/shared';
import type { ChangedField } from '@crypton/strategy-core';
import { PERILLAS, type Desplazamientos, type Movimiento } from './apply';

/**
 * Los avisos del Modo IA, escritos para una persona (spec 054).
 *
 * Hasta el 054 decian «El supervisor ha cambiado buyDistanceBps, sellDistanceBps:
 * <motivo>»: las claves internas y ni un numero. Para decidir si se aprobaba una
 * sugerencia habia que abrir la app, y un cambio aplicado de madrugada no decia
 * cuanto se habia movido nada. Aprobar desde Telegram, ademas, RECALCULA el cambio
 * con el mercado de ese momento (spec 047, F-04), asi que lo aplicado podia no ser
 * lo propuesto sin que ningun aviso lo dijera.
 *
 * Puro y sin Nest, como `apply.ts`: el texto se prueba sin levantar la API.
 */

/**
 * Los nombres de los campos que el supervisor puede mover, por `labelKey`.
 *
 * Copiados de `apps/app/src/app/core/utils/field-labels.ts`, y SOLO los del
 * alcance: lo que la IA no puede tocar no llega nunca a un aviso suyo. Dos tests
 * los mantienen honrados. `alcance.spec.ts` exige que todo campo que la IA puede
 * mover tenga nombre aqui, y `mensajes.spec.ts` lee el fichero de la app y exige
 * que cada nombre diga exactamente lo mismo: un parametro no puede llamarse de una
 * forma en la pantalla y de otra en el aviso que manda mirarla.
 */
export const ETIQUETAS: Readonly<Record<string, string>> = {
  // Comunes
  'strategy.common.leverage': 'Apalancamiento',
  'strategy.common.maxNotionalCap': 'Tope de exposición',

  // Market maker
  'strategy.mm.orderSizePerSide': 'Tamaño por compra/venta',
  'strategy.mm.maxBotPositionValue': 'Valor máximo de la posición',
  'strategy.mm.defensiveThresholdPct': 'Modo defensivo a partir de',
  'strategy.mm.highRiskThresholdPct': 'Modo de alto riesgo a partir de',
  'strategy.mm.buyDistanceBps': 'Distancia de compra',
  'strategy.mm.sellDistanceBps': 'Distancia de venta',
  'strategy.mm.minAllowedDistanceBps': 'Distancia mínima permitida',
  'strategy.mm.refreshSeconds': 'Intervalo de actualización de órdenes',
  'strategy.mm.layers': 'Capas',
  'strategy.mm.layerDistanceMultiplier': 'Multiplicador de distancia por capa',
  'strategy.mm.layerSizeMultiplier': 'Multiplicador de tamaño por capa',
  'strategy.mm.inventorySkewFactor': 'Sesgo por inventario',

  // Market maker V2
  'strategy.mmv2.orderSizePerSide': 'Tamaño por compra/venta',
  'strategy.mmv2.maxBotPositionValue': 'Inversión / posición máxima',
  'strategy.mmv2.defensiveThresholdPct': 'Umbral defensivo',
  'strategy.mmv2.highRiskThresholdPct': 'Umbral de alto riesgo',
  'strategy.mmv2.buyDistanceBps': 'Distancia de compra',
  'strategy.mmv2.sellDistanceBps': 'Distancia de venta',
  'strategy.mmv2.minAllowedDistanceBps': 'Distancia mínima permitida',
  'strategy.mmv2.refreshSeconds': 'Intervalo de actualización de órdenes',
  'strategy.mmv2.repriceThresholdBps': 'Distancia para reajustar precio',
  'strategy.mmv2.orderMaxAgeSeconds': 'Actualizar órdenes después de',
  'strategy.mmv2.fillCooldownSeconds': 'Espera tras un fill',
  'strategy.mmv2.volatilityMultiplier': 'Multiplicador de volatilidad',
  'strategy.mmv2.maxDynamicSpreadBps': 'Spread dinámico máximo',
  'strategy.mmv2.layers': 'Niveles de cotización',
  'strategy.mmv2.layerDistanceMultiplier': 'Multiplicador de distancia por nivel',
  'strategy.mmv2.layerSizeMultiplier': 'Multiplicador de tamaño por nivel',

  // Tendencia
  'strategy.trend.breakoutPeriod': 'Velas del canal de ruptura',
  'strategy.trend.atrStopMultiplier': 'Stop, en ATR',
  'strategy.trend.riskPerTradePct': 'Riesgo por operación',
  'strategy.trend.entryEfficiency': 'Eficiencia mínima para entrar',
  'strategy.trend.stopRepriceBps': 'Movimiento mínimo del stop',

  // Seguimiento de beneficio
  'strategy.trailing.takeProfitPct': 'Beneficio al que empieza a seguir (%)',
  'strategy.trailing.trailingCallbackPct': 'Retroceso para salir (%)',
  'strategy.trailing.trailingRepriceBps': 'Umbral para mover el disparador (bps)',
};

/** Las perillas, con el nombre que les da la guia. */
const NOMBRE_DE_PERILLA: Readonly<Record<keyof Desplazamientos, string>> = {
  leverage: 'apalancamiento',
  coverage: 'cobertura',
  spread: 'diferencial',
  sizeGrowth: 'crecimiento del tamaño',
  cadence: 'cadencia',
};

const NOMBRE_DEL_MOVIMIENTO: Readonly<Record<Exclude<Movimiento, 'IGUAL'>, string>> = {
  MUCHO_MENOS: 'mucho menos',
  MENOS: 'menos',
  MAS: 'más',
  MUCHO_MAS: 'mucho más',
};

/**
 * Cuantos campos se listan como mucho.
 *
 * El diferencial de una V2 arrastra siete y una decision puede mover dos
 * perillas, asi que once no es imposible. Diez lineas se leen de un vistazo en
 * un movil; el resto se cuenta, y el detalle completo queda en la decision.
 */
export const MAX_LINEAS = 10;

/**
 * Las unidades que un nombre del catalogo puede llevar entre parentesis.
 *
 * Los de la app las llevan cuando el descriptor no declara `unit` —«Retroceso
 * para salir (%)»—, y en un aviso la unidad va detras del valor: dejarla tambien
 * en el nombre la repetiria.
 */
const UNIDAD_EN_EL_NOMBRE = /^(.*\S)\s*\((%|bps|min|s|x|USDC)\)$/;

/** Un valor tal como se lee: sin ceros de relleno, con punto, como los avisos del motor. */
export function valorLegible(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'boolean') return v ? 'sí' : 'no';
  // `toFixed()` sin argumento no escribe nunca en notacion exponencial, y quita
  // los ceros de relleno: el capital sale de la base como
  // '5000.000000000000000000', y en un aviso eso es ruido.
  if (isFiniteNum(v)) return D(v as Numeric).toFixed();
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}

/**
 * Una linea por campo: «• Nombre: antes → después unidad».
 *
 * `campo` tiene que ser el del descriptor EFECTIVO (`camposEfectivos`): en el
 * modo «cantidad de moneda» el tamaño por orden no va en USDC sino en la moneda
 * base, y un aviso que dijera «0.009 → 0.0072 USDC» mentiria en mil veces.
 */
export function lineaDeCambio(c: ChangedField, campo: FieldMeta | undefined): string {
  const bruto = ETIQUETAS[c.labelKey] ?? c.key;
  const enElNombre = UNIDAD_EN_EL_NOMBRE.exec(bruto);
  const nombre = enElNombre ? enElNombre[1] : bruto;
  const declarada = campo?.unit === 'sec' ? 's' : campo?.unit;
  const unidad = declarada ?? enElNombre?.[2] ?? (campo?.kind === 'percent' ? '%' : undefined);

  const de = valorLegible(c.from);
  const a = valorLegible(c.to);

  // El apalancamiento se escribe pegado —«3x»—, y en los dos lados: «3 → 2x» se
  // lee como si solo el segundo fuera un apalancamiento.
  if (unidad === 'x') {
    const pegar = (v: string): string => (v === '—' ? v : `${v}x`);
    return `• ${nombre}: ${pegar(de)} → ${pegar(a)}`;
  }
  const sufijo = unidad ? ` ${unidad}` : '';
  if (a !== '—') return `• ${nombre}: ${de} → ${a}${sufijo}`;
  return `• ${nombre}: ${de === '—' ? de : `${de}${sufijo}`} → ${a}`;
}

/** «diferencial: más; cadencia: mucho menos», o vacio si no se sabe. */
function describirPerillas(ajustes: Partial<Record<string, unknown>> | null | undefined): string {
  if (!ajustes) return '';
  const partes: string[] = [];
  for (const perilla of PERILLAS) {
    const m = ajustes[perilla];
    // Los desplazamientos de una aprobacion salen de la columna `raw`, que es
    // JSON: se comprueba que cada uno sea de verdad un movimiento del contrato.
    if (typeof m !== 'string' || !Object.hasOwn(NOMBRE_DEL_MOVIMIENTO, m)) continue;
    partes.push(
      `${NOMBRE_DE_PERILLA[perilla]}: ${NOMBRE_DEL_MOVIMIENTO[m as keyof typeof NOMBRE_DEL_MOVIMIENTO]}`,
    );
  }
  return partes.join('; ');
}

/**
 * Cuando se escribe el aviso:
 *
 *   - `PROPUESTO`: una sugerencia que espera a que alguien la apruebe;
 *   - `APLICADO`: un cambio que el modo automatico ya ha aplicado;
 *   - `APROBADO`: el que se aplica al pulsar «Aplicar» en Telegram, con los
 *     valores recalculados en ese momento.
 */
export type Momento = 'PROPUESTO' | 'APLICADO' | 'APROBADO';

export interface Aviso {
  momento: Momento;
  cambios: readonly ChangedField[];
  /** El descriptor EFECTIVO del bot, de `camposEfectivos`. */
  campos: readonly FieldMeta[];
  /** Lo que pidio el modelo. Sin ello, el aviso no dice que perilla se movio. */
  ajustes?: Partial<Record<string, unknown>> | null;
  motivo?: string | null;
}

/** El texto entero de un `AI_SUGGESTION` o un `AI_APPLIED`. */
export function textoDeCambio(aviso: Aviso): string {
  const n = aviso.cambios.length;
  const cuantos = `${n} ${n === 1 ? 'parámetro' : 'parámetros'}`;
  const perillas = describirPerillas(aviso.ajustes);
  const porQue = perillas ? ` (${perillas})` : '';

  const cabecera =
    aviso.momento === 'PROPUESTO'
      ? `El supervisor propone cambiar ${cuantos}${porQue}:`
      : aviso.momento === 'APROBADO'
        ? `El supervisor ha cambiado ${cuantos} con tu aprobación${porQue}:`
        : `El supervisor ha cambiado ${cuantos}${porQue}:`;

  const porClave = new Map(aviso.campos.map((f) => [f.key, f]));
  const lineas = aviso.cambios.map((c) => lineaDeCambio(c, porClave.get(c.key)));
  const visibles =
    lineas.length > MAX_LINEAS
      ? [...lineas.slice(0, MAX_LINEAS - 1), `• … y ${lineas.length - MAX_LINEAS + 1} más`]
      : lineas;

  const partes = [cabecera, ...visibles];
  if (aviso.momento === 'APROBADO') {
    partes.push('Valores recalculados al aprobar, con el mercado de ese momento.');
  }
  // En una sola linea: el motivo lo escribe el modelo, y un salto suyo partiria
  // el aviso en trozos que parecen de otro evento.
  const motivo = (aviso.motivo ?? '').replace(/\s+/g, ' ').trim();
  if (motivo) partes.push(`Motivo: ${motivo}`);
  return partes.join('\n');
}

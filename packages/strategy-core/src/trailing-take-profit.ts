import {
  D,
  Decimal,
  Mutability,
  type Direction,
  type FieldMeta,
  type Numeric,
  type ValidationIssue,
} from '@crypton/shared';
import { err, warn } from './common';

/**
 * El take profit que SIGUE al precio.
 *
 * No es un bot en ninguna plataforma que lo tenga: en Binance y en Aster es un
 * tipo de orden (`TRAILING_STOP_MARKET`, con `activationPrice` y
 * `callbackRate`) y en 3Commas es una casilla del bot DCA. Aquí es lo segundo,
 * y estas funciones son el mecanismo que comparten las estrategias que lo
 * ofrecen, para que no puedan divergir (spec 042).
 *
 * La semántica es la del venue, citada literalmente de `asterdex/api-docs` V3:
 *
 * > SELL: «the highest price after order placed >= `activationPrice`, and the
 * > latest price <= the highest price × (1 − `callbackRate`)»
 *
 * Con una diferencia deliberada: el máximo se cuenta desde que se ACTIVA, no
 * desde que se coloca la orden. Es lo que espera quien configura «activa al
 * +15 %, sigue con 1 %»: el suelo de lo que cobra es `1,15 × 0,99 = +13,85 %`,
 * y no un retroceso medido contra un máximo anterior a la activación.
 *
 * Lo gestiona el motor en los tres venues por igual —solo Aster tiene trailing
 * nativo, y su `callbackRate` está capado al 5 %—, pero la orden que se coloca
 * **sí** es condicional nativa: dispara aunque el worker esté caído y aunque la
 * caída ocurra entre dos revisiones. El motor solo decide dónde ponerla.
 */

/** Clave del scratch: instante en que se cruzó el objetivo, en epoch ms. */
export const TTP_ARMED = 'ttpArmed';
/** Clave del scratch: extremo del ciclo, ya formateado a la retícula. */
export const TTP_PEAK = 'ttpPeak';

/** Lo que la estrategia lee de su configuración. */
export interface TrailingConfig {
  trailingTakeProfit?: boolean;
  trailingCallbackPct?: string;
  trailingRepriceBps?: number;
}

/**
 * Los tres campos, declarados UNA vez.
 *
 * Van aquí y no copiados en cada estrategia por la misma razón que
 * `MM_COMUNES`: dos copias del mismo mando acaban con rangos distintos, y el
 * usuario ve el mismo nombre haciendo cosas distintas en dos bots.
 *
 * `labelKey` se completa por estrategia —cada una tiene su espacio de
 * traducción— con `camposTrailing()`.
 *
 * `conInterruptor: false` devuelve los dos mandos SIN la casilla de encendido.
 * Lo pide la estrategia dedicada del spec 043, donde el seguimiento no es una
 * opción sino lo único que hace: una casilla para apagarlo la dejaría sin
 * identidad y dejaría además un estado en el que el bot no haría nada.
 */
export function camposTrailing(
  prefijo: string,
  opts: { conInterruptor?: boolean } = {},
): readonly FieldMeta[] {
  const interruptor: FieldMeta[] = [
    {
      key: 'trailingTakeProfit',
      kind: 'boolean',
      mutability: Mutability.HOT,
      labelKey: `strategy.${prefijo}.trailingTakeProfit`,
      helpKey: `strategy.${prefijo}.trailingTakeProfitHelp`,
      required: false,
      default: false,
      group: 'levels',
    },
  ];

  return [
    ...(opts.conInterruptor === false ? [] : interruptor),
    {
      key: 'trailingCallbackPct',
      kind: 'percent',
      mutability: Mutability.HOT,
      labelKey: `strategy.${prefijo}.trailingCallbackPct`,
      helpKey: `strategy.${prefijo}.trailingCallbackPctHelp`,
      min: 0.1,
      max: 10,
      step: 0.1,
      required: false,
      default: 1,
      group: 'levels',
    },
    {
      key: 'trailingRepriceBps',
      kind: 'integer',
      mutability: Mutability.HOT,
      labelKey: `strategy.${prefijo}.trailingRepriceBps`,
      helpKey: `strategy.${prefijo}.trailingRepriceBpsHelp`,
      min: 1,
      max: 200,
      step: 1,
      required: false,
      default: 20,
      advanced: true,
      group: 'levels',
    },
  ];
}

/**
 * Los dos mandos, SIN el interruptor.
 *
 * Lo pide la estrategia dedicada del spec 043, que no declara
 * `trailingTakeProfit` en su `meta.fields` porque allí el seguimiento no se
 * puede apagar. Y lo que no está en la meta no puede estar en la configuración:
 * `diffConfig` trata como COLD todo campo no declarado (spec 044 R-4).
 */
export const TRAILING_KNOBS_DEFAULTS = {
  trailingCallbackPct: '1',
  trailingRepriceBps: 20,
} as const;

/** Valores de fábrica. Apagado: encenderlo cambia dónde sale un bot en marcha. */
export const TRAILING_DEFAULTS = {
  trailingTakeProfit: false,
  ...TRAILING_KNOBS_DEFAULTS,
} as const;

/**
 * Lo que hay que decirle al usuario antes de dejarle encenderlo.
 *
 * Compartida por las estrategias que lo ofrecen: dos copias de la misma regla
 * acaban avisando de cosas distintas para el mismo número.
 */
export function validarTrailing(cfg: TrailingConfig): ValidationIssue[] {
  if (!cfg.trailingTakeProfit) return [];

  const cb = D(cfg.trailingCallbackPct ?? 0);
  if (!cb.isFinite() || cb.lte(0)) {
    return [err('trailingCallbackPct', 'El retroceso debe ser mayor que cero.')];
  }
  if (cb.gt(10)) {
    return [err('trailingCallbackPct', 'El retroceso no puede pasar del 10 %.')];
  }

  // Un trailing NO es una mejora gratis: en marcos cortos baja la tasa de
  // acierto, porque los retrocesos normales del 1-3 % de una cripto lo disparan
  // antes de tiempo. Medio punto es ya el primer respiro del par.
  if (cb.lt('0.5')) {
    return [
      warn(
        'trailingCallbackPct',
        'Un retroceso por debajo del 0,5 % te saca en el primer respiro del par: ' +
          'muchas criptos se mueven un 1-3 % al día sin cambiar de tendencia.',
      ),
    ];
  }
  return [];
}

/**
 * Lo que hay que borrar del `scratch` cuando el seguimiento está APAGADO.
 *
 * El interruptor es HOT, así que se puede apagar con el bot en marcha. Sin esto
 * las dos claves sobreviven hasta el cierre del ciclo, y volver a encenderlo
 * recupera un máximo de antes: con el pico en 140, retroceso del 10 % y la marca
 * ya en 100, el disparador nacía en 126 —una venta con disparo a la baja POR
 * ENCIMA del mercado—, o sea un cierre a mercado inmediato de la posición entera
 * (spec 044 R-1).
 *
 * Devuelve `null` si no había nada que limpiar: cada patch es un `UPDATE` en la
 * base sin amortiguar, y esto se evalúa en cada revisión.
 *
 * OJO con lo que NO arregla, porque parece lo mismo y no lo es: el disparador
 * inmediato tras un `PAUSE`/`RESUME` o tras un worker caído es CORRECTO. Allí el
 * seguimiento nunca se apagó y la condición de salida se cumplió de verdad; el
 * bot solo llegó tarde.
 */
export function limpiarTrailing(scratch: Record<string, unknown>): Record<string, unknown> | null {
  if (scratch[TTP_ARMED] == null && scratch[TTP_PEAK] == null) return null;
  // A `null` y no borrando la clave: el motor funde el patch sobre el scratch
  // (`{...scratch, ...patch}`), así que quitarla de aquí no la quitaría de allí.
  // `null` es lo que las dos lecturas tratan como ausente.
  return { [TTP_ARMED]: null, [TTP_PEAK]: null };
}

/** Lo que hace falta para decidir dónde va el disparador. */
export interface TrailingInput {
  /** El scratch del ciclo. Se lee, no se escribe: el patch va en la salida. */
  scratch: Record<string, unknown>;
  /** Extremos vistos por el stream desde la última planificación, si los hay. */
  extremos?: { alto: string; bajo: string };
  /** Precio de MARCA. Ver por qué la marca en `extremoDelCiclo`. */
  mark: Numeric;
  /** El objetivo de siempre, que con el trailing encendido pasa a ser activación. */
  activacion: Numeric;
  direction: Direction;
  callbackPct: Numeric;
  repriceBps: Numeric;
  now: number;
}

export interface TrailingOut {
  /** ¿Se cruzó ya el objetivo? Mientras sea `false` no hay salida de beneficio. */
  armado: boolean;
  /**
   * Precio al que colocar el disparador, sin redondear. `null` si no está
   * armado: por debajo del objetivo no hay nada que asegurar y el `stopLossPct`
   * nativo sigue cubriendo la bajada.
   */
  disparo: Decimal | null;
  /** Extremo vigente del ciclo (el que manda, no el candidato). */
  extremo: Decimal;
  /** Qué escribir en el scratch. Vacío = no escribir nada. */
  patch: Record<string, unknown>;
  /** Para la nota del plan, en castellano y sin adornos. */
  nota: string;
}

/**
 * Extremo del ciclo: lo persistido, lo visto por el stream y la marca de ahora.
 *
 * Los tres, y se queda con el mayor (o el menor, en corto). El del stream es lo
 * que hace que un pico que sube y baja entre dos revisiones cuente: el motor
 * planifica cada quince segundos y recibe precios varias veces por segundo.
 *
 * De la MARCA y no del último negociado porque es el que los venues suavizan:
 * un mal print no puede inventar un máximo y, con él, un disparador ya por
 * debajo del mercado que cerraría la posición al instante.
 */
export function extremoDelCiclo(
  scratch: Record<string, unknown>,
  extremos: { alto: string; bajo: string } | undefined,
  mark: Numeric,
  direction: Direction,
): Decimal {
  const largo = direction !== 'SHORT';
  const candidatos: Decimal[] = [D(mark)];

  const guardado = scratch[TTP_PEAK];
  if (typeof guardado === 'string') {
    const p = D(guardado);
    if (p.isFinite() && p.gt(0)) candidatos.push(p);
  }

  if (extremos) {
    const visto = D(largo ? extremos.alto : extremos.bajo);
    if (visto.isFinite() && visto.gt(0)) candidatos.push(visto);
  }

  return largo ? Decimal.max(...candidatos) : Decimal.min(...candidatos);
}

/**
 * El disparador vigente del trailing, y si toca moverlo.
 *
 * Tres estados, en este orden:
 *
 * 1. **Sin armar**: el extremo no ha llegado al objetivo. No hay orden de
 *    beneficio; el stop del usuario sigue intacto.
 * 2. **Armando**: el extremo cruza el objetivo en esta revisión. Se anota
 *    `ttpArmed` y nace el disparador.
 * 3. **Armado**: el disparador sube con el extremo y NUNCA baja.
 *
 * El armado es irreversible dentro del ciclo, como el `activationGate` del
 * market maker V2: un precio que vuelve a bajar no desarma un bot que ya tiene
 * inventario que proteger. Y no hace falta limpiarlo: al cerrarse el ciclo,
 * `cycle-accounting` reinicia el scratch entero.
 */
export function trailingVigente(input: TrailingInput): TrailingOut {
  const largo = input.direction !== 'SHORT';
  const objetivo = D(input.activacion);
  const extremo = extremoDelCiclo(input.scratch, input.extremos, input.mark, input.direction);
  const patch: Record<string, unknown> = {};

  // ── 1. ¿Está armado? ──────────────────────────────────────────────
  const yaArmado = input.scratch[TTP_ARMED] != null;
  const cruza = largo ? extremo.gte(objetivo) : extremo.lte(objetivo);

  if (!yaArmado && !cruza) {
    const falta = largo ? 'suba a' : 'baje a';
    return {
      armado: false,
      disparo: null,
      extremo,
      patch,
      nota:
        `Objetivo en ${objetivo.toFixed()}: el seguimiento empieza cuando el precio ${falta} ` +
        'ese nivel. Hasta entonces solo protege el stop loss.',
    };
  }
  if (!yaArmado) patch[TTP_ARMED] = input.now;

  // ── 2. El disparador que sale del extremo ─────────────────────────
  //
  // `extremo × (1 ∓ retroceso)`, la fórmula del venue. Puede quedar POR DEBAJO
  // del mark —lo normal— o por encima si el precio ya ha retrocedido más que el
  // retroceso configurado. Lo segundo parece el fallo 001/F-80 y no lo es: es
  // justo la condición de salida cumplida, así que que el venue lo ejecute al
  // colocarlo es lo correcto.
  const retroceso = D(input.callbackPct).div(100);
  const factor = largo ? D(1).minus(retroceso) : D(1).plus(retroceso);
  const candidato = extremo.mul(factor);

  const guardado = input.scratch[TTP_PEAK];
  const previoPeak = typeof guardado === 'string' ? D(guardado) : null;
  const previo =
    previoPeak && previoPeak.isFinite() && previoPeak.gt(0) ? previoPeak.mul(factor) : null;

  // ── 3. ¿Se recoloca? ──────────────────────────────────────────────
  //
  // Solo si ha avanzado de verdad. Cada patch del scratch es un UPDATE en la
  // base sin amortiguar, y cancelar+recolocar son DOS peticiones: en Lighter el
  // cupo son 60 por minuto de TODA la IP, o sea unas 25 recolocaciones.
  //
  // El avance va CON SIGNO y no en valor absoluto: el extremo se calcula ya
  // como máximo (o mínimo) contra lo persistido, así que el candidato no puede
  // quedar peor que el anterior, y medir el retroceso en valor absoluto sería
  // admitir que sí.
  const avanceBps = previo?.gt(0)
    ? (largo ? candidato.minus(previo) : previo.minus(candidato)).div(previo).mul(D(10_000))
    : D(Number.MAX_SAFE_INTEGER);
  const recoloca = !previo || avanceBps.gte(D(input.repriceBps));

  // Mientras no toque recolocar manda el ANTERIOR, no el candidato. Devolver el
  // candidato «por ser mejor» movería el precio de la orden en cada revisión y
  // el motor la cancelaría y recolocaría igual: el umbral no serviría de nada.
  // Es el mismo defecto que el spec 029 corrigió en `autoAdjustDistance`.
  const disparo = recoloca || !previo ? candidato : previo;
  if (recoloca) patch[TTP_PEAK] = extremo.toFixed();

  const pct = D(input.callbackPct).toFixed();
  return {
    armado: true,
    disparo,
    extremo,
    patch,
    nota:
      `Seguimiento activo desde ${objetivo.toFixed()}. ` +
      `${largo ? 'Máximo' : 'Mínimo'} ${extremo.toFixed()}, sale si retrocede ${pct} %.`,
  };
}

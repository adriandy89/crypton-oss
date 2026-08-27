import { D, type BotConfig, type FieldMeta } from '@crypton/shared';

/**
 * Saneado de una configuración antes de compartirla, y su expansión al copiarla.
 *
 * Compartir un bot NO debe compartir dos cosas:
 *
 *   1. Con qué cuenta opera. `exchangeAccountId` es un identificador interno y
 *      el par puede no existir en el venue del que copia.
 *   2. Cuánto dinero mueve su autor. Los importes absolutos revelan el tamaño de
 *      su cartera, y —peor— desplegarlos tal cual sobre otra cuenta significaría
 *      que alguien con 100 USDC copia un bot dimensionado para 50.000.
 *
 * La solución es guardar los importes como PROPORCIÓN de la inversión total y
 * reexpandirlos contra el capital que ponga quien copia. Los porcentajes, los
 * multiplicadores y los contadores viajan tal cual: son la forma de la
 * estrategia, que es justo lo que se quiere copiar.
 */

/** Campos que nunca se comparten: identifican la cuenta, no la estrategia. */
const NEVER_SHARE = new Set(['exchangeAccountId', 'symbol', 'totalInvestment']);

export interface SharedConfig {
  /** Versión del formato; permite cambiar el saneado sin romper lo ya publicado. */
  v: 1;
  strategy: string;
  /** Campos que no son dinero, tal cual. */
  params: Record<string, unknown>;
  /**
   * Campos monetarios expresados como fracción de `totalInvestment`.
   * `amountPerBuy: 0.1` significa "un 10 % del capital en cada compra".
   */
  ratios: Record<string, string>;
}

const isMoney = (field: FieldMeta): boolean => field.kind === 'money';

/**
 * Convierte una configuración real en una compartible.
 *
 * **Lista blanca, no negra.** Antes, cualquier clave que no estuviera declarada
 * como dinero pasaba tal cual, y `NEVER_SHARE` era una lista de dos nombres. Un
 * campo nuevo de una estrategia —o uno cuyos metadatos aún no existieran— se
 * publicaba entero por omisión, con el importe que llevara dentro. Ahora solo
 * sale lo que tiene `FieldMeta` conocida: lo que no se reconoce, no se comparte.
 *
 * Tampoco viaja `originalInvestment`. Estaba como «referencia informativa», pero
 * era exactamente el número que este códec existe para ocultar: el capital del
 * autor, con dos decimales.
 */
export function sanitizeForShare(
  config: BotConfig,
  fields: readonly FieldMeta[],
  strategy: string,
): SharedConfig {
  const total = D(config.totalInvestment ?? 0);
  const params: Record<string, unknown> = {};
  const ratios: Record<string, string> = {};

  const byKey = new Map(fields.map((f) => [f.key, f]));

  for (const [key, value] of Object.entries(config)) {
    if (NEVER_SHARE.has(key)) continue;

    const field = byKey.get(key);
    // Sin metadatos no se comparte: no hay forma de saber si lleva un importe,
    // un identificador o cualquier otra cosa que no deba salir.
    if (!field) continue;

    if (isMoney(field) && value != null && value !== '') {
      const amount = D(value as string);
      ratios[key] = total.gt(0) ? amount.div(total).toFixed(8) : '0';
      continue;
    }
    params[key] = value;
  }

  return { v: 1, strategy, params, ratios };
}

/**
 * Reconstruye una configuración a partir de la compartida, dimensionada al
 * capital y al mercado de quien copia.
 */
export function expandFromShare(
  shared: SharedConfig,
  input: { exchangeAccountId: string; symbol: string; totalInvestment: string },
): BotConfig {
  const total = D(input.totalInvestment);
  const config: Record<string, unknown> = { ...shared.params };

  for (const [key, ratio] of Object.entries(shared.ratios)) {
    const amount = total.mul(ratio);
    // Se redondea a 2 decimales: son importes en la quote del mercado, y
    // arrastrar ocho decimales solo produce números feos en el formulario.
    config[key] = amount.toFixed(2);
  }

  config['exchangeAccountId'] = input.exchangeAccountId;
  config['symbol'] = input.symbol;
  config['totalInvestment'] = total.toFixed(2);

  return config as BotConfig;
}

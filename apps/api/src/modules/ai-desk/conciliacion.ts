import {
  D,
  EstadoPropuestaAgente,
  MotivoPropuestaAgente,
  SalidaOperacionAgente,
} from '@crypton/shared';

/**
 * El estado de una operación sigue al de su bot (spec 074, R-21). Puro: el
 * servicio lee el bot, su primer ciclo y su aviso de salida, y aquí se decide
 * qué escribir en la propuesta.
 *
 * El primer ciclo ES la operación: `AGENT_TRADE` solo entra en el ciclo 1, y
 * cualquier cierre lo cierra.
 */

/** El primer ciclo del bot, con lo que la conciliación mira de él. */
export interface CicloOperacion {
  entries_filled: number;
  qty: string;
  realized_pnl: string;
  opened_at: Date;
  last_entry_at: Date | null;
  closed_at: Date | null;
}

/** Lo que se lee del bot de una operación. `estado` null: el bot ya no existe. */
export interface BotDeOperacion {
  estado: string | null;
  ciclo: CicloOperacion | null;
  /** El `motivo` del aviso `AGENT_EXIT`, si lo hubo. */
  motivoSalida: string | null;
}

/** Lo que se escribe en la propuesta, o null si no cambia nada. */
export interface CambioOperacion {
  state: EstadoPropuestaAgente;
  reason?: string;
  opened_at?: Date;
  closed_at?: Date;
  exit?: string;
  realized_pnl?: string | null;
  r_real?: string | null;
}

/** Los estados en los que un bot ya no va a hacer nada más. */
const BOT_TERMINADO = new Set(['STOPPED', 'LIQUIDATED']);

const SALIDAS: readonly string[] = Object.values(SalidaOperacionAgente);

/** El R real: lo realizado sobre la pérdida al stop del plan. null sin riesgo. */
export function rReal(realizado: string, riesgo: string | null): string | null {
  if (!riesgo) return null;
  try {
    const base = D(riesgo);
    return base.gt(0) ? D(realizado).div(base).toDecimalPlaces(8).toFixed() : null;
  } catch {
    return null;
  }
}

/**
 * Qué le pasa a una operación EJECUTANDO o ABIERTA según su bot.
 *
 * - Con el primer ciclo cerrado: CERRADA, con lo realizado, su R y cómo salió.
 * - Con una ejecución de entrada: ABIERTA.
 * - Con el bot terminado y sin entrada: SIN_ENTRADA —la IOC no se llenó, o la
 *   idea caducó antes—.
 * - Con el bot terminado y la operación abierta sin ciclo cerrado: CERRADA
 *   por FUERA, sin R: alguien lo paró dejando la posición, y lo que pase con
 *   ella ya no lo ve el bot.
 * - Sin bot: si nunca entró, SIN_ENTRADA; si estaba abierta, FUERA.
 *
 * Un bot en ERROR no cambia nada: se puede reparar, y su stop sigue en el
 * exchange.
 */
export function conciliacion(
  propuesta: { state: string; opened_at: Date | null; riesgo: string | null },
  bot: BotDeOperacion,
  ahora: Date,
): CambioOperacion | null {
  const abierta = propuesta.state === EstadoPropuestaAgente.ABIERTA;
  const ciclo = bot.ciclo;
  const entro = ciclo !== null && (ciclo.entries_filled > 0 || D(ciclo.qty).gt(0));
  const abiertaEn = propuesta.opened_at ?? ciclo?.last_entry_at ?? ciclo?.opened_at ?? ahora;

  if (ciclo?.closed_at && (entro || abierta)) {
    return {
      state: EstadoPropuestaAgente.CERRADA,
      opened_at: abiertaEn,
      closed_at: ciclo.closed_at,
      exit:
        bot.motivoSalida && SALIDAS.includes(bot.motivoSalida)
          ? bot.motivoSalida
          : SalidaOperacionAgente.FUERA,
      realized_pnl: ciclo.realized_pnl,
      r_real: rReal(ciclo.realized_pnl, propuesta.riesgo),
    };
  }
  if (bot.estado === null) {
    return abierta || entro
      ? {
          state: EstadoPropuestaAgente.CERRADA,
          opened_at: abiertaEn,
          closed_at: ahora,
          exit: SalidaOperacionAgente.FUERA,
          realized_pnl: null,
          r_real: null,
        }
      : {
          state: EstadoPropuestaAgente.SIN_ENTRADA,
          reason: MotivoPropuestaAgente.SIN_LLENADO,
          closed_at: ahora,
        };
  }
  if (!abierta && entro) {
    return { state: EstadoPropuestaAgente.ABIERTA, opened_at: abiertaEn };
  }
  if (BOT_TERMINADO.has(bot.estado)) {
    return abierta || entro
      ? {
          state: EstadoPropuestaAgente.CERRADA,
          opened_at: abiertaEn,
          closed_at: ahora,
          exit: SalidaOperacionAgente.FUERA,
          realized_pnl: ciclo?.realized_pnl ?? null,
          r_real: null,
        }
      : {
          state: EstadoPropuestaAgente.SIN_ENTRADA,
          reason: MotivoPropuestaAgente.SIN_LLENADO,
          closed_at: ahora,
        };
  }
  return null;
}

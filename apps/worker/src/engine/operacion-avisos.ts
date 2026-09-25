import { D, EventoOperacionAgente, SalidaOperacionAgente, type Decimal } from '@crypton/shared';
import { INDICE_CIERRE, INDICE_REDUCCION, parseCoid } from '@crypton/strategy-core';
import type { EventoCierre } from './bot-store';

/**
 * El aviso de salida de la operación de un agente (spec 074), como funciones
 * puras. Sale al cerrarse el ciclo EN LUGAR de `CYCLE_CLOSED`, como el del
 * canal: lleva lo mismo —el resultado y el ciclo— y además el R y por qué
 * terminó. Es el que llega por Telegram y el que la API usa para conciliar.
 */

/** Los cierres a mercado del propio runner van del 999 hacia abajo hasta aquí. */
const INDICE_CIERRE_MOTOR = 512;

/** Quién mandó un cierre del motor: una persona o una red de seguridad. */
export type OrigenCierreMotor = 'MANUAL' | 'SEGURIDAD';

/**
 * Por qué terminó la operación, a partir de la orden que la cerró:
 * - el stop —protegido si la operación no perdió—;
 * - un objetivo;
 * - una reducción del seguimiento que la dejó a cero;
 * - un cierre a mercado de la estrategia, con el motivo que dejó en el scratch;
 * - un cierre a mercado del motor: un comando de su dueño o una red de
 *   seguridad (el vigilante del stop, la guarda de liquidación);
 * - una liquidación del venue.
 */
export function motivoDeSalidaAgente(
  clientOrderId: string | null,
  liquidacion: boolean,
  cierre: unknown,
  resultado: Decimal,
  delMotor: OrigenCierreMotor,
): SalidaOperacionAgente {
  if (liquidacion) return SalidaOperacionAgente.LIQUIDACION;
  const porStop = resultado.gte(0)
    ? SalidaOperacionAgente.STOP_PROTEGIDO
    : SalidaOperacionAgente.STOP;
  const c = clientOrderId ? parseCoid(clientOrderId) : null;
  if (!c || (c.kind !== 'STOP_LOSS' && c.kind !== 'TAKE_PROFIT')) {
    return SalidaOperacionAgente[delMotor];
  }
  if (c.kind === 'STOP_LOSS') return porStop;
  if (c.levelIndex >= INDICE_CIERRE_MOTOR) return SalidaOperacionAgente[delMotor];
  if (c.levelIndex >= INDICE_CIERRE) {
    const motivo =
      typeof cierre === 'object' && cierre !== null
        ? (cierre as { motivo?: unknown }).motivo
        : undefined;
    if (motivo === 'TIEMPO') return SalidaOperacionAgente.TIEMPO;
    if (motivo === 'SEGUIMIENTO') return SalidaOperacionAgente.SEGUIMIENTO;
    if (motivo === 'STOP' || motivo === 'TRAILING') return porStop;
    // El stop que no saltó, la liquidación demasiado cerca o el apalancamiento
    // distinto del pedido: las salidas de seguridad de la estrategia.
    return SalidaOperacionAgente.SEGURIDAD;
  }
  if (c.levelIndex >= INDICE_REDUCCION) return SalidaOperacionAgente.SEGUIMIENTO;
  return SalidaOperacionAgente.OBJETIVO;
}

const TEXTO_SALIDA: Readonly<Record<SalidaOperacionAgente, string>> = {
  OBJETIVO: 'objetivo',
  STOP: 'stop',
  STOP_PROTEGIDO: 'stop protegido',
  TIEMPO: 'por tiempo',
  SEGUIMIENTO: 'por el seguimiento',
  SEGURIDAD: 'salida de seguridad',
  MANUAL: 'cierre de su dueño',
  LIQUIDACION: 'liquidación',
  FUERA: 'cerrada fuera del bot',
};

const signo = (x: Decimal): string => (x.gte(0) ? '+' : '');

/**
 * El evento del cierre. El R es el resultado sobre la pérdida al stop que
 * declaró la operación (`riskAmount`); sin ella, no hay R.
 */
export function eventoDeSalidaAgente(
  cierre: { seq: number; pnl: Decimal },
  riesgo: string | null,
  motivo: SalidaOperacionAgente,
  quote: string,
): EventoCierre {
  let r: Decimal | null = null;
  try {
    const base = riesgo ? D(riesgo) : null;
    r = base?.gt(0) ? cierre.pnl.div(base) : null;
  } catch {
    r = null;
  }
  const enR = r ? ` (${signo(r)}${r.toFixed(2)} R)` : '';
  return {
    type: EventoOperacionAgente.SALIDA,
    severity: motivo === SalidaOperacionAgente.LIQUIDACION ? 'WARN' : 'INFO',
    message:
      `Operación cerrada (${TEXTO_SALIDA[motivo]}): ` +
      `${signo(cierre.pnl)}${cierre.pnl.toFixed(2)} ${quote}${enR}.`,
    payload: {
      realizedPnl: cierre.pnl.toFixed(),
      seq: cierre.seq,
      r: r ? r.toDecimalPlaces(4).toNumber() : null,
      motivo,
    },
  };
}

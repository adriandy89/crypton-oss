import type { LevelKind } from '@crypton/shared';

/**
 * IDs de cliente deterministas: la pieza que sostiene toda la idempotencia.
 *
 * El mismo nivel lógico produce SIEMPRE el mismo id mientras dure el ciclo, de
 * modo que dos ticks seguidos no colocan dos órdenes, y un worker que se
 * reinicia reconoce como suyas las órdenes que ya están en el libro.
 *
 * `cycleSeq` entra en el id a propósito: al cerrar un ciclo y abrir el
 * siguiente, los ids cambian y el venue no puede quejarse de id duplicado por
 * una orden anterior que aún tenga en su historial.
 */

const KIND_CODE: Record<LevelKind, string> = {
  BASE: 'B',
  SAFETY: 'S',
  GRID_BUY: 'GB',
  GRID_SELL: 'GS',
  TAKE_PROFIT: 'TP',
  STOP_LOSS: 'SL',
  QUOTE_BID: 'QB',
  QUOTE_ASK: 'QA',
};

/**
 * Prefijo estable del uuid del bot: 16 caracteres hex, 64 bits.
 *
 * Eran 8 (32 bits), y era poco. `client_order_id` es único a nivel GLOBAL, así
 * que dos bots que compartieran prefijo generaban el mismo id canónico en
 * cuanto coincidían ciclo, tipo y nivel — cosa que pasa de continuo, porque
 * todos los bots empiezan en el ciclo 1 con `B0`. El `upsert` que graba la
 * orden reasignaba entonces la fila de OTRO usuario al bot que escribiera, y
 * con ella sus ejecuciones.
 *
 * Lo que lo hacía serio no era la probabilidad: era que se podía dirigir. El
 * ranking entrega identificadores de bots reales de otros usuarios, así que
 * crear y borrar bots en bucle permitía buscar una coincidencia contra un
 * objetivo elegido. A 32 bits eso es alcanzable; a 64 deja de serlo.
 *
 * No hay problema de longitud: Hyperliquid y Lighter hashean el id canónico, y
 * el límite de 36 caracteres de Aster sigue holgado (~26 en el peor caso).
 */
const SHORT_ID_LENGTH = 16;

/** Longitud anterior. Solo la usa el parser, para reconocer ids ya emitidos. */
const LEGACY_SHORT_ID_LENGTH = 8;

export const botShortId = (botId: string): string =>
  botId.replace(/-/g, '').slice(0, SHORT_ID_LENGTH);

export function makeCoid(
  botId: string,
  cycleSeq: number,
  kind: LevelKind,
  levelIndex: number,
): string {
  return `${botShortId(botId)}.${cycleSeq}.${KIND_CODE[kind]}${levelIndex}`;
}

/**
 * Inverso de `makeCoid`; null si la cadena no la generamos nosotros.
 *
 * Acepta también el prefijo corto anterior para que las órdenes ya colocadas en
 * el libro se sigan reconociendo como propias tras el cambio de longitud. Sin
 * esto, el reconciliador las tomaría por ajenas y las dejaría vivas para
 * siempre: no se cancelarían ni se repondrían, y quedarían fuera de la
 * contabilidad del ciclo.
 */
export function parseCoid(
  coid: string,
): { botShort: string; cycleSeq: number; kind: LevelKind; levelIndex: number } | null {
  const m = new RegExp(
    // El largo primero: si probara el corto antes, dependería del retroceso del
    // motor de expresiones para llegar al correcto.
    `^([0-9a-f]{${SHORT_ID_LENGTH}}|[0-9a-f]{${LEGACY_SHORT_ID_LENGTH}})\\.(\\d+)\\.([A-Z]{1,2})(\\d+)$`,
  ).exec(coid);
  if (!m) return null;
  const entry = Object.entries(KIND_CODE).find(([, code]) => code === m[3]);
  if (!entry) return null;
  return {
    botShort: m[1],
    cycleSeq: Number(m[2]),
    kind: entry[0] as LevelKind,
    levelIndex: Number(m[4]),
  };
}

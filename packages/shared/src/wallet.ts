import type { Position } from './market';

/**
 * Lo que hace falta saber para decidir CUANTO capital cabe en un bot.
 *
 * No es «el saldo de una conexion»: junta cuatro fuentes que hasta ahora
 * llegaban por caminos distintos —o no llegaban— y que solo juntas responden a
 * la pregunta que se hace el usuario delante del campo «Capital asignado»:
 *
 *   · el venue      → cuanto hay y cuanto esta libre
 *   · Postgres      → cuanto tienen pedido ya los demas bots de ESTA conexion
 *   · RiskService   → los topes que el propio usuario se puso
 *   · el venue, otra vez → la posicion abierta en el par, si la hay
 *
 * Todo numerico viaja como string por el mismo motivo que en `MarketSpec`: no
 * perder precision al pasar por JSON.
 */
export interface CapitalSnapshot {
  /** La quote de la cuenta. Hoy 'USDC' en los tres venues. */
  asset: string;
  /** Equity total. `null` = no se ha podido leer; ver `unavailable`. */
  total: string | null;
  /** Margen libre: el techo real del capital de un bot nuevo. */
  available: string | null;
  /** Inmovilizado por posiciones y ordenes abiertas. */
  used: string | null;

  /**
   * Epoch ms de la lectura del venue. `null` = nunca se pudo leer.
   *
   * Se manda SIEMPRE y la interfaz lo pinta. Un saldo sin fecha invita a
   * creerselo al segundo, y este viaja cacheado hasta 15 s —o mucho mas si el
   * venue no responde y se sirve el ultimo bueno.
   */
  at: number | null;
  /** true = esto es el ultimo valor bueno, no una lectura de ahora. */
  stale: boolean;

  /**
   * Por que no hay cifras. `null` = todo bien.
   *
   * Nunca viaja como error HTTP: este endpoint no puede impedir crear un bot.
   * Un venue caido tiene que dejar el asistente exactamente como estaba antes
   * de que existiera el saldo.
   */
  unavailable: { reason: 'VENUE' | 'CREDENTIAL'; message: string } | null;

  /** Posicion abierta en el simbolo pedido. `null` si no se pidio o esta plana. */
  position: Position | null;

  /** Lo que ya tienen pedido los DEMAS bots vivos sobre esta misma conexion. */
  committed: {
    /** Suma de `total_investment`. Es margen, no notional. */
    margin: string;
    /** Suma de `total_investment x leverage`. */
    notional: string;
    bots: number;
  };

  /**
   * Los mismos numeros que producen el 403 de `assertWithinLimits`.
   *
   * Van aqui, y no se recalculan en la app, justamente para que no puedan
   * discrepar: el sintoma de una segunda implementacion seria la pantalla
   * diciendo «te caben 5.000 mas» y el servidor respondiendo 403.
   */
  limits: {
    maxLeverage: number | null;
    maxNotionalPerBot: string | null;
    maxTotalNotional: string | null;
    /** Notional de TODOS los bots vivos del usuario, en todas sus conexiones. */
    currentTotalNotional: string;
  };
}

/**
 * Claves de la cache de cartera.
 *
 * Viven en el contrato, al lado de lo que cachean, y no sueltas en el servicio
 * que las escribe: el prefijo lleva version (`v1`) y cambiarlo tiene que ser un
 * solo gesto.
 *
 * Las conexiones de SIMULACION no pasan por aqui: su saldo esta en Postgres y no
 * cuesta nada leerlo, asi que no se cachea y un reinicio se ve en el acto.
 */
const WALLET_CACHE_PREFIX = 'crypton:wallet:v1';
const WALLET_LAST_CACHE_PREFIX = 'crypton:wallet:last:v1';

/** Las claves EXACTAS de una lectura concreta. `symbol` ausente = sin par. */
export function walletCacheKeys(
  userId: string,
  accountId: string,
  symbol?: string,
): { key: string; lastKey: string } {
  const suffix = `${userId}:${accountId}:${symbol ?? '-'}`;
  return {
    key: `${WALLET_CACHE_PREFIX}:${suffix}`,
    lastKey: `${WALLET_LAST_CACHE_PREFIX}:${suffix}`,
  };
}

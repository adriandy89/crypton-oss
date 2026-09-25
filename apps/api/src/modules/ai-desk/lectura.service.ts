import { Injectable, Logger } from '@nestjs/common';
import { D, type IntervaloAgente, type Venue } from '@crypton/shared';
import { VELAS_AGENTE, type ParAgente } from '@crypton/strategy-core';
import { BotsService } from '../bots/bots.service';
import { MarketDataService, MarketStreamService } from '../market-data';
import { MarketsService } from '../markets';
import { RiskService } from '../risk/risk.service';

/** Lo que se lee de un par, y si faltaron sus tramos de apalancamiento. */
export interface LecturaPar {
  par: ParAgente;
  /** El venue publica tramos y no se pudieron leer: ese par no ofrece nada. */
  sinTramos: boolean;
}

/** Un agente, con lo que hace falta para declarar sus pares. */
export interface InteresAgente {
  venue: string;
  symbols: readonly string[];
  exchange_account: { testnet: boolean };
}

/** Quien declara el interés de los agentes en el flujo de precios. */
export const ORIGEN_INTERES = 'ai-desk';

/**
 * Lo que un agente lee del mercado y de la cuenta (spec 074): la ficha, las
 * velas, el ticker y los tramos de cada par; el saldo libre; y el tope de
 * apalancamiento del usuario. Lo usan la ronda y el recálculo al aprobar, que
 * así leen igual.
 *
 * Nada de aquí descifra una clave para leer un dato público: las velas, el
 * ticker y los tramos van por el adaptador público y el presupuesto por IP de
 * siempre. El saldo sí es de la cuenta, y lo lee `BotsService.capital`, el
 * mismo camino que el asistente de bots, con su caché.
 */
@Injectable()
export class AiDeskLecturaService {
  private readonly logger = new Logger(AiDeskLecturaService.name);

  constructor(
    private readonly markets: MarketsService,
    private readonly marketData: MarketDataService,
    private readonly stream: MarketStreamService,
    private readonly bots: BotsService,
    private readonly risk: RiskService,
  ) {}

  /**
   * Un par, o null si ya no está en el catálogo. Lo que falle al leerse queda
   * vacío —sin velas, sin ticker— y la herramienta lo descarta con su motivo.
   */
  async par(
    venue: Venue,
    simbolo: string,
    testnet: boolean,
    intervalo: IntervaloAgente,
  ): Promise<LecturaPar | null> {
    const market = await this.markets.getSpec(venue, simbolo, testnet).catch(() => null);
    if (!market) return null;
    const [velas, ticker, niveles] = await Promise.all([
      this.marketData
        .candles(venue, simbolo, intervalo, { limit: VELAS_AGENTE, testnet })
        .catch((e: Error) => {
          this.logger.debug(`Sin velas de ${simbolo} en ${venue}: ${e.message}`);
          return [];
        }),
      this.marketData.ticker(venue, simbolo, testnet),
      this.marketData.tramos(venue, simbolo, testnet),
    ]);
    return {
      par: {
        simbolo,
        market,
        ticker,
        velas,
        fundingBps: fundingBps(ticker?.fundingRate),
        niveles: niveles ?? [],
      },
      sinTramos: niveles === null,
    };
  }

  /**
   * El margen libre de la cuenta, o null si no se ha podido leer: sin saldo no
   * se dimensiona nada. En la cuenta de simulación es el del simulador.
   */
  async saldoLibre(
    userId: string,
    exchangeAccountId: string,
    simbolo?: string,
  ): Promise<string | null> {
    try {
      const c = await this.bots.capital(userId, {
        exchangeAccountId,
        ...(simbolo ? { symbol: simbolo } : {}),
      });
      return c.available;
    } catch (e) {
      this.logger.debug(`Sin saldo de la cuenta ${exchangeAccountId}: ${(e as Error).message}`);
      return null;
    }
  }

  /** El tope de apalancamiento que se ha puesto el usuario, o null si no tiene. */
  async maxApalancamiento(userId: string): Promise<number | null> {
    const limites = await this.risk.get(userId);
    return limites.max_leverage ?? null;
  }

  /**
   * Declara en el flujo de precios los pares de los agentes que miran, para
   * que el worker mantenga su ticker vivo en Redis (ver
   * `MarketStreamService.fijarInteresServidor`). Se llama en cada barrido con
   * el conjunto ENTERO: un par que deja de mirarse se suelta solo.
   */
  declararInteres(agentes: readonly InteresAgente[]): void {
    const principal = new Set<string>();
    const pruebas = new Set<string>();
    for (const a of agentes) {
      const destino = a.exchange_account.testnet ? pruebas : principal;
      for (const s of a.symbols) destino.add(`${a.venue}:${s}`);
    }
    this.stream.fijarInteresServidor(ORIGEN_INTERES, [...principal], false);
    this.stream.fijarInteresServidor(ORIGEN_INTERES, [...pruebas], true);
  }
}

/**
 * El funding del ticker —fracción por periodo, con signo— en puntos básicos,
 * o null si el venue no lo publica. Es estadística: no vuelve a una orden.
 */
export function fundingBps(tasa: string | undefined): number | null {
  if (tasa === undefined || tasa.trim() === '') return null;
  try {
    const bps = D(tasa).mul(10_000).toNumber();
    return Number.isFinite(bps) ? bps : null;
  } catch {
    return null;
  }
}

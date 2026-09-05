import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { BacktestResult, BacktestSource, CandleInterval } from '@crypton/shared';
import { environment } from '../../../environments/environment';

/**
 * Backtesting histórico, para cualquier usuario sobre sus bots simulados (spec 004).
 *
 * No hay canal de progreso ni sondeo: la ejecución es SÍNCRONA en el servidor
 * —una rejilla de cien niveles sobre treinta días en velas de cinco minutos son
 * unos siete segundos— y la respuesta trae ya el resultado completo. Montar un
 * canal para eso habría sido complicar las dos puntas sin ganar nada.
 */

export interface BacktestSourceInfo {
  id: BacktestSource;
  intervals: CandleInterval[];
  marketTypes: string[];
  maxBarsPerRequest: number;
}

/** Fila del historial: lo justo para una lista y para comparar. */
export interface BacktestSummary {
  id: string;
  bot_id: string | null;
  symbol: string;
  strategy: string;
  source: BacktestSource;
  interval: string;
  from_ms: string;
  to_ms: string;
  bars: number;
  duration_ms: number;
  metrics: BacktestResult['metrics'];
  created_at: string;
}

/**
 * Una ejecución guardada tal y como la devuelve `GET /backtests/:id`: la fila de
 * `backtest_runs`. Los `BigInt` llegan como texto y las columnas JSON con la
 * forma con la que se guardaron (`BacktestResult`). Es lo que permite REABRIR
 * un backtest sin volver a correrlo (spec 004).
 */
export interface BacktestRun {
  id: string;
  bot_id: string | null;
  venue: string;
  symbol: string;
  strategy: string;
  config_version: number | null;
  source: BacktestSource;
  source_symbol: string;
  market_type: string;
  interval: CandleInterval;
  from_ms: string;
  to_ms: string;
  params: BacktestResult['params'];
  bars: number;
  ticks: number;
  fills_total: number;
  duration_ms: number;
  metrics: BacktestResult['metrics'];
  equity_curve: BacktestResult['equity'];
  candles: BacktestResult['candles'];
  warnings: string[];
  created_at: string;
}

/** Una fila de `backtest_fills` (`GET /backtests/:id/fills`). */
export interface BacktestFillRow {
  ts: string;
  side: 'BUY' | 'SELL';
  level_kind: string | null;
  level_index: number | null;
  cycle_seq: number;
  price: string;
  qty: string;
  fee: string;
  is_taker: boolean;
  liquidation: boolean;
  position_after: string;
  realized_acc_after: string;
}

export interface RunBacktestInput {
  botId: string;
  source: BacktestSource;
  interval: CandleInterval;
  fromMs: number;
  toMs: number;
  marketType?: string;
  symbolOverride?: string;
  startingBalance?: string;
  makerFeeRate?: string;
  takerFeeRate?: string;
  slippageRate?: string;
  spreadBps?: number;
  barPath?: string;
}

@Injectable({ providedIn: 'root' })
export class BacktestsService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/backtests`;

  /**
   * Las fuentes y sus intervalos, tal y como los declara el servidor.
   *
   * La pantalla construye su formulario DESDE AQUÍ y no lleva ninguna tabla
   * propia: es el mismo criterio que `capabilities()` en los datos de mercado.
   * Añadir una fuente, o que una deje de servir un intervalo, no toca la app.
   */
  readonly sources = signal<BacktestSourceInfo[] | null>(null);

  async loadSources(): Promise<void> {
    if (this.sources()) return;
    this.sources.set(
      await firstValueFrom(this.http.get<BacktestSourceInfo[]>(`${this.base}/sources`)),
    );
  }

  run(input: RunBacktestInput): Promise<BacktestResult> {
    return firstValueFrom(this.http.post<BacktestResult>(this.base, input));
  }

  list(botId?: string, limit = 25): Promise<BacktestSummary[]> {
    const params: Record<string, string | number> = { limit };
    if (botId) params['botId'] = botId;
    return firstValueFrom(this.http.get<BacktestSummary[]>(this.base, { params }));
  }

  detail(id: string): Promise<BacktestRun> {
    return firstValueFrom(this.http.get<BacktestRun>(`${this.base}/${id}`));
  }

  fills(id: string, limit = 2000): Promise<BacktestFillRow[]> {
    return firstValueFrom(
      this.http.get<BacktestFillRow[]>(`${this.base}/${id}/fills`, { params: { limit } }),
    );
  }

  remove(id: string): Promise<unknown> {
    return firstValueFrom(this.http.delete(`${this.base}/${id}`));
  }
}

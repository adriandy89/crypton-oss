import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  BacktestSource,
  BarPath,
  SourceMarketType,
  candleSpanMs,
  type BacktestParams,
  type BacktestResult,
  type Candle,
} from '@crypton/shared';
import {
  BinanceHistory,
  BybitHistory,
  paginateHistory,
  type HistoryProvider,
} from '@crypton/exchange-core';
import { aggregateCandles, buildMetrics, fidelityWarnings, runReplay } from '@crypton/backtest';
import { CacheService, DbService } from '../../libs';
import { MarketsService } from '../markets/markets.service';
import { BACKTESTABLE_INTERVALS, type CreateBacktestDto } from './dtos';

/**
 * Ejecuta un backtest, de principio a fin y de forma SÍNCRONA.
 *
 * Lo de síncrono no es una simplificación por prisa: está medido. Una rejilla de
 * cien niveles cuesta 638 µs por `plan()` y `reconcile()` solo 3,7 µs, así que
 * treinta días en velas de cinco minutos —8640 barras, planificando una vez por
 * barra— son unos siete segundos de CPU más un par de segundos de descarga. Eso
 * cabe de sobra bajo el interceptor de ochenta segundos de la API, y montar
 * cola, lease y canal de progreso habría sido infraestructura sin trabajo.
 *
 * Lo que sí hace falta es no comerse el proceso: hay un cerrojo global de uno a
 * la vez y el bucle cede el control cada 250 barras.
 */
@Injectable()
export class BacktestsService {
  private readonly logger = new Logger(BacktestsService.name);
  private readonly providers: Record<BacktestSource, HistoryProvider>;

  /**
   * Hay un replay corriendo EN ESTE proceso.
   *
   * Es la protección que de verdad importa —el bucle de eventos es de este
   * proceso— y la única que no depende de que Redis esté en pie.
   */
  private corriendo = false;

  constructor(
    private readonly db: DbService,
    private readonly cache: CacheService,
    private readonly markets: MarketsService,
    config: ConfigService,
  ) {
    const timeoutMs = 12_000;
    this.providers = {
      [BacktestSource.BINANCE]: new BinanceHistory({
        // Las MISMAS variables que ya lee el feed de precio en vivo del worker:
        // un solo sitio al que apuntar si hay que usar un espejo.
        spotUrl: config.get<string>('BINANCE_REST_URL') ?? 'https://api.binance.com',
        perpUrl: config.get<string>('BINANCE_FAPI_URL') ?? 'https://fapi.binance.com',
        timeoutMs,
      }),
      [BacktestSource.BYBIT]: new BybitHistory({
        spotUrl: config.get<string>('BYBIT_REST_URL') ?? 'https://api.bybit.com',
        perpUrl: config.get<string>('BYBIT_REST_URL') ?? 'https://api.bybit.com',
        timeoutMs,
      }),
    };
  }

  /** Qué fuentes hay y qué sirven. La app NO lleva tablas de esto. */
  sources() {
    return Object.values(this.providers).map((p) => ({
      id: p.id,
      intervals: p.intervals.filter((i) => BACKTESTABLE_INTERVALS.includes(i)),
      marketTypes: p.marketTypes,
      maxBarsPerRequest: p.maxBarsPerRequest,
    }));
  }

  async run(dto: CreateBacktestDto, userId: string): Promise<BacktestResult> {
    // Solo los bots del usuario: el de otro es un 404, no un 403 que confirmaría
    // que existe (spec 004).
    const bot = await this.db.bot.findFirst({
      where: { id: dto.botId, user_id: userId },
      select: {
        id: true,
        name: true,
        venue: true,
        symbol: true,
        strategy: true,
        dry_run: true,
        leverage: true,
        margin_mode: true,
        config_version: true,
        total_investment: true,
      },
    });
    if (!bot) throw new NotFoundException('Ese bot no existe.');
    // El backtest reproduce una configuración, no una cuenta. Sobre un bot real
    // el resultado invitaría a compararlo con su histórico de verdad, y no son
    // lo mismo: aquí no hay libro, ni funding, ni las otras posiciones.
    if (!bot.dry_run) {
      throw new BadRequestException('El backtest solo se lanza sobre bots de simulación.');
    }

    const provider = this.providers[dto.source];
    if (!provider.intervals.includes(dto.interval)) {
      throw new BadRequestException(
        `${dto.source} no sirve velas de ${dto.interval}. Disponibles: ` +
          provider.intervals.filter((i) => BACKTESTABLE_INTERVALS.includes(i)).join(', ') +
          '.',
      );
    }

    const marketType = dto.marketType ?? SourceMarketType.PERP;
    if (!provider.marketTypes.includes(marketType)) {
      throw new BadRequestException(`${dto.source} no sirve velas de ${marketType}.`);
    }

    const { fromMs, toMs, bars } = this.checkRange(dto);
    const market = await this.markets.getSpec(bot.venue, bot.symbol, false);
    const revision = await this.db.botConfigRevision.findFirst({
      where: { bot_id: bot.id, version: bot.config_version },
      select: { config: true, version: true },
    });
    if (!revision) throw new NotFoundException('Ese bot no tiene configuración vigente.');

    // Uno a la vez, y por una razón concreta: dos replays simultáneos en el mismo
    // proceso se reparten el bucle de eventos y la API deja de responder a todo
    // lo demás.
    //
    // El cerrojo de proceso va PRIMERO y es el que de verdad protege. El de
    // Redis solo extiende la exclusión a las otras réplicas, y por eso su fallo
    // no puede ser bloqueante: `CacheService.setnx` devuelve `false` tanto si la
    // clave existe como si Redis no está listo, así que fiarlo todo a él
    // convertía una caída de Redis en un «ya hay uno en curso» permanente y
    // falso — con nada corriendo.
    if (this.corriendo) {
      throw new ConflictException('Ya hay un backtest en curso. Espera a que termine.');
    }
    this.corriendo = true;

    let cerrojoRemoto = false;
    try {
      cerrojoRemoto = await this.cache.setnx('lock:backtest:run', Date.now(), 180);
      if (!cerrojoRemoto) {
        this.logger.warn(
          'Sin cerrojo compartido para el backtest: o hay otro en otra réplica, o Redis no ' +
            'responde. Se continúa con la exclusión de este proceso.',
        );
      }
    } catch {
      // Igual: Redis caído degrada, no bloquea.
    }

    const empezado = Date.now();
    try {
      const sourceSymbol = provider.symbolFor(market.base, marketType, dto.symbolOverride ?? null);
      const historia = await paginateHistory({
        provider,
        symbol: sourceSymbol,
        interval: dto.interval,
        marketType,
        fromMs,
        toMs,
        barCap: bars,
        gapMs: 150,
        readCache: async (k) => (await this.cache.get<Candle[]>(`bt:candles:${k}`)) ?? undefined,
        writeCache: async (k, page) => {
          // Un día: una ventana histórica cerrada no cambia nunca, y es lo que
          // hace instantáneo reejecutar el mismo periodo con otros ajustes —que
          // es el uso real de esta herramienta.
          await this.cache.set(`bt:candles:${k}`, page, 86_400);
        },
      });

      if (historia.candles.length === 0) {
        throw new BadRequestException(
          `${dto.source} no tiene histórico de «${sourceSymbol}» en ${dto.interval} para ese ` +
            'rango. Prueba con el símbolo de origen alternativo, con otro intervalo o con la otra fuente.',
        );
      }

      const params = this.paramsOf(dto, bot);
      const out = await runReplay({
        botId: bot.id,
        strategy: bot.strategy,
        config: revision.config as never,
        venue: bot.venue,
        market,
        interval: dto.interval,
        candles: historia.candles,
        params,
        // Ceder el bucle de eventos: sin esto, un replay de miles de barras
        // congela la API entera para todos los usuarios mientras dura.
        yieldEvery: 250,
        onProgress: () => new Promise<void>((r) => setImmediate(r)),
      });

      const span = candleSpanMs(dto.interval);
      const { metrics, equity } = buildMetrics(out, historia.candles, params.startingBalance, {
        barsMissing: historia.barsMissing,
        largestGapMs: historia.largestGapMs,
        spanMs: span,
      });

      const result: BacktestResult = {
        meta: {
          botId: bot.id,
          botName: bot.name,
          strategy: bot.strategy,
          venue: bot.venue,
          symbol: bot.symbol,
          configVersion: revision.version,
          source: dto.source,
          sourceSymbol,
          marketType,
          interval: dto.interval,
          fromMs,
          toMs,
          generatedAt: Date.now(),
          durationMs: Date.now() - empezado,
        },
        params,
        metrics,
        equity,
        candles: aggregateCandles(historia.candles, 1000),
        fills: out.fills,
        fillsTruncated: out.warnings.some((w) => w.includes('ejecuciones')),
        cycles: out.cycles,
        warnings: [
          ...fidelityWarnings({
            source: dto.source,
            sourceSymbol,
            interval: dto.interval,
            venue: bot.venue,
            // Con la estrategia y su configuración: los market makers llevan sus
            // propios avisos de paridad (001/F-65).
            strategy: bot.strategy,
            config: revision.config as Record<string, unknown>,
          }),
          ...out.warnings,
          ...(historia.barsMissing > 0
            ? [
                `Faltan ${historia.barsMissing} velas dentro del rango y NO se han rellenado: ` +
                  'inventar precios habría hecho que el bot operara contra velas que no existieron.',
              ]
            : []),
        ],
      };

      await this.persist(result, userId, revision.config, out.fillsTotal, out.ticks);
      this.logger.log(
        `Backtest de ${bot.symbol} (${dto.interval}, ${historia.candles.length} velas) en ${result.meta.durationMs} ms`,
      );
      return result;
    } finally {
      this.corriendo = false;
      if (cerrojoRemoto) await this.cache.getDel('lock:backtest:run').catch(() => undefined);
    }
  }

  /**
   * Comprueba el rango y devuelve cuántas barras saldrán.
   *
   * El tope es lo que mantiene la ejecución síncrona dentro de lo razonable, y
   * cuando se pasa se dice QUÉ intervalo sí cabría — un «demasiadas velas» a
   * secas obliga al usuario a adivinar.
   */
  private checkRange(dto: CreateBacktestDto): {
    fromMs: number;
    toMs: number;
    bars: number;
  } {
    const ahora = Date.now();
    const toMs = Math.min(dto.toMs, ahora);
    const fromMs = dto.fromMs;
    if (fromMs >= toMs)
      throw new BadRequestException('El rango tiene que empezar antes de acabar.');

    const span = candleSpanMs(dto.interval);
    const bars = Math.floor((toMs - fromMs) / span);
    if (bars < 10)
      throw new BadRequestException('El rango es demasiado corto: menos de diez velas.');
    if (bars > MAX_BARS) {
      const sugerido = BACKTESTABLE_INTERVALS.find(
        (i) => Math.floor((toMs - fromMs) / candleSpanMs(i)) <= MAX_BARS,
      );
      throw new BadRequestException(
        `Ese rango son ${bars} velas de ${dto.interval} y el máximo es ${MAX_BARS}.` +
          (sugerido ? ` Con velas de ${sugerido} sí cabe.` : ''),
      );
    }
    return { fromMs, toMs, bars };
  }

  private paramsOf(
    dto: CreateBacktestDto,
    bot: {
      leverage: number;
      margin_mode: string;
      total_investment: { toString(): string };
    },
  ): BacktestParams {
    return {
      startingBalance: dto.startingBalance ?? bot.total_investment.toString(),
      leverage: bot.leverage,
      marginMode: bot.margin_mode,
      // Por defecto, las de Hyperliquid: 0,02 % maker y 0,05 % taker.
      makerFeeRate: dto.makerFeeRate ?? '0.0002',
      takerFeeRate: dto.takerFeeRate ?? '0.0005',
      slippageRate: dto.slippageRate ?? '0.0005',
      maintenanceMarginRate: dto.maintenanceMarginRate ?? 0.005,
      spreadBps: dto.spreadBps ?? 2,
      barPath: dto.barPath ?? BarPath.NEAREST_FIRST,
    };
  }

  private async persist(
    r: BacktestResult,
    userId: string,
    config: unknown,
    fillsTotal: number,
    ticks: number,
  ): Promise<void> {
    const run = await this.db.backtestRun.create({
      data: {
        bot_id: r.meta.botId,
        requested_by: userId,
        venue: r.meta.venue,
        symbol: r.meta.symbol,
        strategy: r.meta.strategy,
        // La configuración ENTERA, que es la razón de guardar el run: el bot
        // puede cambiar mañana y sin esto el resultado dejaría de significar
        // nada. Aquí iba un `{}` y vaciaba justo eso.
        config: config as never,
        config_version: r.meta.configVersion,
        source: r.meta.source,
        source_symbol: r.meta.sourceSymbol,
        market_type: r.meta.marketType,
        interval: r.meta.interval,
        from_ms: BigInt(r.meta.fromMs),
        to_ms: BigInt(r.meta.toMs),
        params: r.params as never,
        bars: r.metrics.bars,
        ticks,
        fills_total: fillsTotal,
        duration_ms: r.meta.durationMs,
        metrics: r.metrics as never,
        equity_curve: r.equity as never,
        candles: r.candles as never,
        warnings: r.warnings as never,
      },
      select: { id: true },
    });

    if (r.fills.length === 0) return;
    await this.db.backtestFill.createMany({
      data: r.fills.map((f) => ({
        run_id: run.id,
        ts: BigInt(f.ts),
        side: f.side,
        // `LIQUIDATION` no es un nivel de estrategia: en la base va como nulo,
        // igual que en `bot_orders`, y la bandera propia es la que lo dice.
        level_kind: f.levelKind === 'LIQUIDATION' ? null : (f.levelKind as never),
        level_index: f.levelIndex,
        cycle_seq: f.cycleSeq,
        price: f.price,
        qty: f.qty,
        fee: f.fee,
        is_taker: f.isTaker,
        liquidation: f.liquidation,
        position_after: f.positionAfter,
        realized_acc_after: f.realizedAccAfter,
      })),
    });
  }

  /** Las ejecuciones del usuario, y solo las suyas (spec 004). */
  async list(userId: string, opts: { botId?: string; limit?: number }) {
    return this.db.backtestRun.findMany({
      where: { requested_by: userId, ...(opts.botId ? { bot_id: opts.botId } : {}) },
      orderBy: { created_at: 'desc' },
      take: Math.min(opts.limit ?? 25, 100),
      select: {
        id: true,
        bot_id: true,
        symbol: true,
        strategy: true,
        source: true,
        interval: true,
        from_ms: true,
        to_ms: true,
        bars: true,
        duration_ms: true,
        metrics: true,
        created_at: true,
      },
    });
  }

  async detail(userId: string, id: string) {
    const run = await this.db.backtestRun.findFirst({ where: { id, requested_by: userId } });
    if (!run) throw new NotFoundException('Ese backtest no existe.');
    return run;
  }

  async fills(userId: string, id: string, limit = 500) {
    // La propiedad se comprueba ANTES de leer la tabla de ejecuciones: `run_id`
    // no sabe de usuarios.
    const propio = await this.db.backtestRun.findFirst({
      where: { id, requested_by: userId },
      select: { id: true },
    });
    if (!propio) throw new NotFoundException('Ese backtest no existe.');
    return this.db.backtestFill.findMany({
      where: { run_id: id },
      orderBy: { ts: 'asc' },
      take: Math.min(limit, 2000),
    });
  }

  async remove(userId: string, id: string): Promise<void> {
    // `deleteMany` con el usuario en el filtro: la de otro no se borra y no
    // falla, igual que antes cuando no existía.
    await this.db.backtestRun.deleteMany({ where: { id, requested_by: userId } });
  }
}

/**
 * Techo de velas por ejecución.
 *
 * Diez mil cubren lo que de verdad se quiere mirar: treinta días en 5m (8640),
 * noventa días en 15m (8640), un año en 1h (8760) o treinta días en 15m (2880).
 * Por encima, la ejecución síncrona dejaría de caber bajo el interceptor.
 */
export const MAX_BARS = 10_000;

import { randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { D, type BotConfig } from '@crypton/shared';
import { getStrategy } from '@crypton/strategy-core';
import { LeaderboardPeriod, StrategyKind, Venue } from '@crypton/db';
import { CacheService, DbService } from 'src/libs';
import { expandFromShare, sanitizeForShare, type SharedConfig } from './share-codec';
import type { ListLeaderboardDto, ShareBotDto } from './dtos';

/** Cuánto tiempo debe llevar vivo un bot para entrar en el ranking. */
const MIN_UPTIME_SECONDS = 6 * 3600;

const PERIOD_HOURS: Record<LeaderboardPeriod, number | null> = {
  DAY: 24,
  WEEK: 24 * 7,
  MONTH: 24 * 30,
  ALL: null,
};

@Injectable()
export class LeaderboardService {
  private readonly logger = new Logger(LeaderboardService.name);

  constructor(
    private readonly db: DbService,
    private readonly cache: CacheService,
  ) {}

  // ═══════════════════════════════════════════════════════════════
  // Consulta
  // ═══════════════════════════════════════════════════════════════

  /**
   * Ranking ya materializado.
   *
   * Se lee de `leaderboard_entries` y no se calcula al vuelo: cada bot acumula
   * un snapshot por minuto, y agregar eso en cada carga de pantalla haría la
   * lista inusable en cuanto hubiera unos cientos de bots.
   */
  async list(query: ListLeaderboardDto) {
    const period = query.period ?? LeaderboardPeriod.WEEK;

    const entries = await this.db.leaderboardEntry.findMany({
      where: {
        period,
        ...(query.venue ? { venue: query.venue } : {}),
        ...(query.strategy ? { strategy: query.strategy } : {}),
        ...(query.symbol ? { symbol: query.symbol } : {}),
      },
      orderBy: { rank: 'asc' },
      take: query.limit ?? 50,
    });

    // El nombre y el código de copia viven en otras tablas; se traen en una sola
    // consulta en lugar de una por fila.
    //
    // `share` con `select` explícito y no entero: la fila de BotShare lleva el
    // `user_id` del autor y su `config_blob`. Aquí solo se leen tres campos,
    // pero traerla completa dejaba la identidad del autor a un `...share`
    // descuidado de distancia.
    const bots = await this.db.bot.findMany({
      where: { id: { in: entries.map((e) => e.bot_id) } },
      select: {
        id: true,
        name: true,
        leverage: true,
        direction: true,
        share: {
          select: { public: true, share_code: true, copies_count: true },
        },
      },
    });
    const byId = new Map(bots.map((b) => [b.id, b]));

    return entries.map((e) => {
      const bot = byId.get(e.bot_id);
      return {
        rank: e.rank,
        botId: e.bot_id,
        // El nombre lo pone el autor: se muestra, pero nunca su correo ni su id.
        name: bot?.name ?? 'Bot',
        venue: e.venue,
        symbol: e.symbol,
        strategy: e.strategy,
        direction: bot?.direction ?? null,
        leverage: bot?.leverage ?? null,
        roiPct: e.roi_pct.toString(),
        // NI `aum` NI `total_pnl`.
        //
        // Son el margen asignado real y el resultado absoluto del autor: dicen
        // cuánto dinero mueve. Publicarlos contradecía lo que promete el propio
        // controlador («ni cuánto dinero mueve») y lo que el códec de copia se
        // toma la molestia de ocultar convirtiendo importes en proporciones.
        // Además daban, junto al identificador real del bot, un perfil completo
        // de a quién merecía la pena atacar.
        //
        // El ROI se conserva porque es relativo y es lo que de verdad compara
        // dos bots; el resto de columnas se calculan sin revelar tamaño.
        uptimeSeconds: e.uptime_seconds,
        // Solo se puede copiar lo que su autor haya publicado explícitamente.
        shareCode: bot?.share?.public ? bot.share.share_code : null,
        copies: bot?.share?.copies_count ?? 0,
        computedAt: e.computed_at,
      };
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // Compartir y copiar
  // ═══════════════════════════════════════════════════════════════

  /**
   * Publica la configuración de un bot.
   *
   * Lo que se guarda es la FORMA de la estrategia con los importes convertidos a
   * proporción del capital: ni la cuenta del autor ni cuánto dinero mueve. Ver
   * `share-codec.ts`.
   */
  async share(userId: string, botId: string, dto: ShareBotDto) {
    const bot = await this.db.bot.findFirst({
      where: { id: botId, user_id: userId },
      include: { share: true, exchange_account: { select: { testnet: true } } },
    });
    if (!bot) throw new NotFoundException('Bot no encontrado.');

    if (bot.dry_run) {
      // Publicar un bot simulado engañaría al que lo copie: su histórico no
      // proviene de operaciones reales.
      throw new BadRequestException(
        'No se pueden publicar bots en simulación: su histórico no viene de operaciones reales.',
      );
    }

    if (bot.exchange_account.testnet) {
      // Mismo motivo, y aquí es MÁS fácil de pasar por alto: un bot de testnet
      // sí manda órdenes de verdad y sí tiene fills, así que su histórico parece
      // el de un bot real. Pero la liquidez de una red de pruebas no es la de
      // mainnet: lo que allí se llena entero, aquí mueve el precio.
      throw new BadRequestException(
        'No se pueden publicar bots de testnet: su histórico no viene de un mercado real.',
      );
    }

    const revision = await this.db.botConfigRevision.findUniqueOrThrow({
      where: { bot_id_version: { bot_id: botId, version: bot.config_version } },
    });

    const strategy = getStrategy(bot.strategy);
    const blob = sanitizeForShare(
      revision.config as unknown as BotConfig,
      strategy.meta.fields,
      bot.strategy,
    );

    const code = bot.share?.share_code ?? this.newShareCode();
    const share = await this.db.botShare.upsert({
      where: { bot_id: botId },
      create: {
        bot_id: botId,
        user_id: userId,
        share_code: code,
        config_blob: blob as never,
        public: dto.public ?? true,
      },
      update: {
        // Se regenera el blob al republicar: si no, se compartiría una
        // configuración que el bot ya no usa.
        config_blob: blob as never,
        public: dto.public ?? true,
      },
    });

    return {
      shareCode: share.share_code,
      public: share.public,
      copies: share.copies_count,
    };
  }

  async unshare(userId: string, botId: string): Promise<void> {
    const share = await this.db.botShare.findFirst({
      where: { bot_id: botId, user_id: userId },
    });
    if (!share) throw new NotFoundException('Ese bot no está publicado.');
    await this.db.botShare.update({
      where: { bot_id: botId },
      data: { public: false },
    });
  }

  /**
   * Devuelve una configuración lista para precargar el asistente de creación,
   * dimensionada al capital y al mercado de quien copia.
   */
  async resolveShare(
    userId: string,
    code: string,
    input: {
      exchangeAccountId: string;
      symbol: string;
      totalInvestment: string;
    },
  ) {
    const share = await this.db.botShare.findUnique({
      where: { share_code: code },
      include: {
        bot: {
          select: { name: true, strategy: true, venue: true, symbol: true },
        },
      },
    });
    if (!share || !share.public)
      throw new NotFoundException('Ese código no existe o ya no es público.');

    const blob = share.config_blob as unknown as SharedConfig;
    if (blob.v !== 1) {
      throw new ConflictException('Ese bot se publicó con un formato que ya no se soporta.');
    }

    const invested = D(input.totalInvestment);
    if (!invested.isFinite() || invested.lte(0)) {
      throw new BadRequestException('Indica cuánto capital quieres asignar al bot.');
    }

    const config = expandFromShare(
      blob,
      { ...input, sourceSymbol: share.bot.symbol },
      getStrategy(blob.strategy as StrategyKind).meta.fields,
    );

    // Se cuenta la copia aquí y no al crear el bot: interesa saber cuánta gente
    // ha partido de esa configuración, la lleve a producción o no.
    await this.db.botShare.update({
      where: { bot_id: share.bot_id },
      data: { copies_count: { increment: 1 } },
    });

    return {
      strategy: blob.strategy as StrategyKind,
      sourceName: share.bot.name,
      sourceVenue: share.bot.venue,
      sourceSymbol: share.bot.symbol,
      // Sin `originalInvestment`: era el capital del autor, que es justo lo que
      // el saneado se toma la molestia de convertir en proporciones.
      config,
    };
  }

  private newShareCode(): string {
    return randomBytes(8)
      .toString('base64url')
      .replace(/[^0-9a-zA-Z]/g, '')
      .slice(0, 10);
  }

  // ═══════════════════════════════════════════════════════════════
  // Materialización
  // ═══════════════════════════════════════════════════════════════

  /**
   * Recalcula el ranking.
   *
   * Cada 15 minutos: lo bastante fresco para que se note el movimiento del día y
   * lo bastante espaciado para que el coste sea irrelevante frente al trabajo
   * del motor, que es lo que no puede ir lento.
   */
  @Cron(CronExpression.EVERY_30_MINUTES)
  async recompute(): Promise<void> {
    // Una sola réplica recalcula. `@Cron` dispara en todas, y varias
    // recalculando a la vez escriben las MISMAS filas de `leaderboard_entries`
    // pisándose entre ellas.
    if (!(await this.cache.setnx('lock:leaderboard-recompute', Date.now(), 900))) return;

    for (const period of Object.values(LeaderboardPeriod)) {
      try {
        await this.recomputePeriod(period);
      } catch (e) {
        this.logger.error(`Ranking ${period} fallido: ${(e as Error).message}`);
      }
    }
  }

  async recomputePeriod(period: LeaderboardPeriod): Promise<number> {
    const hours = PERIOD_HOURS[period];
    const since = hours ? new Date(Date.now() - hours * 3600_000) : new Date(0);

    // Solo bots REALES DE MAINNET, publicados y con recorrido suficiente. Un bot
    // de una hora con un golpe de suerte no debe encabezar nada, y uno de
    // testnet tampoco: su histórico sale de un libro sin liquidez real.
    //
    // El filtro está aquí ADEMÁS de en `share`, y no de más: `share` guarda la
    // puerta de entrada, pero una cuenta puede haber sido de testnet desde antes
    // de que existiera esa comprobación, y el ranking se recalcula por cron sin
    // volver a pasar por ella.
    const candidates = await this.db.bot.findMany({
      where: {
        dry_run: false,
        exchange_account: { testnet: false },
        share: { public: true },
        started_at: { not: null },
        status: { in: ['RUNNING', 'PAUSED', 'STOPPED'] },
      },
      select: {
        id: true,
        venue: true,
        symbol: true,
        strategy: true,
        started_at: true,
        total_investment: true,
      },
    });

    const rows: {
      botId: string;
      venue: Venue;
      symbol: string;
      strategy: StrategyKind;
      roi: string;
      aum: string;
      pnl: string;
      uptime: number;
    }[] = [];

    for (const bot of candidates) {
      const uptime = Math.floor((Date.now() - bot.started_at!.getTime()) / 1000);
      if (uptime < MIN_UPTIME_SECONDS) continue;

      const [cycles, snapshot] = await Promise.all([
        this.db.botCycle.aggregate({
          where: { bot_id: bot.id, closed_at: { gte: since } },
          _sum: { realized_pnl: true },
        }),
        this.db.botSnapshot.findFirst({
          where: { bot_id: bot.id },
          orderBy: { taken_at: 'desc' },
          select: { unrealized_pnl: true },
        }),
      ]);

      const invested = D(bot.total_investment.toString());
      if (invested.lte(0)) continue;

      const realized = D(cycles._sum.realized_pnl?.toString() ?? 0);
      // El no realizado cuenta: un bot con un resultado excelente y una posición
      // muy perdida abierta no es un buen bot, y ocultarlo sería engañoso.
      const unrealized = D(snapshot?.unrealized_pnl?.toString() ?? 0);
      const total = realized.plus(unrealized);

      rows.push({
        botId: bot.id,
        venue: bot.venue,
        symbol: bot.symbol,
        strategy: bot.strategy,
        roi: total.div(invested).mul(100).toFixed(6),
        aum: invested.toFixed(),
        pnl: total.toFixed(),
        uptime,
      });
    }

    rows.sort((a, b) => Number(b.roi) - Number(a.roi));

    await this.db.$transaction([
      this.db.leaderboardEntry.deleteMany({ where: { period } }),
      this.db.leaderboardEntry.createMany({
        data: rows.map((r, i) => ({
          bot_id: r.botId,
          period,
          venue: r.venue,
          symbol: r.symbol,
          strategy: r.strategy,
          roi_pct: r.roi,
          aum: r.aum,
          total_pnl: r.pnl,
          uptime_seconds: r.uptime,
          rank: i + 1,
        })),
      }),
    ]);

    this.logger.log(`Ranking ${period}: ${rows.length} bot(s)`);
    return rows.length;
  }
}

import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { D, type BotConfig, type MarketSpec } from '@crypton/shared';
import { estimateLiquidationPrice, liquidationDistancePct } from '@crypton/strategy-core';
import { DbService } from 'src/libs';
import { UpdateRiskLimitsDto } from './dtos';

/**
 * Guardas de riesgo del usuario.
 *
 * Se comprueban en DOS momentos y por motivos distintos: aquí, antes de crear
 * o arrancar un bot —para que una configuración fuera de límites no llegue
 * nunca a tocar el venue— y en cada tick del motor, porque el mercado se mueve
 * y un bot que era seguro al arrancar puede dejar de serlo.
 */
@Injectable()
export class RiskService {
  private readonly logger = new Logger(RiskService.name);

  constructor(private readonly db: DbService) {}

  async get(userId: string) {
    const limits = await this.db.riskLimit.findUnique({ where: { user_id: userId } });
    // Un usuario sin fila no debe quedarse sin guardas: se crean por defecto.
    return limits ?? this.db.riskLimit.create({ data: { user_id: userId } });
  }

  async update(userId: string, dto: UpdateRiskLimitsDto) {
    const data = {
      max_notional_per_bot: dto.maxNotionalPerBot ?? null,
      max_total_notional: dto.maxTotalNotional ?? null,
      max_leverage: dto.maxLeverage ?? null,
      max_open_bots: dto.maxOpenBots ?? null,
      max_daily_loss: dto.maxDailyLoss ?? null,
      kill_switch_drawdown_pct: dto.killSwitchDrawdownPct ?? null,
      liquidation_alert_pct: dto.liquidationAlertPct ?? null,
    };
    return this.db.riskLimit.upsert({
      where: { user_id: userId },
      create: { user_id: userId, ...data },
      update: data,
    });
  }

  /**
   * Valida una configuración contra los límites del usuario.
   *
   * Además de los topes explícitos, comprueba algo que el usuario no suele
   * mirar: a qué distancia queda la liquidación con el apalancamiento elegido.
   * Un bot que liquida con un 4 % de movimiento adverso es una pérdida casi
   * segura, y merece un rechazo, no un aviso perdido en un tooltip.
   */
  async assertWithinLimits(userId: string, config: BotConfig, market: MarketSpec): Promise<void> {
    const limits = await this.get(userId);
    const leverage = Number(config.leverage ?? 1);
    const investment = D(config.totalInvestment ?? 0);
    const notional = investment.mul(leverage);

    if (limits.max_leverage != null && leverage > limits.max_leverage) {
      throw new ForbiddenException(
        `Tu límite de apalancamiento es ${limits.max_leverage}× y has pedido ${leverage}×.`,
      );
    }

    if (
      limits.max_notional_per_bot != null &&
      notional.gt(limits.max_notional_per_bot.toString())
    ) {
      throw new ForbiddenException(
        `El notional del bot (${notional.toFixed(2)}) supera tu límite por bot (${limits.max_notional_per_bot.toString()}).`,
      );
    }

    if (limits.max_total_notional != null) {
      const current = await this.currentTotalNotional(userId);
      const projected = current.plus(notional);
      if (projected.gt(limits.max_total_notional.toString())) {
        throw new ForbiddenException(
          `Sumando este bot llegarías a ${projected.toFixed(2)} de notional, por encima de tu límite total (${limits.max_total_notional.toString()}).`,
        );
      }
    }

    // La liquidación se estima sobre el precio de referencia del mercado; el
    // número exacto lo da el venue, pero el orden de magnitud basta para
    // detectar una configuración temeraria antes de que exista posición.
    const liq = estimateLiquidationPrice(1, leverage, config.direction ?? 'LONG');
    if (liq) {
      const distance = liquidationDistancePct(1, liq);
      if (distance.lt(5)) {
        throw new ForbiddenException(
          `A ${leverage}× la liquidación llega con un movimiento adverso de solo ${distance.toFixed(1)} %. Baja el apalancamiento.`,
        );
      }
    }

    if (!market.active) {
      throw new BadRequestException(`El mercado ${market.symbol} no está operativo.`);
    }
  }

  /** Comprueba que el usuario puede poner un bot más en marcha. */
  async assertCanStart(userId: string, botId: string): Promise<void> {
    const limits = await this.get(userId);

    if (limits.max_open_bots != null) {
      const running = await this.db.bot.count({
        where: {
          user_id: userId,
          id: { not: botId },
          status: { in: ['STARTING', 'RUNNING', 'PAUSED'] },
        },
      });
      if (running >= limits.max_open_bots) {
        throw new ForbiddenException(
          `Ya tienes ${running} bots activos y tu límite es ${limits.max_open_bots}.`,
        );
      }
    }

    if (limits.max_daily_loss != null) {
      const loss = await this.todayRealizedPnl(userId);
      if (loss.lt(limits.max_daily_loss.neg().toString())) {
        throw new ForbiddenException(
          `Hoy acumulas ${loss.toFixed(2)} de pérdida y tu límite diario es ${limits.max_daily_loss.toString()}. No se arrancan bots nuevos hasta mañana.`,
        );
      }
    }

    const account = await this.db.bot.findUnique({
      where: { id: botId },
      select: { exchange_account: { select: { status: true, venue: true } } },
    });
    if (account && !['VERIFIED', 'ACTIVE'].includes(account.exchange_account.status)) {
      throw new ForbiddenException(
        `La conexión con ${account.exchange_account.venue} no está verificada. Vuelve a verificarla antes de arrancar.`,
      );
    }
  }

  /** Notional agregado de todos los bots vivos del usuario. */
  /**
   * Publica, y no privada, para que el asistente pueda enseñar el mismo numero
   * que va a producir el 403.
   *
   * Escribir un segundo agregado en `BotsService` habria garantizado que un dia
   * discrepara, y el sintoma seria el peor posible: la pantalla diciendo «te
   * caben 5.000 mas» y el servidor respondiendo que no.
   */
  async currentTotalNotional(userId: string) {
    const bots = await this.db.bot.findMany({
      where: { user_id: userId, status: { in: ['STARTING', 'RUNNING', 'PAUSED'] } },
      select: { total_investment: true, leverage: true },
    });
    return bots.reduce(
      (acc, b) => acc.plus(D(b.total_investment.toString()).mul(b.leverage)),
      D(0),
    );
  }

  /** PnL realizado del día, sumando los ciclos cerrados desde medianoche. */
  private async todayRealizedPnl(userId: string) {
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);

    const cycles = await this.db.botCycle.findMany({
      where: { bot: { user_id: userId }, closed_at: { gte: midnight } },
      select: { realized_pnl: true },
    });
    return cycles.reduce((acc, c) => acc.plus(c.realized_pnl.toString()), D(0));
  }

  /**
   * Kill-switch global: para TODOS los bots del usuario de una vez.
   *
   * Solo marca los estados y deja al worker cancelar y cerrar, porque es él
   * quien tiene el lease y las conexiones. Si la API cancelara por su cuenta,
   * dos procesos estarían operando el mismo bot a la vez.
   */
  async killSwitch(userId: string): Promise<{ affected: number }> {
    const result = await this.db.bot.updateMany({
      where: { user_id: userId, status: { in: ['STARTING', 'RUNNING', 'PAUSED'] } },
      data: { status: 'STOPPING' },
    });
    this.logger.warn(
      `Kill-switch del usuario ${userId}: ${result.count} bot(s) marcados para parar`,
    );
    return { affected: result.count };
  }
}

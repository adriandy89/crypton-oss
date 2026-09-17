import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import {
  D,
  MAX_APALANCAMIENTO_POR_STOP,
  MIN_LIQUIDATION_DISTANCE_PCT,
  maintenanceMarginRateOf,
  maxLeverageWithinDistance,
  startOfDay,
  type BotConfig,
  type MarketSpec,
  type Numeric,
} from '@crypton/shared';
import { DbService } from 'src/libs';
import { UpdateRiskLimitsDto } from './dtos';

/** Lo que la estrategia dice de sí misma y cambia cómo se miden sus límites. */
export interface OpcionesDeRiesgo {
  /** Al editar un bot vivo, no se cuenta a sí mismo en el agregado. */
  excludeBotId?: string;
  /**
   * `POR_STOP` (spec 058): la liquidación la gobierna el stop de cada operación,
   * así que el tope no es el del 5 % sino `MAX_APALANCAMIENTO_POR_STOP`.
   */
  reglaLiquidacion?: 'POR_STOP';
  /**
   * El nocional máximo que declara la estrategia. Sin él se estima como
   * capital por apalancamiento, que en una estrategia con el apalancamiento por
   * operación exageraría el tamaño hasta 25 veces el capital.
   */
  nocional?: string | null;
}

/** El apalancamiento más alto que admite la regla de liquidación en ese mercado. */
function topeDeLaRegla(market: MarketSpec, regla: OpcionesDeRiesgo['reglaLiquidacion']): number {
  return regla === 'POR_STOP'
    ? Math.min(MAX_APALANCAMIENTO_POR_STOP, market.maxLeverage)
    : maxLeverageWithinDistance(maintenanceMarginRateOf(market));
}

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
  async assertWithinLimits(
    userId: string,
    config: BotConfig,
    market: MarketSpec,
    opts: OpcionesDeRiesgo = {},
  ): Promise<void> {
    const limits = await this.get(userId);
    const leverage = Number(config.leverage ?? 1);
    const investment = D(config.totalInvestment ?? 0);
    const notional = opts.nocional ? D(opts.nocional) : investment.mul(leverage);

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
      const current = await this.currentTotalNotional(userId, opts.excludeBotId);
      const projected = current.plus(notional);
      if (projected.gt(limits.max_total_notional.toString())) {
        throw new ForbiddenException(
          `Sumando este bot llegarías a ${projected.toFixed(2)} de notional, por encima de tu límite total (${limits.max_total_notional.toString()}).`,
        );
      }
    }

    // La liquidación se estima antes de que exista posición; el número exacto
    // lo da el venue, pero el orden de magnitud basta para detectar una
    // configuración temeraria. Misma cuenta que `validateCommon` y el asistente,
    // con la tasa de mantenimiento del MERCADO: la tasa plana del 0,5 %
    // prohibía 19× en todos los pares y ningún formulario lo decía (001/F-44,
    // F-93). Con la regla por stop, la distancia la pone cada operación y lo que
    // queda es el techo (spec 058).
    const tope = topeDeLaRegla(market, opts.reglaLiquidacion);
    if (leverage > tope) {
      throw new ForbiddenException(
        opts.reglaLiquidacion === 'POR_STOP'
          ? `El apalancamiento de esta estrategia llega como mucho a ${tope}× en ${market.symbol}, y has pedido ${leverage}×.`
          : `A ${leverage}× la liquidación estimada llega con menos del ${MIN_LIQUIDATION_DISTANCE_PCT} % de movimiento adverso en ${market.symbol}: el máximo aquí es ${tope}×.`,
      );
    }

    if (!market.active) {
      throw new BadRequestException(`El mercado ${market.symbol} no está operativo.`);
    }
  }

  /**
   * El apalancamiento más alto que este usuario puede llevar en este bot sin que
   * `assertWithinLimits` lo rechace.
   *
   * Es la misma cuenta de ahí arriba leída al revés, y existe para que quien
   * PROPONE un cambio pueda respetar el límite en vez de descubrirlo con un 403.
   * El supervisor de IA lo necesita por partida doble: para no proponer lo que va
   * a fallar, y para que su lista de «qué movimiento tiene efecto» no le prometa
   * al modelo un apalancamiento que no cabe (spec 052, F-09).
   *
   * No sustituye a `assertWithinLimits`: la comprobación de verdad sigue estando
   * en el camino de escritura, donde no se puede saltar.
   */
  async topeDeApalancamiento(
    userId: string,
    investment: Numeric,
    market: MarketSpec,
    opts: Pick<OpcionesDeRiesgo, 'excludeBotId' | 'reglaLiquidacion'> = {},
  ): Promise<number> {
    const limits = await this.get(userId);
    const inversion = D(investment);
    const topes: number[] = [topeDeLaRegla(market, opts.reglaLiquidacion)];
    if (limits.max_leverage != null) topes.push(limits.max_leverage);

    // Sin inversión no hay notional que limitar: dividir por cero daría infinito
    // y, peor, un tope inventado.
    if (inversion.gt(0)) {
      if (limits.max_notional_per_bot != null) {
        topes.push(D(limits.max_notional_per_bot.toString()).div(inversion).floor().toNumber());
      }
      if (limits.max_total_notional != null) {
        const otros = await this.currentTotalNotional(userId, opts.excludeBotId);
        topes.push(
          D(limits.max_total_notional.toString()).minus(otros).div(inversion).floor().toNumber(),
        );
      }
    }
    // Nunca menos de 1×: un tope de cero no significa «bot sin apalancamiento»,
    // significa que ya no cabe, y eso lo dice el 403 con su motivo.
    return Math.max(1, Math.min(...topes));
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
  async currentTotalNotional(userId: string, excludeBotId?: string) {
    // Al editar un bot vivo se excluye a sí mismo: contaba una vez como
    // «actual» y otra como «nuevo», y cualquier cambio —incluso apretar el
    // stop— recibía un 403 cerca del tope total (001/F-42).
    const bots = await this.db.bot.findMany({
      where: {
        user_id: userId,
        status: { in: ['STARTING', 'RUNNING', 'PAUSED'] },
        ...(excludeBotId ? { id: { not: excludeBotId } } : {}),
      },
      select: { total_investment: true, leverage: true, max_notional: true },
    });
    // El nocional que declara la estrategia, si lo declara (spec 058): con el
    // apalancamiento por operación, capital por apalancamiento contaría el tope
    // de 25x como si cada bot lo usara entero. El worker suma lo mismo.
    return bots.reduce(
      (acc, b) =>
        acc.plus(
          b.max_notional != null
            ? D(b.max_notional.toString())
            : D(b.total_investment.toString()).mul(b.leverage),
        ),
      D(0),
    );
  }

  /** PnL realizado del día, sumando los ciclos cerrados desde medianoche. */
  private async todayRealizedPnl(userId: string) {
    // La medianoche del USUARIO, con el mismo cálculo que el worker: dos cortes
    // distintos daban dos «días» distintos para la misma guarda (001/F-43).
    const user = await this.db.user.findUnique({
      where: { id: userId },
      select: { timezone: true },
    });
    const midnight = startOfDay(user?.timezone);

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

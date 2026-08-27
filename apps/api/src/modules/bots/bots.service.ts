import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  D,
  liquidationOfPosition,
  venueKey,
  walletCacheKeys,
  type BotConfig,
  type CapitalSnapshot,
  type MarginAdjustment,
  type MarketMakerStats,
  type Position,
  type PreviewResult,
} from '@crypton/shared';
import type { DryRunState } from '@crypton/exchange-core';

/**
 * Una posicion tal y como la guarda el simulador. Es el mismo tipo que vuelca
 * `DryRunAdapter.exportState`, referenciado desde alli para que ampliarlo alli
 * rompa aqui el build en vez de dejar la cartera leyendo un campo que ya no
 * existe.
 */
type PaperPosition = DryRunState['positions'][number];
import { diffConfig, getStrategy } from '@crypton/strategy-core';
import {
  BotStatus,
  Direction,
  MarginMode,
  StrategyKind,
  Venue,
} from '@crypton/db';
import {
  BUS_CHANNELS,
  BusService,
  CacheService,
  DbService,
  VenueBudgetProvider,
} from 'src/libs';
import { ExchangeAccountsService } from '../exchange-accounts';
import { MarketsService } from '../markets';
import { RiskService } from '../risk';
import {
  BotCommandDto,
  CapitalQueryDto,
  CreateBotDto,
  ListBotsQueryDto,
  PreviewBotDto,
  UpdateBotConfigDto,
} from './dtos';

/** Estados en los que el bot está bajo control del worker. */
const LIVE_STATUSES: BotStatus[] = [
  BotStatus.STARTING,
  BotStatus.RUNNING,
  BotStatus.PAUSED,
  BotStatus.STOPPING,
];

/** Comandos que cierran posición a mercado: irreversibles, exigen confirmar. */
const DESTRUCTIVE_COMMANDS = new Set(['STOP_AND_CLOSE', 'CLOSE_NOW', 'PANIC']);

/** La parte de `CapitalSnapshot` que viene del venue. */
type WalletRead = Omit<CapitalSnapshot, 'committed' | 'limits'>;

/**
 * Vida del saldo cacheado.
 *
 * Quince segundos, no dos y no sesenta. Por debajo no se gana frescura real
 * —el propio venue va por detrás— y se multiplica el descifrado de la clave;
 * por encima, quien acaba de depositar no lo ve y deja de fiarse de la cifra.
 * Con quince, el ritmo hacia el venue queda topado en cuatro por minuto y por
 * cuenta, haga lo que haga la interfaz.
 */
const WALLET_TTL_SECONDS = 15;

/** El último valor bueno, para poder enseñar algo fechado cuando el venue cae. */
const WALLET_LAST_TTL_SECONDS = 600;

/** Plazo propio, muy por debajo del interceptor global de 80 s. */
const WALLET_TIMEOUT_MS = 4_000;

const UNAVAILABLE_MESSAGE = {
  VENUE: 'No se ha podido leer tu saldo en el exchange.',
  CREDENTIAL: 'Tu conexión con el exchange ya no verifica.',
} as const;

/**
 * ¿El fallo es de credencial o del venue?
 *
 * La distinción llega hasta la interfaz: con `CREDENTIAL` la app puede ofrecer
 * «Revisar mis conexiones», que es la rama que el paso 1 ya tiene escrita;
 * con `VENUE` no hay nada que el usuario pueda arreglar y solo cabe avisar.
 */
function isAuthError(e: unknown): boolean {
  return (e as { kind?: string } | null)?.kind === 'AUTH';
}

/**
 * Como `Promise.race` contra un reloj, pero soltando el temporizador.
 *
 * Sin el `clearTimeout` cada llamada deja vivo un `setTimeout` de cuatro
 * segundos: no rompe nada, pero mantiene el proceso despierto y ensucia
 * cualquier medición de fugas.
 */
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const clock = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`El exchange no respondió en ${ms} ms.`)),
      ms,
    );
  });
  return Promise.race([work, clock]).finally(() => clearTimeout(timer));
}

@Injectable()
export class BotsService {
  private readonly logger = new Logger(BotsService.name);

  /**
   * Lecturas de saldo en vuelo, por clave de cache.
   *
   * En memoria y no en Redis a proposito: lo que resuelve es la carrera DENTRO
   * de este proceso, que es donde se abren los adaptadores. Mismo patron que
   * `tickersInflight` en `MarketDataService`.
   */
  private readonly walletInflight = new Map<string, Promise<WalletRead>>();

  constructor(
    private readonly db: DbService,
    private readonly markets: MarketsService,
    private readonly accounts: ExchangeAccountsService,
    private readonly risk: RiskService,
    private readonly bus: BusService,
    private readonly cache: CacheService,
    private readonly budget: VenueBudgetProvider,
  ) {}

  // ═══════════════════════════════════════════════════════════════
  // Preview: lo que se ve ANTES de crear el bot
  // ═══════════════════════════════════════════════════════════════

  /**
   * Devuelve la escalera completa, nivel a nivel, con el peor caso y la
   * liquidación estimada. Es el mismo cálculo que ejecutará el motor —viene de
   * `strategy-core`— así que lo que se ve aquí es literalmente lo que se
   * mandará al venue, no una aproximación para la interfaz.
   */
  async preview(userId: string, dto: PreviewBotDto): Promise<PreviewResult> {
    const testnet = dto.testnet === true;
    const market = await this.markets.getSpec(dto.venue, dto.symbol, testnet);
    const strategy = getStrategy(dto.strategy);

    // Se valida ANTES de pedir el precio de referencia, y no despues.
    //
    // Dos motivos. El barato: `referencePrice()` puede acabar abriendo un
    // adaptador autenticado —descifrando una clave de firma— y no tiene
    // sentido pagar eso por una config que no puede funcionar.
    //
    // El caro: sin esto, una config incompleta llegaba entera hasta
    // `strategy.preview()` y salia como un 500 con `[DecimalError] Invalid
    // argument: undefined`. `create()` ya validaba; este camino —el del
    // asistente, el unico que usa un humano— era justo el que no lo hacia.
    const validation = strategy.validate(
      dto.config as unknown as BotConfig,
      market,
    );
    if (!validation.ok) {
      throw new BadRequestException({
        message: 'La configuración no es válida.',
        issues: validation.issues,
      });
    }

    const refPrice =
      dto.refPrice ??
      (await this.referencePrice(userId, dto.venue, dto.symbol, testnet));
    if (!refPrice || D(refPrice).lte(0)) {
      throw new BadRequestException(
        'No hay precio de referencia para ese mercado. Vuelve a intentarlo en unos segundos.',
      );
    }

    return strategy.preview(
      dto.config as unknown as BotConfig,
      market,
      refPrice,
    );
  }

  // ═══════════════════════════════════════════════════════════════
  // Capital: cuanto cabe de verdad en este bot
  // ═══════════════════════════════════════════════════════════════

  /**
   * Cuanto dinero hay, cuanto esta libre, cuanto tienen pedido los demas bots
   * de esta conexion y con que topes choca.
   *
   * Vive en `BotsService` y no en `ExchangeAccountsService` porque no es «el
   * saldo de una conexion»: mezcla el venue, Postgres y `RiskService`, y este
   * modulo ya importa los tres. Al reves habria que invertir la dependencia
   * —el modulo de credenciales importando riesgo y planes— para servir una
   * pantalla que es del asistente de bots.
   *
   * NUNCA lanza por culpa del venue. Ver `readWallet`.
   */
  async capital(
    userId: string,
    dto: CapitalQueryDto,
  ): Promise<CapitalSnapshot> {
    const account = await this.db.exchangeAccount.findFirst({
      where: { id: dto.exchangeAccountId, user_id: userId },
      select: { id: true },
    });
    if (!account) throw new NotFoundException('Conexión no encontrada.');

    // Las tres en paralelo: la del venue es la lenta y las de Postgres son
    // milisegundos, asi que encadenarlas solo sumaria latencia.
    const [wallet, committed, limits, currentTotalNotional] = await Promise.all(
      [
        this.readWallet(userId, dto.exchangeAccountId, dto.symbol, dto.botId),
        this.committedByBots(dto.exchangeAccountId),
        this.risk.get(userId),
        this.risk.currentTotalNotional(userId),
      ],
    );

    return {
      ...wallet,
      committed,
      limits: {
        maxLeverage: limits.max_leverage,
        maxNotionalPerBot: limits.max_notional_per_bot?.toString() ?? null,
        maxTotalNotional: limits.max_total_notional?.toString() ?? null,
        currentTotalNotional: currentTotalNotional.toFixed(),
      },
    };
  }

  /**
   * Lo que ya tienen pedido los OTROS bots vivos de esta misma conexion.
   *
   * Solo los reales: un bot en simulacion no toca el saldo del venue, asi que
   * contarlo aqui haria creer al usuario que tiene menos margen del que tiene.
   *
   * Es un agregado nuevo. El unico que existia —`currentTotalNotional`— es por
   * USUARIO y en notional; este es por CONEXION y en margen, que es la unidad
   * en la que se teclea «Capital asignado».
   */
  private async committedByBots(exchangeAccountId: string) {
    const bots = await this.db.bot.findMany({
      where: {
        exchange_account_id: exchangeAccountId,
        status: {
          in: [BotStatus.STARTING, BotStatus.RUNNING, BotStatus.PAUSED],
        },
        dry_run: false,
      },
      select: { total_investment: true, leverage: true },
    });

    let margin = D(0);
    let notional = D(0);
    for (const b of bots) {
      const m = D(b.total_investment.toString());
      margin = margin.plus(m);
      notional = notional.plus(m.mul(b.leverage));
    }
    return {
      margin: margin.toFixed(),
      notional: notional.toFixed(),
      bots: bots.length,
    };
  }

  /**
   * Saldo y posicion, del venue, con cache y sin poder tumbar nada.
   *
   * La cache de 15 s no es una optimizacion: `openAdapter` es —lo dice su
   * propio docblock— «el UNICO punto por el que el secreto vuelve a memoria», y
   * descifra una clave capaz de mover dinero. Esto acota cuantas veces por
   * minuto esa clave existe en el heap: como mucho cuatro por cuenta, pase lo
   * que pase con la interfaz.
   *
   * Y hay un segundo cache, el de `:last`, de diez minutos. Cuando el venue no
   * responde se sirve el ultimo valor bueno, marcado como rancio y con su hora
   * original: un saldo de hace tres minutos, en gris y fechado, deja decidir;
   * un guion no.
   */
  private async readWallet(
    userId: string,
    accountId: string,
    symbol?: string,
    botId?: string,
  ): Promise<WalletRead> {
    const account = await this.db.exchangeAccount.findFirst({
      where: { id: accountId, user_id: userId },
      select: { id: true, venue: true, paper: true, paper_balance: true },
    });
    if (!account) throw new NotFoundException('Conexión no encontrada.');

    // La SIMULACIÓN no se cachea, y no es un descuido.
    //
    // Esta caché existe para acotar cada cuánto se descifra una clave de firma
    // y cada cuánto se sale al venue; el saldo simulado no hace ni una cosa ni
    // la otra —está en una fila de Postgres— así que memorizarlo solo compraba
    // que reiniciar la simulación tardara quince segundos en verse, y obligaba
    // a barrer Redis con `KEYS` para invalidarla.
    if (account.paper) return this.fetchPaperWallet(account, symbol, botId);

    const { key, lastKey } = walletCacheKeys(userId, accountId, symbol);

    const cached = await this.cache.get<WalletRead>(key).catch(() => null);
    if (cached) return cached;

    // Un solo vuelo por clave. Sin esto, entrar al paso «Parámetros» con dos
    // pestañas abiertas falla el `get` en las dos antes de que ninguna escriba,
    // y se abren dos adaptadores —o sea, dos descifrados— a la vez.
    const inflight = this.walletInflight.get(key);
    if (inflight) return inflight;

    const run = this.fetchWallet(userId, accountId, symbol)
      .then(async (fresh) => {
        await this.cache
          .set(key, fresh, WALLET_TTL_SECONDS)
          .catch(() => undefined);
        await this.cache
          .set(lastKey, fresh, WALLET_LAST_TTL_SECONDS)
          .catch(() => undefined);
        return fresh;
      })
      .catch(async (e: unknown) => {
        // El mensaje crudo del venue NO se registra: puede llevar el indice o la
        // direccion de la cuenta.
        const reason: 'CREDENTIAL' | 'VENUE' = isAuthError(e)
          ? 'CREDENTIAL'
          : 'VENUE';
        this.logger.warn(
          `No se pudo leer el saldo de la conexión ${accountId} (${reason}).`,
        );

        const last = await this.cache
          .get<WalletRead>(lastKey)
          .catch(() => null);
        const unavailable = { reason, message: UNAVAILABLE_MESSAGE[reason] };
        if (last) return { ...last, stale: true, unavailable };

        return {
          asset: 'USDC',
          total: null,
          available: null,
          used: null,
          at: null,
          stale: false,
          unavailable,
          position: null,
        };
      })
      .finally(() => {
        this.walletInflight.delete(key);
      });

    this.walletInflight.set(key, run);
    return run;
  }

  /**
   * Cartera de una conexión de SIMULACIÓN, leída de la base.
   *
   * No abre adaptador ninguno, y esa es la gracia: el saldo simulado ya está
   * guardado —es lo que hace que la simulación sobreviva a un reinicio del
   * motor—, así que pedírselo al venue sería salir a la red para leer algo que
   * está a una consulta de distancia. Sin descifrado, sin cupo de venue y sin
   * plazo que se pueda agotar.
   *
   * El precio de marca sale del mismo sitio del que lo saca el gráfico: la
   * instantánea de tickers que el cron ya refresca cada treinta segundos.
   */
  private async fetchPaperWallet(
    account: {
      id: string;
      venue: Venue;
      paper_balance: { toFixed(): string } | null;
    },
    symbol?: string,
    botId?: string,
  ): Promise<WalletRead> {
    // Sin bot no hay sandbox que leer, y no es un caso raro: es el asistente,
    // que pregunta «¿con cuánto cuento?» ANTES de crear nada. La respuesta
    // correcta ahí es el capital de partida, porque es exactamente lo que va a
    // tener el bot nuevo.
    //
    // El bot se busca ATADO a la conexión, no por su id a secas. La conexión ya
    // viene comprobada contra el dueño, así que exigir que el bot cuelgue de ella
    // es lo que impide que un `botId` ajeno en la query devuelva el saldo, el
    // resultado y la posición del sandbox de otro usuario. Fallar aquí devuelve
    // el capital de partida, que es lo mismo que responder «ese bot no existe».
    const state = botId
      ? await this.db.paperState.findFirst({
          where: { bot_id: botId, bot: { exchange_account_id: account.id } },
        })
      : null;

    const inicial = account.paper_balance?.toFixed() ?? '10000';
    if (!state) {
      return {
        asset: 'USDC',
        total: inicial,
        available: inicial,
        used: '0',
        at: Date.now(),
        stale: false,
        unavailable: null,
        position: null,
      };
    }

    const posiciones = state.positions as unknown as PaperPosition[];
    const equity = D(state.balance).plus(state.realized_pnl);

    // El margen se recompone aquí en vez de guardarlo porque es un derivado, y
    // un derivado guardado es un derivado que algún día discrepa. Lo que sí
    // importa es a QUÉ precio se recompone, y el simulador usa dos distintos a
    // propósito:
    //
    //  · el comprometido de la CUENTA, sobre el precio de marca — es lo que
    //    `DryRunAdapter.getBalances` descuenta del disponible, y es contra ese
    //    disponible contra el que el motor decide si puede aportar margen;
    //  · el de la POSICIÓN, sobre el precio de entrada — es lo que devuelve
    //    `getPositions`, y de ahí sale la liquidación estimada.
    //
    // Calcular los dos igual haría que la API y el motor discreparan en cuanto
    // el precio se moviera: un aporte que el motor sí puede financiar saldría
    // rechazado desde aquí, o al revés.
    let used = D(0);
    let position: Position | null = null;

    for (const p of posiciones) {
      const qty = D(p.qty);
      if (qty.isZero()) continue;

      const entrada = D(p.entryPrice);
      const mark = D(
        (await this.markPrice(account.venue, p.symbol)) ?? p.entryPrice,
      );
      const lev = p.leverage || 1;

      used = used.plus(qty.abs().mul(mark).div(lev)).plus(p.extraMargin);

      if (!symbol || p.symbol !== symbol) continue;

      const notional = qty.abs().mul(entrada);
      const margen = notional.div(lev).plus(p.extraMargin);
      // El apalancamiento EFECTIVO: con margen aportado a mano la posición
      // sostiene el mismo notional con más caja, y eso es literalmente estar
      // menos apalancada.
      const efectivo = margen.gt(0) ? notional.div(margen).toNumber() : lev;

      position = {
        venue: account.venue,
        symbol: p.symbol,
        qty: qty.toFixed(),
        entryPrice: entrada.toFixed(),
        markPrice: mark.toFixed(),
        unrealizedPnl: mark.minus(entrada).mul(qty).toFixed(),
        leverage: efectivo,
        marginMode: p.marginMode,
        // El MISMO cálculo que hace el simulador, y por eso sale de `shared` en
        // vez de rehacerse aquí: en cruzado la caja no es el margen inicial sino
        // la cuenta entera, y una segunda implementación de esa regla es una que
        // algún día dice otro precio que la del motor.
        liquidationPrice:
          liquidationOfPosition(
            { ...p, qty: p.qty },
            posiciones,
            equity,
          )?.toFixed() ?? null,
        marginUsed: margen.toFixed(),
      };
    }

    return {
      asset: 'USDC',
      total: equity.toFixed(),
      available: equity.minus(used).toFixed(),
      used: used.toFixed(),
      at: Date.now(),
      stale: false,
      unavailable: null,
      position,
    };
  }

  /** Precio de marca de la instantánea de tickers. `null` si aún no hay. */
  private async markPrice(
    venue: Venue,
    symbol: string,
  ): Promise<string | null> {
    // Siempre mainnet: una conexión de simulación no vive en otro sitio.
    const tickers = await this.cache
      .get<{ symbol: string; mark?: string; last?: string }[]>(
        `md:tickers:${venueKey(venue, false)}`,
      )
      .catch(() => null);
    const t = tickers?.find((x) => x.symbol === symbol);
    return t?.mark ?? t?.last ?? null;
  }

  private async fetchWallet(
    userId: string,
    accountId: string,
    symbol?: string,
  ): Promise<WalletRead> {
    // Con presupuesto: la API y el worker comparten IP de salida y los DEX
    // cuentan sus limites por IP. Mismo criterio que `MarketDataService`.
    const adapter = await this.accounts.openAdapter(userId, accountId, false, {
      budget: this.budget.budget,
    });
    try {
      // Plazo propio y CORTO, muy por debajo del interceptor global de 80 s:
      // esto pinta una cabecera, y una cabecera que tarda diez segundos ya no
      // sirve para lo que existe.
      const settled = await withTimeout(
        Promise.allSettled([
          adapter.getBalances(),
          // `allSettled` y no `all`: que no haya posicion —o que el venue falle
          // al darla— no puede impedir ver el saldo, que es el dato principal.
          symbol ? adapter.getPositions(symbol) : Promise.resolve([]),
        ]),
        WALLET_TIMEOUT_MS,
      );

      const [balances, positions] = settled;
      if (balances.status === 'rejected') throw balances.reason;

      // Aster filtra los saldos a cero, asi que una cartera vacia devuelve `[]`
      // y no una fila de ceros: eso es un saldo de 0, no un fallo.
      const balance =
        balances.value.find((b) => b.asset === 'USDC') ?? balances.value[0];

      return {
        asset: balance?.asset ?? 'USDC',
        total: balance?.total ?? '0',
        available: balance?.available ?? '0',
        used: balance?.used ?? '0',
        at: Date.now(),
        stale: false,
        unavailable: null,
        position:
          positions.status === 'fulfilled'
            ? (positions.value[0] ?? null)
            : null,
      };
    } finally {
      await adapter.close().catch(() => undefined);
    }
  }
  /** Metadatos de todas las estrategias: con esto la app genera el formulario. */
  strategiesMeta() {
    return Object.values(StrategyKind).map((kind) => {
      const strategy = getStrategy(kind);
      return {
        kind,
        labelKey: strategy.meta.labelKey,
        descriptionKey: strategy.meta.descriptionKey,
        fields: strategy.meta.fields,
        defaults: strategy.defaults(),
      };
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // CRUD
  // ═══════════════════════════════════════════════════════════════

  async list(userId: string, query: ListBotsQueryDto) {
    const bots = await this.db.bot.findMany({
      where: {
        user_id: userId,
        ...(query.status ? { status: query.status } : {}),
        ...(query.venue ? { venue: query.venue } : {}),
        ...(query.strategy ? { strategy: query.strategy } : {}),
        // La red se filtra por la CUENTA y no por una columna de `bots`: es
        // donde vive, y duplicarla aquí daría dos verdades que pueden discrepar.
        // Mismo patrón que usa el ranking para excluir testnet.
        //
        // Los SIMULADOS quedan fuera del filtro: son de mainnet por
        // construcción, y con la lente en testnet desaparecerían de la lista
        // justo cuando el usuario está probando. Su sitio no lo decide la red
        // sino que son simulados, y de separarlos se encarga la app.
        ...(query.testnet !== undefined
          ? {
              exchange_account: {
                OR: [{ testnet: query.testnet }, { paper: true }],
              },
            }
          : {}),
      },
      orderBy: [{ status: 'asc' }, { created_at: 'desc' }],
      include: {
        snapshots: { orderBy: { taken_at: 'desc' }, take: 1 },
        cycles: { orderBy: { seq: 'desc' }, take: 1 },
        exchange_account: { select: { testnet: true, paper: true } },
      },
    });

    return bots.map((bot) => ({
      id: bot.id,
      name: bot.name,
      venue: bot.venue,
      testnet: bot.exchange_account.testnet,
      // La app lo necesita para no sumar el resultado de una simulación al del
      // dinero de verdad en la cartera. `dryRun` no basta: un bot simulado
      // puede correr sobre una conexión REAL, y ese sí gasta cuota de plan y
      // convive con los demás bots de esa cuenta.
      paper: bot.exchange_account.paper,
      symbol: bot.symbol,
      strategy: bot.strategy,
      status: bot.status,
      direction: bot.direction,
      leverage: bot.leverage,
      ...this.metricsOf(bot, bot.snapshots[0] ?? null),
      note: bot.note,
      lastError: bot.last_error,
      startedAt: bot.started_at,
      updatedAt: bot.updated_at,
    }));
  }

  async detail(userId: string, id: string) {
    const bot = await this.mustOwn(userId, id);
    const [revision, cycle, snapshot, openOrders, share] = await Promise.all([
      this.db.botConfigRevision.findUnique({
        where: { bot_id_version: { bot_id: id, version: bot.config_version } },
      }),
      this.db.botCycle.findFirst({
        where: { bot_id: id },
        orderBy: { seq: 'desc' },
      }),
      this.db.botSnapshot.findFirst({
        where: { bot_id: id },
        orderBy: { taken_at: 'desc' },
      }),
      this.db.botOrder.findMany({
        where: {
          bot_id: id,
          status: { in: ['PENDING', 'OPEN', 'PARTIALLY_FILLED'] },
        },
        orderBy: { price: 'desc' },
      }),
      // Estado de publicación en el ranking. Va aquí y no en un endpoint
      // aparte porque solo lo necesita esta pantalla, y pedirlo por separado
      // dejaría un instante en el que el interruptor miente.
      this.db.botShare.findUnique({
        where: { bot_id: id },
        select: { share_code: true, public: true, copies_count: true },
      }),
    ]);

    const strategy = getStrategy(bot.strategy);
    return {
      ...bot,
      // Las MISMAS métricas calculadas que devuelve el listado. Si el detalle
      // solo trajera la fila cruda, la app tendría que recalcular ROI y PnL por
      // su cuenta y las dos pantallas acabarían mostrando cifras distintas.
      ...this.metricsOf(bot, snapshot),
      // Y la misma red que el listado, por el mismo motivo: la pantalla tiene
      // que poder decir en qué libro opera este bot sin deducirlo de nada.
      ...(await this.networkOf(bot.exchange_account_id)),
      config: revision?.config ?? {},
      // Se envían los descriptores junto al bot para que la pantalla de ajustes
      // sepa qué puede cambiarse en caliente sin una segunda petición.
      fields: strategy.meta.fields,
      cycle,
      snapshot,
      // `openOrdersList` y no `openOrders`: en el listado ese nombre es un
      // número, y que la misma clave significara dos cosas distintas según el
      // endpoint es una fuente de errores garantizada en el cliente.
      openOrdersList: openOrders,
      share: share
        ? {
            shareCode: share.share_code,
            public: share.public,
            copies: share.copies_count,
          }
        : null,
    };
  }

  /** Métricas derivadas del último snapshot. Compartidas por listado y detalle. */
  private metricsOf(
    bot: {
      total_investment: { toString(): string };
      started_at: Date | null;
      dry_run: boolean;
    },
    snapshot: {
      realized_pnl_acc: { toString(): string };
      unrealized_pnl: { toString(): string };
      position_qty: { toString(): string };
      average_entry: { toString(): string } | null;
      liquidation_price: { toString(): string } | null;
      open_orders: number;
    } | null,
  ) {
    const invested = D(bot.total_investment.toString());
    const realized = D(snapshot?.realized_pnl_acc?.toString() ?? 0);
    const unrealized = D(snapshot?.unrealized_pnl?.toString() ?? 0);

    return {
      dryRun: bot.dry_run,
      realizedPnl: realized.toFixed(),
      unrealizedPnl: unrealized.toFixed(),
      roiPct: invested.gt(0)
        ? realized.plus(unrealized).div(invested).mul(100).toFixed(2)
        : '0.00',
      positionQty: snapshot?.position_qty?.toString() ?? '0',
      averageEntry: snapshot?.average_entry?.toString() ?? null,
      liquidationPrice: snapshot?.liquidation_price?.toString() ?? null,
      openOrders: snapshot?.open_orders ?? 0,
      uptimeSeconds: bot.started_at
        ? Math.floor((Date.now() - bot.started_at.getTime()) / 1000)
        : 0,
    };
  }

  async create(userId: string, dto: CreateBotDto) {
    const account = await this.db.exchangeAccount.findFirst({
      where: { id: dto.exchangeAccountId, user_id: userId },
    });
    if (!account)
      throw new NotFoundException('Conexión de exchange no encontrada.');
    if (account.status === 'REVOKED') {
      throw new BadRequestException('Esa conexión está revocada.');
    }

    // Una conexión de simulación no tiene credencial y no puede firmar nada, así
    // que su bot solo puede ser simulado. Se rechaza en vez de corregir en
    // silencio: quien manda `dryRun: false` está pidiendo operar con dinero real
    // y merece que se le diga que ahí no hay dinero, no un bot que hace otra
    // cosa de la que pidió.
    if (account.paper && dto.dryRun === false) {
      throw new BadRequestException(
        'Esa conexión es de simulación y no tiene claves: sus bots solo pueden simular. ' +
          'Conecta un exchange para operar con dinero real.',
      );
    }
    const dryRun = account.paper || dto.dryRun === true;

    // La red sale de la cuenta y de ningun otro sitio: es lo que impide que un
    // cliente pida un bot de mainnet sobre una credencial de testnet, o al reves.
    const market = await this.markets.getSpec(
      account.venue,
      dto.symbol,
      account.testnet,
    );
    const strategy = getStrategy(dto.strategy);
    const config = {
      ...dto.config,
      exchangeAccountId: account.id,
      symbol: dto.symbol,
    } as BotConfig;

    // Doble puerta antes de dejar que un bot toque dinero: qué exige la propia
    // estrategia y qué límites de riesgo se ha puesto el usuario. En ese orden:
    // la validación de la estrategia es lo más barato de comprobar y lo que da
    // el mensaje más accionable.
    const validation = strategy.validate(config, market);
    if (!validation.ok) {
      throw new BadRequestException({
        message: 'La configuración no es válida.',
        issues: validation.issues,
      });
    }
    await this.risk.assertWithinLimits(userId, config, market);

    // El preview también valida: si algún nivel es imposible en este venue, el
    // bot no llega a crearse. Vale más un error ahora que veinte rechazos luego.
    const refPrice = await this.referencePrice(
      userId,
      account.venue,
      dto.symbol,
      account.testnet,
    );
    const preview = strategy.preview(config, market, refPrice);
    if (!preview.valid) {
      throw new BadRequestException({
        message: 'La escalera resultante no es válida en este mercado.',
        issues: preview.issues,
      });
    }

    const bot = await this.db.$transaction(async (tx) => {
      const created = await tx.bot.create({
        data: {
          user_id: userId,
          exchange_account_id: account.id,
          name: dto.name,
          venue: account.venue,
          symbol: dto.symbol,
          strategy: dto.strategy,
          status: BotStatus.DRAFT,
          direction: config.direction ?? 'LONG',
          leverage: Number(config.leverage ?? 1),
          margin_mode: config.marginMode ?? 'ISOLATED',
          total_investment: String(config.totalInvestment ?? 0),
          dry_run: dryRun,
          config_version: 1,
        },
      });
      await tx.botConfigRevision.create({
        data: {
          bot_id: created.id,
          version: 1,
          config: config as never,
          apply_level: 'COLD',
          applied_by: userId,
        },
      });
      await tx.botEvent.create({
        data: {
          bot_id: created.id,
          type: 'BOT_CREATED',
          severity: 'INFO',
          message: `Bot creado (${dto.strategy} sobre ${dto.symbol} en ${account.venue}).`,
          payload: { dryRun, paper: account.paper } as never,
        },
      });
      return created;
    });

    if (dto.startActive)
      await this.command(userId, bot.id, { command: 'START' });
    return this.detail(userId, bot.id);
  }

  async rename(userId: string, id: string, name: string) {
    await this.mustOwn(userId, id);
    return this.db.bot.update({ where: { id }, data: { name } });
  }

  async remove(userId: string, id: string): Promise<void> {
    const bot = await this.mustOwn(userId, id);
    if (LIVE_STATUSES.includes(bot.status)) {
      throw new ConflictException('Para el bot antes de eliminarlo.');
    }
    await this.db.bot.delete({ where: { id } });
  }

  // ═══════════════════════════════════════════════════════════════
  // Configuración en caliente
  // ═══════════════════════════════════════════════════════════════

  /**
   * Aplica un cambio de configuración clasificándolo por mutabilidad.
   *
   *   HOT  → el motor lo recoge en el siguiente tick; ni una orden se mueve más
   *          de lo que exija el propio diff.
   *   WARM → cancela y vuelve a tender la escalera. La posición NO se cierra,
   *          pero el usuario tiene que confirmarlo antes.
   *   COLD → se rechaza: sería otro bot distinto.
   */
  async updateConfig(userId: string, id: string, dto: UpdateBotConfigDto) {
    const bot = await this.mustOwn(userId, id);
    const market = await this.markets.getSpec(
      bot.venue,
      bot.symbol,
      (await this.networkOf(bot.exchange_account_id)).testnet,
    );
    const strategy = getStrategy(bot.strategy);

    const currentRevision = await this.db.botConfigRevision.findUniqueOrThrow({
      where: { bot_id_version: { bot_id: id, version: bot.config_version } },
    });
    const previous = currentRevision.config as unknown as BotConfig;

    // Los campos COLD se reinyectan desde la revisión vigente: así un cliente
    // que reenvía el formulario entero no dispara un rechazo por enviar el
    // mismo símbolo o la misma cuenta que ya tenía.
    const next = {
      ...dto.config,
      exchangeAccountId: previous.exchangeAccountId,
      symbol: previous.symbol,
    } as BotConfig;

    const diff = diffConfig(strategy, previous, next);
    if (diff.level === 'NONE') {
      return {
        applied: false,
        level: 'NONE',
        changed: [],
        message: 'No hay cambios.',
      };
    }
    if (diff.level === 'COLD') {
      throw new BadRequestException({
        message:
          'Esos campos no se pueden cambiar con el bot creado. Para el bot y crea uno nuevo.',
        coldFields: diff.coldFields,
      });
    }
    if (diff.level === 'WARM' && dto.acceptRelayout !== true) {
      throw new ConflictException({
        message:
          'Este cambio obliga a cancelar y volver a tender la escalera. La posición no se cierra. Confirma para continuar.',
        level: 'WARM',
        changed: diff.changed,
        requiresConfirmation: true,
      });
    }

    const validation = strategy.validate(next, market);
    if (!validation.ok) {
      throw new BadRequestException({
        message: 'La configuración nueva no es válida.',
        issues: validation.issues,
      });
    }
    await this.risk.assertWithinLimits(userId, next, market);

    const version = bot.config_version + 1;
    await this.db.$transaction(async (tx) => {
      await tx.botConfigRevision.create({
        data: {
          bot_id: id,
          version,
          config: next as never,
          diff: diff.changed as never,
          apply_level: diff.level,
          applied_by: userId,
        },
      });
      await tx.bot.update({
        where: { id },
        data: {
          config_version: version,
          leverage: Number(next.leverage ?? bot.leverage),
          total_investment: String(
            next.totalInvestment ?? bot.total_investment,
          ),
        },
      });
      await tx.botEvent.create({
        data: {
          bot_id: id,
          type: 'CONFIG_UPDATED',
          severity: 'INFO',
          message: `Configuración v${version} aplicada (${diff.level}): ${diff.changed
            .map((c) => c.key)
            .join(', ')}.`,
          payload: { level: diff.level, changed: diff.changed } as never,
        },
      });
    });

    // Se avisa al worker aunque el bot esté parado: si arranca luego, cargará
    // la revisión desde BD igualmente, y publicar de más no cuesta nada.
    await this.bus.publish(BUS_CHANNELS.BOT_CONFIG, {
      userId,
      botId: id,
      type: 'CONFIG_UPDATED',
      data: { version, level: diff.level },
    });

    this.logger.log(`Bot ${id}: configuración v${version} (${diff.level})`);
    return { applied: true, level: diff.level, version, changed: diff.changed };
  }

  // ═══════════════════════════════════════════════════════════════
  // Comandos de runtime
  // ═══════════════════════════════════════════════════════════════

  async command(userId: string, id: string, dto: BotCommandDto) {
    const bot = await this.mustOwn(userId, id);

    // Un comando de runtime solo tiene sentido sobre un bot bajo control del
    // worker. Sin esta puerta, un RESUME sobre un bot ya parado se encolaba,
    // nadie lo ejecutaba jamás —los bots parados no se adoptan— y el usuario
    // se quedaba con un «accepted» que no significaba nada.
    if (dto.command !== 'START' && !LIVE_STATUSES.includes(bot.status)) {
      throw new ConflictException(
        `El bot está en ${bot.status} y no atiende comandos. Arráncalo primero.`,
      );
    }

    if (DESTRUCTIVE_COMMANDS.has(dto.command) && dto.confirm !== true) {
      throw new ConflictException({
        message:
          'Este comando cierra la posición a mercado y realiza el resultado al instante. Confirma para continuar.',
        requiresConfirmation: true,
      });
    }

    const margin =
      dto.command === 'ADJUST_MARGIN'
        ? await this.checkMarginAdjustment(userId, bot, dto)
        : null;

    if (dto.command === 'START') {
      if (LIVE_STATUSES.includes(bot.status)) {
        throw new ConflictException('El bot ya está en marcha.');
      }
      await this.risk.assertCanStart(userId, bot.id);
      await this.assertPairFree(bot);
      try {
        await this.db.bot.update({
          where: { id },
          data: {
            status: BotStatus.STARTING,
            started_at: new Date(),
            last_error: null,
          },
        });
      } catch (e) {
        // La base tiene un índice único parcial sobre (cuenta, símbolo) para los
        // estados vivos. Si dos peticiones de arranque corren a la vez, la
        // comprobación de arriba puede pasar en las dos y solo aquí se decide.
        if ((e as { code?: string }).code === 'P2002') {
          throw new ConflictException(
            `Ya hay otro bot en marcha sobre ${bot.symbol} en esa conexión. ` +
              'En un DEX la posición es única por cuenta y símbolo.',
          );
        }
        throw e;
      }
    }

    // El resto de comandos los ejecuta el worker, que es quien tiene el lease
    // del bot y las conexiones abiertas. La API solo los encola: si intentase
    // cancelar órdenes por su cuenta, dos procesos estarían tocando el mismo
    // bot a la vez y volveríamos al problema que resuelve el lease.
    //
    // La fila de `bot_commands` es la ENTREGA; el mensaje del bus, de aquí
    // abajo, solo acelera la latencia. Antes solo estaba el mensaje, y pub/sub
    // entrega a quien escucha en ese instante: si el worker dueño estaba
    // reiniciando o reconectando a Redis, el comando se perdía en silencio y
    // esta función devolvía `accepted` igualmente. Un PANIC que no llega no es
    // un fallo de latencia, es dinero abierto en el venue.
    if (dto.command !== 'START') {
      await this.db.$transaction([
        this.db.botCommand.create({
          data: {
            bot_id: id,
            command: dto.command,
            requested_by: userId,
            // `countAsBotCapital` NO viaja al worker: es un efecto de
            // contabilidad que resuelve la API, y el motor solo debe saber
            // cuánto colateral mover y en qué sentido. Mandárselo invitaría a
            // que algún día el worker tocase `totalInvestment` por su cuenta,
            // que es de quien tiene el lease de la configuración, no del tick.
            payload: margin
              ? { amount: margin.amount, action: margin.action }
              : undefined,
          },
        }),
        this.db.botEvent.create({
          data: {
            bot_id: id,
            type: 'COMMAND_' + dto.command,
            severity: DESTRUCTIVE_COMMANDS.has(dto.command) ? 'WARN' : 'INFO',
            message: margin
              ? `Comando ADJUST_MARGIN solicitado: ${margin.action === 'ADD' ? 'aportar' : 'retirar'} ${margin.amount}.`
              : `Comando ${dto.command} solicitado.`,
          },
        }),
      ]);
    } else {
      // START no necesita bandeja: su señal duradera es el estado STARTING que
      // se acaba de escribir, y el barrido de adopción lo recoge solo.
      await this.db.botEvent.create({
        data: {
          bot_id: id,
          type: 'COMMAND_START',
          severity: 'INFO',
          message: 'Comando START solicitado.',
        },
      });
    }

    await this.bus
      .publish(BUS_CHANNELS.BOT_COMMANDS, {
        userId,
        botId: id,
        type: dto.command,
        data: {},
      })
      // Que el aviso no salga ya no importa: el worker encuentra el comando en
      // su bandeja al siguiente tick.
      .catch(() => undefined);

    // El capital asignado se sube DESPUÉS de encolar la transferencia y solo si
    // el usuario lo pidió. El orden importa: la transferencia es lo que defiende
    // la posición y no puede quedar detrás de un cambio de configuración que
    // cancela y vuelve a tender la escalera.
    //
    // Y si esto falla, la transferencia ya está encolada y sigue su curso: es
    // deliberado. Lo contrario —renunciar a defender la posición porque el ROI
    // se iba a calcular sobre el denominador viejo— sería cambiar dinero por
    // contabilidad.
    if (margin?.countAsBotCapital) {
      await this.raiseAssignedCapital(userId, id, margin.amount);
    }

    return { accepted: true, command: dto.command };
  }

  /**
   * Comprueba un ajuste de margen ANTES de encolarlo.
   *
   * Todo lo que se puede saber sin hablar con el venue se decide aquí, para que
   * el usuario reciba un motivo legible en el momento en vez de un
   * `COMMAND_FAILED` en la bitácora medio minuto después. El worker vuelve a
   * comprobar lo esencial: entre esta llamada y su ejecución la configuración
   * pudo cambiar, y quien manda al venue es él.
   */
  private async checkMarginAdjustment(
    userId: string,
    bot: {
      id: string;
      symbol: string;
      margin_mode: MarginMode;
      exchange_account_id: string;
    },
    dto: BotCommandDto,
  ): Promise<MarginAdjustment> {
    if (!dto.marginAmount || !dto.marginAction) {
      throw new BadRequestException(
        'Indica el importe y si quieres aportar o retirar margen.',
      );
    }

    // En cruzado esto no existe: el colateral es de toda la cuenta y no hay una
    // caja por posición que engordar. Se dice así, y no se deja que lo rechace
    // el venue con su propio vocabulario.
    if (bot.margin_mode !== MarginMode.ISOLATED) {
      throw new ConflictException(
        'Este bot opera en margen CRUZADO: su colateral es el de toda la cuenta y no hay margen por posición que ajustar. ' +
          'El modo de margen se fija al crear el bot y no puede cambiarse en caliente.',
      );
    }

    // Retirar acerca la liquidación. Es la operación inversa a la que la gente
    // viene buscando, así que se confirma igual que un cierre a mercado.
    if (dto.marginAction === 'REMOVE' && dto.confirm !== true) {
      throw new ConflictException({
        message:
          'Retirar margen ACERCA el precio de liquidación de esta posición. Confirma para continuar.',
        requiresConfirmation: true,
      });
    }

    const amount = D(dto.marginAmount);

    // Solo para APORTAR: es lo único que se puede contrastar de antemano. Si la
    // retirada deja la posición por debajo del margen de mantenimiento lo sabe
    // el venue y nadie más, así que esa se manda y se propaga su rechazo.
    if (dto.marginAction === 'ADD') {
      // Con el bot: si la conexión es de simulación, el margen libre que cuenta
      // es el de SU sandbox, no un saldo de cuenta que ya no existe.
      const wallet = await this.readWallet(
        userId,
        bot.exchange_account_id,
        bot.symbol,
        bot.id,
      );
      // `unavailable` y no `available == null`: la señal de «no se pudo leer»
      // es aquella. Un `available` ausente en la respuesta del venue es un
      // saldo de CERO legítimo —Aster filtra los saldos a cero y devuelve `[]`—
      // y ahí sí hay que rechazar.
      //
      // Cuando el venue no contesta NO se bloquea, ni siquiera con un saldo
      // viejo en caché: negar la defensa de una posición por una lectura que
      // falló, o por una de hace un minuto, es peor que dejar que el venue
      // rechace la transferencia con la cifra de verdad delante.
      if (
        wallet.unavailable == null &&
        wallet.available != null &&
        amount.gt(D(wallet.available))
      ) {
        throw new ConflictException(
          `No tienes tanto margen libre: hay ${D(wallet.available).toFixed(2)} ${wallet.asset} disponibles.`,
        );
      }
    }

    return {
      amount: amount.toFixed(),
      action: dto.marginAction,
      // Retirar no puede subir el capital asignado: sería contabilizar como
      // aportación un dinero que acaba de salir de la posición.
      countAsBotCapital:
        dto.marginAction === 'ADD' && dto.countAsBotCapital === true,
    };
  }

  /**
   * Suma el aporte al capital asignado del bot.
   *
   * Va por `updateConfig` y no por un `UPDATE` directo a propósito: ahí viven la
   * validación de la estrategia, el versionado de la revisión y la clasificación
   * de mutabilidad que avisa al motor. `totalInvestment` es WARM, así que esto
   * retiende la escalera — y por eso es un interruptor y no el comportamiento
   * por defecto.
   */
  private async raiseAssignedCapital(
    userId: string,
    botId: string,
    amount: string,
  ) {
    const bot = await this.db.bot.findUniqueOrThrow({
      where: { id: botId },
      select: { config_version: true },
    });
    const revision = await this.db.botConfigRevision.findUniqueOrThrow({
      where: { bot_id_version: { bot_id: botId, version: bot.config_version } },
    });
    const previous = revision.config as unknown as BotConfig;

    await this.updateConfig(userId, botId, {
      config: {
        ...previous,
        totalInvestment: D(previous.totalInvestment).plus(amount).toFixed(),
      },
      acceptRelayout: true,
    });
  }

  /**
   * Un solo bot vivo por par y cuenta de exchange.
   *
   * En un DEX la posición es única por cuenta y símbolo, así que dos bots sobre
   * el mismo par ven la posición del otro como propia: promedian sobre una
   * cantidad que no han abierto ellos, se cierran el take profit el uno al otro
   * y la contabilidad del ciclo de ambos queda corrupta. No es un caso raro —es
   * lo que pasa siempre que ocurre— y no hay forma honesta de repartir una
   * posición que el venue lleva como una sola.
   *
   * Aquí se comprueba para poder dar un mensaje que se entienda; la garantía
   * real la da el índice único parcial de la base.
   */
  private async assertPairFree(bot: {
    id: string;
    symbol: string;
    exchange_account_id: string;
    dry_run: boolean;
  }): Promise<void> {
    // Solo los REALES compiten: la posición de un bot simulado vive en SU propio
    // simulador y no choca con nadie.
    //
    // Los simulados estuvieron dentro de la regla una temporada, y con razón:
    // mientras el simulador fue uno por CUENTA, dos simulados sobre el mismo par
    // se promediaban la entrada y se cerraban el take profit igual que dos
    // reales. Desde que cada bot tiene su propio sandbox (`paper_states`) eso ya
    // no pasa, y poder correr cinco estrategias sobre BTC a la vez para
    // compararlas es justo para lo que sirve simular.
    if (bot.dry_run) return;

    const rival = await this.db.bot.findFirst({
      where: {
        id: { not: bot.id },
        exchange_account_id: bot.exchange_account_id,
        symbol: bot.symbol,
        status: { in: LIVE_STATUSES },
        dry_run: false,
      },
      select: { name: true },
    });
    if (rival) {
      throw new ConflictException(
        `«${rival.name}» ya está operando ${bot.symbol} en esa conexión. ` +
          'En un DEX la posición es única por cuenta y símbolo: dos bots sobre el mismo par ' +
          'se pisarían la posición y el take profit. Párala antes de arrancar este.',
      );
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Histórico
  // ═══════════════════════════════════════════════════════════════

  async orders(userId: string, id: string, limit = 100, offset = 0) {
    await this.mustOwn(userId, id);
    return this.db.botOrder.findMany({
      where: { bot_id: id },
      orderBy: { placed_at: 'desc' },
      take: limit,
      skip: offset,
    });
  }

  async fills(userId: string, id: string, limit = 100, offset = 0) {
    await this.mustOwn(userId, id);
    return this.db.botFill.findMany({
      where: { order: { bot_id: id } },
      orderBy: { executed_at: 'desc' },
      take: limit,
      skip: offset,
      include: {
        order: {
          select: { level_kind: true, level_index: true, cycle_seq: true },
        },
      },
    });
  }

  async cycles(userId: string, id: string, limit = 50, offset = 0) {
    await this.mustOwn(userId, id);
    return this.db.botCycle.findMany({
      where: { bot_id: id },
      orderBy: { seq: 'desc' },
      take: limit,
      skip: offset,
    });
  }

  async events(userId: string, id: string, limit = 100, offset = 0) {
    await this.mustOwn(userId, id);
    return this.db.botEvent.findMany({
      where: { bot_id: id },
      orderBy: { created_at: 'desc' },
      take: limit,
      skip: offset,
    });
  }

  async snapshots(userId: string, id: string, limit = 500) {
    await this.mustOwn(userId, id);
    return this.db.botSnapshot.findMany({
      where: { bot_id: id },
      orderBy: { taken_at: 'desc' },
      take: limit,
    });
  }

  /**
   * Ficha de market making.
   *
   * Los contadores crudos los mantiene el worker en cada ejecución; aquí solo
   * se derivan las cifras que dependen del AHORA —el PnL del inventario abierto
   * y el tiempo transcurrido— y se componen los ratios.
   *
   * Las definiciones se fijan aquí porque no son universales, y la app las
   * enseña al pie para que nadie las confunda con las de otra plataforma:
   *
   * · grossMatchedProfit — diferencial capturado ANTES de comisiones.
   * · realizedPnl        — el mismo número ya con las comisiones restadas.
   * · inventoryPnl       — PnL no realizado del inventario que sigue abierto.
   * · totalProfit        — realizado + inventario.
   * · efficiencyPct      — diferencial capturado sobre el mayor margen usado.
   * · aprPct             — el beneficio total anualizado sobre ese mismo margen.
   *
   * `efficiencyPct` y `aprPct` salen null en vez de cero cuando no hay margen de
   * referencia: un bot que aún no ha inmovilizado nada no tiene un 0 % de
   * eficiencia, no tiene eficiencia todavía, y pintar un cero haría creer que
   * está funcionando mal.
   */
  async marketMakerStats(
    userId: string,
    id: string,
  ): Promise<MarketMakerStats> {
    const bot = await this.mustOwn(userId, id);

    const [stats, snapshot] = await Promise.all([
      this.db.botMmStat.findUnique({ where: { bot_id: id } }),
      this.db.botSnapshot.findFirst({
        where: { bot_id: id },
        orderBy: { taken_at: 'desc' },
      }),
    ]);

    const gross = D(stats?.gross_matched_profit?.toString() ?? 0);
    const fees = D(stats?.fees_paid?.toString() ?? 0);
    const realized = gross.minus(fees);
    const inventory = D(snapshot?.unrealized_pnl?.toString() ?? 0);
    const total = realized.plus(inventory);
    const peakMargin = D(stats?.peak_margin?.toString() ?? 0);

    // El reloj se para cuando para el bot. La APR divide por este tiempo, así
    // que dejarlo correr haría que la rentabilidad de un bot detenido se fuera
    // acercando a cero sola, día tras día, sin que hubiera pasado nada.
    const startedAt = bot.started_at ?? bot.created_at;
    const hasta =
      bot.stopped_at && bot.stopped_at > startedAt
        ? bot.stopped_at
        : new Date();
    const uptimeSeconds = Math.max(
      0,
      Math.floor((hasta.getTime() - startedAt.getTime()) / 1000),
    );

    const efficiencyPct = peakMargin.gt(0)
      ? gross.div(peakMargin).mul(100)
      : null;

    // La APR necesita las dos cosas: capital de referencia y tiempo corrido.
    // Anualizar los primeros minutos de un bot da cifras de tres dígitos que no
    // significan nada, así que por debajo de una hora no se publica.
    const aprPct =
      peakMargin.gt(0) && uptimeSeconds >= 3600
        ? total
            .div(peakMargin)
            .mul(100)
            .mul(D(365 * 24 * 3600).div(uptimeSeconds))
        : null;

    return {
      botId: id,
      fills: stats?.fills ?? 0,
      buyFills: stats?.buy_fills ?? 0,
      sellFills: stats?.sell_fills ?? 0,
      makerFills: stats?.maker_fills ?? 0,
      takerFills: stats?.taker_fills ?? 0,
      closedCycles: stats?.closed_cycles ?? 0,
      grossMatchedProfit: gross.toFixed(2),
      feesPaid: fees.toFixed(2),
      realizedPnl: realized.toFixed(2),
      inventoryPnl: inventory.toFixed(2),
      totalProfit: total.toFixed(2),
      peakInventory: D(stats?.peak_inventory?.toString() ?? 0).toFixed(2),
      peakMargin: peakMargin.toFixed(2),
      efficiencyPct: efficiencyPct ? efficiencyPct.toFixed(2) : null,
      aprPct: aprPct ? aprPct.toFixed(2) : null,
      uptimeSeconds,
      lastFillAt: stats?.last_fill_at?.toISOString() ?? null,
    };
  }

  async levels(userId: string, id: string) {
    await this.mustOwn(userId, id);
    return this.db.botLevel.findMany({
      where: { bot_id: id },
      orderBy: [{ cycle_seq: 'desc' }, { level_index: 'asc' }],
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // Interno
  // ═══════════════════════════════════════════════════════════════

  private async mustOwn(userId: string, id: string) {
    const bot = await this.db.bot.findFirst({ where: { id, user_id: userId } });
    if (!bot) throw new NotFoundException('Bot no encontrado.');
    return bot;
  }

  /**
   * La red de un bot. No se guarda en `bots` a proposito: vive en la cuenta, y
   * duplicarla aqui daria dos verdades que podrian discrepar. La fila es
   * pequena y este camino no esta en el bucle caliente del motor.
   */
  private async networkOf(
    exchangeAccountId: string,
  ): Promise<{ testnet: boolean; paper: boolean }> {
    const account = await this.db.exchangeAccount.findUnique({
      where: { id: exchangeAccountId },
      select: { testnet: true, paper: true },
    });
    return {
      testnet: account?.testnet === true,
      paper: account?.paper === true,
    };
  }

  /**
   * Precio de referencia. Se intenta con el último snapshot de cualquier bot de
   * ese mercado antes de pedirlo al venue: evita abrir una conexión y firmar
   * solo para pintar un preview.
   *
   * La credencial que se usa es SIEMPRE del usuario que pregunta. Antes se
   * cogía la primera cuenta verificada del venue fuera cual fuera su dueño, así
   * que pedir un preview descifraba la clave privada de un tercero elegible a
   * voluntad con solo cambiar el venue. El mensaje de error ya decía
   * «necesitas una conexión verificada»; ahora la consulta lo cumple.
   */
  private async referencePrice(
    userId: string,
    venue: Venue,
    symbol: string,
    testnet = false,
  ): Promise<string> {
    // Primero, el precio que el motor ya está siguiendo.
    //
    // Es información PÚBLICA y el worker la publica en Redis con caducidad
    // corta, así que aquí no hace falta ni ir al venue ni descifrar la
    // credencial de nadie. Antes se rebuscaba el `mark_price` en los snapshots
    // de bots ajenos —un recorrido de una tabla que crece sin parar, y por un
    // camino que ya no debería existir— y, si no había, se abría un adaptador
    // autenticado para leer un número público.
    const shared = await this.bus
      .cacheGet<{ mark?: string }>(
        `crypton:px:${venueKey(venue, testnet)}:${symbol}`,
      )
      .catch(() => null);
    if (shared?.mark) return shared.mark;

    // La cuenta tiene que ser de la MISMA red. Sin el filtro, un usuario con
    // cuentas en las dos podia acabar leyendo el precio de mainnet para un
    // preview de testnet —o al reves— y ver una escalera montada sobre un precio
    // que no existe en el libro donde va a operar.
    const account = await this.db.exchangeAccount.findFirst({
      where: {
        user_id: userId,
        venue,
        testnet,
        status: { in: ['VERIFIED', 'ACTIVE'] },
      },
      select: { id: true },
    });
    if (!account) {
      const red = testnet ? ' (testnet)' : '';
      throw new ForbiddenException(
        `Necesitas una conexión verificada en ${venue}${red} para consultar precios.`,
      );
    }

    const adapter = await this.accounts.openAdapter(userId, account.id);
    try {
      const ticker = await adapter.getTicker(symbol);
      return ticker.mark;
    } finally {
      await adapter.close().catch(() => undefined);
    }
  }
}

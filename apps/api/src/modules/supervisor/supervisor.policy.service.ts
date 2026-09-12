import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { AiDecisionState, AiMode, Role } from '@crypton/db';
import { DbService } from 'src/libs';
import { MarketDataService } from '../market-data';
import { defaultKnobs } from '../advisor/build';

/**
 * Encender y apagar el Modo IA de un bot.
 *
 * **Aqui vive la frontera del spec 033**, que dice que sobre un bot AJENO un
 * administrador solo puede `PAUSE` y `STOP_KEEP_POSITION` — mirar y contener,
 * nunca disponer del dinero de nadie. Un supervisor que reescribe
 * configuraciones de bots ajenos se la saltaria entera.
 *
 * La resolucion no es un permiso nuevo: **el Modo IA solo se activa sobre bots
 * PROPIOS de un administrador**. Asi no es «un admin operando el bot de otro»,
 * es el dueño operando el suyo con una herramienta, y la consola de
 * administracion no gana ni una ruta sobre bots ajenos.
 *
 * Se hace cumplir en TRES sitios independientes, y son tres a proposito:
 *
 *   1. Aqui, al activar: si el bot no es suyo, `Forbidden`.
 *   2. En el barrido, que exige `role = 'ADMIN'` en la consulta: si a alguien le
 *      quitan el rol, sus politicas se duermen solas sin que nadie tenga que
 *      acordarse de desactivarlas.
 *   3. Al aplicar, porque se escribe con el `user_id` del dueño y `mustOwn`
 *      sigue siendo cierto — no relajado.
 */
@Injectable()
export class SupervisorPolicyService {
  private readonly logger = new Logger(SupervisorPolicyService.name);

  constructor(
    private readonly db: DbService,
    private readonly marketData: MarketDataService,
  ) {}

  /**
   * El bot, comprobando que quien pide es su dueño Y administrador.
   *
   * El mensaje dice la razon en vez de limitarse a negar: quien lo lea tiene que
   * poder entender que no es un permiso que le falte, es que esa herramienta no
   * existe sobre bots ajenos.
   */
  private async mustOwnAsAdmin(adminId: string, botId: string) {
    const bot = await this.db.bot.findUnique({
      where: { id: botId },
      select: {
        id: true,
        user_id: true,
        strategy: true,
        venue: true,
        symbol: true,
        status: true,
        dry_run: true,
        config_version: true,
        exchange_account_id: true,
      },
    });
    if (!bot) throw new NotFoundException('Bot no encontrado.');

    if (bot.user_id !== adminId) {
      throw new ForbiddenException(
        'El Modo IA solo se activa sobre bots propios. Sobre un bot ajeno un ' +
          'administrador solo puede contener (spec 033): pausarlo o sacarlo del motor.',
      );
    }
    return bot;
  }

  /** El estado del Modo IA de un bot. Sin fila es OFF, y significan lo mismo. */
  async get(adminId: string, botId: string) {
    await this.mustOwnAsAdmin(adminId, botId);
    const fila = await this.db.botAiSetting.findUnique({ where: { bot_id: botId } });
    return fila ?? { bot_id: botId, mode: AiMode.OFF, knobs: null };
  }

  /**
   * Enciende, apaga o reconfigura el Modo IA.
   *
   * Al pasar de OFF a otra cosa se SIEMBRAN las perillas de referencia, y eso no
   * es opcional: el contrato con el modelo son desplazamientos sobre un punto de
   * partida, y `buildConfig` no es invertible —la configuracion de un bot que
   * lleva tres semanas no dice con que perillas nacio—. Se siembran con
   * `defaultKnobs` sobre los rasgos del par de HOY, que es la mejor
   * aproximacion disponible a «que perillas explicarian esta configuracion».
   */
  async set(
    adminId: string,
    botId: string,
    dto: { mode: AiMode; trigger?: string; reviewEveryMinutes?: number; allowWarm?: boolean },
  ) {
    const bot = await this.mustOwnAsAdmin(adminId, botId);

    // Solo las estrategias del alcance del spec 046. Las demas no es que fallen:
    // es que en grids, martingala y gridmart los campos que de verdad importan
    // estan marcados `reshapes`, asi que el cambio se rechaza en cuanto el ciclo
    // tiene inventario — el supervisor acertaria poco y gastaria igual.
    if (dto.mode !== AiMode.OFF && !ESTRATEGIAS_CON_SUPERVISOR.has(bot.strategy)) {
      throw new ForbiddenException(
        `El Modo IA todavía no cubre ${bot.strategy}. De momento solo los dos market makers, ` +
          'la estrategia de tendencia y la de seguimiento de beneficio.',
      );
    }

    // El modo MANUAL notifica por Telegram y se aprueba con sus botones. Sin
    // vinculacion las sugerencias se escriben y no llegan a NINGUNA parte: el
    // modo aparece encendido y no pasa nada nunca, y quien lo enciende concluye
    // que el supervisor no propone —no que le falta vincular un chat—. El peor
    // sintoma posible es el silencio (spec 047, G-03).
    if (dto.mode === AiMode.MANUAL) {
      const link = await this.db.telegramLink.findUnique({
        where: { user_id: adminId },
        select: { verified_at: true },
      });
      if (!link?.verified_at) {
        throw new ForbiddenException(
          'El modo «propone y espera» manda las sugerencias por Telegram, y no tienes ' +
            'ningún chat vinculado: no te llegaría ninguna. Vincúlalo en Cuenta → Telegram ' +
            'y vuelve a intentarlo.',
        );
      }
    }

    const previa = await this.db.botAiSetting.findUnique({ where: { bot_id: botId } });
    // Los rasgos del par se siembran A LA VEZ que las perillas y por el mismo
    // motivo: son la referencia contra la que se mide el cambio de regimen, y
    // sin ella esa linea —la que de verdad decide— no se emite nunca
    // (spec 047, F-01). No se resiembran al reconfigurar: una referencia que
    // persigue al mercado siempre diria «parecido».
    const rasgos = (previa?.features_at_enable as never) ?? (await this.rasgosDe(bot));
    const knobs = previa?.knobs ?? defaultKnobs('EQUILIBRADA', rasgos ?? this.rasgosDeRespaldo());

    const fila = await this.db.botAiSetting.upsert({
      where: { bot_id: botId },
      create: {
        bot_id: botId,
        mode: dto.mode,
        knobs: knobs as never,
        // Null si el par no tenia velas: sin referencia real, el expediente se
        // calla en vez de comparar contra un valor inventado.
        features_at_enable: rasgos ?? undefined,
        trigger: dto.trigger ?? 'AMBOS',
        review_every_minutes: dto.reviewEveryMinutes ?? null,
        allow_warm: dto.allowWarm ?? true,
        enabled_by: adminId,
        enabled_at: dto.mode === AiMode.OFF ? null : new Date(),
      },
      update: {
        mode: dto.mode,
        ...(dto.trigger === undefined ? {} : { trigger: dto.trigger }),
        ...(dto.reviewEveryMinutes === undefined
          ? {}
          : { review_every_minutes: dto.reviewEveryMinutes }),
        ...(dto.allowWarm === undefined ? {} : { allow_warm: dto.allowWarm }),
        enabled_by: adminId,
        enabled_at: dto.mode === AiMode.OFF ? null : (previa?.enabled_at ?? new Date()),
        ...(previa?.features_at_enable || !rasgos ? {} : { features_at_enable: rasgos }),
        // Apagar limpia el castigo: si estaba dormido por fallos, volver a
        // encenderlo es decir «intentalo otra vez».
        ...(dto.mode === AiMode.OFF ? { failures: 0, paused_until: null, last_error: null } : {}),
      },
    });

    // Apagar retira lo que estuviera esperando. Una sugerencia pendiente de un
    // modo que ya no esta encendido es una trampa: alguien la aprobaria mañana
    // sin saber que el modo se apago.
    if (dto.mode === AiMode.OFF) {
      await this.db.botAiDecision.updateMany({
        where: { bot_id: botId, state: AiDecisionState.PROPUESTA },
        data: { state: AiDecisionState.DESCARTADA, discard_reason: 'MODO_APAGADO' },
      });
    }

    this.logger.log(`Bot ${botId}: Modo IA ${dto.mode} por ${adminId}`);
    return fila;
  }

  /**
   * Perillas de partida para un bot que ya existe.
   *
   * Se usa el perfil EQUILIBRADA y los rasgos del par de hoy. No se intenta
   * deducir con que perillas nacio el bot —no se puede, `buildConfig` no es
   * invertible— y tampoco importa demasiado: lo que el modelo mueve son
   * DESPLAZAMIENTOS, asi que lo unico que hace falta es un origen consistente
   * desde el que contar.
   *
   * Si no hay rasgos del par —un par recien listado, sin velas suficientes— se
   * siembra igual con unos rasgos neutros. Negarse a encender el modo por eso
   * seria peor: el bot ya existe y el par tendra velas en unas horas.
   */
  private async rasgosDe(bot: { venue: string; symbol: string; exchange_account_id: string }) {
    const cuenta = await this.db.exchangeAccount.findUnique({
      where: { id: bot.exchange_account_id },
      select: { testnet: true },
    });
    return this.marketData
      .features(bot.venue as never, bot.symbol, cuenta?.testnet ?? false)
      .catch(() => null);
  }

  /**
   * Rasgos con los que sembrar las perillas cuando el par todavia no tiene velas.
   *
   * Sirven para eso y SOLO para eso: una perilla es un punto de partida, y un
   * valor aproximado es tolerable. Lo que no puede es acabar en
   * `features_at_enable`, que es una referencia de MEDIDA: el expediente diria
   * «el par se mueve tres veces mas que cuando se configuro» comparando contra un
   * numero que nadie calculo, y el modelo no tendria forma de sospecharlo
   * (spec 047, G-02).
   */
  private rasgosDeRespaldo() {
    return {
      mark: 0,
      volAnnualPct: 60,
      atrPct1h: 0.5,
      atrPct1d: 3,
      rangePct30: 25,
      posInRange: 0.5,
      trendPct: 0,
      trend: 'LATERAL' as const,
      efficiency: 0.3,
      worstDayPct: -6,
      tickBps: 1,
    };
  }

  /** Los bots que toca revisar, ya filtrados por la frontera. */
  async pendientesDeRevision(limite: number, ahora = new Date()) {
    return this.db.botAiSetting.findMany({
      where: {
        mode: { in: [AiMode.MANUAL, AiMode.AUTO] },
        // El disparador se respeta en los DOS sentidos. El manejador de eventos
        // ya excluia a los `PERIODICO`; sin esto, un bot configurado como
        // «revisame solo cuando cierre un ciclo» se revisaba igualmente cada
        // media hora, y quien lo eligio para gastar menos gastaba lo mismo sin
        // que nada se lo dijera (spec 047, F-05).
        trigger: { in: ['PERIODICO', 'AMBOS'] },
        OR: [{ paused_until: null }, { paused_until: { lt: ahora } }],
        bot: {
          status: 'RUNNING',
          // La frontera del spec 033, otra vez y en la consulta: si a alguien le
          // quitan el rol de administrador, sus politicas dejan de barrerse sin
          // que nadie tenga que acordarse de apagarlas una por una.
          user: { role: Role.ADMIN, disabled: false },
        },
      },
      orderBy: { last_review_at: { sort: 'asc', nulls: 'first' } },
      take: limite,
      include: {
        bot: {
          select: {
            id: true,
            user_id: true,
            strategy: true,
            venue: true,
            symbol: true,
            status: true,
            dry_run: true,
            leverage: true,
            total_investment: true,
            config_version: true,
            exchange_account_id: true,
            started_at: true,
          },
        },
      },
    });
  }
}

/** Las cuatro del alcance del spec 046. */
const ESTRATEGIAS_CON_SUPERVISOR = new Set([
  'MARKET_MAKER',
  'MARKET_MAKER_V2',
  'TREND_FOLLOW',
  'TRAILING_PROFIT',
]);

export { ESTRATEGIAS_CON_SUPERVISOR };

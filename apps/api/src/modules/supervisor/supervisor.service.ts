import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiDecisionState, AiMode } from '@crypton/db';
import { D, EventSeverity, resumenDeCiclos, type MarketFeatures } from '@crypton/shared';
import { getStrategy } from '@crypton/strategy-core';
import { BUS_CHANNELS, BusService, CacheService, DbService } from 'src/libs';
import { MarketDataService } from '../market-data';
import { MarketsService } from '../markets';
import { RiskService } from '../risk';
import { BotsService } from '../bots';
import { OpenRouterClient } from '../advisor/openrouter.client';
import type { BuildContext, Knobs } from '../advisor/build';
import { decidirCambio, type CambioPropuesto, type Desplazamientos } from './apply';
import {
  parseRevision,
  PROMPT_VERSION_REVISION,
  revisionSchema,
  systemPromptRevision,
  type Revision,
} from './decision';
import {
  construirExpediente,
  expedienteAPrompt,
  expedienteBucket,
  type Expediente,
} from './dossier';

/**
 * El lazo del supervisor: elegir, mirar, decidir y —si toca— aplicar.
 *
 * Lo que hace seguro todo esto no es que el modelo se porte bien, sino que la
 * unica salida es el MISMO camino de escritura que usa una persona:
 * `BotsService.updateConfig`, con su `diffConfig`, su rechazo de COLD, su guarda
 * de reshape con inventario, su `validate()` y su `assertWithinLimits`. No hay
 * un segundo camino, y eso es deliberado: un segundo camino de escritura acaba
 * perdiendo una de esas comprobaciones, no el primer dia pero si el dia que
 * alguien toque uno de los dos y no el otro.
 *
 * Antes de gastar una sola llamada pasan CINCO barreras, todas deterministas:
 * el filtro por tipo de disparo, el hueco minimo entre llamadas del mismo bot,
 * la coalescencia en Redis, la huella del expediente, y las dos cuotas. Ninguna
 * depende de lo que diga el modelo, porque todas ocurren antes de preguntarle.
 */
@Injectable()
export class SupervisorService {
  private readonly logger = new Logger(SupervisorService.name);

  constructor(
    private readonly db: DbService,
    private readonly cache: CacheService,
    private readonly bus: BusService,
    private readonly config: ConfigService,
    private readonly modelo: OpenRouterClient,
    private readonly marketData: MarketDataService,
    private readonly markets: MarketsService,
    private readonly risk: RiskService,
    private readonly bots: BotsService,
  ) {}

  private num(clave: string, porDefecto: number): number {
    const crudo = (this.config.get<string>(clave, '') ?? '').toString().trim();
    // Vacio significa «sin configurar», NO cero: `Number('')` devuelve 0, y un
    // `.env` a medio rellenar apagaria la funcion en silencio. Es la misma
    // trampa que documenta `consumeCupo` del asesor.
    if (crudo === '') return porDefecto;
    const n = Number(crudo);
    if (!Number.isFinite(n)) {
      this.logger.warn(`${clave} no es un número («${crudo}»): se usa ${porDefecto}.`);
      return porDefecto;
    }
    return n;
  }

  private get enabled(): boolean {
    return this.config.get<string>('AI_AGENT_ENABLE', 'false') === 'true';
  }

  /** Degrada TODO el automatico a manual sin tocar la base. */
  private get forzarManual(): boolean {
    return this.config.get<string>('AI_AGENT_FORCE_MANUAL', 'false') === 'true';
  }

  private get soloSimulados(): boolean {
    return this.config.get<string>('AI_AGENT_DRY_RUN_ONLY', 'true') === 'true';
  }

  /**
   * ¿Cabe otra llamada pagada?
   *
   * Dos contadores: uno por bot y otro de toda la plataforma. El segundo es el
   * que de verdad salva la factura — el primero depende de que cada bot este
   * bien configurado, y el global no depende de nada.
   *
   * Se incrementan ANTES de llamar y no despues de acertar. Contar solo los
   * exitos dejaria abierta la puerta obvia: veinte disparos simultaneos pasarian
   * todos la comprobacion antes de que ninguno terminara.
   *
   * Si Redis no responde, `incrWithExpire` devuelve -1 y aqui se NIEGA. Es lo
   * contrario de lo que hace el resto del cache —que degrada abriendo la mano— y
   * el motivo es el que ya documenta el asesor: al otro lado hay una factura, y
   * sin contador no hay tope.
   */
  private async cabeLlamada(botId: string, topeDelBot: number | null): Promise<boolean> {
    const dia = new Date().toISOString().slice(0, 10);

    const global = await this.cache
      .incrWithExpire(`ai:quota:global:${dia}`, 86_400)
      .catch(() => -1);
    if (global < 0) {
      this.logger.warn('Sin contador de cupo global: el Modo IA no llama al modelo.');
      return false;
    }
    if (global > this.num('AI_AGENT_GLOBAL_DAILY_LIMIT', 500)) {
      this.logger.warn('Cupo diario global del Modo IA agotado.');
      return false;
    }

    const porBot = await this.cache
      .incrWithExpire(`ai:quota:bot:${botId}:${dia}`, 86_400)
      .catch(() => -1);
    if (porBot < 0) return false;
    return porBot <= (topeDelBot ?? this.num('AI_AGENT_DAILY_LIMIT', 24));
  }

  /**
   * El hueco minimo entre llamadas del mismo bot, y la coalescencia entre
   * replicas, en una sola primitiva.
   *
   * `setnx` devuelve false si la clave ya existe, asi que resuelve dos cosas a la
   * vez: que un bot que cierra treinta ciclos en una hora gaste seis llamadas y
   * no treinta, y que con N replicas de API —todas reciben el mismo evento del
   * bus— solo una lo atienda. Mismo patron que `lock:markets-sync`.
   */
  private async reservarTurno(botId: string, minutos: number): Promise<boolean> {
    return this.cache
      .setnx(`ai:cooldown:${botId}`, Date.now(), Math.max(60, Math.floor(minutos * 60)))
      .catch(() => false);
  }

  /** Por que una revision no llego a ninguna parte. Solo para el log. */
  private saltar(botId: string, motivo: string): null {
    this.logger.debug(`Bot ${botId}: revisión saltada (${motivo}).`);
    return null;
  }

  /**
   * Revisa un bot. Devuelve el id de la decision escrita, o null si no hubo.
   *
   * `disparo` dice de donde vino, y solo entra en la fila: lo que decide si se
   * revisa o no son las barreras, no quien llame.
   */
  async revisarBot(
    ajuste: {
      bot_id: string;
      mode: AiMode;
      knobs: unknown;
      review_every_minutes: number | null;
      daily_call_limit: number | null;
      allow_warm: boolean;
      last_bucket: string | null;
      failures: number;
      features_at_enable?: unknown;
    },
    bot: {
      id: string;
      user_id: string;
      strategy: string;
      venue: string;
      symbol: string;
      status: string;
      dry_run: boolean;
      config_version: number;
      exchange_account_id: string;
      started_at: Date | null;
    },
    disparo: string,
  ): Promise<bigint | null> {
    if (!this.enabled) return this.saltar(bot.id, 'interruptor apagado');
    if (!this.modelo.agentAvailable) return this.saltar(bot.id, 'sin clave de modelo');

    // Nunca sobre un bot que no esta operando. En ERROR la premisa esta rota
    // —con el adaptador averiado la configuracion no es el problema— y en
    // LIQUIDATED no queda nada que ajustar.
    if (bot.status !== 'RUNNING') return this.saltar(bot.id, `estado ${bot.status}`);

    // La red de la primera entrega: solo bots simulados. Es la respuesta honesta
    // al principio de la casa de no cambiarle la conducta a un bot en marcha.
    if (this.soloSimulados && !bot.dry_run) return this.saltar(bot.id, 'no es simulado');

    const intervalo = ajuste.review_every_minutes ?? INTERVALO_POR_ESTRATEGIA[bot.strategy] ?? 30;
    const hueco = Math.max(this.num('AI_MIN_GAP_MIN', 10), 0);
    if (!(await this.reservarTurno(bot.id, Math.max(intervalo, hueco)))) {
      return this.saltar(bot.id, 'dentro del enfriamiento');
    }

    const contexto = await this.contextoDe(bot);
    if (!contexto) return this.saltar(bot.id, 'sin datos de mercado');

    const expediente = await this.expedienteDe(
      bot,
      ajuste.knobs as Knobs,
      contexto,
      (ajuste.features_at_enable as MarketFeatures | null) ?? null,
    );
    const huella = expedienteBucket(expediente);

    // La barrera que mas ahorra: si el REGIMEN no ha cambiado, la decision
    // anterior sigue valiendo y preguntar otra vez es pagar por la misma
    // respuesta. Para un bot tranquilo esto convierte cuarenta y ocho revisiones
    // al dia en unas pocas llamadas.
    if (huella === ajuste.last_bucket) {
      await this.marcarRevisado(bot.id, huella);
      return this.saltar(bot.id, 'nada material ha cambiado');
    }

    if (!(await this.cabeLlamada(bot.id, ajuste.daily_call_limit))) {
      return this.saltar(bot.id, 'sin cupo');
    }

    const arrancado = Date.now();
    const crudo = await this.modelo.revisar(
      { name: 'revision', schema: revisionSchema() },
      systemPromptRevision(),
      expedienteAPrompt(expediente),
    );
    const latencia = Date.now() - arrancado;

    await this.marcarRevisado(bot.id, huella);

    if (crudo === null) return this.fallo(bot, ajuste, expediente, disparo, 'MODELO', latencia);
    const revision = parseRevision(crudo);
    if (!revision) return this.fallo(bot, ajuste, expediente, disparo, 'CONTRATO', latencia);

    return this.aplicarDecision(bot, ajuste, expediente, revision, contexto, disparo, latencia);
  }

  /**
   * De la decision del modelo a una fila, y —si el modo lo permite— a un cambio.
   *
   * `MANTENER` no escribe nada. Es lo mas frecuente y tiene que salir gratis: una
   * fila cada media hora diciendo «todo bien» llenaria la tabla de ruido y
   * convertiria el historial en algo que nadie mira.
   */
  private async aplicarDecision(
    bot: {
      id: string;
      user_id: string;
      strategy: string;
      config_version: number;
      dry_run: boolean;
    },
    ajuste: { mode: AiMode; knobs: unknown; allow_warm: boolean },
    expediente: Expediente,
    revision: Revision,
    contexto: Contexto,
    disparo: string,
    latencia: number,
  ): Promise<bigint | null> {
    const modo = this.forzarManual && ajuste.mode === AiMode.AUTO ? AiMode.MANUAL : ajuste.mode;

    if (revision.accion === 'MANTENER') {
      this.logger.debug(`Bot ${bot.id}: MANTENER — ${revision.motivo}`);
      return null;
    }

    const strategy = getStrategy(bot.strategy as never);
    const knobs = ajuste.knobs as Knobs;

    // `AVISAR` ignora los desplazamientos a proposito: es como el modelo dice
    // «esto lo tiene que mirar una persona» sin pedir un cambio. Honrarlos
    // ademas seria convertir un aviso en una propuesta que nadie pidio.
    const cambio =
      revision.accion === 'AVISAR'
        ? null
        : decidirCambio({
            strategy,
            vigente: contexto.vigente,
            knobs,
            ajustes: revision.ajustes,
            ctx: contexto.build,
            refPrice: contexto.refPrice,
            inventario: contexto.inventario,
            permitirWarm: ajuste.allow_warm,
          });

    const descartada = typeof cambio === 'string';

    const fila = await this.db.botAiDecision.create({
      data: {
        bot_id: bot.id,
        trigger: disparo,
        mode: modo,
        raw: revision as never,
        action: revision.accion,
        confidence: revision.confianza,
        rationale: revision.motivo,
        dossier: expediente as never,
        knobs_before: knobs as never,
        knobs_after: cambio && !descartada ? (cambio.knobs as never) : undefined,
        proposed_config: cambio && !descartada ? (cambio.config as never) : undefined,
        diff: cambio && !descartada ? (cambio.diff.changed as never) : undefined,
        apply_level: cambio && !descartada ? cambio.level : null,
        config_version_before: bot.config_version,
        // Un aviso NO es una propuesta: no hay nada que aprobar, asi que nace
        // terminal. Como `PROPUESTA` sin caducidad se quedaba pendiente para
        // siempre —el cron que caduca filtra por `expires_at`— y ensuciaba
        // cualquier vista de «que hay esperando» (spec 047, F-06).
        state:
          revision.accion === 'AVISAR'
            ? AiDecisionState.AVISADA
            : descartada
              ? AiDecisionState.DESCARTADA
              : AiDecisionState.PROPUESTA,
        discard_reason: descartada ? cambio : null,
        expires_at:
          revision.accion === 'AVISAR' || descartada
            ? null
            : new Date(Date.now() + this.num('AI_AGENT_SUGGESTION_TTL_MIN', 60) * 60_000),
        // El modelo que decidio, no el nombre de la variable que lo nombra
        // (spec 047, F-03). La columna existe para poder comparar decisiones de
        // modelos distintos, y con una constante no servia para nada.
        model: this.modelo.agentModelId,
        prompt_version: PROMPT_VERSION_REVISION,
        latency_ms: latencia,
      },
      select: { id: true },
    });

    if (descartada) {
      this.logger.debug(`Bot ${bot.id}: propuesta descartada (${cambio}).`);
      return fila.id;
    }

    // Una sugerencia nueva retira la anterior: una cola de consejos rancios es
    // peor que ninguno, y aprobar el de ayer sobre el mercado de hoy es
    // exactamente lo que la caducidad viene a impedir.
    await this.db.botAiDecision.updateMany({
      where: { bot_id: bot.id, state: AiDecisionState.PROPUESTA, id: { not: fila.id } },
      data: { state: AiDecisionState.DESCARTADA, discard_reason: 'SUPERSEDIDA' },
    });

    if (revision.accion === 'AVISAR') {
      await this.avisar(
        bot,
        'AI_ADVICE',
        `El supervisor recomienda revisar este bot: ${revision.motivo}`,
      );
      return fila.id;
    }

    const campos = cambio!.diff.changed.map((c) => c.key).join(', ');

    // En manual se propone y se espera. Es la mitad del encargo: que la IA avise
    // y decida una persona.
    if (modo !== AiMode.AUTO) {
      await this.avisar(
        bot,
        'AI_SUGGESTION',
        `El supervisor propone cambiar ${campos}: ${revision.motivo}`,
        EventSeverity.INFO,
        await this.valeDe(bot, fila.id),
      );
      return fila.id;
    }

    await this.aplicar(bot, fila.id, cambio!, campos, revision.motivo);
    return fila.id;
  }

  /**
   * Aplica el cambio por el MISMO camino que lo aplicaria una persona.
   *
   * `BotsService.updateConfig` con el `user_id` del dueño —que por construccion
   * es quien encendio el modo, ver `SupervisorPolicyService`— de modo que
   * `mustOwn` sigue siendo cierto y no relajado. Con el pasan otra vez, ahora
   * contra el estado de la base y no contra el que se leyo hace unos segundos,
   * el `diffConfig`, el rechazo de COLD, la guarda de reshape, `validate()` y
   * `assertWithinLimits`. No hay un segundo camino de escritura, y eso es lo que
   * hace que esto sea seguro: cualquier comprobacion que se añada mañana a la
   * via del usuario la hereda el supervisor sin que nadie se acuerde.
   */
  private async aplicar(
    bot: { id: string; user_id: string },
    decisionId: bigint,
    cambio: CambioPropuesto,
    campos: string,
    motivo: string,
    cuentaParaElTope = true,
  ): Promise<void> {
    // El tope de cambios aplicados al dia, que es distinto del cupo de llamadas:
    // aquel cuenta preguntas y este cuenta CAMBIOS. Es el freno del vaiven — un
    // bot reescrito seis veces hoy deja de aceptar mas aunque quede cupo para
    // seguir preguntando.
    const dia = new Date().toISOString().slice(0, 10);
    const aplicados = cuentaParaElTope
      ? await this.cache.incrWithExpire(`ai:applies:${bot.id}:${dia}`, 86_400).catch(() => -1)
      : 0;
    if (
      cuentaParaElTope &&
      (aplicados < 0 || aplicados > this.num('AI_AGENT_MAX_APPLIES_PER_DAY', 6))
    ) {
      await this.db.botAiDecision.update({
        where: { id: decisionId },
        data: { state: AiDecisionState.DESCARTADA, discard_reason: 'TOPE_DIARIO' },
      });
      return;
    }

    try {
      const r = (await this.bots.updateConfig(
        bot.user_id,
        bot.id,
        { config: cambio.config, acceptRelayout: cambio.level === 'WARM' },
        { appliedBy: `ia:${decisionId}` },
      )) as { version?: number };

      await this.db.botAiDecision.update({
        where: { id: decisionId },
        data: {
          state: AiDecisionState.APLICADA,
          applied_at: new Date(),
          config_version_after: r.version ?? null,
        },
      });

      await this.avisar(
        bot,
        'AI_APPLIED',
        `El supervisor ha cambiado ${campos}: ${motivo}`,
        EventSeverity.WARN,
      );
    } catch (e) {
      // La excepcion NO se traga: si `updateConfig` rechaza el cambio —por
      // riesgo, por validacion, por inventario— eso es justo lo que hay que
      // poder leer despues. Y la configuracion queda intacta, que es lo que
      // importa.
      const mensaje = (e as Error).message;
      await this.db.botAiDecision.update({
        where: { id: decisionId },
        data: { state: AiDecisionState.FALLIDA, discard_reason: 'ESCRITURA', error: mensaje },
      });
      await this.avisar(
        bot,
        'AI_FAILED',
        `El supervisor no pudo aplicar su cambio: ${mensaje}`,
        EventSeverity.WARN,
      );
    }
  }

  /**
   * Un fallo del modelo no toca nada, y se cuenta.
   *
   * **No hay plan B determinista**, y es la asimetria deliberada con el asesor:
   * alli las reglas rellenan un formulario que una persona va a revisar antes de
   * crear nada; aqui reescribirian en silencio la configuracion de un bot vivo
   * porque el modelo estaba caido. Si el modelo no contesta, no se toca nada.
   */
  private async fallo(
    bot: { id: string; user_id: string; config_version: number },
    ajuste: { failures: number; mode: AiMode; knobs: unknown },
    expediente: Expediente,
    disparo: string,
    motivo: string,
    latencia: number,
  ): Promise<bigint> {
    const fallos = ajuste.failures + 1;
    const tope = 5;

    const fila = await this.db.botAiDecision.create({
      data: {
        bot_id: bot.id,
        trigger: disparo,
        // Lo que de verdad pasaba, no un relleno. Guardaba `OFF`, `AVISAR`,
        // perillas vacias y version cero: cuatro columnas falsas en el
        // historial que se mira justamente cuando hay que explicar por que un
        // bot cambio solo (spec 047, F-02).
        mode: ajuste.mode,
        raw: {} as never,
        // Una accion que NO esta en el contrato, a proposito: el modelo no dijo
        // nada, y marcarlo como `AVISAR` hacia que su propio fallo le volviera
        // en la siguiente revision como si fuera una opinion suya.
        action: 'FALLO',
        dossier: expediente as never,
        knobs_before: (ajuste.knobs ?? {}) as never,
        config_version_before: bot.config_version,
        state: AiDecisionState.FALLIDA,
        discard_reason: motivo,
        error: `El modelo no devolvió una revisión utilizable (${motivo}).`,
        prompt_version: PROMPT_VERSION_REVISION,
        latency_ms: latencia,
      },
      select: { id: true },
    });

    await this.db.botAiSetting.update({
      where: { bot_id: bot.id },
      data: {
        failures: fallos,
        last_error: motivo,
        // A los cinco seguidos se duerme seis horas. Sin esto, un OpenRouter
        // caido genera una llamada por ventana y por bot, indefinidamente.
        ...(fallos >= tope ? { paused_until: new Date(Date.now() + 6 * 3_600_000) } : {}),
      },
    });

    // Estrangulado a uno por bot y hora. Un fallo que avisa en cada ventana
    // enseña al usuario a silenciar el canal justo antes del aviso que si habia
    // que leer — es la leccion del spec 029, y vale igual aqui.
    if (await this.cache.setnx(`ai:fail:${bot.id}`, 1, 3600).catch(() => false)) {
      await this.avisar(
        bot,
        'AI_FAILED',
        fallos >= tope
          ? 'El supervisor de IA falla repetidamente y se pausa unas horas.'
          : 'El supervisor de IA no ha podido revisar este bot.',
        EventSeverity.WARN,
      );
    }
    return fila.id;
  }

  /**
   * Escribe el evento del bot y lo publica para que llegue a Telegram.
   *
   * `entregaForzada` porque esto nace en la API: sin la marca, el notificador del
   * worker lo descarta por origen ajeno y no lo entrega NADIE (spec 046, R-27).
   */
  private async avisar(
    bot: { id: string; user_id: string },
    tipo: string,
    mensaje: string,
    severidad: EventSeverity = EventSeverity.INFO,
    token?: string,
  ): Promise<void> {
    await this.db.botEvent
      .create({ data: { bot_id: bot.id, type: tipo, severity: severidad, message: mensaje } })
      .catch(() => undefined);

    await this.bus
      .publish(BUS_CHANNELS.BOT_EVENTS, {
        userId: bot.user_id,
        botId: bot.id,
        type: tipo,
        entregaForzada: true,
        data: { severity: severidad, message: mensaje, ...(token ? { token } : {}) },
      })
      .catch(() => undefined);
  }

  /**
   * Canjea el vale de un boton de Telegram y aplica —o descarta— la sugerencia.
   *
   * Cuatro comprobaciones, y ninguna sobra:
   *
   *   1. `getDel` es ATOMICO: el vale existe una vez. Dos pulsaciones del mismo
   *      boton aplican una sola vez, sin necesidad de ningun otro cerrojo, y con
   *      N replicas de API solo una gana el vale.
   *   2. El vale tiene que pertenecer a quien pulsa. El chat demuestra que ese
   *      Telegram controla la cuenta; esto comprueba que la cuenta es la dueña de
   *      la decision.
   *   3. La decision tiene que seguir PENDIENTE. Una ya aplicada, caducada o
   *      descartada no revive.
   *   4. Y la version de configuracion tiene que ser la misma. Si el bot cambio
   *      mientras la sugerencia esperaba, el mundo cambio debajo: la propuesta
   *      se calculo sobre otra cosa y no se aplica.
   */
  async canjearVale(userId: string, token: string, aplicar: boolean): Promise<void> {
    const vale = await this.cache
      .getDel<{ decisionId: string; botId: string; userId: string }>(`ai:vale:${token}`)
      .catch(() => null);
    if (!vale || vale.userId !== userId) return;

    const decision = await this.db.botAiDecision.findUnique({
      where: { id: BigInt(vale.decisionId) },
      include: {
        bot: {
          select: {
            id: true,
            user_id: true,
            strategy: true,
            status: true,
            config_version: true,
          },
        },
      },
    });
    if (!decision || decision.state !== AiDecisionState.PROPUESTA) return;

    if (!aplicar) {
      await this.db.botAiDecision.update({
        where: { id: decision.id },
        data: {
          state: AiDecisionState.RECHAZADA,
          decided_by: userId,
          decided_at: new Date(),
        },
      });
      return;
    }

    // R-13 tambien aqui: entre proponer y aprobar pueden pasar sesenta minutos, y
    // en ese rato el bot puede haber entrado en ERROR o haber sido liquidado.
    // Con el adaptador averiado la configuracion no es el problema
    // (spec 047, G-04).
    if (decision.bot.status !== 'RUNNING') {
      await this.db.botAiDecision.update({
        where: { id: decision.id },
        data: {
          state: AiDecisionState.CADUCADA,
          discard_reason: 'ESTADO',
          decided_at: new Date(),
        },
      });
      await this.avisar(
        decision.bot,
        'AI_FAILED',
        `La sugerencia no se ha aplicado: el bot ya no está operando (${decision.bot.status}).`,
        EventSeverity.WARN,
      );
      return;
    }

    if (decision.config_version_before !== decision.bot.config_version) {
      await this.db.botAiDecision.update({
        where: { id: decision.id },
        data: { state: AiDecisionState.CADUCADA, discard_reason: 'STALE', decided_at: new Date() },
      });
      await this.avisar(
        decision.bot,
        'AI_FAILED',
        'La sugerencia ya no vale: la configuración del bot ha cambiado desde que se propuso.',
        EventSeverity.WARN,
      );
      return;
    }

    // Se RECALCULA contra el mercado de ahora, no se aplica lo que se guardo
    // (spec 047, F-04). La propuesta pudo calcularse hace una hora, y aunque los
    // campos que mueve el supervisor sean distancias en puntos basicos y no
    // precios, `preview()` es lo UNICO que detecta violaciones de tick, paso y
    // notional minimo del venue — y `updateConfig` no lo llama.
    //
    // Se rehace desde las PERILLAS, que es lo que el modelo decidio de verdad;
    // la configuracion concreta siempre fue una consecuencia, no la decision.
    // Por eso esto no vuelve a preguntarle nada al modelo: no hay coste.
    const rehecho = await this.rehacer(decision);
    if (!rehecho) {
      await this.db.botAiDecision.update({
        where: { id: decision.id },
        data: {
          state: AiDecisionState.CADUCADA,
          discard_reason: 'RECALCULO',
          decided_at: new Date(),
        },
      });
      await this.avisar(
        decision.bot,
        'AI_FAILED',
        'La sugerencia ya no cabe con el mercado de ahora, así que no se ha aplicado.',
        EventSeverity.WARN,
      );
      return;
    }

    // La fila guarda lo que se va a aplicar DE VERDAD, no lo que se propuso hace
    // una hora. El historico existe para explicar por que un bot cambio, y si lo
    // aplicado no es lo anotado, explica mal (spec 047, G-05).
    await this.db.botAiDecision.update({
      where: { id: decision.id },
      data: {
        decided_by: userId,
        decided_at: new Date(),
        proposed_config: rehecho.config as never,
        diff: rehecho.diff.changed as never,
        apply_level: rehecho.level,
        knobs_after: rehecho.knobs as never,
      },
    });

    await this.aplicar(
      decision.bot,
      decision.id,
      rehecho,
      rehecho.diff.changed.map((c) => c.key).join(', '),
      decision.rationale ?? '',
      // Una aprobacion HUMANA no pasa por el tope diario de cambios: ese tope
      // existe para que un bot no se reescriba solo seis veces en una tarde, y
      // quien pulsa el boton ha mirado el cambio y ha decidido (F-09).
      false,
    );
  }

  /**
   * Rehace la propuesta desde las perillas, contra el mercado del momento.
   *
   * Devuelve `null` si ya no produce un cambio aplicable — porque el mercado se
   * movio, porque el ciclo tiene ahora inventario, o porque el propio bot
   * cambio. Que una sugerencia caduque asi es la conducta correcta: lo que no
   * puede pasar es aplicar a ciegas una configuracion calculada con otro
   * mercado.
   */
  private async rehacer(decision: {
    bot: { id: string; user_id: string; strategy: string; config_version: number };
    knobs_before: unknown;
    raw: unknown;
  }): Promise<CambioPropuesto | null> {
    // El mando del dueño manda tambien aqui. `allow_warm: false` significa «solo
    // cambios HOT, nunca recoloques la escalera», y recolocarla cuesta
    // comisiones de verdad: al mover la traduccion de proponer a aplicar (F-04)
    // este parametro se quedo atras, y una aprobacion podia aplicar un WARM que
    // su dueño habia prohibido (spec 047, G-01).
    const ajuste = await this.db.botAiSetting.findUnique({
      where: { bot_id: decision.bot.id },
      select: { allow_warm: true },
    });
    const bot = await this.db.bot.findUnique({
      where: { id: decision.bot.id },
      select: {
        id: true,
        user_id: true,
        venue: true,
        symbol: true,
        config_version: true,
        exchange_account_id: true,
      },
    });
    if (!bot) return null;

    const contexto = await this.contextoDe(bot);
    if (!contexto) return null;

    // Se rehace con las perillas de PARTIDA y los desplazamientos que el modelo
    // pidio, que es lo que de verdad decidio. Partir de `knobs_after` con
    // desplazamiento cero daria siempre «sin cambios»: el delta se calcula entre
    // dos generaciones, y con las mismas perillas a los dos lados no hay ninguna.
    const ajustes = (decision.raw as { ajustes?: Desplazamientos })?.ajustes;
    if (!ajustes) return null;

    const cambio = decidirCambio({
      strategy: getStrategy(decision.bot.strategy as never),
      vigente: contexto.vigente,
      knobs: decision.knobs_before as never,
      ajustes,
      ctx: contexto.build,
      refPrice: contexto.refPrice,
      inventario: contexto.inventario,
      permitirWarm: ajuste?.allow_warm ?? true,
    });
    return typeof cambio === 'string' ? null : cambio;
  }

  /**
   * Un vale de un solo uso para aprobar desde Telegram.
   *
   * Opaco a proposito: en `callback_data` caben 64 bytes, y ademas quien lo
   * intercepte no debe poder deducir de que bot es ni que cambio propone. Lo que
   * identifica se guarda AQUI, en Redis, y se canjea con `getDel` —atomico—, de
   * modo que dos pulsaciones aplican una vez sola.
   *
   * Vive lo mismo que la sugerencia: un vale que sobreviviera a su propuesta
   * seria una llave de una puerta que ya no existe.
   */
  private async valeDe(bot: { id: string; user_id: string }, decisionId: bigint): Promise<string> {
    const token = randomUUID().replace(/-/g, '');
    const minutos = this.num('AI_AGENT_SUGGESTION_TTL_MIN', 60);
    await this.cache
      .set(
        `ai:vale:${token}`,
        { decisionId: decisionId.toString(), botId: bot.id, userId: bot.user_id },
        Math.max(60, minutos * 60),
      )
      .catch(() => undefined);
    return token;
  }

  private async marcarRevisado(botId: string, huella: string): Promise<void> {
    await this.db.botAiSetting
      .update({
        where: { bot_id: botId },
        data: { last_review_at: new Date(), last_bucket: huella },
      })
      .catch(() => undefined);
  }

  /** Todo lo que hace falta para decidir, leido una sola vez. */
  private async contextoDe(bot: {
    id: string;
    user_id: string;
    venue: string;
    symbol: string;
    config_version: number;
    exchange_account_id: string;
  }): Promise<Contexto | null> {
    const cuenta = await this.db.exchangeAccount.findUnique({
      where: { id: bot.exchange_account_id },
      select: { testnet: true },
    });
    const testnet = cuenta?.testnet ?? false;

    const [rasgos, mercado, revision] = await Promise.all([
      this.marketData.features(bot.venue as never, bot.symbol, testnet).catch(() => null),
      this.markets.getSpec(bot.venue as never, bot.symbol, testnet).catch(() => null),
      this.db.botConfigRevision.findUnique({
        where: { bot_id_version: { bot_id: bot.id, version: bot.config_version } },
        select: { config: true },
      }),
    ]);
    // Sin rasgos no se decide nada: un prompt con la volatilidad a cero produce
    // numeros inventados con aspecto de calculados. Es el mismo criterio que
    // aplica `buildFeatures` cuando no hay velas suficientes.
    if (!rasgos || !mercado || !revision) return null;

    const limites = await this.risk.get(bot.user_id).catch(() => null);
    const ciclo = await this.db.botCycle.findFirst({
      where: { bot_id: bot.id, closed_at: null },
      orderBy: { seq: 'desc' },
      select: { filled_level_indexes: true },
    });

    const vigente = revision.config as Record<string, unknown>;
    return {
      testnet,
      rasgos,
      vigente: vigente as never,
      refPrice: String(rasgos.mark),
      inventario: ciclo?.filled_level_indexes.length ?? 0,
      build: {
        market: mercado,
        features: rasgos,
        totalInvestment: Number(vigente['totalInvestment'] ?? 0),
        maxLeverageUsuario: limites?.max_leverage ?? null,
        direction: (vigente['direction'] as 'LONG' | 'SHORT' | 'NEUTRAL') ?? 'LONG',
      },
    };
  }

  /** El expediente, con todo lo que el modelo puede ver y nada mas. */
  private async expedienteDe(
    bot: {
      id: string;
      strategy: string;
      dry_run: boolean;
      status: string;
      started_at: Date | null;
    },
    knobs: Knobs,
    contexto: Contexto,
    rasgosAlActivar: MarketFeatures | null,
  ): Promise<Expediente> {
    const desde = new Date(Date.now() - 24 * 3_600_000);
    const [ciclos, snapshot, eventos, mmStat, decisiones, ultimoFill] = await Promise.all([
      this.db.botCycle.findMany({
        where: { bot_id: bot.id, closed_at: { not: null } },
        orderBy: { seq: 'desc' },
        take: 50,
        select: { seq: true, opened_at: true, closed_at: true, realized_pnl: true, fees: true },
      }),
      // Solo un estado RECIENTE. Los snapshots se escriben cada pocos ticks,
      // asi que un bot que estuvo parado, o cuyo worker tuvo un hueco, presentaba
      // ante el modelo una foto de hace horas COMO SI FUERA DE AHORA — y todo lo
      // demas del expediente si era actual, de modo que mezclaba dos momentos
      // sin saberlo. Mismo criterio que `MarketDataService` con su `STALE_MS`
      // (spec 047, F-07).
      this.db.botSnapshot.findFirst({
        where: { bot_id: bot.id, taken_at: { gte: new Date(Date.now() - SNAPSHOT_FRESCO_MS) } },
        orderBy: { taken_at: 'desc' },
      }),
      this.db.botEvent.groupBy({
        by: ['type'],
        where: { bot_id: bot.id, created_at: { gte: desde } },
        _count: { type: true },
      }),
      this.db.botMmStat.findUnique({ where: { bot_id: bot.id } }),
      // Solo lo que el modelo puede reconocer como SUYO: lo que se aplico y lo
      // que sigue esperando una decision. Una fallida no es una opinion —el
      // modelo no llego a darla— y una descartada nunca llego a pasar, asi que
      // enseñarlas como historial es contarle cosas que no ocurrieron. El spec
      // dice que esto «es lo que impide el vaiven»; contaminado, lo provoca
      // (spec 047, F-02).
      this.db.botAiDecision.findMany({
        where: {
          bot_id: bot.id,
          state: {
            in: [AiDecisionState.APLICADA, AiDecisionState.AVISADA, AiDecisionState.PROPUESTA],
          },
        },
        orderBy: { created_at: 'desc' },
        take: 3,
        select: { action: true, created_at: true },
      }),
      // `bot_fills` cuelga de la ORDEN, no del bot: no tiene `bot_id`. Y la marca
      // de tiempo que importa es `executed_at` —cuando lo ejecuto el venue—, no
      // `created_at`, que es cuando nos enteramos nosotros.
      this.db.botFill.findFirst({
        where: { order: { bot_id: bot.id } },
        orderBy: { executed_at: 'desc' },
        select: { executed_at: true },
      }),
    ]);

    const capital = String(contexto.build.totalInvestment);
    const posicion = snapshot ? D(snapshot.position_qty).abs() : D(0);
    const medio = snapshot?.average_entry ? D(snapshot.average_entry) : D(0);

    return construirExpediente({
      estrategia: bot.strategy,
      direccion: contexto.build.direction,
      simulado: bot.dry_run,
      estado: bot.status,
      horasEnMarcha: bot.started_at ? (Date.now() - bot.started_at.getTime()) / 3_600_000 : 0,
      knobs,
      mercado: contexto.rasgos,
      // La referencia contra la que se mide el cambio de regimen. Sin ella esa
      // linea no se emite, y el prompt de sistema le pide al modelo que la mire:
      // se le preguntaba por un dato que no se le daba (spec 047, F-01).
      mercadoAlConfigurar: rasgosAlActivar,
      ciclos: resumenDeCiclos(
        ciclos.map((c) => ({
          seq: c.seq,
          opened_at: c.opened_at.toISOString(),
          closed_at: c.closed_at?.toISOString() ?? null,
          realized_pnl: c.realized_pnl.toString(),
          fees: c.fees.toString(),
        })),
      ),
      capital,
      expuesto: posicion.mul(medio).toFixed(),
      noRealizado: snapshot ? snapshot.unrealized_pnl.toString() : '0',
      distanciaLiquidacionPct: distanciaPct(snapshot),
      ordenesVivas: snapshot?.open_orders ?? 0,
      makerPct: mmStat ? makerPct(mmStat.maker_fills, mmStat.taker_fills) : null,
      horasSinEjecutar: ultimoFill
        ? (Date.now() - ultimoFill.executed_at.getTime()) / 3_600_000
        : null,
      eventos24h: Object.fromEntries(eventos.map((e) => [e.type, e._count.type])),
      historial: decisiones.map((d) => ({
        accion: d.action as never,
        hace: hace(d.created_at),
      })),
    });
  }
}

interface Contexto {
  testnet: boolean;
  rasgos: MarketFeatures;
  vigente: Parameters<typeof decidirCambio>[0]['vigente'];
  refPrice: string;
  inventario: number;
  build: BuildContext;
}

/**
 * Cada cuanto se revisa cada estrategia, en minutos.
 *
 * Media hora para todas, y no es pereza: lo que se juzga —si el diferencial
 * cubre las comisiones, si la volatilidad ha cambiado de regimen, si el bot
 * lleva mucho sin ejecutar— son MEDIAS, y una media no cambia en cinco minutos.
 * Revisar mas a menudo no daria mejores decisiones, daria las mismas mas caras.
 */
/**
 * Cuanto vale una foto del estado del bot.
 *
 * Diez minutos: el motor escribe un snapshot cada pocos ticks —y el tick son
 * quince segundos— asi que con un bot vivo siempre hay uno dentro de esta
 * ventana. Pasado eso, o el bot no esta operando o su worker tiene un hueco, y
 * en los dos casos es mejor decir «no hay dato» que dar por actual algo que no
 * lo es.
 */
const SNAPSHOT_FRESCO_MS = 10 * 60_000;

const INTERVALO_POR_ESTRATEGIA: Record<string, number> = {
  MARKET_MAKER: 30,
  MARKET_MAKER_V2: 30,
  TREND_FOLLOW: 30,
  TRAILING_PROFIT: 30,
};

function distanciaPct(
  snapshot: {
    mark_price: { toString(): string };
    liquidation_price: { toString(): string } | null;
  } | null,
): number | null {
  if (!snapshot?.liquidation_price) return null;
  // `toString()` explicito y no `String()`: son `Decimal` de Prisma, y el
  // generico daria «[object Object]» — que en un calculo de distancia a
  // liquidacion es de los errores que no se ven hasta que importan.
  const mark = D(snapshot.mark_price.toString());
  const liq = D(snapshot.liquidation_price.toString());
  if (mark.lte(0) || liq.lte(0)) return null;
  return mark.minus(liq).abs().div(mark).mul(100).toNumber();
}

function makerPct(maker: number, taker: number): string | null {
  const total = maker + taker;
  return total === 0 ? null : ((maker / total) * 100).toFixed(1);
}

/** «hace 2 horas», para el historial que ve el modelo. Sin fechas absolutas. */
function hace(cuando: Date): string {
  const min = Math.max(0, Math.round((Date.now() - cuando.getTime()) / 60_000));
  if (min < 60) return `${min} minuto(s)`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} hora(s)`;
  return `${Math.round(h / 24)} día(s)`;
}

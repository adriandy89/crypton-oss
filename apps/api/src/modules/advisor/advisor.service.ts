import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Venue } from '@crypton/db';
import { getStrategy } from '@crypton/strategy-core';
import type {
  BotConfig,
  Candle,
  MarketSpec,
  MarketTicker,
  PreviewResult,
  StrategyKind,
} from '@crypton/shared';
import { CacheService } from 'src/libs';
import { MarketDataService } from '../market-data';
import { MarketsService } from '../markets';
import { RiskService } from '../risk';
import {
  buildConfig,
  defaultKnobs,
  PROFILES,
  type BuildContext,
  type Knobs,
  type Profile,
} from './build';
import { OpenRouterClient } from './openrouter.client';
import { buildFeatures, featuresBucket, type MarketFeatures } from './market-features';
import { PROMPT_VERSION } from './prompt';
import { coerceConfig, enforceCouplings } from './sanitize';

/** Los topes del usuario, ya leidos y en numeros. */
interface RiskLimits {
  maxLeverage: number | null;
  maxNotionalPerBot: number | null;
  maxTotalNotional: number | null;
  /** Notional que ya tienen sus bots vivos. */
  notionalActual: number;
}

/** Por que se descarto un perfil. Alimenta el aviso que ve el usuario. */
type Descarte = 'VALIDACION' | 'VENUE' | 'LIMITES';

/** Lo que se devuelve por perfil. */
export interface RecommendedProfile {
  profile: Profile;
  source: 'IA' | 'REGLAS';
  config: Record<string, unknown>;
  headline: {
    leverage: number;
    worstCaseMargin: string;
    worstCaseNotional: string;
    liquidationDistancePct: string | null;
    levels: number;
  };
  rationale: string;
  warnings: string[];
}

export interface RecommendationSet {
  strategy: StrategyKind;
  venue: Venue;
  symbol: string;
  /** El precio con el que se calculo TODO. La app lo usa para saber si caduco. */
  refPrice: string;
  source: 'IA' | 'REGLAS' | 'MIXTO';
  /** Por que faltan perfiles, si faltan. Se pinta tal cual. */
  notice: string | null;
  market: { atrPct1d: number; rangePct30: number; trend: string } | null;
  profiles: RecommendedProfile[];
}

/** Velas que se piden. Los dos son escalones de la cuantizacion de la API. */
const BARS_1H = 300;
const BARS_1D = 150;

/**
 * Cuanto vive una tanda de perillas en cache.
 *
 * Una hora. Las perillas dependen del REGIMEN del mercado, no del precio: lo que
 * cambia minuto a minuto son los numeros, y esos se derivan en caliente en cada
 * peticion. Sin este cache, cada usuario mirando el mismo par con la misma
 * estrategia seria una llamada pagada.
 */
const KNOBS_TTL = 3600;

/**
 * Cuantas llamadas PAGADAS al modelo puede provocar un usuario en un dia.
 *
 * No limita cuantas veces se pueden pedir recomendaciones —eso seguiria siendo
 * ilimitado—, solo cuantas de esas peticiones acaban en una llamada de verdad.
 * Un acierto de cache no gasta nada, asi que mirar veinte veces el mismo par sale
 * gratis y mirar veinte pares distintos gasta veinte.
 */
const DEFAULT_DAILY_LIMIT = 20;

/**
 * Lo que se devuelve al pedir perillas: hace falta distinguir «el modelo no dijo
 * nada» de «al usuario se le acabo el cupo», porque solo lo segundo se le
 * explica. Sin la distincion, alguien que agota su cupo ve las sugerencias
 * empeorar sin razon aparente.
 */
interface PerillasDeIA {
  knobs: { knobs: Knobs; rationale: string }[] | null;
  cupoAgotado: boolean;
}

@Injectable()
export class AdvisorService {
  private readonly logger = new Logger(AdvisorService.name);

  constructor(
    private readonly markets: MarketsService,
    private readonly marketData: MarketDataService,
    private readonly risk: RiskService,
    private readonly cache: CacheService,
    private readonly modelo: OpenRouterClient,
    private readonly config: ConfigService,
  ) {}

  /**
   * Tres configuraciones completas para (estrategia, par), listas para aplicar.
   *
   * De momento solo la rama de REGLAS: el generador determinista con las
   * perillas puestas por perfil. La rama de IA se enchufa despues eligiendo esas
   * mismas perillas, y entra por esta misma cadena de validacion — que es lo que
   * garantiza que las dos ramas produzcan configuraciones igual de validas.
   */
  async suggest(
    userId: string,
    input: {
      venue: Venue;
      symbol: string;
      strategy: StrategyKind;
      totalInvestment: string;
      testnet?: boolean;
      direction?: 'LONG' | 'SHORT' | 'NEUTRAL';
    },
  ): Promise<RecommendationSet> {
    const testnet = input.testnet === true;
    const market = await this.markets.getSpec(input.venue, input.symbol, testnet);
    const features = await this.features(input.venue, input.symbol, testnet, market);

    const vacio: RecommendationSet = {
      strategy: input.strategy,
      venue: input.venue,
      symbol: input.symbol,
      refPrice: '0',
      source: 'REGLAS',
      notice: null,
      market: null,
      profiles: [],
    };

    if (!features) {
      return {
        ...vacio,
        notice:
          'No hay suficiente histórico de este par para proponer una configuración. ' +
          'Puedes configurarlo a mano.',
      };
    }

    const limites = await this.limitesDe(userId);
    const ctx: BuildContext = {
      market,
      features,
      totalInvestment: Number(input.totalInvestment),
      maxLeverageUsuario: limites.maxLeverage,
      direction: input.direction ?? 'LONG',
    };

    // Decimal plano, nunca notacion exponencial. `String(4.182e-7)` devuelve
    // «4.182e-7», y ese texto viaja a la app, entra en `D()` y se compara con
    // precios escritos con todos sus ceros. Con los decimales del mercado se
    // queda en «0.00000042».
    const refPrice = features.mark.toFixed(Math.min(Math.max(market.priceDecimals, 0), 12));
    const profiles: RecommendedProfile[] = [];
    const descartes: Descarte[] = [];

    // Las perillas: del modelo si esta disponible, de las reglas si no. Las dos
    // ramas entran por la MISMA cadena de validacion, que es lo que convierte
    // «la IA no puede proponer algo peligroso» en estructura y no en confianza.
    const deIA = await this.knobsDeIA(userId, input.strategy, input.symbol, features);

    for (const profile of PROFILES) {
      const delModelo = deIA.knobs?.find((k) => k.knobs.profile === profile);
      const knobs = delModelo?.knobs ?? defaultKnobs(profile, features);
      const hecho = this.materialize(
        input.strategy,
        knobs,
        ctx,
        refPrice,
        delModelo ? 'IA' : 'REGLAS',
        limites,
        delModelo?.rationale,
      );
      if (typeof hecho !== 'string') {
        profiles.push(hecho);
        continue;
      }
      // Si lo que propuso el modelo no sobrevive, se reintenta UNA vez con las
      // reglas antes de rendirse: el usuario no tiene por que quedarse sin
      // perfil porque el modelo se pasara de agresivo.
      const respaldo = delModelo
        ? this.materialize(
            input.strategy,
            defaultKnobs(profile, features),
            ctx,
            refPrice,
            'REGLAS',
            limites,
          )
        : hecho;
      if (typeof respaldo === 'string') descartes.push(respaldo);
      else profiles.push(respaldo);
    }

    return {
      strategy: input.strategy,
      venue: input.venue,
      symbol: input.symbol,
      refPrice,
      source: this.sourceOf(profiles),
      notice: this.noticeFor(profiles.length, descartes, ctx, deIA.cupoAgotado),
      market: {
        atrPct1d: features.atrPct1d,
        rangePct30: features.rangePct30,
        trend: features.trend,
      },
      profiles,
    };
  }

  /**
   * La cadena completa: generar, recortar, reparar, validar y previsualizar.
   *
   * Devuelve el perfil, o el MOTIVO del descarte — que es lo que luego permite
   * decirle al usuario la causa real en vez de culpar siempre al capital.
   *
   * **No se reintenta**: se repara lo que es aritmetica entre parametros y se
   * descarta lo demas. Insistir sobre un validador que no converge es como se
   * llega al tiempo de espera del interceptor global.
   */
  private materialize(
    kind: StrategyKind,
    knobs: Knobs,
    ctx: BuildContext,
    refPrice: string,
    source: 'IA' | 'REGLAS',
    limites: RiskLimits,
    rationaleIA?: string,
  ): RecommendedProfile | Descarte {
    const strategy = getStrategy(kind);
    const fields = strategy.meta.fields;

    // 1. Partir de los valores por defecto de la estrategia, que el repo ya
    //    garantiza coherentes con el descriptor.
    const generado = buildConfig(kind, knobs, ctx);

    // 2. Recortar contra el descriptor. Manda el `FieldMeta`, no `validate()`:
    //    en varios campos el descriptor es mas estricto.
    let config = coerceConfig(fields, strategy.defaults(), generado);

    // 3. Imponer los acoplamientos que ninguna validacion deduce mirando un
    //    campo aislado. Se repara siempre hacia MENOS riesgo.
    config = enforceCouplings(kind, config, ctx.market, ctx.maxLeverageUsuario);

    // La cuenta y el par los pone el formulario; aqui solo se rellenan para que
    // `validate()` no falle por ausencia. La app los reafirma al aplicar.
    const paraValidar = {
      ...config,
      symbol: ctx.market.symbol,
      exchangeAccountId: 'preview',
    } as unknown as BotConfig;

    // 4. La validacion de la estrategia decide. Cualquier ERROR y se descarta.
    const validacion = strategy.validate(paraValidar, ctx.market);
    if (!validacion.ok) {
      this.logger.debug(
        `Descartado ${kind}/${knobs.profile}: ${validacion.issues
          .filter((i) => i.severity === 'ERROR')
          .map((i) => i.message)
          .join(' | ')}`,
      );
      return 'VALIDACION';
    }

    // 5. El preview es lo UNICO que detecta las violaciones de tick, paso y
    //    notional minimo del venue: sin el, una configuracion «valida» produce
    //    ordenes que el exchange rechaza una a una.
    let preview: PreviewResult;
    try {
      preview = strategy.preview(paraValidar, ctx.market, refPrice);
    } catch {
      return 'VALIDACION';
    }
    if (!preview.valid || preview.levels.some((l) => l.violations.length > 0)) {
      this.logger.debug(`Descartado ${kind}/${knobs.profile}: niveles con violaciones`);
      return 'VENUE';
    }

    // 6. Los topes del usuario, replicados. No se llama a `assertWithinLimits`
    //    a proposito: lanza excepcion, y aqui hay que FILTRAR, no romper la
    //    respuesta entera por un perfil que no cabe.
    if (!this.dentroDeLimites(config, preview, ctx, limites)) return 'LIMITES';

    return {
      profile: knobs.profile,
      source,
      config,
      headline: {
        leverage: Number(config['leverage'] ?? 1),
        worstCaseMargin: preview.worstCaseMargin,
        worstCaseNotional: preview.worstCaseNotional,
        liquidationDistancePct: preview.liquidationDistancePct,
        levels: preview.levels.length,
      },
      // Lo que dijo el modelo, si lo dijo; si no, la explicacion por reglas.
      rationale: rationaleIA?.trim() || this.rationale(knobs, ctx),
      warnings: validacion.issues.filter((i) => i.severity === 'WARNING').map((i) => i.message),
    };
  }

  /**
   * Las perillas del modelo, cacheadas por REGIMEN de mercado.
   *
   * La clave no lleva el capital ni el usuario, y no por descuido: el modelo no
   * ve ninguno de los dos. Solo ve rasgos normalizados del par, asi que una
   * llamada sirve a todo el que mire ese par con esa estrategia mientras el
   * mercado siga en el mismo regimen. Meter el capital en la clave la haria
   * practicamente unica por peticion, y cada peticion, una llamada pagada.
   *
   * La huella va CUANTIZADA en tramos gruesos por lo mismo: con los valores
   * crudos —dos decimales sobre un precio que se mueve— cada peticion generaria
   * una clave nueva. Es el patron que el modulo de mercado ya usa con el numero
   * de velas.
   */
  private async knobsDeIA(
    userId: string,
    strategy: StrategyKind,
    symbol: string,
    features: MarketFeatures,
  ): Promise<PerillasDeIA> {
    const sinIA: PerillasDeIA = { knobs: null, cupoAgotado: false };
    if (!this.modelo.available) return sinIA;

    // El cache va ANTES que el cupo, y es deliberado: una respuesta que ya esta
    // guardada no cuesta nada, asi que cobrarsela al usuario seria cobrarle por
    // algo que no se ha comprado.
    const clave = `advisor:knobs:v${PROMPT_VERSION}:${strategy}:${symbol}:${featuresBucket(features)}`;
    const cacheado = await this.cache
      .get<{ knobs: Knobs; rationale: string }[]>(clave)
      .catch(() => null);
    if (cacheado) return { knobs: cacheado, cupoAgotado: false };

    if (!(await this.consumeCupo(userId))) return { knobs: null, cupoAgotado: true };

    const fresco = await this.modelo.knobsFor(strategy, symbol, features);
    if (fresco) await this.cache.set(clave, fresco, KNOBS_TTL).catch(() => undefined);
    return { knobs: fresco, cupoAgotado: false };
  }

  /**
   * Apunta un uso y dice si cabia.
   *
   * Se incrementa ANTES de llamar y no despues de acertar. Contar solo los
   * exitos dejaria abierta la puerta obvia: veinte peticiones simultaneas
   * pasarian todas la comprobacion antes de que ninguna hubiera terminado, y el
   * tope de veinte se convertiria en un tope de veinte por cada rafaga.
   *
   * Si Redis no responde, `incrWithExpire` devuelve -1 y aqui se NIEGA el uso.
   * Es lo contrario de lo que hace el resto del cache —que degrada abriendo la
   * mano— y el motivo es que aqui lo que hay al otro lado es una factura: sin
   * contador no hay tope, y sin tope una caida de Redis se convierte en gasto
   * ilimitado. El usuario no se queda sin nada, se queda con las reglas.
   */
  private async consumeCupo(userId: string): Promise<boolean> {
    const crudo = (this.config.get<string>('AI_ADVISOR_DAILY_LIMIT', '') ?? '').toString().trim();

    // Vacio significa «sin configurar», NO cero.
    //
    // `Number('')` devuelve 0, no NaN. Sin esta distincion, un
    // `AI_ADVISOR_DAILY_LIMIT=` sin valor —el estado normal de un .env a medio
    // rellenar, y lo que deja `pnpm setup` si alguien borra el numero— apagaba el
    // asistente ENTERO en silencio: ni un aviso, ni una llamada, solo reglas para
    // siempre.
    let tope = crudo === '' ? DEFAULT_DAILY_LIMIT : Number(crudo);

    // Un valor que no es un numero se trata como ERRATA y no como orden: apagar
    // el asistente porque alguien escribio «veinte» seria de las averias mas
    // dificiles de encontrar, porque todo sigue funcionando, solo que peor. Un
    // cero o un negativo explicitos SI son una orden: apagar.
    if (!Number.isFinite(tope)) {
      this.logger.warn(
        `AI_ADVISOR_DAILY_LIMIT no es un número («${crudo}»): se usa ${DEFAULT_DAILY_LIMIT}.`,
      );
      tope = DEFAULT_DAILY_LIMIT;
    }
    if (tope <= 0) return false;

    // La fecha en UTC: con la del servidor, el contador se reiniciaria a una
    // hora distinta segun donde este desplegado.
    const dia = new Date().toISOString().slice(0, 10);
    const usados = await this.cache
      .incrWithExpire(`advisor:quota:${userId}:${dia}`, 86_400)
      .catch(() => -1);

    if (usados < 0) {
      this.logger.warn('No se ha podido contabilizar el cupo del asistente: se usan reglas.');
      return false;
    }
    return usados <= tope;
  }

  /** De donde salieron los perfiles que se devuelven. */
  private sourceOf(profiles: RecommendedProfile[]): 'IA' | 'REGLAS' | 'MIXTO' {
    const conIA = profiles.filter((p) => p.source === 'IA').length;
    if (conIA === 0) return 'REGLAS';
    return conIA === profiles.length ? 'IA' : 'MIXTO';
  }

  /**
   * Los topes del usuario y el del capital, sin lanzar.
   *
   * Se replica `assertWithinLimits` en vez de llamarla porque aquella lanza
   * `ForbiddenException`: aqui hay que FILTRAR un perfil, no romper la respuesta
   * entera. Estaban solo dos de los cuatro topes, asi que una recomendacion
   * podia devolverse y morir con un 403 al crear el bot.
   */
  private dentroDeLimites(
    config: Record<string, unknown>,
    preview: PreviewResult,
    ctx: BuildContext,
    limites: RiskLimits,
  ): boolean {
    const lev = Number(config['leverage'] ?? 1);
    if (limites.maxLeverage != null && lev > limites.maxLeverage) return false;

    // La distancia a liquidacion, con la misma cuenta que hace el servidor.
    if (100 / lev - 0.5 < 5) return false;

    const notional = ctx.totalInvestment * lev;
    if (limites.maxNotionalPerBot != null && notional > limites.maxNotionalPerBot) return false;
    if (
      limites.maxTotalNotional != null &&
      limites.notionalActual + notional > limites.maxTotalNotional
    ) {
      return false;
    }

    // Y el tope que no esta en ninguna tabla: el margen del peor caso no puede
    // superar lo que el usuario ha puesto. `validate()` y `preview()` miran el
    // venue, no la cartera, asi que una configuracion que pide 120 de margen con
    // 50 de capital pasa las dos y solo se detecta aqui.
    const margen = Number(preview.worstCaseMargin);
    if (Number.isFinite(margen) && margen > ctx.totalInvestment * 1.02) return false;

    return true;
  }

  private async limitesDe(userId: string): Promise<RiskLimits> {
    try {
      const [l, actual] = await Promise.all([
        this.risk.get(userId),
        this.risk.currentTotalNotional(userId).catch(() => null),
      ]);
      return {
        maxLeverage: l.max_leverage ?? null,
        maxNotionalPerBot: l.max_notional_per_bot ? Number(l.max_notional_per_bot) : null,
        maxTotalNotional: l.max_total_notional ? Number(l.max_total_notional) : null,
        notionalActual: actual ? Number(actual) : 0,
      };
    } catch {
      // Sin limites legibles se sigue con los topes duros del sistema, que ya
      // son mas estrictos que el descriptor.
      return {
        maxLeverage: null,
        maxNotionalPerBot: null,
        maxTotalNotional: null,
        notionalActual: 0,
      };
    }
  }

  /** Una linea explicando la decision, en el idioma de la app. */
  private rationale(knobs: Knobs, ctx: BuildContext): string {
    const f = ctx.features;
    const mercado =
      f.trend === 'LATERAL' ? 'El par se mueve de lado' : `El par viene ${f.trend.toLowerCase()}`;
    const movimiento = `con un recorrido diario del ${f.atrPct1d} %`;
    switch (knobs.profile) {
      case 'PRUDENTE':
        return `${mercado} ${movimiento}. Apalancamiento bajo y más margen de caída cubierto: menos beneficio por ciclo a cambio de aguantar más.`;
      case 'AGRESIVA':
        return `${mercado} ${movimiento}. Más apalancamiento y ciclos más cortos: más operaciones y menos colchón antes de la liquidación.`;
      default:
        return `${mercado} ${movimiento}. Reparto intermedio entre cuánto aguanta y cuánto captura por ciclo.`;
    }
  }

  /**
   * Por que faltan perfiles, DICIENDO LA CAUSA REAL.
   *
   * Antes esto culpaba siempre al capital y al minimo del venue, incluso cuando
   * lo que habia fallado eran los topes de riesgo del propio usuario. Mandar a
   * alguien a subir el capital cuando su problema es su limite de notional es
   * peor que no decir nada.
   */
  private noticeFor(
    cuantos: number,
    descartes: Descarte[],
    ctx: BuildContext,
    cupoAgotado = false,
  ): string | null {
    // Se dice SIEMPRE que se ha agotado, aunque las tres configuraciones hayan
    // salido bien. Son perfectamente utiles, pero no son las mismas que salieron
    // ayer, y callarselo hace que la funcion parezca haber empeorado sola.
    const cupo = cupoAgotado
      ? 'Has agotado los usos del asistente por hoy: estas configuraciones están ' +
        'calculadas por reglas. Se renueva mañana.'
      : null;

    if (cuantos === 3) return cupo;

    const cuenta = (d: Descarte) => descartes.filter((x) => x === d).length;
    const dominante: Descarte =
      cuenta('LIMITES') >= cuenta('VENUE') && cuenta('LIMITES') >= cuenta('VALIDACION')
        ? 'LIMITES'
        : cuenta('VENUE') >= cuenta('VALIDACION')
          ? 'VENUE'
          : 'VALIDACION';

    const motivo =
      dominante === 'LIMITES'
        ? 'no caben dentro de tus límites de riesgo. Puedes revisarlos en Cuenta › Límites de riesgo'
        : dominante === 'VENUE'
          ? `no llegan al mínimo por orden del exchange (${ctx.market.minNotional ?? '—'}). ` +
            'Prueba con más capital o con otro par'
          : 'no salen coherentes para esta estrategia en este par';

    const falta =
      cuantos === 0
        ? `No se ha podido proponer ninguna configuración: ${motivo}.`
        : `Falta${3 - cuantos === 1 ? '' : 'n'} ${3 - cuantos} configuración${3 - cuantos === 1 ? '' : 'es'}: ${motivo}.`;

    return cupo ? `${cupo} ${falta}` : falta;
  }

  /**
   * Rasgos del mercado. Sin velas suficientes devuelve `null` y el bloque se
   * apaga con un motivo: es preferible a inventar una recomendacion sobre datos
   * a medias.
   */
  private async features(
    venue: Venue,
    symbol: string,
    testnet: boolean,
    market: MarketSpec,
  ): Promise<MarketFeatures | null> {
    try {
      const [velas1h, velas1d, tickers] = await Promise.all([
        this.marketData.candles(venue, symbol, '1h', {
          limit: BARS_1H,
          testnet,
        }),
        this.marketData
          .candles(venue, symbol, '1d', { limit: BARS_1D, testnet })
          .catch((): Candle[] => []),
        // Sin ticker se cae al ultimo cierre: es un precio peor pero real, y
        // mejor que no poder recomendar nada.
        this.marketData.tickers(venue, testnet).catch((): MarketTicker[] => []),
      ]);
      const ticker = tickers.find((t) => t.symbol === symbol);
      const mark = ticker?.last ?? velas1h[velas1h.length - 1]?.c ?? '0';
      return buildFeatures(velas1h, velas1d, market, mark);
    } catch (e) {
      this.logger.debug(`Sin rasgos de mercado para ${venue}:${symbol}: ${String(e)}`);
      return null;
    }
  }
}

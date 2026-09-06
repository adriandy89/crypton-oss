import {
  Component,
  type OnDestroy,
  type OnInit,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import {
  IonBackButton,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonInput,
  IonSelect,
  IonSelectOption,
  IonSpinner,
  IonToggle,
  IonTitle,
  IonToolbar,
} from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import {
  alertCircleOutline,
  chevronDownOutline,
  linkOutline,
  refreshOutline,
  warningOutline,
} from 'ionicons/icons';
import type { BotConfig, FieldMeta, PreviewResult } from '@crypton/shared';
import { getStrategy } from '@crypton/strategy-core';
import {
  AdvisorService,
  BotsService,
  ExchangeAccountsService,
  MarketDataService,
  MarketsService,
  NetworkService,
  RiskService,
  ToastService,
  WalletService,
} from '../../core/services';
import type {
  ExchangeAccount,
  Market,
  RecommendationSet,
  RecommendedProfile,
  StrategyDescriptor,
  StrategyKind,
} from '../../core/models';
import {
  errorText,
  fieldLabel,
  groupLabel,
  isMarketMaker,
  money,
  parseHttpError,
  pct,
  price,
  qty,
  strategyBlurb,
  strategyLabel,
  toMarketSpec,
  textoDeConfig,
} from '../../core/utils';
import {
  UiAmountFieldComponent,
  UiBadgeComponent,
  UiCapitalHeaderComponent,
  UiCardComponent,
  UiCollapsibleComponent,
  UiEmptyStateComponent,
  UiFieldComponent,
  UiNoticeComponent,
  UiPairSheetComponent,
  UiQuotePreviewComponent,
  UiRecommendationsComponent,
  UiRiskMeterComponent,
  UiStrategyHelpComponent,
} from '../../shared/ui';

/**
 * Clave del campo de capital.
 *
 * Se saca del bucle generico de `ui-field` para pintarlo con
 * `<ui-amount-field>`, que es el unico control que sabe de saldo. Es la UNICA
 * excepcion, y va como constante para que se vea que lo es.
 */
const CAPITAL_FIELD = 'totalInvestment';

/** Cada cuanto se repesca el saldo mientras se esta en «Parámetros». */
const WALLET_POLL_MS = 30_000;

/**
 * Un tope de riesgo en numero, o `null` si el usuario no puso ninguno.
 *
 * Existe por un fallo concreto: `Number(null)` en JavaScript devuelve **0**, no
 * `NaN`. Aqui se comprobaba con `Number.isFinite()`, que da `true` para el cero,
 * asi que «sin limite» se convertia en «limite de cero» y CUALQUIER bot lo
 * superaba. El botón de crear quedaba apagado con un mensaje que decia «tu
 * limite por bot (0,00)» mientras la pantalla de limites decia «sin limite» —y
 * le pasaba a todo usuario que no los hubiera configurado a mano, que es el caso
 * normal.
 *
 * El servidor nunca habria devuelto ese 403: comprueba con `!= null`. Era la app
 * bloqueando por una regla que se inventaba ella sola.
 */
const topeOno = (v: string | null): number | null => {
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

type Step = 'venue' | 'strategy' | 'params' | 'preview';

@Component({
  selector: 'app-bot-create',
  standalone: true,
  imports: [
    FormsModule,
    RouterLink,
    IonHeader,
    IonToolbar,
    IonTitle,
    IonButtons,
    IonBackButton,
    IonButton,
    IonIcon,
    IonContent,
    IonSpinner,
    IonInput,
    IonSelect,
    IonSelectOption,
    IonToggle,
    UiAmountFieldComponent,
    UiBadgeComponent,
    UiCapitalHeaderComponent,
    UiCardComponent,
    UiCollapsibleComponent,
    UiEmptyStateComponent,
    UiFieldComponent,
    UiNoticeComponent,
    UiPairSheetComponent,
    UiQuotePreviewComponent,
    UiRecommendationsComponent,
    UiRiskMeterComponent,
    UiStrategyHelpComponent,
  ],
  templateUrl: './bot-create.page.html',
  styleUrl: './bot-create.page.scss',
})
export class BotCreatePage implements OnInit, OnDestroy {
  private readonly bots = inject(BotsService);
  private readonly accountsSvc = inject(ExchangeAccountsService);
  private readonly network = inject(NetworkService);
  /** La red que se esta mirando. Ver `accounts`. */
  private readonly testnet = this.network.testnet;
  private readonly marketsSvc = inject(MarketsService);
  private readonly md = inject(MarketDataService);
  private readonly wallet = inject(WalletService);
  private readonly riskSvc = inject(RiskService);
  private readonly advisor = inject(AdvisorService);
  private readonly toast = inject(ToastService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  readonly step = signal<Step>('venue');

  /**
   * Conexiones utilizables, leídas EN VIVO del servicio.
   *
   * No es una copia local a propósito: al volver de conectar un exchange, Ionic
   * restaura ESTA misma instancia desde su pila sin volver a ejecutar
   * `ngOnInit`, y una copia hecha allí dejaría el paso 1 diciendo «no tienes
   * ninguna» justo después de que el usuario acabara de crear una.
   *
   * El filtro es el mismo que aplica la API: `POST /bots/preview` responde 403
   * si la cuenta no está verificada, así que ofrecer aquí una que no lo esté
   * sería ofrecer un callejón sin salida.
   *
   * Y se filtra por la RED que se está mirando. No es cosmético: los mercados
   * que se ofrecen abajo salen del catálogo de esa red, así que mezclar cuentas
   * de las dos dejaría elegir una cuenta de mainnet y un par que solo existe en
   * testnet — y el error saldría al final, al crear el bot.
   */
  readonly accounts = computed<ExchangeAccount[]>(() =>
    this.accountsSvc.accounts().filter(
      (a) =>
        ['VERIFIED', 'ACTIVE'].includes(a.status) &&
        // La de SIMULACION se ofrece siempre. Es de mainnet por construccion
        // —simular sobre el libro de una testnet no dice gran cosa—, asi que
        // el filtro de red la habria escondido justo con la lente puesta en
        // testnet, que es cuando mas se esta probando.
        (a.paper || a.testnet === this.testnet()),
    ),
  );

  /** La conexion de simulacion elegida, si lo es. Null cuando se opera de verdad. */
  readonly paperAccount = computed(() => (this.account()?.paper ? this.account() : null));

  /**
   * Conectó un exchange en esta red, pero su credencial ya no verifica.
   *
   * Solo mira las REALES. Antes se apoyaba en que la lista de cuentas ofrecidas
   * se quedara vacía, y eso dejó de pasar en cuanto la conexión de simulación
   * existe siempre: el aviso se volvió inalcanzable y quien tenía la credencial
   * revocada se encontraba un desplegable con «Simulación» dentro y ninguna
   * explicación de por qué había desaparecido lo suyo.
   */
  readonly conexionesRotas = computed(() => {
    const enEstaRed = this.accountsSvc
      .accounts()
      .filter((a) => !a.paper && a.testnet === this.testnet());
    return (
      enEstaRed.length > 0 && !enEstaRed.some((a) => ['VERIFIED', 'ACTIVE'].includes(a.status))
    );
  });

  readonly markets = signal<Market[]>([]);
  /** ¿Está abierta la hoja de elegir par? La hoja no guarda nada más. */
  readonly pairOpen = signal(false);
  readonly strategies = signal<StrategyDescriptor[]>([]);
  readonly preview = signal<PreviewResult | null>(null);
  readonly busy = signal(false);
  readonly previewing = signal(false);
  /** Nombre del bot original, si se llegó aquí desde el ranking. */
  readonly copiedFrom = signal<string | null>(null);

  /**
   * SEÑALES, no campos sueltos. Mismo motivo que se explica abajo para
   * `strategyKind`, y aqui costaba un bug visible: `canCreate()` es un
   * `computed` que lee el nombre, y un `computed` no vuelve a evaluarse porque
   * cambie una propiedad normal. Escribir el nombre del bot no despertaba
   * nada, asi que «Crear bot» se quedaba apagado con el formulario relleno y
   * sin decir por que.
   *
   * Lo mismo valia para `symbol`: `market()` y la validacion en linea cuelgan
   * de el.
   */
  readonly name = signal('');
  readonly accountId = signal('');
  readonly symbol = signal('');
  /**
   * Estrategia elegida. Es una SEÑAL y no un campo suelto: `strategy()`,
   * `fields()` y los grupos del formulario se derivan de aquí con `computed`,
   * y un `computed` que lee una propiedad normal la captura la primera vez y no
   * la vuelve a mirar. Con el campo plano, volver atrás y elegir otra
   * estrategia seguía pintando los parámetros de la primera.
   */
  readonly strategyKind = signal<StrategyKind | ''>('');
  // Arranca en simulación a propósito: es el valor por defecto que evita el
  // error más caro, que es estrenarse con dinero real sin querer.
  //
  // Con una conexión de simulación elegida deja de ser una preferencia y pasa a
  // ser un hecho: esa conexión no tiene claves y no puede firmar nada. Quien
  // manda entonces es `simulando()`, no este campo.
  dryRun = true;
  startActive = true;

  readonly config = signal<Record<string, unknown>>({});

  // ── Configuraciones sugeridas ──
  readonly recommendations = signal<RecommendationSet | null>(null);
  readonly recoLoading = signal(false);
  readonly recoError = signal<string | null>(null);
  /** Perfil aplicado. Se limpia en cuanto el usuario toca un campo. */
  readonly appliedProfile = signal<string | null>(null);

  /** Con capital escrito ya se puede proponer algo con sentido. */
  readonly hasCapital = computed(() => Number(this.config()[CAPITAL_FIELD] ?? 0) > 0);

  /**
   * El precio se ha movido bastante desde que se calcularon las sugerencias.
   *
   * Importa de verdad en las rejillas: llevan `lowerPrice` y `upperPrice`
   * ABSOLUTOS, y un rango calculado hace veinte minutos puede haber quedado
   * entero por debajo del mercado. El servidor devuelve `refPrice` justo para
   * esto, y hasta ahora no lo leia nadie.
   */
  readonly recoStale = computed(() => {
    const set = this.recommendations();
    const ahora = Number(this.mark() ?? 0);
    const entonces = Number(set?.refPrice ?? 0);
    if (!set || !(ahora > 0) || !(entonces > 0)) return false;
    return Math.abs((ahora - entonces) / entonces) * 100 > 1.5;
  });

  /**
   * Identidad de la recomendacion: plataforma, red, par y estrategia.
   *
   * Existe por el riesgo que motiva toda esta funcion: NADA en esta pantalla
   * reinicia `config` al cambiar de par. Se puede volver al paso 1, elegir otro
   * simbolo y seguir con los valores del anterior. Mientras los escribe el
   * usuario uno a uno apenas se nota; en cuanto un boton escribe veinte de
   * golpe, una configuracion calculada para ETH puede acabar aplicada sobre un
   * par que cotiza tres ordenes de magnitud mas abajo.
   *
   * Con esta clave la recomendacion muere sola, y a la vista, en cuanto cambia
   * cualquiera de los cuatro.
   */
  readonly recoKey = computed(() => {
    const cuenta = this.account();
    const par = this.symbol();
    const kind = this.strategyKind();
    if (!cuenta || !par || !kind) return '';
    // El CAPITAL entra en la clave. Las configuraciones se calcularon para una
    // cantidad concreta —los tamaños por orden y los topes salen de ella—, asi
    // que con otra cifra dejan de valer. Y sin esto pasaba algo peor que
    // enseñarlas viejas: aplicarlas devolvia el capital al valor con el que se
    // pidieron, deshaciendo en silencio lo que el usuario acababa de escribir.
    const capital = textoDeConfig(this.config()[CAPITAL_FIELD]);
    return `${cuenta.venue}|${cuenta.testnet}|${par}|${kind}|${capital}`;
  });
  readonly money = money;
  // Los tres formateadores de la escalera. La revision pintaba precio,
  // cantidad y distancia CRUDOS de la API —punto decimal ingles y hasta
  // dieciocho decimales— diez pixeles por encima de cifras que si pasaban por
  // `money()`, justo en la pantalla donde se decide poner dinero (spec 002, F-06).
  readonly price = price;
  readonly qty = qty;
  readonly pct = pct;

  readonly account = computed(() => this.accounts().find((a) => a.id === this.accountId()));

  /**
   * Si este bot va a simular. Es lo que se manda al servidor.
   *
   * Con una conexion de SIMULACION no es una preferencia: esa conexion no tiene
   * claves y el servidor rechaza un `dryRun: false` sobre ella. Se resuelve
   * aqui para que la pantalla y lo que se envia digan lo mismo, y no haya que
   * acordarse de mirar las dos cosas en cada sitio.
   *
   * Metodo y no `computed`: `dryRun` es un campo de formulario con `ngModel`,
   * no una señal, asi que un computed no se recalcularia al moverlo.
   */
  simulando(): boolean {
    return this.paperAccount() !== null || this.dryRun;
  }
  readonly strategy = computed(() => this.strategies().find((s) => s.kind === this.strategyKind()));

  // ═══════════════════════════════════════════════════════════════
  // Saldo real y precio en vivo
  // ═══════════════════════════════════════════════════════════════

  readonly capital = computed(() => this.wallet.balances().get(this.accountId()) ?? null);

  /** Margen libre de la cuenta. `null` = no se pudo leer: se degrada, no se bloquea. */
  readonly available = computed(() => this.capital()?.available ?? null);

  /**
   * El dinero que esta en el otro bolsillo del venue. '' = nada que decir.
   *
   * Hyperliquid separa spot de perpetuos y solo el segundo respalda posiciones,
   * asi que se puede llegar a este paso con el deposito hecho y un saldo
   * operable de cero. El campo de capital se queda entonces topado en cero sin
   * ninguna causa visible (spec 028).
   */
  readonly spotAviso = computed(() => {
    const spot = this.capital()?.spot;
    if (!spot || spot === '0') return '';
    return (
      `Tienes ${money(spot)} ${this.capital()?.asset ?? 'USDC'} en la cuenta de spot del ` +
      'exchange, que no respalda posiciones. Transfierelos a perpetuos para poder usarlos aqui.'
    );
  });

  /**
   * Ultimo precio del par, como STRING.
   *
   * Es el ultimo negociado que trae el ticker: la app no recibe la marca en
   * lote. La vista previa del servidor recibe este mismo numero como
   * `refPrice`, asi que panel y servidor calculan la escalera sobre el mismo
   * precio; solo al CREAR el bot toma el servidor la marca del venue (001/F-66).
   *
   * Que devuelva el string y no el objeto del ticker es deliberado y es lo que
   * hace viable el panel en vivo: `tickerOf()` construye un objeto nuevo en
   * cada volcado —cinco por segundo— y un `computed` que lo leyera recalcularia
   * la escalera entera a ese ritmo. Las señales deduplican con `Object.is`, asi
   * que con el string solo se recalcula cuando el precio cambia de verdad.
   */
  readonly mark = computed<string | null>(() => {
    const account = this.account();
    const symbol = this.symbol();
    if (!account || !symbol) return null;
    return this.md.tickerOf(account.venue, symbol)?.last ?? null;
  });

  readonly changePct = computed<number | null>(() => {
    const account = this.account();
    const symbol = this.symbol();
    if (!account || !symbol) return null;
    const raw = Number(this.md.tickerOf(account.venue, symbol)?.changePct24h);
    return Number.isFinite(raw) ? raw : null;
  });

  readonly pairLabel = computed(() => this.market()?.canonical ?? this.symbol());

  /** Campos ordenados: primero lo estructural, luego el resto. */
  readonly fields = computed<FieldMeta[]>(() => {
    const all = this.strategy()?.fields ?? [];
    // Cuenta y par se eligen en pasos anteriores; repetirlos aquí confundiría.
    return this.capFields(all.filter((f) => f.key !== 'exchangeAccountId' && f.key !== 'symbol'));
  });

  /** El descriptor del capital, que se pinta aparte con `<ui-amount-field>`. */
  readonly capitalField = computed(() => this.fields().find((f) => f.key === CAPITAL_FIELD));

  /**
   * Reescribe los topes del descriptor con los del MERCADO.
   *
   * `COMMON_FIELDS` clava `leverage` en `max: 50` porque no puede saber en qué
   * par se va a operar, pero el tope real es `market.max_leverage` y ya venía
   * en el catálogo: se cargaba en cada petición y no lo leía nadie. Se toca el
   * `FieldMeta` y no `ui-field`, que ya sabe pintar `min`/`max` y generar la
   * pista de rango — así el «max 50» pasa a decir la verdad sin tocar el
   * componente que comparten cuatro pantallas más.
   */
  private capFields(fields: FieldMeta[]): FieldMeta[] {
    const market = this.market();
    if (!market) return fields;
    return fields.map((f) =>
      f.key === 'leverage'
        ? { ...f, max: Math.min(f.max ?? market.max_leverage, market.max_leverage) }
        : f,
    );
  }

  /**
   * Los campos que se ven de entrada, agrupados por sección.
   *
   * Agrupar y plegar no es cosmética: el market maker V2 declara treinta y
   * cuatro parámetros, y en una lista plana los cinco que casi todo el mundo
   * toca quedan enterrados entre los veintinueve que casi nadie cambia. El
   * descriptor ya dice a qué sección pertenece cada uno y cuál es avanzado; lo
   * único que faltaba era hacerle caso.
   */
  readonly basicGroups = computed(() => this.groupsOf(false));
  readonly advancedGroups = computed(() => this.groupsOf(true));

  readonly advancedCount = computed(() =>
    this.advancedGroups().reduce((n, g) => n + g.fields.length, 0),
  );

  /** La vista previa de cotización solo dice algo en un market maker. */
  readonly showQuotePreview = computed(() => {
    const kind = this.strategyKind();
    return !!kind && isMarketMaker(kind);
  });

  private groupsOf(advanced: boolean): { key: string; title: string; fields: FieldMeta[] }[] {
    const wanted = this.fields().filter((f) => (f.advanced ?? false) === advanced);
    const order = [
      'core',
      'quoting',
      'risk',
      'timing',
      'levels',
      'dynamicSpread',
      'priceSource',
      'activation',
      'venue',
    ];

    const buckets = new Map<string, FieldMeta[]>();
    for (const f of wanted) {
      const key = f.group ?? 'core';
      const list = buckets.get(key);
      if (list) list.push(f);
      else buckets.set(key, [f]);
    }

    // Dentro de cada grupo manda `order` si lo trae; si no, el orden en que la
    // estrategia declaró sus campos, que ya es deliberado.
    for (const list of buckets.values()) {
      list.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    }

    return [...buckets.entries()]
      .sort((a, b) => {
        const ia = order.indexOf(a[0]);
        const ib = order.indexOf(b[0]);
        return (ia < 0 ? order.length : ia) - (ib < 0 ? order.length : ib);
      })
      .map(([key, fields]) => ({ key, title: groupLabel(key), fields }));
  }

  groupTitle(key: string): string {
    return groupLabel(key);
  }

  // ═══════════════════════════════════════════════════════════════
  // Validacion EN LA APP, con el mismo codigo que corre el servidor
  //
  // `@crypton/strategy-core` se consume como fuente (ver los `paths` de
  // `tsconfig.json`), asi que esto no es una segunda implementacion de las
  // reglas: es literalmente la funcion que ejecuta la API en `create()`. Lo
  // que se gana es decir lo que falla ANTES de mandar nada, en vez de pintar
  // un toast con el error que vuelve del servidor.
  // ═══════════════════════════════════════════════════════════════

  /** El mercado elegido, resuelto del catalogo ya cargado. */
  readonly market = computed(() => this.markets().find((m) => m.symbol === this.symbol()));
  /**
   * Decimales del mercado para la escalera de la revisión. Sin ellos `price()`
   * redondea por magnitud y dos niveles contiguos de un par de precio muy bajo
   * salen idénticos en la pantalla donde se decide poner dinero.
   */
  readonly decimales = computed(() => this.market()?.price_decimals ?? null);
  readonly decimalesQty = computed(() => this.market()?.qty_decimals ?? null);

  /** Por que no se puede pasar del paso 1. Cadena vacia = se puede. */
  readonly venueBlockedReason = computed<string>(() => {
    if (!this.accountId()) return 'Elige la conexión de exchange con la que va a operar.';
    if (!this.symbol()) return 'Elige el par sobre el que va a operar.';
    return '';
  });

  /**
   * Obligatorios sin rellenar, segun el descriptor de ESTA estrategia.
   *
   * Generico a proposito: sale de `FieldMeta.required`, que las siete
   * estrategias ya declaran. No hay —ni puede haber— una lista por tipo de bot
   * escrita aqui, porque entonces una estrategia nueva llegaria sin validar.
   */
  readonly missingRequired = computed<FieldMeta[]>(() =>
    this.fields()
      .filter((f) => f.required)
      .filter((f) => {
        const v = this.config()[f.key];
        return v === undefined || v === null || v === '';
      }),
  );

  /**
   * La config COMPLETA, tal y como la ven `validate()` y `preview()`.
   *
   * `config` NO lleva ni la cuenta ni el par: se eligen en el paso «Cuenta» y
   * viven en sus propias señales, y `selectStrategy()` reescribe `config` con
   * los `defaults()` de la estrategia, que nunca los traen. Los tres sitios que
   * llamaban al motor tenian que acordarse de anadirlos, y los tres se
   * acordaban solo del par: `validateCommon()` respondia «Falta la conexion de
   * exchange» sobre un campo que esta pantalla no pinta, y «Calcular la
   * escalera» no podia encenderse en NINGUNA de las siete estrategias.
   *
   * Por eso es UNA funcion y no tres literales: el cuarto consumidor la hereda
   * en vez de reintroducir el fallo. Es ademas la misma forma que arma el
   * servidor antes de validar, y `POST /bots/preview` valida el `config` que
   * recibe TAL CUAL, sin fusionarle nada.
   *
   * La cuenta sale de `account()` y no de `accountId()` porque es la que se va
   * a mandar: `runPreview()` y `create()` abortan si es `undefined`. Si el id
   * elegido deja de estar en la lista utilizable —otra red, credencial caida—,
   * el boton se apaga diciendolo, en vez de encenderse para no hacer nada.
   */
  private fullConfig(): BotConfig {
    return {
      ...this.config(),
      exchangeAccountId: this.account()?.id,
      symbol: this.symbol(),
    } as unknown as BotConfig;
  }

  /**
   * Errores por campo, ya en castellano.
   *
   * Solo los de severidad ERROR: los WARNING son advertencias legitimas —un
   * apalancamiento alto, una escalera corta— y bloquear por ellas impediria
   * configuraciones que el servidor acepta sin rechistar.
   */
  readonly issuesByField = computed<Map<string, string>>(() => {
    const out = new Map<string, string>();
    const kind = this.strategyKind();
    const market = this.market();
    if (!kind || !market) return out;

    // `validate()` es puro y defensivo, pero la config viene de un formulario a
    // medio escribir: si algun dia una rama se saltara una guarda, es preferible
    // quedarse sin marcas en linea que tumbar la pantalla entera.
    try {
      const result = getStrategy(kind).validate(this.fullConfig(), toMarketSpec(market));
      for (const issue of result.issues) {
        if (issue.severity !== 'ERROR' || !issue.field) continue;
        if (!out.has(issue.field)) out.set(issue.field, issue.message);
      }
    } catch {
      return new Map();
    }
    return out;
  });

  /**
   * Errores que apuntan a un campo que esta pantalla NO pinta.
   *
   * `fields()` quita la cuenta y el par a proposito —se eligen en el paso
   * «Cuenta»—, asi que un ERROR sobre ellos no tiene donde pintarse:
   * `errorFor()` no llega a llamarse nunca para esas claves y el mensaje se
   * quedaba suelto debajo de un boton apagado, hablando de algo que no se ve
   * aqui y no se puede tocar desde aqui.
   *
   * Se deriva de `fields()` y no de una lista con las dos claves de hoy para
   * que un campo excluido manana entre solo.
   */
  readonly offStepIssues = computed<{ key: string; message: string }[]>(() => {
    const visibles = new Set(this.fields().map((f) => f.key));
    return [...this.issuesByField()]
      .filter(([key]) => !visibles.has(key))
      .map(([key, message]) => ({ key, message }));
  });

  /** Avisos que NO bloquean, para pintarlos sin matar el boton. */
  readonly warnings = computed<string[]>(() => {
    const kind = this.strategyKind();
    const market = this.market();
    if (!kind || !market || this.missingRequired().length > 0) return [];
    try {
      return getStrategy(kind)
        .validate(this.fullConfig(), toMarketSpec(market))
        .issues.filter((i) => i.severity === 'WARNING')
        .map((i) => i.message);
    } catch {
      return [];
    }
  });

  /**
   * La escalera calculada AQUI, con `strategy.preview()`.
   *
   * Es la misma funcion pura que ejecuta el motor —la app consume
   * `@crypton/strategy-core` como fuente—, no una reimplementacion. Por eso el
   * peor caso que se ve mientras se teclea coincide con el del paso «Revisión»,
   * que sigue viniendo del servidor y sigue siendo el que autoriza.
   *
   * El `try/catch` se queda aunque `preview()` ya no lance con config invalida:
   * `ui-field` emite el valor crudo del input en cada pulsacion, y prefiero un
   * panel atenuado a la pantalla entera caida mientras alguien escribe.
   */
  readonly livePreview = computed<PreviewResult | null>(() => {
    const kind = this.strategyKind();
    const market = this.market();
    const ref = this.mark();
    if (!kind || !market || !ref) return null;
    try {
      return getStrategy(kind).preview(this.fullConfig(), toMarketSpec(market), ref);
    } catch {
      return null;
    }
  });

  /** Por que el panel de riesgo no puede enseñar nada todavia. */
  readonly riskEmptyText = computed(() => {
    if (!this.mark()) return 'Esperando el precio del par para calcular el riesgo.';
    if (this.missingRequired().length > 0) {
      return 'Rellena los campos obligatorios para ver la exposición y la liquidación.';
    }
    return 'Ajusta los parámetros para ver el riesgo.';
  });

  /**
   * Los MISMOS topes que producen el 403 de `assertWithinLimits`, avisados aqui.
   *
   * Se replican las cuatro comprobaciones del servidor y ni una mas: una regla
   * de sobra seria bloquear al usuario por una invencion de la app, y una de
   * menos devolveria el 403 sorpresa al final del formulario. Los numeros
   * tampoco se recalculan — vienen de `/bots/capital`, que los saca de
   * `RiskService`.
   *
   * Los cuatro topes se leen con la MISMA forma: `!== null` primero, convertir
   * despues. Ver `topeOno`, arriba, para lo que pasaba cuando no era asi.
   */
  readonly limitIssues = computed<{ message: string; severity: 'ERROR' | 'WARNING' }[]>(() => {
    const out: { message: string; severity: 'ERROR' | 'WARNING' }[] = [];
    const snapshot = this.capital();
    const leverage = Number(this.config()['leverage']);
    const investment = Number(this.config()[CAPITAL_FIELD]);
    if (!snapshot || !Number.isFinite(leverage) || !Number.isFinite(investment)) return out;

    const notional = investment * leverage;
    const limits = snapshot.limits;

    if (limits.maxLeverage !== null && leverage > limits.maxLeverage) {
      out.push({
        message: `Tu límite de apalancamiento es ${limits.maxLeverage}× y has pedido ${leverage}×.`,
        severity: 'ERROR',
      });
    }

    const perBot = topeOno(limits.maxNotionalPerBot);
    if (perBot !== null && notional > perBot) {
      out.push({
        message:
          `El bot movería ${money(notional)} (${money(investment)} de capital × ${leverage} de ` +
          `apalancamiento), por encima de tu límite por bot de ${money(perBot)}. ` +
          `Puedes cambiarlo en Cuenta › Límites de riesgo.`,
        severity: 'ERROR',
      });
    }

    const total = topeOno(limits.maxTotalNotional);
    if (total !== null) {
      const enMarcha = Number(limits.currentTotalNotional) || 0;
      const projected = enMarcha + notional;
      if (projected > total) {
        out.push({
          message:
            `Con este bot llegarías a ${money(projected)} en total entre todos tus bots, por ` +
            `encima de tu límite de ${money(total)}. Ahora mismo tienes ${money(enMarcha)} en marcha.`,
          severity: 'ERROR',
        });
      }
    }

    // La misma cota que aplica el servidor: por debajo del 5 % de distancia a
    // liquidacion, rechaza. Se calcula igual —sobre precio unidad—, asi que es
    // puramente una funcion del apalancamiento.
    if (leverage > 0) {
      const distance = (1 / leverage - 0.005) * 100;
      if (distance < 5) {
        out.push({
          message: `A ${leverage}× la liquidación llega con un movimiento adverso de solo ${distance.toFixed(1)} %. Baja el apalancamiento.`,
          severity: 'ERROR',
        });
      }
    }

    return out;
  });

  readonly limitErrors = computed(() => this.limitIssues().filter((i) => i.severity === 'ERROR'));

  errorFor(key: string): string {
    // Un obligatorio vacio se explica como tal y no con el mensaje generico del
    // validador («debe ser mayor que cero» cuando no hay nada escrito confunde).
    if (this.missingRequired().some((f) => f.key === key)) return 'Falta rellenar este campo.';
    return this.issuesByField().get(key) ?? '';
  }

  /**
   * Nombre visible de un campo por su clave, mirando el descriptor ENTERO.
   *
   * No sirve `fields()`: justamente se usa para los campos que ese filtro quita.
   */
  private labelOf(key: string): string {
    const f = this.strategy()?.fields.find((x) => x.key === key);
    return f ? fieldLabel(f) : key;
  }

  /**
   * Por que no se puede calcular la escalera. Cadena vacia = se puede.
   *
   * Devuelve TEXTO y no un booleano justamente porque el problema que arregla
   * es un boton apagado sin explicacion: quien lo llama esta obligado a tener
   * algo que escribir debajo.
   */
  readonly paramsBlockedReason = computed<string>(() => {
    // PRIMERO lo que AQUI no tiene arreglo. Un ERROR sobre un campo que esta
    // pantalla no pinta es un callejon sin salida: se puede rellenar el
    // formulario entero y seguir con el boton apagado, y el mensaje crudo del
    // validador no dice donde se arregla. Va delante de los obligatorios para
    // no mandar a rellenarlo todo y avisar al final de que hay que volver.
    const fuera = this.offStepIssues();
    if (fuera.length > 0) {
      const nombres = fuera.map((i) => this.labelOf(i.key)).join(', ');
      return `Vuelve al paso «Cuenta» y elige otra vez: ${nombres}.`;
    }

    const missing = this.missingRequired();
    if (missing.length > 0) {
      const names = missing.slice(0, 3).map((f) => fieldLabel(f));
      const resto = missing.length > 3 ? ` y ${missing.length - 3} más` : '';
      return `Falta rellenar: ${names.join(', ')}${resto}.`;
    }
    const issues = this.issuesByField();
    if (issues.size > 0) {
      return issues.size === 1
        ? [...issues.values()][0]
        : `Hay ${issues.size} campos con valores que no valen.`;
    }
    return '';
  });

  readonly paramsComplete = computed(() => this.paramsBlockedReason() === '');

  /**
   * ¿El colapsable «Más parámetros» esconde algo que impide continuar?
   *
   * Sin esto, un obligatorio avanzado sin rellenar dejaba el boton apagado, el
   * motivo escrito debajo… y el campo culpable invisible detras de una seccion
   * plegada. `ui-collapsible` respeta el plegado manual, asi que abrirlo aqui
   * no le quita al usuario el control despues.
   */
  readonly advancedHasProblem = computed(() => {
    const problemas = new Set([
      ...this.missingRequired().map((f) => f.key),
      ...this.issuesByField().keys(),
    ]);
    return this.advancedGroups().some((g) => g.fields.some((f) => problemas.has(f.key)));
  });

  /** Mismo contrato que `paramsBlockedReason`, para el boton de crear. */
  readonly createBlockedReason = computed<string>(() => {
    // Los topes de riesgo se comprueban ANTES que nada: es el 403 que hoy llega
    // al final, cuando el formulario ya esta entero.
    const limite = this.limitErrors()[0];
    if (limite) return limite.message;
    if (this.name().trim().length === 0) return 'Ponle un nombre al bot para poder crearlo.';
    if (this.preview()?.valid === false) {
      return 'Hay niveles inválidos en este mercado. Ajusta los parámetros y vuelve a calcular.';
    }
    if (!this.preview()) return 'Vuelve a calcular la escalera: has cambiado algún parámetro.';
    return '';
  });

  readonly canCreate = computed(() => this.createBlockedReason() === '');

  /**
   * Reserva de precios en vivo.
   *
   * Se pide en el constructor y se SUELTA en `ngOnDestroy`, nunca en un hook de
   * Ionic: esta pagina vive fuera de las pestañas, y ahi `ionViewWillLeave` no
   * es de fiar — es la trampa exacta que documenta `MarketDataService.watchers`.
   * Sin soltarlo, el worker mantendria abierta una suscripcion al venue para una
   * pantalla que ya no existe.
   */
  private readonly priceWatch = this.md.watchSymbols([]);

  /**
   * Reserva de la INSTANTANEA de precios. Son dos cosas distintas y hacen falta
   * las dos.
   *
   * `watchSymbols` declara al servidor que este par interesa, y sus ticks
   * entran en `live()`. Pero `tickerOf()` construye su respuesta recorriendo
   * `tickers()` —la instantanea— y superponiendo el tick encima: sin ella el
   * mapa esta vacio y `tickerOf()` devuelve `undefined` por muchos ticks que
   * lleguen. Sin esta linea el panel de riesgo se quedaba en «esperando el
   * precio» para siempre.
   */
  private readonly tickersWatch = this.md.watchTickers();
  private walletTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    addIcons({
      warningOutline,
      linkOutline,
      alertCircleOutline,
      refreshOutline,
      chevronDownOutline,
    });

    // El par que se mira, declarado al servidor. Cambia con la cuenta y con el
    // simbolo, y se queda vacio mientras no haya los dos.
    effect(() => {
      const account = this.account();
      const symbol = this.symbol();
      this.priceWatch.update(account && symbol ? [`${account.venue}:${symbol}`] : []);
    });

    // El saldo se carga al entrar en «Parámetros», y no dentro de
    // `selectAccount()`: copiar un bot del ranking aterriza directo en ese paso
    // sin pasar por la seleccion de cuenta, y ahi el saldo hace la misma falta.
    effect(() => {
      const paso = this.step();
      const accountId = this.accountId();
      const symbol = this.symbol();
      if (paso !== 'params' || !accountId) return;
      untracked(() => {
        void this.wallet.load(accountId, symbol || undefined);
        this.startWalletPolling();
      });
    });

    // Cambio de lente a media creacion: se vuelve al paso 1.
    //
    // La cuenta elegida puede haber desaparecido de la lista —esta filtrada por
    // red— y los mercados cargados son los de la red anterior. Seguir adelante
    // dejaria el asistente montando un bot sobre una cuenta que ya no se ve y
    // un par que quiza no exista en su libro. Es brusco a proposito: cambiar de
    // red mientras se crea un bot es una decision, no un desliz.

    // Cambio de lente a media creacion: se vuelve al paso 1.
    //
    // La cuenta elegida puede haber desaparecido de la lista —esta filtrada por
    // red— y los mercados cargados son los de la red anterior. Seguir adelante
    // dejaria el asistente montando un bot sobre una cuenta que ya no se ve y
    // un par que quiza no exista en su libro. Es brusco a proposito: cambiar de
    // red mientras se crea un bot es una decision, no un desliz.
    let redAnterior: boolean | null = null;
    effect(() => {
      const testnet = this.testnet();
      if (redAnterior === null) {
        redAnterior = testnet;
        return;
      }
      if (redAnterior === testnet) return;
      redAnterior = testnet;
      untracked(() => {
        this.accountId.set('');
        this.symbol.set('');
        this.markets.set([]);
        this.preview.set(null);
        // Y el saldo. Dejarlo en pantalla enseñaria cifras de mainnet debajo de
        // la franja de testnet, que es justo lo que la franja existe para
        // impedir — y aqui son dolares de verdad.
        this.wallet.clear();
        this.step.set('venue');
      });
    });

    // Cambia lo que se esta configurando -> las sugerencias caducan.
    //
    // Se vacian ANTES de comprobar nada: la clave incluye par y estrategia, y
    // este es el unico sitio de la pantalla que reacciona a que cambien. Sin
    // esto, unas tarjetas calculadas para ETH seguirian en pantalla —y
    // aplicables— despues de cambiar a otro par.
    let claveAnterior: string | null = null;
    effect(() => {
      const clave = this.recoKey();
      if (claveAnterior === clave) return;
      claveAnterior = clave;
      untracked(() => {
        this.recommendations.set(null);
        this.recoError.set(null);
        this.appliedProfile.set(null);
      });
    });
  }

  ngOnDestroy(): void {
    this.priceWatch.release();
    this.tickersWatch();
    this.stopWalletPolling();
    // El saldo NO se conserva entre visitas al asistente: al volver, lo primero
    // que se ve tiene que ser una lectura de ahora, no la de la sesion anterior.
    this.wallet.clear();
  }

  async ngOnInit(): Promise<void> {
    this.busy.set(true);
    try {
      await this.accountsSvc.refresh();
      this.strategies.set(await this.bots.loadStrategies());
      // Los topes de riesgo, para poder avisar en el paso 3 en vez de dejar que
      // el servidor responda 403 al final. Si falla, se sigue sin ellos.
      await this.riskSvc.refresh().catch(() => undefined);
      await this.applyCopiedConfig();
      await this.applyMarketFromUrl();
    } catch (e) {
      await this.toast.error(errorText(e));
    } finally {
      this.busy.set(false);
    }
  }

  /**
   * Precarga desde el ranking, si se llegó aquí copiando un bot.
   *
   * Se salta a los parámetros pero NO al preview: quien copia tiene que ver la
   * escalera y el peor caso con SU capital antes de crear nada. Copiar no puede
   * ser un atajo para saltarse la única pantalla que enseña cuánto se arriesga.
   */
  private async applyCopiedConfig(): Promise<void> {
    // El estado de navegacion llega sin tipar: anclarlo aqui evita que el
    // `any` se propague por los seis accesos de abajo.
    const state = (this.router.getCurrentNavigation()?.extras.state ??
      (history.state as unknown)) as Record<string, unknown> | undefined;
    if (!state?.['config'] || !state?.['strategy']) return;

    this.copiedFrom.set((state['copiedFrom'] as string) ?? null);
    this.strategyKind.set(state['strategy'] as StrategyKind);
    this.accountId.set((state['exchangeAccountId'] as string) ?? '');
    this.symbol.set((state['symbol'] as string) ?? '');
    this.config.set({ ...(state['config'] as Record<string, unknown>) });
    this.name.set(this.copiedFrom() ? `Copia de ${this.copiedFrom()}` : '');

    if (this.accountId()) {
      const cuenta = this.accounts().find((a) => a.id === this.accountId());
      // Misma regla que en `selectAccount`: la red la manda la cuenta.
      if (cuenta) {
        this.markets.set(await this.marketsSvc.list(cuenta.venue, undefined, cuenta.testnet));
      }
    }
    this.step.set('params');
  }

  /**
   * Precarga desde el gráfico de un mercado (`/bots/new?venue=&symbol=`).
   *
   * Se elige la conexión de ese venue y se fija el par, y se avanza SOLO hasta
   * la estrategia: el usuario ya ha decidido dónde operar, pero no cómo ni con
   * cuánto, y esas dos pantallas no se saltan. Si tiene más de una conexión en
   * el venue se queda en el paso 1 con el par ya puesto, para que elija cuál.
   * Sin conexión en ese venue no se hace nada: el paso 1 ya explica que hay
   * que conectar una.
   */
  private async applyMarketFromUrl(): Promise<void> {
    if (this.step() !== 'venue' || this.accountId()) return;
    const q = this.route.snapshot.queryParamMap;
    const venue = q.get('venue');
    const symbol = q.get('symbol');
    if (!venue || !symbol) return;

    // Las de SIMULACION no cuentan para decidir si hay una sola candidata: como
    // existen siempre, sumarlas hacia que un usuario con UNA conexion real en
    // ese venue tuviera «dos» y dejara de preseleccionarse. Si no hay ninguna
    // real, se cae a la simulada, que es la eleccion correcta ahi.
    const reales = this.accounts().filter((a) => a.venue === venue && !a.paper);
    const candidates = reales.length ? reales : this.accounts().filter((a) => a.venue === venue);
    if (candidates.length === 0) return;

    this.symbol.set(symbol);
    if (candidates.length !== 1) return;

    await this.selectAccount(candidates[0].id, { keepSymbol: true });
    if (this.markets().some((m) => m.symbol === symbol)) this.step.set('strategy');
  }

  async selectAccount(id: string, opts: { keepSymbol?: boolean } = {}): Promise<void> {
    this.accountId.set(id);
    if (!opts.keepSymbol) this.symbol.set('');
    const cuenta = this.accounts().find((a) => a.id === id);
    if (!cuenta) return;
    this.busy.set(true);
    try {
      // La red sale de la CUENTA, no de la lente: la de simulación es de
      // mainnet y se ofrece igualmente con la lente en testnet, así que
      // seguirla le habría dado los pares y la retícula del libro equivocado.
      this.markets.set(await this.marketsSvc.list(cuenta.venue, undefined, cuenta.testnet));
    } catch (e) {
      await this.toast.error(errorText(e));
    } finally {
      this.busy.set(false);
    }
  }

  selectStrategy(kind: StrategyKind): void {
    this.strategyKind.set(kind);
    const descriptor = this.strategies().find((s) => s.kind === kind);
    // Los valores por defecto vienen del servidor, de la propia estrategia: la
    // app no tiene una segunda copia que pueda desincronizarse.
    this.config.set({ ...(descriptor?.defaults ?? {}) });
    this.step.set('params');
  }

  value(key: string): unknown {
    return this.config()[key];
  }

  setValue(key: string, value: unknown): void {
    this.config.update((c) => ({ ...c, [key]: value }));
    // El preview deja de ser válido en cuanto se toca un parámetro.
    this.preview.set(null);
    // Y la tarjeta deja de estar aplicada: no puede seguir diciendo «Prudente»
    // cuando el usuario ya ha cambiado uno de sus valores.
    this.appliedProfile.set(null);
  }

  /**
   * Pide las configuraciones sugeridas.
   *
   * Con botón explícito y nunca desde el `valueChange` del campo de capital:
   * cada pulsación en ese campo sería una petición, y el endpoint lee dos series
   * de velas por llamada.
   */
  async loadRecommendations(): Promise<void> {
    const cuenta = this.account();
    const kind = this.strategyKind();
    const capital = Number(this.value(CAPITAL_FIELD) ?? 0);
    if (!cuenta || !kind || !this.symbol() || !(capital > 0)) return;

    const clave = this.recoKey();
    this.recoLoading.set(true);
    this.recoError.set(null);
    try {
      const set = await this.advisor.suggest({
        venue: cuenta.venue,
        symbol: this.symbol(),
        strategy: kind,
        totalInvestment: String(capital),
        direction: (this.value('direction') as 'LONG' | 'SHORT' | 'NEUTRAL') ?? undefined,
      });
      // Una respuesta que llega tarde no puede pisar a la nueva: entre la ida y
      // la vuelta el usuario ha podido cambiar de par.
      if (this.recoKey() !== clave) return;
      this.recommendations.set(set);
    } catch (e) {
      if (this.recoKey() !== clave) return;
      this.recoError.set(errorText(e));
    } finally {
      // Con la misma guarda que las otras dos ramas: sin ella, una respuesta
      // vieja apagaba el indicador de carga mientras la nueva seguia en vuelo, y
      // el bloque se quedaba vacio y quieto sin que nada dijera que faltaba algo.
      if (this.recoKey() === clave) this.recoLoading.set(false);
    }
  }

  /**
   * Aplica una configuración al formulario.
   *
   * UNA sola escritura y no veinte `setValue()`: cada llamada clona el objeto y
   * dispara la recomputación de los cuatro `computed` que cuelgan de `config`.
   * Es el mismo patrón con el que se copia un bot del ranking.
   */
  applyRecommendation(p: RecommendedProfile): void {
    const cuenta = this.account();
    if (!cuenta || this.recoKey() === '') return;

    this.config.set({
      // Se conserva lo que el usuario ya hubiera tocado y la recomendación no
      // fija; encima van los valores propuestos.
      ...this.config(),
      ...p.config,
      exchangeAccountId: cuenta.id,
      symbol: this.symbol(),
    });
    // El preview del servidor deja de valer: obliga a volver a pulsar «Calcular
    // la escalera», que es la puerta que ya existe antes de crear nada.
    this.preview.set(null);
    this.appliedProfile.set(p.profile);
  }

  /**
   * Calcula la escalera con el MISMO código que ejecutará el motor.
   * No es una estimación para la pantalla: es literalmente lo que se mandará.
   */
  async runPreview(): Promise<void> {
    const account = this.account();
    const strategy = this.strategyKind();
    if (!account || !this.symbol() || !strategy) return;

    this.previewing.set(true);
    try {
      const result = await this.bots.preview({
        venue: account.venue,
        // La red de la CUENTA, no la de la lente: la de simulacion es de
        // mainnet y se ofrece tambien con la lente en testnet.
        testnet: account.testnet,
        symbol: this.symbol(),
        strategy,
        // La MISMA forma que se valida en local, no una copia a mano: es
        // justo el objeto que el servidor valida tal cual en `/bots/preview`.
        config: this.fullConfig(),
        // El MISMO precio que uso el panel. Sin el, el servidor tomaba la marca
        // del venue y el panel el ultimo negociado —en Lighter son precios
        // distintos— y cerca del minimo con `sizingMode: BASE` podian discrepar
        // en un nivel (001/F-66).
        refPrice: this.mark() ?? undefined,
      });
      this.preview.set(result);
      this.step.set('preview');
    } catch (e) {
      const parsed = parseHttpError(e);
      await this.toast.error(
        parsed.issues.length ? parsed.issues.map((i) => i.message).join(' ') : parsed.message,
      );
    } finally {
      this.previewing.set(false);
    }
  }

  async create(): Promise<void> {
    const account = this.account();
    const strategy = this.strategyKind();
    if (!account || !strategy) return;

    this.busy.set(true);
    try {
      const bot = await this.bots.create({
        name: this.name().trim(),
        exchangeAccountId: account.id,
        symbol: this.symbol(),
        strategy,
        config: this.config(),
        startActive: this.startActive,
        dryRun: this.simulando(),
      });
      await this.bots.refresh();
      await this.toast.success(this.simulando() ? 'Bot creado en simulación.' : 'Bot creado.');
      await this.router.navigate(['/bots', bot.id], { replaceUrl: true });
    } catch (e) {
      const parsed = parseHttpError(e);
      await this.toast.error(
        parsed.issues.length ? parsed.issues.map((i) => i.message).join(' ') : parsed.message,
      );
    } finally {
      this.busy.set(false);
    }
  }

  /**
   * Repesca del saldo mientras se esta decidiendo cuanto arriesgar.
   *
   * Solo en «Parámetros» y solo con la app DELANTE: `marketData.background()` es
   * publica precisamente para esto, y sin mirarla el movil en el bolsillo
   * seguiria pidiendo el saldo cada treinta segundos — y cada peticion puede
   * acabar en un descifrado de clave en el servidor.
   */
  private startWalletPolling(): void {
    if (this.walletTimer) return;
    this.walletTimer = setInterval(() => {
      if (this.step() !== 'params' || this.md.background()) return;
      const accountId = this.accountId();
      if (accountId) void this.wallet.load(accountId, this.symbol() || undefined);
    }, WALLET_POLL_MS);
  }

  private stopWalletPolling(): void {
    if (this.walletTimer) clearInterval(this.walletTimer);
    this.walletTimer = null;
  }

  /** Lo pide el usuario tocando la marca de tiempo de la cabecera. */
  refreshWallet(): void {
    const accountId = this.accountId();
    if (!accountId) return;
    void this.wallet.load(accountId, this.symbol() || undefined, { force: true });
  }

  /**
   * Los cuatro pasos, con su rotulo. Vive aqui y no en la plantilla porque el
   * indicador y la navegacion tienen que compartir EL MISMO orden: cuando
   * estaban duplicados, anadir un paso obligaba a acordarse de los dos sitios.
   */
  readonly STEPS: { key: Step; label: string }[] = [
    { key: 'venue', label: 'Cuenta' },
    { key: 'strategy', label: 'Estrategia' },
    { key: 'params', label: 'Parámetros' },
    { key: 'preview', label: 'Revisión' },
  ];

  /**
   * Solo hacia ATRAS, y solo a un paso ya recorrido.
   *
   * Saltar hacia adelante desde el indicador dejaria entrar en «Parámetros»
   * sin cuenta ni par elegidos, que es justo lo que el boton «Continuar» del
   * paso 1 evita. Volver, en cambio, no pierde nada: todo el estado vive en
   * señales y sigue ahi.
   */
  canGoTo(target: Step): boolean {
    const order = this.STEPS.map((s) => s.key);
    return order.indexOf(target) < order.indexOf(this.step());
  }

  goTo(target: Step): void {
    if (this.canGoTo(target)) this.step.set(target);
  }

  back(): void {
    const order = this.STEPS.map((s) => s.key);
    const i = order.indexOf(this.step());
    if (i > 0) this.step.set(order[i - 1]);
  }

  // Los nombres y las descripciones salen del catálogo compartido y ya no de
  // dos mapas privados aquí dentro: eran una tercera copia de lo que ya está en
  // `core/utils/labels.ts`, y una estrategia nueva salía con su nombre en la
  // lista de bots y con la constante cruda en este selector.
  readonly strategyLabel = strategyLabel;
  readonly strategyBlurb = strategyBlurb;

  isRisky(kind: string): boolean {
    return kind === 'MARTINGALE' || kind === 'GRIDMART';
  }
}

import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { filter } from 'rxjs';
import {
  AlertController,
  IonBackButton,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonItem,
  IonLabel,
  IonList,
  IonNote,
  IonSegment,
  IonSegmentButton,
  IonSpinner,
  IonTitle,
  IonToolbar,
} from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import {
  chevronForwardOutline,
  closeOutline,
  ellipsisVertical,
  flaskOutline,
  informationCircleOutline,
  shieldOutline,
  statsChartOutline,
  trendingUpOutline,
  trophyOutline,
  warningOutline,
} from 'ionicons/icons';
import {
  D,
  SERIES_POINTS,
  SNAPSHOT_CADENCE_MS,
  alMinuto,
  bucketMsFor,
  costeDeComisionesPct,
  enMercadoPct,
  indiceDePeorCaida,
  capitalActual,
  repartoDeEjecucion,
  resumenDeCiclos,
  retornoSobreMargen,
  aCsv,
  cronologiaPorCiclo,
  sumaExacta,
  edicionesDe,
  recolocarBorrador,
  type FieldMeta,
} from '@crypton/shared';
import { Clipboard } from '@capacitor/clipboard';
import { BotsService, LeaderboardService, StreamService, ToastService } from '../../core/services';
import type {
  BotConfigRevision,
  BotCycle,
  BotDetail,
  BotEvent,
  BotFill,
  BotOrder,
  BotSnapshot,
  ConfigChange,
  MarketMakerStats,
} from '../../core/models';
import {
  errorText,
  eventLabel,
  fieldLabel,
  isMarketMaker,
  labelDeClave,
  money,
  optionLabel,
  orderStatusLabel,
  parseHttpError,
  pct,
  pnlColor,
  price,
  qty,
  shortDate,
  signed,
  strategyBlurb,
  strategyLabel,
  uptime,
  venueLabel,
  textoDeConfig,
} from '../../core/utils';
import {
  UiBadgeComponent,
  UiCardComponent,
  UiCollapsibleComponent,
  UiFieldComponent,
  UiLiqMeterComponent,
  UiMarginSheetComponent,
  UiMeterComponent,
  UiMutabilityBadgeComponent,
  UiNoticeComponent,
  UiSparkComponent,
  UiStatComponent,
  UiStatusPillComponent,
  UiStrategyHelpComponent,
} from '../../shared/ui';
// Directo de `bot-overlay` y no del indice de `shared/chart`: el indice arrastra
// el componente del grafico grande, y esta pantalla no lo pinta.
import { levelTitle } from '../../shared/chart/bot-overlay';
import { serieDeResultado, ventanaDe } from '../../shared/chart/bot-series';
import { BotCommandsService } from '../../shared/bot/bot-commands.service';
import {
  entradasDe,
  filasDeCiclos,
  filasDeOrdenes,
  rotuloDeCiclo,
  ventanasDe,
} from './bot-timeline';
import { liqNum } from '../../core/utils/risk';
// El Modo IA (spec 053), por ruta como el resto de lo de administración.
import { AuthService } from '../../core/auth';
import { AdminBotsService, type AiSetting } from '../../core/services/admin-bots.service';
import { ModoIaService } from '../../core/services/modo-ia.service';
import { insigniaIa, type CambioIa, type InsigniaIa } from '../../core/utils/modo-ia';
import { ModoIaAccionesService } from '../../shared/bot/modo-ia-acciones.service';
import { ModoIaPanelComponent } from '../../shared/bot/modo-ia-panel.component';

type Tab = 'resumen' | 'escalera' | 'ordenes' | 'ajustes' | 'eventos';

/**
 * Ventanas de la curva. La primera es el endpoint de siempre —las ultimas 500
 * filas, 8 h 20 min—; las otras tres piden un rango agregado en el servidor.
 * 30 d es la ultima porque es la retencion de la tabla: no hay mas pasado.
 */
type Rango = '8h' | '24h' | '7d' | '30d';
const RANGO_MS: Record<Exclude<Rango, '8h'>, number> = {
  '24h': 24 * 3_600_000,
  '7d': 7 * 24 * 3_600_000,
  '30d': 30 * 24 * 3_600_000,
};
export const RANGOS: readonly Rango[] = ['8h', '24h', '7d', '30d'];

/** Una fila de la escalera: un nivel, el precio de ahora o la liquidación. */
type LadderRow =
  | { kind: 'level'; o: BotOrder; price: string; dist: string | null }
  | { kind: 'now'; price: string }
  | { kind: 'liq'; price: string };

@Component({
  selector: 'app-bot-detail',
  standalone: true,
  imports: [
    RouterLink,
    IonHeader,
    IonToolbar,
    IonTitle,
    IonButtons,
    IonBackButton,
    IonButton,
    IonIcon,
    IonContent,
    IonSegment,
    IonSegmentButton,
    IonList,
    IonItem,
    IonLabel,
    IonNote,
    IonSpinner,
    UiBadgeComponent,
    UiCardComponent,
    UiCollapsibleComponent,
    UiFieldComponent,
    UiLiqMeterComponent,
    UiMarginSheetComponent,
    UiMeterComponent,
    UiMutabilityBadgeComponent,
    UiNoticeComponent,
    UiSparkComponent,
    UiStatComponent,
    UiStatusPillComponent,
    UiStrategyHelpComponent,
    ModoIaPanelComponent,
  ],
  templateUrl: './bot-detail.page.html',
  styleUrl: './bot-detail.page.scss',
})
export class BotDetailPage implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly bots = inject(BotsService);
  private readonly stream = inject(StreamService);
  private readonly toast = inject(ToastService);
  private readonly commands = inject(BotCommandsService);
  private readonly alerts = inject(AlertController);
  private readonly leaderboard = inject(LeaderboardService);

  readonly bot = signal<BotDetail | null>(null);
  readonly orders = signal<BotOrder[]>([]);
  readonly events = signal<BotEvent[]>([]);
  readonly tab = signal<Tab>('resumen');
  readonly saving = signal(false);
  readonly publicando = signal(false);
  readonly loading = signal(true);
  /** Ficha de market making. null mientras no se ha pedido o no aplica. */
  readonly mmStats = signal<MarketMakerStats | null>(null);

  // ── Modo IA (spec 053) ─────────────────────────────────────────
  private readonly auth = inject(AuthService);
  private readonly adminBots = inject(AdminBotsService);
  private readonly accionesIa = inject(ModoIaAccionesService);
  readonly modoIa = inject(ModoIaService);

  /**
   * Rol de administrador: decide si se PINTAN la pastilla y el panel del Modo
   * IA. Comodidad, no seguridad: las rutas son de administración y el servidor
   * responde 403 a cualquier otro.
   */
  readonly esAdmin = computed(() => this.auth.user()?.role === 'ADMIN');
  /** El Modo IA de este bot. `null` mientras se lee, o para quien no es administrador. */
  readonly ia = signal<AiSetting | null>(null);
  readonly iaError = signal(false);
  readonly guardandoIa = signal(false);
  /** Una lectura que llega despues de un guardado traeria el modo viejo. */
  private secuenciaIa = 0;

  /**
   * Si se enseña la sección del Modo IA en Ajustes.
   *
   * Encendido, siempre —aunque sea para poder apagarlo—. Apagado, solo si la
   * estrategia está en el alcance, o si todavía no se sabe: entonces decide el
   * servidor.
   */
  readonly mostrarPanelIa = computed(() => {
    const b = this.bot();
    if (!b || !this.esAdmin()) return false;
    const ia = this.ia();
    if (ia && ia.mode !== 'OFF') return true;
    return (ia?.cubierta ?? this.modoIa.cubre(b.strategy)) !== false;
  });

  /**
   * La configuración de la que nació el borrador de Ajustes, y su versión.
   *
   * Guardar manda el borrador ENTERO, así que si la configuración cambió
   * mientras había cambios a medio escribir —un ajuste del Modo IA, otro
   * dispositivo—, guardar lo desharía en silencio (spec 053, H-05). Por eso:
   *
   *   - lo editado se mide contra ESTA configuración y no contra la actual. Con
   *     la actual, tras un ajuste de la IA un borrador sin tocar parecía
   *     editado, no se refrescaba y guardarlo deshacía el ajuste (spec 055, G-01);
   *   - si la versión cambia con ediciones a medias, el borrador se recoloca en
   *     el acto sobre la nueva, con solo esas ediciones encima;
   *   - y se guarda diciendo esta versión, para que la API rechace la carrera
   *     que aún cabe entre leer y escribir (spec 055, H-05).
   */
  private readonly borradorBase = signal<number | null>(null);
  private readonly configBase = signal<Record<string, unknown> | null>(null);
  /**
   * El último cambio de versión por debajo de un borrador a medias, para decirlo,
   * con los campos editados que también cambiaron debajo: ahí gana lo editado,
   * y es lo que hay que ver antes de guardar (spec 056, A-2).
   */
  private readonly cambioDebajo = signal<{ de: number; a: number; choques: string[] } | null>(null);
  /**
   * Sube cada vez que el borrador vuelve a nacer, anclado o recolocado. Un
   * guardado que termina sobre OTRO borrador no le cambia la base: pulsar
   * «Descartar» con el guardado en vuelo dejaba el borrador viejo como ediciones
   * sobre la versión recién guardada, y guardar otra vez la revertía
   * (spec 056, A-8).
   */
  private generacionBorrador = 0;
  /**
   * Las lecturas del detalle, pedidas y aplicada. Una respuesta que llega
   * después de otra más nueva traería el bot de antes, y con él el borrador
   * anclado a la versión de antes (spec 056, A-6).
   */
  private detallesPedidos = 0;
  private detalleAplicado = 0;
  /**
   * La serie temporal y los ciclos cerrados. Los dos endpoints existían desde el
   * principio con su método cliente escrito y ninguna pantalla los llamaba
   * (spec 002, F-10): son lo que convierte esta pantalla de una foto del último
   * snapshot en algo que contesta «¿está ganando o solo está abierto?».
   */
  readonly snapshots = signal<BotSnapshot[]>([]);
  readonly cycles = signal<BotCycle[]>([]);
  /** El historial de configuración (spec 006). Se pide con el detalle; vacío si falla. */
  readonly revisions = signal<BotConfigRevision[]>([]);
  /**
   * Las ejecuciones, SOLO para la vista por ciclo (spec 006, R-5): son una
   * petición más por refresco y la bitácora plana no las necesita. `null`
   * mientras nadie ha abierto esa vista.
   */
  readonly fills = signal<BotFill[] | null>(null);
  readonly vistaEventos = signal<'bitacora' | 'ciclos'>('bitacora');
  /**
   * Órdenes, ejecuciones y sucesos en una lista por ciclo. La agrupación es
   * `cronologiaPorCiclo` de `shared`, con sus tests; aquí solo se adaptan las
   * columnas (`bot-timeline.ts`). Los sucesos van por la hora, y se dice.
   */
  readonly cronologia = computed(() =>
    cronologiaPorCiclo(
      entradasDe(this.orders(), this.fills() ?? [], this.events()),
      ventanasDe(this.cycles(), this.bot()?.cycle ?? null),
    ),
  );
  readonly rotuloDeCiclo = rotuloDeCiclo;
  /** `shortDate` para un instante en ms: las entradas de la cronología llevan `at` numérico. */
  readonly fecha = (ms: number): string => shortDate(new Date(ms));
  readonly rango = signal<Rango>('8h');
  readonly rangos = RANGOS;
  /** El cubo con el que llegó la serie: de él sale el umbral de hueco. */
  readonly serieBucket = signal<number>(SNAPSHOT_CADENCE_MS);
  /** Cuándo se pidió la serie por última vez: se vuelve a pedir como mucho una vez por cadencia. */
  private serieCargadaEn = 0;

  /** Copia editable de la configuración. No se toca `bot().config` hasta guardar. */
  readonly draft = signal<Record<string, unknown>>({});

  // ── Ajuste de margen de la posición aislada ───────────────────
  // El formulario entero vive en `ui-margin-sheet`, compartido con el gráfico
  // (spec 005). Aquí solo se decide si está abierto.
  readonly marginOpen = signal(false);

  /**
   * ¿Se puede ajustar el margen de este bot AHORA?
   *
   * Las tres condiciones son las que hacen que la operación exista: en cruzado
   * el colateral es el de toda la cuenta y no hay caja por posición; sin
   * posición no hay nada que financiar; y con el bot parado no hay worker que
   * ejecute el comando —la API lo rechazaría igualmente.
   */
  readonly canAdjustMargin = computed(() => {
    const b = this.bot();
    if (!b) return false;
    if (b.margin_mode !== 'ISOLATED') return false;
    if (!Number.isFinite(Number(b.positionQty)) || Number(b.positionQty) === 0) return false;
    return this.isLive();
  });

  readonly money = money;
  readonly signed = signed;
  readonly pct = pct;
  readonly pnlColor = pnlColor;
  readonly uptime = uptime;
  readonly shortDate = shortDate;
  readonly fieldLabel = fieldLabel;
  readonly price = price;
  readonly qty = qty;
  readonly strategyLabel = strategyLabel;
  readonly strategyBlurb = strategyBlurb;
  readonly venueLabel = venueLabel;
  readonly levelTitle = levelTitle;
  readonly eventLabel = eventLabel;
  readonly orderStatusLabel = orderStatusLabel;

  private id = '';

  /**
   * Campos agrupados por mutabilidad y en ese orden: primero lo que se aplica
   * al instante, luego lo que retiende la escalera, y al final lo inmutable.
   * Así el usuario ve arriba lo que puede tocar sin consecuencias.
   */
  readonly hotFields = computed(() => this.fieldsOf('HOT'));
  readonly warmFields = computed(() => this.fieldsOf('WARM'));
  readonly coldFields = computed(() => this.fieldsOf('COLD'));

  /**
   * Dentro de cada mutabilidad, lo corriente arriba y lo avanzado plegado.
   *
   * La mutabilidad manda sobre el grupo y no al revés: aquí lo que el usuario
   * necesita saber antes que nada es qué le va a pasar al bot si toca ese campo
   * con la posición abierta. El plegado solo evita que los treinta y cuatro
   * parámetros de un market maker V2 entierren los cinco que se tocan de verdad.
   */
  readonly hotBasic = computed(() => this.hotFields().filter((f) => !f.advanced));
  readonly hotAdvanced = computed(() => this.hotFields().filter((f) => f.advanced));
  readonly warmBasic = computed(() => this.warmFields().filter((f) => !f.advanced));
  readonly warmAdvanced = computed(() => this.warmFields().filter((f) => f.advanced));

  /**
   * Publicar comparte la FORMA de la estrategia, no el tamaño, y solo tiene
   * sentido sobre operaciones reales.
   *
   * En la plantilla «ya publicado» se comprueba ANTES que nada: quien tenga un
   * bot publicado tiene que poder retirarlo siempre.
   */
  /** Solo las dos estrategias que cotizan a los dos lados tienen ficha propia. */
  readonly esMarketMaker = computed(() => {
    const kind = this.bot()?.strategy;
    return !!kind && isMarketMaker(kind);
  });

  /**
   * Reparto de las ejecuciones entre maker y taker.
   *
   * Es la cifra que dice si el bot está haciendo su trabajo: un market maker
   * que cruza el libro paga comisión de taker y se queda sin el diferencial que
   * justifica la estrategia. El dato estaba en la base desde siempre —cada fill
   * guarda `is_taker`— y no se agregaba en ninguna parte. Se pinta como barra de
   * dos segmentos y no como donut: dos barras contiguas se comparan, dos donuts no.
   */
  readonly reparto = computed(() => {
    const st = this.mmStats();
    return st && st.fills > 0 ? repartoDeEjecucion(st) : null;
  });

  // ── Analítica del resumen ──────────────────────────────────────
  //
  // La serie se llama «resultado acumulado» y no «equity» a propósito:
  // `bot_snapshots.equity` es `realized_pnl_acc + unrealized_pnl`, es decir PnL,
  // no patrimonio, y rotularlo «equity» heredaría el vocabulario del sector con
  // otro significado (spec 002, R-7).
  readonly vista = computed(() => serieDeResultado(this.snapshots(), this.serieBucket()));
  readonly peorIdx = computed(() => {
    const v = this.vista();
    return v ? indiceDePeorCaida(v) : null;
  });
  /** Lo que la serie cubre DE VERDAD. Con 500 filas a una por minuto, 8 h 20 min. */
  readonly ventana = computed(() => {
    const ms = ventanaDe(this.vista());
    return ms > 0 ? uptime(Math.round(ms / 1000)) : null;
  });
  /** Fracción de los snapshots con posición abierta, en %. */
  readonly enMercado = computed(() => enMercadoPct(this.snapshots().map((x) => x.position_qty)));
  readonly ciclos = computed(() => resumenDeCiclos(this.cycles()));
  /** Resultado total de la cabecera, con `Decimal` (invariante 1). */
  readonly total = computed(() => {
    const b = this.bot();
    return b ? sumaExacta([b.realizedPnl, b.unrealizedPnl]) : '0';
  });
  /**
   * Capital actual, con el mismo respaldo que la tarjeta de la lista: si el
   * servidor va una versión por detrás y no manda el campo, se compone aquí con
   * la función del paquete compartido en vez de enseñar un guion.
   */
  readonly capital = computed(() => {
    const b = this.bot();
    if (!b) return '0';
    return b.currentCapital ?? capitalActual(b.totalInvestment, b.realizedPnl, b.unrealizedPnl);
  });
  /**
   * El capital inicial, SOLO si difiere del asignado de hoy: si son iguales
   * repetirlo es ruido. null también con un servidor sin actualizar, que no
   * manda el campo (spec 025).
   */
  readonly inicialDistinto = computed(() => {
    const b = this.bot();
    const ini = b?.initialInvestment;
    if (!b || ini === undefined || ini === null || ini === '') return null;
    return D(ini).eq(D(b.totalInvestment)) ? null : ini;
  });
  /** PnL abierto sobre el margen usado, en %: el «ROE» de la posición. null sin margen. */
  readonly roe = computed(() => {
    const b = this.bot();
    return b ? retornoSobreMargen(b.unrealizedPnl, b.marginUsed) : null;
  });
  /**
   * Distancia a liquidación, del SERVIDOR (medida contra el precio de la caché de
   * tickers). Antes esta pantalla la pintaba siempre en rojo estuviera al 3 % o
   * al 60 %, y era la única de las cuatro sin semáforo (spec 002, F-02). El
   * semáforo lo pinta `ui-liq-meter`; aquí solo se decide si hay tarjeta.
   */
  readonly liqDist = computed(() => liqNum(this.bot()?.liquidationDistancePct));
  /** Qué parte de lo capturado se llevan las comisiones, en %. */
  readonly costePct = computed(() => {
    const c = this.ciclos();
    return costeDeComisionesPct(c.neto, c.comisiones);
  });
  /**
   * Una frase que contesta «¿está ganando o solo está abierto?».
   *
   * Solo hechos, y solo con recorrido: con menos de tres ciclos cerrados no hay
   * nada que resumir y se calla. El tono se decide por la tasa de acierto Y por
   * el signo del total, nunca por uno solo de los dos.
   */
  readonly veredicto = computed(() => {
    const c = this.ciclos();
    if (c.cerrados < 3) return null;
    const v = this.vista();
    const partes = [`${c.enVerde} de ${c.cerrados} ciclos cerrados en verde`];
    if (v && D(v.peorCaida).gt(0)) {
      const cuando = this.ventana() ? ` en las últimas ${this.ventana()}` : '';
      partes.push(`peor caída ${signed(D(v.peorCaida).neg().toFixed())}${cuando}`);
    }
    const bien = D(c.enVerde).div(c.cerrados).gte(0.6) && D(this.total()).gt(0);
    return { texto: partes.join(' · '), tone: bien ? ('ok' as const) : ('info' as const) };
  });
  /**
   * La escalera como escalera: ordenada por precio, con el precio de ahora
   * insertado en su sitio y la liquidación cerrándola. Antes era una lista de
   * filas sin relación espacial con el precio, y sin la única referencia que da
   * sentido al conjunto.
   */
  readonly escalera = computed((): LadderRow[] => {
    const b = this.bot();
    if (!b) return [];
    // La distancia de cada nivel al precio de ahora se calcula UNA vez aquí, no
    // en la plantilla en cada vuelta de la detección de cambios.
    const mark = b.snapshot?.mark_price;
    const dist = (price: string): string | null =>
      mark && D(mark).gt(0) ? D(price).minus(mark).div(mark).mul(100).toFixed(2) : null;
    const filas: LadderRow[] = b.openOrdersList.map((o) => ({
      kind: 'level',
      o,
      price: o.price,
      dist: dist(o.price),
    }));
    if (b.snapshot?.mark_price) filas.push({ kind: 'now', price: b.snapshot.mark_price });
    if (b.liquidationPrice) filas.push({ kind: 'liq', price: b.liquidationPrice });
    return filas.sort((x, y) => D(y.price).comparedTo(D(x.price)));
  });

  /**
   * Rol de administrador. Solo decide si se PINTA el atajo al backtest.
   *
   * La app esconde lo que no va a funcionar, pero quien decide de verdad es el
   * servidor.
   */
  readonly publicado = computed(() => this.bot()?.share?.public === true);
  /** El ranking exige 6 h de recorrido: se publica igual, pero no aparece aún. */
  readonly demasiadoJoven = computed(() => (this.bot()?.uptimeSeconds ?? 0) < 6 * 3600);

  /**
   * Los campos editados, contra la configuración de la que nació el borrador
   * (spec 055, G-01), y con la igualdad del servidor (spec 056, A-1). Sin base
   * todavía —antes de la primera carga— no hay nada editado.
   */
  readonly ediciones = computed(() => {
    const base = this.configBase();
    return base ? edicionesDe(base, this.draft()) : [];
  });
  /** true si algún campo editable ha cambiado respecto de lo guardado. */
  readonly dirty = computed(() => this.ediciones().length > 0);

  /**
   * El aviso de que la configuración cambió debajo del borrador, o `null`.
   *
   * Va dentro de la barra de guardar, que es fija: debajo del historial no lo
   * veía quien editaba arriba y guardaba desde la barra (spec 056, A-2). Los
   * choques se nombran solo mientras sigan editados.
   */
  readonly avisoDebajo = computed(() => {
    const v = this.cambioDebajo();
    if (!v || !this.dirty()) return null;
    const editados = new Set(this.ediciones());
    const campos = this.bot()?.fields ?? [];
    const choques = v.choques
      .filter((clave) => editados.has(clave))
      .map((clave) => `«${labelDeClave(campos.find((f) => f.key === clave)?.labelKey, clave)}»`);
    // El Modo IA solo existe para un administrador: a los demás la versión les
    // cambia desde otro dispositivo, o al aportar margen (spec 056, A-7).
    const origen = this.esAdmin() ? ', quizá por un ajuste del Modo IA' : '';
    return { de: v.de, a: v.a, origen, choques: choques.join(', ') };
  });

  constructor() {
    addIcons({
      ellipsisVertical,
      warningOutline,
      trophyOutline,
      statsChartOutline,
      shieldOutline,
      flaskOutline,
      chevronForwardOutline,
      closeOutline,
      trendingUpOutline,
      informationCircleOutline,
    });
    // Cualquier evento de ESTE bot refresca la pantalla.
    //
    // Con `takeUntilDestroyed`, y no es cosmetico: `bots/:id` es una ruta raiz
    // que Ionic DESTRUYE al salir, pero la suscripcion se quedaba viva dentro
    // del `Subject` del servicio, que dura toda la sesion. Visitar diez veces el
    // mismo bot dejaba diez suscripciones con el mismo `id`, y un solo evento de
    // ese bot disparaba DIEZ peticiones identicas a la API. Crecia con el uso.
    // La ventana de agrupación vive en `StreamService.ofBot`, compartida con el
    // gráfico: dos copias de esa política ya se desalinearon una vez.
    this.stream
      .ofBot(() => this.id)
      .pipe(takeUntilDestroyed())
      .subscribe(() => void this.load(false));

    // El Modo IA se relee solo con SUS eventos (spec 053): `load()` corre con
    // cada evento del bot, y un market maker manda varios por segundo.
    this.stream.stream
      .pipe(
        filter((ev) => ev.botId === this.id && ev.type.startsWith('AI_')),
        takeUntilDestroyed(),
      )
      .subscribe(() => void this.cargarIa());
  }

  async ngOnInit(): Promise<void> {
    this.id = this.route.snapshot.paramMap.get('id') ?? '';
    // Aparte y sin esperar: no es a lo que se viene aquí, y nunca falla hacia fuera.
    void this.cargarIa();
    await this.load(true);
  }

  // ── Modo IA (spec 053) ─────────────────────────────────────────

  /**
   * Lee el Modo IA del bot, solo para un administrador.
   *
   * Un fallo se enseña como fallo: pintarlo como «Apagado» ofrecería encender
   * algo que quizá ya está encendido.
   */
  async cargarIa(): Promise<void> {
    if (!this.esAdmin() || !this.id) return;
    const turno = ++this.secuenciaIa;
    this.iaError.set(false);
    try {
      const ajuste = await this.adminBots.aiMode(this.id);
      if (turno === this.secuenciaIa) this.ia.set(ajuste);
    } catch {
      if (turno !== this.secuenciaIa) return;
      this.ia.set(null);
      this.iaError.set(true);
    }
  }

  /** Guarda el Modo IA. `guardandoIa` cubre la petición entera, no solo el diálogo. */
  async guardarIa(cambio: CambioIa): Promise<void> {
    const b = this.bot();
    const actual = this.ia();
    if (!b || !actual || this.guardandoIa()) return;

    this.guardandoIa.set(true);
    try {
      const nuevo = await this.accionesIa.guardar(b, cambio, actual.mode);
      if (nuevo) {
        this.secuenciaIa++;
        // Lo que no trae la respuesta del guardado —los interruptores— se conserva.
        this.ia.set({ ...actual, ...nuevo });
        // Una relectura que fallara con el guardado en vuelo ya no vale: lo que
        // hay es la respuesta del servidor (spec 056, A-9).
        this.iaError.set(false);
      }
    } finally {
      this.guardandoIa.set(false);
    }
  }

  /**
   * La pastilla de la cabecera: con la lectura de este bot si ya llegó, y si no
   * con el resumen compartido, que es lo mismo que enseña la lista.
   */
  pastillaIa(b: BotDetail): InsigniaIa | null {
    if (!this.esAdmin()) return null;
    const ia = this.ia();
    return insigniaIa(
      ia ?? this.modoIa.de(b.id),
      this.modoIa.conCanal(ia?.interruptores ?? this.modoIa.interruptores()),
      b,
    );
  }

  private async load(withSpinner: boolean): Promise<void> {
    if (withSpinner) this.loading.set(true);
    const turno = ++this.detallesPedidos;
    try {
      const detail = await this.bots.detail(this.id);
      if (turno < this.detalleAplicado) return;
      this.detalleAplicado = turno;
      this.bot.set(detail);
      // El borrador solo se reinicia si el usuario no tiene cambios sin
      // guardar: refrescar por un evento no debe borrarle lo que estaba
      // escribiendo. Con ediciones a medias y otra versión debajo, se recoloca
      // encima de la nueva y se dice (spec 055, H-05).
      //
      // Y nunca hacia atrás: tras guardar, la base ya es la versión nueva, y un
      // detalle pedido antes de que el guardado terminara trae la vieja. Ese
      // borrador se queda como está: la lectura que sigue trae la buena
      // (spec 056, A-6).
      const base = this.borradorBase();
      const haciaAtras = base !== null && detail.config_version < base;
      if (!haciaAtras && !this.dirty()) {
        this.anclarBorrador(detail.config, detail.config_version);
      } else if (!haciaAtras && base !== detail.config_version) {
        this.recolocarBorrador();
      }
      // La serie y los ciclos van con `catch`: son analítica, y si fallan la
      // pantalla se pinta igual con lo que sí llegó.
      const [orders, events, snapshots, cycles, revisions] = await Promise.all([
        this.bots.orders(this.id, 60),
        this.bots.events(this.id, 60),
        this.cargarSerie().catch((): BotSnapshot[] => []),
        this.bots.cycles(this.id, 60).catch((): BotCycle[] => []),
        this.bots.revisions(this.id).catch((): BotConfigRevision[] => []),
      ]);
      if (turno < this.detalleAplicado) return;
      this.orders.set(orders);
      this.events.set(events);
      this.snapshots.set(snapshots);
      this.cycles.set(cycles);
      this.revisions.set(revisions);
      // Las ejecuciones se refrescan solo si alguien ya abrió la vista por ciclo.
      if (this.fills() !== null) await this.cargarFills();

      // La ficha de market making solo se pide para los bots que la tienen: en
      // el resto sería una llamada más por refresco para leer ceros. Y si falla,
      // la pantalla se pinta igual: no es a lo que se viene aquí.
      if (this.esMarketMaker()) {
        this.mmStats.set(await this.bots.mmStats(this.id).catch(() => null));
      } else {
        this.mmStats.set(null);
      }
    } catch (e) {
      await this.toast.error(errorText(e));
    } finally {
      this.loading.set(false);
    }
  }

  // ── Historial, cronología y CSV (spec 006) ─────────────────────

  /** «Apalancamiento: 2 → 3», con el nombre legible del campo y los valores como en los COLD. */
  cambioTexto(c: ConfigChange): string {
    const de = c.from === undefined ? '—' : textoDeConfig(c.from);
    const a = c.to === undefined ? '—' : textoDeConfig(c.to);
    return `${labelDeClave(c.labelKey, c.key)}: ${de} → ${a}`;
  }

  async verEventos(vista: 'bitacora' | 'ciclos'): Promise<void> {
    this.vistaEventos.set(vista);
    if (vista === 'ciclos' && this.fills() === null) await this.cargarFills();
  }

  private async cargarFills(): Promise<void> {
    this.fills.set(await this.bots.fills(this.id, 100).catch((): BotFill[] => []));
  }

  copiarCiclos(): Promise<void> {
    return this.copiar(aCsv(filasDeCiclos(this.cycles())), 'ciclos');
  }

  copiarOrdenes(): Promise<void> {
    return this.copiar(aCsv(filasDeOrdenes(this.orders())), 'órdenes');
  }

  /**
   * Al portapapeles y no a un fichero: no exige plugins nuevos y cubre el caso
   * («llevármelo a una hoja»). El aviso dice lo de los decimales porque es lo
   * que va a sorprender a quien pegue en una hoja en castellano.
   */
  private async copiar(texto: string, que: string): Promise<void> {
    try {
      await Clipboard.write({ string: texto });
      await this.toast.success(`CSV de ${que} copiado. Los importes van con punto decimal.`);
    } catch (e) {
      await this.toast.error(errorText(e));
    }
  }

  /**
   * Valor de un campo inmutable, ya legible.
   *
   * Los COLD se pintan como texto y no como control, así que sin traducir se
   * veía la constante cruda —«NEUTRAL», «AUTO»— justo en los campos que el
   * usuario no puede cambiar y solo puede leer.
   */
  coldValue(field: FieldMeta): string {
    const raw = this.value(field.key);
    if (raw === null || raw === undefined || raw === '') return '—';
    if (field.kind === 'enum') return optionLabel(textoDeConfig(raw), field.labelKey);
    return textoDeConfig(raw);
  }

  private fieldsOf(mutability: 'HOT' | 'WARM' | 'COLD'): FieldMeta[] {
    return (this.bot()?.fields ?? []).filter((f) => f.mutability === mutability);
  }

  value(key: string): unknown {
    return this.draft()[key];
  }

  setValue(key: string, value: unknown): void {
    // Una edición que empieza sobre un borrador limpio no arrastra el aviso de
    // una recolocación anterior: lo que avisaba ya no está editado (spec 056, A-7).
    if (!this.dirty()) this.cambioDebajo.set(null);
    // Vaciar un campo que ya estaba vacío no es editarlo. El campo entrega '', y
    // con la igualdad del servidor '' frente a null es un cambio: teclear y
    // borrar dejaba la barra de guardar puesta sin nada que guardar
    // (spec 056, A-1).
    const base = this.configBase()?.[key];
    const valor = value === '' && base == null ? base : value;
    this.draft.update((d) => ({ ...d, [key]: valor }));
  }

  discard(): void {
    const b = this.bot();
    if (b) this.anclarBorrador(b.config, b.config_version);
  }

  /** El borrador vuelve a nacer de esta configuración, sin ediciones. */
  private anclarBorrador(config: Record<string, unknown>, version: number): void {
    this.generacionBorrador++;
    this.draft.set({ ...config });
    this.configBase.set({ ...config });
    this.borradorBase.set(version);
    this.cambioDebajo.set(null);
  }

  /**
   * El borrador, sobre la configuración que hay ahora: la nueva, con solo lo que
   * el usuario editó encima (spec 055, H-05). Lo que cambió debajo —un ajuste del
   * Modo IA, otro dispositivo— se conserva, y el formulario lo enseña.
   */
  private recolocarBorrador(): void {
    const b = this.bot();
    const base = this.configBase();
    const de = this.borradorBase();
    if (!b || !base || de === null) return;
    const actual = b.config;
    const r = recolocarBorrador(base, this.draft(), actual);
    // Si lo editado ya coincide con la versión nueva, no queda nada que avisar:
    // el borrador vuelve a nacer de ella (spec 056, A-7).
    if (edicionesDe(actual, r.borrador).length === 0) {
      this.anclarBorrador(actual, b.config_version);
      return;
    }
    this.generacionBorrador++;
    this.draft.set(r.borrador);
    this.configBase.set({ ...actual });
    this.borradorBase.set(b.config_version);
    // Si ya había un aviso, se conserva la versión de la que se partió, y los
    // choques se suman.
    const previo = this.cambioDebajo();
    this.cambioDebajo.set({
      de: previo?.de ?? de,
      a: b.config_version,
      choques: [...new Set([...(previo?.choques ?? []), ...r.choques])],
    });
  }

  /**
   * Guarda los cambios.
   *
   * Un cambio WARM cancela y vuelve a tender la escalera. La API lo rechaza con
   * un 409 la primera vez y devuelve exactamente que campos cambiarían; aquí se
   * traduce en una pregunta con esa lista antes de reintentar confirmando. El
   * usuario no descubre que sus órdenes se han movido después de que pase.
   */
  async save(confirmRelayout = false): Promise<void> {
    if (!this.dirty()) return;
    this.saving.set(true);
    // Lo que se manda, y la versión sobre la que está: si el bot cambió desde la
    // última lectura, la API lo rechaza en vez de deshacer lo que cambió
    // (spec 055, H-05).
    const enviado = this.draft();
    const version = this.borradorBase();
    const generacion = this.generacionBorrador;

    try {
      const result = await this.bots.updateConfig(this.id, enviado, confirmRelayout, version);
      // Si mientras tanto el borrador volvió a nacer —«Descartar», una
      // recolocación—, lo enviado ya no es su base (spec 056, A-8).
      const mismoBorrador = generacion === this.generacionBorrador;
      if (!result.applied) {
        // Para el servidor no hay nada que cambiar: el borrador vuelve a lo
        // guardado, o la barra seguía ofreciendo guardar lo mismo (spec 056, A-1).
        const b = this.bot();
        if (mismoBorrador && b) this.anclarBorrador(b.config, b.config_version);
        await this.toast.show(result.message ?? 'Sin cambios.');
        return;
      }
      // Lo que se acaba de guardar ES la base del borrador: la recarga lo ancla a
      // lo que devuelve el servidor, con sus valores normalizados. Antes del
      // aviso, y no después: mientras se ve, puede llegar el evento del propio
      // guardado, y con la base vieja parecería un cambio de otro.
      if (mismoBorrador && result.version !== undefined) {
        this.configBase.set({ ...enviado });
        this.borradorBase.set(result.version);
        this.cambioDebajo.set(null);
      }
      const nivel =
        result.level === 'HOT'
          ? 'Se aplicará en el próximo ciclo; la posición no se toca.'
          : 'Se cancelan y vuelven a tender las órdenes; la posición sigue abierta.';
      await this.toast.success(`Configuración v${result.version} guardada. ${nivel}`);
      await this.load(false);
    } catch (e) {
      const parsed = parseHttpError(e);

      // El bot cambió justo entre la última lectura y el guardado. La recarga
      // recoloca el borrador sobre la versión nueva, con solo lo editado; no se
      // reintenta sola: lo que cambió puede ser justo lo que se estaba mirando.
      if (parsed.code === 'STALE_VERSION') {
        await this.load(false);
        await this.toast.warn(
          'La configuración cambió mientras guardabas. Tus cambios siguen en el formulario, ' +
            'sobre la versión nueva: revísalos y vuelve a guardar.',
        );
        return;
      }

      if (parsed.requiresConfirmation && !confirmRelayout) {
        // Con la lista de lo que cambia, que el 409 trae: es lo que se confirma
        // (spec 056, A-2).
        const changed = parsed.changed.length
          ? parsed.changed.map((c) => this.cambioTexto(c)).join('\n')
          : parsed.issues.length
            ? parsed.issues.map((i) => i.message).join('\n')
            : 'Se recolocarán las órdenes del bot.';
        const alert = await this.alerts.create({
          header: 'Este cambio recoloca las órdenes',
          message: `${parsed.message}\n\n${changed}`,
          // Los saltos de línea de la lista se respetan (`global.scss`).
          cssClass: 'bd-alert-lista',
          buttons: [
            { text: 'Cancelar', role: 'cancel' },
            { text: 'Aplicar', handler: () => void this.save(true) },
          ],
        });
        await alert.present();
        return;
      }

      if (parsed.coldFields.length > 0) {
        await this.toast.error(
          `Estos campos no se pueden cambiar en un bot ya creado: ${parsed.coldFields.join(', ')}. Para el bot y crea uno nuevo.`,
        );
        return;
      }

      await this.toast.error(errorText(e));
    } finally {
      this.saving.set(false);
    }
  }

  /**
   * Menú de comandos de ejecución. Es el MISMO servicio que usa el gráfico
   * (spec 005, R-4): una lista de comandos y unas confirmaciones, no dos.
   */
  async openCommands(): Promise<void> {
    await this.commands.open(this.id, {
      onSent: () => this.load(false),
      strategy: this.bot()?.strategy,
    });
  }

  async start(): Promise<void> {
    await this.commands.run(this.id, 'START', { onSent: () => this.load(false) });
  }

  // ═══════════════════════════════════════════════════════════════
  // Ajuste de margen
  // ═══════════════════════════════════════════════════════════════

  // Sincrono a proposito: solo lo llama la plantilla. El saldo lo pide la hoja
  // al abrirse, no esta pantalla.
  openMarginSheet(): void {
    this.marginOpen.set(true);
  }

  /** Tras un comando o un ajuste enviado desde una hoja compartida. */
  refreshAfterAction(): void {
    void this.load(false);
  }

  async remove(): Promise<void> {
    const alert = await this.alerts.create({
      header: 'Eliminar bot',
      message: 'Se borra el bot y todo su histórico. La posición en el exchange no se toca.',
      buttons: [
        { text: 'Cancelar', role: 'cancel' },
        {
          text: 'Eliminar',
          role: 'destructive',
          handler: () => {
            void (async () => {
              try {
                await this.bots.remove(this.id);
                await this.bots.refresh();
                await this.router.navigateByUrl('/tabs/bots', { replaceUrl: true });
              } catch (e) {
                await this.toast.error(errorText(e));
              }
            })();
          },
        },
      ],
    });
    await alert.present();
  }

  /**
   * Publica o retira el bot del ranking.
   *
   * Se recarga el detalle en vez de darlo por hecho: el estado que manda es el
   * del servidor, que además puede rechazar la publicación por ser una
   * simulación o un bot de testnet.
   */
  async alternarPublicacion(): Promise<void> {
    const estabaPublicado = this.publicado();
    this.publicando.set(true);
    try {
      if (estabaPublicado) {
        await this.leaderboard.unshare(this.id);
        await this.toast.success('Retirado del ranking.');
      } else {
        await this.leaderboard.share(this.id);
        await this.toast.success(
          this.demasiadoJoven()
            ? 'Publicado. Aparecerá en el ranking al cumplir 6 horas.'
            : 'Publicado en el ranking.',
        );
      }
      await this.load(false);
    } catch (e) {
      await this.toast.error(errorText(e));
    } finally {
      this.publicando.set(false);
    }
  }

  isLive(): boolean {
    const status = this.bot()?.status;
    return status === 'RUNNING' || status === 'STARTING' || status === 'PAUSED';
  }

  /**
   * La serie según la ventana elegida. Sin rango es el endpoint de siempre; con
   * él, el servidor agrega y conserva los extremos de cada cubo, y aquí se
   * recuerda ese cubo para romper la línea solo donde de verdad hay hueco.
   *
   * Se vuelve a pedir como mucho una vez por cadencia: la tabla escribe una
   * fila por minuto y un market maker dispara un refresco cada segundo y medio,
   * así que 39 de cada 40 descargas eran idénticas. Y si mientras se pedía el
   * usuario cambió de ventana, lo que llega es de otra y se descarta.
   */
  private async cargarSerie(forzar = false): Promise<BotSnapshot[]> {
    const r = this.rango();
    if (!forzar && Date.now() - this.serieCargadaEn < SNAPSHOT_CADENCE_MS) return this.snapshots();
    const hasta = Date.now();
    const serie =
      r === '8h'
        ? await this.bots.snapshots(this.id)
        : await this.bots.snapshotsEnRango(this.id, hasta - RANGO_MS[r], hasta);
    if (this.rango() !== r) return this.snapshots();
    this.serieBucket.set(
      r === '8h'
        ? SNAPSHOT_CADENCE_MS
        : bucketMsFor(alMinuto(hasta - RANGO_MS[r]), alMinuto(hasta), SERIES_POINTS / 4),
    );
    this.serieCargadaEn = Date.now();
    return serie;
  }

  /** Cambia la ventana y vuelve a pedir solo la serie: el resto no cambia. */
  async setRango(r: Rango): Promise<void> {
    if (r === this.rango()) return;
    this.rango.set(r);
    const serie = await this.cargarSerie(true).catch((): BotSnapshot[] | null => null);
    if (serie !== null && this.rango() === r) this.snapshots.set(serie);
  }

  /** Duración legible a partir de milisegundos. */
  dur(ms: number | null): string {
    return ms === null ? '—' : uptime(Math.round(ms / 1000));
  }
}

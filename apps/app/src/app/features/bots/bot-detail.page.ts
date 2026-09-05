import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
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
  repartoDeEjecucion,
  resumenDeCiclos,
  aCsv,
  cronologiaPorCiclo,
  sumaExacta,
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

  /** true si algún campo editable ha cambiado respecto de lo guardado. */
  readonly dirty = computed(() => {
    const original = this.bot()?.config ?? {};
    const current = this.draft();
    return Object.keys(current).some(
      (k) => textoDeConfig(current[k]) !== textoDeConfig(original[k]),
    );
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
  }

  async ngOnInit(): Promise<void> {
    this.id = this.route.snapshot.paramMap.get('id') ?? '';
    await this.load(true);
  }

  private async load(withSpinner: boolean): Promise<void> {
    if (withSpinner) this.loading.set(true);
    try {
      const detail = await this.bots.detail(this.id);
      this.bot.set(detail);
      // El borrador solo se reinicia si el usuario no tiene cambios sin
      // guardar: refrescar por un evento no debe borrarle lo que estaba
      // escribiendo.
      if (!this.dirty()) this.draft.set({ ...detail.config });
      // La serie y los ciclos van con `catch`: son analítica, y si fallan la
      // pantalla se pinta igual con lo que sí llegó.
      const [orders, events, snapshots, cycles, revisions] = await Promise.all([
        this.bots.orders(this.id, 60),
        this.bots.events(this.id, 60),
        this.cargarSerie().catch((): BotSnapshot[] => []),
        this.bots.cycles(this.id, 60).catch((): BotCycle[] => []),
        this.bots.revisions(this.id).catch((): BotConfigRevision[] => []),
      ]);
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
    this.draft.update((d) => ({ ...d, [key]: value }));
  }

  discard(): void {
    this.draft.set({ ...(this.bot()?.config as Record<string, unknown>) });
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

    try {
      const result = await this.bots.updateConfig(this.id, this.draft(), confirmRelayout);
      if (!result.applied) {
        await this.toast.show(result.message ?? 'Sin cambios.');
        return;
      }
      const nivel =
        result.level === 'HOT'
          ? 'Se aplicará en el próximo ciclo; la posición no se toca.'
          : 'Se cancelan y vuelven a tender las órdenes; la posición sigue abierta.';
      await this.toast.success(`Configuración v${result.version} guardada. ${nivel}`);
      await this.load(false);
    } catch (e) {
      const parsed = parseHttpError(e);

      if (parsed.requiresConfirmation && !confirmRelayout) {
        const changed = parsed.issues.length
          ? parsed.issues.map((i) => i.message).join('\n')
          : 'Se recolocarán las órdenes del bot.';
        const alert = await this.alerts.create({
          header: 'Este cambio recoloca las órdenes',
          message: `${parsed.message}\n\n${changed}`,
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
    await this.commands.open(this.id, { onSent: () => this.load(false) });
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

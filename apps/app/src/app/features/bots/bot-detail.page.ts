import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import {
  ActionSheetController,
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
  IonModal,
  IonSegment,
  IonSegmentButton,
  IonSpinner,
  IonTitle,
  IonToggle,
  IonToolbar,
} from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import {
  chevronForwardOutline,
  closeOutline,
  ellipsisVertical,
  flaskOutline,
  shieldOutline,
  statsChartOutline,
  trophyOutline,
  warningOutline,
} from 'ionicons/icons';
import type { FieldMeta } from '@crypton/shared';
import { AuthService } from '../../core/auth';
import {
  BotsService,
  LeaderboardService,
  StreamService,
  ToastService,
  WalletService,
} from '../../core/services';
import type {
  BotCommand,
  BotDetail,
  BotEvent,
  BotOrder,
  MarginAction,
  MarketMakerStats,
} from '../../core/models';
import { DESTRUCTIVE_COMMANDS } from '../../core/models';
import {
  errorText,
  fieldLabel,
  isMarketMaker,
  money,
  optionLabel,
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
} from '../../core/utils';
import {
  UiBadgeComponent,
  UiCardComponent,
  UiCollapsibleComponent,
  UiFieldComponent,
  UiMutabilityBadgeComponent,
  UiNoticeComponent,
  UiStatComponent,
  UiStatusPillComponent,
  UiStrategyHelpComponent,
} from '../../shared/ui';

type Tab = 'resumen' | 'escalera' | 'ordenes' | 'ajustes' | 'eventos';

/** Etiquetas de los comandos, en el orden en que se ofrecen. */
const COMMAND_LABELS: { command: BotCommand; label: string; role?: 'destructive' }[] = [
  // Reparar va primero y sin rol destructivo a propósito: es lo que se busca
  // cuando algo «se ve raro», y no toca ni el libro ni la posición.
  { command: 'REPAIR', label: 'Reparar (resincronizar con el exchange)' },
  { command: 'PAUSE', label: 'Pausar (mantiene la posición)' },
  { command: 'RESUME', label: 'Reanudar' },
  { command: 'CANCEL_ALL_ORDERS', label: 'Cancelar todas las órdenes' },
  { command: 'ADD_SAFETY_NOW', label: 'Adelantar orden de seguridad' },
  { command: 'REANCHOR_GRID', label: 'Recentrar la retícula' },
  { command: 'TAKE_PROFIT_NOW', label: 'Tomar beneficio ya', role: 'destructive' },
  { command: 'CLOSE_NOW', label: 'Cerrar posición ya', role: 'destructive' },
  { command: 'STOP_KEEP_POSITION', label: 'Parar conservando la posición' },
  { command: 'STOP_AND_CLOSE', label: 'Parar y cerrar', role: 'destructive' },
  { command: 'PANIC', label: 'PÁNICO: cancelar y cerrar todo', role: 'destructive' },
];

@Component({
  selector: 'app-bot-detail',
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
    IonModal,
    IonSegment,
    IonSegmentButton,
    IonList,
    IonItem,
    IonLabel,
    IonNote,
    IonSpinner,
    IonToggle,
    UiBadgeComponent,
    UiCardComponent,
    UiCollapsibleComponent,
    UiFieldComponent,
    UiMutabilityBadgeComponent,
    UiNoticeComponent,
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
  private readonly sheets = inject(ActionSheetController);
  private readonly alerts = inject(AlertController);
  private readonly leaderboard = inject(LeaderboardService);
  private readonly auth = inject(AuthService);
  private readonly wallet = inject(WalletService);

  readonly bot = signal<BotDetail | null>(null);
  readonly orders = signal<BotOrder[]>([]);
  readonly events = signal<BotEvent[]>([]);
  readonly tab = signal<Tab>('resumen');
  readonly saving = signal(false);
  readonly publicando = signal(false);
  readonly loading = signal(true);
  /** Ficha de market making. null mientras no se ha pedido o no aplica. */
  readonly mmStats = signal<MarketMakerStats | null>(null);

  /** Copia editable de la configuración. No se toca `bot().config` hasta guardar. */
  readonly draft = signal<Record<string, unknown>>({});

  // ── Ajuste de margen de la posición aislada ───────────────────
  readonly marginOpen = signal(false);
  readonly marginAction = signal<MarginAction>('ADD');
  readonly marginAmount = signal('');
  /**
   * Interruptor de contabilidad. Arranca APAGADO siempre, y a propósito: el
   * efecto que la gente busca —alejar la liquidación— lo da la transferencia
   * sola, y encenderlo retiende la escalera. Que el efecto extra haya que
   * pedirlo es la diferencia entre una casilla y una sorpresa.
   */
  readonly marginCountAsCapital = signal(false);
  readonly marginBusy = signal(false);

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

  /** Margen libre de la conexión del bot. `null` = no se pudo leer. */
  readonly freeMargin = computed(() => {
    const b = this.bot();
    if (!b) return null;
    return this.wallet.of(b.exchange_account_id, b.id)?.available ?? null;
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
   * Reparto de las ejecuciones entre maker y taker, en %.
   *
   * Es la cifra que dice si el bot está haciendo su trabajo: un market maker
   * que cruza el libro paga comisión de taker y se queda sin el diferencial que
   * justifica la estrategia. El dato estaba en la base desde siempre —cada fill
   * guarda `is_taker`— y no se agregaba en ninguna parte.
   */
  readonly makerPct = computed(() => {
    const st = this.mmStats();
    if (!st || st.fills === 0) return null;
    return ((st.makerFills / st.fills) * 100).toFixed(1) + ' %';
  });

  /**
   * Rol de administrador. Solo decide si se PINTA el atajo al backtest.
   *
   * La app esconde lo que no va a funcionar, pero quien decide de verdad es el
   * servidor.
   */
  readonly esAdmin = computed(() => this.auth.user()?.role === 'ADMIN');
  readonly publicado = computed(() => this.bot()?.share?.public === true);
  /** El ranking exige 6 h de recorrido: se publica igual, pero no aparece aún. */
  readonly demasiadoJoven = computed(() => (this.bot()?.uptimeSeconds ?? 0) < 6 * 3600);

  /** true si algún campo editable ha cambiado respecto de lo guardado. */
  readonly dirty = computed(() => {
    const original = this.bot()?.config ?? {};
    const current = this.draft();
    return Object.keys(current).some((k) => String(current[k] ?? '') !== String(original[k] ?? ''));
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
    });
    // Cualquier evento de ESTE bot refresca la pantalla.
    //
    // Con `takeUntilDestroyed`, y no es cosmetico: `bots/:id` es una ruta raiz
    // que Ionic DESTRUYE al salir, pero la suscripcion se quedaba viva dentro
    // del `Subject` del servicio, que dura toda la sesion. Visitar diez veces el
    // mismo bot dejaba diez suscripciones con el mismo `id`, y un solo evento de
    // ese bot disparaba DIEZ peticiones identicas a la API. Crecia con el uso.
    this.stream.stream.pipe(takeUntilDestroyed()).subscribe((ev) => {
      if (ev.botId === this.id) void this.load(false);
    });
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
      if (!this.dirty()) this.draft.set({ ...(detail.config as Record<string, unknown>) });
      const [orders, events] = await Promise.all([
        this.bots.orders(this.id, 60),
        this.bots.events(this.id, 60),
      ]);
      this.orders.set(orders);
      this.events.set(events);

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
    if (field.kind === 'enum') return optionLabel(String(raw), field.labelKey);
    return String(raw);
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

  /** Menú de comandos de ejecución. */
  async openCommands(): Promise<void> {
    const sheet = await this.sheets.create({
      header: 'Acciones del bot',
      buttons: [
        ...COMMAND_LABELS.map((c) => ({
          text: c.label,
          role: c.role,
          handler: () => void this.runCommand(c.command),
        })),
        { text: 'Cerrar', role: 'cancel' },
      ],
    });
    await sheet.present();
  }

  async start(): Promise<void> {
    await this.runCommand('START');
  }

  // ═══════════════════════════════════════════════════════════════
  // Ajuste de margen
  // ═══════════════════════════════════════════════════════════════

  async openMarginSheet(): Promise<void> {
    this.marginAction.set('ADD');
    this.marginAmount.set('');
    this.marginCountAsCapital.set(false);
    this.marginOpen.set(true);

    // El saldo se pide al abrir y no al cargar la pantalla: es una lectura
    // contra el venue y la inmensa mayoría de las visitas al detalle no van a
    // ajustar margen. No se espera ni se bloquea nada por ella — si no llega,
    // la hoja funciona igual y sin los atajos de porcentaje.
    const b = this.bot();
    // Con el bot: si su conexion es de simulacion, el saldo que cuenta es el de
    // SU sandbox, no el capital de partida de la conexion.
    if (b) {
      void this.wallet.load(b.exchange_account_id, b.symbol, { force: true, botId: b.id });
    }
  }

  closeMarginSheet(): void {
    this.marginOpen.set(false);
  }

  /** Rellena el importe con una fracción del margen libre. */
  fillMargin(fraction: number): void {
    const free = this.freeMargin();
    if (!free) return;
    this.marginAmount.set(String(Math.floor(Number(free) * fraction * 100) / 100));
  }

  async submitMargin(): Promise<void> {
    const amount = this.marginAmount().trim();
    if (!amount || !(Number(amount) > 0)) {
      await this.toast.error('Escribe un importe mayor que cero.');
      return;
    }

    // Retirar ACERCA la liquidación: es la operación inversa a la que se viene
    // buscando, así que se pregunta aquí además de en la API.
    if (this.marginAction() === 'REMOVE') {
      const alert = await this.alerts.create({
        header: '¿Retirar margen?',
        message:
          'Sacar colateral de esta posición ACERCA su precio de liquidación. ' +
          'Si el mercado se mueve en contra, se liquidará antes.',
        buttons: [
          { text: 'Cancelar', role: 'cancel' },
          {
            text: 'Retirar',
            role: 'destructive',
            handler: () => void this.sendMargin(amount),
          },
        ],
      });
      await alert.present();
      return;
    }
    await this.sendMargin(amount);
  }

  private async sendMargin(amount: string): Promise<void> {
    this.marginBusy.set(true);
    try {
      const action = this.marginAction();
      await this.bots.adjustMargin(this.id, {
        amount,
        action,
        countAsBotCapital: this.marginCountAsCapital(),
      });
      this.marginOpen.set(false);
      // «Enviado» y no «aplicado»: quien habla con el venue es el worker, y el
      // resultado real —con la liquidación de antes y de después— aparece en la
      // bitácora del bot cuando el comando se ejecuta.
      await this.toast.success(
        action === 'ADD'
          ? 'Aporte de margen enviado. Verás el nuevo precio de liquidación en los eventos.'
          : 'Retirada de margen enviada.',
      );
      await this.load(false);
    } catch (e) {
      await this.toast.error(errorText(e));
    } finally {
      this.marginBusy.set(false);
    }
  }

  private async runCommand(command: BotCommand): Promise<void> {
    // Los comandos que cierran a mercado realizan el resultado al instante y no
    // se pueden deshacer: se pregunta SIEMPRE, aunque la API también lo exija.
    if (DESTRUCTIVE_COMMANDS.includes(command)) {
      const alert = await this.alerts.create({
        header: '¿Seguro?',
        message:
          'Esta acción cierra la posición a mercado y realiza el resultado al instante. No se puede deshacer.',
        buttons: [
          { text: 'Cancelar', role: 'cancel' },
          {
            text: 'Confirmar',
            role: 'destructive',
            handler: () => void this.send(command, true),
          },
        ],
      });
      await alert.present();
      return;
    }
    await this.send(command, false);
  }

  private async send(command: BotCommand, confirm: boolean): Promise<void> {
    try {
      await this.bots.command(this.id, command, confirm);
      await this.toast.success(`Comando ${command} enviado.`);
      await this.load(false);
    } catch (e) {
      await this.toast.error(errorText(e));
    }
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
}

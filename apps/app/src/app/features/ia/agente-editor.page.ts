import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import {
  IonBackButton,
  IonButton,
  IonButtons,
  IonCheckbox,
  IonContent,
  IonHeader,
  IonInput,
  IonSegment,
  IonSegmentButton,
  IonSpinner,
  IonTitle,
  IonToggle,
  IonToolbar,
  NavController,
} from '@ionic/angular/standalone';
import {
  AUTONOMIA_DE_FABRICA,
  FAMILIAS_AGENTE,
  INTERVALOS_AGENTE,
  ModoDecision,
  type AiMode,
  type AutonomiaAgente,
  type DefinicionAgenteEntrada,
  type FamiliaAgente,
  type IntervaloAgente,
  type LimitesAgente,
  type PositionSide,
} from '@crypton/shared';
import {
  DEFAULTS_AGENTE,
  NOMBRES_LIMITES_AGENTE,
  peorDiaAgente,
  validarLimitesAgente,
} from '@crypton/strategy-core';
import type { ExchangeAccount, Market } from '../../core/models';
import { ExchangeAccountsService, MarketsService, ToastService } from '../../core/services';
import { AgentesIaService } from '../../core/services/agentes-ia.service';
import { errorText, money, venueLabel } from '../../core/utils';
import {
  AUTONOMIA,
  AYUDA_LIMITES,
  FAMILIA,
  FAMILIA_AYUDA,
  LIMITES_ENTEROS,
  erroresAgente,
} from '../../core/utils/agentes-ia';
import { motivoValido } from '../../shared/bot/motivo';
import {
  UiCardComponent,
  UiCollapsibleComponent,
  UiNoticeComponent,
  UiPairSheetComponent,
} from '../../shared/ui';
import { AdminForbiddenComponent } from '../admin/admin-forbidden.component';
import { LimiteCampoComponent } from './limite-campo.component';

type Clase = keyof AutonomiaAgente;
type ClaveLimite = keyof LimitesAgente;

/** Los límites que se ven de entrada; el resto, bajo «Más límites». */
const LIMITES_PRINCIPALES: readonly ClaveLimite[] = [
  'capital',
  'riesgoPct',
  'perdidaDiariaPct',
  'maxVivas',
  'maxOperacionesDia',
  'apalancamientoMax',
];
const LIMITES_MAS: readonly ClaveLimite[] = [
  'margenPct',
  'maxStopPct',
  'maxCosteR',
  'minObjetivoCoste',
  'minObjetivoPct',
  'minRR',
  'fraccionTp1Pct',
  'maxVelasOperacion',
  'esperaStopMin',
  'maxPerdidasSeguidas',
  'esperaRachaMin',
];
const LIMITES_PRESUPUESTO: readonly ClaveLimite[] = ['consultasDia', 'gastoDiaUsd'];

/** Los límites mientras se editan: todo texto, salvo el interruptor del breakeven. */
type LimitesEnEdicion = Record<Exclude<ClaveLimite, 'breakevenTrasTp1'>, string> & {
  breakevenTrasTp1: boolean;
};

const esUsable = (c: ExchangeAccount): boolean =>
  c.paper || c.status === 'VERIFIED' || c.status === 'ACTIVE';

const esReal = (c: ExchangeAccount): boolean => !c.paper && !c.testnet;

/** De los límites guardados —o los de fábrica— a los del formulario. */
function limitesEnEdicion(
  l: Omit<LimitesAgente, 'capital'> & { capital?: string },
): LimitesEnEdicion {
  const out = {} as Record<string, string | boolean>;
  for (const [k, v] of Object.entries(l)) out[k] = typeof v === 'boolean' ? v : String(v);
  // Frontera del formulario: se acaban de copiar todos los campos, uno a uno.
  return { capital: '', ...out } as LimitesEnEdicion;
}

/**
 * El editor de un agente (spec 074), para crearlo y para editarlo, a pantalla
 * completa como el asistente de bots.
 *
 * Cada sección dice cuándo vale lo que se cambia: la cuenta es fija tras
 * crearlo; lo que mira y sus límites valen para los próximos análisis —lo que
 * ya está abierto sigue con su plan—; la autonomía vale ya. Guardar descarta
 * las propuestas que esperaban, que se calcularon con lo de antes.
 *
 * Valida aquí con la misma función que el servidor (`validarLimitesAgente`),
 * para decirlo al lado de cada campo; el servidor lo vuelve a validar entero.
 * En una cuenta real, crear —o pasar «entrar» a automático— pide marcar el
 * consentimiento: el servidor lo exige igual.
 */
@Component({
  selector: 'app-agente-editor',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    IonBackButton,
    IonButton,
    IonButtons,
    IonCheckbox,
    IonContent,
    IonHeader,
    IonInput,
    IonSegment,
    IonSegmentButton,
    IonSpinner,
    IonTitle,
    IonToggle,
    IonToolbar,
    UiCardComponent,
    UiCollapsibleComponent,
    UiNoticeComponent,
    UiPairSheetComponent,
    AdminForbiddenComponent,
    LimiteCampoComponent,
  ],
  templateUrl: './agente-editor.page.html',
  styles: [
    `
      .cuando {
        margin: calc(-1 * var(--space-1)) 0 var(--space-2);
        font-size: 11px;
        color: var(--text-3);
      }

      .peor {
        margin: calc(-1 * var(--space-2)) 0 var(--space-3);
      }

      .guardar {
        margin-top: var(--space-4);
      }
    `,
  ],
})
export class AgenteEditorPage implements OnInit {
  private readonly servicio = inject(AgentesIaService);
  private readonly cuentasSvc = inject(ExchangeAccountsService);
  private readonly marketsSvc = inject(MarketsService);
  private readonly toast = inject(ToastService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly nav = inject(NavController);

  /** El agente que se edita; null al crear. */
  readonly id = this.route.snapshot.paramMap.get('id');
  readonly creando = this.id === null;

  readonly cargando = signal(!this.creando);
  readonly prohibido = signal(false);
  readonly guardando = signal(false);
  readonly error = signal<string | null>(null);
  /** Los errores del servidor, por campo (`pares`, `limites.riesgoPct`…). */
  readonly erroresServidor = signal<ReadonlyMap<string, string>>(new Map());

  // ── El formulario ────────────────────────────────────────────────────────
  readonly nombre = signal('');
  readonly cuentaId = signal('');
  readonly pares = signal<string[]>([]);
  readonly intervalo = signal<IntervaloAgente>('1h');
  readonly familias = signal<FamiliaAgente[]>([...FAMILIAS_AGENTE]);
  readonly lados = signal<PositionSide[]>(['LONG', 'SHORT']);
  readonly modo = signal<ModoDecision>(ModoDecision.IA);
  readonly limites = signal<LimitesEnEdicion>(limitesEnEdicion(DEFAULTS_AGENTE));
  readonly autonomia = signal<AutonomiaAgente>({ ...AUTONOMIA_DE_FABRICA });
  readonly consentimiento = signal(false);
  readonly motivo = signal('');

  /** Lo guardado, al editar: la versión y si «entrar» ya era automático. */
  private version = 0;
  private entrarGuardado: AiMode | null = null;

  // ── Lo de alrededor ──────────────────────────────────────────────────────
  readonly mercados = signal<Market[]>([]);
  readonly hojaPares = signal(false);

  readonly INTERVALOS = INTERVALOS_AGENTE;
  readonly FAMILIAS = FAMILIAS_AGENTE;
  readonly FAMILIA = FAMILIA;
  readonly FAMILIA_AYUDA = FAMILIA_AYUDA;
  readonly AUTONOMIA = AUTONOMIA;
  readonly CLASES: readonly Clase[] = ['entrar', 'reducir', 'cerrar'];
  readonly NOMBRES = NOMBRES_LIMITES_AGENTE;
  readonly AYUDA = AYUDA_LIMITES;
  readonly PRINCIPALES = LIMITES_PRINCIPALES;
  readonly MAS = LIMITES_MAS;
  readonly PRESUPUESTO = LIMITES_PRESUPUESTO;
  readonly venueLabel = venueLabel;

  readonly cuentas = computed(() => this.cuentasSvc.accounts().filter(esUsable));
  readonly cuenta = computed(
    () => this.cuentasSvc.accounts().find((c) => c.id === this.cuentaId()) ?? null,
  );
  readonly real = computed(() => {
    const c = this.cuenta();
    return c !== null && esReal(c);
  });
  readonly maxPares = computed(() => this.servicio.resumen()?.maxPares ?? 12);

  /** Los límites como los guarda el servidor: enteros como número, decimales como texto. */
  readonly limitesTipados = computed<LimitesAgente>(() => {
    const l = this.limites();
    const out: Record<string, string | number | boolean> = { ...l };
    for (const k of LIMITES_ENTEROS) {
      const n = Number(l[k]);
      out[k] = l[k].trim() !== '' && Number.isFinite(n) ? n : l[k];
    }
    // Frontera del formulario: la validación de abajo mira cada campo con su tipo.
    return out as unknown as LimitesAgente;
  });

  /** Los errores de los límites, con la misma regla que el servidor. */
  readonly erroresLimites = computed<ReadonlyMap<string, string>>(
    () => new Map(validarLimitesAgente(this.limitesTipados()).map((e) => [e.campo, e.mensaje])),
  );

  /** Lo más que puede perder en un día, con los límites de la pantalla. */
  readonly peorDia = computed(() => {
    const l = this.limites();
    try {
      return money(peorDiaAgente({ capital: l.capital, perdidaDiariaPct: l.perdidaDiariaPct }));
    } catch {
      return '—';
    }
  });

  /** En una cuenta real: al crear, o al pasar «entrar» a automático. */
  readonly pideConsentimiento = computed(
    () =>
      this.real() &&
      (this.creando || (this.autonomia().entrar === 'AUTO' && this.entrarGuardado !== 'AUTO')),
  );

  readonly puedeGuardar = computed(
    () =>
      !this.guardando() &&
      this.nombre().trim().length > 0 &&
      this.cuentaId() !== '' &&
      this.pares().length > 0 &&
      this.familias().length > 0 &&
      this.lados().length > 0 &&
      this.erroresLimites().size === 0 &&
      motivoValido(this.motivo()) !== null &&
      (!this.pideConsentimiento() || this.consentimiento()),
  );

  async ngOnInit(): Promise<void> {
    await this.cuentasSvc.refresh().catch(() => undefined);
    if (this.creando) {
      const primera = this.cuentas()[0];
      if (primera) await this.elegirCuenta(primera.id);
      return;
    }
    try {
      const { agente } = await this.servicio.detalle(this.id ?? '');
      this.nombre.set(agente.nombre);
      this.cuentaId.set(agente.cuenta.id);
      this.pares.set([...agente.pares]);
      this.intervalo.set(agente.intervalo);
      this.familias.set([...agente.familias]);
      this.lados.set([...agente.lados]);
      this.modo.set(agente.modo);
      this.limites.set(limitesEnEdicion(agente.limites));
      this.autonomia.set({ ...agente.autonomia });
      this.version = agente.version;
      this.entrarGuardado = agente.autonomia.entrar;
      await this.cargarMercados();
    } catch (e) {
      if ((e as { status?: number }).status === 403) this.prohibido.set(true);
      else this.error.set(errorText(e));
    } finally {
      this.cargando.set(false);
    }
  }

  // ── Lo que cambia el formulario ──────────────────────────────────────────

  async elegirCuenta(id: string): Promise<void> {
    if (!this.creando) return;
    const cambia = id !== this.cuentaId();
    this.cuentaId.set(id);
    // Los pares son de un venue y una red: al cambiar de cuenta ya no valen.
    if (cambia) this.pares.set([]);
    await this.cargarMercados();
  }

  private async cargarMercados(): Promise<void> {
    const c = this.cuenta();
    if (!c) return;
    try {
      this.mercados.set(await this.marketsSvc.list(c.venue, undefined, c.testnet));
    } catch (e) {
      this.error.set(errorText(e));
    }
  }

  alternarFamilia(f: FamiliaAgente): void {
    const lista = this.familias();
    this.familias.set(lista.includes(f) ? lista.filter((x) => x !== f) : [...lista, f]);
  }

  alternarLado(l: PositionSide): void {
    const lista = this.lados();
    this.lados.set(lista.includes(l) ? lista.filter((x) => x !== l) : [...lista, l]);
  }

  quitarPar(p: string): void {
    this.pares.set(this.pares().filter((x) => x !== p));
  }

  fijarLimite(k: ClaveLimite, v: string | boolean): void {
    this.limites.set({ ...this.limites(), [k]: v });
  }

  fijarAutonomia(clase: Clase, v: string): void {
    this.autonomia.set({ ...this.autonomia(), [clase]: v as AiMode });
  }

  textoLimite(k: ClaveLimite): string {
    const v = this.limites()[k];
    return typeof v === 'boolean' ? '' : v;
  }

  /** El error de un campo: el de la pantalla o, si no, el del servidor. */
  errorDe(campo: string): string {
    const local = campo.startsWith('limites.')
      ? this.erroresLimites().get(campo.slice('limites.'.length))
      : undefined;
    return local ?? this.erroresServidor().get(campo) ?? '';
  }

  // ── Guardar ──────────────────────────────────────────────────────────────

  async guardar(): Promise<void> {
    const reason = motivoValido(this.motivo());
    if (!this.puedeGuardar() || !reason) return;
    this.guardando.set(true);
    this.error.set(null);
    this.erroresServidor.set(new Map());
    const definicion: DefinicionAgenteEntrada = {
      nombre: this.nombre().trim(),
      pares: this.pares(),
      intervalo: this.intervalo(),
      familias: this.familias(),
      lados: this.lados(),
      modo: this.modo(),
      limites: this.limitesTipados(),
      autonomia: this.autonomia(),
      ...(this.pideConsentimiento() ? { consentimiento: true } : {}),
      reason,
    };
    try {
      const agente = this.creando
        ? await this.servicio.crear({ ...definicion, exchangeAccountId: this.cuentaId() })
        : await this.servicio.editar(this.id ?? '', { ...definicion, version: this.version });
      await this.toast.success(this.creando ? 'Agente creado.' : 'Agente guardado.');
      // Al crear, el detalle nuevo ocupa el sitio del editor; al editar, se
      // vuelve al detalle de debajo, que se recarga solo con el aviso.
      if (this.creando) {
        await this.router.navigate(['/ia/agentes', agente.id], { replaceUrl: true });
      } else {
        await this.nav.navigateBack(['/ia/agentes', agente.id]);
      }
    } catch (e) {
      const errores = erroresAgente(e);
      this.erroresServidor.set(new Map(errores.map((x) => [x.campo, x.mensaje])));
      this.error.set(
        (e as { status?: number }).status === 409
          ? 'El agente ha cambiado desde que lo abriste. Vuelve a abrirlo y repite el cambio.'
          : errorText(e),
      );
    } finally {
      this.guardando.set(false);
    }
  }
}

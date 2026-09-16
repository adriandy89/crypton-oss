import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  input,
  model,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { IonInput, IonSegment, IonSegmentButton, IonToggle } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import {
  informationCircleOutline,
  optionsOutline,
  sparklesOutline,
  warningOutline,
} from 'ionicons/icons';
import { TelegramService } from '../../core/services';
import {
  AI_MODES,
  AI_TRIGGERS,
  AYUDA_DISPARO,
  AYUDA_MODO_IA,
  ETIQUETA_DISPARO,
  ETIQUETA_MODO_IA,
  type AiMode,
  type AiSwitches,
  type AiTrigger,
} from '../../core/services/admin-bots.service';
import { isMarketMaker } from '../../core/utils';
import {
  FALTA_PARA_PROPONER,
  INTERVALO_IA_MAX,
  INTERVALO_IA_MIN,
  INTERVALO_IA_POR_DEFECTO,
  TEXTO_SIN_CANAL,
  aDisparo,
  canalEfectivo,
  minutosValidos,
  propone,
  type BorradorIa,
} from '../../core/utils/modo-ia';
import { MOTIVO_MAXIMO } from './motivo';
import { UiCollapsibleComponent, UiNoticeComponent, UiSettingRowComponent } from '../ui';
import type { StrategyKind } from '../../core/models';

interface AvisoIa {
  tone: 'info' | 'warn' | 'danger';
  icono: string;
  texto: string;
}

const aviso = (tone: AvisoIa['tone'], texto: string): AvisoIa => ({
  tone,
  icono: tone === 'info' ? 'information-circle-outline' : 'warning-outline',
  texto,
});

/**
 * Los mandos del Modo IA de un bot (spec 053).
 *
 * Solo edita un BORRADOR: no guarda nada ni habla con el servidor. Lo usan el
 * panel del bot —que decide cuándo y cómo se guarda— y el asistente de
 * creación —que lo guarda despues de crear el bot—. Por eso el motivo es
 * opcional: el panel lo pide al confirmar, y el asistente, aqui mismo.
 *
 * Los avisos dicen lo que va a pasar DE VERDAD con el modo elegido: con el
 * interruptor del servidor apagado, con «solo simulados» sobre un bot real o con
 * el bot parado, un modo encendido no hace nada, y quien lo enciende tiene que
 * saberlo antes y no deducirlo de que nunca pasa nada.
 */
@Component({
  selector: 'app-modo-ia-editor',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    IonInput,
    IonSegment,
    IonSegmentButton,
    IonToggle,
    UiCollapsibleComponent,
    UiNoticeComponent,
    UiSettingRowComponent,
  ],
  template: `
    <!-- Un grupo de botones que se quedan pulsados, y no un «radiogroup»: ese
         patrón promete moverse con las flechas, y estos se recorren con el
         tabulador (spec 056, A-11). -->
    <div class="modos" role="group" aria-label="Modo IA">
      @for (m of modos(); track m) {
        @let bloqueado = sinCanalPara(m);
        <button
          type="button"
          class="modo"
          [class.sel]="valor().mode === m"
          [attr.aria-pressed]="valor().mode === m"
          [disabled]="deshabilitado() || bloqueado"
          (click)="elegir(m)"
        >
          <span class="modo-t">{{ etiquetaModo(m) }}</span>
          <span class="modo-a">{{ ayudaModo(m) }}</span>
          @if (bloqueado && sinCanal(); as falta) {
            <span class="modo-a falta">
              Necesita {{ faltaParaProponer[falta] }}: es por donde llegan las sugerencias.
            </span>
          }
        </button>
      }
    </div>

    @if (sinCanal(); as falta) {
      @if (valor().mode !== 'AUTO') {
        <p class="fina">
          <a routerLink="/telegram">{{
            falta === 'SIN_TELEGRAM' ? 'Vincular Telegram' : 'Encender los avisos del Modo IA'
          }}</a>
          para usar «propone y espera».
        </p>
      }
    }

    @if (valor().mode !== 'OFF') {
      @if (avisos().length) {
        <div class="avisos">
          @for (a of avisos(); track a.texto) {
            <ui-notice [tone]="a.tone" [icon]="a.icono">{{ a.texto }}</ui-notice>
          }
        </div>
      }

      <ui-collapsible
        class="adv"
        title="Opciones avanzadas"
        icon="options-outline"
        [startOpen]="!minutosOk()"
      >
        <div class="opt">
          <span class="opt-t">Cuándo revisa</span>
          <ion-segment
            [value]="valor().trigger"
            [disabled]="deshabilitado()"
            aria-label="Cuándo revisa"
            (ionChange)="setDisparo($event.detail.value)"
          >
            @for (t of disparos; track t) {
              <ion-segment-button [value]="t">{{ etiquetaDisparo(t) }}</ion-segment-button>
            }
          </ion-segment>
          <p class="opt-a">{{ ayudaDisparo(valor().trigger) }}</p>
          @if (esMarketMaker() && valor().trigger === 'OPERACION') {
            <ui-notice tone="warn" icon="warning-outline">
              Un market maker no cierra ciclos: con «solo eventos» únicamente lo revisarían los
              avisos de riesgo.
            </ui-notice>
          }
        </div>

        <div class="opt">
          <span class="opt-t">Cada cuántos minutos</span>
          <ion-input
            class="campo"
            [class.mal]="!minutosOk()"
            type="number"
            inputmode="numeric"
            step="1"
            [min]="minimo"
            [max]="maximo"
            [placeholder]="'El de la estrategia (' + porDefecto + ')'"
            [value]="valor().reviewEveryMinutes"
            [disabled]="deshabilitado()"
            aria-label="Minutos entre revisiones"
            (ionInput)="setMinutos($event.detail)"
          />
          <p class="opt-a" [class.mal]="!minutosOk()">
            @if (minutosOk()) {
              Entre {{ minimo }} y {{ maximo }}. Vacío, el que recomienda la estrategia. También es
              el mínimo entre dos revisiones por eventos.
            } @else {
              Tiene que ser un número entero entre {{ minimo }} y {{ maximo }}, o quedar vacío.
            }
          </p>
        </div>

        <ui-setting-row
          class="warm"
          title="Puede recolocar las órdenes"
          [subtitle]="
            valor().allowWarm
              ? 'Puede proponer cambios que cancelan y vuelven a tender las órdenes. Cuesta comisiones.'
              : 'Solo propone cambios que no tocan ninguna orden.'
          "
          [link]="false"
        >
          <ion-toggle
            [checked]="valor().allowWarm"
            [disabled]="deshabilitado()"
            aria-label="Puede recolocar las órdenes"
            (ionChange)="setWarm($event.detail.checked)"
          />
        </ui-setting-row>
      </ui-collapsible>

      @if (pedirMotivo()) {
        <div class="opt">
          <span class="opt-t">Motivo <span class="req">*</span></span>
          <ion-input
            class="campo"
            [value]="motivo()"
            [maxlength]="motivoMaximo"
            placeholder="Queda en la bitácora"
            [disabled]="deshabilitado()"
            aria-label="Motivo del Modo IA"
            (ionInput)="motivo.set($any($event.target).value ?? '')"
          />
        </div>
      }
    }
  `,
  styles: [
    `
      :host {
        display: block;
      }

      .modos {
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
      }

      .modo {
        display: flex;
        flex-direction: column;
        gap: 3px;
        padding: var(--space-3);
        text-align: left;
        font-family: var(--font-ui);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-sm);
        background: transparent;
        cursor: pointer;
      }

      .modo:disabled {
        opacity: 0.55;
        cursor: default;
      }

      .modo.sel {
        border-color: var(--brand-2);
        background: rgba(var(--brand-2-rgb), 0.08);
      }

      .modo-t {
        font-size: 13px;
        font-weight: 600;
        color: var(--text-1);
      }

      .modo-a {
        font-size: 11.5px;
        line-height: 1.45;
        color: var(--text-2);
      }

      .falta {
        color: var(--signal-warn);
      }

      .fina {
        margin: var(--space-2) 0 0;
        font-size: 11.5px;
        color: var(--text-3);
      }

      .fina a {
        color: var(--brand-2);
        text-decoration: none;
      }

      .avisos {
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
        margin-top: var(--space-3);
      }

      .adv {
        margin-top: var(--space-2);
      }

      .opt {
        display: flex;
        flex-direction: column;
        gap: 6px;
        margin: var(--space-2) 0 var(--space-3);
      }

      .opt-t {
        font-size: 12px;
        font-weight: 600;
        color: var(--text-2);
      }

      .opt-a {
        margin: 0;
        font-size: 11.5px;
        line-height: 1.45;
        color: var(--text-3);
      }

      .mal {
        color: var(--pnl-down);
      }

      .campo {
        --padding-start: 12px;
        --padding-end: 12px;
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-sm);
      }

      .campo.mal {
        border-color: var(--pnl-down);
      }

      .req {
        color: var(--pnl-down);
      }

      .warm {
        padding-inline: 0;
      }
    `,
  ],
})
export class ModoIaEditorComponent implements OnInit {
  private readonly telegram = inject(TelegramService);

  /** El borrador que se edita. */
  readonly valor = model.required<BorradorIa>();
  /** El motivo, solo si se pide aqui (al crear un bot). */
  readonly motivo = model('');
  readonly pedirMotivo = input(false);
  readonly estrategia = input<StrategyKind | '' | null>(null);
  readonly simulado = input(true);
  readonly enMarcha = input(true);
  readonly interruptores = input<AiSwitches | null>(null);
  /**
   * El modo que el bot tiene GUARDADO, o `null` si aún no existe (al crearlo).
   * Un bot que ya propone y espera puede volver a ese modo aunque haya perdido
   * el canal: el servidor solo exige canal al pasar a él (spec 056, A-10).
   */
  readonly modoGuardado = input<AiMode | null>(null);
  readonly deshabilitado = input(false);
  /** Los modos que se ofrecen. Fuera del alcance, solo apagarlo. */
  readonly modos = input<readonly AiMode[]>(AI_MODES);

  readonly disparos = AI_TRIGGERS;
  readonly minimo = INTERVALO_IA_MIN;
  readonly maximo = INTERVALO_IA_MAX;
  readonly porDefecto = INTERVALO_IA_POR_DEFECTO;
  readonly motivoMaximo = MOTIVO_MAXIMO;

  /**
   * Por qué no llegarían las sugerencias a quien mira (spec 055): su Telegram si
   * se conoce, y si no, lo que dijo el servidor (spec 056, A-4). Sin ninguno de
   * los dos no se bloquea nada por una suposición.
   */
  readonly sinCanal = computed(() => canalEfectivo(this.telegram.status(), this.interruptores()));
  readonly faltaParaProponer = FALTA_PARA_PROPONER;
  readonly minutosOk = computed(() => minutosValidos(this.valor().reviewEveryMinutes));
  readonly esMarketMaker = computed(() => {
    const kind = this.estrategia();
    return !!kind && isMarketMaker(kind);
  });

  /**
   * Lo que va a pasar DE VERDAD con el modo elegido, en el orden en que lo
   * decide el supervisor. Con los interruptores desconocidos no se afirma nada
   * sobre ellos.
   */
  readonly avisos = computed((): AvisoIa[] => {
    const modo = this.valor().mode;
    if (modo === 'OFF') return [];
    const avisos: AvisoIa[] = [];
    const i = this.interruptores();
    if (i && !i.encendido) {
      avisos.push(
        aviso(
          'warn',
          'El supervisor está apagado en el servidor: con este modo no pasará nada hasta que se encienda.',
        ),
      );
    } else if (i?.soloSimulados && !this.simulado()) {
      avisos.push(
        aviso(
          'warn',
          'El servidor solo deja actuar a la IA sobre bots simulados, y este opera con dinero real: no se revisará.',
        ),
      );
    }
    // Sin canal, el supervisor no revisa lo que propone y espera (spec 055).
    const falta = this.sinCanal();
    if (falta && propone(modo, i)) {
      avisos.push(
        aviso(
          'warn',
          `Las sugerencias llegan por Telegram y ${TEXTO_SIN_CANAL[falta]}: el supervisor no ` +
            'revisará este bot hasta que lo arregles.',
        ),
      );
    } else if (i?.forzarManual && modo === 'AUTO') {
      avisos.push(
        aviso(
          'info',
          'El servidor obliga a proponer y esperar: las sugerencias te llegarán por Telegram y no se aplicará nada sola.',
        ),
      );
    }
    if (!this.enMarcha()) {
      avisos.push(aviso('info', 'La IA solo revisa bots en marcha: empezará cuando el bot opere.'));
    }
    if (modo === 'AUTO' && !this.simulado()) {
      avisos.push(
        aviso('danger', 'Dinero real: en este modo la IA aplica los cambios sin preguntarte.'),
      );
    }
    return avisos;
  });

  constructor() {
    addIcons({ informationCircleOutline, optionsOutline, sparklesOutline, warningOutline });
  }

  ngOnInit(): void {
    // En silencio: sin saber si hay Telegram no se bloquea el modo manual, y el
    // servidor lo rechaza igual con un mensaje que lo explica. Siempre, y no
    // solo la primera vez: el dato del cliente manda sobre el del servidor, y
    // leído una vez por sesión se quedaba viejo (spec 056, A-4).
    void this.telegram.refresh().catch(() => undefined);
  }

  etiquetaModo(m: AiMode): string {
    return ETIQUETA_MODO_IA[m];
  }

  ayudaModo(m: AiMode): string {
    return AYUDA_MODO_IA[m];
  }

  etiquetaDisparo(t: AiTrigger): string {
    return ETIQUETA_DISPARO[t];
  }

  ayudaDisparo(t: AiTrigger): string {
    return AYUDA_DISPARO[t];
  }

  /**
   * «Propone y espera» sin canal no llega a ninguna parte, y el servidor rechaza
   * PASAR a él. Se bloquea solo si no es el modo elegido ni el guardado: quien ya
   * lo tiene tiene que poder verlo marcado, cambiarlo y volver a él.
   */
  sinCanalPara(m: AiMode): boolean {
    return (
      m === 'MANUAL' &&
      !!this.sinCanal() &&
      this.valor().mode !== 'MANUAL' &&
      this.modoGuardado() !== 'MANUAL'
    );
  }

  elegir(mode: AiMode): void {
    this.valor.update((v) => ({ ...v, mode }));
  }

  setDisparo(valor: unknown): void {
    if (typeof valor !== 'string') return;
    this.valor.update((v) => ({ ...v, trigger: aDisparo(valor) }));
  }

  /**
   * Vacío es «el de la estrategia». Lo que no es un número se guarda como `NaN`
   * a proposito: deja el borrador invalido —y el guardado bloqueado— en vez de
   * convertirse en silencio en «vacío».
   *
   * Un campo numérico con texto que no es un número entrega `''`, igual que uno
   * vacío: solo `validity.badInput` los distingue. Sin mirarlo, «1e» se
   * guardaba como «el de la estrategia» (spec 056, A-10).
   */
  setMinutos(detalle: { value?: unknown; event?: Event } | null | undefined): void {
    const nativo = detalle?.event?.target;
    if (nativo instanceof HTMLInputElement && nativo.validity.badInput) {
      this.valor.update((v) => ({ ...v, reviewEveryMinutes: Number.NaN }));
      return;
    }
    const texto = detalle?.value;
    const crudo =
      typeof texto === 'number' ? String(texto) : typeof texto === 'string' ? texto : '';
    const reviewEveryMinutes = crudo.trim() === '' ? null : Number(crudo);
    this.valor.update((v) => ({ ...v, reviewEveryMinutes }));
  }

  setWarm(allowWarm: boolean): void {
    this.valor.update((v) => ({ ...v, allowWarm }));
  }
}

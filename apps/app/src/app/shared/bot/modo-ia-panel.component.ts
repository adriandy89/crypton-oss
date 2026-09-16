import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  linkedSignal,
  output,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { IonButton, IonSpinner } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { informationCircleOutline, sparklesOutline, warningOutline } from 'ionicons/icons';
import { TelegramService } from '../../core/services';
import { AI_MODES, type AiMode, type AiSetting } from '../../core/services/admin-bots.service';
import { ModoIaService } from '../../core/services/modo-ia.service';
import type { StrategyKind } from '../../core/models';
import { shortDate } from '../../core/utils';
import {
  LIMITES_IA,
  borradorDe,
  cambiosDe,
  dormidaHasta,
  minutosValidos,
  mismoBorrador,
  textoDeRevision,
  type BorradorIa,
  type CambioIa,
} from '../../core/utils/modo-ia';
import { UiNoticeComponent } from '../ui';
import { ModoIaEditorComponent } from './modo-ia-editor.component';

/** El bot, en lo que al panel le importa. */
export interface BotDelPanel {
  strategy: StrategyKind;
  dryRun: boolean;
  status: string;
}

const SOLO_APAGAR: readonly AiMode[] = ['OFF'];

/**
 * El Modo IA de un bot que ya existe (spec 053): lo que tiene, lo que puede
 * pasar con él y los mandos para cambiarlo.
 *
 * Lo usan el detalle del bot y la ficha de la consola. No habla con el
 * servidor: la pantalla que lo contiene lee, guarda y le pasa el resultado. Así
 * cada pantalla decide cuándo recargar —el detalle, con los eventos `AI_*` de su
 * bot— sin que el panel tenga que saberlo.
 *
 * Tres cosas que el panel de la consola hacía mal y aquí no:
 *   - un fallo de lectura se pintaba como «Apagado». Aquí es un error, y los
 *     mandos no aparecen: ofrecer «encender» sobre algo que quizá ya está
 *     encendido es peor que no ofrecer nada;
 *   - «se reactiva el …» salía con fechas pasadas;
 *   - la frase de cuándo revisa era fija.
 */
@Component({
  selector: 'app-modo-ia-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, IonButton, IonSpinner, UiNoticeComponent, ModoIaEditorComponent],
  template: `
    @if (error()) {
      <div class="pila">
        <ui-notice tone="danger" icon="warning-outline">
          No se pudo leer el Modo IA de este bot. No se enseñan los mandos para no dar por apagado
          lo que quizá está encendido.
        </ui-notice>
        <ion-button size="small" fill="outline" (click)="reintentar.emit()">Reintentar</ion-button>
      </div>
    } @else if (ajuste(); as s) {
      <div class="pila">
        <ui-notice tone="info" icon="sparkles-outline">{{ frase() }} {{ limites }}</ui-notice>

        @if (noCubierta()) {
          <ui-notice tone="info" icon="information-circle-outline">
            @if (s.mode === 'OFF') {
              El Modo IA todavía no cubre esta estrategia: de momento, solo los dos market makers,
              la de tendencia y la de seguimiento de beneficio.
            } @else {
              El Modo IA ya no cubre esta estrategia: lo único que se puede hacer es apagarlo.
            }
          </ui-notice>
        }

        @if (dormida(); as hasta) {
          <ui-notice tone="warn" icon="warning-outline">
            El supervisor se ha dormido tras varios fallos seguidos. Se reactiva solo el
            {{ fecha(hasta) }}.
          </ui-notice>
        }

        @if (manualSinTelegram()) {
          <ui-notice tone="danger" icon="warning-outline">
            Este bot está en «propone y espera» y no tienes Telegram vinculado: las sugerencias no
            llegan a ninguna parte. <a routerLink="/telegram">Vincúlalo</a> o cambia de modo.
          </ui-notice>
        }
      </div>

      @if (!noCubierta() || s.mode !== 'OFF') {
        <app-modo-ia-editor
          [(valor)]="borrador"
          [estrategia]="bot().strategy"
          [simulado]="bot().dryRun"
          [enMarcha]="bot().status === 'RUNNING'"
          [interruptores]="interruptores()"
          [deshabilitado]="ocupado()"
          [modos]="modos()"
        />
      }

      @if (s.last_review_at || s.last_apply_at) {
        <p class="fina">
          @if (s.last_review_at) {
            Última revisión: {{ fecha(s.last_review_at) }}.
          }
          @if (s.last_apply_at) {
            Último ajuste aplicado: {{ fecha(s.last_apply_at) }}.
          }
        </p>
      }

      @if (sucio()) {
        <div class="acciones">
          <ion-button fill="clear" [disabled]="ocupado()" (click)="descartar()">
            Descartar
          </ion-button>
          <ion-button [disabled]="ocupado() || !valido()" (click)="guardar.emit(cambio())">
            @if (ocupado()) {
              <ion-spinner name="crescent" />
            } @else {
              Guardar
            }
          </ion-button>
        </div>
      }
    } @else {
      <div class="center"><ion-spinner name="crescent" /></div>
    }
  `,
  styles: [
    `
      :host {
        display: block;
      }

      .pila {
        display: flex;
        flex-direction: column;
        align-items: stretch;
        gap: var(--space-2);
        margin-bottom: var(--space-3);
      }

      .pila ion-button {
        align-self: flex-start;
      }

      ui-notice a {
        color: var(--brand-2);
        text-decoration: none;
      }

      .fina {
        margin: var(--space-3) 0 0;
        font-size: 11px;
        color: var(--text-3);
      }

      .acciones {
        display: flex;
        justify-content: flex-end;
        gap: var(--space-2);
        margin-top: var(--space-3);
      }

      .center {
        display: flex;
        justify-content: center;
        padding: var(--space-5) 0;
      }
    `,
  ],
})
export class ModoIaPanelComponent {
  private readonly telegram = inject(TelegramService);
  private readonly modoIa = inject(ModoIaService);

  /** `null` mientras se lee. */
  readonly ajuste = input<AiSetting | null>(null);
  /** La lectura falló: no se enseñan los mandos. */
  readonly error = input(false);
  /** Hay un guardado en vuelo. */
  readonly ocupado = input(false);
  readonly bot = input.required<BotDelPanel>();

  readonly guardar = output<CambioIa>();
  readonly reintentar = output<void>();

  readonly limites = LIMITES_IA;

  private readonly guardado = computed(() => borradorDe(this.ajuste()));

  /**
   * El borrador, que sigue a lo guardado MIENTRAS no se esté editando.
   *
   * Si llega una recarga con cambios a medio escribir —un evento del supervisor,
   * otro dispositivo—, lo escrito se conserva: perderlo por un refresco que el
   * usuario no ha pedido es la clase de sorpresa que hace desconfiar de una
   * pantalla. Lo que se manda al guardar se calcula contra lo guardado NUEVO.
   */
  readonly borrador = linkedSignal<BorradorIa, BorradorIa>({
    source: this.guardado,
    computation: (nuevo, previo) =>
      previo && !mismoBorrador(previo.value, previo.source) ? previo.value : nuevo,
  });

  /**
   * Los interruptores: los que trae la lectura del bot, o los del resumen si
   * esta no los trae (la respuesta de un guardado no los lleva).
   */
  readonly interruptores = computed(
    () => this.ajuste()?.interruptores ?? this.modoIa.interruptores(),
  );

  /** Solo `false` si alguien lo sabe: sin dato, decide el servidor. */
  readonly noCubierta = computed(
    () => this.ajuste()?.cubierta === false || this.modoIa.cubre(this.bot().strategy) === false,
  );

  readonly modos = computed(() => (this.noCubierta() ? SOLO_APAGAR : AI_MODES));
  readonly frase = computed(() => textoDeRevision(this.guardado()));
  readonly dormida = computed(() => dormidaHasta(this.ajuste()));

  /** H-03 del spec 053: el servidor no lo impide si Telegram se desvincula despues. */
  readonly manualSinTelegram = computed(
    () => this.guardado().mode === 'MANUAL' && this.telegram.status()?.linked === false,
  );

  readonly sucio = computed(() => !mismoBorrador(this.borrador(), this.guardado()));
  readonly cambio = computed(() => cambiosDe(this.guardado(), this.borrador()));
  readonly valido = computed(() => {
    const b = this.borrador();
    if (!minutosValidos(b.reviewEveryMinutes)) return false;
    // Pasar a manual sin Telegram: el servidor lo rechazaria.
    const aManual = b.mode === 'MANUAL' && this.guardado().mode !== 'MANUAL';
    return !(aManual && this.telegram.status()?.linked === false);
  });

  constructor() {
    addIcons({ informationCircleOutline, sparklesOutline, warningOutline });
  }

  fecha(valor: string | Date): string {
    return shortDate(valor);
  }

  descartar(): void {
    this.borrador.set(this.guardado());
  }
}

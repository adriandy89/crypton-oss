import { Component, computed, effect, inject, input, model, output, signal } from '@angular/core';
import {
  AlertController,
  IonButton,
  IonContent,
  IonIcon,
  IonModal,
  IonSegment,
  IonSegmentButton,
  IonSpinner,
  IonToggle,
} from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { closeOutline } from 'ionicons/icons';
import { BotsService, ToastService, WalletService } from '../../core/services';
import type { BotDetail, MarginAction } from '../../core/models';
import { errorText, money, price } from '../../core/utils';

/**
 * La hoja de ajuste de margen de una posición aislada.
 *
 * Extraída del detalle del bot para que el gráfico la abra también (spec 005,
 * R-4): es la acción que aleja la liquidación sin comprar ni vender, y la
 * pantalla donde se ve la liquidación acercarse es el gráfico. Dos copias de
 * este formulario —con su aviso de que retirar ACERCA la liquidación y su
 * interruptor de contabilidad— se habrían desalineado con el primer cambio.
 *
 * Se abre con `open` (enlace bidireccional) y avisa con `sent` cuando el
 * comando se ha enviado, para que la pantalla que la contiene se recargue.
 */
@Component({
  selector: 'ui-margin-sheet',
  standalone: true,
  imports: [
    IonModal,
    IonContent,
    IonIcon,
    IonSegment,
    IonSegmentButton,
    IonToggle,
    IonButton,
    IonSpinner,
  ],
  template: `
    <ion-modal
      class="opts margin-sheet"
      [isOpen]="open()"
      [initialBreakpoint]="0.9"
      [breakpoints]="[0, 0.9]"
      handleBehavior="cycle"
      (ionModalDidDismiss)="open.set(false)"
    >
      <ng-template>
        <ion-content class="optbody margin-body">
          <header class="opthead">
            <h2>Ajustar margen</h2>
            <button type="button" class="x" (click)="open.set(false)" aria-label="Cerrar">
              <ion-icon name="close-outline" />
            </button>
          </header>

          @if (bot(); as b) {
            <ion-segment
              class="margin-seg"
              [value]="action()"
              (ionChange)="action.set($any($event.detail.value))"
            >
              <ion-segment-button value="ADD">Aportar</ion-segment-button>
              <ion-segment-button value="REMOVE">Retirar</ion-segment-button>
            </ion-segment>

            @if (action() === 'ADD') {
              <p class="margin-lead">
                El importe sale de tu margen libre y entra en la caja de esta posición.
                <strong>Aleja el precio de liquidación</strong>, ahora en
                {{ price(b.liquidationPrice) }}, sin comprar ni vender nada.
              </p>
            } @else {
              <p class="margin-lead danger">
                Sacas colateral de esta posición y vuelve a tu margen libre.
                <strong>Acerca el precio de liquidación</strong>, ahora en
                {{ price(b.liquidationPrice) }}. Si el mercado se mueve en contra, se liquidará
                antes.
              </p>
            }

            <label class="margin-amount">
              <span class="lbl">Importe</span>
              <input
                type="number"
                inputmode="decimal"
                min="0"
                step="0.01"
                placeholder="0.00"
                [value]="amount()"
                (input)="amount.set($any($event.target).value)"
              />
            </label>

            @if (freeMargin(); as free) {
              <div class="margin-free">
                <span>Margen libre: {{ money(free) }}</span>
                @if (action() === 'ADD') {
                  <!-- Sin atajo al 100 %: dejar la cuenta sin un céntimo libre es
                       lo que impide pagar la siguiente comisión, y es el mismo
                       criterio que ya aplica ui-amount-field al capital. -->
                  <div class="chips">
                    <button type="button" (click)="fill(0.25)">25%</button>
                    <button type="button" (click)="fill(0.5)">50%</button>
                    <button type="button" (click)="fill(0.75)">75%</button>
                  </div>
                }
              </div>
            }

            @if (action() === 'ADD') {
              <div class="margin-toggle">
                <ion-toggle
                  [checked]="countAsCapital()"
                  (ionChange)="countAsCapital.set($any($event.detail.checked))"
                >
                  Contar como capital del bot
                </ion-toggle>
                @if (countAsCapital()) {
                  <p class="hint warn">
                    Además sube el capital asignado del bot, así que el ROI y la APR reflejarán el
                    dinero real que tienes puesto.
                    <strong>Cancela y vuelve a colocar las órdenes abiertas.</strong>
                    No cambia la liquidación más de lo que ya lo hace el aporte.
                  </p>
                } @else {
                  <p class="hint">
                    Solo mueve la liquidación. El ROI y la APR se seguirán calculando sobre el
                    capital asignado actual, así que saldrán más altos de lo que corresponde al
                    dinero puesto.
                  </p>
                }
              </div>
            }

            <ion-button
              expand="block"
              class="margin-go"
              [color]="action() === 'REMOVE' ? 'danger' : 'primary'"
              [disabled]="busy()"
              (click)="submit()"
            >
              @if (busy()) {
                <ion-spinner name="crescent" />
              } @else {
                {{ action() === 'ADD' ? 'Aportar margen' : 'Retirar margen' }}
              }
            </ion-button>
          }
        </ion-content>
      </ng-template>
    </ion-modal>
  `,
  styles: [
    `
      .margin-seg {
        margin-bottom: var(--space-3);
      }

      /* El parrafo que explica QUE hace la transferencia. Es la mitad util de la
         hoja: sin el, aportar y subir el capital asignado parecen lo mismo. */
      .margin-lead {
        margin: 0 0 var(--space-4);
        font-size: 13px;
        line-height: 1.5;
        color: var(--text-2);

        strong {
          color: var(--text-1);
        }

        &.danger strong {
          color: var(--ion-color-danger);
        }
      }

      .margin-amount {
        display: block;
        margin-bottom: var(--space-2);

        .lbl {
          display: block;
          margin-bottom: var(--space-2);
          font-size: 10.5px;
          font-weight: 700;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: var(--text-2);
        }

        input {
          width: 100%;
          padding: var(--space-3);
          border: 1px solid rgba(46, 43, 82, 0.6);
          border-radius: var(--radius-sm);
          background: var(--surface-2);
          color: var(--text-1);
          font-family: var(--font-mono, inherit);
          font-size: 18px;
        }
      }

      .margin-free {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--space-3);
        margin-bottom: var(--space-4);
        font-size: 12px;
        color: var(--text-2);

        .chips {
          display: flex;
          gap: var(--space-2);
        }

        .chips button {
          padding: 4px 10px;
          border: 1px solid rgba(46, 43, 82, 0.6);
          border-radius: var(--radius-pill);
          background: var(--surface-2);
          color: var(--text-1);
          font-size: 11.5px;
        }
      }

      .margin-toggle {
        padding: var(--space-3);
        margin-bottom: var(--space-4);
        border: 1px solid rgba(46, 43, 82, 0.6);
        border-radius: var(--radius-md);
        background: var(--surface-2);

        ion-toggle {
          width: 100%;
          font-size: 13.5px;
        }

        /* El pie CAMBIA con el interruptor a proposito: apagado explica que el
           ROI se queda corto, y encendido avisa de que se recolocan las ordenes.
           Un texto fijo tendria que decir las dos cosas y no se leeria ninguna. */
        .hint {
          margin: var(--space-2) 0 0;
          font-size: 11.5px;
          line-height: 1.45;
          color: var(--text-2);
        }

        .hint.warn strong {
          color: var(--ion-color-warning);
        }
      }

      .margin-go {
        margin-top: var(--space-2);
      }
    `,
  ],
})
export class UiMarginSheetComponent {
  private readonly bots = inject(BotsService);
  private readonly wallet = inject(WalletService);
  private readonly toast = inject(ToastService);
  private readonly alerts = inject(AlertController);

  readonly bot = input<BotDetail | null>(null);
  readonly open = model(false);
  /** El comando se ha enviado: quien contiene la hoja decide cómo recargarse. */
  readonly sent = output<void>();

  readonly action = signal<MarginAction>('ADD');
  readonly amount = signal('');
  /**
   * Interruptor de contabilidad. Arranca APAGADO siempre, y a propósito: el
   * efecto que la gente busca —alejar la liquidación— lo da la transferencia
   * sola, y encenderlo retiende la escalera. Que el efecto extra haya que
   * pedirlo es la diferencia entre una casilla y una sorpresa.
   */
  readonly countAsCapital = signal(false);
  readonly busy = signal(false);

  readonly money = money;
  readonly price = price;

  /** Margen libre de la conexión del bot. `null` = no se pudo leer. */
  readonly freeMargin = computed(() => {
    const b = this.bot();
    if (!b) return null;
    return this.wallet.of(b.exchange_account_id, b.id)?.available ?? null;
  });

  constructor() {
    addIcons({ closeOutline });
    // Al abrir, el formulario vuelve a cero y se pide el saldo. El saldo se pide
    // aquí y no al cargar la pantalla: es una lectura contra el venue y la
    // inmensa mayoría de las visitas no van a ajustar margen. No se espera ni
    // se bloquea nada por ella — si no llega, la hoja funciona igual y sin los
    // atajos de porcentaje. Con conexión de simulación, el saldo que cuenta es
    // el de SU sandbox, no el capital de partida de la conexión.
    effect(() => {
      if (!this.open()) return;
      const b = this.bot();
      this.action.set('ADD');
      this.amount.set('');
      this.countAsCapital.set(false);
      if (b) void this.wallet.load(b.exchange_account_id, b.symbol, { force: true, botId: b.id });
    });
  }

  /** Rellena el importe con una fracción del margen libre. */
  fill(fraction: number): void {
    const free = this.freeMargin();
    if (!free) return;
    this.amount.set(String(Math.floor(Number(free) * fraction * 100) / 100));
  }

  async submit(): Promise<void> {
    const amount = this.amount().trim();
    if (!amount || !(Number(amount) > 0)) {
      await this.toast.error('Escribe un importe mayor que cero.');
      return;
    }

    // Retirar ACERCA la liquidación: es la operación inversa a la que se viene
    // buscando, así que se pregunta aquí además de en la API.
    if (this.action() === 'REMOVE') {
      const alert = await this.alerts.create({
        header: '¿Retirar margen?',
        message:
          'Sacar colateral de esta posición ACERCA su precio de liquidación. ' +
          'Si el mercado se mueve en contra, se liquidará antes.',
        buttons: [
          { text: 'Cancelar', role: 'cancel' },
          { text: 'Retirar', role: 'destructive', handler: () => void this.send(amount) },
        ],
      });
      await alert.present();
      return;
    }
    await this.send(amount);
  }

  private async send(amount: string): Promise<void> {
    const b = this.bot();
    if (!b) return;
    this.busy.set(true);
    try {
      const action = this.action();
      await this.bots.adjustMargin(b.id, {
        amount,
        action,
        countAsBotCapital: this.countAsCapital(),
      });
      this.open.set(false);
      // «Enviado» y no «aplicado»: quien habla con el venue es el worker, y el
      // resultado real —con la liquidación de antes y de después— aparece en la
      // bitácora del bot cuando el comando se ejecuta.
      await this.toast.success(
        action === 'ADD'
          ? 'Aporte de margen enviado. Verás el nuevo precio de liquidación en los eventos.'
          : 'Retirada de margen enviada.',
      );
      this.sent.emit();
    } catch (e) {
      await this.toast.error(errorText(e));
    } finally {
      this.busy.set(false);
    }
  }
}

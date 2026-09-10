import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import {
  AlertController,
  IonBackButton,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonSpinner,
  IonTitle,
  IonToolbar,
} from '@ionic/angular/standalone';
import { ToastService } from '../../core/services';
import {
  ANTIGUEDADES,
  AdminMaintenanceService,
  ETIQUETA_AMBITO,
  type AmbitoPurgable,
  type PurgeScope,
} from '../../core/services/admin-maintenance.service';
import { errorText } from '../../core/utils';
import { UiCardComponent, UiNoticeComponent } from '../../shared/ui';
import { AdminForbiddenComponent } from './admin-forbidden.component';

/**
 * Mantenimiento de históricos (spec 034).
 *
 * Tres pasos, y el del medio es el que importa: elegir antigüedad, **ver
 * cuántas filas caerían**, y solo entonces confirmar. Un borrado no tiene
 * deshacer, así que la pantalla no ofrece un botón que borre sin haber
 * enseñado antes el número.
 */
@Component({
  selector: 'app-admin-maintenance',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    IonBackButton,
    IonButton,
    IonButtons,
    IonContent,
    IonHeader,
    IonSpinner,
    IonTitle,
    IonToolbar,
    UiCardComponent,
    UiNoticeComponent,
    AdminForbiddenComponent,
  ],
  template: `
    <ion-header class="ion-no-border">
      <ion-toolbar>
        <ion-buttons slot="start">
          <ion-back-button defaultHref="/admin" text="" />
        </ion-buttons>
        <ion-title>Mantenimiento</ion-title>
      </ion-toolbar>
    </ion-header>

    <ion-content>
      <div class="pad">
        @if (forbidden()) {
          <app-admin-forbidden />
        } @else {
          <ui-notice tone="info" icon="information-circle-outline">
            La limpieza automática ya corre cada hora en el motor, con las retenciones de cada
            tabla. Esto es para adelantarla o para afinar un caso concreto.
          </ui-notice>
          <ui-notice tone="warn" icon="warning-outline">
            Nada de lo que se purgue aquí puede pertenecer a un <b>bot en marcha</b>, y los eventos
            graves no se borran nunca. Aun así, <b>no hay deshacer</b>: mira el recuento antes de
            confirmar.
          </ui-notice>

          <div class="antig">
            <span class="et">Purgar lo anterior a</span>
            <div class="opts">
              @for (a of antiguedades; track a.dias) {
                <button
                  type="button"
                  class="chip"
                  [class.on]="dias() === a.dias"
                  [attr.aria-pressed]="dias() === a.dias"
                  (click)="setDias(a.dias)"
                >
                  {{ a.label }}
                </button>
              }
            </div>
          </div>

          @if (cargando()) {
            <div class="center"><ion-spinner name="crescent" /></div>
          } @else {
            @for (a of ambitos(); track a.scope) {
              <ui-card>
                <div class="cab">
                  <span class="nom">{{ etiqueta(a.scope) }}</span>
                  <span class="tabla mono">{{ a.tabla }}</span>
                </div>
                <p class="desc">{{ a.descripcion }}</p>
                <div class="cifras">
                  <span>{{ a.filas }} fila(s) purgables en total</span>
                  <span class="d">·</span>
                  @if (a.retencionAutomaticaDias) {
                    <span>el motor ya limpia a {{ a.retencionAutomaticaDias }} días</span>
                  } @else {
                    <span class="w">ningún cron limpia esta tabla</span>
                  }
                </div>

                @if (dias() < a.sueloDias) {
                  <!-- Apagado y explicando por qué, no escondido. -->
                  <p class="fina">
                    Esta tabla no se puede purgar por debajo de {{ a.sueloDias }} días.
                  </p>
                } @else {
                  <div class="acc">
                    <span class="prev">{{ textoPrevio(a.scope) }}</span>
                    <ion-button size="small" fill="clear" (click)="contar(a)">Contar</ion-button>
                    <ion-button
                      size="small"
                      fill="clear"
                      color="danger"
                      [disabled]="(previos()[a.scope] ?? -1) <= 0"
                      (click)="purgar(a)"
                    >
                      Purgar
                    </ion-button>
                  </div>
                }
              </ui-card>
            }
          }
        }
      </div>
    </ion-content>
  `,
  styles: [
    `
      .antig {
        margin: var(--space-3) 0;
      }

      .et {
        display: block;
        margin-bottom: 6px;
        font-size: 11px;
        color: var(--text-3);
      }

      .opts {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-2);
      }

      .chip {
        min-height: 34px;
        padding: 0 12px;
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-xs);
        background: var(--surface-2);
        color: var(--text-2);
        font-family: var(--font-ui);
        font-size: 11.5px;
      }

      .chip.on {
        border-color: transparent;
        background: var(--surface-3);
        color: var(--brand-2);
        font-weight: 700;
      }

      .cab {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: var(--space-2);
      }

      .nom {
        font-size: 12.5px;
        color: var(--text-1);
      }

      .tabla {
        font-size: 10.5px;
        color: var(--text-3);
      }

      .desc {
        margin: 4px 0;
        font-size: 11px;
        color: var(--text-2);
      }

      .cifras {
        display: flex;
        flex-wrap: wrap;
        gap: 5px;
        font-size: 11px;
        color: var(--text-3);

        .d {
          color: var(--border-subtle);
        }

        .w {
          color: var(--signal-warn);
        }
      }

      .acc {
        display: flex;
        align-items: center;
        gap: var(--space-2);
        margin-top: var(--space-2);
      }

      .prev {
        flex-grow: 1;
        font-size: 11px;
        color: var(--text-2);
      }

      .fina {
        margin: var(--space-2) 0 0;
        font-size: 11px;
        color: var(--text-3);
      }

      .center {
        display: flex;
        justify-content: center;
        padding: var(--space-6) 0;
      }
    `,
  ],
})
export class AdminMaintenancePage implements OnInit {
  private readonly api = inject(AdminMaintenanceService);
  private readonly alerts = inject(AlertController);
  private readonly toast = inject(ToastService);

  readonly antiguedades = ANTIGUEDADES;

  readonly ambitos = signal<AmbitoPurgable[]>([]);
  readonly cargando = signal(false);
  readonly forbidden = signal(false);
  readonly dias = signal<number>(30);

  /** Último recuento por ámbito. `undefined` = aún no se ha contado. */
  readonly previos = signal<Partial<Record<PurgeScope, number>>>({});

  ngOnInit(): void {
    void this.cargar();
  }

  etiqueta(scope: PurgeScope): string {
    return ETIQUETA_AMBITO[scope];
  }

  textoPrevio(scope: PurgeScope): string {
    const n = this.previos()[scope];
    if (n === undefined) return 'Sin contar';
    return n === 0 ? 'Nada que purgar' : `${n} fila(s) caerían`;
  }

  /** Cambiar la antigüedad invalida los recuentos: eran de otra pregunta. */
  setDias(d: number): void {
    this.dias.set(d);
    this.previos.set({});
  }

  async contar(a: AmbitoPurgable): Promise<void> {
    try {
      const { filas } = await this.api.preview(a.scope, this.dias());
      this.previos.update((p) => ({ ...p, [a.scope]: filas }));
    } catch (e) {
      await this.toast.error(errorText(e));
    }
  }

  /**
   * Solo se llega aquí con un recuento hecho y mayor que cero: el botón está
   * apagado en cualquier otro caso. La confirmación repite el número, porque es
   * el dato que hace que la decisión sea una decisión.
   */
  async purgar(a: AmbitoPurgable): Promise<void> {
    const n = this.previos()[a.scope] ?? 0;
    const alert = await this.alerts.create({
      header: `¿Purgar ${this.etiqueta(a.scope).toLowerCase()}?`,
      message:
        `Se borrarán ${n} fila(s) de ${a.tabla} anteriores a ${this.dias()} días. ` +
        'No hay deshacer.',
      inputs: [
        {
          name: 'reason',
          type: 'text',
          placeholder: 'Motivo (queda en la bitácora)',
          attributes: { maxlength: 200 },
        },
      ],
      buttons: [
        { text: 'Cancelar', role: 'cancel' },
        {
          text: 'Purgar',
          role: 'destructive',
          handler: (datos: { reason?: string }) => {
            const reason = (datos?.reason ?? '').trim();
            if (reason.length < 3) {
              void this.toast.error('Escribe el motivo: queda en la bitácora.');
              return false;
            }
            void this.ejecutar(a, reason);
            return true;
          },
        },
      ],
    });
    await alert.present();
  }

  private async ejecutar(a: AmbitoPurgable, reason: string): Promise<void> {
    try {
      const res = await this.api.purge(a.scope, this.dias(), reason);
      // «Completo» se dice cuando lo es: si se agotó el tope de lotes aún queda
      // trabajo, y dejar creer que la tabla quedó limpia sería mentir.
      await this.toast.success(
        res.completo
          ? `${res.borradas} fila(s) borradas.`
          : `${res.borradas} fila(s) borradas; queda más, vuelve a purgar.`,
      );
      this.previos.update((p) => ({ ...p, [a.scope]: undefined }));
      await this.cargar();
    } catch (e) {
      await this.toast.error(errorText(e));
    }
  }

  private async cargar(): Promise<void> {
    this.cargando.set(true);
    try {
      const res = await this.api.estado();
      this.ambitos.set(res.ambitos);
      this.forbidden.set(false);
    } catch (e) {
      if ((e as { status?: number }).status === 403) this.forbidden.set(true);
      else await this.toast.error(errorText(e));
    } finally {
      this.cargando.set(false);
    }
  }
}

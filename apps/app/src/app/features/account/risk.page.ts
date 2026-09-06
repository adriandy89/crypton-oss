import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  IonBackButton,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonInput,
  IonItem,
  IonList,
  IonListHeader,
  IonLabel,
  IonNote,
  IonSpinner,
  IonTitle,
  IonToolbar,
} from '@ionic/angular/standalone';
import { RiskService, ToastService } from '../../core/services';
import { errorText } from '../../core/utils';

@Component({
  selector: 'app-risk',
  standalone: true,
  imports: [
    FormsModule,
    IonHeader,
    IonToolbar,
    IonTitle,
    IonButtons,
    IonBackButton,
    IonContent,
    IonList,
    IonListHeader,
    IonItem,
    IonLabel,
    IonInput,
    IonButton,
    IonNote,
    IonSpinner,
  ],
  template: `
    <ion-header>
      <ion-toolbar>
        <ion-buttons slot="start"><ion-back-button defaultHref="/tabs/account" /></ion-buttons>
        <ion-title>Límites de riesgo</ion-title>
      </ion-toolbar>
    </ion-header>

    <ion-content>
      <div class="pad">
        <p class="hint">
          Estos límites se comprueban al crear un bot <strong>y en cada ciclo del motor</strong>. Lo
          segundo importa: el mercado se mueve, y un bot que era seguro al arrancar puede dejar de
          serlo media hora después.
        </p>

        <ion-list inset="true">
          <ion-list-header><ion-label>Exposición</ion-label></ion-list-header>
          <ion-item>
            <ion-input
              label="Notional máximo por bot"
              labelPlacement="stacked"
              type="number"
              placeholder="sin límite"
              [(ngModel)]="maxNotionalPerBot"
              name="a"
            />
          </ion-item>
          <ion-item>
            <ion-input
              label="Notional máximo total"
              labelPlacement="stacked"
              type="number"
              placeholder="sin límite"
              [(ngModel)]="maxTotalNotional"
              name="b"
            />
          </ion-item>
          <ion-item>
            <ion-input
              label="Apalancamiento máximo"
              labelPlacement="stacked"
              type="number"
              min="1"
              max="50"
              [(ngModel)]="maxLeverage"
              name="c"
            />
          </ion-item>
          <ion-item>
            <ion-input
              label="Bots activos a la vez"
              labelPlacement="stacked"
              type="number"
              min="1"
              [(ngModel)]="maxOpenBots"
              name="d"
            />
          </ion-item>
        </ion-list>

        <ion-list inset="true">
          <ion-list-header><ion-label>Frenos automáticos</ion-label></ion-list-header>
          <ion-item>
            <ion-input
              label="Pérdida diaria máxima"
              labelPlacement="stacked"
              type="number"
              placeholder="sin límite"
              [(ngModel)]="maxDailyLoss"
              name="e"
            />
          </ion-item>
          <ion-item>
            <ion-input
              label="Pérdida acumulada que pausa el bot (%)"
              labelPlacement="stacked"
              type="number"
              [(ngModel)]="killSwitchDrawdownPct"
              name="f"
            />
          </ion-item>
          <ion-item>
            <ion-input
              label="Alerta de liquidación (%)"
              labelPlacement="stacked"
              type="number"
              [(ngModel)]="liquidationAlertPct"
              name="g"
            />
          </ion-item>
        </ion-list>

        <ion-note class="foot">
          Al saltar una guarda el bot se <strong>pausa</strong>, no se cierra: cerrar realizaría la
          pérdida al instante y en el peor momento. Pausar detiene el sangrado y deja la decisión
          final en tus manos.
        </ion-note>

        <ion-button expand="block" [disabled]="busy()" (click)="save()">
          @if (busy()) {
            <ion-spinner name="crescent" />
          } @else {
            Guardar límites
          }
        </ion-button>
      </div>
    </ion-content>
  `,
  styles: [
    `
      .hint {
        font-size: 13px;
        color: var(--text-2);
        line-height: 1.6;
        margin: 0 0 var(--space-3);
      }
      .foot {
        display: block;
        padding: var(--space-3) var(--space-2) var(--space-4);
        font-size: 12px;
        line-height: 1.6;
        color: var(--text-3);
      }
    `,
  ],
})
export class RiskPage implements OnInit {
  private readonly risk = inject(RiskService);
  private readonly toast = inject(ToastService);

  readonly busy = signal(false);

  maxNotionalPerBot: string | null = null;
  maxTotalNotional: string | null = null;
  maxLeverage: number | null = null;
  maxOpenBots: number | null = null;
  maxDailyLoss: string | null = null;
  killSwitchDrawdownPct: string | null = null;
  liquidationAlertPct: string | null = null;

  async ngOnInit(): Promise<void> {
    try {
      await this.risk.refresh();
      const l = this.risk.limits();
      if (!l) return;
      this.maxNotionalPerBot = l.max_notional_per_bot;
      this.maxTotalNotional = l.max_total_notional;
      this.maxLeverage = l.max_leverage;
      this.maxOpenBots = l.max_open_bots;
      this.maxDailyLoss = l.max_daily_loss;
      this.killSwitchDrawdownPct = l.kill_switch_drawdown_pct;
      this.liquidationAlertPct = l.liquidation_alert_pct;
    } catch (e) {
      await this.toast.error(errorText(e));
    }
  }

  async save(): Promise<void> {
    this.busy.set(true);
    try {
      // Un campo vacío significa "sin límite", no "cero": mandarlo como null es
      // lo que distingue una cosa de la otra en la API.
      await this.risk.update({
        maxNotionalPerBot: blank(this.maxNotionalPerBot),
        maxTotalNotional: blank(this.maxTotalNotional),
        maxLeverage: this.maxLeverage ?? null,
        maxOpenBots: this.maxOpenBots ?? null,
        maxDailyLoss: blank(this.maxDailyLoss),
        killSwitchDrawdownPct: blank(this.killSwitchDrawdownPct),
        liquidationAlertPct: blank(this.liquidationAlertPct),
      });
      await this.toast.success('Límites guardados.');
    } catch (e) {
      await this.toast.error(errorText(e));
    } finally {
      this.busy.set(false);
    }
  }
}

const blank = (v: string | null): string | null =>
  v === null || String(v).trim() === '' ? null : String(v);

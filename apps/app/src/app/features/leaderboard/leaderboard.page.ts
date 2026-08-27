import { Component, OnInit, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import {
  AlertController,
  IonBackButton,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonRefresher,
  IonRefresherContent,
  IonSegment,
  IonSegmentButton,
  IonSelect,
  IonSelectOption,
  IonSpinner,
  IonTitle,
  IonToolbar,
} from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { copyOutline, trophyOutline } from 'ionicons/icons';
import {
  ExchangeAccountsService,
  LeaderboardService,
  ToastService,
  type LeaderboardPeriod,
  type LeaderboardRow,
} from '../../core/services';
import type { StrategyKind, Venue } from '../../core/models';
import {
  errorText,
  money,
  pct,
  pnlColor,
  strategyLabel,
  uptime,
  venueLabel,
} from '../../core/utils';
import { UiCardComponent, UiEmptyStateComponent, UiStatComponent } from '../../shared/ui';

@Component({
  selector: 'app-leaderboard',
  standalone: true,
  imports: [
    IonBackButton,
    IonButtons,
    IonHeader,
    IonToolbar,
    IonTitle,
    IonContent,
    IonRefresher,
    IonRefresherContent,
    IonSegment,
    IonSegmentButton,
    IonSelect,
    IonSelectOption,
      IonButton,
    IonIcon,
    IonSpinner,
    UiCardComponent,
    UiStatComponent,
    UiEmptyStateComponent,
  ],
  templateUrl: './leaderboard.page.html',
  styleUrl: './leaderboard.page.scss',
})
export class LeaderboardPage implements OnInit {
  readonly leaderboard = inject(LeaderboardService);
  private readonly accounts = inject(ExchangeAccountsService);
  private readonly toast = inject(ToastService);
  private readonly alerts = inject(AlertController);
  private readonly router = inject(Router);

  readonly period = signal<LeaderboardPeriod>('WEEK');
  readonly venue = signal<Venue | ''>('');
  readonly strategy = signal<StrategyKind | ''>('');

  readonly money = money;
  readonly pct = pct;
  readonly pnlColor = pnlColor;
  readonly uptime = uptime;
  readonly strategyLabel = strategyLabel;
  readonly venueLabel = venueLabel;

  constructor() {
    addIcons({ trophyOutline, copyOutline });
  }

  async ngOnInit(): Promise<void> {
    await Promise.all([this.reload(), this.accounts.refresh()]);
  }

  async reload(event?: CustomEvent): Promise<void> {
    try {
      await this.leaderboard.load({
        period: this.period(),
        venue: this.venue() || undefined,
        strategy: this.strategy() || undefined,
      });
    } catch (e) {
      await this.toast.error(errorText(e));
    } finally {
      if (event) (event.target as HTMLIonRefresherElement).complete();
    }
  }

  setPeriod(value: LeaderboardPeriod): void {
    this.period.set(value);
    void this.reload();
  }

  setVenue(value: string): void {
    this.venue.set(value as Venue | '');
    void this.reload();
  }

  setStrategy(value: string): void {
    this.strategy.set(value as StrategyKind | '');
    void this.reload();
  }

  /**
   * Copiar pide DOS cosas antes de nada: con qué cuenta y con cuánto capital.
   *
   * El capital no es opcional ni se hereda del autor: los importes de la
   * configuración compartida se reexpanden contra este número, y ese es
   * exactamente el punto de todo el mecanismo — que quien copia despliegue su
   * tamaño, no el del otro.
   */
  async copy(row: LeaderboardRow): Promise<void> {
    if (!row.shareCode) return;

    const usable = this.accounts
      .accounts()
      .filter((a) => a.venue === row.venue && ['VERIFIED', 'ACTIVE'].includes(a.status));

    if (usable.length === 0) {
      await this.toast.warn(
        `Necesitas una conexión verificada con ${row.venue} para copiar este bot.`,
      );
      return;
    }

    const alert = await this.alerts.create({
      header: `Copiar «${row.name}»`,
      message:
        'Se copia la forma de la estrategia, no el tamaño del autor. Indica cuánto capital quieres asignarle tú.',
      inputs: [
        {
          name: 'investment',
          type: 'number',
          placeholder: 'Capital a asignar (USDC)',
          min: 10,
        },
      ],
      buttons: [
        { text: 'Cancelar', role: 'cancel' },
        {
          text: 'Continuar',
          handler: (data: { investment?: string }) => {
            const amount = Number(data.investment);
            if (!Number.isFinite(amount) || amount <= 0) {
              void this.toast.error('Indica un capital válido.');
              return false;
            }
            void this.doCopy(row, usable[0].id, String(amount));
            return true;
          },
        },
      ],
    });
    await alert.present();
  }

  private async doCopy(
    row: LeaderboardRow,
    exchangeAccountId: string,
    totalInvestment: string,
  ): Promise<void> {
    try {
      const result = await this.leaderboard.resolve({
        code: row.shareCode!,
        exchangeAccountId,
        symbol: row.symbol,
        totalInvestment,
      });

      // Se lleva al asistente con todo precargado en lugar de crear el bot de
      // golpe: quien copia debe poder revisar la escalera y el peor caso antes
      // de poner dinero, igual que si lo hubiera configurado a mano.
      await this.router.navigate(['/bots/new'], {
        state: {
          copiedFrom: result.sourceName,
          strategy: result.strategy,
          config: result.config,
          exchangeAccountId,
          symbol: row.symbol,
        },
      });
    } catch (e) {
      await this.toast.error(errorText(e));
    }
  }

}

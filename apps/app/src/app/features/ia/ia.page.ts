import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import {
  IonContent,
  IonHeader,
  IonRefresher,
  IonRefresherContent,
  IonSegment,
  IonSegmentButton,
  IonTitle,
  IonToolbar,
} from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { hardwareChipOutline } from 'ionicons/icons';
import { AuthService } from '../../core/auth';
import { AgentesIaService } from '../../core/services/agentes-ia.service';
import { AdminForbiddenComponent } from '../admin/admin-forbidden.component';
import { IaAgentesComponent } from './agentes-vista.component';
import { IaInterruptorComponent } from './ia-interruptor.component';
import { IaOperacionesComponent } from './operaciones-vista.component';
import { IaPropuestasComponent } from './propuestas-vista.component';
import { IaResultadosComponent } from './resultados-vista.component';

type Vista = 'agentes' | 'propuestas' | 'operaciones' | 'resultados';
const VISTAS: readonly Vista[] = ['agentes', 'propuestas', 'operaciones', 'resultados'];

/**
 * La sección de IA (specs 073 y 074): solo existe para un `ADMIN`.
 *
 * Sus cuatro vistas —agentes, propuestas, operaciones y resultados— son un
 * componente cada una: así cada una pide lo suyo cuando se abre y ninguna
 * pasa el presupuesto de estilos. Arriba, siempre, el estado del servidor y el
 * interruptor global de entradas: es lo que se busca con prisa.
 *
 * Se cierra a los demás por tres lados: la barra no pinta la pestaña, la ruta
 * lleva `adminGuard` y esta pantalla no pinta nada si la sesión deja de ser de
 * administrador. La autoridad es el `RolesGuard` del servidor: si responde 403,
 * se dice.
 */
@Component({
  selector: 'app-ia',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    IonContent,
    IonHeader,
    IonRefresher,
    IonRefresherContent,
    IonSegment,
    IonSegmentButton,
    IonTitle,
    IonToolbar,
    AdminForbiddenComponent,
    IaAgentesComponent,
    IaInterruptorComponent,
    IaOperacionesComponent,
    IaPropuestasComponent,
    IaResultadosComponent,
  ],
  template: `
    <ion-header>
      <ion-toolbar><ion-title>IA</ion-title></ion-toolbar>
      @if (esAdmin()) {
        <ion-toolbar>
          <ion-segment scrollable [value]="vista()" (ionChange)="elegir($any($event.detail.value))">
            <ion-segment-button value="agentes">Agentes</ion-segment-button>
            <ion-segment-button value="propuestas">
              Propuestas{{ pendientes() ? ' (' + pendientes() + ')' : '' }}
            </ion-segment-button>
            <ion-segment-button value="operaciones">
              Operaciones{{ vivas() ? ' (' + vivas() + ')' : '' }}
            </ion-segment-button>
            <ion-segment-button value="resultados">Resultados</ion-segment-button>
          </ion-segment>
        </ion-toolbar>
      }
    </ion-header>

    <ion-content>
      @if (esAdmin()) {
        <ion-refresher slot="fixed" (ionRefresh)="refrescar($event)">
          <ion-refresher-content />
        </ion-refresher>
        <div class="pad">
          @if (servicio.prohibido()) {
            <app-admin-forbidden />
          } @else {
            <app-ia-interruptor />
            @switch (vista()) {
              @case ('agentes') {
                <app-ia-agentes />
              }
              @case ('propuestas') {
                <app-ia-propuestas />
              }
              @case ('operaciones') {
                <app-ia-operaciones />
              }
              @case ('resultados') {
                <app-ia-resultados />
              }
            }
          }
        </div>
      }
    </ion-content>
  `,
})
export class IaPage {
  private readonly auth = inject(AuthService);
  readonly servicio = inject(AgentesIaService);

  readonly esAdmin = computed(() => this.auth.user()?.role === 'ADMIN');
  readonly vista = signal<Vista>('agentes');
  readonly pendientes = this.servicio.pendientes;
  readonly vivas = computed(() => this.servicio.resumen()?.vivas ?? 0);

  constructor() {
    addIcons({ hardwareChipOutline });
    // `?vista=propuestas`: el enlace de un aviso lleva directo a lo que espera.
    inject(ActivatedRoute)
      .queryParamMap.pipe(takeUntilDestroyed())
      .subscribe((q) => {
        const v = q.get('vista');
        if (v && (VISTAS as readonly string[]).includes(v)) this.vista.set(v as Vista);
      });
  }

  elegir(v: string): void {
    if ((VISTAS as readonly string[]).includes(v)) this.vista.set(v as Vista);
  }

  /** El resumen y la vista abierta piden lo suyo a la vez; el gesto espera al resumen. */
  async refrescar(ev: CustomEvent): Promise<void> {
    await this.servicio.avisar();
    void (ev.target as HTMLIonRefresherElement).complete();
  }
}

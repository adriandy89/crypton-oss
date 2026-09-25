import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { IonButton, IonSpinner } from '@ionic/angular/standalone';
import { EstadoRondaAgente, type DetallePropuesta } from '@crypton/shared';
import { AgentesIaService } from '../../core/services/agentes-ia.service';
import { errorText, price, shortDate } from '../../core/utils';
import { TESIS, reloj, rTexto, textoDe } from '../../core/utils/agentes-ia';
import { AccionItemComponent } from './accion-item.component';
import { AgentesAccionesService } from './agentes-acciones.service';
import { PlanResumenComponent } from './plan-resumen.component';

/**
 * La operación de un agente, en el detalle de su bot `AGENT_TRADE` (spec
 * 074): de qué propuesta nace, el plan con el que entró frente a lo de ahora,
 * lo último del seguimiento y, si espera a una persona, sus botones.
 *
 * Solo para un administrador y sobre bots propios: la ruta es de la consola, y
 * a un bot ajeno responde 404, que aquí se calla.
 */
@Component({
  selector: 'app-operacion-ia-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, IonButton, IonSpinner, AccionItemComponent, PlanResumenComponent],
  template: `
    @if (detalle(); as d) {
      @let p = d.propuesta;
      <p class="ia-nota">
        Nace de una propuesta de {{ p.agente }} del {{ shortDate(p.creadaEn) }}.
        <a [routerLink]="['/ia/propuestas', p.id]">Ver la propuesta</a>
      </p>
      @if (p.operacion; as op) {
        <dl class="ia-kv">
          <dt>Ahora</dt>
          <dd class="num">{{ rTexto(op.r) }}{{ op.stop ? ' · stop ' + price(op.stop) : '' }}</dd>
          <dt>Primer objetivo</dt>
          <dd>{{ op.tp1Hecho ? 'cobrado' : 'aún no' }}</dd>
          @if (op.revision; as rv) {
            <dt>Seguimiento</dt>
            <dd>
              {{ shortDate(rv.en) }} · idea {{ textoDe(TESIS, rv.estado.tesis) }} · lo mejor
              {{ rTexto(rv.estado.mfeR) }}
            </dd>
          }
        </dl>
        @if (op.ultimaAccion; as a) {
          <app-accion-item [accion]="a" [ahora]="ahora()" (cambiado)="recargar()" />
        }
      }
      <h4>El plan con el que entró</h4>
      <app-plan-resumen [plan]="p.planFinal ?? p.plan" />
      @if (viva()) {
        <div class="bts">
          <ion-button size="small" fill="outline" [disabled]="ocupado()" (click)="revisar()">
            Revisar ahora
          </ion-button>
          <ion-button
            size="small"
            fill="clear"
            color="danger"
            [disabled]="ocupado()"
            (click)="cerrar()"
          >
            Cerrar a mercado
          </ion-button>
        </div>
      }
    } @else if (cargando()) {
      <ion-spinner name="crescent" />
    } @else if (error(); as e) {
      <p class="ia-nota">{{ e }}</p>
    }
  `,
  styles: [
    `
      h4 {
        margin: var(--space-3) 0 var(--space-2);
        font-size: 12.5px;
        font-weight: 700;
      }

      .bts {
        display: flex;
        gap: var(--space-2);
        margin-top: var(--space-3);
      }
    `,
  ],
})
export class OperacionIaPanelComponent implements OnInit {
  private readonly servicio = inject(AgentesIaService);
  private readonly acciones = inject(AgentesAccionesService);
  private readonly destroyRef = inject(DestroyRef);

  readonly botId = input.required<string>();
  /** Algo cambió la operación: el detalle del bot vuelve a pedir lo suyo. */
  readonly cambiado = output<void>();

  readonly detalle = signal<DetallePropuesta | null>(null);
  readonly cargando = signal(true);
  readonly error = signal<string | null>(null);
  readonly ocupado = signal(false);
  readonly ahora = reloj();

  readonly price = price;
  readonly shortDate = shortDate;
  readonly rTexto = rTexto;
  readonly textoDe = textoDe;
  readonly TESIS = TESIS;

  readonly viva = computed(() => {
    const e = this.detalle()?.propuesta.estado;
    return e === 'ABIERTA' || e === 'EJECUTANDO';
  });

  private turno = 0;
  /** Para dejar de esperar una ronda al cerrar el panel. */
  private abierta = true;

  ngOnInit(): void {
    this.destroyRef.onDestroy(() => (this.abierta = false));
    void this.cargar();
    this.servicio.cambios
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => void this.cargar());
  }

  async recargar(): Promise<void> {
    await this.cargar();
    this.cambiado.emit();
  }

  private async cargar(): Promise<void> {
    const t = ++this.turno;
    try {
      const d = await this.servicio.operacionDeBot(this.botId());
      if (t !== this.turno) return;
      this.detalle.set(d);
      this.error.set(null);
    } catch (e) {
      if (t !== this.turno) return;
      // Un bot de otro administrador, o una API anterior al spec 074: nada que enseñar.
      const status = (e as { status?: number }).status;
      this.error.set(status === 404 ? null : errorText(e));
    } finally {
      if (t === this.turno) this.cargando.set(false);
    }
  }

  async revisar(): Promise<void> {
    const p = this.detalle()?.propuesta;
    if (!p) return;
    const r = await this.hacer(() => this.acciones.revisar(p));
    // El servidor responde en cuanto la ronda existe, y el modelo puede tardar
    // hasta su plazo: se recarga hasta verla terminada (spec 078).
    if (r?.estado === EstadoRondaAgente.EN_CURSO) {
      await this.acciones.esperarRonda(
        r.id,
        'Revisión',
        async () => {
          await this.recargar();
          return this.detalle()?.seguimiento;
        },
        () => this.abierta,
      );
    }
  }

  async cerrar(): Promise<void> {
    const p = this.detalle()?.propuesta;
    if (p) await this.hacer(() => this.acciones.cerrar(p));
  }

  private async hacer<T>(f: () => Promise<T>): Promise<T | null> {
    if (this.ocupado()) return null;
    this.ocupado.set(true);
    try {
      const r = await f();
      await this.recargar();
      return r;
    } finally {
      this.ocupado.set(false);
    }
  }
}

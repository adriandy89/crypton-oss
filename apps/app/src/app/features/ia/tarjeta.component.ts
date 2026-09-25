import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { EstadisticaR, TarjetaAgente } from '@crypton/shared';
import { money, signed } from '../../core/utils';
import {
  FAMILIA,
  SALIDA,
  ladoTexto,
  porcentaje,
  rTexto,
  textoDe,
} from '../../core/utils/agentes-ia';

/**
 * La tarjeta de resultados de un agente, o de varios del mismo tipo de cuenta
 * (spec 074, R-25). La aritmética viene hecha del servidor (`tarjetaAgente`,
 * con sus tests): aquí solo se pone en palabras. Se enseña; nada de lo que
 * decide la lee.
 */
@Component({
  selector: 'app-ia-tarjeta',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let t = tarjeta();
    <dl class="ia-kv">
      <dt>Propuestas</dt>
      <dd class="num">
        {{ t.propuestas }} · {{ t.tomadas }} tomadas · {{ t.rechazadas }} descartadas ·
        {{ t.caducadas }} caducadas
      </dd>
      <dt>Operaciones cerradas</dt>
      <dd class="num">{{ estadistica(t.operaciones) }}</dd>
      <dt>Resultado</dt>
      <dd class="num">{{ signed(t.resultado) }}</dd>
      @if (t.brechaEjecucion !== null) {
        <dt>Al ejecutar</dt>
        <dd class="num">{{ rTexto(t.brechaEjecucion) }} por operación frente a lo hipotético</dd>
      }
      @if (consultas() !== null) {
        <dt>Coste de la IA</dt>
        <dd class="num">
          {{ consultas() }} consultas · {{ money(coste(), 3) }} $
          @if (consultasSinCoste() > 0) {
            · {{ consultasSinCoste() }} sin coste conocido
          }
        </dd>
      }
    </dl>

    <h4>¿Discrimina la IA?</h4>
    <dl class="ia-kv">
      <dt>Lo que eligió</dt>
      <dd class="num">{{ estadistica(t.elegidas) }}</dd>
      <dt>Lo que tuvo delante y no eligió</dt>
      <dd class="num">{{ estadistica(t.noElegidas) }}</dd>
    </dl>
    <p class="veredicto">{{ discrimina() }}</p>

    <h4>Tus descartes</h4>
    <p class="veredicto">
      @if (t.descartes.n) {
        Lo que descartaste habría dado {{ estadistica(t.descartes) }}.
      } @else {
        Aún no has descartado nada que se haya podido medir.
      }
    </p>

    @if (t.porFamilia.length) {
      <h4>Por familia</h4>
      <dl class="ia-kv">
        @for (f of t.porFamilia; track f.familia + f.lado) {
          <dt>{{ textoDe(FAMILIA, f.familia) }}, {{ ladoTexto(f.lado) }}</dt>
          <dd class="num">{{ estadistica(f.operaciones) }}</dd>
        }
      </dl>
    }
    @if (t.porSalida.length) {
      <h4>Cómo salieron</h4>
      <p class="veredicto num">{{ salidas() }}</p>
    }
  `,
  styles: [
    `
      h4 {
        margin: var(--space-4) 0 var(--space-2);
        font-size: 12.5px;
        font-weight: 700;
      }

      .veredicto {
        margin: var(--space-2) 0 0;
        font-size: 12px;
        line-height: 1.5;
        color: var(--text-2);
      }
    `,
  ],
})
export class IaTarjetaComponent {
  readonly tarjeta = input.required<TarjetaAgente>();
  /** Lo que costó preguntar al modelo; sin ello no se enseña la línea. */
  readonly consultas = input<number | null>(null);
  readonly coste = input<string>('0');
  /** Las que no trajeron coste: una cortada se cobra y no dice cuánto (spec 078). */
  readonly consultasSinCoste = input<number>(0);

  readonly textoDe = textoDe;
  readonly ladoTexto = ladoTexto;
  readonly signed = signed;
  readonly money = money;
  readonly rTexto = rTexto;
  readonly FAMILIA = FAMILIA;

  /** «+0,35 R de media · acierto 55 % (al menos 41 %) · 23 casos · muestra pequeña». */
  estadistica(e: EstadisticaR): string {
    if (e.n === 0) return 'sin casos';
    const partes = [
      `${rTexto(e.rMedio)} de media`,
      `acierto ${porcentaje((e.aciertos / e.n) * 100, 0)} (al menos ${porcentaje(e.wilsonInferior * 100, 0)})`,
      `${e.n} ${e.n === 1 ? 'caso' : 'casos'}`,
    ];
    if (e.muestraPequena) partes.push('muestra pequeña');
    return partes.join(' · ');
  }

  readonly discrimina = computed(() => {
    const { elegidas, noElegidas } = this.tarjeta();
    if (elegidas.muestraPequena || noElegidas.muestraPequena) {
      return 'Muestra pequeña: hasta 30 casos de cada lado, esto no dice nada todavía.';
    }
    if ((elegidas.rMedio ?? 0) > (noElegidas.rMedio ?? 0)) {
      return 'Lo que elige va mejor que lo que deja: por ahora, distingue.';
    }
    return 'Lo que elige no va mejor que lo que deja: por ahora, no está aportando.';
  });

  readonly salidas = computed(() =>
    this.tarjeta()
      .porSalida.map((s) => `${textoDe(SALIDA, s.salida)} ${s.n}`)
      .join(' · '),
  );
}

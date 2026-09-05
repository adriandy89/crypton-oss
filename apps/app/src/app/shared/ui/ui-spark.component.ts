import { Component, computed, input } from '@angular/core';
import { TRAZO_ANCHO, trazosDeSerie } from '@crypton/shared';

export type SparkMode = 'line' | 'area' | 'bars';
export type SparkTone = 'auto' | 'up' | 'down' | 'warn' | 'neutral';

/**
 * Miniserie de solo lectura, en SVG, para dentro de una tarjeta.
 *
 * Es el segundo motor grafico de la app, y existe por una cuenta: cada
 * instancia de `lightweight-charts` monta siete lienzos y un `ResizeObserver`
 * por lienzo, y veinte miniseries en la lista de bots serian ciento cuarenta en
 * un WebView de Android, ademas de meter los ~190 kB del motor en la pestana
 * de aterrizaje. La frontera con `app-price-chart` es mecanica: si tiene eje de
 * tiempo manipulable, cruceta o lineas de precio, es aquel; si es un glifo de
 * datos dentro de una tarjeta, es este.
 *
 * Decisiones que no son de gusto:
 *
 *   - `viewBox="0 0 100 alto"` con `preserveAspectRatio="none"`: asi el ancho
 *     lo pone el contenedor y no hay que medirlo, que es toda la razon de no
 *     usar el motor grande. Con el escalado no uniforme un trazo de 1 px se ve
 *     de 2,5 en una tarjeta ancha y de 0,4 en una estrecha; lo corrige
 *     `vector-effect="non-scaling-stroke"`.
 *   - El color sale del CSS, no de `getComputedStyle`. Un SVG entiende
 *     `var(--pnl-up)`; el trazo usa `currentColor` y el `:host` lleva la clase
 *     de tono. Cero tema en JavaScript y cero deriva con `variables.scss`. El
 *     relleno del area es el mismo color con opacidad, no un color compuesto:
 *     `color-mix()` no esta garantizado en el WebView que la app soporta.
 *   - Sin suavizado. Una curva de Bezier inventa valores entre dos puntos, y
 *     sobre dinero eso es una mentira dibujada.
 *   - La linea se ROMPE en los huecos (`breaks`): un bot parado no escribe
 *     snapshots, y cruzar el hueco afirmaria que el valor se mantuvo.
 *   - La geometria la calcula `trazosDeSerie` en `@crypton/shared`, que tiene
 *     tests, y el marcador del peor momento lee SUS coordenadas: proyectar dos
 *     veces acabaria con el punto flotando fuera de la curva.
 *
 * Las barras van en HTML y no en SVG: bajo el escalado no uniforme los radios
 * de las esquinas se deforman, y un `border-radius` de CSS no.
 */
@Component({
  selector: 'ui-spark',
  standalone: true,
  template: `
    @if (mode() === 'bars') {
      <div class="bars" [style.height.px]="height()" [attr.aria-label]="label()" role="img">
        <div class="half top" [style.flex-basis.%]="split().top">
          @for (b of bars(); track $index) {
            <i [class.up]="b.up" [class.down]="!b.up" [style.height.%]="b.up ? b.h : 0"></i>
          }
        </div>
        <div class="half bottom" [style.flex-basis.%]="split().bottom">
          @for (b of bars(); track $index) {
            <i [class.down]="!b.up" [style.height.%]="b.up ? 0 : b.h"></i>
          }
        </div>
      </div>
    } @else {
      <svg
        [attr.viewBox]="'0 0 ' + ancho + ' ' + height()"
        preserveAspectRatio="none"
        width="100%"
        [attr.height]="height()"
        [attr.role]="height() >= 24 ? 'img' : null"
        [attr.aria-hidden]="height() >= 24 ? null : 'true'"
      >
        @if (height() >= 24) {
          <title>{{ label() }}</title>
        }
        @if (trazos().baseY !== null) {
          <line
            class="base"
            x1="0"
            [attr.y1]="trazos().baseY"
            [attr.x2]="ancho"
            [attr.y2]="trazos().baseY"
            vector-effect="non-scaling-stroke"
          />
        }
        @if (mode() === 'area') {
          <path class="area" [attr.d]="trazos().area" />
        }
        <path class="line" [attr.d]="trazos().linea" vector-effect="non-scaling-stroke" />
      </svg>
      @if (markPos(); as m) {
        <i class="mark" [style.left.%]="m.x" [style.top.%]="m.y"></i>
      }
    }
  `,
  host: { '[class]': 'toneClass()' },
  styles: [
    `
      :host {
        position: relative;
        display: block;
        width: 100%;
        line-height: 0;
      }

      /* El tono es el color del texto del host: todo lo de dentro lo hereda. */
      :host(.up) {
        color: var(--pnl-up);
      }
      :host(.down) {
        color: var(--pnl-down);
      }
      :host(.warn) {
        color: var(--signal-warn);
      }
      :host(.neutral) {
        color: var(--brand-2);
      }

      svg {
        display: block;
        overflow: visible;
      }

      .line {
        fill: none;
        stroke: currentColor;
        stroke-width: 2;
        stroke-linejoin: round;
        stroke-linecap: round;
      }

      .area {
        fill: currentColor;
        fill-opacity: 0.16;
      }

      /* El cero. En una serie de PnL no es opcional: sin el, ir de -40 a -10 se
         lee como una remontada a un buen sitio. */
      .base {
        stroke: var(--border-strong);
        stroke-width: 1;
        stroke-dasharray: 2 2;
      }

      /* El peor momento, como punto HTML y no como <circle>: bajo el escalado
         no uniforme del viewBox un circulo sale elipse. */
      .mark {
        position: absolute;
        width: 7px;
        height: 7px;
        margin: -3.5px 0 0 -3.5px;
        border-radius: 50%;
        background: var(--pnl-down);
        box-shadow: 0 0 0 2px var(--surface-1);
      }

      /* La altura la pone el input, como en el SVG. Con height al 100 % sobre un
         host de altura automatica el bloque se quedaba en auto y cada barra en
         su minimo de 2 px: la grafica salia como una fila de puntos. */
      .bars {
        display: flex;
        flex-direction: column;
        min-height: 24px;
      }

      .half {
        display: flex;
        gap: 3px;
        min-height: 0;
      }

      .half.top {
        align-items: flex-end;
      }

      .half.bottom {
        align-items: flex-start;
      }

      .half i {
        flex: 1;
        display: block;
        min-width: 0;
        background: var(--pnl-up);
      }

      /* Dos pixeles como minimo para que una barra casi nula siga existiendo:
         un ciclo que cerro en cero es un ciclo, no un hueco. */
      .top i.up {
        min-height: 2px;
        border-radius: 4px 4px 0 0;
      }

      .bottom i.down {
        min-height: 2px;
        border-radius: 0 0 4px 4px;
        background: var(--pnl-down);
      }

      .top i.down,
      .bottom i:not(.down) {
        background: transparent;
      }
    `,
  ],
})
export class UiSparkComponent {
  /** Valores ya muestreados. Salen de `vistaDeSerie()`, nunca de cadenas. */
  readonly points = input.required<readonly number[]>();
  /** Indices tras los que la linea se rompe. De `SerieVista.cortes`. */
  readonly breaks = input<readonly number[]>([]);
  readonly mode = input<SparkMode>('line');
  /** 'auto' = verde si el ultimo es mayor o igual que el primero, rojo si no. */
  readonly tone = input<SparkTone>('auto');
  /** Linea de referencia visible. `null` solo en series sin cero con significado. */
  readonly baseline = input<number | null>(null);
  /** Alto en px. El ancho SIEMPRE lo pone el contenedor. */
  readonly height = input<number>(16);
  /** Texto para lector de pantalla. Por debajo de 24 px la fila que la contiene ya imprime las cifras. */
  readonly label = input.required<string>();
  /** Indice del punto que se marca (el peor momento). */
  readonly mark = input<number | null>(null);

  readonly ancho = TRAZO_ANCHO;

  private readonly rango = computed(() => {
    const pts = this.points();
    if (pts.length === 0) return { min: 0, max: 0 };
    let min = pts[0];
    let max = pts[0];
    for (const v of pts) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
    return { min, max };
  });

  readonly trazos = computed(() =>
    trazosDeSerie(this.points(), {
      alto: this.height(),
      min: this.rango().min,
      max: this.rango().max,
      cortes: this.breaks(),
      base: this.baseline(),
    }),
  );

  readonly toneClass = computed(() => {
    const t = this.tone();
    if (t !== 'auto') return t;
    const pts = this.points();
    if (pts.length === 0) return 'neutral';
    return pts[pts.length - 1] >= pts[0] ? 'up' : 'down';
  });

  /** Posicion del marcador, en % del lienzo, leida de las coordenadas del trazo. */
  readonly markPos = computed(() => {
    const i = this.mark();
    const c = i === null ? undefined : this.trazos().coords[i];
    if (!c) return null;
    return { x: (c.x / this.ancho) * 100, y: (c.y / this.height()) * 100 };
  });

  /** Los extremos de cada signo, una sola pasada para las barras y su reparto. */
  private readonly extremos = computed(() => {
    let maxPos = 0;
    let maxNeg = 0;
    for (const v of this.points()) {
      if (v > maxPos) maxPos = v;
      if (-v > maxNeg) maxNeg = -v;
    }
    return { maxPos, maxNeg };
  });

  /** Barras: altura relativa al mayor valor absoluto de su signo. */
  readonly bars = computed(() => {
    const { maxPos, maxNeg } = this.extremos();
    return this.points().map((v) => ({
      up: v >= 0,
      h: v >= 0 ? (maxPos > 0 ? (v / maxPos) * 100 : 0) : maxNeg > 0 ? (-v / maxNeg) * 100 : 0,
    }));
  });

  /**
   * Reparto vertical entre la zona positiva y la negativa, proporcional a los
   * extremos: asi una barra de +10 y otra de -10 miden lo mismo.
   */
  readonly split = computed(() => {
    const { maxPos, maxNeg } = this.extremos();
    const total = maxPos + maxNeg;
    if (total === 0) return { top: 100, bottom: 0 };
    return { top: (maxPos / total) * 100, bottom: (maxNeg / total) * 100 };
  });
}

import { Component, computed, input } from '@angular/core';
import { IonIcon } from '@ionic/angular/standalone';
import type { LevelPreview, PreviewResult } from '../../core/models';

/**
 * Vista previa de la cotizacion de un market maker.
 *
 * Una escalera de rejilla se entiende leyendo sus niveles; una cotizacion de
 * market maker no: lo unico que importa antes de arrancar es a que precio se
 * compra, a que precio se vende y cuanto queda en medio. Eso ultimo es de donde
 * sale TODO el beneficio de la estrategia, y en la lista de niveles hay que
 * calcularlo mentalmente restando dos numeros de seis cifras.
 *
 * El aviso del pie no es relleno legal: el diferencial solo se cobra si las
 * ejecuciones se mantienen equilibradas, y quien no lo sepa va a interpretar
 * este numero como beneficio garantizado.
 */
@Component({
  selector: 'ui-quote-preview',
  standalone: true,
  imports: [IonIcon],
  template: `
    <div class="head">
      <ion-icon name="eye-outline" />
      <span class="ttl">Vista previa de cotización</span>
      @if (direction()) {
        <span class="dir">{{ direction() }}</span>
      }
    </div>

    @if (bid() || ask()) {
      <div class="top">
        <div class="cell">
          <span class="k">Compra</span>
          <span class="v num">{{ bid()?.price ?? '—' }}</span>
        </div>
        <div class="cell">
          <span class="k">Venta</span>
          <span class="v num">{{ ask()?.price ?? '—' }}</span>
        </div>
        <div class="cell">
          <span class="k">Spread</span>
          <span class="v num">{{ spreadPct() ?? '—' }}</span>
        </div>
      </div>

      @if (bid(); as b) {
        <div class="side">
          <span class="tag buy">Compra L1</span>
          <div class="col">
            <span class="px buy num">{{ b.price }}</span>
            <span class="meta num">{{ b.notional }} {{ quoteAsset() }} · {{ bps(b) }}</span>
          </div>
        </div>
      }
      @if (ask(); as a) {
        <div class="side">
          <span class="tag sell">Venta L1</span>
          <div class="col">
            <span class="px sell num">{{ a.price }}</span>
            <span class="meta num">{{ a.notional }} {{ quoteAsset() }} · {{ bps(a) }}</span>
          </div>
        </div>
      }
    } @else {
      <p class="foot">Sin cotización que mostrar con esta configuración.</p>
    }

    <p class="foot">
      El spread solo se captura cuando las ejecuciones se mantienen equilibradas. La tendencia y el
      flujo adverso pueden generar pérdidas de inventario.
    </p>
  `,
  styles: [
    `
      :host {
        display: block;
      }

      .head {
        display: flex;
        align-items: center;
        gap: var(--space-2);
        margin-bottom: var(--space-3);
        font-size: 14px;
        font-weight: 700;
        color: var(--text-1);
      }

      .head ion-icon {
        font-size: 17px;
        color: var(--text-2);
      }

      .ttl {
        flex: 1;
      }

      .dir {
        font-size: 11.5px;
        font-weight: 600;
        color: var(--text-3);
      }

      /* minmax(0, 1fr) y no 1fr a secas: una columna 1fr no baja de su tamano
         minimo, asi que un precio con seis decimales ensanchaba su columna,
         empujaba a las otras dos y la fila se salia del recuadro. */
      .top {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: var(--space-2);
        margin-bottom: var(--space-3);
      }

      .cell {
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
      }

      .k {
        font-size: 11px;
        color: var(--text-3);
      }

      .v {
        font-size: 14px;
        font-weight: 600;
        line-height: 1.25;
        color: var(--text-1);
        overflow-wrap: anywhere;
      }

      .side {
        display: flex;
        align-items: center;
        gap: var(--space-3);
        padding: 10px 0;
        border-top: 1px solid var(--border-subtle);
      }

      .tag {
        flex-shrink: 0;
        width: 78px;
        font-size: 11.5px;
        font-weight: 700;
      }

      .tag.buy {
        color: var(--pnl-up);
      }

      .tag.sell {
        color: var(--pnl-down);
      }

      .col {
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
      }

      .px {
        font-size: 15px;
        font-weight: 600;
      }

      .px.buy {
        color: var(--pnl-up);
      }

      .px.sell {
        color: var(--pnl-down);
      }

      .meta {
        font-size: 11.5px;
        color: var(--text-3);
      }

      .foot {
        margin: var(--space-3) 0 0;
        font-size: 11.5px;
        line-height: 1.5;
        color: var(--text-3);
      }
    `,
  ],
})
export class UiQuotePreviewComponent {
  readonly preview = input.required<PreviewResult | null>();
  readonly direction = input<string>('');
  readonly quoteAsset = input('USDC');

  /**
   * La compra mas cercana al mercado, que es la que se ejecuta primero.
   *
   * Se busca por precio y no por indice: con varios niveles el indice 0 es el
   * primero que genero la estrategia, no necesariamente el mas alto —el orden
   * depende de los multiplicadores por nivel.
   */
  readonly bid = computed(() => this.best('QUOTE_BID', (a, b) => b - a));
  readonly ask = computed(() => this.best('QUOTE_ASK', (a, b) => a - b));

  /**
   * Punto medio entre las dos cotizaciones. null si solo se cotiza un lado.
   *
   * Es la referencia natural de un market maker: el diferencial se mide desde
   * el centro de su propia horquilla, que es justo lo que la cabecera enseña.
   */
  readonly quotedMid = computed(() => {
    const bid = Number(this.bid()?.price);
    const ask = Number(this.ask()?.price);
    if (!bid || !ask) return null;
    return (bid + ask) / 2;
  });

  readonly spreadPct = computed(() => {
    const bid = Number(this.bid()?.price);
    const ask = Number(this.ask()?.price);
    const mid = this.quotedMid();
    if (!mid) return null;
    return (((ask - bid) / mid) * 100).toFixed(2) + ' %';
  });

  /**
   * Distancia del nivel al centro de la horquilla, en bps.
   *
   * Se recalcula aquí en vez de reutilizar `distancePct`, que viene del preview
   * redondeado a dos decimales de PORCENTAJE: la unidad en la que se configura
   * esto es el punto básico, y a esa resolución 17,5 bps se convertían en 18.
   */
  bps(level: LevelPreview): string {
    const mid = this.quotedMid();
    if (mid) return ((Math.abs(Number(level.price) - mid) / mid) * 10_000).toFixed(1) + ' bps';
    // Un solo lado: no hay centro, así que se usa la distancia del preview.
    return (Math.abs(Number(level.distancePct)) * 100).toFixed(1) + ' bps';
  }

  private best(kind: string, order: (a: number, b: number) => number): LevelPreview | null {
    const levels = (this.preview()?.levels ?? []).filter((l) => l.kind === kind);
    if (!levels.length) return null;
    return [...levels].sort((x, y) => order(Number(x.price), Number(y.price)))[0];
  }
}

import { Component, computed, input } from '@angular/core';
import type { PreviewExit, PreviewSide } from '../../core/models';
import { money, pct, price, qty, signed } from '../../core/utils';

/** Una fila de salida, ya rotulada. */
interface Salida {
  clave: 'tp' | 'sl' | 'liq';
  titulo: string;
  exit: PreviewExit;
  /** El color del resultado: el signo del dinero, que es el del % sobre el margen. */
  tono: 'up' | 'down' | '';
  notas: string[];
}

const tonoDe = (pnl: string): Salida['tono'] =>
  Number(pnl) > 0 ? 'up' : Number(pnl) < 0 ? 'down' : '';

/**
 * Un lado de la previsualización, como la confirmación de una orden en un
 * exchange apalancado (spec 080): la posición —entrada media, tamaño y margen—
 * y sus salidas —objetivo, stop y liquidación— con el precio, el movimiento
 * desde la entrada, el resultado en dinero y el % sobre el margen.
 *
 * Presentacional puro: cada cifra llega calculada por `buildPreview` con
 * `Decimal`, la misma función que ejecuta el motor. Aquí no se suma nada.
 *
 * Existe porque la Revisión enseñaba «Objetivo de beneficio 71911» sin decir
 * que a 15× eso era un +225 % del margen, la liquidación con tres distancias
 * distintas y el stop no aparecía (079/F-04, F-07 y F-09).
 */
@Component({
  selector: 'ui-preview-side',
  standalone: true,
  template: `
    <div class="head">
      <span class="lado" [class.corto]="side().direction === 'SHORT'">
        {{ side().direction === 'SHORT' ? 'Corto' : 'Largo' }}
      </span>
      <span class="meta num">
        {{ leverage() }}× · {{ marginMode() === 'CROSS' ? 'margen cruzado' : 'margen aislado' }}
      </span>
    </div>

    <div class="pos">
      <div>
        <span class="k">Entrada media</span>
        <span class="v num">{{ price(side().averageEntry, decimals()) }}</span>
        @if (side().entries > 1) {
          <span class="s">{{ side().entries }} entradas</span>
        }
      </div>
      <div>
        <span class="k">Tamaño</span>
        <span class="v num">{{ qty(side().qty, qtyDecimals()) }} {{ base() }}</span>
        <span class="s num">{{ money(side().notional) }} {{ quote() }}</span>
      </div>
      <div>
        <span class="k">Margen</span>
        <span class="v num">{{ money(side().margin) }} {{ quote() }}</span>
      </div>
    </div>

    @for (s of salidas(); track s.clave) {
      <div class="exit" [class]="s.clave">
        <div class="l1">
          <span class="k">{{ s.titulo }}</span>
          <span class="v num">{{ price(s.exit.price, decimals()) }}</span>
        </div>
        <div class="l2 num">
          <span>{{ pct(s.exit.movePct) }} de precio</span>
          <span [class]="s.tono">{{ signed(s.exit.pnl) }} {{ quote() }}</span>
          <span [class]="s.tono">{{ pct(s.exit.roiPct) }} del margen</span>
        </div>
        @if (s.exit.fromRefPct !== s.exit.movePct) {
          <p class="nota num">{{ pct(s.exit.fromRefPct) }} desde el último precio.</p>
        }
        @for (n of s.notas; track n) {
          <p class="nota">{{ n }}</p>
        }
      </div>
    }

    @if (side().rewardRisk; as rr) {
      <p class="rr">
        Beneficio / riesgo <b class="num">{{ money(rr) }}</b>
        <span>lo que recorre el precio hasta el objetivo por cada 1 hasta el stop</span>
      </p>
    }

    @if (corte(); as c) {
      <p class="cut">{{ c }}</p>
    }
  `,
  styles: [
    `
      :host {
        display: block;
        padding: var(--space-3) 0 0;
        margin-top: var(--space-3);
        border-top: 1px solid var(--border-subtle);
      }

      .head {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: var(--space-2);
        margin-bottom: 10px;
      }

      .lado {
        font-family: var(--font-display);
        font-size: 13.5px;
        font-weight: 700;
        color: var(--pnl-up);
      }

      .lado.corto {
        color: var(--pnl-down);
      }

      .meta {
        font-size: 11px;
        color: var(--text-3);
      }

      .pos {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: var(--space-2);
        margin-bottom: var(--space-2);
      }

      .pos > div {
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
      }

      .k {
        font-size: 10.5px;
        color: var(--text-3);
      }

      .v {
        font-size: 14px;
        font-weight: 600;
        color: var(--text-1);
        overflow-wrap: anywhere;
      }

      .s {
        font-size: 11px;
        color: var(--text-3);
      }

      .exit {
        padding: 9px 11px;
        margin-top: 6px;
        border-radius: var(--radius-sm);
        background: var(--surface-2);
        border-left: 3px solid var(--border-strong);
      }

      .exit.tp {
        border-left-color: var(--pnl-up);
      }

      .exit.sl {
        border-left-color: var(--signal-warn);
      }

      .exit.liq {
        border-left-color: var(--pnl-down);
      }

      .l1 {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: var(--space-2);
      }

      .l2 {
        display: flex;
        flex-wrap: wrap;
        gap: 4px 12px;
        margin-top: 3px;
        font-size: 11.5px;
        color: var(--text-2);
      }

      .up {
        color: var(--pnl-up);
      }

      .down {
        color: var(--pnl-down);
      }

      .nota {
        margin: 4px 0 0;
        font-size: 11px;
        line-height: 1.45;
        color: var(--text-3);
      }

      .rr {
        display: flex;
        flex-wrap: wrap;
        align-items: baseline;
        gap: 2px 8px;
        margin: 10px 0 0;
        font-size: 12px;
        color: var(--text-2);
      }

      .rr span {
        font-size: 10.5px;
        color: var(--text-3);
      }

      .cut {
        margin: 10px 0 0;
        padding: 9px 11px;
        border-radius: var(--radius-sm);
        font-size: 11.5px;
        line-height: 1.5;
        background: rgba(var(--signal-warn-rgb), 0.1);
        color: var(--signal-warn);
      }
    `,
  ],
})
export class UiPreviewSideComponent {
  readonly side = input.required<PreviewSide>();
  readonly leverage = input(1);
  readonly marginMode = input<string | null>(null);
  readonly decimals = input<number | null>(null);
  readonly qtyDecimals = input<number | null>(null);
  readonly base = input('');
  readonly quote = input('USDC');
  /** Rótulo del nivel donde se corta el recorrido, el mismo de la lista de niveles. */
  readonly cutLabel = input<string | null>(null);

  readonly money = money;
  readonly pct = pct;
  readonly price = price;
  readonly qty = qty;
  readonly signed = signed;

  readonly salidas = computed<Salida[]>(() => {
    const s = this.side();
    const out: Salida[] = [];
    if (s.takeProfit) {
      const notas: string[] = [];
      if (s.takeProfitIsActivation) {
        notas.push(
          'No es el precio al que sale: desde ahí sigue al precio y sale cuando retrocede.',
        );
      }
      // El satélite de GridMart o el primer objetivo de un agente: sale una parte.
      if (s.takeProfit.qty !== s.qty) {
        notas.push(
          `Sale por él una parte de la posición: ${qty(s.takeProfit.qty, this.qtyDecimals())} ` +
            `${this.base()}.`,
        );
      }
      out.push({
        clave: 'tp',
        titulo: s.takeProfitIsActivation ? 'Objetivo · empieza a seguir' : 'Objetivo',
        exit: s.takeProfit,
        tono: tonoDe(s.takeProfit.pnl),
        notas,
      });
    }
    if (s.stopLoss) {
      out.push({
        clave: 'sl',
        titulo: s.stopLossEstimated ? 'Stop · estimado' : 'Stop',
        exit: s.stopLoss,
        tono: tonoDe(s.stopLoss.pnl),
        notas: s.stopLossEstimated
          ? ['Con una volatilidad supuesta: el bot lo calcula con la real al entrar.']
          : [],
      });
    }
    if (s.liquidation) {
      out.push({
        clave: 'liq',
        titulo: s.liquidationIsBound ? 'Liquidación · cota' : 'Liquidación',
        exit: s.liquidation,
        tono: tonoDe(s.liquidation.pnl),
        notas: s.liquidationIsBound
          ? [
              'En margen cruzado el venue suma el saldo libre de la cuenta: la real queda más ' +
                'lejos, y lo que se pierde en ella puede pasar del margen de arriba.',
            ]
          : [],
      });
    }
    return out;
  });

  /** Dónde se corta el recorrido, dicho con el nivel de la lista. */
  readonly corte = computed<string | null>(() => {
    const c = this.side().cutAt;
    if (!c) return null;
    const nivel = this.cutLabel() ?? `el nivel ${c.level}`;
    const entradas = this.side().entries;
    const posicion = `la posición de arriba es la de las ${entradas} primeras entradas.`;
    // El tope no deja TENDER el nivel: no es que no se llene, es que no se
    // coloca, y la Revisión ya no lo cuenta en los totales. Mide la posición
    // valorada al precio del nivel, no lo que costó: sin decirlo, un tamaño de
    // 833,69 con un tope de 800 parecía un tope que no funciona.
    if (c.by === 'TOPE') {
      return (
        `El tope de exposición no deja tender ${nivel}: con él, la posición valorada a ese ` +
        'precio ya no cabe. El tope mide lo que vale la posición, no lo que costó, así que el ' +
        `tamaño de arriba puede pasar de él. Desde ahí los niveles no se colocan, y ${posicion}`
      );
    }
    const quien = c.by === 'STOP' ? 'El stop salta' : 'La liquidación llega';
    return `${quien} antes que ${nivel}: desde ahí los niveles no se ejecutan, y ${posicion}`;
  });
}

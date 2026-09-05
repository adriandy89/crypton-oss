import { BotsService, liquidationDistanceOf } from './bots.service';

/**
 * Las métricas que la API deriva del último snapshot, por la parte que hoy
 * mentía en la app.
 *
 * `BotSummary.liquidationDistancePct` estaba declarado en el contrato compartido
 * con el comentario «La métrica de riesgo nº 1» y nadie lo rellenaba, así que
 * cada pantalla se lo calculaba: la cartera y la lista contra el precio de
 * ENTRADA —que no se mueve con el mercado— y solo el gráfico contra el precio
 * vivo. Estos tests fijan que el número sale de aquí, contra el precio de
 * mercado, y que viaja junto con `totalInvestment` (spec 002, F-01 a F-03).
 */

const dec = (v: string) => ({ toString: () => v });

describe('liquidationDistanceOf', () => {
  it('mide contra el precio de MERCADO, no contra el de entrada', () => {
    // Entrada en 100 y liquidación en 80: la distancia «estática» sería 20 %.
    // Pero el precio ya está en 84: quedan 4,76 %, y eso es lo que hay que ver.
    const s = { mark_price: dec('84'), liquidation_price: dec('80') };
    expect(liquidationDistanceOf(s)).toBe('4.76');
  });

  it('en corto la liquidación está por encima y la distancia sigue siendo positiva', () => {
    expect(liquidationDistanceOf({ mark_price: dec('100'), liquidation_price: dec('125') })).toBe(
      '25.00',
    );
  });

  it('sin liquidación, sin snapshot o con precios inválidos devuelve null en vez de un cero', () => {
    // Un cero se leería como «a punto de liquidar»; null se lee como «no aplica».
    expect(liquidationDistanceOf(null)).toBeNull();
    expect(liquidationDistanceOf({ mark_price: dec('100'), liquidation_price: null })).toBeNull();
    expect(
      liquidationDistanceOf({ mark_price: dec('0'), liquidation_price: dec('80') }),
    ).toBeNull();
    expect(
      liquidationDistanceOf({ mark_price: dec('100'), liquidation_price: dec('0') }),
    ).toBeNull();
  });
});

describe('metricsOf', () => {
  // Método privado: se llama a través del prototipo, con un cast que el test
  // declara. La alternativa —hacerlo público— ampliaría la superficie del
  // servicio solo para probarlo.
  const metricsOf = (
    bot: { total_investment: { toString(): string }; started_at: Date | null; dry_run: boolean },
    snapshot: Parameters<typeof liquidationDistanceOf>[0] & {
      realized_pnl_acc: { toString(): string };
      unrealized_pnl: { toString(): string };
      position_qty: { toString(): string };
      average_entry: { toString(): string } | null;
      open_orders: number;
    },
  ) =>
    (
      BotsService.prototype as unknown as {
        metricsOf: (b: typeof bot, s: typeof snapshot) => Record<string, unknown>;
      }
    ).metricsOf(bot, snapshot);

  it('rellena los dos campos del contrato que estaban muertos', () => {
    const m = metricsOf(
      { total_investment: dec('1000'), started_at: null, dry_run: false },
      {
        realized_pnl_acc: dec('71.4'),
        unrealized_pnl: dec('-13.2'),
        position_qty: dec('0.0284'),
        average_entry: dec('60118.4'),
        mark_price: dec('61140'),
        liquidation_price: dec('46812.5'),
        open_orders: 14,
      },
    );
    expect(m.totalInvestment).toBe('1000');
    expect(m.liquidationDistancePct).toBe('23.43');
    // Y lo que ya se servía sigue igual.
    expect(m.roiPct).toBe('5.82');
    expect(m.realizedPnl).toBe('71.4');
  });
});

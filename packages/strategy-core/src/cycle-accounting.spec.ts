import { D, Venue, type CycleState, type Fill } from '@crypton/shared';
import { makeCoid } from './client-order-id';
import { cycleAfterFill, type CycleTotals } from './cycle-accounting';

/**
 * La aritmética del dinero, ahora que es una función pura.
 *
 * Vivía dentro de una transacción de Prisma, así que solo se podía comprobar de
 * refilón a través del motor entero. Estos casos fijan las reglas una a una — y
 * en particular la del acumulado, que ya se rompió una vez y de ella sale el
 * drawdown que dispara el kill-switch.
 */

const BOT = '1a2b3c4d-0000-4000-8000-000000000000';

const cycle = (over: Partial<CycleState> = {}): CycleState => ({
  cycleId: 'c1',
  startedAt: 0,
  entriesFilled: 0,
  lastEntryAt: null,
  filledLevelIndexes: [],
  cooldownUntil: null,
  realizedPnl: '0',
  realizedPnlAcc: '0',
  averageEntry: null,
  anchorPrice: null,
  scratch: { cycleSeq: 1 },
  ...over,
});

const totals = (over: Partial<CycleTotals> = {}): CycleTotals => ({
  qty: D(0),
  averageEntry: null,
  realizedPnl: D(0),
  fees: D(0),
  entriesFilled: 0,
  filledLevelIndexes: [],
  anchorPrice: null,
  lastEntryAt: null,
  ...over,
});

const fill = (
  side: 'BUY' | 'SELL',
  price: string,
  qty: string,
  kind: 'BASE' | 'SAFETY' | 'GRID_BUY' | 'GRID_SELL' | 'TAKE_PROFIT' = 'BASE',
  index = 0,
  fee = '0',
): Fill => ({
  venue: Venue.HYPERLIQUID,
  symbol: 'BTC',
  venueFillId: 'f' + price + qty,
  venueOrderId: 'o1',
  clientOrderId: makeCoid(BOT, 1, kind, index),
  side,
  price,
  qty,
  fee,
  feeAsset: 'USDC',
  isTaker: false,
  ts: 1_000,
});

describe('cycleAfterFill', () => {
  it('abrir fija el precio medio y marca el nivel y el ancla', () => {
    const r = cycleAfterFill(cycle(), totals(), fill('BUY', '100', '1'), {}, 0);

    expect(r.totals.qty.toFixed()).toBe('1');
    expect(r.totals.averageEntry!.toFixed()).toBe('100');
    expect(r.totals.entriesFilled).toBe(1);
    expect(r.totals.filledLevelIndexes).toEqual([0]);
    // El ancla se fija en el primer BASE: de ahí cuelgan las seguridades de la
    // martingala, y recalcularla con el precio vivo las iría alejando.
    expect(r.totals.anchorPrice!.toFixed()).toBe('100');
    expect(r.closed).toBe(false);
  });

  it('aumentar promedia ponderando por cantidad', () => {
    const t = totals({ qty: D(1), averageEntry: D(100), entriesFilled: 1 });
    const r = cycleAfterFill(cycle(), t, fill('BUY', '80', '1', 'SAFETY', 1), {}, 0);

    expect(r.totals.qty.toFixed()).toBe('2');
    expect(r.totals.averageEntry!.toFixed()).toBe('90');
    expect(r.totals.filledLevelIndexes).toEqual([1]);
    expect(r.reduced).toBe(false);
  });

  it('reducir realiza contra el medio y no toca el medio', () => {
    const t = totals({ qty: D(2), averageEntry: D(90) });
    const r = cycleAfterFill(cycle(), t, fill('SELL', '100', '1', 'GRID_SELL'), {}, 0);

    expect(r.totals.qty.toFixed()).toBe('1');
    expect(r.totals.averageEntry!.toFixed()).toBe('90');
    expect(r.matched.toFixed()).toBe('10');
    expect(r.totals.realizedPnl.toFixed()).toBe('10');
    expect(r.reduced).toBe(true);
  });

  it('la comisión sale del realizado, pero NO del diferencial capturado', () => {
    // Son dos cifras distintas a propósito: con solo el realizado no se puede
    // saber si un bot gana poco porque cotiza estrecho o porque el venue se
    // lleva lo que gana.
    const t = totals({ qty: D(2), averageEntry: D(90) });
    const f = fill('SELL', '100', '1', 'GRID_SELL', 0, '2');
    const r = cycleAfterFill(cycle(), t, f, {}, 0);

    expect(r.matched.toFixed()).toBe('10');
    expect(r.totals.realizedPnl.toFixed()).toBe('8');
    expect(r.totals.fees.toFixed()).toBe('2');
  });

  it('una salida al precio medio cierra el par aunque no gane nada', () => {
    // `reduced` es bandera propia y no se deduce de `matched`: deduciéndolo,
    // este par no se habría contado.
    const t = totals({ qty: D(1), averageEntry: D(100) });
    const r = cycleAfterFill(cycle(), t, fill('SELL', '100', '1', 'GRID_SELL'), {}, 0);

    expect(r.matched.toFixed()).toBe('0');
    expect(r.reduced).toBe(true);
  });

  it('dar la vuelta a la posición reancla la entrada al precio del fill', () => {
    const t = totals({ qty: D(1), averageEntry: D(100) });
    const r = cycleAfterFill(cycle(), t, fill('SELL', '120', '3', 'GRID_SELL'), {}, 0);

    expect(r.totals.qty.toFixed()).toBe('-2');
    expect(r.totals.averageEntry!.toFixed()).toBe('120');
    // Solo se realiza sobre la parte que CIERRA, no sobre las tres.
    expect(r.matched.toFixed()).toBe('20');
  });

  it('volver a plana cierra el ciclo y abre el siguiente', () => {
    const t = totals({ qty: D(1), averageEntry: D(100), entriesFilled: 1 });
    const r = cycleAfterFill(
      cycle({ scratch: { cycleSeq: 4 } }),
      t,
      fill('SELL', '110', '1', 'TAKE_PROFIT'),
      { cooldownMinutes: 5 },
      1_000_000,
    );

    expect(r.closed).toBe(true);
    expect(r.cycle.realizedPnl).toBe('0');
    expect(r.cycle.filledLevelIndexes).toEqual([]);
    expect(r.cycle.averageEntry).toBeNull();
    expect(r.cycle.anchorPrice).toBeNull();
    expect(r.cycle.scratch).toEqual({ cycleSeq: 5, cooldownMinutes: 5 });
    // El enfriamiento se cuenta desde el `now` que se pasa, no del reloj: es lo
    // que permite que un backtest lo respete con su propio tiempo.
    expect(r.cycle.cooldownUntil).toBe(1_000_000 + 5 * 60_000);
  });

  it('un residuo de redondeo cuenta como plana', () => {
    // Sin el umbral, un resto del venue dejaba el ciclo abierto para siempre y
    // el siguiente no empezaba nunca.
    const t = totals({ qty: D('1.000000001'), averageEntry: D(100) });
    const r = cycleAfterFill(cycle(), t, fill('SELL', '100', '1', 'TAKE_PROFIT'), {}, 0);

    expect(r.closed).toBe(true);
    expect(r.totals.qty.toFixed()).toBe('0');
  });

  describe('el acumulado del bot', () => {
    it('suma el DELTA del fill, nunca el total del ciclo', () => {
      // La regresión que documenta `CycleState.realizedPnlAcc`: sumar el total
      // lo contaba una vez por cada fill posterior, y de esa cifra sale el
      // drawdown que dispara el kill-switch.
      let c = cycle({ realizedPnlAcc: '100' });
      let t = totals({ qty: D(3), averageEntry: D(90) });

      for (let i = 0; i < 3; i++) {
        const r = cycleAfterFill(c, t, fill('SELL', '100', '1', 'GRID_SELL'), {}, 0);
        c = r.cycle;
        t = r.totals;
      }

      // Tres ventas de 10 sobre un acumulado de 100.
      expect(c.realizedPnlAcc).toBe('130');
      expect(t.realizedPnl.toFixed()).toBe('30');
    });

    it('al cerrar el ciclo tampoco se cuenta dos veces', () => {
      const t = totals({ qty: D(1), averageEntry: D(100) });
      const r = cycleAfterFill(
        cycle({ realizedPnlAcc: '50' }),
        t,
        fill('SELL', '110', '1', 'TAKE_PROFIT'),
        {},
        0,
      );

      expect(r.cycle.realizedPnlAcc).toBe('60');
    });
  });

  describe('reciclado de nivel', () => {
    it('con la bandera puesta, vender un nivel lo libera', () => {
      // Grid Classic: comprar abajo, vender arriba y REPETIR.
      const t = totals({ qty: D(2), averageEntry: D(90), filledLevelIndexes: [3, 7] });
      const r = cycleAfterFill(
        cycle(),
        t,
        fill('SELL', '100', '1', 'GRID_SELL', 3),
        { recycleLevelOnExit: true },
        0,
      );

      expect(r.totals.filledLevelIndexes).toEqual([7]);
    });

    it('sin la bandera, el nivel sigue marcado', () => {
      // GridMart NO puede activarlo: sus seguridades comparten espacio de
      // índices con la rejilla de ventas, y liberar aquí borraría la marca de
      // una seguridad ya comprada — se recompraría sola.
      const t = totals({ qty: D(2), averageEntry: D(90), filledLevelIndexes: [3, 7] });
      const r = cycleAfterFill(cycle(), t, fill('SELL', '100', '1', 'GRID_SELL', 3), {}, 0);

      expect(r.totals.filledLevelIndexes).toEqual([3, 7]);
    });
  });

  it('un fill sin id reconocible no cuenta como entrada ni marca nivel', () => {
    // Es el caso de una liquidación del venue: llega sin el id de ninguna orden
    // nuestra, pero mueve la posición igual.
    const t = totals({ qty: D(1), averageEntry: D(100) });
    const liq: Fill = { ...fill('SELL', '80', '1'), clientOrderId: '', liquidation: true };
    const r = cycleAfterFill(cycle(), t, liq, {}, 0);

    expect(r.closed).toBe(true);
    expect(r.totals.entriesFilled).toBe(0);
    expect(r.matched.toFixed()).toBe('-20');
  });
});

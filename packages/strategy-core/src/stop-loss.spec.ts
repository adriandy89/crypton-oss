import { LevelKind, type DesiredState, type Position } from '@crypton/shared';
import { withStopLoss } from './stop-loss';
import { makeMarket, makePosition } from './testing';

/**
 * El stop común es un % del MARGEN (spec 080): depende del apalancamiento, y
 * cuál se usa es la regla P-2 del plan.
 */
const vacio: DesiredState = { orders: [], immediate: [] };

const ctx = (extra: Record<string, unknown> = {}) => ({
  botId: '1a2b3c4d-0000-0000-0000-000000000000',
  cycleSeq: 1,
  market: makeMarket(),
  stopLossPct: '10',
  leverage: 2,
  ...extra,
});

const posicion = (qty: string, entrada: string, leverage: number): Position => ({
  ...makePosition(qty, entrada),
  leverage,
});

const stop = (d: DesiredState) => d.orders.find((o) => o.levelKind === LevelKind.STOP_LOSS);

describe('withStopLoss — % del margen', () => {
  it('a 2× un 10 % del margen es un 5 % del precio, en largo', () => {
    const s = stop(withStopLoss(vacio, posicion('1', '100', 2), ctx()));
    expect(s?.triggerPrice).toBe('95.0');
    expect(s?.side).toBe('SELL');
  });

  it('y en corto, por encima', () => {
    const s = stop(withStopLoss(vacio, posicion('-1', '100', 2), ctx()));
    expect(s?.triggerPrice).toBe('105.0');
    expect(s?.side).toBe('BUY');
  });

  it('el caso del spec 079: corto a 15× desde 84601 con el stop de fábrica', () => {
    // 84601 × (1 + 10/1500) = 85165,0067; una compra redondea hacia abajo.
    const s = stop(withStopLoss(vacio, posicion('-0.02127', '84601', 15), ctx({ leverage: 15 })));
    expect(s?.triggerPrice).toBe('85165.0');
  });

  it('si el venue tiene la posición MÁS apalancada, manda la suya y lo avisa', () => {
    // 30 % del margen a 10× = 3 % del precio; a los 2× de la configuración
    // serían un 15 %, y el stop quedaría detrás de la liquidación del venue.
    const d = withStopLoss(vacio, posicion('1', '100', 10), ctx({ stopLossPct: '30' }));
    expect(stop(d)?.triggerPrice).toBe('97.0');
    expect(d.avisos).toEqual([
      expect.objectContaining({
        clave: 'stop-apalancamiento-10',
        tipo: 'LEVERAGE_SKIPPED',
        severidad: 'WARN',
      }),
    ]);
  });

  it('un apalancamiento efectivo MENOR (margen aportado a mano) no mueve el stop', () => {
    const d = withStopLoss(vacio, posicion('1', '100', 1.5), ctx());
    expect(stop(d)?.triggerPrice).toBe('95.0');
    expect(d.avisos).toBeUndefined();
  });

  it('la diferencia de redondeo no es un cambio de apalancamiento', () => {
    const d = withStopLoss(vacio, posicion('1', '100', 2.004), ctx());
    expect(stop(d)?.triggerPrice).toBe('95.0');
    expect(d.avisos).toBeUndefined();
  });

  it('conserva los avisos que ya traía el plan', () => {
    const conAviso: DesiredState = {
      ...vacio,
      avisos: [{ clave: 'otro', tipo: 'X', severidad: 'INFO', mensaje: 'm' }],
    };
    const d = withStopLoss(conAviso, posicion('1', '100', 10), ctx());
    expect(d.avisos?.map((a) => a.clave)).toEqual(['otro', 'stop-apalancamiento-10']);
  });

  it('el stop que pone la estrategia manda', () => {
    const propio: DesiredState = {
      orders: [
        {
          clientOrderId: 'x',
          levelKind: LevelKind.STOP_LOSS,
          levelIndex: 0,
          side: 'SELL',
          type: 'MARKET',
          price: '90',
          triggerPrice: '90',
          qty: '1',
          reduceOnly: true,
        },
      ],
      immediate: [],
    };
    expect(withStopLoss(propio, posicion('1', '100', 2), ctx())).toBe(propio);
  });

  it('sin stop configurado no añade nada', () => {
    expect(withStopLoss(vacio, posicion('1', '100', 2), ctx({ stopLossPct: null }))).toBe(vacio);
  });
});

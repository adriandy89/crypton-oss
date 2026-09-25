import { D, LevelKind, StrategyKind } from '@crypton/shared';
import { makeCoid } from '../client-order-id';
import {
  BASE_CONFIG,
  TEST_MARKET,
  makeContext,
  makePosition,
  makeVenueOrder,
  type MakeContextOptions,
} from '../testing';
import {
  ESPERA_ENTRE_CIERRES_MS,
  ESPERA_LLENADO_MS,
  ESPERA_MAXIMA_LLENADO_MS,
  INDICE_CIERRE,
  MAX_INTENTOS_CIERRE,
  cierreAMercado,
  entradaEnCurso,
  leerCierre,
  ordenStop,
  precioBreakeven,
  repartoDeObjetivos,
  salidaDeSeguridad,
  tramosDeSalida,
} from './gestion';

/**
 * La gestión de una operación que comparten el canal y la operación de un
 * agente (spec 074). El canal la cubre de punta a punta con sus propios tests,
 * que no cambiaron al moverla; estos la fijan por su cuenta, para que la
 * operación del agente no dependa de que el canal siga existiendo.
 */

const AHORA = 1_000_000;
const ctx = (extra: Partial<MakeContextOptions> = {}) =>
  makeContext({ strategy: StrategyKind.AI_CHANNEL, config: BASE_CONFIG, now: AHORA, ...extra });

describe('entradaEnCurso', () => {
  const op = { intento: 0, enviadaEn: AHORA };

  it('espera mientras la IOC está en el libro', () => {
    const c = ctx({
      now: AHORA + ESPERA_MAXIMA_LLENADO_MS * 2,
      openOrders: [makeVenueOrder(makeCoid(ctx().botId, 1, LevelKind.BASE, 0), '100')],
    });
    expect(entradaEnCurso(c, 1, op)).toBe(true);
  });

  it('espera su medio minuto aunque no se vea nada', () => {
    expect(entradaEnCurso(ctx({ now: AHORA + ESPERA_LLENADO_MS - 1 }), 1, op)).toBe(true);
    expect(entradaEnCurso(ctx({ now: AHORA + ESPERA_LLENADO_MS }), 1, op)).toBe(false);
  });

  it('con un llenado anotado espera hasta cinco minutos a ver la posición', () => {
    const lleno = { entriesFilled: 1 };
    expect(
      entradaEnCurso(ctx({ now: AHORA + ESPERA_MAXIMA_LLENADO_MS - 1, cycle: lleno }), 1, op),
    ).toBe(true);
    expect(
      entradaEnCurso(ctx({ now: AHORA + ESPERA_MAXIMA_LLENADO_MS, cycle: lleno }), 1, op),
    ).toBe(false);
  });
});

describe('tramosDeSalida', () => {
  const op = {
    plan: {
      objetivos: [
        { precio: '110.0', cantidad: '0.6' },
        { precio: '120.0', cantidad: '0.4' },
      ],
      cantidad: '1',
    },
  };

  it('reparte en la proporción del plan lo que de verdad se llenó', () => {
    const t = tramosDeSalida(TEST_MARKET, op, D('0.5'));
    expect(t.map((x) => [x.precio, x.cantidad.toFixed()])).toEqual([
      ['110.0', '0.3'],
      ['120.0', '0.2'],
    ]);
  });

  it('si un tramo no llega al mínimo, todo al primer objetivo', () => {
    // 0,06 × 110 = 6,6 USDC, por debajo de los 10 de mínimo.
    const t = tramosDeSalida(TEST_MARKET, op, D('0.1'));
    expect(t.map((x) => [x.precio, x.cantidad.toFixed()])).toEqual([['110.0', '0.1']]);
  });

  it('con un solo objetivo, un solo tramo', () => {
    const uno = { plan: { objetivos: [{ precio: '110.0', cantidad: '1' }], cantidad: '1' } };
    expect(tramosDeSalida(TEST_MARKET, uno, D('1'))).toHaveLength(1);
  });
});

describe('repartoDeObjetivos (spec 062, F-22)', () => {
  const tramos = [
    { precio: '110.0', cantidad: D('0.6') },
    { precio: '120.0', cantidad: D('0.4') },
  ];

  it('con la posición entera, cada tramo lo suyo', () => {
    const r = repartoDeObjetivos(TEST_MARKET, tramos, D('1'));
    expect(r.map((x) => x.cantidad.toFixed())).toEqual(['0.6', '0.4']);
  });

  it('la ejecución parcial es del primer tramo, no del segundo', () => {
    const r = repartoDeObjetivos(TEST_MARKET, tramos, D('0.7'));
    expect(r.map((x) => x.cantidad.toFixed())).toEqual(['0.3', '0.4']);
  });

  it('un resto por debajo del mínimo se suma al tramo de al lado', () => {
    // 0,05 × 110 = 5,5 USDC: no se puede colocar solo.
    const r = repartoDeObjetivos(TEST_MARKET, tramos, D('0.45'));
    expect(r.map((x) => x.cantidad.toFixed())).toEqual(['0', '0.45']);
  });

  it('conserva la identidad de los tramos, que es como el canal busca su índice', () => {
    const r = repartoDeObjetivos(TEST_MARKET, tramos, D('1'));
    expect(r[1].t).toBe(tramos[1]);
  });
});

describe('precioBreakeven', () => {
  const costes = { takerBps: 4.5, deslizamientoBps: 2 };

  it('largo: entrada más comisión de ida y vuelta y deslizamiento, redondeado hacia arriba', () => {
    // 100 × (1 + 0,0011) = 100,11 → la venta redondea hacia arriba: 100,2.
    expect(precioBreakeven(TEST_MARKET, D('100'), true, costes).toFixed()).toBe('100.2');
  });

  it('corto: por debajo de la entrada, redondeado hacia abajo', () => {
    expect(precioBreakeven(TEST_MARKET, D('100'), false, costes).toFixed()).toBe('99.8');
  });
});

describe('salidaDeSeguridad', () => {
  const op = { plan: { distanciaStop: 0.05, apalancamiento: 10 } };
  const largoEn = (mark: string, extra: Partial<ReturnType<typeof makePosition>> = {}) =>
    ctx({ price: mark, position: { ...makePosition('1', '100', mark), leverage: 10, ...extra } });

  it('nada que hacer con el precio por encima del stop', () => {
    expect(salidaDeSeguridad(largoEn('97'), op, true, D('95'))).toBeNull();
  });

  it('el precio pasó el stop en más de medio stop y no saltó', () => {
    // 95 × (1 − 0,025) = 92,625.
    expect(salidaDeSeguridad(largoEn('92'), op, true, D('95'))?.motivo).toBe('STOP_NO_SALTO');
  });

  it('la liquidación del venue queda demasiado cerca del stop', () => {
    // Holgura: 100 × 0,05 × 0,5 = 2,5 → la liquidación tiene que estar bajo 92,5.
    const c = largoEn('97', { liquidationPrice: '94.5' });
    expect(salidaDeSeguridad(c, op, true, D('95'))?.motivo).toBe('LIQUIDACION');
  });

  it('el venue informa más apalancamiento del pedido', () => {
    const c = largoEn('97', { leverage: 12 });
    expect(salidaDeSeguridad(c, op, true, D('95'))?.motivo).toBe('APALANCAMIENTO');
  });
});

describe('ordenStop y cierreAMercado', () => {
  it('el stop es una condicional a mercado, reduce-only y con la cantidad truncada al paso', () => {
    const o = ordenStop(ctx(), 1, 'SELL', '95.0', D('0.123456'));
    expect(o).toMatchObject({
      levelKind: LevelKind.STOP_LOSS,
      levelIndex: 0,
      type: 'MARKET',
      triggerPrice: '95.0',
      qty: '0.12345',
      reduceOnly: true,
    });
  });

  it('un intento cada medio minuto, del índice 500 en adelante, doce como mucho', () => {
    const primero = cierreAMercado(ctx(), 1, 'SELL', D('1'), null, 'TIEMPO');
    expect(primero.immediate[0].levelIndex).toBe(INDICE_CIERRE);
    expect(primero.cierre).toEqual({ motivo: 'TIEMPO', intentos: 1, ultimoEn: AHORA });

    const pronto = cierreAMercado(
      ctx({ now: AHORA + ESPERA_ENTRE_CIERRES_MS - 1 }),
      1,
      'SELL',
      D('1'),
      primero.cierre,
      'OTRO',
    );
    expect(pronto.immediate).toEqual([]);

    const segundo = cierreAMercado(
      ctx({ now: AHORA + ESPERA_ENTRE_CIERRES_MS }),
      1,
      'SELL',
      D('1'),
      primero.cierre,
      'OTRO',
    );
    expect(segundo.immediate[0].levelIndex).toBe(INDICE_CIERRE + 1);
    // El motivo es el del primer intento: un cierre en curso no cambia de razón.
    expect(segundo.cierre.motivo).toBe('TIEMPO');

    const agotado = cierreAMercado(
      ctx(),
      1,
      'SELL',
      D('1'),
      { motivo: 'TIEMPO', intentos: MAX_INTENTOS_CIERRE, ultimoEn: 0 },
      'TIEMPO',
    );
    expect(agotado).toMatchObject({ immediate: [], agotado: true });
  });

  it('leerCierre acepta lo que escribió y rechaza lo demás', () => {
    expect(leerCierre({ motivo: 'TIEMPO', intentos: 2, ultimoEn: 5 })).toEqual({
      motivo: 'TIEMPO',
      intentos: 2,
      ultimoEn: 5,
    });
    expect(leerCierre(null)).toBeNull();
    expect(leerCierre({ intentos: 2 })).toBeNull();
    expect(leerCierre(['TIEMPO'])).toBeNull();
  });
});

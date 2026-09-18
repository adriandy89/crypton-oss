import { BotStore, picoDeCaida } from './bot-store';

/**
 * Spec 024. El motor construye el mercado de cada bot desde la fila de
 * `markets`, y esa fila no guardaba lo que los specs 013, 014, 019 y 023
 * añadieron a `MarketSpec`: la estrategia redondeaba sin la regla de cifras
 * significativas de Hyperliquid mientras el adaptador sí la aplicaba (F-04
 * seguía vivo), y el cierre troceado de Aster no conocía su tope.
 */
describe('BotStore.marketSpec (spec 024)', () => {
  it('devuelve los campos del venue que guarda la fila de markets', async () => {
    const fila = {
      venue: 'LIGHTER',
      symbol: 'ETH',
      canonical: 'ETH/USDC',
      base: 'ETH',
      quote: 'USDC',
      tick_size: '0.01',
      step_size: '0.001',
      min_notional: '10',
      min_qty: '0.001',
      max_qty: null,
      max_leverage: 50,
      price_decimals: 2,
      qty_decimals: 3,
      active: true,
      max_market_qty: null,
      max_active_orders: 30,
      max_significant_digits: null,
      maintenance_margin_rate: '0.0125',
    };
    const db = { market: { findUniqueOrThrow: jest.fn().mockResolvedValue(fila) } };
    const store = new BotStore(db as never, {} as never);

    const spec = await store.marketSpec('LIGHTER', 'ETH', false);

    expect(spec).toMatchObject({
      tickSize: '0.01',
      maxActiveOrders: 30,
      maintenanceMarginRate: 0.0125,
      maxSignificantDigits: null,
      maxMarketQty: null,
    });
  });
});

/**
 * Spec 058. El canal con IA decide sus puertas del día —tope de pérdida,
 * operaciones, rachas, esperas y caída máxima— con este historial. Un número
 * mal contado aquí abre entradas que el usuario había cerrado.
 */
describe('BotStore.historialOperaciones (spec 058)', () => {
  const AHORA = Date.UTC(2026, 8, 17, 15, 30);
  const DIA = Date.UTC(2026, 8, 17);
  const cierre = (pnl: string, en: number) => ({ realized_pnl: pnl, closed_at: new Date(en) });

  const montar = (
    over: {
      hoy?: { sum: string | null; n: number };
      recientes?: ReturnType<typeof cierre>[];
      acumulado?: { total: string | null; pico: string | null }[];
      stop?: number | null;
    } = {},
  ) => {
    const db = {
      botCycle: {
        aggregate: jest.fn().mockResolvedValue({
          _sum: { realized_pnl: over.hoy?.sum ?? null },
          _count: { _all: over.hoy?.n ?? 0 },
        }),
        findMany: jest.fn().mockResolvedValue(over.recientes ?? []),
      },
      $queryRaw: jest.fn().mockResolvedValue(over.acumulado ?? [{ total: '0', pico: '0' }]),
      botFill: {
        findFirst: jest
          .fn()
          .mockResolvedValue(over.stop != null ? { executed_at: new Date(over.stop) } : null),
      },
    };
    return { db, store: new BotStore(db as never, {} as never) };
  };

  it('cuenta el día desde las 00:00 UTC y lo realizado con su signo', async () => {
    const { db, store } = montar({ hoy: { sum: '-12.5', n: 3 } });

    const h = await store.historialOperaciones('b1', AHORA);

    expect(h).toMatchObject({ dia: DIA, operacionesHoy: 3, realizadoHoy: '-12.5' });
    expect(db.botCycle.aggregate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { bot_id: 'b1', closed_at: { gte: new Date(DIA) } } }),
    );
  });

  it('la racha son las pérdidas seguidas desde el último cierre, sin cortar por días', async () => {
    const { store } = montar({
      recientes: [
        cierre('-1', AHORA - 1_000),
        cierre('-2', AHORA - 2_000),
        cierre('-0.5', DIA - 60_000),
        cierre('3', DIA - 120_000),
        cierre('-9', DIA - 180_000),
      ],
    });

    const h = await store.historialOperaciones('b1', AHORA);

    expect(h.rachaPerdidas).toBe(3);
    expect(h.ultimoCierreEn).toBe(AHORA - 1_000);
    expect(h.ultimaPerdidaEn).toBe(AHORA - 1_000);
  });

  it('un cierre sin pérdida corta la racha; la última pérdida sigue siendo la suya', async () => {
    const { store } = montar({
      recientes: [cierre('0', AHORA - 1_000), cierre('-2', AHORA - 2_000)],
    });

    const h = await store.historialOperaciones('b1', AHORA);

    expect(h.rachaPerdidas).toBe(0);
    expect(h.ultimaPerdidaEn).toBe(AHORA - 2_000);
  });

  it('el total, el máximo acumulado y el último stop', async () => {
    const { store } = montar({
      acumulado: [{ total: '-4.25', pico: '7.5' }],
      stop: AHORA - 90_000,
    });

    const h = await store.historialOperaciones('b1', AHORA);

    expect(h).toMatchObject({
      realizadoTotal: '-4.25',
      picoRealizado: '7.5',
      ultimoStopEn: AHORA - 90_000,
    });
  });

  it('un bot sin cierres empieza de cero', async () => {
    const { store } = montar({ acumulado: [{ total: null, pico: null }] });

    await expect(store.historialOperaciones('b1', AHORA)).resolves.toEqual({
      dia: DIA,
      operacionesHoy: 0,
      realizadoHoy: '0',
      rachaPerdidas: 0,
      ultimoCierreEn: null,
      ultimaPerdidaEn: null,
      ultimoStopEn: null,
      realizadoTotal: '0',
      picoRealizado: '0',
    });
  });

  it('se recuerda un rato, pero no pasa al día siguiente', async () => {
    const { db, store } = montar();

    await store.historialOperaciones('b1', AHORA);
    await store.historialOperaciones('b1', AHORA + 10_000);
    expect(db.botCycle.aggregate).toHaveBeenCalledTimes(1);

    // Las 00:00 UTC caen dentro de la caché y aun así se relee.
    const medianoche = Date.UTC(2026, 8, 18);
    await store.historialOperaciones('b1', medianoche - 5_000);
    await store.historialOperaciones('b1', medianoche + 1_000);
    expect(db.botCycle.aggregate).toHaveBeenCalledTimes(3);
  });

  it('cerrar un ciclo lo olvida: la lectura siguiente va a la base', async () => {
    const { db, store } = montar();
    await store.historialOperaciones('b1', AHORA);
    // Lo que hace `applyFillToCycle` al cerrar el ciclo.
    (store as unknown as { forgetDailyLoss(u: string, b: string): void }).forgetDailyLoss(
      'u1',
      'b1',
    );
    await store.historialOperaciones('b1', AHORA + 1_000);
    expect(db.botCycle.aggregate).toHaveBeenCalledTimes(2);
  });
});

/**
 * Spec 058. Una IOC que no se ejecuta llega ya muerta en el acuse (CANCELED en
 * Hyperliquid y el simulador, EXPIRED en Aster): su fila se cierra ahí, como la
 * de cualquier orden que ya no está en el libro.
 */
describe('BotStore: las órdenes muertas cierran su fila (spec 058)', () => {
  const montar = () => {
    const db = {
      botOrder: {
        update: jest.fn().mockResolvedValue(undefined),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    return { db, store: new BotStore(db as never, {} as never) };
  };
  type Escritura = { data: Record<string, unknown> };

  it('el acuse CANCELED o EXPIRED cierra la fila; uno vivo, no', async () => {
    const { db, store } = montar();
    const casos = [
      ['CANCELED', true],
      ['EXPIRED', true],
      ['OPEN', false],
      ['PENDING', false],
    ] as const;
    for (const [status, cierra] of casos) {
      db.botOrder.update.mockClear();
      await store.confirmOrder('c-1', { clientOrderId: 'c-1', venueOrderId: 'v-1', status, ts: 0 });
      const { data } = db.botOrder.update.mock.calls[0][0] as Escritura;
      expect(`${status}: ${'closed_at' in data}`).toBe(`${status}: ${cierra}`);
    }
  });

  it('al sincronizar, la vencida y la rechazada también cierran', async () => {
    const { db, store } = montar();
    const casos = [
      ['FILLED', true],
      ['CANCELED', true],
      ['EXPIRED', true],
      ['REJECTED', true],
      ['OPEN', false],
      ['PARTIALLY_FILLED', false],
    ] as const;
    for (const [status, cierra] of casos) {
      db.botOrder.updateMany.mockClear();
      await store.syncOrderState('b1', {
        venue: 'HYPERLIQUID',
        symbol: 'BTC',
        clientOrderId: 'x-1',
        venueOrderId: 'v-1',
        side: 'BUY',
        type: 'LIMIT',
        price: '100',
        triggerPrice: null,
        qty: '1',
        filledQty: '0',
        avgPrice: null,
        status,
        reduceOnly: false,
        createdAt: 0,
      });
      const { data } = db.botOrder.updateMany.mock.calls[0][0] as Escritura;
      expect(`${status}: ${'closed_at' in data}`).toBe(`${status}: ${cierra}`);
    }
  });
});

/**
 * Spec 060, F-15. La caída máxima del canal se mide desde la última vez que el
 * usuario reanudó el bot. Antes se medía sobre el mejor momento de toda su vida,
 * así que un bot pausado por caída volvía a pausarse en la revisión siguiente sin
 * haber operado: solo salía de ahí subiendo el límite o aportando capital.
 */
describe('picoDeCaida (spec 060)', () => {
  const fila = (over: Record<string, unknown> = {}) => ({
    total: '-150',
    pico: '100',
    reanudado_en: null,
    antes: '0',
    pico_desde: null,
    ...over,
  });

  it('sin reanudaciones, el máximo de toda la vida del bot', () => {
    expect(picoDeCaida(fila()).toFixed()).toBe('100');
  });

  it('tras reanudar, el resultado que había en ese momento', () => {
    const p = picoDeCaida(fila({ reanudado_en: new Date(), antes: '-150', pico_desde: null }));
    // La caída pasa a ser cero: el bot vuelve a operar.
    expect(p.toFixed()).toBe('-150');
  });

  it('y el mejor momento alcanzado después, si lo hubo', () => {
    const p = picoDeCaida(fila({ reanudado_en: new Date(), antes: '-150', pico_desde: '-120' }));
    expect(p.toFixed()).toBe('-120');
  });

  it('nunca por debajo de lo que había al reanudar', () => {
    const p = picoDeCaida(fila({ reanudado_en: new Date(), antes: '-150', pico_desde: '-180' }));
    expect(p.toFixed()).toBe('-150');
  });

  it('sin ciclos cerrados, cero', () => {
    expect(picoDeCaida(undefined).toFixed()).toBe('0');
  });
});

/**
 * Spec 060, F-07. Un id que se reutiliza —la cotización de un market maker, un
 * peldaño de una retícula— estrena fila, y la de antes traía su id de venue. Con
 * él puesto, una fila que se quedara PENDING no vencía nunca (`pendienteVencida`
 * exige no tener id) y ese hueco no se volvía a colocar.
 */
describe('BotStore.upsertPendingOrder (spec 060)', () => {
  it('la encarnación nueva de un id empieza sin id de venue', async () => {
    const db = { botOrder: { upsert: jest.fn().mockResolvedValue(undefined) } };
    const store = new BotStore(db as never, {} as never);

    await store.upsertPendingOrder({
      botId: 'b1',
      cycleSeq: 3,
      order: {
        clientOrderId: 'b1.3.QB0',
        levelKind: 'QUOTE_BID',
        levelIndex: 0,
        side: 'BUY',
        type: 'POST_ONLY',
        price: '100',
        qty: '1',
        reduceOnly: false,
      },
      venueClientId: 'v-b1.3.QB0',
    });

    const { update } = db.botOrder.upsert.mock.calls[0][0] as {
      update: Record<string, unknown>;
    };
    expect(update).toMatchObject({ status: 'PENDING', filled_qty: 0, venue_order_id: null });
  });
});

/**
 * Spec 060, F-01. El id de venue de la fila es el del acuse, que no siempre es
 * el del libro; lo que el motor acaba de cancelar se reconoce también por el id
 * de cliente, y siempre dentro del bot.
 */
describe('BotStore.markOrderCanceled (spec 060)', () => {
  const montar = () => {
    const db = { botOrder: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) } };
    return { db, store: new BotStore(db as never, {} as never) };
  };
  const VIVAS = { in: ['PENDING', 'OPEN', 'PARTIALLY_FILLED'] };

  it('con el id de cliente del libro, casa por cualquiera de los dos', async () => {
    const { db, store } = montar();
    await store.markOrderCanceled('b1', 'libro-7', 'cliente-7');
    expect(db.botOrder.updateMany.mock.calls[0][0]).toMatchObject({
      where: {
        bot_id: 'b1',
        status: VIVAS,
        OR: [{ venue_order_id: 'libro-7' }, { venue_client_id: 'cliente-7' }],
      },
      data: { status: 'CANCELED' },
    });
  });

  it('sin él, solo por el id de venue', async () => {
    const { db, store } = montar();
    await store.markOrderCanceled('b1', 'libro-7', null);
    expect(db.botOrder.updateMany.mock.calls[0][0]).toMatchObject({
      where: { bot_id: 'b1', status: VIVAS, OR: [{ venue_order_id: 'libro-7' }] },
    });
  });
});

describe('BotStore.setMaxNotional (spec 058)', () => {
  it('escribe solo si cambia, y alcanza también a un bot sin valor', async () => {
    const db = { bot: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) } };
    const store = new BotStore(db as never, {} as never);

    await store.setMaxNotional('b1', '5000');

    expect(db.bot.updateMany).toHaveBeenCalledWith({
      where: { id: 'b1', OR: [{ max_notional: null }, { NOT: { max_notional: '5000' } }] },
      data: { max_notional: '5000' },
    });
  });

  it('borrarlo solo toca un bot que lo tenía', async () => {
    const db = { bot: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) } };
    const store = new BotStore(db as never, {} as never);

    await store.setMaxNotional('b1', null);

    expect(db.bot.updateMany).toHaveBeenCalledWith({
      where: { id: 'b1', max_notional: { not: null } },
      data: { max_notional: null },
    });
  });
});

describe('BotStore.totalNotionalOfUser (spec 058)', () => {
  it('usa el nocional que declara la estrategia y, si no hay, capital por apalancamiento', async () => {
    const db = {
      bot: {
        findMany: jest.fn().mockResolvedValue([
          // Canal con IA: tope de 25x, pero declara 5000 de nocional.
          { total_investment: '1000', leverage: 25, max_notional: '5000' },
          // Una rejilla de siempre.
          { total_investment: '200', leverage: 3, max_notional: null },
        ]),
      },
    };
    const store = new BotStore(db as never, {} as never);

    const total = await store.totalNotionalOfUser('u1');

    expect(total.toFixed()).toBe('5600');
  });
});

/**
 * Spec 059. El cierre de un ciclo se anuncia con `CYCLE_CLOSED`, salvo que
 * quien aplica el llenado diga otra cosa: el canal con IA avisa con `AI_EXIT`,
 * y dos avisos por la misma salida serían ruido.
 */
describe('BotStore.applyFillToCycle: el evento del cierre (spec 059)', () => {
  const montar = () => {
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: 7n }]),
      botCycle: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          id: 7n,
          seq: 3,
          qty: '1',
          average_entry: '100',
          realized_pnl: '0',
          fees: '0',
          entries_filled: 1,
          filled_level_indexes: [0],
          anchor_price: null,
          last_entry_at: new Date(),
        }),
        update: jest.fn().mockResolvedValue(undefined),
        create: jest.fn().mockResolvedValue(undefined),
      },
      botOrder: { findUnique: jest.fn().mockResolvedValue({ qty: '1', filled_qty: '1' }) },
    };
    const db = {
      $transaction: jest.fn(async (f: (t: typeof tx) => Promise<unknown>) => f(tx)),
      bot: { findUnique: jest.fn().mockResolvedValue({ user_id: 'u1' }) },
      botEvent: { create: jest.fn().mockResolvedValue(undefined) },
    };
    const bus = { publish: jest.fn().mockResolvedValue(undefined) };
    return { db, bus, store: new BotStore(db as never, bus as never) };
  };
  const ciclo = {
    cycleId: 'c3',
    startedAt: 0,
    entriesFilled: 1,
    lastEntryAt: null,
    filledLevelIndexes: [0],
    cooldownUntil: null,
    realizedPnl: '0',
    realizedPnlAcc: '0',
    averageEntry: '100',
    anchorPrice: null,
    scratch: { cycleSeq: 3 },
  };
  const cierre = {
    venue: 'HYPERLIQUID' as const,
    symbol: 'SOL',
    venueFillId: 'f-9',
    venueOrderId: 'v-9',
    clientOrderId: 'x-9',
    side: 'SELL' as const,
    price: '101',
    qty: '1',
    fee: '0.01',
    feeAsset: 'USDC',
    isTaker: true,
    ts: 1,
  };
  const eventoEscrito = (db: ReturnType<typeof montar>['db']) =>
    (db.botEvent.create.mock.calls[0][0] as { data: Record<string, unknown> }).data;

  it('por defecto, CYCLE_CLOSED con el resultado del ciclo', async () => {
    const { db, store } = montar();
    await store.applyFillToCycle('b1', ciclo, cierre);
    expect(eventoEscrito(db)).toMatchObject({
      bot_id: 'b1',
      type: 'CYCLE_CLOSED',
      severity: 'INFO',
      message: 'Ciclo #3 cerrado con 0.99 de resultado.',
      payload: { realizedPnl: '0.99', seq: 3 },
    });
  });

  it('con eventoCierre, el que devuelva, construido con el mismo resultado', async () => {
    const { db, bus, store } = montar();
    const eventoCierre = jest.fn((c: { seq: number; pnl: { toFixed(): string } }) => ({
      type: 'AI_EXIT',
      severity: 'INFO' as const,
      message: `Operación cerrada: ${c.pnl.toFixed()}.`,
      payload: { realizedPnl: c.pnl.toFixed(), seq: c.seq, r: 1.2 },
    }));
    await store.applyFillToCycle('b1', ciclo, cierre, { eventoCierre });
    expect(eventoCierre).toHaveBeenCalledTimes(1);
    expect(eventoCierre.mock.calls[0][0].seq).toBe(3);
    expect(eventoCierre.mock.calls[0][0].pnl.toFixed()).toBe('0.99');
    expect(db.botEvent.create).toHaveBeenCalledTimes(1);
    expect(eventoEscrito(db)).toMatchObject({
      type: 'AI_EXIT',
      message: 'Operación cerrada: 0.99.',
      payload: { realizedPnl: '0.99', seq: 3, r: 1.2 },
    });
    expect(bus.publish).toHaveBeenCalledWith(
      'crypton:bot-events',
      expect.objectContaining({ type: 'AI_EXIT', botId: 'b1' }),
    );
  });

  it('sin cierre no hay evento, ni se construye', async () => {
    const { db, store } = montar();
    const eventoCierre = jest.fn();
    await store.applyFillToCycle('b1', ciclo, { ...cierre, qty: '0.4' }, { eventoCierre });
    expect(eventoCierre).not.toHaveBeenCalled();
    expect(db.botEvent.create).not.toHaveBeenCalled();
  });
});

/**
 * Spec 063. Los límites del usuario se leían una sola vez, al adoptar el bot, y
 * no se releían jamás: subir un tope no liberaba a un bot pausado y bajarlo no
 * mordía a uno en marcha. Ahora los lee el motor cada minuto, y esta es la
 * única puerta por la que pasan la adopción y el refresco.
 */
describe('BotStore.riskGuards (spec 063)', () => {
  const fila = {
    max_notional_per_bot: '5000',
    max_total_notional: '20000',
    max_leverage: 25,
    max_daily_loss: '100',
    kill_switch_drawdown_pct: '70',
    liquidation_alert_pct: '10',
  };

  it('mapea la fila a los guards: decimales a cadena y el apalancamiento a número', async () => {
    const db = { riskLimit: { findUnique: jest.fn().mockResolvedValue(fila) } };
    const store = new BotStore(db as never, {} as never);

    expect(await store.riskGuards('u1')).toEqual({
      maxNotionalPerBot: '5000',
      maxTotalNotional: '20000',
      maxLeverage: 25,
      maxDailyLoss: '100',
      killSwitchDrawdownPct: '70',
      liquidationAlertPct: '10',
    });
  });

  it('sin fila no hay límites, que es lo que significaba antes al adoptar', async () => {
    const db = { riskLimit: { findUnique: jest.fn().mockResolvedValue(null) } };
    const store = new BotStore(db as never, {} as never);

    expect(await store.riskGuards('u1')).toEqual({
      maxNotionalPerBot: null,
      maxTotalNotional: null,
      maxLeverage: null,
      maxDailyLoss: null,
      killSwitchDrawdownPct: null,
      liquidationAlertPct: null,
    });
  });

  it('la caché es por usuario: veinte bots de un dueño son una consulta', async () => {
    const findUnique = jest.fn().mockResolvedValue(fila);
    const store = new BotStore({ riskLimit: { findUnique } } as never, {} as never);

    await store.riskGuards('u1');
    await store.riskGuards('u1');
    await store.riskGuards('u2');

    expect(findUnique).toHaveBeenCalledTimes(2);
  });

  it('«fresco» la salta: arrancar o reanudar no puede leer el tope de hace un rato', async () => {
    const findUnique = jest.fn().mockResolvedValue(fila);
    const store = new BotStore({ riskLimit: { findUnique } } as never, {} as never);

    await store.riskGuards('u1');
    await store.riskGuards('u1', { fresco: true });

    expect(findUnique).toHaveBeenCalledTimes(2);
  });

  it('un error de base RECHAZA: no se confunde con «este usuario no tiene límites»', async () => {
    const db = { riskLimit: { findUnique: jest.fn().mockRejectedValue(new Error('caída')) } };
    const store = new BotStore(db as never, {} as never);

    await expect(store.riskGuards('u1')).rejects.toThrow('caída');
  });
});

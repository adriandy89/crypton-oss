import { type DryRunState } from '@crypton/exchange-core';
import { AccountHub } from './account-hub.service';
import { BotStore } from './bot-store';
import { CredentialsService } from './credentials.service';
import { PaperStateStore } from './paper-state.store';

/**
 * La simulación por el lado del motor.
 *
 * Lo que se defiende aquí son las tres cosas que, si se caen, dejan de ser
 * molestias y pasan a ser dinero mal contado: que abrir una simulación NO
 * descifre ninguna credencial, que cada bot tenga su propio sandbox sin abrir
 * una conexión al venue por cabeza, y que un reinicio de simulación no se pueda
 * pisar.
 */

const BOT_ID = '22222222-2222-2222-2222-222222222222';
const ACCOUNT_ID = '11111111-1111-1111-1111-111111111111';
const VENUE = 'ASTER' as never;

const config = { get: (_k: string, d?: unknown) => d } as never;

// ═══════════════════════════════════════════════════════════════
// CredentialsService
// ═══════════════════════════════════════════════════════════════

/**
 * Cuenta tal y como la devuelve Prisma. Sin sobre: es de simulación.
 *
 * Aster y no Hyperliquid porque el SDK de este último es solo ESM y no se puede
 * construir desde Jest — la misma razón que documenta `normalizeOptions` en
 * `factory.ts`. Lo que se comprueba aquí no depende del venue.
 */
const paperAccount = {
  id: ACCOUNT_ID,
  venue: VENUE,
  paper: true,
  testnet: false,
  builder_approved: false,
  paper_balance: null,
  enc_payload: null,
  enc_dek: null,
  enc_iv: null,
  enc_tag: null,
  enc_key_id: null,
};

function buildCredentials(account: Record<string, unknown> = paperAccount) {
  const open = jest.fn();
  const db = {
    exchangeAccount: { findUniqueOrThrow: jest.fn().mockResolvedValue(account) },
  };
  const service = new CredentialsService(
    db as never,
    { open } as never,
    { budget: {} } as never,
    config,
  );
  return { service, open };
}

describe('CredentialsService — la simulación no toca credenciales', () => {
  it('la fuente de precios NUNCA descifra nada', () => {
    const { service, open } = buildCredentials();

    const source = service.openPriceSource(VENUE, false);

    // La invariante. Si algún día esto falla, la simulación estaría pasando por
    // el descifrador para leer un precio que es público.
    expect(open).not.toHaveBeenCalled();
    expect(source).toBeDefined();
  });

  it('una cuenta de simulación no se abre por la puerta de las credenciales', async () => {
    const { service, open } = buildCredentials();
    await expect(service.openAdapter(ACCOUNT_ID, true)).rejects.toThrow(/simulación/i);
    expect(open).not.toHaveBeenCalled();
  });

  it('una cuenta real sin sobre se para en seco en vez de llegar al descifrador', async () => {
    // Solo puede pasar si falta el CHECK de la base. El mensaje tiene que decir
    // ESO y no el «no se pudo descifrar» genérico, que mandaría a buscar el
    // fallo a la clave maestra.
    const { service, open } = buildCredentials({ ...paperAccount, paper: false });
    await expect(service.openAdapter(ACCOUNT_ID, false)).rejects.toThrow(/credencial guardada/i);
    expect(open).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════
// PaperStateStore
// ═══════════════════════════════════════════════════════════════

describe('PaperStateStore', () => {
  const state: DryRunState = {
    balance: '10000',
    realizedPnl: '-12.5',
    feesPaid: '2.5',
    seq: 7,
    positions: [],
    orders: [],
  };

  function buildStore(overrides: Record<string, unknown> = {}) {
    const db = {
      bot: { findUniqueOrThrow: jest.fn() },
      paperState: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        create: jest.fn().mockResolvedValue(undefined),
        findUnique: jest.fn().mockResolvedValue(null),
        ...overrides,
      },
    };
    return { store: new PaperStateStore(db as never, config), db };
  }

  it('guarda contra el epoch que cargó, no a ciegas', async () => {
    const { store, db } = buildStore({ updateMany: jest.fn().mockResolvedValue({ count: 1 }) });

    await expect(store.save(BOT_ID, 3, state)).resolves.toBe(true);
    expect(db.paperState.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { bot_id: BOT_ID, epoch: 3 } }),
    );
    // Ni un `create` de más: la fila ya estaba.
    expect(db.paperState.create).not.toHaveBeenCalled();
  });

  it('crea la fila la primera vez que un bot guarda su sandbox', async () => {
    const { store, db } = buildStore();
    await expect(store.save(BOT_ID, 0, state)).resolves.toBe(true);
    expect(db.paperState.create).toHaveBeenCalled();
  });

  it('descarta la escritura de un simulador al que le reiniciaron la simulación', async () => {
    // El caso real: el usuario pulsa «reiniciar» y el simulador viejo sigue vivo
    // en el worker hasta treinta segundos. Sin esto, su última escritura
    // resucitaba el estado que se acababa de tirar.
    const { store } = buildStore({ create: jest.fn().mockRejectedValue({ code: 'P2002' }) });
    await expect(store.save(BOT_ID, 0, state)).resolves.toBe(false);
  });

  it('un bot borrado no deja el guardado reintentándose para siempre', async () => {
    const { store } = buildStore({ create: jest.fn().mockRejectedValue({ code: 'P2003' }) });
    await expect(store.save(BOT_ID, 0, state)).resolves.toBe(false);
  });

  it('el capital de partida sale de la CONEXIÓN y vale para cada bot', async () => {
    const { store, db } = buildStore();
    db.bot.findUniqueOrThrow.mockResolvedValue({
      paper_state: null,
      exchange_account: { paper_balance: { toFixed: () => '500' } },
    });

    await expect(store.load(BOT_ID)).resolves.toEqual({
      state: null,
      epoch: 0,
      startingBalance: '500',
    });
  });

  it('lo que se carga es lo mismo que se guardó', async () => {
    const { store, db } = buildStore();
    db.bot.findUniqueOrThrow.mockResolvedValue({
      exchange_account: { paper_balance: null },
      paper_state: {
        epoch: 4,
        seq: 7,
        balance: { toFixed: () => '10000' },
        realized_pnl: { toFixed: () => '-12.5' },
        fees_paid: { toFixed: () => '2.5' },
        positions: [],
        orders: [],
      },
    });

    const loaded = await store.load(BOT_ID);
    expect(loaded.epoch).toBe(4);
    expect(loaded.state).toEqual(state);
  });
});

// ═══════════════════════════════════════════════════════════════
// BotStore.recordLiquidation
// ═══════════════════════════════════════════════════════════════

describe('BotStore.recordLiquidation', () => {
  const fill = {
    venue: 'HYPERLIQUID',
    symbol: 'BTC',
    venueFillId: 'f-1',
    venueOrderId: 'o-1',
    clientOrderId: null,
    side: 'SELL',
    price: '80',
    qty: '1',
    fee: '0.04',
    feeAsset: 'USDC',
    isTaker: true,
    ts: Date.now(),
    liquidation: true,
  } as never;

  function build() {
    const botOrder = { create: jest.fn().mockResolvedValue({ id: 1n }) };
    const botFill = { create: jest.fn().mockResolvedValue(undefined) };
    const db = {
      $transaction: jest.fn((cb: (tx: unknown) => unknown) => cb({ botOrder, botFill })),
    };
    return { store: new BotStore(db as never, {} as never), botOrder, botFill };
  }

  it('la orden sintetica NO guarda el id de orden del venue', async () => {
    // `recordFill` busca por `venue_order_id` cuando la ejecucion no trae client
    // id —el caso de una liquidacion en Hyperliquid—, asi que guardarlo hacia
    // que el SEGUNDO trozo de la misma liquidacion casara con esta orden y se
    // colara por el camino normal, sin pasar por `afterLiquidation`.
    const { store, botOrder } = build();

    await store.recordLiquidation('bot-1', fill, 3);

    const datos = (botOrder.create.mock.calls[0][0] as { data: Record<string, unknown> }).data;
    expect(datos.venue_order_id).toBeUndefined();
    expect(datos.level_kind).toBe('LIQUIDATION');
    // El coid sale del BOT y del id de la ejecucion: el bot lo hace unico entre
    // bots —esa columna es unica a nivel global— y la ejecucion deduplica una
    // reentrega del mismo episodio.
    expect(datos.client_order_id).toBe('liq:bot1:f-1');
  });

  it('el coid lleva el BOT: el id de ejecucion del venue no es unico', async () => {
    // `client_order_id` es unico a nivel GLOBAL, pero el `t` de un trade en
    // Aster solo lo es por SIMBOLO. Sin el bot en el id, dos bots de la misma
    // cuenta liquidados a la vez chocaban y el perdedor se descartaba entero
    // —sin fila, sin PnL, sin pausa y sin aviso— creyendo que era un duplicado.
    const a = build();
    const b = build();

    await a.store.recordLiquidation('11111111-1111-1111-1111-111111111111', fill, 1);
    await b.store.recordLiquidation('22222222-2222-2222-2222-222222222222', fill, 1);

    const coidA = (a.botOrder.create.mock.calls[0][0] as { data: { client_order_id: string } }).data
      .client_order_id;
    const coidB = (b.botOrder.create.mock.calls[0][0] as { data: { client_order_id: string } }).data
      .client_order_id;
    expect(coidA).not.toBe(coidB);
    expect(coidA.length).toBeLessThanOrEqual(64);
  });

  it('una reentrega devuelve null en vez de contarla dos veces', async () => {
    const { store, botOrder } = build();
    botOrder.create.mockRejectedValue({ code: 'P2002' });

    await expect(store.recordLiquidation('bot-1', fill, 3)).resolves.toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
// AccountHub
// ═══════════════════════════════════════════════════════════════

describe('AccountHub — un sandbox por bot, una fuente por venue', () => {
  function buildHub(epoch = 0) {
    const sources: { closed: boolean }[] = [];
    const credentials = {
      openAdapter: jest.fn(),
      openPriceSource: jest.fn().mockImplementation(() => {
        const a = {
          closed: false,
          venue: VENUE,
          getTicker: jest.fn(),
          streamTicker: jest.fn(),
          streamHealth: jest.fn(),
          close: jest.fn().mockImplementation(function (this: { closed: boolean }) {
            this.closed = true;
            return Promise.resolve();
          }),
        };
        sources.push(a);
        return a;
      }),
    };
    const store = {
      load: jest.fn().mockResolvedValue({ state: null, epoch, startingBalance: '10000' }),
      epochOf: jest.fn().mockResolvedValue(epoch),
      save: jest.fn().mockResolvedValue(true),
    };
    const hub = new AccountHub(credentials as never, {} as never, store as never, config);
    return { hub, store, sources, credentials };
  }

  const abrir = (hub: AccountHub, botId: string, symbol: string) =>
    hub.open(ACCOUNT_ID, botId, VENUE, symbol, true, false);

  it('cada bot simulado recibe SU simulador, no uno compartido', async () => {
    // Es toda la razón de ser del cambio: con un simulador por cuenta, dos bots
    // sobre el mismo par se promediaban la entrada y se cerraban el take profit.
    const { hub } = buildHub();

    const a = await abrir(hub, 'bot-a', 'BTC');
    const b = await abrir(hub, 'bot-b', 'BTC');

    expect(b).not.toBe(a);
    await hub.onModuleDestroy();
  });

  it('pero comparten UNA sola fuente de precios', async () => {
    // Cien bots simulados no pueden ser cien conexiones al venue: sería
    // exactamente el problema que este hub existe para resolver.
    const { hub, credentials } = buildHub();

    await abrir(hub, 'bot-a', 'BTC');
    await abrir(hub, 'bot-b', 'ETH');

    expect(credentials.openPriceSource).toHaveBeenCalledTimes(1);
    await hub.onModuleDestroy();
  });

  it('el simulador no cierra la fuente al soltarse: no es suya', async () => {
    const { hub, sources } = buildHub();
    const handle = await abrir(hub, 'bot-a', 'BTC');

    await handle.close();

    expect(sources[0].closed).toBe(false);
    // Y al apagar el motor sí se cierra: si no, quedaría colgando.
    await hub.onModuleDestroy();
    expect(sources[0].closed).toBe(true);
  });

  it('no entrega un sandbox al que le reiniciaron la simulación', async () => {
    // El simulador ocioso sigue en el mapa hasta treinta segundos. Entregarlo
    // tras un reinicio arrancaba el bot sobre el saldo de ANTES mientras la
    // pantalla enseñaba la cuenta limpia.
    const { hub, store } = buildHub(0);

    const handle = await abrir(hub, BOT_ID, 'BTC');
    await handle.close();

    store.epochOf.mockResolvedValue(1); // el usuario reinició por medio
    await abrir(hub, BOT_ID, 'BTC');

    expect(store.load).toHaveBeenCalledTimes(2);
    await hub.onModuleDestroy();
  });

  it('con el bot vivo NO se reemplaza su sandbox: rompería el recuento', async () => {
    // Con handles fuera, sacar la entrada del mapa deja un recuento que ya no
    // baja —`release` busca por clave— y el adaptador no se cierra jamás.
    const { hub, store } = buildHub(0);

    await abrir(hub, BOT_ID, 'BTC'); // sin soltar
    store.epochOf.mockResolvedValue(1);
    await abrir(hub, BOT_ID, 'BTC');

    expect(store.load).toHaveBeenCalledTimes(1);
    await hub.onModuleDestroy();
  });

  it('guarda el sandbox EN CUANTO se suelta, no treinta segundos despues', async () => {
    // Importa cuando el bot se suelta porque se perdio su lease: otro worker lo
    // adopta en cuanto caduca, y con el guardado retrasado la escritura tardia
    // de este proceso caia ENCIMA de lo que el nuevo dueño ya estaba haciendo,
    // con el mismo epoch y sin nada que lo detuviera.
    const { hub, store } = buildHub(1);
    const handle = await abrir(hub, BOT_ID, 'BTC');

    await handle.close();
    await new Promise((r) => setTimeout(r, 20));

    expect(store.save).toHaveBeenCalledWith(BOT_ID, 1, expect.anything());
    await hub.onModuleDestroy();
  });

  it('un sandbox sin bot se cierra: no puede quedarse operando solo', async () => {
    // El simulador sigue suscrito al ticker mientras viva, y cada tick casa sus
    // órdenes en reposo. Esperando al barrido de inactivos, un sandbox huérfano
    // seguía operando medio minuto sin ningún bot detrás — y si el bot se soltó
    // por perder su lease, escribiendo encima del nuevo dueño.
    const { hub, store, credentials } = buildHub(1);
    const handle = await abrir(hub, BOT_ID, 'BTC');

    await handle.close();
    await new Promise((r) => setTimeout(r, 20));

    // Se ha reconstruido, señal de que el anterior ya no estaba en el mapa.
    await abrir(hub, BOT_ID, 'BTC');
    expect(store.load).toHaveBeenCalledTimes(2);
    // Y la fuente de precios NO se reabre: es lo que hacía cara la gracia de
    // treinta segundos, y aquí no hay nada que reabrir.
    expect(credentials.openPriceSource).toHaveBeenCalledTimes(1);
    await hub.onModuleDestroy();
  });

  it('un worker SIN lease no escribe el sandbox al soltarlo', async () => {
    // El epoch protege del reinicio de simulacion, no de un relevo entre
    // procesos: de eso protege el lease. Sin esto, el worker que lo pierde
    // guardaba al soltar el runner —con el mismo epoch que el que ya lo ha
    // adoptado— y le pisaba lo que llevara hecho.
    const { hub, store } = buildHub(1);
    const handle = await abrir(hub, BOT_ID, 'BTC');

    hub.abandonPaper(BOT_ID);
    await handle.close();
    await new Promise((r) => setTimeout(r, 20));

    expect(store.save).not.toHaveBeenCalled();
    await hub.onModuleDestroy();
  });

  it('al abandonar, el simulador se cierra igual: no puede quedarse operando', async () => {
    // El fantasma que esto evita: `abandonPaper` anulaba el registro y `release`
    // dejaba de reconocerlo como simulador, asi que el adaptador se quedaba
    // suscrito al ticker casando ordenes durante un minuto sin bot detras.
    const { hub, store, credentials } = buildHub(1);
    const handle = await abrir(hub, BOT_ID, 'BTC');

    hub.abandonPaper(BOT_ID);
    await handle.close();
    await new Promise((r) => setTimeout(r, 20));

    // Se reconstruye, señal de que el anterior salio del mapa y se cerro.
    await abrir(hub, BOT_ID, 'BTC');
    expect(store.load).toHaveBeenCalledTimes(2);
    expect(credentials.openPriceSource).toHaveBeenCalledTimes(1);
    await hub.onModuleDestroy();
  });

  it('abandonar uno no toca el sandbox de los demas', async () => {
    const { hub, store } = buildHub(1);
    const a = await abrir(hub, 'bot-a', 'BTC');
    const b = await abrir(hub, 'bot-b', 'ETH');

    hub.abandonPaper('bot-a');
    await a.close();
    await b.close();
    await new Promise((r) => setTimeout(r, 20));

    const guardados = store.save.mock.calls.map((c) => c[0]);
    expect(guardados).toEqual(['bot-b']);
    await hub.onModuleDestroy();
  });

  it('guarda el sandbox al apagarse, antes de cerrar nada', async () => {
    const { hub, store } = buildHub(2);
    await abrir(hub, BOT_ID, 'BTC');

    await hub.onModuleDestroy();

    expect(store.save).toHaveBeenCalledWith(BOT_ID, 2, expect.objectContaining({ seq: 0 }));
  });
});

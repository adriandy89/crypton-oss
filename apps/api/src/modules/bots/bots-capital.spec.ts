import { NotFoundException } from '@nestjs/common';
import { BotsService } from './bots.service';

/**
 * El endpoint de capital, por la parte que puede hacer daño.
 *
 * Lo que se comprueba aquí no es el formato de la respuesta: es que una lectura
 * de saldo NO pueda impedir crear un bot, y que no dispare un descifrado de
 * clave por cada repintado de la pantalla.
 *
 * `openAdapter` es —según su propio docblock— «el ÚNICO punto por el que el
 * secreto vuelve a memoria». Cada llamada que llega hasta ahí desprotege una
 * clave capaz de mover dinero, así que la caché y el single-flight no son
 * optimizaciones: son lo que acota cuántas veces por minuto existe esa clave en
 * el heap. Si alguien los quita, estos tests se ponen rojos.
 */

const ACCOUNT_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID = 'u1';

const BALANCE = {
  asset: 'USDC',
  total: '5100',
  available: '4820.15',
  used: '279.85',
};

/** Adaptador de mentira que cuenta sus aperturas y sus cierres. */
function fakeAdapter(overrides: Partial<Record<string, unknown>> = {}) {
  const calls = { close: 0 };
  return {
    calls,
    adapter: {
      getBalances: jest.fn().mockResolvedValue([BALANCE]),
      getPositions: jest.fn().mockResolvedValue([]),
      close: jest.fn().mockImplementation(() => {
        calls.close++;
        return Promise.resolve();
      }),
      ...overrides,
    },
  };
}

/** Caché en memoria con la misma forma que `CacheService`. */
function fakeCache() {
  const store = new Map<string, unknown>();
  return {
    store,
    get: jest.fn((k: string) => Promise.resolve(store.get(k) ?? null)),
    set: jest.fn((k: string, v: unknown) => {
      store.set(k, v);
      return Promise.resolve();
    }),
  };
}

function build(opts: {
  adapter: Record<string, unknown>;
  cache?: ReturnType<typeof fakeCache>;
  accountExists?: boolean;
}) {
  const cache = opts.cache ?? fakeCache();
  const openAdapter = jest.fn().mockResolvedValue(opts.adapter);

  const db = {
    exchangeAccount: {
      findFirst: jest
        .fn()
        .mockResolvedValue(opts.accountExists === false ? null : { id: ACCOUNT_ID }),
    },
    bot: { findMany: jest.fn().mockResolvedValue([]) },
    paperState: { findFirst: jest.fn().mockResolvedValue(null) },
  };

  const risk = {
    get: jest.fn().mockResolvedValue({
      max_leverage: null,
      max_notional_per_bot: null,
      max_total_notional: null,
    }),
    currentTotalNotional: jest.fn().mockResolvedValue({ toFixed: () => '0' }),
  };

  const service = new BotsService(
    db as never,
    {} as never,
    { openAdapter } as never,
    risk as never,
    {} as never,
    cache as never,
    { budget: {} } as never,
  );

  return { service, openAdapter, cache, db };
}

describe('BotsService.capital', () => {
  it('devuelve el saldo del venue y cierra el adaptador', async () => {
    const { adapter, calls } = fakeAdapter();
    const { service } = build({ adapter });

    const snapshot = await service.capital(USER_ID, {
      exchangeAccountId: ACCOUNT_ID,
    });

    expect(snapshot.available).toBe('4820.15');
    expect(snapshot.unavailable).toBeNull();
    expect(snapshot.stale).toBe(false);
    // El llamante esta OBLIGADO a cerrar: un adaptador vivo deja abiertos los
    // sockets del venue y la clave descifrada en memoria.
    expect(calls.close).toBe(1);
  });

  it('cierra el adaptador AUNQUE getBalances lance', async () => {
    const { adapter, calls } = fakeAdapter({
      getBalances: jest.fn().mockRejectedValue(new Error('venue caido')),
    });
    const { service } = build({ adapter });

    await service.capital(USER_ID, { exchangeAccountId: ACCOUNT_ID });

    expect(calls.close).toBe(1);
  });

  it('el venue caido NO rompe la respuesta: 200 con unavailable', async () => {
    const { adapter } = fakeAdapter({
      getBalances: jest.fn().mockRejectedValue(new Error('venue caido')),
    });
    const { service } = build({ adapter });

    const snapshot = await service.capital(USER_ID, {
      exchangeAccountId: ACCOUNT_ID,
    });

    // La regla dura de este endpoint: un exchange caido no puede impedir crear
    // un bot, asi que esto NO lanza y las cifras llegan a null.
    expect(snapshot.unavailable).toEqual({
      reason: 'VENUE',
      message: expect.any(String),
    });
    expect(snapshot.available).toBeNull();
  });

  it('distingue un fallo de credencial de uno del venue', async () => {
    const authError = Object.assign(new Error('sin permiso'), { kind: 'AUTH' });
    const { adapter } = fakeAdapter({
      getBalances: jest.fn().mockRejectedValue(authError),
    });
    const { service } = build({ adapter });

    const snapshot = await service.capital(USER_ID, {
      exchangeAccountId: ACCOUNT_ID,
    });

    // La distincion llega hasta la interfaz: con CREDENTIAL la app puede
    // ofrecer «Revisar mis conexiones»; con VENUE no hay nada que arreglar.
    expect(snapshot.unavailable?.reason).toBe('CREDENTIAL');
  });

  it('sirve el ultimo valor bueno, marcado como rancio, cuando el venue cae', async () => {
    const cache = fakeCache();
    const bueno = fakeAdapter();
    const primero = build({ adapter: bueno.adapter, cache });
    const antes = await primero.service.capital(USER_ID, {
      exchangeAccountId: ACCOUNT_ID,
    });

    // Caduca la entrada viva, pero NO la de `:last`, que dura diez minutos.
    for (const k of [...cache.store.keys()]) {
      if (!k.includes(':last:')) cache.store.delete(k);
    }

    const roto = fakeAdapter({
      getBalances: jest.fn().mockRejectedValue(new Error('venue caido')),
    });
    const segundo = build({ adapter: roto.adapter, cache });
    const despues = await segundo.service.capital(USER_ID, {
      exchangeAccountId: ACCOUNT_ID,
    });

    // Un saldo de hace tres minutos, en gris y fechado, deja decidir. Un guion
    // no: por eso se conserva el valor y se conserva SU hora, no la de ahora.
    expect(despues.available).toBe('4820.15');
    expect(despues.stale).toBe(true);
    expect(despues.at).toBe(antes.at);
    expect(despues.unavailable?.reason).toBe('VENUE');
  });

  it('la segunda llamada sale de cache y NO vuelve a abrir el adaptador', async () => {
    const cache = fakeCache();
    const { adapter } = fakeAdapter();
    const { service, openAdapter } = build({ adapter, cache });

    await service.capital(USER_ID, { exchangeAccountId: ACCOUNT_ID });
    await service.capital(USER_ID, { exchangeAccountId: ACCOUNT_ID });

    // UNA sola apertura: es lo que topa el descifrado de la clave en cuatro por
    // minuto y por cuenta, haga lo que haga la pantalla.
    expect(openAdapter).toHaveBeenCalledTimes(1);
  });

  it('dos llamadas a la vez comparten un solo vuelo', async () => {
    const cache = fakeCache();
    const { adapter } = fakeAdapter();
    const { service, openAdapter } = build({ adapter, cache });

    // Concurrentes de verdad: las dos fallan el `get` antes de que ninguna
    // escriba, que es justo el hueco que la cache sola no cubre.
    await Promise.all([
      service.capital(USER_ID, { exchangeAccountId: ACCOUNT_ID }),
      service.capital(USER_ID, { exchangeAccountId: ACCOUNT_ID }),
    ]);

    expect(openAdapter).toHaveBeenCalledTimes(1);
  });

  it('una cuenta que no es del usuario da 404 y no abre nada', async () => {
    const { adapter } = fakeAdapter();
    const { service, openAdapter } = build({ adapter, accountExists: false });

    await expect(
      service.capital(USER_ID, { exchangeAccountId: ACCOUNT_ID }),
    ).rejects.toBeInstanceOf(NotFoundException);

    // Lo importante no es el codigo, es que la clave NO se llega a descifrar.
    expect(openAdapter).not.toHaveBeenCalled();
  });

  it('que no haya posicion no impide ver el saldo', async () => {
    const { adapter } = fakeAdapter({
      getPositions: jest.fn().mockRejectedValue(new Error('sin posiciones')),
    });
    const { service } = build({ adapter });

    const snapshot = await service.capital(USER_ID, {
      exchangeAccountId: ACCOUNT_ID,
      symbol: 'BTC',
    });

    // `allSettled` y no `all`: el saldo es el dato principal de la pantalla.
    expect(snapshot.available).toBe('4820.15');
    expect(snapshot.position).toBeNull();
  });

  it('una cartera vacia es un saldo de cero, no un fallo', async () => {
    // Aster filtra los saldos a cero, asi que devuelve `[]`.
    const { adapter } = fakeAdapter({
      getBalances: jest.fn().mockResolvedValue([]),
    });
    const { service } = build({ adapter });

    const snapshot = await service.capital(USER_ID, {
      exchangeAccountId: ACCOUNT_ID,
    });

    expect(snapshot.available).toBe('0');
    expect(snapshot.unavailable).toBeNull();
  });
});

/**
 * El `botId` de la consulta no puede servir para leer el sandbox de otro.
 *
 * La conexion se comprueba contra el dueño, pero el bot llegaba suelto: con el
 * id de un bot ajeno se devolvia su saldo, su resultado y su posicion.
 */
describe('BotsService.capital — el bot va atado a la conexion', () => {
  it('busca el sandbox exigiendo que el bot cuelgue de la conexion', async () => {
    const { service, db } = build({ adapter: fakeAdapter() });
    // Conexion de SIMULACION: es el unico caso en el que se mira un sandbox.
    db.exchangeAccount.findFirst.mockResolvedValue({
      id: ACCOUNT_ID,
      venue: 'LIGHTER',
      paper: true,
      paper_balance: null,
    });

    await service.capital(USER_ID, {
      exchangeAccountId: ACCOUNT_ID,
      botId: '99999999-9999-9999-9999-999999999999',
    });

    const where = (
      db.paperState.findFirst.mock.calls[0][0] as {
        where: Record<string, unknown>;
      }
    ).where;
    expect(where.bot).toEqual({ exchange_account_id: ACCOUNT_ID });
  });
});

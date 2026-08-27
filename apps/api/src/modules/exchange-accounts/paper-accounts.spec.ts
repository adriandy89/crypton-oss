import { ExchangeAccountsService } from './exchange-accounts.service';

/**
 * Las conexiones de SIMULACIÓN, por el lado de la API.
 *
 * Lo que se defiende aquí son las puertas que, si se caen, dejan de ser
 * molestias y pasan a ser dinero mal contado: que no se dupliquen, que no se
 * puedan dejar con capital cero o negativo, y que reiniciarlas deje de verdad
 * la cuenta a cero en vez de a medias.
 */

const USER = 'u-1';
const ACCOUNT = 'a-1';

const paper = {
  id: ACCOUNT,
  user_id: USER,
  venue: 'LIGHTER',
  label: 'Simulación',
  status: 'VERIFIED',
  public_ref: 'paper',
  builder_approved: false,
  testnet: false,
  paper: true,
  paper_balance: { toFixed: () => '10000' },
  last_verified_at: null,
  last_error: null,
  created_at: new Date(),
};

function build(account: Record<string, unknown> = paper, existentes: { venue: string }[] = []) {
  const db = {
    exchangeAccount: {
      findFirst: jest.fn().mockResolvedValue(account),
      findUnique: jest.fn().mockResolvedValue({ user_id: USER }),
      findMany: jest.fn().mockResolvedValue(existentes),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
      update: jest.fn().mockImplementation((a: { data: unknown }) => ({
        ...account,
        ...(a.data as object),
      })),
    },
    bot: {
      findFirst: jest.fn().mockResolvedValue(null),
      // Cada bot simulado tiene su propio sandbox, asi que reiniciar «la
      // simulacion» de una conexion es reiniciar el de todos los suyos que
      // tengan algo que reiniciar.
      findMany: jest.fn().mockResolvedValue([{ id: 'b-1', paper_state: { epoch: 2 } }]),
    },
    paperState: { upsert: jest.fn((a: unknown) => a) },
    $transaction: jest.fn((ops: unknown[]) => Promise.resolve(ops)),
  };
  const service = new ExchangeAccountsService(
    db as never,
    {} as never,
    { get: (_k: string, d?: unknown) => d } as never,
  );
  return { service, db };
}

describe('ExchangeAccountsService — conexiones de simulación', () => {
  it('no crea una segunda simulación aunque la primera esté renombrada', async () => {
    // Se decidía por la ETIQUETA: renombrada, dejaba de chocar contra la clave
    // única y el siguiente listado creaba otra. Y otra en el renombrado
    // siguiente, sin tope.
    const { service, db } = build(paper, [
      { venue: 'LIGHTER' },
      { venue: 'HYPERLIQUID' },
      { venue: 'ASTER' },
    ]);

    await service.ensurePaperAccounts(USER);

    expect(db.exchangeAccount.createMany).not.toHaveBeenCalled();
  });

  it('crea solo las que faltan', async () => {
    const { service, db } = build(paper, [{ venue: 'LIGHTER' }]);

    await service.ensurePaperAccounts(USER);

    const venues = (
      db.exchangeAccount.createMany.mock.calls[0][0] as {
        data: { venue: string }[];
      }
    ).data.map((d) => d.venue);
    expect(venues.sort()).toEqual(['ASTER', 'HYPERLIQUID']);
  });

  it('rechaza un capital de partida de cero o negativo', async () => {
    const { service } = build();

    await expect(service.update(USER, ACCOUNT, { paperBalance: '0' })).rejects.toThrow(
      /mayor que cero/i,
    );
    await expect(service.update(USER, ACCOUNT, { paperBalance: '-500' })).rejects.toThrow(
      /mayor que cero/i,
    );
  });

  it('el capital de partida solo existe en la simulación', async () => {
    const { service } = build({ ...paper, paper: false });
    await expect(service.update(USER, ACCOUNT, { paperBalance: '500' })).rejects.toThrow(
      /solo existe en la conexión de simulación/i,
    );
  });

  it('la conexión de simulación no se renombra', async () => {
    const { service } = build();
    await expect(service.update(USER, ACCOUNT, { label: 'La mía' })).rejects.toThrow(
      /no se renombra/i,
    );
  });

  it('reiniciar deja la simulación en su capital y sube el epoch', async () => {
    // El epoch es lo que impide que un adaptador todavía vivo en un worker
    // resucite el estado que se acaba de tirar.
    const { service, db } = build();

    await service.resetPaper(USER, ACCOUNT);

    // Y solo los que tienen algo que reiniciar: sin el filtro, cada reinicio
    // sembraba una fila por cada bot que hubiera existido nunca en la conexion.
    const filtro = (db.bot.findMany.mock.calls[0][0] as { where: Record<string, unknown> }).where;
    expect(filtro.dry_run).toBe(true);

    const escrito = db.paperState.upsert.mock.calls[0][0] as {
      where: { bot_id: string };
      update: {
        epoch: number;
        balance: string;
        positions: unknown[];
        orders: unknown[];
      };
    };
    expect(escrito.where.bot_id).toBe('b-1');
    expect(escrito.update.epoch).toBe(3);
    expect(escrito.update.balance).toBe('10000');
    expect(escrito.update.positions).toEqual([]);
    expect(escrito.update.orders).toEqual([]);
  });

  it('no se reinicia una simulación con bots en marcha', async () => {
    const { service, db } = build();
    db.bot.findFirst.mockResolvedValue({ id: 'b-1', name: 'Rejilla BTC' });

    await expect(service.resetPaper(USER, ACCOUNT)).rejects.toThrow(/parar antes/i);
    expect(db.paperState.upsert).not.toHaveBeenCalled();
  });
});

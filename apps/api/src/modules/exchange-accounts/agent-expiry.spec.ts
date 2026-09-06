import { ExchangeAccountsService } from './exchange-accounts.service';

/**
 * La caducidad de la firma delegada, por el lado de la API (spec 028).
 *
 * Una API wallet de Hyperliquid dura 90 dias por defecto y 180 como maximo. Al
 * vencer, el venue deja de aceptar la firma: los bots no pueden colocar ni
 * cancelar y las posiciones abiertas se quedan sin vigilancia. No se pierde
 * dinero, pero el usuario tiene que enterarse ANTES, y para eso la fecha que
 * devuelve el adaptador tiene que llegar a la columna y de ahi a la pantalla.
 */

const USER = 'u-1';
const ACCOUNT = 'a-1';
const VENCE = Date.UTC(2027, 2, 5);

const fila = (over: Record<string, unknown> = {}) => ({
  id: ACCOUNT,
  user_id: USER,
  venue: 'HYPERLIQUID',
  label: 'Principal',
  status: 'VERIFIED',
  public_ref: '0x' + '1'.repeat(40),
  builder_approved: false,
  testnet: false,
  paper: false,
  paper_balance: null,
  last_verified_at: new Date('2026-09-06T21:19:00.000Z'),
  last_error: null,
  agent_valid_until: null,
  created_at: new Date('2026-09-06T21:19:00.000Z'),
  ...over,
});

function build(verify: jest.Mock, cuenta = fila()) {
  const db = {
    exchangeAccount: {
      // La comprobacion de duplicados busca por etiqueta y `mustOwn` por id:
      // el doble distingue las dos por la forma de la consulta para que crear
      // no choque contra la fila que reverificar necesita encontrar.
      findFirst: jest
        .fn()
        .mockImplementation((a: { where: { label?: string } }) =>
          Promise.resolve(a.where.label === undefined ? cuenta : null),
        ),
      create: jest.fn().mockImplementation((a: { data: object }) => ({ ...cuenta, ...a.data })),
      update: jest.fn().mockImplementation((a: { data: object }) => ({ ...cuenta, ...a.data })),
    },
  };
  const envelope = {
    seal: () => ({
      encPayload: 'p',
      encDek: 'd',
      encIv: 'i',
      encTag: 't',
      encKeyId: 'k',
    }),
  };
  const service = new ExchangeAccountsService(
    db as never,
    envelope as never,
    {
      get: (_k: string, d?: unknown) => d,
    } as never,
  );
  const adapter = { verify, close: jest.fn().mockResolvedValue(undefined) };
  // `adapterFor` y `openAdapter` construyen un adaptador de verdad contra la
  // red: aqui se sustituyen por el doble. Lo que se prueba es el trasvase de la
  // fecha, no el adaptador, que tiene sus propios tests.
  jest.spyOn(service as never, 'adapterFor').mockReturnValue(adapter as never);
  jest.spyOn(service, 'openAdapter').mockResolvedValue(adapter as never);
  return { service, db, adapter };
}

const dto = {
  venue: 'HYPERLIQUID',
  label: 'Principal',
  testnet: false,
  hyperliquid: {
    accountAddress: '0x' + '1'.repeat(40),
    agentPrivateKey: '0x' + '3'.repeat(64),
  },
} as never;

describe('caducidad de la API wallet (spec 028)', () => {
  it('al crear la conexion guarda la fecha que devuelve el venue', async () => {
    const verify = jest
      .fn()
      .mockResolvedValue({ ok: true, publicRef: '0x' + '1'.repeat(40), agentValidUntil: VENCE });
    const { service, db } = build(verify);

    const publico = await service.create(USER, dto);

    expect(db.exchangeAccount.create.mock.calls[0][0].data.agent_valid_until).toEqual(
      new Date(VENCE),
    );
    // Y sale en la proyeccion publica: si no llega a la app, no avisa a nadie.
    expect(publico.agentValidUntil).toEqual(new Date(VENCE));
  });

  it('una firma que no caduca se guarda como nula, no como una fecha inventada', async () => {
    const verify = jest.fn().mockResolvedValue({ ok: true, publicRef: 'x', agentValidUntil: null });
    const { service, db } = build(verify);

    await service.create(USER, dto);

    expect(db.exchangeAccount.create.mock.calls[0][0].data.agent_valid_until).toBeNull();
  });

  it('reverificar pone la fecha al dia: el venue no avisa cuando se reautoriza', async () => {
    const otra = Date.UTC(2027, 8, 1);
    const verify = jest.fn().mockResolvedValue({ ok: true, publicRef: 'x', agentValidUntil: otra });
    const { service, db } = build(verify, fila({ agent_valid_until: new Date(VENCE) }));

    await service.verify(USER, ACCOUNT);

    expect(db.exchangeAccount.update.mock.calls[0][0].data.agent_valid_until).toEqual(
      new Date(otra),
    );
  });

  it('un fallo al reverificar NO borra la fecha que ya se conocia', async () => {
    // Perderla dejaria a la app sin poder avisar justo cuando el venue esta
    // dando problemas, que es cuando mas falta hace saber si la firma sigue viva.
    const verify = jest.fn().mockResolvedValue({ ok: false, publicRef: 'x', detail: 'boom' });
    const { service, db } = build(verify, fila({ agent_valid_until: new Date(VENCE) }));

    await service.verify(USER, ACCOUNT);

    const data = db.exchangeAccount.update.mock.calls[0][0].data;
    expect(data.agent_valid_until).toBeUndefined();
    expect(data.last_error).toBe('boom');
  });

  it('un venue sin caducidad deja la columna intacta en vez de vaciarla', async () => {
    // Aster y Lighter no devuelven el campo. `undefined` conserva lo que haya;
    // `null` lo borraria, y la diferencia solo se ve en un `update`.
    const verify = jest.fn().mockResolvedValue({ ok: true, publicRef: 'x' });
    const { service, db } = build(verify, fila({ venue: 'ASTER' }));

    await service.verify(USER, ACCOUNT);

    expect(db.exchangeAccount.update.mock.calls[0][0].data.agent_valid_until).toBeUndefined();
  });
});

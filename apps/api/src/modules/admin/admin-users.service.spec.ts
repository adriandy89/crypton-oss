import { ConflictException } from '@nestjs/common';
import { AdminUsersService } from './admin-users.service';

/**
 * La ficha de un usuario, y sobre todo lo que NO sale en ella.
 */

const USER = 'u-1';
const ADMIN = 'a-1';

/** Una fila con TODO lo sensible dentro, para comprobar que nada de esto sale. */
const filaCompleta = () => ({
  id: USER,
  email: 'laura@example.com',
  name: 'Laura',
  role: 'USER',
  disabled: false,
  is_email_verified: true,
  country: 'ES',
  language: 'es',
  created_at: new Date('2026-01-01T00:00:00Z'),
  last_login_at: new Date('2026-09-01T10:00:00Z'),
  google_sub: 'GOOGLE-SUB-QUE-NO-DEBE-SALIR',
  bio: null,
  timezone: null,
  display_currency: null,
  updated_at: null,
  _count: { exchange_accounts: 1, bots: 2 },
  bots: [{ status: 'RUNNING' }, { status: 'STOPPED' }],
  exchange_accounts: [
    {
      id: 'acc-1',
      venue: 'HYPERLIQUID',
      label: 'Principal',
      status: 'ACTIVE',
      public_ref: '0xPUBLICO',
      testnet: false,
      paper: false,
      builder_approved: true,
      last_verified_at: null,
      agent_valid_until: null,
      last_error: null,
      enc_payload: 'SOBRE-CIFRADO',
      enc_dek: 'DEK-CIFRADA',
      enc_iv: 'IV',
      enc_tag: 'TAG',
      enc_key_id: 'KEY-1',
    },
  ],
  risk_limit: null,
  telegram_link: {
    verified_at: new Date('2026-02-02T00:00:00Z'),
    chat_id: '123',
    link_code: 'ABC',
  },
});

function build(over: { user?: unknown; adminsActivos?: number } = {}) {
  const db = {
    user: {
      findUnique: jest.fn().mockResolvedValue(over.user ?? filaCompleta()),
      findMany: jest.fn().mockResolvedValue([filaCompleta()]),
      count: jest.fn().mockResolvedValue(over.adminsActivos ?? 2),
      update: jest.fn().mockResolvedValue(undefined),
    },
  };
  const tokens = {
    revokeAll: jest.fn().mockResolvedValue({ aplicada: true, vigenteHasta: new Date() }),
  };
  const revocacion = { clear: jest.fn().mockResolvedValue(undefined) };
  const service = new AdminUsersService(db as never, tokens as never, revocacion as never);
  return { service, db, tokens, revocacion };
}

describe('lo que nunca sale de la consola', () => {
  /**
   * Se comprueba sobre la respuesta SERIALIZADA y no campo a campo: lo que se
   * quiere afirmar no es «este campo no esta», es «este dato no viaja», y da
   * igual si aparece anidado, renombrado o dentro de otra cosa.
   */
  const PROHIBIDOS = [
    'GOOGLE-SUB-QUE-NO-DEBE-SALIR', // identidad ante Google
    'SOBRE-CIFRADO', // el sobre AES-GCM, invariante 8
    'DEK-CIFRADA',
    'KEY-1',
    'ABC', // link_code de Telegram: quien lo acierte recibe los avisos de la victima
    '123', // chat_id
  ];

  it('la ficha completa no lleva ningun secreto', async () => {
    const { service } = build();

    const detalle = await service.detail(USER);
    const json = JSON.stringify(detalle);

    for (const prohibido of PROHIBIDOS) {
      expect(json).not.toContain(prohibido);
    }
    // Y lo que SI tiene que estar, para que el test no pase por estar vacio.
    expect(json).toContain('laura@example.com');
    expect(json).toContain('0xPUBLICO'); // dato publico por definicion del esquema
  });

  it('de Telegram solo dice si esta vinculado', async () => {
    const { service } = build();
    const detalle = await service.detail(USER);
    expect(detalle.telegram).toEqual({ linked: true, verifiedAt: '2026-02-02T00:00:00.000Z' });
  });

  it('cuenta los bots vivos aparte del total', async () => {
    const { service } = build();
    const detalle = await service.detail(USER);
    // Dos bots, uno solo bajo control del motor.
    expect(detalle.bots).toEqual({ total: 2, live: 1 });
    expect(detalle.botsByStatus).toEqual({ RUNNING: 1, STOPPED: 1 });
  });

  it('un usuario que no existe es 404', async () => {
    const { service, db } = build();
    db.user.findUnique.mockResolvedValue(null);
    await expect(service.detail(USER)).rejects.toThrow('Usuario no encontrado.');
  });
});

describe('deshabilitar una cuenta', () => {
  it('marca la fila Y le corta la sesion, en ese orden', async () => {
    const { service, db, tokens } = build();

    const res = await service.disable(ADMIN, USER);

    expect(db.user.update).toHaveBeenCalledWith({
      where: { id: USER },
      data: { disabled: true },
    });
    expect(tokens.revokeAll).toHaveBeenCalledWith(USER, 'cuenta_deshabilitada');
    expect(res).toMatchObject({ disabled: true, sesionCortada: true });
  });

  /**
   * Sin esto, un fallo de Redis devolveria un 200 liso y el administrador se
   * quedaria creyendo que ha cerrado una cuenta comprometida cuando su token
   * sigue valiendo un cuarto de hora.
   */
  it('si el corte no se aplico, lo dice en vez de devolver un exito liso', async () => {
    const { service, tokens } = build();
    const hasta = new Date('2026-09-10T12:15:00Z');
    tokens.revokeAll.mockResolvedValue({ aplicada: false, vigenteHasta: hasta });

    const res = await service.disable(ADMIN, USER);

    // La bandera queda puesta igualmente: es la proteccion duradera y no se
    // revierte porque el corte inmediato haya fallado.
    expect(res).toMatchObject({ disabled: true, sesionCortada: false, accesoResidualHasta: hasta });
  });

  it('un administrador no puede deshabilitarse a si mismo', async () => {
    const { service, db } = build({
      user: { id: ADMIN, disabled: false, role: 'ADMIN' },
    });

    await expect(service.disable(ADMIN, ADMIN)).rejects.toBeInstanceOf(ConflictException);
    expect(db.user.update).not.toHaveBeenCalled();
  });

  /** Dejar la plataforma sin nadie que pueda entrar aqui se arregla con un psql. */
  it('no se puede deshabilitar al ultimo administrador activo', async () => {
    const { service, db } = build({
      user: { id: 'otro-admin', disabled: false, role: 'ADMIN' },
      adminsActivos: 1,
    });

    await expect(service.disable(ADMIN, 'otro-admin')).rejects.toBeInstanceOf(ConflictException);
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it('con mas de un administrador activo, si se puede', async () => {
    const { service, db } = build({
      user: { id: 'otro-admin', disabled: false, role: 'ADMIN' },
      adminsActivos: 2,
    });

    await expect(service.disable(ADMIN, 'otro-admin')).resolves.toMatchObject({ disabled: true });
    expect(db.user.update).toHaveBeenCalled();
  });

  /**
   * Este camino es el que se recorre justo despues de que un corte fallara con
   * Redis caido: la bandera quedo puesta y la sesion no. Devolver «hecho» sin
   * intentarlo dejaria al intruso dentro con la bendicion de la pantalla.
   */
  it('deshabilitar una cuenta ya deshabilitada REINTENTA el corte', async () => {
    const { service, db, tokens } = build({ user: { id: USER, disabled: true, role: 'USER' } });

    await expect(service.disable(ADMIN, USER)).resolves.toMatchObject({
      disabled: true,
      sesionCortada: true,
    });

    expect(tokens.revokeAll).toHaveBeenCalledWith(USER, 'cuenta_deshabilitada');
    // La bandera ya estaba: no se vuelve a escribir.
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it('y si el reintento tampoco corta, lo dice', async () => {
    const { service, tokens } = build({ user: { id: USER, disabled: true, role: 'USER' } });
    const hasta = new Date(Date.now() + 900_000);
    tokens.revokeAll.mockResolvedValue({ aplicada: false, vigenteHasta: hasta });

    await expect(service.disable(ADMIN, USER)).resolves.toMatchObject({
      sesionCortada: false,
      accesoResidualHasta: hasta,
    });
  });
});

describe('rehabilitar y cerrar sesiones', () => {
  /**
   * Sin el `clear`, el usuario recien rehabilitado no podria usar ni el token
   * que le acabase de dar el login: su `iat` seguiria siendo anterior a una
   * marca de revocacion que sigue viva.
   */
  it('rehabilitar LEVANTA la marca de revocacion', async () => {
    const { service, db, revocacion } = build({ user: { id: USER, disabled: true, role: 'USER' } });

    const res = await service.enable(USER);

    expect(db.user.update).toHaveBeenCalledWith({
      where: { id: USER },
      data: { disabled: false },
    });
    expect(revocacion.clear).toHaveBeenCalledWith(USER);
    expect(res).toEqual({ id: USER, disabled: false });
  });

  it('cerrar sesiones no toca la bandera de la cuenta', async () => {
    const { service, db, tokens } = build({ user: { id: USER, disabled: false, role: 'USER' } });

    await service.revokeSessions(USER);

    expect(tokens.revokeAll).toHaveBeenCalledWith(USER, 'sesiones_cerradas');
    expect(db.user.update).not.toHaveBeenCalled();
  });
});

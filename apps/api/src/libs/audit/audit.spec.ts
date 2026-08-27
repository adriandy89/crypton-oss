import {
  actorOf,
  pickFields,
  safeRoute,
  type AuditableRequest,
} from './audit.request';
import { AuditService } from './audit.service';

/**
 * Tests de la bitácora.
 *
 * El primer bloque es el más importante del módulo: comprueba que una clave
 * privada de firma no puede acabar en la tabla. El README dice que esas claves
 * no van «ni en un log», y aquí es donde eso deja de ser una intención y pasa a
 * ser algo que falla si alguien lo rompe.
 */

describe('Redactor — lo que NUNCA puede acabar en la tabla', () => {
  /** El cuerpo real de `POST /exchange-accounts`, con las tres formas de venue. */
  const cuerpoConSecretos = {
    venue: 'HYPERLIQUID',
    label: 'Principal',
    hyperliquid: {
      accountAddress: '0x7a3f000000000000000000000000000000009c21',
      agentPrivateKey: 'a'.repeat(64),
    },
    lighter: { accountIndex: 3, apiKeyIndex: 0, apiPrivateKey: 'b'.repeat(64) },
    aster: {
      userAddress: '0x1b8e000000000000000000000000000000004dd0',
      signerAddress: '0x1b8e000000000000000000000000000000004dd1',
      signerPrivateKey: 'c'.repeat(64),
    },
  };

  it('con la lista blanca de la casa solo salen `venue` y `label`', () => {
    const out = pickFields(cuerpoConSecretos, ['venue', 'label']);
    expect(out).toEqual({ venue: 'HYPERLIQUID', label: 'Principal' });
  });

  it('ninguna clave privada aparece en el resultado serializado', () => {
    const out = JSON.stringify(
      pickFields(cuerpoConSecretos, ['venue', 'label']),
    );
    expect(out).not.toContain('a'.repeat(64));
    expect(out).not.toContain('b'.repeat(64));
    expect(out).not.toContain('c'.repeat(64));
    expect(out.toLowerCase()).not.toContain('privatekey');
  });

  it('aunque alguien listara el venue entero por error, el objeto no se serializa', () => {
    // Segundo cerrojo: las claves privadas viven SIEMPRE dentro de un objeto
    // anidado, y un objeto nunca se copia — se sustituye por su forma.
    const out = pickFields(cuerpoConSecretos, [
      'venue',
      'hyperliquid',
      'aster',
    ]);
    expect(out).toEqual({
      venue: 'HYPERLIQUID',
      hyperliquid: '[objeto]',
      aster: '[objeto]',
    });
    expect(JSON.stringify(out)).not.toContain('a'.repeat(64));
  });

  it('sin lista blanca no sale NADA: el valor por defecto es no registrar', () => {
    expect(pickFields(cuerpoConSecretos, undefined)).toBeNull();
    expect(pickFields(cuerpoConSecretos, [])).toBeNull();
  });

  it('recorta las cadenas largas en vez de guardarlas enteras', () => {
    const out = pickFields({ label: 'x'.repeat(500) }, ['label']) as Record<
      string,
      string
    >;
    expect(out['label'].length).toBeLessThanOrEqual(201);
  });

  it('un campo declarado que no viene no inventa una clave', () => {
    expect(pickFields({ venue: 'ASTER' }, ['venue', 'label'])).toEqual({
      venue: 'ASTER',
    });
  });
});

describe('safeRoute — la fuga de OAuth', () => {
  it('nunca devuelve el código ni el state del callback de Google', () => {
    // El caso real: `GET /auth/google/callback` recibe el código de autorización
    // y el `state` en el query string. Guardar `req.url` sería archivar
    // credenciales de un solo uso en claro.
    const req: AuditableRequest = {
      method: 'GET',
      path: '/api/v1/auth/google/callback',
      originalUrl:
        '/api/v1/auth/google/callback?code=4%2F0AXsecreto&state=abc123',
      url: '/auth/google/callback?code=4%2F0AXsecreto&state=abc123',
    };
    const route = safeRoute(req)!;
    expect(route).toBe('/api/v1/auth/google/callback');
    expect(route).not.toContain('code=');
    expect(route).not.toContain('state=');
    expect(route).not.toContain('secreto');
  });

  it('prefiere el PATRÓN de ruta, no el valor: sin cardinalidad por UUID', () => {
    const req: AuditableRequest = {
      baseUrl: '/api/v1',
      route: { path: '/bots/:id' },
      path: '/api/v1/bots/3f2a-uuid-largo',
    };
    expect(safeRoute(req)).toBe('/api/v1/bots/:id');
  });

  it('sin ruta casada —un 404— cae a la ruta sin query string', () => {
    expect(safeRoute({ path: '/api/v1/inventado' })).toBe('/api/v1/inventado');
  });

  it('como último recurso corta por el interrogante; jamás devuelve un query', () => {
    expect(safeRoute({ url: '/x?ticket=SECRETO' })).toBe('/x');
  });
});

describe('actorOf', () => {
  it('sin sesión es ANON: un 401 del guard no tiene usuario y hay que poder contarlo', () => {
    expect(actorOf({})).toEqual({ actor: 'ANON', actorId: null });
  });

  it('distingue ADMIN de USER: un admin actuando sobre otra cuenta se busca aparte', () => {
    expect(actorOf({ user: { id: 'u1', role: 'ADMIN' } })).toEqual({
      actor: 'ADMIN',
      actorId: 'u1',
    });
    expect(actorOf({ user: { id: 'u2', role: 'USER' } })).toEqual({
      actor: 'USER',
      actorId: 'u2',
    });
  });
});

describe('AuditService — el interruptor y el buffer', () => {
  const db = () => ({
    activityLog: {
      create: jest.fn().mockResolvedValue({}),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
  });
  const config = (value?: string) => ({ get: () => value }) as never;
  const entry = (action = 'x') => ({
    actor: 'USER' as const,
    action,
    outcome: 'OK' as const,
  });

  it('apagado no toca la base ni una vez', async () => {
    const base = db();
    const svc = new AuditService(base as never, config(undefined));
    expect(svc.enabled).toBe(false);
    svc.record(entry());
    await svc.recordNow(entry());
    await svc.flush();
    expect(base.activityLog.create).not.toHaveBeenCalled();
    expect(base.activityLog.createMany).not.toHaveBeenCalled();
  });

  it('cualquier valor que no sea la cadena exacta `true` lo deja apagado', () => {
    for (const v of ['TRUE', '1', 'yes', 'si', '', undefined]) {
      expect(new AuditService(db() as never, config(v)).enabled).toBe(false);
    }
    expect(new AuditService(db() as never, config('true')).enabled).toBe(true);
  });

  it('agrupa: N entradas producen UN solo createMany', async () => {
    const base = db();
    const svc = new AuditService(base as never, config('true'));
    for (let i = 0; i < 50; i++) svc.record(entry(`a${i}`));
    expect(svc.pending).toBe(50);
    await svc.flush();
    expect(base.activityLog.createMany).toHaveBeenCalledTimes(1);
    expect(base.activityLog.createMany.mock.calls[0]![0].data).toHaveLength(50);
    await svc.onModuleDestroy();
  });

  it('un fallo de la base NO se propaga: la petición del usuario sigue viva', async () => {
    const base = db();
    base.activityLog.createMany.mockRejectedValue(new Error('base caída'));
    base.activityLog.create.mockRejectedValue(new Error('base caída'));
    const svc = new AuditService(base as never, config('true'));
    svc.record(entry());
    await expect(svc.flush()).resolves.toBeUndefined();
    await expect(svc.recordNow(entry())).resolves.toBeUndefined();
    await svc.onModuleDestroy();
  });

  it('el buffer se vacía antes de escribir: lo que llegue durante el volcado no se pierde', async () => {
    const base = db();
    let resolver: (() => void) | undefined;
    base.activityLog.createMany.mockImplementation(
      () => new Promise<void>((r) => (resolver = () => r())),
    );
    const svc = new AuditService(base as never, config('true'));
    svc.record(entry('primera'));
    const vuelco = svc.flush();
    svc.record(entry('durante'));
    resolver!();
    await vuelco;
    expect(svc.pending).toBe(1);

    // El mock vuelve a resolver antes de cerrar: `onModuleDestroy` hace un
    // último volcado y con la implementación colgada se quedaría esperando.
    base.activityLog.createMany.mockResolvedValue({ count: 1 });
    await svc.onModuleDestroy();
  });

  it('el buffer tiene tope: no puede tumbar el proceso por memoria', async () => {
    const base = db();
    const svc = new AuditService(base as never, config('true'));
    for (let i = 0; i < 6_000; i++) svc.record(entry(`b${i}`));
    expect(svc.pending).toBeLessThanOrEqual(5_000);
    await svc.onModuleDestroy();
  });
});

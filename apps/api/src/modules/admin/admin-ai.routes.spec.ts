import {
  ValidationPipe,
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Server } from 'node:http';
import request from 'supertest';
import { AuditService } from 'src/libs';
import { JwtAuthGuard } from '../auth/guards';
import { SupervisorPolicyService } from '../supervisor/supervisor.policy.service';
import { SupervisorService } from '../supervisor/supervisor.service';
import { AdminAiController } from './admin-ai.controller';
import { AdminBotsController } from './admin-bots.controller';
import { AdminBotsService } from './admin-bots.service';

/**
 * Las rutas del Modo IA, montadas de verdad (spec 053).
 *
 * `AdminAiController` cambio su prefijo de `admin/bots` a `admin` para poder
 * servir `GET /admin/ai`. Lo que se prueba aqui no se puede probar leyendo
 * metadatos: que el enrutador, con `AdminBotsController` registrado ANTES —como
 * en `admin.module.ts`—, entrega cada peticion a su manejador. Esa es justo la
 * razon del cambio de prefijo: `GET admin/bots/:id` se habria quedado con
 * `admin/bots/ai`.
 *
 * Sin base ni Redis: los servicios son dobles, la sesion la pone un guard falso
 * con el rol que diga la cabecera, y el `RolesGuard` es el de verdad.
 */

const ADMIN_ID = 'la-administradora';
const BOT_ID = '11111111-1111-4111-8111-111111111111';

const sesion: CanActivate = {
  canActivate(ctx: ExecutionContext) {
    const req = ctx
      .switchToHttp()
      .getRequest<{ headers: Record<string, string | undefined>; user?: unknown }>();
    const rol = req.headers['x-rol'];
    if (!rol) return false;
    req.user = {
      id: rol === 'ADMIN' ? ADMIN_ID : 'un-usuario',
      email: 'alguien@example.invalid',
      name: 'Alguien',
      role: rol,
      language: 'es',
    };
    return true;
  },
};

describe('Rutas del Modo IA (spec 053)', () => {
  let app: INestApplication;
  const policy = {
    get: jest.fn(),
    set: jest.fn(),
    encendidosDe: jest.fn(),
    estrategias: jest.fn(),
  };
  const supervisor = { interruptores: jest.fn() };
  const audit = { record: jest.fn(), recordNow: jest.fn() };
  const bots = { detail: jest.fn(), list: jest.fn() };

  const INTERRUPTORES = { encendido: true, forzarManual: false, soloSimulados: true };

  beforeAll(async () => {
    const modulo = await Test.createTestingModule({
      // En el MISMO orden que `admin.module.ts`: el de bots primero.
      controllers: [AdminBotsController, AdminAiController],
      providers: [
        { provide: AdminBotsService, useValue: bots },
        { provide: SupervisorPolicyService, useValue: policy },
        { provide: SupervisorService, useValue: supervisor },
        { provide: AuditService, useValue: audit },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(sesion)
      .compile();

    app = modulo.createNestApplication();
    // Las mismas opciones que `main.ts`.
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    policy.get.mockResolvedValue({ bot_id: BOT_ID, mode: 'AUTO', cubierta: true });
    policy.set.mockResolvedValue({ bot_id: BOT_ID, mode: 'AUTO', cubierta: true });
    policy.encendidosDe.mockResolvedValue([{ bot_id: BOT_ID, mode: 'AUTO' }]);
    policy.estrategias.mockReturnValue(['MARKET_MAKER']);
    supervisor.interruptores.mockReturnValue(INTERRUPTORES);
    audit.recordNow.mockResolvedValue(undefined);
    bots.detail.mockResolvedValue({ id: BOT_ID, owner: { id: 'otra' } });
  });

  // `getHttpServer()` devuelve `any` en el tipo de Nest; debajo es un `http.Server`.
  const http = () => request(app.getHttpServer() as Server);

  it('GET /admin/ai llega a su manejador, no al detalle de un bot', async () => {
    const res = await http().get('/admin/ai').set('x-rol', 'ADMIN').expect(200);

    expect(res.body).toEqual({
      interruptores: INTERRUPTORES,
      estrategias: ['MARKET_MAKER'],
      bots: [{ bot_id: BOT_ID, mode: 'AUTO' }],
    });
    expect(policy.encendidosDe).toHaveBeenCalledWith(ADMIN_ID);
    expect(bots.detail).not.toHaveBeenCalled();
  });

  it('GET /admin/bots/:id/ai sigue en su sitio, y trae los interruptores', async () => {
    const res = await http().get(`/admin/bots/${BOT_ID}/ai`).set('x-rol', 'ADMIN').expect(200);

    expect(policy.get).toHaveBeenCalledWith(ADMIN_ID, BOT_ID);
    expect(res.body).toMatchObject({ mode: 'AUTO', cubierta: true, interruptores: INTERRUPTORES });
  });

  it('PUT /admin/bots/:id/ai sigue en su sitio, pasa el motivo y audita', async () => {
    await http()
      .put(`/admin/bots/${BOT_ID}/ai`)
      .set('x-rol', 'ADMIN')
      .send({ mode: 'AUTO', allowWarm: false, reason: 'lo vigilo yo' })
      .expect(200);

    expect(policy.set).toHaveBeenCalledWith(
      ADMIN_ID,
      BOT_ID,
      expect.objectContaining({ mode: 'AUTO', allowWarm: false, reason: 'lo vigilo yo' }),
    );
    expect(audit.recordNow).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin.bot.ai_enable',
        botId: BOT_ID,
        meta: expect.objectContaining({ allowWarm: false, reason: 'lo vigilo yo' }) as unknown,
      }),
    );
  });

  it('un PUT sin motivo es 400 y no toca nada', async () => {
    await http()
      .put(`/admin/bots/${BOT_ID}/ai`)
      .set('x-rol', 'ADMIN')
      .send({ mode: 'AUTO' })
      .expect(400);
    expect(policy.set).not.toHaveBeenCalled();
  });

  it('un PUT con el disparador vacio es 400, no 500 (H-04)', async () => {
    await http()
      .put(`/admin/bots/${BOT_ID}/ai`)
      .set('x-rol', 'ADMIN')
      .send({ mode: 'AUTO', trigger: null, reason: 'lo vigilo yo' })
      .expect(400);
    expect(policy.set).not.toHaveBeenCalled();
  });

  it('GET /admin/bots/:id sigue siendo el detalle', async () => {
    await http().get(`/admin/bots/${BOT_ID}`).set('x-rol', 'ADMIN').expect(200);
    expect(bots.detail).toHaveBeenCalledWith(BOT_ID);
    expect(policy.get).not.toHaveBeenCalled();
  });

  it('GET /admin/bots/ai NO es el resumen: se lo queda el detalle, y por eso el prefijo es otro', async () => {
    await http().get('/admin/bots/ai').set('x-rol', 'ADMIN').expect(400);
    expect(policy.encendidosDe).not.toHaveBeenCalled();
  });

  it.each([
    ['get', '/admin/ai'],
    ['get', `/admin/bots/${BOT_ID}/ai`],
    ['put', `/admin/bots/${BOT_ID}/ai`],
  ] as const)('un USER recibe 403 en %s %s y no se consulta nada', async (metodo, ruta) => {
    await http()
      [metodo](ruta)
      .set('x-rol', 'USER')
      .send({ mode: 'AUTO', reason: 'lo vigilo yo' })
      .expect(403);
    expect(policy.get).not.toHaveBeenCalled();
    expect(policy.set).not.toHaveBeenCalled();
    expect(policy.encendidosDe).not.toHaveBeenCalled();
    expect(supervisor.interruptores).not.toHaveBeenCalled();
  });
});

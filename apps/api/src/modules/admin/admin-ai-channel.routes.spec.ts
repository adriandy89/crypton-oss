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
import { AiChannelEstadoService } from '../ai-channel';
import { JwtAuthGuard } from '../auth/guards';
import { SupervisorPolicyService } from '../supervisor/supervisor.policy.service';
import { SupervisorService } from '../supervisor/supervisor.service';
import { AdminAiChannelController } from './admin-ai-channel.controller';
import { AdminAiController } from './admin-ai.controller';
import { AdminBotsController } from './admin-bots.controller';
import { AdminBotsService } from './admin-bots.service';

/**
 * Las rutas del canal con IA en la consola, montadas de verdad (spec 059, CA-6).
 *
 * Con los controladores en el orden de `admin.module.ts`: el de bots registra
 * antes `GET admin/bots/:id`, y ninguna ruta del canal puede acabar en él. Un
 * usuario sin el rol recibe 403 en todas y no se toca ningún servicio. La
 * sesión es un guard falso con el rol de la cabecera; el de roles es el real.
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

describe('Rutas del canal con IA (spec 059)', () => {
  let app: INestApplication;
  const canal = {
    resumen: jest.fn(),
    fijarEntradas: jest.fn(),
    estado: jest.fn(),
    decisiones: jest.fn(),
    detalle: jest.fn(),
  };
  const audit = { record: jest.fn(), recordNow: jest.fn() };
  const bots = { detail: jest.fn(), list: jest.fn() };
  const policy = { get: jest.fn(), encendidosDe: jest.fn(), estrategias: jest.fn() };
  const supervisor = { interruptores: jest.fn() };

  beforeAll(async () => {
    const modulo = await Test.createTestingModule({
      controllers: [AdminBotsController, AdminAiController, AdminAiChannelController],
      providers: [
        { provide: AdminBotsService, useValue: bots },
        { provide: SupervisorPolicyService, useValue: policy },
        { provide: SupervisorService, useValue: supervisor },
        { provide: AiChannelEstadoService, useValue: canal },
        { provide: AuditService, useValue: audit },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(sesion)
      .compile();

    app = modulo.createNestApplication();
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
    canal.resumen.mockResolvedValue({ interruptores: { entradas: 'ABIERTAS' }, bots: [] });
    canal.fijarEntradas.mockResolvedValue({ entradas: 'CERRADAS' });
    canal.estado.mockResolvedValue({ botId: BOT_ID });
    canal.decisiones.mockResolvedValue([]);
    canal.detalle.mockResolvedValue({ id: 'reglas:x:1' });
    audit.recordNow.mockResolvedValue(undefined);
  });

  const http = () => request(app.getHttpServer() as Server);

  it('GET /admin/ai-channel llega a su manejador con el administrador que llama', async () => {
    const res = await http().get('/admin/ai-channel').set('x-rol', 'ADMIN').expect(200);
    expect(res.body).toEqual({ interruptores: { entradas: 'ABIERTAS' }, bots: [] });
    expect(canal.resumen).toHaveBeenCalledWith(ADMIN_ID);
    expect(bots.detail).not.toHaveBeenCalled();
  });

  it('PUT /admin/ai-channel/entries cambia el interruptor y lo audita con su motivo', async () => {
    const res = await http()
      .put('/admin/ai-channel/entries')
      .set('x-rol', 'ADMIN')
      .send({ abiertas: false, reason: 'mercado raro' })
      .expect(200);
    expect(res.body).toEqual({ entradas: 'CERRADAS' });
    expect(canal.fijarEntradas).toHaveBeenCalledWith(false);
    expect(audit.recordNow).toHaveBeenCalledWith({
      actor: 'ADMIN',
      actorId: ADMIN_ID,
      botId: null,
      action: 'admin.ai_channel.entries_close',
      severity: 'WARN',
      outcome: 'OK',
      message: 'Entradas del canal con IA cortadas: mercado raro',
      meta: { abiertas: false, reason: 'mercado raro' },
    });

    await http()
      .put('/admin/ai-channel/entries')
      .set('x-rol', 'ADMIN')
      .send({ abiertas: true, reason: 'todo en orden' })
      .expect(200);
    expect(audit.recordNow).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: 'admin.ai_channel.entries_open' }),
    );
  });

  it.each([
    ['sin motivo', { abiertas: false }],
    ['con un motivo corto', { abiertas: false, reason: 'no' }],
    ['sin decir qué', { reason: 'mercado raro' }],
    ['con un texto por booleano', { abiertas: 'false', reason: 'mercado raro' }],
    ['con un campo de más', { abiertas: false, reason: 'mercado raro', bot: BOT_ID }],
  ])('PUT /admin/ai-channel/entries %s es 400 y no toca nada', async (_, cuerpo) => {
    await http().put('/admin/ai-channel/entries').set('x-rol', 'ADMIN').send(cuerpo).expect(400);
    expect(canal.fijarEntradas).not.toHaveBeenCalled();
    expect(audit.recordNow).not.toHaveBeenCalled();
  });

  it('GET /admin/bots/:id/ai-channel es el estado del canal, no el detalle del bot', async () => {
    await http().get(`/admin/bots/${BOT_ID}/ai-channel`).set('x-rol', 'ADMIN').expect(200);
    expect(canal.estado).toHaveBeenCalledWith(ADMIN_ID, BOT_ID);
    expect(bots.detail).not.toHaveBeenCalled();
  });

  it('las decisiones, con su cursor y su tope', async () => {
    await http()
      .get(`/admin/bots/${BOT_ID}/ai-channel/decisiones`)
      .query({ antes: '2026-09-17T10:00:00.000Z', limite: '7' })
      .set('x-rol', 'ADMIN')
      .expect(200);
    expect(canal.decisiones).toHaveBeenCalledWith(ADMIN_ID, BOT_ID, '2026-09-17T10:00:00.000Z', 7);
    await http()
      .get(`/admin/bots/${BOT_ID}/ai-channel/decisiones`)
      .set('x-rol', 'ADMIN')
      .expect(200);
    expect(canal.decisiones).toHaveBeenLastCalledWith(ADMIN_ID, BOT_ID, undefined, undefined);
  });

  it.each([
    ['un límite de más', { limite: '51' }],
    ['un límite cero', { limite: '0' }],
    ['un cursor que no es fecha', { antes: 'ayer' }],
    ['un parámetro de más', { estado: 'DECIDIDA' }],
  ])('las decisiones con %s son 400', async (_, query) => {
    await http()
      .get(`/admin/bots/${BOT_ID}/ai-channel/decisiones`)
      .query(query)
      .set('x-rol', 'ADMIN')
      .expect(400);
    expect(canal.decisiones).not.toHaveBeenCalled();
  });

  it('el detalle de una decisión, también de las del juez', async () => {
    const intent = `reglas:${BOT_ID}:1760000300000`;
    await http()
      .get(`/admin/bots/${BOT_ID}/ai-channel/decisiones/${encodeURIComponent(intent)}`)
      .set('x-rol', 'ADMIN')
      .expect(200);
    expect(canal.detalle).toHaveBeenCalledWith(ADMIN_ID, BOT_ID, intent);
    await http()
      .get(`/admin/bots/${BOT_ID}/ai-channel/decisiones/${encodeURIComponent('a b')}`)
      .set('x-rol', 'ADMIN')
      .expect(400);
  });

  it('un id que no es un UUID es 400 en todas las rutas de un bot', async () => {
    for (const ruta of [
      '/admin/bots/nope/ai-channel',
      '/admin/bots/nope/ai-channel/decisiones',
      '/admin/bots/nope/ai-channel/decisiones/int-1',
    ]) {
      await http().get(ruta).set('x-rol', 'ADMIN').expect(400);
    }
    expect(canal.estado).not.toHaveBeenCalled();
    expect(canal.decisiones).not.toHaveBeenCalled();
    expect(canal.detalle).not.toHaveBeenCalled();
  });

  it('un usuario sin el rol recibe 403 en todas y no se toca nada', async () => {
    const rutas: [string, string][] = [
      ['get', '/admin/ai-channel'],
      ['put', '/admin/ai-channel/entries'],
      ['get', `/admin/bots/${BOT_ID}/ai-channel`],
      ['get', `/admin/bots/${BOT_ID}/ai-channel/decisiones`],
      ['get', `/admin/bots/${BOT_ID}/ai-channel/decisiones/int-1`],
    ];
    for (const [metodo, ruta] of rutas) {
      const peticion =
        metodo === 'put'
          ? http().put(ruta).send({ abiertas: false, reason: 'mercado raro' })
          : http().get(ruta);
      await peticion.set('x-rol', 'USER').expect(403);
    }
    for (const f of Object.values(canal)) expect(f).not.toHaveBeenCalled();
    expect(audit.recordNow).not.toHaveBeenCalled();
  });
});

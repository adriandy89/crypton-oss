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
import {
  AiDeskAgentesService,
  AiDeskAprobacionService,
  AiDeskInterruptoresService,
  AiDeskListadosService,
  AiDeskRondasService,
  AiDeskSeguimientoService,
} from '../ai-desk';
import { JwtAuthGuard } from '../auth/guards';
import { AdminAiDeskController } from './admin-ai-desk.controller';

/**
 * Las rutas de los agentes de IA en la consola, montadas de verdad (spec 074,
 * R-28). La sesión es un guard falso con el rol de la cabecera; el de roles es
 * el real. Un usuario sin el rol recibe 403 en todas y no se toca ningún
 * servicio; sin motivo, 400.
 */

const ADMIN_ID = 'la-administradora';
const AGENTE = '22222222-2222-4222-8222-222222222222';

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

describe('Rutas de los agentes de IA (spec 074)', () => {
  let app: INestApplication;
  const agentes = {
    resumen: jest.fn(),
    crear: jest.fn(),
    detalle: jest.fn(),
    editar: jest.fn(),
    pausar: jest.fn(),
    reanudar: jest.fn(),
    archivar: jest.fn(),
  };
  const interruptores = { fijarEntradas: jest.fn() };
  const aprobacion = { aprobar: jest.fn(), rechazar: jest.fn() };
  const rondas = { analizarAhora: jest.fn() };
  const seguimiento = {
    revisarAhora: jest.fn(),
    cerrarOperacion: jest.fn(),
    aprobarAccion: jest.fn(),
    rechazarAccion: jest.fn(),
  };
  const listados = {
    propuestas: jest.fn(),
    propuesta: jest.fn(),
    operaciones: jest.fn(),
    operacionDeBot: jest.fn(),
    resultados: jest.fn(),
  };
  const audit = { record: jest.fn(), recordNow: jest.fn() };

  beforeAll(async () => {
    const modulo = await Test.createTestingModule({
      controllers: [AdminAiDeskController],
      providers: [
        { provide: AiDeskAgentesService, useValue: agentes },
        { provide: AiDeskInterruptoresService, useValue: interruptores },
        { provide: AiDeskAprobacionService, useValue: aprobacion },
        { provide: AiDeskRondasService, useValue: rondas },
        { provide: AiDeskSeguimientoService, useValue: seguimiento },
        { provide: AiDeskListadosService, useValue: listados },
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
    for (const f of Object.values(agentes)) f.mockResolvedValue({ ok: true });
    interruptores.fijarEntradas.mockResolvedValue({ entradas: 'CERRADAS' });
    aprobacion.aprobar.mockResolvedValue({ estado: 'EJECUTANDO' });
    aprobacion.rechazar.mockResolvedValue({ estado: 'RECHAZADA' });
    rondas.analizarAhora.mockResolvedValue({ id: 'r-1', estado: 'COMPLETADA' });
    for (const f of Object.values(seguimiento)) f.mockResolvedValue({ estado: 'OK' });
    for (const f of Object.values(listados)) f.mockResolvedValue({ ok: true });
    audit.recordNow.mockResolvedValue(undefined);
  });

  const http = () => request(app.getHttpServer() as Server);

  const agenteNuevo = {
    nombre: 'Tendencias',
    exchangeAccountId: '33333333-3333-4333-8333-333333333333',
    pares: ['BTC'],
    intervalo: '1h',
    familias: ['TENDENCIA'],
    lados: ['LONG'],
    modo: 'IA',
    limites: { capital: '1000' },
    autonomia: { entrar: 'MANUAL', reducir: 'AUTO', cerrar: 'MANUAL' },
    reason: 'probar',
  };

  it('GET /admin/ai-desk llega con el administrador que llama', async () => {
    await http().get('/admin/ai-desk').set('x-rol', 'ADMIN').expect(200);
    expect(agentes.resumen).toHaveBeenCalledWith(ADMIN_ID);
  });

  it('PUT /admin/ai-desk/entries cambia el interruptor y lo audita con su motivo', async () => {
    await http()
      .put('/admin/ai-desk/entries')
      .set('x-rol', 'ADMIN')
      .send({ abiertas: false, reason: 'mercado raro' })
      .expect(200);
    expect(interruptores.fijarEntradas).toHaveBeenCalledWith(false, 'mercado raro');
    expect(audit.recordNow).toHaveBeenCalledWith({
      actor: 'ADMIN',
      actorId: ADMIN_ID,
      botId: null,
      action: 'admin.ai_desk.entries_close',
      severity: 'WARN',
      outcome: 'OK',
      message: 'Entradas de los agentes de IA cortadas: mercado raro',
      meta: { abiertas: false, reason: 'mercado raro' },
    });
  });

  it('crear, leer, editar, pausar, reanudar y archivar llegan a su manejador', async () => {
    await http().post('/admin/ai-desk/agentes').set('x-rol', 'ADMIN').send(agenteNuevo).expect(201);
    expect(agentes.crear).toHaveBeenCalledWith(
      ADMIN_ID,
      expect.objectContaining({ nombre: 'Tendencias' }),
    );

    await http().get(`/admin/ai-desk/agentes/${AGENTE}`).set('x-rol', 'ADMIN').expect(200);
    expect(agentes.detalle).toHaveBeenCalledWith(ADMIN_ID, AGENTE);

    const { exchangeAccountId: _c, ...edicion } = agenteNuevo;
    await http()
      .put(`/admin/ai-desk/agentes/${AGENTE}`)
      .set('x-rol', 'ADMIN')
      .send({ ...edicion, version: 2 })
      .expect(200);
    expect(agentes.editar).toHaveBeenCalledWith(
      ADMIN_ID,
      AGENTE,
      expect.objectContaining({ version: 2 }),
    );

    for (const accion of ['pausar', 'archivar'] as const) {
      await http()
        .post(`/admin/ai-desk/agentes/${AGENTE}/${accion}`)
        .set('x-rol', 'ADMIN')
        .send({ reason: 'porque sí' })
        .expect(201);
      expect(agentes[accion]).toHaveBeenCalledWith(ADMIN_ID, AGENTE, 'porque sí');
    }
    await http()
      .post(`/admin/ai-desk/agentes/${AGENTE}/reanudar`)
      .set('x-rol', 'ADMIN')
      .send({ reason: 'de vuelta', consentimiento: true })
      .expect(201);
    expect(agentes.reanudar).toHaveBeenCalledWith(ADMIN_ID, AGENTE, {
      reason: 'de vuelta',
      consentimiento: true,
    });
  });

  it('sin motivo, con campos de más o con valores fuera de su lista: 400', async () => {
    await http()
      .post(`/admin/ai-desk/agentes/${AGENTE}/pausar`)
      .set('x-rol', 'ADMIN')
      .send({})
      .expect(400);
    await http()
      .post('/admin/ai-desk/agentes')
      .set('x-rol', 'ADMIN')
      .send({ ...agenteNuevo, intervalo: '1m' })
      .expect(400);
    await http()
      .post('/admin/ai-desk/agentes')
      .set('x-rol', 'ADMIN')
      .send({ ...agenteNuevo, apalancamiento: 50 })
      .expect(400);
    await http()
      .post('/admin/ai-desk/agentes')
      .set('x-rol', 'ADMIN')
      .send({ ...agenteNuevo, autonomia: { entrar: 'SIEMPRE', reducir: 'AUTO', cerrar: 'MANUAL' } })
      .expect(400);
    expect(agentes.crear).not.toHaveBeenCalled();
    expect(agentes.pausar).not.toHaveBeenCalled();
  });

  it('un usuario sin el rol recibe 403 en todas y no se toca nada', async () => {
    const rutas: [string, string, object?][] = [
      ['get', '/admin/ai-desk'],
      ['put', '/admin/ai-desk/entries', { abiertas: true, reason: 'abrir' }],
      ['post', '/admin/ai-desk/agentes', agenteNuevo],
      ['get', `/admin/ai-desk/agentes/${AGENTE}`],
      ['post', `/admin/ai-desk/agentes/${AGENTE}/pausar`, { reason: 'porque sí' }],
      ['post', `/admin/ai-desk/agentes/${AGENTE}/reanudar`, { reason: 'porque sí' }],
      ['post', `/admin/ai-desk/agentes/${AGENTE}/archivar`, { reason: 'porque sí' }],
      ['post', `/admin/ai-desk/agentes/${AGENTE}/analizar`],
      ['get', '/admin/ai-desk/propuestas'],
      ['get', `/admin/ai-desk/propuestas/${AGENTE}`],
      ['get', '/admin/ai-desk/operaciones'],
      ['get', `/admin/ai-desk/bots/${AGENTE}/operacion`],
      ['get', '/admin/ai-desk/resultados'],
      ['post', `/admin/ai-desk/propuestas/${AGENTE}/aprobar`],
      ['post', `/admin/ai-desk/propuestas/${AGENTE}/rechazar`],
      ['post', `/admin/ai-desk/propuestas/${AGENTE}/revisar`],
      ['post', `/admin/ai-desk/propuestas/${AGENTE}/cerrar`],
      ['post', `/admin/ai-desk/acciones/${AGENTE}/aplicar`],
      ['post', `/admin/ai-desk/acciones/${AGENTE}/rechazar`],
    ];
    for (const [metodo, ruta, cuerpo] of rutas) {
      const r = (http() as unknown as Record<string, (u: string) => request.Test>)
        [metodo](ruta)
        .set('x-rol', 'USER');
      await (cuerpo ? r.send(cuerpo) : r).expect(403);
    }
    for (const f of Object.values(agentes)) expect(f).not.toHaveBeenCalled();
    expect(interruptores.fijarEntradas).not.toHaveBeenCalled();
    expect(aprobacion.aprobar).not.toHaveBeenCalled();
    expect(aprobacion.rechazar).not.toHaveBeenCalled();
    expect(rondas.analizarAhora).not.toHaveBeenCalled();
    for (const f of Object.values(seguimiento)) expect(f).not.toHaveBeenCalled();
    for (const f of Object.values(listados)) expect(f).not.toHaveBeenCalled();
  });

  it('revisar, cerrar, aplicar y rechazar una acción llegan con su origen', async () => {
    const ok = (ruta: string) => http().post(ruta).set('x-rol', 'ADMIN').expect(201);
    await ok(`/admin/ai-desk/propuestas/${AGENTE}/revisar`);
    expect(seguimiento.revisarAhora).toHaveBeenCalledWith(ADMIN_ID, AGENTE);
    await ok(`/admin/ai-desk/propuestas/${AGENTE}/cerrar`);
    expect(seguimiento.cerrarOperacion).toHaveBeenCalledWith(ADMIN_ID, AGENTE, 'APP');
    await ok(`/admin/ai-desk/acciones/${AGENTE}/aplicar`);
    expect(seguimiento.aprobarAccion).toHaveBeenCalledWith(ADMIN_ID, AGENTE, 'APP');
    await ok(`/admin/ai-desk/acciones/${AGENTE}/rechazar`);
    expect(seguimiento.rechazarAccion).toHaveBeenCalledWith(ADMIN_ID, AGENTE, 'APP');
  });

  it('analizar ahora llega con el administrador y el agente', async () => {
    await http()
      .post(`/admin/ai-desk/agentes/${AGENTE}/analizar`)
      .set('x-rol', 'ADMIN')
      .expect(201);
    expect(rondas.analizarAhora).toHaveBeenCalledWith(ADMIN_ID, AGENTE);
  });

  it('aprobar y rechazar desde la app llegan con su origen', async () => {
    await http()
      .post(`/admin/ai-desk/propuestas/${AGENTE}/aprobar`)
      .set('x-rol', 'ADMIN')
      .expect(201);
    expect(aprobacion.aprobar).toHaveBeenCalledWith(ADMIN_ID, AGENTE, 'APP');
    await http()
      .post(`/admin/ai-desk/propuestas/${AGENTE}/rechazar`)
      .set('x-rol', 'ADMIN')
      .expect(201);
    expect(aprobacion.rechazar).toHaveBeenCalledWith(ADMIN_ID, AGENTE, 'APP');
    // Un id que no es un UUID ni llega.
    await http().post('/admin/ai-desk/propuestas/x/aprobar').set('x-rol', 'ADMIN').expect(400);
  });
  it('las lecturas de la app llegan con el administrador que llama, y el filtro se valida', async () => {
    const ok = (ruta: string) => http().get(ruta).set('x-rol', 'ADMIN').expect(200);
    await ok('/admin/ai-desk/propuestas');
    expect(listados.propuestas).toHaveBeenCalledWith(ADMIN_ID, undefined);
    await ok(`/admin/ai-desk/propuestas?agentId=${AGENTE}`);
    expect(listados.propuestas).toHaveBeenLastCalledWith(ADMIN_ID, AGENTE);
    await ok(`/admin/ai-desk/propuestas/${AGENTE}`);
    expect(listados.propuesta).toHaveBeenCalledWith(ADMIN_ID, AGENTE);
    await ok(`/admin/ai-desk/operaciones?agentId=${AGENTE}`);
    expect(listados.operaciones).toHaveBeenCalledWith(ADMIN_ID, AGENTE);
    await ok(`/admin/ai-desk/bots/${AGENTE}/operacion`);
    expect(listados.operacionDeBot).toHaveBeenCalledWith(ADMIN_ID, AGENTE);
    await ok('/admin/ai-desk/resultados');
    expect(listados.resultados).toHaveBeenCalledWith(ADMIN_ID);
    // Un filtro que no es un UUID, o un parámetro que no existe, ni llega.
    listados.propuestas.mockClear();
    await http().get('/admin/ai-desk/propuestas?agentId=x').set('x-rol', 'ADMIN').expect(400);
    await http().get('/admin/ai-desk/propuestas?userId=otro').set('x-rol', 'ADMIN').expect(400);
    expect(listados.propuestas).not.toHaveBeenCalled();
  });
});

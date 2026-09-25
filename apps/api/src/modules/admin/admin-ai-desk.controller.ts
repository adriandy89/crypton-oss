import { Body, Controller, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ActorKind, AuditOutcome, EventSeverity } from '@crypton/shared';
import { AuditService, IdParamDto } from 'src/libs';
import {
  AiDeskAgentesService,
  AiDeskAprobacionService,
  AiDeskInterruptoresService,
  AiDeskListadosService,
  AiDeskRondasService,
  AiDeskSeguimientoService,
  CrearAgenteDto,
  EditarAgenteDto,
  EntradasAgentesDto,
  FiltroAgenteDto,
  MotivoAgenteDto,
  OrigenDecision,
  ReanudarAgenteDto,
} from '../ai-desk';
import { GetUserInfo, JwtAuthGuard, Roles, RolesGuard, type SessionUser } from '../auth';

/**
 * Los agentes de IA en la consola (spec 074). SOLO ADMIN, y sobre agentes
 * PROPIOS: el servicio responde 404 a uno ajeno, como si no existiera.
 *
 * Guardas y rol a nivel de CLASE, como el resto de la consola, y en
 * `admin-guards.spec.ts`. Lo que da poder —crear, editar, reanudar— vuelve a
 * leer el rol de la base en el servicio: la sesión puede ser de antes de que
 * se lo quitaran (R-28).
 */
@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin/ai-desk')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN')
export class AdminAiDeskController {
  constructor(
    private readonly agentes: AiDeskAgentesService,
    private readonly interruptores: AiDeskInterruptoresService,
    private readonly aprobacion: AiDeskAprobacionService,
    private readonly rondas: AiDeskRondasService,
    private readonly seguimiento: AiDeskSeguimientoService,
    private readonly listados: AiDeskListadosService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Agentes de IA: interruptores y agentes propios (solo ADMIN)' })
  resumen(@GetUserInfo() admin: SessionUser) {
    return this.agentes.resumen(admin.id);
  }

  @Put('entries')
  @ApiOperation({
    summary: 'Abre o corta las entradas de todos los agentes (solo ADMIN)',
    description:
      'Las operaciones abiertas siguen con su stop, sus objetivos y su seguimiento; solo dejan ' +
      'de proponerse y abrirse operaciones nuevas. Sin Redis responde 503.',
  })
  async entradas(@GetUserInfo() admin: SessionUser, @Body() dto: EntradasAgentesDto) {
    const interruptores = await this.interruptores.fijarEntradas(dto.abiertas, dto.reason);
    // `recordNow` y no `@Audit`: el motivo va en `meta`, y la lista blanca del
    // decorador no lo deja pasar. WARN, como cualquier cosa que corta o abre
    // la operativa con dinero dentro.
    await this.audit.recordNow({
      actor: ActorKind.ADMIN,
      actorId: admin.id,
      botId: null,
      action: dto.abiertas ? 'admin.ai_desk.entries_open' : 'admin.ai_desk.entries_close',
      severity: EventSeverity.WARN,
      outcome: AuditOutcome.OK,
      message: `Entradas de los agentes de IA ${dto.abiertas ? 'abiertas' : 'cortadas'}: ${dto.reason}`,
      meta: { abiertas: dto.abiertas, reason: dto.reason },
    });
    return interruptores;
  }

  @Post('agentes')
  @ApiOperation({ summary: 'Crea un agente sobre una cuenta propia (solo ADMIN)' })
  crear(@GetUserInfo() admin: SessionUser, @Body() dto: CrearAgenteDto) {
    return this.agentes.crear(admin.id, dto);
  }

  @Get('agentes/:id')
  @ApiOperation({ summary: 'Un agente propio con su día (solo ADMIN)' })
  detalle(@GetUserInfo() admin: SessionUser, @Param() { id }: IdParamDto) {
    return this.agentes.detalle(admin.id, id);
  }

  @Put('agentes/:id')
  @ApiOperation({
    summary: 'Edita un agente propio (solo ADMIN)',
    description:
      'Con la versión que se editó: si el agente cambió entretanto responde 409. Descarta sus ' +
      'propuestas pendientes, que se calcularon con la definición de antes.',
  })
  editar(
    @GetUserInfo() admin: SessionUser,
    @Param() { id }: IdParamDto,
    @Body() dto: EditarAgenteDto,
  ) {
    return this.agentes.editar(admin.id, id, dto);
  }

  @Post('agentes/:id/pausar')
  @ApiOperation({ summary: 'Pausa las entradas de un agente propio (solo ADMIN)' })
  pausar(
    @GetUserInfo() admin: SessionUser,
    @Param() { id }: IdParamDto,
    @Body() dto: MotivoAgenteDto,
  ) {
    return this.agentes.pausar(admin.id, id, dto.reason);
  }

  @Post('agentes/:id/reanudar')
  @ApiOperation({ summary: 'Reanuda un agente propio en pausa (solo ADMIN)' })
  reanudar(
    @GetUserInfo() admin: SessionUser,
    @Param() { id }: IdParamDto,
    @Body() dto: ReanudarAgenteDto,
  ) {
    return this.agentes.reanudar(admin.id, id, dto);
  }

  @Post('agentes/:id/archivar')
  @ApiOperation({ summary: 'Archiva un agente propio sin operaciones vivas (solo ADMIN)' })
  archivar(
    @GetUserInfo() admin: SessionUser,
    @Param() { id }: IdParamDto,
    @Body() dto: MotivoAgenteDto,
  ) {
    return this.agentes.archivar(admin.id, id, dto.reason);
  }

  @Post('agentes/:id/analizar')
  @ApiOperation({
    summary: 'Una ronda de entrada ahora, fuera del reloj (solo ADMIN)',
    description:
      'Con las mismas barreras que la del reloj. Una por minuto y agente: cada una puede costar ' +
      'una llamada al modelo. Responde la ronda, también si una barrera la paró.',
  })
  analizar(@GetUserInfo() admin: SessionUser, @Param() { id }: IdParamDto) {
    return this.rondas.analizarAhora(admin.id, id);
  }

  @Get('propuestas')
  @ApiOperation({
    summary: 'Las propuestas de sus agentes, o de uno: las que esperan y las últimas (solo ADMIN)',
  })
  propuestas(@GetUserInfo() admin: SessionUser, @Query() { agentId }: FiltroAgenteDto) {
    return this.listados.propuestas(admin.id, agentId);
  }

  @Get('propuestas/:id')
  @ApiOperation({ summary: 'Una propuesta propia, con lo que vio y su seguimiento (solo ADMIN)' })
  propuesta(@GetUserInfo() admin: SessionUser, @Param() { id }: IdParamDto) {
    return this.listados.propuesta(admin.id, id);
  }

  @Get('operaciones')
  @ApiOperation({
    summary: 'Las operaciones de sus agentes, o de uno: las vivas y las últimas (solo ADMIN)',
  })
  operaciones(@GetUserInfo() admin: SessionUser, @Query() { agentId }: FiltroAgenteDto) {
    return this.listados.operaciones(admin.id, agentId);
  }

  @Get('bots/:id/operacion')
  @ApiOperation({
    summary: 'La operación de un bot de un agente propio: el panel del bot (solo ADMIN)',
  })
  operacionDeBot(@GetUserInfo() admin: SessionUser, @Param() { id }: IdParamDto) {
    return this.listados.operacionDeBot(admin.id, id);
  }

  @Get('resultados')
  @ApiOperation({
    summary: 'Las tarjetas de resultados de sus agentes (solo ADMIN)',
    description:
      'Una por agente, y las de todos juntos: lo real y lo simulado nunca se suman. Se enseña; ' +
      'nada de lo que decide la lee.',
  })
  resultados(@GetUserInfo() admin: SessionUser) {
    return this.listados.resultados(admin.id);
  }

  @Post('propuestas/:id/aprobar')
  @ApiOperation({
    summary: 'Aprueba una propuesta propia y abre su operación (solo ADMIN)',
    description:
      'La misma rutina que el botón de Telegram y que el modo automático: se recalcula con el ' +
      'precio de ahora y, si ya no vale, caduca con su motivo. Responde en qué acabó.',
  })
  aprobar(@GetUserInfo() admin: SessionUser, @Param() { id }: IdParamDto) {
    return this.aprobacion.aprobar(admin.id, id, OrigenDecision.APP);
  }

  @Post('propuestas/:id/rechazar')
  @ApiOperation({ summary: 'Descarta una propuesta propia (solo ADMIN)' })
  rechazar(@GetUserInfo() admin: SessionUser, @Param() { id }: IdParamDto) {
    return this.aprobacion.rechazar(admin.id, id, OrigenDecision.APP);
  }

  @Post('propuestas/:id/revisar')
  @ApiOperation({
    summary: 'Una ronda de seguimiento ahora sobre una operación propia (solo ADMIN)',
    description: 'Una por minuto y operación. Responde la ronda.',
  })
  revisar(@GetUserInfo() admin: SessionUser, @Param() { id }: IdParamDto) {
    return this.seguimiento.revisarAhora(admin.id, id);
  }

  @Post('propuestas/:id/cerrar')
  @ApiOperation({
    summary: 'Cierra a mercado una operación propia (solo ADMIN)',
    description:
      'Con el comando de siempre (STOP_AND_CLOSE): la salida queda como del dueño. Lo que ' +
      'esperaba respuesta del seguimiento deja de esperarla.',
  })
  cerrar(@GetUserInfo() admin: SessionUser, @Param() { id }: IdParamDto) {
    return this.seguimiento.cerrarOperacion(admin.id, id, OrigenDecision.APP);
  }

  @Post('acciones/:id/aplicar')
  @ApiOperation({
    summary: 'Aplica una acción de seguimiento propuesta (solo ADMIN)',
    description:
      'Solo ciñe el stop o reduce la posición, y solo si sigue reduciendo el riesgo contra la ' +
      'configuración de ahora. Responde en qué acabó.',
  })
  aplicarAccion(@GetUserInfo() admin: SessionUser, @Param() { id }: IdParamDto) {
    return this.seguimiento.aprobarAccion(admin.id, id, OrigenDecision.APP);
  }

  @Post('acciones/:id/rechazar')
  @ApiOperation({ summary: 'Descarta una acción de seguimiento propuesta (solo ADMIN)' })
  rechazarAccion(@GetUserInfo() admin: SessionUser, @Param() { id }: IdParamDto) {
    return this.seguimiento.rechazarAccion(admin.id, id, OrigenDecision.APP);
  }
}

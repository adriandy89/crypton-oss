import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ActorKind, AuditOutcome } from '@crypton/shared';
import { AuditService, IdParamDto } from 'src/libs';
import { GetUserInfo, JwtAuthGuard, Roles, RolesGuard, type SessionUser } from '../auth';
import { HistoryQueryDto } from '../bots/dtos';
import { AdminBotsService } from './admin-bots.service';
import { AdminBotCommandDto, AdminBotsQueryDto } from './dtos';

/**
 * Todos los bots de la plataforma. SOLO ADMIN.
 *
 * Mirar y contener. Lo que NO esta aqui, y no por olvido: `capital` y `preview`
 * abren adaptador y descifran la clave de firma del usuario (invariante 8);
 * `create`, `updateConfig`, `rename` y `remove` no son contener, son operar por
 * otro. La superficie mas segura es la que no existe.
 *
 * Sobre el 403 y el 404: la casa devuelve 404 en vez de 403 para no confirmar la
 * existencia de un recurso ajeno, y eso sigue vigente. Aqui el `RolesGuard`
 * deniega ANTES de mirar el `:id`, asi que el 403 que recibe un usuario normal
 * solo dice «esta ruta es de administracion» —que ya lo dice su nombre— y no
 * revela ninguna fila. Un ADMIN con un id que no existe si recibe 404.
 */
@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin/bots')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN')
export class AdminBotsController {
  constructor(
    private readonly bots: AdminBotsService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Todos los bots, paginados (solo ADMIN)' })
  async list(@GetUserInfo() admin: SessionUser, @Query() query: AdminBotsQueryDto) {
    const page = await this.bots.list(query);

    this.audit.record({
      actor: ActorKind.ADMIN,
      actorId: admin.id,
      action: 'admin.bots.list',
      outcome: AuditOutcome.OK,
      meta: {
        results: page.meta.itemCount,
        ...(query.userId ? { userId: query.userId } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(query.venue ? { venue: query.venue } : {}),
        ...(query.withError ? { withError: true } : {}),
      },
    });
    return page;
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalle de un bot ajeno (solo ADMIN)' })
  async detail(@GetUserInfo() admin: SessionUser, @Param() { id }: IdParamDto) {
    const bot = await this.bots.detail(id);

    this.audit.record({
      actor: ActorKind.ADMIN,
      actorId: admin.id,
      botId: id,
      action: 'admin.bot.read',
      outcome: AuditOutcome.OK,
      meta: { ownerId: bot.owner?.id ?? null },
    });
    return bot;
  }

  // Los historicos NO se auditan uno a uno: un administrador abriendo cuatro
  // pestañas del mismo bot generaria cuatro filas que no dicen nada que no diga
  // ya el `admin.bot.read` con el que entro.

  @Get(':id/orders')
  orders(@Param() { id }: IdParamDto, @Query() q: HistoryQueryDto) {
    return this.bots.orders(id, q.limit, q.offset);
  }

  @Get(':id/fills')
  fills(@Param() { id }: IdParamDto, @Query() q: HistoryQueryDto) {
    return this.bots.fills(id, q.limit, q.offset);
  }

  @Get(':id/cycles')
  cycles(@Param() { id }: IdParamDto, @Query() q: HistoryQueryDto) {
    return this.bots.cycles(id, q.limit, q.offset);
  }

  @Get(':id/events')
  events(@Param() { id }: IdParamDto, @Query() q: HistoryQueryDto) {
    return this.bots.events(id, q.limit, q.offset);
  }

  @Get(':id/revisions')
  revisions(@Param() { id }: IdParamDto, @Query() q: HistoryQueryDto) {
    return this.bots.revisions(id, q.limit, q.offset);
  }

  @Get(':id/levels')
  levels(@Param() { id }: IdParamDto) {
    return this.bots.levels(id);
  }

  /**
   * Contener un bot ajeno. Solo PAUSE y STOP_KEEP_POSITION: ver `ADMIN_COMMANDS`.
   *
   * SIN `@Audit`, a proposito: la fila la escribe el servicio con `recordNow`,
   * que es el unico que conoce al dueño ya resuelto y el unico modo de que la
   * columna `bot_id` no quede a null —el interceptor solo la rellena cuando la
   * accion empieza por `bot.`, y esta empieza por `admin.`—. Que nadie añada
   * aqui el decorador «que falta»: serian dos filas por comando.
   *
   * SIN tope de caudal propio, y la ausencia es una decision: llego a haber uno
   * de diez por minuto y se quito. Un administrador conteniendo una averia
   * generalizada pausa quince bots seguidos, y ese es justo el momento en que
   * esta pantalla tiene que responder. El limitador global —cien peticiones por
   * treinta segundos— ya acota una consola en bucle, que era lo unico que el
   * tope de aqui añadia; contra un administrador malicioso no protegia nada,
   * porque tiene el permiso.
   */
  @Post(':id/commands')
  @HttpCode(200)
  @ApiOperation({ summary: 'Pausa o para un bot ajeno (solo ADMIN)' })
  command(
    @GetUserInfo() admin: SessionUser,
    @Param() { id }: IdParamDto,
    @Body() dto: AdminBotCommandDto,
  ) {
    return this.bots.command(admin, id, dto);
  }
}

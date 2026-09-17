import { Body, Controller, Get, Param, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ActorKind, AuditOutcome, EventSeverity } from '@crypton/shared';
import { AuditService, IdParamDto } from 'src/libs';
import {
  AiChannelEstadoService,
  DecisionCanalParamDto,
  DecisionesCanalQueryDto,
  EntradasCanalDto,
} from '../ai-channel';
import { GetUserInfo, JwtAuthGuard, Roles, RolesGuard, type SessionUser } from '../auth';

/**
 * El canal con IA en la consola (spec 059). SOLO ADMIN, y sobre bots PROPIOS.
 *
 * Lo que se lee: el estado del lazo de cada bot, su día y sus decisiones. Lo
 * único que se escribe es el interruptor global de entradas, que corta las
 * entradas de todos los bots del canal a la vez sin tocar sus posiciones, y se
 * audita. Esto no amplía lo que un administrador puede hacer sobre bots
 * ajenos: el servicio responde 403 a cualquier bot que no sea del que pregunta.
 *
 * Guardas y rol a nivel de CLASE, como el resto de la consola. Prefijo
 * `admin`, como el Modo IA: `admin/ai-channel` no puede colgar de
 * `admin/bots`, donde `GET admin/bots/:id` se lo quedaría.
 */
@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN')
export class AdminAiChannelController {
  constructor(
    private readonly canal: AiChannelEstadoService,
    private readonly audit: AuditService,
  ) {}

  @Get('ai-channel')
  @ApiOperation({ summary: 'Canal con IA: interruptores y bots propios (solo ADMIN)' })
  resumen(@GetUserInfo() admin: SessionUser) {
    return this.canal.resumen(admin.id);
  }

  @Put('ai-channel/entries')
  @ApiOperation({
    summary: 'Abre o corta las entradas de todos los bots del canal con IA (solo ADMIN)',
    description:
      'Las posiciones abiertas siguen con su stop y sus objetivos; solo dejan de abrirse ' +
      'operaciones nuevas. Sin Redis responde 503.',
  })
  async entradas(@GetUserInfo() admin: SessionUser, @Body() dto: EntradasCanalDto) {
    const interruptores = await this.canal.fijarEntradas(dto.abiertas);
    // `recordNow` y no `@Audit`: el motivo va en `meta`, y la lista blanca del
    // decorador no lo deja pasar. WARN, como cualquier cosa que corta o abre
    // la operativa de bots con dinero dentro.
    await this.audit.recordNow({
      actor: ActorKind.ADMIN,
      actorId: admin.id,
      botId: null,
      action: dto.abiertas ? 'admin.ai_channel.entries_open' : 'admin.ai_channel.entries_close',
      severity: EventSeverity.WARN,
      outcome: AuditOutcome.OK,
      message: `Entradas del canal con IA ${dto.abiertas ? 'abiertas' : 'cortadas'}: ${dto.reason}`,
      meta: { abiertas: dto.abiertas, reason: dto.reason },
    });
    return interruptores;
  }

  @Get('bots/:id/ai-channel')
  @ApiOperation({ summary: 'Canal con IA de un bot propio: lazo, día y decisiones (solo ADMIN)' })
  estado(@GetUserInfo() admin: SessionUser, @Param() { id }: IdParamDto) {
    return this.canal.estado(admin.id, id);
  }

  @Get('bots/:id/ai-channel/decisiones')
  @ApiOperation({ summary: 'Decisiones de la IA de un bot propio, paginadas (solo ADMIN)' })
  decisiones(
    @GetUserInfo() admin: SessionUser,
    @Param() { id }: IdParamDto,
    @Query() query: DecisionesCanalQueryDto,
  ) {
    return this.canal.decisiones(admin.id, id, query.antes, query.limite);
  }

  @Get('bots/:id/ai-channel/decisiones/:intentId')
  @ApiOperation({ summary: 'Una decisión con la herramienta que vio el modelo (solo ADMIN)' })
  detalle(@GetUserInfo() admin: SessionUser, @Param() { id, intentId }: DecisionCanalParamDto) {
    return this.canal.detalle(admin.id, id, intentId);
  }
}

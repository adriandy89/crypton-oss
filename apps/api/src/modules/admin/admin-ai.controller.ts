import { Body, Controller, Get, Param, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AiMode } from '@crypton/db';
import { ActorKind, AuditOutcome, EventSeverity } from '@crypton/shared';
import { AuditService, IdParamDto } from 'src/libs';
import { GetUserInfo, JwtAuthGuard, Roles, RolesGuard, type SessionUser } from '../auth';
import { SupervisorPolicyService } from '../supervisor/supervisor.policy.service';
import { SetAiModeDto } from '../supervisor/dtos';

/**
 * El Modo IA de un bot. SOLO ADMIN, y solo sobre bots PROPIOS.
 *
 * Vive en `admin/` y no en `bots/` porque encender un agente que reescribe la
 * configuracion de un bot con dinero dentro es una accion de administracion, y
 * se audita como tal. Pero OJO con lo que no es: esto **no amplia lo que un
 * administrador puede hacer sobre bots ajenos**. `SupervisorPolicyService`
 * rechaza cualquier bot que no sea suyo, de modo que la frase del spec 033
 * —mirar y contener, nunca disponer del dinero de nadie— sigue siendo cierta
 * palabra por palabra.
 *
 * Los guards y el `@Roles` van a nivel de CLASE a proposito, como en el resto de
 * la consola: `RolesGuard` deja pasar cuando NO hay metadata, asi que un metodo
 * nuevo sin decorar naceria abierto a cualquier usuario autenticado.
 */
@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin/bots')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN')
export class AdminAiController {
  constructor(
    private readonly policy: SupervisorPolicyService,
    private readonly audit: AuditService,
  ) {}

  @Get(':id/ai')
  @ApiOperation({ summary: 'Modo IA de un bot propio (solo ADMIN)' })
  get(@GetUserInfo() admin: SessionUser, @Param() { id }: IdParamDto) {
    return this.policy.get(admin.id, id);
  }

  @Put(':id/ai')
  @ApiOperation({
    summary: 'Enciende, apaga o reconfigura el Modo IA de un bot propio (solo ADMIN)',
    description:
      'Solo sobre bots del propio administrador. Sobre un bot ajeno responde 403: ' +
      'la consola de administración mira y contiene, no opera por nadie (spec 033).',
  })
  async set(
    @GetUserInfo() admin: SessionUser,
    @Param() { id }: IdParamDto,
    @Body() dto: SetAiModeDto,
  ) {
    const fila = await this.policy.set(admin.id, id, dto);

    // `recordNow` y no `@Audit`, como en `admin-bots.service.ts`: el motivo
    // entra en `meta` y la lista blanca del decorador no lo deja pasar. Severidad
    // WARN, la misma que la contencion: encender un agente autonomo sobre un bot
    // con dinero dentro es de las cosas que uno quiere encontrar en la bitacora.
    await this.audit.recordNow({
      actor: ActorKind.ADMIN,
      actorId: admin.id,
      botId: id,
      action: dto.mode === AiMode.OFF ? 'admin.bot.ai_disable' : 'admin.bot.ai_enable',
      severity: EventSeverity.WARN,
      outcome: AuditOutcome.OK,
      message: `Modo IA ${dto.mode}: ${dto.reason}`,
      meta: { mode: dto.mode, trigger: dto.trigger, reason: dto.reason },
    });

    return fila;
  }
}

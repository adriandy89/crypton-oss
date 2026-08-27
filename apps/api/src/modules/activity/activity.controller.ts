import {
  Controller,
  Get,
  NotFoundException,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ActorKind, AuditOutcome } from '@crypton/shared';
import { AuditService } from 'src/libs';
import {
  GetUserInfo,
  JwtAuthGuard,
  Roles,
  RolesGuard,
  type SessionUser,
} from '../auth';
import { ActivityService } from './activity.service';
import { ActivityQueryDto } from './dtos';

/**
 * Lectura de la bitacora. SOLO ADMIN.
 *
 * Esta tabla concentra lo mas sensible que se puede saber de la plataforma:
 * quien conecto una credencial, quien borro su cuenta, que peticiones se
 * rechazaron y desde que IP. Un usuario normal no tiene nada que hacer aqui.
 */
@ApiTags('activity')
@ApiBearerAuth()
@Controller('admin/activity')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN')
export class ActivityController {
  constructor(
    private readonly activity: ActivityService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Bitacora de actividad (solo ADMIN)',
    description:
      'Registro transversal de operaciones de usuarios, administradores y del ' +
      'motor, mas todos los fallos HTTP. Complementa `GET /bots/:id/events`, ' +
      'que sigue siendo la bitacora de cada bot.',
  })
  async list(
    @GetUserInfo() user: SessionUser,
    @Query() query: ActivityQueryDto,
  ) {
    const page = await this.activity.list(query);

    // La lectura se audita a si misma, y hay que hacerlo a mano: es un GET, asi
    // que el interceptor no lo mira. Quien consulta el registro de todos los
    // demas tiene que dejar el suyo.
    this.audit.record({
      actor: ActorKind.ADMIN,
      actorId: user.id,
      action: 'admin.activity.read',
      outcome: AuditOutcome.OK,
      meta: {
        results: page.meta.itemCount,
        ...(query.actorId ? { actorId: query.actorId } : {}),
        ...(query.action ? { filterAction: query.action } : {}),
        ...(query.onlyFailures ? { onlyFailures: query.onlyFailures } : {}),
      },
    });
    return page;
  }

  @Get('summary')
  @ApiOperation({
    summary: 'Resumen por accion de las ultimas horas (solo ADMIN)',
    description:
      'Cuantas veces ocurrio cada accion y como acabo. Es la vista de «esta todo bien».',
  })
  summary(@Query('hours') hours?: string) {
    const window = Math.min(Math.max(Number(hours) || 24, 1), 720);
    return this.activity.summary(window);
  }
}

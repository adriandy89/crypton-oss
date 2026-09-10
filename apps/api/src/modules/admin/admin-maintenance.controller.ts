import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ActorKind, AuditOutcome, EventSeverity } from '@crypton/shared';
import { AuditService } from 'src/libs';
import { GetUserInfo, JwtAuthGuard, Roles, RolesGuard, type SessionUser } from '../auth';
import { AdminMaintenanceService } from './admin-maintenance.service';
import { PurgeConfirmDto, PurgeDto } from './dtos';

/**
 * Mantenimiento de históricos. SOLO ADMIN.
 *
 * Tres pasos a propósito —ver, contar, borrar— y no un botón: esto no tiene
 * deshacer, así que quien va a pulsarlo tiene que haber visto antes el número
 * exacto de filas que van a desaparecer.
 */
@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin/maintenance')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN')
export class AdminMaintenanceController {
  constructor(
    private readonly mantenimiento: AdminMaintenanceService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Qué hay guardado y con qué reglas (solo ADMIN)' })
  estado() {
    // No se audita: es un recuento agregado, sin un solo dato de nadie.
    return this.mantenimiento.estado();
  }

  @Post('preview')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Cuántas filas caerían con esa antigüedad (solo ADMIN)',
    description: 'No borra nada. Usa exactamente el mismo filtro que la purga.',
  })
  async preview(@Body() dto: PurgeDto) {
    return {
      scope: dto.scope,
      days: dto.days,
      filas: await this.mantenimiento.contar(dto.scope, dto.days),
    };
  }

  @Post('purge')
  @HttpCode(200)
  @ApiOperation({ summary: 'Purga los históricos de ese ámbito (solo ADMIN)' })
  async purge(@GetUserInfo() admin: SessionUser, @Body() dto: PurgeConfirmDto) {
    const res = await this.mantenimiento.purgar(dto.scope, dto.days);

    // A mano y esperando (`recordNow`): un borrado sin vuelta atrás no puede
    // quedarse en un buffer que un reinicio se lleve por delante. Y va DESPUÉS
    // de purgar, con el recuento real dentro: una fila que dijera «se pidió»
    // sin decir cuánto cayó no serviría para reconstruir nada.
    //
    // Sin `@Audit` por lo mismo que el comando de bots: ver ese controlador.
    await this.audit.recordNow({
      actor: ActorKind.ADMIN,
      actorId: admin.id,
      action: 'admin.maintenance.purge',
      severity: EventSeverity.WARN,
      outcome: AuditOutcome.OK,
      message: `Purga de ${dto.scope} anterior a ${dto.days} días: ${res.borradas} fila(s). ${dto.reason}`,
      meta: {
        scope: dto.scope,
        days: dto.days,
        borradas: res.borradas,
        completo: res.completo,
        reason: dto.reason,
      },
    });
    return res;
  }
}

import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ActorKind, AuditOutcome } from '@crypton/shared';
import { Audit, AuditService, IdParamDto } from 'src/libs';
import { GetUserInfo, JwtAuthGuard, Roles, RolesGuard, type SessionUser } from '../auth';
import { AdminUsersService } from './admin-users.service';
import { AdminUsersQueryDto, DisableUserDto } from './dtos';

/**
 * Las cuentas de la plataforma. SOLO ADMIN.
 *
 * Los guards y el `@Roles` van a nivel de CLASE a proposito: `RolesGuard`
 * restringe pero no protege por defecto —sin metadata deja pasar, y su propio
 * spec lo congela—, asi que un metodo nuevo sin cobertura de clase seria
 * publico. Aqui eso significaria la lista de correos de todos los usuarios.
 *
 * Y las acciones son VERBOS EN LA RUTA, no un `PATCH /admin/users/:id`. Es la
 * decision de diseño mas importante de este controlador: un DTO de
 * actualizacion parcial queda a UN campo de ser una escalada de privilegios. Con
 * acciones nombradas no existe ningun cuerpo capaz de llevar `role`, y «el rol
 * no se cambia desde la UI» pasa de ser una convencion a ser una propiedad de la
 * forma del codigo, que un test congela.
 */
@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin/users')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN')
export class AdminUsersController {
  constructor(
    private readonly users: AdminUsersService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Todas las cuentas, paginadas (solo ADMIN)' })
  async list(@GetUserInfo() admin: SessionUser, @Query() query: AdminUsersQueryDto) {
    const page = await this.users.list(query);

    // A mano porque es un GET y el interceptor no los mira. Mismo motivo que en
    // `activity.controller.ts`: quien consulta las cuentas de todos los demas
    // tiene que dejar constancia de la suya.
    this.audit.record({
      actor: ActorKind.ADMIN,
      actorId: admin.id,
      action: 'admin.users.list',
      outcome: AuditOutcome.OK,
      meta: {
        results: page.meta.itemCount,
        ...(query.q ? { q: query.q } : {}),
        ...(query.role ? { role: query.role } : {}),
        ...(query.disabled !== undefined ? { disabled: query.disabled } : {}),
      },
    });
    return page;
  }

  @Get(':id')
  @ApiOperation({ summary: 'Ficha completa de una cuenta (solo ADMIN)' })
  async detail(@GetUserInfo() admin: SessionUser, @Param() { id }: IdParamDto) {
    const user = await this.users.detail(id);

    // Leer la ficha completa de alguien —sus limites, sus conexiones, sus bots—
    // es un evento de privacidad, no una consulta cualquiera.
    this.audit.record({
      actor: ActorKind.ADMIN,
      actorId: admin.id,
      action: 'admin.user.read',
      outcome: AuditOutcome.OK,
      meta: { targetUserId: id },
    });
    return user;
  }

  @Audit('admin.user.disable', { fields: ['reason'], params: ['id'], critical: true })
  @Post(':id/disable')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Deshabilita una cuenta y le corta la sesion (solo ADMIN)',
    description:
      'Impide entrar, renovar y reautenticarse, y cierra sus sesiones al instante. NO para sus ' +
      'bots: el motor no consulta este campo y sigue operando con la credencial del usuario.',
  })
  disable(
    @GetUserInfo() admin: SessionUser,
    @Param() { id }: IdParamDto,
    @Body() _dto: DisableUserDto,
  ) {
    // El motivo no viaja al servicio: no hay columna donde guardarlo y no se va
    // a añadir una para esto. Lo escribe `@Audit` en `activity_log.meta`, que es
    // donde se busca cuando hay que reconstruir por que se cerro una cuenta.
    void _dto;
    return this.users.disable(admin.id, id);
  }

  @Audit('admin.user.enable', { params: ['id'], critical: true })
  @Post(':id/enable')
  @HttpCode(200)
  @ApiOperation({ summary: 'Rehabilita una cuenta (solo ADMIN)' })
  enable(@Param() { id }: IdParamDto) {
    return this.users.enable(id);
  }

  @Audit('admin.user.sessions_revoke', { params: ['id'], critical: true })
  @Post(':id/sessions/revoke')
  @HttpCode(200)
  @ApiOperation({ summary: 'Cierra todas las sesiones de una cuenta (solo ADMIN)' })
  revokeSessions(@Param() { id }: IdParamDto) {
    return this.users.revokeSessions(id);
  }
}

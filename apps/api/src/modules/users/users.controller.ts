import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Patch,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Audit } from 'src/libs';
import {
  AuthService,
  GetUserInfo,
  JwtAuthGuard,
  type SessionUser,
} from '../auth';
import { DeleteAccountDto, UpdateProfileDto } from './dtos';
import { UsersService } from './users.service';

@ApiTags('users')
@ApiBearerAuth()
@Controller('users')
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly auth: AuthService,
  ) {}

  @Get('me')
  @ApiOperation({
    summary: 'Perfil completo del usuario',
    description:
      'Lee de la base de datos, a diferencia de /auth/me, que devuelve los claims del token sin consultar nada.',
  })
  me(@GetUserInfo() user: SessionUser) {
    return this.users.me(user.id);
  }

  @Audit('user.update_profile', {
    fields: ['name', 'country', 'timezone', 'language'],
  })
  @Patch('me')
  @ApiOperation({ summary: 'Actualiza el perfil' })
  update(@GetUserInfo() user: SessionUser, @Body() dto: UpdateProfileDto) {
    return this.users.update(user.id, dto);
  }

  // Borrar la cuenta es EL evento que hay que conservar: `critical` lo escribe
  // y lo espera, y la tabla no tiene clave foránea para que sobreviva al
  // borrado de la fila de `users`.
  @Audit('user.delete_account', { critical: true })
  @Delete('me')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Borra la cuenta y todo su contenido',
    description:
      'Irreversible. Exige haberse reautenticado con Google y escribir ELIMINAR. Se rechaza con 409 mientras queden bots vivos: sus órdenes están en el venue, y borrar la cuenta se llevaría también la credencial — no quedaría forma de cancelarlas. Usa antes el kill-switch.',
  })
  async remove(
    @GetUserInfo() user: SessionUser,
    @Body() _dto: DeleteAccountDto,
  ) {
    // Reautenticación antes de una acción irreversible: un token de acceso
    // robado dura 15 minutos y no se revalida contra la base de datos, así que
    // por sí solo no puede bastar para vaciar una cuenta.
    await this.auth.assertStepUp(user.id);
    return this.users.remove(user.id);
  }
}

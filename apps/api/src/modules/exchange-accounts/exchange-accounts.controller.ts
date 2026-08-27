import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AuthService,
  GetUserInfo,
  JwtAuthGuard,
  type SessionUser,
} from '../auth';
import { Audit, IdParamDto } from 'src/libs';
import { CreateExchangeAccountDto, UpdateExchangeAccountDto } from './dtos';
import { ExchangeAccountsService } from './exchange-accounts.service';

@ApiTags('exchange-accounts')
@ApiBearerAuth()
@Controller('exchange-accounts')
@UseGuards(JwtAuthGuard)
export class ExchangeAccountsController {
  constructor(
    private readonly accounts: ExchangeAccountsService,
    private readonly auth: AuthService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Lista las conexiones de exchange del usuario' })
  list(@GetUserInfo() user: SessionUser) {
    return this.accounts.list(user.id);
  }

  // Lista blanca de DOS campos. El resto del cuerpo son claves privadas de
  // firma, y el README es explícito: no pueden acabar «ni en un log».
  @Audit('exchange_account.create', {
    fields: ['venue', 'label'],
    critical: true,
  })
  @Post()
  @ApiOperation({
    summary: 'Da de alta una conexión (verifica antes de guardar)',
    description:
      'Exige haberse reautenticado con Google: dar de alta una clave de firma es la operación más sensible de la plataforma.',
  })
  async create(
    @GetUserInfo() user: SessionUser,
    @Body() dto: CreateExchangeAccountDto,
  ) {
    // Sin esto, un token de acceso robado —15 minutos de vida, sin revalidar
    // contra la base de datos— bastaba para conectar una wallet ajena a la
    // cuenta y ponerse a operar con ella.
    await this.auth.assertStepUp(user.id);
    return this.accounts.create(user.id, dto);
  }

  @Audit('exchange_account.update', {
    fields: ['label', 'builderApproved', 'paperBalance'],
    params: ['id'],
  })
  @Patch(':id')
  @ApiOperation({
    summary: 'Actualiza etiqueta o estado de aprobación de comisiones',
  })
  update(
    @GetUserInfo() user: SessionUser,
    @Param() { id }: IdParamDto,
    @Body() dto: UpdateExchangeAccountDto,
  ) {
    return this.accounts.update(user.id, id, dto);
  }

  @Audit('exchange_account.verify', { params: ['id'] })
  @Post(':id/verify')
  @HttpCode(200)
  @ApiOperation({ summary: 'Reverifica la credencial contra el venue' })
  verify(@GetUserInfo() user: SessionUser, @Param() { id }: IdParamDto) {
    return this.accounts.verify(user.id, id);
  }

  @Audit('exchange_account.paper_reset', { params: ['id'] })
  @Post(':id/paper-reset')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Devuelve la simulación a su capital de partida, sin posiciones ni órdenes',
  })
  resetPaper(@GetUserInfo() user: SessionUser, @Param() { id }: IdParamDto) {
    return this.accounts.resetPaper(user.id, id);
  }

  @Audit('exchange_account.delete', { params: ['id'], critical: true })
  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Elimina la conexión (exige que no queden bots activos)',
  })
  async remove(
    @GetUserInfo() user: SessionUser,
    @Param() { id }: IdParamDto,
  ): Promise<void> {
    await this.accounts.remove(user.id, id);
  }
}

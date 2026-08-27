import { Body, Controller, Get, HttpCode, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Audit } from 'src/libs';
import { GetUserInfo, JwtAuthGuard, type SessionUser } from '../auth';
import { UpdateRiskLimitsDto } from './dtos';
import { RiskService } from './risk.service';

@ApiTags('risk')
@ApiBearerAuth()
@Controller('risk')
@UseGuards(JwtAuthGuard)
export class RiskController {
  constructor(private readonly risk: RiskService) {}

  @Get('limits')
  @ApiOperation({ summary: 'Devuelve los límites de riesgo del usuario' })
  get(@GetUserInfo() user: SessionUser) {
    return this.risk.get(user.id);
  }

  @Audit('risk.update_limits', {
    fields: ['maxNotionalPerBot', 'maxTotalNotional', 'maxLeverage', 'maxOpenBots', 'maxDailyLoss'],
    critical: true,
  })
  @Patch('limits')
  @ApiOperation({ summary: 'Actualiza los límites de riesgo' })
  update(@GetUserInfo() user: SessionUser, @Body() dto: UpdateRiskLimitsDto) {
    return this.risk.update(user.id, dto);
  }

  // Para TODOS los bots del usuario. Hoy solo dejaba un `logger.warn`.
  @Audit('risk.kill_switch', { critical: true, severity: 'WARN' })
  @Post('kill-switch')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Para TODOS los bots del usuario y cancela sus órdenes',
    description:
      'Marca todos los bots vivos como STOPPING. El worker cancela órdenes y cierra posiciones abiertas.',
  })
  killSwitch(@GetUserInfo() user: SessionUser) {
    return this.risk.killSwitch(user.id);
  }
}

import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { PortfolioEquitySeries } from '@crypton/shared';
import { GetUserInfo, JwtAuthGuard, type SessionUser } from '../auth';
import { PortfolioEquityQueryDto } from './dtos';
import { PortfolioService } from './portfolio.service';

@ApiTags('portfolio')
@ApiBearerAuth()
@Controller('portfolio')
@UseGuards(JwtAuthGuard)
export class PortfolioController {
  constructor(private readonly portfolio: PortfolioService) {}

  @Get('equity')
  @ApiOperation({
    summary: 'Curva del resultado acumulado de la cartera',
    description:
      'Una fila por cinco minutos escrita por el worker a partir de los bots reales vivos, agregada por extremos a 480 puntos. Es resultado (realizado más no realizado), no patrimonio. Los tramos sin bots vivos no tienen filas y la app rompe ahí la línea.',
  })
  equity(
    @GetUserInfo() user: SessionUser,
    @Query() q: PortfolioEquityQueryDto,
  ): Promise<PortfolioEquitySeries> {
    return this.portfolio.equity(user.id, q.range, q.testnet ?? false);
  }
}

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IdParamDto } from 'src/libs';
import { GetUserInfo, JwtAuthGuard } from '../auth';
import type { SessionUser } from '../auth';
import { CopyShareDto, ListLeaderboardDto, ShareBotDto } from './dtos';
import { LeaderboardService } from './leaderboard.service';

@ApiTags('leaderboard')
@ApiBearerAuth()
@Controller()
@UseGuards(JwtAuthGuard)
export class LeaderboardController {
  constructor(private readonly leaderboard: LeaderboardService) {}

  @Get('leaderboard')
  @ApiOperation({
    summary: 'Ranking de bots publicados',
    description:
      'Solo entran bots REALES (nunca simulados), publicados por su autor y con al menos 6 horas de recorrido.',
  })
  list(@Query() query: ListLeaderboardDto) {
    return this.leaderboard.list(query);
  }

  @Post('bots/:id/share')
  @ApiOperation({
    summary: 'Publica la configuracion de un bot',
    description:
      'Se comparte la FORMA de la estrategia con los importes convertidos a proporcion del capital. Ni la cuenta del autor ni cuanto dinero mueve.',
  })
  share(
    @GetUserInfo() user: SessionUser,
    @Param() { id }: IdParamDto,
    @Body() dto: ShareBotDto,
  ) {
    return this.leaderboard.share(user.id, id, dto);
  }

  @Delete('bots/:id/share')
  @HttpCode(204)
  @ApiOperation({ summary: 'Deja de listar el bot en el ranking' })
  async unshare(
    @GetUserInfo() user: SessionUser,
    @Param() { id }: IdParamDto,
  ): Promise<void> {
    await this.leaderboard.unshare(user.id, id);
  }

  @Post('leaderboard/copy')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Resuelve un codigo compartido a una configuracion lista para crear',
    description:
      'Devuelve la config dimensionada al capital y al mercado de quien copia. No crea el bot: precarga el asistente.',
  })
  copy(@GetUserInfo() user: SessionUser, @Body() dto: CopyShareDto) {
    return this.leaderboard.resolveShare(user.id, dto.code, {
      exchangeAccountId: dto.exchangeAccountId,
      symbol: dto.symbol,
      totalInvestment: dto.totalInvestment,
    });
  }
}

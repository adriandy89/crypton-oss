import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Audit } from 'src/libs';
import { GetUserInfo, JwtAuthGuard, type SessionUser } from '../auth';
import { AdvisorService, type RecommendationSet } from './advisor.service';
import { RecommendDto } from './dtos';

@ApiTags('advisor')
@ApiBearerAuth()
@Controller('advisor')
@UseGuards(JwtAuthGuard)
export class AdvisorController {
  constructor(private readonly advisor: AdvisorService) {}

  /**
   * Tope propio, más ajustado que el global: cada llamada lee dos series de
   * velas y puede acabar en una llamada al modelo, que cuesta dinero de verdad.
   * Diez por minuto cubre de sobra a alguien tanteando configuraciones a mano.
   *
   * Es un límite distinto del cupo diario y los dos hacen falta: este frena la
   * RÁFAGA (y protege el endpoint aunque el modelo esté apagado); el cupo frena
   * el GASTO acumulado del día.
   */
  //
  // Se audita QUE se pidió y para qué par, no la configuración devuelta: la
  // lista de campos es blanca, y el capital del usuario no tiene por qué quedar
  // en la bitácora de una consulta que no crea nada.
  @Audit('bot.advisor.suggest', { fields: ['venue', 'symbol', 'strategy'] })
  @Post('bot-config')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Tres configuraciones completas para una estrategia y un par',
    description:
      'Devuelve hasta tres perfiles (prudente, equilibrado, agresivo) ya validados ' +
      'contra la spec del mercado y los límites del usuario, con el peor caso ' +
      'calculado. No crea nada: rellena el formulario.',
  })
  suggest(
    @GetUserInfo() user: SessionUser,
    @Body() dto: RecommendDto,
  ): Promise<RecommendationSet> {
    return this.advisor.suggest(user.id, dto);
  }
}

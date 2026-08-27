import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Audit } from 'src/libs';
import { GetUserInfo, JwtAuthGuard, Roles, RolesGuard, type SessionUser } from '../auth';
import { BacktestsService } from './backtests.service';
import { CreateBacktestDto, ListBacktestsQueryDto } from './dtos';

/**
 * Backtesting histórico. Solo administradores.
 *
 * Es el módulo que estrena el `RolesGuard`: `activity.controller.ts` dejó escrito
 * que el guard genérico entraría «cuando aparezca el cuarto caso», y aquí llegan
 * seis rutas de golpe.
 *
 * Se permite reproducir el bot de CUALQUIER usuario, no solo los propios: el
 * sentido de una herramienta de administración es poder diagnosticar el bot de
 * quien se queja. A cambio, lanzar uno queda registrado como acción crítica.
 */
@ApiTags('backtests')
@ApiBearerAuth()
@Controller('admin/backtests')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN')
export class BacktestsController {
  constructor(private readonly backtests: BacktestsService) {}

  @Get('sources')
  @ApiOperation({
    summary: 'Fuentes de histórico disponibles',
    description:
      'Proveedores, intervalos y tipos de mercado. La app construye su formulario DESDE AQUÍ: ' +
      'así añadir una fuente no obliga a tocar el frontend, y un intervalo que una deje de ' +
      'servir desaparece solo.',
  })
  sources() {
    return this.backtests.sources();
  }

  @Audit('admin.backtest.run', {
    fields: ['botId', 'source', 'interval', 'fromMs', 'toMs'],
    critical: true,
  })
  @Post()
  // Más estricto que el global: es una petición barata que dispara un trabajo
  // caro y que además golpea a un tercero.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Ejecuta un backtest y devuelve el resultado (solo ADMIN)',
    description:
      'Síncrono: una rejilla de cien niveles sobre treinta días en velas de cinco minutos son ' +
      'unos siete segundos. Solo se admiten bots de simulación.',
  })
  run(@GetUserInfo() user: SessionUser, @Body() dto: CreateBacktestDto) {
    return this.backtests.run(dto, user.id);
  }

  @Get()
  @ApiOperation({
    summary: 'Ejecuciones anteriores (solo ADMIN)',
    description: 'Es lo que permite comparar dos ajustes sobre el mismo periodo.',
  })
  list(@Query() q: ListBacktestsQueryDto) {
    return this.backtests.list({ botId: q.botId, limit: q.limit });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Resultado completo de una ejecución (solo ADMIN)' })
  detail(@Param('id', ParseUUIDPipe) id: string) {
    return this.backtests.detail(id);
  }

  @Get(':id/fills')
  @ApiOperation({
    summary: 'Ejecuciones simuladas (solo ADMIN)',
    description: 'En tabla aparte: un market maker sobre treinta días produce decenas de miles.',
  })
  fills(@Param('id', ParseUUIDPipe) id: string, @Query('limit') limit?: string) {
    return this.backtests.fills(id, Number(limit) || 500);
  }

  @Audit('admin.backtest.delete', { critical: true })
  @Delete(':id')
  @ApiOperation({ summary: 'Borra una ejecución y sus datos (solo ADMIN)' })
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    await this.backtests.remove(id);
    return { ok: true };
  }
}

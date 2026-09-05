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
import { GetUserInfo, JwtAuthGuard, type SessionUser } from '../auth';
import { BacktestsService } from './backtests.service';
import { CreateBacktestDto, ListBacktestsQueryDto } from './dtos';

/**
 * Backtesting histórico, para cualquier usuario y SOLO sobre lo suyo (spec 004).
 *
 * Nació detrás de `RolesGuard` como herramienta de administración que podía
 * reproducir el bot de cualquiera. Se abre a todos porque la pregunta que
 * contesta —«¿cómo habría ido esta configuración el mes pasado?»— es la de
 * quien está decidiendo si poner dinero, y se acota al usuario: sus bots
 * simulados, sus ejecuciones. Un bot o una ejecución de otro es un 404, como en
 * el resto de la API, no un 403 que confirmaría que existe.
 *
 * Se abrió DESPUÉS de corregir el simulador (001/F-45): antes, toda
 * configuración con stop-loss devolvía un resultado falso, y publicar eso a
 * todos habría sido peor que no tener backtest.
 */
@ApiTags('backtests')
@ApiBearerAuth()
@Controller('backtests')
@UseGuards(JwtAuthGuard)
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

  @Audit('backtest.run', { fields: ['botId', 'source', 'interval', 'fromMs', 'toMs'] })
  @Post()
  // Más estricto que el global: es una petición barata que dispara un trabajo
  // caro y que además golpea a un tercero. Ahora que lo lanza cualquier
  // usuario, el cerrojo de proceso del servicio (uno a la vez) es lo que
  // protege al resto; esto solo evita que uno solo lo monopolice.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Ejecuta un backtest sobre un bot simulado propio y devuelve el resultado',
    description:
      'Síncrono: una rejilla de cien niveles sobre treinta días en velas de cinco minutos son ' +
      'unos siete segundos. Solo se admiten bots de simulación.',
  })
  run(@GetUserInfo() user: SessionUser, @Body() dto: CreateBacktestDto) {
    return this.backtests.run(dto, user.id);
  }

  @Get()
  @ApiOperation({
    summary: 'Ejecuciones anteriores del usuario',
    description: 'Es lo que permite reabrir una y comparar dos ajustes sobre el mismo periodo.',
  })
  list(@GetUserInfo() user: SessionUser, @Query() q: ListBacktestsQueryDto) {
    return this.backtests.list(user.id, { botId: q.botId, limit: q.limit });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Resultado completo de una ejecución propia' })
  detail(@GetUserInfo() user: SessionUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.backtests.detail(user.id, id);
  }

  @Get(':id/fills')
  @ApiOperation({
    summary: 'Ejecuciones simuladas de una ejecución propia',
    description: 'En tabla aparte: un market maker sobre treinta días produce decenas de miles.',
  })
  fills(
    @GetUserInfo() user: SessionUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('limit') limit?: string,
  ) {
    return this.backtests.fills(user.id, id, Number(limit) || 500);
  }

  @Audit('backtest.delete')
  @Delete(':id')
  @ApiOperation({ summary: 'Borra una ejecución propia y sus datos' })
  async remove(@GetUserInfo() user: SessionUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.backtests.remove(user.id, id);
    return { ok: true };
  }
}

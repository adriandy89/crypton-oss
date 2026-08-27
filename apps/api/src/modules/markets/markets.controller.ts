import { Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { Audit } from 'src/libs';
import { JwtAuthGuard, Roles, RolesGuard } from '../auth';
import { Venue } from '@crypton/db';
import { MarketsService } from './markets.service';

@ApiTags('markets')
@ApiBearerAuth()
@Controller('markets')
@UseGuards(JwtAuthGuard, RolesGuard)
export class MarketsController {
  constructor(private readonly markets: MarketsService) {}

  @Get()
  @ApiOperation({ summary: 'Lista los mercados disponibles' })
  @ApiQuery({ name: 'venue', required: false, enum: Venue })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({
    name: 'testnet',
    required: false,
    type: Boolean,
    description: 'Red del venue. Ausente = mainnet.',
  })
  list(
    @Query('venue') venue?: Venue,
    @Query('search') search?: string,
    @Query('testnet') testnet?: string,
  ) {
    // Mainnet salvo que se pida testnet EXPLICITAMENTE. Los parametros de
    // consulta llegan como texto, asi que cualquier comparacion laxa —`!!valor`
    // o un `Boolean(...)`— convertiria `?testnet=false` en `true`.
    return this.markets.list(venue, search, testnet === 'true');
  }

  @Audit('admin.markets_sync', { critical: true })
  @Post('sync')
  @ApiOperation({
    summary: 'Fuerza una resincronización de metadatos (solo ADMIN)',
    description:
      'Un cron ya la ejecuta cada 10 minutos. Este endpoint existe para forzarla tras un incidente.',
  })
  @Roles('ADMIN')
  async sync() {
    // Una petición barata que provoca un trabajo caro: recorre los tres venues
    // y escribe más de mil filas en serie. Estaba abierta a cualquier usuario
    // autenticado y sin límite de caudal, así que bastaba un bucle para tumbar
    // el pool de conexiones.
    await this.markets.syncAll();
    return { ok: true };
  }
}

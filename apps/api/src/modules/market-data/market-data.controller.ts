import { Body, Controller, Get, HttpCode, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { GetUserInfo, JwtAuthGuard, type SessionUser } from '../auth';
import { CandlesQueryDto, FeaturesQueryDto, TickersQueryDto, WatchDto } from './dtos';
import { MarketDataService } from './market-data.service';
import { MarketStreamService } from './market-stream.service';

/**
 * Datos públicos de mercado.
 *
 * Va detrás de `JwtAuthGuard` como el resto de la API —no hay superficie
 * anónima y no merece la pena abrir una— pero por dentro nada de esto toca las
 * credenciales de nadie: todo sale de adaptadores sin firmante.
 */
@ApiTags('market-data')
@ApiBearerAuth()
@Controller('market-data')
@UseGuards(JwtAuthGuard)
export class MarketDataController {
  constructor(
    private readonly marketData: MarketDataService,
    private readonly stream: MarketStreamService,
  ) {}

  @Get('capabilities')
  @ApiOperation({
    summary: 'Qué sabe hacer cada plataforma',
    description:
      'Intervalos de vela, máximo de velas por petición y si hay stream en vivo. ' +
      'La app dibuja su barra de intervalos DESDE AQUÍ: así añadir un venue no ' +
      'obliga a tocar el frontend, y un intervalo que un venue deje de servir ' +
      'desaparece solo de la interfaz.',
  })
  capabilities() {
    return this.marketData.capabilities();
  }

  @Get('candles')
  @ApiOperation({
    summary: 'Velas OHLCV de un par',
    description:
      'Devuelve las velas ordenadas de más antigua a más reciente. Un intervalo ' +
      'que el venue no sirva responde 400 con la lista de los que sí, no un ' +
      'error opaco del DEX.',
  })
  candles(@Query() q: CandlesQueryDto) {
    return this.marketData.candles(q.venue, q.symbol, q.interval, {
      limit: q.limit,
      endMs: q.endMs,
      testnet: q.testnet,
    });
  }

  @Get('tickers')
  @ApiOperation({
    summary: 'Instantánea de precios y sesión de 24 h de todos los mercados',
    description:
      'Se sirve de una caché en Redis: esta ruta nunca llama al venue, por ' +
      'muchos usuarios que tengan la lista abierta. Es la FOTO INICIAL, no el ' +
      'mecanismo de actualización: se pide una vez al abrir la pantalla y a ' +
      'partir de ahí los cambios llegan empujados por el flujo SSE a los pares ' +
      'declarados en POST /market-data/watch.',
  })
  tickers(@Query() q: TickersQueryDto) {
    return this.marketData.tickers(q.venue, q.testnet === true);
  }

  @Get('features')
  @ApiOperation({
    summary: 'Rasgos de un par: volatilidad, rango, tendencia y eficiencia',
    description:
      'La franja de veredicto del gráfico: ¿este par es terreno de rejilla o me ' +
      'va a arrastrar? Los calcula la misma función pura que alimenta al advisor ' +
      '(`buildFeatures`), sobre 300 velas de 1 h y 150 de 1 d, y se cachean cinco ' +
      'minutos. `null` cuando no hay velas suficientes: mejor nada que un número ' +
      'inventado con aspecto de calculado.',
  })
  features(@Query() q: FeaturesQueryDto) {
    return this.marketData.features(q.venue, q.symbol, q.testnet === true);
  }

  @Post('watch')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Declara qué pares y qué velas mira esta conexión SSE',
    description:
      'SSE es unidireccional, así que el interés sube por REST: mismo modelo ' +
      'que los comandos de los bots. Sustituye la lista entera, no la amplía, ' +
      'de modo que cerrar una pantalla se declara mandando lo que queda. Sin ' +
      'interés declarado no se manda nada. `symbols` trae el precio en vivo; ' +
      '`candles` trae la vela en formación con su volumen, y solo la sirven los ' +
      'venues cuya capacidad declara `candles.live`. Devuelve lo ACEPTADO de ' +
      'cada clase, que puede ser menos de lo pedido: si una serie de velas no ' +
      'sale en la respuesta, hay que componerla desde el precio.',
  })
  watch(@GetUserInfo() user: SessionUser, @Body() dto: WatchDto) {
    return this.stream.watch(
      user.id,
      dto.streamId,
      dto.symbols,
      dto.candles ?? [],
      dto.testnet === true,
    );
  }
}

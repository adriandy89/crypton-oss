import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Sse,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { Observable } from 'rxjs';
import { IdParamDto } from 'src/libs';
import { Audit } from 'src/libs';
import { GetUserInfo, JwtAuthGuard, type SessionUser } from '../auth';
import { BotSeriesService } from './bot-series.service';
import { BotsSseService } from './bots-sse.service';
import { BotsService } from './bots.service';
import {
  BotCommandDto,
  CapitalQueryDto,
  CreateBotDto,
  HistoryQueryDto,
  ListBotsQueryDto,
  PreviewBotDto,
  SnapshotsQueryDto,
  RenameBotDto,
  UpdateBotConfigDto,
} from './dtos';

@ApiTags('bots')
@ApiBearerAuth()
@Controller('bots')
@UseGuards(JwtAuthGuard)
export class BotsController {
  constructor(
    private readonly bots: BotsService,
    private readonly sse: BotsSseService,
    private readonly series: BotSeriesService,
  ) {}

  // ── Catálogo y preview (antes de que exista bot alguno) ──────────

  @Get('strategies')
  @ApiOperation({
    summary: 'Descriptores de todas las estrategias',
    description:
      'Cada campo trae su mutabilidad (HOT/WARM/COLD), rango y valor por defecto: la app genera el formulario a partir de esto, sin código por estrategia.',
  })
  strategies() {
    return this.bots.strategiesMeta();
  }

  /**
   * OJO AL ORDEN: esta ruta tiene que declararse ANTES de `@Get(':id')`.
   *
   * Nest resuelve por orden de declaración, así que puesta después, `capital`
   * entraría por el comodín, `IdParamDto` lo rechazaría por no ser un UUID y el
   * endpoint devolvería 400 sin que nada delatara la causa.
   */
  @Get('capital')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Saldo real, capital comprometido y topes de riesgo',
    description:
      'Todo lo que hace falta para dimensionar «Capital asignado»: el saldo del venue, lo que ya tienen pedido los demás bots de esa conexión y los límites que producirían un 403 al crear. Responde SIEMPRE 200: si el venue no contesta, llega con `unavailable` y las cifras a null, porque un exchange caído no puede impedir crear un bot.',
  })
  capital(@GetUserInfo() user: SessionUser, @Query() query: CapitalQueryDto) {
    return this.bots.capital(user.id, query);
  }

  @Post('preview')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Calcula la escalera completa y el peor caso',
    description:
      'Devuelve nivel a nivel el precio, la cantidad, el margen y el notional acumulado, más la liquidación estimada. Es el mismo cálculo que ejecutará el motor.',
  })
  preview(@GetUserInfo() user: SessionUser, @Body() dto: PreviewBotDto) {
    return this.bots.preview(user.id, dto);
  }

  // ── Tiempo real ─────────────────────────────────────────────────

  @Sse('stream')
  @ApiOperation({
    summary: 'Flujo SSE con los eventos de los bots del usuario',
  })
  stream(@GetUserInfo() user: SessionUser, @Req() req: Request): Observable<MessageEvent> {
    const { obs, subject, streamId } = this.sse.stream(user.id);
    // Se retira EXACTAMENTE este subject al cerrarse la conexión; ver el
    // comentario de BotsSseService.remove sobre la carrera al reconectar. El
    // identificador va también: es lo que suelta el interés por precios de esta
    // conexión, y sin soltarlo el worker seguiría manteniendo suscripciones al
    // venue para una pantalla que ya no existe.
    req.on('close', () => this.sse.remove(user.id, subject, streamId));
    return obs;
  }

  // ── CRUD ────────────────────────────────────────────────────────

  @Get()
  @ApiOperation({ summary: 'Lista los bots del usuario con su estado y PnL' })
  async list(@GetUserInfo() user: SessionUser, @Query() query: ListBotsQueryDto) {
    const bots = await this.bots.list(user.id, query);
    // La miniserie viaja CON la lista, en una sola consulta para todos los bots:
    // una peticion por tarjeta serian veinte. Si falla, la lista sale igual sin
    // ella: es analitica, no estado.
    const sparks = await this.series
      .sparks(bots.map((b) => b.id))
      .catch(() => new Map<string, string[]>());
    return bots.map((b) => ({ ...b, spark: sparks.get(b.id) ?? [] }));
  }

  @Audit('bot.create', {
    fields: ['name', 'symbol', 'strategy', 'dryRun', 'startActive'],
  })
  @Post()
  @ApiOperation({
    summary: 'Crea un bot (valida configuración, riesgo y escalera)',
  })
  create(@GetUserInfo() user: SessionUser, @Body() dto: CreateBotDto) {
    return this.bots.create(user.id, dto);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Detalle del bot: configuración, ciclo, posición y órdenes vivas',
  })
  detail(@GetUserInfo() user: SessionUser, @Param() { id }: IdParamDto) {
    return this.bots.detail(user.id, id);
  }

  @Audit('bot.rename', { fields: ['name'], params: ['id'] })
  @Patch(':id')
  @ApiOperation({ summary: 'Renombra el bot' })
  rename(@GetUserInfo() user: SessionUser, @Param() { id }: IdParamDto, @Body() dto: RenameBotDto) {
    return this.bots.rename(user.id, id, dto.name);
  }

  @Audit('bot.update_config', { params: ['id'] })
  @Patch(':id/config')
  @ApiOperation({
    summary: 'Cambia la configuración con el bot en marcha',
    description:
      'HOT se aplica en el siguiente tick sin tocar órdenes ni posición. WARM cancela y vuelve a tender la escalera (exige acceptRelayout). COLD se rechaza.',
  })
  updateConfig(
    @GetUserInfo() user: SessionUser,
    @Param() { id }: IdParamDto,
    @Body() dto: UpdateBotConfigDto,
  ) {
    return this.bots.updateConfig(user.id, id, dto);
  }

  // El comando SÍ se guarda: PANIC y STOP_AND_CLOSE cierran posiciones a
  // mercado, y saber quién lo pidió y cuándo es media investigación.
  @Audit('bot.command', {
    fields: ['command', 'confirm'],
    params: ['id'],
    critical: true,
  })
  @Post(':id/commands')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Ejecuta un comando de runtime',
    description:
      'START, PAUSE, RESUME, STOP_KEEP_POSITION, STOP_AND_CLOSE, CLOSE_NOW, TAKE_PROFIT_NOW, ADD_SAFETY_NOW, REANCHOR_GRID, CANCEL_ALL_ORDERS, PANIC y REPAIR. Los que cierran a mercado y REANCHOR_GRID (compromete margen nuevo) exigen confirm:true; REANCHOR_GRID y ADD_SAFETY_NOW solo aplican a Martingala y GridMart; REPAIR no toca el libro y no pide confirmación.',
  })
  command(
    @GetUserInfo() user: SessionUser,
    @Param() { id }: IdParamDto,
    @Body() dto: BotCommandDto,
  ) {
    return this.bots.command(user.id, id, dto);
  }

  @Audit('bot.delete', { params: ['id'], critical: true })
  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Elimina el bot (debe estar parado)' })
  async remove(@GetUserInfo() user: SessionUser, @Param() { id }: IdParamDto): Promise<void> {
    await this.bots.remove(user.id, id);
  }

  // ── Histórico ───────────────────────────────────────────────────

  @Get(':id/levels')
  @ApiOperation({ summary: 'Escalera deseada del bot, nivel a nivel' })
  levels(@GetUserInfo() user: SessionUser, @Param() { id }: IdParamDto) {
    return this.bots.levels(user.id, id);
  }

  @Get(':id/orders')
  @ApiOperation({ summary: 'Órdenes del bot' })
  orders(
    @GetUserInfo() user: SessionUser,
    @Param() { id }: IdParamDto,
    @Query() q: HistoryQueryDto,
  ) {
    return this.bots.orders(user.id, id, q.limit ?? 100, q.offset ?? 0);
  }

  @Get(':id/fills')
  @ApiOperation({ summary: 'Ejecuciones del bot' })
  fills(
    @GetUserInfo() user: SessionUser,
    @Param() { id }: IdParamDto,
    @Query() q: HistoryQueryDto,
  ) {
    return this.bots.fills(user.id, id, q.limit ?? 100, q.offset ?? 0);
  }

  @Get(':id/cycles')
  @ApiOperation({ summary: 'Ciclos cerrados con su PnL realizado' })
  cycles(
    @GetUserInfo() user: SessionUser,
    @Param() { id }: IdParamDto,
    @Query() q: HistoryQueryDto,
  ) {
    return this.bots.cycles(user.id, id, q.limit ?? 50, q.offset ?? 0);
  }

  @Get(':id/events')
  @ApiOperation({ summary: 'Bitácora de auditoría del bot' })
  events(
    @GetUserInfo() user: SessionUser,
    @Param() { id }: IdParamDto,
    @Query() q: HistoryQueryDto,
  ) {
    return this.bots.events(user.id, id, q.limit ?? 100, q.offset ?? 0);
  }

  @Get(':id/revisions')
  @ApiOperation({
    summary: 'Historial de configuración del bot',
    description:
      'Una entrada por versión, de la más nueva a la más vieja, con qué cambió (`diff`) y cómo se aplicó (HOT, WARM o COLD). Sin la configuración completa: la vigente la sirve `GET /bots/:id`.',
  })
  revisions(
    @GetUserInfo() user: SessionUser,
    @Param() { id }: IdParamDto,
    @Query() q: HistoryQueryDto,
  ) {
    return this.bots.revisions(user.id, id, q.limit ?? 50, q.offset ?? 0);
  }

  /**
   * Ficha de market making: diferencial capturado, pares casados, marcas de
   * agua y eficiencia.
   *
   * Endpoint aparte y no dentro de `GET /bots/:id` porque solo tiene sentido
   * para dos de las siete estrategias, y la pantalla de detalle lo pide cuando
   * hace falta en vez de engordar el listado de todos los bots.
   */
  @Get(':id/mm-stats')
  @ApiOperation({ summary: 'Metricas de market making del bot' })
  mmStats(@GetUserInfo() user: SessionUser, @Param() { id }: IdParamDto) {
    return this.bots.marketMakerStats(user.id, id);
  }

  @Get(':id/snapshots')
  @ApiOperation({ summary: 'Serie temporal de equity, posición y PnL' })
  async snapshots(
    @GetUserInfo() user: SessionUser,
    @Param() { id }: IdParamDto,
    @Query() q: SnapshotsQueryDto,
  ) {
    if (q.fromMs === undefined) return this.bots.snapshots(user.id, id, q.limit ?? 500);
    // Con rango: primero la propiedad —un select de una columna— y despues el
    // servicio de series, que no comprueba nada por si mismo. Hasta cuatro filas
    // por cubo —primera, minima, maxima y ultima— para que el peor momento
    // sobreviva al dibujo. Un rango vacio o del reves es un error del cliente,
    // no una serie vacia.
    const toMs = q.toMs ?? Date.now();
    if (toMs <= q.fromMs)
      throw new BadRequestException('El rango de la serie esta vacio o del reves.');
    await this.bots.assertOwn(user.id, id);
    return this.series.inRange(id, q.fromMs, toMs, q.points);
  }
}

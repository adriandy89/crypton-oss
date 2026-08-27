import { Body, Controller, Delete, Get, HttpCode, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Audit } from 'src/libs';
import { GetUserInfo, JwtAuthGuard } from '../auth';
import type { SessionUser } from '../auth';
import { UpdateTelegramPrefsDto } from './dtos';
import { TelegramService } from './telegram.service';

@ApiTags('telegram')
@ApiBearerAuth()
@Controller('telegram')
@UseGuards(JwtAuthGuard)
export class TelegramController {
  constructor(private readonly telegram: TelegramService) {}

  @Get()
  @ApiOperation({ summary: 'Estado de la vinculacion y preferencias de aviso' })
  status(@GetUserInfo() user: SessionUser) {
    return this.telegram.status(user.id);
  }

  // SIN `fields`: la respuesta lleva el codigo de vinculacion y el deepLink que
  // lo embebe. Quien tenga ese codigo recibe las operaciones de la victima.
  @Audit('telegram.link_requested')
  @Post('link')
  @ApiOperation({
    summary: 'Genera un codigo de vinculacion de un solo uso',
    description: 'Devuelve el codigo y un enlace profundo. Regenerarlo invalida el anterior.',
  })
  link(@GetUserInfo() user: SessionUser) {
    return this.telegram.createLinkCode(user.id);
  }

  @Patch('prefs')
  @ApiOperation({ summary: 'Cambia que eventos se notifican' })
  prefs(@GetUserInfo() user: SessionUser, @Body() dto: UpdateTelegramPrefsDto) {
    return this.telegram.updatePrefs(user.id, dto);
  }

  @Audit('telegram.unlink')
  @Delete()
  @HttpCode(204)
  @ApiOperation({ summary: 'Desvincula Telegram' })
  async unlink(@GetUserInfo() user: SessionUser): Promise<void> {
    await this.telegram.unlink(user.id);
  }
}

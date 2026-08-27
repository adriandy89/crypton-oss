import { Module } from '@nestjs/common';
import { EngineModule } from '../engine';
import { NotifierService } from './notifier.service';
import { TelegramPollerService } from './telegram-poller.service';

// Depende de EngineModule por LeaseService: el sondeo de Telegram usa el mismo
// identificador de worker que los leases de bots, asi que los cerrojos de un
// proceso caido se pueden atribuir de un vistazo en Redis.
@Module({
  imports: [EngineModule],
  providers: [NotifierService, TelegramPollerService],
  exports: [NotifierService],
})
export class NotificationsModule {}

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { EngineModule } from './engine';
import { NotificationsModule } from './notifications';
import { AuditModule, BudgetModule, BusModule, CryptoModule, DbModule } from './libs';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    DbModule,
    AuditModule,
    CryptoModule,
    BusModule,
    BudgetModule,
    EngineModule,
    NotificationsModule,
  ],
})
export class AppModule {}

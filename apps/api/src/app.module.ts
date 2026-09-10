import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule } from '@nestjs/throttler';
import { AppController } from './app.controller';
import {
  AllExceptionFilter,
  AuditInterceptor,
  AuditModule,
  BudgetModule,
  BusModule,
  CacheModule,
  CryptoModule,
  DbModule,
  TimeoutInterceptor,
} from './libs';
import { AdminModule } from './modules/admin';
import { ActivityModule } from './modules/activity';
import { AdvisorModule } from './modules/advisor';
import { BacktestsModule } from './modules/backtests';
import { AuthModule } from './modules/auth';
import { CustomThrottlerGuard } from './modules/auth/guards';
import { BotsModule } from './modules/bots';
import { ExchangeAccountsModule } from './modules/exchange-accounts';
import { MarketsModule } from './modules/markets';
import { MarketDataModule } from './modules/market-data';
import { LeaderboardModule } from './modules/leaderboard';
import { PortfolioModule } from './modules/portfolio';
import { RiskModule } from './modules/risk';
import { UsersModule } from './modules/users';
import { TelegramModule } from './modules/telegram';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        throttlers: [
          {
            ttl: config.get<number>('THROTTLE_TTL', 30_000),
            limit: config.get<number>('THROTTLE_LIMIT', 100),
          },
        ],
      }),
    }),
    ScheduleModule.forRoot(),
    DbModule,
    AuditModule,
    CacheModule.forRootAsync(),
    CryptoModule,
    BusModule,
    // Presupuesto de caudal hacia los venues. Es GLOBAL y comparte deposito en
    // Redis con el worker: los limites de los DEX se cuentan por IP y los dos
    // procesos salen por la misma.
    BudgetModule,
    // Aquí había un `BullModule.forRootAsync`, y no había ninguna cola: ni un
    // `@Processor`, ni un `registerQueue`, ni un `InjectQueue` en todo el
    // repositorio. Lo único que hacía era abrir conexiones a Redis para nada.
    //
    // Lo que parecía que resolvía —entregar comandos al motor sin perderlos—
    // lo resuelve ahora la tabla `bot_commands`, que además es auditable y se
    // escribe en la misma transacción que el evento.
    AuthModule,
    ExchangeAccountsModule,
    MarketsModule,
    MarketDataModule,
    RiskModule,
    BotsModule,
    // Despues de `BotsModule` por legibilidad, no por dependencia: `AdvisorModule`
    // solo necesita mercados, velas y limites de riesgo.
    AdvisorModule,
    BacktestsModule,
    TelegramModule,
    LeaderboardModule,
    // La cartera como agregado (spec 003): solo lectura de la tabla que
    // escribe el worker, sin depender de `BotsModule`.
    PortfolioModule,
    UsersModule,
    ActivityModule,
    AdminModule,
  ],
  controllers: [AppController],
  providers: [
    /**
     * El límite de caudal, aplicado de verdad.
     *
     * `ThrottlerModule` estaba configurado desde el principio (100 peticiones
     * por 30 s), pero sin registrar el guard NO se aplicaba en ninguna parte:
     * solo `AuthController` lo usaba, por llevarlo a nivel de clase. Todo lo
     * demás iba sin límite, incluido `POST /bots/preview`, que era el disparador
     * de la fuga de credenciales, y el canje de códigos por fuerza bruta.
     *
     * Se usa `CustomThrottlerGuard` y no el de serie porque cuenta por usuario
     * cuando hay sesión y por IP cuando no la hay: con NAT, contar solo por IP
     * castiga a usuarios legítimos que comparten salida.
     */
    { provide: APP_GUARD, useClass: CustomThrottlerGuard },

    /**
     * Filtro e interceptores globales, por inyección.
     *
     * Antes se registraban con `new` en `main.ts`, y así construidos no pueden
     * inyectar nada: ni el servicio de auditoría, ni ningún otro. Aquí sí.
     *
     * El orden de los interceptores es el de este array: `TimeoutInterceptor`
     * queda por FUERA, de modo que su tope de 80 s cubre también lo que tarde
     * el de auditoría. El de auditoría solo mide y encola; no espera a la base.
     */
    { provide: APP_FILTER, useClass: AllExceptionFilter },
    { provide: APP_INTERCEPTOR, useClass: TimeoutInterceptor },
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
  ],
})
export class AppModule {}

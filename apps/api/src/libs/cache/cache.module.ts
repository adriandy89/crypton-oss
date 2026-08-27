import { DynamicModule, Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { CacheService } from './cache.service';
import { CacheOptions } from './cache.constants';

@Global()
@Module({})
export class CacheModule {
  /**
   * Register a single Redis cache instance
   * @example
   * CacheModule.forRootAsync()
   */
  static forRootAsync(): DynamicModule {
    return {
      module: CacheModule,
      imports: [ConfigModule],
      providers: [
        {
          provide: 'CACHE_OPTIONS',
          useFactory: (configService: ConfigService): CacheOptions => ({
            redisUrl: configService.get<string>('REDIS_URL') || 'redis://localhost:6379',
            password: configService.get<string>('REDIS_PASSWORD'),
            name: 'cache',
          }),
          inject: [ConfigService],
        },
        {
          provide: CacheService,
          useFactory: (options: CacheOptions) => {
            return new CacheService(options);
          },
          inject: ['CACHE_OPTIONS'],
        },
      ],
      exports: [CacheService],
    };
  }
}

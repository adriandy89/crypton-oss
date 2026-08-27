import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createClient, RedisClientType } from 'redis';
import type { CacheOptions } from './cache.constants';

@Injectable()
export class CacheService implements OnModuleInit, OnModuleDestroy {
  private client: RedisClientType | null = null;
  private readonly serviceName: string;
  private readonly logger = new Logger(CacheService.name);

  constructor(private readonly options: CacheOptions) {
    this.serviceName = options.name || 'default';
  }

  async onModuleInit() {
    this.client = createClient({
      url: this.options.redisUrl,
      password: this.options.password,
      // Add more options here if included in CacheOptions
    });

    this.client.on('error', (err) =>
      this.logger.error(
        `Redis [${this.serviceName}] en ${this.options.redisUrl}: ${(err as Error).message}`,
      ),
    );

    try {
      await this.client.connect();
      this.logger.verbose(`Connected to Redis [${this.serviceName}] at ${this.options.redisUrl}`);
    } catch (err) {
      // El arranque SIGUE aunque Redis no responda, y es deliberado: con
      // `/health` atado al healthcheck de Docker, tumbar el proceso aqui
      // convertiria un parpadeo de Redis en un bucle de reinicios. Todos
      // los metodos comprueban `isReady` y se degradan de la forma
      // conservadora —`get` devuelve nada, `setnx` devuelve false, o sea
      // «no he cogido el cerrojo»— asi que ningun cron se duplica.
      //
      // Lo que NO puede pasar es que el operador no se entere: va por el
      // logger de la aplicacion y no por `console.error`, que se salta el
      // formato y el destino del resto de los registros.
      this.logger.error(
        `Sin conexion a Redis [${this.serviceName}] en ${this.options.redisUrl}: ` +
          `${(err as Error).message}. La API arranca DEGRADADA: sin cache, ` +
          `sin crons y con el refresco de sesion fallando.`,
      );
    }
  }

  async onModuleDestroy() {
    if (this.client?.isOpen) {
      await this.client.quit();
      this.client = null; // Clear the client reference
      this.logger.verbose(
        `Disconnected from Redis [${this.serviceName}] at ${this.options.redisUrl}`,
      );
    }
  }

  async flushAll(): Promise<void> {
    if (!this.client?.isReady) {
      this.logger.error(`Redis client [${this.serviceName}] is not ready for FLUSHALL.`);
      return;
    }
    try {
      await this.client.flushAll();
      this.logger.verbose(`FLUSHALL executed on Redis [${this.serviceName}]`);
    } catch (error) {
      console.error(`Error in FLUSHALL on Redis [${this.serviceName}]:`, error);
    }
  }

  async ttl(key: string): Promise<number> {
    if (!this.client?.isReady) {
      this.logger.error(`Redis client [${this.serviceName}] is not ready for TTL.`);
      return await Promise.resolve(-1);
    }
    try {
      return await this.client.ttl(key);
    } catch (error) {
      console.error(`Error in TTL from Redis [${this.serviceName}], key: ${key}:`, error);
      return await Promise.resolve(-1);
    }
  }

  async get<T>(key: string): Promise<T | null> {
    if (!this.client?.isReady) {
      this.logger.error(`Redis client [${this.serviceName}] is not ready for GET.`);
      return null;
    }
    try {
      const value = await this.client.get(key);
      return value ? (JSON.parse(value) as T) : null;
    } catch (error) {
      console.error(`Error in GET from Redis [${this.serviceName}], key: ${key}:`, error);
      return null;
    }
  }

  /** Atomic GET + DEL (single-use tokens: refresh rotation, SSE tickets). */
  async getDel<T>(key: string): Promise<T | null> {
    if (!this.client?.isReady) {
      this.logger.error(`Redis client [${this.serviceName}] is not ready for GETDEL.`);
      return null;
    }
    try {
      const value = await this.client.getDel(key);
      return value ? (JSON.parse(value) as T) : null;
    } catch (error) {
      console.error(`Error in GETDEL from Redis [${this.serviceName}], key: ${key}:`, error);
      return null;
    }
  }

  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    if (!this.client?.isReady) {
      this.logger.error(`Redis client [${this.serviceName}] is not ready for SET.`);
      return;
    }
    try {
      const stringValue = JSON.stringify(value);
      if (ttlSeconds) {
        await this.client.set(key, stringValue, { EX: ttlSeconds });
      } else {
        await this.client.set(key, stringValue);
      }
    } catch (error) {
      console.error(`Error in SET to Redis [${this.serviceName}], key: ${key}:`, error);
    }
  }

  async setnx<T>(key: string, value: T, ttlSeconds?: number): Promise<boolean> {
    if (!this.client?.isReady) {
      this.logger.error(`Redis client [${this.serviceName}] is not ready for SETNX.`);
      return false;
    }
    try {
      const stringValue = JSON.stringify(value);
      const result = await this.client.set(key, stringValue, {
        condition: 'NX', // Only set if the key does not already exist
        EX: ttlSeconds, // Set expiration if provided
      });
      return result === 'OK'; // Redis returns 'OK' on success
    } catch (error) {
      console.error(`Error in SETNX to Redis [${this.serviceName}], key: ${key}:`, error);
      return false;
    }
  }

  async del(key: string | string[]): Promise<void> {
    if (!this.client?.isReady) {
      this.logger.error(`Redis client [${this.serviceName}] is not ready for DEL.`);
      return;
    }
    try {
      await this.client.del(key);
    } catch (error) {
      const claves = Array.isArray(key) ? key.join(', ') : key;
      console.error(`Error in DEL from Redis [${this.serviceName}], key: ${claves}:`, error);
    }
  }

  async exists(key: string): Promise<boolean> {
    if (!this.client?.isReady) {
      this.logger.error(`Redis client [${this.serviceName}] is not ready for EXISTS.`);
      return false;
    }
    try {
      const exists = await this.client.exists(key);
      return exists === 1;
    } catch (error) {
      console.error(`Error in EXISTS from Redis [${this.serviceName}], key: ${key}:`, error);
      return false;
    }
  }

  async keys(pattern: string): Promise<string[]> {
    if (!this.client?.isReady) {
      this.logger.error(`Redis client [${this.serviceName}] is not ready for KEYS.`);
      return [];
    }
    try {
      const keys = await this.client.keys(pattern);
      return keys;
    } catch (error) {
      console.error(`Error in KEYS from Redis [${this.serviceName}], pattern: ${pattern}:`, error);
      return [];
    }
  }

  async expire(key: string, seconds: number): Promise<void> {
    if (!this.client?.isReady) {
      this.logger.error(`Redis client [${this.serviceName}] is not ready for EXPIRE.`);
      return;
    }
    try {
      await this.client.expire(key, seconds);
    } catch (error) {
      console.error(`Error in EXPIRE from Redis [${this.serviceName}], key: ${key}:`, error);
    }
  }

  async sAdd(key: string, value: string | string[]): Promise<void> {
    if (!this.client?.isReady) {
      this.logger.error(`Redis client [${this.serviceName}] is not ready for SADD.`);
      return;
    }
    try {
      await this.client.sAdd(key, value);
    } catch (error) {
      console.error(`Error in SADD to Redis [${this.serviceName}], key: ${key}:`, error);
    }
  }

  async sMembers(key: string): Promise<string[]> {
    if (!this.client?.isReady) {
      this.logger.error(`Redis client [${this.serviceName}] is not ready for SMEMBERS.`);
      return [];
    }
    try {
      const members = await this.client.sMembers(key);
      return members;
    } catch (error) {
      this.logger.error(`Error in SMEMBERS from Redis [${this.serviceName}], key: ${key}:`, error);
      return [];
    }
  }

  async sRem(key: string, value: string | string[]): Promise<void> {
    if (!this.client?.isReady) {
      this.logger.error(`Redis client [${this.serviceName}] is not ready for SREM.`);
      return;
    }
    try {
      await this.client.sRem(key, value);
    } catch (error) {
      console.error(`Error in SREM from Redis [${this.serviceName}], key: ${key}:`, error);
    }
  }

  async lRange(key: string, start: number, stop: number): Promise<string[]> {
    if (!this.client?.isReady) {
      this.logger.error(`Redis client [${this.serviceName}] is not ready for LRANGE.`);
      return [];
    }
    try {
      const members = await this.client.lRange(key, start, stop);
      return members;
    } catch (error) {
      this.logger.error(`Error in LRANGE from Redis [${this.serviceName}], key: ${key}:`, error);
      return [];
    }
  }

  async sIsMember(key: string, value: string): Promise<boolean> {
    if (!this.client?.isReady) {
      this.logger.error(`Redis client [${this.serviceName}] is not ready for SISMEMBER.`);
      return false;
    }
    try {
      const isMember = await this.client.sIsMember(key, value);
      return isMember === 1; // Redis returns 1 for true, 0 for false
    } catch (error) {
      console.error(
        `Error in SISMEMBER from Redis [${this.serviceName}], key: ${key}, value: ${value}:`,
        error,
      );
      return false;
    }
  }

  /**
   * increment a key in Redis with expiration
   */
  async incrWithExpire(key: string, expireSeconds: number): Promise<number> {
    if (!this.client?.isReady) {
      this.logger.error(`Redis client [${this.serviceName}] is not ready for INCR.`);
      return -1;
    }
    try {
      const exists = await this.client.exists(key);
      const value = await this.client.incr(key);
      if (!exists) {
        await this.client.expire(key, expireSeconds);
      }
      return value;
    } catch (error) {
      console.error(`Error in INCR/EXPIRE from Redis [${this.serviceName}], key: ${key}:`, error);
      return -1;
    }
  }

  // clear all devices cache
  async clearAllDeviceIdsCache(deviceIds: string[]): Promise<void> {
    if (!this.client?.isReady) {
      this.logger.error(
        `Redis client [${this.serviceName}] is not ready for clearing all devices cache.`,
      );
      return;
    }
    try {
      const patterns = deviceIds.map((id) => `device:${id}:*` as const);
      let allKeys: string[] = [];
      for (const pattern of patterns) {
        const keys = await this.client.keys(pattern);
        allKeys = allKeys.concat(keys);
      }
      if (allKeys.length > 0) {
        await this.client.del(allKeys);
        this.logger.verbose(
          `Cleared all devices cache for IDs: ${deviceIds.join(', ')} [${this.serviceName}]`,
        );
      } else {
        this.logger.verbose(
          `No cache found for device IDs: ${deviceIds.join(', ')} [${this.serviceName}]`,
        );
      }
    } catch (error) {
      console.error(`Error clearing all devices cache in Redis [${this.serviceName}]:`, error);
    }
  }

  // remove all devices from some caches
  async clearAllUserIdsCache(userIds: string[]): Promise<void> {
    if (!this.client?.isReady) {
      this.logger.error(
        `Redis client [${this.serviceName}] is not ready for clearing all users cache.`,
      );
      return;
    }
    try {
      if (!userIds || userIds.length === 0) {
        this.logger.warn(`No user IDs provided for clearing users cache [${this.serviceName}].`);
        return;
      }
      const pattern = '*:*:users';
      const allKeys = await this.client.keys(pattern);
      for (const key of allKeys) {
        await this.client.sRem(key, userIds);
      }
    } catch (error) {
      console.error(`Error clearing all users cache in Redis [${this.serviceName}]:`, error);
    }
  }

  /**
   * Clear phone cache entries for multiple phones
   */
  async clearPhoneCache(phonesKeys: string[]): Promise<void> {
    if (!this.client?.isReady) {
      this.logger.error(
        `Redis client [${this.serviceName}] is not ready for clearing phone cache.`,
      );
      return;
    }
    try {
      if (!phonesKeys || phonesKeys.length === 0) {
        return;
      }
      const keysToDelete = phonesKeys.filter((phoneKey) => phoneKey); // Filter out null/undefined

      if (keysToDelete.length > 0) {
        await this.client.del(keysToDelete);
      }
    } catch (error) {
      console.error(`Error clearing phone cache in Redis [${this.serviceName}]:`, error);
    }
  }
}

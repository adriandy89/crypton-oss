import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient, createPrismaAdapter } from '@crypton/db';

/**
 * Cliente de Prisma como servicio de Nest.
 *
 * El adaptador viene de `@crypton/db` para que la API y el worker compartan
 * exactamente la misma configuracion de pool: si cada uno la fijara por su
 * cuenta, uno podria agotar las conexiones de Postgres y dejar al otro sin
 * servicio sin ninguna pista de por que.
 */
@Injectable()
export class DbService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    super({ adapter: createPrismaAdapter() });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}

import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { PrismaClient } from '../generated/prisma/client';

/**
 * Punto unico de acceso al modelo de datos.
 *
 * La API y el worker importan SIEMPRE desde aqui, nunca desde una ruta relativa
 * al cliente generado: asi el empaquetado en Docker no depende de la posicion
 * de una carpeta dentro de otro paquete.
 */
export { PrismaClient };
export * from '../generated/prisma/enums';
export type * from '../generated/prisma/models';
export { Prisma } from '../generated/prisma/client';

export interface PrismaConnectionOptions {
  url?: string;
  /** Tope de conexiones del pool. Se reparte entre api y worker. */
  max?: number;
}

/**
 * Adaptador de `pg` con la configuracion de pool compartida.
 *
 * Vive aqui y no en cada app para que las dos usen exactamente los mismos
 * ajustes: con configuraciones distintas, una podria agotar las conexiones de
 * Postgres y dejar a la otra sin servicio sin ninguna pista de por que.
 *
 * Devuelve el ADAPTADOR y no el cliente ya construido a proposito: la API y el
 * worker envuelven PrismaClient en un servicio de Nest que extiende la clase, y
 * eso exige poder llamar a `super({ adapter })` con el adaptador en la mano.
 */
export function createPrismaAdapter(opts: PrismaConnectionOptions = {}): PrismaPg {
  const pool = new Pool({
    connectionString: opts.url ?? process.env.DATABASE_URL,
    max: opts.max ?? 10,
  });
  return new PrismaPg(pool);
}

/** Cliente suelto, para scripts y seeds que no pasan por Nest. */
export function createPrismaClient(opts: PrismaConnectionOptions = {}): PrismaClient {
  return new PrismaClient({ adapter: createPrismaAdapter(opts) });
}

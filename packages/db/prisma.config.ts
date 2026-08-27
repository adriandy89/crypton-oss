import path from 'node:path';
import fs from 'node:fs';
import dotenv from 'dotenv';
import { defineConfig } from 'prisma/config';

/**
 * Configuración de Prisma para migraciones y semilla.
 *
 * `DATABASE_URL` NO tiene un fichero propio en este paquete a propósito: sería
 * una cuarta copia de la misma cadena de conexión, y las copias se
 * desincronizan. Se toma del entorno si ya viene definido —el caso del
 * contenedor de migraciones, donde el compose la inyecta— y si no, del `.env` de
 * la API, que es quien manda cuando todo corre en el host.
 */
const fromApi = path.resolve(__dirname, '../../apps/api/.env');
if (!process.env['DATABASE_URL'] && fs.existsSync(fromApi)) {
  dotenv.config({ path: fromApi });
}

const url = process.env['DATABASE_URL'];

/**
 * Sin URL NO se lanza un error aquí.
 *
 * `prisma generate` solo necesita el esquema, y es lo que se ejecuta al
 * construir la imagen de Docker, donde no hay —ni debe haber— credenciales de
 * base de datos: meter secretos en una imagen es exactamente lo que no se debe
 * hacer. Fallar en ese punto rompería el build sin motivo.
 *
 * Los comandos que sí la necesitan (`migrate`, `db push`) fallan solos con el
 * mensaje de Prisma, que ya indica con claridad qué falta.
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  ...(url ? { datasource: { url } } : {}),
});

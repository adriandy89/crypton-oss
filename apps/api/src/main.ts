import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import compression from 'compression';
import { AppModule } from './app.module';

/**
 * Los BigInt de Prisma, serializables.
 *
 * `bot_orders.id`, `bot_fills.id` y `bot_cycles.id` son `BigInt` en el esquema,
 * y `JSON.stringify` lanza `TypeError: Do not know how to serialize a BigInt`
 * en cuanto uno llega a una respuesta — que es lo que devuelven `GET /bots/:id`
 * (dentro de `openOrdersList`), `GET /bots/:id/orders` y `GET /bots/:id/fills`.
 *
 * Se serializa como STRING y no como number a proposito: por encima de 2^53 un
 * number pierde precision en silencio, y un id truncado es un id que apunta a
 * otra fila.
 */
(BigInt.prototype as unknown as { toJSON(): string }).toJSON = function toJSON(
  this: bigint,
) {
  return this.toString();
};

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  const logger = new Logger('bootstrap');
  const configService = app.get(ConfigService);
  const environment = configService.get<string>('NODE_ENV', 'development');

  if (environment === 'production') {
    app.getHttpAdapter().getInstance().set('trust proxy', 1);
  }

  /**
   * Compresión, con el flujo de eventos EXCLUIDO.
   *
   * La API no comprimía nada. El proxy del cliente web sí declara gzip para
   * `application/json`, pero la app nativa habla directamente con esta API y no
   * pasa por él, así que se llevaba las respuestas enteras: `GET
   * /market-data/tickers` son 212 KB que comprimidos quedan en 33 KB, y el
   * catálogo de mercados pasa de 342 KB a 21 KB. Un móvil con datos móviles
   * paga esa diferencia cada diez segundos.
   *
   * El filtro NO es una precaución teórica. `text/event-stream` figura como
   * comprimible, así que el filtro de serie lo aceptaría, y zlib acumula lo
   * escrito hasta llenar su búfer: los eventos del motor —fills, liquidaciones,
   * cambios de estado del bot— dejarían de llegar cuando ocurren para llegar a
   * ráfagas, o a no llegar. Es el canal por el que la aplicación se entera de
   * lo que hace el dinero del usuario; se deja sin comprimir a propósito.
   */
  app.use(
    compression({
      filter: (req, res) => {
        const type = String(res.getHeader('Content-Type') ?? '');
        if (type.includes('text/event-stream')) return false;
        return compression.filter(req, res);
      },
    }),
  );

  // API con Bearer token: sin cookies, así que sin credentials. Las apps de
  // Capacitor traen sus propios orígenes; en desarrollo se deja abierto.
  const extraOrigins = (configService.get<string>('PUBLIC_APP_URL', '') || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  const allowedOrigins = new Set([
    'capacitor://localhost',
    'https://localhost',
    'http://localhost',
    ...extraOrigins,
  ]);
  app.enableCors({
    origin: (origin, callback) => {
      callback(
        null,
        !origin || environment !== 'production' || allowedOrigins.has(origin),
      );
    },
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    allowedHeaders: 'Content-Type, Accept, Authorization',
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  // El filtro y los interceptores globales se registran por INYECCIÓN, en
  // `app.module.ts` (`APP_FILTER` / `APP_INTERCEPTOR`). Instanciados aquí con
  // `new` no podrían inyectar el servicio de auditoría — y registrarlos en los
  // dos sitios los ejecutaría dos veces.
  app.setGlobalPrefix('api/v1');

  const swaggerEnable = configService.get('SWAGGER_ENABLE') === 'true';
  if (swaggerEnable) {
    const config = new DocumentBuilder()
      .setTitle('CRYPTON API')
      .setDescription('Bots de trading no custodiales sobre DEX')
      .setVersion('1.0')
      .addBearerAuth()
      .build();
    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('api/v1/docs', app, document, {
      swaggerOptions: { filter: true, persistAuthorization: true },
    });
  }

  const port = configService.get<number>('API_PORT', 3200);
  await app.listen(port, () => {
    logger.verbose(`API en el puerto ${port}`);
    logger.debug(
      environment === 'development'
        ? `Swagger: http://localhost:${port}/api/v1/docs`
        : 'Swagger desactivado en producción',
    );
  });
}
void bootstrap();

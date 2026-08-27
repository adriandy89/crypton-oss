import { createServer } from 'node:http';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { EngineService } from './engine';

/** Margen para que el cierre ordenado termine antes de rendirse. */
const SHUTDOWN_TIMEOUT_MS = 30_000;

/**
 * El worker NO expone la API.
 *
 * Corre como contexto de aplicacion puro: mantiene conexiones WebSocket a los
 * DEX y estado en memoria por bot, y no debe compartir ciclo de vida con el
 * proceso web. Asi un despliegue de la API no toca ni una orden.
 *
 * Lo unico que escucha es un servidor minimo de salud, para que el orquestador
 * pueda saber si el motor esta vivo y cuantos bots lleva. `EngineService.status()`
 * existia desde el principio con un comentario que decia "lo consume el endpoint
 * de salud", pero ese endpoint no existia y el contenedor del worker era el
 * unico del stack sin healthcheck.
 */
async function bootstrap(): Promise<void> {
  const logger = new Logger('worker');
  const app = await NestFactory.createApplicationContext(AppModule, {
    bufferLogs: false,
  });

  // Imprescindible para que los ganchos de apagado se ejecuten y los runners se
  // cierren de forma ordenada en un despliegue.
  app.enableShutdownHooks();

  const engine = app.get(EngineService);
  const port = Number(process.env.WORKER_HEALTH_PORT ?? 3300);
  const health = createServer((req, res) => {
    if (req.url !== '/health' && req.url !== '/') {
      res.writeHead(404).end();
      return;
    }
    const status = engine.status();
    const body = JSON.stringify({ ok: status.healthy, ...status });
    // 503 cuando el motor está atascado: el healthcheck del contenedor exige
    // 200, así que esto es lo que hace que un worker bloqueado se vea como tal
    // en vez de seguir pasando por sano con todos sus bots parados.
    res.writeHead(status.healthy ? 200 : 503, { 'Content-Type': 'application/json' }).end(body);
  });
  // Si el puerto está ocupado se avisa y se sigue: el trabajo del worker es
  // ejecutar bots, y negarse a hacerlo porque un puerto de diagnóstico está
  // cogido sería peor que quedarse sin ese diagnóstico. El aviso es de nivel
  // ERROR a propósito: sin este puerto, el orquestador no puede comprobar si el
  // motor está vivo.
  health.on('error', (e) =>
    logger.error(`No se pudo abrir el puerto de salud ${port}: ${e.message}`),
  );
  health.listen(port, () => logger.log(`Salud del motor en :${port}/health`));

  let cerrando = false;
  const stop = async (signal: string): Promise<void> => {
    if (cerrando) return;
    cerrando = true;
    logger.log(`Recibida ${signal}: cerrando el motor...`);
    health.close();

    // Con tope: si un WebSocket se resiste a cerrar, `app.close()` se queda
    // colgado hasta que el orquestador manda SIGKILL. Es peor que salir a
    // tiempo, porque un SIGKILL no libera los leases y el relevo tarda un TTL
    // entero en producirse.
    const cierre = app.close();
    const tope = new Promise<void>((resolve) =>
      setTimeout(() => {
        logger.error(`El cierre ordenado no terminó en ${SHUTDOWN_TIMEOUT_MS} ms: se sale igual.`);
        resolve();
      }, SHUTDOWN_TIMEOUT_MS).unref(),
    );
    await Promise.race([cierre, tope]);
    process.exit(0);
  };
  process.on('SIGTERM', () => void stop('SIGTERM'));
  process.on('SIGINT', () => void stop('SIGINT'));

  /**
   * Una promesa sin manejar tumba el proceso en Node, y con el TODOS los bots
   * de este worker. El motor esta lleno de `void this.tick()` dentro de
   * temporizadores: basta con que el registro de un error falle —la base caida,
   * por ejemplo— para que el fallo salga sin capturar.
   *
   * No se traga el error: se registra y se sale para que Docker reinicie con el
   * estado limpio. Los leases caducan solos y otro worker adopta los bots.
   */
  process.on('unhandledRejection', (reason) => {
    logger.error(`Promesa sin manejar: ${reason instanceof Error ? reason.stack : String(reason)}`);
    void stop('unhandledRejection');
  });
  process.on('uncaughtException', (error) => {
    logger.error(`Excepcion sin capturar: ${error.stack ?? error.message}`);
    void stop('uncaughtException');
  });

  logger.log('Motor de bots en marcha');
}
void bootstrap();

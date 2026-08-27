import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
// El barril de `@nestjs/common` no reexporta las constantes internas: hay que
// entrar a `constants`, que es donde `@Sse()` deja su marca.
import { SSE_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import { timeout } from 'rxjs/operators';

/**
 * Tope de tiempo por petición.
 *
 * Existe para que una llamada colgada —un venue que no responde, una consulta
 * que se atasca— no retenga la conexión y el manejador para siempre.
 *
 * Los flujos SSE son la excepción: viven horas y en silencio largos ratos, así
 * que cortarlos a los ochenta segundos sería cortarlos y punto.
 */
@Injectable()
export class TimeoutInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    // Se pregunta al HANDLER, no a la cabecera `Accept` de la petición.
    //
    // Antes se miraba `accept === 'text/event-stream'`, y eso es un dato que
    // pone quien llama: bastaba mandar esa cabecera en CUALQUIER endpoint para
    // quedarse sin tope de tiempo —comprobado: `GET /market-data/capabilities`
    // con esa cabecera respondía 200 con JSON y sin límite—, que es justo la
    // forma de retener peticiones abiertas a voluntad. `@Sse()` deja una marca
    // en el manejador y esa no la pone nadie desde fuera.
    //
    // De paso arregla el otro lado del mismo error: un cliente que mandara
    // `Accept: text/event-stream, */*` —perfectamente válido— no casaba con la
    // comparación exacta y se habría llevado un corte a los ochenta segundos en
    // mitad del flujo.
    const isSse = this.reflector.get<boolean>(
      SSE_METADATA,
      context.getHandler(),
    );
    if (isSse) return next.handle();
    return next.handle().pipe(timeout(80_000));
  }
}

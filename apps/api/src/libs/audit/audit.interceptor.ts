import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, tap } from 'rxjs';
import { AuditOutcome, EventSeverity } from '@crypton/shared';
import { AuditService } from './audit.service';
import { AUDIT_METADATA, type AuditOptions } from './audit.types';
import { MUTATING, actorOf, pickFields, safeRoute, type AuditableRequest } from './audit.request';

/**
 * Registra las MUTACIONES QUE SALEN BIEN.
 *
 * Los fallos NO se registran aquí, y no es un olvido: en Nest los guards corren
 * ANTES que los interceptores, así que un 401 del guard de sesión o un 429 del
 * limitador de caudal nunca llegan hasta aquí. De eso se encarga
 * `AllExceptionFilter`, que sí los ve. El reparto deja cada fallo registrado
 * exactamente una vez.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    private readonly audit: AuditService,
    private readonly reflector: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (!this.audit.enabled || context.getType() !== 'http') return next.handle();

    const http = context.switchToHttp();
    const req = http.getRequest<AuditableRequest>();
    const res = http.getResponse<{ statusCode?: number }>();
    const method = req.method ?? '';

    // SSE nunca. Un `tap` sobre un Observable infinito escribiría una fila por
    // cada evento del flujo: con el latido cada 15 s y todos los eventos de los
    // bots del usuario, sería la mayor fuente de volumen de la tabla. Hoy no
    // llega aquí porque es un GET sin decorador, pero el día que alguien anote
    // el endpoint esto lo sigue impidiendo. Mismo criterio que
    // `TimeoutInterceptor`, que también se exime por esta cabecera.
    if (req.headers?.accept === 'text/event-stream') return next.handle();
    const options = this.reflector.get<(AuditOptions & { action: string }) | undefined>(
      AUDIT_METADATA,
      context.getHandler(),
    );

    // Sin decorador, solo se registran las mutaciones; una lectura correcta no
    // dice nada que merezca una fila. Con decorador, se registra siempre: es
    // una declaración explícita de que esa acción interesa.
    if (!options && !MUTATING.has(method)) return next.handle();

    const startedAt = Date.now();

    return next.handle().pipe(
      tap({
        // `setImmediate` y no directamente: dentro del `tap` la respuesta aún
        // no se ha enviado y `res.statusCode` sigue valiendo 200 aunque el
        // manejador declare `@HttpCode(204)` —el caso de `DELETE /bots/:id`—.
        // Diferido un tick, Nest ya ha fijado el código real. No añade latencia:
        // la respuesta ya va de camino.
        next: () => setImmediate(() => this.write(req, res, options, method, startedAt)),
        // Los errores se dejan pasar: los recoge el filtro, que además conoce
        // el código HTTP definitivo.
        error: () => undefined,
      }),
    );
  }

  private write(
    req: AuditableRequest,
    res: { statusCode?: number },
    options: (AuditOptions & { action: string }) | undefined,
    method: string,
    startedAt: number,
  ): void {
    const { actor, actorId } = actorOf(req);
    const meta = {
      ...(pickFields(req.body, options?.fields) ?? {}),
      ...(pickFields(req.params, options?.params) ?? {}),
    };

    const entry = {
      actor,
      actorId,
      // Solo para acciones de BOT. Sin esta comprobación, el `:id` de
      // `/exchange-accounts/:id` acababa en la columna `bot_id` y la
      // correlación con `bot_events` devolvía basura.
      botId:
        options?.action?.startsWith('bot.') && typeof req.params?.['id'] === 'string'
          ? req.params['id']
          : null,
      action: options?.action ?? `http.${method.toLowerCase()}`,
      severity: options?.severity ?? EventSeverity.INFO,
      outcome: AuditOutcome.OK,
      route: safeRoute(req),
      method,
      statusCode: res.statusCode ?? 200,
      durationMs: Date.now() - startedAt,
      ip: req.ip ?? null,
      meta: Object.keys(meta).length > 0 ? meta : null,
    };

    // Lo crítico se escribe y se espera; el resto va al buffer. `void` porque
    // la respuesta ya está de camino y no debe esperar a la bitácora.
    if (options?.critical) void this.audit.recordNow(entry);
    else this.audit.record(entry);
  }
}

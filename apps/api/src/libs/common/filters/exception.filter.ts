import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { AuditOutcome, EventSeverity } from '@crypton/shared';
import { AuditService, actorOf, safeRoute, type AuditableRequest } from '../../audit';

/**
 * Filtro global de excepciones.
 *
 * Dos reglas, y las dos importan:
 *
 * 1. **Al cliente solo sale lo que se decidió decirle.** Antes se devolvía
 *    `exception.message` de cualquier error no-HTTP. Los de Prisma incluyen a
 *    menudo la invocación y los valores del campo infractor; los de Redis y los
 *    SDK de los venues, detalles de infraestructura. Ahora un error inesperado
 *    responde un texto genérico y el detalle se queda en el log del servidor,
 *    que es donde sirve para depurar y no para inventariar el sistema.
 *
 * 2. **El código de estado tiene que ser HTTP.** La versión anterior hacía
 *    `typeof exception.code === 'number' → status = exception.code`, y el
 *    `code` numérico de un error de sistema es un `errno` (por ejemplo -4078 de
 *    ECONNREFUSED). `response.status(-4078)` revienta DENTRO del propio filtro,
 *    que es el peor sitio donde puede fallar algo.
 *
 * 3. **Es el ÚNICO sitio que ve todos los fallos.** En Nest los guards corren
 *    antes que los interceptores, así que un 401 del guard de sesión o un 429
 *    del limitador de caudal no pasan por ningún interceptor: solo llegan aquí.
 *    Por eso la bitácora de fallos se escribe en este filtro y no en el
 *    interceptor, que se queda con las mutaciones que salen bien.
 *
 * Se instancia por INYECCIÓN (`APP_FILTER` en `app.module.ts`) y no con `new`
 * en `main.ts`: necesita el servicio de auditoría, y un filtro construido a
 * mano no puede inyectar nada.
 */
@Injectable()
@Catch()
export class AllExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionFilter.name);

  constructor(private readonly audit: AuditService) {}

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const isHttp = exception instanceof HttpException;
    const status = isHttp ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;

    let error: unknown;
    if (isHttp) {
      const body = exception.getResponse();
      const esObjeto = typeof body === 'object' && body !== null;

      if (esObjeto && 'code' in body) {
        // Cuerpo con código estable (`STEP_UP_REQUIRED`, `EMAIL_TAKEN`…): se
        // pasa ENTERO. Quedarse solo con `message` obligaba al cliente a
        // adivinar el caso leyendo el texto en español, que es justo lo que el
        // código viene a evitar.
        error = body;
      } else if (esObjeto && 'message' in body) {
        error = body.message;
      } else {
        error = body;
      }
    } else {
      // Se registra entero —con traza— y se responde genérico.
      this.logger.error(
        `${request.method} ${request.url}: ${(exception as Error)?.message ?? String(exception)}`,
        (exception as Error)?.stack,
      );
      error = 'Error interno del servidor.';
    }

    const safe = this.safeStatus(status);
    this.audite(request, safe, exception);

    response.status(safe).json({
      statusCode: status,
      timestamp: Date.now(),
      path: request.url,
      error,
    });
  }

  /**
   * Deja constancia del fallo. Nunca lanza: si registrar el error fallara y eso
   * propagara, el filtro que existe para que nada se escape sería justamente
   * quien tumbara la respuesta.
   *
   * Del 4xx se guarda la forma —quién, qué ruta, qué código—, no el motivo
   * detallado: el mensaje de una validación puede repetir el valor rechazado, y
   * el valor rechazado de `POST /exchange-accounts` es una clave privada.
   */
  private audite(request: AuditableRequest, status: number, exception: unknown): void {
    if (!this.audit.enabled) return;
    try {
      const { actor, actorId } = actorOf(request);
      const server = status >= 500;
      this.audit.record({
        actor,
        actorId,
        action: `http.error.${status}`,
        severity: server ? EventSeverity.ERROR : EventSeverity.WARN,
        outcome: server ? AuditOutcome.ERROR : AuditOutcome.DENIED,
        // El NOMBRE DE LA CLASE, jamás el mensaje.
        //
        // Los errores de Prisma incluyen la invocación completa con los valores
        // de los campos: un fallo en `exchangeAccount.create` volcaría
        // `enc_payload` y `enc_dek` dentro del mensaje. Los de los SDK de los
        // venues traen detalles de infraestructura. El nombre de la clase basta
        // para agrupar y no puede llevar nada dentro.
        message: kindOf(exception),
        route: safeRoute(request),
        method: request.method ?? null,
        statusCode: status,
        ip: request.ip ?? null,
      });
    } catch {
      /* la bitácora jamás puede romper la respuesta de error */
    }
  }

  /** Un código fuera del rango HTTP haría fallar a `response.status()`. */
  private safeStatus(status: number): number {
    return Number.isInteger(status) && status >= 100 && status <= 599
      ? status
      : HttpStatus.INTERNAL_SERVER_ERROR;
  }
}

/**
 * Identificador del tipo de error, sin su contenido.
 *
 * Se prefiere el `code` estable cuando lo hay —`P2002` de Prisma,
 * `STEP_UP_REQUIRED` de la aplicación— porque agrupa mejor que el nombre de la
 * clase. Se valida contra un patrón cerrado: un `code` que no encaje se
 * descarta en vez de guardarse, porque un `code` con forma libre puede traer
 * cualquier cosa.
 */
function kindOf(e: unknown): string {
  const code = (e as { code?: unknown })?.code;
  if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,46}$/.test(code)) return code;
  return e instanceof Error ? e.constructor.name : 'UnknownError';
}

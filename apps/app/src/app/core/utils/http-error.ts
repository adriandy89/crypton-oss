import { HttpErrorResponse } from '@angular/common/http';

/**
 * Traduce un error HTTP al mensaje que se le enseña al usuario.
 *
 * La API devuelve dos formas distintas: `error` como string, o un objeto con
 * `message` y una lista de `issues` de validación. Las issues llevan el motivo
 * concreto —"la escalera cubre un 40 % pero a 10x liquidas al 10 %"— y son
 * justo lo que hay que mostrar, no un "petición inválida" genérico.
 */
export interface ValidationIssue {
  field: string | null;
  message: string;
  severity: 'ERROR' | 'WARNING';
}

export interface ParsedHttpError {
  message: string;
  issues: ValidationIssue[];
  /** Presente cuando el servidor pide confirmación explícita (409). */
  requiresConfirmation: boolean;
  coldFields: string[];
  status: number;
  /**
   * Código estable del error, cuando la API lo manda: hoy, `STEP_UP_REQUIRED`.
   *
   * Existe porque la app llegó a decidir el flujo leyendo el mensaje **en
   * español** con una expresión regular. Traducir ese texto —o cambiarle una
   * palabra— rompía el recorrido sin que fallara nada visible.
   */
  code: string | null;
}

export function parseHttpError(e: unknown): ParsedHttpError {
  const empty: ParsedHttpError = {
    message: 'Error desconocido',
    issues: [],
    requiresConfirmation: false,
    coldFields: [],
    status: 0,
    code: null,
  };

  if (!(e instanceof HttpErrorResponse)) {
    return { ...empty, message: e instanceof Error ? e.message : String(e) };
  }
  if (e.status === 0) {
    return { ...empty, message: 'Sin conexión con el servidor.' };
  }

  const body = e.error as
    | {
        error?: unknown;
        message?: unknown;
        issues?: ValidationIssue[];
        coldFields?: string[];
        requiresConfirmation?: boolean;
      }
    | undefined;

  // El filtro de excepciones de la API envuelve el cuerpo en `error`.
  const inner = (body?.error ?? body) as Record<string, unknown> | string | string[] | undefined;

  let message = `Error ${e.status}`;
  let issues: ValidationIssue[] = [];
  let coldFields: string[] = [];
  let requiresConfirmation = false;
  let code: string | null = null;

  if (typeof inner === 'string') {
    message = inner;
  } else if (Array.isArray(inner)) {
    message = inner.join(' ');
  } else if (inner && typeof inner === 'object') {
    message = typeof inner['message'] === 'string' ? (inner['message'] as string) : message;
    issues = (inner['issues'] as ValidationIssue[]) ?? [];
    coldFields = (inner['coldFields'] as string[]) ?? [];
    requiresConfirmation = inner['requiresConfirmation'] === true;
    code = typeof inner['code'] === 'string' ? (inner['code'] as string) : null;
  }

  return { message, issues, coldFields, requiresConfirmation, status: e.status, code };
}

/** Mensaje único, con las issues concatenadas. Para toasts. */
export function errorText(e: unknown): string {
  const parsed = parseHttpError(e);
  if (parsed.issues.length === 0) return parsed.message;
  return `${parsed.message} ${parsed.issues.map((i) => i.message).join(' ')}`;
}

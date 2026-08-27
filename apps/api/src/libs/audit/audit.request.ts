import { ActorKind } from '@crypton/shared';

/**
 * Extracción SEGURA de datos de una petición.
 *
 * Todo lo que sale de aquí puede acabar en la base de datos, así que este es el
 * fichero donde se garantiza que un secreto no lo hace. Vive aparte del
 * interceptor porque el filtro de excepciones necesita exactamente lo mismo, y
 * dos copias de esta lógica es una copia que algún día se queda corta.
 */

/** Forma mínima de la petición de Express que se necesita aquí. */
export interface AuditableRequest {
  method?: string;
  headers?: { accept?: string };
  baseUrl?: string;
  path?: string;
  originalUrl?: string;
  url?: string;
  route?: { path?: string };
  params?: Record<string, unknown>;
  body?: unknown;
  ip?: string;
  user?: { id?: string; role?: string };
}

/**
 * El PATRÓN de la ruta, nunca la URL.
 *
 * `GET /auth/google/callback` recibe el código de OAuth y el `state` en el query
 * string, y la vuelta a la app lleva el vale de sesión. Guardar `req.url` sería
 * almacenar credenciales de un solo uso en claro, y el filtro de excepciones ya
 * escribe esa URL en su log.
 *
 * Se prefiere `req.route.path` —el patrón, `/bots/:id`— porque además evita que
 * la columna acumule un valor distinto por cada UUID. Si no hay ruta casada
 * (un 404), se cae a `req.path`, que en Express YA excluye el query string por
 * definición: la fuga queda cerrada por construcción, no por una lista negra
 * que alguien pueda olvidar ampliar.
 */
export function safeRoute(req: AuditableRequest): string | null {
  const pattern = req.route?.path;
  // Con el prefijo delante: `req.route.path` da `/bots/:id` sin el `api/v1`, y
  // dos rutas iguales de módulos distintos serían indistinguibles.
  if (typeof pattern === 'string' && pattern.length > 0) {
    return (req.baseUrl ?? '') + pattern;
  }
  const path = req.path;
  if (typeof path === 'string' && path.length > 0) return path;
  // Último recurso: si solo hay URL, se corta por el interrogante. Nunca se
  // devuelve un query string.
  const url = req.originalUrl ?? req.url;
  return typeof url === 'string' ? url.split('?')[0] : null;
}

/**
 * Los campos del cuerpo declarados en la lista blanca, y solo esos.
 *
 * Además se acota el tamaño de cada valor: un campo legítimo pero enorme
 * —una configuración de estrategia entera— haría crecer la tabla sin aportar
 * nada legible.
 */
export function pickFields(
  source: unknown,
  fields: readonly string[] | undefined,
): Record<string, unknown> | null {
  if (!fields || fields.length === 0) return null;
  if (typeof source !== 'object' || source === null) return null;

  const out: Record<string, unknown> = {};
  const record = source as Record<string, unknown>;
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(record, field)) continue;
    out[field] = clamp(record[field]);
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Recorta valores largos y aplana lo que no sea primitivo. */
function clamp(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value.length > 200 ? value.slice(0, 200) + '…' : value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  // Objetos y arrays: se guarda su forma, no su contenido. Un campo declarado
  // que resulta ser un objeto anidado podría traer cualquier cosa dentro.
  if (Array.isArray(value)) return `[${value.length} elementos]`;
  return '[objeto]';
}

/** Quién actúa, a partir de `req.user` que deja el guard de sesión. */
export function actorOf(req: AuditableRequest): {
  actor: ActorKind;
  actorId: string | null;
} {
  const user = req.user;
  if (!user?.id) return { actor: ActorKind.ANON, actorId: null };
  return {
    actor: user.role === 'ADMIN' ? ActorKind.ADMIN : ActorKind.USER,
    actorId: user.id,
  };
}

/** Métodos que cambian estado. Son los que se registran aunque salgan bien. */
export const MUTATING = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

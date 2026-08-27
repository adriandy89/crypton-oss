import { Role } from '@crypton/db';

/**
 * Usuario autenticado que la estrategia JWT engancha en `req.user`.
 * Los claims viajan dentro del access token: no hay consulta a BD por petición.
 *
 * Lo mínimo para autorizar y para pintar la interfaz. Nada de Google entra
 * aquí: el `sub` es un identificador que no le hace falta a ninguna pantalla,
 * y meterlo en un token que viaja en cada petición sería repartirlo sin motivo.
 */
export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  /** 'es' | 'en' */
  language: string;
}

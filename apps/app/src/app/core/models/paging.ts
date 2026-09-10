/**
 * El sobre paginado de la API.
 *
 * Lo construye `PageDto` + `PageMetaDto` en el servidor. Aqui vive su forma
 * porque la app no puede importar aquellas clases —llevan decoradores de
 * `class-validator` y de Swagger, que no pintan nada en un navegador— y porque
 * ya estaba redeclarada a mano en `activity.service.ts`. Con Usuarios y Bots
 * serian cuatro copias del mismo objeto de seis campos.
 *
 * En `core/models` y NO en `packages/shared`: aquel paquete es dominio y
 * aritmetica de dinero, con test, y api y worker lo consumen desde `dist`. Meter
 * aqui un sobre de transporte HTTP obligaria a `pnpm build:packages` y a pasar
 * los tests de worker y backtest cada vez que cambiase, por un `interface` que
 * el worker no va a leer nunca. El dia que otro consumidor de la API necesite
 * esta forma, el fichero se muda a `shared` y aqui queda un reexport de dos
 * lineas; ese dia el coste estara justificado.
 */

export interface PageMeta {
  page: number;
  limit: number;
  itemCount: number;
  pageCount: number;
  hasPreviousPage: boolean;
  hasNextPage: boolean;
}

export interface Paginated<T> {
  data: T[];
  meta: PageMeta;
}

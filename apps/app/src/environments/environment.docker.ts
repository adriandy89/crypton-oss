/**
 * Build del cliente web que se despliega con Docker.
 *
 * La URL de la API es RELATIVA a proposito: nginx sirve la aplicacion y hace
 * de proxy de `/api/v1` hacia el contenedor de la API (ver apps/app/nginx.conf).
 * Al quedar todo en el mismo origen no hay CORS que configurar, la cookie de
 * sesion —si algun dia la hubiera— seria de primera parte, y cambiar el dominio
 * del despliegue no obliga a reconstruir la imagen.
 */
export const environment = {
  production: true,
  apiUrl: '/api/v1',
};

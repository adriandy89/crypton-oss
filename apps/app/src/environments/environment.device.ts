/**
 * Build para dispositivo o emulador en desarrollo.
 *
 * La URL tiene que ser ABSOLUTA: dentro del WebView de Capacitor no hay ningún
 * dev server que haga de proxy, así que una ruta relativa apuntaría al propio
 * paquete de la app. Cambia la IP por la de tu maquina en la red local
 * (10.0.2.2 si usas el emulador de Android).
 */
export const environment = {
  production: false,
  apiUrl: 'http://10.0.2.2:3200/api/v1',
};

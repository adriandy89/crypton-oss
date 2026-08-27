/**
 * Build de produccion — es la configuracion POR DEFECTO de `ng build`, y por
 * tanto la que acaba dentro del APK.
 *
 * PONLA ANTES DE COMPILAR: dentro del WebView de Capacitor no hay proxy que
 * valga, asi que la URL tiene que ser ABSOLUTA y apuntar a tu propia API. Si
 * sirves la app y la API desde el mismo origen detras de un proxy inverso, usa
 * el build `docker`, que ya va con una ruta relativa.
 */
export const environment = {
  production: true,
  apiUrl: 'https://api.example.com/api/v1',
};

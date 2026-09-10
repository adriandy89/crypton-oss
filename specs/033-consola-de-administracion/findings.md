# 033 — Hallazgos

Este no es un spec de revisión: aquí solo se anota lo que apareció **de paso** al construir la
consola y que no se corrige dentro de este spec (principio 5 de `specs/README.md`: los refactors
oportunistas son specs aparte o no son).

## F-01 — El e2e del preview depende de los mínimos del venue, y falla sin decirlo

**Severidad: Baja.** Test frágil, sin efecto sobre el dinero ni sobre el aislamiento.

`apps/api/test/isolation.e2e-spec.ts`, «el preview no toma prestada la credencial de otro
usuario»: espera **403** con el motivo «conexión verificada» y recibe **400** con
`«La configuración no es válida.»`.

La propiedad que el test defiende **se sigue cumpliendo**: comprueba antes que la respuesta no es
200 ni 201, y no lo es. Lo que falla es la aserción del motivo. La causa es que la petición lleva
`totalInvestment: '100'` con 5 niveles sobre `ASTER/BTCUSDT`, y `validate()` de `strategy-core`
rechaza esa configuración —por los mínimos por orden del mercado— **antes** de que el servicio
llegue a comprobar si el usuario tiene conexión propia en ese venue. Con otros mínimos
sincronizados en `markets`, el mismo test pasa.

Verificado el 2026-09-10 contra una base local con 1259 mercados sincronizados. No lo causa el
spec 033: no toca `preview`, ni `validate`, ni `markets`.

**Arreglo propuesto (spec de seguimiento):** que el test use un importe holgado —o un venue y par
cuyos mínimos no dependan de la sincronización— para que la petición llegue a la comprobación que
el test dice estar probando. Alternativa: que el servicio compruebe la propiedad de la conexión
**antes** que la configuración, que además es el orden barato y el que no filtra por qué falla.

## F-02 — `BotsService.detail()` devuelve la fila cruda de Prisma

**Severidad: Baja.** Riesgo latente, sin fuga hoy.

`apps/api/src/modules/bots/bots.service.ts:719` hace `...bot` sobre la fila de Prisma. Hoy `bots`
no tiene ninguna columna sensible, así que no filtra nada. Pero es preexistente y **compartido con
el endpoint de usuario**: añadir mañana una columna sensible a `bots` la publicaría en los dos
sitios sin que nadie tocase un mapper.

No entra aquí porque tocarlo cambia el contrato de un endpoint en uso por la app.

**Arreglo propuesto (spec de seguimiento):** un `toPublic()` explícito para el detalle de bot, con
el contrato congelado por un test, y la app ajustada si algún campo cambia de nombre.

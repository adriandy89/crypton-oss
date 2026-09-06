# 027 — Elegir el par: una hoja con buscador, y los totales de la lista de bots

Estado: `hecho` (2026-09-06) · Tipo: `cambio` · Rama: `spec/027-selector-de-par`

## Objetivo

Que elegir el par de un bot nuevo sea escribir su nombre, y no arrastrar por una lista alfabética de
cientos de entradas. De paso, que la pestaña Bots diga cuánto suman los bots que se están viendo y que el
capital de cada tarjeta no dependa de que el servidor esté ya desplegado.

## Contexto

Petición del usuario (2026-09-06), con el encargo explícito de no romper nada.

El campo «Par» del asistente era un `ion-select interface="popover"` que desplegaba el catálogo entero del
venue en orden alfabético: **177 pares en Hyperliquid, 212 en Lighter y 546 en Aster**. Para llegar a
`SOL/USDC` había que recorrer una lista que empieza en `0G/USDC`, `2Z/USDC`, `AAVE/USDC`, sin forma de
filtrar escribiendo y sin más dato de cada par que su apalancamiento máximo. La pestaña Mercados ya tenía
buscador, orden por volumen y precio por fila desde el spec 002; el asistente se había quedado atrás.

Las dos mejoras del anexo salieron de la misma sesión: al estrenar el spec 025 el capital no aparecía
porque la API aún no estaba desplegada, y la lista no dice cuánto suma lo que se está mirando.

## Alcance

- `apps/app/src/app/shared/ui/ui-pair-sheet.component.ts` (nuevo) y el barril `shared/ui/index.ts`.
- `apps/app/src/app/features/bots/bot-create.page.{html,ts}`: el disparador y la señal `pairOpen`.
- `apps/app/src/global.scss`: el aspecto del disparador, junto al del resto de campos.
- `apps/app/src/app/features/bots/bots-list.page.{ts,scss}` y `bot-detail.page.{html,ts}`: totales y respaldo.

## Fuera de alcance

- La API: no cambia nada del servidor. El filtrado es en cliente sobre el catálogo que la pantalla ya tiene.
- Virtualizar la lista: 546 filas con `track` por símbolo es lo que ya sostiene la pestaña Mercados con 935.
- Unificar la fila de mercado de las tres pantallas que la repiten (Mercados, gráfico y esta hoja).

## Requisitos

- **R-1** El campo «Par» abre una hoja con buscador que filtra por símbolo, moneda y par a medida que se
  escribe, sobre el catálogo ya cargado y sin ninguna petición nueva.
- **R-2** Sin texto, la lista sale ordenada por volumen de 24 h; sin instantánea de precios, alfabética. Con
  texto manda la relevancia —coincidencia exacta, luego empieza por, luego contiene— y el volumen desempata.
- **R-3** Cada fila enseña el par, su apalancamiento máximo, su volumen, su precio y su cambio del día, y
  marca los pares en los que el usuario ya tiene un bot. Intro elige el primero; elegir cierra la hoja.
- **R-4** El contrato del asistente no cambia: la hoja emite `Market.symbol` y quien lo escribe en la señal
  sigue siendo la página. La hoja no guarda estado del par ni sobrevive a un reinicio de fuera.
- **R-5** La pestaña Bots abre con los totales de los bots visibles: capital actual, asignado y PnL.
- **R-6** El capital actual de la tarjeta y del detalle se compone en la app con `capitalActual()` cuando la
  respuesta del servidor no trae el campo.

## Criterios de aceptación

- **CA-1** Typecheck, `pnpm --filter app lint` y `pnpm --filter app build` limpios, sin avisos de presupuesto
  de estilos; `pnpm lint` de la raíz sin cambios.
- **CA-2** A mano, con la infra levantada: en Aster (546 pares) la hoja abre con los más negociados arriba,
  escribir `sol` pone `SOL/USDC` primero, elegirlo cierra la hoja y el asistente sigue igual —tope de
  apalancamiento del par, vista previa y creación—; cambiar de conexión limpia el par.

## Riesgos

- La hoja se pinta fuera de `ion-content` **a propósito**: el paso «Cuenta» se destruye entero cuando el
  asistente recarga el catálogo, y una hoja dentro se iría con él a media interacción.
- Los precios de la hoja salen de la instantánea de 60 s, no de los ticks en vivo: pueden ir medio minuto
  por detrás. Es deliberado; lo contrario repintaría 546 filas cinco veces por segundo.
- La app no tiene tests: la red es el typecheck, el lint con tipos —que analiza las plantillas— y el build.

## Referencias oficiales

Ninguna: interfaz propia.

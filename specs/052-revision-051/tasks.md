# 052 — Tareas

## Fase 0 — Línea base

- [x] Rama `spec/052-revision-051` desde `main` (`060cf9c`)
- [x] `pnpm build:packages`: verde
- [x] API: 41 suites, **5625 tests** en verde
- [x] `pnpm lint`: 0 errores (3 warnings previos)
- [x] `pnpm check:env`: coherente
- [x] `findings.md` con los 21 hallazgos, evidencia y decisión (18 corregidos, 3 descartados con su razón)

## Fase 1 — Traducción (F-01..F-05, F-11, F-12) — `112d825`

- [x] `atrStopMultiplier` bloqueado con posición, y comprobado que `stopLossPct` en TREND está
      siempre vacío (el validador lo rechaza con valor)
- [x] Cota relativa por escalón. **Tuvo dos vueltas**: la primera versión era una banda ADITIVA
      (`v ± v·25 %`) y rompió el invariante de ida y vuelta —cada MAS+MENOS dejaba el bot un 6,25 %
      más abajo—. La definitiva es MULTIPLICATIVA (`[v / f, v × f]`), que devuelve exactamente el
      valor de partida, con el delta en múltiplos del paso y suelo de un paso
- [x] El cero no se mueve, y con regla propia: la banda de cero es cero, pero decirlo explícito es
      lo que lo convierte en contrato
- [x] Decimales del campo efectivo en los importes
- [x] `PosicionViva.medidaHace` (obligatorio en el tipo: así el compilador obligó a decidir en cada
      sitio) y frescura de dos minutos para bajar el tope
- [x] Con una capa, ni separación ni crecimiento entre capas
- [x] `movimientosConEfecto` prueba el escalón doble
- [x] `apply.spec.ts`: 52 tests en verde

## Fase 2 — Servicio (F-06, F-07, F-09, F-10, F-13) — `9800315`

- [x] `expectedVersion` en `updateConfig`, al leer y **dentro de la transacción** (`updateMany` con
      la versión en el `where`, contando filas)
- [x] El supervisor la pasa en las dos rutas —automática y aprobación por Telegram, donde la versión
      sale de `rehacer`— y distingue el rechazo: `CADUCADA`/`STALE`, sin Telegram
- [x] `warmPermitido` solo cuando la decisión se aplicaría sola
- [x] `RiskService.topeDeApalancamiento` y su uso como `maxLeverageUsuario`
- [x] `failures` a cero con respuesta válida
- [x] Retirar propuestas anteriores nunca tumba el aviso

## Fase 3 — Expediente, efectos y prompt (F-08, F-14..F-18) — `4d8a213`

- [x] Huella: latente con banda muerta, aviso fuera, estado fresco dentro
- [x] `estadoFresco` en el expediente y su línea en el prompt
- [x] Incidencias: `TICK_SLOW`, `LEVERAGE_SKIPPED`, `POSITION_MODE_SKIPPED` fuera; `FAIR_PRICE_*`
      dentro, porque ahí sí actúa una persona
- [x] Historial con `CADUCADA`/`PLAZO` y su rótulo
- [x] Prompt v3

## Fase 4 — Documentación — `e3d72d4`

- [x] `docs/administracion.md` §Modo IA
- [x] `specs/README.md`: 052 y cierre del 051

## Fase 5 — Verificación

- [x] API: 41 suites, **5650 tests** en verde (25 más que la línea base)
- [x] `pnpm lint`: 0 errores. Cazó un `no-base-to-string` en código nuevo (`String()` sobre un valor
      de Prisma-JSON), corregido antes del commit
- [x] `pnpm check:env`: coherente
- [x] **`pnpm --filter api build`**, que es lo que compila el despliegue. Se descubrio tarde y de la
      peor forma: el `docker compose up --build` de produccion fallo. `nest build` corre `tsc` de
      verdad y jest no —es la leccion del spec 049 otra vez—, y cazo un `Numeric` (que incluye
      `Decimal`) pasado a un parametro `string | number`. **Va en la lista de verificacion de ahora
      en adelante, antes de mergear.** El contenedor viejo siguio sirviendo: `up --build` no
      sustituye nada si la imagen no compila
- [x] Mutaciones: **22 de 22 caen** (`mutaciones-052.cjs` en el scratchpad). Tres sobrevivieron a la
      primera y se arreglaron los tests, no el código: la banda multiplicativa, el suelo de un paso
      y el tope efectivo de apalancamiento. Es el mismo ejercicio del 046 y del 051, y vuelve a ser
      donde aparecen los tests que no probaban nada
- [x] Criterios de aceptación CA-1 a CA-15, todos con test

## Fase 6 — Despliegue (autorizado por el usuario)

- [x] Merge a `main` (`eac96f8`) y `push` a origin
- [x] Antes de desplegar, la vigilancia pendiente del 051 (CA-9), que salió **bien y además
      confirmó F-17 en producción**: en doce horas, **cero avisos** (antes ~36 al día), siete
      decisiones con `prompt_version = 2`, dos cambios aplicados y una propuesta rechazada por una
      persona. Las otras cuatro son **la misma propuesta caducada cuatro veces** sobre el market
      maker V2 de LIT, que está en manual: cinco `AI_SUGGESTION` a Telegram por una decisión que su
      dueño ya había dejado pasar. Es exactamente F-17. Y `failures = 1` en el de HYPE por un corte
      del modelo que nunca se iba a reiniciar: F-10
- [x] **El primer despliegue FALLÓ al construir la imagen**, y ahí se descubrió que `nest build` no
      compilaba (ver Fase 5). El contenedor viejo siguió sirviendo: `up --build` no sustituye nada
      si la imagen no compila. Con el arreglo (`e867bf6`), imagen de las 08:03 UTC y `healthy` a las
      08:04:28
- [x] Comprobado que el `dist` desplegado lleva el 052: prompt v3, la cota relativa, el stop de ATR,
      `STALE_VERSION`, `topeDeApalancamiento`, las incidencias nuevas y la frescura. Trampa nueva:
      el `dist` vive en `/app/apps/api/dist/modules`, sin el `src/` que tenía en el 051
- [x] Sin tocar datos: los fallos se reinician solos con la primera revisión buena y las huellas
      cambian con la versión del prompt
- [x] Vigilancia de solo lectura tras la primera revisión v3 (08:25 UTC, el market maker V2 de LIT,
      que está en manual). El modelo respondió **MANTENER**, y el motivo es literalmente el hallazgo
      F-17 funcionando: «Margen negativo pide ensanchar spread, pero ya se rechazó y caducó dos veces
      sin motivo nuevo; se mantiene sin repetir el aviso ni el ajuste». Antes de esto el expediente
      no le enseñaba las caducadas y lo habría vuelto a proponer, con su mensaje de Telegram. Cero
      eventos `AI_*` en la ventana, ninguna fila escrita —`MANTENER` sale gratis a propósito— y la
      huella cambió con la versión del prompt, como tenía que pasar

## Fase 7 — Fork OSS

- [x] Nombres de los bots fuera del privado ANTES de portar (`5a2b892`): los specs y los comentarios
      se publican, y el nombre que su dueño le puso a un bot es suyo
- [x] Parche 3-way desde `0d3ad2e` con las exclusiones de siempre: **24 ficheros, sin un solo
      conflicto**
- [x] Verificación: 18/25 idénticos por md5 sin ``, 0 ausentes, y en los 7 distintos **0 líneas
      nuevas perdidas** — son las divergencias documentadas (planes, `com.crypton.app`, el índice
      propio y el ancho de prettier de `apps/api`)
- [x] OSS: 7016 tests (API 5614 frente a 5650, que son los 36 de planes y del gate de Telegram),
      lint 0 errores, `check:env` coherente, `nest build` de la API
- [x] Commit local `ab06e51`, **sin push** (decisión del usuario), y limpieza de los objetos
      privados del clon (`git cat-file -e` del commit privado ya no lo encuentra)
- [x] Memoria

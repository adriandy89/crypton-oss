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

- [ ] Merge a `main` y push a origin
- [ ] Producción: `git pull --ff-only` y `up -d --build api`; comprobar el `dist` antes de nada
- [ ] Vigilancia de solo lectura

## Fase 7 — Fork OSS

- [ ] Parche 3-way desde el punto de bifurcación, con las exclusiones de siempre
- [ ] Anonimizar antes de portar
- [ ] Commit local (sin push, decisión del usuario)
- [ ] Memoria

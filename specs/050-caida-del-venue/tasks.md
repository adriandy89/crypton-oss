# 050 — Tareas

## Fase 0 — Línea base

- [x] Rama `spec/050-caida-del-venue` creada desde `main` limpia (`5c570ca`)
- [x] `pnpm build:packages`
- [x] `pnpm test` (sin e2e): verde. La API avisa de un worker de jest que no cierra (ya pasaba)
- [x] `pnpm lint`: verde, con 3 warnings previos en `apps/api`
- [x] `pnpm check:env`: coherente

## Fase 1 — Clasificación y timeouts (R-1, R-8)

- [x] Tests de clasificación de red, 5xx, `cause.code` y `TimeoutError`: rojos (4 FATAL); el
      aborto de `fetch` salía como «{}» porque un DOMException no es `instanceof Error`
- [x] `errors.ts`: patrones, `cause.code`, `isVenueUnavailable`
- [x] Tests de timeout en Lighter (servidor local que no contesta) y Aster (`fetch` simulado)
- [x] `AbortSignal.timeout` en `publicGet` y `http`, con `httpTimeoutMs` para los tests

## Fase 2 — Simulador (R-4)

- [x] Tests del último precio reciente: rojos (2 de 5)
- [x] `DryRunAdapter.getTicker`. Fases 1 y 2 van en un solo commit (`1e9ef51`): comparten
      `exchange-core.spec.ts`

## Fase 3 — Motor (R-2, R-3, R-5)

- [x] Tests: caída sin pausa, aviso único, `last_error`, recuperación, bot pausado: rojos
- [x] Tests: fallo propio pausa con un solo `TICK_ERROR`
- [x] Tests: latido sin cola, espaciado durante la caída, `requestTick` sin espera
- [x] Tests: nota sin posición, sin `TICK_SLOW` en tick caído
- [x] `bot-store.ts` `setLastError`
- [x] `bot-runner.ts`

## Fase 4 — Salud, notificador y app (R-6, R-7)

- [x] `runnersAtascados` en `health.ts` y su test; `stalledRunners` lo usa
- [x] `EVENT_PREF`, `ICON` y su test
- [x] `EVENT_LABELS` y `EVENT_SHORT` (rótulo del gráfico)

## Cierre

- [x] Romper cada salvaguarda y ver caer su test: 15 de 15 (script en el scratchpad). Dos trampas:
      la primera tanda se colgó porque un test que falla a medias deja un runner con temporizador
      vivo y jest no sale (hace falta `--forceExit`), y dos mutaciones no probaban nada al principio:
      una no se aplicaba por los CRLF del fichero y otra no compilaba (0 tests)
- [x] Revisión independiente sobre `dc35981`: 0 Críticos, 0 Altos, 2 Medios y 5 Bajos (ver la
      sección «Revisión» del spec). Los siete corregidos con test rojo primero, y cada salvaguarda
      nueva rota a propósito para ver caer su test
- [x] Verificación completa (CA-9), repetida tras la revisión: `build:packages`, `pnpm test`
      (shared 97, strategy-core 509, exchange-core 399, backtest 31, worker 366, api 5556),
      `pnpm lint` (3 warnings previos de la API), `check:env`, typecheck y lint de la app
- [x] Docs (R-9): `riesgo-y-liquidacion.md` y `comandos-guardas-y-eventos.md`
- [x] Criterios de aceptación repasados uno a uno: CA-1 a CA-9 con test; CA-10 es del usuario
- [x] Índice de `specs/README.md` actualizado
- [x] `CLAUDE.md`: sin cambios, ningún invariante nuevo
- [x] Memoria de usuario actualizada

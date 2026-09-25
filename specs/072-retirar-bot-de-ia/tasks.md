# 072 — Tareas

Una casilla por tarea, agrupadas por fase. Se marcan al terminar, con una nota corta si hubo
sorpresas. Nada se da por hecho sin la verificación de su fase.

## Fase 0 — Línea base

- [x] Rama `spec/072-retirar-bot-de-ia` creada desde `main` limpia (`0aa450e`)
- [x] `pnpm build:packages`
- [x] `pnpm test` (sin e2e): **8.437** en verde — shared 212, strategy-core 925, exchange-core 517,
  worker 621, backtest 77, API 6.085

## Fase 1 — La API (`7328fe3`)

- [x] `modules/ai-trader` borrado entero, con el cliente de TypeSafe y la primitiva `score`
- [x] `app.module.ts`, `ai-channel.service.ts` y su spec restaurados a `970c31c`
- [x] `TYPESAFE_AI_API_KEY` y `AI_TRADER_*` fuera de los dos `.env.example` y del compose
- [x] API 5.992 tests en 61 suites (93 menos, los del módulo), lint sin errores, `tsc` limpio,
  `check:env` en verde

## Fases 2 y 3 — La app y la estrategia, juntas (`41f95e4`)

- [x] Guía de la app borrada; siete ficheros restaurados; `field-labels.ts` a mano (124 líneas del
  catálogo y 12 de opciones fuera; «Canal» vuelve a «Canal con IA»)
- [x] **Sorpresa prevista en el plan y confirmada**: la app sola no compila contra un `shared` que
  aún tiene el valor (`bot-detail.page.ts:413` y `:982`, `chart.page.ts:1489`), así que las dos
  fases van en un commit
- [x] `trader/`, `strategies/ai-trader*`, `dimension.ts`, `ia-trader.ts` y el test del replay, borrados
- [x] `shared`, `canal/`, `ai-channel`, registro, `index.ts`, backtest y worker restaurados a `970c31c`
- [x] `bot-runner.ts` leído entero antes de restaurarlo: su única mención del bot era la frase de
  `REANCHOR_NO_APLICA`; todo lo demás cuelga de *flags* de la estrategia
- [x] `strategies.spec.ts`, `warnings.ts` y `warnings.spec.ts` a mano
- [x] `schema.prisma` restaurado y la migración `20260924120000_retirar_ai_trader` escrita
- [x] `solo-admin.spec.ts` restaurado
- [x] `pnpm build:packages` y `pnpm test`: **8.219** en verde — shared 202 (−10), strategy-core 813
  (−112, las siete suites del bot), exchange-core 517, worker 621, backtest 74 (−3), API 5.992
- [x] Compilados viejos de los ficheros borrados quitados de `dist/` (no están en git)

## Fase 4 — La migración, probada

- [x] Base temporal `crypton_mig_072` en el contenedor local, con las 27 migraciones anteriores
  aplicadas con `psql` en orden; sin leer ningún `.env`
- [x] Caso (a): un bot real de `AI_TRADER` en `RUNNING` → aborta con *«Hay 1 bot(s) reales de
  AI_TRADER sin parar…»*; el enum, el bot y su evento siguen igual
- [x] Caso (b): el real ya `STOPPED` y uno simulado en `RUNNING` → borrados con sus eventos; sus dos
  backtests (uno con bot y otro suelto) y su fila del ranking, también; el de rejilla y el del canal,
  intactos con los suyos; el enum sin el valor, las tres columnas con el tipo nuevo, sin restos de
  `StrategyKind_old` y con los cinco índices de `bots`
- [x] De propina, por un fallo del guion de prueba: sobre una base **sin** filas del bot la migración
  también sale limpia, que es el caso real de la base local
- [x] Base temporal borrada. La base `crypton` del usuario no se tocó: sigue en
  `20260917120000_canal_ia` y **nunca aplicó** la migración que añadía el valor

## Fase 5 — Guías y specs

- [x] `docs/ai-trader.md` borrado; cuatro guías restauradas; `README.md` y `CLAUDE.md` a mano (`2b8f7ad`)
- [x] Aviso de retirada en 068, 069, 070 y en la primera parte del 071
- [x] CA-1: `git grep` limpio fuera de `specs/` y de las migraciones. La única coincidencia es
  `typesafe-path` en `pnpm-lock.yaml`, una dependencia de `@volar/kit` (herramientas de Astro) que no
  tiene nada que ver: TypeSafe se llamaba con `fetch`, sin paquete
- [x] CA-2: `git diff 970c31c` de los 35 ficheros restaurados, **vacío**

## Cierre

- [x] `pnpm lint` (0 errores; los 3 avisos de la API son anteriores), `check:env`, `check:labels`
- [x] Tipado de la app y de la API; builds de la API, el worker y la app (con presupuestos)
- [x] Criterios de aceptación: CA-1 a CA-4 cumplidos; CA-5 es del usuario
- [x] Índice de `specs/README.md` actualizado
- [x] Memorias de los specs 068-071 al día
- [x] Merge a `main`

## Visto de paso, fuera de alcance

- `strategies.spec.ts` conserva un comentario del 071 que dice que la puerta de régimen del Market
  Maker V2 «se entrega apagada». Desde `8e0ecf1` viene encendida de fábrica (`EVITA_TENDENCIA`), así
  que la V2 sí pide velas de fábrica. No es del bot y no se toca aquí.

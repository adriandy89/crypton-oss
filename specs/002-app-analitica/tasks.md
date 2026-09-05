# 002 — Tareas

Una casilla por tarea, agrupadas por fase. Se marcan al terminar, con una nota corta si hubo
sorpresas. Nada se da por hecho sin la verificación de su fase.

## Fase 0 — Línea base

- [x] `main` avanzado a `8860625` (fast-forward desde `spec/001-revision-integral`); el 002 parte de ahí
- [x] Rama `spec/002-app-analitica` creada desde `main` limpia (`8860625`)
- [x] `pnpm build:packages` — `shared` compilado para los consumidores de `dist/`
- [x] `pnpm test` (sin e2e) — paquete a paquete; seis rojos conocidos del 001, anotados en `findings.md`
- [x] `pnpm lint` — 0 errores
- [x] `pnpm check:env` — OK (API 34 variables, worker 28; este spec no toca ninguna)

## Fase 1 — Revisión de la interfaz (U-1 … U-10)

- [x] U-1 Coherencia de la métrica de riesgo entre las cuatro pantallas — F-01, F-02
- [x] U-2 Campos del contrato compartido que la API no rellena — F-01, F-03
- [x] U-3 Deriva entre las tres definiciones de `BotSummary` — F-04
- [x] U-4 Formateo de cifras de dinero — F-06
- [x] U-5 Aritmética de dinero frente al invariante 1 — F-07
- [x] U-6 Coste de refresco por evento SSE — F-05
- [x] U-7 Constantes del motor sin traducir — F-08
- [x] U-8 Vocabulario de niveles y estados entre pantallas — F-09
- [x] U-9 Datos servidos y no consumidos — F-10, F-11
- [x] U-10 Jerarquía y densidad de las pantallas clave — sin ficha propia: se resuelve en el rediseño (fase 5)
- [x] Catálogo de propuestas (R-4), ordenado por valor entre coste — P-01..P-14 en `findings.md`
- [x] Tabla de specs de seguimiento — 003 y 005 ya redactados en borrador

## Fase 2 — Maquetas

Lienzo: <https://claude.ai/code/artifact/c95f3af8-da35-4cd9-b3ff-d1e4edfd6465>
Fuentes en el scratchpad de la sesión (`design-002/*.dc.html`), fuera del repositorio.

- [x] Detalle del bot: resumen rediseñado con curva, ciclos y coste
- [x] Cartera: capital frente a exposición, riesgo agregado, reparto
- [x] Lista de bots: miniserie y orden por riesgo
- [x] Gráfico: jerarquía de etiquetas y medidor de liquidación
- [x] Escalera: como escalera, no como lista
- [x] Hoja de componentes nuevos con sus estados
- [x] Aprobación del usuario — 2026-09-05

## Fase 3 — Aritmética y componentes

- [x] `packages/shared/src/series.ts` + `series.spec.ts` — 27 tests; 40 tras la revisión de código
- [x] `muestreoPorExtremos` promovido desde `packages/backtest/src/metrics.ts` — y F-12 anotado: no tenía test
- [x] `metrics.ts` llama a la versión de `shared`; **sus specs pasan sin modificarlos** (24)
- [x] `ui-spark.component.ts` y `ui-meter.component.ts`
- [x] `bot-series.ts`. `series-to-candles.ts` **no se escribe**: su único consumidor sería la pantalla de backtest, fuera de alcance
- [x] tests por paquete en verde salvo los seis rojos conocidos del 001

## Fase 4 — Arreglar lo que miente

- [x] `liquidationDistancePct` y `totalInvestment` rellenados en `metricsOf` — `bots-metrics.spec.ts`
- [x] Las cuatro pantallas leen ese campo; se borran los tres cálculos locales
- [x] «Capital asignado» y «exposición» separados en la cartera
- [x] Refresco del detalle agrupado a 1500 ms
- [x] Revisión del asistente: formateo y acumulados
- [ ] Comprobado a mano: el mismo número en las cuatro pantallas

## Fase 5 — Rediseño, una pantalla por commit

- [x] Detalle del bot
- [x] Cartera
- [x] Lista de bots
- [x] Gráfico — jerarquía de rótulos del eje y barra de liquidación; el veredicto de mercado espera a su endpoint (fase 6)
- [x] `pnpm --filter app build` dentro de presupuesto (queda el aviso previo de `bot-detail.page.scss`)

## Fase 6 — Backend de apalancamiento

- [x] `spark` y `totalInvestment` en `GET /bots`, con test (`BotSeriesService`, 11 tests)
- [x] Rango temporal en `GET /bots/:id/snapshots`, con test — y `GET /market-data/features` con 3 tests
- [x] Ninguna lista hace N peticiones para pintar N miniseries: viajan en la respuesta del listado

## Revisión de código de la primera tanda

Segunda lectura de todo lo añadido por el spec, documentada en `findings.md` (R-01..R-15).

- [x] Lo que mentía o rompía: rango 4× (R-01), hueco fijo (R-02), distancia congelada (R-03) y sin precio vivo en el gráfico (R-04), altura de barras (R-08), `aria-valuemax` (R-09) — `13055fb`, `2c001e3`, `76aa64f`
- [x] Duplicados: semáforo (R-05), agrupación de eventos (R-06), rasgos de mercado (R-07), analítica sin test (R-14)
- [x] Coste y detalles de pantalla: refresco de la serie y carrera de rango (R-10), ROI/reparto ocultos y distancia en plantilla (R-11), decimales del asistente (R-12), guarda y 400 del rango (R-13), miniseries (R-15)
- [x] Verificación: `shared` 54, `backtest` 24, `worker` 254 (+2 rojos del 001), `api` 4184, `ng build`, lint de app y API limpios

## Cierre

- [x] Preguntas abiertas resueltas (F-04 atado entero, F-07 Media, F-11 borrado) — `e64f065`
- [x] Criterios de aceptación repasados uno a uno — CA-1, CA-2, CA-5, CA-7, CA-8 cumplidos; CA-4 y CA-9 cumplidos paquete a paquete (la raíz se detiene en los rojos del 001); CA-6 con el aviso previo al spec de `bot-detail.page.scss`; **CA-3 pendiente** de la comprobación manual con un bot simulado
- [ ] Índice de `specs/README.md` a `hecho` — cuando CA-3 esté comprobado y el usuario apruebe las maquetas
- [x] `CLAUDE.md` actualizado — `series.ts` en el mapa de `packages/shared`
- [x] Memoria de usuario actualizada

# 080 — Tareas

## Fase 0 — Línea base

- [x] Rama `spec/080-roi-y-revision-profesional` desde la del 079
- [x] Línea base: la del 079 (`findings.md`)

## Fase 1 — Una sola liquidación

- [x] `precioLiquidacion` y `distanciaLiquidacion` son las únicas; fuera `estimateLiquidationPrice` y `maxLeverageWithinDistance`
- [x] `maxApalancamientoConDistancia` por lado, en `validateCommon`, `RiskService` y el asesor
- [x] Fuera las copias del 0,5 % plano: app, asesor, supervisor y backtest
- [x] Simulador con el mantenimiento de cada mercado (P-6)

## Fase 2 — El motor en ROI

- [x] `roi.ts` en `shared`, y en `liquidation.ts` `stopMaximoRoi`, `perdidaEnLiquidacionPct` y `HOLGURA_LIQUIDACION`
- [x] `takeProfitPrice` y `stopLossPrice` con apalancamiento
- [x] `withStopLoss` con el apalancamiento del stop y su aviso; runner y backtest
- [x] Martingala, TDCA, seguimiento y GridMart (y fuera el `takeProfitPct` de GridMart)
- [x] Validaciones: stop frente a liquidación, objetivo en corto, retroceso exacto, escalera por niveles
- [x] Valores de fábrica convertidos

## Fase 3 — API

- [x] Asesor en ROI, sin `MAX_SAFE_LEVERAGE`
- [x] Supervisor: ROI, apalancamiento bloqueado con posición, stop ceñido
- [x] `START` valida; apalancamiento con posición rechazado; nocional del MM

## Fase 4 — Previsualización y Revisión

- [x] `PreviewResult` por lados, con `buildPreview` nuevo y `recorridoPeorCaso`
- [x] Correcciones por estrategia (F-02, F-05, F-10 a F-15, F-21 a F-24)
- [x] Pantalla Revisión, medidor de riesgo, recomendaciones y titular del asesor

## Fase 5 — Formulario

- [x] Equivalente en precio en cada campo ROI
- [x] Botón «Usar el stop más ancho válido»
- [x] Avisos de los límites en `Decimal` (F-25; hecho con la fase 4)

## Fase 6 — Migración

- [x] `migration.sql`
- [x] Probada en una base temporal: casos A, B y C, y por Prisma

## Fase 7 — Textos

- [x] `field-labels.ts`, `common-options.ts`, guías, `mensajes.ts`
- [x] F-29, encontrado durante el 080: un campo opcional vacío revienta `validate`, `preview` y `plan`
- [x] `docs/` y `README.md`

## Fase 8 — Lo que salió al rehacer las guías (F-30 a F-37)

- [x] Dos regresiones del 080: la escalera a precio cero a 1× y el aviso de liquidación a 1× en largo
- [x] El margen de cada nivel es el nocional entre el apalancamiento (F-34)
- [x] La previsualización del DCA aplica sus topes (F-30)
- [x] Las fichas dicen el valor de fábrica de `defaults()` (F-35)
- [x] Textos de la app y comentarios desfasados (F-36, F-37)
- [x] El tope en la Revisión de martingala, GridMart y rejillas, y en la validación de la escalera (F-30)
- [x] La rejilla neutral: tope por lado en `plan()`, validación contra el corto y tope por lado (F-31, F-32)
- [x] La tendencia no entra con el stop detrás de la liquidación (F-33)
- [x] Las cifras de todas las guías, vueltas a calcular con el código del 080 (CA-6)

## Cierre

- [x] CA-1 a CA-4 y CA-6 repasados
- [x] Índice de `specs/README.md`, memoria
- [ ] CA-5, del usuario: crear en la app el bot de la captura y ver la Revisión nueva

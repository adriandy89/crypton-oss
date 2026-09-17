# 061 — Tareas

## Fase 0 — Línea base

- [x] Rama `spec/061-grafico-carga-e-indicadores` desde `main` (`651ced6`), limpio
- [x] Línea base heredada del cierre del 060: 8073 tests, lint sin errores, `check:env` y las tres
      compilaciones en verde

## Fase 1 — La matemática

- [x] `packages/strategy-core/src/indicadores-vista.ts`: claves, catálogo `Record` completo y
      `lineasDeIndicador`
- [x] `indicadores-vista.spec.ts` con cifras a mano
- [x] Exportado en `packages/strategy-core/src/index.ts`
- [x] `pnpm test:strategies`, `pnpm --filter worker test`, `pnpm test:backtest`

## Fase 2 — Carga visible

- [x] Entrada `cargando` y regla esqueleto/velo en `price-chart.component.ts`
- [x] `cargandoVelas` en `chart.page.ts`, con su `finally`
- [x] Sin velas de un intervalo bajo la etiqueta de otro

## Fase 3 — Indicadores

- [x] Series de precio (Bollinger, media 50, media exponencial 20)
- [x] Panel propio del RSI y del ATR, excluyentes, con el orden de paneles normalizado
- [x] Colores en `chart-theme.ts` y guías del RSI
- [x] Sección «Indicadores» en la hoja de ajustes

## Fase 4 — Que se recuerde

- [x] `chart-prefs.service.ts` con su clave, su versión y su validación defensiva
- [x] La hoja lee y escribe: indicadores, tipo, volumen, resultado y capas

## Cierre

- [x] CA-1, CA-2 y CA-3 repasados
- [x] Verificación completa: 8083 tests en verde (shared 201, strategy-core 768, exchange-core 482,
      worker 580, backtest 64, API 5988), lint sin errores, `check:env` coherente, y el lint y la
      compilación de la app dentro de presupuesto
- [x] Índice de `specs/README.md`
- [x] Memoria de usuario
- [ ] **CA-4 y CA-5 pendientes del usuario**: el guion a mano sobre el gráfico de un bot simulado y
      los tres gráficos del backtest

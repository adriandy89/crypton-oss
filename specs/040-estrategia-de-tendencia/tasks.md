# 040 — Tareas

## Fase 0 — Línea base

- [x] Rama desde `main` con 037, 038 y 039 mergeados
- [x] `pnpm test` verde

## Fase 1 — Indicadores

- [x] `rangoVerdadero`, `atr`, `donchian` puros en `indicadores.ts`
- [x] 11 tests contra cifras calculadas A MANO, no contra la implementación
- [x] El canal excluye la vela que rompe, con su test

## Fase 2 — La estrategia

- [x] `trend-follow.ts`: entrada por ruptura, filtro de eficiencia, tamaño por riesgo,
      stop por ATR con seguimiento
- [x] `Strategy.candles` pasa a ser función de la configuración (corrige el 038)
- [x] `makeContext` acepta velas
- [x] Registro, export del tipo, `StrategyKind`
- [x] 25 tests propios

## Fase 3 — Base de datos

- [x] Valor `TREND_FOLLOW` en el enum de Prisma
- [x] Migración `20260911120000_strategy_trend_follow`
- [x] `pnpm prisma:deploy` la aplica (PostgreSQL 18.6, sin tocar ninguna fila)

## Fase 4 — Asesor

- [x] `buildTrend` en `advisor/build.ts`
- [x] La estrategia entra en la batería exhaustiva y en la de «los tres perfiles se distinguen»

## Fase 5 — App

- [x] Unión `StrategyKind`, etiqueta y descripción
- [x] Etiquetas de campo
- [x] `trend-follow.guide.ts` — el tipo exige una ficha por campo
- [x] `ng build` limpio

## Fase 6 — Cierre

- [x] `docs/trend-follow.md` + filas en `docs/README.md` y `README.md`
- [x] Aviso de paridad del backtest (el trailing se mueve una vez por vela)
- [x] Las menciones a «las siete estrategias» pasan a ocho en código, guías y web
- [x] `pnpm test` · `pnpm lint` (0 errores) · `ng build`
- [x] Índice de `specs/README.md`
- [ ] **CA-14 pendiente del usuario**: bot simulado, stop condicional nativo y trailing que
      nunca retrocede
- [x] Memoria de usuario

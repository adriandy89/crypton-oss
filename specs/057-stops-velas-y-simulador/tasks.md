# 057 — Tareas

## Fase 0 — Línea base y spec

- [x] Rama `spec/057-stops-velas-y-simulador` desde `main` (`3f03d43`)
- [x] Línea base: 7216 tests, lint sin errores (3 avisos previos), `check:env`, builds y `tsc` de la
      API en verde
- [x] `spec.md`, `findings.md` y fila del índice

## Fase 1 — Los stops (F-01, F-02)

- [x] F-01: test en rojo en `reconcile`, y el arreglo; Aster, Lighter y el simulador informan del
      disparo
- [x] F-02: test en rojo en Tendencia, y el arreglo; guarda en el runner

## Fase 2 — Velas, backtest y simulador (F-03, F-04, F-05)

- [x] F-03: test en rojo en `market-data.spec.ts`, y el arreglo
- [x] F-04: test en rojo en `engine.spec.ts`, y el arreglo (agregación en `shared/candle.ts`)
- [x] F-05: test en rojo (en `exchange-core.spec.ts`, junto al resto del simulador), y el arreglo

## Fase 3 — Motor y adaptadores (F-06 a F-11)

- [x] F-06: test en rojo en el runner, y el arreglo
- [x] F-07, F-08, F-09, F-10, F-11: test en rojo y arreglo, uno por commit

## Fase 4 — Verificación y cierre

- [x] Verificación completa (7280 tests) y mutaciones (28 de 28 caen)
- [x] Guías que citen lo corregido
- [x] Estado del spec y del índice; memoria
- [ ] CA-4 (manual, opcional): reemplazos de `STOP_LOSS` en producción antes y después
- [ ] Despliegue (worker y API, luego la app), cuando el usuario lo apruebe

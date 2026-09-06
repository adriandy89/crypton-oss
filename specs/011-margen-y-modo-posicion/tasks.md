# 011 — Tareas

## Fase 0 — Línea base

- [ ] Rama `spec/011-margen-y-modo-posicion` desde la última rama de spec
- [ ] `pnpm build:packages`; baterías en verde

## Fase 1 — F-71 (veto de HEDGE en Aster)

- [ ] Decisión del usuario: vetar (recomendado) o implementar `positionSide`
- [ ] Test rojo · diff · commit

## Fase 2 — F-34 (`AccountHandle`)

- [ ] Test rojo: `paper-accounts.spec.ts` «el handle expone adjustIsolatedMargin»
- [ ] Diff: reexponer `adjustIsolatedMargin` y `setPositionMode`; `adjustMargin` y `positionMode` los usan · commit

## Fase 3 — API

- [ ] Test rojo: `total_investment` no cambia sin acuse del worker
- [ ] Diff · commit

## Fase 4 — F-08 (idempotencia)

- [ ] Test rojo: «un comando en ejecución no se desreclama»; «ADD_SAFETY_NOW no se ejecuta dos veces»
- [ ] Diff · commit

## Cierre

- [ ] Criterios de aceptación repasados
- [ ] Bloques F-34, F-71, F-08 fuera de `docs/`; fichas del 001
- [ ] Índice de `specs/README.md`
- [ ] Memoria de usuario

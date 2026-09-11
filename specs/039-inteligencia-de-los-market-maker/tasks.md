# 039 — Tareas

## Fase 0 — Línea base

- [x] Rama desde `main` con 037 y 038 mergeados
- [x] `pnpm test` verde: strategy-core 333, api 4317, worker 332, exchange-core 379

## Fase 1 — Las piezas puras

- [x] `microprecio`, `desequilibrio`, `centroSesgado`, `fundingBps`, `factorDeTamano`
- [x] `anotarFill`, `resolverMarkout`, `penalizacionMarkout`
- [x] `deriva` + estimador de Parkinson en `sampleVolatility`
- [x] `mm-inteligencia.spec.ts` — 34 tests numéricos
- [x] El test de Parkinson dice explícitamente qué NO demuestra

## Fase 2 — Campos y grupo

- [x] `INTEL_FIELDS` / `INTEL_DEFAULTS` en `mm-shared`, una sola vez para las dos
- [x] Grupo `intelligence` en `FieldGroup`, en el orden del formulario y en el panel de ayuda
- [x] Etiquetas en `field-labels.ts`

## Fase 3 — Cableado

- [x] V1: `centroDeMercado`, funding, tamaño, markout, filtro de funding, `onFill`
- [x] V2: lo mismo + sesgo de inventario, filtro de tendencia, estimador
- [x] **Los 367 tests anteriores siguen pasando sin tocarlos** (R-10)

## Fase 4 — Conducta

- [x] 16 tests de `plan()`, uno por mando, encendido y apagado
- [x] Un test escrito al revés encontró que en una rampa bajista quien pelea contra la tendencia
      es la COMPRA, no la venta

## Fase 5 — Guías

- [x] `GuideOptions<C>` exige una entrada por campo: el build de la app lo cazó
- [x] `docs/market-maker.md` §5.7 y `docs/market-maker-v2.md` §5.8
- [x] Tabla de valores de fábrica de la V2 y comparativa V1/V2 al día

## Cierre

- [x] `pnpm test` · `pnpm lint` (0 errores) · `ng build` (0 errores)
- [x] Índice de `specs/README.md`
- [ ] **CA-14 pendiente del usuario**: dos MM V2 simulados, uno con microprecio y otro sin él
- [x] Memoria de usuario

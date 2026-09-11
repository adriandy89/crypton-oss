# 035 — Tareas

## Fase 1 — El test que falla primero

- [x] `packages/strategy-core/src/strategies/mm-ejecucion.spec.ts`: harness `recorrer()`, onda
      triangular determinista y rampa monótona
- [x] CA-1 (V2 de fábrica) y CA-2 (V1 de fábrica) — **fallan**, y por el motivo correcto
- [x] CA-3 (propiedad con rampa), CA-4 (refresco por tiempo), CA-5 (tráfico)

## Fase 2 — El arreglo

- [x] `mm-shared.ts`: `precioEstable` asimétrica, con el incidente en el comentario
- [x] `market-maker.ts`: pasar `side` en las dos llamadas
- [x] `market-maker-v2.ts`: mapa de órdenes vivas y envolver los dos precios
- [x] CA-8: el precio conservado es byte a byte el de la orden viva
- [x] `pnpm test:strategies`, `pnpm --filter worker test`, `pnpm test:backtest`, typecheck de la app

## Fase 3 — Que no vuelva a pasar

- [x] Aviso de `validate()` en las dos estrategias, solo en lo patológico (R-4)
- [x] Valores de fábrica de la V2: distancia 40→20, edad 120→300 (R-5)
- [x] Asesor: horizonte de 5 min y sin doble conteo (R-6); `pnpm --filter api test`

## Fase 4 — Validación cruzada

- [ ] `packages/backtest/src/mm-cadencia.spec.ts` contra el `DryRunAdapter` real (CA-6) — **no hecho**: el caso del worker ya ejercita el simulador real de punta a punta, y el harness puro cubre las 24 h. Queda como refuerzo, no como red que falte.
- [x] Un caso más en `bot-runner.strategies.spec.ts` (CA-7)

## Fase 5 — Lo que el usuario lee

- [x] La nota imprime el diferencial aplicado, no el previo al techo (R-7)
- [x] «En mercado» → «Con posición»
- [x] `docs/market-maker{,-v2}.md` y las guías de la app: qué mueve y qué no mueve una cotización
- [x] Matizar el aviso del backtest (`warnings.ts:76-81`)

## Cierre

- [x] Criterios repasados uno a uno (CA-10 es manual del usuario)
- [x] `findings.md` con lo que queda abierto
- [x] Índice de `specs/README.md`

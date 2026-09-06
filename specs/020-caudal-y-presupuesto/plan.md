# 020 — Plan

## Enfoque

Protocolo de `specs/README.md`: test en rojo primero, diff mínimo, dos commits (la prioridad de escritura y
las guardas de Lighter; el cupo de órdenes de Aster con su realimentación, que comparte fichero con la
prioridad de Aster). Todo en `exchange-core`: el motor y la API consumen `VenueBudget` a través de la
interfaz y no cambian.

Decisiones de diseño tomadas aquí:

- **F-10 (prioridad)**: `call()`/`signedRequest()` reciben la prioridad en vez de duplicar los envoltorios.
  Las cancelaciones siguen reintentándose (son idempotentes); solo cambia por qué parte del depósito entran.
- **F-10 (Lighter sin símbolo)**: se rechaza en vez de paginar. Ningún consumidor (motor ni API) llama sin
  símbolo, y paginar 216 peticiones firmadas bajo un cupo de 60 por minuto sería «correcto» durante casi
  cuatro minutos de silencio.
- **F-10 (`SignerClient`)**: cada escritura ya descontaba una petición antes de firmar (`sendTx`); se añade la
  del `nextNonce` que el SDK hace al releer el contador. No se envuelve el HTTP del SDK: es el que firma.
- **F-24**: un depósito de fichas con caudal 17/s y capacidad 85, derivado de los dos límites con el margen
  (`capacidad + 10 × caudal ≤ 300 × 0,85`). Un solo depósito con ráfaga de 300 dejaba pasar 470 en diez
  segundos. Se cuenta por IP, más conservador que por cuenta. Métodos opcionales en la interfaz para que
  `NO_BUDGET` y los dobles de test sigan valiendo.
- **F-76**: `observe` solo **recorta** (nunca amplía) y no espera a Redis: es una pista, no una puerta. Se
  lee en `http()` para cubrir todas las respuestas de Aster de una vez.

## Ficheros afectados

| Fichero | Qué cambia | Tests | Commit |
|---|---|---|---|
| `exchange-core/src/adapters/hyperliquid.ts`, `lighter.ts` | `call(fn, weight, priority)`; cancelaciones, apalancamiento y `modify` con `write`; Lighter exige símbolo y cuenta el nonce | `hyperliquid.spec.ts`, `lighter-transport.spec.ts` | `a407ca3` |
| `exchange-core/src/venue-budget.ts`, `venue-weights.ts`, `adapters/aster.ts` | `ASTER_ORDER_QUOTA`, `takeOrders`, `observe`, `CLAMP_SCRIPT`; cabeceras; prioridad de escritura | `exchange-core.spec.ts`, `aster.spec.ts` | `788a02c` |
| `docs/venues-y-minimos.md` | tabla de cupos y detalles de diseño | enlaces | cierre |

## Verificación

```bash
pnpm test:adapters && pnpm build:packages && pnpm --filter worker test -- --forceExit && pnpm --filter api test
pnpm lint && pnpm check:env
```

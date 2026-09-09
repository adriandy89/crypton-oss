# 031 — Tareas

## Fase 1 — Las comprobaciones manuales pasan a ser tests

- [x] El harness de estrategias acepta otro mercado, otro precio y otra horquilla, y su fuente
      publica la salud del stream
- [x] `MemoryStore` guarda el evento entero (`eventLog`), no solo el tipo: hacía falta para mirar el
      motivo de un rechazo
- [x] Market maker cargado: ni un rechazo post-only, y ninguna orden viva cruza el libro
- [x] Ancla por debajo del libro: la venta se pega al toque en vez de salir cruzada
- [x] Caída del stream anunciada una vez, y su vuelta también
- [x] «Cantidad de moneda» en un par caro (BTC a 100.000): la config vale, el bot arranca y sus
      órdenes miden 0,002 BTC
- [x] **Verificado que fallan sin el arreglo**: con el clamp desactivado y `pnpm build:packages`
      hecho, los dos primeros fallan con `QUOTE_ASK#0 SELL ... Post-only rechazada: cruzaría el libro`

      La trampa que costó una hora: el worker consume `strategy-core` desde `dist`. Sin recompilar,
      el test pasaba igual con el arreglo desactivado y parecía que el escenario no servía. Antes de
      dar por bueno un test de integración hay que compilar.

## Fase 2 — La saturación del presupuesto deja de ser invisible

- [x] `avisarSiElLatidoSeEstira`: un tick más largo que su intervalo emite `TICK_SLOW` (WARN), con
      enfriamiento de 15 min
- [x] Etiquetas del evento en la app
- [x] Test: no avisa por debajo del umbral, avisa una sola vez por encima

## Fase 3 — El enfriamiento por corte del venue es de proceso

- [x] `VenueCooldown` comparte estado por venue; `reset()` para los tests
- [x] `jest.setup.ts` de `exchange-core` lo olvida antes de cada caso, para que un test nuevo no
      herede la trampa
- [x] El test del veto de IP se reescribe conservando su intención (un 418 castiga más que un 429)
- [x] Tests nuevos: dos cuentas del mismo venue comparten el corte; venues distintos, no

## Fase 4 — Recotizado por capa

- [x] `precioEstable()` en `mm-shared.ts`: se conserva el precio de la orden viva mientras el desvío
      no supere el 25 % de la distancia de esa capa
- [x] Aplicado en la V1, **antes** del clamp y del dimensionado (con el precio viejo sale la cantidad
      vieja, y así la orden coincide entera y `reconcile` no la reemplaza)
- [x] Tres tests: se conserva, se recoloca, y la tolerancia es proporcional

## Fase 5 — El stop de los market makers

- [x] **No** se cambia el valor de fábrica. Razón: el stop cierra la posición pero NO para el bot,
      que vuelve a cotizar; uno estrecho en un market maker es una máquina de vender en el mínimo y
      recomprar. Su red natural es el tope de posición y la acción al alcanzarlo.
- [x] `validate()` de las dos estrategias avisa cuando no hay stop, explicando eso mismo
- [x] Tests, incluido uno que fija que los `defaults()` siguen sin `stopLossPct`

## Verificación

- [x] `pnpm test`: **5 334 en verde** (strategy-core 300, exchange-core 365, worker 326, api 4 220,
      shared 92, backtest 31)
- [x] `pnpm lint` sin errores (3 avisos preexistentes en `apps/api`)
- [x] Typecheck y `ng lint` de la app

## Cierre

- [ ] Índice de `specs/README.md`
- [ ] Merge a `main`

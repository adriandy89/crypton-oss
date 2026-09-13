# 050 — Plan

## Enfoque

Separar en `onTickError` **de quién es el fallo**. La clasificación ya existe (`ExchangeError.kind`)
y solo le faltaban dos cosas:

- reconocer los fallos de red que el SDK de Hyperliquid envuelve (`fetch failed`, `cause.code`,
  `HTTP 5xx`);
- un predicado con nombre, `isVenueUnavailable`, que el motor y el simulador compartan.

Con eso, la guarda de ticks tiene dos contadores dentro de la misma racha:

- **Caída del venue.**
  - Nunca pausa.
  - Avisa al tercer fallo con `VENUE_UNAVAILABLE` y deja el texto en `last_error`, sin tocar el
    estado.
  - Recuerda cada 30 min y anuncia la vuelta con `VENUE_RECOVERED`, igual que `STREAM_RECOVERED`:
    solo si se anunció la caída.
- **Fallo propio.** Pausa a los 5, como siempre, con un `TICK_ERROR` por racha (y otro si cambia el
  motivo) en vez de uno por tick.

El latido deja de encolar ticks detrás de uno lento con una bandera, el mismo patrón que
`tickScheduled`. Durante una caída los ticks del temporizador se espacian con un tope de 60 s. Los
comandos y `requestTick` no pasan por ahí, así que un PANIC no espera a nadie.

Alternativas descartadas:

- **Pausar y reanudar solo al volver.** La pausa cancela escalera y take profit, que es justo lo que
  no se quiere tocar durante un corte. Además la cancelación falla igual con el venue caído.
- **Subir el umbral de 5 a N.** Solo desplaza el problema: una caída de 10 min volvería a pausarlo
  todo.
- **Cortacircuitos por venue compartido entre bots.** Toca el camino del PANIC. Queda fuera de
  alcance.
- **Pasar los simulados por `MarketDataService`.** El simulador casa órdenes con los precios que
  recibe (`account-hub.service.ts:714-719`), y sacarlo de ahí ya rompió la simulación una vez. Se
  hace lo mismo que el feed real (20 s de tolerancia) dentro del propio simulador.

## Ficheros afectados

| Fichero | Qué cambia | Tests que lo cubren |
|---|---|---|
| `packages/exchange-core/src/errors.ts` | Patrón de red y 5xx, `cause.code`, `isVenueUnavailable` | `exchange-core.spec.ts` |
| `packages/exchange-core/src/adapters/dry-run.ts` | `getTicker` recurre al último precio reciente | `exchange-core.spec.ts` (DryRunAdapter) |
| `packages/exchange-core/src/adapters/lighter.ts` | `publicGet` con `AbortSignal.timeout` | `lighter.spec.ts` |
| `packages/exchange-core/src/adapters/aster.ts` | `http` con `AbortSignal.timeout` | `aster.spec.ts` |
| `packages/exchange-core/src/index.ts` | Exporta `isVenueUnavailable` si hace falta | — |
| `apps/worker/src/engine/bot-runner.ts` | Guarda de ticks, latido, `TICK_SLOW`, nota de protección, `esperandoAlVenue` | `bot-runner.spec.ts` |
| `apps/worker/src/engine/bot-store.ts` | `setLastError(botId, texto \| null)` | `bot-runner.spec.ts` (doble) |
| `apps/worker/src/engine/engine.service.ts` | `stalledRunners` excluye a quien espera al venue | `engine.service.spec.ts` o `health` |
| `apps/worker/src/notifications/notifier.service.ts` | `EVENT_PREF` e `ICON` de los tipos nuevos | `notifier.service.spec.ts` |
| `apps/app/src/app/core/utils/labels.ts` | Etiquetas de los tipos nuevos | typecheck de la app |
| `docs/riesgo-y-liquidacion.md`, `docs/comandos-guardas-y-eventos.md` | Conducta nueva | — |

## Fases

| Fase | Qué | Criterio de salida |
|---|---|---|
| 0 | Línea base: rama, build, tests, lint, check:env | Verde o rojos conocidos anotados |
| 1 | R-1 y R-8 en exchange-core | Tests nuevos rojos primero, luego verdes; `pnpm test:adapters` |
| 2 | R-4 en el simulador | Ídem; `pnpm test:backtest` sigue verde |
| 3 | R-2, R-3 y R-5 en el runner, más `setLastError` | Tests nuevos; `pnpm --filter worker test` |
| 4 | R-6 y R-7 | Tests del notificador y de la salud; typecheck de la app |
| 5 | R-9 docs, índice de specs, memoria | Estado `hecho` salvo CA-10 |

## Verificación

- Desde Git Bash:
  - `pnpm build:packages`
  - `pnpm test:adapters`, `pnpm test:strategies`, `pnpm test:backtest`
  - `pnpm --filter worker test`, `pnpm --filter api test` (arranque del spec 049)
  - typecheck de la app
  - `pnpm lint`, `pnpm check:env`
- **Romper cada salvaguarda a propósito** y ver caer su test (lección del 046): la rama de caída de
  `onTickError`, la bandera del latido y el colchón del simulador.
- **Manual (CA-10):** reanudar los tres simulados pausados y observar la siguiente caída real.
- Ninguna sonda ni orden contra venues.

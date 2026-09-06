# 015 — Plan

## Enfoque

Protocolo de `specs/README.md`. Dos commits por venue: Lighter (F-05, una línea en el mapeo de `trades`) y
Aster (F-70, F-72, F-73, F-74, todos en el mismo adaptador y probados con el mismo doble de red). La
reconexión forzada se añadió a `ReconnectingSocket`, que Lighter comparte, porque cerrar el socket es lo
que ya dispara la vuelta con la URL reevaluada (y en Aster la URL pide el `listenKey` nuevo).

Alternativas descartadas:

- Marcar liquidación en el barrido REST de Aster (`userTrades`): no trae `clientOrderId` ni tipo; habría que
  cruzar cada `orderId` con `forceOrders`, una petición más por barrido. Queda anotado en la ficha.
- Tratar `deleverage` y `market-settlement` de Lighter como ejecuciones normales: los tres son cierres
  forzados y el motor tiene que pausar y avisar igual.

## Ficheros afectados

| Fichero | Qué cambia | Tests | Commit |
|---|---|---|---|
| `adapters/lighter.ts` (`getRecentFills`) | `Trade.type` ≠ `trade` → `liquidation: true` | `lighter-transport.spec.ts` | `70be23f` |
| `adapters/aster.ts` (`handleUserEvent`, `streamTicker`, `getRecentFills`, `openSocket`), `ws.ts` (`reconnect`) | liquidación por id/ejecución/estado; flujo combinado con marca; `listenKeyExpired` reabre; ventana de 7 días | `adapters/aster.spec.ts`, `streams.spec.ts` | `cfa50ac` |
| `docs/riesgo-y-liquidacion.md`, `docs/venues-y-minimos.md` | el aviso de F-05/F-70 pasa a describir la conducta nueva | grep | cierre |

## Verificación

```bash
pnpm --filter exchange-core test -- --forceExit
pnpm build:packages && pnpm --filter worker test && pnpm test && pnpm lint && pnpm check:env
grep -rn "F-05\|F-70\|F-72\|F-73\|F-74" docs/
```

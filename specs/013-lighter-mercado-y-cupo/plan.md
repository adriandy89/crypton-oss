# 013 — Plan

## Enfoque

Todo con el protocolo de `specs/README.md` (test rojo → diff → dependientes → lint → commit). El adaptador
de Lighter concentra siete de las correcciones, así que se agruparon en tres commits por afinidad y con sus
tests en `lighter-signer.spec.ts` (firmante falso) y `lighter-transport.spec.ts` (servidor REST local); la
clasificación de errores, la regex de `safely()` y el tope de órdenes van en commits propios porque viven en
otros ficheros.

Alternativas descartadas:

- `create_market_order_limited_slippage` del SDK para la holgura: el mismo resultado se consigue con el
  precio tope calculado aquí, que además es lo que ya hacían los disparadores a mercado.
- Rechazar en `validate()` las retículas de más de 30 líneas en Lighter: el tope depende del tier de la
  cuenta, que la app no conoce; se avisa en la vista previa.
- Implementar el stream de cuenta (F-54) en este spec: es una función nueva cuya forma de mensaje no se
  puede confirmar sin una conexión autenticada. Fase aparte.

## Ficheros afectados

| Fichero | Qué cambia | Tests | Commit |
|---|---|---|---|
| `exchange-core/src/errors.ts` | mensajes literales de Lighter (AUTH, INSUFFICIENT_FUNDS, RULES, RETRYABLE) | `errors.spec.ts` | `720031c` |
| `worker/src/engine/bot-runner.ts` (`safely`) | vocabulario de Lighter para «ya no existe» | `bot-runner.spec.ts` | `94a3316` |
| `exchange-core/src/adapters/lighter.ts` (`placeOrder`, `unwrap`) | holgura 5 %, acuse PENDING, IOC, THROTTLED con enfriamiento | `lighter-signer.spec.ts` | `4fafcea` |
| `shared/src/market.ts`, `strategy-core/src/common.ts`, catálogos de Lighter y Aster | `maxActiveOrders` y WARN de la vista previa | `strategies.spec.ts` | `2758f1e` |
| `lighter.ts` (`call`, `pollCall`, constructor, `signerReady`, `acuseSiYaEstaba`) | cabecera viva del SDK, duplicado → orden que ya está, nonce a cero se recarga | `lighter-signer.spec.ts`, `lighter-transport.spec.ts` | `93c5a8b` |
| `lighter.ts` (`toVenueOrder`, `resubscribePaced`, `onOpen`) | edad real de la orden, resuscripción en lotes | `lighter-transport.spec.ts` | `1e3c9a3` |

## Verificación

```bash
pnpm --filter exchange-core test && pnpm --filter strategy-core test
pnpm build:packages && pnpm --filter worker test && pnpm test:backtest
pnpm test && pnpm lint && pnpm check:env
grep -rn "F-47\|F-48\|F-49\|F-50\|F-5[1-6]\|F-16" docs/
```

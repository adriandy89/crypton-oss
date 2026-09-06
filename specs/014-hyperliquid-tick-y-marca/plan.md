# 014 — Plan

## Enfoque

Protocolo de `specs/README.md` (test rojo → diff → dependientes → lint → commit). El arreglo de F-04 se hizo
por la vía completa que proponía la ficha —`MarketSpec` lleva la regla y la única puerta de redondeo la
aplica— en vez de la mitigación (recorte en la dirección segura más un WARN por divergencia): con desired y
enviado calculados igual el problema desaparece, y el WARN sobraba. El resto del adaptador (marca, lado vacío,
enfriamiento, builder, acuse) se agrupó en un commit porque comparte el spec nuevo del adaptador, que sustituye
el SDK ESM por un doble.

Alternativas descartadas:

- Tolerancia del reconciliador distinta de medio tick: habría ocultado la divergencia en vez de eliminarla.
- Compartir el transporte WebSocket entre cuentas (F-27): cambia el modelo «un adaptador por cuenta» del
  `AccountHub`; se cuenta y se avisa.
- Avisar por log de una comisión de builder inválida: `exchange-core` no tiene logger; se omite el builder
  (el efecto es no cobrar la comisión, nunca rechazar la orden) y queda documentado.

## Ficheros afectados

| Fichero | Qué cambia | Tests | Commit |
|---|---|---|---|
| `shared/src/{market,precision}.ts` | `maxSignificantDigits`; `roundPriceForSide` lo aplica hacia el lado, enteros intactos | `precision.spec.ts` (nuevo) | `2088961` |
| `strategy-core/src/common.ts` (`px`) | pasa el tope del mercado a la puerta | `strategies.spec.ts` | `491103a` |
| `worker/src/engine/account-hub.service.ts` | aviso en la décima cuenta real de Hyperliquid | `paper-accounts.spec.ts` | `733ac67` |
| `exchange-core/src/adapters/hyperliquid.ts` | `formatPrice` por la puerta; `maxSignificantDigits: 5`; `getTicker`/`streamTicker` con `markPx`; lado vacío; `VenueCooldown`; tope del builder; guarda del acuse | `adapters/hyperliquid.spec.ts` (nuevo), `streams.spec.ts` | `82c4918` |
| `hyperliquid.ts` (`modifyOrder`) | precio por la puerta y tif conservado | `hyperliquid.spec.ts` | `225ea46` |

## Verificación

```bash
pnpm --filter shared test && pnpm --filter strategy-core test && pnpm --filter exchange-core test
pnpm build:packages && pnpm --filter worker test && pnpm test:backtest && pnpm --filter api test
pnpm test && pnpm lint && pnpm check:env
```

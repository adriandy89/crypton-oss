# 018 — Plan

## Enfoque

Protocolo de `specs/README.md`: test en rojo primero, diff mínimo, un commit por corrección (los que comparten
fichero van juntos y lo dicen en el mensaje). Cuatro commits de código: el ciclo continuo (contabilidad, motor
y backtest), la V1, la V2 con los tests de todo el spec, y el códec de copy-trading.

Decisiones de diseño tomadas aquí (los hallazgos de los market makers son filas de la tabla del 001, sin
ficha; el estado queda en la fila):

- **F-58 / F-62**: `Strategy.keepCycleOnFlat` en vez de arrastrar la memoria al ciclo nuevo. Arrastrarla no
  habría evitado el churn: el `clientOrderId` lleva el ciclo, y cambiar de ciclo obliga a cancelar y reponer
  todas las capas. Para un market maker el ciclo es la vida del bot; el PnL y `bot_mm_stats` no cambian, y las
  pantallas que cuentan ciclos enseñarán uno.
- **F-57**: la vista previa aplica `profile.size`; con eso `buildPreview` marca la capa bajo mínimo y la vista
  previa deja de ser válida. No se toca `validate()`: la regla ya vive en un sitio.
- **F-59 / F-64**: un tope por lado alcanzado cuenta como tope (misma acción al límite, nota «Tope
  largo/corto alcanzado»); cero o vacío es «sin tope propio»; `validate()` rechaza un tope menor que la
  cotización más pequeña. Se descartó tratar '0.40' como cero: el copiador debe saber que el número no vale.
- **F-60**: el techo se aplica en `plan()` tras los multiplicadores (`conTecho`); `composeSpreadBps` deja de
  caparlo y expone `capBps`. El suelo por coste sigue mandando y `validate()` avisa con techo 0.
- **F-61**: `scratch.quotedVolBps` fija la volatilidad de la última recotización. Se descartó muestrear en
  cada tick (una escritura por tick) y se descartó dejar de podar el anillo (cambiaría la medida).
- **F-63**: `fitToRoom` recibe `minNotional` y no coloca un resto por debajo. Se descartó ampliar la capa al
  mínimo: sería colocar más de lo que cabe en el tope.
- **F-15 (MM)**: la espera deja de exigir `quotedMid` (con ancla nunca se escribe). El valor de fábrica de
  `feeEstimateBps` **no** cambia (decisión del usuario, principio 6): se avisa al validar.
- **F-64 (códec)**: `expandFromShare` recibe el par del autor y los metadatos; a otro par no viajan los
  campos `price` ni `sourceSymbolOverride`. Al mismo par viajan intactos.
- **F-67**: aviso de deriva del ancla en la nota (sin evento aparte); textos de `direction`, `referencePrice`,
  `maxDynamicSpreadBps` y `activationMode`; el aviso del suelo distingue su causa. `VENUE_MARK ≡ VENUE_MID`
  en Hyperliquid dejó de ser cierto con el spec 014 (`markPx`). Exportar `venue-markets` (P-07) se acepta: dos
  specs lo importan por la raíz del paquete.

## Ficheros afectados

| Fichero | Qué cambia | Tests | Commit |
|---|---|---|---|
| `strategy-core/src/types.ts`, `cycle-accounting.ts`, `worker/.../bot-store.ts`, `bot-runner.ts`, `backtest/src/engine.ts` | `keepCycleOnFlat` | `cycle-accounting.spec.ts` | `544eda6` |
| `strategy-core/src/strategies/market-maker.ts` | preview con perfil; topes por lado; espera con ancla; suelo 15; nota de deriva | `strategies.spec.ts` | `ffb1a7c` |
| `strategy-core/src/strategies/market-maker-v2.ts` | techo tras multiplicadores; `quotedVolBps`; `fitToRoom` con mínimo; avisos | `strategies.spec.ts` | `3ecd1e4` |
| `api/.../leaderboard/share-codec.ts`, `leaderboard.service.ts` | par del autor; campos `price` y `sourceSymbolOverride` | `share-codec.spec.ts` | `76a1d5e` |
| `docs/{market-maker,market-maker-v2,buenas-practicas,neutral-grid}.md`, guías in-app, `field-labels.ts` | bloques fuera; conducta nueva | `comprobar-enlaces`, `comprobar-parametros` | cierre |

## Verificación

```bash
pnpm --filter strategy-core test && pnpm build:packages
pnpm --filter worker test -- --forceExit && pnpm test:backtest && pnpm --filter api test
pnpm --filter app exec tsc -p tsconfig.app.json --noEmit
pnpm test && pnpm lint && pnpm check:env
grep -rn "F-57\|F-58\|F-59\|F-60\|F-61\|F-62\|F-63\|F-64\|F-67" docs/
```

# 019 — Validación genérica, tasa de mantenimiento por mercado y parámetros muertos

Estado: `hecho` (2026-09-06; F-11 y parte de F-12 quedan para el usuario) · Tipo: `cambio` · Rama: `spec/019-validacion-y-parametros-muertos`

## Objetivo

Que la API rechace lo que el formulario nunca dejó pasar (los `min/max/step/options` de `meta.fields`); que la
liquidación estimada, la puerta del 5 % de la API y el aviso del formulario usen la **misma** tasa de
mantenimiento, la del mercado; que `updateConfig` no cuente dos veces al propio bot contra el tope de notional
total; que la pérdida diaria se corte a la misma medianoche en la API y en el worker; y que los campos comunes
que hoy no hacen nada en tres estrategias (`cooldownMinutes`, `maxNotionalCap`) hagan lo que dicen, mientras los
que exigen una decisión de producto quedan documentados como tales.

## Contexto

| F | Título | Sev. |
|---|---|---|
| F-13 | `validate()` no acota min/max/step/options de más de 30 campos que `meta.fields` sí limita | Media |
| F-93 | MMR plano 0,5 % optimista frente a los mantenimientos reales | Media |
| F-44 | La regla del 5 % de la API prohíbe en la práctica ≥ 19× y ningún formulario lo dice | Media |
| F-42 | `updateConfig` suma el propio bot dos veces contra el tope de notional total | Media |
| F-43 | API y worker cortan el «día» de la pérdida diaria en medianoches distintas | Baja |
| F-12 | Parámetros muertos o a medias (`cooldownMinutes`, `maxNotionalCap`, `direction`, `preloadInventory`, `fullCycleCooldownMinutes`, `takeProfitPct`/`tpMode` de GridMart, `targetLeverage`) | Media |
| F-11 | `drawdownPct` es pérdida acumulada, no caída desde máximo | Media (decide el usuario) |

## Alcance

- `packages/shared/src/{liquidation,market,time}.ts`; `packages/strategy-core/src/{common,registry}.ts` y las
  estrategias (`grid-classic`, `neutral-grid`, `tdca`, `gridmart`); adaptadores (`hyperliquid`, `lighter`:
  `maintenanceMarginRate`); `apps/api/src/modules/{risk,bots,advisor}`; `apps/worker/src/engine/bot-store.ts`;
  textos in-app; `docs/`.
- Tests: `strategies.spec.ts`, `meta.spec.ts`, `liquidation.spec.ts`, `time.spec.ts`, `risk.spec.ts`.

## Fuera de alcance (decisiones del usuario, anotadas en las fichas)

- **F-11**: qué significa «drawdown» para el kill-switch (pérdida acumulada, como hoy, o caída desde máximo).
- **F-12**: implementar o retirar `preloadInventory` (comprar inventario a mercado al arrancar),
  `fullCycleCooldownMinutes` (semántica sin definir), `reanchorOnDrift` (recentrado automático) y
  `targetLeverage` (contrato sin consumidor). Los textos dicen hoy la verdad: no hacen nada.
- Una columna nueva en `markets` para la tasa de mantenimiento: la de Lighter se deriva del apalancamiento
  máximo al leer la ficha de la base (misma regla que Hyperliquid), aunque el adaptador tenga la exacta.

## Requisitos

- **R-1** (F-13) `validateMeta(config, fields)` en `strategy-core` rechaza valores presentes fuera de
  `min`/`max`, no enteros en campos `integer`, fuera de `options` en enumeraciones y campos `required`
  ausentes; el registro lo aplica a `validate()` y `preview()` de las siete estrategias (sin duplicar un error
  que la estrategia ya dé para el mismo campo). GridMart sin multiplicadores devuelve una vista previa
  inválida, no un `DecimalError`.
- **R-2** (F-93) `MarketSpec.maintenanceMarginRate` (Hyperliquid: la mitad del margen inicial al apalancamiento
  máximo; Lighter: `maintenance_margin_fraction`) y `maintenanceMarginRateOf(market)` con esa misma regla como
  respaldo cuando la ficha no lo trae; la vista previa, la API y la validación la usan.
- **R-3** (F-44) `maxLeverageWithinDistance(mmr)` en `shared` (la regla del 5 %) manda en `validateCommon`
  (ERROR con el tope exacto de ese mercado), en `RiskService.assertWithinLimits` y en el asistente: una misma
  cuenta en los tres sitios.
- **R-4** (F-42) `assertWithinLimits(..., { excludeBotId })`: `updateConfig` excluye al propio bot del
  agregado.
- **R-5** (F-43) `startOfDay(timezone, now)` vive en `shared`; API y worker lo usan con la zona del usuario.
- **R-6** (F-12) `cooldownMinutes` frena las entradas nuevas de Grid Classic, Neutral Grid y TDCA mientras dure
  `cooldownUntil`; `maxNotionalCap` es un segundo tope en Neutral Grid (junto a `maxExposure`) y en TDCA (junto
  a `maxPositionNotional`); la vista previa de GridMart pinta el TP del satélite; Neutral Grid avisa si
  `direction` no es neutral; el aviso de `preloadInventory` dice que no está implementado.

## Criterios de aceptación

- **CA-1** Tests de R-1 a R-6 en verde; `pnpm build:packages`; `pnpm test`, `pnpm lint`, `pnpm check:env`;
  typecheck de la app.
- **CA-2** Los bloques de F-13, F-93, F-42, F-43 y F-44 salen de `docs/`; los de F-12 y F-11 se reescriben con
  lo que queda (decisión del usuario). Los números de liquidación de las guías se regeneran con el verificador
  de ejemplos.

## Riesgos

- R-1 rechaza configuraciones guardadas fuera de rango en cuanto se editen; hoy el formulario ya las impide.
- R-2/R-3 acercan la liquidación estimada al venue: las distancias de la vista previa bajan y el tope de
  apalancamiento por mercado baja (BTC en Hyperliquid: 16× en vez de 18×).
- R-6 activa dos campos que estaban muertos: solo cambia algo en bots que ya los tenían rellenos.

## Referencias oficiales

- Hyperliquid, «Margining»: «the maintenance margin is half of the initial margin at max leverage».
- Lighter, `orderBookDetails`: `min_initial_margin_fraction`, `maintenance_margin_fraction` (en 1/10 000).

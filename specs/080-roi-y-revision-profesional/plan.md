# 080 — Plan

## Enfoque

El % sobre margen se traduce a precio en **un solo sitio** (`packages/shared/src/roi.ts`), y los
helpers de `ladder.ts` piden el apalancamiento en su firma. Así el compilador obliga a revisar cada
llamada, y ninguna se queda en la semántica vieja.

La liquidación se reduce a la fórmula exacta, que coincide con la de Hyperliquid (079). La
previsualización pasa a describir **lados**: un largo y un corto no conviven, y cada uno tiene su
entrada, su stop, su objetivo y su liquidación. La pantalla Revisión y el formulario leen esos lados.

Descartadas:

- **Dejar los % sobre el precio y solo enseñar el equivalente.** El usuario decidió cambiarlo (D-1).
- **Pasar también las distancias a margen.** Ningún exchange lo hace, y la geometría de la escalera
  cambiaría al mover el apalancamiento (D-2).
- **Un umbral nuevo para el aviso del stop.** Ya existe `HOLGURA_LIQUIDACION` (P-4).

## Decisiones del plan aprobado

| # | Decisión |
|---|---|
| P-1 | Numeración 079/080, en un worktree aparte (`CRYPTON-080`). |
| P-2 | El ROI se convierte con el apalancamiento de la configuración; el stop, con `max(config, posición)` y un aviso. |
| P-3 | Con posición abierta no se cambia el apalancamiento (API y supervisor). |
| P-4 | El aviso de «stop cerca» usa `HOLGURA_LIQUIDACION = 0.5`. |
| P-5 | `START` vuelve a validar la configuración. |
| P-6 | El simulador usa el mantenimiento de cada mercado. |
| P-7 | Se elimina el `takeProfitPct` muerto de GridMart. |
| P-8 | Resultado en USDC, sin comisiones y rotulado así. |
| P-9 | API, worker y app salen juntos. |

## Fases

| Fase | Qué | Criterio de salida |
|---|---|---|
| 0 | Línea base (la del 079) | Anotada |
| 1 | Una sola liquidación, la exacta, y la regla del 5 % por lado | shared, strategy-core, backtest, worker, api; typecheck de la app |
| 2 | El motor en ROI: `roi.ts`, `ladder.ts`, `withStopLoss`, estrategias, validaciones y valores de fábrica | ídem |
| 3 | API: asesor, supervisor, riesgo del MM, `START` y apalancamiento con posición | api, y su `build` |
| 4 | Contrato de la previsualización por lados, correcciones por estrategia y pantalla Revisión | todo, más la compilación de la app |
| 5 | Formulario: equivalente en precio y propuesta de stop | app |
| 6 | Migración de datos, probada en una base temporal | CA-3 |
| 7 | Textos, ayudas, guías y documentación | `check:labels`; `grep` sin restos |
| 8 | Cierre | CA-1 a CA-4; índice, memoria |

## Verificación

- Por fase, desde Git Bash: `pnpm build:packages`, `pnpm test:strategies`, `pnpm test:adapters`,
  `pnpm test:backtest`, `pnpm --filter worker test`, `pnpm --filter api test`, el typecheck y la
  compilación de la app, y `pnpm lint`. El worker, además, con
  `tsc --noEmit -p tsconfig.build.json`, y la API con `pnpm --filter api build`.
- CA-1: un test de `strategy-core` con el caso del usuario, cifra a cifra.
- CA-3: la migración en `crypton_mig_080`, dentro del contenedor de Postgres. Se aplica con
  `psql -1` y después por `prisma migrate deploy` con `DATABASE_URL` en el entorno, sin leer
  `.env`. Casos: bot en marcha, conversión y sin apalancamiento.

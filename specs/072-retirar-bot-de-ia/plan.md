# 072 — Plan

## Enfoque

**Restaurar, no reescribir.** El bot entró en tres specs y casi todo lo que tocó fuera de sus
carpetas fueron capas para convivir con el canal: uniones de tipos, un lector doble, un reparto
entre dos lazos, un filtro por relación, una extracción. Reescribir cada capa a mano sería escribir
código nuevo sobre el camino del dinero del canal. Devolver esos ficheros a `970c31c` —el merge del
067, lo último antes del 068— recupera el código contra el que se escribieron los tests del canal,
y se comprueba con un `git diff` vacío.

Qué fichero va por qué camino lo decide una sola pregunta: **¿lo volvió a tocar algún commit
posterior al 070?** Si no, y su diff desde `970c31c` es solo del bot, se restaura. Si sí —la
revisión del Market Maker V2 del 071 tocó siete—, se edita a mano quitando solo lo del bot.

Alternativas descartadas:
- `git revert` de los merges 068-070: el 071 se construyó encima (`trader/estado.ts`,
  `typesafe.client.ts`, `field-labels.ts`, `warnings.ts`) y los conflictos serían más difíciles de
  revisar que la lista de abajo.
- Conservar el valor `AI_TRADER` en el enum de la base «por si acaso»: sería un valor que ningún
  código sabe leer, y cualquier fila que lo usara rompería el cliente de Prisma al leerla.

## Ficheros afectados

### Se restauran a `970c31c` (35)

| Fichero | Qué deshace |
|---|---|
| `packages/strategy-core/src/index.ts` | las exportaciones de `trader/`, de la cascada (071) y de `dimension.ts`, y `AiTraderConfig` |
| `packages/shared/src/enums.ts` | el valor del enum, la lista de solo administradores con dos, y `ESTRATEGIAS_CON_INTENCIONES` |
| `packages/shared/src/ia-canal.ts` | las uniones `EleccionDecision`/`OfertaDecision`/`PlanDecision` con sus estrechadores, `candidatoDe`/`decisionDe`, `DESACUERDO` y `TasasBase extends ResumenTasas` |
| `packages/shared/src/ia-canal-vistas.ts` · `.spec.ts` | `veredictoDe` y sus tests |
| `packages/shared/src/index.ts` | la exportación de `ia-trader` |
| `packages/strategy-core/src/canal/herramienta.ts` | la extracción a `dimension.ts` (`e5e26a0`) y `ResumenTasas` |
| `packages/strategy-core/src/canal/analisis.ts` · `tasas-base.ts` | `ResumenTasas` |
| `packages/strategy-core/src/strategies/ai-channel.ts` · `.spec.ts` | el rechazo de una elección «que no es de esta estrategia» y los *casts* de la unión |
| `packages/strategy-core/src/registry.ts` | la entrada del registro |
| `packages/backtest/src/engine.ts` | `planGuardado` con dos formas, `setupDe` y los exportados para su test |
| `apps/worker/src/engine/ai-intents.store.ts` | el lector doble y `candidatoDe`/`decisionDe` |
| `apps/worker/src/engine/engine.service.ts` | la reserva de cupo por venue compartida por dos estrategias |
| `apps/worker/src/engine/bot-runner.ts` | la frase de `REANCHOR_NO_APLICA` (dos líneas; el fichero se lee entero antes, por `CLAUDE.md`) |
| `apps/api/src/app.module.ts` | `AiTraderModule` |
| `apps/api/src/modules/ai-channel/ai-channel.service.ts` · `.spec.ts` | `soltar()`, el filtro por relación del sondeo y el doble de base que lo entendía |
| `apps/api/src/modules/bots/solo-admin.spec.ts` | las dos afirmaciones con dos estrategias |
| `apps/api/.env.example` · `docker/.env.example` · `docker/docker-compose.yml` | `TYPESAFE_AI_API_KEY` y las siete `AI_TRADER_*` |
| `apps/app/src/app/core/models/index.ts` | el espejo del enum |
| `apps/app/src/app/core/content/index.ts` | la guía en el `Record` |
| `apps/app/src/app/core/utils/labels.ts` | el nombre, la descripción y el «Canal» a secas |
| `apps/app/src/app/core/utils/canal-ia.ts` | el motivo `DESACUERDO` |
| `apps/app/src/app/core/utils/risk.ts` | el medidor de camino para dos estrategias |
| `apps/app/src/app/features/admin/bots.page.ts` | el filtro del buscador |
| `apps/app/src/app/features/bots/bot-create.page.ts` | consentimiento, textos del cálculo previo e insignia de riesgo |
| `packages/db/prisma/schema.prisma` | el valor del enum |
| `docs/README.md` · `administracion.md` · `buenas-practicas.md` · `riesgo-y-liquidacion.md` | las filas y frases del bot y el «Canal» a secas |

### Se editan a mano (los que también tocó el 071)

| Fichero | Qué se quita | Qué se queda |
|---|---|---|
| `packages/strategy-core/src/strategies.spec.ts` | `AI_TRADER` en las listas de *flags* y en la de estrategias con series | `MARKET_MAKER_V2` en la de series (071) |
| `packages/backtest/src/warnings.ts` · `.spec.ts` | los dos avisos del bot y su mención en el comentario del F-01 | los avisos de market maker (071) |
| `apps/app/src/app/core/utils/field-labels.ts` | las 90 claves `strategy.aiTrader.*` y sus cuatro listas de opciones; «Canal» vuelve a «Canal con IA» | las que añadió el F-03 del 071 para los market makers y la tendencia |
| `README.md` · `CLAUDE.md` | la fila del bot, el mapa de `ai-trader`, `trader/` y `dimension.ts`, y la frase de los «números de opinión» del invariante 13 | la línea de `check:labels` (071) |
| `specs/README.md` | — | las filas 068-070 pasan a «retirado», la del 071 lo dice de su primera parte, y entra la del 072 |

### Se borran

- `apps/api/src/modules/ai-trader/` (12 ficheros, con `typesafe.client.ts` y la primitiva `score`)
- `packages/strategy-core/src/trader/` (13, con `cascada.ts`) y `strategies/ai-trader.ts`,
  `ai-trader.spec.ts`, `ai-trader-ia.spec.ts`
- `packages/strategy-core/src/dimension.ts` (vuelve a vivir dentro de `canal/herramienta.ts`)
- `packages/shared/src/ia-trader.ts`
- `packages/backtest/src/engine.trader.spec.ts`
- `apps/app/src/app/core/content/ai-trader.guide.ts`
- `docs/ai-trader.md`

### Se quedan a propósito

- `packages/db/prisma/migrations/20260921090000_strategy_ai_trader/` — puede estar aplicada.

### Nuevo

`packages/db/prisma/migrations/20260924120000_retirar_ai_trader/migration.sql`, en una transacción:

1. Un bloque `DO` que aborta con `RAISE EXCEPTION` si hay un bot real de `AI_TRADER` en
   `STARTING`/`RUNNING`/`PAUSED`/`STOPPING`, con el mensaje de qué hacer.
2. `DELETE` de los bots de `AI_TRADER` (las filas hijas caen en cascada, como al borrar desde la
   app), de sus `backtest_runs` y de sus `leaderboard_entries`.
3. El patrón con el que Prisma quita un valor de un enum: tipo nuevo, `ALTER COLUMN ... TYPE ...
   USING strategy::text::...` en las tres columnas que lo usan (`bots`, `leaderboard_entries`,
   `backtest_runs`), renombrar y borrar el viejo. Ningún índice, vista ni función usa la columna.

## Fases

| Fase | Qué | Criterio de salida |
|---|---|---|
| 0 | Línea base: rama, build, tests | Verde o rojos conocidos anotados |
| 1 | La API: TypeSafe y su lazo fuera, y el lazo del canal como antes del 069 | API en verde |
| 2 | La app: el bot fuera y el canal vuelve a llamarse «Canal con IA» | typecheck y build de la app |
| 3 | La estrategia: `shared`, `strategy-core`, backtest, worker, el enum de Prisma y la migración | todo compila y pasa |
| 4 | La migración, probada sobre una base de prueba (CA-3) | los dos casos |
| 5 | Guías, `README.md`, `CLAUDE.md` y specs | CA-1 y CA-2 |
| 6 | Cierre: verificación completa, índice, memorias, merge a `main` | Estado `cerrado` |

Un commit por fase, salvo las fases 2 y 3, que van juntas. Medido: la app sin el bot no compila
contra un `shared` que todavía lo tiene (`bot-detail.page.ts` y `chart.page.ts` pasan el
`StrategyKind` de `shared` a funciones que esperan el de la app), y al revés la guía del bot importa
`AiTraderConfig` de `strategy-core`. El enum de `shared`, el de Prisma y todos los `Record`
exhaustivos que cuelgan de ellos se mueven a la vez.

## Verificación

```bash
pnpm build:packages
pnpm test                         # todo, sin e2e
pnpm lint
pnpm check:env && pnpm check:labels
pnpm --filter app build           # es el único que mira los presupuestos de Angular
pnpm --filter api build && pnpm --filter worker build
git grep -n -i -E "AI_TRADER|ai-trader|aiTrader|typesafe|juezTrader|cuantiza\(|ia-trader|Bot de IA" -- ':!specs' ':!packages/db/prisma/migrations'
git diff 970c31c -- <los 35 de arriba>
```

La migración (CA-3) se prueba sin leer ningún `.env`: una base temporal dentro del contenedor de
Postgres local, las migraciones aplicadas con `psql` en orden, filas de prueba y las dos
comprobaciones; al terminar se borra la base temporal. La base de desarrollo del usuario no se toca.

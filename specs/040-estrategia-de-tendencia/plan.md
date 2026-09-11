# 040 — Plan

## Enfoque

De dentro hacia fuera: indicadores puros → estrategia → registro → asesor → app → docs. Cada capa
se verifica antes de la siguiente, y **el sistema de tipos hace casi todo el trabajo de
checklist**: `STRATEGY_GUIDES`, `STRATEGY_LABELS` y `GuideOptions<C>` son `Record` completos, así
que la app no compila hasta que la estrategia tiene su guía, su etiqueta y una ficha por campo.

### Decisiones que conviene no deshacer

**`Strategy.candles` pasa a ser función de la configuración.** El spec 038 la dejó como constante,
y está mal: el intervalo es del bot, no de la estrategia. Dos bots de tendencia sobre el mismo par
pueden querer uno velas de 1 h y otro de 1 d.

**El canal excluye la vela que rompe.** Si contara en su propio rango, su máximo sería el máximo y
no lo superaría nunca.

**ATR por media aritmética y no por suavización de Wilder.** Las dos son defendibles y dan números
parecidos; esta se comprueba a mano en un test, y un indicador del que depende el **tamaño** de una
posición tiene que poder comprobarse a mano.

**`direction` con NEUTRAL en vez de un `allowShort` aparte.** Dos mandos para la misma pregunta es
una manera de que acaben contradiciéndose. Es el patrón que ya usan los market makers.

**Sin velas suficientes no opera.** Peor que no operar sería operar con una ventana corta: un ATR
de catorce calculado sobre tres es un número con toda la pinta de ser válido.

## Ficheros afectados

| Fichero | Qué | Tests |
|---|---|---|
| `strategy-core/src/indicadores.ts` | `rangoVerdadero`, `atr`, `donchian` | `indicadores.spec.ts` (11) |
| `strategy-core/src/strategies/trend-follow.ts` | La estrategia | `trend-follow.spec.ts` (25) |
| `strategy-core/src/{registry,index,types,testing}.ts` | Registro, export, contrato, contexto con velas | genéricos |
| `shared/src/enums.ts` · `db/prisma/schema.prisma` + migración | El valor de enum | `prisma:deploy` |
| `apps/api/.../advisor/build.ts` | `buildTrend`: el asesor sabe configurarla | `advisor.spec.ts` |
| `apps/app`: `models`, `labels`, `field-labels`, `content/trend-follow.guide.ts` | Tipos, etiquetas, guía | `ng build` |
| `packages/backtest/src/warnings.ts` | El hueco de paridad del trailing | — |
| `docs/trend-follow.md`, `docs/README.md`, `README.md` | Documentación | — |

## Fases

| Fase | Qué | Salida |
|---|---|---|
| 0 | Línea base sobre `main` con 037-039 dentro | Verde |
| 1 | Indicadores puros | 11 tests contra series calculadas a mano |
| 2 | La estrategia y su registro | Entra sola en las baterías genéricas |
| 3 | Enum de Prisma y migración | `prisma:deploy` la aplica |
| 4 | Asesor | Los tres perfiles se distinguen |
| 5 | App: tipos, etiquetas, guía | `ng build` limpio |
| 6 | Docs y cierre | CA-13 |

## Verificación

```bash
pnpm build:packages
pnpm test:strategies · pnpm --filter api test · pnpm --filter worker test · pnpm test:backtest
pnpm lint · pnpm test
pnpm --filter app exec ng build
pnpm prisma:deploy                        # forward-only: no resetea nada
```

Lo que decide si esto está bien hecho no son los tests propios, son los **genéricos**: la batería
que recorre `listStrategies()`, la del asesor que valida y previsualiza toda recomendación, y los
`Record` completos de la app. Si la estrategia entra en todos ellos sin excepciones añadidas, está
bien integrada.

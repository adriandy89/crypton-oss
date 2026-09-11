# 037 — Plan

## Enfoque

Cada requisito es un arreglo pequeño y aislado, con **su test que falla primero** y **su commit**.
No hay refactor: ninguna firma entre paquetes cambia y ningún mando nuevo aparece. El orden lo
manda el riesgo: primero lo que afecta a la conducta de un bot con dinero (R-1, R-2, R-3), luego
lo que afecta a lo que el usuario ve antes de poner dinero (R-4, R-5, R-6), y al final lo que solo
se nota en diagnóstico y caudal (R-7, R-8, R-9).

### Decisiones de diseño

**R-1 — dónde se corta.** Tres opciones:

1. Aplicar `spreadWiden` solo al lado que añade. ← **elegida**
2. Sustituir `spreadWiden × regimeMul` por `max(spreadWiden, regimeMul)`. Descartada: cambia
   también el lado que añade y le quita gradación.
3. Que `REGIME_DISTANCE.reducing` compense dividiendo por `spreadWiden`. Descartada: mete el
   inventario dentro de una constante que hoy es pura y compartida con la V2.

La (1) es una línea, conserva el ensanchado donde el riesgo de verdad crece —el lado que sigue
cargando— y deja `REGIME_DISTANCE` intacta para la V2.

**R-2 — cuánto de duro.** `validate()` en **ERROR**, igual que el `minAllowedDistanceBps >
buyDistanceBps` de la V1: la configuración es incoherente, no arriesgada. Además `plan()` **no
emite** una capa cuyo precio coincida con el de una capa anterior del mismo lado, para que un bot
ya creado con esa configuración deje de quemar cuota. Colapsar es mejor que duplicar: tres órdenes
al mismo precio no dan más profundidad que una, y el venue puede rechazarlas.

**R-3 — dónde vive.** En `expiredQuotes` (`mm-shared.ts`), que es de las dos versiones. El TTL de
salida y la caducidad por edad pasan a compartir la misma excepción.

**R-5 — qué valor gana.** Manda `defaults()`, que es lo que el bot usa y lo que el spec 035
decidió. `meta.default` se pone al día. Para que no vuelva a pasar, un test genérico recorre
`listStrategies()` y compara los dos.

## Ficheros afectados

| Fichero | Qué cambia | Tests que lo cubren |
|---|---|---|
| `packages/strategy-core/src/strategies/market-maker.ts` | R-1 (`spreadWiden` por lado), R-6 (`neutral`), R-9 (ancla + auto) | `strategies.spec.ts` |
| `packages/strategy-core/src/strategies/market-maker-v2.ts` | R-2 (validate + colapso), R-4 (`conTecho` en preview), R-5 (tres `default`), R-6, R-7 (nota), R-8 (`cooling`) | `strategies.spec.ts` |
| `packages/strategy-core/src/strategies/mm-shared.ts` | R-3 (TTL de salida respeta `alcanzando`) | `strategies.spec.ts`, `mm-ejecucion.spec.ts` |
| `packages/strategy-core/src/strategies.spec.ts` | Tests de R-1..R-9 + test genérico de R-5 | — |
| `packages/strategy-core/src/strategies/mm-ejecucion.spec.ts` | Camino multi-tick de R-3 | — |
| `docs/market-maker.md`, `docs/market-maker-v2.md` | R-10 | — |
| `apps/app/src/app/core/content/market-maker*.guide.ts` | R-10 | — |
| `specs/README.md` | Fila 037 en el índice | — |

## Fases

| Fase | Qué | Criterio de salida |
|---|---|---|
| 0 | Línea base: rama, `build:packages`, `pnpm test`, `lint` | ✅ hecho: 314 tests en `strategy-core`, 4307 en `api`, `pnpm test` exit 0 |
| 1 | **R-1** ensanchado por lado | CA-1, CA-2, CA-3 en verde; el test falla antes |
| 2 | **R-2** capas colapsadas en la V2 | CA-4 |
| 3 | **R-3** TTL de salida asimétrico | CA-5 |
| 4 | **R-4** preview con techo · **R-5** descriptores · **R-6** neutral | CA-6, CA-7, CA-8 |
| 5 | **R-7** nota · **R-8** enfriamiento · **R-9** ancla + auto | CA-9, CA-10, CA-11 |
| 6 | **R-10** guías de `docs/` y de la app | Ninguna tabla describe la conducta antigua |
| 7 | Cierre: `findings.md`, índice de specs, memoria | CA-12; estado `hecho` |

Un commit por fase, mensaje `fix(strategy-core): <qué> (spec 037 R-n)`.

## Verificación

```bash
pnpm build:packages
pnpm test:strategies                      # el paquete que se toca
pnpm --filter worker test                 # dependiente obligatorio
pnpm test:backtest                        # dependiente obligatorio
pnpm --filter app exec tsc --noEmit       # la app consume strategy-core como fuente
pnpm lint
pnpm test                                 # todo, sin e2e
```

Jest desde **Git Bash**, no desde PowerShell: allí `2>&1` falsea el código de salida.

Para cada requisito, antes del arreglo: `pnpm --filter @crypton/strategy-core test -- -t "<nombre
del test>"` tiene que fallar **por el motivo declarado**, no por otro. Se anota la salida en
`tasks.md`.

Comprobación manual final (CA-13), con la infra levantada: un MM V1 simulado al que se le deja
acumular inventario por encima del umbral defensivo enseña en la pantalla del bot una distancia
de salida **menor** que la de entrada. Hoy son prácticamente iguales.

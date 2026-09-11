# 045 — Que el número de estrategias deje de envejecer

Estado: `hecho` · Tipo: `cambio` · Rama: `spec/045-el-numero-de-estrategias`

## Objetivo

Quitar el número de estrategias de los treinta y cuatro sitios donde está escrito a mano, porque se
queda viejo cada vez que se añade una y ya se ha quedado viejo **dos veces seguidas**.

Se sabrá que está hecho cuando no quede en el código ni en la documentación una sola frase que diga
cuántas estrategias hay — salvo las tablas, que las enumeran de verdad y no pueden mentir.

## Contexto

Lo encontró la décima sincronización del fork open source: el `README.md` decía «las **ocho**» tres
líneas por encima de una tabla con **nueve** filas, y `docs/README.md` titulaba «Las **siete**
estrategias» sobre esa misma tabla de nueve.

No es un descuido aislado: el spec 040 se propuso explícitamente actualizarlo (su lista de tareas
dice «las menciones a "las siete estrategias" pasan a ocho en código, guías y web») y se dejó la
mitad; el 043 añadió la novena y no tocó ninguna. Un número escrito a mano en treinta y cuatro
sitios no se mantiene: se arregla quitándolo.

Es el mismo defecto que el **F-05 del spec 044** —enumeraciones a mano que se quedan atrás—, pero
donde aquel eran tablas a las que les faltaban filas, este es un número que no hace falta para nada.

## Alcance

- `packages/` — comentarios de `stop-loss`, `tdca`, `martingale`, `trend-follow`, `bot.ts` y tres
  specs de test
- `apps/worker` — dos comentarios del runner y dos de sus tests
- `apps/api` — el controlador de bots y la cabecera del test de la matriz de venues
- `apps/app` — fichas de opciones, dos guías y dos comentarios del asistente
- `README.md`, `CLAUDE.md` y las guías de `docs/` que llevan el número en una frase

## Fuera de alcance

- **`specs/`**, que es historia. Un spec dice lo que era cierto el día que se escribió, y
  reescribirlo lo convertiría en una mentira distinta. Tampoco se tocan los informes del 001.
- **Las tablas**, que enumeran las estrategias una a una. Ahí no hay número que envejezca: si falta
  una fila se ve, y el spec 044 ya las puso al día.
- **`packages/db/prisma/migrations/20260823120000_market_maker_v2/migration.sql`**, cuyo comentario
  dice «a dos de las siete estrategias». Una migración **aplicada no se edita jamás**: Prisma guarda
  su suma de comprobación y cambiar un byte —aunque sea dentro de un comentario— la convierte en
  deriva en todas las bases que ya la tienen. Se queda, y es el único sitio del repositorio fuera de
  `specs/` donde el número sobrevive.
- Cualquier cambio de conducta. Este spec **no toca una sola línea ejecutable**: son comentarios,
  textos de guía, el nombre de un test y prosa de documentación.

## Requisitos

- **R-1 — Donde el número describe el presente, se dice «todas».** `COMMON_FIELDS` inyecta
  `stopLossPct` en **todas** las estrategias, el motor pone el stop en **todas**, `meta.spec.ts`
  cubre **todas**. Ninguna de esas frases necesitaba un número y todas envejecían con él.

- **R-2 — Donde el número describe un subconjunto, se describe el subconjunto.** «Las ocho que
  reconcilian contra el libro» pasa a «las que reconcilian contra el libro»; «un runner sin esto
  funciona igual para las otras ocho» pasa a «para todas las demás». Hoy esos números son correctos
  —ocho de nueve— y por eso nadie los ve envejecer hasta que es tarde.

- **R-3 — Donde el número describe el PASADO, se deja el pasado y se marca como tal.** Dos
  comentarios cuentan un incidente: «`stopLossPct` lo inyecta `COMMON_FIELDS` en las siete, pero
  solo dos lo leían: las otras cinco pintaban el campo y no colocaban nada». El «dos» y el «cinco»
  son parte de la historia y cambiarlos la falsearía; lo que se corrige es el presente —«en
  todas»— y se dice explícitamente que el resto es cómo estaba entonces.

- **R-4 — Dos frases no están solo desfasadas: son falsas.** La guía y el docblock de la estrategia
  de tendencia dicen que «las otras N hacen variaciones de lo mismo: comprar barato y vender caro
  dentro de un rango». Con el seguimiento de beneficio del spec 043 eso dejó de ser cierto: es
  direccional, como la de tendencia. Pasan a hablar de **las estrategias de rango**, que es lo que
  la frase quería decir.

- **R-5 — Nada ejecutable cambia.** `pnpm test` tiene que dar exactamente los mismos números que
  antes del spec, con el único cambio del **nombre** de un test (`…en las siete` → `…en todas`).

## Criterios de aceptación

- **CA-1** `grep` de «las siete|ocho|nueve estrategias» y de «las otras siete|ocho» no devuelve nada
  fuera de `specs/`.
- **CA-2** Las tres frases del `README.md` (mapa del árbol, apertura de «Estrategias» y verificación
  contra infraestructura) dejan de dar un número, y la tabla sigue con sus nueve filas.
- **CA-3** El título de `docs/README.md` y las siete guías que lo citan dejan de contarlas.
- **CA-4** Los dos comentarios históricos siguen contando el incidente con sus «dos» y «cinco», y
  dicen que eso era entonces.
- **CA-5** `pnpm test` con los mismos totales, `pnpm lint` limpio, `ng build` y el worker compilando.

## Riesgos

- **Toca muchos ficheros para no cambiar nada.** Es prosa y comentarios; el riesgo real es escribir
  mal un comentario, no romper un bot. Aun así se verifica entero, porque un `.ts` con una comilla
  mal puesta no compila.

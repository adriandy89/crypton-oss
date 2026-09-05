# 003 — Curva agregada de la cartera

Estado: `en curso` · Tipo: `cambio` · Rama: `spec/003-cartera-agregada` · Base: `ffdfded` (punta de `spec/002-app-analitica`; aprobado por el usuario el 2026-09-05)

## Objetivo

Que la pantalla más mirada de la app —la cartera— conteste «¿voy ganando este mes?» con una curva
del resultado agregado de todos los bots reales, en ventanas de 24 h, 7 d, 30 d y 1 año, sin
inventar ni un punto: los tramos sin bots vivos se rompen, y lo que se pinta lo dice el rótulo.

Estará conseguido cuando la cifra grande de la cartera lleve debajo su historia, la curva coincida
con la suma de las curvas de los bots en cualquier instante en que ambas existan, y un bot borrado
no reescriba el pasado de la cartera.

## Contexto

Es el spec de seguimiento **003** propuesto en `specs/002-app-analitica/findings.md`. El 002 dejó la
cartera con capital y exposición separados, reparto por símbolo y posiciones ordenadas por riesgo,
pero sin serie: hoy es «una cifra sin historia» (catálogo del 002, propuesta B4). Es la única pieza
del catálogo que necesita **persistencia nueva**, y por eso quedó fuera del 002 y tiene spec propio.

Por qué no basta con sumar en el cliente las series de los bots, medido en el 002:

1. **No hay dato.** `GET /bots/:id/snapshots` alcanza 30 días solo con el rango agregado del
   servidor, y sumar N bots son N peticiones por ventana.
2. **Los bots borrados desaparecen del pasado.** `Bot` borra en cascada sus `bot_snapshots`
   (`schema.prisma:303`, `onDelete: Cascade`): la suma de las series de los bots que *existen hoy*
   no es la historia de la cartera, es la historia de los supervivientes.
3. **La aritmética de dinero no va en un `computed` de una vista** (invariante 1 y precedente de
   `candle-paging.ts`): tiene que estar donde se pueda probar.

Y por qué no una agregación al vuelo en el servidor sobre `bot_snapshots`: el mismo problema 2 —los
borrados no están—, más un `GROUP BY` sobre hasta 43 200 filas por bot en cada apertura de la
pestaña de aterrizaje. Una fila materializada cada cinco minutos por usuario y red son 105 filas al
día y 38 000 al año: cabe en memoria para siempre.

## Alcance

- `packages/db/prisma`: modelo `PortfolioSnapshot` y su migración (tabla nueva; **nada de lo que
  existe se toca**). Es lo que hace que este spec necesite aprobación explícita antes de la rama.
- `apps/worker/src/engine/portfolio-snapshots.service.ts` (**nuevo**): cron cada cinco minutos,
  tras cerrojo en Redis, que escribe una fila por usuario y red a partir del **último snapshot** de
  cada bot real vivo. La agregación es una función pura con test.
- `apps/worker/src/engine/retention.service.ts`: purga de la tabla nueva con `RETENTION_PORTFOLIO_DAYS`
  (por defecto 365). Más la variable en `.env.example` y en el compose, que cruza `check:env`.
- `apps/api/src/modules/portfolio/` (**nuevo**): `GET /portfolio/equity?range=24h|7d|30d|1y&testnet=`,
  agregado en SQL con los extremos de cada cubo, como `BotSeriesService` del 002.
- `packages/shared/src/portfolio.ts` (**nuevo**): el contrato `PortfolioEquityPoint` y
  `PortfolioEquitySeries`.
- `apps/app/src/app/features/portfolio/portfolio.page.ts`: la curva en el héroe, con selector de
  ventana, sobre `ui-spark`.

## Fuera de alcance

Saldos reales del venue por cuenta (exigen leer el exchange con credenciales desde el worker, y la
curva de esta pantalla es de **resultado**, no de patrimonio, igual que la del bot); los bots
simulados (dinero de mentira, nunca sumado al héroe: podrán tener la suya en otro spec si hace
falta); rollups de `bot_snapshots` más allá de 30 días; cambiar la retención existente de
`bot_snapshots`; el ranking; cualquier escritura fuera de la tabla nueva.

## Requisitos

- **R-1** Línea base registrada: build, tests paquete a paquete (rojos conocidos del 001 anotados),
  lint, `check:env`.
- **R-2** Tabla `portfolio_snapshots` con: `user_id`, `testnet`, `realized`, `unrealized`, `pnl`
  (= realizado + no realizado, la misma definición que `bot_snapshots.equity`), `invested`
  (Σ `total_investment` de los bots que aportan), `exposure` (Σ |posición| × precio medio), `bots`
  (cuántos aportan), `taken_at`. Índice `(user_id, testnet, taken_at desc)`. Todo `Decimal(38,18)`.
- **R-3** El cron escribe **una fila por (usuario, red)** cada cinco minutos, solo si algún bot real
  de ese usuario tiene un snapshot con menos de diez minutos; sin bots vivos no se escribe nada y
  la curva se rompe ahí. Corre tras `tryLock`, como la purga: `@Cron` dispara en todas las réplicas.
- **R-4** Entran los bots reales (`dry_run = false`) en cualquier estado que tenga snapshot
  reciente: un bot parado con posición sigue teniendo resultado. **Los borrados no**: al borrarse,
  su resultado deja de sumar desde ese instante y el pasado materializado no cambia. Eso es lo que
  se quiere —el pasado no se reescribe— y se le dice al usuario en la pantalla cuando `bots` baja.
- **R-5** La agregación es una función pura `aggregatePortfolio(filas)` con `Decimal`, con test, y
  el cron solo la llama y escribe.
- **R-6** `GET /portfolio/equity` devuelve puntos con `t`, `realized`, `unrealized`, `pnl`,
  `invested`, `exposure`, `bots`, más `bucketMs` y `cadenceMs` (con los que la app rompe la línea
  en los huecos con el MISMO criterio que la curva del bot, `gapMsFor` de `shared`, en vez de
  recibir una lista de huecos calculada con otro) y `retentionFrom` (el corte de retención,
  siempre, para que la app no pinte plano lo que no se midió). Muestreo con los extremos de cada
  cubo, a 480 puntos, como el 002. Solo el usuario dueño.
- **R-7** La curva se rotula **«resultado acumulado de la cartera»**, con el cero visible y la
  ventana real que cubre. Nunca «equity» ni «capital». Un tramo con `bots = 0` no se dibuja.
- **R-8** Purga con `RETENTION_PORTFOLIO_DAYS` (365 por defecto, 0 desactiva), por lotes, dentro
  de `RetentionService.purge()` y bajo su mismo cerrojo.
- **R-9** Ningún cambio en lo que el motor hace con un bot: la escritura nueva es aparte del tick y
  un fallo del cron se registra y no toca a ningún runner.

## Criterios de aceptación

- **CA-1** `pnpm prisma:migrate` aplica la migración sobre una base con datos sin tocar ninguna
  fila existente; `pnpm build:packages` regenera el cliente y compila.
- **CA-2** `aggregatePortfolio` tiene spec: suma exacta con `Decimal` (`'0.1' + '0.2' = '0.3'`),
  agrupa por usuario y red, excluye `dry_run`, cuenta `bots`, y devuelve nada para un usuario sin
  snapshots recientes.
- **CA-3** Con dos workers (`--scale worker=2`) la tabla recibe **una** fila por (usuario, red) y
  cinco minutos, no dos: el cerrojo funciona. Se comprueba contando filas.
- **CA-4** En un instante en que existen ambas, la fila de la cartera coincide con la suma de los
  últimos snapshots de los bots que aportan, cifra a cifra. Se comprueba a mano con dos bots
  simulados sobre una conexión **real** (`dry_run` en cuenta real queda fuera; hace falta al menos
  un bot real o la comprobación se hace en testnet).
- **CA-5** Borrar un bot no cambia ninguna fila anterior de `portfolio_snapshots`; la siguiente
  fila lleva `bots` una unidad menor y la app lo dice.
- **CA-6** El endpoint responde en menos de 200 ms con un año de filas (38 000) gracias al índice;
  la respuesta no pasa de 480 × 4 puntos.
- **CA-7** `check:env` en verde con la variable nueva declarada en `.env.example` e inyectada en el
  compose.
- **CA-8** Tests de worker y api en verde (salvo los rojos conocidos del 001), build de la app
  dentro de presupuesto, lint limpio.

## Riesgos

- **Es la primera escritura nueva del worker desde el 001.** Va en su propio servicio, fuera del
  tick, con su propio cerrojo, y un fallo se registra y no se propaga. Aun así, toca el proceso que
  mueve dinero: se despliega con el cron desactivable por variable (`PORTFOLIO_SNAPSHOTS_ENABLE`,
  por defecto activo) para poder apagarlo sin redesplegar.
- **Migración con el sistema en marcha.** Tabla nueva y nada más: segura de aplicar en caliente,
  como la de `backtests`.
- **Semántica del borrado.** Que un bot borrado deje de sumar «desde ahora» es una decisión, no
  una consecuencia; la alternativa —congelar su realizado en una fila de cierre— es más fiel y más
  compleja. Se propone la simple y se pregunta (pregunta abierta 1).
- **Crecimiento.** 105 filas al día por usuario y red; con mil usuarios, 38 millones al año sin
  purga. De ahí `RETENTION_PORTFOLIO_DAYS` desde el primer día, y que entre en la guarda de
  `purge()` como las demás.
- **Doble verdad de la exposición.** `exposure` aquí se calcula igual que en la app del 002
  (Σ |posición| × precio medio); si algún día la API sirve `currentTotalNotional` por usuario, las
  dos tienen que salir del mismo sitio.

## Decisiones

Las tres preguntas abiertas se cerraron el 2026-09-05 con la aprobación general del usuario
(«apruebo las maquetas y todo lo necesario»), tomando en cada una la propuesta del borrador:

1. **Bots borrados**: dejan de sumar desde el borrado. El pasado materializado no se reescribe y
   la pantalla lo dice cuando `bots` baja. Congelar el realizado en una fila de cierre queda como
   mejora posible si alguien lo echa en falta.
2. **Cadencia**: cinco minutos (105 filas por usuario, red y día). A 480 puntos un minuto no se
   nota y el cron competiría con los ticks por la base.
3. **Retención**: 365 días por defecto (`RETENTION_PORTFOLIO_DAYS`), para que la ventana de un
   año del selector tenga dato; 0 la desactiva.

## Referencias oficiales

Ninguna: no se apoya en documentación de ningún venue ni SDK. Las referencias son internas:
`apps/worker/src/engine/retention.service.ts` (cron, cerrojo, purga por lotes),
`apps/api/src/modules/bots/bot-series.service.ts` (agregación en SQL con extremos, del 002) y
`packages/shared/src/series.ts` (muestreo y vista de una serie, del 002).

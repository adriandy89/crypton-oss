# 072 — Retirar el «Bot de IA» y TypeSafe

Estado: `cerrado` (mezclado a `main`; falta CA-5 del usuario) · Tipo: `cambio` · Rama: `spec/072-retirar-bot-de-ia`

## Objetivo

Que del «Bot de IA» (`AI_TRADER`, specs 068-070) y de su proveedor, TypeSafe
(`TYPESAFE_AI_API_KEY`, spec 069 y la primitiva `score` del 071), no quede nada: ni código, ni
tipos, ni tests, ni variables de entorno, ni un valor de enum en la base, ni una línea en las guías.
Y que el canal con IA (`AI_CHANNEL`), que tuvo que abrirse para convivir con él, vuelva a ser
exactamente el que era antes del 068.

Se sabrá conseguido cuando `git grep` de sus identificadores no encuentre nada fuera de `specs/` y
de las dos migraciones, cuando los ficheros compartidos que solo cambiaron por él sean **byte a
byte** los de `970c31c` (el merge del 067, justo antes del 068), y cuando todo pase en verde.

## Contexto

Decisión del usuario, el 2026-09-24:

> *«quita todo lo relacionado con el ultimo bot de IA que hicimos y la utilizacion de
> TYPESAFE_AI_API_KEY. Quitalo todo.»*

Estado de partida: el bot está mezclado en `main` desde el 068 (`f68f309`), con el modo IA del 069
(`766a960`) y la cadencia del 070 (`7e7831a`). **Nunca operó con dinero real**: arrancaba apagado
tres veces (`decisionMode: REGLAS`, `AI_TRADER_ENABLE=false`, `AI_TRADER_SHADOW_ONLY=true`). La
primera parte del 071 construyó encima el detector de cascadas y la primitiva `score` de TypeSafe
para una medición que salió negativa; su segunda parte —la revisión del Market Maker V2— no tiene
nada que ver con él y se queda.

El número 072 lo dejaba reservado el 071 para la estrategia de cascadas, que no se construyó; está
libre y se usa aquí.

## Alcance

1. **La estrategia.** `packages/strategy-core/src/trader/` entero —incluido `cascada.ts`, que no
   usa ninguna estrategia y solo existía para medir al modelo—, `strategies/ai-trader*.ts`, su
   entrada en el registro y sus exportaciones. En `packages/shared`, `ia-trader.ts`, el valor del
   enum y las uniones que el 068-069 abrieron en `ia-canal.ts` e `ia-canal-vistas.ts` para que el
   lazo de intenciones admitiera dos formas.
2. **El motor y el backtest.** El lector doble de decisiones de `ai-intents.store.ts`, la reserva
   de cupo compartida por dos estrategias de `engine.service.ts`, la frase de `bot-runner.ts`, y el
   `planGuardado` del replay que aceptaba dos formas de plan.
3. **La API.** `modules/ai-trader` entero —el cliente de TypeSafe, las ocho preguntas, el contrato,
   el lazo, sus cupos y su interruptor— y `AiTraderModule`. En el lazo del canal, el reparto de
   «lo que no es mío se suelta» y el filtro por relación del sondeo: con un solo lazo no hay nada
   que repartir.
4. **La configuración.** `TYPESAFE_AI_API_KEY` y las siete `AI_TRADER_*` fuera de
   `apps/api/.env.example`, `docker/.env.example` y `docker/docker-compose.yml`.
5. **La base de datos.** Una migración nueva que borra los bots y backtests de la estrategia y
   recrea `StrategyKind` sin `AI_TRADER` (R-3).
6. **La app.** La guía, sus 90 etiquetas y ayudas con sus cuatro listas de opciones, el espejo del
   enum y los cinco sitios que el compilador no cazaba (consentimiento, textos del cálculo previo, insignia de riesgo, medidor de camino a la
   liquidación y filtro del buscador de administración).
7. **El nombre del canal.** El 068 lo rebautizó de «Canal con IA» a «Canal» **solo para darle el
   nombre «Bot de IA» al nuevo** (`eaf0762`: *«el nombre "Bot de IA" es del nuevo»*). Sin el nuevo,
   el cambio no tiene razón de ser y vuelve el nombre de antes, en la app y en las guías.
8. **Las guías.** `docs/ai-trader.md` fuera, y sus menciones en `docs/`, `README.md` y `CLAUDE.md`
   —incluida la frase del invariante 13 sobre los «números de opinión» y `cuantiza()`, que solo
   existía por TypeSafe—.
9. **Los specs.** 068, 069 y 070 pasan a «retirado por el 072» en el índice y llevan un aviso
   arriba; el 071 lo lleva en su primera parte.

## Fuera de alcance

- **Borrar los documentos de los specs 068-071.** Son la constancia de lo que se decidió y se midió
  —que el modelo no discrimina (070) y que el edge de las cascadas era un artefacto de la ventana
  (071)—, y la constitución pide conservar esa constancia. Se marcan como retirados.
- **Borrar la migración `20260921090000_strategy_ai_trader`.** Puede estar aplicada en alguna base
  y Prisma se niega a seguir si falta una migración aplicada. Se queda como historia y la nueva la
  deshace.
- **La revisión del Market Maker V2 del 071** (F-01 a F-04, `regimeGuard`, los valores de fábrica,
  `check:labels`). La puerta de régimen usa `canal/regimen.ts` y `canal/numeros.ts`, no `trader/`.
  El F-05 del 071 vivía en `trader/estado.ts` y se va con él.
- **Las claves de Redis** `ai:quota-trader:*` (24 h) y `ai:fail-trader:*` (1 h) caducan solas.
- **El fork OSS**, que tiene el bot desde las sincronizaciones 25 y 26. Portar la retirada es
  decisión aparte del usuario.
- **Desplegar.** Este spec no toca producción.

## Requisitos

- **R-1 — Nada ejecutable ni visible.** Ningún fichero, tipo, test, variable, etiqueta ni texto del
  «Bot de IA» o de TypeSafe fuera de `specs/` y de las dos migraciones.
- **R-2 — El canal, como antes del 068.** Lo que el 068-070 cambió en ficheros compartidos **solo**
  por el bot se devuelve a su versión de `970c31c` con `git checkout`, no reescribiéndolo a mano:
  es el código contra el que se escribieron los tests del canal, y así se comprueba con un `git
  diff` vacío en vez de con una lectura. Eso incluye deshacer la extracción de `dimension.ts`
  (`e5e26a0`), que existía para compartir el dimensionado con el bot. Los ficheros que además tocó
  la revisión del Market Maker V2 se editan a mano quitando solo lo del bot.
- **R-3 — La migración no pierde una posición por sorpresa.**
  - Si hay un bot **real** (`dry_run = false`) de `AI_TRADER` en un estado vivo (`STARTING`,
    `RUNNING`, `PAUSED`, `STOPPING`), **aborta** con un mensaje que dice qué hacer y no cambia
    nada. Es la misma regla que aplica la app al borrar un bot: *«Para el bot antes de
    eliminarlo»*.
  - Si no, borra los bots de `AI_TRADER` —en cascada, como el borrado de la app— y sus backtests
    y entradas del ranking, y recrea `StrategyKind` sin el valor.
  - Los simulados se borran en cualquier estado: no tienen dinero detrás, y exigir pararlos antes
    obligaría a hacerlo con una versión que ya no sabe leerlos.
- **R-4 — Orden de despliegue: la API antes que el worker.** La API corre las migraciones. Un worker
  nuevo contra una base que todavía tiene filas de `AI_TRADER` fallaría al leerlas: su cliente de
  Prisma ya no conoce el valor.
- **R-5 — Las variables se van de los tres sitios a la vez**, y `pnpm check:env` lo confirma.

## Criterios de aceptación

- **CA-1** `git grep -n -i -E "AI_TRADER|ai-trader|aiTrader|typesafe|juezTrader|cuantiza\(|ia-trader|Bot de IA"
  -- ':!specs' ':!packages/db/prisma/migrations'` no devuelve nada.
- **CA-2** `git diff 970c31c -- <los ficheros de R-2>` está vacío (la lista, en `plan.md`).
- **CA-3** La migración, aplicada sobre una base de prueba con todas las anteriores:
  (a) con un bot real de `AI_TRADER` en marcha, aborta con su mensaje y no cambia nada;
  (b) sin él, borra los bots de `AI_TRADER` —reales parados y simulados en marcha—, sus backtests y
  sus filas hijas, deja intactos los bots de las demás estrategias y el enum queda sin el valor.
- **CA-4** `pnpm build:packages`, `pnpm test`, `pnpm lint`, `pnpm check:env`, `pnpm check:labels`,
  typecheck y build de la app, y build de la API y del worker, en verde. Los recuentos, en
  `tasks.md`.
- **CA-5** *(usuario)* `pnpm prisma:deploy` en local tras mezclar; y en producción, la API antes que
  el worker.

## Riesgos

- **Una base con un bot real de `AI_TRADER` en marcha.** La migración aborta a propósito. Para
  seguir: parar el bot con la versión anterior, `prisma migrate resolve --rolled-back
  20260924120000_retirar_ai_trader` y volver a desplegar. Con el bot apagado tres veces de fábrica
  y el usuario sin bots corriendo (071), no se espera ninguno.
- **Deshacer la extracción de `dimension.ts`.** Es el dimensionado que decide cuánto dinero entra en
  cada orden del canal. Se mitiga con R-2: no se escribe nada, se restaura el código de antes, que
  es el que cubren `canal/herramienta.spec.ts` y su prueba de propiedad.
- **El empuje automático de VS Code** publica en `origin` lo que se commitea en `main` (memoria del
  fork). El servidor solo despliega con `git pull` a mano, así que publicarlo no despliega nada.

## Referencias oficiales

No aplica: no toca ningún venue ni SDK.

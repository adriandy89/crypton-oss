# 010 — Comandos y ciclo: lo que el usuario pulsa hace lo que dice

Estado: `hecho` (2026-09-06) · Tipo: `cambio` · Rama: `spec/010-comandos-y-ciclo`

## Objetivo

Que las opciones y comandos de las escaleras y rejillas hagan lo que prometen: el take profit «a mercado»
espera al objetivo, «Recentrar la retícula» no duplica compras ni finge recentrar, «Adelantar seguridad»
ejecuta al precio actual y anuncia según el acuse, la espera entre ciclos se puede cambiar en caliente, y
la entrada base «Límite» tiene una sola conducta. Estará hecho cuando los cinco tests que hoy faltan pasen
y los dependientes sigan en verde.

## Contexto

Hallazgos del spec 001 que activa el usuario desde el formulario o el menú del bot, con bots en marcha:

| F | Título | Sev. | Efecto hoy |
|---|---|---|---|
| F-80 | Martingale con `tpMode: MARKET`: salida a mercado **sin disparador** | Alta | En Aster cierra la posición al instante, cierra ciclo, espera y reabre: bucle que quema comisiones; en HL se cancela y reemite; en Lighter puede quedar «ejecutada» sin serlo |
| F-84 | `REANCHOR_GRID` hace daño o nada según la estrategia | Alta | Grid Classic con inventario: segunda compra por nivel y sin ventas; Neutral Grid: no-op; escaleras: recuelga todo bajo el mark sin confirmar |
| F-85 | `ADD_SAFETY_NOW` manda la seguridad a mercado con el precio de la escalera y anuncia sin mirar el acuse | Media | En HL una seguridad a > ~4,8 % del mark no se ejecuta y el usuario recibe «ejecutada a mercado» |
| F-86 | `cooldownMinutes` congelado en la primera fila de ciclo | Media | Un cambio HOT nunca surte efecto; paridad con el backtest rota |
| F-92 | `baseOrderType: LIMIT` tiene dos conductas | Media | Martingale la persigue al precio cada revisión; GridMart la deja fija sin caducidad |

## Alcance

- `packages/strategy-core/src/strategies/martingale.ts` (TP condicional; base LIMIT), `gridmart.ts` (base
  LIMIT), `neutral-grid.ts` (ancla del ciclo), sus specs.
- `apps/worker/src/engine/bot-runner.ts` (`REANCHOR_GRID`, `ADD_SAFETY_NOW`), `bot-store.ts`
  (`cooldownMinutes` de la config vigente), `apps/api/src/modules/bots/bots.service.ts` (`confirm` y
  rechazo de `REANCHOR_GRID`), `apps/app/src/app/shared/bot/bot-commands.service.ts` (ocultar comandos
  donde no aplican y confirmar el recentrado), sus specs.
- `docs/`: bloques de F-80, F-84, F-85, F-86, F-92; fichas del 001.

## Fuera de alcance

- Que el motor honre `cooldownUntil` en Grid Classic, Neutral Grid y TDCA (hoy solo lo leen Martingala y
  GridMart): es cambiar la semántica de un parámetro muerto en tres estrategias; va a
  `019-validacion-y-parametros-muertos` con decisión del usuario.
- F-81, F-82, F-87, F-88, F-89, F-90 (dimensionado y preview de rejillas): `017-grids-dimensionado-y-preview`.
- Cambios de `defaults()`.

## Requisitos

- **R-1** (F-80) Con `tpMode = MARKET`, la salida de Martingala se emite como `MARKET` **con
  `triggerPrice`** igual al precio objetivo (orden condicional que el motor ya traduce con `intent: 'TP'`
  y el simulador modela desde F-45). Con `tpMode = LIMIT` nada cambia.
- **R-2** (F-84) `REANCHOR_GRID`: fuera de las escaleras se **rechaza** con `ACTION_FAILED` y motivo:
  en Grid Classic siempre (las líneas salen del rango; con inventario además duplicaría compras), en
  Neutral Grid (el centro es «Precio ancla», y editarlo es recentrar), en TDCA y en los market makers (no
  hay ancla). En Martingala y GridMart la API exige `confirm` y el evento anota el margen que se
  compromete. La app oculta el comando donde no aplica y pide confirmación antes de recentrar.
  *Decisión al implementar*: el borrador proponía que Neutral Grid leyera `ctx.cycle.anchorPrice` en
  `plan()`; se descartó porque crearía un ancla oculta que una edición posterior de «Precio ancla» (WARM)
  no podría pisar, y cambiaría la semántica de un parámetro con bots en marcha.
- **R-3** (F-85) `ADD_SAFETY_NOW` manda la seguridad a mercado con el **precio de marca** (la holgura la
  pone el adaptador) y emite `SAFETY_ADDED` solo con acuse, diciendo su estado (`FILLED`, o enviada a la
  espera del fill: Aster y Lighter acusan antes de ejecutar); sin acuse, WARN `ADD_SAFETY_SKIPPED`.
- **R-4** (F-86) Al cerrar un ciclo, `cooldownUntil` se calcula con el `cooldownMinutes` de la
  configuración **vigente**, no con el guardado al abrir el ciclo.
- **R-5** (F-92) Una sola conducta para la base `LIMIT` en Martingala y GridMart: precio fijado al emitir
  (post-only al precio del momento), **sin persecución** y con caducidad al pasar `refreshSeconds`-equivalente
  de 5 minutos, tras la cual se recoloca al precio actual. Documentada en la ayuda in-app.

## Criterios de aceptación

- **CA-1** `strategies.spec.ts` «con tpMode MARKET la salida es condicional: lleva disparador y no se
  ejecuta al colocarla» pasa; `bot-runner.strategies.spec.ts` «Martingala con tpMode MARKET no cierra en el
  acto» pasa contra el simulador.
- **CA-2** `bot-runner.spec.ts` «REANCHOR_GRID en Grid Classic con inventario se rechaza y conserva la
  venta», «… en la rejilla neutral se rechaza y remite a Precio ancla» y «… en una martingala recentra y
  anota el margen que compromete» pasan; `bots-reanchor.spec.ts` (API) pasa.
- **CA-3** `bot-runner.spec.ts` «ADD_SAFETY_NOW sale a mercado al precio de marca, no al del escalon» y
  «ADD_SAFETY_NOW sin acuse no anuncia SAFETY_ADDED» pasan.
- **CA-4** `bot-runner.spec.ts` «reloadConfig HOT de cooldownMinutes se aplica al cerrar el ciclo» pasa.
- **CA-5** `strategies.spec.ts` «la base LIMIT de Martingala no se recoloca al moverse el precio» y «la
  base LIMIT de GridMart caduca y se recoloca» pasan.
- **CA-6** `pnpm test`, `pnpm lint`, `pnpm --filter app build` en verde.
- **CA-7** `grep -rn "F-80\|F-84\|F-85\|F-86\|F-92" docs/` sin bloques «Limitación conocida»; las fichas
  in-app de `tpMode`, `baseOrderType` y `reanchorOnDrift` vuelven a describir la conducta nueva.

## Riesgos

- **Bots en marcha**: R-1 cambia lo que hace un bot con `tpMode: MARKET` (hoy, cerrar al instante):
  cualquier bot así configurado está perdiendo dinero en bucle, y el cambio lo detiene. R-4 hace que un
  cambio HOT que hoy se ignora pase a aplicarse. R-5 cambia la base LIMIT de Martingala (deja de perseguir).
  Se aprueban viendo el diff.
- **Tests existentes** que fijan la conducta actual de la base LIMIT o del reanchor se reescriben con el
  nuevo en rojo primero.

## Referencias oficiales

Ninguna regla de venue nueva. Las condicionales `TAKE_PROFIT` ya están mapeadas por adaptador desde F-46
(Lighter `ORDER_TYPE_TAKE_PROFIT`, Hyperliquid trigger `tp`, Aster `TAKE_PROFIT_MARKET`).

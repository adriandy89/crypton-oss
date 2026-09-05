# 004 — Backtest para todos

Estado: `en curso` · Tipo: `cambio` · Rama: `spec/004-backtest-para-todos` · Base: `875526d` (punta de `spec/007-panel-operativo`; el usuario aprobó el 2026-09-05: «sí, haz todo lo necesario»)

## Objetivo

Que cualquier usuario pueda contestar **«¿cómo habría ido esta configuración el mes pasado?»**
desde su propio bot simulado, guardar el resultado, volver a abrirlo y comparar dos ejecuciones;
y que lo que el backtest devuelve **sea verdad para las configuraciones con stop-loss**, que hoy
no lo es.

Estará conseguido cuando el simulador deje el stop en reposo hasta que el precio lo cruce (con el
test que lo confirma), el backtest salga de detrás de `adminGuard` acotado a los bots del usuario
y con su cupo, la pantalla liste y reabra las ejecuciones guardadas, enseñe las operaciones y
compare dos ejecuciones lado a lado.

## Contexto

Seguimiento **004** propuesto por `specs/002-app-analitica/findings.md` (propuesta P-11), que lo
dejó **bloqueado por 001/F-45**: el simulador (`DryRunAdapter`) no modela las órdenes condicionales
y ejecuta un stop-loss —`MARKET` con `triggerPrice`— en el acto, como orden a mercado. En simulación
y en backtest, toda posición con `stopLossPct` se cierra nada más abrirse, con taker y
deslizamiento, y vuelve a entrar en bucle. Abrir el backtest a todos con eso dentro sería publicar
una herramienta que miente justo a quien configura stop, que es quien más cuidado tiene.

F-45 es de severidad **Alta** (sería Crítica sin el modificador «solo simulación»). La
constitución reserva las correcciones dentro del 001 a las Críticas; una Alta va a un spec propio,
y este es el suyo: entra como **fase 1**, con el test que la ficha describe.

Lo demás ya existe y está detrás de un guard de administrador: `POST /admin/backtests` con su
cupo de cinco por minuto, `GET /admin/backtests` (lista), `GET /admin/backtests/:id` (`detail()`,
escrito en la app y **nunca llamado**), `GET /admin/backtests/:id/fills`, `DELETE`, y la pantalla
`admin/backtest` que lanza y borra pero no reabre ni compara.

## Alcance

- `packages/exchange-core/src/adapters/dry-run.ts`: órdenes condicionales en reposo, disparadas
  por el precio de marca, con el sentido por `intent` o, sin él, por el precio de marca al colocar.
  Estado persistible compatible con el guardado anterior. Tests en `exchange-core.spec.ts`.
- `packages/backtest/src/engine.spec.ts`: un test de que un bot con `stopLossPct` no cierra en el
  acto y sí cierra cuando el precio cruza el stop.
- `apps/api/src/modules/backtests`: ruta `backtests` para cualquier usuario autenticado, acotada a
  **sus** bots y **sus** ejecuciones; `admin/backtests` deja de existir. Cupo por usuario.
- `apps/app`: la pantalla pasa a `features/backtest/`, ruta `/backtest` con `authGuard`; lista y
  **reabre** ejecuciones guardadas; tabla de operaciones; comparación de dos ejecuciones. Enlaces
  desde Cuenta y desde el detalle de un bot simulado para todos, no solo para admin.

## Fuera de alcance

Fuentes de velas nuevas; cambiar la semántica de ningún parámetro del backtest; exportar a fichero
(portapapeles sí, con `aCsv` del 006); backtest sobre bots **reales** (se reproduce la
configuración de bots simulados, como hasta ahora, porque son los que el usuario tiene para
probar); optimización de parámetros; el resto de hallazgos del 001, que siguen su protocolo.

## Requisitos

- **R-1** Línea base registrada (tests por paquete con los rojos conocidos del 001, lint, build).
- **R-2 (F-45)** Una orden con `triggerPrice` se guarda en reposo y NO se ejecuta al colocarla. Se
  dispara cuando el precio de marca la cruza: hacia abajo si es un stop de largo o un take-profit
  de corto, hacia arriba en los casos contrarios; el sentido sale de `intent` y, sin él, de la
  posición del disparador respecto al precio de marca al colocarla (como hace Hyperliquid). Al
  dispararse, una `MARKET` cruza el libro **al precio del disparador** con taker y deslizamiento
  en contra —el mismo criterio que las limit, que se llenan a su precio—; una `LIMIT` pasa a ser
  una limit en reposo. Un stop por encima de la liquidación se dispara **antes** que ella en el
  mismo tick; uno por debajo, no. El estado exportado conserva las condicionales y un estado
  guardado sin el campo nuevo se importa igual.
- **R-3** `GET /bots/:id/…` no cambia; `backtests` sustituye a `admin/backtests`: `POST` con cupo
  de 5 por minuto por usuario, solo sobre bots del usuario (404 si no es suyo); `GET` lista
  **solo sus** ejecuciones; `GET :id`, `GET :id/fills` y `DELETE :id` solo sobre las suyas (404 si
  no). Los administradores no ven las de otros: no hay pantalla que lo pida.
- **R-4** La pantalla lista las ejecuciones guardadas del usuario y **reabre** cualquiera sin
  volver a correrla (`detail()` + `fills`), con el mismo resultado, curvas y marcadores que al
  lanzarla.
- **R-5** Tabla de operaciones del resultado (las ejecuciones acotadas que devuelve el servidor),
  con «Copiar CSV».
- **R-6** Comparar dos ejecuciones guardadas: las métricas principales lado a lado, con la
  diferencia marcada. Sin gráficas superpuestas: dos escalas de dinero en un eje es el error de
  gráfico número uno.
- **R-7** Los avisos del resultado (`warnings`, hipótesis del replay) siguen arriba y siempre.

## Criterios de aceptación

- **CA-1** El test de la ficha F-45 existe en `exchange-core.spec.ts` y **fallaba** antes de la
  corrección (confirmación) y pasa después; el resto de la suite igual que la línea base (los tres
  rojos deliberados del 001 siguen en rojo, ninguno nuevo).
- **CA-2** `pnpm test:backtest` en verde con el test nuevo del stop; los 24 anteriores sin tocar.
- **CA-3** `pnpm --filter worker test` igual que la línea base.
- **CA-4** Un usuario sin rol ADMIN lanza un backtest sobre su bot simulado y recibe 404 sobre el
  bot o la ejecución de otro. Tests del servicio.
- **CA-5** Reabrir una ejecución guardada pinta exactamente lo que se pintó al lanzarla. Se
  comprueba a mano.
- **CA-6** `pnpm --filter app build` dentro de presupuesto; lint limpio en app y API.

## Riesgos

- **Toca el simulador que corre bajo los bots simulados de todos.** El cambio es estricto en un
  sentido: solo cambia lo que pasa con órdenes que llevan `triggerPrice`, que hoy se ejecutan mal.
  El resto del camino —limit, market, post-only, liquidación— no cambia y sus tests lo dicen.
- **Estado guardado.** `PaperStateStore` persiste `DryRunState`; el campo nuevo es opcional y
  quien importe un estado viejo deduce el sentido por `intent` o por el lado.
- **Coste de CPU al abrir el backtest a todos.** Se mantiene el cupo de 5 por minuto, ahora por
  usuario, y el tope de barras del servidor. Con más usuarios habría que mover la ejecución a una
  cola; se anota como seguimiento si se llega a notar.
- **Cambio de ruta de la API.** `admin/backtests` desaparece; la app es el único consumidor y
  cambia en el mismo commit.

## Decisiones

- El stop disparado se llena al precio del disparador (más deslizamiento), no al bid del tick: es
  el mismo supuesto de camino continuo con el que ya se llenan las limit, y con el paso de vela del
  backtest el bid de un mínimo puede estar muy por debajo del stop.
- El sentido sin `intent` se deduce del precio de marca al colocar, no del lado: `withStopLoss`
  no rellena `intent` y una venta condicional puede ser stop o take-profit.
- Backtest solo sobre bots simulados del usuario, como hasta ahora; los administradores pierden la
  vista global porque nadie la usaba.

## Referencias oficiales

Ninguna nueva. Referencias internas: `specs/001-revision-integral/findings.md` (F-45),
`packages/exchange-core/src/adapters/dry-run.ts`, `packages/strategy-core/src/stop-loss.ts`,
`packages/backtest/src/engine.ts`, `apps/api/src/modules/backtests/*`,
`apps/app/src/app/features/admin/backtest.page.*`.

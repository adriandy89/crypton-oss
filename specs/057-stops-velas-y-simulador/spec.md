# 057 — Los stops nativos, las velas y el simulador

Estado: `hecho` (11 hallazgos corregidos dentro; falta CA-4 manual y el despliegue) · Tipo:
`revisión` · Rama: `spec/057-stops-velas-y-simulador`

## Objetivo

Corregir fallos que **ya existen** y afectan a bots en marcha, antes de construir sobre ellos el bot
de IA de canales (specs 058-059).

Se sabrá que está hecho cuando:

- cada hallazgo de `findings.md` tenga estado;
- los confirmados tengan un test que fallaba con el código anterior y su arreglo;
- la verificación completa esté en verde y las mutaciones de los arreglos caigan.

## Contexto

Salieron al diseñar el bot `AI_CHANNEL` (2026-09-17). Ese bot opera con apalancamiento alto y se
apoya entero en tres cosas:

- **el stop nativo**;
- **las velas cerradas**;
- **un backtest y un simulador que no mientan**.

Tres revisores independientes (motor, IA y riesgos) leyeron el código para ese diseño. Dos de sus
hallazgos, confirmados después leyendo el código, son candidatos a Crítica y afectan a bots que
operan hoy:

- **F-01.** Los stops nativos se cancelan y se recolocan en cada tick.
- **F-02.** Tendencia suelta su stop si le faltan velas.

El resto degrada lo que el bot nuevo necesita: velas que se dan por cerradas sin estarlo, un
backtest que nunca pasa velas a las estrategias y un simulador que ignora `reduceOnly`.

## Cómo se trata

- Cada hallazgo sigue el protocolo de `specs/README.md`:
  1. Un test que falla por el motivo declarado.
  2. El arreglo mínimo.
  3. Un commit.
- Se corrigen **todos los confirmados** dentro, como en 052 y 056, por decisión del usuario al
  aprobar el plan del 2026-09-17: 058 depende de ellos y dos afectan a bots en marcha.
- Lo que no se confirme queda con su estado y su motivo.
- Nada de esto cambia valores por defecto ni la semántica de ningún parámetro de usuario.

## Alcance

| Área | Ficheros |
|---|---|
| strategy-core | `reconcile.ts` (F-01), `strategies/trend-follow.ts` y `types.ts` (F-02, flag `stopPropio`) |
| shared | `candle.ts` (F-04, `agregarVelas`), `orders.ts` (F-06, `ExchangeError.estadoDesconocido`) |
| exchange-core | adaptadores de Aster y Lighter (F-01), Hyperliquid (F-07), `dry-run.ts` (F-01, F-05), `venue-budget.ts` (F-10), `rate-limit.ts` (F-06) |
| worker | `engine/bot-runner.ts` (F-02, F-06, F-08, F-09, F-11), `marketdata/market-data.service.ts` (F-03) |
| backtest | `engine.ts` y `warnings.ts` (F-04) |
| app | `core/utils/labels.ts` (F-08: la etiqueta de `COMMAND_FAILED`) |
| guías | `simulacion-y-backtest.md`, `trend-follow.md`, `trailing-profit.md`, `comandos-guardas-y-eventos.md`, `riesgo-y-liquidacion.md` |

## Fuera de alcance

- Todo lo del bot `AI_CHANNEL` (specs 058-059).
- Mover un stop colocando el nuevo antes de cancelar el viejo: hoy hay una ventana de milisegundos
  al reemplazarlo. Necesita cambiar el esquema de índices y va en su propio spec.
- Cualquier sonda contra un venue. Las respuestas de Aster y Lighter se toman de su documentación y
  de los tipos de sus SDK.

## Criterios de aceptación

- **CA-1** — Cada hallazgo de `findings.md` tiene estado. Los corregidos llevan su test, que falla
  con el código anterior.
- **CA-2** — `pnpm test`, `pnpm lint`, `pnpm check:env`, `tsc` de la API y los builds de la API, el
  worker y la app en verde.
- **CA-3** — Las mutaciones de los arreglos caen.
- **CA-4** — *(manual, opcional)* Consulta de solo lectura en producción: cuántos reemplazos de
  `STOP_LOSS` había antes del despliegue y cuántos después.

## Riesgos

| Riesgo | Mitigación |
|---|---|
| Comparar el disparo en vez del precio deja de mover un stop que sí cambió | Se compara `triggerPrice`, que es lo que mueve un stop, y un test cubre el stop de seguimiento de Tendencia |
| Un adaptador que no informa del disparo deja un stop desactualizado para siempre | Si la orden viva no trae disparo, se reemplaza, como hasta ahora |
| Recortar `reduceOnly` en el simulador cambia resultados de backtests de otras estrategias | Es el comportamiento real del venue; se anota en la guía de simulación |
| Dejar pendiente una orden en estado desconocido bloquea un nivel | Hasta el vencimiento que ya existe (5 min), igual que cualquier fila PENDING sin acuse |

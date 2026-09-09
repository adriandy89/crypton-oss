# 031 — Los pendientes de los specs 029 y 030, y las pruebas que faltaban

Estado: `en curso` · Tipo: `cambio` · Rama: `spec/031-pendientes-y-pruebas`

## Objetivo

Cerrar lo que los specs 029 y 030 dejaron abierto y, sobre todo, **sustituir por pruebas
automáticas las comprobaciones manuales** que se le habían dejado al usuario. Se sabrá conseguido
cuando cada una de esas comprobaciones sea un test que falla sin su arreglo.

## Contexto

El spec 029 se cerró con tres comprobaciones manuales pendientes, una decisión de valores de fábrica
sin tomar y tres mejoras de caudal aplazadas. El usuario pidió que no quedara nada por comprobar a
mano: que las pruebas las haga el código.

Durante el trabajo apareció además una trampa que conviene dejar escrita: **los tests del worker
consumen `strategy-core` desde `dist`**, no desde el fuente. Un test de integración escrito para
demostrar un arreglo pasaba igual con el arreglo desactivado, simplemente porque el `dist` seguía
teniendo la versión buena. Sin `pnpm build:packages` en medio, un test así no prueba nada.

## Alcance

- `apps/worker`: `bot-runner.ts` (aviso de latido estirado) y los dos specs de motor.
- `packages/strategy-core`: recotizado por capa (`mm-shared.ts`, `market-maker.ts`) y el aviso de
  ausencia de stop en las dos estrategias de market making.
- `packages/exchange-core`: ámbito del enfriamiento por corte del venue (`cooldown.ts`).
- `apps/app`: etiqueta del evento nuevo.

## Fuera de alcance

- El `QUOTE_BID#1 SELL` del aviso original: la base local está vacía y el fuente no puede producirlo.
  Sigue necesitando la base real del usuario.
- Llevar el recotizado por capa a la V2. La V1 es la que tiene el sesgo por inventario y la que
  disparó el incidente; la V2 comparte el motor y se hará con su medida cuando haya evidencia de que
  también satura.

## Requisitos

- **R-1** Las tres comprobaciones manuales del spec 029 son tests automáticos contra el simulador.
- **R-2** Cada uno de esos tests **falla** si se revierte el arreglo que prueba.
- **R-3** Un tick que tarda más que su propio intervalo se avisa, con enfriamiento.
- **R-4** El enfriamiento por corte del venue es de proceso, no de adaptador.
- **R-5** Una capa cuyo precio apenas se ha movido conserva su sitio en el libro.
- **R-6** Un market maker sin stop-loss lo dice **al crearlo**, sin cambiar los valores de fábrica.

## Criterios de aceptación

- **CA-1** `bot-runner.strategies.spec.ts` cubre: market maker cargado sin rechazos ni cruces, ancla
  por debajo del libro, caída y vuelta del stream, y modo «cantidad de moneda» en un par caro.
- **CA-2** Con el clamp desactivado y `pnpm build:packages` hecho, los dos primeros fallan con
  «Post-only rechazada: cruzaría el libro». **Verificado**.
- **CA-3** El aviso de latido estirado se emite una vez por ventana y no antes de tiempo.
- **CA-4** Dos cuentas del mismo venue comparten el corte; venues distintos, no.
- **CA-5** La capa lejana tolera más desviación que la cercana, en proporción a su distancia.
- **CA-6** Los `defaults()` de los dos market makers siguen **sin** `stopLossPct`, y `validate()`
  avisa cuando falta.
- **CA-7** `pnpm test`, `pnpm lint`, `pnpm check:env` y el typecheck de la app, en verde.

## Riesgos

- **El recotizado por capa cambia la conducta**: una orden puede quedarse donde está aunque el precio
  deseado se haya movido unos bps. Es el objetivo —conservar el sitio en la cola y no quemar cuota—,
  y la tolerancia es proporcional a la distancia de cada capa, así que la que cotiza al toque sigue
  al precio como antes.
- **El enfriamiento compartido es más conservador**: un corte en una cuenta ahora detiene las demás
  del mismo venue en ese proceso. Es deliberado; el cortafuegos castiga por IP.
- **No se ha tocado ningún valor de fábrica.** El stop de los market makers se avisa, no se impone:
  al dispararse cierra la posición pero **no** para el bot, así que uno estrecho sería una máquina de
  vender en el mínimo y recomprar.

## Referencias oficiales

Las ya citadas en los specs 029 y 030 (Lighter: 60 peticiones/minuto por IP, «Firewall: 60 seconds»;
Aster: escalado del 418). No se apoya en ninguna regla nueva.

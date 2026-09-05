# 006 — Historial de configuración y cronología por ciclo

Estado: `en curso` · Tipo: `cambio` · Rama: `spec/006-historial-y-cronologia` · Base: `d9e5311` (`main`, tras avanzar los specs 002, 003 y 005; el usuario pidió el 2026-09-05 «continúa los specs siguientes»)

## Objetivo

Que el detalle de un bot conteste dos preguntas que hoy obligan a cruzar pantallas o a leer la
base: **«¿qué cambié, cuándo, y qué pasó después?»** y **«¿qué pasó en el ciclo 7, en orden?»**.
Y que los ciclos y las órdenes se puedan llevar a una hoja de cálculo sin pedir nada nuevo al
servidor.

Estará conseguido cuando la pestaña Ajustes enseñe el historial de revisiones con lo que cambió en
cada una, la pestaña Eventos pueda verse por ciclo con órdenes, ejecuciones y sucesos en una sola
lista ordenada, y un toque copie los ciclos o las órdenes como CSV.

## Contexto

Seguimiento **006** propuesto por `specs/002-app-analitica/findings.md` (propuestas P-03, P-04 y
P-07 del catálogo). Lo que hace falta ya existe y no se lee:

- `bot_config_revisions` se escribe en cada creación y cada cambio de configuración
  (`apps/api/src/modules/bots/bots.service.ts:846,957`), con el `diff` de lo que cambió y el nivel
  con el que se aplicó, y **ningún endpoint la sirve**. El comentario del modelo dice para qué
  existe: «responder a "¿por qué el bot hizo esto?" mirando qué configuración estaba vigente».
- Órdenes, ejecuciones y eventos se sirven por separado (`/orders`, `/fills`, `/events`) y la
  pantalla los pinta en tres listas; el ciclo al que pertenecen viaja en las dos primeras
  (`cycle_seq`) y en la tercera solo por la hora.

## Alcance

- `apps/api/src/modules/bots`: `GET /bots/:id/revisions` (lectura, misma guarda `mustOwn` que
  `/events`), con test del mapeo.
- `packages/shared/src/timeline.ts` (**nuevo**): agrupación por ciclo, pura y con spec.
- `packages/shared/src/csv.ts` (**nuevo**): serialización CSV, pura y con spec.
- `apps/app`: cliente `revisions()`, modelo `BotConfigRevision`, historial en la pestaña Ajustes,
  vista «por ciclo» en la pestaña Eventos, botones «Copiar CSV» en ciclos y órdenes. CSS nuevo en
  `global.scss` (`bd-*`) por el presupuesto de 6 kB.

## Fuera de alcance

Exportar a fichero (necesita `@capacitor/filesystem` y `@capacitor/share`, que no están instalados;
el portapapeles sí, y es lo que se usa); marcar los cambios de configuración sobre la curva de
resultado (`ui-spark` admite una sola marca; sería un spec propio si se echa en falta); restaurar o
editar una revisión antigua; cualquier cambio en cómo se escriben las revisiones; el backtest.

## Requisitos

- **R-1** Línea base registrada (tests por paquete con los rojos conocidos del 001, lint, build).
- **R-2** `GET /bots/:id/revisions?limit&offset` devuelve, de la más nueva a la más vieja:
  `version`, `createdAt`, `applyLevel` (HOT | WARM | COLD | null), `appliedBy` y `diff` (la lista
  de cambios `{ key, from, to, mutability, labelKey }` tal y como la escribió `updateConfig`, o
  `null` en la v1). Nunca la configuración completa: ya la sirve `GET /bots/:id`.
- **R-3** El historial de la pestaña Ajustes enseña cada revisión con su versión, cuándo, cómo se
  aplicó (`ui-mutability-badge`) y qué cambió con el **nombre legible del campo** y los valores
  «de → a» pasados por el mismo formateo que los campos COLD. La v1 se rotula «Creación».
- **R-4** La vista por ciclo de la pestaña Eventos funde órdenes, ejecuciones y sucesos en una lista
  por ciclo, ordenada en el tiempo. Órdenes y ejecuciones van al ciclo que dice su `cycle_seq`;
  los sucesos, al ciclo cuya ventana temporal los contiene; lo que no cae en ninguno se agrupa
  aparte y se dice. La agrupación es una función pura con test (`cronologiaPorCiclo`).
- **R-5** Las ejecuciones solo se piden cuando se abre la vista por ciclo: son una petición más por
  refresco y la bitácora plana no las necesita.
- **R-6** «Copiar CSV» en la tarjeta de ciclos cerrados y en la pestaña Órdenes copia al
  portapapeles (`@capacitor/clipboard`) con cabecera, separador `;`, saltos `\r\n` y comillas donde
  hace falta (`aCsv`, con test). Los importes van con punto decimal, tal y como los guarda la
  base, y el aviso tras copiar lo dice.
- **R-7** Nada de esto añade peticiones al refresco de la pantalla salvo la de revisiones, que se
  pide con el detalle y cae a lista vacía si falla.

## Criterios de aceptación

- **CA-1** `cronologiaPorCiclo` y `aCsv` tienen spec en `packages/shared`; `pnpm --filter
  @crypton/shared test` en verde.
- **CA-2** `GET /bots/:id/revisions` de un bot ajeno responde 404, como los demás endpoints del bot;
  el mapeo tiene test.
- **CA-3** Con un bot con tres revisiones, Ajustes enseña tres entradas, la primera «Creación», y
  en las otras el campo por su nombre legible y los valores de antes y de después.
- **CA-4** Con un bot con dos ciclos cerrados, la vista por ciclo enseña las órdenes y ejecuciones
  de cada uno bajo su cabecera y los sucesos en la ventana que les toca. Se comprueba a mano con
  un bot simulado.
- **CA-5** El CSV copiado de los ciclos abre en una hoja de cálculo con una fila por ciclo y las
  cabeceras en la primera. Se comprueba a mano.
- **CA-6** `pnpm --filter app build` dentro de presupuesto; lint limpio en app y API.

## Riesgos

- **El `diff` no tiene forma garantizada.** Lo escribe `updateConfig` a partir de `changed` y es un
  `Json`. Se lee con tolerancia: cada cambio se pinta si tiene `key`, y lo que no se entiende se
  enseña crudo en vez de romper la lista.
- **Los sucesos no llevan ciclo.** Asignarlos por ventana temporal es una aproximación: un evento
  escrito en el mismo milisegundo en que se abre el ciclo siguiente puede caer en el anterior. Se
  asume y se dice en la pantalla («por la hora»).
- **Presupuesto de CSS.** `bot-detail.page.scss` acaba de volver a caber en 6 kB (spec 005); lo
  nuevo va a `global.scss`.

## Decisiones

- CSV al portapapeles y no a fichero: no exige plugins nuevos y cubre el caso («llevármelo a una
  hoja»).
- Separador `;` y punto decimal: es lo que abre Excel en castellano sin asistente, salvo por los
  decimales, que se avisan.
- El historial se pide con el detalle (una petición más, cacheable) en vez de al abrir la pestaña:
  es pequeño y así la pestaña no parpadea.

## Referencias oficiales

Ninguna. Referencias internas: `bots.service.ts` (`updateConfig`, `diff.changed`),
`packages/shared/src/candle-paging.ts` (precedente de lógica de pantalla en `shared` con test),
`apps/app/src/app/core/utils/field-labels.ts` (nombres legibles de los campos).

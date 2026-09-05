# 005 — Tareas

Una casilla por tarea, agrupadas por fase. Se marcan al terminar, con una nota corta si hubo
sorpresas. Nada se da por hecho sin la verificación de su fase.

## Fase 0 — Aprobación y línea base

- [x] Preguntas abiertas del `spec.md` contestadas — 2026-09-05: el panel entra apagado por defecto; los cuatro tipos informativos se pintan
- [x] Rama `spec/005-grafico-avanzado` creada desde `498c2b1`
- [x] `pnpm build:packages`, tests por paquete (`shared` 61, `api` 4189, `worker` 266 + 2 rojos del 001, `backtest` 24), lint limpio

## Fase 1 — Sucesos

- [x] `buildEventMarkers` (`bot-overlay.ts`) sobre `agruparSucesos` de `shared`; rótulos cortos propios (`EVENT_SHORT`): la frase de `eventLabel()` no cabe sobre una vela
- [x] En vez de `OverlayMarker.shape`, un tipo aparte `OverlayEventMarker` y un input nuevo `events` en `price-chart`: los sucesos se anclan a la barra y no a un precio, y así ningún input existente cambia de tipo (R-6). Cuadrado ámbar lo grave, círculo lo informativo
- [x] Capa «Sucesos» en la leyenda-interruptor
- [x] Test de la agrupación y el filtro — `packages/shared/src/chart-events.spec.ts`, 6 tests (CA-1); con cien eventos en una vela salen dos marcadores (CA-2)

## Fase 2 — Hojas compartidas

- [x] `BotCommandsService` (`shared/bot/`), servicio y no componente: la hoja es un `ActionSheet` que se crea por código. `COMMAND_LABELS`, `DESTRUCTIVE_COMMANDS` y las confirmaciones viven ahí
- [x] `ui-margin-sheet` extraído, con sus estilos (y `bot-detail.page.scss` vuelve a caber en el presupuesto de 6 kB)
- [x] `bot-detail` usa los dos; misma conducta por construcción. **CA-4 a mano pendiente**: un `PANIC` desde el gráfico y desde el detalle piden el mismo texto
- [x] «Acciones» del gráfico abre la hoja de comandos y «Ajustar margen» sale junto a la barra de liquidación. **Apaisado a mano pendiente**: la barra inferior `cta` se esconde ahí y la fila de liquidación es el acceso que queda

## Fase 3 — Precio medio como serie

- [x] `average` en `price-chart` (panel 0, huecos como datos en blanco), vacío por defecto; rótulo «MEDIO» en el eje
- [x] `chart.page` la alimenta desde el rango del 002 (`snapshotsEnRango` desde la primera vela cargada, refrescada como mucho una vez por minuto) casada a las velas con `muestrasPorVela`, y retira la línea `MEDIO` cuando hay serie. Apagar la escalera apaga también la serie

## Fase 4 — Panel de resultado

- [x] `result` en `price-chart`: serie de línea base con el cero como base en el panel siguiente al volumen (20 % de la altura), vacío por defecto; ajuste «Resultado bajo el precio» en la hoja del gráfico, apagado por defecto
- [x] `chart.page` casa la serie a las velas cargadas (una muestra por vela, la última) en vez de al número de velas visibles: el motor comparte la escala de tiempo y un instante fuera de las velas abriría huecos
- [ ] CA-3 a mano: sin bot, series y alturas idénticas a hoy (por construcción los inputs vacíos no crean nada; falta mirarlo con el inspector)
- [ ] CA-5 a mano: eje de tiempo compartido al arrastrar

## Cierre

- [x] Criterios de aceptación repasados — CA-1, CA-2, CA-6 cumplidos (`ng build` sin ningún aviso, lint limpio); **CA-3, CA-4 y CA-5 pendientes de la comprobación manual** con un bot simulado
- [ ] Índice de `specs/README.md` a `hecho` — cuando CA-3..CA-5 estén comprobados
- [x] Memoria de usuario actualizada

# 063 — Tareas

## Fase 0 — Línea base

- [x] Rama `spec/063-limites-que-llegan-al-motor` creada desde `main` limpia
- [x] `pnpm build:packages`
- [x] `pnpm --filter worker test` — 595 en verde antes de tocar nada

## Fase 1 — Los tests que fallan primero

- [x] Subir el tope con el bot vivo: sigue pausando (rojo)
      Dos de los siete fallaron por mis propias aserciones: el arranque escribe
      `RUNNING` legítimamente antes de que la guarda pause, y el motivo propio es
      un texto, no un booleano.
- [x] Bajar el tope con el bot vivo: no pausa (rojo)
- [x] `RESUME` tras subir el tope: rebota (rojo)

## Fase 2 — La lectura, en un solo sitio

- [x] `BotStore.riskGuards(userId, {fresco})` con caché por usuario y su test
- [x] `engine.service.ts` adopta con esa lectura

## Fase 3 — Los guards se refrescan

- [x] `guards` mutable en el runner; los tres usos migrados
- [x] `refreshGuards()` en el tick, también con el bot pausado
- [x] Un fallo de lectura conserva los guards anteriores

## Fase 4 — El motivo caducado

- [x] Marca del motivo propio (`motivoDeGuarda`) y limpieza con `RISK_GUARD_CLEARED`
      NO va dentro de `pauseForRisk`: tiene cinco llamadores (guardas de límites,
      colocaciones fallidas, cortacircuitos de ticks, pausa del canal) y solo el
      primero caduca al cambiar un límite. Se distingue por parámetro y queda
      escrito en el payload del evento (`GUARDA_DE_LIMITES`).
- [x] Recuperación de la marca al adoptar en pausa
- [x] El bot sigue PAUSED: no se reanuda solo

## Fase 5 — App y documentación

- [x] Etiqueta del evento en `labels.ts` y `bot-overlay.ts`
- [x] La pantalla de límites dice el plazo real
- [x] `docs/riesgo-y-liquidacion.md` y `docs/comandos-guardas-y-eventos.md`

## Cierre

- [x] Criterios de aceptación repasados uno a uno
- [x] Índice de `specs/README.md` actualizado
- [x] Memoria de usuario actualizada
- [ ] CA-3, CA-4 y CA-5: las comprobaciones a mano del usuario con la infra levantada

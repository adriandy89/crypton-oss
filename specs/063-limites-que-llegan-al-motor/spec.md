# 063 — Los límites de riesgo llegan al motor

Estado: `hecho` (faltan CA-3 a CA-5: las comprobaciones a mano del usuario) · Tipo: `corrección` · Rama: `spec/063-limites-que-llegan-al-motor`

## Objetivo

Que un cambio en «Cuenta › Límites de riesgo» muerda en los bots que ya están en marcha, en los dos
sentidos, sin reiniciar el worker ni parar el bot. Y que un bot pausado por una guarda que ya no se
cumple deje de enseñar un motivo caducado.

## Contexto

Lo trae un incidente del usuario, no una revisión. Subió su tope de apalancamiento de 10× a 25× y
un bot `AI_CHANNEL` suyo siguió pausado enseñando «apalancamiento 25× por encima de tu límite
(10×)».

El worker lee `risk_limits` **una sola vez**, al adoptar el bot (`engine.service.ts:661-699`), y
guarda el resultado en el objeto `guards` que recibe el `BotRunner`. Ese objeto no se vuelve a leer
nunca: `reloadConfig` recarga la configuración del bot, no los límites, y no hay canal de bus para
esto; `RiskService.update` (API) hace su `upsert` y no avisa a nadie.

Consecuencias, todas confirmadas leyendo el código:

1. La guarda de `bot-runner.ts:3264-3267` pausa contra el tope viejo y escribe el motivo en
   `bots.last_error` (`pauseForRisk`, `bot-runner.ts:3428-3445`). La tarjeta de la app lo pinta tal
   cual (`bots-list.page.ts:408-409`): es una foto del instante de la pausa, no una comprobación
   viva.
2. Reanudar no salva: `RESUME` limpia el motivo, pero el tick siguiente vuelve a evaluar con los
   mismos guards viejos y lo pausa otra vez. La única salida de hoy es parar y arrancar el bot, o
   reiniciar el worker.
3. No es cosmético. En el canal con IA, `guards.maxLeverage` alimenta `maxApalancamientoUsuario`
   (`bot-runner.ts:2237`), el tope con el que se calcula el apalancamiento de **cada operación**.
4. Falla también al **bajar** un tope: un bot vivo sigue operando con el viejo. Es justo lo que
   dicen querer evitar los comentarios de `bot-runner.ts:3261-3263` y `bot-store.ts:55-62`.
5. La pantalla de límites promete «se comprueban al crear un bot **y en cada ciclo del motor**»
   (`risk.page.ts:53`). Hoy esa frase es falsa para todo bot ya adoptado.

## Alcance

- `apps/worker/src/engine/bot-store.ts`: lectura de `risk_limits` con caché por usuario.
- `apps/worker/src/engine/engine.service.ts`: la adopción usa esa lectura.
- `apps/worker/src/engine/bot-runner.ts`: `guards` mutable, refresco periódico, motivo caducado.
- `apps/app/src/app/core/utils/labels.ts` y `shared/chart/bot-overlay.ts`: etiqueta del evento nuevo.
- `apps/app/src/app/features/account/risk.page.ts`: la frase deja de prometer inmediatez.
- `docs/riesgo-y-liquidacion.md`, `docs/comandos-guardas-y-eventos.md`.

## Fuera de alcance

- Canal de bus para avisar de un cambio de límites. La relectura periódica basta, no añade
  superficie y funciona aunque el worker estuviera caído al guardar.
- Que el motor reanude un bot por su cuenta al desaparecer la causa. Va contra el diseño: nadie pone
  a operar lo que el usuario no pidió (`startPaused`, `engine.service.ts:715-719`).
- Lo que apareció mirando esto y merece spec propio: `assertCanStart` (`max_open_bots`,
  `max_daily_loss`) solo corre en START y no al crear; `max_open_bots` no existe en `RiskGuards`;
  `PATCH /risk/limits` tiene semántica de PUT; y la misma regla vive en cuatro sitios.
- `packages/db/prisma`: no se toca. `bot_events.type` es `VarChar(48)`, texto libre.

## Requisitos

- **R-1** El motor relee los límites del usuario mientras el bot vive, sin readoptarlo.
- **R-2** Subir un tope deja de pausar; bajarlo pausa. Las dos direcciones, en el mismo plazo.
- **R-3** El tope que usa el canal con IA para calcular el apalancamiento de cada operación es el
  vigente, no el de la adopción.
- **R-4** Un fallo al leer los límites conserva los que ya había. Nunca relaja un límite.
- **R-5** Un bot pausado por una guarda que ya no se cumple borra su motivo y lo dice con un evento,
  **sin** reanudarse.
- **R-6** Lo anterior vale también tras un relevo de worker, cuando la marca en memoria se perdió.
- **R-7** La app no pinta constantes crudas: el evento nuevo tiene etiqueta.

## Criterios de aceptación

- **CA-1** Tests del worker en verde, con casos para R-1 a R-6 (`pnpm --filter worker test`).
- **CA-2** `pnpm test` (sin e2e) y `pnpm lint` en verde.
- **CA-3** Con la infra levantada y un bot **simulado**: bajar el tope por debajo del apalancamiento
  del bot lo pausa con su motivo en el minuto siguiente, sin tocar el bot.
- **CA-4** Subir el tope, sin tocar el bot ni reiniciar nada: en el minuto siguiente desaparece el
  aviso rojo de la tarjeta, aparece el evento `RISK_GUARD_CLEARED` y el bot **sigue** pausado.
- **CA-5** Reanudar ese bot lo deja en `RUNNING` y no rebota.
- **CA-6** Las guías y la pantalla de límites dicen el plazo real.

## Riesgos

- **Una consulta por bot y por minuto.** Se mitiga con caché por usuario en `BotStore`, el mismo
  patrón que ya usan `dailyLoss` y `totalNotional`: N bots de un usuario comparten una lectura.
- **Borrar un motivo que sigue vigente por otra causa.** Se mitiga con una marca que solo pone la
  pausa por riesgo, igual que `motivoDeCaidaPuesto` hace con la caída del venue.
- **Bots en marcha.** No cambia ningún valor por defecto ni la semántica de ningún parámetro: lo
  único que cambia es *cuándo* se lee un número que ya se leía. Pero eso basta para cambiar una
  conducta real: **a partir del despliegue, un tope que el usuario bajó hace meses empieza a morder
  en bots que hoy lo incumplen en silencio**. Es lo que la guía ya prometía y lo que se ha pedido,
  pero no puede descubrirse con una pausa inesperada: va dicho aquí y en el aviso de despliegue.

## Referencias oficiales

Ninguna: no se apoya en reglas de venue ni de SDK.

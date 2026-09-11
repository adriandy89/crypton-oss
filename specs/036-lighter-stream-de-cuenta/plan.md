# 036 — Plan de implementación

## Enfoque

Suscribirse a `account_all/{id}` y `account_all_orders/{id}`, mapear lo que llegue con **el mismo**
traductor que ya usa el sondeo, y dejar que `shouldPoll()` —que existe desde el spec 013— apague el
barrido solo.

**La regla que gobierna el diseño**: el canal solo se da por bueno cuando entrega algo que sabemos
interpretar. Su forma viene de la documentación y no de una conexión autenticada, así que
`accountStreamUp` no se enciende hasta que llega un mensaje con `trades` u `orders` reconocibles. Si
la forma real no coincide, el bot se queda **como estaba**, nunca peor. Eso es lo que permite
desplegar esto sin la confirmación en vivo que el spec 013 esperaba.

## Lo que ya estaba

- `accountStreamUp` / `accountStreamDownSince`, con el comentario que dice para qué existen.
- `shouldPoll()` con la ventana de reserva de 20 s.
- `subscribe()` genérico, con reintento y resuscripción.
- El token se firma **localmente** (`create_auth_token_with_expiry`): suscribirse no cuesta cupo.

## Lo que se añade

| Pieza | Qué |
|---|---|
| `LighterWsTrade` | La forma de una ejecución, con **todo opcional**: es una hipótesis sobre el venue. |
| `tradeToFill()` | El traductor, extraído de `getRecentFills`. **Una sola** traducción, usada por las dos vías (R-4). Devuelve `null` si falta lo imprescindible. |
| `listaDe()` | Acepta lista o mapa por mercado: la documentación muestra las dos formas. |
| `subscribe(..., auth?)` + `authChannels` + `subscribePayload()` | El token viaja también en la resuscripción de `onOpen`, o el socket vuelve mudo (R-6). |
| `ensureAccountStream()` | Las dos suscripciones y el enrutado. |
| `emitTrade` / `emitOrder` | Deduplican contra lo que ya contó el sondeo (R-5). |
| `symbolOfMarketId()` | `market_id` → símbolo sin gastar una petición. |
| `accountStreamDown()` | Enganchado a la salud del socket: si se cae, el sondeo vuelve. |

`subscribePayload` **no lanza** si el firmante no está: manda sin token, el canal queda mudo y el
sondeo trabaja. Lanzar tumbaría la suscripción de todos los canales, incluidos los de precios.

## Verificación

Siete casos nuevos en `lighter-transport.spec.ts`, contra un `WebSocketServer` local: que se piden
los dos canales con el índice de cuenta; que una ejecución llega como `Fill` con sus campos y su
timestamp en ms; que la misma ejecución dos veces se emite una; que se acepta la forma agrupada por
mercado; que una forma desconocida **no** produce nada; que una ejecución de otra cuenta se
descarta; y que al reconectar los canales se vuelven a pedir. Más uno de salud: el canal entregando
anuncia `fills:UP` y `orders:UP`, que es lo que gobierna el sondeo.

**CA-8 es del usuario** y no necesita código: arrancar un bot real pequeño en Lighter y mirar si la
ejecución aparece al instante o tarda hasta 12 s. La guía está en el scratchpad, fuera del
repositorio, porque la comprobación usa credenciales.

## Commits

1. `docs(spec 036)` — spec, plan, tareas, índice.
2. `feat(exchange-core)` — el canal, el traductor compartido y la autenticación de la suscripción.
3. `test(exchange-core)` — los ocho casos.
4. `docs` — las guías, donde la frase «Lighter no tiene stream de cuenta» era falsa.

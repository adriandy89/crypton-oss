# 036 — Lighter: el stream de cuenta que ya existía

Estado: `hecho` · Tipo: `cambio` · Rama: `spec/036-lighter-stream-de-cuenta`

## Objetivo

Que las ejecuciones y las órdenes de Lighter lleguen **empujadas por WebSocket** en vez de
sondeadas cada 12 segundos, y que el sondeo quede como red de seguridad. Cierra **F-54**, el último
hallazgo que desaconseja operar market makers en ese venue.

## Contexto

La guía dice, desde el spec 001: *«Lighter no tiene stream de cuenta»*. **Es falso.** El propio
hallazgo lo dice mejor: *«sin stream de cuenta (`account_all/*` **documentado y no usado**)»*.
Lighter publica tres canales:

| Canal | Qué trae |
|---|---|
| `account_all/{id}` | `positions`, `trades` y `funding_histories` en cada actualización |
| `account_all_orders/{id}` | Órdenes (autenticado) |
| `account_all_trades/{id}` | Ejecuciones |

En su lugar, el adaptador **sondea cada 12 s y por símbolo** (`lighter.ts:229`) pidiendo `trades`
—peso **600**, el doble que cualquier otra lectura— más las órdenes activas. Con una cuenta
Standard (60 peticiones por minuto y por IP) eso deja la capacidad real en **≈ 1 bot por IP y red**
y da **hasta 12 s de retraso a cada ejecución**. Y el funding no se contabiliza, porque solo viaja
por ese canal.

Doce segundos de retraso es justo lo que hace inservible un market maker: para cuando el bot se
entera de que le han ejecutado, el precio que motivó la cotización ya no existe. De ahí la
limitación conocida que sigue viva en `docs/market-maker.md`.

**Media pieza ya está construida**, y con el comentario que lo explica (`lighter.ts:337-343`):

> *«Salud del canal de CUENTA (`account_all`), que todavía no se suscribe. Existe ya para que
> `shouldPoll` pregunte por lo correcto desde el primer día: mezclar las dos saludes es lo que dejó
> a un bot sin ver sus fills.»*

`accountStreamUp`, `accountStreamDownSince` y `shouldPoll()` —con su ventana de reserva de 20 s—
existen y esperan. Falta suscribirse, mapear y encender la bandera.

**Por qué quedó abierto**: el spec 013 lo dejó «como fase aparte» porque *«exige confirmar la forma
de `account_all/*` con una conexión autenticada»*. Esa desconfianza está justificada — los mapeos de
Lighter ya se apartaron de su documentación antes (F-55: `venueOrderId` resultó ser el índice de
cliente, `createdAt` era `Date.now()`, `markPrice` un precio de hasta cinco minutos).

Este spec no espera a esa confirmación: la hace innecesaria para desplegar.

## Alcance

`packages/exchange-core/src/adapters/lighter.ts` y sus tests. `docs/` y las guías donde la frase
falsa sigue escrita.

## Fuera de alcance

- **Apagar el sondeo por configuración.** Lo apaga el propio stream cuando entrega, y lo reanuda
  cuando deja de hacerlo. No se añade ninguna palanca.
- **Contabilizar el funding.** `funding_histories` llega por el canal, pero incorporarlo al ledger
  toca `cycle-accounting` y es otro spec.
- **Los demás hallazgos de Lighter** (LT-13 mapeos, LT-2 nonce, LT-9).

## Requisitos

- **R-1 (la regla que gobierna el spec).** El stream solo se da por bueno cuando entrega un mensaje
  que sabemos interpretar. Mientras tanto —y ante cualquier duda— **se sigue sondeando**. Si la
  forma real no coincide con la documentada, el bot queda **exactamente como hoy**, nunca peor.
- **R-2** Cuando el stream entrega, el sondeo no gasta ni una petición.
- **R-3** Si el stream cae, el sondeo vuelve tras la ventana de reserva ya existente (20 s).
- **R-4** El mapeo de una ejecución a `Fill` es **el mismo** que usa el sondeo, no una copia: dos
  mapeos del mismo dato divergen.
- **R-5** Una ejecución no se emite dos veces aunque lleguen por las dos vías.
- **R-6** Los canales autenticados se resuscriben con su token también al reconectar, o el socket
  vuelve mudo (que es el fallo que `onOpen` existe para evitar).
- **R-7** La salud del canal de cuenta es independiente de la del canal de precios.

## Criterios de aceptación

- **CA-1** Con el canal entregando ejecuciones, `shouldPoll()` es `false` y el barrido no hace
  ninguna llamada. (unitario)
- **CA-2** Un mensaje del canal con una forma que no se reconoce **no** enciende el stream: se
  sigue sondeando. (unitario)
- **CA-3** Tras caerse el canal, el sondeo vuelve pasada la ventana de reserva. (unitario)
- **CA-4** Una ejecución que llega por el stream produce el mismo `Fill` que la misma ejecución
  leída por REST, campo a campo. (unitario)
- **CA-5** La misma ejecución por las dos vías se emite una sola vez. (unitario)
- **CA-6** Al reconectar, los canales de cuenta se vuelven a pedir **con token**. (unitario)
- **CA-7** `pnpm test:adapters` y `pnpm test` en verde.
- **CA-8** *(manual, del usuario)* Con credenciales reales, comprobar que el canal entrega y con qué
  forma. Hay un script preparado en el scratchpad que **no** entra en el repositorio.

## Riesgos

- **La forma de los mensajes está tomada de la documentación, no verificada en vivo.** Mitigado por
  R-1: lo que no se reconoce no cuenta, y el sondeo sigue.
- **Suscribirse a un canal autenticado no cuesta cupo** —el token se firma localmente
  (`create_auth_token_with_expiry`)—, pero un token caducado sí podría dejar el canal mudo. Por eso
  la salud del canal es independiente y `shouldPoll` mira esa.
- **Duplicados** entre stream y sondeo durante la ventana de solape. Mitigado por R-5.

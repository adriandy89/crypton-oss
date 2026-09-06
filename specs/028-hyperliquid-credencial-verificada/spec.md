# 028 — La credencial de Hyperliquid se verifica de verdad, y su caducidad se ve

Estado: `hecho` · Tipo: `cambio` · Rama: `spec/028-hyperliquid-credencial-verificada`

## Objetivo

Que una credencial de Hyperliquid mal puesta **no se pueda guardar**, y que la app diga cuál era
la dirección correcta en vez de sellar la conexión en verde con un saldo de cero. Y que la fecha
de caducidad de la API wallet esté delante del usuario antes de que se le apague el bot.

## Contexto

El 2026-09-06 un usuario conectó su cuenta de Hyperliquid y la app le dijo «activa · Verificada ·
**0,00 USDC disponibles**» teniendo algo más de cien USDC en el exchange. Lo que había pegado en
«Dirección de tu cuenta» era la dirección de la **API wallet** —la que la propia página de
Hyperliquid muestra al crear el *agent*—, no la de su cuenta.

El error es fácil de cometer —las dos cosas son direcciones `0x…` y se crean en la misma pantalla—
pero lo que lo convirtió en un incidente es que **CRYPTON lo dio por bueno**:
`HyperliquidAdapter.verify()` (`packages/exchange-core/src/adapters/hyperliquid.ts:355`) solo
llama a `clearinghouseState`, que es un endpoint **público de info**. Acepta cualquier dirección
EVM sintácticamente válida y devuelve un estado vacío sin error, así que
`exchange-accounts.service.ts:145` sella el sobre cifrado y guarda la fila como `VERIFIED`.

La verificación no comprobaba nada de lo que dice comprobar: ni que la dirección sea una cuenta,
ni que la clave que firma esté autorizada en ella. Con la dirección de un agente guardada, **las
lecturas y las escrituras apuntan a cuentas distintas**: saldo, posiciones, órdenes, fills y
`orderStatus` salen todos de `this.addr()` (`hyperliquid.ts:1138`), que es la dirección guardada,
mientras las órdenes firmadas van contra la cuenta real que el venue deduce de la firma. Un motor
reconciliando contra el vacío no ve sus propias órdenes: la idempotencia por `clientOrderId` y la
regla de no tocar lo `foreign` dejan de proteger de nada. Hoy el bot no llega a arrancar porque el
capital leído es cero, y eso es lo único que ha evitado el daño.

De la misma conversación salen dos huecos más, los dos preguntados por el usuario:

- **La API wallet caduca.** Hyperliquid da 90 días por defecto y 180 como máximo (la del incidente
  vencía el 2027-03-05, justo 180 días). Al caducar no se pierde ni un dólar —un *agent* no puede
  retirar ni transferir— pero los bots dejan de poder **colocar y cancelar**, y las posiciones
  abiertas se quedan sin nadie que las vigile. La app no muestra la fecha ni avisa.
- **Solo se lee el saldo de perps.** `spotClearinghouseState` no se llama en ningún sitio. Un
  usuario con el dinero en spot ve «0,00 USDC disponibles» y exactamente la misma falta de
  explicación que motivó este spec.

## Alcance

- `packages/exchange-core`: `adapters/hyperliquid.ts` (`verify`, `getBalances`), `types.ts` (el
  resultado de `verify` y `VenueCapabilities` no cambian de forma incompatible).
- `packages/shared`: `wallet.ts` (`CapitalSnapshot.spot`) y `market.ts` (`Balance.spot`).
- `packages/db`: columna aditiva y nullable en `exchange_accounts` más su migración.
- `apps/api`: `modules/exchange-accounts` (guardar y exponer la caducidad), `modules/bots`
  (`fetchWallet` propaga la pista de spot).
- `apps/app`: tarjeta de conexión (fecha y aviso), pantalla de conectar (texto de ayuda), paso de
  capital del asistente (pista de spot).
- `docs/`: credenciales y venues.

## Fuera de alcance

- **Subcuentas y vaults de Hyperliquid.** No existe `vaultAddress` en el repo y añadirlo es un
  spec propio; aquí solo se **rechaza** con un motivo claro en vez de aceptar una cuenta cuyas
  órdenes irían a otro sitio.
- **Que el worker avise de la caducidad.** Un evento de bot cuando la API wallet esté a punto de
  vencer con posición abierta es útil, pero es motor y va en su propio spec. Aquí avisa la app.
- **Aster y Lighter.** Sus credenciales no caducan; el campo nuevo viaja `null` y sus `verify()`
  no se tocan.
- **Operar el spot.** El saldo de spot entra como **pista de diagnóstico**, nunca como capital
  disponible para un bot.

## Requisitos

- **R-1** `HyperliquidAdapter.verify()` comprueba, con lecturas públicas y sin firmar nada, que la
  dirección guardada es una **cuenta** y que la clave configurada es un **agente autorizado en
  ella**. Rechaza con mensaje accionable en castellano: dirección de una API wallet (y **dice**
  cuál es la cuenta, que el venue devuelve), subcuenta, vault, dirección que el venue no conoce en
  esa red, clave no autorizada en la cuenta, API wallet ya caducada, clave ilegible, y la cuenta
  que no responde.
- **R-2** El resultado de `verify()` lleva la caducidad del agente
  (`agentValidUntil?: number | null`, epoch ms). Campo opcional: los demás adaptadores no cambian.
- **R-3** El motivo del rechazo llega íntegro al usuario, tanto al conectar como al reverificar.
- **R-4** La caducidad se guarda en `exchange_accounts.agent_valid_until` al crear y al
  reverificar, y se expone en el objeto público de la cuenta.
- **R-5** La app muestra la fecha de validez de la API wallet en la tarjeta de conexión, y avisa
  cuando falten menos de 14 días o ya haya vencido, explicando qué pasa y qué hacer.
- **R-6** Las guías dicen qué es una API wallet, que no puede retirar, que caduca, y que la
  dirección que se pide **no** es la de la API wallet.
- **R-7** Cuando el equity de perps es cero, el saldo indica si hay USDC en spot y que hay que
  transferirlo. El capital operable sigue siendo solo el de perps.

## Criterios de aceptación

- **CA-1** `pnpm --filter @crypton/exchange-core test -- hyperliquid` cubre los rechazos y el
  caso bueno; el test del caso del incidente falla antes del cambio por el motivo declarado
  (`verify()` devolvía `ok: true` para la dirección de un agente).
- **CA-2** Con la dirección de una API wallet, crear la conexión devuelve 400 y el mensaje nombra
  la dirección de la cuenta principal. Comprobado a mano contra mainnet (solo lectura pública).
- **CA-3** Con la clave de un agente de otra cuenta, crear la conexión devuelve 400 por no estar
  autorizado.
- **CA-4** Con la credencial correcta, la conexión queda `VERIFIED`, el saldo es el real y la
  tarjeta muestra la fecha de validez de la API wallet.
- **CA-5** Con `agent_valid_until` a menos de 14 días, la tarjeta enseña el aviso; a `null`, no
  enseña ningún hueco.
- **CA-6** *Reverificar* actualiza `agent_valid_until` y `last_verified_at`.
- **CA-7** Con equity de perps a cero y USDC en spot, el saldo lo dice; sin USDC en spot no
  aparece ninguna pista.
- **CA-8** Cascada verde: `pnpm test:adapters`, `pnpm test:strategies`, `pnpm --filter worker
  test`, `pnpm test:backtest`, `pnpm --filter api test`, `pnpm build:packages`, `pnpm lint` y el
  typecheck de la app.

## Riesgos

- **Rechazar credenciales que hoy funcionan.** `verify()` se vuelve estricto y solo corre al
  crear y al reverificar: **no** se ejecuta al abrir un adaptador para operar, así que ningún bot
  en marcha se detiene por esto. Las cuentas ya guardadas siguen igual hasta que alguien pulse
  *Reverificar*; si una estaba mal puesta, ese es justo el momento de enterarse.
- **Dos llamadas de info más al crear.** `userRole` y `extraAgents` son lecturas públicas y
  pasan por el `RateLimiter` y el presupuesto del adaptador como el resto. Solo en el alta y en
  la reverificación, nunca en el tick.
- **La migración.** Columna nueva, nullable, sin valor por defecto y sin índice: no reescribe la
  tabla ni toca datos. `prisma:deploy`, nunca `--force`.
- **`packages/shared` obliga a la cascada completa de tests** (`shared → todo`).
  `CapitalSnapshot.spot` es requerido y explícitamente nulo, como el resto del fichero, para que
  ningún camino se olvide de decidirlo; `Balance.spot` sí es opcional porque solo un venue lo
  rellena. La cache `crypton:wallet:v1` no necesita subir de versión: una entrada vieja solo se
  queda sin la pista durante sus 15 s de vida.
- **La clave privada nunca sale del proceso.** La dirección del agente se deriva en memoria y solo
  se comparan direcciones; ningún mensaje de error incluye la clave ni parte de ella.

## Referencias oficiales

- Hyperliquid, *Nonces and API wallets*
  (https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/nonces-and-api-wallets),
  consultado 2026-09-06: «To query the account data associated with a master or sub-account, you
  must pass in the actual address of that account». Y sobre la baja de un agente: «When an
  ApproveAgent action is sent with a matching name» el anterior se da de baja, y «once an agent is
  deregistered, its used nonce state may be pruned».
- Hyperliquid, página *API* de la propia aplicación
  (https://app.hyperliquid.xyz/API), consultada 2026-09-06: «API wallets (also known as agent
  wallets) can perform actions on behalf of an account without having withdrawal permissions. The
  account's public address must be used for info requests.»
- Hyperliquid, *API wallets*: 90 días de validez por defecto, 180 como máximo indicando
  `valid_until` en el nombre; 3 con nombre más 1 sin nombre por cuenta principal, y 2 más por
  subcuenta.
- SDK `@nktkas/hyperliquid` 0.33.3, tipos de `info/_methods/userRole.d.ts` y
  `info/_methods/extraAgents.d.ts`: `userRole` devuelve
  `{role:'agent', data:{user}}` para la dirección de un agente y `{role:'subAccount',
  data:{master}}` para una subcuenta; `extraAgents` devuelve `{ address, name, validUntil }[]`,
  con `validUntil` «`null` when the agent has no expiry».

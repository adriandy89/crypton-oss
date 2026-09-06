# 028 — Tareas

Una casilla por tarea, agrupadas por fase. Se marcan al terminar, con una nota corta si hubo
sorpresas. Nada se da por hecho sin la verificación de su fase.

## Fase 0 — Línea base

- [x] Rama `spec/028-hyperliquid-credencial-verificada` creada desde `main` limpia
- [x] `pnpm build:packages`
- [x] `pnpm test` (sin e2e) — resultado anotado
- [x] `pnpm lint`

## Fase 1 — `verify()` dice la verdad (R-1, R-2)

- [x] Tests en `hyperliquid.spec.ts` que fallan por el motivo declarado: dirección de agente,
      subcuenta, cuenta sin actividad, agente no autorizado, mayúsculas de la dirección, caso bueno
- [x] `agentValidUntil?: number | null` en el resultado de `verify()` (`types.ts`)
- [x] `verify()` con `userRole` + `extraAgents` + la dirección del agente derivada de la clave
- [x] `pnpm --filter @crypton/exchange-core test -- hyperliquid` y `pnpm test:adapters`
- [x] `pnpm --filter worker test` (dependiente de `exchange-core`)
- [x] Commit `fix(exchange-core): la credencial de Hyperliquid se verifica de verdad (spec 028)`

## Fase 2 — La caducidad se guarda (R-4)

- [x] `agent_valid_until DateTime?` en `schema.prisma` y migración nueva
- [x] `create()` y `verify()` la escriben; `toPublic()` la expone como ISO
- [x] `pnpm --filter api test`
- [x] Commit

## Fase 3 — La caducidad se ve, y el motivo del rechazo llega entero (R-3, R-5)

- [x] Fecha de validez en la tarjeta de conexión
- [x] Aviso a menos de 14 días y cuando ya venció, con qué pasa y qué hacer
- [x] El `detail` del rechazo se queda en pantalla, no solo en un toast íntegro al conectar y al reverificar
- [x] Typecheck de la app
- [x] Commit

## Fase 4 — Si el dinero está en spot, decirlo (R-7)

- [x] `CapitalSnapshot.elsewhere` opcional, documentado
- [x] `getBalances()` mira spot solo cuando el equity de perps es cero
- [x] `fetchWallet` lo propaga; la app lo pinta en la tarjeta y en el paso de capital
- [x] Cascada de `shared`: `pnpm test` (sin e2e) y typecheck de la app
- [x] Commit

## Fase 5 — Guías (R-6)

- [x] `docs/` y la ayuda de conectar: qué es una API wallet, que no retira, que caduca, y que la
      dirección que se pide NO es la de la API wallet
- [x] Commit

## Cierre

- [x] Criterios de aceptación repasados uno a uno
- [x] Índice de `specs/README.md` actualizado
- [x] `CLAUDE.md` actualizado si cambió algo que deba saber toda sesión
- [x] Memoria de usuario actualizada si hay decisiones que sobrevivan al spec

## Pendiente del usuario (necesita la infra levantada y una cuenta real)

- [ ] `pnpm prisma:deploy` para aplicar `20260906180000_exchange_account_agent_expiry`
- [ ] CA-2: conectar con la dirección de una API wallet → rechazo que nombra la cuenta correcta
- [ ] CA-3: conectar con la clave de un agente de otra cuenta → rechazo por no autorizado
- [ ] CA-4: conectar bien → verificada, saldo real y fecha de validez en la ficha
- [ ] CA-5: con `agent_valid_until` a menos de 14 días (a mano, en una cuenta de testnet) → aviso
- [ ] CA-6: *Reverificar* refresca `agent_valid_until`
- [ ] CA-7: con el capital en spot → el saldo lo dice

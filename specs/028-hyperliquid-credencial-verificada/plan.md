# 028 — Plan

## Enfoque

La verificación no se reinventa: se le añaden las dos preguntas que el venue ya sabe contestar
gratis y que hoy no se le hacen.

- `userRole({user})` dice **qué es** esa dirección. Si es un agente, la respuesta trae
  `data.user`: la cuenta principal a la que pertenece. O sea, el propio venue nos da la dirección
  que el usuario debería haber pegado, y el mensaje de error se la puede dar a él. Eso convierte
  un «no se ha podido verificar» en una instrucción.
- `extraAgents({user})` lista los agentes autorizados en la cuenta con su `validUntil`. Contra esa
  lista se comprueba la dirección derivada de la clave configurada, y de paso sale la caducidad
  sin una llamada extra.

Las dos son lecturas públicas del endpoint de info, del SDK que ya está instalado, y solo corren
al crear la conexión y al reverificarla. No se firma nada.

Alternativas descartadas:

- **Derivar la cuenta del agente y guardarla nosotros** (`userRole` → `data.user` → guardar eso en
  vez de lo que pegó el usuario): arregla el síntoma callándose. Una credencial de dinero no se
  «corrige sola»; el usuario tiene que ver que se equivocó y con qué.
- **Comprobar la autorización firmando algo inocuo** (un cancel de una orden que no existe):
  prohibido por `specs/README.md` y por `CLAUDE.md`, y además innecesario.
- **Guardar la caducidad calculándola** (`now + 90 días`): mentira a los 91 días. La da el venue.
- **Sumar spot al saldo disponible**: el capital de un bot de perpetuos no puede incluir dinero
  que no es colateral de perps. Entra como pista, no como cifra.

## Ficheros afectados

| Fichero | Qué cambia | Tests que lo cubren |
|---|---|---|
| `packages/exchange-core/src/adapters/hyperliquid.ts` | `verify()` estricto con `userRole` + `extraAgents`; `getBalances()` mira spot si perps es cero | `adapters/hyperliquid.spec.ts` |
| `packages/exchange-core/src/types.ts` | `verify()` devuelve `agentValidUntil?: number \| null`; `Balance` sin cambios | typecheck y tests de `worker` |
| `packages/shared/src/wallet.ts` | `CapitalSnapshot.elsewhere` opcional | `apps/api` (`bots.service.spec.ts`) |
| `packages/db/prisma/schema.prisma` + migración | `exchange_accounts.agent_valid_until` nullable | `pnpm --filter api test` |
| `apps/api/src/modules/exchange-accounts/exchange-accounts.service.ts` | guarda y expone la caducidad | `exchange-accounts.service.spec.ts` |
| `apps/api/src/modules/bots/bots.service.ts` | `fetchWallet` propaga `elsewhere` | `bots.service.spec.ts` |
| `apps/app/src/app/features/account/account.page.*` | fecha de validez, aviso, pista de spot | typecheck |
| `apps/app/src/app/features/account/connect-exchange.page.*` | ayuda: la dirección NO es la de la API wallet | typecheck |
| `docs/` | credenciales: que es una API wallet, que caduca, que no retira | — |

## Fases

| Fase | Qué | Criterio de salida |
|---|---|---|
| 0 | Línea base: rama, `build:packages`, `pnpm test`, `lint` | Verde o rojos conocidos anotados |
| 1 | R-1, R-2: tests de `verify()` primero (fallan), luego el código | `test:adapters` verde, `worker` verde |
| 2 | R-4: columna, migración, servicio, objeto público | `pnpm --filter api test` verde |
| 3 | R-5, R-3: la fecha y el aviso en la app; el motivo del rechazo intacto | typecheck de la app |
| 4 | R-7: pista de spot (`shared` → cascada completa) | `pnpm test` sin e2e verde |
| 5 | R-6: guías y `docs/` | `grep` sin rastro de la ayuda vieja |
| 6 | Cierre: índice de specs, memoria | Estado `hecho` |

## Verificación

Desde Git Bash, nunca PowerShell (allí `2>&1` falsea el código de salida):

```bash
pnpm --filter @crypton/exchange-core test -- hyperliquid
pnpm test:adapters
pnpm test:strategies
pnpm --filter worker test
pnpm test:backtest
pnpm --filter api test
pnpm build:packages
pnpm lint
cd apps/app && pnpm typecheck
```

A mano, con `make infra`, `make api`, `make worker`, `make app`, y sin firmar nada:

1. Conectar Hyperliquid con la dirección de una API wallet → rechazo que nombra la cuenta buena.
2. Conectar con la clave de un agente de otra cuenta → rechazo por no autorizado.
3. Conectar bien → `VERIFIED`, saldo real, fecha de validez en la tarjeta.
4. `agent_valid_until` a menos de 14 días (a mano en la BD, cuenta de testnet) → aviso.
5. *Reverificar* → la fecha se refresca.
6. Equity de perps a cero con USDC en spot → el saldo lo dice.

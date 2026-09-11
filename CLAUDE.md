# CLAUDE.md — CRYPTON (edición open source)

Memoria del proyecto para Claude Code. Léela entera antes de tocar nada: detrás de cada orden
hay dinero real de quien lo despliega. Lo largo está en `README.md` y `docs/`; esto es lo que no
se puede no saber.

## Qué es (y qué no)

Plataforma **no custodial** de bots de trading sobre DEX (Hyperliquid, Lighter, Aster), para
autoalojar, bajo AGPL-3.0. El usuario deja sus fondos en el exchange y entrega una **clave de
firma delegada sin permiso de retirada**. La API **nunca** manda una orden: solo el worker firma.
Si CRYPTON desapareciera, el dinero seguiría donde estaba.

Esta edición **no tiene planes ni suscripciones** (ningún cupo por tier, ninguna pasarela), ni
sitio web, ni infraestructura de nadie: todo lo que hace está disponible para quien la despliegue.
`BUILDER_ADDRESS` viene vacío a propósito.

## Mapa

| Ruta | Qué es |
|---|---|
| `apps/api` | NestJS 11. REST + SSE: cuentas, credenciales cifradas, CRUD de bots, preview, riesgo, backtest, bitácora. **No ejecuta nada**: escribe el comando en `bot_commands` y avisa por Redis. |
| `apps/api` → `modules/admin` | La consola de administración (spec 033). **Mirar y contener**: lee cuentas y bots de todos, y sobre un bot ajeno solo puede `PAUSE` y `STOP_KEEP_POSITION`. Nunca importa `ExchangeAccountsModule`: es la puerta a descifrar la clave de firma. |
| `apps/worker` | NestJS 11 sin HTTP. **El motor**: lease en Redis → un `BotRunner` por bot → tick. Único proceso que descifra claves y firma. También escribe la curva de la cartera (`portfolio_snapshots`) y purga las series. |
| `apps/app` | Ionic 8 + Angular 21 + Capacitor. Ejecuta `strategy-core` **también en cliente** (`features/bots/bot-create.page.ts`, `fullConfig`). |
| `packages/shared` | Tipos, enums (calcan Prisma), `money.ts` (Decimal), `precision.ts` (redondeo), `liquidation.ts`, `series.ts` (la aritmética de las series y la analítica que pintan las pantallas: la app no suma dinero, lo pide aquí con test). |
| `packages/db` | Prisma 7. Genera TypeScript, así que **se compila** (`dist/src`). Fuente única del modelo. |
| `packages/strategy-core` | Cada estrategia como funciones puras: `validate()`, `preview()`, `plan()`. Más `reconcile`, `order-gate`, `stop-loss`, `cycle-accounting`, `client-order-id`, `mutability`. |
| `packages/exchange-core` | Adaptadores HL/Lighter/Aster tras `ExchangeAdapter`, `DryRunAdapter`, `coid`, `errors`, `rate-limit`, `venue-budget`, `venue-weights`, `endpoints`. |
| `packages/backtest` | Replay sobre velas con las **mismas** piezas que el motor. |
| `specs/` | Metodología SDD. **Empieza por `specs/README.md`.** |

Ficheros que hay que leer **enteros** antes de cambiarlos: `apps/worker/src/engine/bot-runner.ts`
(el tick), `apps/worker/src/engine/bot-store.ts`,
`packages/strategy-core/src/{reconcile,stop-loss,order-gate,cycle-accounting}.ts`,
`packages/exchange-core/src/adapters/{hyperliquid,lighter,aster,dry-run}.ts`,
`packages/shared/src/{money,precision}.ts`.

## Invariantes de dinero (no negociables)

1. **Solo `Decimal`** (`packages/shared/src/money.ts`, precisión 40). Dinero y cantidades viajan como `string` en el cable y en la BD (`Decimal(38,18)`). Nunca `number`, nunca `parseFloat`.
2. **Redondeo a la retícula del venue** en `precision.ts`: compra redondea **abajo**, venta **arriba**, cantidad **siempre abajo**. Es la única puerta; ningún adaptador manda nada que no haya pasado por ahí.
3. **`clientOrderId` determinista** `<16 hex del bot>.<ciclo>.<KIND><índice>` (`client-order-id.ts`). Es la idempotencia: dos ticks no colocan dos veces y un worker reiniciado reconoce sus órdenes. Cambiar el formato rompe la reconciliación de todos los bots vivos.
4. **La fila de `bot_orders` se escribe ANTES de llamar al venue** (`bot-runner.ts`, `place()`). Lo que no puede pasar es mandar una orden sin constancia de haberlo hecho.
5. **El motor no ejecuta pasos memorizados: reconcilia.** `plan()` puro → `reconcile()` → solo la diferencia. Una orden sin `clientOrderId` propio es `foreign` y **no se toca nunca**.
6. **El stop-loss** lo inyecta `withStopLoss()` como orden condicional **nativa** del venue: sobrevive a que el worker muera y a `PAUSE`/`STOP_KEEP_POSITION`. Solo `CANCEL_ALL_ORDERS`, `STOP_AND_CLOSE` y `PANIC` lo cancelan. En el simulador es una condicional en reposo que se dispara con el precio de marca, nunca una orden a mercado inmediata.
7. **Un adaptador por cuenta de exchange** (`AccountHub`) y una suscripción pública por símbolo (`MarketDataService`): N bots de una cuenta son una conexión y una clave en RAM.
8. **Secretos**: cifrado de sobre AES-256-GCM. Solo vuelven a claro en `apps/worker/src/engine/credentials.service.ts` y en `apps/api/src/modules/exchange-accounts/exchange-accounts.service.ts` (`openAdapter`). Nunca en Redis, disco ni logs.
9. **La sesión se revoca de verdad.** `JwtStrategy.validate()` consulta una marca por usuario en Redis (`auth:revoked:<id>`) contra el `iat` del token: deshabilitar una cuenta o cerrarle las sesiones muerde **en la petición siguiente**, no dentro de 15 minutos. Con Redis caído se deja pasar —salvo a quien ya se sabía revocado— a propósito: cerrar la API dejaría a quien tiene bots operando sin poder llegar a su kill-switch.
10. **Lease en Redis** (`crypton:lease:bot:<id>`), no en la BD. Redis caído más de un TTL → el worker **suelta** todos sus bots antes que arriesgarse a duplicarlos.
11. **Un solo bot real por par y cuenta** (índice único parcial en `bots`). Los simulados quedan fuera de la regla.
12. **Mutabilidad HOT/WARM/COLD** de cada campo (`meta.fields`) decide lo que hace el motor al recargar la configuración. No es una etiqueta decorativa.
13. **Una escritura con estado desconocido no se reenvía** (`withWriteRetry`): si no se puede saber si la orden entró, se lanza y el tick siguiente reconcilia contra el venue.

## Comandos

```bash
make infra              # Postgres 5341 + Redis 6381 (docker/docker-compose.infra.yml)
make packages           # tsc --watch de los paquetes; dejalo en su terminal
make api / make worker / make app
pnpm build:packages     # OBLIGATORIO antes de api/worker: resuelven @crypton/* por dist/
pnpm test:strategies    # strategy-core: la logica de dinero
pnpm test:adapters      # exchange-core, incluido el simulador
pnpm --filter worker test
pnpm --filter api test  # unitarios; el e2e (test:e2e) necesita la infra levantada
pnpm test:backtest
pnpm test               # todo (sin e2e)
pnpm lint               # eslint con tipos, paquete a paquete
pnpm check:env          # cruza codigo, .env.example y compose
pnpm prisma:migrate | prisma:deploy
```

En Windows, jest se ejecuta desde Git Bash, no desde PowerShell: allí `2>&1` falsea el código de salida.

## Convenciones

- **Castellano** en código, comentarios, commits (`tipo: descripción`, en minúscula) y documentación. Los comentarios cuentan el **por qué** y el incidente que motivó el código; ese estilo se mantiene, no se resume.
- Prettier a 100 columnas, comillas simples, LF. Sin acentos en el texto que imprime `make` (cmd.exe).
- Tests colocados junto al código, `*.spec.ts`, jest + ts-jest por paquete (`rootDir: src`). El grueso de la cobertura está en `strategy-core` a propósito: es pura. La lógica de pantalla que pueda mentir vive en `packages/shared` con test (precedente: `candle-paging.ts`, `series.ts`).
- Nada de `any`. Los únicos casts son fronteras Prisma-JSON y campos privados de SDK, y llevan comentario.
- Los enums de `packages/shared/src/enums.ts` calcan los de Prisma valor a valor.
- ESLint con análisis de tipos se acota por paquete (`.vscode/settings.json` explica por qué).
- El CSS de página que no cabe en el presupuesto de 6 kB por componente va a `apps/app/src/global.scss`, en bloques rotulados.

## Trampas conocidas

- `nest start --watch` **no** recarga cuerpos de funciones de los paquetes, solo sus `.d.ts`. Si cambias `packages/*` sin tocar tipos: Ctrl+C y arrancar de nuevo.
- Node ≥ 22.12 obligatorio: el SDK de Hyperliquid es ESM-only y se carga con `require(esm)`.
- `koffi` (firmante nativo de Lighter) solo tiene binarios para Linux x64, macOS arm64 y Windows x64, y necesita `onlyBuiltDependencies` en `pnpm-workspace.yaml`.
- Postgres se publica en **5341** y Redis en **6381** (`DB_PORT`, `REDIS_PORT`), no en los puertos estándar, para convivir con otras instalaciones locales.
- **NUNCA `down -v` sobre `docker/docker-compose.infra.yml`**: borra credenciales e histórico. `pnpm stack:down` es seguro por diseño.
- **NUNCA `pnpm setup --force`** con datos: cambia la clave maestra y las credenciales guardadas dejan de descifrarse.
- Prisma 7: `prisma migrate diff --from-schema … --to-schema … --script` genera el SQL de una migración sin tocar la base; `pnpm prisma:deploy` la aplica. `migrate dev` sobre una base con datos puede proponer un reset: no se usa.
- Lighter tier Standard = **60 peticiones/min por IP**; al pasarse devuelve una página CAPTCHA de AWS WAF durante 60 s. De ahí la cuenta de servicio `LIGHTER_SERVICE_*` y `WORKER_EGRESS_ID`.
- El SDK de Lighter devuelve los errores como tupla `[…, error]` y NO lanza; `signedWrite` mira la tupla antes de darla por buena.
- `BUILDER_ADDRESS` solo se adjunta si `builder_approved`; ponerlo «por si acaso» hace que el venue rechace la orden **entera**.

## Flujo de trabajo: SDD

Todo cambio nace de un spec en `specs/NNN-slug/`. Lee `specs/README.md`: es la constitución
(principios, escala de severidad, protocolo de corrección, plantilla). Reglas mínimas:

- Un spec de revisión produce `findings.md`. Solo los hallazgos **Críticos confirmados** se corrigen dentro de él, con un test que falla primero y aprobación del usuario viendo el diff. El resto son specs nuevos.
- Ningún cambio en `strategy-core`, `shared`, `exchange-core` o el motor sin test. Tras tocar `strategy-core` o `shared`, pasan también los tests de `worker` y `backtest` y el typecheck de la app.
- Un commit por corrección, en la rama del spec. Sin `push` salvo que el usuario lo pida.
- Las guías de `docs/` citan los hallazgos abiertos en bloques «Limitación conocida (F-NN)». El spec que cierre un `F-NN` hace `grep -rn "F-NN" docs/` y borra o reescribe sus bloques: una guía que sigue avisando de algo corregido es tan mala como una que no avisa.

## Reglas de seguridad para el agente

- No leer ni imprimir `.env`, `docker/.env` ni nada que parezca una clave. No pedirlas.
- No ejecutar nada que firme, coloque o cancele órdenes, ni en mainnet ni en testnet, ni con credenciales de nadie.
- Sondas de red solo de **lectura pública**, solo contra los hosts de `packages/exchange-core/src/endpoints.ts`, con timeout, sin credenciales cargadas en el entorno y con la lista de hosts enseñada al usuario antes. Su salida va al scratchpad, nunca al repo.
- No tocar `packages/db/prisma` (esquema o migraciones) sin un spec que lo pida.
- No cambiar valores por defecto de estrategias ni la semántica de un parámetro de usuario sin decisión explícita del usuario: hay bots en marcha.
- `git push`, `down -v`, `setup --force`, `reset --hard`: nunca.

## Dónde leer más

- `README.md`: puesta en marcha, estrategias, ajustes en caliente, comandos de ejecución y las pruebas recomendadas antes de poner dinero.
- `docs/README.md`: la guía de uso. Una guía por estrategia, todas, con ejemplos verificados por `preview()` y sus limitaciones conocidas, más riesgo y liquidación, venues y mínimos, simulación y backtest, comandos y eventos, y las buenas prácticas de la casa.
- `apps/app/src/app/core/content/*.guide.ts`: las guías de cada estrategia tal como las ve el usuario dentro de la app.
- `docker/README.md`: por qué hay dos composes y qué no se puede hacer con ellos.
- `specs/README.md` y su índice de specs: la revisión integral (001) con sus hallazgos, los specs 002-007 con lo que se decidió en cada pantalla, el 008 (la guía de uso) y los 009-011 (protecciones, comandos y margen).

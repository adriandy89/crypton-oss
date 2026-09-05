# 001 — Plan

## Enfoque

Tres líneas de trabajo independientes (estrategias, motor, APIs) que se revisan en paralelo con
subagentes de solo lectura, cada uno escribiendo en su propio fichero del scratchpad, y un único
consolidador que escribe `findings.md`. Antes de revisar nada se fija la línea base y se citan las
reglas oficiales; después de consolidar se para y se enseña la lista al usuario. Solo entonces se
corrige, de una Crítica en una.

Alternativas descartadas:

- Corregir sobre la marcha lo que se vaya encontrando: mezcla revisión y cambio, y es justo lo que la consigna «mucho cuidado» prohíbe.
- Un solo agente leyendo todo: el contexto no cabe (36 000 líneas) y los veredictos se degradan al final.
- Probar en testnet con credenciales: no autorizado; las sondas públicas cubren lo que se necesita (precisiones, filtros, hosts).

## Fuentes oficiales

| Venue / SDK | Fuente | Cómo se consulta |
|---|---|---|
| Hyperliquid | https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api | Context7 `/websites/hyperliquid_gitbook_io_hyperliquid-docs`; páginas `exchange-endpoint`, `tick-and-lot-size`, `info-endpoint`, `websocket`, `rate-limits-and-user-limits`, `error-responses` |
| SDK `@nktkas/hyperliquid` 0.33.3 | https://nktkas.gitbook.io/hyperliquid | Context7 `/websites/nktkas_gitbook_io_hyperliquid`; tipos en `node_modules/@nktkas/hyperliquid` |
| Lighter | https://apidocs.lighter.xyz | Context7 `/llmstxt/apidocs_lighter_xyz_llms_txt`; `docs/rate-limits`, `docs/get-started`, `reference/*` |
| SDK `zklighter-sdk` 1.3.0 | `node_modules/.pnpm/zklighter-sdk@1.3.0/node_modules/zklighter-sdk/dist/{signer,api}.{js,d.ts}` | Lectura directa del código |
| Aster | https://github.com/asterdex/api-docs | Context7 `/asterdex/api-docs`; fichero crudo `V3(Recommended)/EN/aster-finance-futures-api-v3.md`, `...-testnet.md`, `Aster API Overview.md` |

## Fases

| Fase | Qué | Paralelo | Criterio de salida |
|---|---|---|---|
| 0. Línea base | Árbol limpio, rama `spec/001-revision-integral`, `pnpm build:packages`, `pnpm test` (sin e2e), `pnpm lint`, `pnpm check:env`; versiones; resultado en `findings.md` § Línea base. Commit del andamiaje (`CLAUDE.md`, `specs/`). | serie | Verde o lista de rojos conocidos. |
| 1. Doc oficial | Extraer y citar las reglas por venue (URL, fecha, texto) → `findings.md` § Referencias. | serie | Tabla de reglas completa. |
| 1b. Sondas | Enseñar la lista blanca de hosts al usuario; ejecutar; guardar JSON; `compare.md`. | serie, agente principal | JSON en scratchpad y comparación hecha. |
| 2. Línea C (APIs) | Matriz por venue, comprobaciones C-1…C-9. | 3 subagentes (HL, Lighter, Aster) | Matrices rellenas. |
| 3. Línea A (estrategias) | Familia grid (classic, neutral, gridmart) y familia MM (v1, v2) más tdca y martingale; piezas comunes; paridad app, backtest y advisor. | 2 subagentes | Veredicto A-1…A-22 por estrategia. |
| 4. Línea B (motor) | Modos de fallo B-1…B-22 leyendo `bot-runner.ts` entero. | 1 subagente | Veredicto por modo de fallo. |
| 5. Consolidar | Deduplicar, aplicar la escala, escribir el **test que falla** de cada Crítica (confirmación, no arreglo), tabla resumen, specs de seguimiento propuestos. **Parar y enseñar al usuario.** | serie | Usuario aprueba la lista de Críticas. |
| 6. Correcciones | Protocolo de la constitución, de una en una. | serie | Commits y suite verde. |
| 7. Cierre | `findings.md` final, índice de specs, `CLAUDE.md` si cambió algo, memorias. | serie | Estado `hecho`. |

Las fases 2, 3 y 4 corren a la vez (cinco subagentes como mucho). Cada subagente escribe **solo** en su
fichero del scratchpad; únicamente el consolidador toca `findings.md`. La fase 5 exige las tres líneas
cerradas; la 6 exige la aprobación del usuario.

## Sondas públicas

Scripts en `<scratchpad>/probes/<venue>.mjs`, Node con `fetch` nativo, sin dependencias, nunca en el repo.

Salvaguardas, en este orden: el script aborta si alguna variable de entorno casa con
`/KEY|SECRET|PRIVATE|MNEMONIC|SEED/i`; lista blanca fija de los seis hosts REST, cotejada con
`packages/exchange-core/src/endpoints.ts` y enseñada al usuario antes de la primera ejecución; solo
`GET` y el `POST /info` de Hyperliquid, nunca `/exchange`, `/sendTx*` ni `/order`;
`AbortSignal.timeout(10_000)`; una petición por segundo y no más de veinte por venue y ejecución; parar
ante un 429 sin reintentar; `User-Agent` explícito; una sola ejecución, cacheada.

| Venue | Peticiones (mainnet y testnet) | Qué se compara |
|---|---|---|
| Hyperliquid | `POST /info` `{type:"meta"}`, `{type:"metaAndAssetCtxs"}`, un `l2Book` | `szDecimals`, `maxLeverage`, `midPx` frente a `hyperliquidTickSize` y `MIN_NOTIONAL_USD = '10'` |
| Lighter | `GET /api/v1/orderBooks`, `orderBookDetails` de dos o tres mercados, existencia de `/api/v1/candles` | `supported_price_decimals`, `supported_size_decimals`, `min_base_amount`, `min_quote_amount`, `min_initial_margin_fraction` frente a `loadMarkets` |
| Aster | `GET /fapi/v3/exchangeInfo`, `ping`, `time`, un `bookTicker`; resolución de `fapi.asterdex-testnet.com` y `fstream5.asterdex-testnet.com` | `filters` y `rateLimits` frente a `venue-weights.ts` (2400/min) y `ASSUMED_MAX_LEVERAGE = 50`; un 404 en v3 es en sí un hallazgo |

Salida: `<venue>.<red>.<endpoint>.<ts>.json` en el scratchpad; `compare.md` pasa el JSON guardado por
el parser puro del adaptador (en un test jest temporal, también en scratchpad) y lo compara con lo
sondeado. A `findings.md` va solo la evidencia resumida.

## Riesgos que el revisor no debe olvidar

- La app ejecuta `strategy-core` en cliente (`apps/app/src/app/features/bots/bot-create.page.ts`) **y** llama al preview de la API: dos fuentes de verdad; todo arreglo debe compilar con el tsconfig de la app y seguir siendo equivalente.
- El backtest reutiliza `plan()`, `reconcile` y `cycle-accounting`: los backtests guardados dejan de ser reproducibles tras un arreglo.
- El advisor emite configuraciones: deben pasar el mismo `validate()`; un parámetro muerto es también un fallo del advisor.
- El simulador debe reflejar los arreglos de redondeo o diverge; `bot-runner.strategies.spec.ts` puede estar codificando la conducta errónea; los mocks de adaptador pueden ocultar fallos de forma del SDK (tuplas de Lighter).
- `client_order_id` es `@unique` en `bot_orders`: la colisión del aplanado del market maker falla en la BD o queda vetada en `place()`; se verifica con test.
- `void this.onOrderUpdate(order)` y `onStreamHealth` en `bot-runner.ts` van sin guarda; TTL del lease frente a la duración máxima de un tick; la cuarentena en memoria se pierde al reiniciar; deriva de reloj en Aster.
- Windows: build nativo de `koffi`, CRLF frente a prettier, jest desde Git Bash.

## Verificación

- Fase 0 y fase 7: `pnpm build:packages && pnpm test && pnpm lint && pnpm check:env` desde Git Bash, con los códigos de salida anotados.
- Cada corrección: test que falla → arreglo → `pnpm --filter <pkg> test` → dependientes (`worker`, `backtest`, typecheck de la app) → `pnpm --filter <pkg> lint`.
- `findings.md`: CA-1 a CA-5 repasados uno a uno en el cierre.
- Sondas: `git status` limpio tras ejecutarlas; ninguna variable sensible cargada.

# 035 — Plan de implementación

Acompaña a `spec.md`. Aquí va el **cómo**: el arreglo, los ficheros, los tests y el orden de los
commits. El qué y el por qué están en el spec.

## De dónde sale esto

Un Market Maker V2 en simulación lleva **23 horas sobre LIT/Lighter sin una sola ejecución**:
posición 0, PnL 0,00, ciclo #1, 2 órdenes vivas. En esas 23 horas el precio ha recorrido de 4,28
a 4,95 —un 15 %— y el bot cotiza a ±1,21 % del precio. No debería ser posible.

**No es comportamiento normal: es un defecto.** Y no está donde parece.

### Lo que NO es

- **El simulador está bien.** `packages/exchange-core/src/adapters/dry-run.ts:686-717` casa al
  **tocar** (`ask ≤ precio` en compras, `bid ≥ precio` en ventas), la orden entera, sin cola ni
  parciales, y se evalúa en **cada actualización del libro por WebSocket** —no una vez por tick—
  porque el runner se suscribe al adaptador simulado a propósito
  (`apps/worker/src/engine/account-hub.service.ts:713-726`, cuyo comentario cuenta que servirle el
  precio desde el feed compartido lo dejaba ciego). Es *optimista*: si aquí no ejecuta, en un venue
  real ejecutaría menos.
- **La fórmula del diferencial está bien.** Los 121,4 bps se reproducen al decimal desde
  `composeSpreadBps` (`market-maker-v2.ts:671-697`): `102 + 1,5 + 0,35×36,8 + 4 + 1`.
- **El mercado está bien.** Eficiencia 0,02 (Kaufman, `market-features.ts:106-111`) significa que
  el precio va y viene sin ir a ninguna parte: el terreno *ideal* para un market maker.
- **«En mercado 0 %» no es un fallo de la interfaz**: mide el tiempo con **posición** abierta
  (`packages/shared/src/series.ts:530-535`), no con órdenes puestas. Es otra forma de decir lo
  mismo.

### La causa raíz

**El bot se aparta antes de que el precio pueda alcanzarlo.** El umbral que dispara una
recotización es menor que la distancia a la que cotiza, en **las dos** estrategias y también en los
valores de fábrica:

| | Cotiza a | Recotiza con deriva de | Ratio |
|---|---|---|---|
| V1 fábrica | 20 bps (capa 0 de 3) | **8** (`minAllowedDistanceBps`, `market-maker.ts:726`) | 2,5× |
| V2 fábrica | 45,5 bps | **30** (`repriceThresholdBps`, `market-maker-v2.ts:1079`) | 1,5× |
| El bot del incidente | 121,4 bps | **51** (`spread × 0,5`, `advisor/build.ts:491`) | 2,4× |

Tras recotizar en `M`, el bid queda en `M·(1−d)`. Cuando el precio ha caído el umbral —todavía
lejos del bid— el tick siguiente re-centra sobre el precio nuevo y **el bid se aleja otro tanto**.
Además `refreshSeconds` re-centra cada 30 s aunque el precio no se mueva. La cotización nunca puede
estar a menos de `d − umbral` del mercado, y solo ejecutaría con un salto de `d` entero dentro de
una ventana de 15-30 s. El motor planifica cada `RECONCILE_INTERVAL_MS = 15_000`.

Con el ATR del par (≈291 bps en 1 h), el recorrido esperado en 15 s es ~19 bps. Hacen falta 121.
En 23 h hubo ~5.500 ventanas y ninguna lo consiguió.

### El hallazgo que decide el arreglo

`precioEstable()` (`mm-shared.ts:108-129`) existe para conservar una orden viva cuando moverla no
compensa, con tolerancia del 25 % de la distancia de la capa. **La V1 la usa y la V2 no.** Pero
mirando los números: cuando la recotización la dispara la deriva, *el desvío ES la deriva*, así que
solo frena si `umbral < 0,25·d` — y en fábrica es 8 > 5, en el asesor 0,4·s > 0,25·s.

**Nunca ha frenado nada.** Llevarla a la V2 tal cual no arreglaría nada.

## Decisiones tomadas

**No hay ningún market maker real en marcha**: el único bot afectado es el simulado del incidente.
Eso quita de en medio la única razón para ir con pies de plomo, así que el arreglo va entero y de
una vez, sin interruptor, sin fases y sin compatibilidad hacia atrás que mantener.

| | Decisión |
|---|---|
| Bots vivos | El arreglo se aplica **a todos, sin interruptor**. Un MM que no ejecuta está averiado, y el arreglo además *reduce* peticiones al venue. |
| Fábrica V2 | `buyDistanceBps`/`sellDistanceBps` **40 → 20**; `orderMaxAgeSeconds` **120 → 300**. |
| Asesor | Corregir **horizonte y doble conteo** de la volatilidad. Solo afecta a bots nuevos. |
| Aviso de `validate()` | **Solo en lo patológico**: no salta con la fábrica ni con el asesor. |

---

## El arreglo: la tolerancia se vuelve asimétrica

**Nunca se retira una cotización porque el mercado se le esté acercando.** Hacia fuera sigue
mandando la tolerancia del 25 %; hacia dentro no hay tolerancia.

En `packages/strategy-core/src/strategies/mm-shared.ts`, `precioEstable()` gana el lado:

```ts
const acercandose = side === 'BUY' ? actual.gt(deseado) : actual.lt(deseado);
if (acercandose) return actual;
```

Por qué esto es el arreglo y no un parche:

1. **Es exactamente la condición `e < d`, sin necesidad de pasar el mid.** Para una compra,
   `actual > deseado ⟺ (ancla−actual)/ancla < d`. Álgebra, no heurística.
2. **Desacopla los dos lados** aunque `quotedMid` siga siendo único: con el precio cayendo, la
   compra se conserva (y ejecuta) mientras la venta sigue al mercado. Es la conducta que se quería
   y que hoy no se puede tener porque el centro manda sobre los dos lados a la vez.
3. **No cambia la semántica de ningún parámetro de usuario.** `refreshSeconds`,
   `repriceThresholdBps` y `minAllowedDistanceBps` siguen significando lo que dicen las guías; solo
   cambia lo que ve `reconcile`: una orden que ya no hace falta reemplazar (`samePrice` tolera medio
   tick, `reconcile.ts:252-255`, así que devolver el precio vivo da `unchanged`).
4. **Respeta el spec 029**, que descartó acotar el centro al BBO precisamente para no perseguir al
   precio. Ahora se congela también lo que de verdad importaba: las órdenes.

Con esto, `refreshSeconds` deja de hacer daño solo: re-centrar el centro con las órdenes
conservadas no mueve nada. **No se toca.**

### El límite honesto

Tras el arreglo, la ventana de ejecución pasa a estar limitada por `orderMaxAgeSeconds` (120 s de
fábrica en la V2; la V1 no caduca por edad). Por eso sube a **300 s**, que es además
`volatilitySampleSeconds`: no se tira una cotización antes de haber observado una ventana entera de
volatilidad. La ventana pasa de `min(30 s, umbral)` a 300 s. Es 4× mejor, no infinito.

## Ficheros

| Ruta | Qué |
|---|---|
| `packages/strategy-core/src/strategies/mm-shared.ts` | `precioEstable` asimétrica (+`side`), con el incidente en el comentario. |
| `.../strategies/market-maker.ts` | Pasar `side` en las dos llamadas (`:881`, `:924`); aviso de `validate()`; **defaults sin tocar**. |
| `.../strategies/market-maker-v2.ts` | Mapa de órdenes vivas (calcado de `market-maker.ts:853-855`), envolver los dos precios en `precioEstable`, aviso de `validate()`, `defaults()`. |
| `apps/api/src/modules/advisor/build.ts` | `buildMarketMaker`: horizonte de 5 min, descontar lo que ya añade `composeSpreadBps`, `minAllowedDistanceBps` = suelo por coste, `repriceThresholdBps`, `orderMaxAgeSeconds`. |
| `docs/market-maker{,-v2}.md` + `apps/app/src/app/core/content/market-maker{,-v2}.guide.ts` | «Qué mueve y qué no mueve una cotización viva». |
| `packages/backtest/src/warnings.ts:76-81` | Matizar: el intervalo de recotización sigue sin reproducirse en replay, pero ya hay un test a cadencia de motor. |

### El asesor, en concreto

El horizonte de una cotización viva son minutos, no una hora. Con `recorrido₅ₘ = ATR₁ₕ/√12` y
descontando lo que `composeSpreadBps` ya suma, el par del incidente pasa de **121,4 → ~40 bps por
lado**. Y `minAllowedDistanceBps` deja de ser `0,4·spread` —un umbral de deriva disfrazado de
suelo— para ser el suelo por coste que dice ser.

## Tests — el agujero que hay que cerrar

**Hoy ningún test comprueba que una cotización llegue a ejecutarse.** Los ~30 casos de MM en
`packages/strategy-core/src/strategies.spec.ts` son todos «llamo a `plan()` una vez y compruebo el
precio». El único multi-tick verifica contabilidad de recotizado, no ejecución. Y el backtest
declara explícitamente que no reproduce la cadencia de los market makers.

La magnitud que hay que medir **no es el umbral**: es **cuánto puede recorrer el precio antes de que
la cotización se mueva**. Un test que solo fije `repriceThresholdBps ≥ distancia` seguiría verde con
el bot roto, porque `refreshSeconds` recentra igual.

**`packages/strategy-core/src/strategies/mm-ejecucion.spec.ts`** (nuevo, ~1 s). Un harness
`recorrer({kind, config, camino})` que en cada paso casa las órdenes vivas con la regla de
`dry-run.ts:707`, aplica `cycleAfterFill`, llama a `plan()` y aplica `reconcile`. El camino es una
**onda triangular determinista** calibrada al ATR del incidente (290 bps/hora, semiperiodo 30 min) —
no un paseo aleatorio: por construcción el precio visita toda la banda en los dos sentidos, así que
si no ejecuta la culpa es del recentrado, sin estadística de por medio. Mercado de pruebas con
`tickSize: '0.01'` (1 bps), porque el `TEST_MARKET` actual tiene ticks de 10 bps y taparía el efecto.

La aserción de cabecera es la relación causal, no un recuento:

```ts
expect(r.derivaMaximaSoportadaBps).toBeGreaterThanOrEqual(r.distanciaDeCotizacionBps);
expect(r.huecoMinimoBps).toBe(0);        // el mercado llegó a tocarla
expect(r.ejecuciones.length).toBeGreaterThan(0);
```

Casos: los valores de fábrica de la **V2** y de la **V1** durante 24 h simuladas (los dos leen
`defaults()`, así que se ponen verdes solos al corregirlos); la propiedad con rampa monótona y los
otros mecanismos apagados, en tabla de dos filas (umbral por debajo → 0 ejecuciones, por encima →
ejecuta); que un refresco **por tiempo** no mueva una cotización que el precio apenas ha rozado; y
que no se recotice en más de la mitad de los planes (la cuota de Lighter del spec 031).

**`packages/backtest/src/mm-cadencia.spec.ts`** (nuevo, ~1,5 s): las mismas 24 h a cadencia de motor
pero contra el **`DryRunAdapter` real**, que ya tiene reloj y semilla inyectables. Más un test de
anclaje que compara el veredicto del harness puro y el del simulador en la frontera exacta
(`ask == precio`, `ask == precio + 1 tick`), que es lo que justifica duplicar esas cuatro líneas.

**`apps/worker/src/engine/bot-runner.strategies.spec.ts`**: un `it` más dentro del describe que ya
existe, con 20 movimientos y reloj real — el único sitio donde esto pasa por el reconciliador real,
`revisarOrden`, el coid en hexadecimal y el post-only. No se mockea `Date`: `bot-runner.ts:2134` usa
`Date.now()` a pelo y también gobierna el cortacircuitos; inyectar reloj ahí sería otro spec.

## Verificación

- `pnpm test:strategies` — el test nuevo **falla primero**, por el motivo correcto (jest imprime
  «deriva soportada 4,8 / distancia 93,2»).
- Tras tocar `strategy-core`, el protocolo completo: `pnpm --filter worker test`,
  `pnpm test:backtest`, typecheck de la app, `pnpm --filter strategy-core lint`.
- Tras el asesor: `pnpm --filter api test` (ojo a `advisor.spec.ts` y `venue-matrix.spec.ts`, que
  recorren regímenes × mercados comprobando mínimos: con distancias menores puede cambiar algún
  reparto de capas).
- Jest desde Git Bash, no PowerShell.
- **Manual, el que cierra el caso**: crear otro MM V2 simulado sobre el mismo par y dejarlo unas
  horas. Hoy da 0 ejecuciones; con el arreglo tiene que ejecutar. Comparar `bot_orders`: si antes
  había cientos de filas `CANCELED` siguiendo al precio y ahora hay ejecuciones, está cerrado.

## Orden de commits (rama `spec/035-el-precio-alcanza-la-cotizacion`)

1. `docs(spec 035)` — spec, plan, tareas y fila en el índice.
2. `test(strategy-core)` — el harness y los casos. **Falla primero.**
3. `fix(strategy-core)` — `precioEstable` asimétrica + cablearla en la V2. Diff pequeño.
4. `feat(strategy-core)` — el aviso de `validate()` en las dos estrategias.
5. `chore(strategy-core)` — los valores de fábrica de la V2 (decisión explícita del usuario).
6. `fix(advisor)` — horizonte y doble conteo.
7. `test(backtest,worker)` — la validación cruzada contra el simulador real.
8. `fix(strategy-core,app)` — la nota imprime el diferencial aplicado; «En mercado» → «Con posición».
9. `docs` — guías, contenido de la app y el aviso del backtest.

## Riesgos

- ~~Bots reales que empiezan a operar.~~ **Descartado: no hay ninguno.** El único market maker
  existente es el simulado del incidente, así que no hay conducta en producción que proteger ni
  despliegue por fases que planificar. Sí conviene mirar `maxBotPositionValue` y `limitAction` del
  bot de pruebas: esa red no había hecho falta nunca porque nunca hubo inventario que topar, y en
  cuanto ejecute lo habrá.
- **Selección adversa.** Conservar la compra que el mercado baja a buscar es comprar contra flujo
  informado. Es lo que hace un market maker; las redes ya existen (regímenes `DEFENSIVE`/`HIGH_RISK`,
  tope + acción, `fillCooldownSeconds`, `orderMaxAgeSeconds`, stop opcional) y ninguna se toca.
- **Un pico de volatilidad ya no repliega las cotizaciones puestas**, solo ensancha las nuevas.
  Aceptado y coherente con la congelación de `quotedVolBps` (001/F-61); acotado por la caducidad.
- **Órdenes parcialmente ejecutadas**: `reconcile.ts:193-195` acepta el resto o la cantidad
  original, así que la conservada da `unchanged`. Cubrir con test.
- **La V2 no tiene hoy `precioEstable` en su suite**, así que un fallo de cableado pasaría en
  silencio: test explícito de que el precio devuelto es **byte a byte** el de la orden viva.

## Qué NO se toca

`dry-run.ts` (verificado y correcto), la congelación de `quotedMid` y la decisión del spec 029 de no
acotar el centro al BBO, `refreshSeconds`/`repriceThresholdBps`/`minAllowedDistanceBps` (su
semántica no cambia), los valores de fábrica de la V1, `makeCoid`, `RECONCILE_INTERVAL_MS` y
`packages/db/prisma`. No se debilitan los tests de `expiredQuotes` ni los del ciclo de escritura del
scratch: son la red contra la regresión de tráfico por el otro extremo.

## Lo demás que apareció, y que también entra

Como el encargo es arreglarlo todo y no hay nada en producción que frene:

- **La etiqueta «En mercado» → «Con posición»** (`apps/app/.../bot-detail.page.html:217`). Se lee
  como «con órdenes en el mercado» y mide el tiempo con **posición** abierta. Es cambiar un rótulo,
  y evita exactamente la confusión que tuvo el usuario al leer «En mercado 0 %» con dos órdenes
  vivas. Commit propio, sin lógica.
- **La nota del bot enseña el diferencial ANTES del techo.** `market-maker-v2.ts:1291-1310` imprime
  `s.bps`, pero lo que se coloca pasa por `conTecho()` con los multiplicadores de capa, preset y
  régimen (`:704-705`). Con el techo mordiendo, la nota miente. Se imprime el aplicado.
- **F-54, Lighter y los market makers** — esto **no** se arregla aquí, se recuerda:
  `docs/market-maker.md:594` dice *«Lighter no tiene stream de cuenta: las ejecuciones llegan por
  sondeo cada 12 s, demasiado tarde para recotizar con criterio. Hasta que se corrija: no operes
  market makers en Lighter.»* El bot del incidente es de Lighter. En simulación no muerde; antes de
  llevar un market maker a real en ese venue, hay que cerrar F-54 o cambiar de venue.

Lo que sigue **fuera** de alcance, y por qué: añadir a la V1 un `repriceThresholdBps` propio (hoy
reutiliza `minAllowedDistanceBps` como umbral de deriva, que es una rareza real). Con la tolerancia
asimétrica deja de ser un problema de alcance y pasa a ser solo de tráfico; un campo nuevo costaría
formulario, `meta.fields`, mutabilidad, guía, asesor y app para no arreglar nada más. Queda anotado
como hallazgo en `findings.md`.

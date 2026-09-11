# 035 — El precio tiene que poder alcanzar la cotización

Estado: `hecho` · Tipo: `cambio` · Rama: `spec/035-el-precio-alcanza-la-cotizacion`

## Objetivo

Que un market maker pueda ejecutar. Hoy se aparta antes de que el precio llegue a su cotización, y
lo hace en las dos versiones y también con los valores de fábrica. Se sabrá que está hecho cuando un
recorrido de precio con el ATR del incidente produzca ejecuciones, y haya un test que lo mida.

## Contexto

Un Market Maker V2 en **simulación** lleva **23 h sobre LIT/Lighter sin una sola ejecución**:
posición 0, PnL 0,00, ciclo #1, 2 órdenes vivas. En esas 23 h el precio recorrió de 4,28 a 4,95 —un
15 %— y el bot cotizaba a ±1,21 %. No debería ser posible.

**Lo que NO es**, verificado uno a uno:

- **El simulador está bien.** `packages/exchange-core/src/adapters/dry-run.ts:686-717` casa al
  **tocar** (`ask ≤ precio` en compras, `bid ≥ precio` en ventas), la orden entera, sin cola ni
  parciales, y se evalúa en **cada actualización del libro por WebSocket** —no una vez por tick—,
  porque el runner se suscribe al adaptador simulado a propósito
  (`apps/worker/src/engine/account-hub.service.ts:713-726`). Es *optimista*: si aquí no ejecuta, en
  un venue real ejecutaría menos.
- **La fórmula del diferencial está bien.** Los 121,4 bps se reproducen al decimal desde
  `composeSpreadBps` (`market-maker-v2.ts:671-697`): `102 + 1,5 + 0,35×36,8 + 4 + 1`.
- **El mercado está bien.** Eficiencia de Kaufman 0,02: el precio va y viene sin ir a ninguna
  parte, que es el terreno ideal para un market maker.

**La causa raíz**: el umbral que dispara una recotización es **menor que la distancia a la que se
cotiza**, así que el bot recentra sus órdenes sobre el precio nuevo antes de que el precio pueda
alcanzar a las viejas.

| | Cotiza a | Recotiza con deriva de | Ratio |
|---|---|---|---|
| V1 fábrica | 20 bps (capa 0 de 3) | **8** (`minAllowedDistanceBps`, `market-maker.ts:726`) | 2,5× |
| V2 fábrica | 45,5 bps | **30** (`repriceThresholdBps`, `market-maker-v2.ts:1079`) | 1,5× |
| El bot del incidente | 121,4 bps | **51** (`spread × 0,5`, `advisor/build.ts:491`) | 2,4× |

Tras recotizar en `M`, el bid queda en `M·(1−d)`. Cuando el precio ha caído el umbral —todavía lejos
del bid— el tick siguiente re-centra y el bid se aleja otro tanto. Y `refreshSeconds` re-centra cada
30 s aunque el precio no se mueva. La cotización nunca puede estar a menos de `d − umbral` del
mercado. Con el ATR del par (≈291 bps/h), el recorrido esperado en un tick de 15 s es ~19 bps; hacen
falta 121. En 23 h hubo ~5.500 ventanas y ninguna lo consiguió.

**El hallazgo que decide el arreglo**: `precioEstable()` (`mm-shared.ts:108-129`) conserva una orden
viva mientras el desvío sea ≤ 25 % de la distancia de su capa. La V1 la usa y la V2 no — pero cuando
la recotización la dispara la deriva, *el desvío ES la deriva*, así que solo frena si
`umbral < 0,25·d`, y en fábrica es 8 > 5 y en el asesor 0,4·s > 0,25·s. **Nunca ha frenado nada**, y
llevarla a la V2 tal cual no arreglaría nada.

## Alcance

`packages/strategy-core` (`mm-shared.ts`, las dos estrategias y tests nuevos),
`apps/api/src/modules/advisor/build.ts`, `packages/backtest` (un spec nuevo y un aviso),
`apps/worker` (un caso más), `docs/` y las guías de la app.

## Fuera de alcance

- **`dry-run.ts`**: verificado y correcto.
- **La congelación de `quotedMid`** y la decisión del spec 029 de no acotar el centro al BBO.
- **La semántica de `refreshSeconds`, `repriceThresholdBps` y `minAllowedDistanceBps`**: no cambia.
- **Los valores de fábrica de la V1**: con el arreglo, su capa 0 a 20 bps es alcanzable.
- **Un `repriceThresholdBps` propio para la V1.** Hoy reutiliza `minAllowedDistanceBps`, que es una
  rareza real (F-01), pero tras el arreglo deja de ser un problema de alcance y pasa a ser solo de
  tráfico; un campo nuevo costaría formulario, `meta.fields`, mutabilidad, guía, asesor y app para
  no arreglar nada más.
- **F-54 (Lighter sin stream de cuenta)**: sigue abierto y sigue desaconsejando market makers en
  ese venue.

## Requisitos

- **R-1** Una cotización viva **no se retira porque el mercado se le esté acercando**. Hacia fuera
  sigue mandando la tolerancia del 25 % de la distancia de su capa; hacia dentro no hay tolerancia.
- **R-2** La regla vale para las dos versiones y no exige campo nuevo ni cambia el significado de
  ningún parámetro de usuario.
- **R-3** El precio conservado se devuelve **antes de dimensionar**, para que la cantidad salga
  idéntica y `reconcile` dé la orden por `unchanged`.
- **R-4** `validate()` avisa cuando el umbral queda por debajo de la distancia de cotización, pero
  **solo en lo patológico**: no salta con los valores de fábrica ni con lo que sugiere el asesor.
- **R-5** Valores de fábrica de la V2: distancia **40 → 20** bps y `orderMaxAgeSeconds` **120 → 300**.
- **R-6** El asesor deja de contar la volatilidad dos veces y usa el horizonte de una cotización
  viva —minutos— en vez de una hora.
- **R-7** La nota del bot imprime el diferencial **aplicado**, no el previo al techo.

## Criterios de aceptación

- **CA-1** Con los valores de fábrica de la **V2** y 24 h de un recorrido con el ATR del incidente,
  `derivaMaximaSoportadaBps ≥ distanciaDeCotizacionBps`, el hueco mínimo llega a 0 y hay
  ejecuciones. Hoy falla. (`mm-ejecucion.spec.ts`)
- **CA-2** Lo mismo para la **V1**. (ídem)
- **CA-3** Propiedad, con rampa monótona y los otros mecanismos apagados: con el umbral por debajo
  de la distancia no ejecuta y el hueco se estabiliza en `distancia − umbral`; por encima, ejecuta.
- **CA-4** Un refresco **por tiempo** no mueve una cotización que el precio apenas ha rozado.
- **CA-5** No se recotiza en más de la mitad de los planes (la cuota de Lighter del spec 031).
- **CA-6** El mismo escenario contra el **`DryRunAdapter` real** ejecuta, y la regla de toque del
  harness puro coincide con la del simulador en la frontera exacta. (`mm-cadencia.spec.ts`)
- **CA-7** En el worker, con el reconciliador y el post-only reales, veinte movimientos de precio
  acaban en posición abierta.
- **CA-8** El precio conservado es **byte a byte** el de la orden viva.
- **CA-9** `pnpm test` en verde y `pnpm --filter app build` sin avisos de presupuesto.
- **CA-10** *(manual)* Un MM V2 simulado sobre el mismo par ejecuta en unas horas donde antes no
  ejecutaba en 23.

## Riesgos

- **Selección adversa.** Conservar la compra que el mercado baja a buscar es comprar contra flujo
  informado. Es lo que hace un market maker; las redes existentes (regímenes, tope + acción,
  `fillCooldownSeconds`, `orderMaxAgeSeconds`, stop) no se tocan.
- **Un pico de volatilidad ya no repliega las cotizaciones puestas**, solo ensancha las nuevas.
  Coherente con la congelación de `quotedVolBps` (001/F-61) y acotado por la caducidad por edad.
- **No hay ningún market maker real en marcha**, así que no hay conducta en producción que proteger.
  Sí conviene revisar `maxBotPositionValue` y `limitAction` del bot de pruebas: esa red no había
  hecho falta nunca porque nunca hubo inventario que topar.

## Referencias oficiales

Ninguna: el defecto y su arreglo son internos. Las citas están en el contexto con `fichero:línea`.

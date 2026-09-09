# 030 — Parámetros, selectores y lo que el formulario no dice

Estado: `borrador` · Tipo: `revisión` · Rama: `spec/030-parametros-y-selectores`

## Objetivo

Revisar los parámetros de las siete estrategias con el foco en **lo que cambia según lo que el
usuario elige**: qué anula qué, qué queda inerte, y si el formulario y la validación reflejan esas
dependencias. Se sabrá conseguido cuando cada hallazgo tenga evidencia con `fichero:línea` y un
contrato de arreglo, y los que el usuario apruebe estén corregidos con su test.

## Contexto

El usuario preguntó por el selector **«Introducir tamaños en · Valor nocional / Cantidad de moneda»**
del market maker y pidió revisar todos los parámetros de todos los bots, qué afecta cada uno, y si el
frontend o el backend deben cambiar en función de los selectores.

La revisión encontró que ese selector concreto **rompe el campo que gobierna**: `sizingMode` cambia
la naturaleza de `orderSizePerSide` (nocional en USDC o cantidad de la moneda), pero el descriptor
del campo es estático —`unit: 'USDC'`, `min: 1`— y la validación genérica del spec 019 aplica ese
mínimo a rajatabla. Resultado: el modo «Cantidad de moneda» no se puede usar por debajo de 1 unidad,
y mientras tanto el input le dice al usuario que está tecleando USDC.

Los hallazgos completos, con su evidencia y su contrato de arreglo, están en
[`findings.md`](./findings.md).

## Alcance

- Los descriptores (`meta.fields`) y las funciones `validate()` y `preview()` de las siete
  estrategias en `packages/strategy-core/src/strategies/`.
- El formulario de creación y revisión: `apps/app/src/app/features/bots/bot-create.page.ts`
  (`fields`, `capFields`, `groupsOf`) y `apps/app/src/app/shared/ui/ui-field.component.ts`.
- La validación genérica por descriptor: `packages/strategy-core/src/common.ts`.

## Fuera de alcance

- El catálogo parámetro-por-parámetro **ya existe**: `specs/001-revision-integral/informes/A-grids.md`
  y `A-market-makers.md` lo hicieron campo a campo, y los specs 011-028 corrigieron lo que salió de
  ahí. Este spec no lo repite: revisa las **combinaciones** y la coherencia con el formulario, que es
  lo que aquel no cubrió.
- Cambiar valores de fábrica de cualquier estrategia.
- `packages/db` y cualquier migración.

## Requisitos

- **R-1** El mínimo de un campo cuya unidad depende de un selector no puede ser una constante del
  descriptor: con `sizingMode: BASE` el suelo es el del mercado (`minQty`), no `1`.
- **R-2** La unidad que se pinta en el campo es la que el usuario está tecleando de verdad: `USDC`
  con `QUOTE`, el símbolo base del par con `BASE`.
- **R-3** Las dos guardas que `validate()` no puede hacer en modo BASE se hacen en `preview()`, que
  sí tiene precio de referencia.
- **R-4** Un parámetro que queda inerte por culpa de otro se avisa en `validate()`, con el patrón que
  ya usan Neutral Grid y el Market Maker V2.

## Criterios de aceptación

- **CA-1** Con `sizingMode: BASE` en un par cuyo `minQty` sea 0,0001, una configuración con
  `orderSizePerSide: '0.05'` es válida. Hoy falla con «no puede ser menor que 1».
- **CA-2** El descriptor que recibe `ui-field` para `orderSizePerSide` lleva `unit: 'BTC'` en el par
  BTC con `sizingMode: BASE`, y `unit: 'USDC'` con `QUOTE`.
- **CA-3** En modo BASE, un tope por lado que no da ni para la cotización más pequeña produce un aviso
  en el preview.
- **CA-4** Cada pareja de F-04 produce un `warn` cuando el parámetro queda inerte.
- **CA-5** `pnpm test:strategies`, `pnpm --filter worker test`, `pnpm test:backtest` y el typecheck de
  la app en verde.

## Riesgos

- R-1 y R-2 tocan el descriptor de dos estrategias con bots en marcha. **No cambian ninguna conducta
  del motor**: un bot ya creado sigue con su configuración y su semántica; lo que cambia es lo que el
  formulario acepta y enseña al crear o revisar.
- R-1 relaja un mínimo, así que abre configuraciones que antes se rechazaban. El suelo real lo
  seguirá poniendo `revisarOrden` contra el mercado, que es quien manda.
- R-4 añade avisos: pueden aparecer en bots existentes al revisarlos. Es el efecto buscado.

## Referencias oficiales

Ninguna regla de venue nueva. Los mínimos por mercado ya vienen del catálogo (`MarketSpec.minQty`,
`minNotional`), poblado en el spec 024.

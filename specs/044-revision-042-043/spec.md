# 044 — Revisión de los specs 042 y 043

Estado: `hecho` · Tipo: `cambio` · Rama: `spec/044-revision-042-043`

## Objetivo

Corregir lo que aparece al releer con calma el seguimiento de beneficio: dos defectos de
comportamiento, uno de vista previa, una trampa cargada y tres tablas de documentación que se
quedaron atrás.

## Contexto

Los specs 042 y 043 salieron en verde: 6.779 tests, lint limpio, la app compila y el worker vuelve a
compilar. Pero los tests solo prueban lo que alguien pensó en probar, y hay tres cosas que ninguno
miraba:

- lo que pasa al **apagar y volver a encender** un interruptor HOT;
- lo que pasa con una posición **al borde del mínimo del venue**;
- lo que la **vista previa** enseña cuando la entrada está condicionada a un precio.

Las tres son de las que el spec 041 llamó «de ventana»: no ocurren en una llamada, ocurren entre
dos configuraciones o entre dos pantallas.

`findings.md` lleva las seis fichas con su evidencia.

## Alcance

- `packages/strategy-core/src/trailing-take-profit.ts` — limpiar el estado al apagarlo
- `packages/strategy-core/src/strategies/{tdca,martingale}.ts` — llamarlo
- `packages/strategy-core/src/order-gate.ts` — la regla de la marca, generalizada
- `packages/strategy-core/src/strategies/trailing-profit.ts` — la vista previa y el campo fantasma
- `apps/api/src/modules/advisor/build.ts` — el campo fantasma, también ahí
- `README.md`, `docs/riesgo-y-liquidacion.md`, `docs/buenas-practicas.md`
- Sus tests

## Fuera de alcance

- **F-06**, las dos condicionales del mismo sentido: no se puede cerrar sin un venue real. Va a la
  comprobación manual.
- **F-01 del spec 037**, que sigue esperando decisión del usuario.

## Requisitos

- **R-1 — Apagar el seguimiento borra su estado. (F-01, Alta)**

  `ttpArmed` y `ttpPeak` solo se limpian al cerrarse el ciclo, así que apagar el interruptor —es
  HOT— y volver a encenderlo recupera un máximo de antes. Con el pico en 140, retroceso del 10 % y
  la marca ya en 100, al reencenderlo el disparador nace en **126**: una venta con disparo a la baja
  por encima del mercado, o sea **un cierre a mercado inmediato** de la posición entera.

  Con el seguimiento apagado, las dos claves se limpian. Solo se escribe si había algo que limpiar,
  para no meter un `UPDATE` por tick.

  Lo que **no** cambia: el mismo disparador inmediato tras un `PAUSE`/`RESUME` o tras un worker
  caído sigue siendo correcto. Allí el seguimiento nunca se apagó y la condición se cumplió de
  verdad.

- **R-2 — El mínimo del venue se mide en la MARCA para toda condicional a mercado. (F-02, Media)**

  Hoy la regla es `levelKind === 'STOP_LOSS'`, y el seguimiento emite un `TAKE_PROFIT`: se mide
  contra su disparador. Es el fallo 001/F-91, que esa línea existe para arreglar — «lo que el venue
  cierra es la posición que hay, al precio que hay; el disparo solo dice cuándo».

  Con la marca en 130, una posición de 13 USDC y un retroceso del 10 %, el disparador cae en 11,7:
  con un mínimo de 12 la salida **no se coloca**, aunque la posición sí lo cumple.

  La condición pasa a ser `type === 'MARKET' && triggerPrice != null`. Cubre el stop-loss de
  siempre, el take profit a mercado de Martingala y el seguimiento.

- **R-3 — La vista previa se calcula sobre el precio de entrada. (F-03, Media)**

  Con entrada condicionada a 80, el precio en 100 y objetivo del 15 %, la vista previa pinta
  entrada 100, cantidad 10 y objetivo 115. El bot entrará en 80 con 12,5 y seguirá desde 92.

  Cuando hay condición de entrada, el nivel se dimensiona y se calcula sobre `activationPrice`. El
  `refPrice` se sigue pasando como referencia de mercado, así que «distancia al precio actual» y
  «distancia a liquidación» siguen midiéndose contra hoy, que es lo correcto.

- **R-4 — Ninguna estrategia deja en su configuración un campo que su meta no declare. (F-04, Baja)**

  `TRAILING_PROFIT` metía `trailingTakeProfit: true` en `defaults()` sin declararlo en
  `meta.fields`. Nadie lo lee, pero `diffConfig` trata como **COLD** todo campo no declarado: un
  cliente que reconstruyera la configuración desde la meta haría que la edición de un bot en marcha
  se rechazara por un campo que el usuario no puede ni ver.

  Se quita de `defaults()` y del asesor. Y el test se escribe **para todas** las estrategias, que es
  lo que impide que la próxima repita la trampa.

- **R-5 — Las tablas transversales al día. (F-05, Baja)**

  El peor caso por estrategia de `riesgo-y-liquidacion.md`, el «no lo uses si…» de
  `buenas-practicas.md` y la tabla del `README.md` se quedaron en siete estrategias: les falta
  Tendencia (spec 040) y Seguimiento de beneficio (spec 043). Son justo las dos tablas que se
  consultan antes de encender un bot de riesgo Alto, y las dos que faltan son de riesgo Alto.

## Criterios de aceptación

- **CA-1** Apagar el seguimiento limpia `ttpArmed` y `ttpPeak`; con ellos ya limpios, apagarlo otra
  vez **no** escribe en `scratch` (`scratchPatch` `undefined`).
- **CA-2** Con el pico en 140 y la marca en 100, apagar y volver a encender **no** produce un
  disparador por encima del mercado: el seguimiento empieza de cero desde el precio de ahora.
- **CA-3** Una condicional a mercado por debajo del mínimo **en su disparador** pero por encima
  **en la marca** pasa la puerta; el stop-loss sigue comportándose igual que antes.
- **CA-4** Con `activationPrice` 80 y el precio en 100, la vista previa pinta la entrada en **80**,
  la cantidad correspondiente y el objetivo en **92**.
- **CA-5** Ninguna estrategia devuelve en `defaults()` una clave que no esté en `meta.fields`.
- **CA-6** *(manual, usuario)* Con el seguimiento armado, comprobar en el venue que conviven la
  condicional del trailing y la del stop-loss, las dos `reduceOnly` y del mismo sentido (F-06).
- **CA-7** `pnpm test` verde, `pnpm lint` limpio, `ng build` sin errores, el worker compila.

## Riesgos

- **R-1 cambia el comportamiento de un interruptor HOT sobre bots que ya existen.** No hay ninguno:
  el seguimiento nace apagado y se mergeó hoy. Y el cambio va en la dirección segura — quita un
  cierre a mercado que nadie pidió.
- **R-2 toca `order-gate`, que gobierna TODAS las órdenes de las nueve estrategias.** El cambio
  amplía el caso en que se mide contra la marca; para el stop-loss, que ya lo hacía, el resultado
  es idéntico. Con test de que las demás no se mueven.

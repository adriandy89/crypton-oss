# 044 — Hallazgos de la revisión de los specs 042 y 043

Commit base: `12a9d9e` · Fecha: 2026-09-11 · Hosts sondeados: ninguno.

## Resumen

| ID | Título | Área | Severidad | Estado |
|---|---|---|---|---|
| F-01 | Apagar y volver a encender el seguimiento resucita un máximo viejo | `trailing-take-profit` | Alta | **corregido en 044** |
| F-02 | La puerta de órdenes mide el trailing en el disparo y no en la marca | `order-gate` | Media | **corregido en 044** |
| F-03 | La vista previa de `TRAILING_PROFIT` ignora el precio de entrada configurado | `trailing-profit` | Media | **corregido en 044** |
| F-04 | `trailingTakeProfit` vive en la configuración sin estar en `meta.fields` | `trailing-profit` | Baja | **corregido en 044** |
| F-05 | Las tablas transversales no conocen las dos estrategias nuevas | `docs` | Baja | **corregido en 044** |
| F-06 | Dos condicionales del mismo sentido sobre la misma posición | motor / venues | Abierto | ver ficha |

## Fichas

### F-01 — Apagar y volver a encender el seguimiento resucita un máximo viejo

- **Síntoma**: `ttpArmed` y `ttpPeak` viven en `cycle.scratch` y solo se borran al cerrarse el
  ciclo. Si el usuario apaga `trailingTakeProfit` —es HOT, se puede en marcha—, el precio cae, y
  vuelve a encenderlo, el mecanismo recupera el máximo anterior como si nada hubiera pasado.
- **Evidencia**: con el pico persistido en 140, retroceso del 10 % y la marca ya en 100, al volver
  a encenderlo `plan()` emite el disparador en **126,00**. Es una venta con disparo a la baja y la
  marca por debajo: **la condición ya es cierta al colocarla**, así que el venue cierra la posición
  entera a mercado a 100 en el acto.
- **Por qué no es Crítica**: no deja la posición sin stop —el `stopLossPct` sigue puesto— ni
  duplica exposición ni tumba el worker. Es un cierre a mercado no pedido, que es grave pero cabe
  en Alta.
- **Lo que NO es un defecto, y conviene no «arreglar»**: el mismo disparador inmediato tras un
  `PAUSE`/`RESUME` o tras un worker caído **sí** es correcto. Allí el seguimiento nunca se apagó y
  la condición de salida se cumplió de verdad; lo único que pasó es que el bot llegó tarde.
- **Arreglo**: cuando el seguimiento está apagado, las dos claves se limpian del `scratch`
  (`limpiarTrailing`). Solo se escribe si había algo que limpiar, para no meter un `UPDATE` por
  tick. Volver a encenderlo empieza a seguir desde el precio de ahora, que es lo que el usuario
  espera al darle al interruptor.
- **Test**: `apagarlo borra el maximo, y volver a encenderlo empieza de cero`.

### F-02 — La puerta de órdenes mide el trailing en el disparo y no en la marca

- **Síntoma**: `revisarOrden` decide medir el mínimo del venue contra la **marca** en lugar de
  contra el precio de la orden con `esStop = order.levelKind === 'STOP_LOSS'`
  ([order-gate.ts:57](../../packages/strategy-core/src/order-gate.ts#L57)). El seguimiento emite un
  `TAKE_PROFIT`, así que se mide contra su **disparador**.
- **Por qué importa**: es literalmente el fallo 001/F-91, que esa línea existe para arreglar. En
  una condicional a mercado, el precio de la orden es *cuándo*, no *a cuánto*: el venue cierra la
  posición que hay al precio que hay.
- **Evidencia**: posición de 0,1 con la marca en 130 —13 USDC— y un retroceso del 10 %: el
  disparador cae en 117, o sea 11,7 USDC. Con un mínimo de 12, `revisarOrden` devuelve
  `RESTO_INCERRABLE` y **la salida no se coloca**, aunque la posición sí cumple el mínimo.
- **Alcance real**: solo muerde con la posición dentro de la banda del retroceso respecto del
  mínimo del venue (con 1 %, entre 10 y 10,1 USDC; con 10 %, hasta 11). Por eso es Media y no
  Alta — y por eso no lo cazó ningún test.
- **En corto es al revés y también está mal**: el disparador queda por ENCIMA de la marca, así que
  la puerta es más permisiva de lo que debe y el rechazo lo pone el venue.
- **Arreglo**: la regla pasa a ser la que decía el comentario desde el principio —«lo que el venue
  cierra es la posición que hay, al precio que hay»— y se aplica a **toda condicional a mercado**:
  `order.type === 'MARKET' && order.triggerPrice != null`. Cubre el stop-loss de siempre, el take
  profit a mercado de Martingala y el seguimiento.
- **Tests**: `un take profit CONDICIONAL tambien se mide en la marca` y su contrario,
  `un take profit LIMIT sigue midiendose en su propio precio` — ahí el precio de la orden SÍ es el
  de ejecución, y medirlo en la marca sería mentir en la dirección contraria.
- **Cómo se aplicó**: la regla se **amplía**, no se sustituye. El `levelKind === 'STOP_LOSS'`
  sigue entrando por su nombre además de por su forma, porque un stop emitido sin disparador es
  igualmente una orden a mercado que cierra la posición. Un test que ya existía lo comprobaba y
  falló al cambiarlo: nunca se estrecha una regla de seguridad para ampliarla.

### F-03 — La vista previa de `TRAILING_PROFIT` ignora el precio de entrada configurado

- **Síntoma**: `preview()` dimensiona y calcula el objetivo sobre `refPrice` —el precio de hoy—
  aunque el bot tenga `activationMode` con un `activationPrice`, que es donde va a entrar de
  verdad.
- **Evidencia**: con el precio en 100, entrada condicionada a 80 y objetivo del 15 %, la vista
  previa pinta **entrada 100, cantidad 10, objetivo 115**. Lo que hará el bot es entrar en 80 con
  **12,5** y empezar a seguir en **92**. Los cuatro números están mal, incluida la liquidación.
- **Por qué importa**: es la pantalla en la que el usuario decide comprometer dinero, y el
  principio de la casa es que la vista previa es literalmente lo que se va a mandar. Es la misma
  familia que 041/F-05.
- **Arreglo**: cuando hay condición de entrada, el nivel se dimensiona y se calcula sobre el
  `activationPrice`. El `refPrice` se sigue pasando a `buildPreview` como referencia de mercado, así
  que «distancia al precio actual» y «distancia a liquidación» siguen midiéndose contra hoy. Y el
  aviso lo dice.
- **Test**: `la vista previa se calcula sobre el precio de ENTRADA, no sobre el de hoy`.

### F-04 — `trailingTakeProfit` vive en la configuración sin estar en `meta.fields`

- **Síntoma**: `TRAILING_PROFIT` mete `trailingTakeProfit: true` en `defaults()` pero **no** declara
  el campo en su `meta.fields` (a propósito: el seguimiento no se puede apagar ahí). Nadie lo lee:
  `plan()` llama al mecanismo siempre y `validate()` lo fuerza con `conSeguimiento()`.
- **Por qué importa**: `diffConfig` trata como **COLD** todo campo que la estrategia no declara
  ([mutability.ts:76](../../packages/strategy-core/src/mutability.ts#L76)), que es la opción
  conservadora y correcta. Un cliente que reconstruyera la configuración desde `meta.fields` —que
  es lo que la app hace al crear— mandaría el campo ausente, `diffConfig` lo vería cambiar de
  `true` a `undefined` y **rechazaría la edición entera** de un bot en marcha por un campo que el
  usuario no puede ni ver.
- **Por qué es Baja y no más**: hoy no pasa. La pantalla de edición parte de
  `draft.set({ ...detail.config })`, la copia entera de lo guardado, así que la clave viaja de
  vuelta intacta. Es una trampa cargada, no un fallo.
- **Arreglo**: quitarla. Ni de `defaults()` ni de lo que devuelve el asesor. La estrategia ya se
  comporta como si estuviera siempre encendida sin necesidad de la clave.
- **Test**: `defaults() no devuelve ningun campo que meta.fields no declare`, escrito para
  **todas** las estrategias: así la próxima no repite la trampa.
- **Lo que el test genérico destapó de paso**: **GridMart lleva la misma trampa desde el spec 026**,
  con `takeProfitPct` y `tpMode`. Allí no se puede quitar —la validación compartida de la escalera
  los exige— ni se puede declarar —no gobiernan ninguna orden y el 026 los sacó del formulario por
  eso—. Es el único caso legítimo, así que va al test como excepción **con su motivo escrito**, y no
  se toca: cualquiera de las dos salidas rompería algo que funciona.

### F-05 — Las tablas transversales no conocen las dos estrategias nuevas

- **Síntoma**: el peor caso por estrategia de
  [`riesgo-y-liquidacion.md` §8](../../docs/riesgo-y-liquidacion.md), el «no lo uses si…» de
  [`buenas-practicas.md`](../../docs/buenas-practicas.md) y la tabla de
  [`README.md`](../../README.md) enumeran a mano y se quedaron en siete: les falta **Tendencia**
  (del spec 040) y **Seguimiento de beneficio** (del 043).
- **Por qué importa**: el peor caso y el «cuándo no usarlo» son justo las dos tablas que alguien
  consulta **antes** de encender un bot de riesgo Alto. Que falten las dos de riesgo Alto más
  recientes es lo peor que podía faltar.
- **Arreglo**: las tres tablas al día, con el peor caso de cada una calculado como las demás.

### F-06 — Dos condicionales del mismo sentido sobre la misma posición (abierto)

- **Qué es**: con el seguimiento armado, el bot tiene a la vez el `TAKE_PROFIT` del trailing
  —venta con disparo **a la baja** en, digamos, 128,70— y el `STOP_LOSS` del motor —venta con
  disparo **a la baja** en 95—. Las dos `reduceOnly`, las dos por la posición entera.
- **Por qué se anota**: es la primera vez que ocurre. Hasta ahora las parejas eran de sentidos
  opuestos (el take profit de Martingala dispara al alza) y la estrategia de tendencia emite **un
  solo** stop, porque `withStopLoss` se calla al ver el suyo.
- **Lo que se sabe**: los tres venues aceptan varias condicionales reduce-only sobre una posición,
  y `reduceOnly` impide que la segunda abra nada. El simulador las trata bien, y los tests de
  integración del worker lo recorren entero.
- **Lo que NO se sabe**: cómo se comporta cada venue real cuando **las dos** se cumplen en el mismo
  movimiento —un desplome que cruce 128,70 y 95 en el mismo tick—. Lo esperable es que la primera
  cierre y la segunda quede como reduce-only sin posición, que cada venue cancela o rechaza sin
  consecuencias.
- **Decisión**: no se toca. Va a la comprobación manual del usuario (CA-6), que es la única forma
  honesta de cerrarlo: sondear un venue con credenciales está fuera de lo que este agente hace.

## Verificado OK

Lo que se revisó en esta pasada y está bien:

- **Los requisitos de los dos specs, uno a uno, contra el código.** Los nueve del 042 y los ocho del
  043 están implementados. Es la comprobación que el 041 enseñó a hacer: ningún test genérico caza
  un requisito que nadie escribió.
- **El armado irreversible** (042 R-4) y **el máximo que nunca retrocede** (R-5), incluido el caso
  de bajar el umbral de reprecio en caliente: el disparador no se mueve en contra ni con eso.
- **Ampliar el retroceso en caliente no ensancha el disparador ya puesto**, y es correcto: moverlo
  hacia abajo sería devolver más de lo ya asegurado. Se recupera solo en cuanto el máximo sube.
- **El redondeo del disparador es conservador en los dos sentidos**: `px(..., 'SELL')` redondea
  arriba y acerca la venta al mercado; `px(..., 'BUY')` redondea abajo y acerca la compra. En los
  dos casos dispara **antes**.
- **La escalera de Martingala y el seguimiento no se pelean**: las seguridades cuelgan por debajo de
  la entrada y el disparador vive por encima, así que el precio cruza el disparador primero y el
  ciclo se cierra antes de que ninguna seguridad pueda llenarse.
- **El `scratch` se limpia solo al cerrar el ciclo** (`cycle-accounting.ts:232` lo reconstruye
  entero), así que el máximo de una operación no contamina la siguiente.
- **La marca de agua se vacía en el tick y solo ahí.** Se comprobó que `buildContext` se usa también
  al recibir una ejecución y en `ADD_SAFETY_NOW`: vaciarla allí se comería el pico justo cuando más
  se mueve el precio.
- **Un precio no positivo no entra en la marca de agua**, así que no puede nacer un disparador en
  cero.
- **La entrada a mercado de `TRAILING_PROFIT` no se duplica**: sin `reusesOrderSlots`, la fila
  `FILLED` veta la recolocación durante el resto del ciclo.
- **La espera entre ciclos se comprueba ANTES que la condición de entrada**, y es lo correcto: un
  precio que cruza durante la espera y rebota no debe hacer entrar al bot después, mucho más arriba.
- **El asesor devuelve configuraciones válidas** para los tres perfiles de la estrategia nueva, y
  los tres se distinguen.
- **`diffConfig` no rechaza hoy la edición de un bot de seguimiento**: la pantalla parte de la copia
  entera de la configuración guardada. Ver F-04 para por qué aun así se quita la clave.

## Preguntas abiertas

- **F-06**, arriba: comprobación manual en un venue real.
- Sigue pendiente **F-01 del spec 037** (la V2 cobra el coste de ida y vuelta dos veces), que
  necesita decisión del usuario porque estrecha el diferencial de los bots en marcha.

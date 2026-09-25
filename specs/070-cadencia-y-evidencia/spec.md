# Spec 070 — Que el modelo evalúe más, y con mejor evidencia

> **Retirado por el [spec 072](../072-retirar-bot-de-ia/spec.md) (2026-09-24).** El código de este
> spec ya no existe. Las mediciones siguen valiendo —el modelo no discriminaba, y un minuto es
> aritméticamente imposible— y por eso se conserva.

**Tipo**: cambio · **Rama**: `spec/070-cadencia-y-evidencia` · **Depende de**: 069

## De dónde sale

El proveedor cuesta **0,000081 $ por llamada** y contesta en 256 ms. Los topes que puso el 069
—48 llamadas al día por bot, 400 en la plataforma— están calibrados para un modelo trescientas
veces más caro. La pregunta del usuario fue directa: si es casi gratis, que evalúe todo lo que
pueda, y ¿no sería mejor operar en velas de 1 o 5 minutos?

Se midió antes de tocar nada. **1.297 llamadas reales a Jev sobre BTC, cero fallos, 0,10 $ en
total**, más dos baterías de cadencia sobre 12 pares × 207 días y 30 días de velas de 1 minuto
descargadas para esto.

## Lo que se midió

### 1. El presupuesto nunca fue el cuello de botella

Sobre BTC con costes reales, el detector encuentra **22 toques al día** y la puerta de
`minTargetCostMultiple` deja pasar **0,42**. El tope de 48 no se rozó ni una vez en ninguna
prueba. Subirlo es correcto —está calibrado para otro modelo— pero **no cambia nada hoy**.

### 2. Un minuto es aritméticamente imposible

BTC, 30 días, costes reales (taker 3,5 bps + 2 de deslizamiento):

| cadencia | toques/día | **evaluaciones/día** | pasa la puerta |
|---|---|---|---|
| **1 min** | 292,7 | **0,00** | **0,0 %** |
| 5 min | 57,7 | 0,38 | 0,7 % |
| **15 min** | 20,0 | **0,71** | 3,5 % |
| 30 min | 11,2 | 0,34 | 3,0 % |
| 60 min | 6,2 | 0,46 | 7,4 % |

A 1 minuto hay 8.719 toques y **ni uno ejecutable**: `COSTE` mata 73.509 celdas. Y no es culpa de
las comisiones — sin comisión ninguna, 15 min sigue ganando (3,69/día contra 2,90 a 5 min y 1,81 a
1 min).

**Es física, no configuración.** El coste de ida y vuelta es **fijo en precio**; el recorrido
disponible encoge con la raíz del tiempo. A 1 minuto la banda es tan estrecha que comisiones,
horquilla y deslizamiento se comen más del `maxCostPerTradeR` en todas las celdas, siempre.

Con **cero comisión y sobre 12 pares** el orden se invierte (16,10 evaluaciones/día a 5 min contra
10,31 a 15 min): los alts tienen recorrido relativo mucho mayor que BTC. Por eso la cadencia pasa a
ser **un campo del usuario** y no una constante — pero su defecto sigue siendo 15 min, que es lo
medido como mejor en el caso difícil.

### 3. El modelo no discrimina, y se sabe por qué

Con costes reales y la puerta abierta a 8x —trece veces más candidatos—, 498 llamadas reales:

| | ops | R medio | t |
|---|---|---|---|
| lo que **tomó** | 278 | −0,219 | −3,87 |
| lo que **rechazó** | 220 | −0,205 | −3,43 |

Lo que rechazó era ligeramente mejor. Correlacionando los rasgos de cada toque con su decisión y
con su resultado, sobre los 498 puntos:

| rasgo | corr con su DECISIÓN | corr con el RESULTADO |
|---|---|---|
| `contencion` | **+0,437** | +0,117 |
| `adx` | **−0,353** | −0,043 |
| `chop` | **+0,306** | +0,079 |
| `estiramiento` | +0,031 | **−0,122** |

El modelo decide por **régimen** —contención, ADX, lateralidad—, que es lo que haría cualquier
operador sensato y lo que casi no predice. E **ignora el estiramiento**, que es el predictor más
fuerte que hay y que va en dirección **contraintuitiva**: cuanto más estirado el toque, peor sale.

Y hay un defecto propio del 069 en medio: el criterio de `WAIT_FOR_A_BETTER_TOUCH` decía
literalmente *«not stretched enough to be worth acting on»*. Le estábamos enseñando que poco
estiramiento es motivo para esperar, cuando lo medido dice lo contrario.

## Lo que se hace

1. **Los topes suben**: 48 → 300 por bot (el máximo teórico a 5 min son 288) y 400 → 5.000 global.
2. **La cadencia es un campo del usuario**: `5m`, `15m` (defecto), `30m`, `1h`. **1 minuto no se
   ofrece**, y la guía dice por qué con el número: ofrecer un ajuste que da cero operaciones
   medidas es una trampa, y además triplicaría la carga de datos de mercado a cambio de nada.
3. **La pregunta de esperar deja de insinuar** que poco estiramiento es motivo para esperar.
4. **Las tasas base se condicionan al estiramiento**: además del histórico global de toques
   comparables, el estado lleva el de los que tuvieron un **estiramiento parecido al de ahora**.
   Es la manera honesta de arreglar el punto 3: no se le dice al modelo lo que hemos medido —eso
   sería meterle nuestro prior—, se le da la **evidencia** para que lo descubra él.

## Lo que NO se hace

- **No se afloja `minTargetCostMultiple`.** Multiplicaría las evaluaciones por trece y todas son
  de esperanza negativa: el propio motor con la puerta a 8x da R −0,0004 sobre 190 días de BTC.
- **No se quita el enfriado de `ENTORNO_EQUIVOCADO`.** Nació para ahorrar dinero y el dinero ya no
  es la razón, pero resulta que esa pata **sí tiene señal**: sus 51 casos dan R −0,552, muy por
  debajo de la media. Es un filtro de calidad, no solo de coste.

## Criterios de aceptación

| id | Criterio | Listón |
|---|---|---|
| CA-1 | La cadencia se puede cambiar y el motor pide, mira y fecha con el intervalo elegido | verde |
| CA-2 | Los topes nuevos no permiten gastar más de lo que la cadencia puede generar | verde |
| CA-3 | Las tasas condicionadas salen en el estado, y nunca con muestra insuficiente | verde |
| CA-4 | Batería completa, `worker`, `backtest`, typecheck de la app, `lint`, `check:env` | verde |
| CA-5 | **Medido**: la discriminación del modelo con la evidencia nueva, contra los −0,014 de hoy | se reporta salga lo que salga |

## CA-5: lo que salió al volver a medir

Se repitió el mismo experimento —BTC, 15 min, 90 días, costes reales, puerta a 8x— con la
evidencia condicionada y la pregunta corregida. 498 llamadas reales más, cero fallos.

| | TOMAR | R tomadas | R rechazadas | discriminación |
|---|---|---|---|---|
| antes (069) | 278 | −0,219 | −0,205 | **−0,014** |
| después (070) | **166** | −0,247 | −0,192 | **−0,055** |

**La evidencia nueva sí cambia su conducta**: pasa de rechazar el 44 % de los toques a rechazar el
67 %. La está leyendo. Pero **la cautela extra no está informada**: lo que sigue tomando no es
mejor que lo que descarta, y la diferencia empeora en lugar de mejorar.

Dos mediciones independientes, 996 llamadas reales en total, misma conclusión: **en este montaje el
modelo no aporta valor de selección.**

Lo que sí aguanta las dos tandas es `ENTORNO_EQUIVOCADO`: R **−0,552** en la primera y **−0,606**
en la segunda, contra medias de −0,219 y −0,247. Esa pata identifica lo peor de forma consistente.
Usando el modelo **solo como veto** —todo entra salvo lo que él marca como entorno equivocado— el R
de la población pasa de −0,210 a −0,181. Es una mejora real y sigue siendo negativa: no salva la
estrategia, la hace menos mala.

**Conclusión operativa**: el bot no debe operar en modo IA con dinero real. El modo se queda
disponible, arrancando apagado tres veces, para poder seguir midiéndolo en sombra.

## La advertencia que no se borra

Nada de esto convierte al bot en rentable. El montaje pierde de base: con la puerta a 8x el motor
da R −0,0004 sobre 190 días de BTC, y con la puerta a 25x opera 0,42 veces al día. Lo que este
spec hace es **quitar los topes que no tenían sentido y darle al modelo mejor evidencia**, para que
la próxima medición diga algo distinto de «no discrimina». Si sigue sin discriminar, la conclusión
será que este montaje no es para un modelo.

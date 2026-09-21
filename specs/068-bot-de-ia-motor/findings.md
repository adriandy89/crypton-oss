# 068 — Lo que salió al medir

Walk-forward con `runReplay` sobre **12 pares × 190 días** de velas de 5 min de la API pública de
Aster, con el **juez de reglas** (el modelo no se consulta en el backtest, y eso lo dice el propio
motor).

## M-0 — El agujero que casi cierra el spec con un resultado falso

La primera medición dio **cero operaciones** con un PnL de **−290 y +124**. Cero operaciones no
puede mover el PnL, y esa incoherencia fue lo único que lo delató.

Causa: `planGuardado()` en `packages/backtest/src/engine.ts` exigía `setup`, que solo tiene el plan
del canal. El replay ejecutaba las entradas del «Bot de IA», colocaba los stops y movía el
resultado, pero **no registraba ni una operación**.

Es la peor clase de fallo que hay en este repo: **no parece un agujero, parece un resultado**. Sin
mirar la incoherencia, el spec se habría cerrado por su criterio de parada concluyendo que el motor
no opera nunca. Corregido, con un test que lo fija, y `esPlanCanal` unificada para que no haya dos
criterios distintos para la misma pregunta.

## M-1 — El venue manda, y al revés de lo que todos suponíamos

Con el defecto de fábrica (`minTargetCostMultiple` = 25):

| | Operaciones | Al mes y par | R medio | t | Acierto | Ventanas + |
|---|---|---|---|---|---|---|
| Lighter (sin comisión) | 545 | 7,17 | **−0,107** | −1,82 | 35 % | 2/6 |
| Hyperliquid (con comisión) | 36 | 0,47 | **+0,691** | **+2,80** | 58 % | 3/6 |

El bot va **mejor en el venue caro**. Y tiene explicación: **la puerta del coste no solo evita la
imposibilidad aritmética, está filtrando calidad**. Con comisiones altas casi ningún toque la pasa,
y lo que pasa es muy bueno; con comisiones cero deja pasar cualquier cosa.

Esto obligó a corregir el aviso de `validate()` y las dos guías, que decían lo contrario por
herencia del canal y sin haber medido este motor. **Un aviso heredado que nadie vuelve a medir es
peor que no tener aviso**: manda a la gente al venue equivocado con cara de dato.

## M-2 — El gradiente, que confirma el mecanismo

Apretando la puerta en Lighter hasta igualar la selectividad que Hyperliquid consigue gratis:

| Objetivo mínimo | Operaciones | Al mes y par | R medio | t | Acierto | Ventanas + |
|---|---|---|---|---|---|---|
| 25 (el defecto) | 545 | 7,17 | −0,107 | −1,82 | 35 % | 2/6 |
| 40 | 262 | 3,45 | −0,054 | −0,59 | 35 % | 3/6 |
| 60 | 92 | 1,21 | +0,391 | 1,80 | 42 % | **5/6** |
| **80** | 39 | 0,51 | **+1,356** | **+2,46** | 56 % | **5/6** |

**Monótono en el R, en el acierto y en la estabilidad por ventanas.** Eso no es un ganador de
casualidad en un barrido: es un mecanismo.

Y la coincidencia que lo cierra: **80 × 4 bps (Lighter) = 320 puntos básicos, y 25 × 13 bps
(Hyperliquid) = 325**. Es la **misma distancia absoluta**. Las dos columnas de M-1 y la fila de 80×
de M-2 están describiendo el mismo punto desde dos sitios.

## M-3 — El veredicto de los criterios de aceptación

| | CA-4 (≥ 2 ops/mes/par) | CA-5 (R > 0 con t > 2) | CA-6 (≥ 4/6 ventanas) |
|---|---|---|---|
| Lighter, 25× | ✅ 7,17 | ❌ −0,107 | ❌ 2/6 |
| Lighter, 60× | ❌ 1,21 | ❌ t 1,80 | ✅ 5/6 |
| **Lighter, 80×** | ❌ 0,51 | ✅ **t 2,46** | ✅ **5/6** |
| **Hyperliquid, 25×** | ❌ 0,47 | ✅ **t 2,80** | ❌ 3/6 |

**Ninguna configuración cumple las tres.** La mejor cumple dos: R medio **+1,356** con **t = 2,46** y
**cinco de seis ventanas positivas**, pero con **0,51 operaciones al mes y par** contra las 2 que
pedía CA-4.

Es, con diferencia, el mejor resultado de toda esta línea de trabajo —el canal con IA se quedó en
+0,205 con t = 0,90 tras dos specs— pero **no cumple lo que este spec se puso a sí mismo**, y eso
es lo que cuenta.

## Qué se hace con esto

**El spec se cierra sin desplegar con dinero real.** La estrategia se mezcla a `main` porque es
segura por construcción —solo administradores, `decisionMode` en `REGLAS` y `observeOnly` en `true`,
así que un bot recién creado no manda una orden hasta que su dueño lo diga dos veces— pero **no se
sube su defecto a 80 ni se declara buena**.

No se sube el defecto por la razón que el spec 066 ya dejó escrita: elegir el valor que ganó un
barrido es ajustar el mando a la muestra. Aquí el gradiente es monótono, que es mucho mejor
evidencia que un ganador suelto, pero **39 operaciones siguen siendo 39 operaciones**.

### Lo que este spec deja apuntado para el siguiente

**`minTargetCostMultiple` mide lo que no es.** La coincidencia de los 320 puntos básicos dice que lo
que de verdad selecciona no es el objetivo *en veces el coste*, sino la **distancia absoluta al
objetivo**. Un múltiplo del coste hace que el mismo número signifique cosas distintas en dos venues
—que es exactamente el lío de M-1— y obliga al usuario a saber de comisiones para poner un mando.

Un campo que midiera la distancia del objetivo en **ATR** o en **% del precio** valdría igual en
todos los venues y sería entendible sin una tabla de comisiones delante. Eso es un spec de cambio, y
hay que medirlo antes de creérselo.


## M-4 — La revisión del propio spec, y los seis agujeros que encontró

Leyendo la estrategia con calma después de escribirla deprisa. **Ninguno lo habría cazado la
batería que había**, que es el dato que importa: 8.249 tests en verde y seis fallos dentro.

| # | Qué | Gravedad |
|---|---|---|
| 1 | El **ATR de 1 h estaba inventado** («el de 15 min por dos») y entraba en `apalancamientoPorStop`, o sea en la regla que decide cuánta palanca permite la distancia a la liquidación | **Grave** |
| 2 | El **cierre a mercado usaba un identificador fijo**: un llenado parcial deja su fila ejecutada, esa fila veta el reintento, y la posición se queda abierta | **Grave** |
| 3 | **No se comprobaba que las velas estuvieran cerradas** | Real |
| 4 | **Cuatro mandos no hacían nada**: `invalidationAtr`, `maxDrawdownPct`, `dailyProfitTargetPct`, `maxSpreadFraction` | Real |
| 5 | **En modo reglas no se registraba nada** en el histórico | Real |
| 6 | El **modo IA escribía solicitudes que nadie atiende** y el bot se quedaba mirando en silencio | Real |

Los dos graves comparten una causa: **el ciclo de vida de la posición se escribió mucho más rápido
que el motor de decisión**, y se notó. El motor —la matriz, las puertas, la cuantización— tenía 43
tests propios y estaba bien; lo que rodea a la posición no tenía ninguno.

Lo que se hizo con cada uno:

1. El ATR horario **se mide**, y si no se puede medir cae al de 15 min, que es **menor**: la regla de
   liquidación pide entonces más distancia, no menos. Equivocarse hacia el lado prudente.
2. El índice del identificador **sube en cada intento**, con tope de doce y treinta segundos entre
   ellos. Y mientras se intenta cerrar, **el stop no se retira**: es justo cuando más falta hace.
3. `serieFresca` en los tres intervalos antes de mirar nada.
4. Los cuatro cableados. La caída máxima **pausa el bot** —es de lo que no se cura solo—; el objetivo
   del día y el spread son puertas del plan.
5. Emite su marca de decisión, y en «solo observar» guarda el plan entero: es la constancia de lo
   que habría hecho, que es para lo que sirve ese modo.
6. `validate()` **rechaza el modo IA** hasta que haya proveedor. Un mando que se puede poner y no
   hace nada es peor que un mando que no está.

Doce tests nuevos, uno por agujero y varios por el cierre, que es donde más se podía perder dinero.

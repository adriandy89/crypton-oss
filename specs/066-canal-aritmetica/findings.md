# 066 — Lo que salió al medir

Todo lo de aquí está medido con el motor de backtest de la plataforma (`runReplay`, el mismo que usa
la app) sobre **12 pares × 190 días** de velas de 5 min de la API pública de Aster (14 mar → 20 sep
2026, 2.279 días-par), con el juez de reglas en vez de la IA.

## M-1 — Ninguna puerta de detección es el cuello de botella

R-5 pedía instrumentar los motivos de rechazo de `detectarCanal` antes de aflojar nada. Hecho, sobre
27.360 ticks reales, contando además el **coste marginal** de cada puerta: cuántos ticks se
desbloquearían si esa puerta, y solo esa, no existiera.

| Puerta | Ticks que rechaza | Ticks que desbloquearía quitarla |
|---|---|---|
| `CONTENCION` | 24.973 | **53** |
| `ANCHURA_ATR` | 19.579 | 14 |
| `TOQUES` | 18.006 | 14 |
| `R2` | 19.388 | 0 |
| `ALTERNANCIA` | 16.387 | 0 |
| `DURACION` | 10.293 | 0 |

La lectura es inequívoca y va en contra de lo que parecía el titular: los ticks que fallan **fallan
por dos o tres criterios independientes a la vez** (las parejas más frecuentes son
`ANCHURA_ATR+CONTENCION`: 513 y `CONTENCION+R2`: 189). No hay una puerta severa de más; es que
**1.022 de 27.360 ticks (3,7 %) tienen algo parecido a un canal**, y eso es un hecho sobre el
mercado, no sobre el detector.

**Decisión: no se afloja ninguna.** Aflojar `CONTENCION` entera compraría 53 ticks a cambio de
llamar canal a cualquier cosa.

## M-2 — El venue decide si la aritmética cierra

El mismo recorrido de puertas, cambiando solo el perfil de costes:

| | Hyperliquid / Aster (taker 4,5 bps) | Lighter (0 bps, 2 de deslizamiento) |
|---|---|---|
| Canales detectados | 576 | **1.022** |
| Candidatos | 67 | 135 |
| **Ofertas** | **0** | **18** |
| `ANCHURA_COSTE` rechaza | 23.099 | 4.901 |
| Motivo dominante de los stops | `COSTE`: 106 | `OBJETIVO_CORTO`: 263 |

Con las puertas del spec y costes de Hyperliquid, el walk-forward completo da **cero operaciones**
en 2.279 días-par. No es un fallo de las puertas: es que a 4,5 bps de taker un canal de 15 minutos
en estos pares no paga lo que cuesta entrar y salir de él. Las puertas hacen exactamente lo que
tienen que hacer, que es no operar ahí.

## M-3 — El veredicto de CA-6: el spec no lo cumple

Walk-forward completo con las puertas del spec, barriendo `minTargetCostMultiple` y con el perfil
de costes **más favorable** que existe (Lighter: 0 bps de comisión, 2 de deslizamiento):

| Objetivo mínimo | Operaciones | Al mes y par | R medio | t | Ventanas + | Pares + | PnL |
|---|---|---|---|---|---|---|---|
| 4× | 35 | 0,46 | +0,026 | 0,10 | 2/6 | 4/12 | −24,54 |
| **6×** | 32 | 0,42 | **+0,114** | 0,39 | 2/6 | 4/12 | **+2,70** |
| 8× | 28 | 0,37 | +0,023 | 0,07 | 1/6 | 3/12 | −24,71 |
| 10× | 23 | 0,30 | −0,044 | −0,13 | 1/6 | 3/12 | −32,17 |
| **15× (el defecto)** | 9 | 0,12 | +0,008 | 0,01 | 2/6 | 2/12 | −7,68 |

CA-6 pedía tres cosas a la vez: **≥ 2 operaciones al mes y par**, **R medio positivo con t > 2** y
**≥ 4 de 6 ventanas positivas**. El mejor caso de toda la tabla da 0,46 operaciones al mes y par,
t = 0,39 y 2 ventanas de 6. **No cumple ninguna de las tres.**

Y no hay relación monótona entre la exigencia y el resultado —4× sube, 6× sube más, 8× baja, 10× se
hace negativo, 15× vuelve a subir—, que es la firma de estar mirando ruido. Con 9 a 35 operaciones
repartidas en 12 pares y 6 ventanas, ninguna de estas celdas distingue una ventaja de la suerte.

**Se dispara el criterio de parada escrito en `spec.md`.** El spec se cierra **sin desplegar**.

## Qué se queda, y por qué

Las dos puertas **se quedan**, aunque el spec no cumpla su criterio, y esto no es una contradicción:

- Lo que hacían las 12 operaciones de la línea base era **perder** (R medio −0,578, 75 % en stop,
  ningún objetivo alcanzado). Las puertas quitan esas operaciones. Quitar una pérdida segura es una
  mejora aunque no traiga una ganancia, y era exactamente lo que `spec.md` prometía: «las puertas de
  coste quitan una pérdida segura; no fabrican una ganancia».
- Son **campos de usuario** con su defecto, no constantes escondidas: quien quiera el comportamiento
  de antes lo tiene a un clic.
- El defecto se queda en **15**, no en el 6 que ganó la tabla. Elegir 6 porque sacó el mejor R en un
  barrido de nivel de ruido es sobreajustar a ocho meses de un mercado. El 15 tiene detrás un
  argumento aritmético —un objetivo que no cubre quince veces lo que cuesta entrar y salir no
  compensa el riesgo de cola— y ese argumento no depende de esta muestra.

## Lo que esto deja dicho sobre `AI_CHANNEL`

Juntando M-1, M-2 y M-3, el problema no está en ninguna puerta ni en ningún parámetro:

1. El mercado está en un canal como `detectarCanal` lo define el **3,7 % del tiempo**, y aflojar sus
   puertas no lo cambia (M-1).
2. De esos canales, la geometría de la operación solo paga en un venue sin comisión (M-2).
3. Y aun ahí, lo que queda son 9 a 35 operaciones en 2.279 días-par con R indistinguible de cero.

La conclusión honesta es que **la reversión en canal a 15 minutos, tal y como la detecta este bot,
no tiene una ventaja que explotar en este mercado.** No es que esté mal afinada: es que casi nunca
hay canal, y cuando lo hay el recorrido no paga el viaje.

Lo que sí midió ventaja en esta misma sesión y sobre estos mismos datos fue algo más simple: el
toque de **banda de Bollinger** con el objetivo exigido en múltiplos del coste, en un venue sin
comisión —n = 1.804, R medio +0,060, **t = 2,12**, 5 de 8 meses positivos—, que aparece unas
doscientas veces más a menudo que un canal. Eso no es este spec: es el siguiente.

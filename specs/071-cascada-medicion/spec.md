# Spec 071 — ¿Sabe el modelo distinguir una cascada de una repreciación?

**Tipo**: medición · **Rama**: `spec/071-cascada-medicion` · **Depende de**: 069, 070
**Resultado**: ⛔ **NEGATIVO** — el edge no sobrevive a 400 días. No se construye el 072.

> **La primera parte se retiró con el [spec 072](../072-retirar-bot-de-ia/spec.md) (2026-09-24)**,
> que usó el número que esta dejaba libre para quitar el «Bot de IA» y TypeSafe: el detector de
> cascadas (`trader/cascada.ts`) y la primitiva `score` ya no existen. La segunda —la revisión del
> Market Maker V2— sigue vigente entera.

> **Este spec no construye una estrategia.** No toca el motor, ni la configuración, ni Prisma, ni
> añade un `StrategyKind`. Produce un número y una decisión. La estrategia es el spec 072, y solo se
> escribe si este pasa.

## De dónde sale

El «Bot de IA» pierde (R −0,21, t −3,9) y el modelo no discrimina: medido dos veces, 996 llamadas
reales, lo que toma es igual de malo que lo que rechaza. Antes de rehacerlo se buscaron estrategias
con evidencia profesional y se midieron las que el repositorio puede ejecutar.

**Lo único que pasó el listón** fue desvanecer cascadas de liquidación. Sobre 12 pares × 210 días,
comprar tras una caída >3 % en 60 min y salir a 4 h da **+0,573 % neto de costes, t 4,66, 12 de 12
pares positivos**. Aguantó las tres pruebas que suelen tumbar esto:

1. **No es beta alcista**: sobre los cuatro pares que perdieron en el periodo da +0,635 %, t 3,56, 4/4.
2. **Es asimétrico en la dirección que el mecanismo predice**: vender euforia no funciona (t 1,20).
   Los largos apalancados son el lado abarrotado, así que sus liquidaciones cascadean y las de los
   cortos no.
3. **Sobrevive a la corrección por racimos**: 368 eventos en 135 racimos independientes → t ≈ 2,82.

Y una restricción que manda sobre la implementación: **el edge muere entre 10 y 25 bps de
deslizamiento por lado**. Con orden a mercado no existe.

## ⛔ RESULTADO DE LA FASE 0: el edge era un artefacto de la ventana

**Se para aquí.** Al ampliar de 210 a 400 días y de 12 a 26 pares —2.947 eventos contra 356— el
edge desaparece:

| muestra | eventos | retorno medio | t |
|---|---|---|---|
| 210 días, 12 pares (la que motivó este spec) | 356 | **+0,573 %** | **4,66** |
| **400 días, 26 pares** | **2.947** | **−0,016 %** | **−0,26** |

Y por meses, **7 positivos de 14**. Una moneda al aire. El patrón es limpio y parte la muestra en dos:

| periodo | comportamiento |
|---|---|
| 2025-08 → 2026-02 | oct −1,01 %, dic −1,27 %, ene −0,81 %: **consistentemente negativo** |
| 2026-03 → 2026-09 | jun +0,76 %, jul +0,89 %, sep +0,70 %: consistentemente positivo |

**El fichero de 210 días empezaba en 2026-02-22**, o sea que cubría exactamente —y solo— el régimen
favorable. Las tres pruebas que «aguantó» (no es beta alcista, es asimétrico, sobrevive a los
racimos) se corrieron todas **dentro** de ese régimen, así que ninguna podía detectarlo. La prueba
que faltaba era la más simple: **mirar más atrás**.

No es beta de mercado puro —la correlación del edge mensual con BTC es 0,272, y junio de 2026 fue el
segundo mejor mes con BTC cayendo un 20,6 %— pero sí depende del régimen:

- meses con BTC al alza (6): edge medio **+0,509 %**
- meses con BTC a la baja (8): edge medio **−0,294 %**

### Lo que esto significa para el programa

- **No se construye el spec 072.** Comprar cascadas no tiene ventaja estructural medible.
- **No se busca el filtro que lo arregle.** Encontrar ahora la condición que separa los meses buenos
  de los malos, sabiendo ya cuáles son cuáles, es la definición de sobreajuste. Si alguna vez se
  intenta, tiene que ser con una regla fijada antes y validada en datos que nadie haya visto.
- **Lo que sí se queda**: el detector, sus rasgos y sus tests, que son código honesto y medido; la
  primitiva `score`; el arnés; y sobre todo **este resultado escrito**, para que nadie vuelva a
  medir siete meses de cripto y lo llame una ventaja.

### La lección, que es la más cara de esta sesión

Un dataset heredado de una medición anterior **no es una muestra, es una conveniencia**. Los 210
días estaban ahí porque se habían descargado para otra cosa, y esa comodidad decidió el resultado.
La primera pregunta ante cualquier ventaja nueva es **de dónde salen los datos y qué hay justo antes
de donde empiezan**.

## El stop: medido, y define el diseño

Todo lo anterior mide salida fija a 4 h **sin stop**. Un bot real necesita uno, y sobre un cuchillo
cayendo se toca mucho. Medido en **R** —resultado por unidad de riesgo, que es lo que la plataforma
dimensiona—, sobre los mismos 356 eventos:

| stop | R medio | t | % que toca | distancia |
|---|---|---|---|---|
| 2× ATR | +0,209 | 2,47 | 49 % | 1,35 % |
| 3× ATR | +0,196 | 3,14 | 34 % | 2,03 % |
| 5× ATR | +0,152 | 3,69 | 16 % | 3,38 % |
| **justo bajo el mínimo de la cascada** | **+0,426** | 2,31 | 73 % | **0,54 %** |
| mínimo + 0,4 ATR | +0,368 | 2,43 | 69 % | 0,67 % |

**El stop estructural gana por el doble**, y no por acertar más —salta el 73 % de las veces— sino
porque está cerca: el denominador del riesgo es pequeño y la posición que cabe es grande.

Encaja con el mecanismo: se apuesta a que **ese mínimo aguanta**. Si no aguanta, la premisa era
falsa y se sale barato. Un stop ancho no compra información, solo paga más por descubrir lo mismo.

**Lo que esto obliga a decir en la guía**: 73 % de operaciones perdiendo ~1R y 27 % ganando mucho.
Es un perfil de varianza alta y nadie debe encontrárselo por sorpresa.

Y en bruto —sin stop y con salida a 4 h— el edge era +0,629 % con t 5,00. El stop se lleva parte;
lo que queda sigue siendo lo mejor medido en toda la investigación.

## La pregunta de este spec

El detector de cascada es determinista y ya está medido. Lo que **no** se sabe es si el modelo
aporta algo encima. La pregunta que el código no sabe contestar:

> **¿Esta caída es mecánica —liquidaciones en cadena, revierte— o es información —repreciación
> real, sigue—?**

Es integrar varias señales débiles sin umbral limpio, que es lo único que el modelo hizo bien en
todo el trabajo previo: `ENTORNO_EQUIVOCADO` identificó lo peor de forma **replicada** (R −0,552 y
−0,606 contra medias de −0,219 y −0,247) en dos tandas independientes.

## Hipótesis falsable, escrita antes de mirar

> Sobre los eventos de cascada, el escalar continuo del modelo selecciona un subconjunto de tamaño
> **k** con retorno medio superior en **≥ 0,15 puntos porcentuales** al que selecciona el mejor
> escalar barato, siendo **k el mismo en los dos brazos**.

Todo lo demás —definición del evento, horizonte, costes, no solapamiento— queda **fijo e idéntico**.
La única variable es el orden.

## Los tres fallos del diseño anterior que este corrige

1. **El modelo emitía una categoría** (`TOMAR`/`ESPERAR`/`ENTORNO_EQUIVOCADO`). Una categoría **no
   se puede comparar con un umbral a tasa de aceptación igualada**, y por eso el 069 y el 070 solo
   pudieron decir «−0,014» y «−0,055» sin saber contra qué. Aquí el modelo emite un **escalar
   continuo** (`score`), y se compara con el escalar barato al mismo número de aceptaciones.
2. **Faltaba la línea base que importa**: una regresión logística sobre los **mismos rasgos**. Sin
   ella, un resultado positivo dice «estos rasgos tienen señal», no «el modelo tiene señal» — y el
   meta-etiquetado canónico se implementaría con el logit, que es gratis y no depende de nadie.
3. **El t era de Student.** Con eventos solapados y pares correlacionados está inflado 2-3x. Aquí se
   usa **bootstrap de bloques de calendario**, y sustituye al t de Student, no lo acompaña.

## Fases

### Fase 0 — cero llamadas, cero dólares

- **Recuperar los datos tirados.** El descargador se quedaba con 6 de los 12 campos del kline. Los
  descartados incluyen **volumen de compra agresora** y **número de operaciones**: la distinción
  rotación-frente-a-liquidación, que es exactamente lo que separa una caída mecánica de una real, y
  el rasgo que ningún escalar de precio puede ver.
- **Ampliar a 30 pares × 400 días.** El límite del experimento es el número de eventos
  independientes, y eso no se compra con dinero.
- **Extractor de rasgos + estado** en `packages/strategy-core/src/trader/cascada.ts`, puro y con
  tests. Va ahí y no en la API por la misma razón que `estado.ts`: el backtest tiene que
  reproducirlo byte a byte. **Es el artefacto que sobrevive gane o pierda el experimento.**
- **Las cuatro líneas base**: B0 sin filtro · B1 el mejor escalar barato · B2 regresión logística
  sobre los mismos rasgos, con validación purgada · B3 ranker aleatorio.

**Línea de muerte del programa**: si **B2 no bate a B1** fuera de muestra, no hay señal que extraer
en estos rasgos para nadie, y no se construye el meta-etiquetado con ningún modelo. Cuesta 0 $.

### Fase 1 — piloto, ~500 llamadas (~0,04 $)

- Añadir la primitiva **`score`** a `typesafe.client.ts`: hoy solo hay `choice` y `noul`, y el
  formato de cable de `score` **no está verificado en este repositorio**. Con test y llamada de humo.
- Puertas de validez, todas antes de mirar ningún resultado:

| id | comprobación | umbral |
|---|---|---|
| V-1 | permutación: Δ con desenlaces barajados | \|Δ\| < 0,03 |
| V-2 | reproducibilidad: misma entrada dos veces | sd < 0,3 × sd transversal |
| V-3 | **discordancia del top-k contra B1** | **≥ 25 %** |
| V-4 | auditoría de fuga: ninguna ventana cruza el instante de decisión | binaria |

Si **V-3 falla**, se para y se reporta: *el modelo es una copia ruidosa del escalar*.

### Fase 2 — holdout, una sola vez, ~2.600 llamadas (~0,21 $)

Partición temporal: primer 50 % para iterar, último 50 % intacto. **Las preguntas se congelan y su
`VERSION_PREGUNTAS` se escribe aquí antes de la corrida**; cambiarlas después invalida el holdout.

## Criterio de decisión

**CONSTRUIR** (spec 072) si se cumplen las cuatro:

| id | criterio | listón |
|---|---|---|
| D-1 | Δ = retorno(modelo top-k) − retorno(B1 con k) | **≥ +0,15 pp**, IC bootstrap excluye el 0 |
| D-2 | retorno absoluto del brazo modelo | **> 0** con **t bootstrap ≥ 2** |
| D-3 | signo de Δ por par | **positivo en ≥ 9 de 12** — 7 de 12 sale por azar el 38,7 % de las veces |
| D-4 | Δ contra B2, el logit | **≥ +0,05 pp** — si no, se construye el logit, no el modelo |

**NO CONSTRUIR** si Δ ≤ +0,05 pp, o si el extremo superior de su IC no llega a +0,15.

**NO CONCLUYENTE** en el resto, y su respuesta también va escrita: se amplía la muestra, se corre
**una vez más**, y nunca una tercera.

## Lo que se reporta salga lo que salga

- Si el modelo no aporta pero el **detector sí** —que es lo medido con t 4,66—, la recomendación
  será desplegar el detector **sin IA**.
- La medición del deslizamiento al que muere el edge, que define si esto es implementable.
- El sesgo de supervivencia: los pares son los que existen hoy. No tiene arreglo con estos datos.

---

# Segunda parte: la revisión del Market Maker V2

> **Por qué está aquí y no en un spec aparte.** La medición de arriba dejó el motor de cascadas sin
> destino, y el usuario pidió entonces evaluar qué bot de la plataforma encaja con el modelo de
> probabilidades. La respuesta —Market Maker V2— obligó a mirarlo de verdad, y la revisión encontró
> cosas que no tienen nada que ver con la IA. Se corrigen aquí, con su medición, en vez de abrir un
> spec por cada una.

## De dónde sale

> *«revisa bien, hace un tiempo atrás simulé uno mm2 y no generaba ganancias. Algo puede estar muy
> mal. Revísalo todo con cuidado y arregla.»*

Se reprodujo con el motor real (`runReplay`, que usa las mismas piezas puras que el tick): **ocho
pares, 120 días de velas de 5 min, valores de fábrica → −19,9 %, negativo en 8 de 8.**

## F-01 · El backtest decía que FAVORECE al market maker, y es al revés — **Crítico**

`warnings.ts` le decía al usuario, palabra por palabra, que *«un market maker sale mejor parado aquí
que en el venue»*. Es falso en la dirección que importa.

El replay solo conoce **precios**. Una orden en reposo se ejecuta si, y solo si, el precio llega
hasta ella — o sea que **toda ejecución del replay es, por construcción, una en la que el mercado
vino a por ti**. Un market maker no vive de esas: vive del flujo que cruza su cotización **sin mover
el precio** (alguien cerrando posición, un arbitrajista, una liquidación), y ese flujo no está en una
vela. Lo único que el replay le regala es la falta de cola, que pesa mucho menos.

Lo peor es que **el propio fichero ya lo sabía**: lleva desde el 001/F-65 un comentario que dice que
«los market makers son los que más pierden con un `plan()` por vela», y a continuación añade avisos
propios para tendencia, seguimiento, canal y bot de IA — y **ninguno** para los dos que ese
comentario señala como los peor reproducidos.

**Corregido**: tres avisos de market maker, el primero diciendo en mayúsculas que este backtest no
puede decidir si gana o pierde, y matizado el aviso común de profundidad de libro. Las guías decían
lo mismo y se corrigen igual, con la vuelta de tuerca que faltaba: **el bot simulado en el venue sí
ve flujo real**, y por eso es la herramienta con la que se mide un market maker.

## F-02 · Ningún market maker mira su coste: la salida cierra por debajo — **Crítico**

Ninguna de las dos versiones lee `entryPrice` de la posición. Las dos cotizaciones —la que añade y la
que reduce— se calculan desde el precio de mercado, así que **en cuanto el precio se va, la venta se
planta por debajo del coste medio** y realiza una pérdida que la estrategia nunca quiso hacer. El
beneficio está acotado por el diferencial; la pérdida, no.

Medido con el motor real reconstruyendo el coste medio ejecución a ejecución, ocho pares × 20 días:

| | cierres | media | total |
|---|---|---|---|
| por **encima** del coste medio | 1816 (52 %) | +0,455 | +826 USDC |
| por **debajo** del coste medio | 1652 (48 %) | **−0,777** | −1283 USDC |
| comisiones | | | −63 USDC |
| **realizado** | | | **−520 USDC** |

Un cierre malo pesa **1,71 veces** lo que pesa uno bueno. Y las comisiones son 63 de 520: **no se
pierde por lo que se paga, sino por dónde se pone la salida.**

El sesgo por inventario es el único mando que pelea eso, y funciona. Mismos pares, mismos momentos:

| variante | cierres buenos | realizado |
|---|---|---|
| de fábrica | 52 % | −520 |
| `inventorySkewFactor` 1 | 60 % | **−291** |
| `inventorySkewFactor` 2 | 61 % | −252 |
| `sizeSkewFactor` 0,5 | 61 % | −345 |
| los dos | 63 % | **−241** |

**La V1 lo trae encendido desde siempre; la V2 apagado.**

**No se cambia el valor de fábrica**: movería dónde cotiza cada bot V2 en marcha, y eso es decisión
de su dueño (principio 6). Lo que se hace es **dejar de callarlo** en los cuatro sitios donde se mira
antes de poner dinero: `validate()` de las dos versiones (un `WARNING`, que no bloquea crear el bot),
los avisos del backtest, la guía de dentro de la app y las dos de `docs/`. El aviso vive en
`mm-shared.ts`, no copiado en cada una — la lección del spec 039 R-3.

> **Resuelto abajo**: el usuario confirmó que no tiene ningún bot corriendo, así que
> `inventoryPriceAdjustment` pasa a `true` e `inventorySkewFactor` a `1` en el `defaults()` de la V2,
> como en la V1. Ver «Decisión del usuario».

## F-03 · Veintidós campos de estrategia salían en inglés o mudos — **Alto**

Los formularios se generan a partir de `FieldMeta` y el texto sale de `FIELD_LABELS` por `labelKey` y
`helpKey`. Sin la clave, el **nombre** se cae a des-camelizar («Regime Guard» en una app en
castellano) y la **ayuda** no se cae a nada: el campo se queda mudo.

Faltaban: las **ocho** ayudas del grupo de microestructura de los dos market makers —todos avanzados,
todos en cero de fábrica, o sea los que nadie entiende sin leerla—; `regimeGuard`,
`trendGuardEfficiency` y `volEstimator` de la V2, sin nombre; las **ocho** ayudas de la estrategia de
tendencia, ni una; y `decisionInterval` del «Bot de IA», sin nombre, más seis ayudas.

Los textos ya estaban escritos en las guías de dentro de la app: faltaba la línea del catálogo.

**Corregido**, y añadido **`pnpm check:labels`**, que cruza los `labelKey`/`helpKey` de
`strategy-core` con el catálogo y falla si falta alguno. Verificado en rojo antes de en verde.

## F-04 · La retícula neutral avisaba del tope en TODOS los ticks — **Medio**

`capReached` era cierto con solo tener un tope configurado, tendiera la retícula entera o no, así que
la nota decía «Tope de exposición alcanzado» siempre. El **filtro** siempre estuvo bien; solo el
mensaje. Un aviso que miente enseña a ignorar los avisos. Corregido partiendo la condición en
`hayTope` (filtrar) y `topeMordió` (avisar), con su test.

## F-05 · El estado que ve el modelo identificaba el instrumento — **Medio**

`estado.ts` imprimía la anchura del canal como porcentaje del precio, y eso identifica el par pese a
la doctrina de «sin símbolo». Corregido: se expresa en múltiplos del rango medio verdadero.

## Lo que se añade, apagado de fábrica

**Puerta de régimen** (`regimeGuard`) en la V2: deja de **abrir** contra el mercado cuando el
régimen, medido sobre velas de 15 min y 1 h, dice que no es su terreno. El lado que reduce sigue vivo
siempre. Apagada no pide **ni una vela** — un market maker corre en muchos bots a la vez y cada
sondeo cuenta contra el cupo del venue (el incidente de `TICK_SLOW` del 065).

Existe porque el filtro que ya había mide la eficiencia de Kaufman sobre un anillo de **segundos**, y
el inventario de un market maker se envenena a lo largo de **horas**: está mirando la escala
equivocada. Medido sobre 26 pares y 400 días, el filtro viejo discrimina +0,015 pp —dentro del
ruido— y el clasificador de régimen +0,156 pp con el mismo tiempo activo. Con el motor real sobre 8
pares y 120 días, la puerta y el sesgo por inventario llevan juntos el resultado de −19,9 % a
−11,4 %, mejor en 7 de 8 pares.

## Decisión del usuario: no hay bots corriendo

> *«no tengo ningún bot corriendo, ajusta todo lo necesario y no dejes código inservible y viejo»*

Eso levanta la única restricción que había —el principio 6, no mover dónde cotiza un bot en
marcha—, así que las dos conclusiones medidas pasan a ser el **valor de fábrica**, y lo que solo
existía para no molestar a bots antiguos **se borra**.

### Lo que cambia de fábrica

| campo | antes | ahora | por qué |
|---|---|---|---|
| `inventoryPriceAdjustment` | `false` | **`true`** | F-02: sin él, el 48 % de los cierres cae bajo el coste |
| `inventorySkewFactor` | `'0'` | **`'1'`** | el mismo con el que la V1 lleva funcionando siempre |
| `regimeGuard` | `'OFF'` | **`'EVITA_TENDENCIA'`** | medido, es lo que más aporta después del sesgo |

`meta.default` se mueve con ellos: son dos números distintos y en desacuerdo mentían (spec 037 R-5),
y ahora hay un test que los ata.

### Lo que se borra

**`trendGuardEfficiency`**, con su `deriva()` y sus tests. Medía la eficiencia de Kaufman sobre el
anillo de muestras de **segundos**, y el inventario de un market maker se envenena a lo largo de
**horas**: la escala equivocada. Medido sobre 26 pares y 400 días discriminaba **+0,015 pp** —dentro
del ruido— contra los **+0,156 pp** de la puerta de régimen con el mismo tiempo activo. Se conservaba
«para quien ya lo tuviera encendido», y no hay nadie. Dos mandos para la misma pregunta, uno de ellos
que no funciona, es peor que uno solo.

### El resultado, medido con los valores que de verdad se entregan

Ocho pares × 20 días, reparto del realizado (USDC sobre 1000 de capital):

| variante | cierres buenos | realizado |
|---|---|---|
| lo que se entregaba antes | 52 % | −520 |
| solo el sesgo por inventario | 60 % | −291 |
| solo la puerta de régimen | 58 % | −255 |
| **de fábrica hoy (los dos)** | **62 %** | **−163** |
| + `sizeSkewFactor` 0,5 | 63 % | −158 |

**Los dos efectos se suman**: juntos recortan la pérdida realizada un **69 %**, más que cualquiera de
los dos por separado. Y sobre 120 días, con el inventario marcado a mercado: **−19,9 % → −11,4 %,
mejor en 7 de 8 pares** (DOGE empeora).

`sizeSkewFactor` **se queda en 0**, y ahora por una razón medida y no por omisión: encima de los
otros dos aporta 5 USDC de 163. La guía lo sigue recomendando para quien quiera afinar.

Que siga negativo **no dice nada de la estrategia**: es el replay, que no tiene flujo (F-01). Para
saber si gana, un bot simulado en el venue.

## Verificación

`pnpm build:packages` · `test:strategies` 929 · `worker` 621 · `backtest` 77 · `api` 6085 ·
`pnpm lint` (3 avisos preexistentes en la API, 0 errores) · `check:env` · `check:labels` · typecheck
de la app. Todo verde.

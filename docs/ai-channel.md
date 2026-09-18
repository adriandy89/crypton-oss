# Canal con IA

> Busca rangos y canales bien marcados en velas de 15 minutos y opera el rebote en su borde, con el
> apalancamiento que permite el stop. Un motor calcula cada número de cada operación posible, y una
> IA elige entre esas opciones.

**Riesgo: ALTO.** Opera con apalancamiento de hasta 25x, y **solo la pueden usar los
administradores**. Lee el apartado 1 antes que ningún otro.

---

## 1. Qué es esto, en cristiano

Hay pares que durante horas van y vienen entre dos precios, en un zigzag que se ve a simple vista.
Este bot busca esos tramos y, cuando el precio toca un borde y da señales de rebotar, abre una
operación hacia el otro lado: **compra en el soporte, vende en la resistencia**.

El reparto de papeles es lo importante:

- **El motor lo calcula todo.** Detecta el canal, decide si el mercado está en rango, comprueba el
  toque del borde y prepara las operaciones posibles, cada una con su stop, sus objetivos, su tamaño,
  su apalancamiento y su liquidación.
- **La IA solo elige.** Recibe esas opciones y contesta con palabras de una lista cerrada: «opción A,
  stop normal, objetivo escalonado, apalancamiento medio». **Nunca escribe un número.** Si no
  contesta, o contesta algo que no está en la lista, **no se abre nada**.
- **Las salidas no esperan a nadie.** El stop y los objetivos son órdenes nativas del exchange, y
  el motor cierra solo si el canal se rompe, si se acaba el tiempo o si algo no cuadra.

### El riesgo, dicho claro

1. **Un rebote en el borde acierta entre un 55 y un 68 % de las veces.** No es una «probabilidad
   alta». La ventaja no sale de acertar casi siempre, sale de ganar bastante más de lo que se
   arriesga: el motor no ofrece una operación que no pague al menos 1,2 veces lo arriesgado, ya con
   comisiones.
2. **El apalancamiento es alto a propósito, y sale del stop.** Con un stop cerca, el bot puede usar
   25x y perder lo mismo al stop que con 5x. Lo que cambia con el apalancamiento es el margen que se
   inmoviliza y lo cerca que queda la liquidación. La regla (apartado 4) deja la liquidación siempre
   a tres stops o más.
3. **Un hueco puede saltar el stop.** Una noticia, un exchange que se para. Con margen aislado lo
   más que se pierde en ese caso es el margen de la operación, y ese margen tiene tope (25 % del
   capital de fábrica).
4. **La IA cuesta dinero.** Cada consulta se paga. El bot solo pregunta con una operación lista, y
   hay un cupo por bot y otro para toda la plataforma.
5. **Muchos ratos no hace nada.** Si el mercado no está en rango, espera. Es lo que tiene que hacer.

### Vocabulario mínimo

| Palabra | Qué significa aquí |
|---|---|
| **Canal** | Dos líneas, soporte y resistencia, entre las que el precio va y viene. **Horizontal** si son planas; **inclinado** si suben o bajan juntas. |
| **Régimen** | Si el mercado está en **rango**, en **tendencia**, **comprimido** o sin definir. Solo se opera en rango (o en un inclinado a favor de su pendiente). |
| **Setup** | Lo que hace que una operación esté lista. El **rebote** es el toque del borde con señales de rechazo; la **ruptura fallida**, una salida del canal que vuelve dentro. |
| **R** | Lo que se pierde si salta el stop, con comisiones. «Un objetivo de 3R» paga tres veces eso. |
| **ATR** | El recorrido típico de una vela. Los stops se miden en ATR de 15 min. |
| **Intención** | Cada decisión, con su historia: pedida, consultando, decidida, aceptada, abierta, cerrada… o descartada, caducada o fallida. |

---

## 2. Cómo funciona por dentro, paso a paso

### Paso 1 — Al cerrar cada vela de 5 minutos

El bot se despierta **6 segundos después de cada cierre de 5 minutos** (más un desfase propio de
hasta 2 s) y trae tres series de velas cerradas: 5 min, 15 min y 1 h. Nunca mira una vela a medio
formar.

### Paso 2 — El análisis

1. **Régimen, en velas de 1 h.** Rango si se cumplen tres de cuatro: ADX bajo y sin subir, índice
   de choppiness alto, eficiencia baja y un ancho de Bollinger normal. Además, la vela de 15 min
   tiene que estar «picada». Para cambiar de régimen hacen falta **tres velas de 15 min seguidas**
   que digan lo mismo: un solo tirón no lo cambia.
2. **El canal, en velas de 15 min.** Se buscan giros confirmados —un giro solo cuenta cuando el
   precio se ha dado la vuelta 1,25 ATR, así que nunca se redibuja hacia atrás— y con ellos un canal
   horizontal o uno inclinado. Tiene que pasar todas estas pruebas:
   - dos toques o más por lado, alternados;
   - el 90 % de los cierres dentro;
   - una anchura de 3 a 10 ATR, y de al menos diez veces el coste de ida y vuelta;
   - treinta velas o más desde el primer toque, y el último hace menos de 48;
   - tres cruces de la línea media o más;
   - un precio que vuelve a la media deprisa.

   Sale con una nota: **A**, **B** o **C**.
3. **El toque, en velas de 5 min.** La última vela toca la zona del borde y cierra dentro. Cuenta
   las confirmaciones: **mecha de rechazo**, **RSI extremo**, **divergencia** con el toque anterior
   y **volumen tranquilo** (un toque sin clímax de volumen no suele ser una ruptura). Con dos o más,
   el rebote está **listo**.

Un canal horizontal exige régimen de rango. Uno inclinado también se acepta con tendencia, si es a
favor de su pendiente y el ADX no pasa de 40.

### Paso 3 — Las operaciones posibles

Para cada setup listo, el motor calcula:

- **Tres stops**: ajustado, normal y amplio, a 0,25, 0,5 y 1 ATR más allá del extremo del toque,
  más medio spread. Un stop más lejano que el máximo que permites no se ofrece.
- **La entrada**: una orden límite **inmediata** (IOC) con precio tope. Si el libro se ha ido más
  allá del tope, no se llena y no pasa nada.
- **Dos objetivos**: la **línea media** y cerca del **borde opuesto** (a un 15 % del ancho).
- **El tamaño**, para que el stop cueste el riesgo que pediste y ni un céntimo más.
- **Tres bandas de apalancamiento** —baja, media y alta—, con el margen, la liquidación y la pérdida
  en un hueco de cada una.
- **El R neto** de cada objetivo, el coste en R y el **acierto que haría falta** para empatar.
- **El histórico del par**: cómo le fue a ese mismo toque en los días cargados (casos, aciertos, R
  medio y el límite de Wilson). Con muchos casos y resultado negativo, la operación no se ofrece.

### Paso 4 — Quién elige

- **Modo IA** (de fábrica). El worker deja la solicitud escrita y la API pregunta al modelo. El
  apartado 3 cuenta lo que ve y lo que puede contestar.
- **Modo reglas.** Elige un **juez fijo** con tu perfil, sin llamar a nadie:

  | Perfil | Stop | Apalancamiento | Objetivo |
  |---|---|---|---|
  | Prudente | amplio | bajo | la media |
  | Equilibrada | normal | medio | escalonado |
  | Agresiva | ajustado | alto | escalonado |

  Si la opción del perfil no es viable, prueba la contigua del lado prudente.

### Paso 5 — La entrada

Con una elección válida, el motor **vuelve a calcular todo con los datos del momento**. Si el
mercado ha cambiado, la elección se descarta. Si no:

1. anota la intención como **aceptada**, antes de hablar con el exchange;
2. fija el apalancamiento, **solo con la posición plana**;
3. manda la orden límite inmediata.

Si a los 30 segundos no hay posición, la entrada se da por perdida y la intención queda descartada.

### Paso 6 — Con la posición abierta

- **El stop**, como orden condicional nativa del exchange. Sobrevive a que CRYPTON se caiga.
- **Los objetivos**, como órdenes límite de solo reducción. En el esquema **escalonado**, una parte
  (60 % de fábrica) en la media y el resto en el borde opuesto; si una parte no llega al mínimo del
  exchange, se juntan.
- **Tras el primer objetivo**, el stop pasa a la entrada más los costes. Nunca vuelve atrás y nunca
  se aleja.
- **El vigilante del stop.** Tras el llenado, el bot revisa cada 3 segundos (8 en Lighter) hasta ver
  el stop en el libro. Si a los 5 segundos (10 en Lighter) no está, **cierra la posición a mercado**
  y avisa en crítico.
- **Las salidas deterministas.** El bot cierra a mercado por su cuenta si:
  - se cumple el **tiempo máximo** (24 velas de 15 min, 6 h, de fábrica);
  - una vela de 15 min **cierra fuera del canal** por más de 0,35 ATR;
  - el régimen gira a **tendencia en contra**;
  - el precio ha pasado el stop en más de medio stop y **el stop no ha saltado**;
  - el exchange informa de una **liquidación demasiado cerca** o de **otro apalancamiento** del
    pedido.

  Reintenta cada 30 segundos, doce veces como mucho. Mientras cierra, el stop sigue puesto.

### Paso 7 — Después

Al cerrarse la operación se cierra el ciclo, se apunta el resultado en USDC y en R, y empiezan las
esperas: la de entre operaciones (15 min), la de después de un stop (30 min) y la de después de una
racha de pérdidas (120 min tras tres seguidas).

Si la posición se cierra **fuera del bot** —a mano desde el exchange, por un deleveraging del venue,
o con el worker caído más de lo que alcanza el barrido—, el motor lo nota: pasados cinco minutos sin
que aparezca esa ejecución, cierra el ciclo y la operación por su cuenta y avisa con
`AI_OPERACION_PERDIDA`. El bot vuelve a operar solo. Lo que **no** se puede reconstruir es el
resultado de esa salida: no entra en el tope diario ni en la caída máxima, y el aviso lo dice
(spec 062, F-04).

---

## 3. La IA: qué ve, qué contesta y qué pasa si falla

### Lo que ve

El texto que recibe el modelo va **en unidades relativas**: distancias en % y en ATR, R, riesgo en %
del capital, liquidación en stops, apalancamiento en «x». **Nunca** lleva precios, importes, el par,
nombres ni identificadores: las opciones se llaman A, B, C… Tampoco ve lo que pensó en consultas
anteriores.

### Lo que contesta

Un JSON con **solo palabras de una lista**: operar o no, la opción, el stop, el objetivo, la banda de
apalancamiento, el tamaño (completo o medio), la confianza, hasta tres motivos y dos riesgos, y una
frase sin cifras. El esquema se construye con las opciones de **esa** consulta: una opción inventada
no pasa. Y el servidor no repara nada: una respuesta que no encaja es un fallo.

Encima, tres reglas:

- **No operar es la respuesta por defecto**, y la de la duda.
- **La confianza solo puede reducir.** Por debajo de la confianza mínima no hay entrada; por debajo
  de alta, la operación entra con **la mitad** del tamaño.
- **Solo vale lo ofrecido.** Una opción no disponible, un esquema que no le toca o una banda que no
  existe se descartan.

### El camino de una consulta

1. El worker escribe la solicitud con la herramienta calculada. **Caduca un minuto después del
   cierre** de su vela.
2. La API la reclama —dos servidores nunca preguntan por la misma— y comprueba, por orden:

   | Si… | La solicitud se cierra como |
   |---|---|
   | la IA del canal está apagada en el servidor, o falta la clave | sin entrada: IA apagada |
   | el dueño ya no es un administrador habilitado | sin entrada |
   | el bot no está en marcha | sin entrada |
   | las consultas del bot están en pausa por fallos | sin entrada |
   | el interruptor global de entradas está cortado, o no se puede leer | sin entrada |
   | quedan menos de 8 segundos hasta el plazo | caducada |
   | no queda ninguna opción que ofrecer | sin entrada |
   | el bot o la plataforma han gastado sus consultas del día | sin entrada |

   **El cupo se cuenta antes de llamar**, y con Redis caído no se llama.
3. Pregunta al modelo, con un plazo de 20 segundos como mucho.
4. Escribe la decisión con el modelo, la versión del prompt, lo que tardó y lo que costó.

### Si algo falla

- **Un fallo no es un «no».** Sin respuesta, o con una respuesta fuera del contrato, la intención
  queda **fallida** y no se abre nada.
- **Cinco fallos seguidos** duermen las consultas de ese bot **seis horas**, con un aviso (como mucho
  uno por hora).
- Una respuesta que llega tarde porque la solicitud ya llegó tarde no cuenta como fallo: caduca.

### El modo sombra

Con `AI_CHANNEL_SHADOW_ONLY` en el servidor, la IA decide, la decisión se guarda con sus números y
**no se ejecuta nada**. Sirve para mirar qué haría antes de dejarla operar.

### Lo que cuesta

Cada consulta guarda su coste (en USD, el que devuelve el proveedor), y el panel suma el del día. De
fábrica:

| Variable del servidor | Por defecto | Qué es |
|---|---|---|
| `AI_CHANNEL_MODEL` | `anthropic/claude-sonnet-5` | El modelo |
| `AI_CHANNEL_REASONING` | `medium` | Cuánto razona antes de contestar |
| `AI_CHANNEL_DAILY_LIMIT` | 48 | Consultas al día por bot (manda el menor entre esto y el campo del bot) |
| `AI_CHANNEL_GLOBAL_DAILY_LIMIT` | 400 | Consultas al día de toda la plataforma |
| `AI_CHANNEL_PROMPT_CACHE` | `1h` | Caché de la parte fija del prompt |

La lista completa está en [`administracion.md`](./administracion.md#canal-con-ia-spec-059).

---

## 4. Los límites

Cada límite se comprueba **tres veces**: la herramienta no ofrece nada que lo rompa, la API descarta
una elección que lo rompa, y el worker lo vuelve a mirar con los datos del momento antes de mandar
la orden.

### Por operación

- **Riesgo** (1 % de fábrica, 2 % como mucho): lo que cuesta el stop, con comisiones.
- **Stop más ancho** (1,5 %).
- **Beneficio mínimo** (1,2R neto).
- **Margen máximo** (25 % del capital): lo más que se pierde en un hueco.
- **Nocional máximo** (5 veces el capital).
- **Tope de apalancamiento** (25x, y nunca más que el máximo del par).

### Del día (UTC) y de las rachas

- **Pérdida diaria máxima** (6 % de fábrica y como mucho): al llegar, **no hay entradas hasta las
  00:00 UTC** y el bot vuelve solo. Si un hueco la lleva a **1,5 veces**, el bot **se pausa hasta
  las 00:00 UTC**: reanudarlo antes no abre entradas y la guarda lo vuelve a pausar.
- **Operaciones al día** (8), **pérdidas seguidas** (3, con 120 min de espera), **espera tras un
  stop** (30 min) y **entre operaciones** (15 min).
- **Objetivo del día** (apagado): al llegar, no abre más hasta mañana.
- **Caída máxima** (15 %): lo que ha caído el resultado desde su mejor punto **desde la última vez
  que lo reanudaste**. Al llegar, **pausa**; al reanudarlo, la cuenta empieza de nuevo ahí.
- **Horas sin entradas** y **ventana antes del funding**.

### La regla del apalancamiento por stop

Con `s` la distancia al stop en tanto por uno y `mmr` el margen de mantenimiento del tramo:

```
distancia exigida = el mayor de (3 · s) y (3 ATR de 1 h)
apalancamiento máximo = floor(1 / (mmr + distancia · (1 + mmr)))   topado en 25 y en el del par
```

Así la liquidación queda **al menos a tres stops** de la entrada, y a tres ATR de 1 h. Un stop más
ancho da menos apalancamiento. Las otras estrategias siguen con la regla del 5 % de
[riesgo y liquidación](./riesgo-y-liquidacion.md#4-el-semáforo-y-la-regla-del-5-): esta no la usa,
porque su distancia la pone cada operación.

**Un ejemplo, cifra a cifra** (el test de la herramienta lo fija):

| Dato | Valor |
|---|---|
| Capital | 1.000 USDC |
| Riesgo por operación | 1 % |
| Canal | 99,90 – 102,90 |
| Libro | 100,00 / 100,02 |
| ATR de 15 min / de 1 h | 0,40 / 0,80 |
| Toque del soporte | 99,95 |
| Comisiones | las de Hyperliquid (taker 4,5 bps, maker 1,5, deslizamiento 2) |

- **Stop ajustado** en 99,84; entrada como mucho a **100,05**.
- **Tamaño**: 31,257 unidades (3.127 USDC). Si salta el stop se pierden 10,00 USDC con comisiones: el
  1 %.
- **Apalancamiento**: de 13x a 25x. A 25x inmoviliza 125 USDC y la liquidación queda en **97,02**,
  muy por detrás del stop. A 13x inmovilizaría 241 USDC. **La pérdida al stop es la misma en las
  tres bandas.**
- **Objetivos**: la media en 101,40 paga unas **4 veces** lo arriesgado, y el borde opuesto
  (102,45), unas **7**.
- Con el stop normal o el amplio, menos cantidad (23,817 y 16,136) y la misma pérdida máxima.

---

## 5. Avisos, panel y pausa

### Por Telegram

| Evento | Cuándo | Preferencia |
|---|---|---|
| 📥 **Operación abierta** (`AI_ENTRY`) | Se llenó una entrada. Con lado, cantidad, apalancamiento, stop, objetivos, riesgo y liquidación, y el botón **⏸ Pausar el bot** | Ciclos cerrados |
| 📤 **Operación cerrada** (`AI_EXIT`) | Se cerró, con el resultado en USDC y en R y el motivo. **Sustituye al «ciclo cerrado»** en estos bots | Ciclos cerrados |
| ⛔ **Tope diario** (`AI_DAY_STOP`) | Se llegó a la pérdida diaria máxima | Guardas de riesgo |
| **Sin stop** (`SIN_STOP`) | El stop no apareció a tiempo y se cerró a mercado | Guardas de riesgo |
| **Cierre fallido** (`AI_CIERRE_FALLIDO`) | Doce intentos de cierre a mercado sin éxito | Guardas de riesgo |
| **Posición sin plan** (`AI_POSICION_HUERFANA`) | Hay posición y el bot no sabe de qué operación es: pone un stop de emergencia | Guardas de riesgo |
| ↩️ **Entrada descartada** (`AI_ENTRY_DISCARDED`) | El exchange no aceptó el apalancamiento o la operación ya no cabía | Errores |
| **La IA no pudo actuar** (`AI_FAILED`) | Cinco fallos seguidos del modelo | Errores |

Solo van a la bitácora, sin aviso: cada **decisión** (`AI_DECISION`), la **orden de cierre**
(`AI_CIERRE`), el **stop llevado a la entrada** (`AI_BREAKEVEN`) y una entrada que simplemente no se
llenó.

**El botón de pausa** lleva un vale opaco, no el id del bot: sirve **una vez**, dura **24 horas** y
solo lo puede usar el dueño. La API vuelve a comprobar que sigue siendo administrador antes de pausar,
y la pausa queda en la bitácora.

### El panel «Canal con IA»

En el detalle del bot, pestaña Resumen (y en la ficha de la consola, para tus bots):

- **el estado de la IA**: consultando, en sombra, en pausa por fallos, apagada o sin entradas;
- **el mercado**: régimen, canal, nota y niveles;
- **la operación abierta**: entrada, stop, objetivos, tamaño, riesgo y cuándo se cierra por tiempo;
- **hoy**: la pérdida frente al tope, las operaciones, la racha, las consultas y su coste;
- **las decisiones**: qué se eligió, por qué, con qué confianza y lo que dijo el modelo;
- **dos mandos**: **pausar el bot** y **cortar o abrir sus entradas**.

El gráfico del bot pinta las tres líneas del canal, con su capa «Canal» en la leyenda.

### Lo que hace cada comando en este bot

- **Pausar** cancela los objetivos y **deja solo el stop**. Con el bot pausado tampoco hay salidas
  por tiempo ni por invalidación: nadie la cierra con beneficio hasta que lo reanudes. Lo que sí
  sigue en pausa es la red: si al stop le faltara sitio en el libro, el bot lo repone, y si no sale,
  el vigilante cierra a mercado.
- **Cancelar todas las órdenes** vuelve a poner el stop propio en el acto.
- **Retirar margen** no se admite: acercaría la liquidación al stop calculado. Aportar, sí.
- **Recentrar** no aplica.
- **Cualquier comando** caduca las decisiones pendientes: la siguiente se pide de nuevo.

### Cortar las entradas

- **De un bot**: el interruptor «Entradas permitidas» (o el mando del panel).
- **De todos a la vez**: el interruptor global de la consola, con motivo obligatorio. Si Redis no
  contesta, el worker lo da por cortado.

En los dos casos las posiciones abiertas siguen con su stop y sus objetivos.

---

## 6. Cómo empezar con poco riesgo

### El camino

1. **Backtest.** Con un bot simulado, 30 días en velas de 5 min, tres veces por par (BTC, ETH, SOL),
   con **tramos** para ver si el resultado se sostiene. Mira la tabla por setup: con **menos de 20
   operaciones no se puede concluir nada**, y el acierto que cuenta es el de **Wilson**, no el
   visto. En el backtest decide el juez, no la IA
   ([simulación y backtest](./simulacion-y-backtest.md)).
2. **Simulación, 48-72 horas**, con la IA encendida, en tres pares y un exchange cada uno. Comprueba
   que no hay consultas sin setup, que el stop aparece en segundos, que ningún límite se rompe y que
   el coste es el esperado.
3. **Dinero real, con poco capital.** Mira los primeros avisos, prueba el botón de pausa y comprueba
   que un fallo forzado del modelo acaba en «sin entradas» y con aviso.

### Tres configuraciones

**A — «Para empezar»**: la de fábrica con perfil **Prudente**, tope de apalancamiento **10x** y
confianza mínima **Alta**. Stops amplios, objetivo en la media y solo las decisiones seguras.

**B — «La de fábrica»**: perfil **Agresiva**, riesgo **1 %**, tope **25x**, pérdida diaria **6 %**.
Stop ajustado, objetivo escalonado y banda alta. La pérdida al stop es la misma: lo que sube es el
apalancamiento.

**C — «Solo mirar»**: cualquiera de las dos con **Solo observar** encendido. Decide, consulta y
apunta, sin abrir nada. Gasta consultas.

### Checklist antes de arrancar

- [ ] ¿Has pasado el backtest por tramos y la tabla por setup tiene casos suficientes?
- [ ] ¿Has tenido el bot en simulación al menos dos días?
- [ ] ¿El riesgo por operación, multiplicado por las pérdidas seguidas, es algo que aceptas perder?
- [ ] ¿Tienes Telegram vinculado, con «Guardas de riesgo» y «Ciclos cerrados» encendidos?
- [ ] ¿Has puesto horas sin entradas en los datos macro que mueven tu par?
- [ ] ¿Sabes que pausar deja solo el stop?

### Señales de alarma

| Lo que ves | Qué significa |
|---|---|
| Muchas decisiones «sin entrada» por **oferta** | El modelo elige opciones que no están disponibles. Revisa el panel; si sigue, pasa a modo reglas. |
| Fallos seguidos del modelo | Clave, proveedor o plazo. Con cinco, el bot se toma seis horas. |
| Entradas descartadas por el exchange | El apalancamiento no se aplica, o el tramo del par no da para el nocional. |
| Stops que saltan en cadena en el mismo borde | El rango se está rompiendo. Las esperas lo frenan; si se repite, baja la nota mínima a A. |
| El bot no entra nunca | El par no está en rango, o el canal no pasa las pruebas. Es su trabajo. |

---

## 7. Lo que este bot NO hace

- **No gestiona la posición con IA.** La IA solo decide entradas; las salidas son fijas.
- **No espera en el borde con órdenes puestas.** Las entradas son inmediatas: si el precio pasa,
  la oportunidad se pierde.
- **No opera rupturas confirmadas.** La ruptura fallida es opcional y va apagada.
- **No promedia.** Una posición a la vez, sin segundas entradas.
- **No sabe de noticias.** Pon ventanas sin entradas en los datos macro.
- **No amplía un stop ni sube el apalancamiento con posición**, nunca.

---

## 8. Parámetros configurables, uno a uno

🔥 en caliente (siguiente revisión) · 🌤️ en tibio (cancela y recoloca órdenes) · ❄️ en frío (hay que
crear otro bot).

### Base

#### Lados que opera · `direction` · 🔥 · por defecto **Ambas**
Los dos, solo largos o solo cortos. Cambia solo las entradas nuevas.

#### Capital asignado · `totalInvestment` · 🌤️ · mínimo 50 · ⚠️ campo de riesgo
Sobre él se calculan el riesgo, los topes y el nocional máximo.

#### Modo de margen · `marginMode` · ❄️ · **solo Aislado**
Así, un hueco no puede llevarse más que el margen de la operación.

#### Velas del canal · `structureInterval` · ❄️ · **15 min** o 5 min
15 min da canales de horas, más fiables. 5 min da más ocasiones y más ruido.

#### Quién elige · `decisionMode` · 🔥 · **IA** o reglas
Ver el paso 4.

#### Perfil · `aiProfile` · 🔥 · Prudente, Equilibrada o **Agresiva**
Ordena las preferencias de quien elige. Nunca afloja un límite.

#### Entradas permitidas · `entriesEnabled` · 🔥 · **sí**
Apagado no abre nada nuevo y sigue gestionando lo abierto.

#### Solo observar · `observeOnly` · 🔥 · **no**
Decide y apunta con sus números, sin mandar órdenes. En modo IA sigue consultando.

### Riesgo

#### Tope de apalancamiento · `leverage` · 🔥 · 1–25 · por defecto **25**
Cada operación calcula el suyo con su stop y nunca pasa de aquí ni del máximo del par.

#### Riesgo por operación · `riskPerTradePct` · 🔥 · 0,1–2 % · por defecto **1** · ⚠️
Lo que cuesta el stop, con comisiones. Con el 1 %, diez stops seguidos son un 10 % del capital.

#### Pérdida diaria máxima · `maxDailyLossPct` · 🔥 · 0,5–6 % · por defecto **6** · ⚠️
Ver el apartado 4. Nunca por debajo del riesgo de una operación.

#### Margen máximo por operación · `maxMarginPct` · 🔥 · 5–100 % · por defecto **25** · ⚠️
El peor caso en un hueco. Obliga a un apalancamiento mínimo.

#### Nocional máximo · `maxNotionalMultiple` · 🔥 · 1–25 veces · por defecto **5**
Techo del tamaño aunque el stop sea muy estrecho.

#### Tope de exposición · `maxNotionalCap` · 🔥
Otro techo, en USDC. Manda el menor.

#### Distancia a la liquidación · `liqBufferStops` · 🔥 · 3–10 stops · por defecto **3** · avanzado
Subirlo baja el apalancamiento posible.

#### Stop más ancho · `maxStopPct` · 🔥 · 0,1–5 % · por defecto **1,5**

#### Beneficio mínimo · `minRewardRisk` · 🔥 · 0,5–5 R · por defecto **1,2**
Por debajo de 1 habría que acertar más de la mitad de las veces solo para empatar.

#### Deslizamiento máximo de la entrada · `maxEntrySlippageR` · 🔥 · 0,05–0,5 R · por defecto **0,2** · avanzado
Fija el precio tope de la entrada.

#### Spread máximo · `maxSpreadFraction` · 🔥 · 0,02–0,5 ATR · por defecto **0,1** · avanzado

#### Objetivo de ganancia del día · `dailyProfitTargetPct` · 🔥 · 0–50 % · por defecto **0** (apagado)

#### Caída máxima · `maxDrawdownPct` · 🔥 · 2–50 % · por defecto **15** · ⚠️
Al llegar, pausa manual. Se mide desde la última reanudación: al reanudar, la caída vuelve a cero
y el bot dispone otra vez de todo el margen.

#### Al acercarse la liquidación · `liquidationAction` · 🔥 · por defecto **Cerrar todo**
Con la regla por stop, el aviso salta a dos tercios del camino hasta la liquidación.

#### Stop loss (%) · `stopLossPct`
**No se usa**: cada operación pone el suyo. Si lo rellenas, el bot solo avisa.

### Límites del día y horario (UTC)

#### Espera entre operaciones · `cooldownMinutes` · 🔥 · por defecto **15** min
#### Operaciones al día · `maxTradesPerDay` · 🔥 · 1–48 · por defecto **8**
#### Pérdidas seguidas · `maxConsecutiveLosses` · 🔥 · 1–10 · por defecto **3**
#### Espera tras la racha · `lossStreakCooldownMinutes` · 🔥 · 0–1440 · por defecto **120** min
#### Espera tras un stop · `stopCooldownMinutes` · 🔥 · 0–720 · por defecto **30** min
#### Consultas a la IA al día · `aiDailyCallBudget` · 🔥 · 1–200 · por defecto **48** · avanzado
El servidor tiene su propio techo, y manda el menor.
#### Funding máximo en contra · `maxAdverseFundingBps` · 🔥 · 0–100 bps · por defecto **1** · avanzado
Quita solo el lado que paga. **Un 0 apaga el filtro** —igual que en los market
makers—, así que no es «ningún funding en contra»: es «me da igual el funding».
En Lighter no hace nada: no publica el funding.
#### Sin entradas antes del funding · `fundingBlackoutMinutes` · 🔥 · 0–60 · por defecto **10** · avanzado
En Hyperliquid no aplica: no publica la hora del cobro.
#### Horas sin entradas · `noEntryWindowsUtc` · 🔥 · avanzado
`HH:MM-HH:MM` separadas por comas, hasta seis. Mal escritas, el bot no abre nada hasta corregirlas.

### Salidas

#### Objetivos permitidos · `takeProfitSchemes` · 🔥 · por defecto **Los tres**
Línea media, borde opuesto, escalonado, o que elija quien decide.
#### Parte en la media · `tp1Fraction` · 🔥 · 50–70 % · por defecto **60**
#### Stop a la entrada tras la media · `breakevenAfterTp1` · 🔥 · por defecto **sí**
#### Tiempo máximo · `maxHoldBars` · 🔥 · 4–48 velas de 15 min · por defecto **24**
#### Cierre fuera del canal · `invalidationAtr` · 🔥 · 0,25–0,5 ATR · por defecto **0,35** · avanzado

### Mercado

#### Operaciones · `allowedSetups` · 🔥 · por defecto **Rebote**
La ruptura fallida entra contra un movimiento que acaba de romper: más riesgo.
#### Canales · `allowedChannels` · 🔥 · por defecto **Los dos**
#### Inclinados solo a favor · `slopedWithTrendOnly` · 🔥 · por defecto **sí**
#### Velas para buscar el canal · `channelWindowBars` · 🔥 · 48–200 · por defecto **96** · avanzado
#### Nota mínima del canal · `minChannelQuality` · 🔥 · A, **B** o C
#### Confirmaciones mínimas · `minConfirmations` · 🔥 · 1–4 · por defecto **2**
#### Histórico exigido · `requireEvidence` · 🔥 · **No**, débil (20 casos o más) o moderada (más de 60)
#### Confianza mínima de la IA · `minAiConfidence` · 🔥 · **Media** o alta

### Margen y costes

#### Comisión maker / taker · `makerFeeBps` / `takerFeeBps` · 🔥 · 0–20 bps · avanzado
Vacío, la tarifa base del exchange (Hyperliquid 1,5/4,5 · Aster 1/3,5 · Lighter 0/0).
#### Deslizamiento estimado · `slippageBps` · 🔥 · 0–20 bps · avanzado
Vacío, 2 bps.

---

## 9. Resumen de valores de fábrica

| Campo | Por defecto | ¿Lo cambio? |
|---|---|---|
| Lados que opera | Ambas | Según tu tesis |
| Tope de apalancamiento | 25x | 🟡 Empieza con menos |
| Quién elige | IA | 🟡 Reglas para el backtest y los primeros días |
| Perfil | Agresiva | 🟡 Prudente para empezar |
| Riesgo por operación | 1 % | ✅ Déjalo |
| Pérdida diaria máxima | 6 % | 🟡 Bájala si el capital es todo lo que tienes ahí |
| Margen máximo | 25 % | ✅ Déjalo |
| Operaciones al día | 8 | ✅ Déjalo |
| Pérdidas seguidas / espera | 3 / 120 min | ✅ Déjalo |
| Operaciones permitidas | Rebote | ✅ Déjalo |
| Nota mínima | B | ✅ Déjalo |
| Confianza mínima | Media | 🟡 Alta para empezar |
| Horas sin entradas | — | 🔴 **Pon las de los datos macro** |

---

## 10. ¿Esta u otra?

| | **Canal con IA** | [Tendencia](./trend-follow.md) | [Rejilla clásica](./grid-classic.md) |
|---|---|---|---|
| Qué busca | Un rango con bordes claros | Una ruptura que sigue | Un rango que tú fijas |
| Cuándo entra | Toque del borde con confirmaciones | Rompe su canal de N velas | En cada línea |
| Stop | Siempre, nativo, a 0,25–1 ATR del toque | Por ATR, que sigue al precio | Opcional |
| Apalancamiento | Sale del stop, hasta 25x | Fijo | Fijo |
| Quién decide | Motor + IA (o juez) | Motor | Motor |
| Gana cuando… | El precio va y viene | El precio se va recto | El precio va y viene dentro de tu rango |

**Si dudas entre esta y la rejilla**: la rejilla opera cualquier movimiento dentro de un rango que
tú fijas; esta busca el rango sola, solo entra en el borde y se va si el rango se rompe.

---

## 11. Limitaciones conocidas

- **El backtest mide el motor y el juez, no el modelo.** Tampoco reproduce el funding ni las
  guardas del motor. Los avisos lo dicen junto al resultado.
- **Pausar deja solo el stop.** Mientras dure la pausa no hay salidas por tiempo ni objetivos.
- **Lighter.** El apalancamiento que se fija no se confirma hasta ver la posición, y el stop tarda en
  verse en el libro: el vigilante le da 10 segundos. Como mucho **dos bots de esta estrategia por
  IP** (`AI_CHANNEL_MAX_BOTS_PER_VENUE`).
- **Aster.** Sin los tramos de apalancamiento firmados de la cuenta, o con la cuenta en modo
  cobertura, no hay entradas. En simulación se usa un solo tramo, la estimación optimista.
- **Funding.** Hyperliquid no publica la hora del cobro y Lighter no publica el funding: la
  ventana previa y el filtro de funding no hacen nada en ellos.
- **Pendiente de medir en real**: la caché del prompt y el coste por consulta. Hasta entonces, el
  cupo diario es la protección.

# 067 — Lo que salió al medir

Mismo banco de pruebas que el 066: motor de backtest de la plataforma (`runReplay`) sobre **12 pares
× 190 días** de velas de 5 min de la API pública de Aster (2.279 días-par), juez de reglas, y el
perfil de costes de Lighter (0 bps de comisión, 2 de deslizamiento) salvo donde se diga.

## M-1 — El canal de banda resuelve el problema de encontrar dónde operar

| | Canal de giros | Canal de banda |
|---|---|---|
| Ticks con canal detectado | 576 (2,1 %) | **14.195 (51,9 %)** |
| Candidatos | 135 | 3.521 |
| **Ofertas** | 18 | **416** |
| Operaciones en el walk-forward | 9 | 57 |

Eso era lo que el 066 dejó abierto, y está resuelto: el bot ya no se pasa meses mirando.

## M-2 — Pero encontrar sitio no es ganar: hicieron falta tres arreglos

La primera medición del canal de banda dio **57 operaciones y R medio −0,210**. El desglose de
salidas señaló dónde se escapaba: **objetivo 11 % (R +2,06), stop 35 % (R −0,88) y cierre por tiempo
54 % (R −0,22)**. Más de la mitad de las operaciones no llegaban a ninguna barrera.

Los tres arreglos, en orden de lo que aportaron:

| # | Qué estaba mal | R medio |
|---|---|---|
| 0 | La primera versión | −0,210 |
| 1 | El cierre podía quedar en el **tercio** del canal, y la regla medida exigía el **décimo** | −0,192 |
| 2 | El juez podía apuntar al **borde opuesto**, que en una banda está a **cuatro sigmas** | **+0,280** |
| 3 | Se exigían **dos confirmaciones**, y la regla medida no exigía ninguna | **+0,310** |

El segundo es el que cambia el signo, y no es un ajuste: es un error conceptual. En un canal de
giros, el borde opuesto es un precio que el mercado ya defendió, y apuntar ahí tiene sentido. En una
banda de Bollinger no hay nada enfrente: el borde opuesto está a cuatro sigmas y llegar hasta él es
la travesía entera del canal. **Revertir a la media ES la operación.** Con el objetivo en la media,
el acierto pasa del 21 % al 42 % y los cierres por tiempo dejan de ser el grueso.

El tercero sorprende menos de lo que parece: las cuatro confirmaciones —mecha, RSI extremo,
divergencia y volumen tranquilo— se diseñaron para un toque de un nivel defendido. En un borde
estadístico filtran sin discriminar: exigir dos en vez de una **reduce las operaciones a la mitad y
empeora el R**.

## M-3 — El veredicto de CA-5

Con los tres arreglos dentro, y el canal de banda solo:

| Configuración | ops | Al mes y par | R medio | t | Acierto | Ventanas + | PnL |
|---|---|---|---|---|---|---|---|
| Banda, dos confirmaciones | 12 | 0,16 | +0,280 | 0,79 | 42 % | 2/6 | +33,60 |
| **Banda, una confirmación** | **26** | 0,34 | **+0,310** | 1,34 | **46 %** | **6/6** | **+80,55** |
| Los tres tipos, dos confirmaciones | 17 | 0,22 | +0,038 | 0,13 | 35 % | 2/6 | +6,44 |
| Banda, costes de Hyperliquid | 0 | — | — | — | — | — | — |

CA-5 pedía tres cosas a la vez:

- **≥ 2 operaciones al mes y par** → **no** (0,50 de serie; cuatro veces por debajo).
- **R medio positivo con t > 2** → **no** (t = 0,90 de serie; 1,34 con solo banda).
- **≥ 4 de 6 ventanas positivas** → **sí** (5 de 6 de serie; 6 de 6 con solo banda).

**Una de tres.** El spec **no cumple CA-5**, y por tanto el canal de banda no se despliega con
dinero real por esta medición.

## Lo que sí se puede decir, y lo que no

Lo que sí:

- El canal de banda **arregla el problema que el 066 dejó abierto**: el bot pasa de 18 oportunidades
  a 416, y de 9 operaciones a 26-57.
- Con los tres arreglos, el signo es **positivo en las seis ventanas temporales**. Eso es un tipo de
  evidencia distinto del estadístico t, y en una muestra pequeña es el más informativo de los dos:
  no es un total que un mes bueno arrastra, es que **ningún mes fue malo**.
- El sentido de los arreglos es **conceptual, no numérico**. El del objetivo en la media sobre todo:
  en una banda no hay nada enfrente a cuatro sigmas, y apuntar allí era pedir la travesía entera.
  Ese razonamiento no depende de esta muestra.

Lo que no, y hay que decirlo igual de claro:

- **26 operaciones no demuestran una ventaja.** Con t = 1,34, la probabilidad de ver esto por azar
  no es despreciable.
- **Tres mandos afinados sobre la misma muestra de 190 días** son tres oportunidades de sobreajuste.
  Los arreglos tienen un porqué conceptual, pero la elección concreta —el décimo, la media, una
  confirmación— se validó dentro de muestra.
- **Sigue siendo una estrategia de venue sin comisión.** Con costes de Hyperliquid, cero
  operaciones. Y la del 066 ya midió que muere a 6 puntos básicos de deslizamiento.

Dicho de una vez: esto es **una hipótesis que merece simulación**, no una ventaja demostrada. Lo que
decide es CA-6, el bot simulado del usuario.

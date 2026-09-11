# Buenas prácticas — antes de poner un céntimo

> Este es el documento que hay que leer primero. Las siete guías de estrategia dan por sabido lo que hay aquí.
> Referencias: [riesgo y liquidación](./riesgo-y-liquidacion.md) · [venues y mínimos](./venues-y-minimos.md) · [simulación y backtest](./simulacion-y-backtest.md) · [comandos, guardas y eventos](./comandos-guardas-y-eventos.md).

---

## 1. Antes de nada

- **Operar con derivados apalancados puede hacerte perder todo tu capital.** La plataforma automatiza
  decisiones; no las hace buenas. El mercado puede moverse en contra, puedes perder la posición, y a veces
  el exchange falla o se retrasa.
- **No custodial.** Tu dinero está en el exchange y no sale de allí. Lo que entregas es una clave de firma
  **sin permiso de retirada**. Si la plataforma desapareciera, tu dinero seguiría donde estaba. **Nunca
  introduzcas tu frase semilla** en ningún formulario: la app la rechaza si lo intentas.
- **Martingala y GridMart con apalancamiento tienen riesgo de ruina real**: el peor caso es la suma de
  todos los niveles multiplicada por el apalancamiento, y aparece en la vista previa **antes** de crear el
  bot. Léelo.
- **La vista previa no es una promesa.** Es la escalera que se tendería y el peor caso si se llenara, con
  los tamaños que de verdad se mandan.

---

## 2. El camino obligatorio

```
Simulación  →  testnet del exchange  →  mainnet con 20 USDC y 1×  →  ver las órdenes en la web del DEX  →  subir capital despacio
```

1. **Simulación** ([cómo](./simulacion-y-backtest.md)): la cuenta «Simulación» se crea sola, sigue precios
   reales y no firma nada. Deja el bot **varios días**, hasta verlo en un movimiento adverso. Aprende la
   bitácora aquí.
2. **Testnet** del exchange: la primera vez que tus claves firman algo. Ojo: en testnet los mínimos pueden
   ser distintos (Lighter exige el doble de cantidad mínima en BTC) y el libro es irreal.
3. **Mainnet con 20 USDC y 1×**: lo justo para que las órdenes superen el mínimo del par. Comprueba en la
   web del exchange que las órdenes del bot aparecen, que un `PAUSE` las retira, que el stop está puesto
   como orden condicional.
4. **Subir capital despacio.** Un bot que ha funcionado con 20 USDC no ha demostrado nada sobre lo que
   pasa con 2.000 en una caída del 15 %.

Antes de arrancar cualquier bot, contesta a tres preguntas: **¿qué hace si el precio sube? ¿si baja? ¿si se
queda quieto?** Si no puedes responder las tres con la guía de la estrategia delante, no lo arranques.

---

## 3. Tamaño mínimo por venue

Cada orden **suelta** tiene que superar el mínimo del par. No el capital: **cada orden**.

| Venue | Notional mínimo | Cantidad mínima (ejemplos) | Paso de cantidad |
|---|---|---|---|
| Hyperliquid | 10 USDC | BTC 0,00001 · ETH 0,0001 · DOGE 1 · kPEPE 1 | Entero en DOGE/kPEPE |
| Lighter | 10 USDC | BTC 0,0001 (testnet 0,0002) · ETH 0,005 · SOL 0,1 | 0,00001 BTC · 0,0001 ETH · 0,001 SOL |
| Aster | 5 USDT | BTC 0,001 · ETH 0,001 · DOGE 1 | Entero en DOGE/1000PEPE |

Regla práctica: **≥ 20 USDC por orden**, porque al redondear la cantidad al paso del venue una orden de 12
USDC puede quedarse en 9,90 y rechazarse. Cómo se traduce por estrategia:

| Estrategia | La orden que hay que vigilar |
|---|---|
| Rejilla clásica / neutral | `capital × apalancamiento / niveles` (en la neutral con multiplicador > 1, la línea del ancla es la más pequeña) |
| DCA temporizado | `importe por compra × apalancamiento` |
| Martingala / GridMart | La **entrada base**: con 6 seguridades y escala 1,6 pesa un 2,3 % del capital. Y en GridMart, `núcleo × % vendido en el nivel 1` |
| Market makers | `tamaño por compra/venta × 0,7` si el perfil es Conservador |

Y una regla específica: con 100 USDC **no dan para 20 niveles**: son 5 USDC por línea. El script de
verificación de esta guía confirma que con los valores de fábrica y 100 USDC todas las rejillas salen
inválidas en los tres venues.

Ver [venues y mínimos](./venues-y-minimos.md) para la tabla completa y lo que hace el motor con una orden
que no cumple.

---

## 4. Apalancamiento y distancia a liquidación

| Apalancamiento | Distancia estimada a la liquidación |
|---|---|
| 1× | sin liquidación práctica |
| 2× | ≈ 49,5 % |
| 3× | ≈ 32,8 % |
| 5× | ≈ 19,5 % |
| 10× | ≈ 9,5 % |
| 18× | ≈ 5,1 % (el máximo que la API acepta) |

- El semáforo de la app: **verde ≥ 25 %, ámbar entre 10 y 25 %, rojo < 10 %**. La API rechaza cualquier
  bot cuya liquidación estimada quede a **menos del 5 %**.
- La estimación usa la tasa de mantenimiento del mercado (la mitad del margen inicial a su apalancamiento
  máximo): en una altcoin de 10× hay cinco puntos menos de distancia que en BTC con el mismo apalancamiento.
- **Recomendación**: 1× o 2× en todo lo que retenga inventario; nunca más de 3× en las que promedian a la
  baja. Un market maker gana céntimos muchas veces: multiplicar el riesgo por diez para ganar los mismos
  céntimos no compensa.
- **Aislado frente a cruzado**: la rejilla neutral y los dos market makers vienen en **cruzado**; una
  posición perdedora en cruzado arrastra el saldo de los otros bots de la cuenta. Aislado si quieres
  compartimentar. No se puede cambiar después.

Todo esto, con las fórmulas, en [riesgo y liquidación](./riesgo-y-liquidacion.md).

---

## 5. El stop-loss nativo

Si rellenas **Stop loss (%)**, el motor coloca una **orden condicional en el propio exchange**, sobre el
precio medio real y con la dirección de la posición real. Se dispara aunque la plataforma esté caída.

| Comando | ¿Conserva el stop? |
|---|---|
| Pausar · Parar manteniendo posición · Recentrar la retícula · pausa por guarda de riesgo | ✅ **Sí** |
| Cancelar órdenes | ❌ Lo cancela |
| Parar y cerrar · Pánico | ❌ Lo cancela **después** de que el cierre haya salido; si el exchange no acepta el cierre, el stop se queda y el bot pasa a pausado avisando en CRITICAL |

**Dónde ponerlo**: en escaleras, por debajo del último escalón; en rejillas, por debajo del precio inferior;
en un DCA, donde reconocerías que la tesis falló. Su tamaño mínimo se mide sobre la posición al precio de
marca, así que cabe siempre que la posición supere el mínimo del par.

Cada evento que deja la posición abierta termina diciendo si queda red: «El stop loss sigue vivo en el
exchange.» / «Atención: la posición queda SIN stop loss.» / «hay un stop loss configurado pero NO consta
colocado». **Lee la coletilla.**

---

## 6. El funding

Los perpetuos cobran o pagan **financiación** periódicamente a quien mantiene posición. **Ninguna pantalla
lo enseña**, ni el backtest lo modela. En posiciones de días (un DCA, una escalera agotada, una rejilla
con inventario) puede ser el mayor componente del resultado. Mira la tasa de financiación del par en la web
del exchange antes de dejar un bot con inventario varios días, y cuenta con ella al fijar el take profit.

---

## 7. Las comisiones

- La comisión real la fija el exchange (y el builder, si lo hay) y llega con cada ejecución: la ves en el
  detalle del bot («coste de comisiones», reparto maker/taker). El simulador y el backtest asumen
  **0,02 % maker y 0,05 % taker**.
- **Maker** (orden colgada que alguien viene a buscar) es barato; **taker** (cruzar el libro) es caro. Las
  rejillas, escaleras y market makers cotizan **post-only** para ser maker; las entradas a mercado del DCA
  y de la martingala son taker.
- Regla: **el paso de la rejilla y el take profit tienen que ser bastante mayores que la suma de las dos
  comisiones**. Un ciclo maker+maker cuesta ≈ 0,04 %; uno taker+maker ≈ 0,07 %. La app avisa por debajo
  de 0,05 % de paso, pero eso es el mínimo aceptable, no un buen valor: pasos del 0,5 % al 1,5 % y take
  profits ≥ 0,5 % es lo razonable.
- En el **Market Maker V2**, «Estimación de comisión» viene a **0** de fábrica: ponla (la app avisa si la
  dejas a 0), o el suelo de beneficio no cubre nada.
- Una operación **en rojo** en el historial del exchange tras un par compra-venta cerrado **es normal**:
  el exchange calcula el PnL contra el precio medio de toda la posición, no por nivel. Lo que importa es
  el `CYCLE_CLOSED` del bot y su PnL.

---

## 8. Cuándo NO usar cada bot

| Bot | No lo uses si… |
|---|---|
| [Rejilla clásica](./grid-classic.md) | el par está en tendencia clara, el paso no cubre comisiones, o el par apenas se mueve |
| [Rejilla neutral](./neutral-grid.md) | el par está en tendencia y no vuelve al ancla, o no vas a poner Exposición máxima |
| [DCA temporizado](./tdca.md) | buscas operaciones rápidas, el par está en caída libre, o piensas apalancarte por encima de 3× |
| [Martingala](./martingale.md) | el par cae y no vuelve, usas apalancamiento alto, o no has mirado el tamaño del último escalón |
| [GridMart](./gridmart.md) | es tu primer bot, quieres algo predecible, o vas a operarlo en Lighter |
| [Market Maker V1](./market-maker.md) | el par es ilíquido o quieres ir «largo» (Intención Long solo pone compras) |
| [Market Maker V2](./market-maker-v2.md) | no vas a poner tu comisión real |
| [Tendencia](./trend-follow.md) | necesitas ver operaciones a menudo, el par lleva meses de lado, o no aguantas que falle seis de cada diez veces |
| [Seguimiento de beneficio](./trailing-profit.md) | el par va y viene sin ir a ningún sitio, no piensas poner stop loss, o esperabas una sola operación (este bot vuelve a entrar al cerrar) |

Y para **todas**: no operes a mano ni con otro bot **el mismo par en la misma cuenta**: el exchange
combina las posiciones y el bot deja de reconocer la suya. No dejes una rejilla con el precio muy fuera de
su rango sin decidir qué hacer con el inventario.

---

## 9. Qué mirar en la bitácora

Se lee de más nuevo a más viejo. Lo **ámbar** (WARN) y lo **rojo** (CRITICAL) es lo que hay que mirar:

| Si ves… | Haz… |
|---|---|
| `RISK_GUARD_TRIPPED` | Lee cuál saltó y la coletilla del stop. El bot está pausado con la posición abierta: decide tú. |
| `LIQUIDATION_NEAR` | Aporta margen («Aportar margen» en el menú del bot, o desde el exchange), cierra parte o cierra todo. Ya. |
| `AUTH_ERROR` | La credencial no vale: revísala. El bot no puede operar. |
| `ORDER_UNVIABLE` repetido | Un nivel no llega al mínimo: menos niveles o más capital. |
| `POSITION_BELOW_MINIMUM` | Un resto que ninguna orden puede cerrar: ciérralo a mano en el exchange. |
| `ORDER_REJECTED` «Post-only rechazada» justo tras un `FILL` | Nada: es la cotización re-queriendo el nivel mientras el precio sigue encima. |
| `FAIR_PRICE_STALE` | El bot anclado a Binance dejó de cotizar; si es por bloqueo geográfico, cambia la fuente. |
| `EXIT_PENDING_MIN_SIZE` | Nada: INFO; la salida se colocará cuando entren más ejecuciones. |

La lista completa con su significado, en [comandos, guardas y eventos](./comandos-guardas-y-eventos.md#4-los-eventos-de-la-bitácora).

---

## 10. Cambiar cosas con el bot en marcha

- 🔥 **En caliente**: se aplica en la siguiente revisión sin tocar órdenes ni posición.
- 🌤️ **En tibio**: cancela y recoloca las órdenes; la posición sigue; pide confirmación. La **forma** de
  una escalera o rejilla (rango, niveles, escalas) **no se puede cambiar con escalones ejecutados** en el
  ciclo: la API lo rechaza y te dice que cierres la posición o esperes al fin del ciclo. Con el ciclo
  limpio, sin problema.
- ❄️ **En frío**: hay que crear otro bot.
- «Recentrar la retícula» solo existe en las escaleras (Martingala y GridMart) y pide confirmación: vuelve a
  tender la escalera entera bajo el precio actual con la posición abierta. En las demás estrategias el menú
  no lo ofrece y el motor lo rechaza diciendo el motivo. «Aportar margen» mueve colateral a la posición
  aislada y, si marcaste contarlo como capital, el capital asignado sube cuando el exchange confirma la
  transferencia, no antes.

---

## 11. Los límites de Lighter

- **60 peticiones por minuto por IP** en la cuenta Standard; al pasarse, una página CAPTCHA durante 60 s.
  El motor gasta un 15 % menos del cupo publicado y reserva un 20 % para escrituras (cancelaciones), pero
  con varios bots en Lighter desde la misma IP el cupo se nota.
- **30 órdenes activas por mercado** (y 10 condicionales pendientes): la vista previa avisa si la rejilla
  tiende más; el exceso lo rechaza el venue orden a orden.
- Las **órdenes a mercado** salen con un 5 % de holgura y quedan pendientes hasta que el sondeo de
  ejecuciones las confirma el canal de cuenta, que desde el spec 036 llega empujado y no por sondeo.

Mientras esos hallazgos estén abiertos: rejillas pequeñas, sin market makers, y comprobar los cierres en la
web del exchange. Detalle en [venues y mínimos](./venues-y-minimos.md).

---

## 12. Checklist final

- [ ] He simulado esta configuración varios días y la he visto en un movimiento adverso.
- [ ] Sé qué hace el bot si el precio sube, baja o se queda quieto.
- [ ] He leído el **peor caso** (capital × apalancamiento en rejillas y escaleras; el tope en los market makers) y lo acepto.
- [ ] Apalancamiento 1× o 2×; distancia a liquidación en verde.
- [ ] Cada orden suelta ≥ 20 USDC.
- [ ] El paso / take profit cubre holgadamente dos comisiones.
- [ ] Stop loss puesto donde toca (o peor caso aceptado a conciencia).
- [ ] El freno propio de la estrategia está configurado: `maxExposure` (neutral), `maxPositionNotional` (DCA), `maxBotPositionValue` (market makers), `maxNotionalCap` (escaleras).
- [ ] En Lighter: ≤ 30 órdenes, y sé lo de las órdenes a mercado.
- [ ] Sé qué comandos conservan el stop y cuáles no.
- [ ] Telegram vinculado para recibir los avisos.
- [ ] Empiezo con 20 USDC.

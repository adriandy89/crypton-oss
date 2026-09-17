# Administración

Lo que ve y lo que puede hacer una cuenta con rol `ADMIN`. Se llega desde **Cuenta →
Administración**; para el resto de usuarios ese enlace no existe, y las rutas responden `403`
aunque se escriban a mano.

Toda la sección está construida sobre una idea: **mirar y contener, nunca disponer del dinero de
nadie**. CRYPTON es no custodial —los fondos están en el exchange y lo que la plataforma guarda es
una clave de firma sin permiso de retirada—, así que un administrador capaz de cerrar la posición
de otro rompería la promesa entera del producto. Por eso lo que sigue es tan corto.

## Las tres pantallas

| Pantalla | Qué da |
|---|---|
| **Actividad** | La bitácora de la plataforma: quién hizo qué, qué falló y desde dónde. Es la de siempre (spec 007). |
| **Usuarios** | Todas las cuentas, con búsqueda por correo o nombre y filtros por estado, rol y si tienen bots. Ficha con perfil, límites de riesgo, conexiones de exchange y recuento de bots. |
| **Bots** | Todos los bots de la plataforma, filtrables por usuario, venue, símbolo, estrategia, estado, simulación y «con error». Detalle con capital, resultado, margen, distancia a liquidación y el último error. |

## Lo que un administrador puede hacer

Sobre una **cuenta**: deshabilitarla, rehabilitarla y cerrarle todas las sesiones.

Sobre un **bot ajeno**, solo dos comandos:

| Comando | Qué hace | Qué conserva |
|---|---|---|
| `PAUSE` | Deja de operar; el bot sigue bajo el motor. | La posición **y** el stop-loss nativo del venue. |
| `STOP_KEEP_POSITION` | Lo saca del motor sin tocar la posición. | La posición **y** el stop-loss nativo. |

Toda acción pide un **motivo**, que se guarda en la bitácora junto a la identidad de quien la
pidió. En el bot afectado queda además un evento con severidad `WARN` que dice que vino de
soporte, y **su dueño lo recibe en el momento**, no cuando abra la pantalla.

## Lo que un administrador NO puede hacer, y por qué

- **Cerrar una posición.** `STOP_AND_CLOSE`, `CLOSE_NOW`, `PANIC` y `TAKE_PROFIT_NOW` venden a
  mercado y realizan el resultado. Convertir la pérdida latente de otra persona en pérdida
  realizada es disponer de su dinero, aunque se haga con buena intención.
- **`CANCEL_ALL_ORDERS`.** Este merece su párrafo porque parece inofensivo y no lo es: cancela
  todas las órdenes del bot en el venue, y el stop-loss **es una orden** —condicional y nativa, que
  sobrevive a que el worker muera y sobrevive a `PAUSE`, pero no a esto—. Sobre un bot con posición
  apalancada abierta, cancelar sus órdenes la deja **desnuda y sin vigilancia**. Es la única
  «contención» capaz de dejar a un usuario peor protegido que antes, así que no está en el panel.
- **Abrir riesgo.** `START`, `RESUME`, `REANCHOR_GRID`, `ADD_SAFETY_NOW` y `ADJUST_MARGIN`
  comprometen margen nuevo.
- **Editar la configuración de un bot ajeno.** Quien puede cambiar el apalancamiento de otro no
  está conteniendo, está operando por él.
- **Cambiar roles.** No hay pantalla ni endpoint. Se hace por SQL, a propósito: es un caso que
  ocurre dos veces al año y una ruta para ello es superficie de escalada de privilegios
  permanente.
- **Ver saldos ni credenciales.** El módulo de administración ni siquiera puede construir un
  adaptador de exchange, que es lo único capaz de descifrar la clave de firma de alguien. De las
  conexiones se ve la etiqueta, el venue, el estado y la referencia pública; del vínculo con
  Telegram, solo si existe.

## Deshabilitar una cuenta **no** para sus bots

Es lo más importante de esta página, porque es lo contrario de lo que casi todo el mundo supone.

Deshabilitar impide entrar, renovar la sesión y reautenticarse, y cierra las sesiones abiertas al
instante. Pero **el motor no consulta ese campo**: los bots de esa persona siguen operando con su
credencial, colocando y cancelando órdenes con normalidad.

Y está bien que sea así. Dejar posiciones abiertas sin motor porque un administrador cerró la
cuenta sería peor que la cuenta abierta: nadie recolocaría el stop ni atendería la escalera.

Si lo que hace falta es que **deje de operar**, hay que ir a sus bots y contenerlos uno a uno. La
ficha de la cuenta dice cuántos tiene vivos justamente para eso.

## Mantenimiento: purgar históricos

La limpieza automática **ya existe y no se toca**: el motor la corre cada hora
(`apps/worker/src/engine/retention.service.ts`) con las retenciones de sus variables —30 días de
series de bots, 90 de eventos, 365 de los graves, 90 de comandos, 180 de bitácora, 365 de la curva
de cartera—. La pantalla de **Mantenimiento** sirve para adelantarla o para afinar un caso
concreto, eligiendo entre 15 días, 1 mes, 3 meses y 6 meses.

| Ámbito | Tabla | Suelo | Qué no toca nunca |
|---|---|---|---|
| Series de bots | `bot_snapshots` | 15 d | Bots en marcha |
| Eventos de bots | `bot_events` | 15 d | Bots en marcha; `ERROR` y `CRITICAL` |
| Comandos ejecutados | `bot_commands` | 15 d | Bots en marcha; los pendientes |
| Curva de cartera | `portfolio_snapshots` | 15 d | Usuarios con algún bot en marcha |
| Backtests | `backtest_runs` | 15 d | — |
| Bitácora | `activity_log` | **90 d** | Las filas `CRITICAL` |

**Ninguna purga puede tocar datos de un bot en marcha.** Es la regla que gobierna la pantalla, y no
es cautela decorativa: los snapshots de un bot que está operando son la gráfica que su dueño mira
en ese momento, y sus eventos recientes lo que consulta cuando algo va raro. El cron sí los purga,
con ventanas largas decididas en un despliegue; una persona pulsando un botón con un selector a
quince días es otra cosa. Para la curva de cartera el ancla es el usuario, así que se salta a
cualquiera que tenga un bot vivo: purgarla le dejaría el selector de un año de su pantalla de
Cartera rotulando un corte que no es.

Los **suelos** los impone el servidor, no la pantalla. El de la bitácora —90 días— es la respuesta
a una pregunta incómoda: un administrador con un botón para borrar `activity_log` puede borrar el
rastro de sus propias acciones. El suelo, la protección de los `CRITICAL` y que la propia purga
quede registrada como acción crítica acotan eso hasta donde se puede.

Cada pasada borra como mucho 50.000 filas, para caber en el tiempo que la API se da a sí misma
para responder. Si queda más, la pantalla lo dice y se vuelve a pulsar: nunca da por limpia una
tabla que no lo está.

Siempre se **cuenta antes de borrar**, con el mismo filtro exacto que usará el borrado, para que el
número que se enseña sea el de las filas que van a desaparecer. **No hay deshacer.**

### Lo que no se purga, ni a mano ni por el cron

- **`bot_orders`, `bot_fills` y `bot_cycles`.** Son tres cosas a la vez: la reconciliación del motor
  —el worker lee órdenes por estado y por ciclo en cada tick—, la contabilidad del PnL realizado, y
  el historial que su dueño ve en la app. No se purgan por antigüedad simple.
- **`bot_config_revisions`.** `bot.config_version` apunta a una de sus filas: borrarla dejaría al
  bot señalando al vacío.
- **`bot_ai_decisions` y `bot_ai_intents`.** Son lo único que explica por qué un bot cambió solo de
  configuración o abrió una operación. El cron solo vacía su parte pesada —el expediente y la
  herramienta— a los 90 días (`RETENTION_AI_DOSSIER_DAYS`).

### Limitación conocida (spec 034)

`backtest_runs` y `backtest_fills` se pueden purgar **a mano**, pero **ningún cron los limpia
todavía**. Hasta que se les dé su propia variable de retención, esa tabla solo se vacía cuando
alguien entra en esta pantalla.

## Lo que queda registrado

Todo. Las acciones (`admin.user.disable`, `admin.user.enable`, `admin.user.sessions_revoke`,
`admin.bot.command`, y desde el spec 059 `admin.ai_channel.entries_open`,
`admin.ai_channel.entries_close` y `bot.ai_channel.pause_button`) se escriben **antes de
responder** y no se pierden en un reinicio. Y también las lecturas: abrir el listado de cuentas o
la ficha de alguien deja su propia fila
(`admin.users.list`, `admin.user.read`, `admin.bots.list`, `admin.bot.read`), porque leer la ficha
completa de una persona es un evento de privacidad y no una consulta cualquiera.

Requiere `AUDIT_LOG_ENABLE=true`. Una consola de administración sin bitácora no debería existir.

## Limitación conocida (spec 033): la revocación depende de Redis

Deshabilitar una cuenta o cerrarle las sesiones invalida sus tokens **al instante**, mediante una
marca por usuario en Redis que se compara contra el momento de emisión del token.

Con **Redis caído**, esa comprobación no se puede hacer, y la API **deja pasar** en vez de cerrarse
—salvo a los usuarios que el proceso ya sabía revocados en el último minuto, a los que sigue
negando el paso—. La decisión es deliberada y es la contraria a la del lease del worker: allí
cerrar evita duplicar órdenes; aquí cerrar no evita ninguna. Con la API respondiendo `401` a todo
el mundo, un usuario con bots operando no podría llegar a su kill-switch ni mandar un `PANIC`, que
es mucho peor que perder la revocación durante un corte.

La degradación queda registrada, con cuántas peticiones pasaron sin comprobar y durante cuánto
tiempo. La palanca es `AUTH_REVOCATION_FAIL_OPEN`; ponerla en `false` cierra la API con Redis, y
solo tiene sentido durante un incidente concreto y sabiendo esto.

Si la marca no se pudo escribir, la pantalla lo dice: la cuenta queda deshabilitada, pero su token
en curso aguanta lo que le quede de vida (`JWT_ACCESS_TTL`, 15 minutos por defecto).

> ⚠️ **Limitación conocida (F-06, abierta a 2026-09-17).** Deshabilitar una cuenta no para sus bots,
> como dice esta ficha… salvo los del **canal con IA**: al siguiente relevo de worker —un despliegue,
> un reinicio, un corte de Redis— el bot queda en ERROR con su posición abierta, sin vigilante ni
> salidas, y en ERROR no admite ni PAUSE ni PANIC.
> **Hasta que se corrija:** antes de deshabilitar a un administrador con bots del canal, ciérralos con
> «parar y cerrar». Estado: `specs/060-revision-057-059/findings.md` § F-06.

## Modo IA: un supervisor que vigila bots vivos (spec 046)

CRYPTON ya tenía un asistente que propone configuraciones **al crear** un bot. Esto es lo
contrario: un supervisor que mira un bot **que ya está operando** —sus parámetros, su rendimiento
real y el estado del par— y decide si esa configuración sigue teniendo sentido.

Se enciende **bot a bot**, y hoy solo puede hacerlo un administrador **sobre un bot suyo**. Con las
variables de entorno sin tocar, la función no existe.

### Dónde se ve y dónde se cambia (spec 053)

Todo lo que sigue solo lo ve una cuenta `ADMIN`; para el resto de usuarios no existe.

- **La pastilla.** En la lista de bots, en la cabecera del bot y en la lista de la consola, cada bot
  con el Modo IA encendido lleva `IA · PROPONE` (manual) o `IA · APLICA` (automático). Dice el modo
  **configurado**, y sale **en gris y con contorno cuando la IA no está actuando**: el interruptor del
  servidor está apagado, el servidor solo deja actuar sobre simulados y el bot es real, está dormida
  tras varios fallos, el bot no está en marcha, o el servidor obliga a proponer aunque el modo sea
  automático. El motivo sale al pasar el ratón, y un lector de pantalla lo lee; en el móvil, el gris
  ya dice que no actúa. En la consola solo sale en **tus** bots: el Modo IA de otros administradores
  no se puede consultar.
- **El panel.** En la pestaña **Ajustes** del bot, encima de los campos: el modo y tres opciones
  avanzadas —cuándo revisa (reloj y eventos, solo reloj o solo eventos), cada cuántos minutos (de 10
  a 1440; vacío es el de la estrategia) y si puede recolocar las órdenes—. Guardar pide un
  **motivo**, que queda en la bitácora, y en automático sobre un bot real avisa de que es **dinero
  real**. El mismo panel está en la ficha del bot de la consola. Si el bot es de una estrategia que
  el Modo IA no cubre y está apagado, el panel no sale.
- **Al crear el bot.** El último paso del asistente, «Revisión», ofrece el mismo modo y las mismas
  opciones, con su motivo. Se enciende **después** de crear el bot, con su propia petición: si falla,
  el bot queda creado igualmente y se dice por qué.
- **El rastro en el bot.** Cambiar el modo deja un evento `AI_MODE` en la bitácora del bot (spec 046,
  R-3, que hasta el 053 no se cumplía), y los cambios de configuración que aplica el supervisor llevan
  la marca **IA** en el historial.

«Propone y espera» necesita que sus sugerencias te puedan llegar: un chat de Telegram **vinculado** y
los avisos del **Modo IA** encendidos (en Cuenta → Telegram, fila que solo ve un administrador). Sin
eso, ni el panel ni el servidor dejan **pasar** a él; un bot que ya estaba en «propone y espera» sí
puede seguir en él y cambiar sus opciones (spec 056). La pantalla usa lo que sabe de tu Telegram en
cuanto lo tocas: vincular o encender esos avisos se nota al volver al bot, sin recargar.

Si lo pierdes después —desvinculas Telegram, pides un código nuevo o apagas esos avisos—, el
supervisor **deja de revisar** tus bots en «propone y espera»: no paga llamadas para escribir
sugerencias que no verías. No se toca nada más, y en cuanto el canal vuelve, el bot se revisa solo.
Mientras tanto, su pastilla sale en gris con el motivo (spec 055). En automático no hace falta: el
cambio se aplica y el aviso es informativo.

### Los dos modos

| Modo | Qué hace |
|---|---|
| **Manual** | Propone y espera. La sugerencia llega a tu Telegram con la lista de parámetros que cambiaría —cada uno con su valor actual y el nuevo— y dos botones —aplicar o descartar—, y el bot no se toca hasta que pulses. Al pulsar, el ajuste se **recalcula contra el mercado de ese momento**: si ya no cabe, caduca y se te dice; si se aplica, el aviso trae los valores que se aplicaron de verdad. |
| **Automático** | Aplica el cambio y te avisa después, con la misma lista. Sigue sin poder cruzar ninguno de los límites de abajo. |

### Qué puede hacer, y qué no

Lo que **sí**: mover cinco perillas —apalancamiento, cobertura, diferencial, crecimiento del tamaño
y cadencia— como mucho **dos posiciones cada una** y **dos perillas por decisión**, y solo si el
cambio pasa exactamente la misma validación que un cambio hecho a mano.

Lo que **no**, pase lo que pase:

- **Tocar el capital, el par, la cuenta o la dirección.** Nunca. Decidir cuánto dinero pones no es
  asunto suyo.
- **Parar, pausar, cerrar una posición o cancelar órdenes.** No emite ni un comando. Si cree que
  hace falta algo de eso, avisa y lo decides tú.
- **Ensanchar o apagar un stop loss.** Solo puede estrecharlo, y con una posición abierta ni eso.
- **Subir el apalancamiento más de un punto** por revisión, ni por encima de tus propios límites.
- **Mover más de dos perillas a la vez.** Una perilla arrastra los parámetros que dependen de ella
  —el diferencial de un market maker V2 son siete— y se mueven juntos. Lo que hace atribuible un
  resultado es cuántas decisiones se toman a la vez, no cuántos parámetros cambian.
- **Con una posición abierta, subir el riesgo o tocar lo que podría cerrarla.** El apalancamiento,
  los tamaños y los topes no suben, el modo defensivo de un market maker no se retrasa, y el stop,
  el objetivo o el retroceso no se mueven. Tampoco baja por debajo de lo ya expuesto el tope de un
  market maker que cierra al tocarlo.
- **Recolocar la escalera con escalones ya ejecutados**, ni tocar un bot que no esté operando.
- **Recolocar las órdenes dos veces en seis horas.** Un cambio que cancela y vuelve a tender las
  órdenes espera seis horas desde el anterior del supervisor. Si lo apruebas tú desde Telegram, no.

- **Mover un parámetro más de un cuarto de su valor por escalón** (la mitad con un movimiento
  doble). Un bot muy lejos de donde el supervisor lo pondría tarda varias revisiones en llegar, y
  eso es deliberado: lo que se hace es ajustar, no reconfigurar.
- **Encender lo que dejaste apagado con un cero.** Un cero es una decisión tuya —«estas órdenes no
  caducan por edad»— y de ahí no se sale por ajuste.

Y una propiedad que conviene conocer: **solo cambia lo que el ajuste significa, y sobre lo que tú
pusiste**. Todo lo que el supervisor no mueva se queda exactamente como lo dejaste, y lo que sí
mueve se **desplaza** desde tu valor: si subiste a mano la distancia de compra a 12 bps y el
supervisor ensancha, pasa a 14, no al valor que él habría puesto desde cero. Los importes se mueven
en proporción, y todo dentro de esa banda de un cuarto por escalón. Subir y volver a bajar te deja
**donde estabas**.

Y si tocas el bot mientras el supervisor está pensando —tarda unos segundos en decidir—, **gana lo
tuyo**: su cambio se calculó sobre la configuración que leyó, así que al ver que ya no es la misma
lo descarta y lo dice en el historial de decisiones. No te deshace una edición.

Y al revés tampoco (spec 055). Si el supervisor aplica un cambio mientras tienes campos a medio
editar en Ajustes, el formulario pasa a la versión nueva **con tus cambios encima** y te lo dice
en la barra de guardar —«la configuración ha cambiado mientras editabas»—. Al guardar se aplican
**solo los campos que editaste**, y lo que cambió el supervisor se queda. Si el cambio llega justo
mientras guardas, el servidor lo rechaza, la pantalla vuelve a poner tus cambios sobre la versión
nueva y te pide que guardes otra vez. Si tocaste el mismo campo que el supervisor, gana lo tuyo, y
el aviso nombra esos campos.

Qué cuenta como editado lo decide la misma regla que usa el servidor para decidir qué cambia
(spec 056): los números se comparan como números, así que escribir `12.5` donde ponía `12.50` no es
una edición, y no se conserva encima de lo que cambió el supervisor.

### Qué parámetros toca cada perilla (spec 054)

Medido sobre el código, no deducido:

- **La exploración.** 374 640 decisiones con las cuatro estrategias, los trece mercados de las
  pruebas, capitales de 40 a 60 000 y tres tipos de mercado. Los bots eran recién creados y
  ajustados a mano.
- **El test que la fija.** Un test (`alcance.spec.ts`) repite la exploración en pequeño y falla si
  un día la IA toca algo que no está en esta tabla.

Los nombres son los del formulario de Ajustes.

| Estrategia | Perilla | Qué puede mover |
|---|---|---|
| Market maker | apalancamiento | apalancamiento, tamaño por compra/venta y valor máximo de la posición; con poco capital, también las capas y el multiplicador de distancia por capa |
| | cobertura | modo defensivo a partir de, modo de alto riesgo a partir de y valor máximo de la posición |
| | diferencial | distancias de compra y de venta, distancia mínima permitida y multiplicador de distancia por capa |
| | crecimiento del tamaño | capas, tamaño por compra/venta, multiplicador de tamaño por capa, sesgo por inventario y multiplicador de distancia por capa |
| | cadencia | intervalo de actualización de órdenes |
| Market maker V2 | apalancamiento | apalancamiento, tamaño por compra/venta e inversión / posición máxima; con poco capital, también los niveles de cotización y el multiplicador de distancia por nivel |
| | cobertura | umbral defensivo, umbral de alto riesgo e inversión / posición máxima |
| | diferencial | distancias de compra y de venta, distancia mínima permitida, multiplicador de volatilidad, multiplicador de distancia por nivel, distancia para reajustar precio y spread dinámico máximo |
| | crecimiento del tamaño | niveles de cotización, tamaño por compra/venta, multiplicador de tamaño por nivel y multiplicador de distancia por nivel |
| | cadencia | intervalo de actualización de órdenes, actualizar órdenes después de y espera tras un fill |
| Tendencia | apalancamiento | apalancamiento y tope de exposición |
| | cobertura | velas del canal de ruptura y eficiencia mínima para entrar |
| | diferencial | stop, en ATR |
| | crecimiento del tamaño | riesgo por operación |
| | cadencia | movimiento mínimo del stop |
| Seguimiento de beneficio | apalancamiento | apalancamiento y tope de exposición |
| | cobertura | beneficio al que empieza a seguir |
| | cadencia | retroceso para salir y umbral para mover el disparador |
| | diferencial y crecimiento del tamaño | nada: esta estrategia no los usa |

Dos lecturas que no son obvias:

- **Más capas, órdenes más pequeñas.** En un market maker, «crecimiento del tamaño» reparte el mismo
  capital entre más capas: sube las capas y **baja** el tamaño de cada orden.
- **Con poco capital, apalancamiento y capas van juntos.** Cuántas capas caben depende del
  apalancamiento: «apalancamiento menos» puede quitar una capa y dejar cada orden **más grande**,
  aunque la exposición total baje.

**Reparaciones.** Con cualquier perilla pueden llegar además tres reparaciones, que el aviso lista
igual que el resto:

- **El apalancamiento baja** al menor de tus topes, el del exchange y 18x. Pasa si lo bajaste
  después de encender el Modo IA. Sin esa reparación, el servidor rechazaría cualquier cambio.
- **En el market maker (V1), la distancia mínima permitida baja** hasta la menor de las dos
  distancias: allí no puede quedar por encima. En el **V2 no se toca** (spec 055): si la pusiste por
  encima de las distancias, es tu suelo, y se queda donde lo pusiste.
- **En los market makers, el multiplicador de distancia sube a 1,05** cuando hay varias capas: con
  1, todas caerían al mismo precio.

**El sentido del diferencial.** Con la perilla del diferencial, las distancias de un market maker y
su distancia mínima solo se mueven **en el sentido pedido**: si «más» las fuera a bajar, se quedan
donde están (spec 055).

- **Por qué pasaba.** En el V2 la perilla reparte el diferencial entre la distancia base y el
  multiplicador de volatilidad, y el generador los movía en sentidos contrarios. Así, «más» llegaba
  a estrechar lo que se cotiza.
- **Qué hace ahora.** Se mueve el resto —el multiplicador, el techo dinámico, el umbral de
  recotización y la separación entre niveles—, que ya va en el sentido pedido.
- **Qué implica en calma.** En un mercado en calma, el diferencial de un V2 puede no ensanchar nada:
  su objetivo está en el suelo por comisiones, y la perilla no tiene nada que mover.

**Lo que no ha cambiado en ninguna de las 241 717 propuestas de la exploración:**

- el capital, el par, la cuenta y la dirección;
- el perfil y todo lo que se deriva de él: la acción al alcanzar el límite, el perfil de riesgo, el
  comportamiento, «ajustar distancia automáticamente» y «usar tamaño normal hasta el máximo»;
- el stop loss, la pérdida diaria máxima y los límites de inventario largo y corto;
- la fuente de precio, la condición de activación, la resolución de las velas, los lados que opera
  una tendencia y los demás campos que exigen crear otro bot;
- en el market maker V2, la estimación de comisión, el buffer de seguridad, el margen mínimo de
  beneficio, el margen del libro y la muestra de volatilidad;
- el spread dinámico, el ajuste de precio por inventario, las velas del ATR y el «solo post-only».

### Cómo es un aviso

Una sugerencia o un cambio aplicado llega así a Telegram, y queda igual en los eventos del bot:

```text
🤖 mi bot (ETH) · simulado — El supervisor propone cambiar 6 parámetros (cobertura: menos; cadencia: menos):
• Umbral defensivo: 70 → 56 %
• Umbral de alto riesgo: 80 → 64 %
• Intervalo de actualización de órdenes: 30 → 35 s
• Actualizar órdenes después de: 300 → 375 s
• Espera tras un fill: 35 → 40 s
• Inversión / posición máxima: 15000 → 12000 USDC
Motivo: …
```

- **Qué dice.** Entre paréntesis, lo que pidió el modelo. En cada línea, el valor de ahora y el
  nuevo, con su unidad; en «cantidad de moneda», el tamaño va en la moneda del par.
- **Cotas.** Como mucho se listan diez parámetros; si hay más, la última línea los cuenta. Si un lote
  de avisos no cabe en un mensaje, llega en varios.
- **Tras aprobar.** El aviso dice «con tu aprobación» y que los valores se recalcularon al aprobar:
  pueden no coincidir con los de la sugerencia si el mercado se movió entre medias.

### Cuándo mira

Cada media hora, y además cuando pasa algo que merece mirarse: un ciclo cerrado, una guarda de
riesgo, un aviso de liquidación, falta de margen o un rechazo grave del exchange. Es lo de fábrica;
las opciones avanzadas del panel dejan solo el reloj, solo los eventos, u otro intervalo. Con «solo
eventos», el intervalo sigue siendo el mínimo entre dos revisiones, y un market maker —que no cierra
ciclos— solo se revisaría ante avisos de riesgo.

**Nunca con cada ejecución.** Para un market maker un fill es su conducta normal —decenas por
minuto— y lo que hay que juzgar es una media, no un evento. Lo que aquí cuenta como «una operación»
es un **ciclo cerrado**. Un market maker no cierra ciclos nunca, así que a él lo revisa el reloj.

Antes de preguntarle nada al modelo se interponen seis filtros:

- el tipo de disparo;
- en «propone y espera», que haya canal para las sugerencias;
- un hueco mínimo entre consultas del mismo bot;
- la coalescencia entre réplicas;
- una huella del estado: si nada material ha cambiado desde la última respuesta, sigue valiendo;
- dos cupos diarios, uno por bot y otro de toda la plataforma.

Cuando cree que hace falta una persona, te avisa **como mucho una vez al día por bot**. Los avisos
repetidos quedan guardados en el historial de decisiones, pero no llegan a Telegram ni al registro
de eventos del bot.

### Qué ve el modelo

Rasgos ya calculados y cuantizados: volatilidad, recorrido típico, tendencia, cómo ha cambiado el
régimen desde que se configuró el bot, su rendimiento —por ciclos, o por **pares casados y su
margen** si es un market maker—, el resultado realizado desde que opera y en las últimas 24 horas,
su exposición y su distancia a liquidación **en porcentajes y tramos**, y **qué cambiaría ahora
mover cada perilla**, calculado con la misma cadena que aplica, para que no pida lo que no tiene
efecto —incluido si hace falta el movimiento doble para que pase algo—. Si el motor lleva un rato
sin escribir el estado del bot, también ve que no lo hay: entonces se decide como si hubiera
posición abierta, que es lo prudente.

De las últimas 24 horas ve solo las **incidencias reales**: avisos y errores. Ni las ejecuciones, ni
los rechazos post-only que son la conducta normal de un market maker, ni las reanudaciones que haces
tú, ni sus propios avisos, ni lo que ninguna perilla arregla —un tick lento por el cupo del exchange,
un apalancamiento que el venue no acepta cambiar con posición abierta—. Y de su historial ve sus **cambios** —aplicados, pendientes o rechazados
por ti—, nunca sus explicaciones: leerse a sí mismo es lo que convirtió un único fallo del modelo en
veinte avisos de «fallos persistentes».

**No ve dinero.** Ni un importe, ni un precio absoluto. Tampoco el nombre ni la nota del bot, que
son texto que escribes tú. Y no emite números: emite desplazamientos sobre bandas, que un generador
determinista traduce a parámetros respetando la retícula del venue y tus límites.

### Si algo falla

Si el modelo no contesta o responde algo que no cumple el contrato, **no se toca nada**. No hay
plan B: aquí un plan B reescribiría la configuración de un bot vivo porque el modelo estaba caído.
Se avisa —como mucho un aviso por bot y hora— y tras cinco fallos seguidos el modo se duerme unas
horas.

Con **Redis caído** el Modo IA se apaga solo: sin poder contar el gasto no se llama a nadie.

### Los interruptores

| Cuándo | Qué |
|---|---|
| Quieres apagarlo todo | `AI_AGENT_ENABLE=false` |
| Quieres que deje de aplicar pero siga sugiriendo | `AI_AGENT_FORCE_MANUAL=true` |
| Quieres que solo actúe sobre bots simulados | `AI_AGENT_DRY_RUN_ONLY=true` (así viene) |
| Quieres apagarlo en un bot concreto | Ajustes del bot → Modo IA → «Apagado» (queda en `OFF`) |
| Quieres más o menos avisos de «revisa este bot» | `AI_AGENT_ADVICE_COOLDOWN_H` (24 horas por defecto) |

### El rastro

Cada decisión queda guardada con el expediente que vio el modelo, lo que propuso y en qué acabó. La
fila **no se borra nunca** —es la única forma de explicar por qué un bot cambió solo—; lo que se
vacía a los noventa días es el expediente, que es el grueso del peso.

Un cambio aplicado aparece en el historial de configuración del bot como cualquier otro, firmado por
el supervisor. **Deshacerlo es volver a la versión anterior**, igual que cualquier cambio a mano.

### Por qué solo sobre bots propios

Porque la regla de esta consola es *mirar y contener, nunca disponer del dinero de nadie*. Un agente
que reescribe la configuración de un bot ajeno la rompería. Al limitarlo a bots propios no es un
administrador operando el bot de otro: es el dueño operando el suyo con una herramienta, y lo que se
puede hacer sobre bots de terceros sigue siendo exactamente lo de antes — pausar y sacar del motor.

## Canal con IA (spec 059)

La estrategia **Canal con IA** (`AI_CHANNEL`) es la única que **solo puede usar un
administrador**, y para todos los demás no existe: no sale en la lista de estrategias, y crearla,
previsualizarla, editarla o arrancarla responde `403`. El rol se lee de la base en cada uno de esos
caminos, así que a quien le retiran el rol deja de poder arrancar su bot en la petición siguiente.
Tampoco la cubren los planes, el ranking, el asesor ni el Modo IA. La guía de la estrategia está en
[ai-channel.md](./ai-channel.md).

El reparto es el del Modo IA: **el worker calcula y ejecuta; la API solo pregunta**. El modelo elige
entre operaciones que ya calculó el motor, con palabras de una lista, y nunca escribe un número.

### Dónde se ve y dónde se cambia

- **La pastilla.** En la lista de bots, en la cabecera del bot y en la lista de la consola, cada bot
  propio del canal lleva la suya: consultando, en sombra, en pausa por fallos, apagada o sin
  entradas. Sale en gris cuando la IA no está consultando. Como la del Modo IA, solo aparece en
  bots propios.
- **El panel.** En el detalle del bot (pestaña Resumen) y en la ficha de la consola: el estado de la
  IA, el mercado, la operación abierta, el día y las decisiones con sus motivos. Desde ahí se pausa
  el bot y se cortan o abren sus entradas.
- **El interruptor global.** En el índice de Administración, debajo de las pantallas. **Corta o abre
  las entradas de todos los bots del canal a la vez**, con motivo obligatorio. Las posiciones
  abiertas siguen con su stop y sus objetivos.
  - Se guarda en Redis (`crypton:ai-channel:entries`). El worker lo lee en cada revisión y, con
    Redis caído, lo da por cortado.
  - La API comprueba lo escrito leyéndolo de vuelta: si Redis no contesta, responde `503` y el
    interruptor no cambia.
  - Queda en la bitácora (`admin.ai_channel.entries_open` o `…_close`, en `WARN`).

### Las rutas

| Ruta | Qué |
|---|---|
| `GET /admin/ai-channel` | Los interruptores y los bots propios del canal, con su lazo y su última decisión |
| `PUT /admin/ai-channel/entries` | `{ abiertas, reason }`: el interruptor global |
| `GET /admin/bots/:id/ai-channel` | El estado de un bot propio: interruptores, lazo, día y últimas cinco decisiones |
| `GET /admin/bots/:id/ai-channel/decisiones` | Las decisiones, de la más reciente hacia atrás (`antes`, `limite` ≤ 50) |
| `GET /admin/bots/:id/ai-channel/decisiones/:intentId` | Una decisión con la herramienta completa que vio el modelo |

Sobre un bot ajeno, `403`; sobre uno que no es del canal, `404`. Esto no amplía lo que un
administrador puede hacer sobre bots de otros.

### El botón de pausa de Telegram

Cada aviso de operación abierta lleva **⏸ Pausar el bot**. El botón lleva un vale opaco, nunca el
id del bot. La API lo canjea:

1. el vale sirve **una vez**, también con varias réplicas, y caduca a las **24 horas**;
2. tiene que ser del usuario del chat;
3. el dueño tiene que seguir siendo administrador habilitado;
4. manda `PAUSE` por el camino de siempre y lo apunta (`bot.ai_channel.pause_button`, `WARN`).

Pausar cancela los objetivos y deja **solo el stop** en el exchange.

### Cuándo pregunta, y qué pasa si falla

- **Solo con una operación lista.** El worker deja la solicitud al cerrar la vela de 5 minutos, y
  caduca un minuto después.
- **La API la reclama** con una escritura condicional: dos réplicas nunca preguntan por la misma.
  Escucha el bus y, por si un aviso se pierde, mira cada 10 segundos. Cada minuto caduca lo vencido.
- **Antes de llamar** comprueba el interruptor del servidor, el dueño, el estado del bot, la pausa
  por fallos, el interruptor global, el plazo, la oferta y los cupos. **El cupo se cuenta antes de
  llamar**, y sin Redis no se llama.
- **Con la IA apagada** la API no llama, pero cierra cada solicitud con su motivo: el panel dice por
  qué el bot no entra.
- **Un fallo** —sin respuesta, o fuera del contrato— no abre nada. Con **cinco seguidos**, ese bot
  deja de preguntar **seis horas** y avisa (como mucho una vez por hora).

### Las variables

| Variable | Por defecto | Qué |
|---|---|---|
| `AI_CHANNEL_ENABLE` | `false` | El interruptor del servidor. Con `false` no se llama a nadie. Usa `OPENROUTER_API_KEY` |
| `AI_CHANNEL_MODEL` | `anthropic/claude-sonnet-5` | El modelo |
| `AI_CHANNEL_REASONING` | `medium` | Esfuerzo de razonamiento (`low`, `medium` o `high`) |
| `AI_CHANNEL_TIMEOUT_MS` | `20000` | Plazo de cada llamada, con tope en 25.000 |
| `AI_CHANNEL_DAILY_LIMIT` | `48` | Consultas al día por bot. Manda el menor entre esto y el campo del bot |
| `AI_CHANNEL_GLOBAL_DAILY_LIMIT` | `400` | Consultas al día de toda la plataforma |
| `AI_CHANNEL_PROMPT_CACHE` | `1h` | Caché de la parte fija del prompt: `1h`, `5m` u `off` |
| `AI_CHANNEL_SHADOW_ONLY` | `false` | Modo sombra: decide y registra, y nunca ejecuta |
| `AI_CHANNEL_CONCURRENCY` | `4` | Consultas a la vez por réplica de la API |
| `AI_CHANNEL_MAX_BOTS_PER_VENUE` (worker) | `LIGHTER=2` | Bots reales del canal por venue. El que no cabe queda en error |

Los contadores del día van por día UTC. El gasto de cada consulta queda en su fila, y el del día en
el panel.

### El rastro

Cada solicitud es una fila de `bot_ai_intents` con su historia (pedida, consultando, decidida,
aceptada, abierta, cerrada, o sin entrada, fallida, descartada o caducada), la herramienta que vio
el modelo, lo que eligió, lo que dijo, el plan que resultó, el modelo, la versión del prompt, lo
que tardó y lo que costó. **La fila no se borra nunca**. La herramienta se vacía a los 90 días
(`RETENTION_AI_DOSSIER_DAYS`), igual que el expediente del Modo IA.

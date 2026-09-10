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

### Limitación conocida (spec 034)

`backtest_runs` y `backtest_fills` se pueden purgar **a mano**, pero **ningún cron los limpia
todavía**. Hasta que se les dé su propia variable de retención, esa tabla solo se vacía cuando
alguien entra en esta pantalla.

## Lo que queda registrado

Todo. Las acciones (`admin.user.disable`, `admin.user.enable`, `admin.user.sessions_revoke`,
`admin.bot.command`) se escriben **antes de responder** y no se pierden en un reinicio. Y también
las lecturas: abrir el listado de cuentas o la ficha de alguien deja su propia fila
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

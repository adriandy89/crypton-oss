# 062 — El canal con IA, listo para operar

Estado: `en curso` · Tipo: `cambio` · Rama: `spec/062-canal-listo-para-operar` (desde `main`,
`c034c98`)

## Objetivo

Cerrar los hallazgos abiertos del 060 que impiden dejar al canal con IA operar solo: los que lo
matan en silencio, los que dejan una posición apalancada sin red, y los que hacen que la pantalla o
los avisos cuenten algo distinto de lo que pasa.

Estará conseguido cuando ninguna de las situaciones normales de una sesión —una operación que se
cierra fuera del bot, un cierre a mercado que no sale a la primera, un relevo de worker, una pausa—
deje al bot muerto, sin stop o mintiendo.

## Contexto

- **La petición.** El usuario, el 2026-09-18, tras desplegar: que el canal esté listo y terminado
  para simulaciones y para dinero real.
- **De dónde sale la lista.** `specs/060-revision-057-059/findings.md`: 63 hallazgos, de los que se
  corrigieron cinco (los tres Críticos, la regresión F-07 y F-15). Aquí entran los que tocan al
  canal y a la red que lo protege.
- **Por qué ahora y no en seguimientos sueltos.** Porque el bot va a operar con dinero real y a 25x:
  lo que queda abierto no son mejoras, son las situaciones en las que hoy se queda parado o sin
  protección.

## Alcance

| Bloque | Hallazgos | Qué |
|---|---|---|
| A · No se queda muerto ni sin red | F-04, F-05, F-06, F-08, F-12 | La intención huérfana, el cierre que no se puede repetir, el candado al readoptar, la orden que Lighter descarta y la guarda de liquidación en pausa |
| B · Las cuentas y los avisos dicen la verdad | F-13, F-14, F-19, F-21, F-22, F-24 | El aviso de la pausa de 6 h, el botón de pausa, el día UTC del 1,5×, la operación cerrada sin barrer, el reparto de objetivos y el stop de emergencia |
| C · Configuración | F-23, F-49 | Booleanos mal tipados y el filtro de funding con 0 |
| D · Lo que se ve | F-44, F-45, F-46, F-47, F-52 | Semáforo de liquidación, cupo, pastilla, «sin análisis» y «cortar entradas» |

## Fuera de alcance

- Los hallazgos que no tocan al canal (F-09 de Tendencia, F-16, F-17 del replay, F-18 del alta).
- Los de configuraciones opcionales que el usuario no usa (F-10 con `slopedWithTrendOnly` apagado,
  F-11 con el falso quiebre encendido): quedan anotados y salen de fábrica apagados.
- La matemática del canal (F-26, F-27, F-28): no impide operar y cambia decisiones, así que va en su
  propio spec con backtest delante.
- Cambiar valores por defecto o la semántica de un parámetro sin decirlo aquí.

## Requisitos

- **R-1 Nada se queda vivo sin dueño.** Con el venue plano y sin operación en vuelo, una intención
  `ACEPTADA` o `ABIERTA` se cierra y el ciclo también, con su aviso. El bot vuelve a operar sin que
  nadie lo toque.
- **R-2 El cierre de emergencia se puede repetir.** El vigilante y la guarda de liquidación pueden
  volver a mandar su cierre dentro del mismo ciclo, y el aviso dice lo que de verdad pasó.
- **R-3 Un relevo de worker no deja un bot en ERROR con posición.** El candado de administrador
  solo decide arranques nuevos; lo que ya opera se adopta en pausa, y lo que se estaba cerrando se
  cierra.
- **R-4 Lighter no bloquea un nivel para siempre.** Un acuse sin id de venue vence como cualquier
  otro pendiente.
- **R-5 Pausado, la posición del canal sigue protegida.** La guarda de liquidación actúa, no solo
  avisa, en las estrategias con apalancamiento por operación.
- **R-6 Los avisos no mienten.** La pausa por fallos se anuncia aunque el minuto anterior hubiera
  otro fallo; el botón de pausa dice si no pudo pausar; una operación cerrada fuera del libro no se
  cuenta como entrada que no se llenó.
- **R-7 Sin cambios de conducta no pedidos.** Ninguna corrección altera un valor por defecto ni la
  semántica de un parámetro, salvo la de R-5, que se anota en las guías.

## Criterios de aceptación

- **CA-1** Cada hallazgo corregido tiene su test, que falla antes y pasa después, y una mutación
  cazada.
- **CA-2** Verificación completa en verde: los seis paquetes, lint, `check:env` y las tres builds.
- **CA-3** Las guías dicen la conducta nueva y los bloques «Limitación conocida» de lo corregido
  desaparecen.
- **CA-4** *(usuario)* La simulación de 48-72 h del 059 y la primera sesión real con capital
  pequeño.

## Riesgos

- **Se toca el motor con bots en marcha.** Cada arreglo va acotado a su camino y con test; las
  estrategias que no son el canal no cambian de conducta salvo donde el hallazgo lo exige, y se dice.
- **La guarda de liquidación en pausa cambia una conducta.** Solo para estrategias con
  apalancamiento por operación —hoy, el canal—, que es donde la guía ya lo prometía.

## Referencias oficiales

Ninguna regla de venue nueva. Las citas de cada hallazgo están en
`specs/060-revision-057-059/findings.md`.

## Lo hecho

Dieciocho hallazgos, catorce commits, uno por corrección salvo dos pares que comparten fichero y
contrato (F-13 con F-14, y los cuatro de la app). Cada uno con su test, que falla antes y pasa
después, y su mutación cazada.

| Bloque | Hallazgo | Qué cambia |
|---|---|---|
| A | F-04 | Una intención que nadie cierra deja de matar al bot: pasados 5 min con el venue plano se cierran ciclo e intención y se avisa (`AI_OPERACION_PERDIDA`). Además, parar cerrando barre las ejecuciones antes de soltar el runner; `cerrar` tiene su propio `try`; el rechazo se escribe antes de olvidar la operación |
| A | F-05 | Cada cierre del motor se lleva su bloque de índices (999→512, buscado en la base), el cierre definitivo del canal no se calla por el mínimo del venue, y el aviso «sin stop» se enfría a uno por minuto y no culpa al exchange |
| A | F-06 | El candado de administrador y el tope por venue deciden ARRANQUES; un relevo readopta, y en pausa si el dueño ya no puede operar. El interruptor de entradas relee el rol |
| A | F-08 | El acuse pendiente de Lighter ya no afirma un id de venue que no tiene, así que la fila vence como cualquier otra |
| A | F-12 | Pausado, la guarda de liquidación de las estrategias con apalancamiento por operación cierra en vez de solo avisar |
| B | F-13 | El aviso de la pausa de 6 h se salta el límite de uno por hora |
| B | F-14 | El botón de pausa mira el vale antes de contestar, y la API avisa en WARN tanto si pausó como si no pudo |
| B | F-19 | La ficha de la consola relee el detalle del dueño con los eventos del bot |
| B | F-21 | Una operación que ya no está en el venue no se confunde con una IOC sin llenar |
| B | F-22 | Lo cobrado del primer objetivo ya no se le quita al segundo |
| B | F-24 | El stop de emergencia de una huérfana se acota a dos tercios del camino a la liquidación |
| C | F-23 | `validateMeta` rechaza lo que no sea un booleano, y el canal lee sus dos interruptores al lado seguro |
| C | F-49 | Las guías dicen que un `maxAdverseFundingBps` de 0 apaga el filtro |
| D | F-44 | El semáforo del canal mide el camino recorrido hacia la liquidación, no la distancia |
| D | F-45 | «Consultas X de N» usa el tope que de verdad aplica |
| D | F-46 | La pastilla mira también el modo y las entradas del propio bot |
| D | F-47 | Las esperas del día ya no dejan la pantalla sin análisis |
| D | F-52 | Cortar las entradas se aplica aunque la configuración ya no valide |

**Verificación (CA-2), en verde:** 8108 tests (shared 202, strategy-core 774, exchange-core 483,
worker 595, backtest 64, API 5990), `pnpm lint` sin errores, `pnpm check:env`, y las tres builds
(app dentro de presupuesto, web, paquetes).

**Lo que este spec NO toca** y sigue abierto en `specs/060-revision-057-059/findings.md`: la
matemática del canal (F-26 a F-28, F-38 a F-43), el replay (F-17, F-29, F-59 a F-61), los cupos y
avisos de la IA en la API (F-31 a F-36), y la limpieza (F-16, F-18, F-20, F-25, F-30, F-37, F-48,
F-50, F-51, F-53 a F-58, F-62, F-63).

**Conducta que cambia y hay que saber:**

- Con el bot **pausado**, el canal ahora **cierra** al acercarse la liquidación (R-5, F-12).
- Un bot del canal cuyo dueño deja de ser administrador habilitado **deja de abrir** en un minuto y
  se adopta **en pausa** en el siguiente relevo, en vez de quedarse en ERROR (F-06).
- `validate` rechaza un booleano que no lo sea en **todas** las estrategias (F-23). Ninguna
  configuración guardada por la app puede tenerlo.
- Hay un evento nuevo, `AI_OPERACION_PERDIDA` (WARN, canal `risk`).

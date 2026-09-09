# 029 — Tareas

## Fase 0 — Línea base

- [x] Rama `spec/029-market-maker-contra-el-libro` creada desde `main` limpia
- [x] `pnpm build:packages`
- [x] `pnpm test` (sin e2e): **5 309 en verde** — shared 92, strategy-core 282, exchange-core 363,
      backtest 31, worker 321, api 4 220
- [x] `pnpm lint`: 0 errores (3 avisos preexistentes en `apps/api`, fuera de este spec)

## Fase 1 — C-0: el `QUOTE_BID#1 SELL` del aviso

- [x] Consulta de solo lectura a `bot_orders` — **la base local está vacía** (0 filas en todas las
      tablas): ese bot no vive en esta máquina. **Queda pendiente para el usuario** contra la base
      real. El fuente de `main` no puede producir esa combinación: `QUOTE_BID` lleva `side: 'BUY'`
      literal (`market-maker.ts`) y el rótulo del aviso sale del mismo objeto que el lado.

## Fase 2 — C-1: el precio se acota al libro · `c97ac4c`

- [x] Tests que fallan primero: venta bajo el bid con inventario al tope, con sesgo 3, compra sobre
      el ask en corto, sin libro, y orden de las capas
- [x] `hayLibro` y `sinCruzarLibro` en `mm-shared.ts`
- [x] Clamp en MM v1 y v2, **antes** de dimensionar la orden
- [x] Sin BBO no se cotiza, y la nota lo dice (v1 y v2)
- [x] Tests de la V2: sin libro y con el centro congelado

      Sorpresa: acotar el **centro** al libro (lo que decía el plan) rompía la congelación de
      `quotedMid` —que existe para no perseguir al precio— y habría recotizado en cada tick,
      disparando el churn que la fase 5 quiere reducir. Se descartó; el clamp por lado basta,
      porque sólo actúa cuando la orden cruzaría de verdad. `centroEnLibro` se eliminó en el acto
      para no dejar código sin uso.

      Tres tests existentes cambiaron de conducta a propósito (ancla manual, fuente externa y
      espera tras un fill): sus precios cruzaban el libro y ahora se pegan al toque.

## Fase 3 — C-2: el bot que no puede reducir inventario lo dice · `d822dda`

- [x] Contador de rechazos por reglas y CRITICAL a los 20 seguidos sin una sola orden aceptada
- [x] La cuarentena distingue `levelKind` y `reduceOnly`
- [x] Una inmediata que reduce se manda como salida definitiva: un cierre no puede quedar en
      cuarentena
- [x] Tests verificados en rojo antes de la corrección

      No se hace lo de «ensanchar la distancia tras el rechazo» que proponía el plan: con el clamp
      de C-1 la orden ya sale pegada al toque, que es lo más colocable que hay. Ensanchar sólo la
      alejaría del libro.

## Fase 4 — C-3: la nota · `f90141d`

- [x] La nota cuenta las cotizaciones vivas en el libro y lo dice sólo cuando no coinciden
- [ ] `stopLossPct` por defecto — **pendiente de decisión del usuario**: cambiar `defaults()` de una
      estrategia lo prohíbe `CLAUDE.md` sin su visto bueno, y falta fijar el valor

## Fase 5 — C-4: cuota de Lighter y prioridad del stop

- [x] Prioridad `critical` en el presupuesto, reclamada por las órdenes con disparador · `236cafa`
- [x] `autoAdjustDistance` deja de puentear la congelación · `f90141d`
- [ ] La saturación del presupuesto deja de ser invisible — **no hecho**
- [ ] Recotizado por capa — **no hecho**
- [ ] Enfriamiento por CAPTCHA por IP — **no hecho**

      Las tres pendientes son de **caudal**, no de un fallo que cueste dinero por sí mismo, y la del
      recotizado por capa cambia la conducta de bots en marcha lo bastante como para merecer su
      propia decisión. Van a spec de seguimiento.

## Fase 6 — C-5: los avisos · `d822dda`, `55a06ca`

- [x] El resumen diario no mezcla simulado con real, y los simulados salen en su línea
- [x] Los avisos marcan el bot simulado
- [x] `STREAM_ERROR` con enfriamiento de 5 min por stream y `STREAM_RECOVERED` al volver
- [x] El post-only de cotización baja a INFO y `MIN_SEVERITY` hace que eso lo silencie de verdad
- [x] `notifier.service.spec.ts` nuevo (5 tests): antes no había ninguno

## Fase 7 — C-6: nada de código muerto · `e93911c`

- [x] `NotifierService.invalidate()` **eliminado**: no lo llamaba nadie y no podía funcionar —la API
      corre en otro proceso—; el TTL de 60 s es lo que gobierna la propagación, y ahora lo dice el
      comentario

      Corregido respecto al plan: `observe()` y `takeOrders()` **no** son código muerto. Los usa el
      adaptador de Aster (`aster.ts:297,379`) desde el spec 020, con tests. El informe que los daba
      por muertos se equivocaba.

## Fase 8 — Documentación · `e93911c`, `195babf`

- [x] `docs/market-maker.md` y `docs/market-maker-v2.md`
- [x] `docs/comandos-guardas-y-eventos.md` y `docs/simulacion-y-backtest.md`
- [x] Guías de la app y etiquetas de `STREAM_RECOVERED`

## Cierre

- [x] Índice de `specs/README.md` actualizado
- [ ] Comprobaciones manuales del usuario (CA-8 y las de `plan.md`)
- [ ] Comparar un backtest de market maker antes y después: los precios cambian a propósito

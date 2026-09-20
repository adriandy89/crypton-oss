# 065 — Tareas

## Fase 0 — Línea base

- [x] Rama `spec/065-ritmo-y-caudal-del-canal` creada desde `main` limpia (`3c18a43`)
- [x] `pnpm build:packages`
- [x] `pnpm test` — **8120 en verde** antes de tocar nada (shared 202, strategy-core 774,
      exchange-core 483, worker 607, backtest 64, api 5990)

> Orden alterado respecto al plan: **R-9 va al final**, no al principio. Instrumentar el
> presupuesto y el limitador antes de reescribirlos obligaba a hacerlo dos veces. La única
> dependencia dura del plan —R-3 antes que R-4— se respeta.

## Fase 1 — R-9 Observabilidad (va primero: es lo único con conducta idéntica)

- [x] `packages/exchange-core/src/caudal-metricas.ts` y su test
- [x] El presupuesto anota lo que hace esperar, y el reinicio va al `jest.setup`
- [x] Vigilante en el worker y en la API, con sus tests
- [x] `TICK_SLOW` dice cuánto fue del presupuesto, o dice que NO lo fue

> **Un desvío del plan.** El limitador no anota. Tras R-4 sus esperas están
> acotadas por el marcapasos y ya no hay bloqueo de cabecera; instrumentarlo
> exigía pasarle el venue, que hoy no conoce, a cambio de medir algo que ya no
> se dispara. Donde se duerme sin límite es en el presupuesto, y ahí sí mide.

## Fase 2 — R-1 El simulador sirve el precio del flujo

- [x] Rojo: «con el flujo vivo, el tick no vuelve a pedirle el precio a la fuente»
      (esperaba 0 llamadas a la fuente, recibía 2)
- [x] Rojo: «sin flujo, cada precio sigue yendo a la fuente y casando» (red del backtest)
- [x] La procedencia en `anotarTicker` y el atajo en `getTicker`
- [x] Reescribir el comentario obsoleto de `account-hub.service.ts:729-739`
- [x] exchange-core 487, worker 607, backtest 64 en verde

## Fase 3 — R-2 La capacidad del depósito

- [x] Rojo: «una ventana de mil velas no exige el depósito lleno ni deja deuda»
- [x] Rojo: «el depósito no puede pasarse del cupo en una ventana de 60 s» (los tres venues)
- [x] `capacidadDe()` y `burstSeconds` a 6
- [x] Medido: las tres series de un bot pasan de **3557 ms a 442 ms**
- [x] exchange-core 493, worker 607 en verde

## Fase 4 — R-3 La cola del presupuesto

- [x] Rojo: «una lectura cara no se muere de hambre entre lecturas baratas»
- [x] Rojo: «una crítica no espera detrás de una cola de lecturas»
- [x] Rojo: «treinta esperas son una consulta a Redis por ciclo» (495 antes, 61 ahora)
- [x] Cola por clave, orden por plazo y servidor único, en memoria y en Redis
- [x] Una crítica interrumpe el descanso del servidor de Redis
- [x] Con Redis caído salen TODOS los que esperaban, no solo la cabeza
- [x] exchange-core 499, worker 607 en verde

> **Dos desvíos del plan, con su motivo.**
>
> 1. **La regla de «adelantar solo si no retrasa» se ha caído.** Es inalcanzable:
>    exigía `fichas >= cabeza.need + suyo`, y si hay tantas fichas la cabeza ya se
>    concede en esa misma pasada. Quedaba como código muerto.
> 2. **El envejecimiento no «sube una clase»: es un plazo.** Subir de clase al
>    envejecer no cambia nada, porque envejecen todos a la vez y el orden relativo
>    se conserva — medido, la lectura seguía saliendo la última de once. Se ordena
>    por `llegada + penalización de clase`, con las críticas siempre delante.

## Fase 5 — R-4 Los dos carriles del limitador

- [x] Rojo: «una llamada colgada no retiene a las de detrás»
- [x] Rojo: «el carril ordenado no solapa dos llamadas» (el nonce de Lighter y de Aster)
- [x] `runLibre()`, marcapasos con reserva de turno, elección por prioridad
- [x] Los tres adaptadores eligen carril; repasados uno a uno los `call()` firmados
      (las tres `limiter.run` directas de Lighter son escrituras firmadas y se quedan)
- [x] `VENUE_MAX_CONCURRENT_READS` en el worker, `.env.example` y compose; `check:env` en verde
- [x] Aster se queda en 1: sus lecturas firman con nonce y sondearlo exige credenciales
- [x] exchange-core 506, worker 607 en verde

## Fase 6 — R-5 La API con freno

- [x] Rojo: «el adaptador público lleva su tope de caudal y su concurrencia»
- [x] `createPublicAdapter` con los dos parámetros
- [x] `MARKETDATA_RATE_LIMIT_PER_SECOND` y `VENUE_MAX_CONCURRENT_READS` en el
      `.env.example` de la API y en el compose; `check:env` en verde
- [x] api 5992 en verde

## Fase 7 — R-6 El tope cuenta los simulados

- [x] Rojo: «los simulados cuentan, pero no le quitan el hueco a uno real»
- [x] `reservarCanal` asimétrico; guías, `.env.example` y compose
- [x] Un test fijaba la regla vieja («un simulado no lo gasta»): reescrito con la
      nueva y partido en dos, para que la asimetría quede fijada por separado
- [x] worker 610 en verde; `check:env` en verde

## Fase 8 — R-7 Las ventanas de velas

- [ ] **Comprobación previa al despliegue (del usuario)**: bots vivos con evidencia
      exigida distinta de «no». Es la única tarea de este spec que no se puede hacer
      desde aquí, y va ANTES de desplegar R-7.
- [x] Rojo: equivalencia del análisis con la serie corta y la larga
- [x] Rojo: para toda la banda de `channelWindowBars`, más de 60 muestras
- [x] `seriesDe` con la fórmula (656 por defecto, 760 con la ventana al máximo)
- [x] `engine.canal.spec.ts` y el contrato de series de `ai-channel.spec.ts`
- [x] Guía de la app y `docs/ai-channel.md`: los días de histórico, con la nota de Lighter
- [x] strategy-core 778, backtest 64, worker 610 en verde

## Fase 9 — R-8 El 1 h no se baja cuatro veces por hora

- [x] Rojo: un intervalo de una hora no se refresca por techo de TTL
- [x] El techo solo se aplica por encima del día, donde no hay cierre alineado
- [x] Seis intentos, no dos, persiguiendo el cierre de un intervalo de una hora
- [x] worker 613 en verde

> Trampa del test: sin pasar `ttlMs`, `candleHistory` usa el techo por defecto de
> 60 s y esa descarga se cuela contándose como un intento de persecución. El
> runner siempre pasa el suyo (`ttlDeSerie`); el test también, ahora.

## Fase 10 — Verificación

- [x] `pnpm build:packages`, `pnpm test` (**8169**, +49 sobre la línea base), `pnpm lint`,
      `pnpm check:env` y el typecheck de la app — el único error de la app,
      `@jsverse/transloco-utils`, es preexistente y de una dependencia que falta
- [ ] `grep -rn "F-" docs/` por si alguna limitación conocida queda cerrada
- [ ] CA-13 manual del usuario tras desplegar API y worker juntos

## Fase 11 — Revisión del spec sobre sí mismo, antes de desplegar

- [x] **Escritura que esperaba de más en Redis.** El servidor duerme entre consultas y solo lo
      despertaba una crítica: una cancelación que llegaba durante ese descanso se quedaba detrás de
      las lecturas. Ahora despierta a quien llega con más prioridad que la cabeza. Con test, y la
      mutación —volver a «solo críticas»— lo pone en rojo.
- [x] **El vigilante borraba los contadores que el motor necesita.** El aviso de ritmo mide restando
      totales, así que una ventana a mitad de tick le daba cero. Totales monótonos y
      `consumirVentana`, que solo pone a cero los máximos.
- [x] **El aviso podía decir más segundos de los que duró la revisión**, porque la espera es de toda
      la IP. Se acota y se dice de quién es.
- [x] **Código muerto:** Aster recibía `maxConcurrentReads` sin usarlo (no tiene carril libre), lo
      que dejaba armada una concurrencia que se activaría sola sobre un camino con nonce. Dos
      umbrales y el vigilante dejan de exportarse.
- [x] **El worker no tenía test del grafo de Nest** — el agujero del spec 049, cerrado solo en la
      API. Se añade, y la mutación (quitar un proveedor) lo pone en rojo.
- [x] **400 líneas de reformateo de markdown** que metió prettier sin que nadie lo pidiera:
      revertidas. El diff de las guías baja de 543 líneas a 32.
- [x] Auditoría, uno a uno, de los caminos firmados de los tres adaptadores: **ninguno va por el
      carril libre**. En Hyperliquid, todo `this.exchange.*` pasa por `callWrite` o por
      `call(..., 'write')`; en Lighter, las cuatro llamadas con `signedWrite` pasan `'write'`.
- [x] Sin migraciones de base de datos, y las dos variables nuevas traen defecto en el compose: un
      `.env` de producción que no las tenga sigue funcionando.

## Resultado

Nueve commits, uno por requisito, en `spec/065-ritmo-y-caudal-del-canal`. Batería completa en
verde: **8174 tests** frente a los 8120 de la línea base.

| Qué | Antes | Después |
|---|---|---|
| Precio de un bot simulado, por revisión | 2 peticiones de `info` (peso 22) por bot | 0 mientras el flujo esté fresco |
| Las tres series de un bot del canal | 3557 ms de espera en el depósito | 442 ms |
| Capacidad del depósito (Hyperliquid) | 34, menos que la lectura de velas (37) | 102 |
| Treinta esperas en Redis | 495 consultas | 61 |
| Una llamada colgada | retenía 10 s a todos los bots del venue | solo a su carril |
| Serie de estructura | 1000 velas, peso 37 | 656, peso 31 |
| Serie de 1 h | 4 descargas por hora | 1 |
| Tope por venue | los simulados se lo saltaban | cuentan, sin quitar hueco a un real |
| Espera en el presupuesto | invisible hasta el aviso al usuario | medida, y avisada un minuto antes |

## Lo que queda, y es del usuario

1. ~~Contar los bots vivos con evidencia exigida distinta de «no».~~ **Ya no aplica**: el usuario
   borra todos los bots para empezar limpio, así que no hay ninguno cuya conducta pueda cambiar.
2. **Desplegar API y worker JUNTOS.** Comparten la clave del depósito en Redis y un proceso viejo
   recorta la capacidad de los nuevos en cada refill. La clave NO se versiona a propósito: dos
   versiones darían dos depósitos sobre la misma IP y ahí sí se podría pasar del cupo.
3. **CA-13**: que en quince minutos —el enfriamiento del aviso— no vuelva ningún `TICK_SLOW`, que
   los cuatro simulados sigan casando órdenes, y vigilar la primera hora los descartes de la consola
   del canal y el ritmo de `bot_ai_intents`.
4. Si hiciera falta volver atrás en caliente: `VENUE_MAX_CONCURRENT_READS=1` desactiva los carriles
   nuevos **sin redesplegar código**. Para eso existe el interruptor.

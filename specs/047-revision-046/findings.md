# 047 — Hallazgos de la revisión del spec 046

Commit base: `aaf5120` · Rama revisada: `spec/046-modo-ia-supervisor` · Fecha: 2026-09-12
Sin sondas a ningún venue: este spec no habla con ninguno.

## Línea base

`pnpm build:packages`, `pnpm test` (97 shared, 504 strategy-core, 381 exchange-core, 31 backtest,
345 worker, 5533 API), `pnpm lint` y `pnpm check:env`: todo en verde antes de empezar.

## Cómo se revisó

Releyendo `spec.md` requisito por requisito contra el código, que es lo que el spec 041 dejó
aprendido: *«los tests genéricos cazan todo lo estructural, pero nada caza un requisito del propio
spec que no se implementó»*. Los ocho hallazgos de abajo salieron así; ninguno lo cazó un test.

**Ninguno es Crítico.** Por la escala de `specs/README.md`, una Crítica exige producir una de cinco
cosas —posición sin stop, exposición duplicada, caída del worker, firma contra host equivocado o
rechazo sistemático de órdenes— y el supervisor no puede provocar ninguna: no firma, no coloca, no
cancela y no manda comandos. Lo que hay son dos **Altas** que hacen que decida peor de lo que el
spec promete, y seis entre Media y Baja.

## Resumen

| ID | Título | Área | Severidad | Estado | Evidencia | Arreglo |
|---|---|---|---|---|---|---|
| F-01 | El cambio de régimen no llega nunca al modelo | supervisor | **Alta** | confirmado | `supervisor.service.ts:745` | S |
| F-02 | El historial que ve el modelo cuenta los fallos como opiniones | supervisor | **Alta** | confirmado | `supervisor.service.ts:718` + `fallo()` | S |
| F-03 | La columna `model` guarda el nombre de la variable | supervisor | Media | confirmado | `supervisor.service.ts:310` | S |
| F-04 | Aprobar desde Telegram no recalcula, contra lo que dice R-23 | supervisor | Media | confirmado | `canjearVale()` vs `spec.md:185` | M |
| F-05 | El disparador `OPERACION` se guarda y no se respeta | supervisor | Media | confirmado | `pendientesDeRevision()` | S |
| F-06 | Un aviso queda pendiente para siempre | supervisor | Media | confirmado | `aplicarDecision()` | S |
| F-07 | El expediente no mira si el estado del bot es reciente | supervisor | Media | confirmado | `expedienteDe()` | S |
| F-08 | `AI_AGENT_REVIEW_TTL_S` no la lee nadie | entorno | Baja | confirmado | `grep` en `apps/api/src` | S |

---

## F-01 — El cambio de régimen no llega nunca al modelo · **Alta**

**Síntoma.** La línea que el propio spec llama «la que de verdad decide» —cuánto ha cambiado la
volatilidad **desde que se configuró el bot**— no aparece jamás en el prompt.

**Evidencia.** `apps/api/src/modules/supervisor/supervisor.service.ts:745` pasa
`mercadoAlConfigurar: null` sin excepción. `dossier.ts:157` solo compone `cambioDeVolatilidad`
cuando ese valor no es nulo, así que la rama está muerta:

```ts
mercadoAlConfigurar: null,
```

El test de `dossier.spec.ts` **sí** lo cubre… porque el test lo rellena a mano. Por eso pasó.

**Impacto.** El supervisor decide sin lo único que responde a la pregunta que tiene delante. Un bot
no está mal configurado en abstracto, lo está **respecto de cuándo se configuró**; sin esa línea el
modelo ve la volatilidad de hoy y no tiene con qué compararla, así que juzga por valores absolutos
—que es exactamente lo que el expediente cuantizado intenta evitar—. Y el prompt de sistema le pide
explícitamente que mire ese cambio (*«si la volatilidad ha subido claramente desde que se
configuró»*), de modo que se le pregunta por un dato que no se le da.

**Propuesta.** Guardar los rasgos del par al sembrar las perillas (hay sitio natural: la fila de
`bot_ai_settings` ya guarda `knobs`, y el `last_bucket`) y pasarlos al expediente. Con un test que
falle si el prompt renderizado no lleva la línea cuando hay referencia.

---

## F-02 — El historial que ve el modelo cuenta los fallos como opiniones · **Alta**

**Síntoma.** Cuando el modelo no contesta o se sale del contrato, la fila se guarda con
`action: 'AVISAR'`. El historial que se le enseña en la siguiente revisión filtra por
`action != 'MANTENER'`, así que **le devuelve sus propios fallos como si fueran decisiones suyas**.

**Evidencia.** `fallo()` escribe la fila con datos que no son ciertos:

```ts
mode: AiMode.OFF,          // el bot estaba en MANUAL o AUTO
action: 'AVISAR',          // el modelo no dijo nada: no contestó
knobs_before: {} as never, // las perillas existen
config_version_before: 0,  // la versión real es otra
```

Y `supervisor.service.ts:718` las recoge:

```ts
where: { bot_id: bot.id, action: { not: 'MANTENER' } },
```

**Impacto.** Tres fallos seguidos de OpenRouter hacen que el modelo lea «AVISAR hace 10 minutos,
AVISAR hace 40 minutos, AVISAR hace una hora» y concluya que ya avisó tres veces de algo. El spec
dice que ese historial «es lo que impide el vaivén»; contaminado, lo provoca. Y las `DESCARTADA`
entran igual, así que también lee como hechos ajustes que nunca se aplicaron.

Además el histórico queda mintiendo para siempre en cuatro columnas, y es el histórico que se mira
cuando hay que explicar por qué un bot cambió solo.

**Propuesta.** Que `fallo()` escriba lo que de verdad pasó (el modo real, las perillas reales, la
versión real) y una acción propia que no se confunda con una decisión. Y que el historial del
expediente se limite a las decisiones **aplicadas o pendientes**, que son las únicas que el modelo
puede considerar suyas.

---

## F-03 — La columna `model` guarda el nombre de la variable · Media

**Síntoma.** `bot_ai_decisions.model` guarda la cadena literal `'AI_AGENT_MODEL'` en todas las
filas, en vez del modelo que tomó la decisión.

**Evidencia.** `apps/api/src/modules/supervisor/supervisor.service.ts:310`:

```ts
model: 'AI_AGENT_MODEL',
```

**Impacto.** La columna existe para poder comparar decisiones tomadas por modelos distintos —el
esquema lo dice: *«comparar decisiones de versiones distintas tiene que poder VERSE, no
adivinarse»*— y no sirve para nada. El día que se cambie el modelo, el histórico no dirá cuál
decidió qué, que es justo cuando hace falta.

**Propuesta.** Exponer el modelo efectivo desde `OpenRouterClient` y guardarlo.

---

## F-04 — Aprobar desde Telegram no recalcula, contra lo que promete R-23 · Media

**Síntoma.** R-23 dice que al pulsar el botón «se **recalcula contra el mercado de ahora**». No se
recalcula: se aplica la configuración guardada cuando se propuso, hasta una hora antes.

**Evidencia.** `canjearVale()` pasa directamente lo almacenado:

```ts
config: decision.proposed_config as never,
```

No hay llamada a `contextoDe()` ni a `decidirCambio()` en ese camino. Lo que sí se comprueba es que
`config_version` no haya cambiado.

**Impacto.** Menor de lo que parece, y conviene decirlo con precisión: los campos que el supervisor
mueve son distancias en puntos básicos, tamaños y umbrales, no precios absolutos, así que una hora
de desfase rara vez los invalida. Y `updateConfig` revalida con `validate()` contra el mercado
actual. Pero **no** pasa por `preview()`, que es lo único que detecta violaciones de tick, paso y
notional mínimo, de modo que la comprobación que el requisito prometía no está.

Lo que sí es un problema sin matices: **el spec y la documentación afirman algo que no ocurre**.

**Propuesta.** Dos salidas legítimas. La barata: corregir R-23 y `docs/administracion.md` para que
digan lo que de verdad pasa —se comprueba la versión, no se recalcula—. La cara: recalcular de
verdad desde las perillas guardadas, que es una llamada a `contextoDe` + `decidirCambio` sin pasar
por el modelo. La segunda cumple lo prometido y cuesta poco, porque las perillas ya están en la
fila.

---

## F-05 — El disparador `OPERACION` se guarda y no se respeta · Media

**Síntoma.** `bot_ai_settings.trigger` admite `PERIODICO`, `OPERACION` y `AMBOS`. El barrido
periódico no lo mira, así que un bot configurado como `OPERACION` —«revísame solo cuando cierre un
ciclo»— se revisa igualmente cada media hora.

**Evidencia.** `supervisor.scheduler.ts:88` respeta el mando en un sentido:

```ts
if (ajuste.trigger === 'PERIODICO') return;
```

pero `SupervisorPolicyService.pendientesDeRevision()` no incluye `trigger` en su `where`.

**Impacto.** Un mando a medias, que es la definición de Media en la escala. Quien elija `OPERACION`
para gastar menos gastará lo mismo, y no habrá nada que se lo diga.

**Propuesta.** Añadir `trigger: { in: ['PERIODICO', 'AMBOS'] }` a la consulta del barrido, con test.

---

## F-06 — Un aviso queda pendiente para siempre · Media

**Síntoma.** Una decisión `AVISAR` se guarda como `PROPUESTA` con `expires_at: null`. El cron que
caduca las propuestas filtra por `expires_at: { lt: new Date() }`, así que nunca la toca.

**Evidencia.** `aplicarDecision()`:

```ts
state: revision.accion === 'AVISAR' ? AiDecisionState.PROPUESTA : …,
expires_at: revision.accion === 'AVISAR' || descartada ? null : …,
```

**Impacto.** Se acumulan filas `PROPUESTA` que nadie va a resolver, porque un aviso no tiene nada
que aprobar. Ensucian cualquier vista de «qué hay pendiente» y, si algún día se cuentan las
pendientes para decidir algo, contarán de más. Se limpian solo si llega otra propuesta sobre el
mismo bot, que es casualidad, no diseño.

**Propuesta.** Un aviso no es una propuesta: darle su propio estado terminal al escribirlo.

---

## F-07 — El expediente no mira si el estado del bot es reciente · Media

**Síntoma.** La posición, la exposición y la distancia a liquidación salen del último
`bot_snapshot`, sin comprobar de cuándo es.

**Evidencia.** `expedienteDe()` toma el más reciente y punto:

```ts
this.db.botSnapshot.findFirst({ where: { bot_id: bot.id }, orderBy: { taken_at: 'desc' } }),
```

**Impacto.** Los snapshots se escriben cada pocos ticks y se purgan a los 30 días, así que un bot
que estuvo parado y volvió a arrancar, o cuyo worker tuvo un hueco, presenta ante el modelo una foto
de hace horas **como si fuera de ahora**. El expediente no lo dice, y todo lo demás sí es actual, de
modo que el modelo mezcla dos momentos sin saberlo.

**Propuesta.** Descartar el snapshot pasado un umbral y decir «sin dato reciente», que es lo que el
resto del expediente ya hace cuando falta algo. Es el mismo criterio que aplica `MarketDataService`
con `STALE_MS`.

---

## F-08 — `AI_AGENT_REVIEW_TTL_S` no la lee nadie · Baja

**Síntoma.** La variable está declarada en los tres sitios, documentada con un párrafo en
`.env.example`, y no la lee ninguna línea de código.

**Evidencia.** `grep -rl AI_AGENT_REVIEW_TTL_S apps/api/src` no devuelve nada. `pnpm check:env` la
reporta como «declarada y no leída», que es informativo y no falla.

**Impacto.** Quien la configure creerá que ajusta algo. El caché de decisión acabó implementándose
con `last_bucket` en la fila, que no caduca por tiempo: mientras el régimen no cambie, no se vuelve
a preguntar, y eso es lo correcto, pero no es lo que la variable dice.

**Propuesta.** Quitarla de los tres sitios. Si alguna vez se quiere que una decisión caduque por
tiempo aunque el régimen no cambie, se vuelve a añadir con código detrás.

---

## Verificado OK

Lo que se revisó y **sí** hace lo que el spec dice:

- **La frontera del spec 033.** Tres puertas independientes, y las tres cerradas: al activar, al
  leer y en la consulta del barrido (`role: ADMIN`, `disabled: false`).
- **No hay un segundo camino de escritura.** `aplicar()` es el único punto que escribe configuración
  y va por `BotsService.updateConfig`. El supervisor no emite ni un comando.
- **El contrato con el modelo.** Ni un `minimum`, ni un `maximum`, ni un `number`; todo en
  `required`; el perfil no está. `parseRevision` no repara: tira la respuesta entera.
- **El expediente no lleva dinero ni texto del usuario**, y `name`/`note` no están siquiera en el
  tipo de entrada.
- **Los topes de `apply.ts`**, incluidos los dos que solo se ejercitan desde sus tests directos.
- **El vale de Telegram**: opaco, de un solo uso por `getDel`, atado al dueño, y con la
  comprobación de versión al canjear.
- **`FILL` no dispara nunca**, y `CYCLE_CLOSED` sí.
- **Con Redis caído no se llama al modelo**, y sin cupo tampoco.

## Preguntas abiertas

1. **F-04**: ¿corregir el texto o recalcular de verdad? Recalcular cumple lo prometido y cuesta
   poco; corregir el texto es honesto y no toca código que ya funciona.
2. **El tope de cambios diarios se aplica también a una aprobación manual.** Un usuario que pulsa
   «aplicar» en Telegram puede encontrarse con que su séptimo cambio del día se descarta en
   silencio. El tope se diseñó para frenar al automático. No se anota como hallazgo porque es una
   decisión de producto, no un defecto: hace falta que el usuario diga cuál quiere.

## Specs de seguimiento propuestos

Si el usuario prefiere no tocar el 046 antes de mergearlo, los ocho hallazgos caben en un solo spec
de corrección. La alternativa —y la recomendación— está en `spec.md`: **el 046 no está mergeado**,
así que corregirlo dentro es más barato que mergear algo que ya se sabe defectuoso.

---

# Segunda pasada (spec 047, tanda G)

Commit base: `c528e9a` · Fecha: 2026-09-12

Revisión de las **correcciones** de la primera tanda, más las zonas que aquella no miró. Seis
hallazgos, **tres Altas**, y conviene decir lo incómodo primero: **dos los introduje al corregir la
primera tanda**. Es exactamente lo que el riesgo declarado en `spec.md` anticipaba —«corregir ocho
cosas a la vez sobre código recién escrito puede introducir defectos nuevos»— y la razón por la que
una segunda pasada no es una formalidad.

| ID | Título | Severidad | Origen | Evidencia |
|---|---|---|---|---|
| G-01 | Aprobar desde Telegram se salta `allow_warm` | **Alta** | F-04 | `rehacer()`: `permitirWarm: true` |
| G-02 | La referencia del cambio de régimen puede ser inventada | **Alta** | F-01 | `rasgosDe()` |
| G-03 | El modo manual sin Telegram no tiene salida, y nada lo dice | **Alta** | 046 | `setAiMode()` |
| G-04 | El canje no comprueba el estado del bot | Media | 046 | `canjearVale()` |
| G-05 | La fila no refleja lo que de verdad se aplicó | Media | F-04 | `canjearVale()` |
| G-06 | Un aviso se guarda como `APLICADA` | Baja | F-06 | `aplicarDecision()` |

---

## G-01 — Aprobar desde Telegram se salta `allow_warm` · **Alta**

**Síntoma.** `allow_warm: false` significa «el supervisor solo propone cambios HOT, nunca recoloca
la escalera». Al recalcular en el canje se pasa `permitirWarm: true` fijo, así que una aprobación
desde Telegram **puede aplicar un WARM a un bot cuyo dueño lo había prohibido**.

**Evidencia.** `rehacer()` no lee el ajuste del bot:

```ts
permitirWarm: true,
```

**Impacto.** Un WARM cancela las órdenes del bot y las vuelve a tender: cuesta comisiones de verdad,
que es precisamente por lo que existe el interruptor. Se viola un mando **explícito** del usuario, y
se viola justo en el camino que él creía más controlado —el que pasa por su propia aprobación—.

Es un efecto secundario de F-04: al mover la traducción del momento de proponer al momento de
aplicar, el parámetro se quedó atrás.

**Propuesta.** Leer `allow_warm` de la política y pasarlo. Con test.

---

## G-02 — La referencia del cambio de régimen puede ser inventada · **Alta**

**Síntoma.** Si al activar el Modo IA el par no tiene velas suficientes, `rasgosDe()` devuelve unos
rasgos **por defecto** —inventados— y desde F-01 eso se guarda en `features_at_enable`, que es la
referencia contra la que se mide el cambio de régimen.

**Evidencia.** `supervisor.policy.service.ts`:

```ts
return rasgos ?? { mark: 0, volAnnualPct: 60, atrPct1h: 0.5, atrPct1d: 3, … };
```

**Impacto.** El expediente puede decirle al modelo «el par se mueve 3 veces MÁS que cuando se
configuró» comparando contra un número que nadie calculó. Y es peor que no decir nada: el prompt
presenta esa línea como un hecho medido, el modelo la usa para decidir si ensancha o estrecha, y no
hay forma de que sospeche.

El respaldo era razonable cuando esos rasgos solo servían para **sembrar perillas** —ahí un valor
aproximado es tolerable, porque las perillas son un punto de partida—. Como **referencia de
medida** no lo es. Lo cambió F-01 sin que yo revisara el respaldo.

**Propuesta.** Guardar `null` cuando no hay rasgos reales. El expediente ya sabe callarse: sin
referencia no emite la línea, que es exactamente lo que debe pasar.

---

## G-03 — El modo manual sin Telegram no tiene salida, y nada lo dice · **Alta**

**Síntoma.** En modo `MANUAL` las sugerencias se notifican por Telegram y se aprueban con sus
botones. Si el administrador **no tiene Telegram vinculado**, la sugerencia se escribe en la base y
no llega a ninguna parte: no hay aviso, y la cola en la app quedó aplazada. El modo aparece
encendido y no pasa nada nunca.

**Evidencia.** `setAiMode()` no comprueba `telegram_links`, y `admin-bots.service.ts` de la app no
tiene ningún método de decisiones. La única vía de aprobación es el botón.

**Impacto.** La mitad de la funcionalidad —el modo que el usuario pidió expresamente para «revisar
antes»— no funciona en un caso perfectamente normal, y el síntoma es el peor posible: **silencio**.
Quien lo encienda concluirá que el supervisor no propone nada, no que le falta vincular un chat.

**Propuesta.** Al activar `MANUAL` sin vinculación, decirlo. Dos formas legítimas: rechazar con un
mensaje que explique qué falta, o dejar activarlo y devolver un aviso claro. Lo que no vale es
callar.

---

## G-04 — El canje no comprueba el estado del bot · Media

**Síntoma.** R-13 dice que el supervisor nunca actúa sobre un bot que no esté `RUNNING`. El canje
comprueba el vale, el dueño, el estado de la decisión y la versión de configuración — pero no el
estado del bot.

**Evidencia.** El `include` de `canjearVale()` ni siquiera trae `status`.

**Impacto.** Entre proponer y aprobar pueden pasar sesenta minutos, y en ese rato el bot puede haber
entrado en `ERROR` o haber sido liquidado. Aplicar entonces es justo lo que R-13 prohíbe: con el
adaptador averiado la configuración no es el problema.

**Propuesta.** Traer `status` y negarse, diciendo por qué.

---

## G-05 — La fila no refleja lo que de verdad se aplicó · Media

**Síntoma.** Tras F-04 el canje **recalcula**, pero la fila sigue guardando `proposed_config`, `diff`
y `apply_level` de cuando se propuso. Se aplica una cosa y el historial cuenta otra.

**Impacto.** Es el mismo defecto que F-02 en versión suave: el histórico de decisiones existe para
explicar por qué un bot cambió, y si lo aplicado no es lo anotado, explica mal. La diferencia entre
lo propuesto y lo recalculado será casi siempre pequeña — pero «casi siempre» no es una propiedad.

**Propuesta.** Al aplicar, actualizar la fila con lo recalculado.

---

## G-06 — Un aviso se guarda como `APLICADA` · Baja

**Síntoma.** Al corregir F-06 se le dio a los avisos el estado `APLICADA` para que dejaran de quedar
pendientes. Pero un aviso no aplica nada.

**Impacto.** Hoy ninguno: el estado solo se usa para el historial del modelo, donde un aviso debe
entrar porque **sí** es una opinión suya. El problema es el día que alguien cuente las `APLICADA`
como «cambios que hizo el supervisor»: contarán de más, y nada avisará.

**Propuesta.** Un valor propio en el enum (`AVISADA`). Es `ALTER TYPE … ADD VALUE`, la misma
migración de una línea que los specs 040 y 043.

---

## Decisiones del usuario sobre la tanda G

- **G-03**: se **rechaza** activar `MANUAL` sin Telegram vinculado, con un mensaje que dice qué
  falta y dónde. El modo `AUTO` no lo necesita —avisa después, no espera a nadie— y apagar tampoco,
  porque negárselo a quien no tiene Telegram lo dejaría atrapado.
- **G-06**: estado propio `AVISADA`, con su migración de una línea. El historial del modelo lo sigue
  viendo, porque un aviso sí es una opinión suya; lo que deja de pasar es que cuente como un cambio.

Los seis quedan corregidos con su test. La cola de decisiones en la app sigue aplazada: con G-03
resuelto, el modo manual ya no puede quedarse sin salida.


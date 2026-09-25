# Specs — desarrollo dirigido por especificación (SDD)

Este directorio es la **constitución** del proyecto y el índice de todo lo que se ha decidido
hacer. Ningún cambio de código nace fuera de un spec. Un spec es un contrato corto: qué se va a
hacer, por qué, cómo se sabrá que está hecho, y qué se decidió por el camino.

Se mantiene a mano, en castellano, sin herramientas externas. Copiar `_template/` es todo lo
que hace falta para abrir uno.

> **Edición open source.** Estos specs nacieron en el repositorio privado del que deriva esta
> edición y se portan tal cual, como registro de lo que se decidió y por qué. Algunas referencias
> no existen aquí: `Resume.MD`, `apps/web`, el módulo de planes y suscripciones, y las migraciones
> anteriores a `0_init`. Los hallazgos y las correcciones sí aplican: el código es el mismo.
>
> Por eso falta el **032**, que era entero sobre el sitio web público y sus planes: aquí no habría
> nada que hacer con él. La numeración se conserva para que un spec se llame igual en los dos
> repositorios.
>
> Los specs que solo existen en esta edición se numeran aparte, **`oss-NNN`**, para no pisar esa
> numeración, y tienen su propia tabla al final del índice.

## Principios

1. **El dinero manda.** Nada que toque `strategy-core`, `shared`, `exchange-core` o el motor del
   worker cambia sin un test que lo cubra. Si un cambio no se puede probar, no se hace.
2. **`Decimal` y `string`, nunca `number`.** Es el invariante 1 de `CLAUDE.md` y aquí solo se recuerda.
3. **Hallazgo → spec → corrección.** Un problema encontrado no se arregla al vuelo: se anota con
   evidencia, se clasifica, y se corrige dentro del spec que lo autoriza.
4. **Evidencia o no existe.** Un hallazgo lleva `fichero:línea` y, cuando contradice a un venue,
   la cita literal de su documentación oficial con URL y fecha de consulta.
5. **Lo que no está en un spec no se hace.** Refactors oportunistas, subidas de versión y
   «ya que estoy» son specs aparte o no son.
6. **No cambiarle la conducta a un bot en marcha.** Ningún cambio de valor por defecto ni de
   semántica de un parámetro de usuario sin decisión explícita del usuario.

## Ciclo de vida

`borrador` → `aprobado` → `en curso` → `hecho` → `cerrado`

- **borrador**: escrito, sin revisar.
- **aprobado**: el usuario ha leído `spec.md` y `plan.md` y ha dado el visto bueno.
- **en curso**: hay trabajo en la rama `spec/NNN-slug`.
- **hecho**: todos los criterios de aceptación cumplidos y verificados.
- **cerrado**: mergeado o descartado, con la decisión anotada.

## Estructura

```
specs/
  README.md              ← esto
  _template/             ← se copia para abrir un spec
    spec.md              qué y por qué: alcance, requisitos R-n, criterios de aceptación CA-n
    plan.md              cómo: enfoque, ficheros, fases, verificación
    tasks.md             checklist ejecutable por fase
    findings.md          solo en specs de revisión: hallazgos con severidad y evidencia
  NNN-slug/              un directorio por spec, numerado y con nombre corto
```

Numeración: tres cifras correlativas. El slug es corto, en minúscula, con guiones.

## Escala de severidad

La severidad es del **efecto**, nunca del tamaño del arreglo. Se aplican las reglas en orden y
gana la primera que case.

| Nivel | Regla de decisión | Qué pasa |
|---|---|---|
| **Crítica** | Deben cumplirse **las tres**: (1) alcanzable en operación normal con una configuración válida; (2) produce una de: posición **sin el stop-loss configurado** (o stop con lado, precio o tamaño erróneos), **órdenes o exposición duplicadas** (idempotencia por `clientOrderId` rota, dos runners en un bot), **caída del worker entero**, **firma contra la red u host equivocados**, o **rechazo sistemático de toda orden en un venue** en producción; (3) **confirmada**: test que falla, o cita de la doc oficial y sonda pública que coinciden. Sin (3) se anota «Crítica (por confirmar)» y **no** dispara cambios. | Se corrige dentro del spec de revisión, con el protocolo de abajo. |
| **Alta** | Pérdida acotada o probabilística (churn de comisiones o caudal, redondeo que rechaza en algunos mercados, bot muerto en un venue o configuración); error contable silencioso que alimenta PnL, equity o una guarda; red de seguridad documentada que es código muerto; riesgo de baneo por IP; errores `AUTH`/`THROTTLED` tragados. | Spec de seguimiento prioritario. |
| **Media** | Degradación visible sin pérdida: parámetros muertos o a medias, deriva entre app, API y advisor, comando no idempotente de efecto acotado, documentación que confunde la operación. | Spec de seguimiento. |
| **Baja** | Nombres, logs, tests que faltan sin evidencia de fallo, `README`/`Resume.MD` desfasados. | Lote de limpieza. |

Modificadores: si solo afecta a simulación (paper/DryRun) o solo a testnet, baja un nivel. Empate
entre Crítica y Alta → Alta más spec de seguimiento; el usuario puede subirla.

## Protocolo de corrección de una Crítica dentro de un spec de revisión

Precondiciones: el hallazgo tiene id (`F-NN`), evidencia (`fichero:línea` y cita), un *contrato
de arreglo* en `findings.md` (conducta esperada, ficheros que se tocan, nombre del test) y el
usuario ha aprobado la lista de críticas a corregir.

1. **Confirmar**: un test que falla **por el motivo declarado**, colocado junto al código
   (`pnpm --filter <paquete> test -- <fichero>`), o cita oficial más sonda pública que lo demuestren.
2. **Enseñar antes de aplicar**: id, `git diff`, salida del test antes y después, y radio de
   impacto (quién llama a lo que cambia). Esperar aprobación explícita.
3. **Diff mínimo**: alrededor de 50 líneas como mucho, sin dependencias nuevas, sin cambiar firmas
   entre paquetes, sin cambiar valores por defecto que alteren bots en marcha, sin refactor, sin
   tocar migraciones, credenciales, `.env` ni el simulador salvo que sea el objeto del hallazgo.
4. **Tests del paquete y de sus dependientes**: `shared → todo`; `strategy-core → backtest, worker
   y typecheck de la app` (la app consume `strategy-core` como fuente, en navegador);
   `exchange-core → worker`. Después `pnpm --filter <paquete> lint`, y `pnpm build:packages` si
   cambió un tipo público. Jest se ejecuta desde Git Bash, no desde PowerShell.
5. **Un commit por corrección**, en la rama del spec, con mensaje
   `fix(<área>): <qué> (spec NNN F-NN)`. Si un dependiente rompe y una iteración pequeña no lo
   arregla: `git revert` (nunca `reset --hard`) y el hallazgo vuelve a «abierto» con spec de
   seguimiento. Si el usuario lo rechaza, se descarta y se anota la decisión.
6. **Vía de escape**: una crítica que exija migración o refactor recibe solo una **mitigación**
   (guarda, negativa a arrancar, evento) y un spec propio.
7. **Prohibido**: llamadas firmadas o autenticadas a un venue, operar en mainnet **o testnet**,
   subir versiones de SDK, tocar `packages/db/prisma`, debilitar o borrar tests existentes,
   cambiar la semántica de un parámetro de usuario sin decisión del usuario.

## Sondas contra los venues

Solo **lectura pública**, sin credenciales y sin firmar. Los scripts viven en el scratchpad de la
sesión, nunca en el repo. Antes de ejecutarlos: abortan si hay alguna variable de entorno que case
con `/KEY|SECRET|PRIVATE|MNEMONIC|SEED/i`; solo hablan con los hosts de
`packages/exchange-core/src/endpoints.ts`, y esa lista se enseña al usuario antes de la primera
ejecución; timeout de 10 s; una petición por segundo y no más de veinte por venue y ejecución;
ante un 429 se paran sin reintentar. A `findings.md` va solo la evidencia resumida.

## Cómo abrir un spec

1. Copiar `_template/` a `NNN-slug/` con el siguiente número libre.
2. Rellenar `spec.md` y `plan.md`; dejar `tasks.md` con las casillas de las fases.
3. Añadir la fila al índice de abajo en estado `borrador`.
4. Pedir aprobación al usuario; pasar a `aprobado` y crear la rama `spec/NNN-slug`.

## Índice

| Nº | Spec | Tipo | Estado | Rama |
|---|---|---|---|---|
| 001 | [Revisión integral de bots, motor y APIs](001-revision-integral/spec.md) | revisión | hecho | `spec/001-revision-integral` |
| 002 | [Analítica e interfaz de la app](002-app-analitica/spec.md) | revisión | en curso | `spec/002-app-analitica` |
| 003 | [Curva agregada de la cartera](003-cartera-agregada/spec.md) | cambio | en curso | `spec/003-cartera-agregada` |
| 004 | [Backtest para todos](004-backtest-para-todos/spec.md) | cambio | en curso | `spec/004-backtest-para-todos` |
| 005 | [Gráfico avanzado](005-grafico-avanzado/spec.md) | cambio | en curso | `spec/005-grafico-avanzado` |
| 006 | [Historial de configuración y cronología por ciclo](006-historial-y-cronologia/spec.md) | cambio | en curso | `spec/006-historial-y-cronologia` |
| 007 | [Panel operativo](007-panel-operativo/spec.md) | cambio | en curso | `spec/007-panel-operativo` |
| 008 | [Guía de uso: una guía por estrategia, riesgo, venues, simulación y comandos](008-guia-de-uso/spec.md) | cambio | en curso | `spec/008-guia-de-uso` |
| 009 | [Protecciones y cierre](009-protecciones-y-cierre/spec.md) | cambio | hecho | `spec/009-protecciones-y-cierre` |
| 010 | [Comandos y ciclo](010-comandos-y-ciclo/spec.md) | cambio | hecho | `spec/010-comandos-y-ciclo` |
| 011 | [Margen y modo de posición](011-margen-y-modo-posicion/spec.md) | cambio | hecho | `spec/011-margen-y-modo-posicion` |
| 012 | [Aster: nonce y errores](012-aster-nonce-y-errores/spec.md) | cambio | hecho | `spec/012-aster-nonce-y-errores` |
| 013 | [Lighter: mercado con holgura, cupo de órdenes y errores con nombre](013-lighter-mercado-y-cupo/spec.md) | cambio | hecho (F-54 abierto) | `spec/013-lighter-mercado-y-cupo` |
| 014 | [Hyperliquid: el precio que se planifica es el que se envía, y la marca es la marca](014-hyperliquid-tick-y-marca/spec.md) | cambio | hecho | `spec/014-hyperliquid-tick-y-marca` |
| 015 | [Liquidaciones y streams por venue](015-liquidaciones-y-streams-por-venue/spec.md) | cambio | hecho | `spec/015-liquidaciones-y-streams-por-venue` |
| 016 | [Parciales y reconciliación](016-parciales-y-reconcile/spec.md) | cambio | hecho | `spec/016-parciales-y-reconcile` |
| 017 | [Rejillas: dimensionado, vista previa y forma con inventario](017-grids-dimensionado-y-preview/spec.md) | cambio | hecho | `spec/017-grids-dimensionado-y-preview` |
| 018 | [Market makers: ciclo continuo, topes, techo y vista previa](018-market-makers/spec.md) | cambio | hecho | `spec/018-market-makers` |
| 019 | [Validación genérica, tasa de mantenimiento por mercado y parámetros muertos](019-validacion-y-parametros-muertos/spec.md) | cambio | hecho | `spec/019-validacion-y-parametros-muertos` |
| 020 | [Caudal y presupuesto: escrituras con reserva, cupo de órdenes y realimentación](020-caudal-y-presupuesto/spec.md) | cambio | hecho | `spec/020-caudal-y-presupuesto` |
| 021 | [Motor: errores que no se tragan, salud que dice la verdad y retención](021-motor-errores-y-salud/spec.md) | cambio | hecho | `spec/021-motor-errores-y-salud` |
| 022 | [Simulador y backtest: los huecos de paridad, declarados y contados](022-simulador-y-backtest/spec.md) | cambio | hecho | `spec/022-simulador-y-backtest` |
| 023 | [Limpieza: docs desfasadas, tests que faltaban y menores por venue y estrategia](023-limpieza-docs-y-tests/spec.md) | cambio | hecho | `spec/023-limpieza-docs-y-tests` |
| 024 | [Mercados: los campos del venue llegan a la fila de `markets`](024-mercados-campos-del-venue/spec.md) | cambio | hecho | `spec/024-mercados-campos-del-venue` |
| 025 | [Capital en las vistas de bots: cuánto dinero hay ahora, cuánto se puso y qué hay en juego](025-capital-en-las-vistas-de-bots/spec.md) | cambio | hecho | `spec/025-capital-en-las-vistas-de-bots` |
| 026 | [Campos muertos fuera del formulario, valores de fábrica y semánticas fijadas](026-campos-muertos-y-decisiones/spec.md) | cambio | hecho | `spec/026-campos-muertos-y-decisiones` |
| 027 | [Elegir el par: una hoja con buscador, y los totales de la lista de bots](027-selector-de-par/spec.md) | cambio | hecho | `spec/027-selector-de-par` |
| 028 | [La credencial de Hyperliquid se verifica de verdad, y su caducidad se ve](028-hyperliquid-credencial-verificada/spec.md) | cambio | hecho (comprobaciones manuales pendientes) | `spec/028-hyperliquid-credencial-verificada` |
| 029 | [El market maker cotiza contra el libro](029-market-maker-contra-el-libro/spec.md) | cambio | hecho (los pendientes de caudal se cerraron en el 031) | `spec/029-market-maker-contra-el-libro` |
| 030 | [Parámetros, selectores y lo que el formulario no dice](030-parametros-y-selectores/spec.md) | revisión | hecho (F-01..F-06 corregidos) | `spec/030-parametros-y-selectores` |
| 031 | [Los pendientes de los specs 029 y 030, y las pruebas que faltaban](031-pendientes-y-pruebas/spec.md) | cambio | hecho | `spec/031-pendientes-y-pruebas` |
| 033 | [Consola de administración](033-consola-de-administracion/spec.md) | cambio | hecho (falta CA-11 manual) | `spec/033-consola-de-administracion` |
| 034 | [Purga de históricos desde la consola](034-purga-de-historicos/spec.md) | cambio | hecho (falta CA-8 manual) | `spec/034-purga-de-historicos` |
| 035 | [El precio tiene que poder alcanzar la cotización](035-el-precio-alcanza-la-cotizacion/spec.md) | cambio | hecho (falta CA-10 manual) | `spec/035-el-precio-alcanza-la-cotizacion` |
| 036 | [Lighter: el stream de cuenta que ya existía](036-lighter-stream-de-cuenta/spec.md) | cambio | hecho (falta CA-8 manual) | `spec/036-lighter-stream-de-cuenta` |
| 037 | [Los mandos del market maker se pelean entre si](037-combinaciones-de-market-maker/spec.md) | cambio | hecho (falta CA-13 manual) | `spec/037-combinaciones-de-market-maker` |
| 038 | [Los datos que el motor no tiene](038-los-datos-que-faltan/spec.md) | cambio | hecho (falta CA-11 manual) | `spec/038-los-datos-que-faltan` |
| 039 | [Que el market maker mire algo mas que el punto medio](039-inteligencia-de-los-market-maker/spec.md) | cambio | hecho (falta CA-14 manual) | `spec/039-inteligencia-de-los-market-maker` |
| 040 | [Una estrategia que gane cuando el precio se va en linea recta](040-estrategia-de-tendencia/spec.md) | cambio | hecho (falta CA-14 manual) | `spec/040-estrategia-de-tendencia` |
| 041 | [Revision de los specs 037-040](041-revision-de-la-tanda/spec.md) | cambio | hecho | `spec/041-revision-de-la-tanda` |
| 042 | [El take profit puede seguir al precio](042-trailing-take-profit/spec.md) | cambio | hecho (falta CA-13 manual) | `spec/042-trailing-take-profit` |
| 043 | [Un bot que solo hace eso: entrar, seguir al maximo y salir](043-estrategia-trailing/spec.md) | cambio | hecho (falta CA-12 manual) | `spec/043-estrategia-trailing` |
| 044 | [Revision de los specs 042 y 043](044-revision-042-043/spec.md) | cambio | hecho (falta CA-6 manual) | `spec/044-revision-042-043` |
| 045 | [Que el numero de estrategias deje de envejecer](045-el-numero-de-estrategias/spec.md) | cambio | hecho | `spec/045-el-numero-de-estrategias` |
| 046 | [Modo IA: un supervisor que vigila bots vivos](046-modo-ia-supervisor/spec.md) | cambio | hecho (falta CA-12 manual y aplicar la migracion) | `spec/046-modo-ia-supervisor` |
| 047 | [Revision del spec 046](047-revision-046/spec.md) | revision | hecho (los 14 hallazgos corregidos dentro del 046) | `spec/046-modo-ia-supervisor` |
| 048 | [Revision de las nueve estrategias](048-revision-de-estrategias/spec.md) | revision | hecho (falta CA-5 manual) | `spec/048-revision-de-estrategias` |
| 049 | [La API no arranca: el supervisor no se puede inyectar](049-el-supervisor-no-se-inyecta/spec.md) | correccion | hecho (falta CA-5 manual) | `spec/049-el-supervisor-no-se-inyecta` |
| 050 | [Una caida del venue no es un fallo del bot](050-caida-del-venue/spec.md) | cambio | hecho (falta CA-10 manual) | `spec/050-caida-del-venue` |
| 051 | [El supervisor que solo avisa](051-el-supervisor-que-solo-avisa/spec.md) | cambio | hecho (falta CA-10 manual) | `spec/051-el-supervisor-que-solo-avisa` |
| 052 | [Revision del spec 051](052-revision-051/spec.md) | revision | hecho (18 hallazgos corregidos dentro) | `spec/052-revision-051` |
| 053 | [La lista de bots alineada y el Modo IA en la app](053-modo-ia-en-la-app/spec.md) | cambio | hecho (faltan CA-2 y CA-10 manuales; H-03 y H-05 corregidos en el 055) | `spec/053-modo-ia-en-la-app` |
| 054 | [Lo que cambia la IA: los avisos con sus valores, y su alcance medido](054-lo-que-cambia-la-ia/spec.md) | cambio | hecho (falta CA-9 manual; H-01 y H-02 del V2 corregidos en el 055) | `spec/054-lo-que-cambia-la-ia` |
| 055 | [Los pendientes del Modo IA, y los errores que la app no veia](055-los-pendientes-del-modo-ia/spec.md) | cambio | hecho (falta CA-8 manual; desplegar primero la API) | `spec/055-los-pendientes-del-modo-ia` |
| 056 | [Revision de los specs 053 a 055](056-revision-053-055/spec.md) | revision | hecho (20 hallazgos, ninguno Critico; 2 descartados, el resto corregido dentro; falta CA-4 manual) | `spec/055-los-pendientes-del-modo-ia` |
| 057 | [Los stops nativos, las velas y el simulador](057-stops-velas-y-simulador/spec.md) | revision | hecho (11 hallazgos, 2 Criticos; todos corregidos dentro; falta CA-4 manual) | `spec/057-stops-velas-y-simulador` |
| 058 | [El motor determinista del canal y la estrategia AI_CHANNEL](058-canal-determinista/spec.md) | cambio | hecho (falta CA-9 del usuario: el walk-forward con el juez) | `spec/058-canal-determinista` |
| 059 | [La IA del canal, el producto y las guias](059-canal-ia/spec.md) | cambio | hecho (faltan CA-10 y CA-11 del usuario: la llamada de pago y la simulacion) | `spec/059-canal-ia` |
| 060 | [Revision de los specs 057 a 059 antes de desplegar](060-revision-057-059/spec.md) | revision | hecho (63 hallazgos; corregidos dentro los 3 Criticos, F-07 —regresion del 057— y F-15; el resto en los seguimientos 061-071; falta CA-4 tras la simulacion) | `spec/060-revision-057-059` |
| 061 | [El grafico avisa de que esta cargando, y deja encender indicadores](061-grafico-carga-e-indicadores/spec.md) | cambio | hecho (faltan CA-4 y CA-5: las comprobaciones a mano del usuario) | `spec/061-grafico-carga-e-indicadores` |
| 062 | [El canal con IA, listo para operar](062-canal-listo-para-operar/spec.md) | cambio | hecho (18 hallazgos del 060 cerrados; falta CA-4: la simulacion y la primera sesion real) | `spec/062-canal-listo-para-operar` |
| 063 | [Los limites de riesgo llegan al motor](063-limites-que-llegan-al-motor/spec.md) | correccion | hecho (faltan CA-3 a CA-5: las comprobaciones a mano del usuario) | `spec/063-limites-que-llegan-al-motor` |
| 065 | [El canal con IA no mantiene su ritmo](065-ritmo-y-caudal-del-canal/spec.md) | cambio | hecho (falta CA-13, la comprobacion del usuario tras desplegar) | `spec/065-ritmo-y-caudal-del-canal` |
| 066 | [El canal con IA: que la aritmetica cierre](066-canal-aritmetica/spec.md) | cambio | cerrado sin desplegar (las dos puertas de coste se quedan; CA-6 no se cumple y se disparo el criterio de parada - ver `findings.md`) | `spec/066-canal-aritmetica` |
| 067 | [El canal de banda: que el bot de IA encuentre donde operar](067-canal-de-banda/spec.md) | cambio | hecho, sin desplegar (el bot pasa de 18 oportunidades a 416 y el R medio a +0,31 con 6/6 ventanas positivas, pero CA-5 solo cumple 1 de 3) | `spec/067-canal-de-banda` |
| 068 | [El «Bot de IA»: el motor, medible sin gastar una llamada](068-bot-de-ia-motor/spec.md) | cambio | **retirado por el 072** (cerrado sin desplegar: mejor resultado de toda la linea - R medio +1,36 con t = 2,46 y 5/6 ventanas - pero 0,51 operaciones al mes y par contra las 2 que pedia CA-4) | `spec/068-bot-de-ia-motor` |
| 069 | [TypeSafe decide: el «Bot de IA» ya tiene IA](069-typesafe-decide/spec.md) | cambio | **retirado por el 072** (nunca se desplego; CA-8 queda sin hacer porque ya no hay nada que comprobar) | `spec/069-typesafe-decide` |
| 070 | [Que el modelo evalue mas, y con mejor evidencia](070-cadencia-y-evidencia/spec.md) | cambio | **retirado por el 072** (el codigo ya no existe; la medicion sigue valiendo: con 996 llamadas reales el modelo NO discriminaba) | `spec/070-cadencia-y-evidencia` |
| 071 | [¿Sabe el modelo distinguir una cascada de una repreciacion? Y la revision del Market Maker V2](071-cascada-medicion/spec.md) | medicion + correccion | hecho, sin desplegar (la medicion sale NEGATIVA: el edge de las cascadas era un artefacto de la ventana; su detector y la primitiva `score` se retiraron con el 072; la revision del MM V2 cierra 5 hallazgos, 2 Criticos, y sus valores medidos ya son los de fabrica) | `spec/071-cascada-medicion` |
| 072 | [Retirar el «Bot de IA» y TypeSafe](072-retirar-bot-de-ia/spec.md) | cambio | cerrado (lo compartido vuelve byte a byte a como estaba antes del 068 y el canal a llamarse «Canal con IA»; falta CA-5: `prisma:deploy` y, al desplegar, la API antes que el worker) | `spec/072-retirar-bot-de-ia` |
| 073 | [La seccion de IA, solo para administradores](073-seccion-ia/spec.md) | cambio | hecho, fase 1 (la pestana «IA», su ruta con `adminGuard` y la pantalla vacia, que llena el 074; faltan CA-1 y CA-2, las comprobaciones del usuario) | `spec/073-seccion-ia` |
| 074 | [Agentes de IA: analizan, proponen, ejecutan y siguen operaciones](074-agentes-ia/spec.md) | cambio | hecho, sin desplegar (motor, operacion `AGENT_TRADE`, runner, API, Telegram, app y guias; revisado en el 075; faltan los CA-12 a CA-14 del usuario y lo Alto y lo Medio del 075, que corrige el 076: `AI_DESK_ENABLE` apagado hasta entonces) | `spec/074-agentes-ia` |
| 075 | [Revision del spec 074 antes de operar con dinero real](075-revision-074/spec.md) | revision | hecho (43 hallazgos: la Critica F-01 corregida dentro; lo Alto y lo Medio al 076 y lo Bajo al 077, con las 20 decisiones del usuario) | `spec/075-revision-074` |

### Solo en esta edicion

| Nº | Spec | Tipo | Estado | Rama |
|---|---|---|---|---|
| oss-001 | [Lo que el `0_init` de esta edicion perdio](oss-001-objetos-perdidos-del-init/spec.md) | correccion | en curso | `spec/oss-001-objetos-perdidos-del-init` |


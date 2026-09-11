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
| 034 | [Purga de históricos desde la consola](034-purga-de-historicos/spec.md) | cambio | hecho (falta CA-8 manual) | `spec/034-purga-de-historicos` || 035 | [El precio tiene que poder alcanzar la cotización](035-el-precio-alcanza-la-cotizacion/spec.md) | cambio | hecho (falta CA-10 manual) | `spec/035-el-precio-alcanza-la-cotizacion` |
| 036 | [Lighter: el stream de cuenta que ya existía](036-lighter-stream-de-cuenta/spec.md) | cambio | hecho (falta CA-8 manual) | `spec/036-lighter-stream-de-cuenta` |


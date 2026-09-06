# 008 — Guía de uso: una guía por estrategia, riesgo, venues, simulación y comandos

Estado: `en curso` · Tipo: `cambio` (documentación y textos) · Rama: `spec/008-guia-de-uso`

## Objetivo

Que cualquier persona pueda configurar cada uno de los siete bots leyendo `docs/`, con un ejemplo
verificado por tipo de bot, las buenas prácticas de la casa y **todas las limitaciones abiertas dichas
de frente**. Estará hecho cuando las once guías existan, sus ejemplos pasen el script de verificación
contra el código real, y los textos de la app y el README dejen de contradecir al motor.

## Contexto

El usuario pidió revisar los bots «para estar seguros de que están bien y que cada uno tiene su
spec bien» y una guía de uso con ejemplo por tipo de bot y buenas prácticas. La revisión (informe
`informes/revision-estrategias.md`) confirma que el código está en verde y las seis Críticas del 001
corregidas, pero que **30 Altas, 47 Medias y 11 Bajas siguen abiertas** y varias de ellas son
exactamente lo que una guía honesta tiene que contar: parámetros que el motor no lee (F-12), un
preview que enseña la mitad del peor caso (F-88), un comando que duplica compras (F-84), un modo de
take profit que cierra al instante (F-80). Hasta hoy `docs/` solo cubría los dos market makers; las
otras cinco estrategias tenían únicamente la guía in-app, y la app y el README dicen cosas que el
código desmiente («tope duro», «once controles», «las seis estrategias»).

Se pidió además comparar con un directo de YouTube de una plataforma competidora que ofrece la misma
familia de bots. Decisión del usuario: **omitir el vídeo** (YouTube no publicó subtítulos y no hay vía
pública al audio); la comparativa se hizo contra la documentación pública de esa plataforma y es un
informe interno del repositorio privado: no forma parte de esta edición.

## Alcance

- `docs/`: `README.md` (índice), `grid-classic.md`, `neutral-grid.md`, `tdca.md`, `martingale.md`,
  `gridmart.md`, `buenas-practicas.md`, `riesgo-y-liquidacion.md`, `venues-y-minimos.md`,
  `simulacion-y-backtest.md`, `comandos-guardas-y-eventos.md`; §«Limitaciones conocidas» y dos frases
  corregidas en `market-maker.md` / `market-maker-v2.md`.
- Textos in-app que hoy contradicen al código: `apps/app/src/app/core/utils/field-labels.ts` y las
  guías `apps/app/src/app/core/content/*.ts` (solo cadenas; ninguna orden ni valor cambia).
- `README.md` (recuentos, enlace a `docs/`), `CLAUDE.md` («Dónde leer más», regla de los bloques
  F-NN), `specs/README.md` (índice).
- Informes: `informes/revision-estrategias.md` (fase A). La comparativa con la competencia es interna del
  repositorio privado y no se publica.
- Scripts de verificación en el scratchpad de la sesión (no se versionan): `verificar-ejemplos.cjs`,
  `coherencia-estrategias.cjs`, `comprobar-parametros.cjs`, `comprobar-enlaces.cjs`.

## Fuera de alcance

- Cualquier cambio en `validate()`, `defaults()`, `meta.fields`, `plan()`, motor, adaptadores o
  tests: van a los specs 009 (`protecciones-y-cierre`), 010 (`comandos-y-ciclo`) y 011
  (`margen-y-modo-posicion`), y al resto de la tabla renumerada del 001.
- Ocultar comandos por estrategia en la app (`bot-commands.service.ts`): es mitigación de F-84/F-85
  y cambia lo que el usuario puede hacer; va al 010 junto con el veto del motor.
- Las cinco `strategy.*.description` que faltan en `field-labels.ts`: no tienen lector.
- `Resume.MD` (F-20) y el análisis del vídeo.
- Nombrar a la competencia en `docs/`: la comparativa es interna y no se porta al fork OSS.

## Requisitos

- **R-1** Una guía por estrategia con la espina de `docs/market-maker.md`: qué es, cómo funciona paso
  a paso, configuraciones A/B/C, checklist, señales de alarma, lo que no mira, **limitaciones
  conocidas**, parámetros uno a uno (un H4 por cada `key` de `meta.fields`), valores de fábrica,
  comparación con las hermanas.
- **R-2** Cada configuración A/B/C lleva los números del `preview()` real (peor caso, margen, media,
  liquidación estimada, distancia, TP) copiados del script, con la fecha de los precios.
- **R-3** Cada limitación va en un bloque autocontenido con su `F-NN`, fecha, «hasta que se corrija» y
  enlace a la ficha del 001, para borrarlo cuando se cierre el hallazgo.
- **R-4** `buenas-practicas.md` recoge el camino simulación → testnet → mainnet con 20 USDC y 1×, los
  mínimos por venue, la regla 25/10/5 % de liquidación, el stop nativo y qué comandos lo conservan, el
  funding, las comisiones, cuándo no usar cada bot, la bitácora y los límites de Lighter.
- **R-5** Los textos in-app y el README dejan de afirmar lo que el código desmiente (lista en
  `plan.md`); ninguna cadena cambia el significado de un parámetro, solo lo describe.
- **R-6** `README.md` enlaza a `docs/README.md`; `CLAUDE.md` obliga al spec que cierre un `F-NN`
  citado en `docs/` a borrar o reescribir su bloque.

## Criterios de aceptación

- **CA-1** `node verificar-ejemplos.cjs` termina con `0 ejemplo(s) en rojo` y los números impresos
  coinciden con los bloques «Peor caso» de las guías.
- **CA-2** `node comprobar-parametros.cjs`: para cada guía de estrategia, el conjunto de claves de los
  H4 de «Parámetros» es igual a `meta.fields.map(f => f.key)`.
- **CA-3** `node comprobar-enlaces.cjs`: 0 enlaces o anclas rotos en `docs/`, `README.md`, `CLAUDE.md`.
- **CA-4** Todo `F-NN` citado en `docs/` existe como ficha en `specs/001-revision-integral/findings.md`.
- **CA-5** `pnpm --filter app build` y `pnpm --filter app lint` en verde tras tocar los textos.
- **CA-6** Manual: con el asistente de creación abierto, cada configuración A/B/C reproduce la vista
  previa del documento, salvo las discrepancias anotadas (F-88, F-14).

## Riesgos

- Las limitaciones se corregirán y la guía quedaría falsa: bloques F-NN borrables, prosa que describe
  la conducta prevista y regla en `CLAUDE.md`.
- Los precios envejecen: cada ejemplo lleva la fecha de captura de `venue-markets.ts`; re-ejecutar el
  script es el mantenimiento.
- Desfase con las guías in-app que no se toquen: `docs/README.md` dice que ante contradicción manda el
  código, y la guía cita `fichero:línea`.
- Bots en marcha: nada del spec cambia conducta.

## Referencias oficiales

- La documentación pública de la plataforma competidora y el directo de YouTube (2026-09-05, sin pistas
  de subtítulos a fecha 2026-09-06) se citan solo en el informe interno del repositorio privado.

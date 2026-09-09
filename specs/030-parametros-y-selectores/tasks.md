# 030 — Tareas

## Fase 0 — Revisión

- [x] Barrido de los descriptores de las siete estrategias: `kind`, `unit`, `min`, `max`,
      `mutability`, `default` y opciones de cada campo
- [x] Contraste de cada selector con lo que anula, leyendo su uso en `validate()`, `preview()` y
      `plan()`
- [x] Contraste con el formulario (`bot-create.page.ts`, `ui-field.component.ts`)
- [x] Sonda local contra el `dist` compilado (sin red, sin credenciales) para F-01
- [x] `findings.md` con seis hallazgos y una lista de lo verificado correcto

      Descartado: un detector automático de «campos declarados que nadie lee» daba falsos positivos
      evidentes (`postOnly`, `orderSizePerSide`…). No se usó como evidencia. El catálogo
      parámetro-por-parámetro ya existe en `specs/001/informes/A-grids.md` y `A-market-makers.md`.

## Fase 1 — F-01 y F-02: el selector de tamaños · `71eca24`, `6972425`

- [x] Tests que fallan primero (cinco), más la sonda que reproduce el error original
- [x] `camposEfectivos()` en `common.ts`, exportada desde el índice del paquete
- [x] `registry.ts` la aplica antes de `validateMeta`, en `validate()` y en `preview()`
- [x] `capFields` del formulario la aplica antes de su ajuste de apalancamiento
- [x] Sonda repetida tras el arreglo: `valida: true`
- [x] La API la aplica también al servir el detalle de un bot (`91f6ead`)

      Encontrado en la revisión final, antes de pasar a `main`: `bots.service.ts` servía
      `strategy.meta.fields` tal cual, así que la pantalla de **ajustes** —donde se toca un bot en
      marcha— seguía diciendo USDC. Se hizo tolerante a un par retirado del catálogo, y el test del
      spec 025, que no mockeaba `markets`, ahora lo hace.

## Fase 2 — F-03: los avisos que se perdían en modo BASE · `71eca24`

- [x] `avisosDeTopeEnMoneda()` en `market-maker.ts`, llamada desde `preview()`
- [x] Tres tests. Sólo la V1: la V2 no declara topes por lado

## Fase 3 — F-04: parámetros inertes · `71eca24`

- [x] Cuatro avisos nuevos, con el patrón de Neutral Grid y la V2
- [x] Cuatro tests

      El techo del diferencial (`maxDynamicSpreadBps`) queda fuera del aviso a propósito: **sí** se
      sigue aplicando con `dynamicSpread: false`.

## Fase 4 — F-05: unidades que faltaban · `71eca24`

- [x] `unit: 'USDC'` en `amountPerBuy`, `maxPositionNotional` y `maxExposure`

## Fase 5 — F-06: el formulario atenúa lo que no aplica · `6972425`

- [x] `grupoInerte()` para `dynamicSpread`, `priceSource` y `activation`
- [x] Etiqueta «no aplica ahora» y opacidad, sin ocultar ni mover campos

## Fase 6 — Verificación

- [x] `pnpm test` completo: **5 321 en verde** (strategy-core 294)
- [x] `pnpm lint` de `strategy-core` y `ng lint` de la app, sin errores
- [x] Typecheck de la app

## Cierre

- [x] Índice de `specs/README.md` actualizado
- [ ] Documentación: guías de los market makers y del TDCA con la unidad según el modo
- [ ] Comprobación manual del usuario: crear un market maker en modo «cantidad de moneda» sobre un
      par caro y ver que el campo se rotula con la moneda y acepta decimales

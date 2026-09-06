# 011 — Margen y modo de posición: «Aportar margen» funciona y la cobertura de Aster no rompe la cuenta

Estado: `hecho` (2026-09-06) · Tipo: `cambio` · Rama: `spec/011-margen-y-modo-posicion`

## Objetivo

Que el comando «Aportar / retirar margen» llegue al venue, que `positionMode` se aplique (o se rechace
donde no puede funcionar), y que ningún comando se ejecute dos veces. Estará hecho cuando `AccountHandle`
reexponga las dos operaciones con test, `HEDGE` quede vetado en Aster (o implementado con `positionSide`),
y `ADD_SAFETY_NOW` y `ADJUST_MARGIN` sean idempotentes.

## Contexto

| F | Título | Sev. | Efecto hoy |
|---|---|---|---|
| F-34 | `AccountHandle` no reexpone `adjustIsolatedMargin` ni `setPositionMode` | Alta | «Aportar margen» **falla siempre** en los tres venues; la API sube igualmente el capital asignado (denominador de `drawdownPct`); `positionMode` es un parámetro muerto |
| F-71 | Aster en modo cobertura: sin `positionSide`, con `reduceOnly`; `HEDGE` no puede funcionar | Alta | Hoy enmascarado por F-34: en cuanto `setPositionMode` funcione, elegir cobertura **cambia el modo de toda la cuenta** de Aster y toda orden recibe `-4061` |
| F-08 | `recoverStale` desreclama comandos en ejecución; `ADD_SAFETY_NOW` no es idempotente | Media | Un comando puede ejecutarse dos veces |

**Dependencia**: F-34 y F-71 van **juntos**. Reexponer `setPositionMode` sin vetar `HEDGE` en Aster destapa
F-71 en producción.

## Alcance

- `apps/worker/src/engine/account-hub.service.ts` (`AccountHandle`), `bot-runner.ts` (`adjustMargin`,
  aplicación de `positionMode`, idempotencia de comandos), `apps/api` (no subir `total_investment` si el
  venue rechaza), `packages/strategy-core` (veto de `HEDGE` en Aster en `validate()` de los MM, o
  `positionSide` en el adaptador de Aster), sus specs.

## Fuera de alcance

- `positionMode` para las cinco estrategias que no lo declaran.
- El resto de Aster (`aster-nonce-y-errores`, spec 012).

## Requisitos

- **R-1** `AccountHandle` expone `adjustIsolatedMargin` y `setPositionMode`; `paper-accounts.spec.ts` «el
  handle expone adjustIsolatedMargin» pasa; `ADJUST_MARGIN` mueve margen en el simulador y en los tres
  adaptadores.
- **R-2** La API solo actualiza `total_investment` al recibir el acuse `MARGIN_ADJUSTED` del worker, que
  lleva el id del comando; la intención (`countAsBotCapital`) viaja en la fila del comando y un update
  condicional sobre esa bandera impide que varias réplicas de la API sumen dos veces. Si el comando falla,
  no hay nada que revertir porque nada se subió.
- **R-3** Se toma la opción (a): `validateCommon` rechaza `positionMode: HEDGE` cuando el mercado es de
  Aster y el runner no lo aplica aunque un bot lo tuviera guardado (avisa con `POSITION_MODE_SKIPPED`).
  `ONE_WAY` sí se aplica al arrancar en Aster (el adaptador ya trata «no need to change» como éxito). La
  opción (b), `positionSide` en el adaptador, queda para cuando alguien la pida: exige sonda firmada.
- **R-4** `ADJUST_MARGIN` se cierra en la bandeja **antes** de tocar el venue (como mucho una vez) y
  `recoverStale` no desreclama comandos cuyo worker sigue teniendo el lease del bot. `ADD_SAFETY_NOW` no
  hizo falta: su orden lleva `clientOrderId` y una repetición choca con la fila ya ejecutada.

## Criterios de aceptación

- **CA-1** Tests de R-1 a R-4 en verde; `pnpm test` y `pnpm lint` en verde.
- **CA-2** Manual (usuario, bot simulado aislado con posición): «Aportar margen 10» → `MARGIN_ADJUSTED` y la
  liquidación se aleja.
- **CA-3** `grep -rn "F-34\|F-71\|F-08" docs/` sin bloques «Limitación conocida».

## Riesgos

- Un bot en Aster con `positionMode: HEDGE` guardado empezaría a aplicarlo al reexponer la operación:
  el veto de R-3(a) tiene que entrar en el **mismo** commit o antes.
- `total_investment` es el denominador del kill-switch: R-2 cambia cuándo se actualiza.

## Referencias oficiales

Aster: `positionSide` obligatorio en modo cobertura y error `-4061` (doc V3, citada en
`specs/001-revision-integral/informes/C-aster.md`).

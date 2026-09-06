# 026 — Campos muertos fuera del formulario, valores de fábrica y semánticas fijadas

Estado: `hecho` (2026-09-06) · Tipo: `cambio` · Rama: `spec/026-campos-muertos-y-decisiones`

## Objetivo

Cerrar las decisiones que quedaban abiertas del spec 001 tomando siempre el camino que no añade
complejidad ni rompe nada: lo que no hace nada sale del formulario y del contrato; lo que tiene una
semántica válida pero mal rotulada se rotula bien; los dos valores de fábrica que engañaban se corrigen
para los bots nuevos; y lo que solo un take profit demasiado corto puede estropear, se avisa.

## Contexto

El usuario delegó las decisiones el 2026-09-06 («retira los campos que no se utilicen o implementa los más
fáciles o quítalos, como mejor sea sin romper nada ni agregar complejidades»). Quedaban:

| Qué | Decisión tomada | Por qué |
|---|---|---|
| F-11 `killSwitchDrawdownPct` | Se conserva la semántica (pérdida acumulada sobre el capital asignado) y se rotula así en la app y en las guías | Medir la caída desde el máximo exige guardar el pico de cada bot; hay bots en marcha con el umbral puesto y ninguno cambia de conducta |
| F-12 `preloadInventory` (Grid Classic) | Fuera | Implementarlo es una compra a mercado al arrancar: riesgo nuevo para un campo que nadie usa |
| F-12 `fullCycleCooldownMinutes` (GridMart) | Fuera | Sin semántica definida; la espera que existe es `cooldownMinutes` |
| F-12 `reanchorOnDrift` / `reanchorThresholdPct` (Neutral Grid) | Fuera, con su aviso | Recentrar solo es editar el ancla; el aviso duplicaba lo que el gráfico ya enseña |
| F-12 `targetLeverage` (contrato `DesiredState`) | Fuera | Ningún consumidor: el apalancamiento se fija al arrancar desde la configuración |
| F-12 `takeProfitPct` / `tpMode` heredados en GridMart | Fuera del formulario, no del contrato | No gobiernan ninguna orden; `defaults()` los sigue fijando para la validación compartida de la escalera |
| F-94 `cooldownMinutes` de GridMart | 1 min de fábrica (bots nuevos) | Es lo que prometía el campo muerto y lo que trae Martingala; con 0 la escalera reabre la base al instante |
| F-15 `feeEstimateBps` del Market Maker V2 | 2 bps de fábrica (bots nuevos) | La guía lo llama «el campo más importante, y viene en 0»; 2 bps es la comisión maker típica y el aviso con 0 se conserva |
| F-94 mínimo de `takeProfitPct` (0,05 %) | Se conserva el mínimo; la app **avisa** por debajo del 0,3 % | Subir el mínimo pausaría bots existentes al recargar; un aviso no rompe nada |
| F-54 Lighter sin stream de cuenta | Aceptado | La capacidad está documentada; una solución propia es un spec aparte si algún día hace falta |
| Lighter sin cuenta de servicio | Soportado: el arranque anuncia el modo y su cupo | Ya existe el aviso; negarse a arrancar castigaría un despliegue de prueba |
| F-79 y F-94, lo aceptado | Definitivo | Anotado en sus fichas |

## Alcance

- `packages/shared/src/bot.ts`; `packages/strategy-core/src/strategies/{grid-classic,gridmart,neutral-grid,
  martingale,market-maker,market-maker-v2,tdca}.ts`; `apps/api/src/modules/advisor/build.ts`;
  `apps/app/src/app/core/{utils/field-labels.ts,content/*.guide.ts}`; `apps/app/src/app/features/account/risk.page.ts`.
- `docs/`: guías de las cinco estrategias afectadas, riesgo, comandos; fichas y preguntas abiertas del 001.

## Fuera de alcance

- Implementar la precarga de inventario, el recentrado automático o el drawdown desde máximo.
- Tocar la configuración guardada de los bots existentes: las claves retiradas quedan en su JSON sin
  efecto, como hasta ahora, y `diffConfig` no las toma por cambio porque no cambian.

## Requisitos

- **R-1** Ningún `meta.fields` ofrece `preloadInventory`, `fullCycleCooldownMinutes`, `reanchorOnDrift` ni
  `reanchorThresholdPct`; GridMart tampoco ofrece `takeProfitPct` ni `tpMode`. Los `defaults()` y las
  interfaces dejan de declararlos (salvo los dos heredados de GridMart, que `defaults()` sigue fijando).
- **R-2** `DesiredState` no tiene `targetLeverage` y ninguna estrategia lo devuelve.
- **R-3** GridMart nace con `cooldownMinutes: 1`; el Market Maker V2 con `feeEstimateBps: '2'` (y `default: 2`).
- **R-4** `validateLadderConfig` avisa si `takeProfitPct` baja del 0,3 %; GridMart avisa igual para `satelliteTpPct`.
- **R-5** El kill-switch se rotula «pérdida acumulada» en la app y en las guías; la semántica no cambia.
- **R-6** El asesor no propone los campos retirados; las etiquetas y fichas in-app de esos campos desaparecen.

## Criterios de aceptación

- **CA-1** Tests de R-1 a R-4 en verde; `pnpm test`, `pnpm lint`, `pnpm check:env`; typecheck, lint y `ng build`.
- **CA-2** Las guías no describen ningún campo que el formulario no ofrezca (`comprobar-parametros`); los
  ejemplos de las guías siguen verificados (`verificar-ejemplos`); las fichas F-11, F-12 y F-54 llevan la
  decisión y la sección «Preguntas abiertas» del 001 queda respondida.

## Riesgos

- Un bot existente con `preloadInventory: true` o `reanchorOnDrift: true` guardado deja de recibir su aviso;
  ninguno de los dos hacía otra cosa.
- Los dos valores de fábrica solo afectan a bots nuevos: los existentes conservan su configuración.

## Referencias oficiales

Ninguna: contratos internos.

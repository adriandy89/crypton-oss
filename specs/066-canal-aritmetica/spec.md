# 066 — El canal con IA: que la aritmética cierre

Estado: `cerrado sin desplegar` (se disparó el criterio de parada: CA-6 no se cumple; ver `findings.md`) · Tipo: `cambio` · Rama: `spec/066-canal-aritmetica`

## Objetivo

Que una operación del canal con IA pueda ganar dinero por aritmética antes de entrar. Hoy no puede:
el coste de ida y vuelta se lleva el 67 % del presupuesto de riesgo, y en ocho de cada veintiocho
operaciones se lo lleva entero. Se sabrá conseguido cuando el walk-forward sobre doce pares y siete
meses dé R medio positivo con `t > 2` y al menos dos operaciones al mes y par.

## Contexto

Medido con el motor de backtest de la plataforma (`runReplay`, el mismo que usa la app) sobre **12
pares y 190 días** (2.279 días-par, 14 mar → 20 sep 2026), con el juez de reglas:

| | |
|---|---|
| Operaciones | **12** — una cada 5 meses y par; 6 de 12 pares no operaron nunca |
| Acierto / R medio | 17 % / −0,578 (IC 95 % [−1,36 , +0,20]) |
| Salidas | 75 % en stop, **ningún objetivo alcanzado** |
| Seis configuraciones | **las seis negativas**, R entre −0,46 y −0,78 |
| Liquidaciones | 0 |

**La causa raíz no es la detección de rangos.** Sobre las 28 operaciones de la variante que más
opera:

| | |
|---|---|
| Distancia mediana al stop | **0,300 %** |
| Coste de ida y vuelta | **0,200 %** |
| **El coste se come** | **el 67 % del riesgo** |
| Operaciones con coste ≥ 100 % del riesgo | **8 de 28** |

Una operación cuyo coste iguala su riesgo no puede ganar: para sacar 1R neto necesita 2R brutos.
Eso explica el resto de síntomas —75 % de stops, ningún objetivo, acierto necesario del 31 % frente
al 18 % logrado— sin necesidad de culpar a la detección.

**La puerta que da la vuelta al signo.** Midiendo la reversión en banda sobre los mismos 12 pares y
7 meses, con la única puerta del objetivo expresado en múltiplos del coste de ida y vuelta:

| Objetivo mínimo | n | R medio | t | pares + | meses + |
|---|---|---|---|---|---|
| sin puerta | 7.087 | **−0,2295** | −17,5 | — | — |
| ≥ 10× coste | 1.044 | −0,0065 | −0,17 | 3/12 | 2/8 |
| **≥ 15× coste** | 359 | **+0,1043** | +1,61 | 7/12 | 2/8 |

El canal **ya tiene** esa puerta —`MIN_ANCHURA_COSTES = 10` (`canales.ts:68`)— pero sobre la
**anchura del canal**, no sobre el objetivo de la operación. Como el objetivo es la media, o sea la
mitad de la anchura, la puerta efectiva vale **5×**: de lleno en la zona perdedora.

Y `costeR` —la parte del riesgo que se van comisiones y deslizamiento— **ya se calcula**
(`herramienta.ts:444`): se le enseña a la IA y no frena nada.

**Lo que este spec promete y lo que no.** Promete quitar la imposibilidad aritmética, que está
medida. **No promete que el bot gane**: con la puerta de coste el resultado pasa de −0,23 a +0,10,
pero con `t = 1,61` y solo 2 meses positivos de 8. Eso es una moneda al aire, no una ventaja. Por
eso el spec lleva criterio de parada.

Decisión del usuario, pedida y reafirmada: cambiar `AI_CHANNEL` para que funcione. Eso autoriza
tocar valores por defecto y la semántica de parámetros, que `CLAUDE.md` reserva a decisión explícita.

## Alcance

Se **modifica la estrategia existente**; no se añade ninguna, así que no entra nada del recorrido de
alta (enum, migración de Prisma, registro, los `Record` completos de la app, asesor, supervisor).

- `packages/strategy-core/src/canal/herramienta.ts` — las dos puertas nuevas.
- `packages/strategy-core/src/canal/canales.ts` — `MIN_ANCHURA_COSTES`.
- `packages/strategy-core/src/canal/config.ts` — `DEFAULTS_CANAL`, `ConfigCanal` y el lector.
- `packages/strategy-core/src/strategies/ai-channel.ts` — `meta.fields`.
- `apps/app/src/app/core/content/ai-channel.guide.ts` y `core/utils/field-labels.ts`.
- `docs/ai-channel.md`.
- Tests en `canal/herramienta.spec.ts`, `strategies/ai-channel.spec.ts` y `packages/backtest`.

## Fuera de alcance

- **El filtro de régimen** (`canal/regimen.ts`). Es la pieza más valiosa que tiene el bot: descartó
  el 87 % de las entradas y llevó el R medio de −0,143 a +0,608. La literatura coincide. Se queda.
- **La estructura a 5 min.** Medida: opera menos (9 frente a 12), acierta menos (11 % frente a
  17 %), R peor (−0,777) y cuesta 5× más CPU. El cuello de botella es el régimen de 1 h.
- **La entrada por límite en la banda.** La peor de once variantes (−0,31 frente a −0,16):
  selección adversa. La entrada sigue siendo IOC.
- **El motor.** Cero liquidaciones en 2.279 días-par; stops y objetivos donde debían.
- **`shared/liquidation.ts`**, el apalancamiento por stop y el vigilante del stop.
- **Añadir una estrategia nueva.** Se arregla la que hay.

## Requisitos

- **R-1 — El coste deja de ser información y pasa a ser puerta.**
  Una opción de stop con `costeR` por encima de `maxCosteR` es **no viable**, con motivo `COSTE`.
  Campo `maxCostPerTradeR`, por defecto **0,20**; hoy la mediana real es 0,67.
- **R-2 — El objetivo se mide en múltiplos del coste.**
  `minRewardRisk` compara el objetivo con el stop, así que un stop diminuto pasa con un objetivo
  diminuto. Puerta nueva sobre la distancia entrada → TP1 en múltiplos del coste de ida y vuelta:
  campo `minTargetCostMultiple`, por defecto **15**. Motivo `OBJETIVO_CORTO`.
- **R-3 — La anchura deja de contradecir al objetivo.** `MIN_ANCHURA_COSTES` pasa de 10 a **30**:
  con el objetivo en la media, 30× de anchura son 15× de objetivo.
- **R-4 — El mando muerto.** `minChannelQuality` está medido como inerte: con B y con C salen
  exactamente las mismas 12 operaciones, el mismo R y el mismo PnL. Se fija en B y se retira del
  formulario, o se reparte la puntuación para que C signifique algo. Un mando que no hace nada
  engaña a quien lo mira.
- **R-5 — Que opere lo suficiente para poder juzgarlo.** Objetivo: **≥ 2 operaciones al mes y par**
  (hoy 0,16). Si R-1 a R-3 no llegan, se instrumentan los motivos de rechazo de `detectarCanal`
  sobre datos reales y se revisa la puerta que más candidatos cuesta por menos calidad. Nada se
  afloja a ciegas: cada puerta que se toque, con su medición.

## Criterios de aceptación

- **CA-1** `costeR` por encima del tope deja la opción no viable con motivo `COSTE`, y por debajo la
  deja pasar. Test con las cifras reales medidas.
- **CA-2** Un objetivo a menos de `minTargetCostMultiple` veces el coste no se ofrece
  (`OBJETIVO_CORTO`). Test con un canal estrecho que hoy sí se opera.
- **CA-3** Los campos nuevos salen en `meta.fields` con rango y defecto; `meta.spec.ts` en verde.
- **CA-4** La guía in-app documenta los dos campos: `GuideOptions` no compila si falta uno.
- **CA-5** Batería completa: `pnpm build:packages`, `pnpm test`, `pnpm lint`, `pnpm check:env` y el
  typecheck de la app.
- **CA-6 (el que decide)** Walk-forward con `runReplay` sobre 12 pares × 190 días, contra la línea
  base de este spec (12 operaciones, R medio −0,578): **≥ 2 operaciones al mes y par**, **R medio
  positivo con t > 2** y **≥ 4 de 6 ventanas positivas**.
- **CA-7 (manual, usuario)** Un bot simulado por par durante dos semanas antes de cualquier plan de
  dinero real.

## Criterio de parada

Si tras R-1 a R-5 el walk-forward no cumple CA-6, el spec se cierra **sin desplegar** y con el
resultado en `findings.md`. La alternativa no es seguir aflojando mandos, sino aceptar que la
reversión en canal a 15 min no tiene ventaja explotable en este mercado. Con lo medido hoy, ese
desenlace es tan probable como el otro.

## Riesgos

- **Que las puertas lo dejen sin operar.** R-1 a R-3 son restrictivas. Por eso R-5 fija un suelo de
  cadencia y CA-6 lo mide: si opera menos, el spec ha fracasado aunque suba el R.
- **Sobreajuste a siete meses de un mercado.** El 15× sale de esta muestra y solo 2 de sus 8 meses
  son positivos. Mitigación: es un campo de usuario con su defecto, no una constante escondida, y
  CA-6 exige estabilidad por ventanas, no solo un total.
- **Bots en marcha.** Un bot vivo heredará los defectos nuevos y empezará a rechazar entradas que
  antes tomaba. Es la intención, pero se dice en la guía.
- **La guía miente si no se actualiza.** `docs/ai-channel.md` afirma cosas que estas puertas cambian.

## Referencias oficiales

- Reversión de corto plazo en cripto, medición cruzada entre mercados:
  <https://arxiv.org/html/2608.21888> (consultada el 2026-09-20). Predictibilidad concentrada en
  **15 minutos**; 90 % de 183 pares de Binance con reversión significativa frente al 2,7 % de 187
  acciones; AUC 0,531 frente a 0,499. El pico está «cerca de 1,3 bp por operación contra un coste de
  ida y vuelta de 5 bp», y «ninguno de los 183 pares supera la banda de 5 bp en ningún umbral».
- Reversión intradía sobre SOL/USDT perpetuo, cinco años y 525.600 velas de 5 min, con comisiones
  reales: <https://papers.ssrn.com/sol3/papers.cfm?abstract_id=6932998> (consultada el 2026-09-20).
  Un stop del 0,15 % es «matemáticamente inviable» porque los costes consumen el 93 % del riesgo;
  con stops del 1 % al 2 % el resultado es significativo.
- Régimen como factor dominante: factor de beneficio 1,62 con ADX < 20 frente a −0,74 con ADX > 30
  en BTC/USDT 4 h, 2023-2025.

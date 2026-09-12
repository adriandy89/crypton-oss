# 048 — Hallazgos de la revisión de las nueve estrategias

Commit base: `a3e74dd` (`main`) · Rama: `spec/048-revision-de-estrategias` · Fecha: 2026-09-12
Sin sondas a ningún venue.

## Línea base

`pnpm test` en verde antes de empezar: shared 97, strategy-core 504, exchange-core 381, backtest 31,
worker 345, API 5437.

## Cómo se revisó

Una por una, leyendo `validate()`, `preview()`, `plan()` y su descriptor, y contrastando cada
estrategia **contra las demás**: el método que más ha rendido es buscar una regla que una aplica y
otra no, porque casi siempre significa que una corrección no se propagó.

Tres hallazgos, **ninguno Crítico**. Dos son el mismo defecto en dos estrategias distintas, y ese es
el que importa: **una corrección del spec 001 que se aplicó a una rejilla y no a las otras dos**.

## Resumen

| ID | Título | Estrategia | Severidad | Estado | Evidencia |
|---|---|---|---|---|---|
| H-01 | El tope de exposición no acota nada hasta después de superarse | NEUTRAL_GRID | **Alta** | confirmado | `neutral-grid.ts:397` |
| H-02 | El tope de posición se rebasa siempre por el importe de una compra | TDCA | **Alta** | confirmado y medido | `tdca.ts` (bloque de topes) |
| H-03 | La última línea de una rejilla geométrica vende a un precio aritmético | GRID_CLASSIC | Media | confirmado y medido | `grid-classic.ts:151` |

---

## H-01 — El tope de exposición no acota nada hasta después de superarse · **Alta**

**Síntoma.** `maxExposure` (y el común `maxNotionalCap`) se comprueban contra la exposición **que ya
existe**, no contra la que el plan está a punto de tender. Con la posición a cero se tiende la
retícula **entera**, valga lo que valga, y el tope solo empieza a actuar cuando ya se ha superado.

**Evidencia.** `packages/strategy-core/src/strategies/neutral-grid.ts:397`:

```ts
const capReached = cap != null && cap.gt(0) && exposure.gte(cap);
```

y más abajo, dentro del bucle de líneas:

```ts
if (capReached) {
  const wouldIncrease = (isBuy && posQty.gte(0)) || (!isBuy && posQty.lte(0));
  if (wouldIncrease) continue;
}
```

**Por qué es un hallazgo y no una decisión.** Porque es **exactamente** el defecto que el spec 001
(F-87) corrigió en la rejilla clásica, y el comentario que lo explica sigue ahí, en
`grid-classic.ts:320`:

> *«El tope acota lo que se TIENDE: notional ya abierto más el de las entradas que se dejan vivas,
> de la más cercana al precio hacia fuera, y en cuanto una no cabe se corta ahí (sin huecos en la
> retícula). Antes era una puerta binaria sobre la posición ya abierta: con posición cero se tendía
> la retícula entera y el tope actuaba después de superarse (001/F-87).»*

La corrección se aplicó a `GRID_CLASSIC` y no se propagó a `NEUTRAL_GRID`. `MARTINGALE` y `GRIDMART`
sí proyectan (`projected.plus(lv.notional).gt(cap)`), de modo que de las cinco estrategias con tope
de notional, **cuatro lo hacen bien y esta no**.

**Impacto.** El propio `validate()` avisa de que *«sin tope de exposición, si el precio se pega a un
extremo, la posición neta crece hasta agotar el margen»* — lo que le dice al usuario que **con** tope
eso no pasa. Pasa igual: si el precio recorre el rango hacia un extremo, se ejecutan todas las
líneas de ese lado antes de que la guarda reaccione. La guarda sirve para dejar de **añadir** una
vez superada, no para no superarla.

**Propuesta.** El mismo patrón de `grid-classic`: recorrer las líneas que aumentarían posición de la
más cercana al precio hacia fuera, acumulando notional proyectado, y cortar en la primera que no
quepa. Con test que fije que la suma tendida no supera el tope.

---

## H-02 — El tope de posición se rebasa siempre por el importe de una compra · **Alta**

**Síntoma.** El DCA temporizado comprueba `posición × mark ≥ tope` **antes** de comprar, sin
proyectar la compra que va a emitir. El resultado es que el tope se rebasa sistemáticamente por el
importe de una compra entera.

**Evidencia.** `packages/strategy-core/src/strategies/tdca.ts`:

```ts
const topes = [cfg.maxPositionNotional, cfg.maxNotionalCap]…
if (topes.length > 0 && pos.mul(mark).gte(topes.reduce(…))) {
  blockers.push('tope de posición alcanzado');
}
```

**Medido.** Con `maxPositionNotional = 1000`, `amountPerBuy = 100` y apalancamiento 2, partiendo de
una posición de 990 USDC de notional:

```
nota: Comprando (2/20).
COMPRA de 199.64 -> notional final 1189.64 con tope 1000
```

Es decir, **un 19 % por encima del tope**. El rebase es tan grande como `amountPerBuy × leverage`, y
con apalancamientos altos y pocas compras puede ser una fracción muy grande del tope.

**Impacto.** Son dos topes de riesgo —uno propio y otro común a todas las estrategias— que no acotan
lo que dicen acotar. Quien ponga 1000 para no pasar de 1000 pasará de 1000 en cada ciclo.

**Propuesta.** Proyectar: `pos.mul(mark).plus(notional).gt(tope)`. Es una línea, y deja el TDCA
alineado con las otras cuatro.

---

## H-03 — La última línea de una rejilla geométrica vende a un precio aritmético · Media

**Síntoma.** En una rejilla clásica, la línea superior no tiene otra por encima a la que vender, así
que se le proyecta una. La proyección es **siempre aritmética** —suma el último salto— incluso
cuando la rejilla es `GEOMETRIC`, donde los saltos son multiplicativos y crecen.

**Evidencia.** `packages/strategy-core/src/strategies/grid-classic.ts:151`:

```ts
function sellPriceFor(prices: Decimal[], i: number): Decimal {
  if (i + 1 < prices.length) return prices[i + 1];
  const last = prices[prices.length - 1];
  const prev = prices[prices.length - 2] ?? last;
  return last.plus(last.minus(prev));   // aritmético, siempre
}
```

`buyPriceFor` tiene el mismo problema en la línea inferior, que es la que importa en un bot `SHORT`.

**Medido.** Rejilla geométrica de 5 niveles entre 100 y 200
(`100 · 118,92 · 141,42 · 168,18 · 200`):

```
venta de la ultima (aritmetico): 231.8207
venta de la ultima (geometrico): 237.8414
diferencia: 2.60 %
```

La diferencia crece con la amplitud del rango y con menos niveles.

**Impacto.** Acotado y siempre del lado prudente: se vende **antes**, así que la línea superior
captura menos beneficio del que su propia progresión indica. No hay pérdida, hay un escalón que no
paga lo que los demás. Pero rompe la promesa del modo geométrico —que cada escalón capture el mismo
**porcentaje**— justo en la línea que más lejos está.

**Propuesta.** Proyectar con la misma ley que la rejilla: `last × (last / prev)` en geométrica,
`last + (last − prev)` en aritmética. Con test sobre las dos.

---

## Verificado OK

Lo que se revisó y **no** tiene defecto, porque una revisión que solo lista problemas no dice dónde
se puede confiar:

- **Ningún parámetro muerto en las nueve.** Se comprobó cada clave declarada contra todo el código
  que puede leer una configuración —`strategy-core` entero más el runner—. El único candidato,
  `sourceMarketType` del market maker V2, lo lee el worker (`bot-runner.ts:2320`). Los specs 019 y
  026 hicieron su trabajo.
- **MARTINGALE y GRIDMART proyectan bien su tope** (`projected.plus(lv.notional).gt(cap)` y cortan
  la escalera sin dejar huecos).
- **La entrada a mercado de TREND_FOLLOW y TRAILING_PROFIT va en `orders` y no en `immediate`**, a
  diferencia de TDCA y MARTINGALE. **No es un defecto**: ninguna de las dos declara
  `reusesOrderSlots`, así que `place()` recibe `allowRefill = false` y una fila ya ejecutada veta el
  reenvío. Era el candidato más serio a Crítica —«exposición duplicada»— y está cerrado.
- **Los dos market makers validan el solape de capas** (`layers > 1 && layerDistanceMultiplier <= 1`
  es error en ambos). El hallazgo R-2 del spec 037 quedó cerrado de verdad.
- **Las diferencias de rangos y valores de fábrica entre los dos market makers son deliberadas y
  están documentadas**: los mandos de inteligencia de la V2 nacen apagados (spec 039) y sus umbrales
  de riesgo en 90/100 los explica su propia guía.
- **El stop de TREND_FOLLOW nunca retrocede y se ancla en la entrada** (spec 041 R-2), y el trailing
  de las cuatro estrategias que lo tienen pasa por la misma pieza compartida con `intent: 'SL'`
  (spec 042 R-1).
- **NEUTRAL_GRID avisa de que la dirección no sesga la retícula** en vez de fingir que lo hace
  (001/F-12), y de que sin tope la posición crece sin freno.

## Preguntas abiertas

1. **H-01 y H-02 cambian la conducta de bots en marcha**: un bot con tope que hoy tiende la retícula
   entera pasará a tender menos líneas. Es lo que el tope prometía, pero es un cambio de conducta y
   el principio 6 de `specs/README.md` pide decisión explícita del usuario.
2. **H-03 cambia el precio de salida de una línea** en las rejillas geométricas ya creadas. También
   es conducta en marcha, aunque el efecto sea vender un poco más arriba.

## Specs de seguimiento propuestos

Ninguno: los tres caben en este spec si el usuario autoriza tocar conducta de bots vivos. Si no,
H-01 y H-02 son un spec de corrección propio y H-03 puede ir en un lote de limpieza.

# 035 — Hallazgos

Lo que apareció de paso y **no** se corrige aquí (principio 5 de `specs/README.md`).

## F-01 — En la V1, `minAllowedDistanceBps` hace dos trabajos

**Severidad: Baja.** Tras el arreglo del spec ya no impide ejecutar; queda como derroche de cuota.

`market-maker.ts:726` compara la deriva del precio contra `minAllowedDistanceBps` para decidir si
toca recotizar, y `:873` usa ese mismo campo como **suelo** de la distancia con un
`Decimal.max(minBps, …)`. O sea: el umbral de recotización es, por construcción, menor o igual que
la distancia de cotización. No es un valor de fábrica desafortunado — es que falta el mando. La V2
tiene `repriceThresholdBps` como campo propio.

Con la tolerancia asimétrica esto deja de ser un problema de **alcance** —la cotización a la que el
mercado se acerca se conserva pase lo que pase— y pasa a ser solo de **tráfico**: el bot recoloca
órdenes que nadie ha tocado, y en Lighter eso cuesta cuota (60 peticiones/min por IP).

Mitigado con un aviso en `validate()` que salta cuando el número es tan bajo que el derroche es
seguro (por debajo de la cuarta parte de la primera capa).

**Arreglo propuesto (spec de seguimiento):** un `repriceThresholdBps` propio para la V1. No entra
aquí porque costaría formulario, `meta.fields`, mutabilidad, guía, asesor y app para no arreglar
nada que el spec 035 no haya arreglado ya.

## F-02 — F-54 sigue abierto: los market makers no deben operarse en Lighter

**Severidad: Alta**, y **no es de este spec**: viene del 001 y sigue vivo.

`docs/market-maker.md` lo dice: *«Lighter no tiene stream de cuenta: las ejecuciones llegan por
sondeo cada 12 s, demasiado tarde para recotizar con criterio. Hasta que se corrija: no operes
market makers en Lighter.»*

Se anota aquí porque el bot del incidente es de Lighter. En **simulación** no muerde —el simulador
casa contra el BBO por WebSocket—, pero ahora que los market makers ejecutan de verdad, la
diferencia entre simulado y real en ese venue pasa a importar mucho más que antes.

## F-03 — La señal de «el mercado se acerca» no se puede deducir del precio

**Severidad: Alta.** Detectada en la revisión del propio spec, corregida dentro de él.

La primera versión de la tolerancia asimétrica deducía «el mercado se acerca» comparando la orden
viva con la que se cotizaría ahora: para una compra, «la viva está más alta». Esa comparación
también se cumple cuando el precio deseado se **aleja** porque el diferencial se ha ensanchado, así
que una cotización podía estrecharse pero **nunca ensancharse**: el ensanchado por volatilidad, el
régimen defensivo y una subida de distancia en caliente quedaban descartados en silencio. En la V1,
que no caduca por edad, para siempre.

Corregido: la señal viene del ancla (`mid` frente a `quotedMid`), que es la misma que decide la
caducidad por edad. Una sola señal para las dos cosas, para que no vuelvan a divergir. Congelado con
dos tests: con el mercado quieto, ensanchar la distancia mueve la cotización; con el mercado bajando
hacia ella, se conserva aunque se ensanche.

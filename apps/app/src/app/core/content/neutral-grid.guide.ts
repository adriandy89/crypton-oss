import type { NeutralGridConfig } from '@crypton/strategy-core';
import type { StrategyGuide } from './types';

export const NEUTRAL_GRID_GUIDE: StrategyGuide<NeutralGridConfig> = {
  headline:
    'Cotiza a los dos lados alrededor de un precio ancla: compra por debajo, vende por encima, y trata de volver siempre a posición cero.',
  risk: 'MEDIO',
  bestFor:
    'Un par que oscila alrededor de un precio de referencia claro y al que no quieres apostar ni al alza ni a la baja. A diferencia de la rejilla clásica, aquí el bot opera desde el primer momento a los dos lados, no solo comprando.',
  howItWorks: [
    'Eliges un precio ancla y un rango a su alrededor. El ancla es el centro: el punto donde el bot considera que tu posición debería ser cero.',
    'Reparte los niveles por todo el rango y coloca compras en los que están por debajo del precio actual y ventas en los que están por encima. Con tope de exposición, cada lado se tiende desde el precio hacia fuera hasta donde quepa.',
    'El capital no se reparte a partes iguales: los niveles más lejanos al ancla pesan más, para que las entradas fuertes ocurran en los extremos.',
    'Cada vez que una compra se ejecuta, tu posición se vuelve más larga; cada venta, más corta. En el centro del rango la posición neta vuelve a rondar cero.',
    'Una línea tendida sigue viva hasta que el precio la cruza; la línea cruzada se queda sin orden hasta que el precio se aleja medio escalón, y vuelve con el lado que toque. Así no se recompra encima de lo que acaba de ejecutarse ni se recoloca nada en cada movimiento mínimo.',
  ],
  goodWhen: [
    'Quieres exposición neutral: ganar del vaivén sin quedarte estructuralmente largo ni corto.',
    'El par tiene un precio de referencia reconocible al que suele volver.',
    'Te vale operar a los dos lados desde el arranque, sin esperar a que el precio baje para empezar.',
  ],
  badWhen: [
    'El precio rompe en tendencia. Al alejarse del ancla la posición neta crece en su contra y no vuelve sola.',
    'No pones tope de exposición: sin el, la posición neta crece hasta agotar el margen.',
    'Buscas acumular una moneda. Para eso la rejilla clásica o el DCA temporizado encajan mejor.',
  ],
  examples: [
    {
      title: 'Neutral alrededor de un ancla clara en ETH',
      venue: 'Lighter',
      pair: 'ETH/USDC',
      price: '2.503,35 USDC',
      setup: [
        { label: 'Dirección', value: 'Neutral' },
        { label: 'Precio ancla', value: '2.500' },
        { label: 'Rango', value: '2.200 - 2.800' },
        { label: 'Niveles', value: '24' },
        { label: 'Capital', value: '800 USDC' },
        { label: 'Apalancamiento', value: '2x' },
        { label: 'Exposición máxima', value: '700 USDC' },
      ],
      outcome:
        'Con ETH en 2.503 la posición arranca en cero y el tope de 700 USDC da a cada lado su presupuesto: al arrancar hay diez compras colgadas, hasta 2.270, y diez ventas, hasta 2.771; las cuatro líneas de los extremos se quedan sin orden. Cada vuelta del precio al ancla cierra ciclos por los dos lados. Si ETH baja hasta 2.200 el bot acumula un largo de once compras, hasta 2.247, y ahí para: el tope lo corta antes de que ese lado llegue a los 865 USDC que suman sus líneas, y la Revisión lo enseña cortado en el mismo sitio. Las compras y las ventas no se suman: nunca son la misma posición, y la Revisión enseña cada lado aparte.',
    },
    {
      title: 'BTC con el tope de exposición como freno principal',
      venue: 'Lighter',
      pair: 'BTC/USDC',
      price: '78.910 USDC',
      setup: [
        { label: 'Precio ancla', value: '79.000' },
        { label: 'Rango', value: '74.000 - 84.000' },
        { label: 'Niveles', value: '20' },
        { label: 'Capital', value: '1.000 USDC' },
        { label: 'Apalancamiento', value: '2x' },
        { label: 'Exposición máxima', value: '500 USDC' },
      ],
      outcome:
        'El tope de 500 USDC es la mitad del capital, y cada lado se tiende desde el precio hacia fuera hasta donde quepa: al arrancar, cinco compras y cinco ventas alrededor de 78.910, y las diez líneas de los extremos se quedan sin orden. Si BTC cae, el largo se queda en cinco compras; si sube, el corto se queda en cuatro, porque un corto vale más según sube el precio y la quinta venta deja de caber. Las órdenes que reducen la posición siguen siempre vivas. Es la forma de tener una rejilla ancha sin que una ruptura la convierta en una posición direccional grande.',
    },
    {
      title: 'SOL cargando los extremos',
      venue: 'Lighter',
      pair: 'SOL/USDC',
      price: '138,42 USDC',
      setup: [
        { label: 'Precio ancla', value: '138' },
        { label: 'Rango', value: '115 - 165' },
        { label: 'Niveles', value: '12' },
        { label: 'Multiplicador de tamaño', value: '1,5' },
        { label: 'Capital', value: '600 USDC' },
        { label: 'Espaciado', value: 'Geométrico' },
        { label: 'Exposición máxima', value: '600 USDC' },
      ],
      outcome:
        'Con multiplicador 1,5 las líneas pegadas al ancla mueven poco dinero (23 USDC en 140) y las de los extremos mucho (263 USDC en 115, 175 en 165): el bot apenas se mueve mientras SOL ronde los 138, y carga fuerte hacia los extremos. Es útil cuando esperas ruido en el centro y quieres reservar la munición para los extremos. Pero el tope de 600 USDC es menor que los 719,59 que suma el lado largo: la línea de 115, la de 263 USDC, se queda sin orden, y lo más abajo que compra es 118,84; arriba cabe todo, hasta 165. Con el tope en 720 también se tiende la de 115. Con más niveles o más multiplicador las líneas del centro caen por debajo del mínimo del par y la app rechaza el bot.',
    },
  ],
  options: {
    anchorPrice: {
      what: 'El centro de la retícula: el precio en el que el bot considera que tu posición debería ser cero.',
      affects:
        'Todo se mide contra el. Por debajo se colocan compras y por encima ventas, y el peso de cada nivel crece con su distancia al ancla. Ponerlo lejos del precio actual hace que el bot arranque ya cargado hacia un lado.',
      tip: 'Tiene que estar dentro del rango, y lo natural es ponerlo cerca del precio de hoy o del precio al que el par suele volver.',
    },
    lowerPrice: {
      what: 'Extremo inferior del rango. La compra más lejana se coloca aquí.',
      affects:
        'Cuanto más abajo, más caída cubre la retícula y más separadas quedan las líneas. También es donde acaba tu posición larga máxima si el precio se desploma.',
    },
    upperPrice: {
      what: 'Extremo superior del rango. La venta más lejana se coloca aquí.',
      affects:
        'Cuanto más arriba, más subida cubre y más corto puedes acabar acumulando si el precio se dispara.',
    },
    gridLevels: {
      what: 'Cuántas líneas se reparten por el rango completo, contando los dos lados del ancla.',
      affects:
        'Más niveles hacen la retícula más fina: más ciclos y más pequeños. El mínimo son 4 porque con menos no hay retícula a dos lados que valga la pena.',
      tip: 'Cuenta que el capital repartido entre los niveles siga dejando órdenes por encima del mínimo del par.',
    },
    gridSpacing: {
      what: 'Cómo se reparten las líneas: misma distancia en USDC (aritmético) o mismo porcentaje (geométrico).',
      affects:
        'Aquí viene geométrico por defecto, y tiene sentido: si el rango es amplio, el mismo salto en USDC rinde porcentajes muy distintos arriba y abajo del ancla.',
    },
    sizeMultiplier: {
      what: 'Cuanto más dinero mueven los niveles lejanos al ancla frente a los cercanos. Con 1 todos pesan igual.',
      affects:
        'Subirlo vacía el centro y carga los extremos: el bot se mueve poco con el ruido y entra fuerte cuando el precio se aleja de verdad. Bajarlo a 1 reparte el capital de forma pareja por todo el rango.',
      tip: 'Entre 1 y 1,5 para empezar. Por encima de 2, casi todo el capital vive en las dos o tres líneas de cada extremo.',
    },
    maxExposure: {
      what: 'Tope de la posición NETA del bot, en USDC. Es el freno propio de esta estrategia.',
      affects:
        'Cada lado tiene su presupuesto: se tienden las líneas de la más cercana al precio hacia fuera mientras la posición, al precio de ahora, más esas órdenes quepan en el tope. Las órdenes que REDUCEN la posición siguen siempre vivas. La Revisión lo aplica igual y corta cada lado en la primera línea que ya no cabe.',
      tip: 'Ponlo siempre: sin él, en una ruptura la posición neta crece hasta agotar el margen. Si es menor que lo que suman las líneas de un lado, la app te avisa de que ese lado no se tenderá entero; si no deja tender ni la línea más cercana al ancla, no deja crear el bot.',
    },
    maxNotionalCap: {
      what: 'Tope del valor de la posición que comparten varias estrategias. Aquí tiene el mismo sentido que Exposición máxima.',
      affects:
        'Manda el menor de los dos: el plan, la Revisión y la validación usan ese. Con este solo, sin Exposición máxima, la retícula ya tiene freno y la app no avisa de que falte.',
      tip: 'Configura Exposición máxima y deja este vacío, salvo que quieras un segundo techo aún más bajo.',
    },
    direction: {
      what: 'Hacia donde se inclinaría la retícula. El motor no lo lee: en neutral, largo o corto la retícula es la misma, compras bajo el ancla y ventas encima.',
      affects:
        'No sesga ninguna orden ni cambia la Revisión, que enseña los dos lados, ni la validación, que mide la liquidación siempre contra el corto; la app avisa si lo cambias. Neutral es lo que le da sentido a esta estrategia.',
      tip: 'Déjalo en Neutral. No se puede cambiar después.',
    },
  },
};

import type { GridMartConfig } from '@crypton/strategy-core';
import { LADDER_OPTION_DOCS } from './ladder-options';
import type { StrategyGuide } from './types';

export const GRIDMART_GUIDE: StrategyGuide<GridMartConfig> = {
  headline:
    'La escalera de seguridad de la martingala más una rejilla de ventas sobre el núcleo de la posición, con recompra automática bajo cada venta ejecutada.',
  risk: 'ALTO',
  bestFor:
    'Sacar rendimiento a una posición mientras esperas. Donde la martingala solo espera al objetivo final, GridMart va vendiendo trozos del núcleo en las subidas y recomprándolos más abajo, cobrando el vaivén por el camino.',
  howItWorks: [
    'El arranque es idéntico a la martingala: entrada base y escalera de seguridades por debajo, cada una más lejos y más grande.',
    'La posición se divide en dos partes. El NÚCLEO es lo que compró la entrada base; el SATÉLITE es todo lo que añadieron las seguridades.',
    'El satélite tiene su propia orden de cierre, a un objetivo corto sobre el punto de equilibrio, en % de tu margen: es la parte que se deshace en el primer rebote.',
    'El núcleo NO se cierra de golpe. Sobre él se tiende una rejilla de ventas escalonadas hacia arriba, cada una más lejos que la anterior.',
    'Cada venta de la rejilla que se ejecuta deja anotada una recompra por debajo, al precio de esa venta menos el descuento que fijes. Cuando la recompra entra, ese escalón vuelve a estar disponible para venderse otra vez.',
    'Ese ciclo de vender arriba y recomprar abajo se repite sobre el mismo núcleo mientras el precio oscile.',
    'En corto es el espejo: las seguridades van por encima, las ventas de la rejilla son recompras por debajo y cada una se vuelve a vender más arriba.',
  ],
  goodWhen: [
    'Esperas una caída seguida de un lateral: la escalera te posiciona y la rejilla monetiza el vaivén posterior.',
    'Quieres que la posición trabaje en vez de estar quieta esperando un único objetivo.',
    'Ya entiendes la martingala. GridMart es la martingala más una capa encima, y hereda todos sus riesgos.',
  ],
  badWhen: [
    'Es la estrategia más compleja y una de las dos de riesgo alto. Si es tu primer bot, empieza por la rejilla clásica.',
    'El par cae sin rebotar: heredas el peor caso completo de la martingala, con la posición entera abierta en pérdidas.',
    'Quieres algo predecible. Aquí conviven cuatro mecanismos a la vez: escalera, cierre del satélite, rejilla de ventas y recompras.',
  ],
  examples: [
    {
      title: 'GridMart completo sobre ETH',
      venue: 'Lighter',
      pair: 'ETH/USDC',
      price: '2.503 USDC',
      setup: [
        { label: 'Capital', value: '800 USDC' },
        { label: 'Apalancamiento', value: '2x' },
        { label: 'Seguridades', value: '5 · sep. 3 % · dist. 1,3 · vol. 1,3' },
        { label: 'Take profit satélite', value: '1,6 % del margen' },
        { label: 'Ventas de rejilla', value: '4' },
        { label: 'Separación inicial de venta', value: '1 %' },
        { label: 'Multiplicador de distancia', value: '1,2' },
        { label: 'Núcleo vendido en el nivel 1', value: '25 %' },
        { label: 'Descuento de recompra', value: '0,5 %' },
      ],
      outcome:
        'La entrada base compra unos 0,05 ETH: ese es el núcleo. Sobre el se tienden cuatro ventas en 2.528, 2.558, 2.594 y 2.637, de 25 % del núcleo cada una, unos 32 USDC por orden. Si ETH sube a 2.530 se ejecuta la primera y queda anotada una recompra en 2.515; cuando el precio vuelve a bajar, recompra y ese escalón vuelve a estar disponible. Por debajo, las seguridades esperan en 2.428, 2.330, 2.203, 2.038 y 1.824, cubriendo un 27 % de caída. El satélite sale con un 1,6 % del margen, un 0,8 % del precio sobre el punto de equilibrio.',
    },
    {
      title: 'Modo clásico: martingala pura, sin rejilla',
      venue: 'Lighter',
      pair: 'BTC/USDC',
      price: '78.910 USDC',
      setup: [
        { label: 'Modo clásico', value: 'Activado' },
        { label: 'Capital', value: '600 USDC' },
        { label: 'Apalancamiento', value: '2x' },
        { label: 'Seguridades', value: '6 · sep. 2,5 % · dist. 1,35 · vol. 1,5' },
        { label: 'Take profit satélite', value: '2,4 % del margen' },
      ],
      outcome:
        'Con el modo clásico activado desaparecen la rejilla de ventas y las recompras: queda una única orden de cierre sobre la posición entera al 2,4 % del margen, un 1,2 % del precio sobre la media, exactamente como una martingala. Las seguridades caen en 76.937, 74.274, 70.679, 65.825, 59.272 y 50.427: un 36 % de cobertura. Con todas llenas la media queda en 59.437 y la liquidación exacta a 2x en 30.481, un 61 % por debajo del precio de hoy. Es la forma de usar GridMart cuando quieres el comportamiento simple.',
    },
    {
      title: 'SOL con rejilla ancha y recompras frecuentes',
      venue: 'Lighter',
      pair: 'SOL/USDC',
      price: '138,42 USDC',
      setup: [
        { label: 'Capital', value: '700 USDC' },
        { label: 'Apalancamiento', value: '2x' },
        { label: 'Seguridades', value: '4 · sep. 4,5 % · dist. 1,3 · vol. 1,4' },
        { label: 'Ventas de rejilla', value: '5' },
        { label: 'Separación inicial de venta', value: '1,5 %' },
        { label: 'Multiplicador de distancia', value: '1,15' },
        { label: 'Núcleo vendido en el nivel 1', value: '20 %' },
        { label: 'Descuento de recompra', value: '1 %' },
      ],
      outcome:
        'El núcleo son unos 0,92 SOL y se reparte en cinco ventas del 20 % cada una, en 140,5, 142,9, 145,6, 148,8 y 152,4, de unos 26 USDC por orden. El descuento de recompra del 1 % es menor que la separación del 1,5 %: la primera recompra queda en 139,1, por encima de donde entró el núcleo, así que se vuelve a tocar con facilidad y el núcleo se repone. Las seguridades esperan en 132,19, 124,09, 113,57 y 99,88, y el satélite sale con el 1,2 % del margen de fábrica, un 0,6 % del precio.',
    },
  ],
  options: {
    ...LADDER_OPTION_DOCS,
    classicMode: {
      what: 'Apaga la rejilla de ventas y las recompras. El bot se comporta como una martingala normal.',
      affects:
        'Activado, queda una sola orden de cierre sobre la posición entera al objetivo del satélite, y todos los parámetros de rejilla y recompra dejan de tener efecto.',
      tip: 'No se puede cambiar después. Actívalo si quieres la simplicidad de la martingala manteniendo esta estrategia.',
    },
    satelliteTpPct: {
      what: 'Beneficio al que se cierra el SATÉLITE —todo lo que añadieron las órdenes de seguridad—, en % de tu margen y medido desde el punto de equilibrio de la posición: a 2x, un 1,2 % del margen es un 0,6 % del precio.',
      affects:
        'Es la salida rápida del bot. Bajarlo hace que el satélite se deshaga en el primer repunte y libere margen; subirlo lo mantiene más tiempo y expuesto al siguiente movimiento en contra.',
      tip: 'Suele ser corto a propósito: por debajo del 1 % del precio. Si en precio no llega al 0,3 %, las comisiones pueden comérselo y la app avisa. Con el modo clásico activado, este es el objetivo de la posición entera.',
    },
    gridSellCount: {
      what: 'Cuántas ventas escalonadas se tienden sobre el núcleo.',
      affects:
        'Más ventas trocean el núcleo en porciones más pequeñas y reparten los cierres por un tramo más ancho de subida. Menos ventas concentran el núcleo en pocos precios.',
      tip: 'Cuida que el núcleo dividido entre las ventas siga dando órdenes por encima del mínimo del par, unos 10 USDC.',
    },
    gridSellInitialSeparationPct: {
      what: 'A qué distancia del punto de equilibrio se coloca la PRIMERA venta de la rejilla —por encima en largo, por debajo en corto—, en % del precio.',
      affects:
        'Separaciones cortas venden pronto y a menudo, cobrando movimientos pequeños. Separaciones largas esperan subidas de verdad y dejan el núcleo quieto mientras tanto.',
      tip: 'Tiene que ser MAYOR que el descuento de recompra. La recompra queda siempre mejor que su venta, pero con un descuento mayor que la separación queda también más allá de donde entró el núcleo: el escalón puede quedarse vendido mucho tiempo y el núcleo se va vaciando. La app te avisa.',
    },
    gridSellDistanceMultiplier: {
      what: 'Cuánto se aleja cada venta respecto de la anterior. Con 1 todas van a la misma distancia.',
      affects:
        'Subirlo abre la rejilla en abanico: las primeras ventas siguen cerca y las últimas se van muy arriba, reservando parte del núcleo para una subida grande.',
      tip: 'Entre 1,1 y 1,3 mantiene la rejilla razonablemente compacta.',
    },
    corePctSoldAtLevel1: {
      what: 'Qué porcentaje del núcleo se vende en la primera línea de la rejilla.',
      affects:
        'Con 25 % y cuatro ventas de igual tamaño, el núcleo se agota justo en la última línea. Subirlo vende mucho en el primer repunte; bajarlo guarda casi todo el núcleo para precios más altos.',
      tip: 'La última venta se lleva lo que quede, así que la rejilla vende siempre el núcleo entero: con un 10 % y cuatro ventas iguales, la última vende el 70 %.',
    },
    gridSellQtyMultiplier: {
      what: 'Cuánto crece o mengua cada venta respecto de la anterior. Con 1 todas venden la misma cantidad.',
      affects:
        'Por encima de 1 las ventas de arriba son mayores: vendes más cuanto más sube. Por debajo de 1 son menores: sueltas mucho pronto y guardas poco para el final.',
      tip: 'Empieza en 1. Una venta que se pasaría del núcleo que queda se recorta, y la última se lleva lo que quede.',
    },
    gridRebuyDiscountPct: {
      what: 'Cuánto mejor que el precio de una venta ejecutada se anota su recompra —por debajo en largo, por encima en corto—, en % del precio.',
      affects:
        'Es el beneficio de cada vuelta completa de la rejilla. Descuentos pequeños recompran enseguida y reciclan el escalón a menudo; descuentos grandes esperan caídas mayores y pueden dejar el escalón vendido mucho tiempo.',
      tip: 'Mantenlo por debajo de la separación inicial de venta. Si es mayor, las recompras quedan tan lejos que el núcleo se va vaciando sin reponerse, y la app te avisa.',
    },
    maxNotionalCap: {
      what: 'Tope duro del valor de la posición. En esta estrategia el motor SI lo consulta al tender la escalera.',
      affects:
        'Corta la escalera en el escalón en que se alcanza el tope, sin tocar la rejilla de ventas ni las recompras ya anotadas.',
      tip: 'Mira el peor caso del preview para elegir la cifra.',
    },
    leverage: {
      what: 'Cuántas veces multiplica el exchange el margen que le das.',
      affects:
        'Como en la martingala, acorta la escalera que cabe: la app la recorre nivel a nivel con la media de lo ya comprado y, si la liquidación llega antes que una seguridad, rechaza la configuración en margen aislado (en cruzado, avisa). El take profit satélite y el stop van en % de tu margen: con más apalancamiento quedan más cerca en precio.',
      tip: 'Lo que cabe depende también de la escala de volumen, porque la media baja con cada escalón: la app te dice qué seguridad no llegaría.',
    },
  },
};

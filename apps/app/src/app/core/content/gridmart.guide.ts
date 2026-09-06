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
    'El satélite tiene su propia orden de cierre, a un objetivo corto sobre el punto de equilibrio: es la parte que se deshace en el primer rebote.',
    'El núcleo NO se cierra de golpe. Sobre él se tiende una rejilla de ventas escalonadas hacia arriba, cada una más lejos que la anterior.',
    'Cada venta de la rejilla que se ejecuta deja anotada una recompra por debajo, al precio de esa venta menos el descuento que fijes. Cuando la recompra entra, ese escalón vuelve a estar disponible para venderse otra vez.',
    'Ese ciclo de vender arriba y recomprar abajo se repite sobre el mismo núcleo mientras el precio oscile.',
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
        { label: 'Take profit satélite', value: '0,8 %' },
        { label: 'Ventas de rejilla', value: '4' },
        { label: 'Separación inicial de venta', value: '1 %' },
        { label: 'Multiplicador de distancia', value: '1,2' },
        { label: 'Núcleo vendido en el nivel 1', value: '25 %' },
        { label: 'Descuento de recompra', value: '0,5 %' },
      ],
      outcome:
        'La entrada base compra unos 0,05 ETH: ese es el núcleo. Sobre el se tienden cuatro ventas en 2.528, 2.558, 2.594 y 2.637, de 25 % del núcleo cada una, unos 32 USDC por orden. Si ETH sube a 2.530 se ejecuta la primera y queda anotada una recompra en 2.515; cuando el precio vuelve a bajar, recompra y ese escalón vuelve a estar disponible. Por debajo, las seguridades esperan en 2.428, 2.330, 2.203, 2.038 y 1.824, cubriendo un 27 % de caída.',
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
        { label: 'Take profit satélite', value: '1,2 %' },
      ],
      outcome:
        'Con el modo clásico activado desaparecen la rejilla de ventas y las recompras: queda una única orden de cierre sobre la posición entera al 1,2 % de la media, exactamente como una martingala. Las seguridades caen en 76.938, 74.274, 70.679, 65.826, 59.276 y 50.428, un 36 % de cobertura frente al 50 % que separa de la liquidación a 2x. Es la forma de usar GridMart cuando quieres el comportamiento simple.',
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
        'El núcleo son unos 0,92 SOL y se reparte en cinco ventas del 20 % cada una, en 140,5, 142,9, 145,6, 148,8 y 152,4, de unos 26 USDC por orden. El descuento de recompra del 1 % es menor que la separación de 1,5 %, así que cada venta recomprada deja un margen a favor y el núcleo se conserva. Las seguridades esperan en 132,19, 124,09, 113,57 y 99,88.',
    },
  ],
  options: {
    ...LADDER_OPTION_DOCS,
    takeProfitPct: {
      what: 'Objetivo de beneficio heredado de la martingala, sobre el precio medio de la posición. En GridMart NO gobierna ninguna orden.',
      affects:
        'El satélite sale por su propio objetivo y el núcleo se deshace por la rejilla de ventas: el bot no coloca ningún take profit con este porcentaje. Sigue formando parte de las comprobaciones de la escalera antes de crear el bot, y la vista previa pinta con él una orden que el bot no llegará a colocar.',
      tip: 'El número que de verdad marca el ritmo de cierres es el Take profit satélite. El Modo de take profit tampoco tiene efecto aquí: las salidas son siempre limitadas.',
    },
    classicMode: {
      what: 'Apaga la rejilla de ventas y las recompras. El bot se comporta como una martingala normal.',
      affects:
        'Activado, queda una sola orden de cierre sobre la posición entera al objetivo del satélite, y todos los parámetros de rejilla y recompra dejan de tener efecto.',
      tip: 'No se puede cambiar después. Actívalo si quieres la simplicidad de la martingala manteniendo esta estrategia.',
    },
    satelliteTpPct: {
      what: 'Beneficio al que se cierra el SATÉLITE: todo lo que añadieron las órdenes de seguridad, medido sobre su punto de equilibrio.',
      affects:
        'Es la salida rápida del bot. Bajarlo hace que el satélite se deshaga en el primer repunte y libere margen; subirlo lo mantiene más tiempo y expuesto a la siguiente caída.',
      tip: 'Suele ser corto a propósito, por debajo del 1 %. Con el modo clásico activado, este es el objetivo de la posición entera.',
    },
    gridSellCount: {
      what: 'Cuántas ventas escalonadas se tienden sobre el núcleo.',
      affects:
        'Más ventas trocean el núcleo en porciones más pequeñas y reparten los cierres por un tramo más ancho de subida. Menos ventas concentran el núcleo en pocos precios.',
      tip: 'Cuida que el núcleo dividido entre las ventas siga dando órdenes por encima del mínimo del par, unos 10 USDC.',
    },
    gridSellInitialSeparationPct: {
      what: 'A qué distancia por encima del precio se coloca la PRIMERA venta de la rejilla.',
      affects:
        'Separaciones cortas venden pronto y a menudo, cobrando movimientos pequeños. Separaciones largas esperan subidas de verdad y dejan el núcleo quieto mientras tanto.',
      tip: 'Tiene que ser MAYOR que el descuento de recompra: si no, cada venta se recompra más cara de lo que vendió y el núcleo se va vaciando. La app te avisa.',
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
      tip: 'Multiplícalo por el número de ventas para ver cuánto núcleo cubre la rejilla. Si no llega al 100 %, siempre queda una parte sin vender.',
    },
    gridSellQtyMultiplier: {
      what: 'Cuánto crece o mengua cada venta respecto de la anterior. Con 1 todas venden la misma cantidad.',
      affects:
        'Por encima de 1 las ventas de arriba son mayores: vendes más cuanto más sube. Por debajo de 1 son menores: sueltas mucho pronto y guardas poco para el final.',
      tip: 'Empieza en 1. El bot recorta la última venta si la suma se pasara del núcleo disponible.',
    },
    gridRebuyDiscountPct: {
      what: 'Cuánto por debajo del precio de una venta ejecutada se anota su recompra.',
      affects:
        'Es el beneficio de cada vuelta completa de la rejilla. Descuentos pequeños recompran enseguida y reciclan el escalón a menudo; descuentos grandes esperan caídas mayores y pueden dejar el escalón vendido mucho tiempo.',
      tip: 'Mantenlo por debajo de la separación inicial de venta. Si es mayor, cada vuelta pierde núcleo en vez de ganarlo, y la app te avisa.',
    },
    fullCycleCooldownMinutes: {
      what: 'Pensado como espera tras completar un ciclo entero.',
      affects:
        'Hoy no cambia nada: el motor no lo lee. La espera que de verdad se aplica entre ciclos es la del campo común Espera entre ciclos.',
      tip: 'Usa Espera entre ciclos, en la sección de Tiempos. Este campo está en el formulario pero no tiene efecto.',
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
        'Como en la martingala, acorta la escalera que cabe: la app rechaza la configuración si la escalera cubre más recorrido que la distancia a tu liquidación.',
      tip: 'A 2x cabe hasta un 50 % de caída; a 5x, solo un 20 %.',
    },
  },
};

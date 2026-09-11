import type { GridClassicConfig } from '@crypton/strategy-core';
import type { StrategyGuide } from './types';

export const GRID_CLASSIC_GUIDE: StrategyGuide<GridClassicConfig> = {
  headline:
    'Parte un rango de precio en niveles y pone una compra en cada uno. Cuando una se ejecuta, coloca su venta un escalón más arriba.',
  risk: 'BAJO',
  bestFor:
    'Mercados que van de lado. La rejilla no necesita que el precio suba: necesita que se mueva. Cada vaivén dentro del rango es un ciclo de compra y venta cerrado.',
  howItWorks: [
    'Eliges un precio inferior, uno superior y cuántos niveles quieres. El bot reparte el rango en esa cantidad de líneas.',
    'Coloca una orden de compra limitada en cada línea por debajo del precio actual. El capital asignado se reparte a partes iguales entre todos los niveles.',
    'Cuando el precio baja y ejecuta una compra, el bot coloca automáticamente su venta en la línea inmediatamente superior.',
    'Cuando esa venta se ejecuta, has cerrado la diferencia entre las dos líneas. El nivel queda libre y vuelve a colocar su compra.',
    'El ciclo se repite indefinidamente mientras el precio siga dentro del rango.',
  ],
  goodWhen: [
    'El par lleva días o semanas oscilando entre dos precios reconocibles.',
    'Quieres ingresos de la volatilidad sin tener que acertar la dirección.',
    'Prefieres muchas operaciones pequeñas y cerradas antes que una grande y abierta.',
    'Es la más fácil de entender de todas: literalmente comprar abajo y vender arriba, repetido.',
  ],
  badWhen: [
    'El precio está en tendencia clara. Si se va por debajo del rango te quedas con todas las compras ejecutadas y ninguna venta: una posición perdedora completa.',
    'El rango es tan estrecho que el salto entre líneas no cubre ni las comisiones de ida y vuelta.',
    'El par apenas se mueve. Sin oscilación no hay ciclos, y el capital se queda parado.',
  ],
  examples: [
    {
      title: 'Lateral amplio en BTC',
      venue: 'Lighter',
      pair: 'BTC/USDC',
      price: '78.910 USDC',
      setup: [
        { label: 'Rango', value: '72.000 - 86.000' },
        { label: 'Niveles', value: '20' },
        { label: 'Capital', value: '600 USDC' },
        { label: 'Apalancamiento', value: '2x' },
        { label: 'Espaciado', value: 'Aritmético' },
      ],
      outcome:
        'Cada línea queda a unos 737 USDC de la siguiente, un 0,9 % del precio, y mueve 60 USDC de posición. Con el precio en 78.910 hay unas diez compras vivas por debajo. Cada vaivén completo entre dos líneas deja alrededor de 0,55 USDC menos comisiones. Si BTC pierde los 72.000, te quedas con las veinte compras hechas y 1.200 USDC de posición larga esperando a que vuelva.',
    },
    {
      title: 'Acumular SOL sin apalancamiento',
      venue: 'Lighter',
      pair: 'SOL/USDC',
      price: '138,42 USDC',
      setup: [
        { label: 'Rango', value: '120 - 160' },
        { label: 'Niveles', value: '25' },
        { label: 'Capital', value: '500 USDC' },
        { label: 'Apalancamiento', value: '1x' },
        { label: 'Parar al salir del rango', value: 'Si' },
      ],
      outcome:
        'Sin apalancamiento no hay precio de liquidación: el peor caso es quedarte con 500 USDC en SOL comprado a una media cercana a 140. Cada línea mueve 20 USDC, por encima del mínimo de 10 USDC del par y de los 0,1 SOL de cantidad mínima. Con 1,67 USDC entre líneas, cada ciclo cerrado deja un 1,2 % bruto.',
    },
    {
      title: 'Rejilla corta sobre un techo',
      venue: 'Hyperliquid',
      pair: 'ETH/USDC',
      price: '2.503 USDC',
      setup: [
        { label: 'Dirección', value: 'Corto' },
        { label: 'Rango', value: '2.400 - 2.800' },
        { label: 'Niveles', value: '16' },
        { label: 'Capital', value: '400 USDC' },
        { label: 'Apalancamiento', value: '3x' },
      ],
      outcome:
        'En corto todo se invierte: el bot vende en las líneas por encima del precio y recompra un escalón más abajo. Gana mientras ETH siga rebotando bajo los 2.800. El riesgo también se invierte: si rompe por arriba acumulas un corto de 1.200 USDC, y a 3x la liquidación queda en torno a un 33 % por encima de tu media.',
    },
  ],
  options: {
    lowerPrice: {
      what: 'El precio más bajo de la rejilla. Por debajo de él ya no hay ninguna línea.',
      affects:
        'Marca tu peor caso: si el precio lo pierde, todas las compras están hechas y tienes la posición entera abierta en pérdidas. Bajarlo da más margen de caída, pero estira las líneas y separa más los ciclos.',
      tip: 'Míralo como el precio al que estarías cómodo teniendo el capital entero invertido.',
    },
    upperPrice: {
      what: 'El precio más alto de la rejilla. Por encima de él ya no hay ninguna línea.',
      affects:
        'Si el precio lo supera, todas las ventas se han ejecutado, el bot se queda en líquido y deja de operar hasta que vuelva. No pierdes dinero: dejas de ganarlo.',
      tip: 'Que quede por encima del techo que el par ha respetado últimamente, no justo encima del precio de hoy.',
    },
    gridLevels: {
      what: 'En cuantas líneas se parte el rango. Con 20 niveles hay 20 precios de compra repartidos entre el inferior y el superior.',
      affects:
        'Más niveles significa líneas más juntas: más operaciones y más pequeñas. Menos niveles, líneas más separadas: menos operaciones, cada una con más beneficio. El capital se reparte siempre a partes iguales, así que subir niveles reduce el tamaño de cada orden.',
      tip: 'Vigila que el capital dividido entre los niveles siga por encima del mínimo del par, que ronda los 10 USDC. La app te avisa antes de crear el bot.',
    },
    gridSpacing: {
      what: 'Cómo se reparten las líneas. Aritmético deja la misma distancia en USDC entre todas; geométrico deja el mismo porcentaje.',
      affects:
        'En aritmético, un salto de 700 USDC es un 0,9 % arriba del rango y casi un 1 % abajo. En geométrico todas las líneas rinden el mismo porcentaje, así que abajo quedan más juntas en dinero y arriba más separadas.',
      tip: 'Aritmético se lee más fácil. Geométrico compensa mejor en rangos muy amplios, donde el extremo inferior y el superior se diferencian mucho.',
    },
    stopOnRangeExit: {
      what: 'Qué hacer cuando el precio se sale del rango que definiste.',
      affects:
        'Activado, el bot deja de colocar entradas nuevas fuera del rango pero MANTIENE vivas las ventas de lo que ya compró: sigue pudiendo cerrar ciclos si el precio vuelve. Desactivado, sigue operando aunque el precio este fuera de la zona que decidiste.',
      tip: 'Déjalo activado. Es lo que impide que la rejilla persiga al precio fuera de donde tu tesis tenía sentido.',
    },
    sizingMode: {
      what: 'Si el tamaño de cada línea se calcula como valor en USDC o como cantidad fija de moneda.',
      affects:
        'En valor nocional todas las líneas mueven el mismo dinero, así que abajo compras más monedas que arriba y tu precio medio mejora solo. En cantidad, todas compran las mismas monedas y las líneas de abajo comprometen menos dinero.',
      tip: 'Valor nocional es lo habitual en una rejilla, y es lo que viene por defecto.',
    },
  },
};

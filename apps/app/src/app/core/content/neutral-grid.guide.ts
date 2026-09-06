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
    'Reparte los niveles por todo el rango y coloca compras en los que están por debajo del precio actual y ventas en los que están por encima.',
    'El capital no se reparte a partes iguales: los niveles más lejanos al ancla pesan más, para que las entradas fuertes ocurran en los extremos.',
    'Cada vez que una compra se ejecuta, tu posición se vuelve más larga; cada venta, más corta. En el centro del rango la posición neta vuelve a rondar cero.',
    'Alrededor del precio actual el bot deja una banda muerta de medio escalón, para no cancelar y recolocar órdenes en cada movimiento mínimo.',
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
        'Con ETH en 2.503 la posición arranca prácticamente en cero: hay compras colgadas hasta 2.200 y ventas hasta 2.800. Cada vuelta del precio al ancla cierra ciclos por los dos lados. Si ETH se va a 2.200 el bot habra acumulado un largo, pero el tope de 700 USDC corta las compras antes de comprometer los 1.600 USDC que permitiria el apalancamiento.',
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
        'El tope de 500 USDC es la mitad del capital: el bot puede cotizar en las veinte líneas, pero en cuanto la posición neta llega a 500 USDC en cualquier dirección solo deja vivas las órdenes que la reducen. Es la forma de tener una rejilla ancha sin que una ruptura la convierta en una posición direccional grande.',
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
        'Con multiplicador 1,5 las líneas pegadas al ancla mueven poco dinero (23 USDC en 140) y las de los extremos mucho (263 USDC en 115, 175 en 165): el bot apenas se mueve mientras SOL ronde los 138, y carga de verdad si se va a 115 o a 165. Es útil cuando esperas ruido en el centro y quieres reservar la munición para los extremos. Con más niveles o más multiplicador las líneas del centro caen por debajo del mínimo del par y la app rechaza el bot.',
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
      what: 'Tope de la posición NETA del bot, en USDC, mirando los dos lados. Es el freno propio de esta estrategia.',
      affects:
        'Alcanzado el tope, el bot deja vivas únicamente las órdenes que REDUCEN la posición: sigue cerrando, pero no vuelve a cargar en la misma dirección.',
      tip: 'Ponlo siempre. Sin el, la app te avisa por una razón concreta: en una ruptura la posición neta crece hasta agotar el margen.',
    },
    reanchorOnDrift: {
      what: 'Vigila cuánto se ha alejado el precio del ancla que fijaste.',
      affects:
        'Solo informa: cuando se pasa del umbral, el bot lo anota en su estado para que lo veas, pero NO mueve el ancla por su cuenta. Recentrar es editar el Precio ancla (en tibio); el comando Recentrar la retícula no existe para esta estrategia y el menú del bot no lo ofrece.',
      tip: 'Actívalo si quieres el aviso, y recentra tú editando el ancla cuando lo veas.',
    },
    reanchorThresholdPct: {
      what: 'A qué porcentaje de distancia del ancla se considera que el precio se ha ido demasiado.',
      affects: 'Solo decide cuando aparece el aviso anterior. No cambia ni una orden por si mismo.',
      tip: 'Un valor cercano a la mitad de tu rango avisa cuando el precio se acerca a un extremo.',
    },
    maxNotionalCap: {
      what: 'Tope genérico de notional que comparten varias estrategias.',
      affects:
        'En la rejilla neutral el freno que manda es Exposición máxima, que es el que el motor consulta al planificar. Este campo queda como límite adicional y no sustituye a aquel.',
      tip: 'Configura Exposición máxima; deja este vacio salvo que quieras un segundo techo aún más bajo.',
    },
    direction: {
      what: 'Hacia donde se inclina la retícula. Hoy el motor no lo lee al planificar: en neutral, largo o corto la retícula es la misma, compras bajo el ancla y ventas encima.',
      affects:
        'Solo cambia la dirección con la que la vista previa estima la liquidación. No sesga ninguna orden. Neutral es lo que le da sentido a esta estrategia.',
      tip: 'Déjalo en Neutral. No se puede cambiar después.',
    },
  },
};

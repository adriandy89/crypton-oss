import type { MartingaleConfig } from '@crypton/strategy-core';
import { LADDER_OPTION_DOCS } from './ladder-options';
import type { StrategyGuide } from './types';

export const MARTINGALE_GUIDE: StrategyGuide<MartingaleConfig> = {
  headline:
    'Una entrada inicial y varias órdenes de seguridad por debajo, cada una más lejos y más grande. Baja tu precio medio deprisa para cerrar el ciclo con un rebote pequeño.',
  risk: 'ALTO',
  bestFor:
    'Caídas que rebotan. La escalera convierte una bajada en una posición con precio medio bajo, y basta un repunte corto para cerrar el ciclo entero en beneficio.',
  howItWorks: [
    'Con la posición en cero, el bot abre la entrada base: a mercado por defecto, o limitada si prefieres esperar precio.',
    'Debajo cuelga las órdenes de seguridad. La primera va a la separación inicial que hayas puesto, y cada siguiente se aleja más que la anterior según la escala de distancia.',
    'Cada seguridad también es más grande que la anterior, según la escala de volumen. El capital se reparte proporcionalmente entre todos los escalones, así que el capital asignado es un techo real.',
    'Cada seguridad que se ejecuta baja tu precio medio, y el bot recoloca la orden de cierre más abajo, sobre la media nueva.',
    'Cuando el precio recupera el objetivo sobre esa media, se cierra toda la posición de golpe y el ciclo termina.',
  ],
  goodWhen: [
    'El par corrige y rebota con regularidad, y las caídas que ves rara vez pasan de lo que cubre tu escalera.',
    'Tienes claro cual es el peor caso y estas dispuesto a asumirlo: la app te lo enseña entero antes de crear el bot.',
    'Quieres cerrar ciclos con movimientos pequeños a favor, sin esperar a recuperar el precio de la primera entrada.',
  ],
  badWhen: [
    'El par cae y no vuelve. Es el escenario que arruina esta estrategia: cada escalón te deja más dinero dentro de una posición que sigue bajando.',
    'Usas apalancamiento alto. La escalera y el apalancamiento tiran en la misma dirección, y la liquidación llega antes de que se ejecuten los últimos escalones.',
    'No has mirado hasta donde cubre la escalera. Si el precio la agota, el bot deja de promediar y solo queda esperar o asumir la pérdida.',
  ],
  examples: [
    {
      title: 'Escalera equilibrada en ETH',
      venue: 'Lighter',
      pair: 'ETH/USDC',
      price: '2.503 USDC',
      setup: [
        { label: 'Capital', value: '400 USDC' },
        { label: 'Apalancamiento', value: '2x' },
        { label: 'Órdenes de seguridad', value: '6' },
        { label: 'Separación inicial', value: '3 %' },
        { label: 'Escala de distancia', value: '1,3' },
        { label: 'Escala de volumen', value: '1,6' },
        { label: 'Take profit', value: '1,2 %' },
      ],
      outcome:
        'Los escalones caen en 2.428, 2.330, 2.203, 2.038, 1.824 y 1.545: la escalera cubre un 38 % de caída y a 2x la liquidación llega sobre el 50 %, así que se agota antes de que el exchange cierre. La entrada base mueve unos 19 USDC y el último escalón unos 311. Si ETH cae a 1.900 y rebota un 1,2 % sobre la media, el ciclo cierra completo.',
    },
    {
      title: 'BTC conservador, escalera corta',
      venue: 'Lighter',
      pair: 'BTC/USDC',
      price: '78.910 USDC',
      setup: [
        { label: 'Capital', value: '900 USDC' },
        { label: 'Apalancamiento', value: '3x' },
        { label: 'Órdenes de seguridad', value: '6' },
        { label: 'Separación inicial', value: '2 %' },
        { label: 'Escala de distancia', value: '1,25' },
        { label: 'Escala de volumen', value: '1,4' },
        { label: 'Take profit', value: '1 %' },
        { label: 'Tope de exposición', value: '2.400 USDC' },
      ],
      outcome:
        'Escalones en 77.332, 75.359, 72.890, 69.813, 65.960 y 61.140. Cubre un 22,5 % y a 3x la liquidación ronda el 33 %, con margen de sobra. La escala de volumen baja, 1,4, hace que el último escalón no sea desproporcionado frente al primero: se promedia más despacio a cambio de un peor caso más plano.',
    },
    {
      title: 'DOGE agresivo, al filo de la escalera',
      venue: 'Aster',
      pair: 'DOGE/USDT',
      price: '0,09209 USDT',
      setup: [
        { label: 'Capital', value: '300 USDT' },
        { label: 'Apalancamiento', value: '2x' },
        { label: 'Órdenes de seguridad', value: '5' },
        { label: 'Separación inicial', value: '5 %' },
        { label: 'Escala de distancia', value: '1,3' },
        { label: 'Escala de volumen', value: '1,5' },
        { label: 'Take profit', value: '3 %' },
      ],
      outcome:
        'Escalones en 0,08749, 0,08150, 0,07371, 0,06360 y 0,05045. La escalera cubre un 45 % y a 2x la liquidación está sobre el 50 %: se agota justo antes, que es lo más lejos que la app deja llegar sin rechazar la configuración. La entrada base mueve unos 29 USDT y el último escalón unos 219: más de un tercio del capital vive en ese único nivel.',
    },
  ],
  options: {
    ...LADDER_OPTION_DOCS,
    maxNotionalCap: {
      what: 'Tope duro del valor de la posición. En esta estrategia el motor SI lo consulta: corta la escalera en el escalón en que se alcanza.',
      affects:
        'Es el freno independiente de todo lo demas. Si lo pones por debajo de lo que suma la escalera completa, los últimos escalones no llegan a colocarse nunca.',
      tip: 'Útil como segundo techo por si te equivocas con la escala de volumen. Mira el peor caso del preview para elegir la cifra.',
    },
    leverage: {
      what: 'Cuántas veces multiplica el exchange el margen que le das.',
      affects:
        'Aquí pesa el doble que en otras estrategias: además de multiplicar pérdidas, acerca la liquidación y por tanto acorta cuánta escalera cabe. La app RECHAZA la configuración si la escalera cubre más recorrido que la distancia a tu liquidación, porque los últimos escalones no se ejecutarian jamas.',
      tip: 'A 2x cabe una escalera de hasta un 50 % de caída; a 5x, solo un 20 %. Baja el apalancamiento antes que acortar la escalera.',
    },
    cooldownMinutes: {
      what: 'Espera entre el cierre de un ciclo y la apertura del siguiente.',
      affects:
        'Sin espera, el bot vuelve a abrir la entrada base inmediatamente después de cerrar, a veces en mitad del mismo impulso que acaba de darle el beneficio.',
      tip: 'Viene con 1 minuto por defecto. Subirlo evita encadenar ciclos dentro de la misma vela.',
    },
    stopLossPct: {
      what: 'Pérdida máxima sobre el precio medio antes de cerrar la posición.',
      affects:
        'Es la única salida ordenada cuando la escalera se agota y el precio sigue bajando. Sin el, el bot se queda con la posición completa esperando un rebote que puede no llegar.',
      tip: 'Ponlo por debajo del último escalón de la escalera; si lo pones por encima, cierra el ciclo antes de haber terminado de promediar.',
    },
  },
};

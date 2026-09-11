import type { MarketMakerConfig } from '@crypton/strategy-core';
import type { StrategyGuide } from './types';

export const MARKET_MAKER_GUIDE: StrategyGuide<MarketMakerConfig> = {
  headline:
    'Mantiene a la vez una compra por debajo del precio y una venta por encima, y cobra la diferencia cada vez que se ejecutan las dos.',
  risk: 'MEDIO',
  bestFor:
    'Pares liquidos y con movimiento constante. No apuesta a que el precio suba o baje: gana del ir y venir, cobrando el diferencial que hay entre su compra y su venta.',
  howItWorks: [
    'El bot toma el precio medio del libro y coloca una compra a X puntos básicos por debajo y una venta a X por encima. Un punto básico es una centésima de porcentaje: 20 bps es un 0,2 %.',
    'Puede repetirlo en varias capas, cada una más lejos y opcionalmente más grande que la anterior.',
    'Si se ejecutan las dos patas, te quedas la diferencia. Si solo se ejecuta una, has abierto posición en esa dirección.',
    'A medida que se acumula inventario, el bot desplaza el centro de su cotización en contra: si va largo, baja el centro para vender antes y comprar más lejos.',
    'Cuando la posición se acerca a su tope, el bot pasa a modo defensivo: aleja el lado que añade y acerca el que reduce. Al llegar al umbral de alto riesgo deja de añadir por completo.',
    'La cotización se rehace cada cierto tiempo, o antes si el precio se ha movido lo suficiente o si una orden se ha ejecutado.',
  ],
  goodWhen: [
    'El par tiene volumen y el libro es estrecho: hay contrapartida constante a los dos lados.',
    'Quieres ingresos frecuentes y pequeños en vez de operaciones grandes y esporádicas.',
    'Puedes dejar el bot funcionando de forma continua: un market maker gana por acumulación, no por aciertos puntuales.',
  ],
  badWhen: [
    'El par se mueve en tendencia fuerte. Siempre se ejecuta primero el lado equivocado, y acabas comprando toda la bajada.',
    'El diferencial que cotizas no cubre las comisiones de ida y vuelta. Si esto te preocupa, Market maker V2 calcula el mínimo por ti.',
    'El par es ilíquido: sin contrapartida, las órdenes se quedan colgadas y el bot no cierra ciclos.',
  ],
  examples: [
    {
      title: 'Cotizar BTC a tres capas',
      venue: 'Lighter',
      pair: 'BTC/USDC',
      price: '78.910 USDC',
      setup: [
        { label: 'Dirección', value: 'Neutral' },
        { label: 'Tamaño por compra/venta', value: '50 USDC' },
        { label: 'Valor máximo de posición', value: '500 USDC' },
        { label: 'Distancia compra / venta', value: '20 bps / 20 bps' },
        { label: 'Capas', value: '3 · distancia 1,5 · tamaño 1' },
        { label: 'Actualización', value: '30 s' },
        { label: 'Apalancamiento', value: '2x' },
      ],
      outcome:
        'Las compras quedan a 20, 30 y 45 bps por debajo: 78.752, 78.673 y 78.555. Las ventas, simétricas por arriba. Cada capa mueve 50 USDC, así que hay 150 USDC comprometidos por lado, holgados frente al tope de 500. Un ciclo completo de compra y venta a 20 bps deja un 0,4 % bruto sobre los 50 USDC de esa capa.',
    },
    {
      title: 'ETH conservador, con freno temprano',
      venue: 'Hyperliquid',
      pair: 'ETH/USDC',
      price: '2.503 USDC',
      setup: [
        { label: 'Perfil de riesgo', value: 'Conservador' },
        { label: 'Tamaño por compra/venta', value: '40 USDC' },
        { label: 'Valor máximo de posición', value: '300 USDC' },
        { label: 'Distancia compra / venta', value: '25 bps / 25 bps' },
        { label: 'Modo defensivo a partir de', value: '60 %' },
        { label: 'Modo de alto riesgo a partir de', value: '85 %' },
        { label: 'Capas', value: '2' },
      ],
      outcome:
        'El perfil conservador multiplica las distancias por 1,5 y reduce el tamaño al 70 %, así que en la práctica cotiza a unos 37 bps con órdenes de 28 USDC. Cuando la posición pasa de 180 USDC (el 60 % de 300) el bot aleja el lado que añade y acerca el que reduce; a partir de 255 USDC deja de añadir del todo y solo mantiene la salida.',
    },
    {
      title: 'SOL con sesgo largo y ancla manual',
      venue: 'Lighter',
      pair: 'SOL/USDC',
      price: '138,42 USDC',
      setup: [
        { label: 'Dirección', value: 'Intención Long' },
        { label: 'Tamaño por compra/venta', value: '30 USDC' },
        { label: 'Valor máximo de posición', value: '400 USDC' },
        { label: 'Distancia compra / venta', value: '15 bps / 35 bps' },
        { label: 'Precio de referencia', value: '136' },
        { label: 'Sesgo por inventario', value: '1,5' },
        { label: 'No operar por debajo de', value: '120' },
      ],
      outcome:
        'Con la compra a 15 bps y la venta a 35 el bot compra más fácil de lo que vende: acumula SOL a propósito. El precio de referencia de 136 hace que cotice alrededor de ese ancla y no del mercado, así que si SOL sube por encima el bot deja de comprar solo. Por debajo de 120 no abre posición nueva, solo reduce.',
    },
  ],
  options: {
    // ── Microestructura (spec 039) ──────────────────────────────────
    //
    // Todo esto nace APAGADO. Son los mandos que dejan al bot mirar algo más
    // que el punto medio, y cada uno tiene su precio: por eso se encienden de
    // uno en uno y mirando la nota del bot, no todos a la vez.
    fairPriceMode: {
      what: 'De dónde sale el precio justo alrededor del cual se cotiza.',
      affects:
        'Con «Punto medio» es (mejor compra + mejor venta) / 2, que ignora cuánta cantidad hay a cada lado. Con «Microprecio» se pondera cada precio por la cantidad del lado contrario: si hay mucha gente esperando para comprar, el precio justo sube.',
      tip: 'Es el mando con mejor relación beneficio/riesgo de este grupo, y el primero que conviene probar. Requiere que el venue publique los tamaños del libro: Hyperliquid y Aster sí, Lighter no — allí se comporta exactamente igual que «Punto medio».',
    },
    obiSkewFactor: {
      what: 'Cuánto desplaza la cotización el desequilibrio entre las cantidades del mejor bid y del mejor ask.',
      affects:
        'Con más cantidad esperando para comprar, las dos cotizaciones suben. Con 0 el desequilibrio no se mira.',
      tip: 'Empieza en 0,3–0,5. Subirlo mucho hace que el centro se mueva a menudo, y cada movimiento por encima de la «distancia para reajustar» es una recotización más: se paga en cuota del venue y en prioridad en el libro.',
    },
    sizeSkewFactor: {
      what: 'Sesga el TAMAÑO de cada lado según el inventario, en vez de la distancia.',
      affects:
        'Con posición larga, las compras se hacen más pequeñas y las ventas más grandes. Con el tope lleno y el factor al máximo, el lado que añade desaparece.',
      tip: 'Es más suave que mover precios: no sacrifica la probabilidad de que ejecute justo el lado por el que quieres salir. 0,3–0,5 es un buen punto de partida.',
    },
    fundingSkewFactor: {
      what: 'Inclina la cotización hacia el lado al que el exchange está pagando funding.',
      affects:
        'Con funding positivo —los largos pagan— las dos cotizaciones bajan, así que el bot tiende a quedarse corto, que es el lado que cobra. Con funding negativo, al revés.',
      tip: 'Mídelo antes de confiar en él: mira unos días qué funding tiene tu par y cuánto se movería la cotización. Lighter no publica funding, así que allí este mando no hace nada.',
    },
    maxAdverseFundingBps: {
      what: 'Funding en contra a partir del cual el bot deja de ABRIR posición del lado que paga.',
      affects:
        'Con 0 no hay filtro. Por encima del umbral, el lado que se pondría a pagar deja de cotizar; el lado que reduce inventario sigue vivo siempre.',
      tip: 'Un funding extremo y sostenido suele significar que todo el mundo está del mismo lado. No es el mando para empezar.',
    },
    markoutHorizonSeconds: {
      what: 'Cuántos segundos después de cada ejecución se mira dónde está el mercado.',
      affects:
        'Es la medida de si te están eligiendo: si te compran y el precio sigue bajando, el markout es negativo. Con 0 no se mide nada y no se guarda nada.',
      tip: '30–60 s. Por debajo mide ruido; por encima, mide otra cosa. Enciéndelo con la sensibilidad en 0 primero: así lo ves en la nota del bot sin que cambie ninguna orden.',
    },
    markoutSensitivity: {
      what: 'Cuánto se aleja un lado cuando su markout es negativo.',
      affects:
        'La penalización se suma a la distancia de ESE lado. Un markout bueno no acerca la cotización: perseguir al mercado cuando te va bien es la otra forma conocida de perder dinero haciendo mercado.',
      tip: 'Necesita el horizonte encendido. Empieza en 0,5–1 después de haber mirado unos días qué markout tiene tu bot.',
    },
    orderSizePerSide: {
      what: 'Lo que se pone en cada orden, en cada lado. Con varias capas, es el tamaño de la primera.',
      affects:
        'Multiplicado por el número de capas es el dinero que tienes colgado en el libro por lado. Subirlo hace que cada ejecución mueva más posición y llegues antes al tope.',
      tip: 'Que supere el mínimo del par, unos 10 USDC. Si la suma de todas las capas de un lado se pasa del valor máximo de posición, la app te avisa.',
    },
    maxBotPositionValue: {
      what: 'Tope de la posición del bot en cualquier dirección, larga o corta. Es el freno principal de esta estrategia.',
      affects:
        'De el se calculan los umbrales defensivo y de alto riesgo, que van en porcentaje sobre esta cifra. Alcanzado el tope, entra en juego la acción al alcanzar el límite.',
      tip: 'Aquí manda este campo y no el tope de exposición genérico. Sin holgura frente al tamaño por capas, el bot vive permanentemente en modo defensivo.',
    },
    buyDistanceBps: {
      what: 'A cuantos puntos básicos por debajo del precio medio se coloca la compra. 20 bps es un 0,2 %.',
      affects:
        'Distancias cortas se ejecutan mucho y ganan poco en cada vuelta; largas se ejecutan poco y ganan más. Junto a la distancia de venta forma el diferencial que cobras.',
      tip: 'Ponerla más corta que la de venta inclina el bot a acumular; al reves, a vender.',
    },
    sellDistanceBps: {
      what: 'A cuantos puntos básicos por encima del precio medio se coloca la venta.',
      affects:
        'El espejo de la distancia de compra. Las dos juntas definen lo que cobras por vuelta completa.',
      tip: 'Simétricas si quieres neutralidad de verdad.',
    },
    minAllowedDistanceBps: {
      what: 'Suelo duro: el bot no cotiza nunca más cerca del precio que esto, pase lo que pase con el resto de ajustes.',
      affects:
        'Protege de que el sesgo por inventario, el spread dinámico o el ajuste automático acerquen tanto la cotización que dejes de cubrir comisiones.',
      tip: 'Tiene que ser menor o igual que las distancias de compra y de venta; si no, la app rechaza la configuración.',
    },
    layers: {
      what: 'Cuántas órdenes escalonadas se colocan por lado.',
      affects:
        'Más capas cubren un tramo más ancho de precio y capturan movimientos mayores, a costa de tener más dinero colgado en el libro.',
      tip: 'Empieza con 2 o 3. Con una sola capa el bot deja de cotizar en cuanto esa orden se ejecuta.',
    },
    layerDistanceMultiplier: {
      what: 'Cuánto se aleja cada capa respecto de la anterior. Con 1,5 y una primera capa a 20 bps, la segunda va a 30 y la tercera a 45.',
      affects:
        'Subirlo abre la cotización en abanico: la capa cercana se ejecuta a menudo y las lejanas esperan movimientos grandes.',
      tip: 'Tiene que ser mayor que 1 si hay más de una capa: con 1 todas caerían al mismo precio, y esa combinación se rechaza al guardar.',
    },
    layerSizeMultiplier: {
      what: 'Cuánto crece cada capa respecto de la anterior.',
      affects:
        'Por encima de 1 las capas lejanas mueven más dinero: compras más cuanto más cae el precio. Por debajo de 1, menos.',
      tip: 'Empieza en 1. Subirlo mucho convierte al market maker en algo parecido a una martingala.',
    },
    riskProfile: {
      what: 'Ajuste conjunto de distancia y tamaño. Conservador cotiza un 50 % más lejos con órdenes al 70 %; agresivo, un 30 % más cerca con órdenes al 130 %.',
      affects:
        'Es un atajo que multiplica lo que hayas puesto en las distancias y en el tamaño por orden, sin que tengas que tocar cada campo.',
      tip: 'Equilibrado deja tus números tal cual. Usa los otros dos para mover el comportamiento entero de una vez.',
    },
    dynamicSpread: {
      what: 'Ensancha el lado que AÑADE posición a medida que crece el inventario.',
      affects:
        'Activado, cuanto más cargado está el bot más lejos cotiza el lado que sigue cargándolo. El lado que reduce no se toca: encarecer la salida anularía el modo defensivo. Desactivado, la distancia es siempre la que fijaste.',
      tip: 'Déjalo activado: es lo que evita que una tendencia te llene la posición al precio de siempre.',
    },
    inventoryPriceAdjustment: {
      what: 'Desplaza el centro de la cotización en contra del inventario para deshacerlo antes.',
      affects:
        'Activado, con posición larga el bot baja su centro: la venta queda más cerca y la compra más lejos. Desactivado, el centro es siempre el precio medio del libro.',
      tip: 'Activado por defecto. Es lo que hace que el bot tienda a volver a posición cero por si solo.',
    },
    inventorySkewFactor: {
      what: 'Cuánta fuerza tiene ese desplazamiento. Con 0 no hay desplazamiento; con 2, el doble del normal.',
      affects:
        'Subirlo hace que el bot corra más por deshacer el inventario, a costa de vender antes de tiempo en un movimiento a favor.',
      tip: 'Solo tiene efecto si el ajuste de precio por inventario está activado.',
    },
    autoAdjustDistance: {
      what: 'Hace que la distancia siga la anchura real del libro en vez de ser un número fijo.',
      affects:
        'Activado, el bot cotiza al menos un 20 % más ancho que el diferencial que vea en el libro: si el mercado se ensancha, el se ensancha con el. Nunca cotiza más cerca de lo que le pediste.',
      tip: 'Útil en pares cuyo libro cambia mucho de anchura a lo largo del día.',
    },
    postOnly: {
      what: 'Intenta colocar órdenes que no tomen liquidez de inmediato, para pagar siempre comisión de maker.',
      affects:
        'Activado, si una orden fuese a ejecutarse al instante el exchange la rechaza en vez de cruzarla, y el bot la recoloca. Desactivado, puedes acabar pagando comisión de taker, que es la que se come el diferencial. En cualquier caso el bot ya no manda órdenes que crucen el libro: si el precio calculado saldría en el toque contrario, la orden se pega al toque, que nunca empeora tu precio.',
      tip: 'Déjalo activado. El negocio de un market maker es cobrar el diferencial, no pagarlo.',
    },
    refreshSeconds: {
      what: 'Cada cuanto se rehace la cotización aunque el precio no se haya movido.',
      affects:
        'Valores bajos siguen al mercado de cerca y generan más cancelaciones; altos dejan las órdenes más tiempo quietas. Una ejecución rehace la cotización al instante, sin esperar a esto.',
      tip: 'El mínimo es 15 segundos, que es el ritmo al que el motor revisa cada bot. Por debajo no habría diferencia.',
    },
    fillCooldownSeconds: {
      what: 'Congela la cotización durante unos segundos después de una ejecución.',
      affects:
        'Evita que el bot persiga al mercado que acaba de barrer su orden y vuelva a ponerse justo delante del mismo movimiento.',
      tip: 'Con 0 no hay pausa. Unos segundos bastan para dejar pasar el impulso.',
    },
    exitOrderTtlSeconds: {
      what: 'Cuánto tiempo se mantiene viva una orden de salida antes de rehacerla al precio nuevo.',
      affects:
        'Con 0 la orden de salida no caduca nunca y espera al precio que tenía. Con un valor, el bot la retira y la vuelve a poner más cerca del mercado actual, cerrando antes pero a peor precio.',
      tip: 'Déjalo en 0 si prefieres esperar a tu precio; ponlo si te molesta ver salidas colgadas lejos del mercado.',
    },
    defensiveThresholdPct: {
      what: 'Qué porcentaje del tope de posición hace que el bot pase a modo defensivo.',
      affects:
        'En modo defensivo el bot aleja un 50 % el lado que añade posición y acerca un 40 % el que la reduce: sigue cotizando a dos lados, pero empujando hacia la salida.',
      tip: 'Tiene que ser menor que el umbral de alto riesgo, o el modo defensivo no llega a activarse nunca.',
    },
    highRiskThresholdPct: {
      what: 'Qué porcentaje del tope de posición hace que el bot deje de añadir por completo.',
      affects:
        'Superado, el lado que añade posición desaparece del libro y solo queda el que reduce, colocado a la mitad de distancia para salir cuanto antes.',
      tip: 'Es la última línea antes de que actue la acción al alcanzar el límite.',
    },
    maxLongPosition: {
      what: 'Tope específico para el lado largo, en USDC.',
      affects:
        'Permite ser asimétrico: dejar que el bot acumule más en un sentido que en el otro, sin tocar el tope general.',
      tip: 'Déjalo vacio si el tope general te vale para los dos lados.',
    },
    maxShortPosition: {
      what: 'Tope específico para el lado corto, en USDC.',
      affects: 'El espejo del anterior, para limitar cuánto puede acabar vendido el bot.',
      tip: 'Déjalo vacio si el tope general te vale para los dos lados.',
    },
    referencePrice: {
      what: 'Ancla manual. Con esto puesto, el bot cotiza alrededor de este precio y no del mercado.',
      affects:
        'Congela el centro de la cotización donde tu digas. Si el mercado se aleja del ancla más del doble de la capa más lejana, la nota del bot lo dice («Mercado a N bps del ancla…») y las órdenes quedan lejos del precio real. La Espera tras un fill sigue actuando con el ancla puesta.',
      tip: 'Déjalo vacio salvo que quieras cotizar alrededor de un nivel concreto. Si lo pones, mira la nota del bot de vez en cuando: no hay evento aparte.',
    },
    direction: {
      what: 'Hacia qué lado se inclina la cotización. Aquí no describe una posición, sino una intención.',
      affects:
        'En neutral cotiza igual a los dos lados. Con intención long el bot coloca SOLO compras (y con short, solo ventas): acumula sin salida propia, y una posición contraria previa no se deshace sola. Para inclinarte a un lado, deja neutral y acorta la distancia de ese lado.',
      tip: 'Neutral es lo natural en un market maker. No se puede cambiar después.',
    },
    limitAction: {
      what: 'Qué hace el bot cuando la posición toca el valor máximo que le fijaste.',
      affects:
        'Pausar entradas deja de cotizar el lado que añade y espera. Cerrar todo liquida la posición a mercado. Apagar la cierra y además detiene el bot.',
      tip: 'Pausar entradas es lo prudente: el modo de alto riesgo ya ha estado empujando hacia la salida antes de llegar aquí.',
    },
    sizingMode: {
      what: 'Si tecleas los tamaños como valor en USDC o como cantidad de moneda.',
      affects:
        'En valor nocional el bot ajusta la cantidad al precio de cada momento; en cantidad, el valor en USDC de cada orden varía con el precio.',
      tip: 'Valor nocional es lo más fácil de comparar contra el tope de posición.',
    },
    priceFloor: {
      what: 'Por debajo de este precio el bot solo reduce, no abre.',
      affects:
        'Desactiva el lado comprador cuando el precio cae por debajo del nivel a partir del cual ya no quieres seguir acumulando.',
    },
    priceCeiling: {
      what: 'Por encima de este precio el bot solo reduce, no abre.',
      affects:
        'Desactiva el lado vendedor cuando el precio sube por encima de donde ya no quieres seguir vendiendo.',
    },
  },
};

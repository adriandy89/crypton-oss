import type { MarketMakerV2Config } from '@crypton/strategy-core';
import type { StrategyGuide } from './types';

export const MARKET_MAKER_V2_GUIDE: StrategyGuide<MarketMakerV2Config> = {
  headline:
    'Un market maker en el que el diferencial no se fija: se calcula, sumando la volatilidad del momento, la anchura del libro y lo que cuesta abrir y cerrar la operación.',
  risk: 'MEDIO',
  bestFor:
    'Cotizar de forma continua sin tener que reajustar a mano cuando el mercado cambia de ritmo. Es la versión pensada para no cotizar nunca por debajo de lo que cuesta operar.',
  howItWorks: [
    'El bot parte de una distancia base en puntos básicos, igual que el market maker clásico. Un punto básico es una centésima de porcentaje.',
    'A esa base le SUMA la anchura del libro y la volatilidad medida en los últimos minutos, multiplicada por el factor que elijas. Cuanto más nervioso está el mercado, más ancho cotiza.',
    'También le suma el coste de la operación completa: la comisión por lado contada dos veces, más el colchon de seguridad que quieras.',
    'Por debajo calcula un suelo: la comisión de ida y vuelta más el margen mínimo de beneficio que exijas. El bot NUNCA cotiza más cerca que ese suelo.',
    'Por arriba hay un techo, para que un pico de volatilidad no lo mande a cotizar absurdamente lejos.',
    'Puede anclarse al precio de Binance en vez de al del propio exchange. Si esa fuente se cae o se queda rancia, el bot deja de cotizar en vez de caer en silencio al precio local.',
    'Opcionalmente espera a que el precio cruce un disparador antes de empezar. Una vez armado, se queda armado.',
  ],
  goodWhen: [
    'Quieres que el bot se adapte solo a mercados tranquilos y nerviosos sin que tengas que tocar nada.',
    'Te importa asegurar que cada vuelta completa deja beneficio limpio después de comisiones.',
    'Operas en un DEX pequeño y prefieres anclar el precio al de un mercado más grande y líquido.',
  ],
  badWhen: [
    'Quieres control directo del diferencial. Aquí lo que escribes es un punto de partida, no el número final.',
    'Es la estrategia con más parámetros de las ocho. Si buscas algo simple, el market maker clásico hace lo mismo con la mitad de ajustes.',
    'El par no tiene volumen: por muy bien calculado que esté el diferencial, sin contrapartida no hay ciclos.',
  ],
  examples: [
    {
      title: 'BTC con el diferencial compuesto',
      venue: 'Lighter',
      pair: 'BTC/USDC',
      price: '78.910 USDC',
      setup: [
        { label: 'Tamaño por compra/venta', value: '60 USDC' },
        { label: 'Inversión / posición máxima', value: '600 USDC' },
        { label: 'Distancia compra / venta', value: '20 bps / 20 bps' },
        { label: 'Estimación de comisión', value: '2 bps' },
        { label: 'Margen mínimo de beneficio', value: '8 bps' },
        { label: 'Spread dinámico', value: 'Si · libro 1,5 · vol. x0,35' },
        { label: 'Spread dinámico máximo', value: '100 bps' },
      ],
      outcome:
        'El suelo sale de 2 bps por lado contados dos veces más 8 de margen: 12 bps, por debajo de los cuales el bot no cotiza. Con una volatilidad medida de 25 bps, la parte dinámica añade 1,5 + 25 x 0,35 = 10,25 bps. El total queda en 40 + 10,25 + 4 = 54 bps, un 0,54 %: compra en 78.484 y vende en 79.336. Si el mercado se calma y la volatilidad baja a 5 bps, el mismo bot pasa a cotizar sobre 47 bps sin que toques nada.',
    },
    {
      title: 'ETH anclado al precio de Binance',
      venue: 'Hyperliquid',
      pair: 'ETH/USDC',
      price: '2.503 USDC',
      setup: [
        { label: 'Fuente de precio', value: 'Binance' },
        { label: 'Origen del precio justo', value: 'Global desde la fuente' },
        { label: 'Tipo de mercado de origen', value: 'Perpetuo' },
        { label: 'Distancia compra / venta', value: '25 bps / 25 bps' },
        { label: 'Estimación de comisión', value: '2,5 bps' },
        { label: 'Margen mínimo de beneficio', value: '10 bps' },
        { label: 'Tamaño por compra/venta', value: '50 USDC' },
      ],
      outcome:
        'El bot cotiza alrededor del precio de ETHUSDT perpetuo en Binance, no del libro de Hyperliquid: si el DEX se desvia del mercado global, sus órdenes quedan del lado bueno de esa diferencia. El suelo es de 15 bps (5 de ida y vuelta más 10 de margen). Y lo importante: si el feed de Binance se cae o se queda rancio, el bot RETIRA sus órdenes en lugar de seguir cotizando contra un precio que ya no sabe si es bueno.',
    },
    {
      title: 'kPEPE con símbolo alternativo y disparador',
      venue: 'Hyperliquid',
      pair: 'kPEPE/USDC',
      price: '0,004133 USDC',
      setup: [
        { label: 'Fuente de precio', value: 'Binance' },
        { label: 'Símbolo de origen alternativo', value: '1000PEPEUSDT' },
        { label: 'Tipo de mercado de origen', value: 'Spot' },
        { label: 'Condición de activación', value: 'Cuando baje a 0,00400' },
        { label: 'Tamaño por compra/venta', value: '25 USDC' },
        { label: 'Capas', value: '3 · distancia 1,2' },
        { label: 'Usar tamaño normal hasta el máximo', value: 'Si' },
      ],
      outcome:
        'Sin el símbolo alternativo el bot pediria kPEPEUSDT a Binance, que no existe; con el, consulta 1000PEPEUSDT y el precio llega bien. La condición de activación lo mantiene parado hasta que kPEPE baje de 0,00400: hasta entonces no coloca ni una orden. En cuanto lo cruza queda armado para siempre y empieza a cotizar sus tres capas.',
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
    inventoryPriceAdjustment: {
      what: 'Desplaza el centro de la cotización en contra del inventario para deshacerlo antes.',
      affects:
        'Con posición larga el centro baja: la venta queda más cerca y la compra más lejos, así que el bot tiende solo a volver a cero. Sin esto, lo único que reacciona al inventario son los modos de riesgo.',
      tip: 'La V1 lo tiene encendido desde siempre; aquí llega apagado para no cambiar la conducta de los bots que ya existen. Enciéndelo: es lo que hace que un market maker no se quede atrapado del lado equivocado.',
    },
    inventorySkewFactor: {
      what: 'Con cuánta fuerza empuja ese desplazamiento.',
      affects: 'Con 0 no hay. Con 2, el doble que con 1.',
      tip: 'Empieza en 1. Subirlo hace que el bot corra más por deshacer inventario, a costa de vender antes de tiempo en un movimiento que le venía bien.',
    },
    trendGuardEfficiency: {
      what: 'Eficiencia de la tendencia a partir de la cual el bot deja de ABRIR contra ella.',
      affects:
        'Mide cuánto del recorrido del precio es avance y cuánto es ir y venir: 1 es una línea recta y 0 es puro vaivén. Por encima del umbral, el lado que pelea contra la dirección del mercado deja de cotizar; el que reduce sigue vivo.',
      tip: '0,6–0,7. Es la respuesta al único riesgo de verdad de esta estrategia: que el precio no vaya y venga, sino que se vaya en línea recta. Con 0 está apagado.',
    },
    volEstimator: {
      what: 'Cómo se convierte en un número el recorrido del precio de la ventana.',
      affects:
        '«Recorrido» es máximo menos mínimo, y crece con el número de muestras: dos bots con la misma volatilidad real pero distinto ritmo de refresco miden cosas distintas. «Parkinson» divide por la raíz de dos veces el logaritmo de las muestras y quita esa dependencia.',
      tip: '⚠️ Parkinson da números MUCHO más pequeños que Recorrido, así que al cambiarlo hay que volver a ajustar el multiplicador de volatilidad. Por eso no es el valor de fábrica.',
    },
    behaviorPreset: {
      what: 'Ajuste conjunto de distancia y tamaño. Conservador cotiza más lejos con órdenes más pequeñas; agresivo, más cerca y más grandes.',
      affects:
        'Multiplica lo que hayas puesto en las distancias y en el tamaño por orden, sin que tengas que tocar cada campo por separado.',
      tip: 'Equilibrado deja tus números tal cual.',
    },
    orderSizePerSide: {
      what: 'Lo que se pone en cada orden, en cada lado. Con varias capas, es el tamaño de la primera.',
      affects:
        'Multiplicado por el número de capas es el dinero colgado en el libro por lado. Subirlo hace que cada ejecución mueva más posición.',
      tip: 'Que supere el mínimo del par, unos 10 USDC.',
    },
    maxBotPositionValue: {
      what: 'Tope de la posición del bot en cualquier dirección. Es el freno principal de esta estrategia.',
      affects:
        'De el se calculan los umbrales defensivo y de alto riesgo, y contra él se recorta el tamaño de la última capa que cabe.',
      tip: 'Aquí manda este campo y no el tope de exposición genérico.',
    },
    buyDistanceBps: {
      what: 'Punto de PARTIDA del diferencial de compra, en puntos básicos. No es la distancia final: el resto de la fórmula suma sobre esto.',
      affects:
        'Sube o baja todo el conjunto. La distancia real que verás será esta más la parte dinámica, más el coste de operar, siempre acotada entre el suelo y el techo.',
      tip: 'Si te sorprende ver el bot cotizando más lejos de lo que escribiste, es justo esto: la fórmula suma.',
    },
    sellDistanceBps: {
      what: 'Punto de partida del diferencial de venta, en puntos básicos.',
      affects: 'El espejo del anterior. Asimetricos inclinan el bot hacia acumular o hacia vender.',
      tip: 'Simétricos si quieres neutralidad de verdad.',
    },
    minAllowedDistanceBps: {
      what: 'Suelo duro absoluto: el bot no cotiza nunca más cerca del precio que esto.',
      affects:
        'Compite con el suelo calculado (comisión de ida y vuelta más margen mínimo); manda el más alto de los dos.',
      tip: 'A diferencia del market maker clásico, aquí la app no comprueba que sea menor que tus distancias de compra y venta. Revísalo tu.',
    },
    feeEstimateBps: {
      what: 'Lo que te cobra el exchange por lado, en puntos básicos. Se cuenta DOS veces, porque una vuelta completa son dos operaciones.',
      affects:
        'Entra dos veces en la fórmula: eleva el suelo por debajo del cual el bot no cotiza, y se suma a la distancia final para que el coste ya este cubierto.',
      tip: 'Ponla igual a tu comisión real de maker en ese venue. Dejarla en 0 hace que el bot cotice como si operar fuese gratis.',
    },
    safetyBufferBps: {
      what: 'Colchon extra que se suma a la distancia final, por encima del coste ya calculado.',
      affects:
        'Aleja la cotización un poco más de lo estrictamente necesario, para no operar al filo del beneficio cero.',
      tip: 'Unos pocos puntos básicos bastan. Subirlo mucho hace que el bot deje de ejecutar.',
    },
    minProfitMarginBps: {
      what: 'Lo que tiene que quedar limpio después de comisiones en cada vuelta completa.',
      affects:
        'Junto a la comisión forma el SUELO de la cotización: por debajo de ese número el bot sencillamente no cotiza, aunque tus distancias sean menores.',
      tip: 'Es la garantia de que un ciclo cerrado deja dinero. Si lo subes mucho, el bot cotiza tan lejos que casi no se ejecuta.',
    },
    postOnly: {
      what: 'Intenta colocar órdenes que no tomen liquidez de inmediato, para pagar siempre comisión de maker.',
      affects:
        'Activado, el exchange rechaza la orden en vez de cruzarla si fuese a ejecutarse al instante, y el bot la recoloca. Desactivado, puedes pagar comisión de taker. En cualquier caso el bot ya no manda órdenes que crucen el libro: si el precio calculado saldría en el toque contrario, la orden se pega al toque. Importa con el precio anclado a otro exchange, que puede separarse del libro donde se firma la orden.',
      tip: 'Déjalo activado: toda la fórmula de coste asume que operas como maker.',
    },
    defensiveThresholdPct: {
      what: 'Qué porcentaje del tope de posición hace que el bot pase a modo defensivo.',
      affects:
        'En modo defensivo aleja el lado que añade posición y acerca el que la reduce, empujando hacia la salida sin dejar de cotizar.',
      tip: 'Tiene que ser menor que el umbral de alto riesgo. Aquí viene más alto que en el market maker clásico, en 90 %.',
    },
    highRiskThresholdPct: {
      what: 'Qué porcentaje del tope de posición hace que el bot deje de añadir por completo.',
      affects: 'Superado, solo queda viva la cotización del lado que reduce la posición.',
      tip: 'Con el 100 % por defecto, este modo solo se activa justo al tocar el tope.',
    },
    refreshSeconds: {
      what: 'Cada cuanto se rehace la cotización aunque el precio no se haya movido.',
      affects:
        'Es el ritmo de fondo. Una ejecución o un movimiento mayor que la distancia para reajustar la rehacen antes, sin esperar a esto.',
      tip: 'El mínimo son 15 segundos, el ritmo al que el motor revisa cada bot.',
    },
    repriceThresholdBps: {
      what: 'Cuánto tiene que moverse el precio para recotizar antes de tiempo.',
      affects:
        'Valores bajos siguen al mercado de cerca y cancelan mucho; altos dejan las órdenes quietas aunque el precio se aleje.',
      tip: 'Ponlo cerca de tu distancia de cotización o por encima. Muy por debajo, el bot rehace sus órdenes antes de que el mercado llegue a tocarlas y se pasa el día recolocando para nada.',
    },
    orderMaxAgeSeconds: {
      what: 'Edad máxima de una cotización viva antes de rehacerla, aunque el precio no se haya movido.',
      affects:
        'Una orden vieja fue calculada con un libro que ya no existe. Bajarlo mantiene la cotización fresca a costa de más cancelaciones. No caduca el lado al que el mercado se está acercando: esas órdenes están más cerca de ejecutarse cuanto más esperan.',
      tip: 'Con 0 las órdenes no caducan por edad. Es un ajuste que el market maker clásico no tiene.',
    },
    fillCooldownSeconds: {
      what: 'Congela la cotización durante unos segundos después de una ejecución.',
      affects:
        'Evita perseguir al mercado que acaba de barrer tu orden y volver a ponerte delante del mismo movimiento.',
      tip: 'Viene con 35 segundos por defecto, bastante más que en el market maker clásico.',
    },
    exitOrderTtlSeconds: {
      what: 'Cuánto tiempo se mantiene viva una orden de salida antes de rehacerla al precio nuevo.',
      affects:
        'Con 0 la salida espera indefinidamente a su precio. Con un valor, el bot la acerca al mercado actual: cierra antes, a peor precio.',
      tip: 'Déjalo en 0 si prefieres esperar a tu precio.',
    },
    dynamicSpread: {
      what: 'Activa la parte de la fórmula que ensancha la cotización con la volatilidad y la anchura del libro.',
      affects:
        'Desactivado, la distancia final es solo tu base más el coste de operar: un número fijo. Activado, el bot se ensancha solo cuando el mercado se pone nervioso.',
      tip: 'Es lo que distingue a esta versión. Desactivarlo la deja parecida al market maker clásico.',
    },
    volatilitySampleSeconds: {
      what: 'Ventana de tiempo sobre la que se mide el recorrido del precio.',
      affects:
        'Ventanas cortas reaccionan enseguida a un susto y también lo olvidan enseguida. Ventanas largas dan una medida más estable y más lenta.',
      tip: 'Las muestras se toman al recotizar, no en cada instante: con refrescos lentos la ventana efectiva es menor de lo que parece.',
    },
    orderBookMarginBps: {
      what: 'Margen fijo que se suma siempre a la parte dinámica, haya volatilidad o no.',
      affects:
        'Es un suelo de la parte dinámica: garantiza un mínimo de holgura sobre la anchura del libro.',
      tip: 'Valores pequeños, de 1 a 3 bps, son lo habitual.',
    },
    volatilityMultiplier: {
      what: 'Cuánta parte de la volatilidad medida pasa al diferencial. Con 0,35, una volatilidad de 20 bps añade 7.',
      affects:
        'Subirlo hace que el bot se aparte mucho en cuanto hay movimiento, protegiendo del mercado en tendencia a costa de ejecutar menos. Con 0, la volatilidad deja de influir.',
      tip: 'Es el mando principal de esta versión. Toca este antes que las distancias base.',
    },
    maxDynamicSpreadBps: {
      what: 'Techo del diferencial compuesto (base, libro, volatilidad y coste). Se aplica DESPUÉS de los multiplicadores de nivel, de comportamiento y de modo de riesgo: ninguna capa cotiza más ancha que esto.',
      affects:
        'Impide que un pico puntual mande la cotización tan lejos que deje de ejecutarse durante horas. El suelo por coste sigue mandando por debajo. Con 0 no hay techo, y la app lo avisa.',
      tip: 'Tiene que quedar por encima del suelo calculado (comisión de ida y vuelta más margen mínimo); si no, la app rechaza la configuración porque el bot no podría cotizar con beneficio.',
    },
    layers: {
      what: 'Cuántas órdenes escalonadas se colocan por lado.',
      affects:
        'Más capas cubren un tramo más ancho de precio, a costa de tener más dinero colgado en el libro.',
      tip: 'Viene con 1 por defecto, a diferencia del market maker clásico. Con una sola capa el bot deja de cotizar ese lado en cuanto se ejecuta.',
    },
    layerDistanceMultiplier: {
      what: 'Cuánto se aleja cada nivel respecto del anterior.',
      affects:
        'Subirlo abre la cotización en abanico: la cercana se ejecuta a menudo, las lejanas esperan movimientos grandes.',
      tip: 'Viene con 1, que con un solo nivel está bien. En cuanto subas los niveles hay que subirlo también (1,3–1,5): con 1 todos caerían al mismo precio, y esa combinación se rechaza al guardar.',
    },
    layerSizeMultiplier: {
      what: 'Cuánto crece cada capa respecto de la anterior.',
      affects: 'Por encima de 1 las capas lejanas mueven más dinero; por debajo, menos.',
      tip: 'Empieza en 1.',
    },
    useFullSizeUntilMax: {
      what: 'Qué hacer con la última capa cuando ya no cabe entera dentro del tope de posición.',
      affects:
        'Activado, esa capa se coloca completa o no se coloca: nunca verás una orden a medias. Desactivado, se recorta al hueco que quede.',
      tip: 'Actívalo en pares con mínimos altos, donde una capa recortada quedaría por debajo del mínimo y sería rechazada.',
    },
    priceSource: {
      what: 'Contra qué precio se cotiza: el del propio exchange donde opera el bot, o el de Binance como referencia externa.',
      affects:
        'Con Binance el bot cotiza alrededor del precio del mercado grande, no del libro local. Si esa fuente se cae o se queda rancia, el bot DEJA DE COTIZAR en vez de volver en silencio al precio local.',
      tip: 'Binance tiene sentido en pares donde el DEX se desvia del mercado global. Recuerda que añade una dependencia externa.',
    },
    fairPriceOrigin: {
      what: 'De dónde sale exactamente el precio de referencia: el global de la fuente, el punto medio del libro del exchange o su precio de marca.',
      affects:
        'El global sigue al mercado grande. El medio del libro sigue al exchange donde operas. El de marca es el que ese exchange usa para liquidar, más estable que el medio.',
      tip: 'Global desde la fuente es lo coherente si has elegido Binance como fuente de precio.',
    },
    sourceMarketType: {
      what: 'Qué mercado de Binance se consulta: el perpetuo, el de contado o su precio de índice.',
      affects:
        'El perpetuo es el más parecido a lo que operas en un DEX de perpetuos. El de contado no arrastra la prima del perpetuo. El índice es una media de varios mercados y el más estable.',
      tip: 'Perpetuo por defecto, y suele ser la elección correcta.',
    },
    sourceSymbolOverride: {
      what: 'El nombre exacto del par en Binance, cuando allí no se llama igual que en tu exchange.',
      affects:
        'Por defecto el bot pide el símbolo base seguido de USDT: BTC pasa a ser BTCUSDT. Si ese nombre no existe en Binance, no hay precio y el bot no cotiza.',
      tip: 'Es justo el caso de kPEPE en Hyperliquid, que en Binance es 1000PEPEUSDT. Déjalo vacio si el nombre coincide.',
    },
    activationMode: {
      what: 'Condición de precio que tiene que cumplirse para que el bot empiece a cotizar.',
      affects:
        'Con una condición puesta, el bot no coloca ni una orden hasta que el precio cruce el disparador. Una vez armado sigue armado mientras el bot viva: un par casado no cierra el ciclo ni borra el armado, y un retroceso del precio no lo duerme.',
      tip: 'Útil para dejar preparado un bot que solo quieres que arranque a un precio concreto. Parar el bot y volverlo a arrancar sí vuelve a evaluar la condición.',
    },
    activationPrice: {
      what: 'El precio que tiene que cruzarse para que el bot se arme y empiece.',
      affects:
        'Sin condición de activación no hace nada. Con condición puesta, es obligatorio y mayor que cero.',
      tip: 'Ponlo donde de verdad quieras empezar a cotizar, no donde está el precio hoy.',
    },
    positionMode: {
      what: 'Cómo cuenta el exchange una venta cuando ya tienes un largo abierto.',
      affects:
        'Importa más aquí que en ninguna otra estrategia: en modo cobertura, un market maker neutral acumula las dos patas a la vez en vez de compensarlas, y paga margen por las dos.',
      tip: 'Deja Automático. No se puede cambiar después.',
    },
    limitAction: {
      what: 'Qué hace el bot cuando la posición toca su valor máximo.',
      affects:
        'Pausar entradas deja de cotizar el lado que añade. Cerrar todo liquida a mercado. Apagar cierra y detiene el bot.',
      tip: 'Pausar entradas es lo prudente: el modo de alto riesgo ya ha empujado hacia la salida antes de llegar aquí.',
    },
    sizingMode: {
      what: 'Si tecleas los tamaños como valor en USDC o como cantidad de moneda.',
      affects: 'En valor nocional el bot ajusta la cantidad al precio de cada momento.',
      tip: 'Valor nocional es lo más fácil de comparar contra el tope de posición.',
    },
    direction: {
      what: 'Hacia qué lado se inclina la cotización. Aquí no describe una posición, sino una intención.',
      affects:
        'En neutral cotiza igual a los dos lados; con intención long coloca SOLO compras (y con short, solo ventas): acumula sin salida propia y una posición contraria previa no se deshace sola.',
      tip: 'Neutral es lo natural en un market maker. No se puede cambiar después.',
    },
    priceFloor: {
      what: 'Por debajo de este precio el bot solo reduce, no abre.',
      affects:
        'Desactiva el lado comprador cuando el precio cae por debajo de donde ya no quieres seguir acumulando.',
    },
    priceCeiling: {
      what: 'Por encima de este precio el bot solo reduce, no abre.',
      affects:
        'Desactiva el lado vendedor cuando el precio sube por encima de donde ya no quieres seguir vendiendo.',
    },
  },
};

import {
  StrategyKind,
  candleSpanMs,
  type BacktestSource,
  type CandleInterval,
} from '@crypton/shared';

/**
 * Los límites del backtest, redactados para que los lea el administrador.
 *
 * Van SIEMPRE con el resultado y por encima de las cifras. Un resultado de
 * backtest sin sus limitaciones al lado es peor que no tener backtest: invita a
 * tomar por una promesa lo que es una reconstrucción con hipótesis.
 */
export function fidelityWarnings(opts: {
  source: BacktestSource;
  sourceSymbol: string;
  interval: CandleInterval;
  venue: string;
  /** Con la estrategia y su configuración, los avisos propios de cada una. */
  strategy?: StrategyKind;
  config?: Record<string, unknown>;
}): string[] {
  const avisos = [
    // 1. La hipótesis más gorda, y la que más engaña en velas largas.
    `Orden dentro de la vela: una vela no dice si el máximo llegó antes que el ` +
      `mínimo. Se asume apertura → extremo más cercano → el otro → cierre. En ${opts.interval} ` +
      `el error es tanto mayor cuanto más larga sea la vela.`,

    // 2. Favorece al market maker, así que hay que decirlo.
    'Sin profundidad de libro: una orden en reposo se ejecuta ENTERA en cuanto el ' +
      'precio la toca, a su propio precio. No hay ejecuciones parciales ni cola de ' +
      'prioridad para las post-only, así que un market maker sale mejor parado aquí ' +
      'que en el venue.',

    // 3. Y esta hace el resultado OPTIMISTA, que es la dirección peligrosa.
    'Margen de mantenimiento plano (≈0,5 %) en lugar de la escala por tramos que ' +
      'aplica cada venue. Los tramos altos son peores, así que una posición grande ' +
      'revienta ANTES en el venue que aquí.',

    // 4. La que el usuario elige y quizá no dimensiona.
    `Los precios son de ${opts.source} (${opts.sourceSymbol}), no de ${opts.venue}. ` +
      `La moneda es la misma, pero el diferencial, las mechas y los huecos son los de ` +
      `ese otro mercado.`,

    // 5. En posiciones de días puede ser el término dominante del PnL.
    'Sin financiación: los perpetuos cobran o pagan funding cada ocho horas y aquí ' +
      'no está. En estrategias que mantienen posición varios días puede ser el mayor ' +
      'componente del resultado.',

    // 6. Silenciosa y fácil de olvidar.
    'La ficha del mercado (tick, paso y mínimo notional) es la de HOY, no la que ' +
      'regía durante el periodo reproducido.',

    // 7. Las guardas de riesgo. Decía «guardas de cuenta» y sugería que las del
    //    bot sí estaban: no lo están (001/F-65). Solo el stop-loss (orden
    //    condicional) y la liquidación del simulador existen aquí.
    'Guardas de riesgo no simuladas: ni las de cuenta (pérdida diaria global y notional ' +
      'total, que dependen de tus OTROS bots) ni las del bot (pérdida diaria máxima, ' +
      'kill-switch, acción al acercarse la liquidación). En el replay solo existen el ' +
      'stop-loss y la liquidación.',

    // 8 bis. Los datos de microestructura que el replay no puede reconstruir: una
    //    vela no dice cuánta cantidad había en el toque, y la serie no trae la
    //    tasa de funding. Una estrategia que los mire se comporta aquí como si
    //    el venue no los publicara (spec 038).
    'Sin tamaños del toque ni tasa de funding: una vela no dice cuánta cantidad había ' +
      'a cada lado del libro. Una estrategia que use el microprecio, el desequilibrio o ' +
      'el funding se comporta en el replay como si el venue no los publicara.',

    // 8. Hueco que comparte con el modo simulación actual; se declara, no se oculta.
    'El margen retenido por las órdenes en reposo no se descuenta del saldo ' +
      'disponible, así que el capital libre sale algo sobreestimado.',

    // 9. Y la referencia sin la cual un número no significa nada.
    'Compara siempre contra comprar y mantener: un +8 % en un mercado que subió un ' +
      '40 % no es un buen resultado.',
  ];

  // Los market makers son los que más pierden con «un plan() por vela»: todo lo
  // que los define ocurre entre velas, y aquí no ocurre (001/F-65).
  // La de tendencia es la unica que decide sobre VELAS, asi que el replay -que
  // corre plan() una vez por vela- reproduce su cadencia casi exactamente. Lo
  // que no reproduce es el stop de seguimiento entre velas: aqui solo puede
  // moverse una vez por vela, y en el motor se mueve cada quince segundos.
  if (opts.strategy === StrategyKind.TREND_FOLLOW) {
    avisos.push(
      'Tendencia: el stop de seguimiento se mueve UNA vez por vela, no cada quince segundos. ' +
        'En un movimiento rapido el replay lo deja mas atras que el motor, asi que tiende a ' +
        'salir peor de lo que saldria en real, no mejor.',
    );
  }

  // El seguimiento de beneficio tiene el mismo hueco que el stop de tendencia, y
  // uno mas suyo: la MARCA DE AGUA del motor -el maximo visto entre dos
  // planificaciones- no existe en el replay, que solo ve el cierre de la vela.
  // Los dos huecos empujan en la misma direccion: el replay sale mas abajo.
  if (opts.strategy === StrategyKind.TRAILING_PROFIT) {
    avisos.push(
      'Seguimiento de beneficio: el disparador se mueve UNA vez por vela y el maximo se mide ' +
        'sobre el cierre, no sobre lo que el motor ve entre revisiones. Las dos cosas hacen que ' +
        'el replay siga al maximo con retraso y salga por debajo de lo que saldria en real.',
    );
  }

  const esMarketMaker =
    opts.strategy === StrategyKind.MARKET_MAKER || opts.strategy === StrategyKind.MARKET_MAKER_V2;
  if (esMarketMaker) {
    avisos.push(
      'Market maker: se recotiza UNA vez por vela, no cada quince segundos. El intervalo de ' +
        'actualización, la espera tras ejecución y la ventana de volatilidad no se reproducen, ' +
        'y el precio de referencia externo es la propia serie de velas. Recotizar menos de la ' +
        'cuenta hace que el replay ejecute MÁS que el motor, no menos.',
    );
    const maxAge = Number(opts.config?.['orderMaxAgeSeconds'] ?? 0);
    const velaSeg = candleSpanMs(opts.interval) / 1000;
    if (maxAge > 0 && maxAge < velaSeg) {
      avisos.push(
        `«Actualizar órdenes después de» (${maxAge} s) es menor que la vela (${velaSeg} s): las ` +
          'cotizaciones caducan en cada vela y el bot cotiza en vela alterna.',
      );
    }
  }

  return avisos;
}

import type { BacktestSource, CandleInterval } from '@crypton/shared';

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

    // 7. Las guardas que no se pueden reconstruir sin las otras posiciones.
    'Guardas de cuenta no simuladas: la pérdida diaria global y el notional total ' +
      'del usuario dependen de sus OTROS bots, que aquí no existen.',

    // 8. Hueco que comparte con el modo simulación actual; se declara, no se oculta.
    'El margen retenido por las órdenes en reposo no se descuenta del saldo ' +
      'disponible, así que el capital libre sale algo sobreestimado.',

    // 9. Y la referencia sin la cual un número no significa nada.
    'Compara siempre contra comprar y mantener: un +8 % en un mercado que subió un ' +
      '40 % no es un buen resultado.',
  ];

  return avisos;
}

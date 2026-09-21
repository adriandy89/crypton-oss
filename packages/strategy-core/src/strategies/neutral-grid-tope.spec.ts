import { StrategyKind } from '@crypton/shared';
import { getStrategy } from '../registry';
import { makeContext } from '../testing';

/**
 * El aviso del tope de exposición de la retícula neutral.
 *
 * Decía «Tope de exposición alcanzado: solo órdenes que reducen posición» en
 * TODOS los ticks de cualquier bot que tuviera un tope configurado, tendiera la
 * retícula entera o no. La condición era «hay tope», no «el tope ha mordido».
 *
 * Un aviso que miente siempre enseña a ignorar los avisos, y eso es peor que no
 * avisar: el día que el tope muerda de verdad, nadie lo va a leer.
 *
 * El FILTRO nunca estuvo mal —`admitidas` ya llevaba bien las líneas que caben—,
 * solo el mensaje.
 */

const base = {
  exchangeAccountId: 'a',
  symbol: 'TEST',
  direction: 'NEUTRAL' as const,
  lowerPrice: '90',
  upperPrice: '110',
  anchorPrice: '100',
  gridLevels: 5,
  gridSpacing: 'ARITHMETIC' as const,
  sizeMultiplier: '1',
  totalInvestment: '100',
  leverage: 1,
};

const planCon = (extra: Record<string, unknown>, price = '100') =>
  getStrategy(StrategyKind.NEUTRAL_GRID).plan(
    makeContext({
      strategy: StrategyKind.NEUTRAL_GRID,
      config: { ...base, ...extra } as never,
      price,
    }),
  );

describe('Retícula neutral: el aviso del tope (spec 071)', () => {
  it('con tope holgado NO dice que se haya alcanzado', () => {
    // Mil de tope contra una retícula de cinco líneas sobre cien de inversión:
    // cabe entera, así que no hay nada que avisar.
    const plan = planCon({ maxExposure: '1000' });

    expect(plan.orders.length).toBeGreaterThan(0);
    expect(plan.note).not.toContain('Tope de exposición alcanzado');
    expect(plan.note).toContain('órdenes activas');
  });

  it('y sin tope ninguno, tampoco', () => {
    const plan = planCon({});
    expect(plan.note).not.toContain('Tope de exposición alcanzado');
  });

  /**
   * Cuando el tope SÍ deja líneas fuera, el aviso tiene que aparecer: es la
   * única forma de que el usuario sepa por qué su retícula está a medias.
   */
  it('cuando el tope deja líneas fuera, lo dice', () => {
    const holgado = planCon({ maxExposure: '1000' });
    const apretado = planCon({ maxExposure: '25' });

    expect(apretado.orders.length).toBeLessThan(holgado.orders.length);
    expect(apretado.note).toContain('Tope de exposición alcanzado');
  });

  /**
   * Y el filtro sigue haciendo lo suyo: lo que se recorta son las líneas que
   * AÑADEN posición, nunca las que la reducen. Retirar esas dejaría la posición
   * sin contrapartida, que es lo que arruina una retícula.
   */
  it('el tope recorta, pero deja menos órdenes, no ninguna', () => {
    const apretado = planCon({ maxExposure: '25' });
    expect(apretado.orders.length).toBeGreaterThan(0);
  });
});

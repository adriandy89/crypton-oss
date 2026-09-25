import { StrategyKind } from '@crypton/shared';
import { getStrategy } from '../registry';
import { makeContext, makePosition } from '../testing';

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
 * El FILTRO sí estuvo mal hasta el spec 080: con la posición a cero contaba
 * compras y ventas en un solo presupuesto, y tendía la mitad de lo que cabía
 * en cada lado. Y la nota decía «solo órdenes que reducen posición» sin nada
 * que reducir. Ahora dice cuántas líneas deja fuera.
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

// Cinco líneas de 20 USDC a 1×: compras en 90 y 95, ventas en 105 y 110, y la
// de 100 espera a que el precio se aleje de ella.
const planCon = (
  extra: Record<string, unknown>,
  price = '100',
  position: ReturnType<typeof makePosition> | null = null,
) =>
  getStrategy(StrategyKind.NEUTRAL_GRID).plan(
    makeContext({
      strategy: StrategyKind.NEUTRAL_GRID,
      config: { ...base, ...extra } as never,
      price,
      position,
    }),
  );

const lados = (plan: ReturnType<typeof planCon>) => plan.orders.map((o) => o.side).sort();

describe('Retícula neutral: el aviso del tope (spec 071)', () => {
  it('con tope holgado NO dice que se haya alcanzado', () => {
    // Mil de tope contra una retícula de cinco líneas sobre cien de inversión:
    // cabe entera, así que no hay nada que avisar.
    const plan = planCon({ maxExposure: '1000' });

    expect(plan.orders.length).toBeGreaterThan(0);
    expect(plan.note).not.toContain('tope de exposición');
    expect(plan.note).toContain('órdenes activas');
  });

  it('y sin tope ninguno, tampoco', () => {
    const plan = planCon({});
    expect(plan.note).not.toContain('tope de exposición');
  });

  /**
   * Cuando el tope SÍ deja líneas fuera, el aviso tiene que aparecer: es la
   * única forma de que el usuario sepa por qué su retícula está a medias.
   */
  it('cuando el tope deja líneas fuera, lo dice', () => {
    const holgado = planCon({ maxExposure: '1000' });
    const apretado = planCon({ maxExposure: '25' });

    expect(apretado.orders.length).toBeLessThan(holgado.orders.length);
    expect(apretado.note).toBe(
      'Retícula neutral: 2 órdenes activas; el tope de exposición deja fuera 2 líneas.',
    );
  });

  /**
   * Con la posición a cero, cada lado tiene su presupuesto: si el precio baja
   * se llenan las compras y las ventas de arriba no se tocan, así que nunca
   * suman juntas. Con 40 de tope caben las dos compras (≈ 40) y las dos ventas;
   * con un solo presupuesto se tendían una de cada.
   */
  it('con la posición a cero, el tope se aplica a cada lado por separado', () => {
    const plan = planCon({ maxExposure: '40' });
    expect(lados(plan)).toEqual(['BUY', 'BUY', 'SELL', 'SELL']);
    expect(plan.note).toBe('Retícula neutral: 4 órdenes activas.');
  });

  it('con posición, solo cuenta el lado que la agranda, desde lo ya abierto', () => {
    // Largo de 0,2 a 100: 20 abiertos. Cabe la compra de 95 (≈ 40), no la de
    // 90; las dos ventas reducen y se dejan siempre.
    const plan = planCon({ maxExposure: '40' }, '100', makePosition('0.2', '100'));
    expect(lados(plan)).toEqual(['BUY', 'SELL', 'SELL']);
    expect(plan.orders.find((o) => o.side === 'BUY')?.price).toBe('95.0');
    expect(plan.note).toContain('el tope de exposición deja fuera 1 línea.');
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

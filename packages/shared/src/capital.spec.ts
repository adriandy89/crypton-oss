import { capitalActual, retornoSobreMargen, valorDePosicion } from './capital';

/**
 * Spec 025. La aritmética del capital de un bot vive aquí y no en la app: la
 * app no suma dinero, lo pide a `shared` con test (invariante 1).
 */
describe('capitalActual', () => {
  it('es lo asignado más lo realizado más lo abierto, exacto', () => {
    expect(capitalActual('1000', '43.20', '-0.10')).toBe('1043.1');
    // Con `Number`, 0,1 + 0,2 daría 0,30000000000000004.
    expect(capitalActual('0', '0.1', '0.2')).toBe('0.3');
  });

  it('un bot en pérdidas puede valer menos que cero solo si el PnL lo dice', () => {
    expect(capitalActual('100', '-120', '0')).toBe('-20');
  });
});

describe('valorDePosicion', () => {
  it('es la cantidad en valor absoluto por el precio de marca', () => {
    expect(valorDePosicion('0.5', '80000')).toBe('40000');
    expect(valorDePosicion('-0.5', '80000')).toBe('40000');
  });

  it('sin posición vale cero; sin precio no se inventa', () => {
    expect(valorDePosicion('0', '80000')).toBe('0');
    expect(valorDePosicion('0.5', null)).toBeNull();
    expect(valorDePosicion('0.5', '0')).toBeNull();
  });
});

describe('retornoSobreMargen', () => {
  it('es el PnL abierto sobre el margen usado, en %', () => {
    expect(retornoSobreMargen('12.5', '250')).toBe('5.00');
    expect(retornoSobreMargen('-30', '600')).toBe('-5.00');
  });

  it('sin margen no hay porcentaje', () => {
    expect(retornoSobreMargen('12.5', '0')).toBeNull();
    expect(retornoSobreMargen('12.5', null)).toBeNull();
  });
});

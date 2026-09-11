import { D, type Candle } from '@crypton/shared';
import { atr, donchian, rangoVerdadero } from './indicadores';

/**
 * Los indicadores de los que depende el TAMANO de una posicion y el sitio de un
 * stop. Las cifras esperadas estan calculadas a mano, no sacadas de correr el
 * codigo: un test que compara el codigo consigo mismo no prueba nada.
 */

const vela = (o: number, h: number, l: number, c: number, t = 0): Candle => ({
  t,
  o: String(o),
  h: String(h),
  l: String(l),
  c: String(c),
  v: '1',
});

describe('rangoVerdadero', () => {
  it('sin cierre previo es simplemente alto menos bajo', () => {
    expect(rangoVerdadero(vela(100, 105, 98, 103), null).toFixed()).toBe('7');
  });

  it('con un hueco AL ALZA manda la distancia al cierre anterior', () => {
    // Cierra en 90 y la siguiente abre en 100: se movio 15 (105 - 90), no 7.
    expect(rangoVerdadero(vela(100, 105, 98, 103), D(90)).toFixed()).toBe('15');
  });

  it('con un hueco A LA BAJA manda la otra distancia', () => {
    // Cierra en 120 y la siguiente va de 98 a 105: se movio 22 (120 - 98).
    expect(rangoVerdadero(vela(100, 105, 98, 103), D(120)).toFixed()).toBe('22');
  });

  it('sin hueco manda el rango de la propia vela', () => {
    expect(rangoVerdadero(vela(100, 105, 98, 103), D(100)).toFixed()).toBe('7');
  });
});

describe('atr', () => {
  it('es la media de los rangos verdaderos, comprobable a mano', () => {
    // Cuatro velas, tres rangos verdaderos: 10, 10 y 10. ATR(3) = 10.
    const velas = [
      vela(100, 105, 95, 100),
      vela(100, 105, 95, 100),
      vela(100, 105, 95, 100),
      vela(100, 105, 95, 100),
    ];
    expect(atr(velas, 3)!.toFixed()).toBe('10');
  });

  it('un hueco sube el ATR, que es de lo que se trata', () => {
    const sinHueco = [vela(100, 102, 98, 100), vela(100, 102, 98, 100), vela(100, 102, 98, 100)];
    const conHueco = [vela(100, 102, 98, 100), vela(120, 122, 118, 120), vela(100, 102, 98, 100)];
    expect(Number(atr(conHueco, 2))).toBeGreaterThan(Number(atr(sinHueco, 2)));
  });

  it('no se pronuncia con menos velas de las pedidas', () => {
    // Un ATR de catorce calculado sobre tres es un numero con toda la pinta de
    // ser valido, que es lo peligroso.
    expect(atr([vela(100, 101, 99, 100), vela(100, 101, 99, 100)], 14)).toBeNull();
    expect(atr([vela(100, 101, 99, 100)], 1)).toBeNull();
    expect(atr([vela(100, 101, 99, 100), vela(100, 101, 99, 100)], 0)).toBeNull();
  });

  it('con exactamente periodo + 1 velas ya se pronuncia', () => {
    expect(atr([vela(100, 101, 99, 100), vela(100, 102, 98, 100)], 1)!.toFixed()).toBe('4');
  });
});

describe('donchian', () => {
  const serie = [
    vela(100, 110, 90, 100),
    vela(100, 120, 95, 100),
    vela(100, 115, 85, 100),
    vela(100, 130, 99, 125), // la ultima: rompe
  ];

  it('el canal EXCLUYE la vela que rompe', () => {
    // Si la ultima entrara en su propio rango, el maximo seria 130 y nunca lo
    // superaria: el canal tiene que ser el techo que HABIA.
    const c = donchian(serie, 3)!;
    expect(c.alto.toFixed()).toBe('120');
    expect(c.bajo.toFixed()).toBe('85');
    expect(c.cierre.toFixed()).toBe('125');
    expect(Number(c.cierre)).toBeGreaterThan(Number(c.alto)); // hay ruptura
  });

  it('solo mira las `periodo` velas anteriores, no toda la serie', () => {
    const c = donchian(serie, 2)!;
    // Las dos anteriores a la ultima: maximos 120 y 115, minimos 95 y 85.
    expect(c.alto.toFixed()).toBe('120');
    expect(c.bajo.toFixed()).toBe('85');
  });

  it('no se pronuncia sin velas suficientes', () => {
    expect(donchian(serie, 4)).toBeNull();
    expect(donchian(serie, 0)).toBeNull();
  });
});

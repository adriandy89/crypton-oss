import { edicionesDe, mismoValorDeConfig, recolocarBorrador } from './borrador';

/**
 * El borrador de Ajustes (spec 055, 053/H-05).
 *
 * Lo que se prueba es lo que decide si guardar deshace un ajuste que el
 * supervisor de IA —u otro dispositivo— aplicó mientras el dueño editaba.
 */
describe('borrador — lo que el dueño editó', () => {
  const base = { buyDistanceBps: 12, sellDistanceBps: '12', layers: 2, postOnly: true };

  it('sin tocar nada no hay ediciones, aunque cambie el tipo del valor', () => {
    expect(edicionesDe(base, { ...base })).toEqual([]);
    // El formulario devuelve cadenas: '12' y 12 son el mismo valor.
    expect(edicionesDe(base, { ...base, buyDistanceBps: '12', layers: '2' })).toEqual([]);
  });

  it('lo editado es lo que difiere de la base, no de la configuracion actual', () => {
    expect(edicionesDe(base, { ...base, layers: 3, postOnly: false })).toEqual([
      'layers',
      'postOnly',
    ]);
  });

  it('un campo que aparece o desaparece tambien es una edicion', () => {
    expect(edicionesDe(base, { ...base, stopLossPct: '5' })).toEqual(['stopLossPct']);
    const { layers: _quitado, ...sinCapas } = base;
    expect(edicionesDe(base, sinCapas)).toEqual(['layers']);
    // Vaciar y no tener son lo mismo, como en la pantalla.
    expect(edicionesDe({ ...base, stopLossPct: null }, base)).toEqual([]);
  });
});

describe('borrador — recolocar sobre otra version', () => {
  it('lo que cambio entretanto se conserva: es el caso del ajuste de la IA', () => {
    // El dueño empezo a editar sobre la v3; el supervisor subio la distancia en
    // la v4; el dueño cambio las capas. Guardar el borrador entero devolvia la
    // distancia a 12 sin que nadie lo pidiera.
    const v3 = { buyDistanceBps: 12, layers: 2, refreshSeconds: 30 };
    const borrador = { ...v3, layers: 3 };
    const v4 = { ...v3, buyDistanceBps: 14 };

    const r = recolocarBorrador(v3, borrador, v4);

    expect(r.ediciones).toEqual(['layers']);
    expect(r.borrador).toEqual({ buyDistanceBps: 14, layers: 3, refreshSeconds: 30 });
  });

  it('si el dueño toco el mismo campo, gana el dueño', () => {
    const v3 = { buyDistanceBps: 12 };
    const r = recolocarBorrador(v3, { buyDistanceBps: 20 }, { buyDistanceBps: 14 });
    expect(r.borrador).toEqual({ buyDistanceBps: 20 });
  });

  it('un campo nuevo en la version nueva llega al borrador', () => {
    const r = recolocarBorrador({ a: 1 }, { a: 1 }, { a: 1, b: 2 });
    expect(r.borrador).toEqual({ a: 1, b: 2 });
    expect(r.ediciones).toEqual([]);
  });

  it('un campo que el dueño quito se queda quitado', () => {
    const r = recolocarBorrador({ a: 1, b: 2 }, { a: 1 }, { a: 1, b: 5 });
    expect(r.borrador).toEqual({ a: 1 });
    expect(r.ediciones).toEqual(['b']);
  });

  it('no toca las configuraciones que recibe', () => {
    const base = Object.freeze({ a: 1 });
    const borrador = Object.freeze({ a: 2 });
    const actual = Object.freeze({ a: 3, b: 4 });
    expect(() => recolocarBorrador(base, borrador, actual)).not.toThrow();
    expect(actual).toEqual({ a: 3, b: 4 });
  });

  it('un valor reescrito igual no se conserva sobre el ajuste de la IA (spec 056, A-1)', () => {
    // El generador guarda «12.50»; los botones − y + del campo escriben
    // `String(Number(v))`, o sea «12.5». Comparando texto era una edicion: al
    // recolocar se conservaba el 12.5 encima del 15 de la IA, y guardar lo
    // deshacia. Para el servidor no es ningun cambio, y aqui tampoco.
    const v5 = { orderSizePerSide: '12.50', refreshSeconds: 30 };
    const borrador = { orderSizePerSide: '12.5', refreshSeconds: 45 };
    const v6 = { ...v5, orderSizePerSide: '15' };

    const r = recolocarBorrador(v5, borrador, v6);

    expect(r.ediciones).toEqual(['refreshSeconds']);
    expect(r.borrador).toEqual({ orderSizePerSide: '15', refreshSeconds: 45 });
    expect(r.choques).toEqual([]);
  });

  it('dice en que campos la edicion sustituye a lo que cambio debajo (spec 056, A-2)', () => {
    const v3 = { buyDistanceBps: 12, layers: 2, refreshSeconds: 30 };
    const borrador = { ...v3, buyDistanceBps: 20, layers: 3 };
    const v4 = { ...v3, buyDistanceBps: 14, refreshSeconds: 60 };

    const r = recolocarBorrador(v3, borrador, v4);

    expect(r.ediciones).toEqual(['buyDistanceBps', 'layers']);
    // Las capas no cambiaron debajo; el intervalo cambio pero nadie lo edito.
    expect(r.choques).toEqual(['buyDistanceBps']);
    expect(r.borrador).toEqual({ buyDistanceBps: 20, layers: 3, refreshSeconds: 60 });
  });
});

describe('borrador — la igualdad del servidor (spec 056, A-1)', () => {
  it('los numeros se comparan como numeros, se escriban como se escriban', () => {
    expect(mismoValorDeConfig('12.50', '12.5')).toBe(true);
    expect(mismoValorDeConfig(20, '20.0')).toBe(true);
    expect(mismoValorDeConfig('2', 2)).toBe(true);
    expect(mismoValorDeConfig('0.1', 0.1)).toBe(true);
    expect(mismoValorDeConfig('12.5', '12.6')).toBe(false);
  });

  it('vacio y ausente son lo mismo; vacio y un valor, no', () => {
    expect(mismoValorDeConfig(null, undefined)).toBe(true);
    expect(mismoValorDeConfig(null, 0)).toBe(false);
    expect(mismoValorDeConfig(undefined, '5')).toBe(false);
  });

  it('los booleanos se comparan como booleanos', () => {
    expect(mismoValorDeConfig(true, true)).toBe(true);
    expect(mismoValorDeConfig(true, false)).toBe(false);
    expect(mismoValorDeConfig(false, 0)).toBe(true);
  });

  it('el resto se compara como texto', () => {
    expect(mismoValorDeConfig('LONG', 'LONG')).toBe(true);
    expect(mismoValorDeConfig('LONG', 'SHORT')).toBe(false);
    expect(mismoValorDeConfig('long', 'LONG')).toBe(false);
  });

  it('lo editado usa esta igualdad', () => {
    const base = { size: '12.50', layers: 3, postOnly: true };
    expect(edicionesDe(base, { size: '12.5', layers: '3.0', postOnly: true })).toEqual([]);
    expect(edicionesDe(base, { size: '12.6', layers: 3, postOnly: true })).toEqual(['size']);
  });
});

import { aCsv } from './csv';

describe('aCsv', () => {
  it('cabecera de las claves de la primera fila, separador ; y saltos CRLF', () => {
    const out = aCsv([
      { ciclo: 1, neto: '12.5', cerrado: true },
      { ciclo: 2, neto: '-3', cerrado: false },
    ]);
    expect(out).toBe('ciclo;neto;cerrado\r\n1;12.5;true\r\n2;-3;false');
  });

  it('entrecomilla lo que lleva el separador, comillas o saltos, y duplica las comillas', () => {
    const out = aCsv([{ nota: 'a;b', cita: 'dijo "hola"', texto: 'dos\nlíneas' }]);
    expect(out.split('\r\n')[1]).toBe('"a;b";"dijo ""hola""";"dos\nlíneas"');
  });

  it('las columnas pedidas mandan en orden y selección; lo que falta sale vacío', () => {
    const out = aCsv([{ a: 1, b: null, c: 'x' }], ['c', 'a', 'd']);
    expect(out).toBe('c;a;d\r\nx;1;');
  });

  it('sin filas, solo la cabecera pedida; sin nada, cadena vacía', () => {
    expect(aCsv([], ['a', 'b'])).toBe('a;b');
    expect(aCsv([])).toBe('');
  });
});

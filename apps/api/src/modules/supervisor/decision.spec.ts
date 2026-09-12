import { MOVIMIENTOS, SIN_MOVIMIENTO } from './apply';
import {
  ACCIONES,
  CONFIANZAS,
  parseRevision,
  PROMPT_VERSION_REVISION,
  revisionSchema,
  systemPromptRevision,
} from './decision';

/**
 * La doctrina de `advisor/prompt.ts`, convertida en estructura.
 *
 * «Lo unico que acota igual en todos los proveedores, a nivel de gramatica de
 * decodificacion, es `enum`». Si alguien añade un `minimum` a este esquema
 * creyendo que refuerza algo, en realidad crea una barandilla que existe con un
 * proveedor y no con otro — y el enrutado no lo elegimos nosotros. Este fichero
 * lo impide.
 */

type Nodo = Record<string, unknown>;

/** Recorre el esquema entero, incluidos los objetos anidados. */
function recorrer(nodo: unknown, ruta: string, visitar: (n: Nodo, ruta: string) => void): void {
  if (typeof nodo !== 'object' || nodo === null) return;
  if (Array.isArray(nodo)) {
    nodo.forEach((hijo, i) => recorrer(hijo, `${ruta}[${i}]`, visitar));
    return;
  }
  const n = nodo as Nodo;
  visitar(n, ruta);
  for (const [clave, valor] of Object.entries(n)) {
    recorrer(valor, ruta ? `${ruta}.${clave}` : clave, visitar);
  }
}

describe('decision — el esquema solo puede acotar con enum', () => {
  const esquema = revisionSchema();

  it('no contiene ni una restriccion que algun proveedor pueda ignorar', () => {
    const prohibidas = [
      'minimum',
      'maximum',
      'exclusiveMinimum',
      'exclusiveMaximum',
      'multipleOf',
      'minLength',
      'maxLength',
      'pattern',
      'minItems',
      'maxItems',
      'oneOf',
      'anyOf',
      'allOf',
      'not',
      '$ref',
    ];
    const encontradas: string[] = [];
    recorrer(esquema, '', (n, ruta) => {
      for (const p of prohibidas) if (p in n) encontradas.push(`${ruta}.${p}`);
    });
    expect(encontradas).toEqual([]);
  });

  it('no hay ni un campo numerico: todo valor es enumerado o la frase', () => {
    const numericos: string[] = [];
    recorrer(esquema, '', (n, ruta) => {
      if (n['type'] === 'number' || n['type'] === 'integer') numericos.push(ruta);
      // Una cadena sin `enum` solo se admite en el motivo, que es prosa.
      if (n['type'] === 'string' && !('enum' in n) && !ruta.endsWith('motivo')) {
        numericos.push(`${ruta} (cadena libre)`);
      }
    });
    expect(numericos).toEqual([]);
  });

  it('todo objeto cierra sus propiedades y exige todas sus claves', () => {
    // El modo estricto exige que TODO lo de `properties` este en `required`. Un
    // campo opcional rompe la salida estructurada en unos proveedores y en otros
    // no, que es el fallo mas caro de diagnosticar: la funcion falla a ratos.
    recorrer(esquema, '', (n, ruta) => {
      if (!('properties' in n)) return;
      expect(`${ruta || 'raiz'}: additionalProperties`).toBe(
        n['additionalProperties'] === false ? `${ruta || 'raiz'}: additionalProperties` : 'falta',
      );
      const props = Object.keys(n['properties'] as Nodo).sort();
      const req = [...((n['required'] as string[]) ?? [])].sort();
      expect(`${ruta || 'raiz'}: ${req.join(',')}`).toBe(`${ruta || 'raiz'}: ${props.join(',')}`);
    });
  });

  it('los enums son los mismos objetos que usa la traduccion', () => {
    // Dos vocabularios con las mismas bandas derivando por separado es una averia
    // con fecha: el dia que alguien añada un movimiento a uno y no al otro.
    const ajustes = (esquema['properties'] as Nodo)['ajustes'] as Nodo;
    const leverage = (ajustes['properties'] as Nodo)['leverage'] as Nodo;
    expect(leverage['enum']).toEqual([...MOVIMIENTOS]);
    expect(((esquema['properties'] as Nodo)['accion'] as Nodo)['enum']).toEqual([...ACCIONES]);
    expect(((esquema['properties'] as Nodo)['confianza'] as Nodo)['enum']).toEqual([...CONFIANZAS]);
  });

  it('las cinco perillas del esquema son las cinco de la traduccion', () => {
    const ajustes = (esquema['properties'] as Nodo)['ajustes'] as Nodo;
    expect(Object.keys(ajustes['properties'] as Nodo).sort()).toEqual(
      Object.keys(SIN_MOVIMIENTO).sort(),
    );
  });

  it('el perfil NO esta en el esquema', () => {
    // Es lo que hace estables los campos de caracter: `limitAction` sale
    // CLOSE_ALL con perfil prudente y PAUSE_ENTRIES con cualquier otro, y es HOT.
    const json = JSON.stringify(esquema);
    expect(json).not.toContain('profile');
    expect(json).not.toContain('perfil');
  });
});

describe('decision — el parseo no repara, descarta', () => {
  const buena = JSON.stringify({
    accion: 'AJUSTAR',
    ajustes: { ...SIN_MOVIMIENTO, spread: 'MAS' },
    confianza: 'MEDIA',
    motivo: 'La volatilidad ha subido desde que se configuró.',
  });

  it('acepta una respuesta que cumple el contrato', () => {
    const r = parseRevision(buena);
    expect(r).not.toBeNull();
    expect(r?.accion).toBe('AJUSTAR');
    expect(r?.ajustes.spread).toBe('MAS');
    expect(r?.ajustes.leverage).toBe('IGUAL');
  });

  it('una banda fuera del enum tira la respuesta ENTERA', () => {
    // No se repara la perilla mala dejando pasar las otras cuatro: si el modelo
    // se ha salido del contrato, lo que dijo no es de fiar, y al otro lado esta
    // la configuracion de un bot con dinero dentro.
    const mala = JSON.stringify({
      accion: 'AJUSTAR',
      ajustes: { ...SIN_MOVIMIENTO, spread: 'MUCHISIMO_MAS' },
      confianza: 'MEDIA',
      motivo: 'x',
    });
    expect(parseRevision(mala)).toBeNull();
  });

  it('una perilla que falta tira la respuesta', () => {
    const sinCadence = JSON.stringify({
      accion: 'MANTENER',
      ajustes: { leverage: 'IGUAL', coverage: 'IGUAL', spread: 'IGUAL', sizeGrowth: 'IGUAL' },
      confianza: 'ALTA',
      motivo: 'x',
    });
    expect(parseRevision(sinCadence)).toBeNull();
  });

  it('una accion desconocida tira la respuesta', () => {
    // En particular CONTENER, que NO esta en el vocabulario: el supervisor no
    // manda comandos, y si un dia se le añadiera hay que hacerlo a proposito.
    const contener = JSON.stringify({
      accion: 'CONTENER',
      ajustes: SIN_MOVIMIENTO,
      confianza: 'ALTA',
      motivo: 'x',
    });
    expect(parseRevision(contener)).toBeNull();
  });

  it('un JSON roto o vacio no lanza, devuelve nulo', () => {
    expect(parseRevision('')).toBeNull();
    expect(parseRevision('{')).toBeNull();
    expect(parseRevision('null')).toBeNull();
    expect(parseRevision('[]')).toBeNull();
    expect(parseRevision('"texto"')).toBeNull();
  });

  it('el motivo se recorta y nunca se convierte con String()', () => {
    // `String()` sobre un objeto da «[object Object]», y eso acabaria de
    // explicacion en la tarjeta que lee una persona.
    const largo = JSON.stringify({
      accion: 'MANTENER',
      ajustes: SIN_MOVIMIENTO,
      confianza: 'BAJA',
      motivo: 'x'.repeat(1000),
    });
    expect(parseRevision(largo)?.motivo.length).toBe(240);

    const objeto = JSON.stringify({
      accion: 'MANTENER',
      ajustes: SIN_MOVIMIENTO,
      confianza: 'BAJA',
      motivo: { a: 1 },
    });
    expect(parseRevision(objeto)?.motivo).toBe('');
  });

  it('el prompt no promete nada que el esquema no pueda cumplir', () => {
    const p = systemPromptRevision();
    // Le dice explicitamente que NO mencione cifras, que es lo que evita que la
    // frase que lee una persona contradiga a los numeros que calcula el servidor.
    expect(p).toContain('no debes mencionar cifras');
    // Y que no puede tocar lo que la traduccion no le deja tocar.
    expect(p).toContain('No puedes cambiar el capital');
    expect(p).toContain('Tampoco puedes pararlo');
    expect(PROMPT_VERSION_REVISION).toBeGreaterThan(0);
  });
});

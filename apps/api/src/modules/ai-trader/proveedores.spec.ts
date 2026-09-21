import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * La lista de ficheros que hablan con un modelo es **cerrada, corta y auditable**
 * (spec 069).
 *
 * `CLAUDE.md` lo afirma; esto lo hace cumplir. La diferencia importa: una regla
 * que solo está escrita en la documentación se rompe sin que nadie se entere, y
 * lo que se rompe aquí es la propiedad de la que cuelga todo lo demás — que se
 * pueda leer en dos ficheros TODO lo que sale de esta casa hacia un modelo.
 *
 * Si este test falla porque has añadido un proveedor, lo que hay que hacer no es
 * añadirlo a la lista sin más: hay que cambiar también la línea de `CLAUDE.md`,
 * porque deja de ser una lista de dos.
 */

/** Los únicos ficheros que pueden abrir una conexión hacia un modelo. */
const PERMITIDOS = ['modules/advisor/openrouter.client.ts', 'modules/ai-trader/typesafe.client.ts'];

/** Los hosts de modelo conocidos. Uno nuevo aquí es una decisión, no un detalle. */
const HOSTS = ['openrouter.ai', 'api.typesafe.ai'];

const RAIZ = join(__dirname, '..', '..');

function fuentes(dir: string, salida: string[] = []): string[] {
  for (const nombre of readdirSync(dir)) {
    const ruta = join(dir, nombre);
    if (statSync(ruta).isDirectory()) {
      fuentes(ruta, salida);
    } else if (nombre.endsWith('.ts') && !nombre.endsWith('.spec.ts')) {
      salida.push(ruta);
    }
  }
  return salida;
}

const leer = (relativa: string): string => readFileSync(join(RAIZ, relativa), 'utf8');

describe('Los ficheros que hablan con un modelo', () => {
  const ficheros = fuentes(RAIZ);

  it('son exactamente dos, y son los de la lista', () => {
    const conHost = ficheros
      .filter((f) => {
        const texto = readFileSync(f, 'utf8');
        // Una URL de modelo escrita entera: es lo que de verdad abre la conexión.
        return HOSTS.some((h) => texto.includes(`https://${h}`));
      })
      .map((f) => relative(RAIZ, f).split(sep).join('/'))
      .sort();

    expect(conHost).toEqual([...PERMITIDOS].sort());
  });

  /**
   * Los dos no se importan entre sí: un proveedor caído no puede arrastrar al
   * otro, y no puede haber un sitio donde se «unifique el transporte», que es
   * como se pierde la mitad de lo que cada uno sabe de su proveedor.
   */
  it('no se importan entre sí', () => {
    // Por el IMPORT, no por la mención: los dos se citan en sus comentarios a
    // propósito —uno explica que copia el patrón del otro— y eso es bueno.
    const importa = (fichero: string, otro: string): boolean =>
      new RegExp(String.raw`(from|require\()\s*['"][^'"]*` + otro + `['"]`).test(leer(fichero));

    expect(importa(PERMITIDOS[1], 'openrouter.client')).toBe(false);
    expect(importa(PERMITIDOS[0], 'typesafe.client')).toBe(false);
  });

  /**
   * Y la clave no se registra jamás. Un `logger` con la clave dentro la deja en
   * el disco del servidor y en cualquier agregador de logs que haya detrás
   * (invariante 8).
   */
  it('ninguno registra su clave', () => {
    for (const permitido of PERMITIDOS) {
      for (const linea of leer(permitido).split('\n')) {
        if (!/logger\.(log|warn|error|debug|verbose)/.test(linea)) continue;
        // Lo que se busca es la clave INTERPOLADA, no una frase que hable de
        // ella: «la clave no es válida» es justo lo que hay que registrar.
        for (const [, expresion] of linea.matchAll(/\$\{([^}]*)\}/g)) {
          expect(expresion).not.toMatch(/clave|apiKey|API_KEY|token|secret/i);
        }
      }
    }
  });
});

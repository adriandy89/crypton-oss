import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * R-25: el motor de los agentes no lee lo medido.
 *
 * `medicion.ts` etiqueta lo que habría pasado con cada candidato y cada
 * propuesta y hace la tarjeta, y eso se enseña. Ni las familias, ni la
 * herramienta, ni los jueces, ni la propuesta, ni el seguimiento lo importan:
 * decidir con el historial del propio agente sería un cambio de diseño, con su
 * spec. La API tiene su propia comprobación para sus ficheros.
 */

const FUENTES = readdirSync(__dirname).filter(
  (f) => f.endsWith('.ts') && !f.endsWith('.spec.ts') && f !== 'medicion.ts',
);

const sinComentarios = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');

describe('el motor de los agentes no lee lo medido (R-25)', () => {
  it('se miran de verdad los que deciden', () => {
    for (const f of ['herramienta.ts', 'juez.ts', 'propuesta.ts', 'seguimiento.ts']) {
      expect(FUENTES).toContain(f);
    }
  });

  it.each(FUENTES)('%s', (f) => {
    const fuente = sinComentarios(readFileSync(join(__dirname, f), 'utf8'));
    expect(fuente).not.toMatch(/from '\.\/medicion'/);
    expect(fuente).not.toMatch(/\b(tarjetaAgente|estadisticaR|resultadoHipotetico)\b/);
  });
});

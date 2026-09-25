import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * R-25: nada de lo que decide lee lo medido.
 *
 * El resultado hipotético de cada candidato y de cada propuesta, y la tarjeta
 * que sale de ellos, se ENSEÑAN. Si una ronda, una aprobación o un seguimiento
 * los leyera, el agente acabaría decidiendo con su propio historial sin que su
 * dueño lo hubiera decidido —y con una muestra que el spec 070 midió que no
 * separa lo bueno de lo malo—. Leerlos para decidir sería un cambio de diseño,
 * con su spec; no algo que pueda colarse en una línea.
 *
 * Se mira el fuente de cada fichero del módulo, sin comentarios: los que leen
 * lo medido son solo los de la app (`listados*`) y quien lo escribe
 * (`medicion.service.ts`). El módulo, su índice y el reloj solo los cablean.
 */

const DIR = __dirname;
const LEEN_LA_MEDIDA = new Set(['listados.ts', 'listados.service.ts', 'medicion.service.ts']);
const LA_CABLEAN = new Set(['ai-desk.module.ts', 'index.ts', 'ai-desk.scheduler.ts']);

/** Leer lo medido: sus columnas, sus filas o sus cuentas. */
const LECTURAS: readonly RegExp[] = [
  /\.outcome\b/,
  /\boutcome\s*:\s*true\b/,
  /\bmeasured_at\b/,
  /\.measurable\b/,
  /\bmeasurable\s*:\s*true\b/,
  /\baiDeskCandidate\s*\.\s*(findMany|findFirst|findUnique|count|aggregate|groupBy)\b/,
  /\b(tarjetaAgente|estadisticaR|resultadoHipotetico|resultadoHipoteticoDe|filaCandidatoDe)\b/,
];
const IMPORTA_LA_MEDIDA = /from '\.\/(listados|listados\.service|medicion\.service)'/;

/** El fuente sin comentarios: un comentario puede nombrar lo que el código no toca. */
const sinComentarios = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');

const fuentes = readdirSync(DIR).filter(
  (f) => f.endsWith('.ts') && !f.endsWith('.spec.ts') && !f.endsWith('fixture-spec.ts'),
);

describe('nada de lo que decide lee lo medido (R-25)', () => {
  it('se miran de verdad los que deciden', () => {
    for (const f of ['rondas.service.ts', 'aprobacion.service.ts', 'seguimiento.service.ts']) {
      expect(fuentes).toContain(f);
    }
  });

  it.each(fuentes.filter((f) => !LEEN_LA_MEDIDA.has(f)))('%s', (f) => {
    const fuente = sinComentarios(readFileSync(join(DIR, f), 'utf8'));
    for (const p of LECTURAS) expect(fuente).not.toMatch(p);
    if (!LA_CABLEAN.has(f)) expect(fuente).not.toMatch(IMPORTA_LA_MEDIDA);
  });

  it('el patrón caza lo que dice cazar', () => {
    const cazada = (s: string) => LECTURAS.some((p) => p.test(sinComentarios(s)));
    expect(cazada('select: { outcome: true }')).toBe(true);
    expect(cazada('if (p.outcome) return;')).toBe(true);
    expect(cazada('where: { measured_at: { not: null } }')).toBe(true);
    expect(cazada('await this.db.aiDeskCandidate.findMany({})')).toBe(true);
    expect(cazada('const t = tarjetaAgente(c, p);')).toBe(true);
    // La bitácora también tiene un `outcome`, y no es esto.
    expect(cazada('outcome: AuditOutcome.OK,')).toBe(false);
    expect(cazada('// aquí no se lee el .outcome')).toBe(false);
    expect(cazada('await this.db.aiDeskCandidate.createMany({ data })')).toBe(false);
  });
});

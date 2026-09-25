import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Lo que el esquema no declara vive solo en las migraciones (spec oss-001).
 *
 * Un índice parcial o un `CHECK` no están en `schema.prisma`: se escriben a mano
 * en una migración y el esquema, como mucho, los cita en un comentario. El
 * `0_init` de esta edición se generó desde el esquema y perdió los cinco sin
 * que nada avisara. Durante un mes la base no tuvo el índice que impide dos
 * bots reales vivos en el mismo par y conexión (invariante 11 de `CLAUDE.md`),
 * y el `P2002` que `BotsService` captura al arrancar para ese caso no podía
 * llegar nunca.
 *
 * Se recorre la cadena en el orden en que la aplica Prisma —el nombre de la
 * carpeta— y, para cada objeto, cuenta lo último que le pasa: tiene que acabar
 * creado, y con la definición que sostiene lo que el código da por hecho.
 */

const MIGRACIONES = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  '..',
  'packages',
  'db',
  'prisma',
  'migrations',
);

/** La cadena entera, sin comentarios: un comentario puede nombrar lo que no crea. */
const cadena = readdirSync(MIGRACIONES, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort()
  .map((m) => readFileSync(join(MIGRACIONES, m, 'migration.sql'), 'utf8'))
  .join('\n;\n')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/--.*$/gm, '');

interface Objeto {
  nombre: string;
  tipo: 'indice' | 'restriccion';
  /** Lo que tiene que decir la sentencia que lo crea, con los espacios ya colapsados. */
  definicion: readonly RegExp[];
}

const OBJETOS: readonly Objeto[] = [
  {
    // Un solo bot REAL vivo por par y conexión: en un DEX la posición es única
    // por cuenta y símbolo. Los simulados, fuera: cada uno tiene su simulador.
    nombre: 'uq_bot_live_account_symbol',
    tipo: 'indice',
    definicion: [
      /^CREATE UNIQUE INDEX/,
      /ON "bots" ?\( ?"exchange_account_id", ?"symbol" ?\)/,
      /WHERE "status" IN \('STARTING', 'RUNNING', 'PAUSED', 'STOPPING'\)/,
      /AND "dry_run" = false/,
    ],
  },
  {
    // El drenaje de comandos pregunta siempre por lo pendiente.
    nombre: 'idx_bot_command_pending',
    tipo: 'indice',
    definicion: [/ON "bot_commands" ?\( ?"bot_id", ?"id" ?\)/, /WHERE "executed_at" IS NULL/],
  },
  {
    // «¿Hay errores?», sin recorrer la bitácora entera.
    nombre: 'idx_activity_failures',
    tipo: 'indice',
    definicion: [/ON "activity_log" ?\( ?"created_at" DESC ?\)/, /WHERE "outcome" <> 'OK'/],
  },
  {
    // Una conexión real sin credencial no puede firmar: falla al escribirla.
    nombre: 'ck_exchange_account_credentials',
    tipo: 'restriccion',
    definicion: [
      /^ALTER TABLE "exchange_accounts"/,
      /CHECK \( ?"paper" OR "enc_payload" IS NOT NULL ?\)/,
    ],
  },
  {
    // Una conexión de simulación no guarda ningún secreto.
    nombre: 'ck_exchange_account_paper_no_secret',
    tipo: 'restriccion',
    definicion: [
      /^ALTER TABLE "exchange_accounts"/,
      /CHECK \( ?NOT "paper" OR "enc_payload" IS NULL ?\)/,
    ],
  },
];

/** Posición de la última coincidencia, o -1. */
function ultima(patron: RegExp): number {
  let pos = -1;
  for (const m of cadena.matchAll(patron)) pos = m.index;
  return pos;
}

/** La sentencia entera que contiene la posición dada, con los espacios colapsados. */
function sentenciaEn(pos: number): string {
  const inicio = cadena.lastIndexOf(';', pos) + 1;
  const fin = cadena.indexOf(';', pos);
  return cadena
    .slice(inicio, fin < 0 ? undefined : fin)
    .replace(/\s+/g, ' ')
    .trim();
}

function patrones(o: Objeto): { crea: RegExp; borra: RegExp } {
  const nombre = String.raw`"?${o.nombre}"?(?!\w)`;
  return o.tipo === 'indice'
    ? {
        crea: new RegExp(
          String.raw`CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?${nombre}`,
          'gi',
        ),
        borra: new RegExp(
          String.raw`DROP\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+EXISTS\s+)?${nombre}`,
          'gi',
        ),
      }
    : {
        crea: new RegExp(String.raw`ADD\s+CONSTRAINT\s+${nombre}`, 'gi'),
        borra: new RegExp(String.raw`DROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?${nombre}`, 'gi'),
      };
}

describe('Lo que el esquema no declara, en la cadena de migraciones (spec oss-001)', () => {
  it('la cadena se lee: hay migraciones', () => {
    expect(cadena.length).toBeGreaterThan(0);
  });

  it.each(OBJETOS)('$nombre acaba creado y con su definición', (o) => {
    const { crea, borra } = patrones(o);
    const creado = ultima(crea);
    const borrado = ultima(borra);
    const sentencia = creado < 0 ? '' : sentenciaEn(creado);
    expect({
      creado: creado >= 0,
      sigueDespuesDelUltimoBorrado: creado > borrado,
      faltaEnLaDefinicion: o.definicion.filter((p) => !p.test(sentencia)).map(String),
    }).toEqual({ creado: true, sigueDespuesDelUltimoBorrado: true, faltaEnLaDefinicion: [] });
  });
});

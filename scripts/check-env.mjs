#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Comprueba que las variables de entorno cuadran en las tres fuentes:
 *
 *   1. Lo que el CÓDIGO lee (`config.get('X')` o `process.env.X`).
 *   2. Lo que declara el `.env.example` de cada app.
 *   3. Lo que el compose inyecta a cada contenedor.
 *
 * Una variable que el código lee pero nadie define no falla al compilar ni en
 * los tests: falla en producción, con el valor por defecto puesto en silencio.
 * Este script convierte eso en un error visible.
 *
 *   node scripts/check-env.mjs
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Variables que provee el entorno de ejecución, no nuestra configuración. */
const AMBIENT = new Set(['NODE_ENV', 'PATH', 'HOME']);

const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

/** Recorre un directorio recogiendo los .ts, sin entrar en node_modules ni dist. */
function sourceFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    if (['node_modules', 'dist', 'generated', 'www'].includes(entry.name)) continue;
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...sourceFiles(rel));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) out.push(rel);
  }
  return out;
}

/** Variables que el código lee, por ConfigService o por process.env. */
function usedIn(dir) {
  const used = new Set();
  for (const file of sourceFiles(dir)) {
    const src = read(file);
    for (const m of src.matchAll(/\.get(?:<[^>]*>)?\(\s*'([A-Z][A-Z0-9_]*)'/g)) used.add(m[1]);
    for (const m of src.matchAll(/process\.env(?:\.|\[')([A-Z][A-Z0-9_]*)/g)) used.add(m[1]);
    // Los secretos no se leen con `config.get` directamente, sino a traves de
    // ayudantes que ademas validan (`requireSecret`, `this.require`). Sin esta
    // linea, JWT_ACCESS_SECRET o GOOGLE_CLIENT_ID —justo las que impiden
    // arrancar si faltan— quedaban fuera de la comprobacion.
    for (const m of src.matchAll(/require(?:Secret)?\(\s*(?:this\.)?config\s*,\s*'([A-Z][A-Z0-9_]*)'/g))
      used.add(m[1]);
  }
  return used;
}

/** Variables declaradas en un fichero .env (ignorando comentarios). */
function declaredIn(file) {
  const declared = new Set();
  for (const line of read(file).split('\n')) {
    const m = /^([A-Z][A-Z0-9_]*)=/.exec(line);
    if (m) declared.add(m[1]);
  }
  return declared;
}

/** Variables que el compose inyecta a un servicio concreto. */
function composeEnvFor(service) {
  const compose = read('docker/docker-compose.yml');
  // Se acota al bloque `environment:` del servicio para no mezclar servicios.
  const start = compose.indexOf(`\n  ${service}:`);
  if (start < 0) return new Set();
  const nextService = compose.slice(start + 1).search(/\n  [a-z-]+:\n/);
  const block = compose.slice(start, nextService > 0 ? start + 1 + nextService : undefined);

  const envStart = block.indexOf('environment:');
  if (envStart < 0) return new Set();

  const vars = new Set();
  for (const line of block.slice(envStart).split('\n')) {
    const m = /^\s{6}([A-Z][A-Z0-9_]*):/.exec(line);
    if (m) vars.add(m[1]);
  }
  return vars;
}

/**
 * Los paquetes compartidos cuentan para LAS DOS apps.
 *
 * Sin esto habia un punto ciego entero: una variable leida solo desde
 * `packages/` no aparecia en ninguna de las dos listas, asi que podia faltar en
 * los `.env.example` y en el compose sin que este script dijera nada — que es
 * exactamente el fallo que existe para cazar. `DATABASE_URL` es el caso vivo: la
 * lee `@crypton/db` por `process.env` y aqui figuraba como «declarada y no
 * leida», o sea justo al reves de la verdad.
 *
 * Se suman a las dos porque eso es lo que son: codigo que ejecutan las dos.
 */
const SHARED = ['packages'];

const CHECKS = [
  { app: 'API', dirs: ['apps/api/src', ...SHARED], example: 'apps/api/.env.example', service: 'api' },
  {
    app: 'Worker',
    dirs: ['apps/worker/src', ...SHARED],
    example: 'apps/worker/.env.example',
    service: 'worker',
  },
];

let problems = 0;

for (const check of CHECKS) {
  const used = [...new Set(check.dirs.flatMap((d) => [...usedIn(d)]))]
    .filter((v) => !AMBIENT.has(v))
    .sort();
  const declared = declaredIn(check.example);
  const inCompose = composeEnvFor(check.service);

  console.log(`\n${check.app}  —  ${used.length} variables usadas por el código`);

  const missingExample = used.filter((v) => !declared.has(v));
  const missingCompose = used.filter((v) => !inCompose.has(v));
  const unusedExample = [...declared]
    .filter((v) => !used.includes(v) && !AMBIENT.has(v))
    .sort();

  if (missingExample.length) {
    console.log(`  ✗ sin declarar en ${check.example}: ${missingExample.join(', ')}`);
    problems += missingExample.length;
  } else {
    console.log(`  ✓ todas declaradas en el .env.example`);
  }

  if (missingCompose.length) {
    console.log(`  ✗ sin inyectar al contenedor "${check.service}": ${missingCompose.join(', ')}`);
    problems += missingCompose.length;
  } else {
    console.log(`  ✓ todas inyectadas por el compose`);
  }

  if (unusedExample.length) {
    // No es un error: alguna se deja documentada a propósito. Ya no aparecen
    // aquí las que se leen desde `packages/` —ese escaneo las cubre—, así que lo
    // que salga en esta línea merece una mirada.
    console.log(`  · declaradas y no leídas directamente: ${unusedExample.join(', ')}`);
  }
}

console.log();
if (problems > 0) {
  console.log(`${problems} problema(s). Una variable sin definir no falla al compilar:`);
  console.log('falla en producción, con el valor por defecto aplicado en silencio.');
  process.exit(1);
}
console.log('Entorno coherente en código, .env.example y compose.');

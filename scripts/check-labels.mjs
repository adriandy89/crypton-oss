#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Comprueba que cada campo de estrategia tiene nombre y ayuda en la app.
 *
 * Los formularios de la app se generan enteros a partir de `FieldMeta`, y el
 * texto visible sale de `FIELD_LABELS` (`apps/app/src/app/core/utils/field-labels.ts`)
 * buscando por `labelKey` y `helpKey`. Cuando una clave no está:
 *
 *   - el NOMBRE se cae a des-camelizar la clave, así que un campo llamado
 *     `regimeGuard` aparece como «Regime Guard» en una app en castellano;
 *   - la AYUDA no se cae a nada: sencillamente no se enseña. El campo se queda
 *     mudo, y son precisamente los avanzados —los que nadie entiende sin
 *     leerla— los que más fácil se quedan sin ella.
 *
 * Nada de eso rompe la compilación ni un test: la app arranca, el formulario
 * se pinta y el usuario ve un mando en inglés sin explicación. Así se
 * acumularon veintidós huecos, incluido el grupo entero de microestructura de
 * los dos market makers y las ocho ayudas de la estrategia de tendencia.
 *
 *   node scripts/check-labels.mjs
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const ESTRATEGIAS = 'packages/strategy-core/src';
const CATALOGO = 'apps/app/src/app/core/utils/field-labels.ts';

/** Los .ts de un directorio, sin entrar en dist ni en los tests. */
function fuentes(dir) {
  const out = [];
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    if (['node_modules', 'dist'].includes(entry.name)) continue;
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...fuentes(rel));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) out.push(rel);
  }
  return out;
}

/**
 * Las claves que declara cada campo, con el fichero donde están.
 *
 * Solo `labelKey`/`helpKey` de CAMPOS: `StrategyMeta` también los tiene, pero
 * el nombre de una estrategia sale de `STRATEGY_LABELS` (`labels.ts`), que es
 * otro mapa y va por `StrategyKind`.
 */
function declaradas() {
  const mapa = new Map();
  for (const file of fuentes(ESTRATEGIAS)) {
    const src = read(file);
    for (const m of src.matchAll(/(labelKey|helpKey):\s*'([^']+)'/g)) {
      if (!mapa.has(m[2])) mapa.set(m[2], { tipo: m[1], file });
    }
  }
  return mapa;
}

/**
 * Las claves de `StrategyMeta`, que NO necesitan entrada en el catálogo.
 *
 * Se detectan porque terminan en `.label` o `.description` y las declara
 * `kind:`/`labelKey:` del propio meta, no un campo.
 */
const esDeMeta = (clave) => /\.(label|description)$/.test(clave);

const catalogo = read(CATALOGO);
const tiene = (clave) => catalogo.includes(`'${clave}'`);

const faltan = [];
for (const [clave, info] of declaradas()) {
  if (esDeMeta(clave)) continue;
  if (!tiene(clave)) faltan.push({ clave, ...info });
}

console.log(`\nCampos de estrategia en ${CATALOGO}\n`);

if (!faltan.length) {
  console.log('  ✓ todos los campos tienen nombre y ayuda en castellano.\n');
  process.exit(0);
}

const nombres = faltan.filter((f) => f.tipo === 'labelKey');
const ayudas = faltan.filter((f) => f.tipo === 'helpKey');

if (nombres.length) {
  console.log(`  ✗ ${nombres.length} campo(s) SIN NOMBRE (saldrán des-camelizados, en inglés):`);
  for (const f of nombres) console.log(`      ${f.clave}   (${f.file})`);
}
if (ayudas.length) {
  console.log(`  ✗ ${ayudas.length} campo(s) SIN AYUDA (el campo se queda mudo):`);
  for (const f of ayudas) console.log(`      ${f.clave}   (${f.file})`);
}

console.log(`\nAñádelas a ${CATALOGO}. Nada de esto rompe la compilación:`);
console.log('se ve solo abriendo el formulario, y por eso hace falta este script.\n');
process.exit(1);

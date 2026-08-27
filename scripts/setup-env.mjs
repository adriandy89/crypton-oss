#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Genera los ficheros `.env` locales a partir de los `.example`.
 *
 * Existe por un motivo concreto: los secretos hay que repetirlos en varios
 * ficheros y hacerlo a mano falla de formas silenciosas. La clave maestra debe
 * ser IDÉNTICA en la API y en el worker —la API cifra, el worker descifra— y si
 * no coinciden, ningún bot arranca con un error que no señala la causa.
 *
 * Además, los `.example` llevan la variable comentada como ejemplo antes de la
 * de verdad; un reemplazo ingenuo escribe el valor en el comentario y deja la
 * real vacía. Aquí se ancla a principio de línea para evitarlo.
 *
 *   node scripts/setup-env.mjs           crea lo que falte
 *   node scripts/setup-env.mjs --force   regenera todo (invalida las sesiones)
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const force = process.argv.includes('--force');

const hex32 = () => randomBytes(32).toString('hex');

/** Secretos compartidos: se generan UNA vez y se reparten a quien los necesite. */
const secrets = {
  CREDENTIALS_MASTER_KEY: hex32(),
  JWT_ACCESS_SECRET: hex32(),
  JWT_REFRESH_SECRET: hex32(),
};

const TARGETS = [
  {
    example: 'docker/.env.example',
    output: 'docker/.env',
    label: 'stack de Docker',
    values: secrets,
  },
  {
    example: 'apps/api/.env.example',
    output: 'apps/api/.env',
    label: 'API en el host',
    values: secrets,
  },
  {
    example: 'apps/worker/.env.example',
    output: 'apps/worker/.env',
    label: 'worker en el host',
    // El worker no emite tokens: solo necesita la clave de cifrado.
    values: { CREDENTIALS_MASTER_KEY: secrets.CREDENTIALS_MASTER_KEY },
  },
];

/**
 * Asigna un valor a una variable. El ancla `^` es imprescindible: sin ella, la
 * primera coincidencia suele ser el ejemplo comentado del bloque de ayuda.
 */
function setVar(content, key, value) {
  const re = new RegExp(`^${key}=.*$`, 'm');
  if (!re.test(content)) {
    console.warn(`   aviso: ${key} no aparece en el .example`);
    return content;
  }
  return content.replace(re, `${key}=${value}`);
}

let created = 0;
let skipped = 0;

for (const target of TARGETS) {
  const examplePath = path.join(root, target.example);
  const outputPath = path.join(root, target.output);

  if (!fs.existsSync(examplePath)) {
    console.error(`✗ falta ${target.example}`);
    process.exitCode = 1;
    continue;
  }

  if (fs.existsSync(outputPath) && !force) {
    console.log(`· ${target.output} ya existe (--force para regenerarlo)`);
    skipped++;
    continue;
  }

  let content = fs.readFileSync(examplePath, 'utf8');
  for (const [key, value] of Object.entries(target.values)) {
    content = setVar(content, key, value);
  }

  fs.writeFileSync(outputPath, content);
  console.log(`✓ ${target.output}  (${target.label})`);
  created++;
}

console.log();

if (created > 0) {
  console.log(`Secretos generados y compartidos donde toca:`);
  console.log(`  CREDENTIALS_MASTER_KEY  ${secrets.CREDENTIALS_MASTER_KEY.slice(0, 16)}…`);
  console.log(`  JWT_ACCESS_SECRET       ${secrets.JWT_ACCESS_SECRET.slice(0, 16)}…`);
  console.log(`  JWT_REFRESH_SECRET      ${secrets.JWT_REFRESH_SECRET.slice(0, 16)}…`);
  console.log();
  console.log('IMPORTANTE: guarda CREDENTIALS_MASTER_KEY fuera del backup de la');
  console.log('base de datos. Si se pierde, ninguna credencial de exchange se');
  console.log('puede volver a descifrar.');
}

if (created > 0) {
  console.log();
  console.log('QUEDA UNA COSA A MANO: el acceso con Google.');
  console.log('  GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET y GOOGLE_REDIRECT_URI no se');
  console.log('  pueden generar aquí: se crean en console.cloud.google.com como');
  console.log('  credenciales OAuth 2.0 de tipo «aplicación web». Sin ellas la API no');
  console.log('  arranca, porque sin ellas no puede entrar nadie.');
}

if (skipped > 0 && created > 0) {
  console.log();
  console.log(`Ojo: ${skipped} fichero(s) ya existían y conservan sus claves antiguas.`);
  console.log('Si la clave maestra no coincide entre API y worker, los bots no arrancan.');
}

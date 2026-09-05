/**
 * CSV para llevarse una tabla a una hoja de cálculo (spec 006, R-6).
 *
 * Separador `;` y saltos `\r\n`: es lo que abre Excel en castellano sin pasar
 * por el asistente de importación. Se entrecomilla lo que lleve el separador,
 * comillas o saltos de línea, y las comillas se duplican, que es la única regla
 * de escape del formato. Los importes van tal y como llegan —con punto decimal,
 * como los guarda la base—; convertirlos aquí a coma sería adivinar la
 * configuración regional de la hoja de destino, y la pantalla lo avisa.
 */

export type ValorCsv = string | number | boolean | null | undefined;

const SEPARADOR = ';';

function celda(v: ValorCsv): string {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'string' ? v : String(v);
  return /[";\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * @param filas objetos con las mismas claves; las que falten salen vacías.
 * @param columnas orden y selección de columnas. Sin ella, las claves de la
 *   primera fila en su orden.
 */
export function aCsv(
  filas: readonly Record<string, ValorCsv>[],
  columnas?: readonly string[],
): string {
  const cols = columnas ?? (filas.length ? Object.keys(filas[0]) : []);
  const lineas = [cols.map(celda).join(SEPARADOR)];
  for (const f of filas) lineas.push(cols.map((c) => celda(f[c])).join(SEPARADOR));
  return lineas.join('\r\n');
}

/**
 * El borrador de Ajustes de un bot, y lo que su dueño editó en él
 * (spec 055, 053/H-05).
 *
 * Guardar Ajustes manda la configuración ENTERA. Si mientras había cambios a
 * medio escribir la configuración cambió —un ajuste del Modo IA, otro
 * dispositivo—, guardar el borrador tal cual deshacía en silencio lo que cambió
 * entretanto. Y la pantalla lo empeoraba: decidía si había cambios sin guardar
 * comparando el borrador con la configuración ACTUAL, así que tras un ajuste de
 * la IA un borrador que nadie había tocado parecía editado, no se refrescaba y
 * ofrecía «guardar igualmente», que era exactamente deshacer el ajuste.
 *
 * La regla: lo editado es lo que difiere de la configuración de la que NACIÓ el
 * borrador, y si la versión cambió, se guardan solo esas ediciones encima de la
 * versión nueva.
 *
 * Vive en `shared` por el precedente de `timeline.ts`: la app no tiene runner de
 * tests, y esto decide si se deshace un cambio en un bot con dinero dentro.
 */

/**
 * Si dos valores de configuración son el mismo, con la regla del servidor.
 *
 * Es la igualdad con la que `diffConfig` (strategy-core) decide qué cambia al
 * guardar, y está aquí para que la pantalla decida con LA MISMA qué está
 * editado (spec 056, A-1). Con dos reglas, la pantalla comparaba texto y el
 * servidor números: un «12.5» escrito sobre un «12.50» guardado era una edición
 * para la pantalla y no para el servidor. Al recolocar el borrador sobre un
 * ajuste de la IA se conservaba el 12.5, y guardar deshacía el ajuste.
 *
 * Laxa a propósito: los números llegan del formulario como string ('2' vs 2) y
 * compararlos en crudo marcaría cambios que no existen, lo que haría que el bot
 * retendiera la escalera sin motivo.
 */
export function mismoValorDeConfig(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  if (typeof a === 'boolean' || typeof b === 'boolean') return Boolean(a) === Boolean(b);
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na === nb;
  // Ultimo escalon, con null, booleanos y numeros ya descartados arriba: lo que
  // queda de un config son cadenas y enums. Dos objetos distintos se verian
  // iguales aqui, pero un config no los contiene.
  // eslint-disable-next-line @typescript-eslint/no-base-to-string
  return String(a) === String(b);
}

type Config = Readonly<Record<string, unknown>>;

/** Los campos en los que el borrador difiere de la configuración de la que nació. */
export function edicionesDe(base: Config, borrador: Config): string[] {
  const claves = new Set([...Object.keys(base), ...Object.keys(borrador)]);
  return [...claves].filter((clave) => !mismoValorDeConfig(borrador[clave], base[clave]));
}

export interface BorradorRecolocado {
  /** La configuración nueva, con las ediciones del dueño encima. */
  borrador: Record<string, unknown>;
  /** Los campos editados, que son los únicos que el borrador cambia. */
  ediciones: string[];
  /**
   * Los editados que TAMBIÉN cambiaron entre las dos versiones: ahí la edición
   * del dueño sustituye a lo que cambió debajo, y la pantalla tiene que decirlo
   * (spec 056, A-2).
   */
  choques: string[];
}

/**
 * El borrador recolocado sobre otra versión.
 *
 * Lo que el dueño no tocó toma el valor de la versión nueva —así se conserva lo
 * que cambió entretanto—, y lo que tocó conserva su valor, aunque también haya
 * cambiado en la nueva: lo editó a mano, y la pantalla le dice que la versión
 * cambió y en qué campos choca.
 */
export function recolocarBorrador(
  base: Config,
  borrador: Config,
  actual: Config,
): BorradorRecolocado {
  const ediciones = edicionesDe(base, borrador);
  const out: Record<string, unknown> = { ...actual };
  for (const clave of ediciones) {
    if (clave in borrador) out[clave] = borrador[clave];
    else delete out[clave];
  }
  const choques = ediciones.filter((clave) => !mismoValorDeConfig(base[clave], actual[clave]));
  return { borrador: out, ediciones, choques };
}

/**
 * Convierte a texto un valor de configuracion de bot.
 *
 * Existe porque los config viajan como `Record<string, unknown>` y hacerles
 * `String()` a secas convierte cualquier objeto en "[object Object]": comparar
 * dos valores distintos daria igual, y una etiqueta ensenaria eso al usuario.
 * Lo que llega de verdad son escalares —numeros, cadenas, booleanos— y
 * cualquier otra cosa se serializa en vez de perderse.
 */
export function textoDeConfig(valor: unknown): string {
  if (valor === null || valor === undefined) return '';
  if (typeof valor === 'string') return valor;
  if (typeof valor === 'number' || typeof valor === 'boolean' || typeof valor === 'bigint') {
    return valor.toString();
  }
  try {
    return JSON.stringify(valor) ?? '';
  } catch {
    return '';
  }
}

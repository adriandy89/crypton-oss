/**
 * `15m`, `30d`, `900s` → segundos.
 *
 * Vive aparte de `TokenService` porque lo necesitan dos: quien FIRMA el access
 * token y quien decide cuanto tiene que vivir la marca de revocacion, que tiene
 * que cubrir al token vivo mas antiguo. Con una copia en cada sitio, cambiar
 * `JWT_ACCESS_TTL` dejaria la marca corta y la revocacion se levantaria sola
 * antes de tiempo, en silencio.
 *
 * Un valor que no case con el formato cae a 30 dias: es el comportamiento que
 * ya tenia `TokenService` y no se cambia aqui.
 */
export function ttlToSeconds(ttl: string): number {
  const m = /^(\d+)([smhd])$/.exec(ttl.trim());
  if (!m) return 30 * 24 * 3600;
  const n = parseInt(m[1], 10);
  return { s: n, m: n * 60, h: n * 3600, d: n * 86400 }[m[2]] as number;
}

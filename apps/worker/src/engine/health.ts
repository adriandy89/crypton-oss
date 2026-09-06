/**
 * Salud del motor, tal y como la ve el healthcheck del contenedor.
 *
 * Tres entradas y una regla:
 *
 * · Sin Redis confirmado no hay salud. Un worker que lleva más de un TTL sin
 *   confirmar sus leases suelta todos sus bots (`LeaseService.renewAll`) y se
 *   queda con cero runners… y con la regla antigua («cero runners = sano»)
 *   pasaba por sano justo en el peor momento (001/F-18).
 * · Con cero runners y Redis vivo, sano: es un worker sin trabajo, no roto.
 * · Con runners, enfermo solo cuando están atascados TODOS. Un bot suelto
 *   atascado no es asunto del contenedor —de ese se encarga el cortacircuitos
 *   del propio runner—, y hacer que uno malo marque el worker entero como no
 *   sano dejaría a los otros doscientos cuarenta y nueve señalados por su culpa.
 *
 * Es una función pura para poder probarla sin levantar el motor.
 */
export interface SaludEntrada {
  runners: number;
  stalled: number;
  /** ¿Redis responde? Sin él este proceso no puede sostener ni un lease. */
  leasesConfirmed: boolean;
}

export function evaluarSalud(s: SaludEntrada): boolean {
  if (!s.leasesConfirmed) return false;
  if (s.runners === 0) return true;
  return s.stalled < s.runners;
}

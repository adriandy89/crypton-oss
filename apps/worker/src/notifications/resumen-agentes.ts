import { D, EstadoPropuestaAgente, PROPUESTAS_EJECUTADAS, type Decimal } from '@crypton/shared';

/** Una propuesta de hoy, con lo que el resumen mira de ella. */
export interface PropuestaDelDia {
  state: string;
  dry_run: boolean;
}

/** Una operación cerrada hoy: su resultado y su R, en cadena decimal. */
export interface CerradaDelDia {
  pnl: string | null;
  r: string | null;
  dry_run: boolean;
}

/** Una operación abierta ahora. */
export interface AbiertaAhora {
  dry_run: boolean;
}

interface Parte {
  propuestas: number;
  operadas: number;
  cerradas: number;
  pnl: Decimal;
  /** La suma de los R, o null si ninguna cerrada lo tiene. */
  r: Decimal | null;
  abiertas: number;
}

const ejecutadas = new Set<string>(PROPUESTAS_EJECUTADAS);
const conSigno = (v: Decimal): string => `${v.gte(0) ? '+' : ''}${v.toFixed(2)}`;

function parte(
  propuestas: readonly PropuestaDelDia[],
  cerradas: readonly CerradaDelDia[],
  abiertas: readonly AbiertaAhora[],
  dryRun: boolean,
): Parte {
  // Las de modo sombra no se ofrecieron a nadie: se miden, no se cuentan aquí.
  const p = propuestas.filter(
    (x) => x.dry_run === dryRun && x.state !== EstadoPropuestaAgente.SOMBRA,
  );
  const c = cerradas.filter((x) => x.dry_run === dryRun);
  const conR = c.filter((x) => x.r !== null);
  return {
    propuestas: p.length,
    operadas: p.filter((x) => ejecutadas.has(x.state)).length,
    cerradas: c.length,
    pnl: c.reduce((a, x) => a.plus(x.pnl ?? '0'), D(0)),
    r: conR.length > 0 ? conR.reduce((a, x) => a.plus(x.r ?? '0'), D(0)) : null,
    abiertas: abiertas.filter((x) => x.dry_run === dryRun).length,
  };
}

const vacia = (p: Parte): boolean =>
  p.propuestas === 0 && p.operadas === 0 && p.cerradas === 0 && p.abiertas === 0;

const resultado = (p: Parte): string => `${conSigno(p.pnl)}${p.r ? ` (${conSigno(p.r)} R)` : ''}`;

/**
 * Las líneas de los agentes en el resumen diario (spec 074): lo propuesto hoy,
 * lo que llegó a operarse, lo cerrado con su resultado y su R, y lo abierto
 * ahora. Real y simulado van aparte, como en el resto del resumen: el resultado
 * de un simulado es dinero que no existe y no se suma nunca al de verdad. Sin
 * nada que contar, ninguna línea.
 */
export function lineasResumenAgentes(
  propuestas: readonly PropuestaDelDia[],
  cerradas: readonly CerradaDelDia[],
  abiertas: readonly AbiertaAhora[],
): string[] {
  const real = parte(propuestas, cerradas, abiertas, false);
  const sim = parte(propuestas, cerradas, abiertas, true);
  if (vacia(real) && vacia(sim)) return [];

  const lineas = ['<b>Agentes</b>'];
  if (!vacia(real)) {
    // Lo cerrado hoy pudo proponerse ayer: sin propuestas de hoy, no se dice «0».
    if (real.propuestas > 0) {
      lineas.push(`Propuestas: ${real.propuestas} · operadas ${real.operadas}`);
    }
    if (real.cerradas > 0) lineas.push(`Cerradas: ${real.cerradas} · <b>${resultado(real)}</b>`);
    if (real.abiertas > 0) lineas.push(`Abiertas: ${real.abiertas}`);
  }
  if (!vacia(sim)) {
    lineas.push(
      `<i>Simulado (no cuenta): ${sim.propuestas} propuesta(s) · ${sim.operadas} operada(s)` +
        (sim.cerradas > 0 ? ` · ${sim.cerradas} cerrada(s), ${resultado(sim)}` : '') +
        ` · ${sim.abiertas} abierta(s)</i>`,
    );
  }
  return lineas;
}

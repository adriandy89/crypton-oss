import { lineasResumenAgentes } from './resumen-agentes';

/**
 * La sección de los agentes en el resumen diario (spec 074). Lo que importa es
 * lo mismo que en el resto del resumen: el simulado no se suma nunca al real.
 */
describe('lineasResumenAgentes', () => {
  it('sin nada que contar, ninguna línea', () => {
    expect(lineasResumenAgentes([], [], [])).toEqual([]);
    // Lo de modo sombra no se ofreció a nadie: no cuenta como propuesta.
    expect(lineasResumenAgentes([{ state: 'SOMBRA', dry_run: false }], [], [])).toEqual([]);
  });

  it('lo real, con lo propuesto, lo operado, lo cerrado con su R y lo abierto', () => {
    expect(
      lineasResumenAgentes(
        [
          { state: 'CERRADA', dry_run: false },
          { state: 'ABIERTA', dry_run: false },
          { state: 'CADUCADA', dry_run: false },
          { state: 'FALLIDA', dry_run: false },
        ],
        [
          { pnl: '10', r: '1', dry_run: false },
          { pnl: '-4.5', r: '-0.5', dry_run: false },
        ],
        [{ dry_run: false }],
      ),
    ).toEqual([
      '<b>Agentes</b>',
      'Propuestas: 4 · operadas 2',
      'Cerradas: 2 · <b>+5.50 (+0.50 R)</b>',
      'Abiertas: 1',
    ]);
  });

  it('el simulado va aparte y no se suma', () => {
    const lineas = lineasResumenAgentes(
      [
        { state: 'CERRADA', dry_run: false },
        { state: 'CERRADA', dry_run: true },
      ],
      [
        { pnl: '2', r: '0.2', dry_run: false },
        { pnl: '100', r: '5', dry_run: true },
      ],
      [{ dry_run: true }],
    );
    expect(lineas).toEqual([
      '<b>Agentes</b>',
      'Propuestas: 1 · operadas 1',
      'Cerradas: 1 · <b>+2.00 (+0.20 R)</b>',
      '<i>Simulado (no cuenta): 1 propuesta(s) · 1 operada(s) · 1 cerrada(s), +100.00 (+5.00 R) · 1 abierta(s)</i>',
    ]);
  });

  it('solo simulado: sin líneas de real', () => {
    expect(lineasResumenAgentes([{ state: 'RECHAZADA', dry_run: true }], [], [])).toEqual([
      '<b>Agentes</b>',
      '<i>Simulado (no cuenta): 1 propuesta(s) · 0 operada(s) · 0 abierta(s)</i>',
    ]);
  });

  it('sin R en ninguna cerrada, el resultado va sin R; y con pérdidas, con su signo', () => {
    // Propuesta ayer y cerrada hoy: sin «Propuestas: 0».
    expect(lineasResumenAgentes([], [{ pnl: '-3', r: null, dry_run: false }], [])).toEqual([
      '<b>Agentes</b>',
      'Cerradas: 1 · <b>-3.00</b>',
    ]);
  });
});

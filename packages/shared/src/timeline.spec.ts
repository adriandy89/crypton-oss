import { cronologiaPorCiclo, type EntradaCronologia, type VentanaCiclo } from './timeline';

/**
 * La cronología por ciclo (spec 006, CA-1).
 *
 * Lo que se fija: que lo que trae ciclo vaya a su ciclo aunque no esté en la
 * lista, que lo que no lo trae se asigne por la ventana temporal, que lo suelto
 * no desaparezca, y el orden.
 */

const MIN = 60_000;
const T0 = 1_700_000_000_000;

const entrada = (
  o: Partial<EntradaCronologia> & { id: string; at: number },
): EntradaCronologia => ({
  tipo: 'suceso',
  cycleSeq: null,
  titulo: o.id,
  detalle: '',
  tono: 'neutral',
  ...o,
});

const ciclos: VentanaCiclo[] = [
  { seq: 1, desde: T0, hasta: T0 + 60 * MIN },
  { seq: 2, desde: T0 + 60 * MIN, hasta: T0 + 120 * MIN },
  // El ciclo vivo: sin cierre.
  { seq: 3, desde: T0 + 120 * MIN, hasta: null },
];

describe('cronologiaPorCiclo', () => {
  it('lo que trae ciclo va a su ciclo, aunque ese ciclo no esté en la lista', () => {
    const out = cronologiaPorCiclo(
      [
        entrada({ id: 'o1', at: T0 + 5 * MIN, tipo: 'orden', cycleSeq: 1 }),
        // Una orden del ciclo 9, que no existe entre los cerrados: no se pierde.
        entrada({ id: 'o9', at: T0 + 500 * MIN, tipo: 'orden', cycleSeq: 9 }),
      ],
      ciclos,
    );
    expect(out.map((g) => g.seq)).toEqual([9, 1]);
    expect(out[0].desde).toBeNull();
    expect(out[1].entradas.map((e) => e.id)).toEqual(['o1']);
  });

  it('lo que no trae ciclo se asigna por la ventana temporal; el ciclo abierto llega hasta hoy', () => {
    const out = cronologiaPorCiclo(
      [
        entrada({ id: 'e1', at: T0 + 30 * MIN }),
        // Justo en el borde: pertenece al ciclo que EMPIEZA ahí.
        entrada({ id: 'e2', at: T0 + 60 * MIN }),
        entrada({ id: 'e3', at: T0 + 10_000 * MIN }),
      ],
      ciclos,
    );
    const porSeq = new Map(out.map((g) => [g.seq, g.entradas.map((e) => e.id)]));
    expect(porSeq.get(1)).toEqual(['e1']);
    expect(porSeq.get(2)).toEqual(['e2']);
    expect(porSeq.get(3)).toEqual(['e3']);
  });

  it('lo que no cae en ningún ciclo se agrupa aparte, al final, y no desaparece', () => {
    const out = cronologiaPorCiclo(
      [
        entrada({ id: 'antes', at: T0 - 10 * MIN }),
        entrada({ id: 'o1', at: T0 + 5 * MIN, tipo: 'orden', cycleSeq: 1 }),
      ],
      ciclos,
    );
    expect(out.map((g) => g.seq)).toEqual([1, null]);
    expect(out[1].entradas.map((e) => e.id)).toEqual(['antes']);
  });

  it('ciclos de más nuevo a más viejo; dentro, en orden temporal aunque lleguen del revés', () => {
    const out = cronologiaPorCiclo(
      [
        entrada({ id: 'b', at: T0 + 20 * MIN, tipo: 'ejecucion', cycleSeq: 1 }),
        entrada({ id: 'a', at: T0 + 10 * MIN, tipo: 'orden', cycleSeq: 1 }),
        entrada({ id: 'c', at: T0 + 70 * MIN, tipo: 'orden', cycleSeq: 2 }),
      ],
      ciclos,
    );
    expect(out.map((g) => g.seq)).toEqual([2, 1]);
    expect(out[1].entradas.map((e) => e.id)).toEqual(['a', 'b']);
    expect(out[1].desde).toBe(T0);
    expect(out[1].hasta).toBe(T0 + 60 * MIN);
  });

  it('un instante ilegible no produce una entrada sin sitio', () => {
    expect(cronologiaPorCiclo([entrada({ id: 'x', at: Number.NaN })], ciclos)).toEqual([]);
  });
});

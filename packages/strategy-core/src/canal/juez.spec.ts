import {
  BandaApalancamiento,
  EsquemaObjetivo,
  EstadoSetup,
  NivelConfianza,
  PerfilCanal,
  TamanoOperacion,
  TipoSetup,
  TipoStop,
  Veredicto,
} from '@crypton/shared';
import { construirOperacion, esElegible, herramientaCanal } from './herramienta';
import { PREFERENCIAS, juezDeReglas } from './juez';
import {
  T0_CANAL,
  candidatoDePrueba,
  casoAleatorio,
  entradaDePrueba,
  mercadoDePrueba,
  mulberry32,
} from './testing-canal';

const REB_L = `REB-L-H${T0_CANAL}`;

const decidir = (
  perfil: PerfilCanal,
  o: Parameters<typeof entradaDePrueba>[0] = {},
  cfg: Record<string, unknown> = {},
) => {
  const e = entradaDePrueba(o, { aiProfile: perfil, ...cfg });
  return { e, salida: herramientaCanal(e), eleccion: juezDeReglas(herramientaCanal(e), e.cfg) };
};

describe('juezDeReglas: las preferencias de cada perfil', () => {
  it.each<[PerfilCanal, TipoStop, BandaApalancamiento, EsquemaObjetivo]>([
    [PerfilCanal.AGRESIVA, TipoStop.AJUSTADO, BandaApalancamiento.ALTA, EsquemaObjetivo.ESCALONADO],
    [
      PerfilCanal.EQUILIBRADA,
      TipoStop.NORMAL,
      BandaApalancamiento.MEDIA,
      EsquemaObjetivo.ESCALONADO,
    ],
    [PerfilCanal.PRUDENTE, TipoStop.AMPLIO, BandaApalancamiento.BAJA, EsquemaObjetivo.MEDIA],
  ])('%s: stop %s, banda %s, objetivo %s', (perfil, stop, apalancamiento, objetivo) => {
    const { eleccion, salida, e } = decidir(perfil);
    expect(eleccion).toEqual({
      veredicto: Veredicto.OPERAR,
      opcion: REB_L,
      stop,
      objetivo,
      apalancamiento,
      tamano: TamanoOperacion.COMPLETO,
      // Canal de calidad A.
      confianza: NivelConfianza.ALTA,
    });
    const r = construirOperacion(salida, eleccion, e.cfg, e.market, 'x', T0_CANAL);
    expect(r.motivo).toBeNull();
  });

  it('si el stop preferido no está, prueba el contiguo hacia lo prudente', () => {
    // El ajustado (99,84) queda por encima del ask. Con un ATR mayor los tres
    // stops quedan a una distancia sana del coste: este caso mide la
    // PREFERENCIA del juez, no la aritmética (spec 066).
    const { eleccion } = decidir(PerfilCanal.AGRESIVA, {
      mercado: mercadoDePrueba({ atr15m: '1' }),
      ticker: { ...entradaDePrueba().ticker, bid: '99.80', ask: '99.82' },
    });
    expect(eleccion).toMatchObject({ veredicto: Veredicto.OPERAR, stop: TipoStop.NORMAL });
  });

  it('nunca hacia lo arriesgado: el prudente sin su stop amplio no opera', () => {
    // ATR 2: el amplio pasa del 1,5 % y el normal solo paga el opuesto.
    const mercado = mercadoDePrueba({ atr15m: '2', atr1h: '0.01' });
    const prudente = decidir(PerfilCanal.PRUDENTE, { mercado });
    expect(prudente.salida.candidatos[0].stops[2].motivo).toBe('STOP_ANCHO');
    expect(prudente.salida.candidatos[0].stops[0].viable).toBe(true);
    expect(prudente.eleccion).toMatchObject({ veredicto: Veredicto.NO_OPERAR, opcion: 'NINGUNA' });
    // El agresivo sí, con su ajustado.
    expect(decidir(PerfilCanal.AGRESIVA, { mercado }).eleccion).toMatchObject({
      veredicto: Veredicto.OPERAR,
      stop: TipoStop.AJUSTADO,
    });
  });

  it('el opuesto, cuando la media no paga, solo lo toma el agresivo', () => {
    // ATR 2 y un mínimo de 1,6R: ni el ajustado (1,51R) ni el normal (0,93R)
    // pagan en la media; en el opuesto, sí (2,83R y 1,74R).
    const mercado = mercadoDePrueba({ atr15m: '2', atr1h: '0.01' });
    const cfg = { minRewardRisk: '1.6' };
    const agresiva = decidir(PerfilCanal.AGRESIVA, { mercado }, cfg);
    const [ajustado, normal] = agresiva.salida.candidatos[0].stops;
    expect(ajustado.esquemasViables).toEqual([EsquemaObjetivo.OPUESTO]);
    expect(normal.esquemasViables).toEqual([EsquemaObjetivo.OPUESTO]);
    expect(agresiva.eleccion).toMatchObject({
      veredicto: Veredicto.OPERAR,
      stop: TipoStop.AJUSTADO,
      objetivo: EsquemaObjetivo.OPUESTO,
    });
    for (const perfil of [PerfilCanal.EQUILIBRADA, PerfilCanal.PRUDENTE]) {
      expect(decidir(perfil, { mercado }, cfg).eleccion.veredicto).toBe(Veredicto.NO_OPERAR);
    }
  });

  it('con un único esquema permitido, ese es el de todos los perfiles', () => {
    for (const perfil of Object.values(PerfilCanal)) {
      const { eleccion } = decidir(perfil, {}, { takeProfitSchemes: 'OPUESTO' });
      expect(eleccion).toMatchObject({
        veredicto: Veredicto.OPERAR,
        objetivo: EsquemaObjetivo.OPUESTO,
        stop: PREFERENCIAS[perfil].stops[0],
      });
    }
  });

  it('entre candidatos, el de mayor R', () => {
    const fq = candidatoDePrueba({
      id: `FQ-L-H${T0_CANAL}`,
      setup: TipoSetup.FALSO_QUIEBRE,
      extremo: 99.98,
    });
    const { eleccion, salida } = decidir(
      PerfilCanal.AGRESIVA,
      { candidatos: [fq, candidatoDePrueba()], mercado: mercadoDePrueba({ atr15m: '1' }) },
      { allowedSetups: 'TODOS' },
    );
    // El falso quiebre se giró más cerca de la entrada: su stop también lo
    // está, y con la misma media su R es mayor.
    //
    // Ojo con la trampa que este caso tenía: con el ATR por defecto, el giro a
    // 99,98 dejaba el stop a 0,14 % del tope contra un coste de ida y vuelta de
    // 0,13 %. El R nominal salía mayor y la operación era imposible de ganar —
    // justo la ilusión que la puerta de coste existe para matar (spec 066). Con
    // el ATR subido, los dos candidatos están a distancia sana y la comparación
    // mide lo que dice medir.
    const r = (i: number) => salida.candidatos[i].stops[0].rNetoTp1 ?? 0;
    expect(r(0)).toBeGreaterThan(r(1));
    expect(eleccion.opcion).toBe(`FQ-L-H${T0_CANAL}`);
    const alReves = decidir(
      PerfilCanal.AGRESIVA,
      { candidatos: [candidatoDePrueba(), fq], mercado: mercadoDePrueba({ atr15m: '1' }) },
      { allowedSetups: 'TODOS' },
    );
    expect(alReves.eleccion.opcion).toBe(`FQ-L-H${T0_CANAL}`);
  });

  it('sin candidato elegible no opera', () => {
    const { eleccion } = decidir(PerfilCanal.AGRESIVA, {
      candidatos: [candidatoDePrueba({ estado: EstadoSetup.VIGILANDO })],
    });
    expect(eleccion).toEqual({
      veredicto: Veredicto.NO_OPERAR,
      opcion: 'NINGUNA',
      stop: TipoStop.AJUSTADO,
      objetivo: EsquemaObjetivo.ESCALONADO,
      apalancamiento: BandaApalancamiento.ALTA,
      tamano: TamanoOperacion.COMPLETO,
      confianza: NivelConfianza.BAJA,
    });
    expect(
      juezDeReglas(herramientaCanal(entradaDePrueba({ canal: null })), entradaDePrueba().cfg),
    ).toMatchObject({ veredicto: Veredicto.NO_OPERAR });
  });
});

describe('juezDeReglas: propiedades', () => {
  it('lo que elige siempre se puede construir, y es lo primero disponible de su perfil', () => {
    const azar = mulberry32(2058);
    let operadas = 0;
    for (let caso = 0; caso < 3000; caso++) {
      const base = casoAleatorio(azar);
      const perfil = Object.values(PerfilCanal)[caso % 3];
      const cfg = { ...base.cfg, perfil };
      const salida = herramientaCanal({ ...base, cfg });
      const eleccion = juezDeReglas(salida, cfg);
      const c = salida.candidatos[0];
      const pref = PREFERENCIAS[perfil];
      const objetivos = cfg.esquemas.length === 1 ? cfg.esquemas : pref.objetivos;
      const esperado = esElegible(c)
        ? pref.stops.find((t) => {
            const o = c.stops.find((x) => x.tipo === t);
            return o?.viable && objetivos.some((x) => o.esquemasViables.includes(x));
          })
        : undefined;
      if (!esperado) {
        expect(eleccion.veredicto).toBe(Veredicto.NO_OPERAR);
        continue;
      }
      expect(eleccion).toMatchObject({
        veredicto: Veredicto.OPERAR,
        stop: esperado,
        apalancamiento: pref.banda,
      });
      const r = construirOperacion(salida, eleccion, cfg, base.market, 'x', base.ahora);
      if (!r.plan) throw new Error(`caso ${caso}: ${r.motivo}`);
      operadas++;
    }
    expect(operadas).toBeGreaterThan(500);
  }, 60_000);
});

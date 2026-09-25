import {
  BandaApalancamiento,
  D,
  Decimal,
  FamiliaAgente,
  MotivoPropuestaAgente,
  NivelConfianza,
  ObjetivoAgente,
  TamanoOperacion,
  TipoStop,
  Venue,
  eleccionEfectiva,
  planAgenteDe,
  type Candle,
  type EleccionAgente,
  type SalidaAgente,
} from '@crypton/shared';
import { mulberry32 } from '../canal/testing-canal';
import { herramientaAgente, ofertaAgente } from './herramienta';
import { juezAgente } from './juez';
import {
  MOVIMIENTO_MAXIMO_STOPS,
  construirPropuesta,
  recalcularPropuesta,
  type ContextoPropuesta,
  type DatosFrescos,
} from './propuesta';
import {
  SEMILLA_REVERSION,
  cortarEnSenal,
  entradaAgenteDePrueba,
  historialAgenteDePrueba,
  limitesDePrueba,
  mercadoAgente,
  serieRango,
  serieRuptura,
  serieTendencia,
  tickerDe,
} from './testing-agentes';

/**
 * De la elección al plan (spec 074): la única vía de enumeraciones a números.
 * Se fija que el plan sale de la opción que calculó la herramienta y de nada
 * más, y que al aprobar se recalcula con el precio de ahora o caduca.
 */

const VIDA = 15 * 60_000;

const SERIES: { familia: FamiliaAgente; lado: 'LONG' | 'SHORT'; velas: Candle[] }[] = (
  ['LONG', 'SHORT'] as const
).flatMap((lado) => [
  {
    familia: FamiliaAgente.TENDENCIA,
    lado,
    velas: cortarEnSenal(serieTendencia(lado), FamiliaAgente.TENDENCIA, lado),
  },
  {
    familia: FamiliaAgente.RUPTURA,
    lado,
    velas: cortarEnSenal(serieRuptura(lado), FamiliaAgente.RUPTURA, lado),
  },
  {
    familia: FamiliaAgente.REVERSION,
    lado,
    velas: cortarEnSenal(serieRango(SEMILLA_REVERSION[lado]), FamiliaAgente.REVERSION, lado),
  },
]);

function ronda(velas: Candle[], limites = limitesDePrueba()) {
  const entrada = entradaAgenteDePrueba(velas, { limites });
  const salida = herramientaAgente(entrada);
  const ctx: ContextoPropuesta = {
    limites,
    venue: Venue.HYPERLIQUID,
    market: entrada.pares[0].market,
    intervalo: '1h',
    ahora: entrada.ahora,
    vidaMs: VIDA,
  };
  return { entrada, salida, ctx };
}

describe('juezAgente', () => {
  it('elige el primer puesto de la oferta con un stop NORMAL o AMPLIO, banda baja y escalonado', () => {
    let elegidas = 0;
    for (const { velas } of SERIES) {
      const { salida } = ronda(velas);
      const e = juezAgente(salida);
      const primero = ofertaAgente(salida)[0]?.candidato;
      if (!primero) {
        expect(e).toBeNull();
        continue;
      }
      expect(e).not.toBeNull();
      if (!e) continue;
      elegidas++;
      expect([TipoStop.NORMAL, TipoStop.AMPLIO]).toContain(e.stop);
      expect(e.tamano).toBe(TamanoOperacion.COMPLETO);
      expect(e.confianza).toBe(NivelConfianza.ALTA);
      // La confianza del juez no parte el tamaño.
      expect(eleccionEfectiva(e)).toBe(e);
      const opcion = primero.stops.find((o) => o.tipo === e.stop);
      if (e.candidatoId === primero.id && opcion) {
        const bajas = opcion.bandas.map((b) => b.banda);
        expect(e.apalancamiento).toBe(bajas.includes(BandaApalancamiento.BAJA) ? 'BAJA' : bajas[0]);
      }
    }
    expect(elegidas).toBeGreaterThanOrEqual(4);
  });

  it('sin nada que ofrecer, nada', () => {
    const vacia: SalidaAgente = { ...ronda(SERIES[0].velas).salida, pares: [] };
    expect(juezAgente(vacia)).toBeNull();
  });

  it('un candidato con solo el stop AJUSTADO viable no lo toma', () => {
    const { salida } = ronda(SERIES[0].velas);
    const soloAjustado: SalidaAgente = {
      ...salida,
      pares: salida.pares.map((p) => ({
        ...p,
        candidatos: p.candidatos.map((c) => ({
          ...c,
          stops: c.stops.map((o) => (o.tipo === TipoStop.AJUSTADO ? o : { ...o, viable: false })),
        })),
      })),
    };
    expect(juezAgente(soloAjustado)).toBeNull();
  });
});

describe('construirPropuesta', () => {
  it('el plan sale de la opción elegida, número a número', () => {
    let planes = 0;
    for (const { velas } of SERIES) {
      const { salida, ctx } = ronda(velas);
      const e = juezAgente(salida);
      if (!e) continue;
      const r = construirPropuesta(salida, e, ctx);
      expect(r.motivo).toBeNull();
      const plan = r.plan;
      if (!plan) continue;
      planes++;
      const cand = salida.pares[0].candidatos.find((c) => c.id === e.candidatoId);
      const opcion = cand?.stops.find((o) => o.tipo === e.stop);
      const banda = opcion?.bandas.find((b) => b.banda === e.apalancamiento);
      expect(plan.stop).toBe(opcion?.precio);
      expect(plan.cantidad).toBe(opcion?.cantidad);
      expect(plan.apalancamiento).toBe(banda?.apalancamiento);
      expect(plan.liquidacionEstimada).toBe(banda?.liquidacion);
      expect(plan.entradaTope).toBe(cand?.entradaTope);
      expect(plan.tp1).toBe(cand?.tp1);
      expect(plan.tp2).toBe(cand?.tp2);
      expect(plan.nivelIdea).toBe(cand?.nivel);
      // La pérdida al stop, la de la opción.
      expect(D(plan.riesgo).toFixed()).toBe(D(opcion?.perdidaAlStop ?? '0').toFixed());
      // Los objetivos reparten toda la cantidad.
      const suma = plan.objetivos.reduce((a, o) => a.plus(o.cantidad), D(0));
      expect(suma.toFixed()).toBe(D(plan.cantidad).toFixed());
      expect(plan.entradaHasta).toBe(ctx.ahora + VIDA);
      expect(plan.maxMinutos).toBe(24 * 60);
      expect(plan.costes).toEqual({ makerBps: 1.5, takerBps: 4.5, deslizamientoBps: 2 });
      // Y lo que se guarda se vuelve a leer.
      expect(planAgenteDe(JSON.parse(JSON.stringify(plan)))).toEqual(plan);
    }
    expect(planes).toBeGreaterThanOrEqual(4);
  });

  it('lo que no está en la oferta, o no estaba disponible, no produce nada', () => {
    const { salida, ctx } = ronda(SERIES[0].velas);
    const e = juezAgente(salida);
    expect(e).not.toBeNull();
    if (!e) return;
    const no = (x: Partial<EleccionAgente>, c: Partial<ContextoPropuesta> = {}) =>
      construirPropuesta(salida, { ...e, ...x }, { ...ctx, ...c }).motivo;
    expect(no({ candidatoId: 'OTRO' })).toBe('OFERTA');
    expect(no({}, { market: mercadoAgente({ symbol: 'ETH' }) })).toBe('OFERTA');
    expect(no({}, { intervalo: '4h' })).toBe('OFERTA');
    const cand = salida.pares[0].candidatos.find((c) => c.id === e.candidatoId);
    const opcion = cand?.stops.find((o) => o.tipo === e.stop);
    const bandas = opcion?.bandas.map((b) => b.banda) ?? [];
    const falta = Object.values(BandaApalancamiento).find((b) => !bandas.includes(b));
    if (falta) expect(no({ apalancamiento: falta })).toBe('OFERTA');
    const inviable = cand?.stops.find((o) => !o.viable);
    if (inviable) expect(no({ stop: inviable.tipo })).toBe('OFERTA');
  });

  it('la mitad del tamaño es la mitad, redondeada al paso', () => {
    const { salida, ctx } = ronda(SERIES[0].velas);
    const e = juezAgente(salida);
    if (!e) throw new Error('sin elección');
    const entero = construirPropuesta(salida, e, ctx).plan;
    const medio = construirPropuesta(salida, { ...e, tamano: TamanoOperacion.MEDIO }, ctx).plan;
    expect(entero && medio).toBeTruthy();
    if (!entero || !medio) return;
    const mitad = D(entero.cantidad).div(2).toDecimalPlaces(3, Decimal.ROUND_DOWN);
    expect(D(medio.cantidad).toFixed()).toBe(mitad.toFixed());
    expect(medio.apalancamiento).toBe(entero.apalancamiento);
    expect(D(medio.riesgo).lt(entero.riesgo)).toBe(true);
  });
});

describe('recalcularPropuesta (R-19)', () => {
  function aprobada() {
    const { entrada, salida, ctx } = ronda(SERIES[0].velas);
    const e = juezAgente(salida);
    const plan = e ? construirPropuesta(salida, e, ctx).plan : null;
    if (!plan) throw new Error('sin plan');
    const frescos: DatosFrescos = {
      ticker: entrada.pares[0].ticker ?? tickerDe(SERIES[0].velas),
      saldoLibre: entrada.saldoLibre,
      historial: entrada.historial,
      niveles: [],
      maxApalancamientoUsuario: null,
      atrLiquidacion: '1',
    };
    return { plan, frescos, ctx };
  }

  it('con el mismo precio, el mismo plan, y una nueva hora para entrar', () => {
    const { plan, frescos, ctx } = aprobada();
    const r = recalcularPropuesta(plan, frescos, {
      ...ctx,
      ahora: ctx.ahora + 60_000,
      vidaMs: 300_000,
    });
    expect(r.motivo).toBeNull();
    expect(r.plan?.stop).toBe(plan.stop);
    expect(r.plan?.eleccion).toEqual(plan.eleccion);
    expect(r.plan?.entradaHasta).toBe(ctx.ahora + 60_000 + 300_000);
    // La cantidad no crece al recalcular con los mismos datos.
    expect(D(r.plan?.cantidad ?? '0').lte(plan.cantidad)).toBe(true);
  });

  const moverA = (t: DatosFrescos['ticker'], precio: Decimal) => ({
    ...t,
    bid: precio.toFixed(2),
    ask: precio.plus('0.01').toFixed(2),
    mark: precio.toFixed(2),
  });

  it('caduca si el precio ya pasó el stop', () => {
    const { plan, frescos, ctx } = aprobada();
    const largo = plan.lado === 'LONG';
    const pasado = largo ? D(plan.stop).minus(1) : D(plan.stop).plus(1);
    const r = recalcularPropuesta(
      plan,
      { ...frescos, ticker: moverA(frescos.ticker, pasado) },
      ctx,
    );
    expect(r.motivo).toBe(MotivoPropuestaAgente.PRECIO_PASO_STOP);
  });

  it('caduca si el precio se movió más de media distancia de stop', () => {
    const { plan, frescos, ctx } = aprobada();
    const largo = plan.lado === 'LONG';
    const distancia = D(plan.entradaReferencia).minus(plan.stop).abs();
    const salto = distancia.mul(MOVIMIENTO_MAXIMO_STOPS).plus('0.05');
    const lejos = largo
      ? D(plan.entradaReferencia).plus(salto)
      : D(plan.entradaReferencia).minus(salto);
    const r = recalcularPropuesta(plan, { ...frescos, ticker: moverA(frescos.ticker, lejos) }, ctx);
    expect(r.motivo).toBe(MotivoPropuestaAgente.PRECIO_MOVIDO);
  });

  it('caduca si ya no cabe en los límites: sin saldo, o con el día gastado', () => {
    const { plan, frescos, ctx } = aprobada();
    expect(recalcularPropuesta(plan, { ...frescos, saldoLibre: '0' }, ctx).motivo).toBe(
      MotivoPropuestaAgente.LIMITES,
    );
    const gastado = historialAgenteDePrueba({ realizadoHoy: '-200' });
    expect(recalcularPropuesta(plan, { ...frescos, historial: gastado }, ctx).motivo).toBe(
      MotivoPropuestaAgente.LIMITES,
    );
  });

  it('otro par u otro intervalo no es esta propuesta', () => {
    const { plan, frescos, ctx } = aprobada();
    expect(
      recalcularPropuesta(plan, frescos, { ...ctx, market: mercadoAgente({ symbol: 'ETH' }) })
        .motivo,
    ).toBe(MotivoPropuestaAgente.LIMITES);
  });
});

describe('propiedad: todo plan generado cabe en su riesgo y deja la liquidación detrás', () => {
  it('con límites y elecciones al azar', () => {
    const azar = mulberry32(2026);
    const uno = <T>(xs: readonly T[]): T => xs[Math.floor(azar() * xs.length)];
    let planes = 0;
    for (let caso = 0; caso < 150; caso++) {
      const { velas } = SERIES[caso % SERIES.length];
      const riesgoPct = (0.1 + azar() * 2).toFixed(2);
      const limites = limitesDePrueba({
        capital: (500 + azar() * 20_000).toFixed(2),
        riesgoPct,
        perdidaDiariaPct: (Number(riesgoPct) + azar() * 4).toFixed(2),
        apalancamientoMax: 1 + Math.floor(azar() * 25),
        fraccionTp1Pct: (10 + Math.floor(azar() * 80)).toString(),
      });
      const { salida, ctx } = ronda(velas, limites);
      for (const { candidato } of ofertaAgente(salida)) {
        for (const o of candidato.stops.filter((x) => x.viable)) {
          const e: EleccionAgente = {
            candidatoId: candidato.id,
            stop: o.tipo,
            objetivo: uno(Object.values(ObjetivoAgente)),
            apalancamiento: uno(o.bandas).banda,
            tamano: uno(Object.values(TamanoOperacion)),
            confianza: NivelConfianza.ALTA,
          };
          const plan = construirPropuesta(salida, e, ctx).plan;
          if (!plan) continue;
          planes++;
          const largo = plan.lado === 'LONG';
          const tope = D(limites.capital).mul(limites.riesgoPct).div(100);
          expect(D(plan.riesgo).lte(tope.plus('0.000001'))).toBe(true);
          if (plan.liquidacionEstimada !== null) {
            const liq = D(plan.liquidacionEstimada);
            expect(largo ? liq.lt(plan.stop) : liq.gt(plan.stop)).toBe(true);
          }
          const stop = D(plan.stop);
          for (const obj of plan.objetivos) {
            expect(largo ? D(obj.precio).gt(stop) : D(obj.precio).lt(stop)).toBe(true);
          }
          expect(plan.objetivos.length).toBeGreaterThanOrEqual(1);
          expect(plan.objetivos.length).toBeLessThanOrEqual(2);
          expect(planAgenteDe(plan)).not.toBeNull();
        }
      }
    }
    expect(planes).toBeGreaterThan(50);
  });
});

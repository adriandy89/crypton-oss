import { BucketObjetivo, BucketStop, NivelConfianza, TamanoOperacion } from '@crypton/shared';
import type { PlanTrader } from '@crypton/shared';
import { planGuardadoParaTest, setupDeParaTest } from './engine';

/**
 * El agujero que este fichero cierra, y que costó una medición entera.
 *
 * El registro de operaciones del replay exigía `setup`, que solo tiene el plan
 * del canal. Con el «Bot de IA» el replay **ejecutaba las operaciones y movía
 * el PnL, pero las contaba como cero**. Y eso es la peor clase de fallo: no
 * parece un agujero, parece un resultado — «el motor no opera nunca»— y sobre
 * ese resultado falso se habría cerrado el spec.
 *
 * Lo cazó que el PnL no fuera cero con cero operaciones. Que no vuelva a pasar.
 */
describe('planGuardado — las dos formas de plan (spec 068)', () => {
  const planTrader: PlanTrader = {
    intentId: 'i1',
    lado: 'LONG',
    veredicto: {
      accion: 'TOMAR',
      confianza: NivelConfianza.ALTA,
      acuerdo: true,
      stop: BucketStop.MEDIDO,
      objetivo: BucketObjetivo.EN_LA_MEDIA,
      tamano: TamanoOperacion.COMPLETO,
    },
    entradaReferencia: '100',
    entradaTope: '100.1',
    stop: '99',
    objetivos: [{ precio: '101', cantidad: '1' }],
    cantidad: '1',
    apalancamiento: 10,
    nocional: '100.1',
    riesgo: '1.1',
    rNeto: 1.5,
    liquidacionEstimada: '95',
    huella: 'h',
    barT: 0,
    banda: { superior: '102', media: '101', inferior: '99.5', refT: 0 },
    venceEn: 1,
    distanciaStop: 0.011,
  };

  it('reconoce el plan del «Bot de IA», que no tiene `setup`', () => {
    const leido = planGuardadoParaTest({ op: { plan: planTrader } });

    expect(leido).not.toBeNull();
    expect(setupDeParaTest(leido!)).toBe('BANDA_MEDIDO');
  });

  it('reconoce el del canal, que sí lo tiene', () => {
    const delCanal = { riesgo: '1', setup: 'REBOTE', lado: 'LONG' };
    const leido = planGuardadoParaTest({ op: { plan: delCanal } });

    expect(leido).not.toBeNull();
    expect(setupDeParaTest(leido!)).toBe('REBOTE');
  });

  it('y no se inventa un plan donde no lo hay', () => {
    expect(planGuardadoParaTest({})).toBeNull();
    expect(planGuardadoParaTest({ op: {} })).toBeNull();
    // Con riesgo pero sin nada que lo identifique: no es ni uno ni otro.
    expect(planGuardadoParaTest({ op: { plan: { riesgo: '1' } } })).toBeNull();
  });
});

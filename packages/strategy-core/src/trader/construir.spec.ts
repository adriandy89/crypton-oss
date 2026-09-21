import {
  AccionTrader,
  BucketObjetivo,
  BucketStop,
  D,
  MotivoTrader,
  NivelConfianza,
  RegimenMercado,
  TamanoOperacion,
  type EleccionConfianza,
  type RespuestaTrader,
} from '@crypton/shared';
import { construirOperacionTrader, cuantiza } from './construir';
import { espacioTrader } from './esqueletos';
import { juezTrader } from './juez';
import {
  MERCADO_TRADER,
  T0_TRADER,
  configDePrueba,
  entradaDePrueba,
  senalDePrueba,
} from './testing-trader';
import type { Regimen } from '../canal/regimen';

const segura = <T extends string>(clave: T, confianza = 1): EleccionConfianza<T> => ({
  clave,
  probabilidades: { [clave]: 1 },
  confianza,
});

function respuesta(o: Partial<RespuestaTrader> = {}): RespuestaTrader {
  return {
    accion: segura(AccionTrader.TOMAR),
    regimenRevierte: 1,
    toqueAgotamiento: 1,
    historialApoya: 1,
    stopDeterminado: 0,
    stop: segura(BucketStop.MEDIDO),
    objetivoDeterminado: 0,
    objetivo: segura(BucketObjetivo.EN_LA_MEDIA),
    ...o,
  };
}

const REGIMEN_RANGO: Regimen = {
  regimen: RegimenMercado.RANGO,
  sentido: null,
  medidas: null,
  crudos: [RegimenMercado.RANGO, RegimenMercado.RANGO, RegimenMercado.RANGO],
};

/**
 * Los cuatro mandos que pueden ponerle un juez encima al modelo.
 *
 * Desde la revision del 069 vienen APAGADOS de fabrica —en modo IA decide la
 * IA—, asi que este bloque los enciende a mano: lo que prueba es que el
 * mecanismo funciona cuando el usuario lo quiere, no lo que pasa por defecto.
 * Lo que pasa por defecto se prueba mas abajo, y es lo contrario.
 */
const CON_JUEZ = {
  minRouteConfidence: 0.45,
  fullSizeConfidence: 0.6,
  statedThreshold: 0.6,
  requireAgreement: true,
};

describe('cuantiza — la frontera del invariante 13 (spec 068)', () => {
  const cfg = configDePrueba(CON_JUEZ);

  it('de probabilidades entran, y de ahí salen solo enumeraciones', () => {
    const v = cuantiza(respuesta(), cfg);

    expect(Object.values(v).every((x) => typeof x !== 'number')).toBe(true);
    expect(v.accion).toBe(AccionTrader.TOMAR);
    expect(v.confianza).toBe(NivelConfianza.ALTA);
  });

  it('con el mando abstenido, manda el defecto del usuario y no el del modelo', () => {
    // El modelo dice CENIDO, pero dice también que no tiene razón para preferirlo.
    const v = cuantiza(respuesta({ stopDeterminado: 0.1, stop: segura(BucketStop.CENIDO) }), cfg);
    expect(v.stop).toBe(cfg.stopPorDefecto);
  });

  it('y con el mando determinado, manda el modelo', () => {
    const v = cuantiza(respuesta({ stopDeterminado: 0.9, stop: segura(BucketStop.CENIDO) }), cfg);
    expect(v.stop).toBe(BucketStop.CENIDO);
  });

  /**
   * El patrón `stated` existe por esto: «la confianza refleja el argumento más
   * débil». Sin la vía de abstención, una respuesta arbitraria sobre un mando
   * del que nadie preguntaba tiraría abajo una decisión bien fundada.
   */
  it('la confianza de un mando abstenido NO baja la compuesta', () => {
    const conDuda = cuantiza(
      respuesta({ stopDeterminado: 0.1, stop: segura(BucketStop.CENIDO, 0.3) }),
      cfg,
    );
    const conRazon = cuantiza(
      respuesta({ stopDeterminado: 0.9, stop: segura(BucketStop.CENIDO, 0.3) }),
      cfg,
    );

    expect(conDuda.confianza).toBe(NivelConfianza.ALTA);
    expect(conRazon.confianza).toBe(NivelConfianza.BAJA);
  });

  it('las tres puertas de contexto solo pueden restar', () => {
    expect(cuantiza(respuesta({ regimenRevierte: 0.1 }), cfg).acuerdo).toBe(false);
    expect(cuantiza(respuesta({ toqueAgotamiento: 0.1 }), cfg).acuerdo).toBe(false);
    expect(cuantiza(respuesta({ historialApoya: 0.1 }), cfg).acuerdo).toBe(false);
    expect(cuantiza(respuesta(), cfg).acuerdo).toBe(true);
  });

  it('y se pueden apagar, porque son del usuario', () => {
    const sinAcuerdo = configDePrueba({ requireAgreement: false });
    expect(cuantiza(respuesta({ regimenRevierte: 0 }), sinAcuerdo).acuerdo).toBe(true);
  });

  it('la confianza solo REDUCE el tamaño: nunca hay una opción mayor', () => {
    expect(cuantiza(respuesta(), cfg).tamano).toBe(TamanoOperacion.COMPLETO);
    // Con el juez encendido (0,45 de ruta y 0,60 de tamaño completo), una
    // confianza de 0,50 opera a media posición. Apagado —que es el defecto—
    // operaría entera.
    expect(cuantiza(respuesta({ accion: segura(AccionTrader.TOMAR, 0.5) }), cfg).tamano).toBe(
      TamanoOperacion.MEDIO,
    );
  });
});

describe('construirOperacionTrader — de la decisión al dinero (spec 068)', () => {
  // Con el juez encendido: este bloque comprueba que cada negativa tiene su
  // motivo, y dos de esas negativas solo existen si el juez esta puesto.
  const cfg = configDePrueba(CON_JUEZ);
  const espacio = espacioTrader(entradaDePrueba());
  const construir = (r: RespuestaTrader, c = cfg) =>
    construirOperacionTrader(espacio, cuantiza(r, c), c, MERCADO_TRADER, 'i1', T0_TRADER);

  it('un TOMAR con todo en regla da un plan ejecutable', () => {
    const { plan, motivo } = construir(respuesta());

    expect(motivo).toBeNull();
    expect(plan).not.toBeNull();
    expect(D(plan!.cantidad).gt(0)).toBe(true);
    expect(plan!.apalancamiento).toBeGreaterThanOrEqual(1);
    expect(plan!.objetivos).toHaveLength(1);
    // Es un largo: stop debajo de la entrada y objetivo encima.
    expect(Number(plan!.stop)).toBeLessThan(Number(plan!.entradaTope));
    expect(Number(plan!.objetivos[0].precio)).toBeGreaterThan(Number(plan!.entradaTope));
  });

  it('cada negativa tiene su motivo, y son distintos', () => {
    expect(construir(respuesta({ accion: segura(AccionTrader.ESPERAR) })).motivo).toBe(
      MotivoTrader.NO_OPERAR,
    );
    expect(construir(respuesta({ accion: segura(AccionTrader.ENTORNO_EQUIVOCADO) })).motivo).toBe(
      MotivoTrader.ENTORNO,
    );
    expect(construir(respuesta({ accion: segura(AccionTrader.TOMAR, 0.1) })).motivo).toBe(
      MotivoTrader.CONFIANZA,
    );
    expect(construir(respuesta({ regimenRevierte: 0 })).motivo).toBe(MotivoTrader.DESACUERDO);
  });

  /**
   * La garantía de totalidad: ninguna respuesta, ni una que pida una celda
   * inexistente, produce un plan fuera de las celdas viables ofrecidas.
   */
  it('es total: pida lo que pida, el plan sale de una celda VIABLE', () => {
    for (const s of [BucketStop.CENIDO, BucketStop.MEDIDO, BucketStop.HOLGADO]) {
      for (const o of [BucketObjetivo.CORTO, BucketObjetivo.EN_LA_MEDIA, BucketObjetivo.LARGO]) {
        const { plan } = construir(
          respuesta({
            stopDeterminado: 1,
            stop: segura(s),
            objetivoDeterminado: 1,
            objetivo: segura(o),
          }),
        );
        if (!plan) continue;
        // El veredicto guarda lo PEDIDO. Lo que se ejecuta sale siempre de una
        // celda viable, aunque lo pedido no lo fuera.
        const usada = espacio.esqueletos.find(
          (x) =>
            x.viable && x.precioStop === plan.stop && x.precioObjetivo === plan.objetivos[0].precio,
        );
        expect(usada).toBeDefined();
      }
    }
  });

  it('camina hacia lo prudente, nunca hacia el riesgo', () => {
    // Se pide la celda que el fixture deja no viable (holgado + corto, que cae
    // por RR) y tiene que salir una más prudente, no una más arriesgada.
    const { plan } = construir(
      respuesta({
        stopDeterminado: 1,
        stop: segura(BucketStop.HOLGADO),
        objetivoDeterminado: 1,
        objetivo: segura(BucketObjetivo.CORTO),
      }),
    );
    expect(plan).not.toBeNull();
  });

  it('media posición que no llega al mínimo del venue no se fuerza', () => {
    const espacioGrande = espacioTrader(entradaDePrueba({}, { totalInvestment: '20' }));
    const r = construirOperacionTrader(
      espacioGrande,
      cuantiza(respuesta({ accion: segura(AccionTrader.TOMAR, 0.5) }), cfg),
      cfg,
      MERCADO_TRADER,
      'i1',
      T0_TRADER,
    );
    // O sale media de verdad, o no sale: nunca sale entera disfrazada de media.
    if (r.plan) {
      const celda = espacioGrande.esqueletos.find((x) => x.viable)!;
      expect(D(r.plan.cantidad).lte(D(celda.cantidad!))).toBe(true);
    } else {
      expect(r.motivo).toBe(MotivoTrader.MINIMO);
    }
  });
});

describe('juezTrader — el brazo de control (spec 068)', () => {
  const cfg = configDePrueba();

  it('en rango y con celda viable, toma el toque', () => {
    const espacio = espacioTrader(entradaDePrueba());
    const r = juezTrader(espacio, REGIMEN_RANGO, cfg);

    expect(r.accion.clave).toBe(AccionTrader.TOMAR);
    expect(r.accion.confianza).toBe(1);
  });

  it('en tendencia no espera: arma el enfriado, porque es otro mercado', () => {
    const espacio = espacioTrader(entradaDePrueba());
    const r = juezTrader(espacio, { ...REGIMEN_RANGO, regimen: RegimenMercado.TENDENCIA }, cfg);

    expect(r.accion.clave).toBe(AccionTrader.ENTORNO_EQUIVOCADO);
  });

  it('sin borde tocado, espera', () => {
    const espacio = espacioTrader(entradaDePrueba({ senal: senalDePrueba({ lado: null }) }));
    expect(juezTrader(espacio, REGIMEN_RANGO, cfg).accion.clave).toBe(AccionTrader.ESPERAR);
  });

  it('con la banda demasiado estrecha para su ATR, espera', () => {
    const espacio = espacioTrader(entradaDePrueba({ senal: senalDePrueba({ anchuraAtr: 0.5 }) }));
    expect(juezTrader(espacio, REGIMEN_RANGO, cfg).accion.clave).toBe(AccionTrader.ESPERAR);
  });

  it('se abstiene SIEMPRE de los mandos: el control es «2 ATR y la media»', () => {
    const espacio = espacioTrader(entradaDePrueba());
    const r = juezTrader(espacio, REGIMEN_RANGO, cfg);
    const v = cuantiza(r, cfg);

    expect(r.stopDeterminado).toBe(0);
    expect(r.objetivoDeterminado).toBe(0);
    expect(v.stop).toBe(BucketStop.MEDIDO);
    expect(v.objetivo).toBe(BucketObjetivo.EN_LA_MEDIA);
  });

  it('su respuesta pasa por el MISMO camino que la del modelo', () => {
    const espacio = espacioTrader(entradaDePrueba());
    const { plan } = construirOperacionTrader(
      espacio,
      cuantiza(juezTrader(espacio, REGIMEN_RANGO, cfg), cfg),
      cfg,
      MERCADO_TRADER,
      'i1',
      T0_TRADER,
    );
    expect(plan).not.toBeNull();
  });
});

/**
 * En modo IA decide la IA (spec 069, revision).
 *
 * Este bloque existe porque la primera version del 069 le puso al modelo tres
 * jueces encima: un veto de «acuerdo», un suelo de confianza y un umbral que
 * TIRABA su eleccion de stop para sustituirla por el valor por defecto. Con la
 * confianza real del modelo —que medida contra BTC no paso de 0,61— eso
 * significaba que la mitad de sus decisiones salian a medio tamano y otra parte
 * no salia. Se estaba midiendo al juez, no a la IA.
 *
 * Si alguien vuelve a subir uno de estos defectos, esto falla. Es el punto.
 */
describe('cuantiza con los defectos: manda el modelo', () => {
  const respuesta = (o: Partial<RespuestaTrader> = {}): RespuestaTrader => ({
    accion: {
      clave: AccionTrader.TOMAR,
      probabilidades: { TOMAR: 0.5, ESPERAR: 0.3, ENTORNO_EQUIVOCADO: 0.2 },
      // Baja a proposito: con los umbrales viejos esto no habria operado.
      confianza: 0.35,
    },
    regimenRevierte: 0.2,
    toqueAgotamiento: 0.2,
    historialApoya: 0.2,
    stopDeterminado: 0.05,
    stop: { clave: BucketStop.HOLGADO, probabilidades: {}, confianza: 0.2 },
    objetivoDeterminado: 0.05,
    objetivo: { clave: BucketObjetivo.CORTO, probabilidades: {}, confianza: 0.2 },
    ...o,
  });

  it('su eleccion de stop y objetivo se ejecuta aunque no «este determinada»', () => {
    const v = cuantiza(respuesta(), configDePrueba());

    expect(v.stop).toBe(BucketStop.HOLGADO);
    expect(v.objetivo).toBe(BucketObjetivo.CORTO);
  });

  it('una confianza baja no le quita tamano ni le impide operar', () => {
    const v = cuantiza(respuesta(), configDePrueba());

    expect(v.confianza).toBe(NivelConfianza.ALTA);
    expect(v.tamano).toBe(TamanoOperacion.COMPLETO);
  });

  it('las tres preguntas de contexto no vetan al enrutado', () => {
    const v = cuantiza(respuesta(), configDePrueba());

    expect(v.acuerdo).toBe(true);
    expect(v.accion).toBe(AccionTrader.TOMAR);
  });

  /**
   * Los mandos siguen ahi y siguen siendo del usuario: quien quiera un juez
   * encima del modelo lo enciende. Lo que cambio es el defecto.
   */
  it('pero el usuario puede volver a ponerle un juez encima', () => {
    const conJuez = configDePrueba({
      minRouteConfidence: 0.45,
      fullSizeConfidence: 0.6,
      statedThreshold: 0.6,
      requireAgreement: true,
    });
    const v = cuantiza(respuesta(), conJuez);

    expect(v.confianza).toBe(NivelConfianza.BAJA);
    expect(v.acuerdo).toBe(false);
    expect(v.stop).toBe(conJuez.stopPorDefecto);
  });
});

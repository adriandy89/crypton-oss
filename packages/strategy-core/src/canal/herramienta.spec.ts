import {
  BandaApalancamiento,
  D,
  Decimal,
  EsquemaObjetivo,
  EstadoSetup,
  Evidencia,
  NivelConfianza,
  TamanoOperacion,
  TipoCanal,
  TipoStop,
  Veredicto,
  maintenanceMarginRateOf,
  precioLiquidacion,
  tramoDeApalancamiento,
  type EleccionOperacion,
  type NivelApalancamiento,
  type OpcionStop,
  type SalidaHerramienta,
} from '@crypton/shared';
import { makeMarket } from '../testing';
import {
  construirOperacion,
  herramientaCanal,
  inicioDelCanal,
  nivelesDecimalesEn,
  objetivosDeEsquema,
  perdidaHoyPct,
  precioDeStop,
  tramosOrdenados,
} from './herramienta';
import {
  QUINCE_MIN,
  T0_CANAL,
  canalDePrueba,
  candidatoDePrueba,
  casoAleatorio,
  entradaDePrueba,
  historialDePrueba,
  mejorTiempo,
  mercadoDePrueba,
  mulberry32,
} from './testing-canal';

const opcion = (s: SalidaHerramienta, tipo: TipoStop, i = 0): OpcionStop => {
  const o = s.candidatos[i].stops.find((x) => x.tipo === tipo);
  if (!o) throw new Error('sin opción ' + tipo);
  return o;
};

const eleccion = (o: Partial<EleccionOperacion> = {}): EleccionOperacion => ({
  veredicto: Veredicto.OPERAR,
  opcion: `REB-L-H${T0_CANAL}`,
  stop: TipoStop.AJUSTADO,
  objetivo: EsquemaObjetivo.MEDIA,
  apalancamiento: BandaApalancamiento.ALTA,
  tamano: TamanoOperacion.COMPLETO,
  confianza: NivelConfianza.ALTA,
  ...o,
});

describe('herramientaCanal: el ejemplo trabajado', () => {
  /*
   * 1000 USDC, riesgo 1 %, margen máximo 25 %, colchón 3, comisiones de
   * Hyperliquid (taker 4,5 bps, maker 1,5, deslizamiento 2). Par con tick 0,01,
   * step 0,001, mantenimiento 1 % y máximo 50x. Libro 100,00 / 100,02, ATR(15m)
   * 0,4 y ATR(1h) 0,8. Canal 99,9-102,9; un largo tocó 99,95.
   *
   * Stops = 99,95 − (k·0,4 + 0,01): 99,84 · 99,74 · 99,54.
   * Tope de la IOC = 100,02 + 0,2·(100,02 − 99,84) = 100,056 → compra hacia
   * abajo → 100,05.
   *
   * Ajustado:
   *   unidad = 0,21 + 100,05·0,00045 + 99,84·0,00065 = 0,3199185
   *   R      = min(1000·1 %, 1000·6 %·0,9) = 10
   *   N      = 10/0,3199185·100,05 → cantidad 31,257 (a la baja) → 3127,26285
   *   pérdida al stop = 0,3199185·31,257 = 9,9996925545 ≤ 10
   *   need   = max(3·0,21/100,05, 3·0,8/100,05) = 0,023988…
   *   Lstop  = floor(1/(0,01 + 0,023988·1,01)) = 29 → topado a 25
   *   Lmin   = ceil(3127,36/250) = 13 · media round(19) = 19
   *   liquidación a 25x = 100,05·0,96/0,99 = 97,018… → hacia la entrada 97,02
   *   TP1 = 101,40 · TP2 = 102,9 − 0,15·3 = 102,45
   */
  const s = herramientaCanal(entradaDePrueba());
  const aj = opcion(s, TipoStop.AJUSTADO);

  it('precios: stops, tope de la IOC y objetivos en la retícula y hacia la entrada', () => {
    const c = s.candidatos[0];
    expect(c.entradaReferencia).toBe('100.02');
    expect(c.entradaTope).toBe('100.05');
    expect(c.tp1).toBe('101.4');
    expect(c.tp2).toBe('102.45');
    expect(c.extremo).toBe('99.95');
    expect(c.stops.map((o) => o.precio)).toEqual(['99.84', '99.74', '99.54']);
    expect(c.descartes).toEqual([]);
  });

  it('fuera de la retícula, stops y objetivos redondean HACIA la entrada', () => {
    // ATR 0,403: el ajustado cae en 99,95 − 0,11075 = 99,83925. Canal hasta
    // 102,905: media 101,4025 y opuesto 102,905 − 0,45075 = 102,45425.
    const e = entradaDePrueba({
      mercado: mercadoDePrueba({ atr15m: '0.403' }),
      canal: canalDePrueba({ resistencia: '102.905', media: '101.4025' }),
    });
    const largo = herramientaCanal(e).candidatos[0];
    expect(largo.stops[0].precio).toBe('99.84');
    expect([largo.tp1, largo.tp2]).toEqual(['101.4', '102.45']);

    const corto = herramientaCanal({
      ...e,
      ticker: { ...e.ticker, bid: '102.78', ask: '102.80' },
      canal: canalDePrueba({ soporte: '99.895', media: '101.3975' }),
      candidatos: [candidatoDePrueba({ lado: 'SHORT' })],
    }).candidatos[0];
    // 102,85 + 0,11075 = 102,96075 → 102,96. Media 101,3975 → 101,40;
    // opuesto 99,895 + 0,15·3,005 = 100,34575 → 100,35.
    expect(corto.stops[0].precio).toBe('102.96');
    expect([corto.tp1, corto.tp2]).toEqual(['101.4', '100.35']);
  });

  it('el ajustado, cifra a cifra', () => {
    expect(aj.viable).toBe(true);
    expect(aj.motivo).toBeNull();
    expect(aj.perdidaPorUnidad).toBe('0.3199185');
    expect(aj.riesgo).toBe('10.00');
    expect(aj.cantidad).toBe('31.257');
    expect(aj.nocional).toBe('3127.26285');
    expect(aj.perdidaAlStop).toBe('9.9996925545');
    expect(aj.apalancamientoMinimo).toBe(13);
    expect(aj.apalancamientoMaximo).toBe(25);
    expect(aj.bandas).toEqual([
      {
        banda: BandaApalancamiento.BAJA,
        apalancamiento: 13,
        margen: '240.56',
        liquidacion: '93.29',
        perdidaCatastrofica: '240.56',
      },
      {
        banda: BandaApalancamiento.MEDIA,
        apalancamiento: 19,
        margen: '164.59',
        liquidacion: '95.75',
        perdidaCatastrofica: '164.59',
      },
      {
        banda: BandaApalancamiento.ALTA,
        apalancamiento: 25,
        margen: '125.09',
        liquidacion: '97.02',
        perdidaCatastrofica: '125.09',
      },
    ]);
    expect(aj.distancia).toBeCloseTo(0.21 / 100.05, 12);
    // (1,35·31,257 − (100,05·0,00045 + 101,4·0,00015)·31,257) / 9,9996925545
    expect(aj.rNetoTp1).toBeCloseTo(4.03155, 4);
    // (2,4·31,257 − (100,05·0,00045 + 102,45·0,00015)·31,257) / 9,9996925545
    expect(aj.rNetoTp2).toBeCloseTo(7.31314, 4);
    expect(aj.costeR).toBeCloseTo(0.1099185 / 0.21, 10);
    expect(aj.aciertoEquilibrioTp1).toBeCloseTo(1 / (1 + (aj.rNetoTp1 ?? 0)), 12);
    expect(aj.riesgoPctCapital).toBeCloseTo(0.99996925545, 10);
    expect(aj.medioViable).toBe(true);
    expect(aj.esquemasViables).toEqual([
      EsquemaObjetivo.MEDIA,
      EsquemaObjetivo.ESCALONADO,
      EsquemaObjetivo.OPUESTO,
    ]);
  });

  it('el normal y el amplio: más stop, menos cantidad y la misma pérdida máxima', () => {
    const no = opcion(s, TipoStop.NORMAL);
    const am = opcion(s, TipoStop.AMPLIO);
    expect(no.perdidaPorUnidad).toBe('0.4198535');
    expect(no.cantidad).toBe('23.817');
    expect(no.apalancamientoMinimo).toBe(10);
    expect(am.perdidaPorUnidad).toBe('0.6197235');
    expect(am.cantidad).toBe('16.136');
    for (const o of [aj, no, am]) expect(D(o.perdidaAlStop ?? '99').lte(10)).toBe(true);
  });

  it('el uso del día y la huella', () => {
    expect(s.uso).toEqual({
      perdidaHoyPct: 0,
      topeDiarioPct: 6,
      operacionesHoy: 0,
      topeOperaciones: 8,
      rachaPerdidas: 0,
    });
    expect(s.huella).toBe(`${T0_CANAL - 300_000}|H${T0_CANAL}|REB-L-H${T0_CANAL}:LISTO`);
    expect(s.version).toBe(1);
  });

  it('el corto, en espejo: stop arriba, tope por debajo del bid y liquidación por encima del stop', () => {
    const e = entradaDePrueba({
      ticker: { ...entradaDePrueba().ticker, bid: '102.78', ask: '102.80', mark: '102.79' },
      candidatos: [candidatoDePrueba({ lado: 'SHORT' })],
    });
    const c = herramientaCanal(e).candidatos[0];
    expect(c.id).toBe(`REB-S-H${T0_CANAL}`);
    expect(c.stops.map((o) => o.precio)).toEqual(['102.96', '103.06', '103.26']);
    // 102,78 − 0,2·0,18 = 102,744 → venta hacia arriba → 102,75
    expect(c.entradaTope).toBe('102.75');
    // Hacia la entrada: los objetivos del corto redondean hacia arriba.
    expect(c.tp1).toBe('101.4');
    expect(c.tp2).toBe('100.35');
    const o = c.stops[0];
    // 0,21 + 102,75·0,00045 + 102,96·0,00065
    expect(o.perdidaPorUnidad).toBe('0.3231615');
    expect(o.cantidad).toBe('30.944');
    expect(o.apalancamientoMinimo).toBe(13);
    // 102,75·1,04/1,01 = 105,8019… → compra hacia abajo → 105,80
    expect(o.bandas[2]).toMatchObject({ apalancamiento: 25, liquidacion: '105.80' });
    expect(o.rNetoTp1).toBeCloseTo((1.35 * 30.944 - 0.0614475 * 30.944) / (0.3231615 * 30.944), 6);
  });
});

describe('herramientaCanal: la aritmética tiene que cerrar (spec 066)', () => {
  /**
   * El defecto que mató al canal, medido: en 28 operaciones reales la distancia
   * mediana al stop era 0,300 % y el coste de ida y vuelta 0,200 %, o sea que
   * las comisiones y el deslizamiento se llevaban el 67 % del riesgo. En 8 de
   * las 28 se lo llevaban ENTERO: para sacar 1R neto hacía falta 2R brutos.
   *
   * `costeR` ya se calculaba y solo se le enseñaba a la IA. Ahora frena.
   */
  it('un stop tan corto que el coste se come el riesgo no se ofrece', () => {
    // ATR diminuto: el stop ajustado queda a un suspiro de la entrada y el
    // coste, que es fijo en porcentaje, pasa a ser casi todo el riesgo.
    const e = entradaDePrueba({ mercado: mercadoDePrueba({ atr15m: '0.02', atr1h: '0.04' }) });
    const o = opcion(herramientaCanal(e), TipoStop.AJUSTADO);

    expect(o.viable).toBe(false);
    expect(o.motivo).toBe('COSTE');
  });

  it('con el stop a una distancia sana, el coste deja de ser la puerta', () => {
    // Con el ATR del fixture el amplio se queda en 0,215 de coste por R: por
    // encima del quinto que pide el defecto. Con el ATR al doble, el stop se
    // aleja y el coste cae a su sitio.
    const e = entradaDePrueba({ mercado: mercadoDePrueba({ atr15m: '0.8' }) });
    const o = opcion(herramientaCanal(e), TipoStop.AMPLIO);

    expect(o.costeR).not.toBeNull();
    expect(o.costeR!).toBeLessThanOrEqual(0.2);
    expect(o.motivo).not.toBe('COSTE');
  });

  it('el tope del coste es del usuario, no una constante escondida', () => {
    const apretado = entradaDePrueba({}, { maxCostPerTradeR: '0.01' });
    expect(opcion(herramientaCanal(apretado), TipoStop.AMPLIO).motivo).toBe('COSTE');

    const suelto = entradaDePrueba({}, { maxCostPerTradeR: '0.9' });
    expect(opcion(herramientaCanal(suelto), TipoStop.AMPLIO).motivo).not.toBe('COSTE');
  });

  /**
   * `minRewardRisk` compara el objetivo con el STOP, así que un stop diminuto
   * lo pasa con un objetivo diminuto. Lo que decide si una operación merece la
   * pena es el objetivo medido en COSTES: medido sobre 12 pares y 7 meses, con
   * la puerta en 15× el R medio pasa de −0,2295 a +0,1043.
   */
  it('un objetivo que no llega a los costes pedidos no se ofrece', () => {
    const e = entradaDePrueba({}, { minTargetCostMultiple: 400 });
    const o = opcion(herramientaCanal(e), TipoStop.AMPLIO);

    expect(o.viable).toBe(false);
    expect(o.motivo).toBe('OBJETIVO_CORTO');
  });

  it('y con un objetivo holgado, pasa', () => {
    const e = entradaDePrueba({}, { minTargetCostMultiple: 1 });
    expect(opcion(herramientaCanal(e), TipoStop.AMPLIO).motivo).not.toBe('OBJETIVO_CORTO');
  });

  /**
   * La puerta mide contra el objetivo que el bot va a poner de verdad. `tp1` es
   * la media del canal y `tp2` el borde opuesto, al doble de distancia: a quien
   * solo admite `OPUESTO` no se le puede negar la entrada por lo corto que le
   * quedaría un objetivo que nunca va a usar.
   */
  it('quien solo apunta al borde opuesto se mide contra ese objetivo, no contra la media', () => {
    // En el fixture, la media queda a 10,4 costes y el borde opuesto a 18,5:
    // el defecto de producción, 15, cae justo entre los dos.
    const exigencia = { minTargetCostMultiple: 15 };
    const media = entradaDePrueba({}, exigencia);
    const opuesto = entradaDePrueba({}, { ...exigencia, takeProfitSchemes: 'OPUESTO' });

    expect(opcion(herramientaCanal(media), TipoStop.AMPLIO).motivo).toBe('OBJETIVO_CORTO');
    expect(opcion(herramientaCanal(opuesto), TipoStop.AMPLIO).motivo).not.toBe('OBJETIVO_CORTO');
  });
});

/**
 * Un borde trazado desde giros es un precio que el mercado defendió; una banda
 * de Bollinger no la defiende nadie. Por eso el stop de una banda va fuera, y
 * la escalera de cada tipo de canal es distinta (spec 067).
 */
describe('herramientaCanal: la escalera de stops depende del canal (spec 067)', () => {
  /** A cuántos ATR del extremo del candidato queda el stop, sin el medio spread. */
  const stopDe = (tipoCanal: TipoCanal, tipo: TipoStop): number => {
    const e = entradaDePrueba({ canal: canalDePrueba({ tipo: tipoCanal }) });
    const cand = candidatoDePrueba();
    const medioSpread = D(e.ticker.ask).minus(e.ticker.bid).abs().div(2);
    const stop = precioDeStop(e, cand, tipo, tipoCanal);
    return Number(
      D(String(cand.extremo)).minus(stop!).minus(medioSpread).div(e.mercado.atr15m).toFixed(4),
    );
  };

  it('el canal de giros mantiene su cuarto, su medio y su ATR', () => {
    expect(stopDe(TipoCanal.HORIZONTAL, TipoStop.AJUSTADO)).toBeCloseTo(0.25, 2);
    expect(stopDe(TipoCanal.HORIZONTAL, TipoStop.NORMAL)).toBeCloseTo(0.5, 2);
    expect(stopDe(TipoCanal.HORIZONTAL, TipoStop.AMPLIO)).toBeCloseTo(1, 2);
    expect(stopDe(TipoCanal.INCLINADO, TipoStop.NORMAL)).toBeCloseTo(0.5, 2);
  });

  it('el de banda pone el stop fuera: 1, 1,5 y 2,5 ATR', () => {
    expect(stopDe(TipoCanal.BANDA, TipoStop.AJUSTADO)).toBeCloseTo(1, 2);
    expect(stopDe(TipoCanal.BANDA, TipoStop.NORMAL)).toBeCloseTo(1.5, 2);
    // 2,5 ATR es lo que usaba la medición que trajo este tipo de canal.
    expect(stopDe(TipoCanal.BANDA, TipoStop.AMPLIO)).toBeCloseTo(2.5, 2);
  });
});

/**
 * En un canal de banda el borde opuesto está a cuatro sigmas: apuntar ahí no es
 * revertir a la media, es pedir la travesía entera. Medido sobre doce pares y
 * siete meses, dejarlo elegir hundía el R medio de +0,28 a −0,21 (spec 067).
 */
describe('herramientaCanal: en una banda el objetivo es la media (spec 067)', () => {
  // El amplio no sirve de sonda: en una banda son 2,5 ATR, y con ese stop la
  // relación beneficio/riesgo del fixture ya no llega a `minRewardRisk`.
  const esquemasDe = (tipo: TipoCanal): EsquemaObjetivo[] =>
    opcion(herramientaCanal(entradaDePrueba({ canal: canalDePrueba({ tipo }) })), TipoStop.NORMAL)
      .esquemasViables;

  it('el canal de giros sigue pudiendo apuntar al borde opuesto', () => {
    expect(esquemasDe(TipoCanal.HORIZONTAL)).toContain(EsquemaObjetivo.OPUESTO);
    expect(esquemasDe(TipoCanal.HORIZONTAL)).toContain(EsquemaObjetivo.ESCALONADO);
  });

  it('el de banda, no: ni el opuesto ni el escalonado, que cobra la mitad allí', () => {
    const esquemas = esquemasDe(TipoCanal.BANDA);

    expect(esquemas).toContain(EsquemaObjetivo.MEDIA);
    expect(esquemas).not.toContain(EsquemaObjetivo.OPUESTO);
    expect(esquemas).not.toContain(EsquemaObjetivo.ESCALONADO);
  });
});

describe('herramientaCanal: los límites', () => {
  it('lo perdido hoy recorta el riesgo al 90 % de lo que queda del tope', () => {
    const e = entradaDePrueba({ historial: historialDePrueba({ realizadoHoy: '-55' }) });
    const s = herramientaCanal(e);
    const o = opcion(s, TipoStop.AJUSTADO);
    // (6 − 5,5) % de 1000 · 0,9 = 4,5
    expect(o.riesgo).toBe('4.50');
    expect(D(o.perdidaAlStop ?? '99').lte('4.5')).toBe(true);
    expect(s.uso.perdidaHoyPct).toBe(5.5);
  });

  it('con el tope diario gastado no hay opción', () => {
    const e = entradaDePrueba({ historial: historialDePrueba({ realizadoHoy: '-60' }) });
    const c = herramientaCanal(e).candidatos[0];
    expect(c.stops.map((o) => o.motivo)).toEqual(['TOPE_DIARIO', 'TOPE_DIARIO', 'TOPE_DIARIO']);
    expect(c.descartes).toEqual(['SIN_OPCION_VIABLE']);
  });

  it('lo ganado hoy no amplía el riesgo', () => {
    const e = entradaDePrueba({ historial: historialDePrueba({ realizadoHoy: '300' }) });
    expect(opcion(herramientaCanal(e), TipoStop.AJUSTADO).riesgo).toBe('10.00');
    expect(perdidaHoyPct(e.historial, D(1000)).toNumber()).toBe(0);
  });

  it('un stop que el precio ya pasó no se ofrece', () => {
    const e = entradaDePrueba({
      ticker: { ...entradaDePrueba().ticker, bid: '99.80', ask: '99.82' },
    });
    const c = herramientaCanal(e).candidatos[0];
    // El ajustado (99,84) queda por encima del ask; el tope sale del normal.
    expect(c.stops[0].motivo).toBe('STOP_INVALIDO');
    expect(c.entradaTope).toBe('99.83');
    // Y el normal, con el precio ya tan encima del giro, deja el stop a 0,06 %
    // contra un coste de ida y vuelta de 0,11 %: el coste es el DOBLE del
    // riesgo. Antes se ofrecía; desde el spec 066 no, y es el caso de libro de
    // por qué la puerta existe.
    expect(c.stops[1].motivo).toBe('COSTE');
    expect(c.stops[2].viable).toBe(true);
  });

  it('un stop más ancho que maxStopPct no se ofrece', () => {
    const e = entradaDePrueba({ mercado: mercadoDePrueba({ atr15m: '2', atr1h: '0.01' }) });
    const c = herramientaCanal(e).candidatos[0];
    expect(c.stops[2].motivo).toBe('STOP_ANCHO');
  });

  it('un stop más ancho da menos apalancamiento', () => {
    const e = entradaDePrueba(
      { mercado: mercadoDePrueba({ atr15m: '2', atr1h: '0.01' }) },
      { maxStopPct: '3', maxMarginPct: '100' },
    );
    const c = herramientaCanal(e).candidatos[0];
    // Tope 100,13; stops 99,44 · 98,94 · 97,94:
    //   s = 0,69 % → need 2,07 % → 32 → 25
    //   s = 1,19 % → need 3,57 % → 21
    //   s = 2,19 % → need 6,56 % → 13
    expect(c.entradaTope).toBe('100.13');
    expect(c.stops.map((o) => o.apalancamientoMaximo)).toEqual([25, 21, 13]);
  });

  it('el tope de apalancamiento del bot, del par y de la cuenta', () => {
    const base = entradaDePrueba({}, { leverage: 20 });
    expect(opcion(herramientaCanal(base), TipoStop.AJUSTADO).apalancamientoMaximo).toBe(20);
    const usuario = entradaDePrueba({ maxApalancamientoUsuario: 15 });
    expect(opcion(herramientaCanal(usuario), TipoStop.AJUSTADO).apalancamientoMaximo).toBe(15);
    const par = entradaDePrueba({
      market: makeMarket({
        tickSize: '0.01',
        stepSize: '0.001',
        priceDecimals: 2,
        qtyDecimals: 3,
        maxLeverage: 10,
        maintenanceMarginRate: 0.01,
      }),
    });
    const o = opcion(herramientaCanal(par), TipoStop.AJUSTADO);
    expect(o.apalancamientoMaximo).toBe(10);
    // Ni a 10x cabe el nocional en 250 de margen: se reduce a 2500.
    expect(o.apalancamientoMinimo).toBe(10);
    expect(D(o.nocional ?? '0').lte(2500)).toBe(true);
  });

  it('poco saldo libre reduce el nocional, no sube la palanca', () => {
    const e = entradaDePrueba({ saldoLibre: '100' });
    const o = opcion(herramientaCanal(e), TipoStop.AJUSTADO);
    // min(250, 90) = 90 de margen; 3127/90 → 35 > 25 → 90·25 = 2250
    expect(o.apalancamientoMinimo).toBe(25);
    expect(o.cantidad).toBe('22.488');
    expect(D(o.nocional ?? '0').lte(2250)).toBe(true);
    expect(
      herramientaCanal(entradaDePrueba({ saldoLibre: '0' })).candidatos[0].stops[0].motivo,
    ).toBe('SIN_MARGEN');
  });

  it('el múltiplo y el tope de nocional', () => {
    const e = entradaDePrueba({}, { maxNotionalMultiple: '2', maxNotionalCap: '1500' });
    const o = opcion(herramientaCanal(e), TipoStop.AJUSTADO);
    expect(D(o.nocional ?? '0').lte(1500)).toBe(true);
    expect(o.cantidad).toBe('14.992');
  });

  it('los tramos: el nocional que cae en un tramo usa SUS reglas', () => {
    const niveles: NivelApalancamiento[] = [
      { desdeNocional: '1000', maxApalancamiento: 10, mantenimiento: 0.05 },
      { desdeNocional: '0', maxApalancamiento: 50, mantenimiento: 0.01 },
    ];
    const o = opcion(herramientaCanal(entradaDePrueba({ niveles })), TipoStop.AJUSTADO);
    // Tramo 1: acotado a 1000 → 9,995. Tramo 2: 3127 no cabe en 250 a 10x →
    // 2500 → 24,987. Gana el mayor, con el mantenimiento del 5 %.
    expect(o.cantidad).toBe('24.987');
    expect(o.bandas.map((b) => b.apalancamiento)).toEqual([10, 10, 10]);
    // 100,05·0,9/0,95 = 94,784… → 94,79
    expect(o.bandas[0].liquidacion).toBe('94.79');
  });

  it('los tramos: un tramo que no deja operar no impide el anterior', () => {
    const niveles: NivelApalancamiento[] = [
      { desdeNocional: '0', maxApalancamiento: 50, mantenimiento: 0.01 },
      { desdeNocional: '2000', maxApalancamiento: 1, mantenimiento: 0.5 },
    ];
    const o = opcion(herramientaCanal(entradaDePrueba({ niveles })), TipoStop.AJUSTADO);
    expect(D(o.nocional ?? '0').lt(2000)).toBe(true);
    expect(o.apalancamientoMaximo).toBe(25);
  });

  it('por debajo del mínimo del venue no hay opción', () => {
    const e = entradaDePrueba({
      market: makeMarket({
        tickSize: '0.01',
        stepSize: '0.001',
        priceDecimals: 2,
        qtyDecimals: 3,
        minNotional: '5000',
        maxLeverage: 50,
      }),
    });
    expect(herramientaCanal(e).candidatos[0].stops.map((o) => o.motivo)).toEqual([
      'MINIMO',
      'MINIMO',
      'MINIMO',
    ]);
  });

  it('medioViable: la mitad tiene que llegar al mínimo, con la cuenta de la operación', () => {
    const conMinimo = (minNotional: string) =>
      entradaDePrueba({
        market: makeMarket({
          tickSize: '0.01',
          stepSize: '0.001',
          priceDecimals: 2,
          qtyDecimals: 3,
          minNotional,
          maxLeverage: 50,
        }),
      });
    // Ajustado: 31,257 entera y 15,628 la mitad, a 100,05: 1563,5814 de nocional.
    const justo = conMinimo('1563.5814');
    const oJusto = opcion(herramientaCanal(justo), TipoStop.AJUSTADO);
    expect(oJusto.viable).toBe(true);
    expect(oJusto.medioViable).toBe(true);
    const medio = eleccion({ tamano: TamanoOperacion.MEDIO });
    const ok = construirOperacion(
      herramientaCanal(justo),
      medio,
      justo.cfg,
      justo.market,
      'x',
      T0_CANAL,
    );
    expect(ok.plan?.cantidad).toBe('15.628');

    const corto = conMinimo('1563.5815');
    const oCorto = opcion(herramientaCanal(corto), TipoStop.AJUSTADO);
    expect(oCorto.viable).toBe(true);
    expect(oCorto.medioViable).toBe(false);
    const no = construirOperacion(
      herramientaCanal(corto),
      medio,
      corto.cfg,
      corto.market,
      'x',
      T0_CANAL,
    );
    expect(no).toEqual({ plan: null, motivo: 'MINIMO' });
    // Una opción que no es viable tampoco lo es a medias.
    const sinOpcion = conMinimo('5000');
    expect(herramientaCanal(sinOpcion).candidatos[0].stops.every((o) => !o.medioViable)).toBe(true);
  });

  it('inicioDelCanal cuenta velas de la estructura', () => {
    const canal = { refT: T0_CANAL, duracionVelas: 40 };
    expect(inicioDelCanal(canal, '15m')).toBe(T0_CANAL - 40 * QUINCE_MIN);
    expect(inicioDelCanal(canal, '5m')).toBe(T0_CANAL - 40 * 300_000);
  });

  it('el máximo de cantidad del venue, también el de las órdenes a mercado', () => {
    const e = entradaDePrueba({
      market: makeMarket({
        tickSize: '0.01',
        stepSize: '0.001',
        priceDecimals: 2,
        qtyDecimals: 3,
        maxLeverage: 50,
        maxQty: '100',
        maxMarketQty: '5',
      }),
    });
    expect(opcion(herramientaCanal(e), TipoStop.AJUSTADO).cantidad).toBe('5');
  });

  it('un objetivo que no paga el mínimo de R deja la opción sin ese esquema', () => {
    // Canal estrecho: la media a 100,45 y el opuesto a 101 − 0,165 → 100,83.
    const canal = canalDePrueba({ soporte: '99.9', resistencia: '101', media: '100.45' });
    const s = herramientaCanal(entradaDePrueba({ canal }));
    const no = opcion(s, TipoStop.AMPLIO);
    expect(no.rNetoTp1 ?? 9).toBeLessThan(1.2);
    expect(no.esquemasViables).not.toContain(EsquemaObjetivo.MEDIA);
  });

  it('los esquemas que la configuración no permite no se ofrecen', () => {
    const s = herramientaCanal(entradaDePrueba({}, { takeProfitSchemes: 'OPUESTO' }));
    expect(opcion(s, TipoStop.AJUSTADO).esquemasViables).toEqual([EsquemaObjetivo.OPUESTO]);
  });

  it('descartes: sin confirmaciones, esperanza negativa y evidencia pedida', () => {
    const vigilando = entradaDePrueba({
      candidatos: [candidatoDePrueba({ estado: EstadoSetup.VIGILANDO })],
    });
    expect(herramientaCanal(vigilando).candidatos[0].descartes).toEqual(['CONFIRMACIONES']);

    const id = `REB-L-H${T0_CANAL}`;
    const mala = {
      n: 80,
      aciertos: 30,
      rMedio: -0.2,
      wilsonInferior: 0.27,
      evidencia: Evidencia.MODERADA,
    };
    const negativa = entradaDePrueba({ tasas: new Map([[id, mala]]) });
    expect(herramientaCanal(negativa).candidatos[0].descartes).toEqual(['ESPERANZA_NEGATIVA']);

    const sinTasas = entradaDePrueba({}, { requireEvidence: 'DEBIL' });
    expect(herramientaCanal(sinTasas).candidatos[0].descartes).toEqual(['EVIDENCIA']);
    const debil = {
      n: 30,
      aciertos: 18,
      rMedio: 0.3,
      wilsonInferior: 0.42,
      evidencia: Evidencia.DEBIL,
    };
    const conDebil = entradaDePrueba(
      { tasas: new Map([[id, debil]]) },
      { requireEvidence: 'DEBIL' },
    );
    expect(herramientaCanal(conDebil).candidatos[0].descartes).toEqual([]);
    const pideModerada = entradaDePrueba(
      { tasas: new Map([[id, debil]]) },
      { requireEvidence: 'MODERADA' },
    );
    expect(herramientaCanal(pideModerada).candidatos[0].descartes).toEqual(['EVIDENCIA']);
  });

  it('sin canal no hay candidatos, y la huella lo dice', () => {
    const s = herramientaCanal(entradaDePrueba({ canal: null }));
    expect(s.candidatos).toEqual([]);
    expect(s.huella).toBe(`${T0_CANAL - 300_000}|-|`);
  });

  it('un canal inclinado desplaza los objetivos con el tiempo', () => {
    const canal = canalDePrueba({ tipo: TipoCanal.INCLINADO, pendientePorVela: 0.1 });
    const e = entradaDePrueba({ canal, ahora: T0_CANAL + 2 * QUINCE_MIN });
    const c = herramientaCanal(e).candidatos[0];
    // +0,2: media 101,6, opuesto 103,1 − 0,45 = 102,65
    expect(c.tp1).toBe('101.6');
    expect(c.tp2).toBe('102.65');
    expect(nivelesDecimalesEn(canal, T0_CANAL + QUINCE_MIN).soporte.toFixed()).toBe('100');
  });
});

describe('construirOperacion', () => {
  const e = entradaDePrueba();
  const s = herramientaCanal(e);

  it('de la elección al plan, con los números de la oferta', () => {
    const r = construirOperacion(s, eleccion(), e.cfg, e.market, 'int-1', T0_CANAL);
    expect(r.motivo).toBeNull();
    expect(r.plan).toMatchObject({
      intentId: 'int-1',
      candidatoId: `REB-L-H${T0_CANAL}`,
      lado: 'LONG',
      entradaTope: '100.05',
      stop: '99.84',
      cantidad: '31.257',
      apalancamiento: 25,
      nocional: '3127.26285',
      riesgo: '9.9996925545',
      liquidacionEstimada: '97.02',
      objetivos: [{ precio: '101.4', cantidad: '31.257' }],
      huella: s.huella,
      barT: s.barT,
      venceEn: T0_CANAL + 24 * QUINCE_MIN,
      canal: { tipo: TipoCanal.HORIZONTAL, soporte: '99.9', resistencia: '102.9' },
    });
    // El primer toque, para dibujarlo: la duración en velas de la estructura.
    const canal = s.canal;
    if (!canal) throw new Error('sin canal');
    expect(r.plan?.canal.desde).toBe(canal.refT - canal.duracionVelas * QUINCE_MIN);
    expect(r.plan?.rNeto).toBeCloseTo(opcion(s, TipoStop.AJUSTADO).rNetoTp1 ?? 0, 10);
  });

  it('la banda solo cambia el apalancamiento y la liquidación', () => {
    const r = construirOperacion(
      s,
      eleccion({ apalancamiento: BandaApalancamiento.BAJA }),
      e.cfg,
      e.market,
      'x',
      T0_CANAL,
    );
    expect(r.plan).toMatchObject({
      apalancamiento: 13,
      cantidad: '31.257',
      liquidacionEstimada: '93.29',
    });
  });

  it('escalonado: 60 % al primer objetivo y el resto al segundo', () => {
    const r = construirOperacion(
      s,
      eleccion({ objetivo: EsquemaObjetivo.ESCALONADO }),
      e.cfg,
      e.market,
      'x',
      T0_CANAL,
    );
    expect(r.plan?.objetivos).toEqual([
      { precio: '101.4', cantidad: '18.754' },
      { precio: '102.45', cantidad: '12.503' },
    ]);
  });

  it('medio tamaño: la mitad de la cantidad y de la pérdida', () => {
    const r = construirOperacion(
      s,
      eleccion({ tamano: TamanoOperacion.MEDIO }),
      e.cfg,
      e.market,
      'x',
      T0_CANAL,
    );
    expect(r.plan?.cantidad).toBe('15.628');
    // 0,3199185 · 15,628
    expect(r.plan?.riesgo).toBe('4.999686318');
  });

  it('medio tamaño por debajo del mínimo: no hay operación', () => {
    const market = { ...e.market, minNotional: '2000' };
    const r = construirOperacion(
      s,
      eleccion({ tamano: TamanoOperacion.MEDIO }),
      e.cfg,
      market,
      'x',
      T0_CANAL,
    );
    expect(r).toEqual({ plan: null, motivo: 'MINIMO' });
  });

  it.each<[string, Partial<EleccionOperacion>, string]>([
    ['no operar', { veredicto: Veredicto.NO_OPERAR }, 'NO_OPERAR'],
    ['un candidato que no está', { opcion: 'REB-S-H1' }, 'OFERTA'],
    ['NINGUNA con OPERAR', { opcion: 'NINGUNA' }, 'OFERTA'],
  ])('rechaza %s', (_, o, motivo) => {
    expect(construirOperacion(s, eleccion(o), e.cfg, e.market, 'x', T0_CANAL)).toEqual({
      plan: null,
      motivo,
    });
  });

  it('rechaza un stop no viable y un esquema no viable', () => {
    const topeGastado = entradaDePrueba({ historial: historialDePrueba({ realizadoHoy: '-60' }) });
    const s2 = herramientaCanal(topeGastado);
    expect(construirOperacion(s2, eleccion(), e.cfg, e.market, 'x', T0_CANAL).motivo).toBe(
      'OFERTA',
    );

    const soloOpuesto = entradaDePrueba({}, { takeProfitSchemes: 'OPUESTO' });
    const s3 = herramientaCanal(soloOpuesto);
    expect(
      construirOperacion(s3, eleccion(), soloOpuesto.cfg, e.market, 'x', T0_CANAL).motivo,
    ).toBe('OFERTA');
  });

  it('rechaza un candidato que no está listo o está descartado', () => {
    const v = herramientaCanal(
      entradaDePrueba({ candidatos: [candidatoDePrueba({ estado: EstadoSetup.VIGILANDO })] }),
    );
    expect(construirOperacion(v, eleccion(), e.cfg, e.market, 'x', T0_CANAL).motivo).toBe('OFERTA');
  });

  it('vuelve a mirar la configuración: dirección, setups, canales y esquemas', () => {
    const cortos = entradaDePrueba({}, { direction: 'SHORT' }).cfg;
    expect(construirOperacion(s, eleccion(), cortos, e.market, 'x', T0_CANAL).motivo).toBe(
      'OFERTA',
    );
    const inclinados = entradaDePrueba({}, { allowedChannels: 'INCLINADO' }).cfg;
    expect(construirOperacion(s, eleccion(), inclinados, e.market, 'x', T0_CANAL).motivo).toBe(
      'OFERTA',
    );
    const falsos = entradaDePrueba({}, { allowedSetups: 'FALSO_QUIEBRE' }).cfg;
    expect(construirOperacion(s, eleccion(), falsos, e.market, 'x', T0_CANAL).motivo).toBe(
      'OFERTA',
    );
    const media = entradaDePrueba({}, { takeProfitSchemes: 'OPUESTO' }).cfg;
    expect(construirOperacion(s, eleccion(), media, e.market, 'x', T0_CANAL).motivo).toBe('OFERTA');
  });

  it('objetivosDeEsquema funde el escalonado si una parte no llega al mínimo', () => {
    const market = { ...e.market, minNotional: '500' };
    expect(
      objetivosDeEsquema(market, EsquemaObjetivo.ESCALONADO, D('8'), D('101'), D('102'), D('0.6')),
    ).toEqual([{ precio: '101', cantidad: '8' }]);
  });
});

// ── Propiedades ─────────────────────────────────────────────────────────────

describe('herramientaCanal: propiedades sobre 10.000 casos', () => {
  it('ningún límite se rompe en ninguna opción ni en ninguna banda', () => {
    const azar = mulberry32(58);
    let viables = 0;
    let planes = 0;
    for (let caso = 0; caso < 10_000; caso++) {
      const e = casoAleatorio(azar);
      const { cfg, market } = e;
      const s = herramientaCanal(e);
      const c = s.candidatos[0];
      const largo = c.lado === 'LONG';
      const tope = D(c.entradaTope);
      const ref = D(c.entradaReferencia);
      const fallo = (que: string) => `caso ${caso}: ${que}`;
      // El tope nunca es mejor que la referencia ni en más holgura de la pedida.
      expect(largo ? tope.gte(ref) : tope.lte(ref)).toBe(true);
      expect(tope.mod(market.tickSize).isZero()).toBe(true);
      const taker = D(cfg.costes.takerBps).div(10_000);
      const desl = D(cfg.costes.deslizamientoBps).div(10_000);
      const perdidaHoy = perdidaHoyPct(e.historial, cfg.capital);
      const riesgoMax = Decimal.min(
        cfg.capital.mul(cfg.riesgoPct).div(100),
        cfg.capital.mul(cfg.topeDiarioPct.minus(perdidaHoy)).div(100).mul('0.9'),
      );
      const margenMax = Decimal.min(
        cfg.capital.mul(cfg.maxMargenPct).div(100),
        D(e.saldoLibre).mul('0.9'),
      );
      const tramos = tramosOrdenados(
        e.niveles,
        market.maxLeverage,
        maintenanceMarginRateOf(market),
      );
      const palancaMax = Math.min(
        25,
        cfg.apalancamientoTope,
        market.maxLeverage,
        e.maxApalancamientoUsuario ?? 25,
      );
      for (const o of c.stops) {
        if (!o.viable) continue;
        viables++;
        const stop = D(o.precio);
        const q = D(o.cantidad ?? 'NaN');
        const n = D(o.nocional ?? 'NaN');
        const perdida = D(o.perdidaAlStop ?? 'NaN');
        const dist = tope.minus(stop).abs();
        const sRel = dist.div(tope);
        // Retícula y mínimos.
        expect(stop.mod(market.tickSize).isZero()).toBe(true);
        expect(q.mod(market.stepSize).isZero()).toBe(true);
        expect(n.eq(q.mul(tope))).toBe(true);
        if (market.minNotional) expect(n.gte(market.minNotional)).toBe(true);
        if (market.maxQty) expect(q.lte(market.maxQty)).toBe(true);
        if (market.maxMarketQty) expect(q.lte(market.maxMarketQty)).toBe(true);
        // El stop, del lado bueno y no más ancho de lo permitido.
        expect(largo ? stop.lt(tope) : stop.gt(tope)).toBe(true);
        expect(sRel.lte(cfg.maxStopPct.div(100))).toBe(true);
        // 1. La pérdida al stop, recalculada aquí, no pasa del riesgo.
        const unidad = dist.plus(tope.mul(taker)).plus(stop.mul(taker.plus(desl)));
        if (!unidad.mul(q).eq(perdida)) throw new Error(fallo('pérdida mal calculada'));
        if (perdida.gt(riesgoMax))
          throw new Error(fallo(`pérdida ${perdida.toFixed()} > ${riesgoMax.toFixed()}`));
        // Los topes de nocional.
        expect(n.lte(cfg.capital.mul(cfg.multiploNocional))).toBe(true);
        if (cfg.topeNocional) expect(n.lte(cfg.topeNocional)).toBe(true);
        // Las bandas.
        const tramo = tramoDeApalancamiento(
          tramos,
          n,
          market.maxLeverage,
          maintenanceMarginRateOf(market),
        );
        const necesaria = Decimal.max(
          sRel.mul(cfg.colchonStops),
          D(e.mercado.atr1h).div(tope).mul(3),
        );
        const [baja, media, alta] = o.bandas.map((b) => b.apalancamiento);
        expect(baja).toBeGreaterThanOrEqual(1);
        expect(baja).toBeLessThanOrEqual(media);
        expect(media).toBeLessThanOrEqual(alta);
        expect(n.lte(cfg.capital.mul(alta))).toBe(true);
        for (const b of o.bandas) {
          const L = b.apalancamiento;
          if (L > palancaMax || L > tramo.maxApalancamiento) {
            throw new Error(
              fallo(`palanca ${L} por encima de ${palancaMax}/${tramo.maxApalancamiento}`),
            );
          }
          // 3. Lo que se pierde en un hueco: el margen.
          if (n.div(L).gt(margenMax))
            throw new Error(fallo(`margen ${n.div(L).toFixed()} > ${margenMax.toFixed()}`));
          // 2. La liquidación, lejos y detrás del stop.
          const liq = precioLiquidacion(tope, L, tramo.mantenimiento, c.lado);
          if (liq) {
            const dLiq = tope.minus(liq).abs().div(tope);
            if (dLiq.lt(necesaria))
              throw new Error(fallo(`liquidación a ${dLiq.toFixed()} < ${necesaria.toFixed()}`));
            if (largo ? liq.gte(stop) : liq.lte(stop))
              throw new Error(fallo('liquidación antes del stop'));
          }
        }
        // El R de lo que se ofrece llega al mínimo.
        if (o.esquemasViables.includes(EsquemaObjetivo.MEDIA)) {
          expect(o.rNetoTp1 ?? -1).toBeGreaterThanOrEqual(cfg.minRR);
        }
        if (o.esquemasViables.includes(EsquemaObjetivo.OPUESTO)) {
          expect(o.rNetoTp2 ?? -1).toBeGreaterThanOrEqual(cfg.minRR);
        }
        for (const x of o.esquemasViables) expect(cfg.esquemas).toContain(x);

        // La mitad que promete la oferta es la que acepta la operación (spec 059).
        const aMedias = construirOperacion(
          s,
          eleccion({
            opcion: c.id,
            stop: o.tipo,
            objetivo: o.esquemasViables[0],
            tamano: TamanoOperacion.MEDIO,
          }),
          cfg,
          market,
          'x',
          e.ahora,
        );
        if ((aMedias.plan !== null) !== o.medioViable) {
          throw new Error(fallo(`medioViable ${o.medioViable} y la operación dice otra cosa`));
        }

        // Y la operación que sale de elegir la opción.
        const r = construirOperacion(
          s,
          eleccion({
            opcion: c.id,
            stop: o.tipo,
            objetivo: o.esquemasViables[Math.floor(azar() * o.esquemasViables.length)],
            apalancamiento: o.bandas[Math.floor(azar() * 3)].banda,
            tamano: azar() < 0.5 ? TamanoOperacion.COMPLETO : TamanoOperacion.MEDIO,
          }),
          cfg,
          market,
          'x',
          e.ahora,
        );
        if (!r.plan) {
          expect(r.motivo).toBe('MINIMO');
          continue;
        }
        planes++;
        const p = r.plan;
        const cantidad = D(p.cantidad);
        expect(cantidad.lte(q)).toBe(true);
        expect(D(p.riesgo).lte(perdida)).toBe(true);
        expect(p.stop).toBe(o.precio);
        const suma = p.objetivos.reduce((acc, x) => acc.plus(x.cantidad), D(0));
        expect(suma.eq(cantidad)).toBe(true);
        for (const x of p.objetivos) {
          const precioTp = D(x.precio);
          expect(precioTp.mod(market.tickSize).isZero()).toBe(true);
          expect(D(x.cantidad).mod(market.stepSize).isZero()).toBe(true);
          if (largo ? precioTp.lte(tope) : precioTp.gte(tope)) {
            throw new Error(fallo('un objetivo al otro lado de la entrada'));
          }
        }
      }
    }
    // Que el generador no se quede en casos que nunca operan.
    expect(viables).toBeGreaterThan(3000);
    expect(planes).toBeGreaterThan(2000);
  }, 120_000);
});

describe('herramientaCanal: rendimiento', () => {
  it('una oferta con dos candidatos tarda menos de 5 ms', () => {
    const e = entradaDePrueba({
      candidatos: [candidatoDePrueba(), candidatoDePrueba({ lado: 'SHORT' })],
      ticker: { ...entradaDePrueba().ticker, bid: '101.00', ask: '101.02' },
    });
    expect(mejorTiempo(() => herramientaCanal(e), 50)).toBeLessThan(5);
  });
});

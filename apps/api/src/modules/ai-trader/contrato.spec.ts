import { AccionTrader } from '@crypton/shared';
import { parseRespuestaTrader } from './contrato';
import { PREGUNTAS_IDS, preguntasTrader } from './preguntas';
import { espacioDePrueba, respuestaBuena } from './oferta.fixture-spec';
import { estadoTrader } from '@crypton/strategy-core';
import { configDePrueba } from './oferta.fixture-spec';

/**
 * El contrato de la respuesta (spec 069).
 *
 * La regla que gobierna todo esto: lo que llega de un proveedor externo **no se
 * completa a medias**. O encaja entero o es un fallo de contrato. Rellenar un
 * hueco con un valor prudente sería operar con una decisión que nadie tomó.
 */

describe('Las preguntas', () => {
  const estado = estadoTrader(espacioDePrueba(), configDePrueba());
  const preguntas = preguntasTrader(estado);

  it('son ocho, y ni una más', () => {
    expect(Object.keys(preguntas)).toHaveLength(8);
    expect(Object.keys(preguntas).sort()).toEqual(Object.values(PREGUNTAS_IDS).sort());
  });

  /**
   * Los criterios de las dos elecciones salen del estado que calculó el motor:
   * el modelo elige entre descripciones ya valoradas y validadas, nunca entre
   * números que tenga que inventar.
   */
  it('las opciones que se ofrecen son las que calculó el motor', () => {
    const stop = preguntas[PREGUNTAS_IDS.STOP];
    expect(stop.type).toBe('choice');
    expect(Object.keys((stop as { criteria: Record<string, string> }).criteria)).toEqual(
      estado.stop_choices.map((x) => x.key),
    );
  });

  it('el enrutado tiene tres opciones, no dos', () => {
    const accion = preguntas[PREGUNTAS_IDS.ACCION] as { criteria: Record<string, string> };
    expect(Object.keys(accion.criteria)).toHaveLength(3);
  });

  /**
   * En inglés a propósito, y sin una sola cifra con moneda ni el símbolo: el
   * estado ya lo garantiza, y las instrucciones no pueden reintroducirlo.
   */
  it('ninguna instrucción trae cifras ni el símbolo del par', () => {
    for (const p of Object.values(preguntas)) {
      expect(p.instructions).not.toMatch(/\d/);
      expect(p.instructions).not.toContain('TEST');
    }
  });
});

describe('El contrato de la respuesta', () => {
  it('una respuesta entera se traduce a nuestro vocabulario', () => {
    const r = parseRespuestaTrader(respuestaBuena());

    expect(r.fallo).toBeNull();
    expect(r.respuesta!.accion.clave).toBe(AccionTrader.TOMAR);
    expect(r.respuesta!.regimenRevierte).toBe(0.82);
    expect(r.respuesta!.stop.clave).toBe('MEDIDO');
  });

  /** Las probabilidades llegan con las claves inglesas: se traducen también. */
  it('las probabilidades del enrutado se traducen', () => {
    const r = parseRespuestaTrader(respuestaBuena());
    expect(r.respuesta!.accion.probabilidades).toEqual({
      TOMAR: 0.72,
      ESPERAR: 0.2,
      ENTORNO_EQUIVOCADO: 0.08,
    });
  });

  it.each(Object.values(PREGUNTAS_IDS))('sin la respuesta a %s, no hay decisión', (id) => {
    const answers = respuestaBuena();
    delete answers[id];
    const r = parseRespuestaTrader(answers);

    expect(r.respuesta).toBeNull();
    expect(r.fallo!.faltan).toContain(id);
  });

  it('una acción que no se ofreció no se interpreta', () => {
    const r = parseRespuestaTrader(
      respuestaBuena({
        action: { choice: 'BUY_EVERYTHING', probabilities: {}, confidence: 0.9 },
      }),
    );
    expect(r.respuesta).toBeNull();
  });

  /**
   * Las dos elecciones de mandos se validan SIEMPRE, aunque su noul de
   * «determinado» venga baja. Quien decide si se usan o mandan los defectos del
   * usuario es `cuantiza()`, y esa decisión no se adelanta aquí: adelantarla
   * haría pasar por buena una respuesta mal formada solo porque el modelo se
   * abstuvo.
   */
  it('una elección mal formada falla aunque el modelo se abstuviera de opinar', () => {
    const r = parseRespuestaTrader(
      respuestaBuena({
        stop_width_is_determined: { noul: 0.01 },
        stop_width: { choice: 'ENORME', probabilities: {}, confidence: 0.1 },
      }),
    );
    expect(r.respuesta).toBeNull();
    expect(r.fallo!.faltan).toContain(PREGUNTAS_IDS.STOP);
  });

  it('el fallo dice QUÉ faltó, para poder mirarlo después', () => {
    const r = parseRespuestaTrader({});
    expect(r.fallo!.faltan).toHaveLength(8);
  });
});

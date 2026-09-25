import {
  AccionSeguimiento,
  ClaseAccion,
  EstadoTesis,
  RegimenMercado,
  type EstadoOperacionAgente,
  type OpcionSeguimiento,
} from '@crypton/shared';
import { juezSeguimiento } from './juez-seguimiento';

/**
 * El juez de reglas del seguimiento (spec 074). Solo actúa con la idea rota,
 * o debilitada con beneficio en juego, o con el tiempo casi agotado a favor; y
 * siempre elige entre lo que se le ofrece.
 */

const estado = (extra: Partial<EstadoOperacionAgente> = {}): EstadoOperacionAgente => ({
  rAhora: 0.4,
  mfeR: 0.8,
  maeR: -0.3,
  minutos: 120,
  fraccionTiempo: 0.2,
  tp1Hecho: false,
  stopR: -1,
  posicionFraccion: 1,
  objetivoR: 1.2,
  tesis: EstadoTesis.INTACTA,
  motivosTesis: [],
  regimen: RegimenMercado.TENDENCIA,
  sentido: null,
  ...extra,
});

const opcion = (accion: AccionSeguimiento): OpcionSeguimiento => ({
  accion,
  clase:
    accion === AccionSeguimiento.MANTENER
      ? null
      : accion === AccionSeguimiento.CERRAR
        ? ClaseAccion.CERRAR
        : ClaseAccion.REDUCIR,
  cambio: {},
  stopNuevo: null,
  posicionNueva: null,
  riesgoRestanteR: 0,
});

const todas = Object.values(AccionSeguimiento).map(opcion);

describe('juezSeguimiento', () => {
  it('con la idea intacta, mantener: el plan ya lleva sus salidas', () => {
    expect(juezSeguimiento(estado({ rAhora: 2 }), todas)).toBe('MANTENER');
  });

  it('con la idea rota, cerrar; si cerrar no está permitido, lo más protector que haya', () => {
    const rota = estado({ tesis: EstadoTesis.ROTA });
    expect(juezSeguimiento(rota, todas)).toBe('CERRAR');
    const sinCerrar = todas.filter((o) => o.accion !== AccionSeguimiento.CERRAR);
    expect(juezSeguimiento(rota, sinCerrar)).toBe('ASEGURAR_UN_R');
    const soloReducir = [
      opcion(AccionSeguimiento.MANTENER),
      opcion(AccionSeguimiento.REDUCIR_TERCIO),
    ];
    expect(juezSeguimiento(rota, soloReducir)).toBe('REDUCIR_TERCIO');
    // Sin nada ofrecido, mantener: nunca inventa una acción.
    expect(juezSeguimiento(rota, [opcion(AccionSeguimiento.MANTENER)])).toBe('MANTENER');
  });

  it('con la idea debilitada, asegura solo si hay beneficio en juego', () => {
    const debil = estado({ tesis: EstadoTesis.DEBILITADA });
    expect(juezSeguimiento({ ...debil, rAhora: 0.5 }, todas)).toBe('MANTENER');
    expect(juezSeguimiento({ ...debil, rAhora: 1.2 }, todas)).toBe('ASEGURAR_MEDIO_R');
    const sinMedio = todas.filter((o) => o.accion !== AccionSeguimiento.ASEGURAR_MEDIO_R);
    expect(juezSeguimiento({ ...debil, rAhora: 1.2 }, sinMedio)).toBe('PROTEGER');
  });

  it('con el tiempo casi agotado y a favor, protege la entrada', () => {
    expect(juezSeguimiento(estado({ fraccionTiempo: 0.85, rAhora: 0.3 }), todas)).toBe('PROTEGER');
    expect(juezSeguimiento(estado({ fraccionTiempo: 0.85, rAhora: -0.3 }), todas)).toBe('MANTENER');
  });

  it('nunca devuelve algo que no se le ofreció', () => {
    for (const tesis of Object.values(EstadoTesis)) {
      for (const rAhora of [-1, 0, 0.5, 1.5, 3]) {
        for (const fraccionTiempo of [0, 0.5, 0.9, 1.2]) {
          for (let n = 1; n <= todas.length; n++) {
            const ofrecidas = [opcion(AccionSeguimiento.MANTENER), ...todas.slice(1, n)];
            const a = juezSeguimiento(estado({ tesis, rAhora, fraccionTiempo }), ofrecidas);
            expect(ofrecidas.map((o) => o.accion)).toContain(a);
          }
        }
      }
    }
  });
});

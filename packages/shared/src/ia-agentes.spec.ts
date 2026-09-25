import { AiMode } from './enums';
import {
  AUTONOMIA_DE_FABRICA,
  AccionSeguimiento,
  CLASE_DE_ACCION,
  ClaseAccion,
  ESQUEMA_DE_OBJETIVO,
  EfectoAccion,
  EstadoAgente,
  EstadoPropuestaAgente,
  EventoAgente,
  EventoOperacionAgente,
  INTERVALOS_AGENTE,
  LETRAS_OFERTA,
  MAX_OFERTA_AGENTE,
  OBJETIVO_DE_ESQUEMA,
  OPCION_NINGUNA,
  ObjetivoAgente,
  PROPUESTAS_EJECUTADAS,
  PROPUESTAS_TERMINALES,
  PROPUESTAS_VIVAS,
  PULSACION_AGENTE,
  SIN_FRENOS,
  VerboAgente,
  callbackAgente,
  claveValeAgente,
  datosEventoAgente,
  efectoDe,
  esEventoAgente,
  esIntervaloAgente,
  esValeAgente,
  insigniaAgente,
  leerCallbackAgente,
  type AutonomiaAgente,
  type EleccionAgente,
  type EstadoInsigniaAgente,
  type InterruptoresAgentes,
} from './ia-agentes';
import {
  BandaApalancamiento,
  EVENTOS_MODO_IA,
  ModoDecision,
  NivelConfianza,
  TamanoOperacion,
  TipoStop,
  eleccionEfectiva,
} from './ia-canal';

/**
 * El vocabulario de los agentes (spec 074). Lo que aquí se fija lo leen la API,
 * el worker y la app a la vez: un valor que cambia en un sitio y no en otro es
 * un botón que no hace nada o un aviso que no llega.
 */

const VALE = '0123456789abcdef0123456789abcdef';

describe('efectoDe: la autonomía con los frenos del servidor', () => {
  const todo = (modo: AiMode): AutonomiaAgente => ({ entrar: modo, reducir: modo, cerrar: modo });

  it('de fábrica: entrar y cerrar proponen, reducir aplica', () => {
    const f = (clase: ClaseAccion) => efectoDe(clase, AUTONOMIA_DE_FABRICA, SIN_FRENOS, true);
    expect(f(ClaseAccion.ENTRAR)).toBe(EfectoAccion.PROPONE);
    expect(f(ClaseAccion.REDUCIR)).toBe(EfectoAccion.APLICA);
    expect(f(ClaseAccion.CERRAR)).toBe(EfectoAccion.PROPONE);
  });

  it('apagado, entrar solo mide y lo demás no existe', () => {
    const a = todo(AiMode.OFF);
    expect(efectoDe(ClaseAccion.ENTRAR, a, SIN_FRENOS, true)).toBe(EfectoAccion.MIDE);
    expect(efectoDe(ClaseAccion.REDUCIR, a, SIN_FRENOS, true)).toBe(EfectoAccion.NUNCA);
    expect(efectoDe(ClaseAccion.CERRAR, a, SIN_FRENOS, true)).toBe(EfectoAccion.NUNCA);
  });

  it('forzar manual convierte lo automático en propuesta', () => {
    const frenos = { ...SIN_FRENOS, forzarManual: true };
    for (const clase of Object.values(ClaseAccion)) {
      expect(efectoDe(clase, todo(AiMode.AUTO), frenos, false)).toBe(EfectoAccion.PROPONE);
    }
  });

  it('solo simulación: en real no se entra y lo demás lo decide una persona', () => {
    const frenos = { ...SIN_FRENOS, soloSimulacion: true };
    const a = todo(AiMode.AUTO);
    expect(efectoDe(ClaseAccion.ENTRAR, a, frenos, true)).toBe(EfectoAccion.MIDE);
    expect(efectoDe(ClaseAccion.REDUCIR, a, frenos, true)).toBe(EfectoAccion.PROPONE);
    expect(efectoDe(ClaseAccion.CERRAR, a, frenos, true)).toBe(EfectoAccion.PROPONE);
    // En la cuenta de simulación no cambia nada.
    expect(efectoDe(ClaseAccion.ENTRAR, a, frenos, false)).toBe(EfectoAccion.APLICA);
  });

  it('la sombra lo registra todo sin ejecutar nada', () => {
    const frenos = { ...SIN_FRENOS, soloSombra: true };
    for (const clase of Object.values(ClaseAccion)) {
      expect(efectoDe(clase, todo(AiMode.AUTO), frenos, false)).toBe(EfectoAccion.MIDE);
    }
  });

  it('ningún freno convierte nada en automático', () => {
    const modos = Object.values(AiMode);
    const bools = [false, true];
    for (const clase of Object.values(ClaseAccion)) {
      for (const modo of modos) {
        for (const forzarManual of bools) {
          for (const soloSimulacion of bools) {
            for (const soloSombra of bools) {
              for (const real of bools) {
                const e = efectoDe(
                  clase,
                  todo(modo),
                  { forzarManual, soloSimulacion, soloSombra },
                  real,
                );
                if (e === EfectoAccion.APLICA) expect(modo).toBe(AiMode.AUTO);
                if (forzarManual || soloSombra) expect(e).not.toBe(EfectoAccion.APLICA);
              }
            }
          }
        }
      }
    }
  });
});

describe('insigniaAgente', () => {
  const AHORA = Date.parse('2026-09-24T12:00:00Z');
  const interruptores = (extra: Partial<InterruptoresAgentes> = {}): InterruptoresAgentes => ({
    encendido: true,
    modeloDisponible: true,
    modelo: 'anthropic/claude-sonnet-5',
    entradas: 'ABIERTAS',
    motivoEntradas: null,
    frenos: SIN_FRENOS,
    limiteAgente: 120,
    limiteGlobal: 600,
    llamadasGlobalesHoy: 0,
    ...extra,
  });
  const agente = (extra: Partial<EstadoInsigniaAgente> = {}): EstadoInsigniaAgente => ({
    estado: EstadoAgente.ACTIVO,
    dormidoHasta: null,
    modo: ModoDecision.IA,
    autonomia: AUTONOMIA_DE_FABRICA,
    real: true,
    ...extra,
  });

  it('todo en orden', () => {
    expect(insigniaAgente(interruptores(), agente(), AHORA)).toBe('ACTIVO');
  });

  it('de lo más grave a lo menos', () => {
    // Archivado y pausado mandan sobre el servidor: son del agente.
    const apagado = interruptores({ encendido: false });
    expect(insigniaAgente(apagado, agente({ estado: EstadoAgente.ARCHIVADO }), AHORA)).toBe(
      'ARCHIVADO',
    );
    expect(insigniaAgente(apagado, agente({ estado: EstadoAgente.PAUSADO }), AHORA)).toBe(
      'PAUSADO',
    );
    expect(insigniaAgente(apagado, agente(), AHORA)).toBe('APAGADO');
    for (const entradas of ['CERRADAS', 'DESCONOCIDO'] as const) {
      expect(insigniaAgente(interruptores({ entradas }), agente(), AHORA)).toBe('CORTADO');
    }
  });

  it('sin clave del modelo, solo sigue el modo reglas', () => {
    const sinModelo = interruptores({ modeloDisponible: false });
    expect(insigniaAgente(sinModelo, agente(), AHORA)).toBe('SIN_MODELO');
    expect(insigniaAgente(sinModelo, agente({ modo: ModoDecision.REGLAS }), AHORA)).toBe('REGLAS');
  });

  it('dormido por fallos hasta su hora, y en reglas no duerme', () => {
    const hasta = new Date(AHORA + 60_000).toISOString();
    expect(insigniaAgente(interruptores(), agente({ dormidoHasta: hasta }), AHORA)).toBe('DORMIDO');
    expect(insigniaAgente(interruptores(), agente({ dormidoHasta: hasta }), AHORA + 60_000)).toBe(
      'ACTIVO',
    );
    expect(
      insigniaAgente(
        interruptores(),
        agente({ dormidoHasta: hasta, modo: ModoDecision.REGLAS }),
        AHORA,
      ),
    ).toBe('REGLAS');
  });

  it('mide cuando no va a entrar: autonomía apagada, sombra o real con solo simulación', () => {
    const soloMedir = { ...AUTONOMIA_DE_FABRICA, entrar: AiMode.OFF };
    expect(insigniaAgente(interruptores(), agente({ autonomia: soloMedir }), AHORA)).toBe('MIDE');
    const sombra = interruptores({ frenos: { ...SIN_FRENOS, soloSombra: true } });
    expect(insigniaAgente(sombra, agente(), AHORA)).toBe('MIDE');
    const soloSim = interruptores({ frenos: { ...SIN_FRENOS, soloSimulacion: true } });
    expect(insigniaAgente(soloSim, agente(), AHORA)).toBe('MIDE');
    expect(insigniaAgente(soloSim, agente({ real: false }), AHORA)).toBe('ACTIVO');
  });
});

describe('los botones de Telegram', () => {
  it('un vale son 32 hexadecimales en minúscula', () => {
    expect(esValeAgente(VALE)).toBe(true);
    expect(esValeAgente(VALE.toUpperCase())).toBe(false);
    expect(esValeAgente(VALE.slice(1))).toBe(false);
    expect(esValeAgente(`${VALE}0`)).toBe(false);
    expect(esValeAgente(42)).toBe(false);
    expect(claveValeAgente(VALE)).toBe(`ag:vale:${VALE}`);
  });

  it('el callback más largo cabe en los 64 bytes de Telegram', () => {
    for (const verbo of Object.values(VerboAgente)) {
      const data = callbackAgente(VALE, verbo);
      // Solo ASCII: así cada carácter es un byte y la longitud es la que cuenta Telegram.
      expect(data).toMatch(/^[ -~]+$/);
      expect(data.length).toBeLessThanOrEqual(64);
    }
  });

  it('se lee lo que se escribe', () => {
    for (const verbo of Object.values(VerboAgente)) {
      expect(leerCallbackAgente(callbackAgente(VALE, verbo))).toEqual({ vale: VALE, verbo });
    }
  });

  it('los botones del Modo IA y del canal no son de agente', () => {
    expect(leerCallbackAgente(`ia:${VALE}:si`)).toBeNull();
    expect(leerCallbackAgente(`ic:${VALE}:pausa`)).toBeNull();
  });

  it('lo mal formado no es nada', () => {
    for (const malo of [
      null,
      42,
      '',
      'ag',
      `ag:${VALE}`,
      `ag:${VALE}:si:extra`,
      `ag:${VALE}:pausa`,
      `ag:${VALE.slice(2)}:si`,
      `AG:${VALE}:si`,
    ]) {
      expect(leerCallbackAgente(malo)).toBeNull();
    }
  });
});

describe('los eventos', () => {
  const todos = [...Object.values(EventoAgente), ...Object.values(EventoOperacionAgente)];

  it('todos empiezan por AGENT_, y ninguno despierta al Modo IA', () => {
    for (const tipo of [...todos, PULSACION_AGENTE]) {
      expect(tipo.startsWith('AGENT_')).toBe(true);
      expect(esEventoAgente(tipo)).toBe(true);
      expect(EVENTOS_MODO_IA).not.toContain(tipo);
    }
  });

  it('sin repetidos', () => {
    expect(new Set(todos).size).toBe(todos.length);
  });

  it('los del canal y del Modo IA no son de agente', () => {
    for (const tipo of ['AI_ENTRY', 'AI_EXIT', 'AI_SUGGESTION', 'SIN_STOP', 'CYCLE_CLOSED']) {
      expect(esEventoAgente(tipo)).toBe(false);
    }
  });
});

describe('los datos de un evento de agente', () => {
  it('se leen enteros', () => {
    const datos = {
      agentId: 'ag-1',
      propuestaId: 'p-1',
      accionId: 'a-1',
      vale: VALE,
      accion: AccionSeguimiento.CERRAR,
      severity: 'INFO',
      message: 'x',
    };
    expect(datosEventoAgente(datos)).toEqual({
      agentId: 'ag-1',
      propuestaId: 'p-1',
      accionId: 'a-1',
      vale: VALE,
      accion: AccionSeguimiento.CERRAR,
    });
  });

  it('sin agente no son de agente', () => {
    for (const malo of [null, 'ag-1', 42, {}, { agentId: '' }, { agentId: 7 }]) {
      expect(datosEventoAgente(malo)).toBeNull();
    }
  });

  it('lo opcional mal formado se deja fuera, y el aviso sigue siendo del agente', () => {
    // Un vale roto no pinta botones que no servirían; el aviso llega igual.
    expect(
      datosEventoAgente({
        agentId: 'ag-1',
        propuestaId: 3,
        accionId: '',
        vale: VALE.toUpperCase(),
        accion: 'VENDER_TODO',
      }),
    ).toEqual({ agentId: 'ag-1' });
  });
});

describe('el contrato', () => {
  it('cada objetivo del modelo es un esquema del motor, y al revés', () => {
    for (const o of Object.values(ObjetivoAgente)) {
      expect(OBJETIVO_DE_ESQUEMA[ESQUEMA_DE_OBJETIVO[o]]).toBe(o);
    }
  });

  it('una letra por puesto de la oferta, y ninguna se confunde con NINGUNA', () => {
    expect(LETRAS_OFERTA).toHaveLength(MAX_OFERTA_AGENTE);
    expect(new Set(LETRAS_OFERTA).size).toBe(LETRAS_OFERTA.length);
    expect(LETRAS_OFERTA).not.toContain(OPCION_NINGUNA);
  });

  it('la confianza solo reduce el tamaño, con la misma regla que el canal', () => {
    const e: EleccionAgente = {
      candidatoId: 'BTC|TENDENCIA|LONG|1',
      stop: TipoStop.NORMAL,
      objetivo: ObjetivoAgente.ESCALONADO,
      apalancamiento: BandaApalancamiento.BAJA,
      tamano: TamanoOperacion.COMPLETO,
      confianza: NivelConfianza.MEDIA,
    };
    expect(eleccionEfectiva(e)).toEqual({ ...e, tamano: TamanoOperacion.MEDIO });
    const alta = { ...e, confianza: NivelConfianza.ALTA };
    expect(eleccionEfectiva(alta)).toBe(alta);
  });

  it('en el seguimiento solo mantener no tiene clase; cerrar es su propia clase', () => {
    for (const accion of Object.values(AccionSeguimiento)) {
      const clase = CLASE_DE_ACCION[accion];
      if (accion === AccionSeguimiento.MANTENER) expect(clase).toBeNull();
      else if (accion === AccionSeguimiento.CERRAR) expect(clase).toBe(ClaseAccion.CERRAR);
      else expect(clase).toBe(ClaseAccion.REDUCIR);
    }
  });
});

describe('estados e intervalos', () => {
  it('una propuesta viva no es terminal, y todo estado es pendiente, vivo o terminal', () => {
    const vivas = new Set<string>(PROPUESTAS_VIVAS);
    for (const e of PROPUESTAS_TERMINALES) expect(vivas.has(e)).toBe(false);
    const clasificados = new Set<string>([
      EstadoPropuestaAgente.PROPUESTA,
      ...PROPUESTAS_VIVAS,
      ...PROPUESTAS_TERMINALES,
    ]);
    expect([...clasificados].sort()).toEqual(Object.values(EstadoPropuestaAgente).sort());
  });

  it('ejecutadas son las que tuvieron un bot en marcha, y ninguna está pendiente', () => {
    expect([...PROPUESTAS_EJECUTADAS].sort()).toEqual(
      [
        EstadoPropuestaAgente.ABIERTA,
        EstadoPropuestaAgente.CERRADA,
        EstadoPropuestaAgente.EJECUTANDO,
        EstadoPropuestaAgente.SIN_ENTRADA,
      ].sort(),
    );
    expect(PROPUESTAS_EJECUTADAS).not.toContain(EstadoPropuestaAgente.PROPUESTA);
    expect(PROPUESTAS_EJECUTADAS).not.toContain(EstadoPropuestaAgente.APROBANDO);
  });

  it('nunca un minuto (spec 070)', () => {
    expect(INTERVALOS_AGENTE).not.toContain('1m');
    expect(esIntervaloAgente('1h')).toBe(true);
    expect(esIntervaloAgente('1m')).toBe(false);
    expect(esIntervaloAgente(60)).toBe(false);
  });
});

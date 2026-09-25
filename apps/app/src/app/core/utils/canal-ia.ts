import {
  EventoCanal,
  insigniaCanal,
  type DecisionCanalVista,
  type EleccionOperacion,
  type EstadoPropioCanal,
  type InsigniaCanal,
  type InterruptoresCanal,
  type LazoCanal,
} from '@crypton/shared';
import { shortDate } from './format';

/**
 * El canal con IA, en piezas puras (spec 059).
 *
 * Lo que decide QUÉ se pinta —la pastilla, el texto de cada motivo y el resumen
 * de una decisión— vive aquí y no en las pantallas: lo usan las dos listas de
 * bots, el detalle y la consola, y cuatro copias de la misma regla son cuatro
 * sitios donde se desalinea. La regla de la pastilla es `insigniaCanal` de
 * `shared`, con sus tests; aquí solo se le pone texto.
 *
 * Todo lo que llega del servidor es texto de una columna que puede crecer antes
 * que la app: un valor que no está en los mapas se enseña tal cual.
 */

/** Los eventos que cambian lo que enseña el canal: los suyos y los fallos del modelo. */
const EVENTOS_CANAL: ReadonlySet<string> = new Set([...Object.values(EventoCanal), 'AI_FAILED']);

export const esEventoCanal = (tipo: string): boolean => EVENTOS_CANAL.has(tipo);

/** Un valor del vocabulario con su texto, o el valor tal cual. */
export const textoDe = (mapa: Readonly<Record<string, string>>, valor: string | null): string =>
  valor === null ? '' : (mapa[valor] ?? valor);

export const ESTADO_INTENCION: Readonly<Record<string, string>> = {
  SOLICITADA: 'pedida',
  CONSULTANDO: 'consultando',
  DECIDIDA: 'decidida',
  SIN_ENTRADA: 'sin entrada',
  FALLIDA: 'fallida',
  ACEPTADA: 'aceptada',
  ABIERTA: 'abierta',
  CERRADA: 'cerrada',
  RECHAZADA: 'descartada',
  CADUCADA: 'caducada',
};

/**
 * Por qué una intención acabó como acabó. Juntos los motivos de la consulta
 * (`MotivoConsulta`, los escribe la API) y los del motor (`MotivoRechazo`, los
 * escribe el worker): los dos van a la misma columna, y los que comparten nombre
 * dicen lo mismo.
 */
export const MOTIVO_INTENCION: Readonly<Record<string, string>> = {
  IA_APAGADA: 'la IA está apagada en el servidor',
  DUENO: 'el dueño ya no es administrador',
  ESTADO_BOT: 'el bot no estaba en marcha',
  PAUSA_FALLOS: 'consultas en pausa por fallos',
  INTERRUPTOR: 'entradas cortadas',
  REDIS: 'sin Redis no se consulta',
  CUPO_BOT: 'sin consultas hoy para este bot',
  CUPO_GLOBAL: 'sin consultas hoy en la plataforma',
  NO_OPERAR: 'la IA prefirió no operar',
  OFERTA: 'la elección no estaba en la oferta',
  CONFIANZA: 'menos confianza de la pedida',
  SOMBRA: 'modo sombra',
  MODELO: 'el modelo no respondió',
  CONTRATO: 'respuesta fuera del contrato',
  PLAZO: 'fuera de plazo',
  VENUE: 'el exchange no la aceptó',
  LIMITES: 'ya no cabía en los límites',
  HUELLA: 'el mercado había cambiado',
  PUERTA: 'una puerta del plan se cerró antes',
  ESTADO: 'un comando o un cambio la dejó sin sentido',
};

export const MOTIVO_CANAL: Readonly<Record<string, string>> = {
  CANAL_CLARO: 'canal claro',
  CANAL_JUSTO: 'canal justo',
  REGIMEN_RANGO: 'mercado en rango',
  REGIMEN_DUDOSO: 'régimen dudoso',
  CONFIRMACIONES_FUERTES: 'confirmaciones fuertes',
  CONFIRMACIONES_JUSTAS: 'confirmaciones justas',
  EVIDENCIA_FAVORABLE: 'histórico a favor',
  EVIDENCIA_ESCASA: 'poco histórico',
  EVIDENCIA_DESFAVORABLE: 'histórico en contra',
  RECOMPENSA_BUENA: 'buena recompensa',
  RECOMPENSA_POBRE: 'recompensa pobre',
  COSTE_ALTO: 'coste alto',
  DIA_TENSO: 'día tenso',
};

export const RIESGO_CANAL: Readonly<Record<string, string>> = {
  RUPTURA: 'ruptura',
  TENDENCIA_CERCANA: 'tendencia cerca',
  LIQUIDEZ: 'liquidez',
  VOLATILIDAD: 'volatilidad',
  RACHA: 'racha de pérdidas',
  TOPE_DIARIO_CERCA: 'tope diario cerca',
  FUNDING: 'funding',
};

export const REGIMEN: Readonly<Record<string, string>> = {
  RANGO: 'en rango',
  TENDENCIA: 'en tendencia',
  COMPRESION: 'comprimido',
  INDEFINIDO: 'indefinido',
};

export const SETUP: Readonly<Record<string, string>> = {
  REBOTE: 'rebote',
  FALSO_QUIEBRE: 'ruptura fallida',
};

export const TIPO_CANAL: Readonly<Record<string, string>> = {
  HORIZONTAL: 'horizontal',
  INCLINADO: 'inclinado',
  BANDA: 'de banda',
};

const STOP: Readonly<Record<string, string>> = {
  AJUSTADO: 'ajustado',
  NORMAL: 'normal',
  AMPLIO: 'amplio',
};

const OBJETIVO: Readonly<Record<string, string>> = {
  MEDIA: 'a la media',
  ESCALONADO: 'escalonado',
  OPUESTO: 'al borde opuesto',
};

const NIVEL: Readonly<Record<string, string>> = { BAJA: 'baja', MEDIA: 'media', ALTA: 'alta' };

/** «Opción X · stop normal · objetivo escalonado · …», o «No operar». */
export function textoEleccion(e: EleccionOperacion | null): string {
  if (!e) return '';
  if (e.veredicto === 'NO_OPERAR') return 'No operar';
  return [
    `opción ${e.opcion}`,
    `stop ${textoDe(STOP, e.stop)}`,
    `objetivo ${textoDe(OBJETIVO, e.objetivo)}`,
    `apalancamiento ${textoDe(NIVEL, e.apalancamiento)}`,
    `tamaño ${e.tamano === 'MEDIO' ? 'medio' : 'completo'}`,
    `confianza ${textoDe(NIVEL, e.confianza)}`,
  ].join(' · ');
}

/** Por qué no sirvió la respuesta del modelo (`FalloModelo` y el contrato). */
const FALLO_MODELO: Readonly<Record<string, string>> = {
  SIN_CLAVE: 'sin clave del modelo',
  HTTP: 'error del servicio del modelo',
  TIEMPO: 'tiempo agotado',
  NEGATIVA: 'el modelo se negó',
  TRUNCADA: 'respuesta cortada',
  RED: 'fallo de red',
  VACIA: 'respuesta vacía',
  CONTRATO: 'respuesta fuera del contrato',
};

/** «decidida · la IA prefirió no operar», con el fallo del modelo si lo hubo. */
export function textoEstado(d: Pick<DecisionCanalVista, 'estado' | 'motivo' | 'fallo'>): string {
  const partes = [textoDe(ESTADO_INTENCION, d.estado)];
  if (d.motivo) partes.push(textoDe(MOTIVO_INTENCION, d.motivo));
  // El contrato ya lo dice el motivo: no se repite.
  if (d.fallo && d.fallo !== d.motivo) partes.push(textoDe(FALLO_MODELO, d.fallo));
  return partes.join(' · ');
}

/** Los motivos y los riesgos que dio el modelo, ya en castellano. */
export function textoMotivos(d: DecisionCanalVista): { motivos: string; riesgos: string } {
  const r = d.respuesta;
  if (!r) return { motivos: '', riesgos: '' };
  return {
    motivos: r.motivos.map((m) => textoDe(MOTIVO_CANAL, m)).join(', '),
    riesgos: r.riesgos.map((m) => textoDe(RIESGO_CANAL, m)).join(', '),
  };
}

// ── La pastilla ────────────────────────────────────────────────────────────

export interface PastillaCanal {
  texto: string;
  /** Uniones literales: `strictTemplates` rechaza un `string` en `ui-badge`. */
  tone: 'brand' | 'neutral' | 'warn';
  variant: 'soft' | 'outline';
  activa: boolean;
  /** Por qué no consulta, para el `title` y los lectores; `null` si consulta. */
  porQue: string | null;
}

const TEXTO_INSIGNIA: Readonly<Record<InsigniaCanal, string>> = {
  CONSULTA: 'IA · canal',
  SOMBRA: 'IA · sombra',
  PAUSADA: 'IA · en pausa',
  APAGADA: 'IA · apagada',
  CORTADA: 'IA · sin entradas',
  REGLAS: 'Canal · reglas',
};

/**
 * La pastilla de un bot del canal. La insignia la decide `shared`; aquí se le
 * pone texto y se añade lo que la insignia no mira: que el bot esté en marcha.
 * Sale en gris y con contorno cuando la IA no está consultando, igual que la del
 * Modo IA: en un móvil el `title` no se ve.
 */
export function pastillaCanal(
  interruptores: InterruptoresCanal,
  lazo: LazoCanal,
  bot: { status: string },
  ahora = Date.now(),
  propio?: EstadoPropioCanal,
): PastillaCanal {
  const insignia = insigniaCanal(interruptores, lazo, ahora, propio);
  let porQue: string | null = null;
  switch (insignia) {
    case 'APAGADA':
      porQue = 'La IA del canal está apagada en el servidor: en modo IA no abre nada nuevo.';
      break;
    case 'CORTADA':
      porQue =
        propio?.entradas === false
          ? 'Este bot tiene las entradas apagadas en su configuración: no abrirá nada.'
          : interruptores.entradas === 'CERRADAS'
            ? 'Las entradas del canal están cortadas para todos los bots.'
            : 'No se puede leer el interruptor de entradas, y sin él no se abre nada.';
      break;
    case 'REGLAS':
      porQue = 'Modo reglas: decide el juez del motor, sin consultar a la IA.';
      break;
    case 'PAUSADA':
      porQue = `Consultas en pausa tras varios fallos seguidos del modelo, hasta el ${shortDate(lazo.pausadoHasta)}.`;
      break;
    case 'SOMBRA':
      porQue = 'Modo sombra: la IA decide y se registra, pero no se ejecuta nada.';
      break;
    case 'CONSULTA':
      if (bot.status !== 'RUNNING') porQue = 'La IA solo consulta con el bot en marcha.';
      break;
  }
  const activa = porQue === null;
  const aviso = insignia === 'PAUSADA' || insignia === 'CORTADA';
  return {
    texto: TEXTO_INSIGNIA[insignia],
    tone: activa ? 'brand' : aviso ? 'warn' : 'neutral',
    variant: activa ? 'soft' : 'outline',
    activa,
    porQue,
  };
}

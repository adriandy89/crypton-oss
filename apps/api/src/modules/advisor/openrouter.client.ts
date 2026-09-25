import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { D } from '@crypton/shared';
import { BANDS, PROFILES, type Band, type Knobs, type Profile } from './build';
import type { MarketFeatures } from './market-features';
import { knobsSchema, marketPrompt, systemPrompt } from './prompt';

/**
 * El unico fichero del proyecto que habla con un modelo de lenguaje.
 *
 * Se llama por el proveedor y no por el modelo a proposito: contra lo que se
 * habla es OpenRouter, y el modelo es una variable de entorno. Un fichero
 * llamado `claude.client.ts` que apunta a otro host es una mentira que se
 * descubre tarde.
 *
 * Todo lo que sale de aqui son PERILLAS: enumeraciones que un generador
 * determinista convierte en parametros. Nada de lo que devuelva este cliente
 * llega al usuario sin pasar antes por `validate()` y `preview()`.
 *
 * Degrada en silencio por diseño. Sin clave configurada, con el interruptor
 * apagado, con la API caida, con tiempo de espera agotado o con una respuesta
 * que no cumple el esquema, devuelve `null` y el servicio sirve los perfiles
 * deterministas. Una funcion de conveniencia no puede dejar sin crear bots a
 * nadie.
 *
 * Se usa `fetch` y no un SDK: el repo no tiene cliente HTTP y los adaptadores de
 * exchange ya hablan asi. Añadir una dependencia para una sola llamada POST es
 * peor negocio que las veinte lineas de abajo.
 */

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

/**
 * Tope de tokens de la respuesta.
 *
 * Holgado a proposito: con razonamiento, lo que el modelo piensa cuenta contra
 * este mismo tope. OpenRouter traduce el esfuerzo en un presupuesto de
 * razonamiento que es una parte de este numero —el 20 % con `low`, 1600 tokens;
 * el 50 % con `medium`, 4000; el 80 % con `high`, 6400— y exige que el tope sea
 * ESTRICTAMENTE mayor que ese presupuesto. La salida util son ~600 tokens, asi
 * que sobra sitio para las dos cosas.
 *
 * Ese presupuesto se piensa, se tarda en pensar y se cobra aunque `exclude`
 * lo oculte. Por eso el plazo de una llamada no se puede fijar sin mirar el
 * esfuerzo: ver `plazoRecomendadoMs` (spec 078).
 */
const MAX_TOKENS = 8_000;

/**
 * El plazo del asesor y del supervisor. Por debajo del interceptor global de
 * 80 s, dejando margen al plan B: el asesor responde dentro de una petición
 * HTTP, a alguien que está mirando la pantalla.
 */
const TIMEOUT_MS = 25_000;

/**
 * El tope de una DECISIÓN —el canal con IA y los agentes—, que no responde a
 * nadie que espere: corre aparte, una vez por vela (spec 078).
 *
 * Hasta el 078 compartían los 25 s del asesor, y con `medium` el modelo no
 * llegaba a terminar: cada ronda se cortaba a los 20 s de su plazo y se cobraba
 * entera igualmente, porque una petición sin streaming que se aborta sigue
 * generándose en el proveedor. Incidente del 2026-09-25, el primer agente real.
 */
export const TOPE_DECISION_MS = 120_000;

/** La parte de `max_tokens` que OpenRouter reserva al razonamiento, por esfuerzo. */
const PARTE_RAZONAMIENTO: Readonly<Record<EsfuerzoRazonamiento, number>> = {
  low: 0.2,
  medium: 0.5,
  high: 0.8,
};

/**
 * El plazo que se recomienda para cada esfuerzo, con el razonamiento entero
 * más la respuesta y la cola del proveedor. Es una recomendación para avisar,
 * no un tope: nada se corta por ella.
 */
const PLAZO_RECOMENDADO_MS: Readonly<Record<EsfuerzoRazonamiento, number>> = {
  low: 45_000,
  medium: 90_000,
  high: TOPE_DECISION_MS,
};

/** Los tokens que puede pensar el modelo antes de responder con este esfuerzo. */
export function presupuestoRazonamiento(esfuerzo: EsfuerzoRazonamiento): number {
  return Math.round(MAX_TOKENS * PARTE_RAZONAMIENTO[esfuerzo]);
}

export function plazoRecomendadoMs(esfuerzo: EsfuerzoRazonamiento): number {
  return PLAZO_RECOMENDADO_MS[esfuerzo];
}

/**
 * El aviso de arranque de una carga cuyo plazo no deja terminar al modelo, o
 * null. Con él, el incidente del 078 se habría visto en el log al desplegar en
 * vez de en la primera ronda.
 */
export function avisoPlazo(
  variable: string,
  plazoMs: number,
  esfuerzo: EsfuerzoRazonamiento,
): string | null {
  const recomendado = plazoRecomendadoMs(esfuerzo);
  if (plazoMs >= recomendado) return null;
  return (
    `${variable}=${plazoMs} con razonamiento ${esfuerzo}: el modelo puede pensar hasta ` +
    `${presupuestoRazonamiento(esfuerzo)} tokens antes de responder y el plazo se le queda ` +
    `corto. Cada llamada cortada se cobra entera. Se recomiendan al menos ${recomendado} ms.`
  );
}

interface RespuestaOpenRouter {
  choices?: {
    finish_reason?: string;
    message?: { content?: string | null; refusal?: string | null };
  }[];
  error?: { code?: number; message?: string };
  usage?: unknown;
}

/**
 * Lo que costó una llamada, tal y como lo cuenta OpenRouter (spec 059).
 *
 * Llega en todas las respuestas, sin pedirlo. `coste` es el de la llamada en
 * créditos, que se compran en dólares: se guarda en cadena decimal, como
 * cualquier importe.
 */
export interface UsoModelo {
  tokensEntrada: number;
  tokensSalida: number;
  tokensCacheLeidos: number;
  tokensCacheEscritos: number;
  tokensRazonamiento: number;
  coste: string | null;
}

/** Por qué no hubo respuesta utilizable. Es lo que se anota en el lazo del bot. */
export type FalloModelo =
  'SIN_CLAVE' | 'HTTP' | 'TIEMPO' | 'NEGATIVA' | 'TRUNCADA' | 'RED' | 'VACIA';

/** El resultado de una llamada: el texto, lo que costó y, si no sirve, por qué. */
export interface RespuestaModelo {
  contenido: string | null;
  uso: UsoModelo | null;
  fallo: FalloModelo | null;
}

/**
 * Lo que se pide cuando el modelo tiene que ELEGIR entre opciones que ya
 * calculó el motor: el canal con IA (spec 059) y los agentes (spec 074). El
 * mensaje de sistema es fijo, para la caché; la oferta cambia en cada llamada.
 */
export interface PeticionDecision {
  esquema: { name: string; schema: Record<string, unknown> };
  system: string;
  usuario: string;
  /** Lo que queda hasta el plazo de la decisión, ya recortado por quien llama. */
  limiteMs: number;
}

export interface RespuestaDecision extends RespuestaModelo {
  latenciaMs: number;
  modelo: string;
}

/** Los nombres con los que nacieron, en el canal (spec 059). */
export type PeticionCanal = PeticionDecision;
export type RespuestaCanal = RespuestaDecision;

/** Cómo se cachea el prompt de una decisión: una hora, cinco minutos o nada. */
export type CachePrompt = '1h' | '5m' | 'off';
export type EsfuerzoRazonamiento = 'low' | 'medium' | 'high';

const CACHES: readonly CachePrompt[] = ['1h', '5m', 'off'];
const ESFUERZOS: readonly EsfuerzoRazonamiento[] = ['low', 'medium', 'high'];

const entero = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.trunc(v) : 0;

/**
 * El uso de la respuesta, o null si no viene. Lo que no es un número finito y
 * positivo cuenta como cero: es una factura, no un dato con el que decidir.
 */
export function usoDe(bruto: unknown): UsoModelo | null {
  if (typeof bruto !== 'object' || bruto === null) return null;
  const u = bruto as {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    cost?: unknown;
    prompt_tokens_details?: { cached_tokens?: unknown; cache_write_tokens?: unknown } | null;
    completion_tokens_details?: { reasoning_tokens?: unknown } | null;
  };
  const coste =
    typeof u.cost === 'number' && Number.isFinite(u.cost) && u.cost >= 0
      ? D(u.cost.toString()).toFixed()
      : null;
  return {
    tokensEntrada: entero(u.prompt_tokens),
    tokensSalida: entero(u.completion_tokens),
    tokensCacheLeidos: entero(u.prompt_tokens_details?.cached_tokens),
    tokensCacheEscritos: entero(u.prompt_tokens_details?.cache_write_tokens),
    tokensRazonamiento: entero(u.completion_tokens_details?.reasoning_tokens),
    coste,
  };
}

/** El marcador de caché del mensaje de sistema, o nada. */
export function marcadorCache(cache: CachePrompt): { type: 'ephemeral'; ttl?: '1h' } | undefined {
  if (cache === 'off') return undefined;
  return cache === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' };
}

interface Pedido {
  cuerpo: Record<string, unknown>;
  /** Solo para los mensajes de log: qué llamada falló. */
  que: string;
  titulo: string;
  clave: string;
  limiteMs: number;
}

/**
 * Lo que distingue una carga de decisión de otra (spec 074): su interruptor
 * —hecho clave, que vale '' con él apagado—, su modelo, su esfuerzo, su caché
 * y su línea en la factura.
 */
interface CargaDecision {
  clave: string;
  modelo: string;
  esfuerzo: EsfuerzoRazonamiento;
  cache: CachePrompt;
  /** Lo más que se espera, pida lo que pida quien llama (spec 078). */
  topeMs: number;
  /** Solo para los mensajes de log. */
  que: string;
  titulo: string;
}

/**
 * El primer origen de `PUBLIC_APP_URL`, y solo si se puede mandar tal cual.
 *
 * Dos motivos, y ninguno es teorico:
 *
 *   - Esa variable es una LISTA separada por comas —asi la lee `main.ts` para el
 *     CORS—, de modo que mandarla entera pondria «http://a,http://b» de
 *     referente en el panel.
 *   - Un dominio internacionalizado sin convertir a punycode traeria caracteres
 *     por encima de 255, y eso hace que `fetch` lance antes de salir.
 */
function referenteValido(bruto: string): string {
  const primero = (bruto || '').split(',')[0]?.trim() ?? '';
  return primero && /^[ -~]+$/.test(primero) ? primero : 'https://example.invalid';
}

@Injectable()
export class OpenRouterClient {
  private readonly logger = new Logger(OpenRouterClient.name);
  private readonly apiKey: string;
  private readonly model: string;
  private readonly referer: string;
  /**
   * La clave del supervisor, con su propio interruptor (spec 046).
   *
   * Es la MISMA clave de OpenRouter —la cuenta es una— pero el interruptor es
   * otro, y eso es deliberado: el asesor responde a alguien que esta mirando la
   * pantalla y el supervisor gasta solo, en bucle, sin que nadie lo pida. Tienen
   * que poder encenderse y apagarse por separado.
   */
  private readonly agentKey: string;
  private readonly agentModel: string;
  /**
   * La IA del canal (spec 059), con su interruptor, su modelo y su caché. Es un
   * tercer trabajo: elegir entre operaciones ya calculadas para un bot con
   * dinero dentro, en bucle y con plazo.
   */
  private readonly channelKey: string;
  private readonly channelModel: string;
  private readonly channelEffort: EsfuerzoRazonamiento;
  private readonly channelCache: CachePrompt;
  /**
   * Los agentes de IA (spec 074), la cuarta carga. Eligen, como el canal, entre
   * operaciones ya calculadas, pero sobre varios pares a la vez y para
   * operaciones sueltas que abre y sigue un agente. Otro interruptor y otra
   * línea en la factura: uno se tiene que poder apagar sin tocar el otro.
   *
   * OJO con los nombres: `agentKey` y `agentModel` son del SUPERVISOR (el Modo
   * IA, spec 046), que se llamó «agente» antes de que estos existieran. Lo de
   * aquí se llama `desk`, como el módulo `ai-desk` y sus variables `AI_DESK_*`.
   */
  private readonly deskKey: string;
  private readonly deskModel: string;
  private readonly deskEffort: EsfuerzoRazonamiento;
  private readonly deskCache: CachePrompt;

  constructor(private readonly config: ConfigService) {
    // Se lee con `get` y NO con `requireSecret`: sin clave la API tiene que
    // arrancar igual. Tumbar el servidor entero por una ayuda del asistente
    // seria un intercambio pesimo.
    const apiKey = this.config.get<string>('OPENROUTER_API_KEY', '');
    const enabled = this.config.get<string>('AI_ADVISOR_ENABLE', 'false') === 'true';

    this.apiKey = enabled ? apiKey : '';
    this.model = this.config.get<string>('OPENROUTER_MODEL', 'anthropic/claude-sonnet-5');
    this.referer = referenteValido(this.config.get<string>('PUBLIC_APP_URL', ''));

    const agentEnabled = this.config.get<string>('AI_AGENT_ENABLE', 'false') === 'true';
    this.agentKey = agentEnabled ? apiKey : '';
    // SIN caida a `OPENROUTER_MODEL` si esta vacia, y a proposito: no son el
    // mismo trabajo. Clasificar un par de un solo disparo con quince
    // enumeraciones de salida no es lo mismo que juzgar un expediente con
    // historial, rendimiento y estado sobre un bot con dinero dentro. Se querra
    // poder subir uno sin subir el otro, y ver las dos lineas separadas en la
    // factura.
    this.agentModel = this.config.get<string>('AI_AGENT_MODEL', 'anthropic/claude-sonnet-5');

    if (agentEnabled && !apiKey) {
      this.logger.warn(
        'AI_AGENT_ENABLE está activo pero falta OPENROUTER_API_KEY: ' +
          'el Modo IA no podrá revisar ningún bot.',
      );
    }

    const channelEnabled = this.config.get<string>('AI_CHANNEL_ENABLE', 'false') === 'true';
    this.channelKey = channelEnabled ? apiKey : '';
    // Sin caída al modelo de los otros, por lo mismo que el supervisor.
    this.channelModel = this.config.get<string>('AI_CHANNEL_MODEL', 'anthropic/claude-sonnet-5');
    this.channelEffort = this.enLista(
      'AI_CHANNEL_REASONING',
      ESFUERZOS,
      'medium',
    ) as EsfuerzoRazonamiento;
    this.channelCache = this.enLista('AI_CHANNEL_PROMPT_CACHE', CACHES, '1h') as CachePrompt;
    if (channelEnabled && !apiKey) {
      this.logger.warn(
        'AI_CHANNEL_ENABLE está activo pero falta OPENROUTER_API_KEY: ' +
          'los bots del canal con IA no abrirán ninguna operación.',
      );
    }

    const deskEnabled = this.config.get<string>('AI_DESK_ENABLE', 'false') === 'true';
    this.deskKey = deskEnabled ? apiKey : '';
    // Sin caída al modelo de los otros tres, por lo mismo que el supervisor.
    this.deskModel = this.config.get<string>('AI_DESK_MODEL', 'anthropic/claude-sonnet-5');
    this.deskEffort = this.enLista(
      'AI_DESK_REASONING',
      ESFUERZOS,
      'medium',
    ) as EsfuerzoRazonamiento;
    this.deskCache = this.enLista('AI_DESK_PROMPT_CACHE', CACHES, '1h') as CachePrompt;
    if (deskEnabled && !apiKey) {
      this.logger.warn(
        'AI_DESK_ENABLE está activo pero falta OPENROUTER_API_KEY: ' +
          'los agentes en modo IA no propondrán nada; los de REGLAS, sí.',
      );
    }

    if (enabled && !apiKey) {
      this.logger.warn(
        'AI_ADVISOR_ENABLE está activo pero falta OPENROUTER_API_KEY: ' +
          'se servirán configuraciones calculadas por reglas.',
      );
    } else if (!enabled && apiKey) {
      // El caso simétrico, y el que más despista: quien pone la clave da por
      // hecho que con eso basta. Sin esta línea, el asistente se queda apagado y
      // NADA en el log lo explica — el interruptor está en otra variable.
      this.logger.warn(
        'Hay OPENROUTER_API_KEY pero AI_ADVISOR_ENABLE no está a «true»: ' +
          'el asistente sigue apagado y se servirán configuraciones por reglas.',
      );
    }
  }

  get available(): boolean {
    return this.apiKey !== '';
  }

  /** Si el SUPERVISOR puede llamar. Independiente de `available`, ver el constructor. */
  get agentAvailable(): boolean {
    return this.agentKey !== '';
  }

  /**
   * El modelo con el que decide el supervisor.
   *
   * Se expone para que quede EN LA FILA de cada decision: la columna existe para
   * poder comparar despues decisiones tomadas por modelos distintos, y eso tiene
   * que poder verse, no adivinarse (spec 047, F-03).
   */
  get agentModelId(): string {
    return this.agentModel;
  }

  /** Si la IA del canal puede llamar (spec 059). Independiente de los otros dos. */
  get canalDisponible(): boolean {
    return this.channelKey !== '';
  }

  /** El modelo del canal: va en cada intención, como el del supervisor. */
  get canalModelo(): string {
    return this.channelModel;
  }

  /**
   * Si los agentes de IA pueden llamar (spec 074). Independiente de los otros
   * tres, y NO es `agentAvailable`, que es el del supervisor.
   */
  get agentesDisponible(): boolean {
    return this.deskKey !== '';
  }

  /** El modelo de los agentes: va en cada ronda, como el del canal en su intención. */
  get agentesModelo(): string {
    return this.deskModel;
  }

  /** Con qué esfuerzo razonan los agentes: de él depende el plazo que necesitan (spec 078). */
  get agentesEsfuerzo(): EsfuerzoRazonamiento {
    return this.deskEffort;
  }

  /** Con qué esfuerzo razona el canal. */
  get canalEsfuerzo(): EsfuerzoRazonamiento {
    return this.channelEffort;
  }

  /**
   * Una variable que solo admite unos valores. Uno que no está en la lista no
   * se usa: se avisa y se queda el valor por defecto, que es lo prudente.
   */
  private enLista(nombre: string, lista: readonly string[], defecto: string): string {
    const valor = this.config.get<string>(nombre, defecto).trim();
    if (lista.includes(valor)) return valor;
    this.logger.warn(`${nombre}=${valor} no es válido (${lista.join(', ')}): se usa ${defecto}.`);
    return defecto;
  }

  /**
   * Pide tres combinaciones de perillas para este mercado.
   *
   * Devuelve `null` ante cualquier problema: quien llama ya tiene un plan B, y
   * es preferible a servir una recomendacion a medias.
   */
  async knobsFor(
    strategy: string,
    symbol: string,
    features: MarketFeatures,
  ): Promise<{ knobs: Knobs; rationale: string }[] | null> {
    if (!this.available) return null;
    const { contenido } = await this.pedir({
      cuerpo: this.body(strategy, symbol, features),
      que: 'recomendaciones',
      titulo: 'Crypton bot advisor',
      clave: this.apiKey,
      limiteMs: TIMEOUT_MS,
    });
    return contenido === null ? null : this.parse(contenido);
  }

  /**
   * Pide al modelo que revise un bot que YA esta operando (spec 046).
   *
   * Vive aqui y no en un cliente propio porque este sigue siendo, por diseño, el
   * unico fichero del proyecto que habla con un modelo de lenguaje. Lo que
   * cambia respecto del asesor es el modelo —`AI_AGENT_MODEL`, su propia
   * variable—, el interruptor y el esquema; el transporte, con sus doscientas
   * lineas de incidentes aprendidos, es el mismo.
   *
   * Devuelve el JSON en crudo: la forma la valida `parseRevision`, que es quien
   * conoce el contrato. Aqui solo se sabe de HTTP.
   */
  async revisar(
    esquema: { name: string; schema: Record<string, unknown> },
    system: string,
    usuario: string,
  ): Promise<string | null> {
    if (!this.agentAvailable) return null;
    const { contenido } = await this.pedir({
      cuerpo: {
        model: this.agentModel,
        max_tokens: MAX_TOKENS,
        // Mas esfuerzo que en el asesor, y a proposito: alli se eligen tres
        // ternas de enumeraciones sobre unos rasgos de mercado; aqui se juzga un
        // expediente con historial, rendimiento y estado, y la decision de
        // MANTENER o no vale lo que vale.
        reasoning: { effort: 'medium', exclude: true },
        response_format: {
          type: 'json_schema',
          json_schema: { name: esquema.name, strict: true, schema: esquema.schema },
        },
        provider: { require_parameters: true },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: usuario },
        ],
      },
      que: 'revision',
      titulo: 'Crypton bot supervisor',
      clave: this.agentKey,
      limiteMs: TIMEOUT_MS,
    });
    return contenido;
  }

  /**
   * Pide al modelo que elija entre las operaciones que calculó el worker para
   * un bot del canal con IA (spec 059).
   *
   * Vive aquí por la misma razón que la revisión: este sigue siendo el único
   * fichero que habla con un modelo. A diferencia de los otros dos, devuelve
   * también lo que costó la llamada y por qué falló, si falló: el lazo del bot
   * lo anota y lo enseña, y un fallo cuenta para dormir las consultas.
   *
   * El mensaje de sistema es fijo y va marcado para la caché del proveedor; la
   * oferta, que cambia en cada llamada, va detrás, en el del usuario.
   */
  async decidirCanal(p: PeticionCanal): Promise<RespuestaCanal> {
    return this.decidir(
      {
        clave: this.channelKey,
        modelo: this.channelModel,
        esfuerzo: this.channelEffort,
        cache: this.channelCache,
        topeMs: TOPE_DECISION_MS,
        que: 'decision del canal',
        titulo: 'Crypton AI channel',
      },
      p,
    );
  }

  /**
   * Pide al modelo que elija, en una ronda de un agente, entre las operaciones
   * que calculó el motor para sus pares, o que diga qué hacer con una que ya
   * está abierta (spec 074).
   *
   * La misma petición que la del canal con otra carga: su interruptor, su
   * modelo, su esfuerzo, su caché y su título en el panel de OpenRouter.
   */
  async decidirAgente(p: PeticionDecision): Promise<RespuestaDecision> {
    return this.decidir(
      {
        clave: this.deskKey,
        modelo: this.deskModel,
        esfuerzo: this.deskEffort,
        cache: this.deskCache,
        topeMs: TOPE_DECISION_MS,
        que: 'decision de un agente',
        titulo: 'Crypton AI desk',
      },
      p,
    );
  }

  /**
   * Una decisión entre opciones ya calculadas, por la carga que la pide.
   *
   * Sacada del cuerpo de `decidirCanal` al llegar los agentes (spec 074): lo
   * que cambia de una a otra es la carga, y dos copias de este cuerpo acabarían
   * distintas en lo que no se mira.
   */
  private async decidir(carga: CargaDecision, p: PeticionDecision): Promise<RespuestaDecision> {
    const inicio = Date.now();
    if (carga.clave === '') {
      return {
        contenido: null,
        uso: null,
        fallo: 'SIN_CLAVE',
        latenciaMs: 0,
        modelo: carga.modelo,
      };
    }
    const cache = marcadorCache(carga.cache);
    const r = await this.pedir({
      cuerpo: {
        model: carga.modelo,
        max_tokens: MAX_TOKENS,
        reasoning: { effort: carga.esfuerzo, exclude: true },
        response_format: {
          type: 'json_schema',
          json_schema: { name: p.esquema.name, strict: true, schema: p.esquema.schema },
        },
        provider: { require_parameters: true },
        messages: [
          {
            role: 'system',
            content: [{ type: 'text', text: p.system, ...(cache ? { cache_control: cache } : {}) }],
          },
          { role: 'user', content: p.usuario },
        ],
      },
      que: carga.que,
      titulo: carga.titulo,
      clave: carga.clave,
      limiteMs: Math.min(p.limiteMs, carga.topeMs),
    });
    return { ...r, latenciaMs: Date.now() - inicio, modelo: carga.modelo };
  }

  /**
   * El transporte: una peticion, dos intentos y un solo presupuesto de tiempo.
   *
   * Extraido del cuerpo de `knobsFor` al añadir la revision (spec 046). Todo lo
   * que hay aqui es conocimiento pagado con averias —el reintento solo de lo que
   * puede salir bien, el cuerpo que hay que cancelar a mano, los errores que
   * llegan con HTTP 200, la negativa en su propio campo, el truncado por
   * `max_tokens`, el `TypeError` que no es un fallo de red— y duplicarlo para el
   * supervisor habria sido perderlo a la mitad.
   *
   * La clave y el plazo van en cada pedido (spec 059): las cabeceras usaban
   * siempre la del asesor, y con el asesor apagado el supervisor mandaba una
   * clave vacía.
   *
   * Nunca lanza. Devuelve el contenido, el uso —si hubo respuesta, porque una
   * negativa o un truncado también se facturan— y el motivo del fallo.
   */
  private async pedir(p: Pedido): Promise<RespuestaModelo> {
    const { que } = p;
    try {
      const json = JSON.stringify(p.cuerpo);

      // Un solo presupuesto de tiempo para los dos intentos: dos esperas
      // completas de 25 s se comerian el interceptor global de 80 s entre esto y
      // las dos series de velas que ya se han pedido antes de llegar aqui.
      const limite = Date.now() + p.limiteMs;
      let res: Response | null = null;

      for (let intento = 1; intento <= 2; intento++) {
        const restante = limite - Date.now();
        // Menos de un segundo no da para nada: mejor rendirse que mandar una
        // peticion condenada a abortarse a medio camino.
        if (restante < 1_000) break;

        const r = await fetch(OPENROUTER_URL, {
          method: 'POST',
          headers: this.headers(p.titulo, p.clave),
          body: json,
          signal: AbortSignal.timeout(restante),
        });

        // Se reintenta SOLO lo que puede salir bien a la segunda. Un 401 o un
        // 402 van a fallar igual y reintentarlos solo gasta el presupuesto.
        //
        // El reintento no es un lujo: el uso de cupo ya esta apuntado antes de
        // llegar aqui, asi que un 502 pasajero le costaria al usuario uno de sus
        // veinte usos del dia a cambio de nada.
        const reintentable = !r.ok && (r.status >= 500 || r.status === 429);
        // `res` se queda con la ULTIMA respuesta que llegó, pase lo que pase.
        // Si el primer intento diera 5xx y ya no quedara tiempo para el segundo,
        // descartarla dejaria el fallo sin registrar en ninguna parte.
        const hayTiempo = limite - Date.now() >= 1_000;
        if (!reintentable || intento === 2 || !hayTiempo) {
          res = r;
          break;
        }
        // El cuerpo se descarta a mano: sin leerlo ni cancelarlo, la conexion
        // queda ocupada hasta que pase el recolector.
        await r.body?.cancel().catch(() => undefined);
      }

      const sinRespuesta = (fallo: FalloModelo, uso: UsoModelo | null = null): RespuestaModelo => ({
        contenido: null,
        uso,
        fallo,
      });

      // Sin ningún intento: el plazo no daba ni para empezar.
      if (!res) return sinRespuesta('TIEMPO');
      if (!res.ok) {
        await this.reportarFallo(res, que);
        return sinRespuesta('HTTP');
      }

      const datos = (await res.json()) as RespuestaOpenRouter;
      const uso = usoDe(datos.usage);

      // OpenRouter devuelve algunos errores con HTTP 200 y el fallo en el
      // cuerpo: hay que mirarlo antes de leer `choices`.
      if (datos.error) {
        this.logger.debug(
          `El modelo no respondió a ${que} (${datos.error.code ?? '?'}): ` +
            `${datos.error.message ?? ''}`,
        );
        return sinRespuesta('HTTP', uso);
      }

      const eleccion = datos.choices?.[0];
      if (!eleccion) return sinRespuesta('VACIA', uso);

      // Una negativa por seguridad tambien llega con 200, en su propio campo.
      if (eleccion.message?.refusal) {
        this.logger.warn(`El modelo declinó la petición de ${que}.`);
        return sinRespuesta('NEGATIVA', uso);
      }
      // Truncado: el JSON estara a medias y el parser fallaria igual, pero en
      // silencio. Se registra como aviso porque significa que el tope se ha
      // quedado corto, y eso hay que verlo en el log, no deducirlo de que las
      // respuestas «nunca sirven».
      if (eleccion.finish_reason === 'length') {
        this.logger.warn(
          `La respuesta del modelo a ${que} se truncó por max_tokens. ` +
            'Si se repite, hay que subir MAX_TOKENS.',
        );
        return sinRespuesta('TRUNCADA', uso);
      }

      const contenido = eleccion.message?.content ?? '';
      return { contenido, uso, fallo: contenido === '' ? 'VACIA' : null };
    } catch (e) {
      // El tiempo de espera agotado llega como `TimeoutError` desde
      // `AbortSignal.timeout`. Se registra aparte porque significa otra cosa que
      // un fallo de red: el modelo estaba pensando de mas.
      const nombre = (e as Error)?.name;
      if (nombre === 'TimeoutError' || nombre === 'AbortError') {
        this.logger.debug(`El modelo tardó más de ${p.limiteMs} ms en ${que}.`);
        return { contenido: null, uso: null, fallo: 'TIEMPO' };
      }
      if (e instanceof TypeError) {
        // Un TypeError aqui NO es un problema de red: es una peticion mal
        // construida por nosotros —una cabecera con un carácter ilegal, un
        // cuerpo que no se puede serializar— y `fetch` la rechaza antes de
        // abrir el socket. Va como error y no como depuracion porque si no,
        // un fallo permanente nuestro se disfraza de caida ajena pasajera.
        this.logger.error(`Petición a OpenRouter mal formada, no llegó a salir: ${e.message}`);
      } else {
        this.logger.debug(`Fallo al pedir ${que}: ${String(e)}`);
      }
      return { contenido: null, uso: null, fallo: 'RED' };
    }
  }

  /**
   * Las cabeceras.
   *
   * Estan en su propio metodo por una razon concreta: los valores de cabecera
   * HTTP son ByteString, y `fetch` LANZA ante un solo caracter por encima de
   * 255. Un guion largo en el titulo —lo natural al escribirlo en español— hacia
   * que la peticion no llegara a salir NUNCA. Y como el fallo aparecia en el
   * catch general, se registraba como un problema de red cualquiera y la funcion
   * servia reglas para siempre mientras el cupo se seguia gastando.
   *
   * Todo lo que salga de aqui va en ASCII, y hay un test que lo comprueba.
   *
   * La clave es la de la llamada: cada carga tiene su interruptor, y con el
   * asesor apagado su clave vale '' (spec 059).
   */
  private headers(titulo: string, clave: string): Record<string, string> {
    return {
      Authorization: `Bearer ${clave}`,
      'Content-Type': 'application/json',
      // Identifican la llamada en el panel de OpenRouter. Sin ellas todo el
      // gasto aparece como «desconocido», que es justo lo que no quieres cuando
      // hay que averiguar quien se esta comiendo el saldo.
      'HTTP-Referer': this.referer,
      // Distingue las cargas en el panel de OpenRouter. Es la forma barata de
      // ver por separado lo que gasta el asesor, el supervisor, el canal y los
      // agentes sin abrir una segunda cuenta.
      'X-Title': titulo,
    };
  }

  /**
   * El cuerpo de la peticion.
   *
   * Sin `temperature` ni `top_p`. `temperature` SI la admite este modelo —lo
   * dice su ficha en OpenRouter—, asi que no mandarla es una decision: la salida
   * ya viene acotada por el esquema a quince enumeraciones, de modo que bajar la
   * temperatura no puede hacerla mas correcta y subirla solo cambiaria cual de
   * las combinaciones validas sale. `top_p` directamente no figura entre los
   * parametros admitidos, y mandarlo solo serviria para que se ignore.
   */
  private body(
    strategy: string,
    symbol: string,
    features: MarketFeatures,
  ): Record<string, unknown> {
    return {
      model: this.model,
      max_tokens: MAX_TOKENS,
      // Elegir tres ternas de enumeraciones no da para mas: subir el esfuerzo
      // aqui es pagar tokens de razonamiento por una decision que ya viene
      // acotada por el esquema.
      reasoning: { effort: 'low', exclude: true },
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'perillas',
          strict: true,
          schema: knobsSchema(),
        },
      },
      // NO es una precaucion de manual: este modelo se sirve desde varios
      // proveedores y algunos NO soportan salidas estructuradas. Sin esto, una
      // parte de las peticiones acabaria en uno que IGNORA el esquema — el
      // modelo devolveria texto libre, `parse()` fallaria y la funcion caeria a
      // las reglas de forma intermitente y sin motivo aparente, que es de los
      // fallos mas caros de diagnosticar.
      provider: { require_parameters: true },
      // SIN marcador de cache de prompt, y medido antes de quitarlo: el bloque
      // estable son ~530 tokens y el minimo cacheable de Sonnet son 1024. Un
      // `cache_control` aqui no se activaria NUNCA — seria un adorno que aparenta
      // una optimizacion que no existe. Quien ahorra de verdad las llamadas es el
      // cache de perillas del servicio, que se salta la peticion entera.
      messages: [
        { role: 'system', content: systemPrompt() },
        { role: 'user', content: marketPrompt(strategy, symbol, features) },
      ],
    };
  }

  /**
   * Registra un fallo HTTP con el nivel que le corresponde.
   *
   * La distincion importa: 401 y 402 son problema del OPERADOR y hay que verlos
   * en el log de errores; los demas son ruido pasajero que el plan B ya cubre.
   * Sin separarlos, un saldo agotado se confunde con una caida de OpenRouter y
   * se busca donde no es.
   */
  private async reportarFallo(res: Response, que: string): Promise<void> {
    const cuerpo = await res.text().catch(() => '');
    if (res.status === 401) {
      this.logger.error('La clave de OpenRouter no es válida.');
    } else if (res.status === 402) {
      this.logger.error(
        'OpenRouter rechaza la llamada por saldo insuficiente: recarga la cuenta. Mientras, ' +
          'el asistente usa reglas y ni el Modo IA, ni el canal con IA, ni los agentes en ' +
          'modo IA deciden nada.',
      );
    } else if (res.status === 429) {
      this.logger.warn(`OpenRouter está limitando el ritmo (${que}).`);
    } else {
      this.logger.debug(`El modelo no respondió a ${que} (${res.status}): ${cuerpo.slice(0, 300)}`);
    }
  }

  /**
   * Valida la forma de la respuesta.
   *
   * Las perillas NO se reparan: si no cumplen el esquema, la respuesta entera no
   * es de fiar y se cae al plan B. Reparar aqui seria adivinar que quiso decir
   * un modelo que ya se ha salido del contrato.
   *
   * Se valida aunque el modo estricto prometa que no hace falta: la promesa la
   * cumple el proveedor, y el proveedor lo elige el enrutador.
   */
  private parse(raw: string): { knobs: Knobs; rationale: string }[] | null {
    let datos: unknown;
    try {
      datos = JSON.parse(raw);
    } catch {
      return null;
    }

    const propuestas = (datos as { propuestas?: unknown[] })?.propuestas;
    if (!Array.isArray(propuestas) || propuestas.length !== 3) return null;

    const esBanda = (v: unknown): v is Band => BANDS.includes(v as Band);
    const salida: { knobs: Knobs; rationale: string }[] = [];
    const perfilesVistos = new Set<Profile>();

    for (const p of propuestas) {
      const o = p as Record<string, unknown>;
      const profile = o['profile'] as Profile;
      if (!PROFILES.includes(profile) || perfilesVistos.has(profile)) return null;
      perfilesVistos.add(profile);

      if (
        !esBanda(o['leverage']) ||
        !esBanda(o['coverage']) ||
        !esBanda(o['spread']) ||
        !esBanda(o['sizeGrowth']) ||
        !esBanda(o['cadence'])
      ) {
        return null;
      }

      salida.push({
        knobs: {
          profile,
          leverage: o['leverage'],
          coverage: o['coverage'],
          spread: o['spread'],
          sizeGrowth: o['sizeGrowth'],
          cadence: o['cadence'],
        },
        // Lo unico del modelo que se pinta TAL CUAL en la interfaz, asi que se
        // trata como lo que es: texto ajeno.
        //
        // Se exige que SEA una cadena en vez de convertirla. `String()` sobre un
        // objeto da «[object Object]», y eso acabaria de explicacion en una
        // tarjeta. Y se recorta aqui sin fiarse del modelo: el limite de
        // longitud es una descripcion del esquema, no algo que la API imponga.
        rationale: typeof o['rationale'] === 'string' ? o['rationale'].slice(0, 240) : '',
      });
    }

    return salida;
  }
}

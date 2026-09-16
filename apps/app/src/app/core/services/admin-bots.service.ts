import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../../environments/environment';
import type { BotStatus, Paginated, StrategyKind, Venue } from '../models';

/**
 * Los UNICOS comandos que un administrador puede mandar sobre un bot ajeno.
 *
 * Contencion, no destruccion: ninguno de los dos toca la posicion y ninguno
 * retira el stop-loss nativo del venue. `CANCEL_ALL_ORDERS` no esta —y no es un
 * olvido— porque cancela tambien ese stop, y sobre una posicion apalancada la
 * dejaria desnuda: la unica «contencion» capaz de dejar a alguien peor protegido
 * que antes.
 *
 * Esta lista es COMODIDAD para pintar botones. La que manda es el `@IsIn` del
 * DTO del servidor: un cliente que se restringe a si mismo no restringe nada.
 */
export const ADMIN_BOT_COMMANDS = ['PAUSE', 'STOP_KEEP_POSITION'] as const;
export type AdminBotCommand = (typeof ADMIN_BOT_COMMANDS)[number];

export const ETIQUETA_COMANDO: Record<AdminBotCommand, string> = {
  PAUSE: 'Pausar (mantiene la posición)',
  STOP_KEEP_POSITION: 'Parar conservando la posición',
};

/** Que hace el supervisor de IA con un bot. */
export const AI_MODES = ['OFF', 'MANUAL', 'AUTO'] as const;
export type AiMode = (typeof AI_MODES)[number];

export const ETIQUETA_MODO_IA: Record<AiMode, string> = {
  OFF: 'Apagado',
  MANUAL: 'Propone y espera',
  AUTO: 'Decide y aplica',
};

export const AYUDA_MODO_IA: Record<AiMode, string> = {
  OFF: 'El bot funciona con la configuración que tú le pusiste. Nadie la toca.',
  MANUAL: 'Te manda las sugerencias por Telegram con dos botones. No cambia nada hasta que pulses.',
  AUTO: 'Aplica los ajustes y te avisa después. Nunca toca el capital, el par ni la posición.',
};

/**
 * El texto de la pastilla de un bot con el Modo IA encendido (spec 053).
 *
 * Corto a proposito: vive en la linea de la tarjeta junto a «simulación» y
 * «testnet», y los mismos verbos que las etiquetas largas para que se
 * reconozcan. Apagado no tiene: sin modo, sin pastilla.
 */
export const ETIQUETA_CORTA_MODO_IA: Record<Exclude<AiMode, 'OFF'>, string> = {
  MANUAL: 'IA · propone',
  AUTO: 'IA · aplica',
};

/**
 * Cuándo revisa el supervisor. Calcado de `AI_TRIGGERS` del servidor, con el
 * valor de fabrica primero.
 */
export const AI_TRIGGERS = ['AMBOS', 'PERIODICO', 'OPERACION'] as const;
export type AiTrigger = (typeof AI_TRIGGERS)[number];

export const ETIQUETA_DISPARO: Record<AiTrigger, string> = {
  AMBOS: 'Reloj y eventos',
  PERIODICO: 'Solo reloj',
  OPERACION: 'Solo eventos',
};

export const AYUDA_DISPARO: Record<AiTrigger, string> = {
  AMBOS: 'Cada cierto tiempo, y además al cerrar un ciclo o ante un aviso de riesgo.',
  PERIODICO:
    'Solo cada cierto tiempo: un ciclo cerrado o un aviso de riesgo no adelantan la revisión.',
  OPERACION: 'Solo al cerrar un ciclo o ante un aviso de riesgo, nunca por reloj.',
};

/** Por qué no le llegarían las sugerencias del Modo IA a su dueño (spec 055). */
export type SinCanalIa = 'SIN_TELEGRAM' | 'AVISOS_IA_APAGADOS';

/**
 * Lo que los interruptores del servidor dejan hacer hoy (spec 053).
 *
 * Sin esto la app enseñaria «decide y aplica» sobre un bot al que el
 * supervisor no va a mirar.
 */
export interface AiSwitches {
  /** El interruptor global Y la clave del modelo. */
  encendido: boolean;
  /** El automatico se degrada a «propone y espera». */
  forzarManual: boolean;
  /** Solo actua sobre bots simulados. */
  soloSimulados: boolean;
  /**
   * Si al administrador que pregunta le llegarían las sugerencias, o por qué no
   * (spec 055, 053/H-03). Sin canal, el supervisor no revisa sus bots en
   * «propone y espera». Opcional: una API anterior no lo manda.
   */
  sinCanal?: SinCanalIa | null;
}

export interface AiSetting {
  bot_id: string;
  mode: AiMode;
  /** `VarChar` en el servidor: el vocabulario puede crecer antes que la app. */
  trigger?: string;
  /** `null` = el intervalo que recomienda la estrategia. */
  review_every_minutes?: number | null;
  allow_warm?: boolean;
  last_review_at?: string | null;
  last_apply_at?: string | null;
  failures?: number;
  paused_until?: string | null;
  last_error?: string | null;
  /**
   * Si la estrategia entra en el alcance del Modo IA. Ausente con un servidor
   * anterior al spec 053: se trata como desconocido, y decide el servidor.
   */
  cubierta?: boolean;
  /** Solo en la lectura de un bot. */
  interruptores?: AiSwitches;
}

/** `GET /admin/ai`: el Modo IA de los bots propios encendidos (spec 053). */
export interface AiOverview {
  interruptores: AiSwitches;
  /** Las estrategias que cubre el Modo IA. */
  estrategias: string[];
  bots: AiSetting[];
}

export interface SetAiMode {
  mode: AiMode;
  trigger?: AiTrigger;
  /** `null` vuelve al intervalo de la estrategia. */
  reviewEveryMinutes?: number | null;
  allowWarm?: boolean;
  reason: string;
}

export interface AdminBotRow {
  id: string;
  name: string;
  owner: { id: string; email: string; name: string; disabled: boolean };
  venue: Venue;
  symbol: string;
  strategy: StrategyKind;
  status: BotStatus;
  direction: 'LONG' | 'SHORT' | 'NEUTRAL';
  leverage: number;
  marginMode: 'CROSS' | 'ISOLATED';
  dryRun: boolean;
  paper: boolean;
  testnet: boolean;
  /** Dinero: cadena, siempre. La app no suma importes, los pide ya sumados. */
  totalInvestment: string;
  lastError: string | null;
  startedAt: string | null;
  lastTickAt: string | null;
  createdAt: string;
  updatedAt: string | null;
}

export interface AdminBotsFilters {
  userId?: string;
  email?: string;
  venue?: Venue;
  symbol?: string;
  strategy?: StrategyKind;
  status?: BotStatus;
  dryRun?: boolean;
  withError?: boolean;
}

/**
 * El detalle de un bot ajeno.
 *
 * Es lo que devuelve `BotsService.detail()` —el mismo objeto que ve su dueño—
 * mas quien es ese dueño. Se escribe suelto y no se reutiliza el tipo del
 * detalle propio porque esta pantalla solo lee un puñado de campos y atarla al
 * contrato completo la obligaria a seguir cada cambio de aquel.
 */
export interface AdminBotDetail extends AdminBotRow {
  currentCapital?: string | null;
  realizedPnl?: string;
  unrealizedPnl?: string;
  roiPct?: string;
  positionQty?: string | null;
  marginUsed?: string | null;
  liquidationPrice?: string | null;
  liquidationDistancePct?: string | null;
  openOrders?: number;
  note?: string | null;
  configVersion?: number;
  config?: Record<string, unknown>;
}

/**
 * Todos los bots de la plataforma, solo para ADMIN (spec 033).
 *
 * Mirar y contener. No hay aqui nada que cree, edite ni borre un bot ajeno: esa
 * superficie no existe en el servidor tampoco.
 */
@Injectable({ providedIn: 'root' })
export class AdminBotsService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/admin/bots`;

  list(filters: AdminBotsFilters, page = 1, limit = 30): Promise<Paginated<AdminBotRow>> {
    const params: Record<string, string> = { page: String(page), limit: String(limit) };
    if (filters.userId) params['userId'] = filters.userId;
    if (filters.email) params['email'] = filters.email;
    if (filters.venue) params['venue'] = filters.venue;
    if (filters.symbol) params['symbol'] = filters.symbol;
    if (filters.strategy) params['strategy'] = filters.strategy;
    if (filters.status) params['status'] = filters.status;
    if (filters.dryRun !== undefined) params['dryRun'] = String(filters.dryRun);
    if (filters.withError) params['withError'] = 'true';
    return firstValueFrom(this.http.get<Paginated<AdminBotRow>>(this.base, { params }));
  }

  detail(id: string): Promise<AdminBotDetail> {
    return firstValueFrom(this.http.get<AdminBotDetail>(`${this.base}/${id}`));
  }

  /** El motivo es obligatorio: sin el, el servidor devuelve 400. */
  command(
    id: string,
    command: AdminBotCommand,
    reason: string,
  ): Promise<{ accepted: boolean; command: string }> {
    return firstValueFrom(
      this.http.post<{ accepted: boolean; command: string }>(`${this.base}/${id}/commands`, {
        command,
        reason,
      }),
    );
  }

  /**
   * El Modo IA de un bot PROPIO (spec 046).
   *
   * Solo funciona sobre bots del propio administrador: sobre uno ajeno el
   * servidor responde 403. Y eso no es una limitacion de esta pantalla, es la
   * regla de la consola —mirar y contener, nunca disponer del dinero de nadie—:
   * un agente que reescribe la configuracion de un bot de otro se la saltaria.
   */
  aiMode(id: string): Promise<AiSetting> {
    return firstValueFrom(this.http.get<AiSetting>(`${this.base}/${id}/ai`));
  }

  /** El motivo es obligatorio, como en los comandos y por lo mismo. */
  setAiMode(id: string, dto: SetAiMode): Promise<AiSetting> {
    return firstValueFrom(this.http.put<AiSetting>(`${this.base}/${id}/ai`, dto));
  }

  /**
   * El Modo IA de los bots PROPIOS encendidos, los interruptores del servidor y
   * las estrategias que cubre (spec 053). Una sola peticion para toda la lista:
   * una por tarjeta serian veinte.
   *
   * Cuelga de `admin/ai` y no de `admin/bots/ai`: ahi la ruta del detalle de un
   * bot se la quedaria.
   */
  aiOverview(): Promise<AiOverview> {
    return firstValueFrom(this.http.get<AiOverview>(`${environment.apiUrl}/admin/ai`));
  }
}

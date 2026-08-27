import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumberString,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { BotStatus, StrategyKind, Venue } from '@crypton/db';

/**
 * La configuración específica de cada estrategia viaja como objeto libre y la
 * valida `strategy-core`, que es quien conoce sus campos. Duplicar aquí un DTO
 * por estrategia significaría mantener la misma verdad en dos sitios y que se
 * desincronicen a la primera.
 */
export class PreviewBotDto {
  @IsEnum(Venue)
  venue: Venue;

  @IsString()
  @IsNotEmpty()
  symbol: string;

  @IsEnum(StrategyKind)
  strategy: StrategyKind;

  @IsObject()
  config: Record<string, unknown>;

  /** Precio de referencia. Si falta, se toma el del mercado. */
  @IsOptional()
  @IsString()
  refPrice?: string;

  /**
   * Red del venue. Ausente = mainnet.
   *
   * Aqui SI lo decide el cliente, y puede porque el preview no manda nada al
   * venue: solo pinta una escalera. Al crear el bot la red ya no se pregunta,
   * sale de la cuenta elegida.
   */
  @IsOptional()
  @IsBoolean()
  testnet?: boolean;
}

export class CreateBotDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  name: string;

  @IsUUID()
  exchangeAccountId: string;

  @IsString()
  @IsNotEmpty()
  symbol: string;

  @IsEnum(StrategyKind)
  strategy: StrategyKind;

  @IsObject()
  config: Record<string, unknown>;

  /** true = arranca en cuanto se crea. */
  @IsOptional()
  @IsBoolean()
  startActive?: boolean;

  /**
   * Simulación. Se fija al crear y no se puede cambiar: mezclar operaciones
   * simuladas y reales en el mismo bot dejaría su histórico de PnL sin sentido.
   */
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;
}

export class UpdateBotConfigDto {
  @IsObject()
  config: Record<string, unknown>;

  /**
   * Confirmación explícita para cambios WARM, que cancelan y vuelven a tender
   * la escalera. Sin ella la API los rechaza: el usuario debe saber que sus
   * órdenes se van a recolocar antes de que ocurra.
   */
  @IsOptional()
  @IsBoolean()
  acceptRelayout?: boolean;
}

export class RenameBotDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  name: string;
}

export const BOT_COMMANDS = [
  'START',
  'PAUSE',
  'RESUME',
  'STOP_KEEP_POSITION',
  'STOP_AND_CLOSE',
  'CLOSE_NOW',
  'TAKE_PROFIT_NOW',
  'ADD_SAFETY_NOW',
  'REANCHOR_GRID',
  'CANCEL_ALL_ORDERS',
  'PANIC',
  'REPAIR',
  'ADJUST_MARGIN',
] as const;

export type BotCommandName = (typeof BOT_COMMANDS)[number];

/**
 * Importe de un ajuste de margen: decimal POSITIVO, sin signo.
 *
 * Mismo patrón que `risk` y `advisor`, y por el mismo motivo: `@IsNumberString`
 * a secas acepta `0` y `-5`, y aquí un signo colado en el importe convertiría
 * un aporte en una retirada — que en aislado ACERCA la liquidación en vez de
 * alejarla. El sentido lo lleva `marginAction` y solo `marginAction`.
 */
const IMPORTE_POSITIVO = /^(?!0+(\.0+)?$)\d+(\.\d+)?$/;

export class BotCommandDto {
  @IsEnum(BOT_COMMANDS)
  command: BotCommandName;

  /**
   * Los comandos que cierran posición a mercado exigen confirmación: son
   * irreversibles y realizan pérdidas al instante.
   */
  @IsOptional()
  @IsBoolean()
  confirm?: boolean;

  // ── Solo para ADJUST_MARGIN ───────────────────────────────────
  // Opcionales en el DTO porque el resto de comandos no los llevan; que
  // ADJUST_MARGIN sí los traiga lo exige el servicio, que es quien sabe de qué
  // comando se trata. Un `@ValidateIf` por campo diría lo mismo repartido en
  // tres sitios.

  @IsOptional()
  @Matches(IMPORTE_POSITIVO, {
    message: 'El importe debe ser un número mayor que cero, sin signo.',
  })
  @IsNumberString()
  marginAmount?: string;

  @IsOptional()
  @IsEnum(['ADD', 'REMOVE'])
  marginAction?: 'ADD' | 'REMOVE';

  /**
   * Sube también el capital asignado del bot. NO cambia la liquidación: eso lo
   * hace la transferencia al venue, que ocurre de todas formas.
   */
  @IsOptional()
  @IsBoolean()
  countAsBotCapital?: boolean;
}

export class ListBotsQueryDto {
  @IsOptional()
  @IsEnum(BotStatus)
  status?: BotStatus;

  @IsOptional()
  @IsEnum(Venue)
  venue?: Venue;

  /**
   * Red del venue. AUSENTE = las dos, no «mainnet».
   *
   * Es la unica excepcion a la regla de que ausente significa mainnet, y es
   * deliberada: aqui filtra una lista que ya existia sin este parametro, asi que
   * el valor por defecto tiene que seguir devolviendo lo mismo que devolvia. Un
   * cliente sin actualizar sigue viendo todos sus bots.
   */
  @IsOptional()
  @Transform(({ value }) => (value === undefined ? undefined : value === true || value === 'true'))
  @IsBoolean()
  testnet?: boolean;

  @IsOptional()
  @IsEnum(StrategyKind)
  strategy?: StrategyKind;
}

export class HistoryQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}

/**
 * Lo que hace falta para responder «cuanto capital cabe en este bot».
 *
 * El simbolo es opcional: en el paso «Cuenta» del asistente todavia no hay par
 * elegido y el saldo ya se quiere enseñar. Sin el, se omite la posicion abierta
 * y el resto de la respuesta llega igual.
 */
export class CapitalQueryDto {
  @IsUUID()
  exchangeAccountId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  symbol?: string;

  /**
   * El bot que pregunta, si lo hay.
   *
   * Solo cambia algo en las conexiones de SIMULACIÓN, donde el saldo no es de la
   * conexión sino del sandbox de cada bot: sin esto, la ficha de un bot simulado
   * enseñaba el capital de partida en lugar del suyo, y el margen libre que
   * ofrecía para aportar no era el que tenía. En una conexión real se ignora.
   */
  @IsOptional()
  @IsUUID()
  botId?: string;
}

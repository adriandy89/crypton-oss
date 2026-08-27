import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Venue } from '@crypton/db';
import { CANDLE_INTERVALS, type CandleInterval } from '@crypton/shared';

/**
 * El intervalo se valida contra la unión del sistema, no contra la lista del
 * venue: aquí solo se comprueba que sea un intervalo EXISTENTE. Si el venue en
 * concreto no lo sirve, el mensaje lo da el adaptador, que es quien sabe qué
 * alternativas ofrecer — y ese mensaje es el que ve el usuario.
 */
export class CandlesQueryDto {
  @IsEnum(Venue)
  venue: Venue;

  /**
   * Ver `SYMBOL_RE` en `market-stream.service.ts`: lista NEGRA, no blanca.
   *
   * El patrón anterior era `[A-Za-z0-9_\-:.]` y dejaba fuera los cuatro pares
   * de Aster con nombre en chino, que sí están en el catálogo: su gráfico
   * respondía 400 y no había forma de abrirlo. Quien decide qué símbolos
   * existen es el catálogo, que este endpoint consulta antes de salir al venue.
   *
   * `:` sí se excluye ahora, y no por gusto: el símbolo entra en una clave de
   * Redis compuesta con dos puntos, y ningún par real lo lleva.
   */
  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  // eslint-disable-next-line no-control-regex -- el rango de control esta a proposito: es el saneado que rechaza caracteres de control en un simbolo
  @Matches(/^[^\s,:|\u0000-\u001f]+$/)
  symbol: string;

  // `IsIn` y no `IsEnum`: el segundo espera un OBJETO enum y con un array
  // valida bien pero produce un mensaje vacío («must be one of the following
  // values: »), que es lo que el usuario vería.
  @IsIn(CANDLE_INTERVALS)
  interval: CandleInterval;

  /**
   * Tope de velas.
   *
   * 1500 NO es «el techo del venue más generoso» —eso decía aquí y es falso—:
   * es el de Aster, el de en medio. Hyperliquid sirve hasta 5000 y Lighter solo
   * 500. Se deja en 1500 a propósito y no se sube al máximo de Hyperliquid,
   * porque una sola llamada de 5000 velas pesa 104 sobre el presupuesto de
   * caudal que comparten los bots —unos seis segundos de la IP entera— desde un
   * endpoint de solo lectura. Para ver más pasado se pagina con `endMs`, que
   * además comparte caché entre usuarios; una ventana a medida no la comparte
   * nadie.
   *
   * El servicio acota además al techo REAL de cada venue antes de construir la
   * clave de caché. Ver `MarketDataService.candles`.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1500)
  limit?: number;

  /** Fin del rango en ms epoch. Ausente = hasta ahora. Sirve para paginar hacia atrás. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  endMs?: number;

  /**
   * Red del venue. Ausente = mainnet.
   *
   * `Type(() => Boolean)` NO sirve aqui: convierte cualquier cadena no vacia en
   * `true`, asi que `?testnet=false` acabaria pidiendo testnet. Se transforma a
   * mano comparando con la cadena exacta.
   */
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  testnet?: boolean;
}

export class TickersQueryDto {
  /** Sin venue devuelve los tres, que es lo que pide la lista de mercados. */
  @IsOptional()
  @IsEnum(Venue)
  venue?: Venue;

  /**
   * Red del venue. Ausente = mainnet.
   *
   * `Type(() => Boolean)` NO sirve aqui: convierte cualquier cadena no vacia en
   * `true`, asi que `?testnet=false` acabaria pidiendo testnet. Se transforma a
   * mano comparando con la cadena exacta.
   */
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  testnet?: boolean;
}

/**
 * Lo que mira una conexión ahora mismo.
 *
 * Sube por REST porque SSE es unidireccional: es el mismo modelo que ya usan
 * los comandos de los bots —baja por el flujo, sube por REST— y evita abrir un
 * WebSocket bidireccional solo para decir tres palabras.
 */
export class WatchDto {
  /**
   * La conexión que declara el interés.
   *
   * Lo emite el servidor en el primer evento del flujo (`HELLO`). Va aquí y no
   * se deduce del usuario porque el mismo usuario puede tener la lista abierta
   * en el móvil y un gráfico en el portátil, y con un solo conjunto por usuario
   * el último en declarar dejaría al otro sin precios.
   */
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  streamId: string;

  /**
   * Pares en formato `VENUE:SIMBOLO`.
   *
   * El tope de 60 es el mismo que aplica el transporte, y está aquí además
   * porque cada entrada puede acabar siendo una suscripción al WebSocket de un
   * venue: es un recurso contado que se comparte con los bots que operan, así
   * que el borde tiene que acotarlo antes de que llegue a nadie.
   */
  @IsArray()
  @ArrayMaxSize(60)
  @IsString({ each: true })
  // eslint-disable-next-line no-control-regex -- el rango de control esta a proposito: es el saneado que rechaza caracteres de control en un simbolo
  @Matches(/^[A-Z]+:[^\s,:|\u0000-\u001f]{1,32}$/, { each: true })
  symbols: string[];

  /**
   * Series de velas en formato `VENUE:SIMBOLO:INTERVALO`.
   *
   * Van aparte de `symbols` y con un tope MUCHO mas bajo porque son otra cosa:
   * un precio en vivo comparte el ticker que el worker ya tiene abierto, pero
   * cada serie de velas es una suscripcion propia al venue —en Aster, un
   * WebSocket entero— y un grafico solo mira una resolucion de un par.
   *
   * Opcional: un cliente antiguo no lo manda y sigue recibiendo precios.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(4)
  @IsString({ each: true })
  // eslint-disable-next-line no-control-regex -- el rango de control esta a proposito: es el saneado que rechaza caracteres de control en un simbolo
  @Matches(/^[A-Z]+:[^\s,:|\u0000-\u001f]{1,32}:[A-Za-z0-9]{1,3}$/, {
    each: true,
  })
  candles?: string[];

  /**
   * Red del venue de TODA la declaracion. Ausente = mainnet.
   *
   * Una sola bandera para el conjunto entero, en vez de marcar cada par: la
   * pantalla mira una red a la vez —es lo que enciende el distintivo de la
   * barra— y por par abriria la puerta a una lista mezclada que nadie sabria
   * pintar. Cambiar de red vuelve a declarar el conjunto entero, que es lo que
   * este endpoint ya hace en cada cambio de pantalla.
   */
  @IsOptional()
  @IsBoolean()
  testnet?: boolean;
}

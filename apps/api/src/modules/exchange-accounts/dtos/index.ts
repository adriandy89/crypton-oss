import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Venue } from '@crypton/db';

const HEX_PRIVATE_KEY = /^(0x)?[0-9a-fA-F]{64}$/;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * Nunca se acepta una frase semilla. La comprobación es explícita y con mensaje
 * propio porque es EL error que arruina a un usuario: una seed da control total
 * de los fondos, mientras que una clave de API wallet solo permite operar.
 */
const looksLikeSeedPhrase = (value: string): boolean => value.trim().split(/\s+/).length >= 12;

export class HyperliquidCredentialsDto {
  @IsString()
  @Matches(EVM_ADDRESS, {
    message: 'La dirección de la cuenta no es una dirección EVM válida.',
  })
  accountAddress: string;

  @IsString()
  @Matches(HEX_PRIVATE_KEY, {
    message:
      'La clave de la API wallet debe ser hexadecimal de 64 caracteres. Nunca introduzcas tu frase semilla.',
  })
  agentPrivateKey: string;

  /**
   * HEREDADO. La red se manda ahora en `CreateExchangeAccountDto.testnet`, que
   * vale para los tres venues. Se sigue aceptando para no romper a un cliente
   * sin actualizar; el servidor toma el `true` de cualquiera de los dos.
   */
  @IsOptional()
  @IsBoolean()
  testnet?: boolean;
}

export class LighterCredentialsDto {
  @IsInt()
  @Min(0)
  accountIndex: number;

  @IsInt()
  @Min(0)
  apiKeyIndex: number;

  @IsString()
  @IsNotEmpty()
  apiPrivateKey: string;
}

export class AsterCredentialsDto {
  @IsString()
  @Matches(EVM_ADDRESS, { message: 'La dirección de usuario no es válida.' })
  userAddress: string;

  @IsString()
  @Matches(EVM_ADDRESS, {
    message: 'La dirección de la API wallet no es válida.',
  })
  signerAddress: string;

  @IsString()
  @Matches(HEX_PRIVATE_KEY, {
    message:
      'La clave de la API wallet debe ser hexadecimal de 64 caracteres. Nunca introduzcas tu frase semilla.',
  })
  signerPrivateKey: string;
}

/**
 * Dar de alta una clave de firma exige demostrar que sigues siendo tú, no solo
 * tener un token válido. Esa prueba no viaja aquí: es una reautenticación con
 * Google hecha justo antes, que el controlador consume con `assertStepUp`.
 */
export class CreateExchangeAccountDto {
  @IsEnum(Venue)
  venue: Venue;

  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  label: string;

  /**
   * Red del venue. Ausente = mainnet.
   *
   * Es una propiedad de LA CUENTA, no de la credencial, y por eso vive aqui
   * arriba y vale para los tres venues: los bots heredan su red de la cuenta a
   * la que se atan, asi que esta bandera es lo unico que decide contra que libro
   * acaba operando una clave. Se fija al conectar y no se puede cambiar despues.
   *
   * La URL NO se pregunta. Antes `lighter.baseUrl` y `aster.baseUrl` eran texto
   * libre sin validar que acababa en un `fetch()` y —en Lighter— dentro del
   * firmante, o sea que quien mandaba el formulario elegia el destino de una
   * clave capaz de mover dinero. Ahora la decide `VENUE_ENDPOINTS` en el
   * servidor a partir de esta bandera.
   */
  @IsOptional()
  @IsBoolean()
  testnet?: boolean;

  @IsOptional()
  @ValidateNested()
  @Type(() => HyperliquidCredentialsDto)
  hyperliquid?: HyperliquidCredentialsDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => LighterCredentialsDto)
  lighter?: LighterCredentialsDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => AsterCredentialsDto)
  aster?: AsterCredentialsDto;

  /** Comprueba que ninguna de las claves recibidas parece una frase semilla. */
  static assertNoSeedPhrase(dto: CreateExchangeAccountDto): string | null {
    const candidates = [
      dto.hyperliquid?.agentPrivateKey,
      dto.lighter?.apiPrivateKey,
      dto.aster?.signerPrivateKey,
    ].filter(Boolean) as string[];
    return candidates.some(looksLikeSeedPhrase)
      ? 'Eso parece una frase semilla. CRYPTON solo acepta la clave privada de una API wallet, que no puede retirar fondos.'
      : null;
  }
}

export class UpdateExchangeAccountDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  label?: string;

  @IsOptional()
  @IsBoolean()
  builderApproved?: boolean;

  /**
   * Capital de partida de la simulación. Solo en la conexión de simulación.
   *
   * Viaja como cadena, igual que el resto de importes del sistema: un `number`
   * de JavaScript no representa exactamente todos los decimales y este va a
   * parar a una columna de 38 dígitos.
   *
   * Cambiarlo reinicia la simulación: conservar el estado convertiría «simular
   * con 500» en «simular con 500 más lo que ya llevabas».
   */
  @IsOptional()
  // El patrón, y no `@IsNumberString`, porque este cierra la puerta al SIGNO sin
  // cerrársela a los céntimos: «-500» era una cadena numérica perfectamente
  // válida y dejaba la simulación en negativo, mientras que `no_symbols` habría
  // tirado también «500.50». El rango lo termina de acotar el servicio, que es
  // quien sabe que esto solo vale en una conexión de simulación.
  @Matches(/^\d+(\.\d+)?$/, {
    message: 'El capital de partida tiene que ser un número positivo.',
  })
  paperBalance?: string;
}

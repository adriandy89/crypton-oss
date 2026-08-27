import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

/**
 * Parámetro de ruta `:id`. Existe además del UUIDDto heredado porque este usa
 * el nombre `id`, que es el que llevan las rutas de CRYPTON; validarlo como
 * UUID en el propio decorador evita que un valor basura llegue hasta Prisma.
 */
export class IdParamDto {
  @ApiProperty({ example: '123e4567-e89b-12d3-a456-426614174000' })
  @IsUUID()
  readonly id: string;
}

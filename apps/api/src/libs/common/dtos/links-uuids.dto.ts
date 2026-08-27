import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsDefined, IsOptional, IsString } from 'class-validator';

export class LinksUUIDsDto {
  @ApiProperty({
    description: 'ids fot update',
    example: [],
  })
  @IsArray()
  @IsString({ each: true })
  @IsDefined()
  readonly toUpdate: string[];

  @ApiProperty({
    description: 'ids fot delete',
    example: [],
  })
  @IsArray()
  @IsString({ each: true })
  @IsDefined()
  readonly toDelete: string[];

  @ApiProperty({
    description: 'ids for apply actions',
    example: [],
  })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  readonly uuids: string[];
}

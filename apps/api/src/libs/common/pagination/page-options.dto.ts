import { ApiPropertyOptional } from '@nestjs/swagger';

import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import { SortOrderEnum } from './interfaces/sort.interface';

export class PageOptionsDto {
  @ApiPropertyOptional({
    enum: SortOrderEnum,
    default: SortOrderEnum.DESC,
  })
  @IsEnum(SortOrderEnum)
  @IsOptional()
  readonly sortOrder: SortOrderEnum = SortOrderEnum.DESC;

  @ApiPropertyOptional({
    minimum: 1,
    default: 1,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  readonly page: number = 1;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: 101,
    default: 10,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(101)
  @IsOptional()
  readonly limit: number = 10;
}

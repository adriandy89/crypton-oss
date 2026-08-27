import { ApiProperty } from '@nestjs/swagger';
import { IsArray } from 'class-validator';
import { PageMetaDto } from './page-meta.dto';

export class PageDto<TData> {
  @IsArray()
  @ApiProperty()
  readonly data: TData[];

  @ApiProperty({ type: () => PageMetaDto })
  readonly meta: PageMetaDto;

  constructor(data: TData[], meta: PageMetaDto) {
    this.data = data;
    this.meta = meta;
  }
}

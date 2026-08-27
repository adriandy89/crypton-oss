import { ApiProperty } from '@nestjs/swagger';
import { IsDateString, IsNotEmpty } from 'class-validator';

export class DateFromParamsDto {
  @ApiProperty({
    description: 'Start date in ISO format',
    example: '2026-01-01T00:00:00Z',
    required: true,
    type: Date,
  })
  @IsDateString()
  @IsNotEmpty()
  readonly from: string;
}

import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMinSize,
  ArrayNotEmpty,
  IsArray,
  IsNotEmpty,
  IsString,
} from 'class-validator';

export class UUIDArrayDto {
  @ApiProperty({
    description: 'UUIDs Array',
    type: [String],
    example: [
      'a1b2c3d4-e5f6-7g8h-9i0j-k1l2m3n4o5p6',
      'a1b2c3d4-e5f6-7g8h-9i0j-k1l2m3n4o5p7',
    ],
  })
  @IsNotEmpty()
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMinSize(1)
  @IsString({ each: true })
  readonly uuids: string[];
}

import { ApiProperty } from '@nestjs/swagger';
import {
  IsDateString,
  IsNotEmpty,
  ValidateBy,
  buildMessage,
} from 'class-validator';

export function IsAfter(property: string) {
  return ValidateBy({
    name: 'isAfter',
    constraints: [property],
    validator: {
      validate: (value: any, args: any) => {
        const [relatedPropertyName] = args.constraints;
        const relatedValue = args.object[relatedPropertyName];
        return (
          relatedValue && value && new Date(value) > new Date(relatedValue)
        );
      },
      defaultMessage: buildMessage(
        (_eachPrefix, args) =>
          `$property must be after ${args?.constraints[0]}`,
        { message: 'to date must be after from date' },
      ),
    },
  });
}

export function IsMaxDaysRange(property: string, maxDays: number) {
  return ValidateBy({
    name: 'isMaxDaysRange',
    constraints: [property, maxDays],
    validator: {
      validate: (value: any, args: any) => {
        const [relatedPropertyName, maxDays] = args.constraints;
        const relatedValue = args.object[relatedPropertyName];

        if (!relatedValue || !value) return true;

        const fromDate = new Date(relatedValue);
        const toDate = new Date(value);
        const diffInMs = toDate.getTime() - fromDate.getTime();
        const diffInDays = diffInMs / (1000 * 60 * 60 * 24);

        return diffInDays <= maxDays;
      },
      defaultMessage: buildMessage(
        (_eachPrefix, args) =>
          `Date range cannot exceed ${args?.constraints[1]} days`,
        { message: 'Date range cannot exceed maximum allowed days' },
      ),
    },
  });
}

export class DateRangeParamsDto {
  @ApiProperty({
    description: 'Start date in ISO format',
    example: '2025-12-01T00:00:00Z',
    required: true,
    type: Date,
  })
  @IsDateString()
  @IsNotEmpty()
  readonly from: string;

  @ApiProperty({
    description: 'End date in ISO format',
    example: '2025-12-30T23:59:59Z',
    required: true,
    type: Date,
  })
  @IsDateString()
  @IsNotEmpty()
  @IsAfter('from')
  @IsMaxDaysRange('from', 370)
  readonly to: string;
}

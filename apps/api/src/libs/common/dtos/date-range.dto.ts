import { ApiProperty } from '@nestjs/swagger';
import {
  IsDateString,
  IsNotEmpty,
  ValidateBy,
  buildMessage,
  type ValidationArguments,
} from 'class-validator';

/**
 * Lee una restriccion del validador y la devuelve como fecha comparable.
 *
 * `args.object` y `args.constraints` son `any` en class-validator, asi que sin
 * este paso cada acceso propagaba `any` por toda la funcion: un nombre de
 * propiedad mal escrito compilaba y devolvia `undefined`, y el validador decia
 * que si a un rango invalido en vez de fallar.
 */
function relatedDate(args: ValidationArguments, index: number): string | undefined {
  const property = args.constraints[index] as string;
  const value = (args.object as Record<string, unknown>)[property];
  return typeof value === 'string' ? value : undefined;
}

export function IsAfter(property: string) {
  return ValidateBy({
    name: 'isAfter',
    constraints: [property],
    validator: {
      validate: (value: unknown, args: ValidationArguments) => {
        const relatedValue = relatedDate(args, 0);
        if (!relatedValue || typeof value !== 'string') return false;
        return new Date(value) > new Date(relatedValue);
      },
      defaultMessage: buildMessage(
        (_eachPrefix, args) => `$property must be after ${String(args?.constraints[0])}`,
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
      validate: (value: unknown, args: ValidationArguments) => {
        const relatedValue = relatedDate(args, 0);
        const maxDays = args.constraints[1] as number;

        if (!relatedValue || typeof value !== 'string') return true;

        const fromDate = new Date(relatedValue);
        const toDate = new Date(value);
        const diffInMs = toDate.getTime() - fromDate.getTime();
        const diffInDays = diffInMs / (1000 * 60 * 60 * 24);

        return diffInDays <= maxDays;
      },
      defaultMessage: buildMessage(
        (_eachPrefix, args) => `Date range cannot exceed ${String(args?.constraints[1])} days`,
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

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { AllExceptionFilter } from './exception.filter';

/**
 * Lo que llega al cliente de cada error (spec 055, G-02).
 *
 * El filtro solo reenviaba entero un cuerpo con `code`, y de los demas se
 * quedaba con `message`. Tres rechazos de configuracion construyen cuerpos con
 * mas datos y sin `code` —la confirmacion de un cambio WARM, los motivos de una
 * configuracion no valida y los campos COLD—, y la app los recibia como un texto
 * suelto: esperaba `requiresConfirmation` para preguntar, nunca lo veia, y ningun
 * cambio WARM se podia aplicar desde Ajustes.
 */
function respuesta(e: unknown): { status: number; error: unknown } {
  let status = 0;
  let cuerpo: { error?: unknown } = {};
  const res = {
    status: (s: number) => {
      status = s;
      return res;
    },
    json: (b: { error?: unknown }) => {
      cuerpo = b;
    },
  };
  const host = {
    switchToHttp: () => ({
      getResponse: () => res,
      getRequest: () => ({ method: 'PATCH', url: '/bots/x/config' }),
    }),
  };
  new AllExceptionFilter({ enabled: false } as never).catch(e, host as never);
  return { status, error: cuerpo.error };
}

describe('AllExceptionFilter — lo que llega al cliente (spec 055, G-02)', () => {
  it('la confirmacion de un cambio WARM llega entera', () => {
    const cuerpo = {
      message: 'Este cambio obliga a cancelar y volver a tender la escalera.',
      level: 'WARM',
      changed: [{ key: 'layers', from: 2, to: 3 }],
      requiresConfirmation: true,
    };
    expect(respuesta(new ConflictException(cuerpo))).toEqual({ status: 409, error: cuerpo });
  });

  it('los motivos de una configuracion no valida llegan enteros', () => {
    const cuerpo = {
      message: 'La configuración nueva no es válida.',
      issues: [{ field: 'layers', message: 'Entre 1 y 10.', severity: 'ERROR' }],
    };
    expect(respuesta(new BadRequestException(cuerpo))).toEqual({ status: 400, error: cuerpo });
  });

  it('los campos COLD llegan enteros', () => {
    const cuerpo = { message: 'No se pueden cambiar.', coldFields: ['symbol'] };
    expect(respuesta(new BadRequestException(cuerpo))).toEqual({ status: 400, error: cuerpo });
  });

  it('un cuerpo con codigo sigue llegando entero', () => {
    const cuerpo = { message: 'Cambio', code: 'STALE_VERSION', reason: 'STALE_VERSION' };
    expect(respuesta(new ConflictException(cuerpo))).toEqual({ status: 409, error: cuerpo });
  });

  it('un cuerpo sin campos del contrato sigue llegando como su mensaje', () => {
    // `reason` no es del contrato con la app: el supervisor lo lee de la
    // excepcion, no de la respuesta HTTP.
    const e = new ConflictException({ message: 'Con escalones ejecutados…', reason: 'RESHAPE' });
    expect(respuesta(e)).toEqual({ status: 409, error: 'Con escalones ejecutados…' });
  });

  it('un error de validacion de class-validator sale como hasta ahora', () => {
    // Su cuerpo es `{ statusCode, message: string[], error }`: ningun campo del
    // contrato, asi que sale la lista, que es lo que la app ya sabe leer.
    const e = new BadRequestException(['mode must be one of the following values']);
    expect(respuesta(e)).toEqual({
      status: 400,
      error: ['mode must be one of the following values'],
    });
  });

  it('un error con texto sale como su texto', () => {
    expect(respuesta(new ForbiddenException('No es tuyo.'))).toEqual({
      status: 403,
      error: 'No es tuyo.',
    });
    expect(respuesta(new NotFoundException())).toEqual({ status: 404, error: 'Not Found' });
  });

  it('un error que no es HTTP no cuenta nada', () => {
    // Un fallo de Prisma trae la invocacion con sus valores: no sale nunca.
    const e = new Error('Invalid `prisma.bot.update()` invocation: enc_payload = …');
    expect(respuesta(e)).toEqual({ status: 500, error: 'Error interno del servidor.' });
  });
});

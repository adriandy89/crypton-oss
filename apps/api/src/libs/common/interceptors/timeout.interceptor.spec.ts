import { Reflector } from '@nestjs/core';
import { SSE_METADATA } from '@nestjs/common/constants';
import { TimeoutError, of, throwError, timer } from 'rxjs';
import { catchError, map } from 'rxjs/operators';
import { TimeoutInterceptor } from './timeout.interceptor';

/**
 * El tope de tiempo por peticion.
 *
 * Lo que se comprueba es DE DONDE sale la decision. Antes salia de la cabecera
 * `Accept` de la peticion —un dato que pone quien llama—, asi que bastaba
 * mandar `text/event-stream` en cualquier endpoint para quedarse sin tope y
 * poder retener peticiones abiertas a voluntad.
 */

/** Un manejador con o sin la marca que deja `@Sse()`. */
const contexto = (esSse: boolean, accept?: string) => {
  const handler = () => undefined;
  if (esSse) Reflect.defineMetadata(SSE_METADATA, true, handler);
  return {
    getHandler: () => handler,
    switchToHttp: () => ({ getRequest: () => ({ headers: { accept } }) }),
  } as never;
};

const nunca = { handle: () => timer(200_000).pipe(map(() => 'tarde')) };
const rapido = { handle: () => of('pronto') };

const correr = (ctx: never, next: { handle: () => unknown }) =>
  new Promise<string>((resolve) => {
    (
      new TimeoutInterceptor(new Reflector()).intercept(
        ctx,
        next as never,
      ) as never as {
        pipe: (...a: unknown[]) => { subscribe: (o: unknown) => void };
      }
    )
      .pipe(
        catchError((e: unknown) =>
          of(e instanceof TimeoutError ? 'CORTADO' : 'otro error'),
        ),
      )
      .subscribe({ next: (v: unknown) => resolve(String(v)) });
  });

describe('TimeoutInterceptor — de donde sale la decision', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('un endpoint normal se corta a los 80 s', async () => {
    const p = correr(contexto(false), nunca);
    await jest.advanceTimersByTimeAsync(81_000);
    expect(await p).toBe('CORTADO');
  });

  it('la cabecera Accept NO puede quitar el tope de un endpoint normal', async () => {
    // Este es el agujero: `Accept: text/event-stream` en una ruta que no es un
    // flujo dejaba la peticion sin limite de tiempo.
    const p = correr(contexto(false, 'text/event-stream'), nunca);
    await jest.advanceTimersByTimeAsync(81_000);
    expect(await p).toBe('CORTADO');
  });

  it('un flujo SSE NO se corta, aunque pasen horas', async () => {
    let terminado = false;
    const p = correr(contexto(true), nunca).then((v) => {
      terminado = true;
      return v;
    });
    await jest.advanceTimersByTimeAsync(190_000);
    // A los 190 s sigue vivo: cortarlo a los 80 seria cortar el canal por el
    // que la aplicacion se entera de los fills.
    expect(terminado).toBe(false);
    await jest.advanceTimersByTimeAsync(20_000);
    expect(await p).toBe('tarde');
  });

  it('un flujo SSE sin la cabecera exacta TAMPOCO se corta', async () => {
    // El otro lado del mismo error: `text/event-stream, */*` es una cabecera
    // perfectamente valida que no casaba con la comparacion exacta, y ese
    // cliente se habria llevado un corte en mitad del flujo.
    let terminado = false;
    void correr(contexto(true, 'text/event-stream, */*'), nunca).then(
      () => (terminado = true),
    );
    await jest.advanceTimersByTimeAsync(190_000);
    expect(terminado).toBe(false);
  });

  it('lo que responde rapido pasa igual', async () => {
    expect(await correr(contexto(false), rapido)).toBe('pronto');
  });

  it('un error del manejador se propaga tal cual, no como corte', async () => {
    const fallo = { handle: () => throwError(() => new Error('boom')) };
    expect(await correr(contexto(false), fallo)).toBe('otro error');
  });
});

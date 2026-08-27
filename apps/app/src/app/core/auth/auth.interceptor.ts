import { HttpErrorResponse, type HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, from, switchMap, throwError } from 'rxjs';
import { AuthService } from './auth.service';

/**
 * Rutas que NO deben llevar token ni disparar renovación.
 *
 * `google/step-up` NO está en la lista a propósito: arranca la reautenticación
 * de una sesión que ya existe, así que necesita el token como cualquier otra
 * ruta protegida.
 */
const PUBLIC_PATHS = [
  '/auth/google/start',
  '/auth/google/exchange',
  '/auth/refresh',
  '/auth/sign-out',
];

/**
 * Adjunta el token de acceso y renueva la sesión cuando caduca.
 *
 * La renovación la serializa `AuthService.refresh()`, así que varios 401
 * simultáneos —lo normal al volver a abrir la app— consumen un único refresh
 * token en lugar de rotarlo varias veces y cerrar la sesión sin motivo.
 */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthService);
  const router = inject(Router);

  const isPublic = PUBLIC_PATHS.some((p) => req.url.includes(p));
  const token = auth.accessToken;

  const authorized =
    token && !isPublic ? req.clone({ setHeaders: { Authorization: `Bearer ${token}` } }) : req;

  return next(authorized).pipe(
    catchError((error: unknown) => {
      const is401 = error instanceof HttpErrorResponse && error.status === 401;
      if (!is401 || isPublic) return throwError(() => error);

      return from(auth.refresh()).pipe(
        switchMap((ok) => {
          if (!ok) {
            void router.navigateByUrl('/auth/login', { replaceUrl: true });
            return throwError(() => error);
          }
          // Se repite la petición con el token nuevo. Solo se reintenta UNA
          // vez: si vuelve a dar 401 con un token recién emitido, el problema
          // no es la caducidad y reintentar en bucle no ayudaría.
          return next(req.clone({ setHeaders: { Authorization: `Bearer ${auth.accessToken}` } }));
        }),
      );
    }),
  );
};

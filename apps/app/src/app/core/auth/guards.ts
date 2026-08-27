import { inject } from '@angular/core';
import { Router, type CanActivateFn } from '@angular/router';
import { AuthService } from './auth.service';

/** Exige sesión. Si no la hay, manda al login. */
export const authGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  return auth.isAuthenticated() ? true : router.createUrlTree(['/auth/login']);
};

/**
 * Lo contrario: si YA hay sesión, no se muestra el login. Evita el desconcierto
 * de volver a ver la pantalla de acceso tras entrar con el botón de atrás.
 */
export const guestGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  return auth.isAuthenticated() ? router.createUrlTree(['/tabs/bots']) : true;
};

/**
 * Exige rol de administrador.
 *
 * Es COMODIDAD, no seguridad, y conviene tenerlo claro: el `role` sale de los
 * claims del token que guarda este mismo navegador, así que cualquiera puede
 * saltárselo. La autoridad de verdad es el `RolesGuard` del servidor, que es
 * quien responde 403. Esto solo evita enseñar una pantalla que no va a
 * funcionar.
 *
 * Redirige a los bots y no al login: quien llega aquí SÍ ha entrado, solo que
 * con otro rol, y mandarlo a la pantalla de acceso sugeriría que su sesión ha
 * caducado.
 */
export const adminGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  return auth.user()?.role === 'ADMIN' ? true : router.createUrlTree(['/tabs/bots']);
};

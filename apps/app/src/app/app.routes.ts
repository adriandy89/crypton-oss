import { Routes } from '@angular/router';
import { adminGuard, authGuard, guestGuard } from './core/auth';

export const routes: Routes = [
  // ── La vuelta de Google ──
  // Antes del grupo con `guestGuard` y fuera de él: la reautenticación de una
  // operación crítica vuelve por aquí CON la sesión abierta, y ese guard la
  // mandaría a los bots antes de canjear el vale.
  {
    path: 'auth/callback',
    loadComponent: () => import('./features/auth/callback.page').then((m) => m.AuthCallbackPage),
  },

  // ── Acceso (pantalla completa, solo sin sesión) ──
  // Sin alta: la cuenta se crea sola la primera vez que se entra con Google.
  {
    path: 'auth',
    canActivate: [guestGuard],
    children: [
      {
        path: 'login',
        loadComponent: () => import('./features/auth/login.page').then((m) => m.LoginPage),
      },
      { path: '', redirectTo: 'login', pathMatch: 'full' },
    ],
  },

  // ── Shell principal ──
  {
    path: 'tabs',
    canActivate: [authGuard],
    loadComponent: () => import('./tabs/tabs.page').then((m) => m.TabsPage),
    children: [
      {
        path: 'portfolio',
        loadComponent: () =>
          import('./features/portfolio/portfolio.page').then((m) => m.PortfolioPage),
      },
      {
        path: 'bots',
        loadComponent: () => import('./features/bots/bots-list.page').then((m) => m.BotsListPage),
      },
      {
        path: 'markets',
        loadComponent: () =>
          import('./features/markets/markets-list.page').then((m) => m.MarketsListPage),
      },
      {
        path: 'account',
        loadComponent: () => import('./features/account/account.page').then((m) => m.AccountPage),
      },
      { path: '', redirectTo: 'bots', pathMatch: 'full' },
    ],
  },

  // ── Pantallas completas fuera de los tabs ──
  // El asistente de creación y el detalle van fuera del shell a propósito:
  // ocupan toda la pantalla y tener la barra de tabs debajo invitaría a salirse
  // a media configuración sin guardar.
  // El grafico va FUERA de las pestanas, como el detalle de un bot: ocupa toda
  // la pantalla, y en apaisado esconde hasta su propia cabecera.
  {
    path: 'markets/:venue/:symbol',
    canActivate: [authGuard],
    loadComponent: () => import('./features/markets/chart.page').then((m) => m.MarketChartPage),
  },
  // Ranking sale de las pestanas y pasa a pantalla completa, como Riesgo y
  // Telegram. Se entra desde Cuenta.
  {
    path: 'leaderboard',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./features/leaderboard/leaderboard.page').then((m) => m.LeaderboardPage),
  },
  {
    path: 'bots/new',
    canActivate: [authGuard],
    loadComponent: () => import('./features/bots/bot-create.page').then((m) => m.BotCreatePage),
  },
  {
    path: 'bots/:id',
    canActivate: [authGuard],
    loadComponent: () => import('./features/bots/bot-detail.page').then((m) => m.BotDetailPage),
  },
  {
    path: 'accounts/new',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./features/account/connect-exchange.page').then((m) => m.ConnectExchangePage),
  },
  {
    path: 'telegram',
    canActivate: [authGuard],
    loadComponent: () => import('./features/account/telegram.page').then((m) => m.TelegramPage),
  },
  {
    path: 'risk',
    canActivate: [authGuard],
    loadComponent: () => import('./features/account/risk.page').then((m) => m.RiskPage),
  },
  {
    path: 'profile',
    canActivate: [authGuard],
    loadComponent: () => import('./features/account/profile.page').then((m) => m.ProfilePage),
  },
  {
    path: 'security',
    canActivate: [authGuard],
    loadComponent: () => import('./features/account/security.page').then((m) => m.SecurityPage),
  },

  // El backtest, para cualquier usuario sobre sus bots simulados (spec 004). Fuera
  // del shell de pestañas: se llega desde Cuenta o desde el detalle de un bot,
  // no ocupa sitio en la barra.
  {
    path: 'backtest',
    canActivate: [authGuard],
    loadComponent: () => import('./features/backtest/backtest.page').then((m) => m.BacktestPage),
  },

  // Administracion. Fuera del shell de pestañas: es una herramienta, no una
  // seccion de la app, y no debe ocupar sitio en la barra de nadie.
  //
  // Agrupacion SIN componente, igual que el bloque de `auth` de arriba y al
  // contrario que `tabs`: aqui no hay shell —cada pantalla es completa y trae su
  // propia cabecera—, asi que un padre con `loadComponent` solo añadiria un
  // outlet anidado, una pila de navegacion de mas y ambigüedad en el boton de
  // volver. Lo que aporta el padre es tener los guardas escritos UNA vez:
  // cualquier pantalla que se cuelgue aqui nace protegida.
  //
  // `adminGuard` es comodidad, no seguridad: el rol sale del token que guarda
  // este mismo navegador. Quien manda es el `RolesGuard` del servidor, y por eso
  // TODAS estas pantallas manejan ademas el 403 de verdad.
  {
    path: 'admin',
    canActivate: [authGuard, adminGuard],
    children: [
      {
        path: '',
        loadComponent: () => import('./features/admin/admin.page').then((m) => m.AdminPage),
      },
      // La URL no cambia: los enlaces y marcadores a /admin/activity siguen valiendo.
      {
        path: 'activity',
        loadComponent: () =>
          import('./features/admin/activity.page').then((m) => m.AdminActivityPage),
      },
      {
        path: 'users',
        loadComponent: () => import('./features/admin/users.page').then((m) => m.AdminUsersPage),
      },
      {
        path: 'users/:id',
        loadComponent: () =>
          import('./features/admin/user-detail.page').then((m) => m.AdminUserDetailPage),
      },
      {
        path: 'bots',
        loadComponent: () => import('./features/admin/bots.page').then((m) => m.AdminBotsPage),
      },
      {
        path: 'bots/:id',
        loadComponent: () =>
          import('./features/admin/bot-detail.page').then((m) => m.AdminBotDetailPage),
      },
      {
        path: 'maintenance',
        loadComponent: () =>
          import('./features/admin/maintenance.page').then((m) => m.AdminMaintenancePage),
      },
    ],
  },

  { path: '', redirectTo: 'tabs/bots', pathMatch: 'full' },
  { path: '**', redirectTo: 'tabs/bots' },
];

# 073 — Plan

## Enfoque

Lo mínimo que deja la sección **lista para llenarse** y **cerrada a quien no es administrador**,
siguiendo los patrones que la app ya tiene: pestaña hija del shell `tabs` con `loadComponent`,
`adminGuard` como en `/admin`, el `esAdmin` local calculado sobre `auth.user()` como en los otros
cinco sitios, página *standalone* `OnPush` con `ui-empty-state`, y los iconos registrados con
`addIcons` en quien los usa.

Alternativas descartadas:
- `canMatch` en vez de `canActivate`: con `canMatch` la URL de un no administrador caería al `**`
  y acabaría igual en `/tabs/bots`, pero por un camino menos legible; el resto de la app usa
  `canActivate`.
- Un icono SVG propio: ionicons ya tiene uno que no usa nada más de la app, y uno propio desentonaría
  con los trazos de las otras cuatro pestañas.
- Esconder la pestaña con CSS: seguiría en el DOM y en el árbol de accesibilidad.

## Ficheros afectados

| Fichero | Qué cambia | Cómo se verifica |
|---|---|---|
| `apps/app/src/app/tabs/tabs.page.ts` | el botón «IA» dentro de `@if (esAdmin())`, el `AuthService` y el icono | build y lint de la app |
| `apps/app/src/app/app.routes.ts` | la hija `ia` de `tabs`, con `adminGuard` | build de la app |
| `apps/app/src/app/features/ia/ia.page.ts` | nueva: cabecera de pestaña raíz y estado vacío, solo con sesión de administrador | build y lint de la app |
| `docs/administracion.md` | la pestaña, en la guía de lo que ve un administrador | lectura |
| `specs/README.md` | la fila 073 | — |

## Fases

| Fase | Qué | Criterio de salida |
|---|---|---|
| 0 | Rama desde `main` con el 072 mezclado | `main` limpio |
| 1 | La pestaña, la ruta y la pantalla | build, lint y tipado de la app en verde |
| 2 | La guía de administración y el índice de specs | — |
| 3 | Las siguientes fases: el contenido, con las instrucciones del usuario | cada una con su spec |

## Verificación

```bash
cd apps/app && pnpm exec tsc -p tsconfig.app.json --noEmit
pnpm --filter app lint
pnpm --filter app build        # producción: presupuestos y strictTemplates
```

La app no tiene tests de interfaz (`"test": "echo sin tests de UI por ahora"`), así que CA-1 y CA-2
se comprueban a mano, con una cuenta de cada rol.

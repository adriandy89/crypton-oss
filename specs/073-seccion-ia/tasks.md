# 073 — Tareas

Una casilla por tarea, agrupadas por fase. Se marcan al terminar, con una nota corta si hubo
sorpresas. Nada se da por hecho sin la verificación de su fase.

## Fase 0 — Línea base

- [x] Rama `spec/073-seccion-ia` desde `main` con el 072 mezclado (`894e6fd`)

## Fase 1 — La pestaña, la ruta y la pantalla

- [x] `features/ia/ia.page.ts`: cabecera de pestaña raíz, estado vacío, nada sin sesión de `ADMIN`
- [x] `app.routes.ts`: hija `ia` de `tabs` con `adminGuard`
- [x] `tabs.page.ts`: botón «IA» con `hardware-chip-outline`, solo si `esAdmin()`
- [x] Tipado, lint y build de producción de la app. El único tropiezo fue de formato: la llamada a
  `addIcons` con cinco iconos pasa de 100 columnas y prettier la quiere partida
- [x] El build deja la pantalla en su propio trozo, cargado solo al entrar en la pestaña

## Fase 2 — Guía e índice

- [x] `docs/administracion.md`: la pestaña IA; `docs/README.md` la menciona en su fila
- [x] `CLAUDE.md`: la pestaña en la fila de `apps/app` del mapa
- [x] Fila 073 en `specs/README.md`

## Fase 3 — Lo que viene

- [ ] El contenido de la sección, con las instrucciones del usuario (cada fase, su spec)

## Cierre de la fase 1

- [x] CA-3 en verde
- [ ] CA-1 y CA-2: comprobación a mano del usuario, con una cuenta de cada rol

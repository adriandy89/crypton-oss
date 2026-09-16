# 056 — Revisión de los specs 053, 054 y 055

Estado: `hecho` (falta CA-4 manual) · Tipo: `revisión` · Rama: `spec/055-los-pendientes-del-modo-ia`

## Objetivo

Revisar con ojos nuevos todo lo que el 053, el 054 y el 055 cambian antes de pasarlo a `main` y al
fork open source, y corregir lo que se confirme.

Se sabrá que está hecho cuando:

- cada hallazgo de `findings.md` tenga estado;
- los corregidos tengan su test, o la verificación que les corresponda si son de la app, que no
  tiene tests;
- la verificación completa esté en verde.

## Contexto

Petición del usuario del 2026-09-16: «arregla todos los pendientes, luego revisa y pasa al open
source, y luego pasa todo a main. CUIDADO».

**Quién revisó.** Dos revisores independientes, en solo lectura y sobre el contenido commiteado
(`git show`/`git diff 978f2f1 HEAD`):

- uno la API, el worker y `shared`;
- otro la app.

**Qué revisaron.**

- **Backend.** Buscaron defectos de corrección, fugas por el filtro de excepciones, efectos sobre el
  dinero, el notificador y la coherencia entre código, comentarios y tests. Además revisaron todos
  los `throw` con campos del contrato con la app.
- **App.** Recorrieron a mano los escenarios del borrador de Ajustes: primera carga, eventos con y
  sin cambio de versión, guardar, `applied: false`, los dos 409, error de red, descartar y eventos
  durante un guardado.

## Cómo se trata

Ninguno de estos cambios está en `main`, así que los hallazgos confirmados **se corrigen dentro**,
en la rama del 055, como el 047 hizo con el 046. El razonamiento es el que dio el usuario entonces:
mergear algo que ya se sabe defectuoso para arreglarlo después es peor negocio.

Lo que no se corrige lleva su motivo en `findings.md`.

Escala de severidad y criterios: los de `specs/README.md`.

## Criterios de aceptación

- **CA-1** — Cada hallazgo de `findings.md` tiene estado y, si se corrige, un test o su verificación.
- **CA-2** — `pnpm test`, `pnpm lint`, `pnpm check:env`, `tsc` de la API y los builds de la API, el
  worker y la app en verde.
- **CA-3** — Las mutaciones de los arreglos caen.
- **CA-4** — Comprobación manual del usuario: la de CA-8 del 055, más ver el aviso de la
  recolocación junto a la barra de guardar.

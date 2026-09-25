# 073 — La sección de IA: una pestaña solo para administradores

Estado: `hecho` (fase 1: la pestaña, la ruta y la pantalla vacía; faltan CA-1 y CA-2, que son del
usuario, y el contenido llega en fases siguientes) · Tipo: `cambio` · Rama: `spec/073-seccion-ia`

## Objetivo

Una sección nueva de IA en la app, con **su propia entrada en la barra de abajo y su propio
icono**, que **solo existe para un administrador**. Esta fase construye el hueco —la pestaña, la
ruta con su guarda y una pantalla vacía— para que las fases siguientes solo tengan que llenarlo.

Se sabrá conseguido cuando un `ADMIN` vea cinco pestañas con «IA» entre «Bots» y «Cuenta», cuando
cualquier otra cuenta vea exactamente las cuatro de siempre y una URL escrita a mano la devuelva a
sus bots, y cuando el build de producción de la app, su lint y su tipado pasen.

## Contexto

Pedido del usuario el 2026-09-24, después de retirar el «Bot de IA» (spec 072):

> *«planificar una sección nueva de IA, con entrada nueva en el menú de abajo y icono nuevo, el
> objetivo es una sección para IA SOLO ACCESIBLE PARA ADMINISTRADORES, cuando todo esté preparado
> me avisas para darte instrucciones de las siguientes fases.»*

Hay dos decisiones de diseño anteriores con las que esto choca, y se resuelven a favor de lo pedido:

- `app.routes.ts` saca la **administración** del shell de pestañas a propósito: *«es una
  herramienta, no una sección de la app, y no debe ocupar sitio en la barra de nadie»*. Eso sigue
  valiendo para `/admin`. La sección de IA es otra cosa: el usuario la quiere **en la barra**, y es
  la primera pestaña que no ve todo el mundo.
- `tabs.page.ts` dice que *«cinco pestañas ya aprietan en un móvil»* (por eso Mercados sustituyó a
  Ranking). Con IA, un administrador tiene cinco; el resto sigue con cuatro. «IA» es la etiqueta más
  corta de la barra.

## Alcance

- `apps/app/src/app/tabs/tabs.page.ts`: el botón de la pestaña, pintado solo para un `ADMIN`.
- `apps/app/src/app/app.routes.ts`: la ruta `/tabs/ia` con `adminGuard`.
- `apps/app/src/app/features/ia/ia.page.ts`: la pantalla, vacía.
- `docs/administracion.md`: la pestaña en la guía de lo que ve un administrador.

## Fuera de alcance

- **El contenido de la sección.** Llega con las instrucciones del usuario, fase a fase.
- **El servidor.** Esta fase no pide un solo dato, así que no hay nada que proteger en la API; un
  controlador vacío «por si acaso» sería superficie sin uso. La primera fase que pida datos trae su
  controlador bajo las reglas de R-3.
- **Mudar a la sección lo que ya hay de IA** (el Modo IA, la consola del Canal con IA, el asesor).
  Es una decisión de producto del usuario, no de esta fase.
- **Unificar el `esAdmin`**, que hoy está repetido en cinco sitios de la app. Sería un refactor
  oportunista; aquí se sigue el mismo patrón.

## Requisitos

- **R-1 — La pestaña, con icono propio.** «IA», entre «Bots» y «Cuenta», con `hardware-chip-outline`
  de ionicons: no lo usa nada más en la app. **No** es `sparkles-outline` a propósito: ese ya marca
  el Modo IA y las recomendaciones del asesor, y una sección que se pintara igual que una de sus
  funciones confundiría a quien busca una o la otra. Cambiarlo es una línea en cada fichero.
- **R-2 — Solo administradores, por tres lados.**
  1. El botón solo se pinta si el rol de la sesión es `ADMIN`, y es reactivo: si el rol cambia con
     la app abierta, la pestaña aparece o desaparece sola.
  2. La ruta lleva `adminGuard`: una URL escrita a mano devuelve a `/tabs/bots`, igual que `/admin`.
  3. La pantalla no pinta nada si su sesión deja de ser de administrador con la pestaña ya creada
     (Ionic conserva vivas las páginas de las pestañas).

  Los tres son **comodidad, no seguridad**: el rol sale de los claims del token que guarda el propio
  navegador. La autoridad será el servidor (R-3).
- **R-3 — El contrato que hereda cada fase siguiente.**
  - Todo endpoint de la sección va bajo `@UseGuards(JwtAuthGuard, RolesGuard)` y `@Roles('ADMIN')`
    **a nivel de clase**, y su controlador entra en la lista de `admin/admin-guards.spec.ts`, que es
    la que comprueba que ninguno nace sin guardas.
  - La app maneja el `403` con `<app-admin-forbidden />`, como las pantallas de `/admin`.
  - Si una fase da poder sobre dinero, configuración o bots, el rol se lee **de la base** en cada
    uso (como `esAdministradorHabilitado()` de `bots.service.ts`, que mira también `disabled`),
    no solo del token: el token vive 15 minutos.
  - Los invariantes de `CLAUDE.md` valen dentro igual que fuera; en especial el 13 —ninguna IA
    escribe configuración ni fija un número por su cuenta— y el mapa de módulos, que dice que
    `openrouter.client.ts` es el único fichero que habla con un modelo.
- **R-4 — Para los demás no cambia nada**: las mismas cuatro pestañas, en el mismo orden, con las
  mismas rutas.

## Criterios de aceptación

- **CA-1** *(usuario)* Con una cuenta `ADMIN`: cinco pestañas —Cartera, Mercados, Bots, IA,
  Cuenta—, «IA» con el icono del chip, y al tocarla se abre la pantalla de la sección.
- **CA-2** *(usuario)* Con una cuenta normal: las cuatro de siempre; y `/tabs/ia` escrita a mano
  lleva a `/tabs/bots`.
- **CA-3** `pnpm --filter app build` (producción: presupuestos y `strictTemplates`), `pnpm --filter
  app lint` y el tipado de la app, en verde.

## Riesgos

- **Cinco pestañas en un móvil estrecho.** Solo para administradores, y con la etiqueta más corta
  posible. Si molesta, la salida es sacar otra a Cuenta, como se hizo con Ranking.
- **Un ascenso a `ADMIN` tarda en verse**: el rol va en el token, así que la pestaña aparece al
  renovarlo (15 minutos como mucho) o al volver a entrar. Es la misma regla que ya tiene `/admin`.
- **Una pestaña seleccionada que desaparece** (se le retira el rol con la sección abierta): la
  pantalla se queda en blanco por R-2.3 y el resto de pestañas sigue funcionando.

## Referencias oficiales

No aplica: no toca ningún venue ni SDK. El icono es de ionicons 7.4.0, la versión instalada.

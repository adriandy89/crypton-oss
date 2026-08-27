# Política de seguridad

## Reportar una vulnerabilidad

**No abras una *issue* pública.** Usa el aviso privado de GitHub:
*Security* → *Report a vulnerability* en este repositorio.

Cuenta qué has encontrado, cómo reproducirlo y qué crees que se puede conseguir
con ello. Si has escrito una prueba de concepto, adjúntala.

## Qué es especialmente interesante

Este proyecto custodia **claves de firma delegadas** de exchanges. Por orden de
gravedad:

- Cualquier camino que permita **leer o descifrar credenciales** de otra cuenta,
  o sacarlas del proceso (`packages/db`, `apps/api/src/libs/crypto`).
- Aislamiento entre usuarios: que una petición pueda tocar bots, cuentas u
  órdenes que no son suyas. Hay un test dedicado a esto en
  `apps/api/test/isolation.e2e-spec.ts`.
- Fallos en el flujo de acceso: robo de sesión, confusión de identidad en el
  OAuth, tokens que no caducan o no se revocan.
- Que un bot pueda operar sobre una cuenta que no le corresponde, o que la
  reconciliación pueda ser inducida a mandar órdenes que nadie pidió.

## Fuera de alcance

- Que un despliegue mal configurado exponga la API sin TLS o con secretos por
  defecto. El README dice lo que hay que poner; ponerlo es de quien despliega.
- Pérdidas por operar: apalancamiento, liquidaciones y estrategias que se
  comportan como está documentado que se comportan.
- Vulnerabilidades de los propios exchanges o de sus APIs.

## Autoalojado

No hay servicio central ni despliegue oficial: cada instalación es de quien la
levanta. Un arreglo se publica como versión nueva, y actualizar es cosa de cada
operador. Si mantienes un despliegue con usuarios, vigila las publicaciones del
repositorio.

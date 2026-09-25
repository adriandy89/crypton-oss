# 075 — Plan

## Cómo se revisa

1. **Línea base** antes de tocar nada: `pnpm build:packages`, `pnpm test`, `pnpm lint`,
   `pnpm check:env` y `pnpm check:labels`, anotada en `findings.md`.
2. **Seis revisiones independientes en paralelo**, una por área (OP, MO, WK, AP, AC, UI de
   `spec.md`). Cada revisor lee el diff `c7fec40..spec/074-agentes-ia` de su área con la escala de
   severidad de la constitución delante, **no edita nada**, no llama a la red ni lee `.env`, y
   devuelve hallazgos con evidencia `fichero:línea`, escenario y el test que los confirmaría.
3. **Verificación**: cada hallazgo se vuelve a leer en el código antes de anotarlo. Los que no se
   sostienen se descartan con su motivo; los que se repiten entre áreas se funden.
4. **`findings.md`**: resumen, fichas, lo verificado y las preguntas abiertas. Las Críticas quedan
   «por confirmar» hasta tener su test que falla.
5. **Aprobación del usuario** de la lista de Críticas a corregir.
6. **Corrección**, una a una con el protocolo de la constitución: test que falla por el motivo
   declarado, diff enseñado antes de aplicar, arreglo mínimo, tests del paquete y de sus
   dependientes, y un commit `fix(<área>): … (spec 075 F-NN)`.
7. **Seguimientos**: lo Alto, Medio y Bajo va a specs nuevos, que se abren con el visto bueno del
   usuario.

## Ficheros

Solo `specs/075-revision-074/` y el índice de `specs/README.md` hasta el paso 6; en el paso 6, los
que diga el contrato de arreglo de cada Crítica aprobada.

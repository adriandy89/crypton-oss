# 060 — Plan

## Enfoque

1. **Siete revisiones independientes en paralelo**, una por área (EX, MA, ES, WK, IA, AC, UI).
   - Quien revisa no modifica nada del repositorio.
   - Confirma sus hipótesis con scripts contra los `dist` compilados, o con los tests que ya
     existen.
   - Devuelve cada hallazgo con severidad, evidencia, escenario, confianza y arreglo propuesto.
2. **Una revisión transversal propia**, de lo que cruza áreas: el contrato de `bot_ai_intents`
   entre el worker, la API y la migración, y los estados que podrían bloquear un bot.
3. **Verificación de cada hallazgo** antes de anotarlo:
   - se lee el camino entero;
   - si se puede, un test que falla por el motivo declarado confirma el hallazgo;
   - lo que no se sostiene se descarta con su motivo.
4. **`findings.md`**, con la numeración `F-NN` del spec y el id de la revisión de origen.
5. **Aprobación del usuario** sobre qué se corrige. Después, el protocolo de la constitución, un
   hallazgo por commit:
   1. test que falla;
   2. arreglo mínimo;
   3. tests del paquete y de sus dependientes;
   4. mutación del arreglo.
6. **Verificación completa y cierre.**

## Lo que no cambia

- **Sin tocar lo que no pida un hallazgo:** ni valores por defecto ni la semántica de un
  parámetro.
- **Sin migraciones nuevas.** Una Crítica que la exija recibe una mitigación y su propio spec.
- **Sin llamadas firmadas ni al modelo.**

## Verificación

- Jest desde Git Bash, con `pnpm build:packages` antes.
- Paquete a paquete: tests, `pnpm lint`, `pnpm check:env` y las builds de la API, el worker y la
  app.
- `tsc` de la API y del worker, y los fines de línea con `eol.cjs`.

## Fase 2 (tras la simulación del usuario)

Revisión de al menos 100 decisiones reales:
- motivos de `SIN_ENTRADA` y `FALLIDA`;
- coste por consulta;
- latencia del stop tras el llenado;
- retraso de la vela;
- límites que se acercaron al tope.

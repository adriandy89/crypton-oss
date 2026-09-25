# oss-001 — Tareas

- [x] Spec, plan y fila del índice, con la numeración propia de esta edición (`aff9a96`)
- [x] `objetos-a-mano.spec.ts` y verlo fallar por los cinco objetos (CA-1): los cinco con
  `creado: false`
- [x] La migración `20260924150000_objetos_perdidos_del_init` y el test en verde (CA-1): 6 de 6.
  Cuatro sabotajes de la migración —sin `dry_run = false`, un estado de menos en el índice único, el
  `CHECK` de credenciales al revés y un `DROP INDEX` después de crear el de la bitácora— los caza
  cada uno (`229dd6d`)
- [x] Bases temporales con `psql`: el defecto a la vista —dos bots reales `RUNNING` en el mismo par
  entran sin la migración— y los abortos con su mensaje y la base intacta, por los bots y por cada
  `CHECK` (CA-2, CA-3, CA-5)
- [x] Bases temporales con `psql`: la migración aplicada; volver a arrancar el parado o un tercero
  real en el mismo par falla por `uq_bot_live_account_symbol`, dos simulados vivos, dos reales
  parados o uno en otro par pasan, las conexiones que rompen los `CHECK` ya no entran y aplicarla dos
  veces sale bien (CA-4, CA-5, R-2)
- [x] `prisma migrate deploy` y `prisma migrate status` de la cadena entera, con una base y un rol
  temporales; por Prisma, el aborto enseña su mensaje (`P3018`), la base no cambia, y
  `migrate resolve --rolled-back` más otro `deploy` la aplican (CA-6). La primera versión, con
  `BEGIN`/`COMMIT`, enseñaba «current transaction is aborted»: por eso va sin ellos
- [x] `pg_dump` de las dos cadenas comparado tabla a tabla sin el orden de columnas: solo los
  planes y el nombre de la clave de `paper_states` (CA-7)
- [x] Tests de la API (6262 en 87 suites), `pnpm lint` sin errores, `tsc` de la API con los tests y
  los builds de la API y el worker (CA-8)
- [x] La trampa, en `CLAUDE.md` de esta edición
- [x] Commits en la rama y a `main` de esta edición, sin push

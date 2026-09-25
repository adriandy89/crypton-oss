-- Spec 080: los % de RESULTADO pasan a medirse sobre el MARGEN (ROI), como el
-- TP/SL por ROI de un exchange apalancado: precio = entrada x (1 +- ROI/L).
--
-- Hasta aqui eran % del PRECIO. Esta migracion convierte UNA vez lo guardado:
-- el valor nuevo es el viejo por el apalancamiento de su propia configuracion,
-- asi que a ese apalancamiento el bot hace exactamente lo mismo que antes.
-- Un "5" a 2x pasa a "10"; un 5 a 3x, a 15. El tipo se conserva: un texto
-- sigue siendo texto y un numero, numero. Vacios y nulos no se tocan.
--
-- Los campos son los que llevan `roi` en su FieldMeta (lo fija el test
-- `validacion-roi.spec.ts` de strategy-core, contra esta misma lista):
--   stopLossPct     en todas las estrategias;
--   takeProfitPct   en MARTINGALE, TDCA y TRAILING_PROFIT;
--   satelliteTpPct  en GRIDMART.
-- GRIDMART pierde ademas `takeProfitPct` y `tpMode`, que no gobernaban ninguna
-- orden (P-7).
--
-- Donde:
--   bot_config_revisions.config y .diff     con config.leverage, si no bots.leverage
--   bot_ai_decisions.proposed_config y .diff con proposed_config.leverage, si no bots.leverage
--   bot_shares.config_blob.params           con params.leverage, si no bots.leverage
--   backtest_runs.config                    con config.leverage, si no el de su bot
-- En un diff, el `from` de un cambio se mide con el apalancamiento de antes si
-- el mismo cambio lo movio. Los registros (bot_events, activity_log,
-- bot_commands, raw y dossier del supervisor) no se tocan: cuentan lo que paso
-- con la semantica de entonces.
--
-- 1. NO se migra con un bot en marcha, real o simulado: sus stops y objetivos
--    cambiarian de precio con la posicion abierta. Si lo hay, aborta ANTES de
--    cambiar nada. Para seguir: pararlo con la version anterior, marcar esta
--    migracion como revertida
--      prisma migrate resolve --rolled-back 20260925120000_roi_sobre_margen
--    y volver a desplegar. Al arrancarlo de nuevo, START valida la
--    configuracion ya convertida contra el mercado de hoy (P-5).
-- 2. Tampoco si un valor que convertir no tiene un apalancamiento con el que
--    hacerlo: convertirlo con uno supuesto seria inventarse el stop.
--
-- Sin BEGIN/COMMIT: Prisma manda el guion en una sola consulta y Postgres la
-- ejecuta como una transaccion implicita; el primer RAISE la deshace entera y
-- su mensaje llega tal cual. Con psql, ejecutarla con -1.

DO $$
DECLARE
  vivos INTEGER;
  cuales TEXT;
BEGIN
  SELECT count(*),
         string_agg(format('%s (%s, %s)', "name", "strategy", "status"), '; ' ORDER BY "created_at")
    INTO vivos, cuales
    FROM "bots"
   WHERE "status" IN ('STARTING', 'RUNNING', 'PAUSED', 'STOPPING');
  IF vivos > 0 THEN
    RAISE EXCEPTION 'Hay % bot(s) en marcha: %. Paralos con la version anterior antes de desplegar esta: sus stops y objetivos cambiarian de precio con la posicion abierta (spec 080).', vivos, cuales;
  END IF;
END $$;

-- Un numero de la configuracion, venga como numero o como texto. NULL si no lo es.
CREATE FUNCTION pg_temp._num(v JSONB) RETURNS NUMERIC
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  n NUMERIC;
BEGIN
  IF v IS NULL OR jsonb_typeof(v) NOT IN ('number', 'string') THEN
    RETURN NULL;
  END IF;
  BEGIN
    n := nullif(btrim(v #>> '{}'), '')::NUMERIC;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN NULL;
  END;
  IF n IS NULL OR n = 'NaN'::NUMERIC OR n IN ('Infinity'::NUMERIC, '-Infinity'::NUMERIC) THEN
    RETURN NULL;
  END IF;
  RETURN n;
END $$;

-- El apalancamiento con el que convertir: el de la configuracion y, si no
-- trae uno valido, el de respaldo. NULL si ninguno es positivo.
CREATE FUNCTION pg_temp._lev(cfg JSONB, respaldo NUMERIC) RETURNS NUMERIC
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  propio NUMERIC := CASE WHEN jsonb_typeof(cfg) = 'object' THEN pg_temp._num(cfg -> 'leverage') END;
BEGIN
  IF propio > 0 THEN
    RETURN propio;
  END IF;
  IF respaldo > 0 THEN
    RETURN respaldo;
  END IF;
  RETURN NULL;
END $$;

-- v por lev, conservando el tipo. Lo que no es un numero sale tal cual.
CREATE FUNCTION pg_temp._por(v JSONB, lev NUMERIC) RETURNS JSONB
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  n NUMERIC := pg_temp._num(v);
BEGIN
  IF n IS NULL OR lev IS NULL THEN
    RETURN v;
  END IF;
  IF jsonb_typeof(v) = 'number' THEN
    RETURN to_jsonb(trim_scale(n * lev));
  END IF;
  RETURN to_jsonb(trim_scale(n * lev)::TEXT);
END $$;

-- Los campos de % de resultado de cada estrategia.
CREATE FUNCTION pg_temp._claves(estrategia TEXT) RETURNS TEXT[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN estrategia IN ('MARTINGALE', 'TDCA', 'TRAILING_PROFIT') THEN ARRAY['stopLossPct', 'takeProfitPct']
    WHEN estrategia = 'GRIDMART' THEN ARRAY['stopLossPct', 'satelliteTpPct']
    ELSE ARRAY['stopLossPct']
  END
$$;

-- Una configuracion convertida.
CREATE FUNCTION pg_temp._cfg(cfg JSONB, estrategia TEXT, lev NUMERIC) RETURNS JSONB
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  k TEXT;
  r JSONB := cfg;
BEGIN
  IF cfg IS NULL OR jsonb_typeof(cfg) <> 'object' THEN
    RETURN cfg;
  END IF;
  IF estrategia = 'GRIDMART' THEN
    r := r - 'takeProfitPct' - 'tpMode';
  END IF;
  FOREACH k IN ARRAY pg_temp._claves(estrategia) LOOP
    IF r ? k THEN
      r := jsonb_set(r, ARRAY[k], pg_temp._por(r -> k, lev));
    END IF;
  END LOOP;
  RETURN r;
END $$;

-- Un diff convertido: [{key, from, to, mutability, labelKey}, ...].
CREATE FUNCTION pg_temp._diff(diff JSONB, estrategia TEXT, lev NUMERIC) RETURNS JSONB
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  lev_antes NUMERIC := lev;
  e JSONB;
  r JSONB := '[]'::JSONB;
BEGIN
  IF diff IS NULL OR jsonb_typeof(diff) <> 'array' THEN
    RETURN diff;
  END IF;
  -- Si el mismo cambio movio el apalancamiento, el `from` se midio con el de antes.
  SELECT coalesce(pg_temp._lev(jsonb_build_object('leverage', x -> 'from'), NULL), lev)
    INTO lev_antes
    FROM jsonb_array_elements(diff) x
   WHERE x ->> 'key' = 'leverage'
   LIMIT 1;
  IF lev_antes IS NULL THEN
    lev_antes := lev;
  END IF;
  FOR e IN SELECT x FROM jsonb_array_elements(diff) x LOOP
    IF estrategia = 'GRIDMART' AND e ->> 'key' IN ('takeProfitPct', 'tpMode') THEN
      CONTINUE;
    END IF;
    IF jsonb_typeof(e) = 'object' AND e ->> 'key' = ANY (pg_temp._claves(estrategia)) THEN
      IF e ? 'from' THEN
        e := jsonb_set(e, '{from}', pg_temp._por(e -> 'from', lev_antes));
      END IF;
      IF e ? 'to' THEN
        e := jsonb_set(e, '{to}', pg_temp._por(e -> 'to', lev));
      END IF;
    END IF;
    r := r || jsonb_build_array(e);
  END LOOP;
  RETURN r;
END $$;

-- Hay algo que convertir? Un campo de resultado con numero en la
-- configuracion, o en un cambio del diff.
CREATE FUNCTION pg_temp._necesita(cfg JSONB, diff JSONB, estrategia TEXT) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
  SELECT
    (jsonb_typeof(cfg) = 'object' AND EXISTS (
      SELECT 1 FROM unnest(pg_temp._claves(estrategia)) k
       WHERE pg_temp._num(cfg -> k) IS NOT NULL))
    OR
    (jsonb_typeof(diff) = 'array' AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(diff) x
       WHERE jsonb_typeof(x) = 'object'
         AND x ->> 'key' = ANY (pg_temp._claves(estrategia))
         AND (pg_temp._num(x -> 'from') IS NOT NULL OR pg_temp._num(x -> 'to') IS NOT NULL)))
$$;

DO $$
DECLARE
  sin INTEGER;
BEGIN
  SELECT
    (SELECT count(*)
       FROM "bot_config_revisions" r JOIN "bots" b ON b."id" = r."bot_id"
      WHERE pg_temp._necesita(r."config", r."diff", b."strategy"::TEXT)
        AND pg_temp._lev(r."config", b."leverage") IS NULL)
  + (SELECT count(*)
       FROM "bot_ai_decisions" d JOIN "bots" b ON b."id" = d."bot_id"
      WHERE pg_temp._necesita(d."proposed_config", d."diff", b."strategy"::TEXT)
        AND pg_temp._lev(d."proposed_config", b."leverage") IS NULL)
  + (SELECT count(*)
       FROM "bot_shares" s JOIN "bots" b ON b."id" = s."bot_id"
      WHERE pg_temp._necesita(s."config_blob" -> 'params', NULL, b."strategy"::TEXT)
        AND pg_temp._lev(s."config_blob" -> 'params', b."leverage") IS NULL)
  + (SELECT count(*)
       FROM "backtest_runs" t
      WHERE pg_temp._necesita(t."config", NULL, t."strategy"::TEXT)
        AND pg_temp._lev(t."config",
              (SELECT b."leverage" FROM "bots" b WHERE b."id" = t."bot_id")) IS NULL)
    INTO sin;
  IF sin > 0 THEN
    RAISE EXCEPTION 'Hay % fila(s) con un %% de resultado y sin apalancamiento con el que convertirlo. Revisalas a mano antes de desplegar (spec 080).', sin;
  END IF;
END $$;

UPDATE "bot_config_revisions" r
   SET "config" = pg_temp._cfg(r."config", b."strategy"::TEXT, pg_temp._lev(r."config", b."leverage")),
       "diff" = pg_temp._diff(r."diff", b."strategy"::TEXT, pg_temp._lev(r."config", b."leverage"))
  FROM "bots" b
 WHERE b."id" = r."bot_id"
   AND (pg_temp._necesita(r."config", r."diff", b."strategy"::TEXT) OR b."strategy" = 'GRIDMART');

UPDATE "bot_ai_decisions" d
   SET "proposed_config" = pg_temp._cfg(d."proposed_config", b."strategy"::TEXT,
                             pg_temp._lev(d."proposed_config", b."leverage")),
       "diff" = pg_temp._diff(d."diff", b."strategy"::TEXT,
                  pg_temp._lev(d."proposed_config", b."leverage"))
  FROM "bots" b
 WHERE b."id" = d."bot_id"
   AND (pg_temp._necesita(d."proposed_config", d."diff", b."strategy"::TEXT) OR b."strategy" = 'GRIDMART');

UPDATE "bot_shares" s
   SET "config_blob" = jsonb_set(s."config_blob", '{params}',
         pg_temp._cfg(s."config_blob" -> 'params', b."strategy"::TEXT,
           pg_temp._lev(s."config_blob" -> 'params', b."leverage")))
  FROM "bots" b
 WHERE b."id" = s."bot_id"
   AND jsonb_typeof(s."config_blob" -> 'params') = 'object'
   AND (pg_temp._necesita(s."config_blob" -> 'params', NULL, b."strategy"::TEXT) OR b."strategy" = 'GRIDMART');

UPDATE "backtest_runs" t
   SET "config" = pg_temp._cfg(t."config", t."strategy"::TEXT,
         pg_temp._lev(t."config", (SELECT b."leverage" FROM "bots" b WHERE b."id" = t."bot_id")))
 WHERE pg_temp._necesita(t."config", NULL, t."strategy"::TEXT) OR t."strategy" = 'GRIDMART';

DROP FUNCTION pg_temp._necesita(JSONB, JSONB, TEXT);
DROP FUNCTION pg_temp._diff(JSONB, TEXT, NUMERIC);
DROP FUNCTION pg_temp._cfg(JSONB, TEXT, NUMERIC);
DROP FUNCTION pg_temp._claves(TEXT);
DROP FUNCTION pg_temp._por(JSONB, NUMERIC);
DROP FUNCTION pg_temp._lev(JSONB, NUMERIC);
DROP FUNCTION pg_temp._num(JSONB);

-- 03_views.sql
-- Views that make Icechunk data queryable from standard Snowflake SQL

USE DATABASE ICECHUNK_DB;
USE SCHEMA ICECHUNK;

-- ── Temperature view ──────────────────────────────────────────────────────────
-- Returns the latest full global temperature snapshot for a 24-hour window.
-- Adjust time_start/time_end and lat/lon ranges as needed.
CREATE OR REPLACE VIEW CLIMATE_TEMPERATURE AS
WITH raw AS (
  SELECT ICECHUNK_SLICE(
    'temperature',
    '2024-01-01T00:00:00',
    '2024-01-01T23:00:00',
    -90, 90,
    -180, 180
  ) AS result
),
flat AS (
  SELECT f.value AS row
  FROM raw, LATERAL FLATTEN(input => result:data) f
)
SELECT
  row:time::TIMESTAMP_NTZ  AS observation_time,
  row:lat::FLOAT           AS latitude,
  row:lon::FLOAT           AS longitude,
  row:value::FLOAT         AS temperature_k,
  (row:value::FLOAT - 273.15) AS temperature_c,
  result:snapshot_id::VARCHAR AS snapshot_id
FROM flat, raw;


-- ── Generic parameterized helper procedure ────────────────────────────────────
-- Call this to get any variable for any region/time range and insert into a temp table
CREATE OR REPLACE PROCEDURE ICECHUNK_QUERY(
  P_VARIABLE VARCHAR,
  P_TIME_START VARCHAR,
  P_TIME_END VARCHAR,
  P_LAT_MIN FLOAT,
  P_LAT_MAX FLOAT,
  P_LON_MIN FLOAT,
  P_LON_MAX FLOAT
)
RETURNS TABLE (observation_time TIMESTAMP_NTZ, latitude FLOAT, longitude FLOAT, variable VARCHAR, value FLOAT, snapshot_id VARCHAR)
LANGUAGE SQL
AS
$$
DECLARE
  res RESULTSET DEFAULT (
    WITH raw AS (
      SELECT ICECHUNK_SLICE(
        :P_VARIABLE, :P_TIME_START, :P_TIME_END,
        :P_LAT_MIN, :P_LAT_MAX, :P_LON_MIN, :P_LON_MAX
      ) AS result
    ),
    flat AS (
      SELECT f.value AS row, result:snapshot_id::VARCHAR AS snapshot_id
      FROM raw, LATERAL FLATTEN(input => result:data) f
    )
    SELECT
      row:time::TIMESTAMP_NTZ AS observation_time,
      row:lat::FLOAT          AS latitude,
      row:lon::FLOAT          AS longitude,
      row:variable::VARCHAR   AS variable,
      row:value::FLOAT        AS value,
      snapshot_id
    FROM flat
  );
BEGIN
  RETURN TABLE(res);
END;
$$;


-- ── Example queries ───────────────────────────────────────────────────────────

-- 1. Temperature over UK for Jan 1 2024
-- CALL ICECHUNK_QUERY('temperature','2024-01-01T00:00:00','2024-01-01T23:00:00',
--                      49,61,-8,2);

-- 2. Pressure over equatorial band
-- CALL ICECHUNK_QUERY('pressure','2024-06-01T00:00:00','2024-06-01T11:00:00',
--                      -10,10,-180,180);

-- 3. Humidity over continental US
-- CALL ICECHUNK_QUERY('humidity','2024-07-04T00:00:00','2024-07-04T23:00:00',
--                      24,50,-125,-66);

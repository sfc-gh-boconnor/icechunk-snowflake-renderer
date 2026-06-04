-- =============================================================================
-- IceChunk Accelerator — Weather Cortex Agent  v1.0
-- =============================================================================
-- Creates 3 tool stored procedures and a Cortex Agent that can answer
-- natural-language questions about Met Office weather data in the IceChunk store.
--
-- Usage:
--   snow sql -f 05_create_agent.sql -c <CONNECTION>
--
-- Prerequisites:
--   01_snowflake_setup.sql  — creates ICECHUNK_DB role + CORTEX_USER grant
--   03_deploy_services.sql  — services must be running (tool procedures call them)
-- =============================================================================

USE ROLE SYSADMIN;
USE SCHEMA ICECHUNK_DB.ICECHUNK;
USE WAREHOUSE XSMALL;

-- =============================================================================
-- TOOL 1: TOOL_WEATHER_META
-- Returns available variables, latest snapshot, grid dimensions.
-- Useful for "what data is available?" questions.
-- =============================================================================
CREATE OR REPLACE PROCEDURE ICECHUNK_DB.ICECHUNK.TOOL_WEATHER_META()
RETURNS VARIANT
LANGUAGE SQL
AS
$$
DECLARE
    result VARIANT;
BEGIN
    SELECT PARSE_JSON(ICECHUNK_DB.ICECHUNK.ICECHUNK_META()) INTO result;
    RETURN OBJECT_CONSTRUCT(
        'variables',        result:variables,
        'latest_snapshot',  result:latest_snapshot,
        'tags',             result:tags,
        'grid',             result:grid,
        'status',           'SUCCESS'
    );
EXCEPTION
    WHEN OTHER THEN
        RETURN OBJECT_CONSTRUCT('error', SQLERRM, 'status', 'FAILED');
END;
$$;

-- =============================================================================
-- TOOL 2: TOOL_WEATHER_SLICE
-- Geocodes a natural language region description, then queries IceChunk for
-- summary statistics (min/max/avg/count) for a specific weather variable.
-- Returns aggregated stats rather than raw rows to fit in agent context window.
-- =============================================================================
CREATE OR REPLACE PROCEDURE ICECHUNK_DB.ICECHUNK.TOOL_WEATHER_SLICE(
    REGION_DESCRIPTION  VARCHAR,
    VARIABLE            VARCHAR,
    SNAPSHOT_ID         VARCHAR DEFAULT NULL
)
RETURNS VARIANT
LANGUAGE PYTHON
RUNTIME_VERSION = '3.11'
PACKAGES = ('snowflake-snowpark-python')
HANDLER = 'run'
AS
$$
import json

# Unit conversions for human-readable output
UNIT_INFO = {
    'air_temperature':              {'unit': '°C',    'transform': 'value - 273.15',    'round': 1},
    'wind_speed_at_10m':            {'unit': 'm/s',   'transform': 'value',             'round': 1},
    'air_pressure_at_sea_level':    {'unit': 'hPa',   'transform': 'value / 100',       'round': 1},
    'relative_humidity':            {'unit': '%',     'transform': 'value * 100',       'round': 1},
    'lwe_precipitation_rate':       {'unit': 'mm/hr', 'transform': 'value * 3600000',   'round': 3},
    'cloud_amount_of_total_cloud':  {'unit': '%',     'transform': 'value * 100',       'round': 1},
    'cloud_amount_of_high_cloud':   {'unit': '%',     'transform': 'value * 100',       'round': 1},
    'cloud_amount_of_medium_cloud': {'unit': '%',     'transform': 'value * 100',       'round': 1},
    'cloud_amount_of_low_cloud':    {'unit': '%',     'transform': 'value * 100',       'round': 1},
}

def _escape(s):
    return s.replace("'", "''")

def run(session, region_description: str, variable: str, snapshot_id: str = None) -> dict:
    try:
        safe_region = _escape(region_description)
        safe_var    = _escape(variable)

        # Step 1: Use AI_COMPLETE to extract bounding box from natural language
        geocode_sql = f"""
        SELECT AI_COMPLETE(
            'claude-sonnet-4-5',
            'Extract the geographic bounding box for this region as lat/lon coordinates. Region: {safe_region}',
            {{'temperature': 0, 'max_tokens': 300}},
            {{'type': 'json', 'schema': {{
                'type': 'object',
                'properties': {{
                    'lat_min': {{'type': 'number'}}, 'lat_max': {{'type': 'number'}},
                    'lon_min': {{'type': 'number'}}, 'lon_max': {{'type': 'number'}},
                    'region_name': {{'type': 'string'}}
                }},
                'required': ['lat_min','lat_max','lon_min','lon_max']
            }}}}
        ) AS result
        """
        geo_row = session.sql(geocode_sql).collect()[0]['RESULT']
        bbox = json.loads(geo_row) if isinstance(geo_row, str) else geo_row

        if not all(k in bbox for k in ['lat_min', 'lat_max', 'lon_min', 'lon_max']):
            return {'error': f'Could not geocode region: {region_description}', 'status': 'FAILED'}

        snap_expr = f"'{snapshot_id}'" if snapshot_id else 'NULL'
        ui = UNIT_INFO.get(variable, {'unit': 'raw', 'transform': 'value', 'round': 4})
        transform = ui['transform']
        rnd = ui['round']

        # Step 2: Query IceChunk for summary stats (H3 resolution 4 = ~180km cells, lightweight)
        stats_sql = f"""
        SELECT
            ROUND(MIN({transform}), {rnd})  AS min_val,
            ROUND(MAX({transform}), {rnd})  AS max_val,
            ROUND(AVG({transform}), {rnd})  AS avg_val,
            ROUND(STDDEV({transform}), {rnd}) AS std_val,
            COUNT(*)                         AS cell_count
        FROM (
            SELECT f.value:value::FLOAT AS value
            FROM (
                SELECT PARSE_JSON(ICECHUNK_DB.ICECHUNK.ICECHUNK_SLICE_H3(
                    '{safe_var}',
                    {bbox['lat_min']}, {bbox['lat_max']},
                    {bbox['lon_min']}, {bbox['lon_max']},
                    {snap_expr}, 4
                )):data AS d
            ) t,
            LATERAL FLATTEN(input => t.d) f
        ) raw
        """
        stats = session.sql(stats_sql).collect()[0]

        if stats['CELL_COUNT'] is None or stats['CELL_COUNT'] == 0:
            return {
                'region': bbox.get('region_name', region_description),
                'bbox':   bbox,
                'variable': variable,
                'error': 'No data found for this region. It may be outside the grid or the variable name is incorrect.',
                'status': 'FAILED'
            }

        return {
            'region':     bbox.get('region_name', region_description),
            'bbox':       bbox,
            'variable':   variable,
            'unit':       ui['unit'],
            'min':        stats['MIN_VAL'],
            'max':        stats['MAX_VAL'],
            'avg':        stats['AVG_VAL'],
            'std':        stats['STD_VAL'],
            'cell_count': stats['CELL_COUNT'],
            'resolution': '~180km H3 grid (res 4)',
            'status':     'SUCCESS'
        }

    except Exception as e:
        return {'error': f'TOOL_WEATHER_SLICE failed: {str(e)}', 'status': 'FAILED'}
$$;

-- =============================================================================
-- TOOL 3: TOOL_WEATHER_SUMMARY
-- Returns summary stats for ALL weather variables in a region.
-- Used for general "what's the weather like in X?" questions.
-- =============================================================================
CREATE OR REPLACE PROCEDURE ICECHUNK_DB.ICECHUNK.TOOL_WEATHER_SUMMARY(
    REGION_DESCRIPTION  VARCHAR,
    SNAPSHOT_ID         VARCHAR DEFAULT NULL
)
RETURNS VARIANT
LANGUAGE PYTHON
RUNTIME_VERSION = '3.11'
PACKAGES = ('snowflake-snowpark-python')
HANDLER = 'run'
AS
$$
import json

VARIABLES = [
    'air_temperature', 'wind_speed_at_10m', 'air_pressure_at_sea_level',
    'relative_humidity', 'lwe_precipitation_rate',
    'cloud_amount_of_total_cloud',
]

UNIT_INFO = {
    'air_temperature':           {'unit': '°C',    'transform': 'v - 273.15', 'round': 1},
    'wind_speed_at_10m':         {'unit': 'm/s',   'transform': 'v',          'round': 1},
    'air_pressure_at_sea_level': {'unit': 'hPa',   'transform': 'v / 100',    'round': 1},
    'relative_humidity':         {'unit': '%',     'transform': 'v * 100',    'round': 1},
    'lwe_precipitation_rate':    {'unit': 'mm/hr', 'transform': 'v * 3600000','round': 3},
    'cloud_amount_of_total_cloud':{'unit': '%',    'transform': 'v * 100',    'round': 1},
}

def _escape(s):
    return s.replace("'", "''")

def run(session, region_description: str, snapshot_id: str = None) -> dict:
    try:
        safe_region = _escape(region_description)

        # Geocode the region
        geocode_sql = f"""
        SELECT AI_COMPLETE(
            'claude-sonnet-4-5',
            'Extract the geographic bounding box for: {safe_region}',
            {{'temperature': 0, 'max_tokens': 300}},
            {{'type': 'json', 'schema': {{
                'type': 'object',
                'properties': {{
                    'lat_min': {{'type': 'number'}}, 'lat_max': {{'type': 'number'}},
                    'lon_min': {{'type': 'number'}}, 'lon_max': {{'type': 'number'}},
                    'region_name': {{'type': 'string'}}
                }},
                'required': ['lat_min','lat_max','lon_min','lon_max']
            }}}}
        ) AS result
        """
        geo_row = session.sql(geocode_sql).collect()[0]['RESULT']
        bbox = json.loads(geo_row) if isinstance(geo_row, str) else geo_row

        snap_expr = f"'{snapshot_id}'" if snapshot_id else 'NULL'
        summary = {}

        for var in VARIABLES:
            ui = UNIT_INFO.get(var, {'unit': 'raw', 'transform': 'v', 'round': 4})
            t = ui['transform'].replace('v', 'f.value:value::FLOAT')
            rnd = ui['round']
            sql = f"""
            SELECT ROUND(AVG({t}), {rnd}) AS avg_val,
                   ROUND(MIN({t}), {rnd}) AS min_val,
                   ROUND(MAX({t}), {rnd}) AS max_val
            FROM (
                SELECT PARSE_JSON(ICECHUNK_DB.ICECHUNK.ICECHUNK_SLICE_H3(
                    '{var}', {bbox['lat_min']}, {bbox['lat_max']},
                    {bbox['lon_min']}, {bbox['lon_max']}, {snap_expr}, 4
                )):data AS d
            ) t, LATERAL FLATTEN(input => t.d) f
            """
            try:
                row = session.sql(sql).collect()[0]
                if row['AVG_VAL'] is not None:
                    summary[var] = {
                        'avg': row['AVG_VAL'],
                        'min': row['MIN_VAL'],
                        'max': row['MAX_VAL'],
                        'unit': ui['unit']
                    }
            except Exception:
                pass  # Skip unavailable variables

        return {
            'region':   bbox.get('region_name', region_description),
            'bbox':     bbox,
            'weather':  summary,
            'status':   'SUCCESS'
        }

    except Exception as e:
        return {'error': f'TOOL_WEATHER_SUMMARY failed: {str(e)}', 'status': 'FAILED'}
$$;

-- =============================================================================
-- WEATHER AGENT: Cortex Agent with 3 tools
-- =============================================================================
CREATE OR REPLACE AGENT ICECHUNK_DB.ICECHUNK.WEATHER_AGENT
COMMENT = 'Weather analysis agent powered by Met Office Global 10km IceChunk data.'
PROFILE = '{"display_name": "Weather Agent", "color": "blue"}'
FROM SPECIFICATION $$
models:
  orchestration: auto
orchestration:
  budget:
    seconds: 120
    tokens: 32000
instructions:
  system: |
    You are a weather analysis assistant powered by Met Office Global Deterministic
    10km forecast data stored in an IceChunk Zarr store on Snowflake.

    The data covers the entire globe at ~10km (0.09°) resolution.

    Available variables (always call tool_weather_meta for the current list):
    - air_temperature: raw values in Kelvin (K). Convert to °C by subtracting 273.15.
    - wind_speed_at_10m: metres per second (m/s). Beaufort scale: 0-1=calm, 3-7=gentle/moderate breeze, 10+=storm.
    - air_pressure_at_sea_level: Pascals (Pa). Convert to hPa by dividing by 100. Normal sea level = 1013 hPa.
    - relative_humidity: fraction 0-1. Multiply by 100 for percentage.
    - lwe_precipitation_rate: kg/m²/s. Multiply by 3,600,000 for mm/hr.
    - cloud_amount_of_total_cloud: fraction 0-1. Multiply by 100 for percentage.

    CRITICAL RULES:
    1. ALWAYS call a tool for any weather data question. NEVER guess or use training knowledge.
    2. Report values with proper units and human-readable conversions.
    3. When coordinates are provided (e.g. from a map click), use them directly in the region description.
    4. If a tool returns status FAILED, report the exact error without supplementing from your knowledge.
    5. For general "what's the weather like in X" questions use tool_weather_summary.
    6. For specific variable questions ("what is the temperature in X") use tool_weather_slice.
    7. Use tool_weather_meta when asked what data is available.

  response: |
    Be concise and informative. Always show:
    - Values with correct units after conversion
    - Min/max range alongside the average when available
    - A brief interpretation (e.g. "14°C is mild for early June")
    Format numbers to 1 decimal place for temperatures, pressures and wind speeds.

  orchestration: |
    - General weather questions ("what's the weather in X", "how is the weather"): tool_weather_summary
    - Specific variable ("temperature in X", "wind speed over Y", "is it raining in Z"): tool_weather_slice
    - Metadata / available data ("what variables", "what data do you have"): tool_weather_meta
    - If lat/lon coordinates are provided, build region as "lat X.XX lon Y.YY" and ±0.5° bbox
    - Always use tools. Never answer weather questions from training data.

tools:
  - tool_spec:
      type: generic
      name: tool_weather_meta
      description: "Get available weather variables, latest snapshot ID, and global grid information. Call this when asked what data is available."
      input_schema:
        type: object
        properties: {}
  - tool_spec:
      type: generic
      name: tool_weather_slice
      description: "Get summary statistics (min, max, average, std deviation) for a single weather variable in a geographic region. Geocodes the region description automatically."
      input_schema:
        type: object
        properties:
          region_description:
            type: string
            description: "Region name or lat/lon description, e.g. 'United Kingdom', 'Tokyo area', 'lat 51.5 lon -0.12'"
          variable:
            type: string
            description: "Variable name: air_temperature, wind_speed_at_10m, air_pressure_at_sea_level, relative_humidity, lwe_precipitation_rate, cloud_amount_of_total_cloud"
          snapshot_id:
            type: string
            description: "Snapshot ID from the IceChunk store (optional, omit for latest)"
        required: [region_description, variable]
  - tool_spec:
      type: generic
      name: tool_weather_summary
      description: "Get a full weather summary (all variables) for a region. Use for general weather questions like 'what is the weather like in Paris?'"
      input_schema:
        type: object
        properties:
          region_description:
            type: string
            description: "Region name or description, e.g. 'Paris', 'southern England', 'lat 48.8 lon 2.3'"
          snapshot_id:
            type: string
            description: "Snapshot ID (optional, omit for latest)"
        required: [region_description]

tool_resources:
  tool_weather_meta:
    type: procedure
    identifier: ICECHUNK_DB.ICECHUNK.TOOL_WEATHER_META
    execution_environment:
      type: warehouse
      warehouse: XSMALL
  tool_weather_slice:
    type: procedure
    identifier: ICECHUNK_DB.ICECHUNK.TOOL_WEATHER_SLICE
    execution_environment:
      type: warehouse
      warehouse: XSMALL
  tool_weather_summary:
    type: procedure
    identifier: ICECHUNK_DB.ICECHUNK.TOOL_WEATHER_SUMMARY
    execution_environment:
      type: warehouse
      warehouse: XSMALL
$$;

-- =============================================================================
-- Grants
-- =============================================================================

-- ── SYSADMIN (admin access) ───────────────────────────────────────────────────
GRANT USAGE ON PROCEDURE ICECHUNK_DB.ICECHUNK.TOOL_WEATHER_META() TO ROLE SYSADMIN;
GRANT USAGE ON PROCEDURE ICECHUNK_DB.ICECHUNK.TOOL_WEATHER_SLICE(VARCHAR,VARCHAR,VARCHAR) TO ROLE SYSADMIN;
GRANT USAGE ON PROCEDURE ICECHUNK_DB.ICECHUNK.TOOL_WEATHER_SUMMARY(VARCHAR,VARCHAR) TO ROLE SYSADMIN;
GRANT USAGE ON AGENT ICECHUNK_DB.ICECHUNK.WEATHER_AGENT TO ROLE SYSADMIN;

-- ── ICECHUNK_DB (the SPCS service identity user role) ─────────────────────────
-- Required so the icechunk-accelerator service can call the Cortex Agent API
-- with the ICECHUNK service token.
GRANT USAGE ON AGENT ICECHUNK_DB.ICECHUNK.WEATHER_AGENT
    TO ROLE ICECHUNK_DB;
GRANT USAGE ON PROCEDURE ICECHUNK_DB.ICECHUNK.TOOL_WEATHER_META()
    TO ROLE ICECHUNK_DB;
GRANT USAGE ON PROCEDURE ICECHUNK_DB.ICECHUNK.TOOL_WEATHER_SLICE(VARCHAR,VARCHAR,VARCHAR)
    TO ROLE ICECHUNK_DB;
GRANT USAGE ON PROCEDURE ICECHUNK_DB.ICECHUNK.TOOL_WEATHER_SUMMARY(VARCHAR,VARCHAR)
    TO ROLE ICECHUNK_DB;

-- ── Cortex AI access ──────────────────────────────────────────────────────────
-- Grants the ICECHUNK_DB role permission to call Cortex LLM functions
-- (AI_COMPLETE, CORTEX.COMPLETE) used inside the tool procedures and agent.
-- Without this the agent API returns 0 chars with no error.
GRANT DATABASE ROLE SNOWFLAKE.CORTEX_USER TO ROLE ICECHUNK_DB;

SELECT 'Weather agent created. Test with: CALL TOOL_WEATHER_META();' AS status;

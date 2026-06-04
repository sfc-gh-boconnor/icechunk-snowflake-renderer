-- 02_external_function.sql
-- Snowflake external function that calls the SPCS /snowflake/slice endpoint

USE DATABASE ICECHUNK_DB;
USE SCHEMA ICECHUNK;

-- The Snowflake external function — calls /snowflake/slice on the SPCS service
-- Replace <INGRESS_URL> with the actual ingress URL
CREATE OR REPLACE EXTERNAL FUNCTION ICECHUNK_SLICE(
  variable       VARCHAR,
  time_start     VARCHAR,
  time_end       VARCHAR,
  lat_min        FLOAT,
  lat_max        FLOAT,
  lon_min        FLOAT,
  lon_max        FLOAT
)
RETURNS VARIANT
API_INTEGRATION = ICECHUNK_API_INTEGRATION
AS 'https://<INGRESS_URL>/snowflake/slice';


-- Grant usage to other roles if needed:
-- GRANT USAGE ON FUNCTION ICECHUNK_SLICE(VARCHAR,VARCHAR,VARCHAR,FLOAT,FLOAT,FLOAT,FLOAT)
--   TO ROLE <role_name>;

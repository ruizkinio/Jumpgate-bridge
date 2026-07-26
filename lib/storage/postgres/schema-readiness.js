"use strict";

const { codedError } = require("../repository-utils");
const { PostgresDatabase } = require("./database");
const { firstRow } = require("./repository-helpers");

const REQUIRED_POSTGRES_SCHEMA_MIGRATION = "0011_history_http_receipts";
const REQUIRED_DISPATCH_HISTORY_INDEX = "scrobble_dispatches_history_generation_idx";
const REQUIRED_HISTORY_RESERVATION_INDEX = "history_grants_reservation_expiry_idx";

const SCHEMA_READINESS_QUERY = `
  WITH target_table AS (
    SELECT table_class.oid
      FROM pg_catalog.pg_class AS table_class
      JOIN pg_catalog.pg_namespace AS table_namespace
        ON table_namespace.oid = table_class.relnamespace
     WHERE table_namespace.nspname = current_schema()
       AND table_class.relname = 'scrobble_dispatches'
       AND table_class.relkind IN ('r', 'p')
  ), target_column AS (
    SELECT column_attribute.attnotnull,
           pg_catalog.format_type(
             column_attribute.atttypid,
             column_attribute.atttypmod
           ) AS data_type,
           pg_catalog.pg_get_expr(column_default.adbin, column_default.adrelid) AS column_default
      FROM target_table
      JOIN pg_catalog.pg_attribute AS column_attribute
        ON column_attribute.attrelid = target_table.oid
       AND column_attribute.attname = 'history_generation'
       AND column_attribute.attnum > 0
       AND NOT column_attribute.attisdropped
      LEFT JOIN pg_catalog.pg_attrdef AS column_default
        ON column_default.adrelid = column_attribute.attrelid
       AND column_default.adnum = column_attribute.attnum
  ), target_index AS (
    SELECT index_metadata.indisvalid,
           index_metadata.indisready,
           index_metadata.indisunique,
           index_metadata.indpred IS NULL AS unfiltered,
           index_metadata.indexprs IS NULL AS expression_free,
           index_metadata.indnkeyatts,
           index_metadata.indnatts,
           ARRAY(
             SELECT indexed_attribute.attname
               FROM unnest(index_metadata.indkey::smallint[])
                    WITH ORDINALITY AS indexed_key(attnum, position)
               JOIN pg_catalog.pg_attribute AS indexed_attribute
                 ON indexed_attribute.attrelid = target_table.oid
                AND indexed_attribute.attnum = indexed_key.attnum
              WHERE indexed_key.position <= index_metadata.indnkeyatts
              ORDER BY indexed_key.position
           ) AS key_columns
      FROM target_table
      JOIN pg_catalog.pg_index AS index_metadata
        ON index_metadata.indrelid = target_table.oid
      JOIN pg_catalog.pg_class AS index_class
        ON index_class.oid = index_metadata.indexrelid
       AND index_class.relname = '${REQUIRED_DISPATCH_HISTORY_INDEX}'
  ), receipt_columns AS (
    SELECT table_class.relname AS table_name,
           column_attribute.attname AS column_name,
           column_attribute.attnotnull,
           pg_catalog.format_type(
             column_attribute.atttypid,
             column_attribute.atttypmod
           ) AS data_type,
           pg_catalog.pg_get_expr(column_default.adbin, column_default.adrelid) AS column_default
      FROM pg_catalog.pg_class AS table_class
      JOIN pg_catalog.pg_namespace AS table_namespace
        ON table_namespace.oid = table_class.relnamespace
      JOIN pg_catalog.pg_attribute AS column_attribute
        ON column_attribute.attrelid = table_class.oid
       AND column_attribute.attnum > 0
       AND NOT column_attribute.attisdropped
      LEFT JOIN pg_catalog.pg_attrdef AS column_default
        ON column_default.adrelid = column_attribute.attrelid
       AND column_default.adnum = column_attribute.attnum
     WHERE table_namespace.nspname = current_schema()
       AND table_class.relkind IN ('r', 'p')
       AND (
         (table_class.relname = 'history_grants' AND column_attribute.attname IN (
           'reservation_expires_at', 'claim_response_status',
           'claim_response_headers', 'claim_response_body'
         )) OR
         (table_class.relname = 'history_event_receipts' AND column_attribute.attname IN (
           'response_status', 'response_headers', 'response_body'
         ))
       )
  ), receipt_constraints AS (
    SELECT constraint_metadata.conname,
           constraint_metadata.contype,
           constraint_metadata.convalidated
      FROM pg_catalog.pg_constraint AS constraint_metadata
      JOIN pg_catalog.pg_class AS table_class
        ON table_class.oid = constraint_metadata.conrelid
      JOIN pg_catalog.pg_namespace AS table_namespace
        ON table_namespace.oid = table_class.relnamespace
     WHERE table_namespace.nspname = current_schema()
       AND constraint_metadata.conname IN (
         'history_grants_claim_response_shape',
         'history_event_receipts_http_shape'
       )
  ), reservation_index AS (
    SELECT index_metadata.indisvalid,
           index_metadata.indisready,
           index_metadata.indisunique,
           index_metadata.indpred IS NOT NULL AS filtered,
           index_metadata.indexprs IS NULL AS expression_free,
           index_metadata.indnkeyatts,
           index_metadata.indnatts,
           ARRAY(
             SELECT indexed_attribute.attname
               FROM unnest(index_metadata.indkey::smallint[])
                    WITH ORDINALITY AS indexed_key(attnum, position)
               JOIN pg_catalog.pg_attribute AS indexed_attribute
                 ON indexed_attribute.attrelid = table_class.oid
                AND indexed_attribute.attnum = indexed_key.attnum
              WHERE indexed_key.position <= index_metadata.indnkeyatts
              ORDER BY indexed_key.position
           ) AS key_columns
      FROM pg_catalog.pg_class AS table_class
      JOIN pg_catalog.pg_namespace AS table_namespace
        ON table_namespace.oid = table_class.relnamespace
      JOIN pg_catalog.pg_index AS index_metadata
        ON index_metadata.indrelid = table_class.oid
      JOIN pg_catalog.pg_class AS index_class
        ON index_class.oid = index_metadata.indexrelid
       AND index_class.relname = '${REQUIRED_HISTORY_RESERVATION_INDEX}'
     WHERE table_namespace.nspname = current_schema()
       AND table_class.relname = 'history_grants'
       AND table_class.relkind IN ('r', 'p')
  )
  SELECT
    EXISTS (
      SELECT 1 FROM schema_migrations WHERE version = $1
    ) AS migration_applied,
    EXISTS (
      SELECT 1
        FROM target_column
       WHERE attnotnull = true
         AND data_type = 'bigint'
         AND column_default IS NULL
    ) AS history_generation_column_safe,
    EXISTS (
      SELECT 1
        FROM target_index
       WHERE indisvalid = true
         AND indisready = true
         AND indisunique = false
         AND unfiltered = true
         AND expression_free = true
         AND indnkeyatts = 3
         AND indnatts = 3
         AND key_columns = ARRAY['profile_id', 'history_generation', 'status']::name[]
    ) AS history_generation_index_safe,
    (
      SELECT
        count(*) FILTER (WHERE
          table_name = 'history_grants' AND column_name = 'reservation_expires_at' AND
          attnotnull = true AND data_type = 'timestamp with time zone' AND column_default IS NULL
        ) = 1 AND
        count(*) FILTER (WHERE
          table_name = 'history_grants' AND column_name = 'claim_response_status' AND
          attnotnull = false AND data_type = 'integer' AND column_default IS NULL
        ) = 1 AND
        count(*) FILTER (WHERE
          table_name = 'history_grants' AND column_name = 'claim_response_headers' AND
          attnotnull = false AND data_type = 'jsonb' AND column_default IS NULL
        ) = 1 AND
        count(*) FILTER (WHERE
          table_name = 'history_grants' AND column_name = 'claim_response_body' AND
          attnotnull = false AND data_type = 'bytea' AND column_default IS NULL
        ) = 1 AND
        count(*) FILTER (WHERE
          table_name = 'history_event_receipts' AND column_name = 'response_status' AND
          attnotnull = true AND data_type = 'integer' AND column_default IS NULL
        ) = 1 AND
        count(*) FILTER (WHERE
          table_name = 'history_event_receipts' AND column_name = 'response_headers' AND
          attnotnull = true AND data_type = 'jsonb' AND column_default IS NULL
        ) = 1 AND
        count(*) FILTER (WHERE
          table_name = 'history_event_receipts' AND column_name = 'response_body' AND
          attnotnull = true AND data_type = 'bytea' AND column_default IS NULL
        ) = 1
        FROM receipt_columns
    ) AS history_http_columns_safe,
    (
      SELECT count(*) = 2 AND bool_and(contype = 'c' AND convalidated = true)
        FROM receipt_constraints
    ) AS history_http_constraints_safe,
    EXISTS (
      SELECT 1
        FROM reservation_index
       WHERE indisvalid = true
         AND indisready = true
         AND indisunique = false
         AND filtered = true
         AND expression_free = true
         AND indnkeyatts = 3
         AND indnatts = 3
         AND key_columns = ARRAY['reservation_expires_at', 'created_at', 'grant_id']::name[]
    ) AS history_reservation_index_safe
`;

function resolveDatabase(databaseOrOptions) {
  if (databaseOrOptions && typeof databaseOrOptions.query === "function") {
    return databaseOrOptions;
  }
  const options = databaseOrOptions || {};
  if (options.database && typeof options.database.query === "function") {
    return options.database;
  }
  if (options.pool) return new PostgresDatabase({ pool: options.pool });
  throw new TypeError("database is required");
}

function schemaNotReady(message) {
  return codedError("postgres_schema_not_ready", message);
}

async function attestPostgresSchemaReadiness(databaseOrOptions) {
  const database = resolveDatabase(databaseOrOptions);
  const row = firstRow(await database.query(
    SCHEMA_READINESS_QUERY,
    [REQUIRED_POSTGRES_SCHEMA_MIGRATION]
  ));
  if (!row || row.migration_applied !== true) {
    throw schemaNotReady("required PostgreSQL migration is not applied");
  }
  if (row.history_generation_column_safe !== true) {
    throw schemaNotReady("PostgreSQL dispatch history generation column is unsafe");
  }
  if (row.history_generation_index_safe !== true) {
    throw schemaNotReady("PostgreSQL dispatch history generation index is unsafe");
  }
  if (row.history_http_columns_safe !== true) {
    throw schemaNotReady("PostgreSQL history HTTP receipt columns are unsafe");
  }
  if (row.history_http_constraints_safe !== true) {
    throw schemaNotReady("PostgreSQL history HTTP receipt constraints are unsafe");
  }
  if (row.history_reservation_index_safe !== true) {
    throw schemaNotReady("PostgreSQL history reservation expiry index is unsafe");
  }
  return Object.freeze({
    historyGenerationColumn: true,
    historyGenerationIndex: REQUIRED_DISPATCH_HISTORY_INDEX,
    historyHttpColumns: true,
    historyHttpConstraints: true,
    historyReservationIndex: REQUIRED_HISTORY_RESERVATION_INDEX,
    migration: REQUIRED_POSTGRES_SCHEMA_MIGRATION,
  });
}

module.exports = {
  attestPostgresSchemaReadiness,
  REQUIRED_DISPATCH_HISTORY_INDEX,
  REQUIRED_HISTORY_RESERVATION_INDEX,
  REQUIRED_POSTGRES_SCHEMA_MIGRATION,
  SCHEMA_READINESS_QUERY,
};

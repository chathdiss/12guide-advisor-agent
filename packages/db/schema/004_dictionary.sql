-- The IFS data dictionary: which logical units (entities) exist, and which views and columns they have.
--
-- It is loaded from two exports of the IFS dictionary (DICTIONARY_SYS_LU_ACTIVE and DICTIONARY_SYS_VIEW_COLUMN_ACT) with
-- `npm run ingest:dictionary` in packages/knowledge. The Advisor's describe_entity and find_columns tools read it, so an
-- answer about SQL, a Lobby data source or a report uses the names IFS really has: the base table, view and package of an
-- entity, all columns of its view (also the system ones such as OBJID and OBJSTATE) with type and flags, and the joins.
--
-- Every row belongs to a version (for example 'IFS Cloud 25R2'), so two releases can be loaded side by side.
-- The tables are separate from the knowledge base because 380,000 columns would crowd out the documents in a text search.

-- One row per logical unit.
CREATE TABLE IF NOT EXISTS dictionary_lu (
  version        TEXT NOT NULL,
  lu_name        TEXT NOT NULL,                 -- CustomerOrderLine
  module         TEXT NOT NULL DEFAULT '',      -- ORDER
  lu_prompt      TEXT NOT NULL DEFAULT '',      -- Customer Order Line
  base_table     TEXT NOT NULL DEFAULT '',      -- CUSTOMER_ORDER_LINE_TAB
  base_view      TEXT NOT NULL DEFAULT '',      -- CUSTOMER_ORDER_LINE
  base_package   TEXT NOT NULL DEFAULT '',      -- CUSTOMER_ORDER_LINE_API
  enabled_rowkey BOOLEAN NOT NULL DEFAULT FALSE,
  lu_type        TEXT NOT NULL DEFAULT '',      -- Entity, EntityWithState, Enumeration, Utility, SystemService ...
  PRIMARY KEY (version, lu_name)
);

CREATE INDEX IF NOT EXISTS dictionary_lu_lower_idx ON dictionary_lu (version, lower(lu_name));
CREATE INDEX IF NOT EXISTS dictionary_lu_view_idx ON dictionary_lu (version, base_view);
CREATE INDEX IF NOT EXISTS dictionary_lu_prompt_idx ON dictionary_lu (version, lower(lu_prompt));

-- One row per column of a view. An entity has its base view and often more (LOV, PUB, report views ...).
CREATE TABLE IF NOT EXISTS dictionary_column (
  version            TEXT NOT NULL,
  view_name          TEXT NOT NULL,             -- CUSTOMER_ORDER
  column_name        TEXT NOT NULL,             -- DATE_ENTERED
  lu_name            TEXT NOT NULL,
  datatype           TEXT NOT NULL DEFAULT '',  -- STRING(20)/UPPERCASE, NUMBER, DATE/DATETIME ...
  prompt             TEXT NOT NULL DEFAULT '',  -- the label in the user interface
  type_flag          TEXT NOT NULL DEFAULT '',  -- K key, P parent key, A attribute
  required_flag      TEXT NOT NULL DEFAULT '',  -- M mandatory
  insert_flag        TEXT NOT NULL DEFAULT '',  -- I can be given on insert
  update_flag        TEXT NOT NULL DEFAULT '',  -- U can be updated
  lov_flag           TEXT NOT NULL DEFAULT '',  -- L has a list of values
  column_index       INT NOT NULL DEFAULT 0,
  column_reference   TEXT NOT NULL DEFAULT '',  -- the logical unit this column points to: the join (CustOrdCustomer)
  enumeration        TEXT NOT NULL DEFAULT '',
  row_level_security TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (version, view_name, column_name)
);

CREATE INDEX IF NOT EXISTS dictionary_column_lu_idx ON dictionary_column (version, lu_name);
-- the detail entities of an entity: the logical units that have its key as a parent key
CREATE INDEX IF NOT EXISTS dictionary_column_parent_idx ON dictionary_column (version, column_reference) WHERE type_flag = 'P';
-- the words of a column name and its prompt, for "which column holds the planned delivery date"
CREATE INDEX IF NOT EXISTS dictionary_column_words_idx ON dictionary_column
  USING GIN (to_tsvector('simple', replace(column_name, '_', ' ') || ' ' || prompt));

-- Which file was loaded for a version, so that a repeat run skips a file that did not change.
CREATE TABLE IF NOT EXISTS dictionary_load (
  version    TEXT NOT NULL,
  kind       TEXT NOT NULL,                     -- 'lu' or 'column'
  file_hash  TEXT NOT NULL,
  row_count  INT NOT NULL,
  loaded_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (version, kind)
);

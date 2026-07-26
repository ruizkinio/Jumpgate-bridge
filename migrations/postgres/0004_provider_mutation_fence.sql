ALTER TABLE provider_collections
  ADD COLUMN mutation_fence numeric(128, 0) NOT NULL DEFAULT 0,
  ADD CONSTRAINT provider_collections_mutation_fence_nonnegative
    CHECK (mutation_fence >= 0);

CREATE TABLE provider_mutation_fence_counter (
  singleton_id smallint PRIMARY KEY CHECK (singleton_id = 1),
  mutation_fence numeric(128, 0) NOT NULL DEFAULT 0,
  CONSTRAINT provider_mutation_fence_counter_nonnegative
    CHECK (mutation_fence >= 0)
);

INSERT INTO provider_mutation_fence_counter (singleton_id, mutation_fence)
SELECT 1, COALESCE(MAX(mutation_fence), 0)
FROM provider_collections;

CREATE TABLE provider_mutation_protocol (
  singleton_id smallint PRIMARY KEY CHECK (singleton_id = 1),
  enforcement_active boolean NOT NULL DEFAULT false,
  mutations_paused boolean NOT NULL DEFAULT false,
  activated_at timestamptz,
  paused_at timestamptz,
  activation_fence numeric(128, 0),
  CONSTRAINT provider_mutation_protocol_activation_state CHECK (
    (
      enforcement_active = false AND
      activated_at IS NULL AND
      activation_fence IS NULL
    ) OR
    (
      enforcement_active = true AND
      activated_at IS NOT NULL AND
      activation_fence IS NOT NULL AND
      activation_fence >= 0
    )
  ),
  CONSTRAINT provider_mutation_protocol_pause_state CHECK (
    (mutations_paused = false AND paused_at IS NULL) OR
    (mutations_paused = true AND paused_at IS NOT NULL)
  )
);

INSERT INTO provider_mutation_protocol (
  singleton_id,
  enforcement_active,
  mutations_paused,
  activated_at,
  paused_at,
  activation_fence
) VALUES (1, false, false, NULL, NULL, NULL);

CREATE FUNCTION enforce_provider_mutation_protocol()
RETURNS trigger
LANGUAGE plpgsql
AS $body$
DECLARE
  active boolean;
  paused boolean;
  activation_floor numeric(128, 0);
  fence_marker text;
  protocol_marker text;
BEGIN
  SELECT enforcement_active, mutations_paused, activation_fence
    INTO active, paused, activation_floor
    FROM provider_mutation_protocol
   WHERE singleton_id = 1;

  IF active IS NULL OR paused IS NULL THEN
    RAISE EXCEPTION 'provider mutation protocol state is unavailable'
      USING ERRCODE = '55000';
  END IF;
  IF paused THEN
    RAISE EXCEPTION 'provider mutations are paused'
      USING ERRCODE = '55000';
  END IF;
  IF active = false THEN
    RETURN NEW;
  END IF;
  IF activation_floor IS NULL THEN
    RAISE EXCEPTION 'provider mutation protocol state is inconsistent'
      USING ERRCODE = '55000';
  END IF;

  protocol_marker := current_setting('jumpgate.provider_mutation_protocol', true);
  fence_marker := current_setting('jumpgate.provider_mutation_fence', true);
  IF protocol_marker IS DISTINCT FROM '1' OR
     fence_marker IS NULL OR
     fence_marker !~ '^[1-9][0-9]{0,127}$' THEN
    RAISE EXCEPTION 'provider mutation protocol marker is required'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.mutation_fence IS DISTINCT FROM fence_marker::numeric THEN
    RAISE EXCEPTION 'provider mutation fence marker does not match the row'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.mutation_fence <= activation_floor THEN
    RAISE EXCEPTION 'provider mutation fence does not exceed the activation fence'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.mutation_fence < OLD.mutation_fence THEN
    RAISE EXCEPTION 'provider mutation fence cannot move backwards'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$body$;

CREATE TRIGGER provider_collections_mutation_protocol
BEFORE INSERT OR UPDATE ON provider_collections
FOR EACH ROW EXECUTE FUNCTION enforce_provider_mutation_protocol();

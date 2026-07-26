ALTER TABLE provider_collections
  ADD COLUMN mutation_fence TEXT NOT NULL DEFAULT '0' CHECK (
    mutation_fence = '0' OR (
      length(mutation_fence) BETWEEN 1 AND 128 AND
      substr(mutation_fence, 1, 1) GLOB '[1-9]' AND
      mutation_fence NOT GLOB '*[^0-9]*'
    )
  );

CREATE TABLE provider_mutation_fence_counter (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  mutation_fence TEXT NOT NULL DEFAULT '0' CHECK (
    mutation_fence = '0' OR (
      length(mutation_fence) BETWEEN 1 AND 128 AND
      substr(mutation_fence, 1, 1) GLOB '[1-9]' AND
      mutation_fence NOT GLOB '*[^0-9]*'
    )
  )
);

INSERT INTO provider_mutation_fence_counter (singleton_id, mutation_fence)
VALUES (
  1,
  COALESCE(
    (
      SELECT mutation_fence
      FROM provider_collections
      ORDER BY length(mutation_fence) DESC, mutation_fence DESC
      LIMIT 1
    ),
    '0'
  )
);

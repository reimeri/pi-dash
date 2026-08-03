ALTER TABLE workspaces
  ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;

WITH ordered AS (
  SELECT
    id,
    row_number() OVER (
      ORDER BY name COLLATE NOCASE, created_at, id
    ) - 1 AS position
  FROM workspaces
)
UPDATE workspaces
SET sort_order = (
  SELECT ordered.position
  FROM ordered
  WHERE ordered.id = workspaces.id
);

DROP INDEX workspaces_name_order_idx;

CREATE UNIQUE INDEX workspaces_sort_order_unique
  ON workspaces (sort_order);

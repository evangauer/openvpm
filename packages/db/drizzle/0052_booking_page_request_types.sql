-- Preserve legacy published booking pages while moving from implicit "all
-- active types" behavior to explicit requestable type selections. Pages with
-- no active types are unpublished instead of remaining visibly live but
-- returning a closed public route.
WITH legacy_pages AS (
  SELECT
    bp.id,
    COALESCE(
      (
        SELECT jsonb_agg(to_jsonb(at.id::text) ORDER BY at.id)
        FROM appointment_types at
        WHERE at.practice_id = bp.practice_id
          AND at.deleted_at IS NULL
      ),
      '[]'::jsonb
    ) AS active_type_ids
  FROM booking_pages bp
  WHERE bp.deleted_at IS NULL
    AND (
      NOT (bp.config ? 'bookableTypeIds')
      OR bp.config -> 'bookableTypeIds' = 'null'::jsonb
    )
)
UPDATE booking_pages bp
SET
  config = jsonb_set(
    CASE WHEN jsonb_typeof(bp.config) = 'object' THEN bp.config ELSE '{}'::jsonb END,
    '{bookableTypeIds}',
    legacy.active_type_ids,
    true
  ),
  published = CASE
    WHEN jsonb_array_length(legacy.active_type_ids) = 0 THEN false
    ELSE bp.published
  END,
  updated_at = now()
FROM legacy_pages legacy
WHERE bp.id = legacy.id;

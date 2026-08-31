UPDATE messages
SET provider_projection_json = NULL
WHERE provider_projection_json IS NOT NULL
  AND CASE
    WHEN json_valid(provider_projection_json)
      THEN COALESCE(json_extract(provider_projection_json, '$.version'), -1) <> 2
    ELSE 1
  END;

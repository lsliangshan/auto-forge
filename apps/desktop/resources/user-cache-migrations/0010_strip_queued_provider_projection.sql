UPDATE messages
SET provider_projection_json = NULL
WHERE provider_projection_json IS NOT NULL
  AND CASE
    WHEN json_valid(provider_projection_json)
      THEN COALESCE(json_extract(provider_projection_json, '$.version'), -1) <> 2
    ELSE 1
  END;

UPDATE outbox_mutations
SET payload_json = json_remove(payload_json, '$.providerProjection')
WHERE kind = 'message.append'
  AND json_valid(payload_json)
  AND json_type(payload_json, '$.providerProjection') IS NOT NULL;

UPDATE sync_receipt_evidence
SET payload_json = json_remove(payload_json, '$.providerProjection')
WHERE kind = 'message.append'
  AND json_valid(payload_json)
  AND json_type(payload_json, '$.providerProjection') IS NOT NULL;

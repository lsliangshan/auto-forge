-- Permit the new immutable message transition on deployed databases. The
-- replacement autoforge_sync_push definition from the foundation migration is
-- deployed with this migration release and validates the payload strictly.
DO $$
DECLARE constraint_name text;
BEGIN
  SELECT conname INTO constraint_name
  FROM pg_constraint
  WHERE conrelid = 'app_sync_mutations'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%message.append%'
  LIMIT 1;
  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE app_sync_mutations DROP CONSTRAINT %I', constraint_name);
    ALTER TABLE app_sync_mutations ADD CONSTRAINT app_sync_mutations_kind_check CHECK (kind IN (
      'conversation.create', 'conversation.rename', 'conversation.preferences',
      'conversation.delete', 'conversation.restore', 'message.append',
      'message.conversion_block_terminal', 'legacy.import', 'privacy.consent',
      'preferences.update', 'usage.record'
    ));
  END IF;
END $$;

-- Data-preserving rollback.
-- Existing knowledgeBaseIds and knowledgeMode values remain readable and synchronized so
-- rolling back application code cannot strand a newer device's revision chain.
BEGIN;
COMMIT;

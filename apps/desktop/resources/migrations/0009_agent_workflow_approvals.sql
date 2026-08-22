CREATE TABLE agent_workflow_approvals (
  execution_id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  block_id TEXT NOT NULL
);

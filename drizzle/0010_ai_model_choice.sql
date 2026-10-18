ALTER TABLE workspace_settings ADD COLUMN aiModel TEXT NOT NULL DEFAULT 'hosted' CHECK(aiModel IN ('hosted','gemma-v2'));

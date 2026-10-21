-- S1d: the subagent that produced a sidechain turn (joins subagent_meta.agent_id).
-- NULL for main-thread turns. No FK: a subagent file can be scanned before its
-- meta row exists, and workflow subagents have no subagent_meta row.

ALTER TABLE turns ADD COLUMN agent_id TEXT;

-- Migration number: 0004 	 2026-08-16T00:00:00.000Z

-- Standing used to be nicknames or nothing. It is now a mode: 'roles' (the
-- default) hands out a coloured, hoisted role per score tier, 'nicknames' keeps
-- the old " (12)" suffix, 'both' does the two, 'off' does neither.
-- nickname_sync is left in place so an older worker rolling back still reads a
-- valid row, but nothing reads it any more; `standing` decides.
ALTER TABLE guild_settings ADD COLUMN standing TEXT NOT NULL DEFAULT 'roles';

-- Tier key to role snowflake, written by ensureTierRoles. Null until the guild
-- has run a mode that includes roles.
ALTER TABLE guild_settings ADD COLUMN tier_roles_json TEXT;

-- Migration number: 0002 	 2026-08-16T00:00:00.000Z

-- court_channel_id keeps its rows but now means the dashboard channel.
ALTER TABLE guild_settings ADD COLUMN category_id       TEXT;
ALTER TABLE guild_settings ADD COLUMN forum_channel_id  TEXT;
ALTER TABLE guild_settings ADD COLUMN tags_json         TEXT;

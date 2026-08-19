-- Who sees the votes on a case: public lists the voters, anonymous shows only
-- the tally, secret seals even the tally until the verdict.
ALTER TABLE guild_settings ADD COLUMN ballot TEXT NOT NULL DEFAULT 'public';

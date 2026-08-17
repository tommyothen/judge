-- Migration number: 0003 	 2026-08-16T00:00:00.000Z

-- cases.id is global across every guild in the database, so the first case in a
-- new guild used to be announced as Case #4. `number` is the per-guild public
-- name for a case; `id` stays the internal key.
ALTER TABLE cases ADD COLUMN number INTEGER;

UPDATE cases
   SET number = (SELECT COUNT(*)
                   FROM cases AS c2
                  WHERE c2.guild_id = cases.guild_id AND c2.id <= cases.id);

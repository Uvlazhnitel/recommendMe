ALTER TABLE movies ADD COLUMN tmdb_title TEXT;
ALTER TABLE movies ADD COLUMN original_title TEXT;
ALTER TABLE movies ADD COLUMN tmdb_release_year INTEGER;
ALTER TABLE movies ADD COLUMN original_language TEXT;
ALTER TABLE movies ADD COLUMN tmdb_vote_average REAL CHECK (tmdb_vote_average BETWEEN 0 AND 10);
ALTER TABLE movies ADD COLUMN directors_json TEXT CHECK (CASE WHEN json_valid(directors_json) THEN json_type(directors_json) = 'array' ELSE directors_json IS NULL END);
ALTER TABLE movies ADD COLUMN credits_json TEXT CHECK (CASE WHEN json_valid(credits_json) THEN json_type(credits_json) = 'object' ELSE credits_json IS NULL END);
ALTER TABLE movies ADD COLUMN tmdb_enrichment_status TEXT NOT NULL DEFAULT 'pending' CHECK (tmdb_enrichment_status IN ('pending', 'matched', 'not_found', 'ambiguous', 'error'));
ALTER TABLE movies ADD COLUMN tmdb_attempted_at TEXT;

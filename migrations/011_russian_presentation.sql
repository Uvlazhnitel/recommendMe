-- Presentation only: canonical movie facts, recommendation text and journals stay intact.
CREATE TABLE ru_movie_metadata (
  tmdb_id INTEGER PRIMARY KEY CHECK(tmdb_id > 0),
  title TEXT NOT NULL CHECK(length(trim(title)) > 0),
  overview TEXT,
  fetched_at TEXT NOT NULL
) STRICT;
CREATE TABLE ru_recommendation_text (
  recommendation_id INTEGER PRIMARY KEY,
  user_id TEXT NOT NULL,
  movie_id INTEGER NOT NULL,
  source_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','failed','done')),
  why_fit TEXT,
  possible_mismatch TEXT,
  model TEXT,
  usage_json TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(user_id,recommendation_id,movie_id) REFERENCES recommendations(user_id,id,movie_id) ON DELETE CASCADE,
  CHECK(status <> 'done' OR (why_fit IS NOT NULL AND possible_mismatch IS NOT NULL AND length(trim(why_fit)) > 0 AND length(trim(possible_mismatch)) > 0))
) STRICT;

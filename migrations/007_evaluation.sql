CREATE TABLE recommendation_evaluation (
  result_id TEXT PRIMARY KEY,
  saved_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json))
) STRICT;

CREATE TABLE recommendation_outcomes (
  movie_id INTEGER PRIMARY KEY REFERENCES movies(id) ON DELETE RESTRICT,
  recommendation_id INTEGER NOT NULL UNIQUE REFERENCES recommendations(id) ON DELETE RESTRICT,
  watch_recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  first_rating_recorded_at TEXT
) STRICT;

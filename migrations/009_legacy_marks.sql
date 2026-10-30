-- Historical import data is personal. Numeric ratings remain in user_movies.
ALTER TABLE user_movies ADD COLUMN watchlist INTEGER NOT NULL DEFAULT 0 CHECK(watchlist IN (0,1));
CREATE TABLE legacy_import_sources (
 user_id TEXT NOT NULL REFERENCES profiles(id),
 source_key TEXT NOT NULL,
 sha256 TEXT NOT NULL CHECK(length(sha256)=64),
 document_json TEXT NOT NULL CHECK(json_valid(document_json)),
 imported_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 PRIMARY KEY(user_id,source_key)
) STRICT;
CREATE TABLE legacy_movie_marks (
 user_id TEXT NOT NULL,
 source_key TEXT NOT NULL,
 source_id TEXT NOT NULL,
 movie_id INTEGER NOT NULL REFERENCES movies(id),
 sentiment TEXT CHECK(sentiment IN ('liked','disliked','mixed')),
 numeric_override INTEGER NOT NULL DEFAULT 0 CHECK(numeric_override IN (0,1)),
 identity_confirmed INTEGER NOT NULL DEFAULT 0 CHECK(identity_confirmed IN (0,1)),
 PRIMARY KEY(user_id,source_key,source_id),
 FOREIGN KEY(user_id,source_key) REFERENCES legacy_import_sources(user_id,source_key),
 FOREIGN KEY(user_id,movie_id) REFERENCES user_movies(user_id,movie_id)
) STRICT;
CREATE TRIGGER legacy_marks_numeric_insert AFTER INSERT ON user_movies
WHEN NEW.rating_100 IS NOT NULL
BEGIN UPDATE legacy_movie_marks SET numeric_override=1 WHERE user_id=NEW.user_id AND movie_id=NEW.movie_id; END;
CREATE TRIGGER legacy_marks_numeric_update AFTER UPDATE OF rating_100 ON user_movies
WHEN NEW.rating_100 IS NOT NULL
BEGIN UPDATE legacy_movie_marks SET numeric_override=1 WHERE user_id=NEW.user_id AND movie_id=NEW.movie_id; END;

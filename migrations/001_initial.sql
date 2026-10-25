CREATE TABLE movies (
  id INTEGER PRIMARY KEY,
  tmdb_id INTEGER UNIQUE CHECK (tmdb_id > 0),
  letterboxd_uri TEXT UNIQUE CHECK (length(trim(letterboxd_uri)) > 0),
  title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  release_year INTEGER,
  media_type TEXT NOT NULL DEFAULT 'unknown' CHECK (media_type IN ('movie', 'tv', 'unknown')),
  runtime_minutes INTEGER CHECK (runtime_minutes >= 0),
  overview TEXT,
  genres_json TEXT CHECK (CASE WHEN json_valid(genres_json) THEN json_type(genres_json) = 'array' ELSE genres_json IS NULL END),
  poster_path TEXT,
  tmdb_vote_count INTEGER CHECK (tmdb_vote_count >= 0),
  tmdb_popularity REAL CHECK (tmdb_popularity >= 0),
  metadata_updated_at TEXT,
  CHECK (media_type != 'tv' OR tmdb_id IS NULL)
) STRICT;

CREATE TABLE user_movies (
  movie_id INTEGER PRIMARY KEY REFERENCES movies(id) ON DELETE RESTRICT,
  watched INTEGER NOT NULL DEFAULT 0 CHECK (watched IN (0, 1)),
  rating_100 INTEGER CHECK (rating_100 BETWEEN 0 AND 100),
  original_rating_stars REAL CHECK (original_rating_stars BETWEEN 0 AND 5 AND original_rating_stars * 2 = CAST(original_rating_stars * 2 AS INTEGER)),
  rating_source TEXT NOT NULL DEFAULT 'none' CHECK (rating_source IN ('none', 'letterboxd', 'manual')),
  not_interested INTEGER NOT NULL DEFAULT 0 CHECK (not_interested IN (0, 1)),
  watched_at TEXT,
  letterboxd_date TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE TABLE recommendations (
  id INTEGER PRIMARY KEY,
  movie_id INTEGER NOT NULL REFERENCES movies(id) ON DELETE RESTRICT,
  recommended_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  why_fit TEXT,
  possible_mismatch TEXT,
  rejected INTEGER NOT NULL DEFAULT 0 CHECK (rejected IN (0, 1))
) STRICT;
CREATE INDEX recommendations_movie_date ON recommendations(movie_id, recommended_at);

CREATE TABLE taste_profile (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  profile_json TEXT NOT NULL CHECK (json_valid(profile_json)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE TRIGGER user_movies_updated_at
AFTER UPDATE OF watched, rating_100, original_rating_stars, rating_source, not_interested, watched_at, letterboxd_date ON user_movies
WHEN OLD.watched IS NOT NEW.watched
  OR OLD.rating_100 IS NOT NEW.rating_100
  OR OLD.original_rating_stars IS NOT NEW.original_rating_stars
  OR OLD.rating_source IS NOT NEW.rating_source
  OR OLD.not_interested IS NOT NEW.not_interested
  OR OLD.watched_at IS NOT NEW.watched_at
  OR OLD.letterboxd_date IS NOT NEW.letterboxd_date
BEGIN
  UPDATE user_movies SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE movie_id = NEW.movie_id;
END;

CREATE TRIGGER taste_profile_updated_at
AFTER UPDATE OF profile_json ON taste_profile
WHEN OLD.profile_json IS NOT NEW.profile_json
BEGIN
  UPDATE taste_profile SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

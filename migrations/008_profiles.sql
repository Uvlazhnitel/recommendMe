-- Existing personal records belong to Ilya. No historical values are recomputed.
CREATE TABLE profiles (id TEXT PRIMARY KEY CHECK(id IN ('ilya','valeriy')), name TEXT NOT NULL) STRICT;
INSERT INTO profiles(id,name) VALUES('ilya','Илья'),('valeriy','Валерий');

CREATE TABLE user_movies_v8 (
  user_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
  movie_id INTEGER NOT NULL REFERENCES movies(id) ON DELETE RESTRICT,
  watched INTEGER NOT NULL DEFAULT 0 CHECK (watched IN (0, 1)),
  rating_100 INTEGER CHECK (rating_100 BETWEEN 0 AND 100),
  original_rating_stars REAL CHECK (original_rating_stars BETWEEN 0 AND 5 AND original_rating_stars * 2 = CAST(original_rating_stars * 2 AS INTEGER)),
  rating_source TEXT NOT NULL DEFAULT 'none' CHECK (rating_source IN ('none', 'letterboxd', 'manual')),
  not_interested INTEGER NOT NULL DEFAULT 0 CHECK (not_interested IN (0, 1)),
  watched_at TEXT,
  letterboxd_date TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
, letterboxd_rating_date TEXT, review_text TEXT CHECK (review_text IS NULL OR length(review_text) <= 2000),
  PRIMARY KEY(user_id,movie_id)
) STRICT;
INSERT INTO user_movies_v8(user_id,movie_id,watched,rating_100,original_rating_stars,rating_source,not_interested,watched_at,letterboxd_date,created_at,updated_at,letterboxd_rating_date,review_text) SELECT 'ilya',movie_id,watched,rating_100,original_rating_stars,rating_source,not_interested,watched_at,letterboxd_date,created_at,updated_at,letterboxd_rating_date,review_text FROM user_movies;

CREATE TABLE taste_profile_v8 (
  user_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
  profile_json TEXT NOT NULL CHECK (json_valid(profile_json)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY(user_id)
) STRICT;
INSERT INTO taste_profile_v8(user_id,profile_json,created_at,updated_at) SELECT 'ilya',profile_json,created_at,updated_at FROM taste_profile;

CREATE TABLE recommendations_v8 (
  user_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
  id INTEGER PRIMARY KEY,
  movie_id INTEGER NOT NULL REFERENCES movies(id) ON DELETE RESTRICT,
  recommended_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  why_fit TEXT,
  possible_mismatch TEXT,
  rejected INTEGER NOT NULL DEFAULT 0 CHECK (rejected IN (0, 1))
, result_id TEXT CHECK (result_id IS NULL OR length(trim(result_id)) > 0),
  UNIQUE(user_id,id,movie_id)
) STRICT;
INSERT INTO recommendations_v8(user_id,id,movie_id,recommended_at,why_fit,possible_mismatch,rejected,result_id) SELECT 'ilya',id,movie_id,recommended_at,why_fit,possible_mismatch,rejected,result_id FROM recommendations;

CREATE TABLE recommendation_evaluation_v8 (
  user_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
  result_id TEXT NOT NULL,
  saved_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
  PRIMARY KEY(user_id,result_id)
) STRICT;
INSERT INTO recommendation_evaluation_v8(user_id,result_id,saved_at,metadata_json) SELECT 'ilya',result_id,saved_at,metadata_json FROM recommendation_evaluation;

CREATE TABLE recommendation_outcomes_v8 (
  user_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
  movie_id INTEGER NOT NULL REFERENCES movies(id) ON DELETE RESTRICT,
  recommendation_id INTEGER NOT NULL,
  watch_recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  first_rating_recorded_at TEXT,
  PRIMARY KEY(user_id,movie_id),
  UNIQUE(user_id,recommendation_id),
  FOREIGN KEY(user_id,recommendation_id,movie_id) REFERENCES recommendations_v8(user_id,id,movie_id) ON DELETE RESTRICT
) STRICT;
INSERT INTO recommendation_outcomes_v8(user_id,movie_id,recommendation_id,watch_recorded_at,first_rating_recorded_at) SELECT 'ilya',movie_id,recommendation_id,watch_recorded_at,first_rating_recorded_at FROM recommendation_outcomes;

DROP TABLE recommendation_outcomes;
DROP TABLE recommendation_evaluation;
DROP TABLE recommendations;
DROP TABLE user_movies;
DROP TABLE taste_profile;
ALTER TABLE user_movies_v8 RENAME TO user_movies;
ALTER TABLE taste_profile_v8 RENAME TO taste_profile;
ALTER TABLE recommendations_v8 RENAME TO recommendations;
ALTER TABLE recommendation_evaluation_v8 RENAME TO recommendation_evaluation;
ALTER TABLE recommendation_outcomes_v8 RENAME TO recommendation_outcomes;

CREATE INDEX recommendations_user_movie_date ON recommendations(user_id,movie_id,recommended_at);
CREATE UNIQUE INDEX recommendations_result_movie ON recommendations(user_id,result_id,movie_id) WHERE result_id IS NOT NULL;

CREATE TRIGGER taste_profile_updated_at
AFTER UPDATE OF profile_json ON taste_profile
WHEN OLD.profile_json IS NOT NEW.profile_json
BEGIN
  UPDATE taste_profile SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE user_id = NEW.user_id;
END;

CREATE TRIGGER user_movies_updated_at
AFTER UPDATE OF watched, rating_100, original_rating_stars, rating_source, not_interested, watched_at, letterboxd_date, letterboxd_rating_date ON user_movies
WHEN OLD.watched IS NOT NEW.watched
  OR OLD.rating_100 IS NOT NEW.rating_100
  OR OLD.original_rating_stars IS NOT NEW.original_rating_stars
  OR OLD.rating_source IS NOT NEW.rating_source
  OR OLD.not_interested IS NOT NEW.not_interested
  OR OLD.watched_at IS NOT NEW.watched_at
  OR OLD.letterboxd_date IS NOT NEW.letterboxd_date
  OR OLD.letterboxd_rating_date IS NOT NEW.letterboxd_rating_date
BEGIN
  UPDATE user_movies SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE user_id = NEW.user_id AND movie_id = NEW.movie_id;
END;

CREATE TRIGGER user_movies_review_updated_at
AFTER UPDATE OF review_text ON user_movies
WHEN OLD.review_text IS NOT NEW.review_text
BEGIN
  UPDATE user_movies SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE user_id = NEW.user_id AND movie_id = NEW.movie_id;
END;

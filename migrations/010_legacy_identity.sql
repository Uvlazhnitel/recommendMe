CREATE TABLE legacy_identity_decisions (
 user_id TEXT NOT NULL,
 source_key TEXT NOT NULL,
 source_id TEXT NOT NULL,
 source_sha256 TEXT NOT NULL CHECK(length(source_sha256)=64),
 status TEXT NOT NULL CHECK(status IN ('confirmed','ambiguous','not_found')),
 candidates_json TEXT NOT NULL CHECK(json_valid(candidates_json)),
 decision_json TEXT NOT NULL CHECK(json_valid(decision_json)),
 applied_movie_id INTEGER REFERENCES movies(id),
 PRIMARY KEY(user_id,source_key,source_id),
 FOREIGN KEY(user_id,source_key,source_id) REFERENCES legacy_movie_marks(user_id,source_key,source_id)
) STRICT;
CREATE TABLE personal_rating_history (
 user_id TEXT NOT NULL,
 movie_id INTEGER NOT NULL,
 PRIMARY KEY(user_id,movie_id),
 FOREIGN KEY(user_id,movie_id) REFERENCES user_movies(user_id,movie_id) ON DELETE CASCADE
) STRICT;
INSERT OR IGNORE INTO personal_rating_history SELECT user_id,movie_id FROM user_movies WHERE rating_100 IS NOT NULL;
INSERT OR IGNORE INTO personal_rating_history SELECT user_id,movie_id FROM legacy_movie_marks WHERE numeric_override=1;
CREATE TRIGGER personal_rating_history_insert AFTER INSERT ON user_movies WHEN NEW.rating_100 IS NOT NULL
BEGIN INSERT OR IGNORE INTO personal_rating_history VALUES(NEW.user_id,NEW.movie_id); END;
CREATE TRIGGER personal_rating_history_update AFTER UPDATE OF rating_100 ON user_movies WHEN NEW.rating_100 IS NOT NULL
BEGIN INSERT OR IGNORE INTO personal_rating_history VALUES(NEW.user_id,NEW.movie_id); END;
CREATE TRIGGER legacy_marks_attach AFTER UPDATE OF movie_id ON legacy_movie_marks
WHEN EXISTS(SELECT 1 FROM personal_rating_history WHERE user_id=NEW.user_id AND movie_id=NEW.movie_id)
BEGIN UPDATE legacy_movie_marks SET numeric_override=1 WHERE user_id=NEW.user_id AND movie_id=NEW.movie_id; END;

ALTER TABLE user_movies ADD COLUMN review_text TEXT CHECK (review_text IS NULL OR length(review_text) <= 2000);

CREATE TRIGGER user_movies_review_updated_at
AFTER UPDATE OF review_text ON user_movies
WHEN OLD.review_text IS NOT NEW.review_text
BEGIN
  UPDATE user_movies SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE movie_id = NEW.movie_id;
END;

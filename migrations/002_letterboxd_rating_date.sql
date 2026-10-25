ALTER TABLE user_movies ADD COLUMN letterboxd_rating_date TEXT;
DROP TRIGGER user_movies_updated_at;
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
  UPDATE user_movies SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE movie_id = NEW.movie_id;
END;

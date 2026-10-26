ALTER TABLE recommendations ADD COLUMN result_id TEXT CHECK (result_id IS NULL OR length(trim(result_id)) > 0);
CREATE UNIQUE INDEX recommendations_result_movie ON recommendations(result_id, movie_id) WHERE result_id IS NOT NULL;

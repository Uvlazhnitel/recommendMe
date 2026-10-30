import { openDatabase } from './db';
import { readRecommendationBatch } from './recommendation-batches';
import { warmRussianMovies } from './russian-metadata';
import { profileRoute } from './profile-http';
import { ProfileError, type UserId } from './profiles';
import { parsePreferences, type RecommendationPreferences } from './recommendation-preferences';
import { readJsonBody, JsonInputError, assertWriteOrigin } from './http-json';
import { isRequestId } from './recommendation-batches';
import { GenerationError } from './recommendation-runs';
import { generateRecommendationBatch, recommendationState, type RecommendationDependencies } from './recommendation-service';

const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const messages: Record<string, string> = {
  preferences_conflict: 'Эта попытка уже привязана к другим пожеланиям. Нового платного запроса не было.',
  configuration_missing: 'Для подбора нужно настроить OpenAI, модель и TMDB на сервере.',
  profile_unavailable: 'Сохранённый профиль вкуса отсутствует или повреждён. Подготовьте его отдельно через CLI.',
  ratings_missing: 'Для подбора нужны текущие оценки фильмов.',
  generation_busy: 'Подбор уже выполняется. Дождитесь результата — повторный запрос не отправлен.',
  generation_interrupted: 'Предыдущая попытка не завершилась. Проверьте процесс сервера и блокировку; автоматического повтора не будет.',
  generation_failed_before: 'Эта попытка уже завершилась ошибкой. Новый платный подбор требует нового подтверждения.',
  backup_failed: 'Не удалось создать резервную копию. Новые платные запросы не выполнялись.',
  candidates_failed: 'Не удалось получить и проверить кандидатов. Финальный отбор не запускался.',
  no_candidates: 'Нет подходящих кандидатов с выбранными пожеланиями. Длительность, запреты, просмотры и ограничения повторов не ослаблялись.',
  ranking_failed: 'Финальный отбор не завершён. Предыдущая подборка сохранена; автоматического повтора нет.',
  generation_timeout: 'Время ожидания подбора истекло. Отправленные запросы могли быть оплачены; автоматического повтора нет.',
  save_failed: 'Не удалось сохранить новую подборку. Предыдущая доступна; можно повторить только сохранение без повторного обращения к модели.',
  saved_result_unavailable: 'Подготовленный результат не найден. Повтор сохранения не запускает подбор.',
  no_eligible_recommendations: 'Фильмы стали недоступны до сохранения. Новых запросов к модели не выполнялось.',
  generation_state_unavailable: 'Не удалось прочитать состояние подбора. Проверьте сервер; новый платный запуск не выполнялся.',
  generation_unavailable: 'Подбор не завершён. Предыдущая подборка сохранена. Проверьте состояние перед новым платным запуском.',
};
export function recommendationHandlers(dependencies: RecommendationDependencies = {}) {
  const handlers = {
    async get(request: Request, userId: UserId) {
      try { if (request) assertWriteOrigin(request); let result = recommendationState(userId, dependencies);
        if (!dependencies.open) {
          await warmRussianMovies([...(result.batch?.movies.map(row => row.movie_id) ?? []), ...result.home.favorites.map(row => row.movie_id)]);
          result = recommendationState(userId, dependencies);
        }
        return reply(result); }
      catch (error) { if (error instanceof ProfileError) throw error; return reply({ error: error instanceof JsonInputError ? error.code : 'recommendations_unavailable', message: 'Не удалось прочитать сохранённую подборку.' }, error instanceof JsonInputError ? error.status : 503); }
    },
    async generate(request: Request, userId: UserId) {
      let requestId: string;
      let preferences: RecommendationPreferences | undefined;
      try {
        const body = await readJsonBody(request);
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !['request_id', 'confirmed', 'preferences'].includes(k)) ||
          !('request_id' in body) || !isRequestId(body.request_id) || !('confirmed' in body) || body.confirmed !== true) throw new JsonInputError('invalid_request');
        requestId = body.request_id.toLowerCase();
        if ('preferences' in body) {
          try { preferences = parsePreferences(body.preferences); } catch { throw new JsonInputError('invalid_preferences'); }
        }
        const params = new URL(request.url).searchParams;
        if ([...params.keys()].some(key => key !== 'save_only') || (params.has('save_only') && (params.getAll('save_only').length !== 1 || params.get('save_only') !== '1'))) throw new JsonInputError('invalid_request');
      } catch (error) { if (error instanceof ProfileError) throw error; return reply({ error: error instanceof JsonInputError ? error.code : 'invalid_request', message: 'Проверьте подтверждение и идентификатор запроса.' }, error instanceof JsonInputError ? error.status : 400); }
      try {
        const result = await generateRecommendationBatch(userId, requestId, dependencies, { saveOnly: new URL(request.url).searchParams.get('save_only') === '1', preferences });
        if (!dependencies.open) {
          await warmRussianMovies(result.batch?.movies.map(row => row.movie_id) ?? []);
          if (result.batch) {
            const db = openDatabase({ readonly: true });
            try { result.batch = readRecommendationBatch(db, userId, result.batch.result_id); } finally { db.close(); }
          }
        }
        return reply(result, result.replayed ? 200 : 201);
      } catch (error) { if (error instanceof ProfileError) throw error;
        const failure = error instanceof GenerationError ? error : new GenerationError('generation_unavailable');
        return reply({ error: failure.code, message: messages[failure.code] ?? messages.generation_unavailable, request_id: requestId }, failure.status);
      }
    },
  };
  return { get: profileRoute(handlers.get), generate: profileRoute(handlers.generate) };
}

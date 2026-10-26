import type { SpotlightMovie } from '../../components/cinema-spotlight';
import bladePoster from './assets/blade-runner-poster.jpg';
import bladeBackdrop from './assets/blade-runner-backdrop.jpg';
import herPoster from './assets/her-poster.jpg';
import herBackdrop from './assets/her-backdrop.jpg';
import grandPoster from './assets/grand-budapest-poster.jpg';
import grandBackdrop from './assets/grand-budapest-backdrop.jpg';
import arrivalPoster from './assets/arrival-poster.jpg';
import arrivalBackdrop from './assets/arrival-backdrop.jpg';
import perfectPoster from './assets/perfect-days-poster.jpg';
import perfectBackdrop from './assets/perfect-days-backdrop.jpg';

// Verified TMDB imagery; illustrative Russian copy, never an actual recommendation result.
export const demoMovies: SpotlightMovie[] = [
  { tmdb_id: 335984, title: 'Бегущий по лезвию 2049', heading_lines: ['Бегущий', 'по лезвию 2049'], year: 2017, genres: ['Фантастика', 'триллер'], runtime: 164, poster: bladePoster, backdrop: bladeBackdrop,
    why_fit: 'Если вам близка фантастика, в которой мир раскрывает внутренний конфликт героя, здесь есть за что зацепиться. Детективная история постепенно становится разговором о памяти, одиночестве и праве на собственную жизнь.',
    possible_mismatch: 'Неторопливый темп и холодная эмоциональная дистанция. Фильм просит внимания, а не предлагает лёгкий вечер.' },
  { tmdb_id: 152601, title: 'Она', year: 2013, genres: ['Драма', 'мелодрама'], runtime: 126, poster: herPoster, backdrop: herBackdrop,
    why_fit: 'Камерная история об отношениях использует фантастическую идею, чтобы говорить о близости и одиночестве. Визуальная мягкость сочетается с непростыми вопросами.', possible_mismatch: 'Разговорный ритм и меланхоличная интонация могут не подойти для лёгкого вечера.' },
  { tmdb_id: 120467, title: 'Отель «Гранд Будапешт»', year: 2014, genres: ['Комедия', 'драма'], runtime: 100, poster: grandPoster, backdrop: grandBackdrop,
    why_fit: 'Если вам близки истории о неожиданной дружбе, здесь она становится сердцем авантюрного сюжета. За точной композицией и сухим юмором постепенно проступает меланхолия.', possible_mismatch: 'Нарочитая театральность и быстрый темп могут мешать сопереживанию.' },
  { tmdb_id: 329865, title: 'Прибытие', year: 2016, genres: ['Фантастика', 'драма'], runtime: 116, poster: arrivalPoster, backdrop: arrivalBackdrop,
    why_fit: 'Фантастическая идея раскрывается через личную историю. Вместо зрелища — внимание к языку, памяти и выбору.', possible_mismatch: 'Медленный темп и нелинейный рассказ требуют внимания.' },
  { tmdb_id: 976893, title: 'Идеальные дни', year: 2023, genres: ['Драма'], runtime: 124, poster: perfectPoster, backdrop: perfectBackdrop,
    why_fit: 'Наблюдение за повседневностью превращается в спокойный, очень человеческий портрет. Точная работа со звуком и деталями важнее событий.', possible_mismatch: 'Почти нет привычной сюжетной интриги.' },
];

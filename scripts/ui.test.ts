import test from 'node:test';
import assert from 'node:assert/strict';
import { previewEnabled, tmdbImage } from '../src/lib/movie-images';

test('movie images only use confirmed TMDB paths and fixed CDN sizes', () => {
  assert.equal(tmdbImage('/confirmed-123.jpg'), 'https://image.tmdb.org/t/p/w500/confirmed-123.jpg');
  assert.equal(tmdbImage('/confirmed_456.png', 'w342'), 'https://image.tmdb.org/t/p/w342/confirmed_456.png');
  for (const value of [null, undefined, '', 'https://evil.test/poster.jpg', '//evil.test/a.jpg', '/../../a.jpg', '/%2e%2e/a.jpg', '/a.jpg?redirect=evil', '/a.svg', '/a.jpg#fragment', '/a\\b.jpg']) assert.equal(tmdbImage(value), null);
});

test('development preview cannot be enabled in production, tests or missing environment', () => {
  assert.equal(previewEnabled('development'), true);
  for (const value of ['production', 'test', '', 'true', undefined]) assert.equal(previewEnabled(value), false);
});

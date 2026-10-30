import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

// Validates the prepared export only; it does not access or modify a database.
export function validateFatherList(bytes) {
  let data;
  try { data = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('Invalid JSON'); }
  if (!data || data.schema_version !== 2 || data.status !== 'prepared_not_imported' ||
      !Array.isArray(data.library) || !Array.isArray(data.occurrences) || !Array.isArray(data.sources) ||
      !Array.isArray(data.ambiguous_identity_ids) || !data.stats || typeof data.stats !== 'object') throw new Error('Unsupported export');
  const unique = (rows, name) => {
    const ids = new Set();
    for (const row of rows) {
      if (!row || typeof row !== 'object' || typeof row.id !== 'string' || !row.id.trim() || ids.has(row.id)) throw new Error(`Invalid or duplicate ${name} ID`);
      ids.add(row.id);
    }
    return ids;
  };
  const libraryIds = unique(data.library, 'library'), occurrenceIds = unique(data.occurrences, 'occurrence');
  const ambiguous = new Set(data.ambiguous_identity_ids);
  if (ambiguous.size !== data.ambiguous_identity_ids.length || [...ambiguous].some(id => typeof id !== 'string' || !occurrenceIds.has(id) || libraryIds.has(id))) throw new Error('Invalid ambiguous identities');
  if (!data.sources.length || data.sources.some(s => !s || typeof s.name !== 'string' || !s.name.trim() || typeof s.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(s.sha256))) throw new Error('Invalid source manifest');
  for (const row of data.library) {
    if ((row.year !== null && (!Number.isSafeInteger(row.year) || row.year < 1800 || row.year > 2200)) || typeof row.title !== 'string' || !row.title.trim() || !['film','series'].includes(row.media_type) ||
        typeof row.watched !== 'boolean' || typeof row.planned_to_watch !== 'boolean' || typeof row.watchlist !== 'boolean' ||
        ![null,'liked','disliked','mixed'].includes(row.sentiment) || row.personal_rating_100 !== null || row.tmdb_id !== null ||
        !Array.isArray(row.source_ids) || !row.source_ids.length || new Set(row.source_ids).size !== row.source_ids.length || row.source_ids.some(id => !occurrenceIds.has(id) || ambiguous.has(id))) throw new Error('Invalid library record');
  }
  const byId = new Map(data.occurrences.map(row => [row.id, row]));
  for (const row of data.library) for (const id of row.source_ids) if (byId.get(id).library_id !== row.id) throw new Error('Inconsistent source reference');
  for (const row of data.occurrences) if (row.library_id != null && !libraryIds.has(row.library_id)) throw new Error('Unknown library reference');
  const counts = { unique_library_entries:data.library.length, source_occurrences:data.occurrences.length,
    watched:data.library.filter(r=>r.watched).length, watchlist:data.library.filter(r=>r.watchlist).length,
    liked:data.library.filter(r=>r.sentiment==='liked').length, disliked:data.library.filter(r=>r.sentiment==='disliked').length,
    mixed:data.library.filter(r=>r.sentiment==='mixed').length, unknown_sentiment:data.library.filter(r=>r.sentiment===null).length,
    series:data.library.filter(r=>r.media_type==='series').length, ambiguous_identity:ambiguous.size };
  for (const [key, value] of Object.entries(counts)) if (data.stats[key] !== value) throw new Error(`Stats mismatch: ${key}`);
  return {sha256:createHash('sha256').update(bytes).digest('hex'),schema_version:2,status:data.status,counts};
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args=process.argv.slice(2);
    if (args.length!==4 || args[0]!=='--user' || args[1]!=='valeriy' || args[2]!=='--input' || !args[3]) throw new Error('Usage: node scripts/father-list-validate.mjs --user valeriy --input FILE');
    console.log(JSON.stringify(validateFatherList(readFileSync(args[3])),null,2));
  } catch (error) { console.error(error instanceof Error ? error.message : 'Validation failed'); process.exitCode=1; }
}

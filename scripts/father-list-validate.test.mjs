import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateFatherList } from './father-list-validate.mjs';
const fixture=()=>({schema_version:2,status:'prepared_not_imported',sources:[{name:'example',sha256:'a'.repeat(64)}],ambiguous_identity_ids:['amb'],library:[{id:'l',title:'Example',year:null,media_type:'film',watched:true,planned_to_watch:false,watchlist:false,sentiment:'liked',personal_rating_100:null,tmdb_id:null,source_ids:['o']}],occurrences:[{id:'o',library_id:'l'},{id:'amb',library_id:null}],stats:{unique_library_entries:1,source_occurrences:2,watched:1,watchlist:0,liked:1,disliked:0,mixed:0,unknown_sentiment:0,series:0,ambiguous_identity:1}});
const bytes=value=>Buffer.from(JSON.stringify(value));
test('valid prepared export yields counts and deterministic hash',()=>{const v=validateFatherList(bytes(fixture()));assert.equal(v.counts.liked,1);assert.match(v.sha256,/^[a-f0-9]{64}$/);assert.equal(v.sha256,validateFatherList(bytes(fixture())).sha256)});
test('rejects broken references, duplicate IDs, invented personal rating and incorrect counts',()=>{for(const mutate of [x=>x.library[0].source_ids=['missing'],x=>x.occurrences.push(x.occurrences[0]),x=>x.library[0].personal_rating_100=80,x=>x.stats.liked=2,x=>x.occurrences[0].library_id='bad']){const x=fixture();mutate(x);assert.throws(()=>validateFatherList(bytes(x)));}});

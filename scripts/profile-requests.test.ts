import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyBrowserProfile, profileFetch } from '../src/app/profile-requests';
const one={user_id:'ilya' as const,selection_id:'00000000-0000-4000-8000-000000000001'},two={user_id:'valeriy' as const,selection_id:'00000000-0000-4000-8000-000000000002'};
const headers={'X-Profile-ID':one.user_id,'X-Profile-Selection':one.selection_id};
test('profile reads honor caller abort and suppress stale bodies and errors',async t=>{
 Object.defineProperty(globalThis,'window',{value:{dispatchEvent(){}},configurable:true});t.after(()=>Reflect.deleteProperty(globalThis,'window'));
 applyBrowserProfile(one);let calls=0;
 t.mock.method(globalThis,'fetch',async (_url,init)=>{calls++;if(init?.signal?.aborted)throw init.signal.reason;return await new Promise<Response>((resolve,reject)=>init?.signal?.addEventListener('abort',()=>reject(init.signal!.reason)));});
 const already=new AbortController();already.abort();await assert.rejects(profileFetch('/test',{signal:already.signal}),{name:'AbortError'});
 const during=new AbortController();const pending=profileFetch('/test',{signal:during.signal});during.abort();await assert.rejects(pending,{name:'AbortError'});assert.equal(window.recommendmeProfile!.reads.size,0);
 const switched=profileFetch('/test');applyBrowserProfile(two);await assert.rejects(switched,{name:'AbortError'});assert.equal(window.recommendmeProfile!.reads.size,0);assert.equal(calls,3);
});
test('late error body cannot clear a newer profile',async t=>{
 Object.defineProperty(globalThis,'window',{value:{dispatchEvent(){}},configurable:true});t.after(()=>Reflect.deleteProperty(globalThis,'window'));applyBrowserProfile(one);
 let release!:()=>void;const gate=new Promise<void>(r=>release=r);
 t.mock.method(globalThis,'fetch',async()=>new Response(new ReadableStream({async start(c){await gate;c.enqueue(new TextEncoder().encode('{"error":"profile_changed"}'));c.close();}}),{status:409,headers}));
 const pending=profileFetch('/test');await new Promise(r=>setTimeout(r,0));applyBrowserProfile(two);release();await assert.rejects(pending,{name:'AbortError'});assert.equal(window.recommendmeProfile!.active?.user_id,'valeriy');
});

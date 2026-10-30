import type { UserId } from '../../src/lib/profiles';
import { PROFILE_COOKIE } from '../../src/lib/profile-http';
// Existing single-profile regressions explicitly belong to Ilya, not a runtime default.
export function profileRequest(input: string | URL | Request, init: RequestInit = {}, owner: UserId = 'ilya') {
  const selection_id='00000000-0000-4000-8000-000000000001';
  const headers=new Headers(init.headers);
  if(!headers.has('Cookie'))headers.set('Cookie',`${PROFILE_COOKIE}=${encodeURIComponent(JSON.stringify({user_id:owner,selection_id}))}`);
  if(!headers.has('X-Profile-ID'))headers.set('X-Profile-ID',owner);
  if(!headers.has('X-Profile-Selection'))headers.set('X-Profile-Selection',selection_id);
  return new Request(input,{...init,headers});
}

import { randomUUID } from 'node:crypto';
import { PROFILES, ProfileError, userId, type UserId } from './profiles';
import { assertWriteOrigin, JsonInputError, readJsonBody } from './http-json';
import { requireAccess } from './access';

export const PROFILE_COOKIE = 'recommendme_profile';
export type ProfileSelection = { user_id: UserId; selection_id: string };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
export function selectedProfile(request: Request): ProfileSelection | null {
  const cookies = (request.headers.get('cookie') ?? '').split(';').map(v => v.trim()).filter(v => v.startsWith(PROFILE_COOKIE+'='));
  if (!cookies.length) return null;
  try {
    if(cookies.length!==1) throw Error();
    const value = JSON.parse(decodeURIComponent(cookies[0].slice(PROFILE_COOKIE.length+1)));
    if (!value || typeof value.selection_id !== 'string' || !uuid.test(value.selection_id)) throw Error();
    return {user_id:userId(value.user_id),selection_id:value.selection_id};
  } catch { throw new ProfileError('invalid_profile'); }
}
export function profileError(error: unknown) {
  if (error instanceof ProfileError || error instanceof JsonInputError) return Response.json({error:error.code}, {status:error.status,headers:{'Cache-Control':'no-store'}});
  return Response.json({error:'profile_unavailable'}, {status:503,headers:{'Cache-Control':'no-store'}});
}
export function requireProfile(request: Request): ProfileSelection {
  const value=selectedProfile(request);if(!value) throw new ProfileError('profile_required',428);
  const expected=request.headers.get('X-Profile-ID'), selection=request.headers.get('X-Profile-Selection');
  if(!expected||!selection) throw new ProfileError('profile_required',428);
  userId(expected);
  if(expected!==value.user_id||selection!==value.selection_id) throw new ProfileError('profile_changed',409);
  return value;
}
export function profileRoute<A extends unknown[]>(handler:(request:Request,owner:UserId,...args:A)=>Response|Promise<Response>) {
  return async(request:Request,...args:A):Promise<Response>=>{
    try {
      requireAccess(request);
      assertWriteOrigin(request);
      const profile=requireProfile(request);
      const response=await handler(request,profile.user_id,...args);
      response.headers.set('X-Profile-ID',profile.user_id);response.headers.set('X-Profile-Selection',profile.selection_id);
      response.headers.set('Cache-Control','no-store');response.headers.set('Vary','Authorization, Cookie, X-Profile-ID, X-Profile-Selection');
      return response;
    }catch(error){return profileError(error);}
  };
}
export function getProfile(request:Request) {
  try {requireAccess(request);assertWriteOrigin(request);return Response.json({profiles:PROFILES,active:selectedProfile(request)},{headers:{'Cache-Control':'no-store','Vary':'Authorization, Cookie'}});}catch(error){return profileError(error);}
}
export async function chooseProfile(request:Request) {
  try {
    requireAccess(request);
    const body=await readJsonBody(request);
    if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length!==1||!('user_id' in body))throw new ProfileError('invalid_profile');
    const active:ProfileSelection={user_id:userId(body.user_id),selection_id:randomUUID()};
    const secure=new URL(request.url).protocol==='https:'||request.headers.get('x-forwarded-proto')==='https';
    return Response.json({profiles:PROFILES,active},{headers:{'Cache-Control':'no-store','Set-Cookie':`${PROFILE_COOKIE}=${encodeURIComponent(JSON.stringify(active))}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Strict${secure?'; Secure':''}`}});
  }catch(error){return profileError(error);}
}

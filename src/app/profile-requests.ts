import type { ProfileSelection } from '@/lib/profile-http';
import { accessFetch } from './access-client';

type BrowserState = { active: ProfileSelection | null; epoch: number; reads: Set<AbortController> };
declare global { interface Window { recommendmeProfile?: BrowserState } }
function state(): BrowserState {
  if (typeof window === 'undefined') throw new Error('Выберите профиль перед работой с библиотекой.');
  return window.recommendmeProfile ??= {active:null,epoch:0,reads:new Set()};
}
export function applyBrowserProfile(active: ProfileSelection | null) {
  const current=state();if(current.active?.selection_id===active?.selection_id && current.active?.user_id===active?.user_id)return;
  current.epoch++;current.active=active;for(const controller of current.reads)controller.abort();current.reads.clear();
  try {for(let i=sessionStorage.length-1;i>=0;i--){const key=sessionStorage.key(i);if(key?.startsWith('recommendme-library:'))sessionStorage.removeItem(key);}}catch{}
}
export function profilePositionKey(url:string) {return `recommendme-library:${state().active?.selection_id ?? 'none'}:${url}`;}
export async function profileFetch(url:string,init:RequestInit={}) {
  const current=state(),active=current.active,epoch=current.epoch;if(!active)throw new Error('Сначала выберите профиль.');
  const headers=new Headers(init.headers);headers.set('X-Profile-ID',active.user_id);headers.set('X-Profile-Selection',active.selection_id);
  const controller=new AbortController(),reading=!init.method||init.method.toUpperCase()==='GET';
  const callerSignal=init.signal;
  const abortFromCaller=()=>controller.abort(callerSignal?.reason);
  if(reading){current.reads.add(controller);if(callerSignal?.aborted)abortFromCaller();else callerSignal?.addEventListener('abort',abortFromCaller,{once:true});}
  const checkCurrent=()=>{if(current.epoch!==epoch)throw new DOMException('Profile changed','AbortError');if(reading&&controller.signal.aborted)throw controller.signal.reason ?? new DOMException('Aborted','AbortError');};
  try {
    const response=await accessFetch(url,{...init,headers,...(reading?{signal:controller.signal}:{})});
    checkCurrent();
    if(!response.ok){const body=await response.clone().json().catch(()=>null);checkCurrent();if(['profile_changed','profile_required','invalid_profile'].includes(body?.error)){
      applyBrowserProfile(null);window.dispatchEvent(new Event('recommendme-profile-invalid'));throw new DOMException('Profile changed','AbortError');
    }if(body?.error==='schema_upgrade_required')throw new Error('База требует явного обновления схемы. Пользовательские данные не изменены.');}
    if(response.ok&&(response.headers.get('X-Profile-ID')!==active.user_id||response.headers.get('X-Profile-Selection')!==active.selection_id))throw new Error('Ответ приложения относится к другому профилю.');
    // Check after body parsing too: consumers use the returned Response asynchronously.
    const body=await response.arrayBuffer();checkCurrent();
    return new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers});
  }finally{callerSignal?.removeEventListener('abort',abortFromCaller);current.reads.delete(controller);}
}

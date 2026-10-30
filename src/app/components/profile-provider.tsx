'use client';
import { createContext, Fragment, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { PROFILES } from '@/lib/profiles';
import type { ProfileSelection } from '@/lib/profile-http';
import { applyBrowserProfile } from '../profile-requests';
import { Button } from './ui';
import { trapDialogFocus } from './home-gallery';

type Context = {active:ProfileSelection|null;ready:boolean;error:string;choose:(id:string)=>Promise<void>;busy:boolean};
const ProfileContext=createContext<Context|null>(null);
function useProfile(){const value=useContext(ProfileContext);if(!value)throw Error('Profile provider missing');return value;}
export function ProfileProvider({children}:{children:React.ReactNode}){
  const router=useRouter(),[active,setActive]=useState<ProfileSelection|null>(null),[ready,setReady]=useState(false),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const current=useRef<ProfileSelection|null>(null),sequence=useRef(0),channel=useRef<BroadcastChannel|null>(null);
  const apply=useCallback((next:ProfileSelection|null,reset=false)=>{
    const changed=current.current?.selection_id!==next?.selection_id;
    if(changed){applyBrowserProfile(next);current.current=next;setActive(next);if(reset)router.replace('/');}
  },[router]);
  const load=useCallback(async(reset=false)=>{
    const id=++sequence.current;
    try{const response=await fetch('/api/profile',{cache:'no-store',credentials:'same-origin'});const body=await response.json();if(id!==sequence.current)return;
      if(!response.ok){apply(null,reset);setError('Выберите профиль заново.');return;}
      apply(body.active,reset||Boolean(current.current&&current.current.selection_id!==body.active?.selection_id));setError('');
    }catch{if(id===sequence.current)setError('Не удалось проверить профиль. Повторно откройте приложение.');}
    finally{if(id===sequence.current)setReady(true);}
  },[apply]);
  useEffect(()=>{
    const initial=setTimeout(()=>{void load();},0);const sync=()=>{apply(null,true);void load(true);};const focus=()=>{if(document.visibilityState==='visible')void load();};
    try{channel.current=new BroadcastChannel('recommendme-profile');channel.current.onmessage=sync;}catch{}
    const storage=(event:StorageEvent)=>{if(event.key==='recommendme-profile-change')sync();};
    window.addEventListener('storage',storage);window.addEventListener('focus',focus);document.addEventListener('visibilitychange',focus);window.addEventListener('recommendme-profile-invalid',sync);
    return()=>{clearTimeout(initial);sequence.current++;channel.current?.close();window.removeEventListener('storage',storage);window.removeEventListener('focus',focus);document.removeEventListener('visibilitychange',focus);window.removeEventListener('recommendme-profile-invalid',sync);};
  },[apply,load]);
  async function choose(id:string){if(busy)return;setBusy(true);setError('');
    try{const response=await fetch('/api/profile',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({user_id:id}),credentials:'same-origin'});if(!response.ok)throw Error();
      apply(null,true);await load(true);channel.current?.postMessage('changed');try{localStorage.setItem('recommendme-profile-change',crypto.randomUUID());}catch{}
    }catch{apply(null,true);setError('Выбор не подтверждён. Проверьте профиль перед продолжением.');await load(true);}
    finally{setBusy(false);}
  }
  return <ProfileContext value={{active,ready,error,choose,busy}}>{children}</ProfileContext>;
}
function Choices(){const {choose,busy,error}=useProfile();return <><p>Две независимые библиотеки, без паролей. Любой с доступом к приложению может сменить профиль.</p><div className="profile-choices">{PROFILES.map(p=><Button key={p.id} disabled={busy} onClick={()=>void choose(p.id)}>{p.name}</Button>)}</div>{error?<p role="alert" className="error-state">{error}</p>:null}</>;}
export function ProfileGate({children}:{children:React.ReactNode}){const {active,ready,error}=useProfile();if(!ready)return <p role="status">Проверяем выбранный профиль…</p>;if(!active)return <section className="profile-chooser"><h1>Кто будет смотреть?</h1><Choices/></section>;return <><Fragment key={active.selection_id}>{children}</Fragment>{error?<p role="alert">{error}</p>:null}</>;}
export function ProfileControl(){const {active}=useProfile(),dialog=useRef<HTMLDialogElement>(null),button=useRef<HTMLButtonElement>(null);
  useEffect(()=>{dialog.current?.close();},[active?.selection_id]);if(!active)return null;
  const name=PROFILES.find(p=>p.id===active.user_id)!.name;
  return <div className="profile-control"><Button ref={button} tone="quiet" onClick={()=>dialog.current?.showModal()} aria-label={`Сменить профиль: ${name}`}><strong>{name}</strong><span>Сменить профиль</span></Button>
    <dialog ref={dialog} className="profile-dialog" aria-labelledby="profile-title" onKeyDown={trapDialogFocus} onClose={()=>button.current?.focus()}><h2 id="profile-title">Сменить профиль</h2><p>Несохранённые изменения будут сброшены.</p><Choices/><Button tone="quiet" onClick={()=>dialog.current?.close()}>Отмена</Button></dialog></div>;
}

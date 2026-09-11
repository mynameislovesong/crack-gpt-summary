(() => {
  'use strict';

  // ---------------------------------------------------------------------------
  // Tampermonkey compatibility layer for the original MV3 extension.
  // - chrome.storage.local -> shared GM storage
  // - chrome.runtime.sendMessage -> local Crack controller / ChatGPT bridge
  // - cross-origin Crack <-> ChatGPT transfer -> shared GM job bus
  // ---------------------------------------------------------------------------
  const US = globalThis.__CrackGPTUserscript = globalThis.__CrackGPTUserscript || {};
  US.version = '1.2.14.1';
  US.runtimeId = 'crack-gpt-summary-userscript';
  US.runtimeListeners = US.runtimeListeners || new Set();
  US.storageListeners = US.storageListeners || new Set();
  US.background = null;

  const STORAGE_KEY='CG_US_STORAGE_V1';
  const JOB_PREFIX='CG_US_JOB_';
  const RESULT_PREFIX='CG_US_RESULT_';
  const PROGRESS_PREFIX='CG_US_PROGRESS_';
  const CANCEL_PREFIX='CG_US_CANCEL_';
  const CLAIM_PREFIX='CG_US_CLAIM_';
  const RECEIVER_PREFIX='CG_US_RECEIVER_';
  const LOCK_PREFIX='CG_US_LOCK_';
  Object.assign(US,{STORAGE_KEY,JOB_PREFIX,RESULT_PREFIX,PROGRESS_PREFIX,CANCEL_PREFIX,CLAIM_PREFIX,RECEIVER_PREFIX,LOCK_PREFIX});

  const clone = value => {
    if (value === undefined) return undefined;
    try { return structuredClone(value); } catch { return JSON.parse(JSON.stringify(value)); }
  };
  const readStore=()=>{
    const v=GM_getValue(STORAGE_KEY,{});
    return v && typeof v==='object' && !Array.isArray(v) ? v : {};
  };
  const pick=(store,keys)=>{
    if(keys==null)return clone(store);
    if(typeof keys==='string')return {[keys]:clone(store[keys])};
    if(Array.isArray(keys))return Object.fromEntries(keys.map(k=>[k,clone(store[k])]));
    if(keys && typeof keys==='object'){
      const out={};
      for(const [k,def] of Object.entries(keys))out[k]=store[k]===undefined?clone(def):clone(store[k]);
      return out;
    }
    return {};
  };
  const emitStorage=(oldStore,newStore,remote=false)=>{
    const changes={};
    for(const k of new Set([...Object.keys(oldStore||{}),...Object.keys(newStore||{})])){
      const a=oldStore?.[k],b=newStore?.[k];
      let same=false;
      try{same=JSON.stringify(a)===JSON.stringify(b);}catch{same=a===b;}
      if(!same)changes[k]={oldValue:clone(a),newValue:clone(b)};
    }
    if(!Object.keys(changes).length)return;
    for(const fn of [...US.storageListeners]){try{fn(changes,'local');}catch(e){console.warn('[Crack GPT] storage listener failed',e);}}
  };

  // Receive storage changes made by another tab of the same userscript.
  try{
    US.storageWatchId=GM_addValueChangeListener(STORAGE_KEY,(name,oldValue,newValue,remote)=>{
      if(remote)emitStorage(oldValue||{},newValue||{},true);
    });
  }catch{}

  async function dispatchRuntimeMessage(message,sender={id:US.runtimeId,tab:null,frameId:0,url:location.href}){
    for(const listener of [...US.runtimeListeners]){
      let replied=false,replyValue;
      let resolveReply;
      const replyPromise=new Promise(r=>{resolveReply=r;});
      const reply=value=>{if(!replied){replied=true;replyValue=value;resolveReply(value);}};
      let ret;
      try{ret=listener(message,sender,reply);}catch(e){return {ok:false,error:e?.message||String(e)};}
      if(ret===true){
        // Chrome's return true keeps the response channel open. Give the async handler
        // enough time for ChatGPT file upload / send confirmation.
        const timeoutMs = message?.type==='CG_COMMIT' ? 205000 : 30000;
        const timeout=new Promise(r=>setTimeout(()=>r({ok:false,error:'userscript 메시지 응답 시간이 초과되었습니다.'}),timeoutMs));
        return Promise.race([replyPromise,timeout]);
      }
      if(replied)return replyValue;
      if(ret!==undefined)return ret;
    }
    return {ok:false,error:'userscript 메시지 수신기가 없습니다.'};
  }
  US.dispatchRuntimeMessage=dispatchRuntimeMessage;

  const chromeShim={
    runtime:{
      id:US.runtimeId,
      sendMessage:async message=>{
        try{
          if(location.origin==='https://crack.wrtn.ai'){
            if(!US.background)throw new Error('Crack userscript 컨트롤러가 아직 준비되지 않았습니다.');
            return await US.background.handle(message);
          }
          if(location.origin==='https://chatgpt.com'){
            if(message?.type==='CG_PROGRESS'){
              GM_setValue(PROGRESS_PREFIX+message.id,{stage:message.stage,ts:Date.now()});
              return {ok:true};
            }
            return {ok:false,error:'ChatGPT userscript에서 지원하지 않는 런타임 요청입니다.'};
          }
          return {ok:false,error:'지원하지 않는 사이트입니다.'};
        }catch(e){return {ok:false,error:e?.message||String(e)};}
      },
      onMessage:{
        addListener(fn){US.runtimeListeners.add(fn);},
        removeListener(fn){US.runtimeListeners.delete(fn);}
      }
    },
    storage:{
      local:{
        async get(keys){return pick(readStore(),keys);},
        async set(items){
          if(!items || typeof items!=='object')return;
          const oldStore=readStore();
          const next={...oldStore,...clone(items)};
          GM_setValue(STORAGE_KEY,next);
          emitStorage(oldStore,next,false);
        },
        async remove(keys){
          const list=Array.isArray(keys)?keys:[keys];
          const oldStore=readStore(),next={...oldStore};
          for(const k of list)delete next[k];
          GM_setValue(STORAGE_KEY,next);emitStorage(oldStore,next,false);
        },
        async clear(){const oldStore=readStore();GM_setValue(STORAGE_KEY,{});emitStorage(oldStore,{},false);}
      },
      onChanged:{
        addListener(fn){US.storageListeners.add(fn);},
        removeListener(fn){US.storageListeners.delete(fn);}
      }
    }
  };
  // The concatenated extension modules expect the Chrome extension global.
  US.chromeShim=chromeShim;
  try{globalThis.chrome=chromeShim;}catch{}
})();

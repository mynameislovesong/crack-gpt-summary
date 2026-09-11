// ==UserScript==
// @name         Crack GPT 로그 요약 (Tampermonkey)
// @namespace    https://github.com/mynameislovesong/crack-gpt-summary
// @version      1.2.14.2
// @description  Crack API 로그를 지정한 ChatGPT 대화에 TXT로 첨부하고 요약합니다.
// @match        https://crack.wrtn.ai/*
// @match        https://chatgpt.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_addValueChangeListener
// @grant        GM_removeValueChangeListener
// @grant        GM_openInTab
// @run-at       document-idle
// @noframes
// @sandbox      DOM
// @homepageURL  https://github.com/mynameislovesong/crack-gpt-summary
// @updateURL    https://raw.githubusercontent.com/mynameislovesong/crack-gpt-summary/main/crack-gpt-summary.user.js
// @downloadURL  https://raw.githubusercontent.com/mynameislovesong/crack-gpt-summary/main/crack-gpt-summary.user.js
// ==/UserScript==

(() => {
'use strict';
if(window.top!==window.self || globalThis.__crackGPTUserscript)return;
globalThis.__crackGPTUserscript=true;
let CrackGPT,CrackRanges,CrackCleaner,CrackRoute,CrackMessageAPI,CrackLogExtractor,CrackSettings,CrackSettingsModal;

// Module: shared.js
(() => {
  'use strict';
  const CHUNK_SIZE = 128 * 1024;
  const LONG_PROMPT_THRESHOLD = 6000;
  const INSTRUCTION_FILE_NAME = 'Crack-GPT-Instructions.txt';
  function chatUrl(raw) {
    if (typeof raw !== 'string' || !raw.trim()) throw new Error('ChatGPT 요약용 채팅 URL을 설정해 주세요.');
    let u;
    try { u = new URL(raw.trim()); } catch { throw new Error('잘못된 ChatGPT URL입니다.'); }
    if (u.origin !== 'https://chatgpt.com' || u.username || u.password ||
        !/\/c\/[a-zA-Z0-9-]+\/?$/.test(u.pathname))
      throw new Error('https://chatgpt.com/의 특정 대화 URL(/c/대화ID)을 입력해 주세요.');
    u.hash = ''; u.search = ''; u.pathname = u.pathname.replace(/\/$/, '');
    return u.href;
  }
  function validatePrompt(prompt) {
    if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('로그 요약 지침을 설정해 주세요.');
    return prompt;
  }
  function shouldAttachPrompt(prompt) {
    validatePrompt(prompt);
    return prompt.length > LONG_PROMPT_THRESHOLD;
  }
  function makePrompt(prompt) {
    validatePrompt(prompt);
    if (shouldAttachPrompt(prompt)) {
      return `첨부한 ${INSTRUCTION_FILE_NAME}의 지침 전체를 빠짐없이 적용해서 함께 첨부된 RP 로그를 처리해줘. 지침 파일을 축약하거나 일부만 적용하지 말 것.`;
    }
    return `첨부한 RP 로그 전체를 아래 지침에 따라 요약해줘.\n\n${prompt}`;
  }
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  async function digest(text) {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(bytes)].map(v => v.toString(16).padStart(2, '0')).join('');
  }
  async function checked(promise) {
    const result = await promise;
    if (!result?.ok) throw new Error(result?.error || 'Userscript 연결이 끊겼습니다. 페이지를 새로고침해 주세요.');
    return result;
  }
  async function timeout(promise, ms, stage) {
    let timer;
    try { return await Promise.race([promise,new Promise((_,reject)=>{
      timer=setTimeout(()=>reject(new Error(`${stage}: 제한 시간 ${ms/1000}초를 초과했습니다.`)),ms);
    })]); } finally { clearTimeout(timer); }
  }
  const STAGES=Object.freeze({history:'과거 로그 불러오는 중…',extract:'로그 추출 중…',
    connect:'ChatGPT 탭 연결 중…',recover:'ChatGPT 연결 복구 중…',file:'TXT 파일 생성 중…',
    attach:'ChatGPT 파일 첨부 중…',upload:'파일 업로드 확인 중…',prompt:'요약 지침 입력 중…',
    send:'ChatGPT 전송 중…',confirm:'전송 확인 중…'});
  const TIMEOUT=Object.freeze({tab:30000,handshake:2500,injection:10000,transfer:15000,
    editor:15000,fileInput:8000,attach:10000,upload:60000,prompt:30000,send:15000,confirm:30000,commit:190000});
  CrackGPT = Object.freeze({CHUNK_SIZE,LONG_PROMPT_THRESHOLD,INSTRUCTION_FILE_NAME,chatUrl,makePrompt,shouldAttachPrompt,sleep,digest,checked,
    timeout,STAGES,TIMEOUT,PROTOCOL:3,FILE_NAME:'Crack-RP-Log.txt'});
})();

// Module: ranges.js
(() => {
  'use strict';
  const C=CrackGPT;
  function crackChatId(raw){
    const url=new URL(raw);
    if(url.origin!=='https://crack.wrtn.ai' || !/\/episodes\/[^/]+\/?$/.test(url.pathname))
      throw new Error('현재 Crack 채팅 ID를 확인하지 못했습니다. 채팅방에서 실행해 주세요.');
    return url.origin+url.pathname.replace(/\/$/,'');
  }
  const key=(kind,chatId,presetId)=>`${kind}:${encodeURIComponent(chatId)}:${encodeURIComponent(presetId)}`;
  const defaults=()=>({mode:'after',start:1,end:'',record:false});
  function validateChoice(value){
    const v={...defaults(),...value};
    if(!['after','all','manual'].includes(v.mode))throw new Error('유효하지 않은 범위입니다.');
    if(v.mode==='manual' && (!Number.isSafeInteger(Number(v.start)) || Number(v.start)<1 ||
      (v.end!=='' && (!Number.isSafeInteger(Number(v.end)) || Number(v.end)<Number(v.start)))))
      throw new Error('유효하지 않은 범위입니다.');
    return {mode:v.mode,start:Number(v.start)||1,end:v.end===''?'':Number(v.end),record:v.record===true};
  }
  const signature=m=>JSON.stringify([m.role,m.messageGroupId||null,m.content]);
  const prefixHash=(messages,index)=>C.digest(JSON.stringify(messages.slice(0,index+1).map(signature)));
  async function getSelectedTurnRange(structure,choice,previous){
    const {turns,orphans}=structure;
    if(!turns?.length)throw new Error('완성된 USER / CHARACTER 쌍이 없습니다. 답변 완료 후 다시 시도해 주세요.');
    const messages=[...turns.flatMap(t=>[t.user,t.character]),...orphans.map(o=>o.message)]
      .sort((a,b)=>a.chronologicalIndex-b.chronologicalIndex);
    if(messages.some(m=>!['user','character'].includes(m.role)))throw new Error('메시지 구성 실패: 알 수 없는 화자입니다.');
    choice=validateChoice(choice);
    let start=1,end=turns.length;
    if(choice.mode==='after' && previous){
      const matches=[];
      for(let i=0;i<messages.length;i++){
        const m=messages[i];
        if(previous.lastMessageId ? m.messageGroupId===previous.lastMessageId && m.role==='character' :
          await C.digest(signature(m))===previous.cursor?.messageHash)matches.push(i);
      }
      if(matches.length!==1)throw new Error('이전 처리 cursor를 확인하지 못했습니다. 전체/직접 범위를 선택하거나 처리 위치를 초기화해 주세요.');
      const index=matches[0],turn=turns.find(t=>t.character===messages[index]);
      if(!turn || await prefixHash(messages,index)!==previous.cursor?.prefixHash)
        throw new Error('이전 처리 로그가 변경되었습니다. 범위를 확인하거나 처리 위치를 초기화해 주세요.');
      start=turn.logicalTurn+1;
    }else if(choice.mode==='manual'){
      start=choice.start;end=choice.end===''?turns.length:choice.end;
    }
    if(choice.mode==='after' && start>turns.length)throw new Error('새로 전송할 로그가 없습니다.');
    if(start<1 || end<start || end>turns.length)throw new Error('유효하지 않은 범위입니다.');
    return {start,end,messages,turns,record:choice.mode==='after'||choice.record};
  }
  async function sliceLogicalTurns(structure,choice,previous){
    const range=await getSelectedTurnRange(structure,choice,previous);
    const {start,end,turns,messages}=range;
    // Orphans before a turn belong to that next turn; trailing orphans are retained
    // with the final range, but never advance the completed-turn cursor.
    let boundary=start===1?0:turns[start-2].character.chronologicalIndex;
    const sections=[];
    let position=0;
    while(position<messages.length && messages[position].chronologicalIndex<=boundary)position++;
    for(const turn of turns.slice(start-1,end)){
      const last=turn.logicalTurn===turns.length?Infinity:turn.character.chronologicalIndex;
      const selected=[];
      while(position<messages.length && messages[position].chronologicalIndex<=last)selected.push(messages[position++]);
      sections.push(`T${turn.logicalTurn}\n`+selected.map(m=>`[${m.role.toUpperCase()}]\n${m.content}`).join('\n\n'));
      boundary=turn.character.chronologicalIndex;
    }
    const last=turns[end-1].character,index=messages.indexOf(last);
    const progress={lastTurn:end,lastMessageId:last.messageGroupId||null,
      cursor:{messageHash:await C.digest(signature(last)),prefixHash:await prefixHash(messages,index)},
      rangeStart:start,rangeEnd:end};
    return {text:sections.join('\n\n'),fileName:`Crack-RP-Log-T${start}-T${end}.txt`,progress,
      record:range.record,currentLastTurn:turns.length};
  }
  CrackRanges =Object.freeze({crackChatId,key,defaults,validateChoice,getSelectedTurnRange,sliceLogicalTurns});
})();

// Module: cleaner.js
(() => {
  'use strict';
  const defaults=Object.freeze({removeImageMarkdown:true,removeImageUrls:true,removeComments:true,
    normalizeBlankLines:true,removeLoreOoc:false,removeMarkdownDecoration:false});
  const options=value=>Object.fromEntries(Object.entries(defaults).map(([key,fallback])=>
    [key,typeof value?.[key]==='boolean'?value[key]:fallback]));
  // Independently implemented from verified v0.4.2 string-transformation rules.
  // Code fences are always retained; there is deliberately no fence option.
  function cleanRpLog(input,value){
    const enabled=options(value);
    let result=String(input??'').replace(/\r\n?/g,'\n').replace(/\uFEFF/g,'');
    if(enabled.removeLoreOoc)result=result.replace(/<ooc_lore_context\b[^>]*>[\s\S]*?<\/ooc_lore_context\s*>/gi,'');
    if(enabled.removeComments){
      result=result.replace(/<!--[\s\S]*?-->/g,'');
      result=result.split('\n').filter(row=>!/^\[\/\/\]:\s*#\s*\(.*\)\s*$/.test(row.trim()) &&
        !/^\[comment\]:\s*#\s*\(.*\)\s*$/i.test(row.trim())).join('\n');
    }
    const rows=[];
    for(let row of result.split('\n')){
      if(enabled.removeImageMarkdown)row=row.replace(/!\[[^\]\n]*\]\([^)\n]*\)/g,'');
      const trimmed=row.trim();
      if(enabled.removeImageUrls && /^https?:\/\//i.test(trimmed) && /\.(png|jpe?g|webp|gif|avif|svg)(\?[^ \t]*)?$/i.test(trimmed))continue;
      if(enabled.removeMarkdownDecoration && !/^\s*```/.test(trimmed)){
        const substitutions=[
          [/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+|[^)\n]+)\)/g,'$1'],
          [/^\s{0,3}#{1,6}\s+/g,''],[/^\s{0,3}>\s?/g,''],[/`([^`\n]+)`/g,'$1'],
          [/\*\*([^*\n]+)\*\*/g,'$1'],[/__([^_\n]+)__/g,'$1'],
          [/(^|[^*])\*([^*\n]+)\*(?!\*)/g,'$1$2'],[/(^|[^_])_([^_\n]+)_(?!_)/g,'$1$2'],[/~~([^~\n]+)~~/g,'$1']
        ];
        for(const [pattern,replacement] of substitutions)row=row.replace(pattern,replacement);
      }
      row=row.replace(/[ \t]+$/g,'');rows.push(row.trim()===''?'':row);
    }
    result=rows.join('\n');
    return enabled.normalizeBlankLines?result.replace(/[ \t]+\n/g,'\n').replace(/\n{3,}/g,'\n\n').trim():result;
  }
  CrackCleaner =Object.freeze({defaults,options,cleanRpLog});
})();

// Module: bridge.js
// Native userscript transport. Only metadata is advertised; payloads have a short lifetime.
const Bridge = (() => {
  const PREFIX='cg-tm:', TTL=360000, id=crypto.randomUUID();
  const key=(kind,value)=>PREFIX+kind+':'+value;
  const read=(kind,value)=>GM_getValue(key(kind,value),null);
  const put=(kind,value,data)=>GM_setValue(key(kind,value),{...data,expires:Date.now()+TTL});
  const remove=(kind,value)=>GM_deleteValue(key(kind,value));
  const valid=value=>value && value.expires>Date.now();
  const listeners=new Set();
  function watch(kind,value,fn){
    const token=GM_addValueChangeListener(key(kind,value),(_k,_old,next)=>fn(next));
    listeners.add(token);return ()=>{listeners.delete(token);GM_removeValueChangeListener(token);};
  }
  function cleanup(){
    for(const name of GM_listValues())if(name.startsWith(PREFIX)){
      const entry=GM_getValue(name,null);
      if(entry?.expires && entry.expires<Date.now())GM_deleteValue(name);
    }
  }
  cleanup();
  async function exclusive(name,fn,wait=false){
    if(!navigator.locks)throw new Error('이 브라우저는 중복 전송 방지 잠금을 지원하지 않습니다. 최신 Chrome을 사용해 주세요.');
    return navigator.locks.request('crack-gpt-tm:'+name,wait?{}:{ifAvailable:true},lock=>{
      if(!lock)throw new Error('이미 같은 채팅 또는 대상에 전송 작업이 진행 중입니다.');
      return fn();
    });
  }
  function wait(kind,value,predicate,ms,signal,onChange){
    return new Promise((resolve,reject)=>{
      let done=false,stop=()=>{},timer;
      const finish=(error,result)=>{if(done)return;done=true;stop();clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(error):resolve(result);};
      const abort=()=>finish(new Error('채팅방 이동 또는 페이지 종료로 작업을 중단했습니다.'));
      const check=next=>{try{if(next)onChange?.(next);if(predicate(next))finish(null,next);}catch(e){finish(e);}};
      stop=watch(kind,value,check);
      timer=setTimeout(()=>finish(new Error('ChatGPT 연결 또는 전송 확인 시간이 초과되었습니다. 대화를 확인한 후 다시 실행해 주세요.')),ms);
      signal?.addEventListener('abort',abort,{once:true});
      if(signal?.aborted)abort();else check(read(kind,value));
    });
  }
  function assertJob(j){
    const lease=read('lease',j.id);
    if(j.aborted || !valid(lease) || lease.cancelled || lease.receiver!==id || lease.url!==j.url)
      throw new Error('Crack 원본 작업이 종료되거나 취소되었습니다.');
    if(CrackGPT.chatUrl(location.href)!==j.url)throw new Error('ChatGPT 대상 채팅이 변경되었습니다.');
  }
  async function findReceiver(url,signal,verify){
    const started=performance.now(),tried=new Set();let opened=false;
    const deadline=Date.now()+CrackGPT.TIMEOUT.tab;
    while(Date.now()<deadline){
      verify();
      const available=GM_listValues().filter(k=>k.startsWith(key('receiver',''))).map(k=>GM_getValue(k,null))
        .filter(r=>r?.url===url && !tried.has(r.id));
      for(const receiver of available){
        tried.add(receiver.id);
        const nonce=crypto.randomUUID();
        try{
          const answer=wait('pong',nonce,r=>valid(r)&&r.receiver===receiver.id,CrackGPT.TIMEOUT.handshake,signal);
          put('inbox',receiver.id,{kind:'ping',nonce,url});
          await answer;verify();
          console.info('[Crack GPT] ChatGPT tab ready duration:',Math.round(performance.now()-started),'ms');
          return receiver.id;
        }catch(e){if(signal.aborted)throw e;}
        finally{remove('pong',nonce);}
      }
      if(!opened){GM_openInTab(url,{active:true,insert:true,setParent:true});opened=true;}
      await CrackGPT.sleep(250);
    }
    throw new Error('ChatGPT userscript에 연결하지 못했습니다. 로그인과 Tampermonkey 실행 허용을 확인하고 ChatGPT 탭을 한 번 새로고침해 주세요.');
  }
  async function send(input,{signal,verify,onStage}){
    const C=CrackGPT;
    return exclusive('source:'+input.chatId+':'+input.presetId,()=>exclusive('destination:'+input.url,async()=>{
      verify();
      const snapshot=await CrackSettings.snapshot(input.chatId,input.presetId);verify();
      if(snapshot.preset.chatUrl!==input.url || await C.digest(snapshot.preset.prompt)!==input.promptHash || snapshot.progressRevision!==input.progressRevision)
        throw new Error('설정 또는 처리 위치가 변경되었습니다. 다시 시도해 주세요.');
      verify();onStage('connect');
      const receiver=await findReceiver(input.url,signal,verify);verify();
      const jobId=crypto.randomUUID(),j={...input,id:jobId,receiver,summaryPrompt:snapshot.preset.prompt};
      let heartbeat;
      const cancel=()=>put('lease',jobId,{cancelled:true,receiver,url:j.url});
      signal.addEventListener('abort',cancel,{once:true});
      // Lease uses its own expiration, not the longer payload retention deadline.
      const lease=()=>{verify();GM_setValue(key('lease',jobId),{receiver,url:j.url,expires:Date.now()+30000});};
      try{
        lease();heartbeat=setInterval(()=>{try{lease();}catch{cancel();}},5000);
        put('payload',jobId,j);
        const resultPromise=wait('state',jobId,s=>valid(s)&&s.receiver===receiver&&s.done,C.TIMEOUT.commit,signal,s=>{if(s.receiver===receiver)onStage(s.stage);});
        put('inbox',receiver,{kind:'run',jobId,url:j.url});
        const result=await resultPromise;verify();
        if(!result.ok || result.confirmed!=='user-message')throw new Error(result.error||'실제 전송 성공을 확인하지 못했습니다.');
        j.checkSource=async()=>verify();
        let warning;
        try{warning=await CrackSettings.updateProgressAfterSuccessfulSend(j);}catch{verify();warning='전송은 성공했지만 처리 위치 저장에 실패했습니다. 다음 실행 전에 범위를 확인해 주세요.';}
        verify();return {ok:true,warning};
      }finally{
        clearInterval(heartbeat);signal.removeEventListener('abort',cancel);
        cancel();remove('payload',jobId);remove('state',jobId);
        // Short-lived cancellation metadata prevents late deliveries; never retry a run.
      }
    }));
  }
  function receive(run){
    let busy=false,current=null,revision=0,suspended=false;
    function announce(){
      let url=null;try{url=CrackGPT.chatUrl(location.href);}catch{}
      if(url!==current){current=url;revision++;}
      // Presence is refreshed by page events and confirmed by ping before use.
      GM_setValue(key('receiver',id),{id,url,expires:Date.now()+86400000});
    }
    const stop=watch('inbox',id,async command=>{
      if(!valid(command))return;
      try{
        if(CrackGPT.chatUrl(location.href)!==command.url)return;
        if(command.kind==='ping'){put('pong',command.nonce,{receiver:id});return;}
        if(command.kind!=='run' || read('consumed',command.jobId))return;
        if(busy){put('state',command.jobId,{receiver:id,done:true,ok:false,error:'ChatGPT에서 다른 로그 전송을 처리 중입니다.'});return;}
        busy=true;
        try{
          await exclusive('receiver:'+command.url,async()=>{
            const j=read('payload',command.jobId);
            if(!valid(j) || j.receiver!==id || j.id!==command.jobId || j.url!==command.url)throw new Error('전송 데이터가 만료되거나 대상이 다릅니다.');
            const initialRevision=revision;
            const verify=()=>{if(suspended || initialRevision!==revision)throw new Error('ChatGPT 페이지 이동으로 전송을 중단했습니다.');assertJob(j);};
            verify();
            // Persist consumption before any DOM effects. A reload cannot replay this job.
            put('consumed',j.id,{receiver:id});
            remove('payload',j.id);
            const state=s=>put('state',j.id,{receiver:id,...s});
            state({stage:'file',done:false});
            const result=await run(j,async stage=>{verify();state({stage,done:false});},verify);
            verify();state({...result,done:true});
          });
        }catch(e){put('state',command.jobId,{receiver:id,done:true,ok:false,error:e.message});}
        finally{busy=false;}
      }catch{/* unrelated route or expired inbox */}
    });
    window.navigation?.addEventListener('currententrychange',announce);
    window.addEventListener('popstate',announce);window.addEventListener('pageshow',()=>{suspended=false;announce();});
    document.addEventListener('visibilitychange',announce);
    window.addEventListener('pagehide',()=>{suspended=true;revision++;remove('receiver',id);remove('inbox',id);});
    announce();return stop;
  }
  return {send,receive,exclusive};
})();

if(location.hostname==='crack.wrtn.ai'){

// Module: route-state.js
(() => {
  'use strict';
  if(CrackRoute)return;
  const subscribers=new Set();let revision=0;
  const current=()=>{try{return CrackRanges.crackChatId(location.href);}catch{return null;}};
  let last=current();
  function refresh(){
    const next=current();if(next===last)return;
    last=next;revision++;
    for(const callback of subscribers)callback({chatId:next,revision});
  }
  // Chrome >=120 provides Navigation.currententrychange for pushState,
  // replaceState and history traversal in the content script's isolated world.
  window.navigation?.addEventListener('currententrychange',refresh);
  window.addEventListener('popstate',refresh);
  window.addEventListener('pageshow',refresh);
  window.addEventListener('hashchange',refresh);
  CrackRoute =Object.freeze({current,refresh,get revision(){refresh();return revision;},
    subscribe(callback){subscribers.add(callback);return ()=>subscribers.delete(callback);}});
})();

// Module: crack-message-api.js
(() => {
  'use strict';
  const ERR={
    chat:'현재 Crack 채팅방 ID를 찾을 수 없습니다.',
    session:'Crack 로그인 세션을 확인할 수 없습니다.',
    expired:'Crack 로그인 세션이 만료되었습니다. 페이지를 새로고침하거나 다시 로그인해주세요.',
    rate:'Crack 메시지 요청 제한에 도달했습니다. 잠시 후 다시 시도해주세요.',
    format:'Crack 메시지 API 응답 형식이 변경되었습니다.',
    network:'Crack 메시지 API에 연결하지 못했습니다.',
    pagination:'Crack 로그 페이지네이션 처리 중 오류가 발생했습니다.',
    changed:'로그 수집 중 채팅방이 변경되었습니다.',
    aborted:'Crack 로그 수집이 취소되었습니다.',
    timeout:'Crack 메시지 API 응답 시간이 초과되었습니다.'
  };
  function getChatId(){
    if(location.origin!=='https://crack.wrtn.ai')return null;
    const id=location.pathname.match(/\/episodes\/([^/?#]+)\/?$/)?.[1];
    try{return id?decodeURIComponent(id):null;}catch{return null;}
  }
  function accessToken(){
    try{
      const cookie=document.cookie.split(';').map(v=>v.trim()).find(v=>v.startsWith('access_token='));
      return cookie?decodeURIComponent(cookie.slice('access_token='.length)):null;
    }catch{return null;}
  }
  // Read only the current access cookie, never retain it in the collector, storage,
  // messages or diagnostics. Raw fetch exceptions/response bodies never escape.
  function requestPage(url,signal){
    const token=accessToken();
    if(!token)throw new Error(ERR.session);
    return fetch(url,{method:'GET',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
      credentials:'omit',cache:'no-store',redirect:'error',signal});
  }
  function isLimitError(json){
    // Narrow, structured evidence only. An arbitrary 400/422 is not retried.
    const candidates=[json?.error,json?.data,json];
    return candidates.some(e=>e && (
      ['INVALID_LIMIT','LIMIT_EXCEEDED','INVALID_PAGE_SIZE','PAGE_SIZE_TOO_LARGE'].includes(e.code) ||
      ['limit','pageSize'].includes(e.field) ||
      (typeof e.message==='string' && /\b(limit|pageSize|page size)\b/i.test(e.message) &&
       /maximum|too (?:large|high)|exceed|between|at most|must be|invalid/i.test(e.message))));
  }
  async function fetchAllMessages({signal,pageSize=500,maxPages=100,maxMessages=50000,requestTimeoutMs=15000,onProgress}={}){
    if(!Number.isSafeInteger(pageSize)||pageSize<1||pageSize>500 ||
       !Number.isSafeInteger(maxPages)||maxPages<1||maxPages>100 ||
       !Number.isSafeInteger(maxMessages)||maxMessages<1||maxMessages>50000 ||
       !Number.isSafeInteger(requestTimeoutMs)||requestTimeoutMs<1||requestTimeoutMs>60000)
      throw new Error('잘못된 API 수집 제한 설정입니다.');
    const initialChatId=getChatId();if(!initialChatId)throw new Error(ERR.chat);
    const controller=new AbortController();let abortError=ERR.aborted;
    const abort=message=>{if(!controller.signal.aborted){abortError=message;controller.abort();}};
    const externalAbort=()=>abort(ERR.aborted),unload=()=>abort(ERR.aborted);
    const check=()=>{
      if(getChatId()!==initialChatId)abort(ERR.changed);
      if(controller.signal.aborted)throw new Error(abortError);
    };
    signal?.addEventListener('abort',externalAbort,{once:true});
    if(signal?.aborted)externalAbort();
    window.addEventListener('pagehide',unload,{once:true});
    const watch=setInterval(()=>{if(getChatId()!==initialChatId)abort(ERR.changed);},100);
    const started=performance.now(),messages=[],seenIds=new Map(),seenCursors=new Set();
    let cursor=null,retriedLimit=false;
    try{
      for(let page=0;page<maxPages;page++){
        check();
        const url=new URL(`https://crack-api.wrtn.ai/crack-gen/v3/chats/${encodeURIComponent(initialChatId)}/messages`);
        url.searchParams.set('limit',String(pageSize));
        if(cursor!==null)url.searchParams.set('cursor',cursor);
        let response,json;
        const timer=setTimeout(()=>abort(ERR.timeout),requestTimeoutMs);
        try{
          try{response=await requestPage(url,controller.signal);}
          catch(e){check();throw new Error(e?.message===ERR.session?ERR.session:ERR.network);}
          check();
          if(response.status===401)throw new Error(ERR.expired);
          if(response.status===429)throw new Error(ERR.rate);
          if(!response.ok){
            if(page===0 && pageSize===500 && !retriedLimit && [400,422].includes(response.status)){
              try{json=await response.json();}catch{check();}
              check();
              if(isLimitError(json)){retriedLimit=true;pageSize=100;page--;continue;}
            }
            throw new Error(`Crack 메시지 API 오류: HTTP ${response.status}`);
          }
          try{json=await response.json();}catch{check();throw new Error(ERR.format);}
          check();
        }finally{clearTimeout(timer);}
        const data=json?.data;
        if(json?.result!=='SUCCESS' || !Array.isArray(data?.messages) || typeof data.hasNext!=='boolean')
          throw new Error(ERR.format);
        for(const message of data.messages){
          // Crack can return historical messages whose embedded chatId differs from the
          // current episode ID. The request endpoint and live route already pin the
          // collection to initialChatId, so message.chatId is metadata, not a validity gate.
          if(typeof message?._id!=='string' || !message._id ||
             typeof message?.content!=='string' || !['user','assistant'].includes(message?.role))
            throw new Error(ERR.format);
          const old=seenIds.get(message._id);
          if(old){
            if(['content','role','turnId','parentTurnId','reroll','status'].some(k=>old[k]!==message[k]))
              throw new Error('API 수집 중 메시지가 변경되었습니다. 다시 시도해주세요.');
            continue;
          }
          seenIds.set(message._id,message);messages.push(message);
          if(messages.length>maxMessages)throw new Error('안전 제한을 초과하는 메시지 수입니다.');
        }
        console.info(`[Crack GPT] API page ${page+1}: ${data.messages.length} messages`);
        onProgress?.({page:page+1,messageCount:messages.length,complete:!data.hasNext});
        check();
        if(!data.hasNext){
          console.info('[Crack GPT] API total messages:',messages.length);
          return messages.reverse();
        }
        if(!data.messages.length || typeof data.nextCursor!=='string' || !data.nextCursor || seenCursors.has(data.nextCursor))
          throw new Error(ERR.pagination);
        seenCursors.add(data.nextCursor);cursor=data.nextCursor;
      }
      throw new Error('Crack 로그 페이지네이션 안전 한도(최대 페이지)에 도달했습니다. 일부 로그는 전송하지 않습니다.');
    }finally{
      clearInterval(watch);signal?.removeEventListener('abort',externalAbort);window.removeEventListener('pagehide',unload);
      console.info('[Crack GPT] API collection duration:',Math.round(performance.now()-started),'ms');
    }
  }
  function normalizeApiMessages(messages){
    return messages.map((message,index)=>({
      id:message._id,messageGroupId:message._id,chronologicalIndex:index+1,
      role:message.role==='assistant'?'character':'user',content:message.content,
      siteTurn:null,links:[],images:[],turnId:message.turnId??null,parentTurnId:message.parentTurnId??null,
      reroll:message.reroll??false,status:message.status??null,source:'api'
    }));
  }
  CrackMessageAPI =Object.freeze({fetchAllMessages,normalizeApiMessages,getChatId});
})();

// Module: crack-log-extractor.js
(() => {
    'use strict';
    function buildLogicalTurns(
        messages
    ) {
        const turns = [];
        const orphans = [];

        let i = 0;
        let logicalTurn = 1;

        while (
            i < messages.length
        ) {
            const current =
                messages[i];

            const next =
                messages[
                    i + 1
                ];

            if (
                current?.role ===
                    'user' &&
                next?.role ===
                    'character'
            ) {
                turns.push({
                    logicalTurn,

                    siteTurn:
                        next.siteTurn,

                    user:
                        current,

                    character:
                        next
                });

                logicalTurn++;
                i += 2;

                continue;
            }

            orphans.push({
                message:
                    current,

                reason:
                    current.role ===
                        'user'
                        ? 'USER 다음에 CHARACTER가 없음'
                        : current.role ===
                              'character'
                        ? '직전 USER와 정상 쌍을 이루지 못함'
                        : '역할 판별 실패'
            });

            i++;
        }

        return {
            turns,
            orphans
        };
    }
    function exportTXT(structure) {
        // Preserve unpaired messages in their original chronological positions.
        const ordered = [...structure.turns.flatMap(t => [t.user, t.character]),
            ...structure.orphans.map(o => o.message)]
            .sort((a, b) => a.chronologicalIndex - b.chronologicalIndex);
        if (ordered.some(m => !['user', 'character'].includes(m.role)))
            throw new Error('화자를 판별하지 못한 메시지가 있어 전송을 중단했습니다.');
        return ordered.map(m => `[${m.role.toUpperCase()}]\n${m.content}`).join('\n\n');
    }
    let running = false;
    async function getCurrentCrackLogText(onProgress, structured = false, options = {}) {
        if (running) throw new Error('이미 로그를 수집하고 있습니다.');
        running = true;
        const initialChatId = CrackMessageAPI.getChatId();
        try {
            const raw = await CrackMessageAPI.fetchAllMessages({...options, onProgress});
            if (CrackMessageAPI.getChatId() !== initialChatId) throw new Error('로그 수집 중 채팅방이 변경되었습니다.');
            const messages = CrackMessageAPI.normalizeApiMessages(raw);
            if (!messages.length || !messages.some(m => m.content.trim())) throw new Error('추출된 RP 로그가 0자입니다.');
            const structure = buildLogicalTurns(messages);
            console.info('[Crack GPT] API logical turns:', structure.turns.length);
            return structured ? structure : exportTXT(structure);
        } finally { running = false; }
    }
    CrackLogExtractor = Object.freeze({getCurrentCrackLogText,
        getCurrentCrackLogStructure: (onProgress, options) => getCurrentCrackLogText(onProgress, true, options)});
})();

// Module: settings-store.js
(() => {
  'use strict';
  const R=CrackRanges,C=CrackGPT;
  let queue=Promise.resolve();
  function transaction(fn){const task=queue.then(()=>Bridge.exclusive('settings',fn,true));queue=task.catch(()=>{});return task;}
  const stored=()=>GM_getValue('cg-settings',{});
  const write=async patch=>GM_setValue('cg-settings',{...stored(),...patch});
  async function settings(){
    const s=stored();
    if(!s.presetSchema){
      const presets=s.presets?.length?s.presets:
        (s.summaryPrompt || s.summaryChatUrl)?[{id:'preset-default',name:'기본 로그 요약',prompt:s.summaryPrompt||'',chatUrl:s.summaryChatUrl||''}]:[];
      Object.assign(s,{presets,selectedPresetId:presets.some(p=>p.id===s.selectedPresetId)?s.selectedPresetId:presets[0]?.id||'',presetSchema:1,settingsRevision:0});
      await write({presets:s.presets,selectedPresetId:s.selectedPresetId,presetSchema:1,settingsRevision:0});
    }
    if(s.cleanerOptions===undefined){s.cleanerOptions=CrackCleaner.options();await write({cleanerOptions:s.cleanerOptions});}
    return {cleanerOptions:CrackCleaner.options(s.cleanerOptions),presets:s.presets||[],selectedPresetId:s.selectedPresetId||'',revision:s.settingsRevision||0};
  }
  async function pair(chatId,presetId){
    const pk=R.key('progress',chatId,presetId),rk=R.key('range',chatId,presetId);
    const data=stored();
    return {progress:data[pk]?.record||null,progressRevision:data[pk]?.revision||0,choice:data[rk]||R.defaults()};
  }
  function validatePreset(p){
    if(!p || typeof p.id!=='string' || !p.id || typeof p.name!=='string' || !p.name.trim())throw new Error('프리셋 이름을 입력해 주세요.');
    if(typeof p.prompt!=='string' || !p.prompt.trim())throw new Error('현재 선택한 프리셋에 지침이 없습니다.');
    if(typeof p.chatUrl!=='string' || !p.chatUrl.trim())throw new Error('현재 선택한 프리셋에 ChatGPT 채팅 URL이 없습니다.');
    return {...p,name:p.name.trim(),chatUrl:C.chatUrl(p.chatUrl)};
  }
  async function handle(m,chatId){
    return transaction(async()=>{
      const s=await settings();
      if(m.type==='CG_SETTINGS_GET'){
        const presetId=m.presetId===undefined?s.selectedPresetId:m.presetId;
        return {ok:true,...s,...await pair(chatId,presetId)};
      }
      if(m.type==='CG_SETTINGS_SAVE'){
        if(m.revision!==s.revision)throw new Error('다른 탭에서 설정이 변경되었습니다. 설정창을 다시 열어 주세요.');
        if(!Array.isArray(m.presets))throw new Error('잘못된 프리셋입니다.');
        const presets=m.presets.map(validatePreset);
        if(new Set(presets.map(p=>p.id)).size!==presets.length)throw new Error('프리셋 ID가 중복되었습니다.');
        const selectedPresetId=presets.some(p=>p.id===m.selectedPresetId)?m.selectedPresetId:presets[0]?.id||'';
        const choice=R.validateChoice(m.choice);
        await write({presets,selectedPresetId,cleanerOptions:CrackCleaner.options(m.cleanerOptions===undefined?s.cleanerOptions:m.cleanerOptions),settingsRevision:s.revision+1,
          [R.key('range',chatId,selectedPresetId)]:choice});
        return {ok:true};
      }
      if(m.type==='CG_PROGRESS_RESET'){
        if(!s.presets.some(p=>p.id===m.presetId))throw new Error('저장된 프리셋을 먼저 선택해 주세요.');
        const state=await pair(chatId,m.presetId);
        await write({[R.key('progress',chatId,m.presetId)]:{revision:state.progressRevision+1,record:null}});
        return {ok:true};
      }
      throw new Error('알 수 없는 설정 요청입니다.');
    });
  }
  const snapshot=(chatId,presetId)=>transaction(async()=>{
    const s=await settings();
    if(!s.presets.length)throw new Error('사용할 지침 프리셋이 없습니다.');
    const p=s.presets.find(p=>p.id===presetId);
    if(!p)throw new Error('선택한 지침 프리셋을 찾지 못했습니다.');
    return {...await pair(chatId,presetId),preset:validatePreset(p)};
  });
  function updateProgressAfterSuccessfulSend(j){
    return transaction(async()=>{
      if(!j.record || j.aborted)return null;
      const s=await settings(),state=await pair(j.chatId,j.presetId);
      if(!s.presets.some(p=>p.id===j.presetId) || state.progressRevision!==j.progressRevision)
        return '전송은 성공했지만 처리 기록이 변경되어 cursor는 갱신하지 않았습니다.';
      await j.checkSource?.();
      if(j.aborted)return '채팅 이동으로 처리 위치를 갱신하지 않았습니다.';
      await write({[R.key('progress',j.chatId,j.presetId)]:
        {revision:state.progressRevision+1,record:{...j.progress,processedAt:Date.now()}}});
      console.info('[Crack GPT] progress updated:',j.progress.lastTurn);
      return null;
    });
  }
  CrackSettings =Object.freeze({handle,snapshot,validatePreset,updateProgressAfterSuccessfulSend});
})();

// Module: settings-modal.js
(() => {
  'use strict';
  const C=CrackGPT,R=CrackRanges;
  const request=m=>C.checked(C.timeout(CrackSettings.handle(m,m.chatId||CrackRoute.current()),C.TIMEOUT.transfer,'설정 연결'));
  let active=null;
  async function open(){
    if(active){active.focus();return;}
    let chatId=R.crackChatId(location.href);
    const initial=await request({type:'CG_SETTINGS_GET'});
    if(chatId!==R.crackChatId(location.href))return;
    if(active){active.focus();return;}
    const host=document.createElement('div');host.id='crack-gpt-settings-host';
    host.style.cssText='all:initial;position:fixed;inset:0;z-index:2147483647;color:#f7f8ff;font-family:ui-sans-serif,-apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif';
    const root=host.attachShadow({mode:'open'});
    root.innerHTML=`<style>
      :host{font:14px/1.45 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#eefcf7;color-scheme:dark}
      *{box-sizing:border-box}
      #overlay{position:fixed;inset:0;display:grid;place-items:center;padding:24px;background:rgba(5,9,9,.74);font:inherit;color:#effff8}
      #dialog{position:relative;width:min(668px,100%);max-height:min(900px,92vh);overflow:auto;border:1px solid rgba(134,172,160,.14);border-radius:26px;background:
        linear-gradient(180deg,#141b19 0%,#101616 54%,#0f1416 100%);
        box-shadow:0 18px 44px rgba(0,0,0,.4),inset 0 1px 0 rgba(255,255,255,.035);scrollbar-width:thin;scrollbar-color:#35665a transparent;contain:layout paint;overscroll-behavior:contain}
      #dialog::-webkit-scrollbar{width:8px}#dialog::-webkit-scrollbar-thumb{background:#35665a;border-radius:999px}
      header{position:sticky;top:0;z-index:2;display:flex;align-items:flex-start;justify-content:space-between;gap:18px;padding:22px 24px 18px;background:linear-gradient(180deg,rgba(20,28,26,.98),rgba(16,23,22,.97));border-bottom:1px solid rgba(134,172,160,.08)}
      #hero{display:flex;align-items:flex-start;gap:14px}
      #eyebrow{margin:0 0 6px;color:#9abbb0;font-size:11px;font-weight:800;letter-spacing:.2em;text-transform:uppercase}
      h2{margin:0;color:#fff!important;font-size:22px;line-height:1.12;letter-spacing:-.03em}
      #subtitle{margin:7px 0 0;color:#b3c9c2;font-size:12px;line-height:1.55;max-width:46ch}
      #close{display:grid;place-items:center;flex:0 0 auto;width:38px;height:38px;padding:0;border-radius:12px;background:rgba(255,255,255,.06);border:1px solid rgba(134,172,160,.12);color:#d9fff1;font-size:20px;line-height:1;cursor:pointer}
      #close:hover{background:rgba(255,255,255,.11);color:#fff}
      #content{display:grid;gap:15px;padding:0 24px 22px}
      .card{padding:17px;border:1px solid rgba(134,172,160,.09);border-radius:18px;background:linear-gradient(180deg,rgba(8,16,16,.52),rgba(7,12,16,.52));box-shadow:inset 0 1px 0 rgba(255,255,255,.03)}
      .cardTitle{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:13px}
      .cardTitle h3{margin:0;color:#fff!important;font-size:13px;letter-spacing:-.01em}.muted{color:#9fc9bc!important;font-size:11px}
      label.field{display:block;margin-top:12px;color:#effff8!important;font-size:12px;font-weight:650}
      label.field:first-child{margin-top:0}
      input,select,textarea,button{font:inherit;color:inherit}
      input:not([type=radio]):not([type=checkbox]),select,textarea{width:100%;margin-top:6px;border:1px solid rgba(95,178,154,.26);border-radius:12px;background:#0a1316;color:#f5fffb;padding:10px 11px;transition:border-color .15s ease,box-shadow .15s ease,background .15s ease}
      input:not([type=radio]):not([type=checkbox]):hover,select:hover,textarea:hover{border-color:rgba(102,228,190,.38)}
      input:not([type=radio]):not([type=checkbox]):focus,select:focus,textarea:focus{outline:none;border-color:#6ca494;box-shadow:0 0 0 2px rgba(108,164,148,.12);background:#0d1718}
      textarea{min-height:150px;resize:vertical;line-height:1.6}
      #promptMeta{display:block;margin-top:7px;color:#8fc0b1!important;font-size:10px;text-align:right}
      select{appearance:none;background-image:linear-gradient(45deg,transparent 50%,#81cdb3 50%),linear-gradient(135deg,#81cdb3 50%,transparent 50%);background-position:calc(100% - 16px) 48%,calc(100% - 11px) 48%;background-size:5px 5px,5px 5px;background-repeat:no-repeat;padding-right:34px}
      button{border:1px solid rgba(134,172,160,.12);border-radius:12px;padding:9px 12px;background:rgba(255,255,255,.06);cursor:pointer;transition:background .14s ease,border-color .14s ease,transform .14s ease,opacity .14s ease,box-shadow .14s ease}
      button:hover:not(:disabled){background:rgba(255,255,255,.11);border-color:rgba(96,236,190,.22)}button:active:not(:disabled){transform:scale(.98)}button:disabled{opacity:.45;cursor:not-allowed}
      button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:2px solid #8eb9aa;outline-offset:2px}
      #presetTools{display:flex;gap:7px}#new{color:#e9fff7!important}#delete{color:#ffc8cf!important}
      #history{position:relative;white-space:pre-wrap;line-height:1.7;margin:0;padding:13px 14px 13px 40px;border-radius:13px;background:linear-gradient(135deg,rgba(73,120,106,.13),rgba(71,103,132,.08));border:1px solid rgba(134,172,160,.13);color:#d7f0e7;font-size:12px}
      #history::before{content:'↻';position:absolute;left:14px;top:13px;color:#9fc7b9;font-weight:700}
      #chat{display:block;margin-top:9px;color:#84b2a3;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      #reset{margin-top:11px;padding:7px 10px;font-size:11px;color:#d7fff0!important;background:transparent}
      fieldset.card{margin:0;min-width:0}legend{padding:0 7px;color:#fff!important;font-size:13px;font-weight:700}
      #rangeModes{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:7px;margin:2px 0 12px}
      #rangeModes label{position:relative;display:flex;align-items:center;justify-content:center;min-height:42px;margin:0;padding:8px 7px;border:1px solid rgba(95,178,154,.18);border-radius:12px;background:rgba(255,255,255,.035);cursor:pointer;text-align:center;color:#cfe8df!important;font-size:12px;font-weight:600;transition:border-color .14s ease,background .14s ease,color .14s ease,transform .14s ease}
      #rangeModes label:hover{border-color:rgba(96,236,190,.28);background:rgba(255,255,255,.055)}
      #rangeModes label:has(input:checked){border-color:rgba(111,160,145,.36);background:rgba(91,126,115,.14);color:#fff!important;box-shadow:none}
      #rangeModes input{position:absolute;opacity:0;inset:0;cursor:pointer}
      #manual{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-top:2px}
      #manual label,#recordLabel,#cleanerOptions label{display:block;color:#e9fff8!important;font-size:12px}
      #recordLabel{margin-top:11px;cursor:pointer}
      #recordLabel input,#cleanerOptions input{margin-right:8px;accent-color:#6a9e8e}
      #cleanerOptions{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 12px;margin-top:4px}
      #cleanerOptions label{padding:11px 12px;border:1px solid rgba(95,178,154,.14);border-radius:13px;background:rgba(255,255,255,.03);cursor:pointer;line-height:1.45;color:#dff7ee!important}
      #cleanerOptions label:hover{border-color:rgba(96,236,190,.22);background:rgba(255,255,255,.05)}
      #cleanerOptions label:has(input:checked){border-color:rgba(111,160,145,.28);background:rgba(91,126,115,.12);color:#fff!important}
      #error{min-height:22px;padding:0 24px 8px;color:#ffb7bf;font-size:12px;white-space:pre-wrap}
      footer{position:sticky;bottom:0;z-index:2;display:flex;justify-content:flex-end;padding:14px 24px 20px;background:linear-gradient(180deg,rgba(17,23,22,.2),rgba(16,22,21,.96) 42%,rgba(16,22,21,.98))}
      #save{min-width:132px;padding:10px 16px;font-weight:700;color:#fcfffe!important;background:#477f6f;box-shadow:none}
      #save:hover:not(:disabled){background:#508b7a}

      #dialog{color:#f7f8ff!important}
      #eyebrow{color:#9abbb0!important}
      #subtitle{color:#b8cbc4!important}
      .card{color:#f7f8ff!important}
      input:not([type=radio]):not([type=checkbox]),select,textarea{color:#fff!important}
      input::placeholder,textarea::placeholder{color:#8ab3a8!important;opacity:1}
      option{background:#101a1b;color:#fff}
      #rangeModes label:has(input:checked){color:#fff!important}
      #history{color:#eefcf7!important}
      #chat{color:#84b2a3!important}
      [hidden]{display:none!important}
      @media(max-width:620px){#overlay{padding:10px;place-items:end center}#dialog{width:100%;max-height:94vh;border-radius:24px 24px 16px 16px}header{padding:19px 18px 16px}#content{padding:0 18px 18px}footer{padding:12px 18px 16px}#rangeModes{grid-template-columns:1fr}#cleanerOptions{grid-template-columns:1fr}}
      @media(prefers-reduced-motion:reduce){button,input,select,textarea,#rangeModes label,#cleanerOptions label{transition:none}}
    </style><div id="overlay"><section id="dialog" role="dialog" aria-modal="true" aria-labelledby="title" tabindex="-1">
      <header><div id="hero"><div><p id="eyebrow">CRACK × GPT</p><h2 id="title">로그 매니저 설정</h2><p id="subtitle">로그를 선택한 ChatGPT 채팅으로 전송합니다.</p></div></div><button id="close" aria-label="설정 닫기">×</button></header>
      <div id="content">
        <section class="card">
          <div class="cardTitle"><h3>지침 프리셋</h3><div id="presetTools"><button id="new">＋ 새 프리셋</button><button id="delete">삭제</button></div></div>
          <label class="field" for="presets">현재 프리셋<select id="presets"></select></label>
          <label class="field" for="name">프리셋 이름<input id="name" maxlength="100" placeholder="예: 장기 로그 요약"></label>
          <label class="field" for="url">ChatGPT 채팅 URL<input id="url" type="url" placeholder="https://chatgpt.com/c/…"></label>
          <label class="field" for="prompt">요약 지침<textarea id="prompt" rows="7" placeholder="이 로그를 어떻게 정리할지 지침을 입력하세요."></textarea><small id="promptMeta">0자</small></label>
        </section>
        <section class="card">
          <div class="cardTitle"><h3>현재 채팅 처리 기록</h3><span class="muted">프리셋별로 따로 기억됩니다</span></div>
          <div id="history" aria-live="polite"></div><small id="chat"></small><button id="reset">처리 위치 초기화</button>
        </section>
        <fieldset class="card"><legend>로그 정리</legend><div id="cleanerOptions"></div></fieldset>
        <fieldset class="card"><legend>이번 전송 범위</legend>
          <div id="rangeModes">
            <label><input type="radio" name="mode" value="after" checked><span>마지막 처리 이후</span></label>
            <label><input type="radio" name="mode" value="all"><span>전체 로그</span></label>
            <label><input type="radio" name="mode" value="manual"><span>직접 지정</span></label>
          </div>
          <div id="manual"><label>시작<input id="start" type="number" min="1" step="1"></label><label>끝<input id="end" type="number" min="1" step="1" placeholder="현재 (비워 두기)"></label></div>
          <label id="recordLabel"><input id="record" type="checkbox"><span>이 범위를 마지막 처리 위치로 기록</span></label>
        </fieldset>
      </div>
      <div id="error" role="alert"></div>
      <footer><button id="save">저장 후 닫기</button></footer>
    </section></div>`;
    document.documentElement.append(host);
    const el=id=>root.getElementById(id),previousFocus=document.activeElement;
    const cleanerLabels={removeImageMarkdown:'이미지 마크다운 제거',removeImageUrls:'이미지 URL 제거',removeComments:'HTML·마크다운 주석 제거',normalizeBlankLines:'빈 줄 정리',removeLoreOoc:'로어 전용 OOC 제거',removeMarkdownDecoration:'일반 마크다운 장식 제거'};
    const cleanerValues=CrackCleaner.options(initial.cleanerOptions);
    for(const [key,label] of Object.entries(cleanerLabels)){
      const row=document.createElement('label'),input=document.createElement('input');input.type='checkbox';input.id='cleaner-'+key;input.checked=cleanerValues[key];row.append(input,document.createTextNode(label));el('cleanerOptions').append(row);
    }
    let presets=structuredClone(initial.presets),selected=initial.selectedPresetId,loadToken=0,busy=false,loading=false;
    let currentChoice=initial.choice,record=initial.progress;
    const close=()=>{unsubscribe();GM_removeValueChangeListener(storageListener);host.remove();active=null;previousFocus?.focus?.();};
    active=el('dialog');active.focus();
    const error=e=>el('error').textContent=e.message||String(e);
    function stash(){const p=presets.find(p=>p.id===selected);if(p)Object.assign(p,{name:el('name').value,prompt:el('prompt').value,chatUrl:el('url').value});}
    function updatePromptMeta(){const n=el('prompt').value.length;el('promptMeta').textContent=n>C.LONG_PROMPT_THRESHOLD?`${n.toLocaleString()}자 · 긴 지침은 TXT로 자동 첨부됩니다.`:`${n.toLocaleString()}자`;}
    function controls(){
      const mode=root.querySelector('input[name=mode]:checked').value;
      el('manual').hidden=mode!=='manual';el('recordLabel').hidden=mode==='after';
    }
    function showRecord(){
      el('history').textContent=record?`마지막 전송: T${record.rangeStart} ~ T${record.rangeEnd}\n${new Date(record.processedAt).toLocaleString()}\n다음 전송: T${record.lastTurn+1} ~ 현재`:
        '마지막 전송: 없음\n다음 전송: T1 ~ 현재';
      el('chat').textContent=`현재 채팅: ${chatId}`;
    }
    function showChoice(){
      root.querySelector(`input[name=mode][value="${currentChoice.mode}"]`).checked=true;
      el('start').value=currentChoice.mode==='manual'?currentChoice.start:(record?.lastTurn||0)+1;
      el('end').value=currentChoice.end;el('record').checked=currentChoice.record;controls();
    }
    function renderPreset(){
      el('presets').replaceChildren();
      for(const p of presets){const option=document.createElement('option');option.value=p.id;option.textContent=p.name||'이름 없는 지침';el('presets').append(option);}
      el('presets').value=selected;
      const p=presets.find(p=>p.id===selected);
      for(const [id,key] of [['name','name'],['prompt','prompt'],['url','chatUrl']]){el(id).value=p?.[key]||'';el(id).disabled=!p;}
      updatePromptMeta();
      el('delete').disabled=!p;el('reset').disabled=!p || !initial.presets.some(x=>x.id===selected);
    }
    async function loadPair(changeChoice=true){
      loading=true;el('save').disabled=true;
      const token=++loadToken,presetId=selected,at=chatId;
      try {
      const data=await request({type:'CG_SETTINGS_GET',chatId:at,presetId});
      if(token!==loadToken || at!==chatId || !host.isConnected)return;
      record=data.progress;showRecord();
      if(changeChoice){currentChoice=data.choice;showChoice();}
      }finally{if(token===loadToken){loading=false;el('save').disabled=busy;}}
    }
    el('prompt').addEventListener('input',updatePromptMeta);
    el('presets').onchange=()=>{stash();selected=el('presets').value;renderPreset();loadPair().catch(error);};
    el('new').onclick=()=>{stash();const p={id:crypto.randomUUID(),name:'새 지침',prompt:'',chatUrl:''};presets.push(p);selected=p.id;renderPreset();loadPair().catch(error);el('name').focus();};
    el('delete').onclick=()=>{presets=presets.filter(p=>p.id!==selected);selected=presets[0]?.id||'';renderPreset();loadPair().catch(error);};
    el('reset').onclick=async()=>{try{await request({type:'CG_PROGRESS_RESET',chatId,presetId:selected});await loadPair(false);}catch(e){error(e);}};
    root.querySelectorAll('input[name=mode]').forEach(input=>input.onchange=controls);
    el('save').onclick=async()=>{
      if(busy || loading)return;busy=true;el('save').disabled=true;el('error').textContent='';
      try{
        if(chatId!==R.crackChatId(location.href))throw new Error('채팅방이 변경되었습니다. 범위를 다시 확인해 주세요.');
        stash();const choice=R.validateChoice({mode:root.querySelector('input[name=mode]:checked').value,start:el('start').value,end:el('end').value,record:el('record').checked});
        await request({type:'CG_SETTINGS_SAVE',chatId,cleanerOptions:Object.fromEntries(Object.keys(cleanerLabels).map(key=>[key,el('cleaner-'+key).checked])),presets,selectedPresetId:selected,revision:initial.revision,choice});close();
      }catch(e){error(e);}finally{busy=false;el('save').disabled=false;}
    };
    el('close').onclick=close;el('overlay').onclick=e=>{if(e.target===el('overlay'))close();};
    // Keep modal editing events inside the Shadow DOM. Crack has page-level keyboard/focus
    // handlers; letting Enter/Shift+Enter escape the modal can make the site steal focus
    // from our textarea after a paste. stopPropagation() does NOT cancel the textarea's
    // native behavior, so Enter still inserts a newline normally.
    root.addEventListener('keydown',e=>{
      e.stopPropagation();
      if(e.key==='Escape'){close();return;}
      if(e.key==='Tab'){
        const items=[...root.querySelectorAll('button,input,select,textarea')].filter(x=>!x.disabled&&x.getClientRects().length);
        const first=items[0],last=items.at(-1);
        if(e.shiftKey && (root.activeElement===first || root.activeElement===el('dialog'))){e.preventDefault();last.focus();}
        else if(!e.shiftKey && root.activeElement===last){e.preventDefault();first.focus();}
      }
    });
    for(const type of ['keyup','keypress','beforeinput','input','change','paste','cut','copy','focusin','focusout','click','pointerdown','pointerup'])
      root.addEventListener(type,e=>e.stopPropagation());
    const storageListener=GM_addValueChangeListener('cg-settings',(_key,oldValue,newValue)=>{
      const k=R.key('progress',chatId,selected);
      if(JSON.stringify(oldValue?.[k])!==JSON.stringify(newValue?.[k]))loadPair(false).catch(error);
    });
    const unsubscribe=CrackRoute.subscribe(({chatId:next})=>{
      if(!next){close();return;}
      if(next!==chatId){chatId=next;el('history').textContent='현재 채팅 기록 확인 중…';loadPair().catch(error);}
    });
    renderPreset();showRecord();showChoice();
  }
  CrackSettingsModal =Object.freeze({open});
})();

// Module: crack.js
(() => {
  'use strict';
  if (document.getElementById('crack-gpt-summary-host')) return;
  const C = CrackGPT;
  const POSITION_KEY='crackGptLauncherPosition';
  const EDGE_GAP=14;
  const DRAG_THRESHOLD=3;

  const host = document.createElement('div');
  host.id='crack-gpt-summary-host';
  host.style.cssText='position:fixed;left:18px;bottom:18px;z-index:2147483646;max-width:calc(100vw - 28px);';
  const root=host.attachShadow({mode:'closed'});
  root.innerHTML=`<style>
    :host{font:13px/1.4 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#effff8}
    *{box-sizing:border-box}
    #panel{position:relative;max-width:min(372px,calc(100vw - 28px));padding:8px;border:1px solid rgba(139,174,163,.16);border-radius:20px;background:
      linear-gradient(180deg,#151b1a 0%,#111615 100%);
      box-shadow:0 10px 26px rgba(0,0,0,.28),inset 0 1px 0 rgba(255,255,255,.04);transition:box-shadow .18s ease,transform .18s ease,border-color .18s ease;touch-action:none;overflow:hidden}
        #panel:hover{border-color:rgba(149,190,177,.26);box-shadow:0 12px 30px rgba(0,0,0,.32),inset 0 1px 0 rgba(255,255,255,.05)}
    #panel.dragging{cursor:grabbing;transform:scale(1.01);border-color:rgba(132,186,169,.38);box-shadow:0 14px 32px rgba(0,0,0,.35)}
    #actions{display:flex;align-items:center;gap:6px}
    button{border:0;font:600 13px/1 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:inherit;cursor:pointer;transition:transform .14s ease,filter .14s ease,background .14s ease,opacity .14s ease,box-shadow .14s ease;-webkit-tap-highlight-color:transparent}
    button:active{transform:scale(.97)}
    button:focus-visible{outline:2px solid #7ff1c7;outline-offset:2px}
    button:disabled{opacity:.58;cursor:wait;transform:none}
    #send{position:relative;min-height:36px;padding:0 13px;border-radius:11px;background:#3f7e6d;box-shadow:none;white-space:nowrap;letter-spacing:-.01em;color:#f8fffc}
    #send:not(:disabled):hover{filter:brightness(1.08);box-shadow:none}
    #settings{display:grid;place-items:center;width:36px;height:36px;padding:0;border-radius:11px;background:rgba(255,255,255,.06);color:#d7e4e0;font-size:15px;border:1px solid rgba(145,183,171,.1)}
    #settings:hover{background:rgba(255,255,255,.12);color:#fff}
    #grip{display:grid;place-items:center;width:16px;height:32px;margin-right:-2px;color:#6f8f85;font-size:12px;letter-spacing:-4px;cursor:grab;user-select:none;-webkit-user-select:none;opacity:.75}
    #panel.dragging #grip{cursor:grabbing;color:#b6cbc4}
    #status{max-width:340px;margin-top:6px;padding:8px 10px;border-radius:10px;background:rgba(8,13,13,.62);border:1px solid rgba(145,183,171,.08);color:#c9d9d4;font-size:12px;line-height:1.55;white-space:pre-wrap;overflow-wrap:anywhere;user-select:text;-webkit-user-select:text}
    #status:empty{display:none}
    @media(max-width:560px){#panel{max-width:calc(100vw - 24px)}}
    @media(prefers-reduced-motion:reduce){#panel,button{transition:none}}
  </style><section id="panel" aria-label="GPT 로그 매니저"><div id="actions"><span id="grip" aria-hidden="true">⠿</span><button id="send">GPT 로그 요약</button><button id="settings" aria-label="GPT 로그 요약 설정" title="설정">⚙</button></div><div id="status" role="status" aria-live="polite"></div></section>`;
  document.documentElement.append(host);

  const panel=root.getElementById('panel');
  const button=root.getElementById('send');
  const status=root.getElementById('status');
  const request=m=>C.checked(C.timeout(CrackSettings.handle(m,m.chatId||CrackRoute.current()),C.TIMEOUT.transfer,'설정 읽기'));
  let operation=null;
  const showStage=value=>{if(C.STAGES[value])status.textContent=C.STAGES[value];};

  function clampPosition(x,y){
    const rect=host.getBoundingClientRect();
    const width=rect.width || 220,height=rect.height || 50;
    return {
      x:Math.max(EDGE_GAP,Math.min(x,window.innerWidth-width-EDGE_GAP)),
      y:Math.max(EDGE_GAP,Math.min(y,window.innerHeight-height-EDGE_GAP))
    };
  }
  function applyPosition(pos){
    if(!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y))return;
    const next=clampPosition(pos.x,pos.y);
    host.style.left=`${Math.round(next.x)}px`;
    host.style.top=`${Math.round(next.y)}px`;
    host.style.right='auto';
    host.style.bottom='auto';
  }
  async function restorePosition(){
    try{
      const pos=GM_getValue(POSITION_KEY,null);
      if(pos)applyPosition(pos);
    }catch{}
  }
  function savePosition(){
    const rect=host.getBoundingClientRect();
    GM_setValue(POSITION_KEY,{x:Math.round(rect.left),y:Math.round(rect.top)});
  }

  // Classic click-drag: press the launcher and move it immediately. A click without movement keeps button actions intact.
  let drag=null,suppressClickUntil=0;
  panel.addEventListener('pointerdown',e=>{
    if(e.button!==0 || e.isPrimary===false || e.target.closest('#status'))return;
    const rect=host.getBoundingClientRect();
    drag={pointerId:e.pointerId,startX:e.clientX,startY:e.clientY,left:rect.left,top:rect.top,active:false};
    // Do not capture on pointerdown. Capturing here retargets pointerup/click to #panel
    // and prevents the send/settings buttons from receiving their normal click.
    // Capture only after actual pointer movement turns this gesture into a drag.
  });
  panel.addEventListener('pointermove',e=>{
    if(!drag || drag.pointerId!==e.pointerId)return;
    const dx=e.clientX-drag.startX,dy=e.clientY-drag.startY;
    if(!drag.active){
      if(Math.hypot(dx,dy)<DRAG_THRESHOLD)return;
      drag.active=true;
      suppressClickUntil=Date.now()+500;
      panel.classList.add('dragging');
      try{panel.setPointerCapture(e.pointerId);}catch{}
    }
    e.preventDefault();
    const next=clampPosition(drag.left+dx,drag.top+dy);
    host.style.left=`${Math.round(next.x)}px`;
    host.style.top=`${Math.round(next.y)}px`;
    host.style.right='auto';
    host.style.bottom='auto';
  });
  const finishDrag=e=>{
    if(!drag || drag.pointerId!==e.pointerId)return;
    const wasActive=drag.active;
    if(wasActive){
      e.preventDefault();
      suppressClickUntil=Date.now()+500;
      panel.classList.remove('dragging');
      savePosition();
    }
    try{panel.releasePointerCapture(e.pointerId);}catch{}
    drag=null;
  };
  panel.addEventListener('pointerup',finishDrag);
  panel.addEventListener('pointercancel',finishDrag);
  panel.addEventListener('lostpointercapture',()=>{
    if(drag?.active){panel.classList.remove('dragging');savePosition();}
    drag=null;
  });
  root.addEventListener('click',e=>{
    if(Date.now()<suppressClickUntil){e.preventDefault();e.stopImmediatePropagation();}
  },true);
  window.addEventListener('resize',()=>{
    if(host.style.top){const r=host.getBoundingClientRect();applyPosition({x:r.left,y:r.top});savePosition();}
  },{passive:true});
  restorePosition();

  root.getElementById('settings').onclick=()=>CrackSettingsModal.open().catch(e=>status.textContent=e.message);
  const update=()=>{
    host.hidden=!CrackRoute.current();
    if(!host.isConnected && !document.getElementById(host.id))document.documentElement.append(host);
  };
  // Only direct children of <html>, no subtree scans or route polling.
  let repairQueued=false;
  const repair=new MutationObserver(()=>{
    if(host.isConnected || repairQueued)return;
    repairQueued=true;queueMicrotask(()=>{repairQueued=false;update();});
  });
  repair.observe(document.documentElement,{childList:true});
  CrackRoute.subscribe(()=>{
    if(operation){operation.cancelled=true;operation.controller.abort();}
    status.textContent=operation?'채팅방 이동으로 작업을 중단했습니다.':'';update();
  });
  window.addEventListener('pagehide',()=>{
    if(operation){operation.cancelled=true;operation.controller.abort();}
  });
  update();
  button.onclick=async()=>{
    if(button.disabled)return;
    button.disabled=true; button.textContent='로그 수집 중…';status.textContent='Crack 로그 불러오는 중…';
    const run={chatId:CrackRoute.current(),revision:CrackRoute.revision,controller:new AbortController(),cancelled:false};
    operation=run;
    const verify=()=>{if(run.cancelled || CrackRoute.current()!==run.chatId || CrackRoute.revision!==run.revision)throw new Error('채팅방 이동으로 작업을 중단했습니다.');};
    let collecting=false;
    try {
      const startUrl=location.href;
      const chatId=CrackRanges.crackChatId(startUrl);
      const settings=await request({type:'CG_SETTINGS_GET',chatId});verify();
      if(!settings.presets.length)throw new Error('사용할 지침 프리셋이 없습니다.');
      const preset=settings.presets.find(p=>p.id===settings.selectedPresetId);
      if(!preset)throw new Error('사용할 지침 프리셋이 없습니다.');
      if(!preset.name.trim())throw new Error('프리셋 이름을 입력해 주세요.');
      if(!preset.chatUrl.trim())throw new Error('현재 선택한 프리셋에 ChatGPT 채팅 URL이 없습니다.');
      const url=C.chatUrl(preset.chatUrl);C.makePrompt(preset.prompt);
      collecting=true;
      const structure=await CrackLogExtractor.getCurrentCrackLogStructure(p=>{status.textContent=`Crack 로그 불러오는 중… ${p.messageCount}개 수집${p.complete?' 완료':` · ${p.page}페이지`}`;},{signal:run.controller.signal});verify();
      collecting=false;
      if(CrackRanges.crackChatId(location.href)!==chatId)throw new Error('추출 도중 채팅방이 변경되었습니다.');
      showStage('extract');
      const selected=await CrackRanges.sliceLogicalTurns(structure,settings.choice,settings.progress);
      verify();
      const log=CrackCleaner.cleanRpLog(selected.text,settings.cleanerOptions);
      if(!log.trim())throw new Error('TXT 생성 실패: 선택 범위의 로그가 없습니다.');
      console.info('[Crack GPT] chat id:',chatId);
      console.info('[Crack GPT] selected preset:',preset.id);
      console.info('[Crack GPT] current last turn:',selected.currentLastTurn);
      console.info('[Crack GPT] previous cursor:',settings.progress?.lastTurn||0);
      console.info('[Crack GPT] selected range:',selected.progress.rangeStart,selected.progress.rangeEnd);
      console.info('[Crack GPT] generated txt chars:',log.length);
      const hash=await C.digest(log);verify();
      const promptHash=await C.digest(preset.prompt);verify();
      showStage('connect');button.textContent='전송 중…';
      if(CrackRanges.crackChatId(location.href)!==chatId)throw new Error('채팅방이 변경되었습니다.');
      const result=await Bridge.send({chatId,url,text:log,length:log.length,hash,presetId:preset.id,promptHash,
        progressRevision:settings.progressRevision,progress:selected.progress,record:selected.record,fileName:selected.fileName},
        {signal:run.controller.signal,verify,onStage:showStage});verify();
      if(!result.ok)throw new Error(result.error);
      status.textContent=result.warning || `ChatGPT로 T${selected.progress.rangeStart} ~ T${selected.progress.rangeEnd} 로그를 전송했습니다.`;
    } catch(e) {
      status.textContent=`${collecting?'로그 수집 실패':'GPT 로그 요약 전송 실패'}:\n${e.message || '로그 추출 또는 연결 실패입니다.'}`;
      console.warn('[Crack GPT] operation failed');
    } finally {
      operation=null;
      button.disabled=false;button.textContent='GPT 로그 요약';
    }
  };
})();

}else if(location.hostname==='chatgpt.com'){
(() => {
  'use strict';
  if(location.origin!=='https://chatgpt.com')return;
  const C=CrackGPT;
  const visible=el=>el && el.getClientRects().length && getComputedStyle(el).visibility!=='hidden';
  function target(url){
    let current;
    try{current=C.chatUrl(location.href);}catch{throw new Error('ChatGPT 로그인 또는 지정한 채팅 접근 권한을 확인해 주세요.');}
    if(current!==url)throw new Error('ChatGPT 대상 채팅이 변경되었습니다.');
  }
  function read(el){
    if(el instanceof HTMLTextAreaElement)return el.value;
    // innerText adds layout-dependent blank lines between paragraphs. Read the
    // editor's paragraph structure instead, retaining actual empty paragraphs.
    function inline(node){
      if(node.nodeType===Node.TEXT_NODE)return node.textContent;
      if(node.nodeName==='BR')return '\n';
      return [...node.childNodes].map(inline).join('');
    }
    return [...el.childNodes].map(node=>{
      let value=inline(node);
      if(node.nodeType===Node.ELEMENT_NODE && /^(P|DIV)$/.test(node.nodeName) && node.lastChild?.nodeName==='BR')
        value=value.slice(0,-1); // browser/ProseMirror's terminal caret placeholder
      return value;
    }).join('\n');
  }
  const normalize=s=>s.replace(/\r\n?/g,'\n');
  const progress=(j,value)=>j.report(value);
  // DOM changes wake the waiter immediately; polling also detects navigation and
  // non-mutating visibility changes. Every path disconnects observers and timers.
  function waitFor(fn,ms,error,j){
    return new Promise((resolve,reject)=>{
      let timer,poll,observer;
      const end=(err,value)=>{clearTimeout(timer);clearInterval(poll);observer?.disconnect();err?reject(err):resolve(value);};
      const check=()=>{
        try {
          j.verify();target(j.url);
          if(j.aborted)throw new Error('전송 작업이 중단되었습니다.');
          const value=fn();if(value)end(null,value);
        }catch(e){end(e);}
      };
      timer=setTimeout(()=>end(new Error(error)),ms);
      poll=setInterval(check,200);
      observer=new MutationObserver(check);
      observer.observe(document.documentElement,{childList:true,subtree:true,attributes:true,characterData:true});
      check();
    });
  }
  const enabled=el=>visible(el) && !el.disabled && el.getAttribute('aria-disabled')!=='true';
  function findSendButton(form){
    const selectors=[
      'button[data-testid="send-button"]',
      'button[data-testid="composer-submit-button"]',
      'button[type="submit"]',
      'button[aria-label="Send prompt"]',
      'button[aria-label="프롬프트 보내기"]'
    ];
    const candidates=selectors.map(selector=>form.querySelector(selector)).filter(Boolean);
    return candidates.find(visible) || candidates[0] || null;
  }
  // Only visible filename text inside this composer counts, excluding the draft.
  function filenameVisible(form,editor,fileName){
    if(!form.isConnected)return false;
    const walker=document.createTreeWalker(form,NodeFilter.SHOW_TEXT);
    for(let node;node=walker.nextNode();){
      if(!node.textContent.includes(fileName) || editor.contains(node))continue;
      const parent=node.parentElement;
      if(!parent || parent.closest('script,style') || !visible(parent))continue;
      const range=document.createRange();range.selectNodeContents(node);
      if(range.getClientRects().length)return true;
    }
    return false;
  }
  async function attachFiles(j,files,form,editor){
    await progress(j,'file');
    for(const file of files)console.info('[Crack GPT] attachment bytes:',file.name,file.size);
    await progress(j,'attach');
    const acceptsText=input=>!input.disabled && (!input.accept || input.accept.split(',').some(t=>
      ['.txt','text/plain','text/*','*/*'].includes(t.trim().toLowerCase())));
    function findInput(){
      const known=form.querySelector('input#upload-files[type="file"]');
      if(known && acceptsText(known))return known;
      const candidates=[...form.querySelectorAll('input[type="file"]')].filter(acceptsText);
      if(candidates.length>1)throw new Error('TXT 첨부: 파일 input을 하나로 식별하지 못했습니다.');
      return candidates[0];
    }
    const ensureInput=async()=>{
      let input=findInput();
      if(!input){
        const plus=form.querySelector('button[data-testid="composer-plus-btn"]');
        if(enabled(plus) && plus.getAttribute('aria-expanded')!=='true')plus.click();
        input=await waitFor(findInput,C.TIMEOUT.fileInput,'TXT 첨부: 파일 input 탐색 시간이 초과되었습니다.',j);
      }
      return input;
    };
    if(read(editor).trim())throw new Error('TXT 첨부 전에 기존 초안이 발견되었습니다.');
    for(const file of files)if(filenameVisible(form,editor,file.name))throw new Error(`TXT 첨부 전에 기존 첨부파일(${file.name})이 발견되었습니다.`);
    // Attach one file per change event. This works whether ChatGPT's input is single- or multi-file,
    // and survives the site replacing/resetting the hidden input after each upload.
    for(const file of files){
      const input=await ensureInput();
      const transfer=new DataTransfer();transfer.items.add(file);
      try {input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));}
      catch {throw new Error(`ChatGPT에 ${file.name} 파일을 첨부하지 못했습니다. 파일 지정이 거부되었습니다.`);}
      await waitFor(()=>filenameVisible(form,editor,file.name),C.TIMEOUT.attach,
        `${file.name} 첨부를 확인하지 못했습니다.`,j);
    }
    console.info('[Crack GPT] files attached:',files.map(f=>f.name).join(', '));
  }
  async function commit(j){
    j.verify();target(j.url);
    if(j.received!==j.length)throw new Error('전체 로그가 전달되지 않았습니다.');
    let logText=j.parts.join(''); j.parts=[];
    if(await C.digest(logText)!==j.hash)throw new Error('전달된 로그의 무결성 검증에 실패했습니다.');
    if(!logText.trim())throw new Error('추출된 RP 로그가 0자입니다.');
    const longPrompt=C.shouldAttachPrompt(j.summaryPrompt);
    const text=C.makePrompt(j.summaryPrompt);
    const editor=await waitFor(()=>{
      const el=document.querySelector('#prompt-textarea');
      return visible(el) && (el.isContentEditable || el instanceof HTMLTextAreaElement) && el;
    },C.TIMEOUT.editor,'입력창 탐색 실패: ChatGPT 로그인 상태와 페이지 오류를 확인해 주세요.',j);
    if(read(editor).trim())throw new Error('ChatGPT 입력창에 작성 중인 내용이 있습니다. 해당 내용을 정리한 뒤 다시 시도해 주세요.');
    const form=editor.closest('form');
    if(!form)throw new Error('ChatGPT 입력 폼 구조가 변경되었습니다.');
    const files=[new File([logText],j.fileName,{type:'text/plain;charset=utf-8'})];
    if(longPrompt)files.push(new File([j.summaryPrompt],C.INSTRUCTION_FILE_NAME,{type:'text/plain;charset=utf-8'}));
    const fileNames=files.map(file=>file.name);
    for(const name of fileNames)if(filenameVisible(form,editor,name))throw new Error('ChatGPT 입력창에 기존 첨부파일이 있습니다. 정리한 뒤 다시 시도해 주세요.');
    await attachFiles(j,files,form,editor);
    logText=null;
    await progress(j,'prompt');
    if(read(editor).trim())throw new Error('업로드 중 입력 내용이 변경되었습니다.');
    const injectionStarted=performance.now();
    editor.focus();
    const before=new InputEvent('beforeinput',{bubbles:true,cancelable:true,inputType:'insertText',data:text});
    if(!editor.dispatchEvent(before))throw new Error('ChatGPT가 텍스트 입력을 거부했습니다.');
    if(editor instanceof HTMLTextAreaElement){
      if(editor.maxLength>=0 && text.length>editor.maxLength)throw new Error('요약 지침이 너무 길어 ChatGPT 입력창에 전송하지 못했습니다.');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(editor,text);
      editor.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:text}));
    }else{
      // Native editing command updates ProseMirror through the browser's editing pipeline.
      // Do not assign innerHTML/textContent: that can leave the editor's model unchanged.
      const range=document.createRange();range.selectNodeContents(editor);
      const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);
      const insertionDeadline=Date.now()+C.TIMEOUT.prompt;
      // Large multiline insertText calls can monopolize the renderer. Insert bounded
      // chunks through the same native pipeline, preserving selection and all text.
      for(let offset=0;offset<text.length;){
        j.verify();target(j.url);
        if(j.aborted || !editor.isConnected)throw new Error('텍스트 입력 도중 작업이 중단되었습니다.');
        if(Date.now()>insertionDeadline)throw new Error('요약 지침이 너무 길어 ChatGPT 입력창에 전송하지 못했습니다. 입력 시간이 초과되어 전송을 중단했습니다.');
        if(document.activeElement!==editor || !editor.contains(window.getSelection()?.anchorNode))
          throw new Error('입력 도중 포커스가 변경되었습니다. 일부 로그는 전송하지 않았습니다.');
        let end=Math.min(offset+4096,text.length);
        const last=text.charCodeAt(end-1);
        if(end<text.length && last>=0xD800 && last<=0xDBFF)end--;
        if(!document.execCommand('insertText',false,text.slice(offset,end)))throw new Error('ChatGPT 텍스트 주입 실패입니다. 입력기가 삽입을 거부했습니다.');
        offset=end;
        await C.sleep(0);
      }
      editor.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:text}));
    }
    editor.dispatchEvent(new Event('change',{bubbles:true}));
    await waitFor(()=>editor.isConnected && normalize(read(editor))===normalize(text) && editor,
      Math.min(C.TIMEOUT.prompt,3000),
      '텍스트 주입 검증 실패입니다. 로그가 너무 길거나 입력창이 변경되었습니다. 일부 로그는 전송하지 않았습니다.',j);
    console.info('[Crack GPT] prompt injected');
    console.info('[Crack GPT] prompt injection duration:', Math.round(performance.now()-injectionStarted), 'ms');
    await progress(j,'send');
    const send=await waitFor(()=>{
      const el=findSendButton(form);
      return enabled(el) && el;
    },C.TIMEOUT.send,'ChatGPT가 파일 전송 준비 상태가 되지 않았습니다.',j);
    console.info('[Crack GPT] send ready:',{
      testid:send.getAttribute('data-testid'),
      type:send.getAttribute('type'),
      disabled:!!send.disabled,
      ariaDisabled:send.getAttribute('aria-disabled')
    });
    j.verify();target(j.url);
    if(normalize(read(editor))!==normalize(text))throw new Error('전송 전에 입력 내용이 변경되어 중단했습니다.');
    // File attachment presence is verified once in attachFiles(). ChatGPT may replace
    // the attachment-card DOM after upload completes, so filenames are intentionally
    // not re-required here. The composer's enabled Send state is the final readiness signal.
    const finalSend=findSendButton(form);
    if(!enabled(finalSend))throw new Error('전송 직전 ChatGPT 전송 버튼 상태가 변경되었습니다.');
    const previous=new Set(document.querySelectorAll('[data-message-author-role="user"]'));
    // The single side-effect boundary. Never repeat this click on uncertain acknowledgement.
    const confirmationStarted=performance.now();
    j.verify();j.clicked=true; finalSend.click();
    await progress(j,'confirm');
    await waitFor(()=>[...document.querySelectorAll('[data-message-author-role="user"]')].some(el=>{
      if(previous.has(el))return false;
      const body=el.querySelector('.user-message-bubble-color .whitespace-pre-wrap');
      return body && normalize(body.innerText).trim()===normalize(text).trim();
    }),C.TIMEOUT.confirm,'자동 전송 확인 실패입니다. ChatGPT 대화와 오류 안내를 확인해 주세요. 중복 방지를 위해 다시 전송하지 않았습니다.',j);
    console.info('[Crack GPT] message sent');
    console.info('[Crack GPT] send confirmation duration:', Math.round(performance.now()-confirmationStarted), 'ms');
    return {ok:true,confirmed:'user-message'};
  }
  Bridge.receive(async(input,report,verify)=>{
    if(!Number.isSafeInteger(input.length) || input.length<=0 || typeof input.text!=='string' || input.text.length!==input.length ||
      !/^[a-f0-9]{64}$/.test(input.hash) || !/^Crack-RP-Log-T[1-9][0-9]*-T[1-9][0-9]*\.txt$/.test(input.fileName))
      throw new Error('잘못된 TXT 전송 데이터입니다.');
    const j={...input,received:input.length,parts:[input.text],report,verify};input.text=null;j.text=null;
    try{return await commit(j);}finally{j.parts=[];j.summaryPrompt=null;}
  });
})();

}
})();

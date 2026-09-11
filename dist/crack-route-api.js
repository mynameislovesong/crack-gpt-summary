(() => {
  'use strict';
  if (location.origin !== 'https://crack.wrtn.ai') return;
  const chrome = globalThis.__CrackGPTUserscript.chromeShim;
(() => {
  'use strict';
  if(globalThis.CrackRoute)return;
  const subscribers=new Set();let revision=0;
  const current=()=>{try{return CrackRanges.crackChatId(location.href);}catch{return null;}};
  let last=current();
  function refresh(){
    const next=current();if(next===last)return;
    last=next;revision++;
    for(const callback of subscribers)callback({chatId:next,revision});
  }
  window.navigation?.addEventListener('currententrychange',refresh);
  window.addEventListener('popstate',refresh);
  window.addEventListener('pageshow',refresh);
  window.addEventListener('hashchange',refresh);
  globalThis.CrackRoute=Object.freeze({current,refresh,get revision(){refresh();return revision;},
    subscribe(callback){subscribers.add(callback);return ()=>subscribers.delete(callback);}});
})();
(() => {
  'use strict';
  const ERR={chat:'현재 Crack 채팅방 ID를 찾을 수 없습니다.',session:'Crack 로그인 세션을 확인할 수 없습니다.',expired:'Crack 로그인 세션이 만료되었습니다. 페이지를 새로고침하거나 다시 로그인해주세요.',rate:'Crack 메시지 요청 제한에 도달했습니다. 잠시 후 다시 시도해주세요.',format:'Crack 메시지 API 응답 형식이 변경되었습니다.',network:'Crack 메시지 API에 연결하지 못했습니다.',pagination:'Crack 로그 페이지네이션 처리 중 오류가 발생했습니다.',changed:'로그 수집 중 채팅방이 변경되었습니다.',aborted:'Crack 로그 수집이 취소되었습니다.',timeout:'Crack 메시지 API 응답 시간이 초과되었습니다.'};
  function getChatId(){if(location.origin!=='https://crack.wrtn.ai')return null;const id=location.pathname.match(/\/episodes\/([^/?#]+)\/?$/)?.[1];try{return id?decodeURIComponent(id):null;}catch{return null;}}
  function accessToken(){try{const cookie=document.cookie.split(';').map(v=>v.trim()).find(v=>v.startsWith('access_token='));return cookie?decodeURIComponent(cookie.slice('access_token='.length)):null;}catch{return null;}}
  function requestPage(url,signal){const token=accessToken();if(!token)throw new Error(ERR.session);return fetch(url,{method:'GET',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},credentials:'omit',cache:'no-store',redirect:'error',signal});}
  function isLimitError(json){const candidates=[json?.error,json?.data,json];return candidates.some(e=>e && (['INVALID_LIMIT','LIMIT_EXCEEDED','INVALID_PAGE_SIZE','PAGE_SIZE_TOO_LARGE'].includes(e.code)||['limit','pageSize'].includes(e.field)||(typeof e.message==='string'&&/\b(limit|pageSize|page size)\b/i.test(e.message)&&/maximum|too (?:large|high)|exceed|between|at most|must be|invalid/i.test(e.message))));}
  async function fetchAllMessages({signal,pageSize=500,maxPages=100,maxMessages=50000,requestTimeoutMs=15000,onProgress}={}){
    if(!Number.isSafeInteger(pageSize)||pageSize<1||pageSize>500||!Number.isSafeInteger(maxPages)||maxPages<1||maxPages>100||!Number.isSafeInteger(maxMessages)||maxMessages<1||maxMessages>50000||!Number.isSafeInteger(requestTimeoutMs)||requestTimeoutMs<1||requestTimeoutMs>60000)throw new Error('잘못된 API 수집 제한 설정입니다.');
    const initialChatId=getChatId();if(!initialChatId)throw new Error(ERR.chat);
    const controller=new AbortController();let abortError=ERR.aborted;const abort=message=>{if(!controller.signal.aborted){abortError=message;controller.abort();}};const externalAbort=()=>abort(ERR.aborted),unload=()=>abort(ERR.aborted);const check=()=>{if(getChatId()!==initialChatId)abort(ERR.changed);if(controller.signal.aborted)throw new Error(abortError);};
    signal?.addEventListener('abort',externalAbort,{once:true});if(signal?.aborted)externalAbort();window.addEventListener('pagehide',unload,{once:true});const watch=setInterval(()=>{if(getChatId()!==initialChatId)abort(ERR.changed);},100);const started=performance.now(),messages=[],seenIds=new Map(),seenCursors=new Set();let cursor=null,retriedLimit=false;
    try{for(let page=0;page<maxPages;page++){check();const url=new URL(`https://crack-api.wrtn.ai/crack-gen/v3/chats/${encodeURIComponent(initialChatId)}/messages`);url.searchParams.set('limit',String(pageSize));if(cursor!==null)url.searchParams.set('cursor',cursor);let response,json;const timer=setTimeout(()=>abort(ERR.timeout),requestTimeoutMs);try{try{response=await requestPage(url,controller.signal);}catch(e){check();throw new Error(e?.message===ERR.session?ERR.session:ERR.network);}check();if(response.status===401)throw new Error(ERR.expired);if(response.status===429)throw new Error(ERR.rate);if(!response.ok){if(page===0&&pageSize===500&&!retriedLimit&&[400,422].includes(response.status)){try{json=await response.json();}catch{check();}check();if(isLimitError(json)){retriedLimit=true;pageSize=100;page--;continue;}}throw new Error(`Crack 메시지 API 오류: HTTP ${response.status}`);}try{json=await response.json();}catch{check();throw new Error(ERR.format);}check();}finally{clearTimeout(timer);}const data=json?.data;if(json?.result!=='SUCCESS'||!Array.isArray(data?.messages)||typeof data.hasNext!=='boolean')throw new Error(ERR.format);for(const message of data.messages){if(typeof message?._id!=='string'||!message._id||typeof message?.content!=='string'||!['user','assistant'].includes(message?.role))throw new Error(ERR.format);const old=seenIds.get(message._id);if(old){if(['content','role','turnId','parentTurnId','reroll','status'].some(k=>old[k]!==message[k]))throw new Error('API 수집 중 메시지가 변경되었습니다. 다시 시도해주세요.');continue;}seenIds.set(message._id,message);messages.push(message);if(messages.length>maxMessages)throw new Error('안전 제한을 초과하는 메시지 수입니다.');}console.info(`[Crack GPT] API page ${page+1}: ${data.messages.length} messages`);onProgress?.({page:page+1,messageCount:messages.length,complete:!data.hasNext});check();if(!data.hasNext){console.info('[Crack GPT] API total messages:',messages.length);return messages.reverse();}if(!data.messages.length||typeof data.nextCursor!=='string'||!data.nextCursor||seenCursors.has(data.nextCursor))throw new Error(ERR.pagination);seenCursors.add(data.nextCursor);cursor=data.nextCursor;}throw new Error('Crack 로그 페이지네이션 안전 한도(최대 페이지)에 도달했습니다. 일부 로그는 전송하지 않습니다.');}finally{clearInterval(watch);signal?.removeEventListener('abort',externalAbort);window.removeEventListener('pagehide',unload);console.info('[Crack GPT] API collection duration:',Math.round(performance.now()-started),'ms');}
  }
  function normalizeApiMessages(messages){return messages.map((message,index)=>({id:message._id,messageGroupId:message._id,chronologicalIndex:index+1,role:message.role==='assistant'?'character':'user',content:message.content,siteTurn:null,links:[],images:[],turnId:message.turnId??null,parentTurnId:message.parentTurnId??null,reroll:message.reroll??false,status:message.status??null,source:'api'}));}
  globalThis.CrackMessageAPI=Object.freeze({fetchAllMessages,normalizeApiMessages,getChatId});
})();
(() => {
  'use strict';
  function buildLogicalTurns(messages){const turns=[],orphans=[];let i=0,logicalTurn=1;while(i<messages.length){const current=messages[i],next=messages[i+1];if(current?.role==='user'&&next?.role==='character'){turns.push({logicalTurn,siteTurn:next.siteTurn,user:current,character:next});logicalTurn++;i+=2;continue;}orphans.push({message:current,reason:current.role==='user'?'USER 다음에 CHARACTER가 없음':current.role==='character'?'직전 USER와 정상 쌍을 이루지 못함':'역할 판별 실패'});i++;}return {turns,orphans};}
  function exportTXT(structure){const ordered=[...structure.turns.flatMap(t=>[t.user,t.character]),...structure.orphans.map(o=>o.message)].sort((a,b)=>a.chronologicalIndex-b.chronologicalIndex);if(ordered.some(m=>!['user','character'].includes(m.role)))throw new Error('화자를 판별하지 못한 메시지가 있어 전송을 중단했습니다.');return ordered.map(m=>`[${m.role.toUpperCase()}]\n${m.content}`).join('\n\n');}
  let running=false;async function getCurrentCrackLogText(onProgress,structured=false,options={}){if(running)throw new Error('이미 로그를 수집하고 있습니다.');running=true;const initialChatId=CrackMessageAPI.getChatId();try{const raw=await CrackMessageAPI.fetchAllMessages({...options,onProgress});if(CrackMessageAPI.getChatId()!==initialChatId)throw new Error('로그 수집 중 채팅방이 변경되었습니다.');const messages=CrackMessageAPI.normalizeApiMessages(raw);if(!messages.length||!messages.some(m=>m.content.trim()))throw new Error('추출된 RP 로그가 0자입니다.');const structure=buildLogicalTurns(messages);console.info('[Crack GPT] API logical turns:',structure.turns.length);return structured?structure:exportTXT(structure);}finally{running=false;}}
  globalThis.CrackLogExtractor=Object.freeze({getCurrentCrackLogText,getCurrentCrackLogStructure:(onProgress,options)=>getCurrentCrackLogText(onProgress,true,options)});globalThis.getCurrentCrackLogText=getCurrentCrackLogText;
})();
})();

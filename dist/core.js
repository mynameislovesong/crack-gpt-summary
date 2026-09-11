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
    if (!result?.ok) throw new Error(result?.error || '확장프로그램 연결이 끊겼습니다. 페이지를 새로고침해 주세요.');
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
  globalThis.CrackGPT = Object.freeze({CHUNK_SIZE,LONG_PROMPT_THRESHOLD,INSTRUCTION_FILE_NAME,chatUrl,makePrompt,shouldAttachPrompt,sleep,digest,checked,
    timeout,STAGES,TIMEOUT,PROTOCOL:3,FILE_NAME:'Crack-RP-Log.txt'});
})();
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
  globalThis.CrackRanges=Object.freeze({crackChatId,key,defaults,validateChoice,getSelectedTurnRange,sliceLogicalTurns});
})();
(() => {
  'use strict';
  const defaults=Object.freeze({removeImageMarkdown:true,removeImageUrls:true,removeComments:true,
    normalizeBlankLines:true,removeLoreOoc:false,removeMarkdownDecoration:false});
  const options=value=>Object.fromEntries(Object.entries(defaults).map(([key,fallback])=>
    [key,typeof value?.[key]==='boolean'?value[key]:fallback]));
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
      if(enabled.removeImageMarkdown)row=row.replace(/!\[[^\]\n]*\]\([^\)\n]*\)/g,'');
      const trimmed=row.trim();
      if(enabled.removeImageUrls && /^https?:\/\//i.test(trimmed) && /\.(png|jpe?g|webp|gif|avif|svg)(\?[^ \t]*)?$/i.test(trimmed))continue;
      if(enabled.removeMarkdownDecoration && !/^\s*```/.test(trimmed)){
        const substitutions=[
          [/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+|[^)\n]+)\)/g,'$1'],[/^\s{0,3}#{1,6}\s+/g,''],[/^\s{0,3}>\s?/g,''],[/`([^`\n]+)`/g,'$1'],
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
  globalThis.CrackCleaner=Object.freeze({defaults,options,cleanRpLog});
})();

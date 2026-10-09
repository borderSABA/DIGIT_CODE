'use strict';
const GAME_ID='digit-code';
const GAME_NAME='ディジットコード';
const APP_VERSION='v0.1.15';
const MAX_PLAYERS=6;
const WORKER_ORIGIN='https://digit-code-online.naitoryo7110.workers.dev';
const COMMON_PLAYER_NAME_KEY='boardgamePlayerName';
const ROOM_IDS=['room1','room2','room3','room4'];
const NAME_DRAFT_KEY=`${GAME_ID}-name-draft`;
const ACTIVE_ROOM_KEY=`${GAME_ID}-online-room`;
const ACTIVE_NAME_KEY=`${GAME_ID}-online-active-name`;

const $=s=>document.querySelector(s); const $$=s=>[...document.querySelectorAll(s)];
let ws=null,currentRoomId=null,currentPlayerName='',state=null,reconnectTimer=null,actionSeq=0,commonNameSavedForSession=null;
let selectedTarget=null,lastTurnPlayerId=null,timerTicker=null,lastGameSessionId=null,serverClockOffsetMs=0;
const answerDraft=Array(6).fill('');
const memo={candidates:Array.from({length:6},()=>new Set([0,1,2,3,4,5,6,7,8,9])),segments:Array.from({length:6},()=>({a:0,b:0,c:0,d:0,e:0,f:0,g:0}))};
const SEGMENTS=['a','b','c','d','e','f','g'];
const DIGIT_LABELS=['T','U','V','W','X','Y'];

function commonSavedName(){return String(localStorage.getItem(COMMON_PLAYER_NAME_KEY)||'').trim().slice(0,32)}
function saveCommonNameOnActualStart(name){name=String(name||'').trim().slice(0,32);if(name)localStorage.setItem(COMMON_PLAYER_NAME_KEY,name)}
function tokenKey(roomId){return `${GAME_ID}-online-token-${roomId}`}
function getToken(roomId){let t=localStorage.getItem(tokenKey(roomId));if(!t){t=crypto.randomUUID().replace(/-/g,'');localStorage.setItem(tokenKey(roomId),t)}return t}
function newActionId(prefix='op'){actionSeq=(actionSeq+1)%1000000;return [prefix,Date.now(),actionSeq,Math.random().toString(36).slice(2,8)].join('-')}
function roomNo(id){return ROOM_IDS.indexOf(id)+1}
function showScreen(id){$$('.screen').forEach(x=>x.classList.remove('active'));$(id).classList.add('active')}
function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function roomStatusLabel(r){if(r?.status==='playing')return'ゲーム中';if(r?.status==='finished')return'終了';return'待機中'}

async function fetchRoomSummary(roomId){const r=await fetch(`${WORKER_ORIGIN}/summary?roomId=${encodeURIComponent(roomId)}`,{cache:'no-store'});if(!r.ok)throw new Error('取得失敗');return r.json()}
async function loadRooms(){const grid=$('#roomGrid');if(!grid.children.length)grid.innerHTML=ROOM_IDS.map((id,i)=>`<article class="room-card" data-room-card="${id}"><div class="room-head"><h2>ROOM ${i+1}</h2><span class="status">取得中</span></div><div class="count">- / ${MAX_PLAYERS}人</div><div class="room-players">参加者：取得中</div><button data-join-room="${id}">参加する</button><button class="danger" data-reset-room="${id}">初期化</button></article>`).join('');
 await Promise.allSettled(ROOM_IDS.map(async id=>{const card=grid.querySelector(`[data-room-card="${id}"]`);try{const d=await fetchRoomSummary(id);const r=d.room||d;card.querySelector('.status').textContent=roomStatusLabel(r);card.querySelector('.count').textContent=`${r.players?.length||0} / ${MAX_PLAYERS}人`;card.querySelector('.room-players').textContent=(r.players?.length?`参加者：\n${r.players.map(p=>p.name).join('\n')}`:'参加者：なし');const token=localStorage.getItem(tokenKey(id));const mine=token&&r.players?.some(p=>p.tokenHash===token.slice(0,8));card.querySelector('[data-join-room]').textContent=mine?'再接続':'参加する';}catch{card.querySelector('.status').textContent='取得失敗';card.querySelector('.room-players').textContent='このROOMだけ取得できませんでした';}}));}

async function resetRoom(roomId){if(!confirm(`ROOM ${roomNo(roomId)} を初期化しますか？`))return;const r=await fetch(`${WORKER_ORIGIN}/reset-empty?roomId=${encodeURIComponent(roomId)}`,{method:'POST',cache:'no-store'});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||'ROOMを初期化できませんでした。');localStorage.removeItem(tokenKey(roomId));await loadRooms()}

async function joinRoom(roomId){const name=$('#nameInput').value.trim().slice(0,32);if(!name){alert('プレイヤー名を入力してください。');return}sessionStorage.setItem(NAME_DRAFT_KEY,name);const token=getToken(roomId);const u=new URL(`${WORKER_ORIGIN}/join-check`);u.searchParams.set('roomId',roomId);u.searchParams.set('name',name);u.searchParams.set('token',token);const r=await fetch(u,{cache:'no-store'});const d=await r.json().catch(()=>({}));if(!r.ok){alert(d.error||'ROOMへ参加できません。');return}currentRoomId=roomId;currentPlayerName=name;localStorage.setItem(ACTIVE_ROOM_KEY,roomId);localStorage.setItem(ACTIVE_NAME_KEY,name);connectWs(roomId,name,token)}

function wsUrl(roomId,name,token){const u=new URL(WORKER_ORIGIN.replace(/^http/,'ws')+'/ws');u.searchParams.set('roomId',roomId);u.searchParams.set('name',name);u.searchParams.set('token',token);return u}
function connectWs(roomId,name,token){
  const previous=ws;
  if(previous){
    previous.onopen=previous.onmessage=previous.onclose=previous.onerror=null;
    try{previous.close()}catch{}
  }
  const socket=new WebSocket(wsUrl(roomId,name,token));
  ws=socket;
  socket.onopen=()=>{if(ws!==socket)return;clearTimeout(reconnectTimer)};
  socket.onmessage=e=>{if(ws!==socket)return;const m=JSON.parse(e.data);if(m.type==='error'){alert(m.error);return}if(m.type==='state'){state=m.state;onState()}};
  socket.onclose=()=>{if(ws!==socket)return;if(currentRoomId)scheduleReconnect()};
  socket.onerror=()=>{};
}
function scheduleReconnect(){clearTimeout(reconnectTimer);reconnectTimer=setTimeout(()=>{if(!currentRoomId)return;if(ws&&(ws.readyState===WebSocket.OPEN||ws.readyState===WebSocket.CONNECTING))return;const n=localStorage.getItem(ACTIVE_NAME_KEY)||currentPlayerName;connectWs(currentRoomId,n,getToken(currentRoomId))},1200)}
function send(type,payload={}){if(!ws||ws.readyState!==WebSocket.OPEN)return;ws.send(JSON.stringify({type,actionId:newActionId(type),...payload}))}

function me(){return state?.players?.find(p=>p.tokenHash===getToken(currentRoomId).slice(0,8))}
function onState(){if(!state)return;if(Number.isFinite(Number(state.serverNow)))serverClockOffsetMs=Number(state.serverNow)-Date.now();const started=state.status==='playing';if(started&&state.gameSessionId&&commonNameSavedForSession!==state.gameSessionId){saveCommonNameOnActualStart(currentPlayerName);commonNameSavedForSession=state.gameSessionId}if(state.gameSessionId&&lastGameSessionId!==state.gameSessionId){lastGameSessionId=state.gameSessionId;for(let i=0;i<6;i++)answerDraft[i]='';syncAnswerInputs()}if(state.status==='lobby'){stopTimerTicker();renderLobby();showScreen('#lobbyScreen')}else if(state.status==='playing'){renderGame();showScreen('#gameScreen')}else if(state.status==='finished'){renderGame();showScreen('#gameScreen');renderResult();$('#resultScreen').classList.add('active')}}
function renderLobby(){$('#lobbyRoomName').textContent=`ROOM ${roomNo(currentRoomId)}`;$('#lobbyStatus').textContent='待機中';$('#lobbyPlayers').innerHTML=state.players.map((p,i)=>`<div class="player-row">${i+1}. ${esc(p.name)}${p.id===state.hostId?'（ホスト）':''}</div>`).join('');const mine=me();const isHost=!!mine&&mine.id===state.hostId;$('#startBtn').disabled=!isHost||state.players.length<1;const turnSec=Math.round(Number(state.turnTimeMs||30000)/1000);const thinkSec=Math.round(Number(state.thinkingTimeMs||10000)/1000);const turnInput=$('#turnTimeInput'),thinkInput=$('#thinkingTimeInput');if(turnInput&&document.activeElement!==turnInput)turnInput.value=turnSec;if(thinkInput&&document.activeElement!==thinkInput)thinkInput.value=thinkSec;if(turnInput)turnInput.disabled=!isHost;if(thinkInput)thinkInput.disabled=!isHost}

let settingsSendTimer=null;
function applyTimeSettingsSilently(){const mine=me();if(!mine||mine.id!==state?.hostId||state?.status!=='lobby')return;const turnSeconds=Number($('#turnTimeInput')?.value);const thinkingSeconds=Number($('#thinkingTimeInput')?.value);if(!Number.isFinite(turnSeconds)||turnSeconds<5||turnSeconds>300)return;if(!Number.isFinite(thinkingSeconds)||thinkingSeconds<0||thinkingSeconds>120)return;const currentTurn=Math.round(Number(state.turnTimeMs||30000)/1000);const currentThink=Math.round(Number(state.thinkingTimeMs||10000)/1000);if(Math.round(turnSeconds)===currentTurn&&Math.round(thinkingSeconds)===currentThink)return;send('settings',{turnSeconds:Math.round(turnSeconds),thinkingSeconds:Math.round(thinkingSeconds)})}
function scheduleTimeSettingsUpdate(){clearTimeout(settingsSendTimer);settingsSendTimer=setTimeout(applyTimeSettingsSilently,250)}

function renderGame(){const mine=me();$('#gameRoomLabel').textContent=`ROOM ${roomNo(currentRoomId)}`;const turn=state.players.find(p=>p.id===state.turnPlayerId);const phase=state.phase||'turn';$('#turnLabel').textContent=state.status==='finished'?'答え合わせ':phase==='thinking'?'シンキングタイム':turn?`${turn.name}の手番　公開質問 ${state.totalQuestionCount||0}`:`公開質問 ${state.totalQuestionCount||0}`;$('#playerStrip').innerHTML=state.players.map(p=>`<div class="player-chip ${p.id===state.turnPlayerId&&phase==='turn'?'turn':''} ${p.answerLocked?'locked':''}"><b>${esc(p.name)}</b><br>${p.answerLocked?`🔒 回答済み　Q${p.answerQuestionCount??0}`:`質問 ${p.questionCount||0}`}</div>`).join('');if(phase==='turn'&&turn&&lastTurnPlayerId!==turn.id&&state.status==='playing'){const pop=$('#turnPop');pop.textContent=`${turn.name}の手番`;pop.classList.remove('hidden');clearTimeout(window.__digitTurnPopTimer);window.__digitTurnPopTimer=setTimeout(()=>pop.classList.add('hidden'),2200)}lastTurnPlayerId=state.turnPlayerId;buildQuestionBoard();renderMemo();renderHistory();renderQuestionSelection();renderAnswerBox(mine);startTimerTicker()}

function initAnswerGrid(){const grid=$('#answerGridInline');if(!grid||grid.children.length)return;grid.innerHTML=Array.from({length:6},(_,i)=>`<select data-answer-digit="${i}" aria-label="解答${i+1}"><option value="">-</option>${[0,1,2,3,4,5,6,7,8,9].map(n=>`<option value="${n}">${n}</option>`).join('')}</select>`).join('');grid.querySelectorAll('[data-answer-digit]').forEach(sel=>sel.addEventListener('change',()=>{answerDraft[Number(sel.dataset.answerDigit)]=sel.value}))}
function syncAnswerInputs(){initAnswerGrid();$$('[data-answer-digit]').forEach(sel=>{const i=Number(sel.dataset.answerDigit);if(sel.value!==String(answerDraft[i]??''))sel.value=String(answerDraft[i]??'')})}
function renderAnswerBox(mine){syncAnswerInputs();const locked=!!mine?.answerLocked||state?.status!=='playing';$$('[data-answer-digit]').forEach(sel=>sel.disabled=locked);$('#answerBtn').disabled=!mine||locked;$('#answerBtn').textContent=mine?.answerLocked?'回答済み':'回答確定';$('#answerStatus').textContent=mine?.answerLocked?`回答済み・Q${mine.answerQuestionCount??0}`:'未確定'}
function stopTimerTicker(){if(timerTicker){clearInterval(timerTicker);timerTicker=null}}
function updatePhaseTimer(){const el=$('#phaseTimer'),mobile=$('#mobileBoardTimer');if(!state||state.status!=='playing'){if(el)el.textContent='--';if(mobile)mobile.textContent='--';return}const deadline=Number(state.phaseDeadline||0);const remain=Math.max(0,deadline-serverNowMs());const sec=Math.ceil(remain/1000);const text=state.phase==='thinking'?`シンキング ${sec}秒`:`残り ${sec}秒`;if(el){el.textContent=state.phase==='thinking'?`思考 ${sec}秒`:`手番 ${sec}秒`;el.classList.toggle('thinking',state.phase==='thinking')}if(mobile){mobile.textContent=text;mobile.classList.toggle('thinking',state.phase==='thinking')}}
function startTimerTicker(){stopTimerTicker();updatePhaseTimer();timerTicker=setInterval(updatePhaseTimer,200)}

function serverNowMs(){return Date.now()+serverClockOffsetMs}

const DIGIT_SEGS={0:['a','b','c','d','e','f'],1:['b','c'],2:['a','b','d','e','g'],3:['a','b','c','d','g'],4:['b','c','f','g'],5:['a','c','d','f','g'],6:['a','c','d','e','f','g'],7:['a','b','c'],8:['a','b','c','d','e','f','g'],9:['a','b','c','d','f','g']};
function canAskQuestion(){const mine=me();return !!(mine&&state?.status==='playing'&&state.phase==='turn'&&state.turnPlayerId===mine.id&&!mine.answerLocked&&Number(state.phaseDeadline||0)>serverNowMs())}
function sameTarget(a,b){return JSON.stringify(a||null)===JSON.stringify(b||null)}
function questionAnswered(q){if(!q||!state?.publicInfo)return false;if(q.kind==='line')return state.publicInfo.lines?.[q.label]!=null;if(q.kind==='parity')return state.publicInfo.parity?.[q.digit]!=null;if(q.kind==='compare')return state.publicInfo.compare?.[`${q.a}-${q.b}`]!=null;if(q.kind==='segment')return state.publicInfo.segments?.[q.digit]?.[q.segment]!=null;return false}
function selectQuestion(target){if(!canAskQuestion()||questionAnswered(target))return;selectedTarget=target;buildQuestionBoard();renderQuestionSelection()}
function clearQuestionSelection(){selectedTarget=null;buildQuestionBoard();renderQuestionSelection()}
function renderQuestionSelection(){const box=$('#questionSelection'),text=$('#questionSelectionText'),btn=$('#askSelectedBtn');if(!box||!text||!btn)return;const ok=canAskQuestion()&&selectedTarget&&!questionAnswered(selectedTarget);if(!ok){box.classList.remove('hidden');box.classList.add('inactive');text.textContent='盤面から質問する場所を選択';btn.disabled=true;return}box.classList.remove('hidden');box.classList.remove('inactive');text.textContent=questionText(selectedTarget);btn.disabled=false}
function segmentCoordinate(i,s){const top=i<3;const col=i%3;const vertical=[['A','B','C'],['D','E','F'],['G','H','I']][col];const rows=top?{a:'J',f:'K',b:'K',g:'L',e:'M',c:'M',d:'N'}:{a:'O',f:'P',b:'P',g:'Q',e:'R',c:'R',d:'S'};const v={a:vertical[1],g:vertical[1],d:vertical[1],f:vertical[0],e:vertical[0],b:vertical[2],c:vertical[2]}[s];return `${v}:${rows[s]}`}
function buildQuestionBoard(){const b=$('#questionBoard');b.innerHTML='';for(let i=0;i<6;i++){const cell=document.createElement('div');cell.className='digit-cell'+(sameTarget(selectedTarget,{kind:'parity',digit:i})?' selected-target':'');cell.dataset.digit=i;const parityRaw=state.publicInfo?.parity?.[i];const parityText=parityRaw==='・・'?'偶':parityRaw==='・'?'奇':(parityRaw||'');if(parityText)cell.classList.add('parity-answered');cell.innerHTML=`<span class="digit-label">${DIGIT_LABELS[i]}</span><span class="parity-mark">${parityText}</span>`;cell.onclick=()=>selectQuestion({kind:'parity',digit:i});for(const s of SEGMENTS){const el=document.createElement('div');el.className=`seg ${s}`;const target={kind:'segment',digit:i,segment:s};if(sameTarget(selectedTarget,target))el.classList.add('selected-target');const pub=state.publicInfo?.segments?.[i]?.[s];if(pub===true){el.classList.add('on','answered')}if(pub===false){el.classList.add('off','answered')}el.title=`${segmentCoordinate(i,s)}に線はある？`;el.onclick=e=>{e.stopPropagation();selectQuestion(target)};cell.appendChild(el)}b.appendChild(cell)}addLineButtons(b);addCompareButtons(b)}
function boardGeometry(){const mobile=window.innerWidth<=760;const padX=mobile?2.2:3.2,padY=mobile?2.2:3.2,gapX=mobile?6.5:7,gapY=mobile?9:8;const cellW=(100-padX*2-gapX*2)/3,cellH=(100-padY*2-gapY)/2;const cellLeft=c=>padX+c*(cellW+gapX),cellTop=r=>padY+r*(cellH+gapY);return{padX,padY,gapX,gapY,cellW,cellH,cellLeft,cellTop}}
function addLineButtons(b){const g=boardGeometry();const mobile=window.innerWidth<=760;const xFracs=[.22,.50,.78];const labels=['A','B','C','D','E','F','G','H','I'];labels.forEach((l,i)=>{const target={kind:'line',label:l};const btn=document.createElement('button');btn.className='line-btn'+(state.publicInfo?.lines?.[l]!=null?' answered':'')+(sameTarget(selectedTarget,target)?' selected-target':'');btn.textContent=state.publicInfo?.lines?.[l]!=null?`${l}:${state.publicInfo.lines[l]}`:l;btn.title=`${l}列に線は何本ある？`;const col=Math.floor(i/3),sub=i%3;btn.style.top=mobile?'0.2%':'0.8%';btn.style.left=`${g.cellLeft(col)+xFracs[sub]*g.cellW}%`;btn.onclick=e=>{e.stopPropagation();selectQuestion(target)};b.appendChild(btn)});const rows=['J','K','L','M','N','O','P','Q','R','S'];const yFracs=[.08,.28,.50,.72,.92];rows.forEach((l,i)=>{const target={kind:'line',label:l};const btn=document.createElement('button');btn.className='line-btn'+(state.publicInfo?.lines?.[l]!=null?' answered':'')+(sameTarget(selectedTarget,target)?' selected-target':'');btn.textContent=state.publicInfo?.lines?.[l]!=null?`${l}:${state.publicInfo.lines[l]}`:l;btn.title=`${l}列に線は何本ある？`;const row=i<5?0:1,sub=i%5;btn.style.left=mobile?'2.2%':'0.8%';btn.style.top=`${g.cellTop(row)+yFracs[sub]*g.cellH}%`;btn.onclick=e=>{e.stopPropagation();selectQuestion(target)};b.appendChild(btn)})}
function addCompareButtons(b){const pairs=state.comparePairs||[];const g=boardGeometry();const centersX=[0,1,2].map(c=>g.cellLeft(c)+g.cellW/2),centersY=[0,1].map(r=>g.cellTop(r)+g.cellH/2);const horizontalPos=[[ (centersX[0]+centersX[1])/2,centersY[0] ],[ (centersX[1]+centersX[2])/2,centersY[0] ],[ (centersX[0]+centersX[1])/2,centersY[1] ],[ (centersX[1]+centersX[2])/2,centersY[1] ]];const verticalPos=centersX.map(x=>[x,(centersY[0]+centersY[1])/2]);pairs.forEach((p,i)=>{const [a,c]=p;const target={kind:'compare',a,b:c};const symbol=state.publicInfo?.compare?.[`${a}-${c}`]||'';const vertical=i>=4;const btn=document.createElement('button');btn.className='compare-btn'+(symbol?' answered':'')+(vertical?' vertical':'')+(sameTarget(selectedTarget,target)?' selected-target':'');if(vertical){btn.innerHTML=symbol?`<span class="rotated-compare">${symbol}</span>`:'↕'}else{btn.textContent=symbol||'↔'}btn.title=`${DIGIT_LABELS[a]}は${DIGIT_LABELS[c]}より大きい？小さい？`;const pos=vertical?(verticalPos[i-4]||[50,50]):(horizontalPos[i]||[50,50]);btn.style.left=pos[0]+'%';btn.style.top=pos[1]+'%';btn.onclick=e=>{e.stopPropagation();selectQuestion(target)};b.appendChild(btn)})}
function questionText(q){if(q.kind==='line')return `${q.label}列に線は何本ある？`;if(q.kind==='parity')return `${DIGIT_LABELS[q.digit]}は奇数？偶数？`;if(q.kind==='compare')return `${DIGIT_LABELS[q.a]}は${DIGIT_LABELS[q.b]}より大きい？小さい？`;return `${segmentCoordinate(q.digit,q.segment)}に線はある？`}
function askSelectedQuestion(){if(!canAskQuestion()||!selectedTarget||questionAnswered(selectedTarget))return;const q=selectedTarget;selectedTarget=null;renderQuestionSelection();send('ask',{question:q})}

function miniDigitHtml(n){const on=new Set(DIGIT_SEGS[n]||[]);return `<div class="mini-seven">${SEGMENTS.map(seg=>`<span class="mini-seg ${seg} ${on.has(seg)?'on':''}"></span>`).join('')}</div>`}
function memoSegClass(i,s){const v=memo.segments[i]?.[s]||0;return v===1?' local-on':v===-1?' local-off':''}
function cycleMemoSegment(i,s){const cur=memo.segments[i]?.[s]||0;memo.segments[i][s]=cur===0?1:cur===1?-1:0;renderMemo()}
function resetMemoDigit(i){if(!Number.isInteger(i)||i<0||i>5)return;memo.segments[i]={a:0,b:0,c:0,d:0,e:0,f:0,g:0};renderMemo()}
function memoDigitHtml(i){return `<div class="memo-seven">${SEGMENTS.map(seg=>`<button type="button" class="memo-seg ${seg}${memoSegClass(i,seg)}" data-memo-seg="${i}:${seg}" aria-label="${DIGIT_LABELS[i]} ${seg}"></button>`).join('')}</div>`}
function renderMemo(){const pane=$('#memoPane');pane.innerHTML=`
  <div class="digit-reference"><div class="memo-section-title">数字の見本</div><div class="digit-reference-grid">${[0,1,2,3,4,5,6,7,8,9].map(n=>`<div class="digit-reference-item"><div class="digit-reference-number">${n}</div>${miniDigitHtml(n)}</div>`).join('')}</div></div>
  <div class="memo-section-title">推理メモ</div>
  <div class="memo-board">${memo.segments.map((_,i)=>`<div class="memo-digit-cell"><div class="memo-title">${DIGIT_LABELS[i]}</div><button type="button" class="memo-reset" data-memo-reset="${i}" title="${DIGIT_LABELS[i]}のメモをリセット">リセット</button>${memoDigitHtml(i)}</div>`).join('')}</div>
  <p class="hint">推理メモの線をタップすると「あり → なし → 未確定」で切り替わります。T～Yは各枠のリセットで個別に初期化できます。</p>`;
  pane.querySelectorAll('[data-memo-seg]').forEach(btn=>btn.onclick=()=>{const [i,seg]=btn.dataset.memoSeg.split(':');cycleMemoSegment(Number(i),seg)});
  pane.querySelectorAll('[data-memo-reset]').forEach(btn=>btn.onclick=e=>{e.stopPropagation();resetMemoDigit(Number(btn.dataset.memoReset))})}
function renderHistory(){const h=state.history||[];$('#historyPane').innerHTML=h.length?h.slice().reverse().map(x=>`<div class="history-item"><b>${esc(x.playerName)}</b><br>${esc(x.questionText)} → <strong>${esc(x.answerText)}</strong></div>`).join(''):'<div class="hint">まだ質問はありません。</div>'}

function submitAnswer(){const mine=me();if(!mine||mine.answerLocked||state?.status!=='playing')return;syncAnswerInputs();if(answerDraft.some(v=>v==='')){alert('6か所すべて入力してください。');return}send('answer',{digits:answerDraft.map(Number)})}
function renderResult(){const ranked=[...state.players].sort((a,b)=>(a.rank??999)-(b.rank??999));const correct=ranked.filter(p=>p.isCorrect);$('#resultTitle').textContent=correct.length?'答え合わせ・順位':'全員不正解';$('#resultBody').innerHTML=`<div class="hint">正解コード</div><div class="secret-code">${(state.revealedCode||[]).map(n=>`<div>${n}</div>`).join('')}</div><div class="player-list result-ranking">${ranked.map(p=>`<div class="player-row ${p.isCorrect?'correct':'wrong'}"><b>${p.rank??'-'}位　${esc(p.name)}</b>　${p.isCorrect?'正解':'不正解'}　確定時質問 ${p.answerQuestionCount??'-'}<br><span class="submitted-code">回答：${Array.isArray(p.submittedAnswer)?`${p.submittedAnswer.slice(0,3).join('')} / ${p.submittedAnswer.slice(3).join('')}`:'-'}</span></div>`).join('')}</div>`;const mine=me();$('#rematchBtn').disabled=!mine||mine.id!==state.hostId}

function leaveRoom(){if(ws&&ws.readyState===WebSocket.OPEN)send('leave');currentRoomId=null;state=null;localStorage.removeItem(ACTIVE_ROOM_KEY);localStorage.removeItem(ACTIVE_NAME_KEY);try{ws?.close()}catch{};ws=null;showScreen('#titleScreen');loadRooms()}
function backLobby(){send('backLobby')}

function openMobilePanel(tab){const side=document.querySelector('.side-panel');if(window.innerWidth<=760){side.classList.toggle('mobile-open');}document.querySelectorAll('.tab').forEach(x=>x.classList.toggle('active',x.dataset.tab===tab));document.querySelectorAll('.tab-pane').forEach(x=>x.classList.toggle('active',x.id===tab+'Pane'))}

$('#nameInput').value=sessionStorage.getItem(NAME_DRAFT_KEY)??commonSavedName()??'';
$('#nameInput').addEventListener('input',e=>sessionStorage.setItem(NAME_DRAFT_KEY,e.target.value));
$('#refreshRoomsBtn').onclick=loadRooms;$('#roomGrid').onclick=e=>{const j=e.target.closest('[data-join-room]');const r=e.target.closest('[data-reset-room]');if(j)joinRoom(j.dataset.joinRoom);if(r)resetRoom(r.dataset.resetRoom).catch(err=>alert(err.message))};
$('#memoOpenBtn').onclick=()=>openMobilePanel('memo');$('#historyOpenBtn').onclick=()=>openMobilePanel('history');
$('#startBtn').onclick=()=>send('start');$('#turnTimeInput').addEventListener('input',scheduleTimeSettingsUpdate);$('#thinkingTimeInput').addEventListener('input',scheduleTimeSettingsUpdate);$('#leaveLobbyBtn').onclick=leaveRoom;$('#leaveGameBtn').onclick=leaveRoom;$('#answerBtn').onclick=submitAnswer;$('#rematchBtn').onclick=()=>send('rematch');$('#backLobbyBtn').onclick=backLobby;
$('#askSelectedBtn').onclick=askSelectedQuestion;$('#cancelQuestionBtn').onclick=clearQuestionSelection;
$$('.tab').forEach(t=>t.onclick=()=>{$$('.tab').forEach(x=>x.classList.remove('active'));$$('.tab-pane').forEach(x=>x.classList.remove('active'));t.classList.add('active');$('#'+t.dataset.tab+'Pane').classList.add('active')});
initAnswerGrid();
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'&&currentRoomId&&(!ws||ws.readyState!==WebSocket.OPEN))scheduleReconnect()});window.addEventListener('online',()=>{if(currentRoomId&&(!ws||ws.readyState!==WebSocket.OPEN))scheduleReconnect()});
(async()=>{const active=localStorage.getItem(ACTIVE_ROOM_KEY),name=localStorage.getItem(ACTIVE_NAME_KEY);if(active&&ROOM_IDS.includes(active)&&name){currentRoomId=active;currentPlayerName=name;connectWs(active,name,getToken(active))}else{showScreen('#titleScreen');await loadRooms()}})();

'use strict';
const GAME_ID='digit-code';
const GAME_NAME='ディジットコード';
const APP_VERSION='v0.1.2';
const MAX_PLAYERS=6;
const WORKER_ORIGIN='https://digit-code-online.naitoryo7110.workers.dev';
const COMMON_PLAYER_NAME_KEY='boardgamePlayerName';
const ROOM_IDS=['room1','room2','room3','room4'];
const NAME_DRAFT_KEY=`${GAME_ID}-name-draft`;
const ACTIVE_ROOM_KEY=`${GAME_ID}-online-room`;
const ACTIVE_NAME_KEY=`${GAME_ID}-online-active-name`;

const $=s=>document.querySelector(s); const $$=s=>[...document.querySelectorAll(s)];
let ws=null,currentRoomId=null,currentPlayerName='',state=null,reconnectTimer=null,actionSeq=0,commonNameSavedForSession=null;
let selectedQuestionType=null,selectedTarget=null,lastTurnPlayerId=null,timerTicker=null,lastGameSessionId=null;
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
function connectWs(roomId,name,token){if(ws)try{ws.close()}catch{};ws=new WebSocket(wsUrl(roomId,name,token));ws.onopen=()=>{clearTimeout(reconnectTimer)};ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.type==='error'){alert(m.error);return}if(m.type==='state'){state=m.state;onState()}};ws.onclose=()=>{if(currentRoomId)scheduleReconnect()};ws.onerror=()=>{};showScreen('#lobbyScreen')}
function scheduleReconnect(){clearTimeout(reconnectTimer);reconnectTimer=setTimeout(()=>{if(currentRoomId){const n=localStorage.getItem(ACTIVE_NAME_KEY)||currentPlayerName;connectWs(currentRoomId,n,getToken(currentRoomId))}},1200)}
function send(type,payload={}){if(!ws||ws.readyState!==WebSocket.OPEN)return;ws.send(JSON.stringify({type,actionId:newActionId(type),...payload}))}

function me(){return state?.players?.find(p=>p.tokenHash===getToken(currentRoomId).slice(0,8))}
function onState(){if(!state)return;const started=state.status==='playing';if(started&&state.gameSessionId&&commonNameSavedForSession!==state.gameSessionId){saveCommonNameOnActualStart(currentPlayerName);commonNameSavedForSession=state.gameSessionId}if(state.gameSessionId&&lastGameSessionId!==state.gameSessionId){lastGameSessionId=state.gameSessionId;for(let i=0;i<6;i++)answerDraft[i]='';syncAnswerInputs()}if(state.status==='lobby'){stopTimerTicker();renderLobby();showScreen('#lobbyScreen')}else if(state.status==='playing'){renderGame();showScreen('#gameScreen')}else if(state.status==='finished'){renderGame();showScreen('#gameScreen');renderResult();$('#resultScreen').classList.add('active')}}
function renderLobby(){$('#lobbyRoomName').textContent=`ROOM ${roomNo(currentRoomId)}`;$('#lobbyStatus').textContent='待機中';$('#lobbyPlayers').innerHTML=state.players.map((p,i)=>`<div class="player-row">${i+1}. ${esc(p.name)}${p.id===state.hostId?'（ホスト）':''}</div>`).join('');const mine=me();$('#startBtn').disabled=!mine||mine.id!==state.hostId||state.players.length<1}

function renderGame(){const mine=me();$('#gameRoomLabel').textContent=`ROOM ${roomNo(currentRoomId)}`;const turn=state.players.find(p=>p.id===state.turnPlayerId);const phase=state.phase||'turn';$('#turnLabel').textContent=state.status==='finished'?'答え合わせ':phase==='thinking'?'シンキングタイム':turn?`${turn.name}の手番　公開質問 ${state.totalQuestionCount||0}`:`公開質問 ${state.totalQuestionCount||0}`;$('#playerStrip').innerHTML=state.players.map(p=>`<div class="player-chip ${p.id===state.turnPlayerId&&phase==='turn'?'turn':''} ${p.answerLocked?'locked':''}"><b>${esc(p.name)}</b><br>${p.answerLocked?`🔒 回答済み　Q${p.answerQuestionCount??0}`:`未回答・質問 ${p.questionCount||0}`}</div>`).join('');if(phase==='turn'&&state.turnPlayerId===mine?.id&&lastTurnPlayerId!==mine.id&&state.status==='playing'&&!mine?.answerLocked){const pop=$('#turnPop');pop.classList.remove('hidden');setTimeout(()=>pop.classList.add('hidden'),2200)}lastTurnPlayerId=state.turnPlayerId;buildQuestionBoard();renderMemo();renderHistory();const myTurn=mine&&phase==='turn'&&state.turnPlayerId===mine.id&&!mine.answerLocked&&state.status==='playing';$$('[data-qtype]').forEach(b=>b.disabled=!myTurn);renderAnswerBox(mine);startTimerTicker()}

function initAnswerGrid(){const grid=$('#answerGridInline');if(!grid||grid.children.length)return;grid.innerHTML=Array.from({length:6},(_,i)=>`<select data-answer-digit="${i}" aria-label="解答${i+1}"><option value="">-</option>${[0,1,2,3,4,5,6,7,8,9].map(n=>`<option value="${n}">${n}</option>`).join('')}</select>`).join('');grid.querySelectorAll('[data-answer-digit]').forEach(sel=>sel.addEventListener('change',()=>{answerDraft[Number(sel.dataset.answerDigit)]=sel.value}))}
function syncAnswerInputs(){initAnswerGrid();$$('[data-answer-digit]').forEach(sel=>{const i=Number(sel.dataset.answerDigit);if(sel.value!==String(answerDraft[i]??''))sel.value=String(answerDraft[i]??'')})}
function renderAnswerBox(mine){syncAnswerInputs();const locked=!!mine?.answerLocked||state?.status!=='playing';$$('[data-answer-digit]').forEach(sel=>sel.disabled=locked);$('#answerBtn').disabled=!mine||locked;$('#answerBtn').textContent=mine?.answerLocked?'回答済み':'回答確定';$('#answerStatus').textContent=mine?.answerLocked?`回答済み・Q${mine.answerQuestionCount??0}`:'未確定'}
function stopTimerTicker(){if(timerTicker){clearInterval(timerTicker);timerTicker=null}}
function updatePhaseTimer(){const el=$('#phaseTimer');if(!el||!state||state.status!=='playing'){if(el)el.textContent='--';return}const deadline=Number(state.phaseDeadline||0);const remain=Math.max(0,deadline-Date.now());const sec=Math.ceil(remain/1000);if(state.phase==='thinking'){el.textContent=`思考 ${sec}秒`;el.classList.add('thinking')}else{el.textContent=`手番 ${sec}秒`;el.classList.remove('thinking')}}
function startTimerTicker(){stopTimerTicker();updatePhaseTimer();timerTicker=setInterval(updatePhaseTimer,200)}

const DIGIT_SEGS={0:['a','b','c','d','e','f'],1:['b','c'],2:['a','b','d','e','g'],3:['a','b','c','d','g'],4:['b','c','f','g'],5:['a','c','d','f','g'],6:['a','c','d','e','f','g'],7:['a','b','c'],8:['a','b','c','d','e','f','g'],9:['a','b','c','d','f','g']};
function buildQuestionBoard(){const b=$('#questionBoard');b.innerHTML='';for(let i=0;i<6;i++){const cell=document.createElement('div');cell.className='digit-cell';cell.dataset.digit=i;cell.innerHTML=`<span class="digit-label">${DIGIT_LABELS[i]}</span><span class="parity-mark">${state.publicInfo?.parity?.[i]||''}</span>`;for(const s of SEGMENTS){const el=document.createElement('div');el.className=`seg ${s}`;const pub=state.publicInfo?.segments?.[i]?.[s];if(pub===true)el.classList.add('on');if(pub===false)el.classList.add('off');const local=memo.segments[i][s];if(pub==null&&local===1)el.classList.add('local-on');if(pub==null&&local===2)el.classList.add('local-off');el.onclick=()=>segmentClick(i,s);cell.appendChild(el)}b.appendChild(cell)}addLineButtons(b);addCompareButtons(b)}
function addLineButtons(b){const labels=['A','B','C','D','E','F','G','H','I'];labels.forEach((l,i)=>{const btn=document.createElement('button');btn.className='line-btn'+(state.publicInfo?.lines?.[l]!=null?' answered':'');btn.textContent=state.publicInfo?.lines?.[l]!=null?`${l}:${state.publicInfo.lines[l]}`:l;btn.style.top='1%';btn.style.left=`${7+i*10.3}%`;btn.onclick=()=>lineClick(l);b.appendChild(btn)});const rows=['J','K','L','M','N','O','P','Q','R','S'];rows.forEach((l,i)=>{const btn=document.createElement('button');btn.className='line-btn'+(state.publicInfo?.lines?.[l]!=null?' answered':'');btn.textContent=state.publicInfo?.lines?.[l]!=null?`${l}:${state.publicInfo.lines[l]}`:l;btn.style.left='1%';const local=i<5?8+i*8.2:56+(i-5)*8.2;btn.style.top=`${local}%`;btn.onclick=()=>lineClick(l);b.appendChild(btn)})}
function addCompareButtons(b){const pairs=state.comparePairs||[];pairs.forEach((p,i)=>{const [a,c]=p;const btn=document.createElement('button');btn.className='compare-btn'+(state.publicInfo?.compare?.[`${a}-${c}`]?' answered':'');btn.textContent=state.publicInfo?.compare?.[`${a}-${c}`]||'↔';const pos=[[32,25],[63,25],[32,75],[63,75],[17,50],[50,50],[83,50]][i]||[50,50];btn.style.left=pos[0]+'%';btn.style.top=pos[1]+'%';btn.onclick=()=>compareClick(a,c);b.appendChild(btn)})}
function currentType(t){return selectedQuestionType===t}
function lineClick(label){if(currentType('line'))confirmQuestion({kind:'line',label});}
function segmentClick(i,s){if(currentType('segment')){confirmQuestion({kind:'segment',digit:i,segment:s});return}memo.segments[i][s]=(memo.segments[i][s]+1)%3;buildQuestionBoard()}
function compareClick(a,b){if(currentType('compare'))confirmQuestion({kind:'compare',a,b})}
function digitClickParity(i){if(currentType('parity'))confirmQuestion({kind:'parity',digit:i})}
function confirmQuestion(target){selectedTarget=target;const text=questionText(target);$('#questionHint').textContent=text+' を質問します';if(confirm(`${text}\n質問を確定しますか？`)){send('ask',{question:target});selectedQuestionType=null;selectedTarget=null;$('#questionHint').textContent='質問種類を選んでください。'}}
function questionText(q){if(q.kind==='line')return `${q.label}列の線の本数`;if(q.kind==='parity')return `${DIGIT_LABELS[q.digit]}の奇数/偶数`;if(q.kind==='compare')return `${DIGIT_LABELS[q.a]}と${DIGIT_LABELS[q.b]}の大小`;return `${DIGIT_LABELS[q.digit]}の線${q.segment.toUpperCase()}の有無`}

function renderMemo(){const pane=$('#memoPane');pane.innerHTML=`<div class="memo-grid">${memo.candidates.map((set,i)=>`<div class="memo-card"><div class="memo-title">${DIGIT_LABELS[i]}</div><div class="candidate-grid">${[0,1,2,3,4,5,6,7,8,9].map(n=>`<button class="candidate ${set.has(n)?'':'off'}" data-candidate="${i}:${n}">${n}</button>`).join('')}</div></div>`).join('')}</div><p class="hint">数字候補はタップで消去/復活。盤面の線は質問選択中以外なら3状態メモです。</p>`;pane.querySelectorAll('[data-candidate]').forEach(btn=>btn.onclick=()=>{const [i,n]=btn.dataset.candidate.split(':').map(Number);const set=memo.candidates[i];set.has(n)?set.delete(n):set.add(n);renderMemo()})}
function renderHistory(){const h=state.history||[];$('#historyPane').innerHTML=h.length?h.slice().reverse().map(x=>`<div class="history-item"><b>${esc(x.playerName)}</b><br>${esc(x.questionText)} → <strong>${esc(x.answerText)}</strong></div>`).join(''):'<div class="hint">まだ質問はありません。</div>'}

function submitAnswer(){const mine=me();if(!mine||mine.answerLocked||state?.status!=='playing')return;syncAnswerInputs();if(answerDraft.some(v=>v==='')){alert('6か所すべて入力してください。');return}const arr=answerDraft.map(Number);const q=state?.totalQuestionCount||0;if(!confirm(`この回答を伏せて確定しますか？
${arr.slice(0,3).join('')}
${arr.slice(3).join('')}

現在の公開質問数：${q}
確定後は変更できず、以降の自分の手番は自動パスになります。`))return;send('answer',{digits:arr})}
function renderResult(){const ranked=[...state.players].sort((a,b)=>(a.rank??999)-(b.rank??999));const correct=ranked.filter(p=>p.isCorrect);$('#resultTitle').textContent=correct.length?'答え合わせ・順位':'全員不正解';$('#resultBody').innerHTML=`<div class="hint">正解コード</div><div class="secret-code">${(state.revealedCode||[]).map(n=>`<div>${n}</div>`).join('')}</div><div class="player-list result-ranking">${ranked.map(p=>`<div class="player-row ${p.isCorrect?'correct':'wrong'}"><b>${p.rank??'-'}位　${esc(p.name)}</b>　${p.isCorrect?'正解':'不正解'}　確定時質問 ${p.answerQuestionCount??'-'}<br><span class="submitted-code">回答：${Array.isArray(p.submittedAnswer)?`${p.submittedAnswer.slice(0,3).join('')} / ${p.submittedAnswer.slice(3).join('')}`:'-'}</span></div>`).join('')}</div>`;const mine=me();$('#rematchBtn').disabled=!mine||mine.id!==state.hostId}

function leaveRoom(){if(ws&&ws.readyState===WebSocket.OPEN)send('leave');currentRoomId=null;state=null;localStorage.removeItem(ACTIVE_ROOM_KEY);localStorage.removeItem(ACTIVE_NAME_KEY);try{ws?.close()}catch{};ws=null;showScreen('#titleScreen');loadRooms()}
function backLobby(){send('backLobby')}

function openMobilePanel(tab){const side=document.querySelector('.side-panel');if(window.innerWidth<=760){side.classList.toggle('mobile-open');}document.querySelectorAll('.tab').forEach(x=>x.classList.toggle('active',x.dataset.tab===tab));document.querySelectorAll('.tab-pane').forEach(x=>x.classList.toggle('active',x.id===tab+'Pane'))}

$('#nameInput').value=sessionStorage.getItem(NAME_DRAFT_KEY)??commonSavedName()??'';
$('#nameInput').addEventListener('input',e=>sessionStorage.setItem(NAME_DRAFT_KEY,e.target.value));
$('#refreshRoomsBtn').onclick=loadRooms;$('#roomGrid').onclick=e=>{const j=e.target.closest('[data-join-room]');const r=e.target.closest('[data-reset-room]');if(j)joinRoom(j.dataset.joinRoom);if(r)resetRoom(r.dataset.resetRoom).catch(err=>alert(err.message))};
$('#memoOpenBtn').onclick=()=>openMobilePanel('memo');$('#historyOpenBtn').onclick=()=>openMobilePanel('history');
$('#startBtn').onclick=()=>send('start');$('#leaveLobbyBtn').onclick=leaveRoom;$('#leaveGameBtn').onclick=leaveRoom;$('#answerBtn').onclick=submitAnswer;$('#rematchBtn').onclick=()=>send('rematch');$('#backLobbyBtn').onclick=backLobby;
$$('[data-qtype]').forEach(b=>b.onclick=()=>{selectedQuestionType=b.dataset.qtype;selectedTarget=null;$('#questionHint').textContent={line:'A～Sの列ラベルを選択してください。',parity:'T～Yの数字位置を選択してください。',compare:'数字間の↔を選択してください。',segment:'調べたい線を直接選択してください。'}[selectedQuestionType];if(selectedQuestionType==='parity')$$('.digit-cell').forEach((el,i)=>{el.onclick=()=>digitClickParity(i)})});
$$('.tab').forEach(t=>t.onclick=()=>{$$('.tab').forEach(x=>x.classList.remove('active'));$$('.tab-pane').forEach(x=>x.classList.remove('active'));t.classList.add('active');$('#'+t.dataset.tab+'Pane').classList.add('active')});
initAnswerGrid();
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'&&currentRoomId&&(!ws||ws.readyState!==WebSocket.OPEN))scheduleReconnect()});window.addEventListener('online',()=>{if(currentRoomId&&(!ws||ws.readyState!==WebSocket.OPEN))scheduleReconnect()});
(async()=>{const active=localStorage.getItem(ACTIVE_ROOM_KEY),name=localStorage.getItem(ACTIVE_NAME_KEY);if(active&&ROOM_IDS.includes(active)&&name){currentRoomId=active;currentPlayerName=name;connectWs(active,name,getToken(active))}else{showScreen('#titleScreen');await loadRooms()}})();

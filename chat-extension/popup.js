'use strict';

const BASE = 'https://livechat-u2jk.onrender.com';

/* ────────────────────────────────────────────
   상태
──────────────────────────────────────────── */
let token       = null;
let currentUser = null;   // { id, username, nickname }
let socket      = null;
let currentRoom = null;   // { title, code, isHost, hostUserId }

/* ────────────────────────────────────────────
   chrome.storage.local 헬퍼
──────────────────────────────────────────── */
const store = {
  get: (key)  => new Promise(r => chrome.storage.local.get(key, d => r(d[key] ?? null))),
  set: (obj)  => new Promise(r => chrome.storage.local.set(obj, r)),
  del: (key)  => new Promise(r => chrome.storage.local.remove(key, r)),
};

/* ────────────────────────────────────────────
   API 요청 (app.js의 apiRequest와 동일 구조)
──────────────────────────────────────────── */
async function api(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '요청 처리 중 오류가 발생했습니다.');
  return data;
}

/* ────────────────────────────────────────────
   UI 헬퍼
──────────────────────────────────────────── */
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function showModal(id) {
  document.getElementById(id).classList.remove('hidden');
}

function hideModals() {
  document.querySelectorAll('.modal-overlay').forEach(m => m.classList.add('hidden'));
}

function setLoginAlert(msg, type = 'error') {
  const el = document.getElementById('loginAlert');
  el.textContent = msg;
  el.className = `alert${type === 'success' ? ' success' : ''}`;
  el.classList.remove('hidden');
}

/* ────────────────────────────────────────────
   유틸
──────────────────────────────────────────── */
function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function avClass(name = '') {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) & 0xff;
  return `av-${h % 8}`;
}

function relTime(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr), now = new Date();
  const sec = (now - d) / 1000;
  if (sec < 60) return '방금 전';
  if (sec < 3600) return `${Math.floor(sec / 60)}분 전`;
  const yest = new Date(now);
  yest.setDate(now.getDate() - 1);
  if (d.toDateString() === now.toDateString())  return '오늘';
  if (d.toDateString() === yest.toDateString()) return '어제';
  return `${Math.floor(sec / 86400)}일 전`;
}

function msgTime(dateStr) {
  if (!dateStr) return '';
  return new Date(dateStr).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
}

/* ────────────────────────────────────────────
   초기화 — 저장된 토큰이 있으면 바로 방 목록으로
──────────────────────────────────────────── */
async function init() {
  document.getElementById('registerLink').href = `${BASE}/register.html`;

  token = await store.get('token');
  if (token) {
    try {
      const data = await api('/api/auth/me');
      currentUser = data.user;
      updateFooter();
      await loadRooms();
      connectSocket();
      showScreen('roomListScreen');
    } catch {
      // 토큰 만료 등 → 로그인 화면
      await store.del('token');
      token = null;
      showScreen('loginScreen');
    }
  } else {
    showScreen('loginScreen');
  }
}

/* ────────────────────────────────────────────
   로그인
──────────────────────────────────────────── */
document.getElementById('loginBtn').addEventListener('click', doLogin);
document.getElementById('loginPassword').addEventListener('keydown', e => {
  if (e.key === 'Enter') doLogin();
});

async function doLogin() {
  const un = document.getElementById('loginUsername').value.trim();
  const pw = document.getElementById('loginPassword').value;
  if (!un || !pw) { setLoginAlert('아이디와 비밀번호를 입력해주세요.'); return; }

  const btn = document.getElementById('loginBtn');
  btn.disabled = true;
  btn.textContent = '로그인 중...';

  try {
    // 1. 로그인 → 토큰 발급
    const loginData = await api('/api/auth/login', {
      method: 'POST',
      body: { username: un, password: pw },
    });
    token = loginData.token;
    await store.set({ token });

    // 2. 사용자 정보 확인 (app.js의 restoreUser와 동일)
    const meData = await api('/api/auth/me');
    currentUser = meData.user;

    updateFooter();
    await loadRooms();
    connectSocket();
    showScreen('roomListScreen');
  } catch (e) {
    setLoginAlert(e.message || '로그인에 실패했습니다.');
  } finally {
    btn.disabled = false;
    btn.textContent = '로그인';
  }
}

/* ────────────────────────────────────────────
   로그아웃
──────────────────────────────────────────── */
document.getElementById('logoutBtn').addEventListener('click', async () => {
  await store.del('token');
  token = null;
  currentUser = null;
  currentRoom = null;
  disconnectSocket();

  document.getElementById('loginUsername').value = '';
  document.getElementById('loginPassword').value = '';
  document.getElementById('loginAlert').classList.add('hidden');
  showScreen('loginScreen');
});

/* ────────────────────────────────────────────
   하단 유저 정보 업데이트
──────────────────────────────────────────── */
function updateFooter() {
  const nick = currentUser?.nickname || currentUser?.username || '-';
  document.getElementById('footerNick').textContent   = nick;
  document.getElementById('footerAvatar').textContent = (nick[0] ?? '?').toUpperCase();
}

/* ────────────────────────────────────────────
   방 목록 (REST)
   — app.js: refreshMyRooms → /api/rooms/mine
             refreshRecentRooms → /api/rooms/recent
──────────────────────────────────────────── */
async function loadRooms() {
  try {
    const [mine, recent] = await Promise.all([
      api('/api/rooms/mine'),
      api('/api/rooms/recent'),
    ]);
    renderRooms('savedList',  mine.rooms   ?? [], true);
    renderRooms('recentList', recent.rooms ?? [], false);
  } catch {
    renderRooms('savedList',  [], true);
    renderRooms('recentList', [], false);
  }
}

function renderRooms(listId, rooms, isOwner) {
  const el = document.getElementById(listId);
  if (!rooms.length) {
    el.innerHTML = `<div class="room-empty">${isOwner ? '만든 방이 없습니다' : '최근 들어간 방이 없습니다'}</div>`;
    return;
  }

  el.innerHTML = rooms.map(r => {
    const name  = esc(r.title || r.roomName || '방');
    const first = (r.title || r.roomName || '?')[0].toUpperCase();
    const code  = esc(r.code || r.roomCode || '------');
    const count = r.members?.length ?? 0;
    const time  = relTime(r.updatedAt || r.createdAt);
    const av    = avClass(r.title || r.roomName);
    return `
      <div class="room-item" data-code="${code}" data-name="${name}">
        <div class="room-avatar ${av}">${first}</div>
        <div class="room-info">
          <div class="room-name-row">
            <span class="room-name">${name}</span>
            ${isOwner ? '<span class="badge-host">방장</span>' : ''}
          </div>
          <div class="room-code-row">${code} · ${count}명</div>
        </div>
        <div class="room-meta"><span class="room-time">${time}</span></div>
      </div>`;
  }).join('');

  el.querySelectorAll('.room-item').forEach(item => {
    item.addEventListener('click', () => joinRoom(item.dataset.code));
  });
}

/* ────────────────────────────────────────────
   탭 전환
──────────────────────────────────────────── */
document.querySelectorAll('.tabs .tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tabs .tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
    const target = tab.dataset.tab === 'saved' ? 'savedList' : 'recentList';
    document.getElementById(target).classList.add('active');
  });
});

/* ────────────────────────────────────────────
   모달: 코드로 참가
──────────────────────────────────────────── */
document.getElementById('joinCodeBtn').addEventListener('click', () => {
  document.getElementById('joinCodeInput').value = '';
  showModal('joinModal');
});

document.getElementById('joinCodeInput').addEventListener('input', e => {
  e.target.value = e.target.value.toUpperCase();
});

document.getElementById('joinCodeInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('joinSubmit').click();
});

document.getElementById('joinSubmit').addEventListener('click', () => {
  const code = document.getElementById('joinCodeInput').value.trim().toUpperCase();
  if (!/^[0-9A-Z]{6}$/.test(code)) {
    alert('방 코드는 영문/숫자 6자리입니다. (예: A1B2C3)');
    return;
  }
  hideModals();
  joinRoom(code);
});

/* ────────────────────────────────────────────
   모달: 방 만들기
   — app.js: socket.emit('room:create', { title })
──────────────────────────────────────────── */
document.getElementById('createRoomBtn').addEventListener('click', () => {
  document.getElementById('createTitle').value = '';
  showModal('createModal');
});

document.getElementById('createTitle').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('createSubmit').click();
});

document.getElementById('createSubmit').addEventListener('click', () => {
  const title = document.getElementById('createTitle').value.trim();
  if (!title) { alert('방 이름을 입력해주세요.'); return; }
  if (!socket) { alert('연결이 끊어졌습니다. 다시 로그인해주세요.'); return; }

  hideModals();
  document.getElementById('createTitle').value = '';
  socket.emit('room:create', { title });
  // 생성 후 room:state 이벤트에서 채팅 화면으로 자동 전환
});

/* 모달 닫기 */
document.querySelectorAll('.modal-cancel').forEach(btn => {
  btn.addEventListener('click', hideModals);
});
document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', e => { if (e.target === overlay) hideModals(); });
});

/* ────────────────────────────────────────────
   방 입장
   — app.js: socket.emit('room:join', { code })
──────────────────────────────────────────── */
function joinRoom(code) {
  if (!socket) { alert('연결이 끊어졌습니다. 다시 로그인해주세요.'); return; }
  socket.emit('room:join', { code });
  // room:state 이벤트에서 화면 전환 + 히스토리 로드
}

/* ────────────────────────────────────────────
   뒤로가기 (방 나가기)
   — app.js: socket.emit('room:leave')
──────────────────────────────────────────── */
document.getElementById('backBtn').addEventListener('click', () => {
  if (socket) socket.emit('room:leave');
  currentRoom = null;
  document.getElementById('msgList').innerHTML = '';
  loadRooms().catch(() => {});
  showScreen('roomListScreen');
});

/* ────────────────────────────────────────────
   방 코드 복사
──────────────────────────────────────────── */
document.getElementById('copyCodeBtn').addEventListener('click', () => {
  const code = document.getElementById('chatCode').textContent;
  navigator.clipboard.writeText(code).catch(() => {});
});

/* ────────────────────────────────────────────
   소켓 연결
   — 서버 이벤트: session:user, room:state, room:users,
                  chat:history, chat:receive, system:notice,
                  room:kicked, chat:error, connect_error
──────────────────────────────────────────── */
function connectSocket() {
  disconnectSocket();

  if (typeof io === 'undefined') {
    console.warn('[LiveChat] socket.io.min.js 가 없습니다. ' +
      'https://cdn.socket.io/4.7.2/socket.io.min.js 를 다운로드해 확장 폴더에 추가하세요.');
    return;
  }

  socket = io(BASE, {
    transports: ['websocket'],
    auth: { token },
  });

  /* 연결 시 사용자 정보 (app.js: socket.on('session:user')) */
  socket.on('session:user', user => {
    currentUser = user;
    updateFooter();
  });

  /* 방 상태 변경 (입장·나가기·생성·강퇴 후 모두 수신) */
  socket.on('room:state', room => {
    currentRoom = room || null;

    if (room) {
      document.getElementById('chatTitle').textContent = room.title || room.code;
      document.getElementById('chatCode').textContent  = room.code;
      document.getElementById('chatCount').textContent = '0';
      document.getElementById('chatHostBadge').classList.toggle('hidden', !room.isHost);
      showScreen('chatScreen');
      loadRooms().catch(() => {});
    } else {
      document.getElementById('msgList').innerHTML = '';
      showScreen('roomListScreen');
      loadRooms().catch(() => {});
    }
  });

  /* 참가자 목록 갱신 (app.js: socket.on('room:users')) */
  socket.on('room:users', payload => {
    if (payload?.room && currentRoom && payload.room.code === currentRoom.code) {
      currentRoom.isHost = payload.room.hostUserId === currentUser?.id;
      document.getElementById('chatHostBadge').classList.toggle('hidden', !currentRoom.isHost);
    }
    const count = payload?.users?.length ?? 0;
    document.getElementById('chatCount').textContent = count;
  });

  /* 메시지 히스토리 (입장 직후 수신) */
  socket.on('chat:history', payload => {
    // app.js: payload가 배열이거나 { roomCode, messages } 형태
    const msgs = Array.isArray(payload) ? payload : (payload?.messages ?? []);

    // 다른 방 히스토리 무시
    const payloadCode = Array.isArray(payload) ? '' : (payload?.roomCode ?? '');
    if (payloadCode && currentRoom && payloadCode !== currentRoom.code) return;

    document.getElementById('msgList').innerHTML = '';
    msgs.forEach(appendMsg);
    scrollBottom();
  });

  /* 실시간 메시지 수신 (chat:receive) */
  socket.on('chat:receive', msg => {
    appendMsg(msg);
    scrollBottom();
  });

  /* 시스템 공지 */
  socket.on('system:notice', payload => {
    appendSys(payload?.text || payload || '');
  });

  /* 강퇴 */
  socket.on('room:kicked', payload => {
    currentRoom = null;
    document.getElementById('msgList').innerHTML = '';
    alert(`${payload.byNickname} 님에게 강퇴당했습니다. (${payload.roomCode})`);
    loadRooms().catch(() => {});
    showScreen('roomListScreen');
  });

  /* 오류 */
  socket.on('chat:error', msg => appendSys(`⚠️ ${msg}`));
  socket.on('connect_error', () => appendSys('⚠️ 소켓 연결에 실패했습니다.'));
}

function disconnectSocket() {
  if (socket) { socket.disconnect(); socket = null; }
}

/* ────────────────────────────────────────────
   메시지 렌더링
──────────────────────────────────────────── */
function appendMsg(msg) {
  const list   = document.getElementById('msgList');
  const isSelf = currentUser
    && msg.senderId
    && String(msg.senderId) === String(currentUser.id);

  const nick  = msg.sender || '알 수 없음';
  const first = nick[0].toUpperCase();
  const av    = avClass(nick);
  const time  = msgTime(msg.createdAt);

  // app.js: mediaMime 기준으로 이미지/비디오 판별
  const imgUrl   = msg.mediaMime?.startsWith('image/') ? msg.mediaUrl : (msg.imageData || '');
  const videoUrl = msg.mediaMime?.startsWith('video/') ? msg.mediaUrl : (msg.videoData || '');

  let content = '';
  if (imgUrl) {
    content = `<img class="msg-img" src="${esc(imgUrl)}" alt="이미지" loading="lazy" />`;
  } else if (videoUrl) {
    content = `<video class="msg-img" src="${esc(videoUrl)}" controls preload="metadata"></video>`;
  } else {
    content = `<div class="msg-bubble">${esc(msg.text || '').replace(/\n/g, '<br>')}</div>`;
  }

  const group = document.createElement('div');
  group.className = `msg-group${isSelf ? ' self' : ''}`;
  group.innerHTML = `
    <div class="msg-header">
      <div class="msg-avatar ${av}">${first}</div>
      <span class="msg-author">${esc(nick)}</span>
      <span class="msg-time-label">${time}</span>
    </div>
    ${content}`;
  list.appendChild(group);
}

function appendSys(text) {
  const el = document.createElement('div');
  el.className = 'sys-msg';
  el.textContent = text;
  document.getElementById('msgList').appendChild(el);
  scrollBottom();
}

function scrollBottom() {
  const list = document.getElementById('msgList');
  requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; });
}

/* ────────────────────────────────────────────
   메시지 전송
   — app.js: socket.emit('chat:send', { text, mediaUrl, mediaMime, imageData, videoData })
──────────────────────────────────────────── */
document.getElementById('sendBtn').addEventListener('click', sendMsg);
document.getElementById('msgInput').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMsg(); }
});

function sendMsg() {
  const input = document.getElementById('msgInput');
  const text  = input.value.trim();
  if (!text || !socket || !currentRoom) return;

  socket.emit('chat:send', {
    text,
    mediaUrl:  '',
    mediaMime: '',
    imageData: '',
    videoData: '',
  });

  input.value = '';
  input.focus();
}

/* ────────────────────────────────────────────
   시작
──────────────────────────────────────────── */
init();

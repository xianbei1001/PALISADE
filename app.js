'use strict';

const $ = (sel) => document.querySelector(sel);

const TYPES = {
  world: { label: '组织', cls: 'world' },
  character: { label: '人员信息', cls: 'character' },
  incident: { label: '绝密事件', cls: 'incident' },
};

/* 琥珀单色屏：头像只用同一色相的不同明度，保持"一块屏只有一个颜色"的观感 */
const AVATAR_COLORS = [
  'rgba(255, 176, 0, 0.16)', 'rgba(255, 208, 90, 0.13)', 'rgba(192, 138, 16, 0.20)',
  'rgba(255, 106, 61, 0.12)', 'rgba(255, 176, 0, 0.10)', 'rgba(255, 208, 90, 0.19)',
  'rgba(138, 97, 0, 0.22)', 'rgba(255, 176, 0, 0.24)',
];

const BODY_LIMIT = 420;

const state = {
  user: null,
  messages: new Map(),
  filter: 'all',
  q: '',
  order: 'desc',
  type: 'world',
  replyTo: null,
  editing: null,
  unread: 0,
  entered: false,
  admin: false,
  wantAdmin: false,
  realtime: true,
  expanded: new Set(), // 已展开全文的消息 id，重建 DOM 后要还原
  opened: new Set(),   // 已点开的涂黑块 key（消息 id:序号）
};

let stream = null;
let pollTimer = null;

/* 静态镜像模式：build.mjs 生成的 data.js 会定义 window.ARCHIVE_DATA。
   但同一个 dist 也可能被 Worker 托管（那时 /api/me 可用），
   所以先探测后端，探到了就以后端为准。 */
const ARCHIVE_DATA = Array.isArray(window.ARCHIVE_DATA) ? window.ARCHIVE_DATA : null;
let staticMode = Boolean(ARCHIVE_DATA);

const feed = $('#feed');
const emptyEl = $('#empty');
const bodyInput = $('#bodyInput');
const sendBtn = $('#sendBtn');
const jumpBtn = $('#jumpTop');
const connEl = $('#conn');
const connText = $('#connText');

/* ---------------- 工具 ---------------- */

const esc = (value) =>
  String(value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));

function colorFor(name) {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && url !== '/api/login') {
      state.admin = false;
      state.editing = null;
      applyAdminMode();
      render();
      openLogin();
    }
    const err = new Error(data.error || '请求失败（' + res.status + '）');
    err.status = res.status;
    throw err;
  }
  return data;
}

let toastTimer = null;
function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2400);
}

function setConn(online) {
  connEl.classList.toggle('is-on', online);
  connEl.classList.toggle('is-off', !online);
  connText.textContent = online
    ? (state.admin ? 'TAPE_DRIVE: MOUNTED // READ-WRITE' : 'TAPE_DRIVE: MOUNTED // READ-ONLY')
    : 'TAPE_DRIVE: UNMOUNTED // RECONNECTING…';
  setStatus(online ? 'LINK OK' : 'LINK LOST');
}

function setStatus(text) {
  const el = $('#sbState');
  if (el) el.textContent = text;
}

/* ---------------- 档案库接入（伪验证） ---------------- */

function gateStatus(text) {
  const el = $('#gateStatus');
  if (el) el.textContent = text;
}

function openArchive() {
  if (state.entered) return;
  state.entered = true;

  const button = $('#gateBtn');
  const key = $('#gateKey');
  button.disabled = true;
  key.disabled = true;
  gateStatus('DECRYPTING ARCHIVES...');
  setStatus('DECRYPTING');

  setTimeout(() => {
    gateStatus('DECRYPTING ARCHIVES... [OK]');
    setTimeout(() => {
      $('#gate').classList.add('is-gone');
      enterApp();
      setTimeout(() => { $('#gate').hidden = true; }, 260);
    }, 240);
  }, 520);
}

function enterApp() {
  $('#appView').hidden = false;
  applyAdminMode();
  setStatus('LINK OK');
  render();
  autoGrow();
  sync();
  // 等 /api/me 回来再决定用 SSE 还是轮询，避免先错连一次
  meReady.then(() => {
    connect();
    if (state.wantAdmin && !state.admin) setTimeout(openLogin, 240);
  });
}

/** 按 state.admin 切换录入界面与顶栏按钮 */
function applyAdminMode() {
  $('#composer').hidden = !state.admin;
  $('#logoutBtn').hidden = !state.admin;
  $('#clearance').classList.toggle('is-mgr', state.admin);
}

function openLogin() {
  const box = $('#login');
  box.hidden = false;
  box.classList.remove('is-gone');
  $('#loginWarn').textContent = 'SELECT ACCESS MODE';
  $('#loginTitle').textContent = '// 选择接入方式';
  $('#loginHint').textContent = '管理员可录入与改写档案。访客只能阅读。';
  $('#modeChoice').hidden = false;
  $('#loginForm').hidden = true;
  $('#loginStatus').textContent = '';
  $('#loginBtn').disabled = false;
  $('#loginPass').value = '';
}

function chooseAdmin() {
  $('#loginWarn').textContent = 'MANAGER AUTHENTICATION';
  $('#loginTitle').textContent = '// 管理口令';
  $('#loginHint').textContent = '输入管理口令，验证通过后启用录入与改写。';
  $('#modeChoice').hidden = true;
  $('#loginForm').hidden = false;
  $('#loginStatus').textContent = '';
  setTimeout(() => $('#loginPass').focus(), 60);
}

function chooseGuest() {
  state.wantAdmin = false;
  if (location.search) history.replaceState(null, '', location.pathname);
  closeLogin();
  setStatus('LINK OK');
  toast('READ-ONLY');
}

function closeLogin() {
  const box = $('#login');
  box.classList.add('is-gone');
  setTimeout(() => { box.hidden = true; }, 240);
}

async function submitLogin(event) {
  event.preventDefault();
  const pass = $('#loginPass').value.trim();
  if (!pass) return;

  const button = $('#loginBtn');
  button.disabled = true;
  $('#loginStatus').textContent = 'VERIFYING...';

  try {
    await api('POST', '/api/login', { password: pass });
    state.admin = true;
    $('#loginStatus').textContent = 'ACCESS GRANTED';
    setTimeout(() => {
      $('#loginPass').value = '';
      applyAdminMode();
      setConn(true);
      setStatus('LINK OK');
      closeLogin();
      render();
      autoGrow();
      toast('READ-WRITE');
      setTimeout(() => bodyInput.focus(), 260);
    }, 420);
  } catch (err) {
    $('#loginStatus').textContent = err.message || '口令不正确';
    button.disabled = false;
    $('#loginPass').select();
  }
}

async function doLogout() {
  try {
    await api('POST', '/api/logout');
  } catch {
    /* 会话本就不存在也没关系 */
  }
  state.admin = false;
  applyAdminMode();
  render();
  location.replace(location.pathname);
}

$('#gateBtn').addEventListener('click', openArchive);

$('#gateKey').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    openArchive();
  }
});

$('#gateForm').addEventListener('submit', (event) => {
  event.preventDefault();
  openArchive();
});

$('#loginForm').addEventListener('submit', submitLogin);
$('#logoutBtn').addEventListener('click', doLogout);
$('#modeAdmin').addEventListener('click', chooseAdmin);
$('#modeGuest').addEventListener('click', chooseGuest);
$('#loginBack').addEventListener('click', openLogin);

/* ---------------- 渲染 ---------------- */

function visibleMessages() {
  let list = [...state.messages.values()];

  if (state.filter !== 'all') list = list.filter((m) => m.type === state.filter);

  const q = state.q.trim().toLowerCase();
  if (q) {
    list = list.filter((m) =>
      ((m.code || '') + '\n' + m.title + '\n' + m.body + '\n' + m.author)
        .toLowerCase().includes(q));
  }

  list.sort((a, b) => a.seq - b.seq);
  if (state.order === 'desc') list.reverse();
  return list;
}

function quoteHtml(m) {
  if (!m.replyTo) return '';
  const src = state.messages.get(m.replyTo);
  if (!src) return '<div class="quote">原消息已删除</div>';
  const text = (src.title || src.body).replace(/\s+/g, ' ');
  return '<div class="quote"><b>' + esc(src.author) + '</b>：' + esc(text.slice(0, 80)) + '</div>';
}

function bodyHtml(text, mid) {
  let n = 0;
  const markup = (chunk) =>
    esc(chunk).replace(/\[\[([^\[\]]+)\]\]/g, (all, inner) => {
      const k = mid + ':' + n++;
      const open = state.opened.has(k) ? ' is-open' : '';
      return '<span class="redacted' + open + '" tabindex="0" data-k="' + k + '">' + inner + '</span>';
    });

  if (text.length <= BODY_LIMIT) return '<p class="body">' + markup(text) + '</p>';

  const open = state.expanded.has(mid);
  const id = 'rest-' + mid;
  return (
    '<p class="body">' +
      markup(text.slice(0, BODY_LIMIT)) + '…' +
      '<span id="' + id + '"' + (open ? '' : ' hidden') + '>' + markup(text.slice(BODY_LIMIT)) + '</span> ' +
      (open ? '' : '<button class="link" data-act="expand" data-target="' + id + '">展开全文</button>') +
    '</p>'
  );
}

function messageHtml(m) {
  const t = TYPES[m.type] || TYPES.world;
  const actions = [];

  if (state.admin) {
    actions.push('<button data-act="edit">改写</button>');
    actions.push('<button data-act="reply">引用</button>');
    actions.push('<button data-act="del">清除</button>');
  }

  return (
    '<article class="msg" data-id="' + esc(m.id) + '" data-type="' + esc(m.type) + '">' +
      '<div class="seal" aria-hidden="true">' + esc(t.label.slice(0, 1)) + '</div>' +
      '<div class="msg-main">' +
        '<div class="meta">' +
          '<span class="code">' + esc(m.code || 'DOC-???') + '</span>' +
          '<span class="badge ' + t.cls + '">' + t.label + '</span>' +
        '</div>' +
        '<h3 class="title">' + esc(m.title) + '</h3>' +
        bodyHtml(m.body, m.id) +
        quoteHtml(m) +
        (actions.length ? '<div class="actions">' + actions.join('') + '</div>' : '') +
      '</div>' +
    '</article>'
  );
}

function render() {
  const list = visibleMessages();
  const parts = [];

  for (const m of list) {
    parts.push(messageHtml(m));
  }

  feed.innerHTML = parts.join('');

  const filtering = state.filter !== 'all' || state.q.trim() !== '';
  emptyEl.hidden = list.length > 0;
  emptyEl.textContent = filtering
    ? 'NO MATCHING RECORDS.'
    : 'ARCHIVE EMPTY.';

  const all = [...state.messages.values()];
  $('#stats').textContent =
    'ARCHIVE_INDEX: 共 ' + all.length + ' 份机密文件 // ENCRYPTION: AES-74';
}

function updateJump() {
  if (state.unread <= 0) {
    jumpBtn.hidden = true;
    return;
  }
  jumpBtn.hidden = false;
  jumpBtn.textContent = '有 ' + state.unread + ' 条新消息 ' + (state.order === 'desc' ? '↑' : '↓');
}

/* ---------------- 实时同步 ---------------- */

function upsert(msg, isNew) {
  const prev = state.messages.get(msg.id);
  if (prev && prev.updatedAt === msg.updatedAt) return;

  const beforeHeight = document.documentElement.scrollHeight;
  const beforeTop = window.scrollY;

  state.messages.set(msg.id, msg);
  if (isNew && beforeTop > 40) state.unread += 1;

  render();

  const delta = document.documentElement.scrollHeight - beforeHeight;
  if (delta > 0) {
    window.scrollTo(0, beforeTop <= 40 ? 0 : beforeTop + delta);
  }
  updateJump();
}

function removeMessage(id) {
  state.messages.delete(id);
  if (state.replyTo === id) setReply(null);
  if (state.editing === id) stopEdit();
  render();
}

async function sync() {
  if (staticMode) {
    const next = new Map();
    for (const m of ARCHIVE_DATA) next.set(m.id, m);
    state.messages = next;
    setConn(true);
    render();
    return;
  }
  try {
    const data = await api('GET', '/api/messages');
    const next = new Map();
    for (const m of data.messages) next.set(m.id, m);

    // 数据没变就不重建 DOM：否则展开全文、涂黑展开的状态每隔几秒就被冲掉
    let changed = next.size !== state.messages.size;
    if (!changed) {
      for (const [id, m] of next) {
        const prev = state.messages.get(id);
        if (!prev || prev.updatedAt !== m.updatedAt) {
          changed = true;
          break;
        }
      }
    }
    if (!changed) {
      setConn(true);
      return;
    }

    state.messages = next;
    if (state.replyTo && !next.has(state.replyTo)) setReply(null);
    render();
  } catch {
    /* 离线或未登录时静默，等待重连 */
  }
}

function connect() {
  if (staticMode) return; // 静态镜像没有实时流
  if (state.realtime) {
    if (stream) stream.close();
    stream = new EventSource('/api/events');

    stream.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      upsert(msg, !state.messages.has(msg.id));
    });
    stream.addEventListener('update', (event) => upsert(JSON.parse(event.data), false));
    stream.addEventListener('delete', (event) => removeMessage(JSON.parse(event.data).id));

    stream.onopen = () => {
      setConn(true);
      sync();
    };
    stream.onerror = () => {
      if (state.entered) setConn(false);
    };
    return;
  }
  // 没有 SSE 的后端（例如 Cloudflare Worker）就走轮询
  if (pollTimer) clearInterval(pollTimer);
  sync();
  setConn(true);
  pollTimer = setInterval(sync, 5000);
}

/* ---------------- 交互 ---------------- */

function autoGrow() {
  bodyInput.style.height = 'auto';
  bodyInput.style.height = Math.min(bodyInput.scrollHeight, 320) + 'px';
  const len = bodyInput.value.length;
  const hint = $('#charHint');
  hint.textContent = len + ' / 5000';
  hint.style.color = len > 4500 ? 'var(--bad)' : '';
}

function setReply(id) {
  state.replyTo = id;
  const bar = $('#replyBar');
  const msg = id ? state.messages.get(id) : null;
  if (!msg) {
    bar.hidden = true;
    return;
  }
  $('#replyName').textContent = msg.author;
  $('#replySnippet').textContent = (msg.title || msg.body).replace(/\s+/g, ' ').slice(0, 40);
  bar.hidden = false;
  bodyInput.focus();
}

function startEdit(id) {
  const m = state.messages.get(id);
  if (!m || !state.admin) return;
  setReply(null);
  state.editing = id;
  setType(m.type);
  $('#titleInput').value = m.title;
  bodyInput.value = m.body;
  autoGrow();
  $('#editCodeInput').value = m.code;
  $('#editBar').hidden = false;
  sendBtn.textContent = '保存改写';
  $('#composer').hidden = false;
  window.scrollTo({ top: 0, behavior: 'smooth' });
  $('#titleInput').focus();
}

function stopEdit() {
  if (!state.editing) return;
  state.editing = null;
  $('#editBar').hidden = true;
  sendBtn.textContent = '归档';
  $('#titleInput').value = '';
  bodyInput.value = '';
  autoGrow();
}

function setType(type) {
  state.type = type;
  document.querySelectorAll('.tab').forEach((tab) => {
    const on = tab.dataset.type === type;
    tab.classList.toggle('is-on', on);
    tab.setAttribute('aria-selected', String(on));
  });
}

async function send() {
  if (staticMode) {
    toast('只读镜像，无法写入');
    return;
  }
  const body = bodyInput.value.trim();
  if (!body) {
    bodyInput.focus();
    return;
  }
  const title = $('#titleInput').value.trim();
  if (!title) {
    toast('档案需要有标题');
    $('#titleInput').focus();
    return;
  }

  sendBtn.disabled = true;
  try {
    if (state.editing) {
      const code = $('#editCodeInput').value.trim();
      const updated = await api('PATCH', '/api/messages/' + encodeURIComponent(state.editing), {
        type: state.type, title, body, code,
      });
      upsert(updated, false);
      stopEdit();
      toast('REWRITTEN: ' + updated.code);
      return;
    }

    const payload = { type: state.type, title, body, replyTo: state.replyTo };
    const msg = await api('POST', '/api/messages', payload);
    upsert(msg, true);
    bodyInput.value = '';
    $('#titleInput').value = '';
    setReply(null);
    autoGrow();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    if (state.order === 'desc') {
      state.unread = 0;
      updateJump();
    }
    toast('ARCHIVED: ' + msg.code);
  } catch (err) {
    toast(err.message);
  } finally {
    sendBtn.disabled = false;
  }
}

feed.addEventListener('click', async (event) => {
  const red = event.target.closest('.redacted');
  if (red) {
    red.classList.toggle('is-open');
    const k = red.dataset.k;
    if (k) {
      if (red.classList.contains('is-open')) state.opened.add(k);
      else state.opened.delete(k);
    }
    return;
  }

  const btn = event.target.closest('[data-act]');
  if (!btn) return;

  const article = btn.closest('.msg');
  const id = article && article.dataset.id;
  const act = btn.dataset.act;

  if (act === 'expand') {
    const rest = document.getElementById(btn.dataset.target);
    if (rest) rest.hidden = false;
    btn.hidden = true;
    if (id) state.expanded.add(id);
    return;
  }

  if (act === 'reply') {
    setReply(id);
    return;
  }

  if (act === 'edit') {
    startEdit(id);
    return;
  }

  if (act === 'del') {
    if (!confirm('清除这份档案？此操作不可撤销。')) return;
    try {
      await api('DELETE', '/api/messages/' + encodeURIComponent(id));
      removeMessage(id);
    } catch (err) {
      toast(err.message);
    }
  }
});

feed.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  const red = event.target.closest('.redacted');
  if (!red) return;
  event.preventDefault();
  red.classList.toggle('is-open');
  const k = red.dataset.k;
  if (k) {
    if (red.classList.contains('is-open')) state.opened.add(k);
    else state.opened.delete(k);
  }
});

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => setType(tab.dataset.type));
});

document.querySelectorAll('.chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    state.filter = chip.dataset.filter;
    document.querySelectorAll('.chip').forEach((c) => c.classList.toggle('is-on', c === chip));
    render();
  });
});

let searchTimer = null;
$('#search').addEventListener('input', (event) => {
  clearTimeout(searchTimer);
  const value = event.target.value;
  searchTimer = setTimeout(() => {
    state.q = value;
    render();
  }, 140);
});

$('#orderBtn').addEventListener('click', () => {
  state.order = state.order === 'desc' ? 'asc' : 'desc';
  $('#orderBtn').textContent = state.order === 'desc' ? '排序: 档案编号 ↑' : '排序: 档案编号 ↓';
  state.unread = 0;
  updateJump();
  render();
  window.scrollTo({ top: state.order === 'desc' ? 0 : document.documentElement.scrollHeight });
});

$('#sendBtn').addEventListener('click', send);

bodyInput.addEventListener('input', autoGrow);
bodyInput.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
    event.preventDefault();
    send();
  }
  if (event.key === 'Escape') {
    if (state.replyTo) setReply(null);
    else if (state.editing) stopEdit();
  }
});

$('#replyCancel').addEventListener('click', () => setReply(null));
$('#editCancel').addEventListener('click', () => stopEdit());

jumpBtn.addEventListener('click', () => {
  state.unread = 0;
  updateJump();
  window.scrollTo({
    top: state.order === 'desc' ? 0 : document.documentElement.scrollHeight,
    behavior: 'smooth',
  });
});

window.addEventListener('scroll', () => {
  if (window.scrollY < 40 && state.unread > 0) {
    state.unread = 0;
    updateJump();
  }
}, { passive: true });

/* ---------------- 启动 ---------------- */

setType('world');
autoGrow();
setStatus('STANDBY');
$('#gateKey').focus();

// 先探一次后端：有 /api/me 就说明不是纯静态托管，以它为准
const meReady = api('GET', '/api/me')
  .then((me) => {
    if (me && typeof me.admin === 'boolean') {
      staticMode = false;
      if (typeof me.realtime === 'boolean') state.realtime = me.realtime;
      if (me.admin) {
        state.admin = true;
        applyAdminMode();
      }
    }
    return me;
  })
  .catch(() => null);

meReady.then(() => {
  if (staticMode) return;
  // 只要后端在，接入终端后就给出「管理员 / 访客」的选择
  state.wantAdmin = true;
});

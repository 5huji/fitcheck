/* ==========================================================================
   健身打卡 · 全部逻辑
   --------------------------------------------------------------------------
   代码结构（改功能时按这个顺序找）：
     1. 常量与工具函数
     2. 数据层        —— 读写手机本地的 localStorage
     3. 统计计算      —— 连续打卡天数等
     4. 音频          —— 到点响铃（Web Audio 合成，不需要音频文件）
     5. 屏幕常亮      —— Wake Lock，训练期间不让屏幕黑
     6. 通知          —— 尽力而为，iOS 网页版能力有限
     7. 计时器        —— 核心逻辑：记住"结束时刻"而不是每秒减一
     8. 界面渲染      —— 今日 / 计时 / 记录 / 设置
     9. 打卡弹窗
    10. 启动
   ========================================================================== */

'use strict';

/* ============================ 1. 常量与工具 ============================ */

const KEY_RECORDS = 'fitcheck.records.v1';
const KEY_SETTINGS = 'fitcheck.settings.v1';
const KEY_TIMER = 'fitcheck.timer.v1';

const PRESET_MINUTES = [10, 20, 30, 45, 60];
const MIN_MINUTES = 1;
const MAX_MINUTES = 300;

const FATIGUE = {
  tired: { name: '很累', icon: '☾', cls: 'f-tired' },
  normal: { name: '还可以', icon: '☀', cls: 'f-normal' },
  easy: { name: '轻松', icon: '⚡', cls: 'f-easy' },
};

/** 把 Date 转成本地日期字符串 2026-09-13（不能用 toISOString，那是 UTC 会差一天） */
function dateKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 日期字符串加减天数 */
function shiftDate(key, delta) {
  const [y, m, d] = key.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + delta);
  return dateKey(dt);
}

/** 2026-09-13 → 9月13日 */
function prettyDate(key) {
  const [, m, d] = key.split('-').map(Number);
  return `${m}月${d}日`;
}

/** 2026-09 → 2026年9月 */
function prettyMonth(key) {
  const [y, m] = key.split('-').map(Number);
  return `${y}年${m}月`;
}

/** 相对日期：今天 / 昨天 / 3天前 / 9月1日 */
function relativeDate(key) {
  const today = dateKey();
  if (key === today) return '今天';
  if (key === shiftDate(today, -1)) return '昨天';
  const diff = Math.round((new Date(today) - new Date(key)) / 86400000);
  if (diff > 1 && diff < 7) return `${diff}天前`;
  return prettyDate(key);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

const $ = (id) => document.getElementById(id);

function toast(msg, ms = 1800) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, ms);
}

/* ============================ 2. 数据层 ============================ */

let records = [];
let settings = { defaultMinutes: 20, notifyEnabled: true };

function loadAll() {
  try {
    const r = JSON.parse(localStorage.getItem(KEY_RECORDS) || '[]');
    records = Array.isArray(r) ? r : [];
  } catch { records = []; }

  try {
    settings = Object.assign(settings, JSON.parse(localStorage.getItem(KEY_SETTINGS) || '{}'));
  } catch { /* 用默认值 */ }
}

function saveRecords() {
  localStorage.setItem(KEY_RECORDS, JSON.stringify(records));
}

function saveSettings() {
  localStorage.setItem(KEY_SETTINGS, JSON.stringify(settings));
}

function findToday() {
  const k = dateKey();
  return records.find((r) => r.date === k) || null;
}

/**
 * 打卡。今天已有记录就更新（等于"修改今日打卡"），没有就新建。
 * @param {number} durationMinutes 本次计时时长，会累加到当天记录上
 */
function checkIn(fatigue, note, durationMinutes) {
  const existing = findToday();
  if (existing) {
    existing.fatigue = fatigue;
    existing.note = note;
    existing.completed = true;
    if (durationMinutes > 0) existing.duration = (existing.duration || 0) + durationMinutes;
  } else {
    records.push({
      id: 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      date: dateKey(),
      completed: true,
      fatigue,
      note,
      duration: durationMinutes || 0,
      createdAt: new Date().toISOString(),
    });
  }
  saveRecords();
  renderAll();
}

function updateRecord(id, fatigue, note) {
  const r = records.find((x) => x.id === id);
  if (!r) return;
  r.fatigue = fatigue;
  r.note = note;
  saveRecords();
  renderAll();
}

function deleteRecord(id) {
  records = records.filter((r) => r.id !== id);
  saveRecords();
  renderAll();
}

/* ============================ 3. 统计计算 ============================ */

function computeStats() {
  const dates = new Set(records.map((r) => r.date));
  const total = records.length;
  const sorted = records.map((r) => r.date).sort();
  const last = sorted.length ? sorted[sorted.length - 1] : null;
  const monthKey = dateKey().slice(0, 7);
  const monthCount = records.filter((r) => r.date.startsWith(monthKey)).length;

  // 连续打卡：今天有记录就从今天数；今天还没打卡就从昨天数（避免白天显示 0 误导人）
  let cursor = dateKey();
  let streak = 0;
  if (!dates.has(cursor)) {
    const yesterday = shiftDate(cursor, -1);
    if (!dates.has(yesterday)) {
      return { total, streak: 0, last, monthCount };
    }
    cursor = yesterday;
  }
  while (dates.has(cursor)) {
    streak += 1;
    cursor = shiftDate(cursor, -1);
  }
  return { total, streak, last, monthCount };
}

/* ============================ 4. 音频 ============================ */

let audioCtx = null;
let keepAlive = null;

function ensureAudio() {
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    audioCtx = new AC();
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

/**
 * 保持音频会话活跃。
 * iOS 只在"用户操作"之后才允许播放声音。开始计时那一下就是用户操作，
 * 此刻启动一个几乎无声的振荡器，之后到点才能马上响铃，不会因为会话休眠而哑掉。
 */
function startAudioKeepAlive() {
  const ctx = ensureAudio();
  if (!ctx || keepAlive) return;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  gain.gain.value = 0.0001;
  osc.frequency.value = 40;
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start();
  keepAlive = { osc, gain };
}

function stopAudioKeepAlive() {
  if (!keepAlive) return;
  try { keepAlive.osc.stop(); } catch (e) { /* 已经停了 */ }
  keepAlive = null;
}

/** 到点响铃：5 声由低到高的提示音，约 3 秒 */
function playAlarm() {
  const ctx = ensureAudio();
  if (!ctx) return;
  const t0 = ctx.currentTime;
  [0, 0.55, 1.1, 1.65, 2.35].forEach((offset, i) => {
    const t = t0 + offset;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(i % 2 === 0 ? 880 : 1174, t);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.9, t + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.48);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.55);
  });
  if (navigator.vibrate) navigator.vibrate([320, 120, 320, 120, 520]);
}

/* ============================ 5. 屏幕常亮 ============================ */

let wakeLock = null;

async function acquireWakeLock() {
  if (!('wakeLock' in navigator)) return false;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
    return true;
  } catch (e) {
    return false;
  }
}

function releaseWakeLock() {
  try { if (wakeLock) wakeLock.release(); } catch (e) { /* 忽略 */ }
  wakeLock = null;
}

/* ============================ 6. 通知 ============================ */

function isStandalone() {
  return window.navigator.standalone === true
    || window.matchMedia('(display-mode: standalone)').matches;
}

function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

/** 当前环境能不能发系统通知 */
function notificationSupport() {
  if (!('Notification' in window)) {
    if (isIOS() && !isStandalone()) {
      return { ok: false, text: '需先添加到主屏幕', hint: 'iOS 上必须先把本页"添加到主屏幕"，再从主屏幕图标打开，才可能发通知。' };
    }
    return { ok: false, text: '当前浏览器不支持', hint: '这个浏览器不提供网页通知能力，只能靠页面铃声提醒。' };
  }
  if (!window.isSecureContext) {
    return { ok: false, text: '需要 HTTPS', hint: '网页通知只能在 HTTPS 网站上使用。' };
  }
  if (Notification.permission === 'denied') {
    return { ok: false, text: '已拒绝', hint: '系统里已拒绝通知权限。iOS 需要删掉主屏幕图标重新添加才能再弹权限。' };
  }
  return { ok: true, text: Notification.permission === 'granted' ? '已允许' : '未授权', hint: '' };
}

async function requestNotifyPermission() {
  if (!('Notification' in window)) return false;
  try {
    const p = await Notification.requestPermission();
    return p === 'granted';
  } catch (e) {
    return false;
  }
}

/** 发送"训练结束"通知。iOS 上可能不生效，失败就静默跳过，不影响响铃。 */
async function notifyFinished() {
  if (!settings.notifyEnabled) return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const reg = await navigator.serviceWorker.ready;
    if (!reg || !reg.showNotification) return;
    await reg.showNotification('训练时间结束', {
      body: '训练时间结束，完成今天的训练吧！',
      icon: './icons/icon-192.png',
      tag: 'fitcheck-training',
      renotify: true,
    });
  } catch (e) {
    /* iOS 网页版通常走不到这里，忽略 */
  }
}

/* ============================ 7. 计时器 ============================ */

/**
 * 关键设计：不用"每秒减一"。
 * 每秒减一的话，切到后台或锁屏后网页的计时器就停了，回到前台时间会卡住。
 * 这里保存"结束时刻 endAt"，每次刷新都用它反推剩余秒数，永远准确。
 */
const timer = {
  phase: 'idle',      // idle | running | paused | finished
  totalSec: 20 * 60,
  remainSec: 20 * 60,
  endAt: 0,
  lastSessionMinutes: 0,
};

let tickHandle = null;

function timerStart() {
  if (timer.phase === 'running') return;

  if (timer.phase === 'idle' || timer.phase === 'finished') {
    timer.remainSec = timer.totalSec;
    timer.lastSessionMinutes = 0;
  }
  if (timer.remainSec <= 0) return;

  timer.endAt = Date.now() + timer.remainSec * 1000;
  timer.phase = 'running';

  ensureAudio();              // 必须在用户点击的这一刻创建，否则 iOS 不给放声音
  startAudioKeepAlive();
  startTick();
  persistTimer();
  acquireWakeLock();
  renderTimer();
}

function timerPause() {
  if (timer.phase !== 'running') return;
  syncFromClock();
  if (timer.phase !== 'running') return;   // 刚好处在结束那一瞬
  timer.phase = 'paused';
  stopTick();
  stopAudioKeepAlive();
  releaseWakeLock();
  persistTimer();
  renderTimer();
}

function timerStop() {
  if (timer.phase === 'running' || timer.phase === 'paused') {
    const trained = timer.totalSec - timer.remainSec;
    timer.lastSessionMinutes = trained >= 60 ? Math.floor(trained / 60) : 0;
  }
  timer.phase = 'idle';
  timer.remainSec = timer.totalSec;
  timer.endAt = 0;
  stopTick();
  stopAudioKeepAlive();
  releaseWakeLock();
  persistTimer();
  renderTimer();
}

function timerSetMinutes(min) {
  if (timer.phase === 'running' || timer.phase === 'paused') return;
  const v = Math.max(MIN_MINUTES, Math.min(MAX_MINUTES, Math.round(min)));
  timer.totalSec = v * 60;
  timer.remainSec = v * 60;
  timer.lastSessionMinutes = 0;
  timer.phase = 'idle';
  persistTimer();
  renderTimer();
}

function startTick() {
  stopTick();
  tickHandle = setInterval(syncFromClock, 250);
}

function stopTick() {
  if (tickHandle) clearInterval(tickHandle);
  tickHandle = null;
}

/** 用"结束时刻 − 现在"反推剩余秒数 */
function syncFromClock() {
  if (timer.phase !== 'running') return;
  const remainMs = timer.endAt - Date.now();
  if (remainMs <= 0) {
    finishTimer();
    return;
  }
  const next = Math.ceil(remainMs / 1000);
  if (next !== timer.remainSec) {
    timer.remainSec = next;
    renderTimer();
  }
}

function finishTimer() {
  stopTick();
  stopAudioKeepAlive();
  releaseWakeLock();
  timer.remainSec = 0;
  timer.lastSessionMinutes = Math.floor(timer.totalSec / 60);
  timer.phase = 'finished';
  timer.endAt = 0;
  persistTimer();
  playAlarm();
  notifyFinished();
  renderTimer();
}

function persistTimer() {
  try {
    localStorage.setItem(KEY_TIMER, JSON.stringify({
      endAt: timer.endAt,
      totalSec: timer.totalSec,
      phase: timer.phase,
      remainSec: timer.remainSec,
      lastSessionMinutes: timer.lastSessionMinutes,
    }));
  } catch (e) { /* 忽略 */ }
}

/** 恢复上次的计时（App 被系统回收后重新打开时用） */
function restoreTimer() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(KEY_TIMER) || 'null'); } catch (e) { /* 忽略 */ }
  if (!saved) return;

  timer.totalSec = saved.totalSec || timer.totalSec;
  timer.remainSec = saved.remainSec != null ? saved.remainSec : timer.totalSec;
  timer.lastSessionMinutes = saved.lastSessionMinutes || 0;

  if (saved.phase === 'running' && saved.endAt > Date.now()) {
    timer.phase = 'running';
    timer.endAt = saved.endAt;
    timer.remainSec = Math.ceil((saved.endAt - Date.now()) / 1000);
    startTick();
    // 注意：这里不启动音频保活——恢复了计时但用户没有操作过页面，iOS 仍然不让放声音
  } else if (saved.phase === 'paused') {
    timer.phase = 'paused';
  }
}

/* ============================ 8. 界面渲染 ============================ */

let activeTab = 'today';

function switchTab(name) {
  activeTab = name;
  document.querySelectorAll('.page').forEach((p) => {
    p.classList.toggle('is-active', p.id === 'page-' + name);
  });
  document.querySelectorAll('.tab').forEach((t) => {
    t.classList.toggle('is-active', t.dataset.tab === name);
  });
  if (name === 'history') renderHistory();
  if (name === 'settings') renderSettings();
  if (name === 'today') renderToday();
}

function renderAll() {
  renderToday();
  renderTimer();
  if (activeTab === 'history') renderHistory();
  if (activeTab === 'settings') renderSettings();
}

/* ---------- 今日 ---------- */

function renderToday() {
  const today = findToday();
  const s = computeStats();

  const [yy, mm, dd] = dateKey().split('-').map(Number);
  $('todayDate').textContent = `${yy}年${mm}月${dd}日`;

  if (today) {
    $('todayIcon').textContent = '✓';
    $('todayIcon').classList.remove('pending');
    $('todayTitle').textContent = '今日已完成';
  } else {
    $('todayIcon').textContent = '○';
    $('todayIcon').classList.add('pending');
    $('todayTitle').textContent = '今日未完成';
  }

  const detail = $('todayDetail');
  if (today) {
    const f = FATIGUE[today.fatigue] || FATIGUE.normal;
    detail.hidden = false;
    detail.innerHTML =
      `<span class="chip">${f.name}</span>` +
      (today.duration > 0 ? `<span>训练 ${today.duration} 分钟</span>` : '') +
      (today.note ? `<div style="flex-basis:100%">${escapeHtml(today.note)}</div>` : '');
  } else {
    detail.hidden = true;
    detail.innerHTML = '';
  }

  $('statStreak').textContent = s.streak;
  $('statTotal').textContent = s.total;
  $('statLast').textContent = s.last ? relativeDate(s.last) : '—';

  $('btnCheckin').hidden = !!today;
  $('todayExtra').hidden = !today;
}

/* ---------- 计时 ---------- */

const RING_CIRCUMFERENCE = 2 * Math.PI * 104;

function renderTimer() {
  const t = timer.remainSec;
  $('timerText').textContent =
    `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;

  const phaseText = { idle: '准备开始', running: '计时中', paused: '已暂停', finished: '已完成' }[timer.phase];
  $('timerPhase').textContent = phaseText;

  const ratio = timer.totalSec > 0 ? 1 - timer.remainSec / timer.totalSec : 0;
  const ring = $('ringFg');
  ring.setAttribute('stroke-dasharray', String(RING_CIRCUMFERENCE));
  ring.setAttribute('stroke-dashoffset', String(RING_CIRCUMFERENCE * (1 - Math.max(0, Math.min(1, ratio)))));
  ring.classList.toggle('paused', timer.phase === 'paused');
  ring.classList.toggle('idle', timer.phase === 'idle');

  $('finishedBanner').hidden = timer.phase !== 'finished';
  $('durationPanel').hidden = timer.phase !== 'idle';
  $('wakeLockHint').hidden = timer.phase !== 'running';

  $('btnTimerMain').textContent =
    timer.phase === 'running' ? '暂停' : (timer.phase === 'paused' ? '继续' : '开始');
  $('btnTimerStop').disabled = timer.phase === 'idle';
  $('btnTimerStop').textContent = timer.phase === 'finished' ? '重置' : '结束';

  // 预设按钮高亮
  const curMin = Math.round(timer.totalSec / 60);
  document.querySelectorAll('.preset').forEach((b) => {
    b.classList.toggle('is-on', Number(b.dataset.min) === curMin);
  });
  $('customMinutes').textContent = `${curMin} 分钟`;
}

function buildPresets() {
  const grid = $('presetGrid');
  grid.innerHTML = PRESET_MINUTES
    .map((m) => `<button class="preset" data-min="${m}">${m} 分钟</button>`)
    .join('');
  grid.addEventListener('click', (e) => {
    const btn = e.target.closest('.preset');
    if (!btn) return;
    timerSetMinutes(Number(btn.dataset.min));
  });
}

/* ---------- 历史 ---------- */

function renderHistory() {
  const s = computeStats();
  $('hStatTotal').textContent = s.total;
  $('hStatStreak').textContent = s.streak;
  $('hStatMonth').textContent = s.monthCount;

  const list = $('historyList');
  $('historyEmpty').hidden = records.length > 0;

  if (!records.length) { list.innerHTML = ''; return; }

  const groups = new Map();
  [...records]
    .sort((a, b) => b.date.localeCompare(a.date))
    .forEach((r) => {
      const k = r.date.slice(0, 7);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    });

  let html = '';
  groups.forEach((items, monthKey) => {
    html += `<div class="month-title">${prettyMonth(monthKey)}</div><div class="rec-list">`;
    items.forEach((r) => {
      const f = FATIGUE[r.fatigue] || FATIGUE.normal;
      const [y, m, d] = r.date.split('-').map(Number);
      html += `
        <div class="rec" data-id="${r.id}">
          <div class="rec-date">
            <div class="rec-day">${d}</div>
            <div class="rec-mon">${m}月</div>
          </div>
          <div class="rec-main">
            <div class="rec-line1">
              <span>${relativeDate(r.date)}</span>
              <span class="rec-fatigue ${f.cls}">${f.name}</span>
              ${r.duration > 0 ? `<span class="muted" style="font-size:13px">${r.duration}分钟</span>` : ''}
            </div>
            ${r.note ? `<div class="rec-note">${escapeHtml(r.note)}</div>` : ''}
          </div>
          <div class="rec-dot"></div>
        </div>`;
    });
    html += '</div>';
  });
  list.innerHTML = html;
}

/* ---------- 设置 ---------- */

function renderSettings() {
  const sel = $('selectDefault');
  if (!sel.options.length) {
    sel.innerHTML = PRESET_MINUTES.map((m) => `<option value="${m}">${m} 分钟</option>`).join('');
  }
  sel.value = String(settings.defaultMinutes);

  $('toggleNotify').checked = !!settings.notifyEnabled;

  const sup = notificationSupport();
  $('notifySupport').textContent = sup.text;
  $('notifyFoot').textContent = sup.hint
    || '到点会播放页面铃声。网页版在 iOS 上无法做到"锁屏后自动响"，训练请让本页保持在前台。';

  $('dataCount').textContent = records.length;
  $('appVersion').textContent = '1.0';

  const mode = isStandalone() ? '已添加到主屏幕' : (isIOS() ? 'Safari 标签页' : '浏览器标签页');
  $('runMode').textContent = mode + (isIOS() && !isStandalone() ? '（建议添加到主屏幕）' : '');
}

/* ============================ 9. 打卡弹窗 ============================ */

let sheetState = { mode: 'create', recordId: null, fatigue: 'normal' };

function openSheet(mode, record) {
  sheetState.mode = mode;
  sheetState.recordId = record ? record.id : null;
  sheetState.fatigue = record ? record.fatigue : 'normal';

  $('sheetTitle').textContent = mode === 'create' ? '完成打卡' : '修改记录';
  $('noteInput').value = record ? (record.note || '') : '';

  // 只有从计时页面过来、且是新建打卡时，才把训练时长带进去
  const useDuration = mode === 'create' && timer.lastSessionMinutes > 0;
  const hint = $('sheetDurationHint');
  hint.hidden = !useDuration;
  if (useDuration) hint.textContent = `本次训练 ${timer.lastSessionMinutes} 分钟，将一并记录`;

  renderFatigueRow();
  $('sheetMask').hidden = false;
}

function closeSheet() {
  $('sheetMask').hidden = true;
}

function renderFatigueRow() {
  const row = $('fatigueRow');
  row.innerHTML = Object.entries(FATIGUE).map(([key, f]) => `
    <button class="fatigue ${sheetState.fatigue === key ? 'is-on' : ''}" data-level="${key}">
      <span class="fico">${f.icon}</span>
      <span class="fname">${f.name}</span>
    </button>`).join('');
}

function saveSheet() {
  const fatigue = sheetState.fatigue;
  const note = $('noteInput').value.trim();

  if (sheetState.mode === 'create') {
    const useDuration = timer.lastSessionMinutes;
    checkIn(fatigue, note, useDuration);
    if (useDuration > 0) timer.lastSessionMinutes = 0;
    toast('已记录今日训练');
  } else {
    updateRecord(sheetState.recordId, fatigue, note);
    toast('已更新');
  }
  closeSheet();
}

/* ============================ 10. 启动 ============================ */

function bindEvents() {
  // 标签栏
  $('tabbar').addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (tab) switchTab(tab.dataset.tab);
  });

  // 今日
  $('btnStart').addEventListener('click', () => switchTab('timer'));
  $('btnCheckin').addEventListener('click', () => openSheet('create', null));
  $('btnEditToday').addEventListener('click', () => {
    const today = findToday();
    if (today) openSheet('edit', today);
  });
  $('btnUndoToday').addEventListener('click', () => {
    const today = findToday();
    if (!today) return;
    if (confirm('撤销今日打卡？这条记录会被删除。')) {
      deleteRecord(today.id);
      toast('已撤销今日打卡');
    }
  });

  // 计时
  $('btnTimerMain').addEventListener('click', () => {
    if (timer.phase === 'running') timerPause();
    else timerStart();
  });
  $('btnTimerStop').addEventListener('click', () => timerStop());
  $('btnGoCheckin').addEventListener('click', () => {
    switchTab('today');
    openSheet('create', null);
  });

  $('stepMinus').addEventListener('click', () => timerSetMinutes(Math.round(timer.totalSec / 60) - 5));
  $('stepPlus').addEventListener('click', () => timerSetMinutes(Math.round(timer.totalSec / 60) + 5));

  // 记录：点条目编辑，长按删除
  $('historyList').addEventListener('click', (e) => {
    const row = e.target.closest('.rec');
    if (!row) return;
    const r = records.find((x) => x.id === row.dataset.id);
    if (r) openSheet('edit', r);
  });
  $('historyList').addEventListener('contextmenu', (e) => {
    const row = e.target.closest('.rec');
    if (!row) return;
    e.preventDefault();
    if (confirm('删除这条训练记录？')) deleteRecord(row.dataset.id);
  });

  // 设置
  $('selectDefault').addEventListener('change', (e) => {
    settings.defaultMinutes = Number(e.target.value);
    saveSettings();
    if (timer.phase === 'idle') timerSetMinutes(settings.defaultMinutes);
  });

  $('toggleNotify').addEventListener('change', async (e) => {
    const on = e.target.checked;
    settings.notifyEnabled = on;
    saveSettings();
    if (on) {
      const ok = await requestNotifyPermission();
      if (!ok) {
        const sup = notificationSupport();
        toast(sup.ok === false && sup.text !== '未授权' ? sup.text : '未获得通知权限，将只用页面铃声');
      }
    }
    renderSettings();
  });

  $('btnClearAll').addEventListener('click', () => {
    if (!records.length) { toast('没有记录可清空'); return; }
    if (confirm(`确定清空全部 ${records.length} 条训练记录？此操作无法撤销。`)) {
      records = [];
      saveRecords();
      renderAll();
      toast('已清空');
    }
  });

  $('btnExport').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(records, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `fitcheck-backup-${dateKey()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  });

  // 弹窗
  $('sheetCancel').addEventListener('click', closeSheet);
  $('sheetMask').addEventListener('click', (e) => {
    if (e.target === $('sheetMask')) closeSheet();
  });
  $('sheetSave').addEventListener('click', saveSheet);
  $('fatigueRow').addEventListener('click', (e) => {
    const b = e.target.closest('.fatigue');
    if (!b) return;
    sheetState.fatigue = b.dataset.level;
    renderFatigueRow();
  });

  // 回到前台：立刻校正时间，并把屏幕常亮重新申请上
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (timer.phase === 'running') {
      syncFromClock();
      acquireWakeLock();
      startAudioKeepAlive();
    }
  });

  // 页面隐藏前保存一次状态
  window.addEventListener('pagehide', persistTimer);
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (!window.isSecureContext) return;
  navigator.serviceWorker.register('./sw.js').catch(() => { /* 离线缓存失败不影响使用 */ });
}

function init() {
  loadAll();

  // 先尝试恢复上次未完成的计时；没有历史计时才用设置里的默认时长
  const hadSavedTimer = !!localStorage.getItem(KEY_TIMER);
  restoreTimer();
  if (!hadSavedTimer) {
    timer.totalSec = settings.defaultMinutes * 60;
    timer.remainSec = timer.totalSec;
  }

  buildPresets();
  bindEvents();
  renderAll();
  renderSettings();
  switchTab('today');
  registerServiceWorker();

  // 如果恢复了"计时中"但用户在页面上做任何操作，立刻把音频会话激活，
  // 这样到点还能响铃（iOS 只允许在用户操作之后播放声音）。
  document.addEventListener('pointerdown', () => {
    if (timer.phase === 'running') {
      ensureAudio();
      startAudioKeepAlive();
    }
  });
}

document.addEventListener('DOMContentLoaded', init);

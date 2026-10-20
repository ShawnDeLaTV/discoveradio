const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const audio = $('#audio'), root = document.documentElement;
const socket = io({ auth: { listener: true } });
const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
let me = { user: null }, state = null, offset = 0, listening = false, ctx, analyser, freq;
let ready = Promise.resolve(), autoTried = false, listenersN = 0, queue = [], userPaused = false;

/* ---------- Utilitaires ---------- */
const fmt = s => { s = Math.max(0, Math.floor(s || 0)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const initial = n => (String(n || '?').trim()[0] || '?').toUpperCase();
const s = n => (n > 1 ? 's' : '');
function toast(msg, ms = 6000, action) {
  const el = document.createElement('div');
  el.className = 'toast'; el.textContent = msg;
  if (action) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'toast-act'; b.textContent = action.label;
    b.onclick = () => { action.fn(); el.remove(); };
    el.classList.add('has-act'); el.append(b);
  }
  $('#toasts').append(el); setTimeout(() => el.remove(), ms);
}
async function shareOut(text) {
  try {
    if (navigator.share) await navigator.share({ title: 'Discoveradio', text, url: location.origin });
    else { await navigator.clipboard.writeText(`${text} ${location.origin}`); toast('Lien copié, colle-le où tu veux.'); }
  } catch {}
}
const PLATFORMS = {
  'spotify.com': 'Spotify', 'music.apple.com': 'Apple Music', 'deezer.com': 'Deezer', 'music.youtube.com': 'YouTube Music',
  'youtube.com': 'YouTube', 'youtu.be': 'YouTube', 'soundcloud.com': 'SoundCloud', 'bandcamp.com': 'Bandcamp', 'tidal.com': 'TIDAL',
};
function platformName(url) {
  try {
    const h = new URL(url).hostname.replace(/^www\./, '');
    for (const [d, n] of Object.entries(PLATFORMS)) if (h === d || h.endsWith('.' + d)) return n;
    return h;
  } catch { return ''; }
}

/* ---------- Thème ---------- */
$('#themeBtn').onclick = () => {
  const next = root.dataset.theme === 'light' ? 'dark' : 'light';
  root.dataset.theme = next;
  try { localStorage.setItem('theme', next); } catch {}
  readColors();
};

/* ---------- Panneaux masquables (programme à gauche, chat à droite) ---------- */
const panels = (() => { try { return JSON.parse(localStorage.getItem('panels')) || { side: true, chat: true }; } catch { return { side: true, chat: true }; } })();   // masqués par défaut ; ensuite on retient le choix de chacun
function applyPanels() {
  const st = $('.stage');
  st.classList.toggle('hide-side', !!panels.side);
  st.classList.toggle('hide-chat', !!panels.chat);
  try { localStorage.setItem('panels', JSON.stringify(panels)); } catch {}
}
for (const [k, hide, open] of [['side', '#hideSide', '#openSide'], ['chat', '#hideChat', '#openChat']]) {
  for (const id of [hide, open]) { const b = $(id); if (b) b.onclick = () => { panels[k] = !panels[k]; applyPanels(); }; }
}
applyPanels();

/* ---------- Dialogues ---------- */
document.addEventListener('click', e => {
  const c = e.target.closest('[data-close]');
  if (c) return c.closest('dialog').close();
  if (e.target.closest('[data-open="share"]')) openShare();
  if (e.target.tagName === 'DIALOG') e.target.close();          // clic sur le fond
});
const needLogin = fn => (...a) => me.user ? fn(...a) : $('#loginDlg').showModal();

/* ---------- Horloge : décalage serveur/client (échantillon au RTT le plus faible) ---------- */
async function syncClock() {
  let best;
  for (let i = 0; i < 6; i++) {
    const t0 = Date.now(), ts = await socket.emitWithAck('time'), t1 = Date.now(), rtt = t1 - t0;
    if (!best || rtt < best.rtt) best = { rtt, off: ts + rtt / 2 - t1 };
  }
  offset = best.off;
}
const pos = () => (Date.now() + offset - state.startedAt) / 1000;

/* ---------- Audio : Web Audio + démarrage automatique ou au premier geste ---------- */
function syncPlayUI() {
  const playing = listening && !audio.paused;
  $('#play-icon').toggleAttribute('hidden', playing);
  $('#pause-icon').toggleAttribute('hidden', !playing);
  $('#listen').setAttribute('aria-label', playing ? 'Mettre en pause' : 'Écouter');
  document.body.classList.toggle('is-playing', playing);
  document.body.classList.toggle('is-paused', userPaused);
  $('#statusLabel').textContent = userPaused ? "En pause, l'antenne continue" : 'En direct';
}
audio.addEventListener('play', syncPlayUI);
audio.addEventListener('pause', syncPlayUI);
function setupAudio() {
  if (ctx) return;
  ctx = new AudioContext();
  const src = ctx.createMediaElementSource(audio);
  analyser = ctx.createAnalyser(); analyser.fftSize = 1024; analyser.smoothingTimeConstant = .5;
  src.connect(analyser); analyser.connect(ctx.destination);
  freq = new Uint8Array(analyser.frequencyBinCount);
}
async function startListening() {
  if (listening) return;
  userPaused = false;
  setupAudio();
  await ctx.resume();
  if (ctx.state !== 'running') return armGesture();
  listening = true;
  if (state) { seek(); audio.play().catch(() => { listening = false; syncPlayUI(); armGesture(); }); }
  syncPlayUI();
}
function stopListening() { listening = false; userPaused = true; audio.pause(); syncPlayUI(); }
const GESTURES = ['pointerdown', 'keydown', 'touchstart'];
function onGesture(e) {
  if (e.target.closest?.('#listen')) return;
  GESTURES.forEach(ev => removeEventListener(ev, onGesture));
  startListening();
}
function armGesture() { GESTURES.forEach(ev => addEventListener(ev, onGesture)); }
async function tryAutoplay() {
  if (autoTried) return;
  autoTried = true;
  await startListening();
  if (!listening) armGesture();
}
let revealT;
$('#listen').onclick = e => {
  const playing = listening && !audio.paused, b = e.currentTarget;
  // écran tactile (pas de survol) : un premier toucher fait réapparaître le bouton, le suivant met en pause
  if (playing && matchMedia('(hover: none)').matches && !b.classList.contains('show')) {
    b.classList.add('show'); clearTimeout(revealT); revealT = setTimeout(() => b.classList.remove('show'), 2800); return;
  }
  b.classList.remove('show'); clearTimeout(revealT);
  playing ? stopListening() : startListening();
};
$('#vol').oninput = e => { audio.volume = e.target.value; };
audio.volume = .8;
try {   // commandes écran verrouillé / casque
  navigator.mediaSession.setActionHandler('play', startListening);
  navigator.mediaSession.setActionHandler('pause', stopListening);
} catch {}

function seek() {
  if (!state) return;
  const p = Math.max(0, pos());
  audio.currentTime = isFinite(audio.duration) ? Math.min(p, audio.duration - .05) : p;
}
async function applyState(st) {
  const changed = st.track && state?.track.id !== st.track.id;
  state = st.track ? st : null;
  renderTrack(st);
  if (!state) { audio.pause(); audio.removeAttribute('src'); audio.dataset.id = ''; syncPlayUI(); return; }
  if (audio.dataset.id != state.track.id) {
    audio.dataset.id = state.track.id;
    audio.src = state.track.url;
    audio.onloadedmetadata = () => { seek(); if (listening) audio.play().catch(() => {}); else tryAutoplay(); };
    audio.load();
  } else seek();
  if (changed) { refreshVote(); refreshActiveTab(); }
}
let retried = 0;
audio.addEventListener('error', () => {      // fichier retiré ou coupure réseau : une nouvelle tentative
  if (!state || retried++ > 2) return;
  setTimeout(() => { audio.load(); }, 2500);
});
audio.addEventListener('loadstart', () => { retried = 0; });

socket.on('connect', () => { ready = syncClock().catch(() => {}); });
socket.on('state', async st => { await ready; await meReady; applyState(st); });
socket.on('votes', ({ trackId, count }) => { if (state?.track.id === trackId) $('#count').textContent = count; });
socket.on('next', renderQueue);
/* Le serveur envoie directement le nombre à afficher (auditeurs réels + fond simulé) */
socket.on('listeners', n => {
  listenersN = n;
  $('#listeners').textContent = `${n} auditeur${n > 1 ? 's' : ''}`;
  $('#pitchBtn').textContent = `Fais écouter ton son à ${n} auditeur${n > 1 ? 's' : ''}`;
});
socket.on('react', float);
socket.on('on-air', ({ title, listeners: n }) => toast(`« ${title} » passe à l'antenne maintenant, ${n} personnes écoutent avec toi.`, 14000,
  { label: 'Partager', fn: () => shareOut(`Mon morceau « ${title} » passe en direct maintenant sur Discoveradio, ${n} personnes l'écoutent.`) }));
socket.on('my-track', ({ title, status }) => {
  toast(status === 'approved' ? `« ${title} » est validé. Il passera bientôt à l'antenne.` : `« ${title} » n'a pas été retenu.`, 8000);
  if ($('#mineDlg').open) loadMine();
});

// Correction de dérive, barre de progression, pré-chargement du morceau suivant
setInterval(() => { if (state && listening && !audio.paused && Math.abs(audio.currentTime - pos()) > .4) seek(); }, 3000);
const pre = new Audio(); pre.preload = 'auto'; let preId = null;
setInterval(() => {
  if (!state) { $('#elapsed').textContent = $('#total').textContent = '0:00'; return; }
  const d = state.track.duration, p = Math.min(Math.max(pos(), 0), d);
  $('#elapsed').textContent = fmt(p); $('#total').textContent = fmt(d);
  const nx = queue[0];
  if (nx && d - p < 45 && preId !== nx.id) { preId = nx.id; pre.src = nx.url; }
}, 500);

/* ---------- Affichage du morceau ---------- */
function renderTrack(st) {
  const t = st.track;
  $('#title').textContent = t ? t.title : 'L\'antenne est vide';
  $('#artist').textContent = t ? t.artist : 'Propose le premier morceau et lance la radio.';
  const by = $('#by');
  by.hidden = !t?.by;
  if (t?.by) by.innerHTML = `<span class="avatar sm" aria-hidden="true">${esc(initial(t.by))}</span><span>Découvert par <strong>${esc(t.by)}</strong></span>`;
  const a = $('#platform');
  if (t?.link) {
    a.href = t.link; a.hidden = false;
    a.textContent = t.linkIsSearch ? `Chercher l'artiste sur Spotify` : `Écouter sur ${platformName(t.link)}`;
  } else { a.hidden = true; a.removeAttribute('href'); }
  $('#count').textContent = t ? t.upvotes : 0;
  $('#upvote').disabled = !t;
  $('#shareRadio').disabled = !t;
  $('#emptyCta').hidden = !!t;
  document.title = t ? `${t.title}, ${t.artist} · Discoveradio` : 'Discoveradio';
  renderQueue(st.next || []);
  try {
    navigator.mediaSession.metadata = t ? new MediaMetadata({ title: t.title, artist: t.artist, album: 'Discoveradio' }) : null;
  } catch {}
}
function renderQueue(arr) {
  queue = arr;
  const n = $('#queueN'); n.hidden = !arr.length; n.textContent = arr.length;
  const total = arr.reduce((a, t) => a + t.duration, 0);
  $('#queueMeta').textContent = arr.length
    ? `${arr.length} morceau${arr.length > 1 ? 'x' : ''} en attente, environ ${Math.max(1, Math.round(total / 60))} min de musique. Les plus aimés reviennent plus vite.` : '';
  $('#queueList').innerHTML = arr.length ? arr.map((t, i) => `
    <li class="track">
      <span class="rank">${i + 1}</span>
      <div class="meta"><strong>${esc(t.title)}</strong><span>${esc(t.artist)}${t.by ? `, proposé par ${esc(t.by)}` : ''}</span></div>
      ${t.fresh ? '<span class="chip">Nouveau</span>' : '<span></span>'}
      <span class="dur">${fmt(t.duration)}</span>
    </li>`).join('')
    : `<li class="empty">La file est vide. <button class="linklike" type="button" data-open="share">Propose le prochain morceau</button></li>`;
  if (arr.length) $('#queueList').insertAdjacentHTML('beforeend', '<li class="empty queue-cta"><button class="linklike" type="button" data-open="share">Ajoute ton morceau à la suite</button></li>');
}

/* ---------- Onglets ---------- */
function selectTab(id) {
  $$('[role="tab"]').forEach(t => {
    const on = t.id === id;
    t.setAttribute('aria-selected', on);
    $('#' + t.getAttribute('aria-controls')).hidden = !on;
  });
  refreshActiveTab();
}
const activeTab = () => $('[role="tab"][aria-selected="true"]')?.id;
function refreshActiveTab() {
  const id = activeTab();
  if (id === 't-history') loadHistory();
  if (id === 't-top') loadCharts();
}
$$('[role="tab"]').forEach(t => {
  t.onclick = () => {
    const same = activeTab() === t.id, sheet = !matchMedia('(min-width: 1240px)').matches;
    selectTab(t.id);
    if (sheet) document.body.classList.toggle('sheet-open', !(same && document.body.classList.contains('sheet-open')));
  };
});
document.addEventListener('pointerdown', e => { if (document.body.classList.contains('sheet-open') && !e.target.closest('.side, dialog')) document.body.classList.remove('sheet-open'); });
const trackRow = t => `
  <li class="track plain">
    <div class="meta"><strong>${esc(t.title)}</strong><span>${esc(t.artist)}${t.by ? `, proposé par ${esc(t.by)}` : ''}</span></div>
    ${t.link && !t.linkIsSearch ? `<a class="ext" href="${esc(t.link)}" target="_blank" rel="noopener">${esc(platformName(t.link))}</a>` : '<span></span>'}
    <span class="dur">${t.likes ? `${t.likes} ♥` : fmt(t.duration)}</span>
  </li>`;
async function loadHistory() {
  const rows = await (await fetch('/api/history')).json().catch(() => []);
  $('#historyList').innerHTML = rows.length ? rows.map(trackRow).join('') : '<li class="empty">Rien n\'est encore passé avant ce morceau.</li>';
}
async function loadCharts() {
  const c = await (await fetch('/api/charts')).json().catch(() => ({ tracks: [], users: [] }));
  $('#topTracks').innerHTML = c.tracks.length ? c.tracks.map(trackRow).join('') : '<li class="empty">Aucun like pour l\'instant. Le premier morceau que tu aimes ouvre le classement.</li>';
  $('#topUsers').innerHTML = c.users.length ? c.users.map((u, i) => `
    <li class="track">
      <span class="rank">${i + 1}</span>
      <div class="meta"><strong>${esc(u.name)}</strong><span>${u.tracks} morceau${u.tracks > 1 ? 'x' : ''} à l'antenne</span></div>
      <span></span><span class="dur">${u.likes} ♥</span>
    </li>`).join('') : '<li class="empty">Les découvreurs apparaîtront ici dès qu\'un morceau passera à l\'antenne.</li>';
}

/* ---------- Likes, partage, réactions ---------- */
async function refreshVote() {
  if (!me.user || !state) return $('#upvote').setAttribute('aria-pressed', 'false');
  const r = await fetch('/api/vote');
  if (r.ok) $('#upvote').setAttribute('aria-pressed', !!(await r.json()).voted);
}
$('#upvote').onclick = needLogin(async () => {
  const r = await fetch('/api/vote', { method: 'POST' });
  if (!r.ok) return;
  const j = await r.json();
  $('#upvote').setAttribute('aria-pressed', j.voted); $('#count').textContent = j.count;
});
$('#shareRadio').onclick = async () => {
  if (!state) return;
  const t = state.track;
  shareOut(`J'écoute « ${t.title} » de ${t.artist} sur Discoveradio, en direct.`);
};
const EMOJIS = ['🔥', '❤️', '🤯', '💃', '👏'];
$('#reactBtns').innerHTML = EMOJIS.map(e => `<button type="button" data-e="${e}" aria-label="Réagir avec ${e}">${e}</button>`).join('');
$('#reactBtns').onclick = e => {
  const b = e.target.closest('button[data-e]');
  if (!b || !state) return;
  socket.emit('react', b.dataset.e); float(b.dataset.e);
};
function float(e) {
  if (still || document.hidden) return;
  const el = document.createElement('span');
  el.className = 'float'; el.textContent = e;
  el.style.left = (4 + Math.random() * 88) + '%';
  el.style.setProperty('--r', (Math.random() * 40 - 20) + 'deg');
  el.addEventListener('animationend', () => el.remove());
  $('#reactions').append(el);
}

/* ---------- Proposer un morceau ---------- */
const etaMin = () => {
  if (!state) return 0;
  const rest = Math.max(0, state.track.duration - pos());
  return Math.max(1, Math.round((rest + queue.filter(t => t.fresh).reduce((a, t) => a + t.duration, 0)) / 60));
};
const openShare = needLogin(() => {
  $('#shareHint').textContent = !state
    ? 'L\'antenne est vide : ton morceau sera le premier diffusé, dès qu\'il est validé.'
    : `${listenersN} personne${s(listenersN)} ${listenersN > 1 ? 'écoutent' : 'écoute'} en ce moment. Une fois validé, ton morceau passe à l'antenne dans environ ${etaMin()} min, et tu es prévenu ici quand il démarre.`;
  $('#shareMsg').textContent = ''; $('#shareMsg').classList.remove('err');
  $('#shareDlg').showModal();
});
$('#share').onclick = openShare;
$('#doneShare').onclick = () => shareOut("Je viens de proposer un morceau sur Discoveradio, la webradio où tout le monde écoute en même temps. Viens l'écouter en direct avec moi.");
const drop = $('#drop');
['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, () => drop.classList.add('over')));
['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, () => drop.classList.remove('over')));
$('#fileInput').onchange = e => {
  const f = e.target.files[0];
  $('#fileName').textContent = f ? `${f.name} (${(f.size / 1048576).toFixed(1)} Mo)` : 'Dépose ton fichier audio ici, ou clique pour le choisir';
};
$('#shareForm').onsubmit = e => {
  e.preventDefault();
  const msg = (t, err) => { const m = $('#shareMsg'); m.textContent = t; m.classList.toggle('err', !!err); };
  if (!$('#fileInput').files[0] && !$('#directUrl').value.trim()) return msg('Choisis un fichier audio ou colle un lien direct.', true);
  const btn = $('#shareSubmit'), bar = $('#up');
  btn.disabled = true; msg('Envoi en cours…');
  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/tracks');
  xhr.upload.onprogress = ev => { if (ev.lengthComputable) { bar.hidden = false; bar.value = ev.loaded / ev.total * 100; } };
  xhr.onerror = () => { bar.hidden = true; btn.disabled = false; msg('Erreur réseau, réessaie.', true); };
  xhr.onload = () => {
    bar.hidden = true; btn.disabled = false;
    let j = {}; try { j = JSON.parse(xhr.responseText); } catch {}
    if (xhr.status >= 300) return msg(j.error || 'Envoi impossible, réessaie.', true);
    e.target.reset(); $('#fileName').textContent = 'Dépose ton fichier audio ici, ou clique pour le choisir';
    $('#shareDlg').close();
    $('#doneText').textContent = j.status === 'approved'
      ? `Il est en ligne et passera à l'antenne dans environ ${etaMin()} min. Tu es prévenu ici dès qu'il démarre.`
      : "Un modérateur l'écoute rapidement. Tu es prévenu ici dès qu'il est validé.";
    $('#doneDlg').showModal();
  };
  xhr.send(new FormData(e.target));
};

/* ---------- Compte ---------- */
async function loadMine() {
  const rows = await (await fetch('/api/my/tracks')).json().catch(() => []);
  const label = { pending: ['En attente', 'chip soft'], approved: ['Validé', 'chip'], rejected: ['Refusé', 'chip bad'] };
  $('#mineList').innerHTML = rows.length ? rows.map(t => {
    const [txt, cls] = label[t.status] || ['', 'chip soft'];
    const stats = t.status === 'approved'
      ? (t.plays ? `${t.plays} passage${s(t.plays)}, ${t.likes} like${s(t.likes)}${t.peak ? `, jusqu'à ${t.peak} auditeur${s(t.peak)}` : ''}` : 'Pas encore passé à l\'antenne.')
      : '';
    return `<div class="mine-item"><div class="meta"><strong>${esc(t.title)}</strong><span>${esc(t.artist)}</span></div><span class="${cls}">${txt}</span>${stats ? `<small>${stats}</small>` : ''}</div>`;
  }).join('') : '<p class="muted">Tu n\'as pas encore proposé de morceau. <button class="linklike" type="button" data-open="share">Propose le premier</button></p>';
}
$('#nameForm').onsubmit = async e => {
  e.preventDefault();
  const r = await fetch('/api/me', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: $('#nameInput').value }) });
  const j = await r.json();
  $('#nameMsg').textContent = r.ok ? 'Enregistré. Ton nouveau nom apparaîtra sur tes prochains passages.' : j.error;
  if (r.ok) me.user.name = j.name;
};
const ICON_USER = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>';
const ICON_SHIELD = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 4 6v6c0 5 3.4 8.3 8 9 4.6-.7 8-4 8-9V6z"/></svg>';
function renderAuth() {
  const el = $('#auth');
  if (!me.user) {
    el.innerHTML = `<button id="loginBtn" class="btn btn-auth" type="button" aria-label="Connexion">${ICON_USER}<span class="lbl">Connexion</span></button>`;
    $('#loginBtn').onclick = () => $('#loginDlg').showModal();
    return;
  }
  const u = me.user;
  el.innerHTML = `${u.isAdmin ? `<a class="btn btn-auth" href="/admin.html" aria-label="Modération">${ICON_SHIELD}<span class="lbl">Modération</span></a>` : ''}
    <button id="meBtn" class="avatar" type="button" aria-label="Mon compte et mes morceaux">${u.avatar ? `<img src="${esc(u.avatar)}" alt="" referrerpolicy="no-referrer">` : esc(initial(u.name))}</button>`;
  $('#meBtn').onclick = () => { $('#nameInput').value = me.user.name || ''; $('#nameMsg').textContent = ''; loadMine(); $('#mineDlg').showModal(); };
}

/* ---------- Chat (Kiwi IRC dans une iframe, déplacée selon la largeur d'écran) ---------- */
const wide = matchMedia('(min-width: 1240px)');
function placeChat() {
  const box = $('#chatBox');
  if (box) (wide.matches ? $('#chatSlot') : $('#chatSlotNarrow')).append(box);
}
function mountChat() {
  if (!me.chat) { $('.stage').classList.add('no-chat'); $('#chatCol').remove(); $('#openChat')?.remove(); $('#t-chat').remove(); $('#p-chat').remove(); return; }
  const box = document.createElement('div');
  box.id = 'chatBox';
  box.innerHTML = '<iframe id="chatFrame" title="Chat en direct" src="/chat/" loading="lazy" allow="clipboard-write"></iframe>';
  document.body.append(box); placeChat();
}
wide.addEventListener('change', placeChat);

/* ---------- Bulle : le spectre du morceau en cours dessine sa forme, les coups de grosse caisse la font claquer ---------- */
const cv = $('#viz'), g = cv.getContext('2d');
let C = {};
const NB = 48;                                   // bandes de fréquences (échelle logarithmique, 40 Hz à 12 kHz)
const S = new Float32Array(NB);                  // spectre normalisé et lissé
const E = { bass: 0, mid: 0, high: 0, all: 0, beat: 0, rot: 0, tilt: 0 };
let gmax = .25, bassAvg = 0, lastBeat = 0, bands = null, bandsFor = 0, trackSeed = 0, seedId = null, lastT = 0;
function readColors() {
  const st = getComputedStyle(root), v = n => st.getPropertyValue(n).trim();
  C = { o1: v('--orb-1'), o2: v('--orb-2'), o3: v('--orb-3'), glow: v('--orb-glow'), mode: v('--orb-mode') || 'lighter', line: v('--line'), live: v('--accent-2'), ink2: v('--ink-2') };
}
const rgba = (hex, a) => hex + Math.round(Math.min(Math.max(a, 0), 1) * 255).toString(16).padStart(2, '0');
function resize() { const d = devicePixelRatio || 1; cv.width = cv.clientWidth * d; cv.height = cv.clientHeight * d; }
addEventListener('resize', resize);
if (window.ResizeObserver) new ResizeObserver(resize).observe(cv);
readColors(); resize();
function makeBands() {
  const hzPerBin = ctx.sampleRate / analyser.fftSize, out = [];
  for (let i = 0; i < NB; i++) {
    const f0 = 40 * Math.pow(300, i / NB), f1 = 40 * Math.pow(300, (i + 1) / NB);
    const a = Math.max(1, Math.floor(f0 / hzPerBin)), b = Math.max(a + 1, Math.ceil(f1 / hzPerBin));
    out.push([a, Math.min(b, freq.length)]);
  }
  bands = out; bandsFor = ctx.sampleRate;
}
const mean = (a, b) => { let s = 0; for (let i = a; i < b; i++) s += S[i]; return s / (b - a); };
function analyse(live, now) {
  if (live) {
    analyser.getByteFrequencyData(freq);
    if (!bands || bandsFor !== ctx.sampleRate) makeBands();
    const raw = new Float32Array(NB);
    let peak = 0;
    for (let i = 0; i < NB; i++) {
      let s = 0; const [a, b] = bands[i];
      for (let k = a; k < b; k++) s += freq[k];
      raw[i] = (s / (b - a) / 255) * (1 + i / NB * 1.8);       // compense la pente naturelle du spectre
      peak = Math.max(peak, raw[i]);
    }
    gmax = Math.max(.12, Math.max(gmax * .997, peak));          // gain automatique : s'adapte au volume et au morceau
    for (let i = 0; i < NB; i++) {
      const n = Math.pow(raw[i] / gmax, 1.35);                  // contraste : seuls les pics ressortent
      S[i] += (n - S[i]) * (n > S[i] ? .6 : .14);
    }
  } else for (let i = 0; i < NB; i++) S[i] *= .92;
  const bass = mean(0, 8), mid = mean(8, 28), high = mean(28, NB);
  E.bass = bass; E.mid = mid; E.high = high; E.all = (bass + mid + high) / 3;
  // détection de pulsation : montée brusque des graves
  if (live && bass > bassAvg * 1.28 + .08 && now - lastBeat > 170) { E.beat = 1; lastBeat = now; }
  bassAvg += (bass - bassAvg) * .1;
  E.beat *= .86;
  // couleur dominante : morceau grave et sombre = violet/rouge, morceau brillant = rose
  const c = (mid * .5 + high) / (bass + mid + high + .001);
  E.tilt += (c - E.tilt) * .03;
}
function blob(cx, cy, r, rot, seed, amp, color, alpha) {
  const N = 90;
  g.beginPath();
  for (let i = 0; i <= N; i++) {
    const a = i / N * Math.PI * 2;
    const u = (1 + Math.cos(a - rot)) / 2;                       // 1 = face au « nord » de la bulle, 0 = opposé
    const v = S[Math.min(NB - 1, Math.floor(Math.pow(u, .8) * (NB - 1)))];
    const k = 1 + amp * v + .035 * Math.sin(a * 3 + rot * 2 + seed) + .02 * Math.sin(a * 5 - rot * 3 + seed * 2);
    const x = cx + Math.cos(a) * r * k, y = cy + Math.sin(a) * r * k;
    i ? g.lineTo(x, y) : g.moveTo(x, y);
  }
  g.closePath();
  const ox = Math.cos(seed * 2.1 + rot) * r * .22, oy = Math.sin(seed * 1.7 + rot * 1.3) * r * .22;
  const gr = g.createRadialGradient(cx + ox, cy + oy, r * .05, cx + ox, cy + oy, r * 1.3);
  gr.addColorStop(0, rgba(color, alpha)); gr.addColorStop(.55, rgba(color, alpha * .55)); gr.addColorStop(1, rgba(color, 0));
  g.fillStyle = gr; g.fill();
}
function draw(t) {
  requestAnimationFrame(draw);
  const dt = Math.min(64, t - lastT || 16); lastT = t;
  const d = devicePixelRatio || 1, w = cv.width, h = cv.height;
  g.clearRect(0, 0, w, h);
  if (state && state.track.id !== seedId) {                      // chaque morceau a sa propre signature de mouvement
    seedId = state.track.id; gmax = .25; bassAvg = 0;
    trackSeed = [...String(seedId)].reduce((s, ch) => (s * 31 + ch.charCodeAt(0)) % 1000, 7) / 1000 * Math.PI * 2;
  }
  const live = !!(analyser && listening && !audio.paused);
  analyse(live, t);
  const calm = still ? 0 : (Math.sin(t / 1500) + 1) * .5;
  E.rot += dt / 1000 * (still ? 0 : .25 + E.all * 2.2 + E.beat * 1.4);
  const rot = E.rot + trackSeed;
  const cx = w / 2, cy = h / 2, M = Math.min(w, h);
  const r = M * .25 * (1 + E.bass * .28 + E.beat * .16 + calm * .03);
  const amp = .55 + E.mid * .3;
  // halo qui bat avec les graves
  const halo = g.createRadialGradient(cx, cy, r * .5, cx, cy, r * 2.3);
  halo.addColorStop(0, rgba(C.glow, .18 + E.bass * .3 + E.beat * .3)); halo.addColorStop(1, rgba(C.glow, 0));
  g.fillStyle = halo; g.fillRect(0, 0, w, h);
  // trois nappes : violet = graves, rose = médiums, rouge = aigus et pulsations ; leur poids suit la couleur du morceau
  g.globalCompositeOperation = C.mode;
  blob(cx, cy, r, rot, trackSeed, amp, C.o1, .55 + E.bass * .45 + (1 - E.tilt) * .1);
  blob(cx, cy, r * .93, -rot * 1.3, trackSeed + 1.7, amp * 1.05, C.o2, .45 + E.mid * .5 + E.tilt * .15);
  blob(cx, cy, r * .82, rot * .7 + 2, trackSeed + 3.3, amp * 1.2, C.o3, .35 + E.high * .6 + E.beat * .4);
  g.globalCompositeOperation = 'source-over';
  const core = g.createRadialGradient(cx - r * .2, cy - r * .25, 0, cx, cy, r * .75);
  core.addColorStop(0, 'rgba(255,255,255,' + Math.min(.8, .25 + E.mid * .3 + E.beat * .35) + ')'); core.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = core; g.beginPath(); g.arc(cx, cy, r * .75, 0, Math.PI * 2); g.fill();
  // anneau : progression du morceau
  const p = state ? Math.min(Math.max(pos() / state.track.duration, 0), 1) : 0, R = M * .46;
  g.lineWidth = 2 * d; g.lineCap = 'round';
  g.strokeStyle = C.line; g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.stroke();
  if (p > 0) {
    // en pause, l'antenne continue sans toi : l'anneau passe en pointillés gris au lieu de faire croire qu'on écoute encore
    const away = userPaused, col = away ? rgba(C.ink2, .7) : C.live, a = -Math.PI / 2 + p * Math.PI * 2;
    g.strokeStyle = col; if (away) g.setLineDash([5 * d, 9 * d]);
    g.beginPath(); g.arc(cx, cy, R, -Math.PI / 2, a); g.stroke(); g.setLineDash([]);
    g.fillStyle = col; g.beginPath(); g.arc(cx + Math.cos(a) * R, cy + Math.sin(a) * R, 4 * d, 0, Math.PI * 2); g.fill();
  }
}
requestAnimationFrame(draw);

/* ---------- Démarrage ---------- */
const meReady = fetch('/api/me').then(r => r.json()).then(j => {
  me = j; renderAuth(); mountChat();
  $('#gbtn').hidden = !j.googleEnabled;
  $('#devForm').hidden = !j.devLogin;
  $('#noLogin').hidden = j.googleEnabled || j.devLogin;
  if (j.contact) $('#contactLine').innerHTML = `Pour faire retirer un morceau : <a href="mailto:${esc(j.contact)}">${esc(j.contact)}</a>.`;
}).catch(() => {});
if (new URLSearchParams(location.search).has('propose')) meReady.then(() => openShare());
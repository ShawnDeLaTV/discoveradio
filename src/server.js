import express from 'express';
import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import dns from 'dns/promises';
import net from 'net';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { Server } from 'socket.io';
import session from 'express-session';
import connectPg from 'connect-pg-simple';
import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import multer from 'multer';
import pg from 'pg';
import { parseFile } from 'music-metadata';

const {
  PORT = 3000, DATABASE_URL, SESSION_SECRET = 'change-me',
  BASE_URL = `http://localhost:${PORT}`, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,
  ADMIN_EMAILS = '', UPLOAD_DIR = './uploads', LIBRARY_DIR = './library',
  CHAT_ENABLED = '1', ALLOW_DEV_LOGIN = '0', CONTACT_EMAIL = '',
} = process.env;
const AUTO_APPROVE_AFTER = Number(process.env.AUTO_APPROVE_AFTER ?? 3);   // 0 = modération systématique

const admins = ADMIN_EMAILS.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const googleEnabled = !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);
const devLogin = !googleEnabled && ALLOW_DEV_LOGIN === '1';
const MAX_BYTES = 30 * 1024 * 1024, MIN_SEC = 30, MAX_SEC = 15 * 60;
const PENDING_LIMIT = 3, DAILY_LIMIT = 5;
const AUDIO_EXT = new Set(['.mp3', '.ogg', '.oga', '.opus', '.wav', '.flac', '.m4a', '.aac']);
const MIME_EXT = { 'audio/mpeg': '.mp3', 'audio/ogg': '.ogg', 'audio/wav': '.wav', 'audio/x-wav': '.wav',
  'audio/flac': '.flac', 'audio/mp4': '.m4a', 'audio/x-m4a': '.m4a', 'audio/aac': '.aac', 'audio/opus': '.opus' };
const REACTIONS = ['🔥', '❤️', '🤯', '💃', '👏'];

if (BASE_URL.startsWith('https://') && /^change-me/.test(SESSION_SECRET)) {
  console.error('SESSION_SECRET doit être changé en production (BASE_URL est en https).');
  process.exit(1);
}
if (!googleEnabled && !devLogin) console.warn('Aucune connexion configurée : renseigne GOOGLE_CLIENT_ID/SECRET (ou ALLOW_DEV_LOGIN=1 en local).');
if (devLogin) console.warn('⚠ Login "dev" activé : n\'importe qui peut se connecter, y compris avec un email admin. Jamais en production.');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

class UserError extends Error {}
const safeExt = name => { const e = path.extname(name || '').toLowerCase(); return AUDIO_EXT.has(e) ? e : null; };
const sha256 = file => new Promise((ok, ko) => {
  const h = crypto.createHash('sha256');
  fs.createReadStream(file).on('data', d => h.update(d)).on('end', () => ok(h.digest('hex'))).on('error', ko);
});
const rmLater = (file, ms = 90_000) => setTimeout(() => fs.rm(path.join(UPLOAD_DIR, file), () => {}), ms);

/* ---------- Base de données ---------- */
const pool = new pg.Pool({ connectionString: DATABASE_URL });
await pool.query(`
  CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, avatar TEXT,
    is_admin BOOLEAN NOT NULL DEFAULT false);
  CREATE TABLE IF NOT EXISTS tracks (
    id SERIAL PRIMARY KEY, title TEXT NOT NULL, artist TEXT NOT NULL, spotify_url TEXT,
    file TEXT NOT NULL, duration REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',            -- pending | approved | rejected
    submitted_by INT REFERENCES users(id), created_at TIMESTAMPTZ DEFAULT now(),
    last_played_at TIMESTAMPTZ);
  CREATE TABLE IF NOT EXISTS votes (
    user_id INT REFERENCES users(id) ON DELETE CASCADE,
    track_id INT REFERENCES tracks(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, track_id));
  CREATE TABLE IF NOT EXISTS radio_state (id INT PRIMARY KEY DEFAULT 1, track_id INT, started_at TIMESTAMPTZ);
  ALTER TABLE tracks ADD COLUMN IF NOT EXISTS plays INT NOT NULL DEFAULT 0;
  ALTER TABLE tracks ADD COLUMN IF NOT EXISTS peak_listeners INT NOT NULL DEFAULT 0;
  ALTER TABLE tracks ADD COLUMN IF NOT EXISTS sha TEXT;
  ALTER TABLE tracks ADD COLUMN IF NOT EXISTS source TEXT;
  CREATE UNIQUE INDEX IF NOT EXISTS tracks_sha_live ON tracks(sha) WHERE sha IS NOT NULL AND status <> 'rejected';
  CREATE INDEX IF NOT EXISTS tracks_status_idx ON tracks(status);
`);

// Le nom affiché n'est écrasé qu'à la première connexion : l'utilisateur peut ensuite le changer.
const upsertUser = async (email, name, avatar) => (await pool.query(
  `INSERT INTO users(email,name,avatar,is_admin) VALUES($1,$2,$3,$4)
   ON CONFLICT (email) DO UPDATE SET avatar=EXCLUDED.avatar, name=COALESCE(users.name, EXCLUDED.name),
   is_admin = users.is_admin OR EXCLUDED.is_admin RETURNING *`,
  [email, name, avatar, admins.includes(email)])).rows[0];

/* ---------- App, sessions, auth ---------- */
const app = express();
app.set('trust proxy', 1);                       // derrière Caddy
const server = http.createServer(app);
const io = new Server(server);
const PgStore = connectPg(session);
const sessionMw = session({
  store: new PgStore({ pool, createTableIfMissing: true }),
  secret: SESSION_SECRET, resave: false, saveUninitialized: false,
  cookie: { maxAge: 30 * 864e5, sameSite: 'lax', httpOnly: true, secure: 'auto' },
});
io.engine.use(sessionMw);                        // permet de lier une socket à un utilisateur

app.use((_req, res, next) => { res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin' }); next(); });
app.use('/media', express.static(UPLOAD_DIR, { maxAge: '7d', immutable: true, index: false }));   // gère les Range requests
app.use(express.static('public', { maxAge: '5m' }));
app.get('/healthz', async (_req, res) => { await pool.query('SELECT 1'); res.send('ok'); });

app.use(sessionMw);
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(async (req, _res, next) => {
  req.me = req.session.userId
    ? (await pool.query('SELECT * FROM users WHERE id=$1', [req.session.userId])).rows[0] : null;
  next();
});
const requireAuth = (req, res, next) => req.me ? next() : res.status(401).json({ error: 'Connexion requise' });
const requireAdmin = (req, res, next) => req.me?.is_admin ? next() : res.status(403).json({ error: 'Réservé aux administrateurs' });
const hits = new Map();
const tooFast = (key, ms) => { const t = Date.now(), last = hits.get(key) || 0; if (t - last < ms) return true; hits.set(key, t); return false; };
setInterval(() => { const t = Date.now(); for (const [k, v] of hits) if (t - v > 60_000) hits.delete(k); }, 60_000).unref();

if (googleEnabled) {
  passport.use(new GoogleStrategy(
    { clientID: GOOGLE_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET, callbackURL: `${BASE_URL}/auth/google/callback` },
    async (_a, _r, profile, done) => {
      try {
        const email = profile.emails?.[0]?.value?.toLowerCase();
        if (!email) return done(new Error('Email Google manquant'));
        // Prénom seulement par défaut : on n'affiche pas le nom complet des gens à l'antenne.
        done(null, await upsertUser(email, profile.name?.givenName || profile.displayName, profile.photos?.[0]?.value));
      } catch (e) { done(e); }
    }));
  app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'], session: false }));
  app.get('/auth/google/callback', passport.authenticate('google', { session: false, failureRedirect: '/' }),
    (req, res) => { req.session.userId = req.user.id; res.redirect('/'); });
} else if (devLogin) {
  app.post('/auth/dev', async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    if (!email.includes('@')) return res.status(400).send('Email invalide');
    const u = await upsertUser(email, String(req.body.name || email.split('@')[0]).slice(0, 30), null);
    req.session.userId = u.id; res.redirect('/');
  });
}
app.post('/auth/logout', (req, res) => req.session.destroy(() => res.redirect('/')));
app.get('/api/me', (req, res) => res.json({
  googleEnabled, devLogin, chat: CHAT_ENABLED === '1', contact: CONTACT_EMAIL,
  user: req.me && { name: req.me.name, email: req.me.email, avatar: req.me.avatar, isAdmin: req.me.is_admin },
}));
app.patch('/api/me', requireAuth, async (req, res) => {
  const name = String(req.body.name || '').trim().replace(/\s+/g, ' ').slice(0, 30);
  if (name.length < 2) return res.status(400).json({ error: 'Pseudo trop court (2 caractères minimum).' });
  await pool.query('UPDATE users SET name=$1 WHERE id=$2', [name, req.me.id]);
  res.json({ name });
});

/* ---------- Chat : Kiwi IRC (image prête à l'emploi) ---------- */
// La config du client est générée ici : hôte/port/TLS déduits de la requête, pseudo = nom de l'utilisateur.
const chatNick = name => {
  const n = String(name || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9_\[\]\\`^{|}-]/g, '').slice(0, 20);
  return !n ? null : /^[0-9-]/.test(n) ? `D${n}` : n;
};
app.get('/kiwi-config.json', (req, res) => {
  const hostHeader = req.host || 'localhost';
  const port = Number(/:(\d+)$/.exec(hostHeader)?.[1] || (req.secure ? 443 : 80));
  res.set('Cache-Control', 'no-store').json({
    windowTitle: 'Chat · Discoveradio',
    startupScreen: 'welcome',
    restricted: true,
    startupOptions: {
      server: req.hostname, port, tls: req.secure, direct: true, direct_path: '/irc',
      channel: '#discoveradio', nick: chatNick(req.me?.name) || 'Auditeur?', autoConnect: true, encoding: 'utf8',
    },
    themes: [{ name: 'Discoveradio', url: 'static/themes/discoveradio' }],
    settings: { theme: 'discoveradio' },
  });
});

/* ---------- Moteur de diffusion ---------- */
let now = null;     // { track, startedAt, peak }
let timer, advancing = null;
const listeners = () => [...io.sockets.sockets.values()].filter(s => s.data.listener).length;

/* Auditeurs simulés : un « fond » de 20 à 80 qui dérive doucement, identique pour tout le monde.
   Désactivable avec FAKE_AUDIENCE=0 (auditeurs réels uniquement, aucune fausse réaction). */
const FAKE_AUDIENCE = process.env.FAKE_AUDIENCE !== '0';
const FAKE_MIN = 20, FAKE_MAX = 80;
let fakeN = FAKE_AUDIENCE ? 30 + Math.floor(Math.random() * 30) : 0;
const totalListeners = () => listeners() + fakeN;          // ce qui est affiché
const emitListeners = () => {
  const real = listeners();
  if (now) now.peak = Math.max(now.peak, real);             // le pic reste calculé sur les vrais auditeurs
  io.emit('listeners', real + fakeN);
};
if (FAKE_AUDIENCE) {
  (function driftFake() {
    // marche aléatoire (±1 la plupart du temps, ±2 rarement) avec rappel vers le milieu de la fourchette
    const pull = (50 - fakeN) * 0.03;
    const step = Math.round(Math.random() * 3 - 1.5 + pull);
    const next = Math.min(FAKE_MAX, Math.max(FAKE_MIN, fakeN + step));
    if (next !== fakeN) { fakeN = next; if (io.engine.clientsCount) emitListeners(); }
    setTimeout(driftFake, 4000 + Math.random() * 8000);
  })();

  /* Fausses réactions : diffusées à tout le monde en même temps, de temps en temps, parfois en petite salve */
  const FAKE_REACTIONS = ['❤️', '❤️', '❤️', '🔥', '🔥', '👏', '💃', '🤯'];
  (function fakeReact() {
    if (now && io.engine.clientsCount) {
      const burst = Math.random() < 0.3 ? 2 + Math.floor(Math.random() * 3) : 1;
      for (let i = 0; i < burst; i++)
        setTimeout(() => io.emit('react', FAKE_REACTIONS[Math.floor(Math.random() * FAKE_REACTIONS.length)]), i * (150 + Math.random() * 300));
    }
    setTimeout(fakeReact, 3000 + Math.random() * 9000);
  })();
}

const TRACK_SQL = `SELECT t.*, u.name AS submitter, (SELECT count(*)::int FROM votes v WHERE v.track_id=t.id) AS likes
  FROM tracks t LEFT JOIN users u ON u.id=t.submitted_by`;
const publicTrack = (t, extra = {}) => ({
  id: t.id, title: t.title, artist: t.artist, duration: t.duration,
  url: `/media/${t.file}`,
  link: t.spotify_url || `https://open.spotify.com/search/${encodeURIComponent(t.artist)}/artists`,
  linkIsSearch: !t.spotify_url,
  by: t.submitter || null, fresh: !t.last_played_at, likes: t.likes ?? 0, plays: t.plays ?? 0, ...extra,
});
const votesCount = async id => +(await pool.query('SELECT count(*) FROM votes WHERE track_id=$1', [id])).rows[0].count;

// Ordre : les nouveaux morceaux d'abord (premier arrivé, premier servi), puis les plus anciennement joués ;
// chaque like fait remonter un morceau de 20 min. On évite d'enchaîner deux morceaux du même proposant.
function interleave(rows, last) {
  const left = [...rows], out = [];
  while (left.length) {
    let i = left.findIndex(r => r.submitted_by == null || r.submitted_by !== last);
    if (i < 0) i = 0;
    const [r] = left.splice(i, 1);
    out.push(r); last = r.submitted_by;
  }
  return out;
}
async function upcoming(limit = 10) {
  const { rows } = await pool.query(
    `SELECT * FROM (${TRACK_SQL} WHERE t.status='approved' AND t.id <> $1) q
     ORDER BY (q.last_played_at IS NOT NULL),
              COALESCE(q.last_played_at, q.created_at) - q.likes * interval '20 minutes', q.id LIMIT 40`,
    [now?.track.id ?? 0]);
  return interleave(rows, now?.track.submitted_by).slice(0, limit);
}
const queuePayload = async () => (await upcoming(10)).map(t => publicTrack(t));
const broadcastQueue = async () => io.emit('next', await queuePayload());
const snapshot = async () => ({
  track: now ? publicTrack(now.track, { upvotes: await votesCount(now.track.id) }) : null,
  startedAt: now?.startedAt, next: await queuePayload(),
});
const saveState = () => pool.query(
  `INSERT INTO radio_state(id,track_id,started_at) VALUES(1,$1,$2)
   ON CONFLICT (id) DO UPDATE SET track_id=EXCLUDED.track_id, started_at=EXCLUDED.started_at`,
  [now?.track.id ?? null, now ? new Date(now.startedAt) : null]);
const schedule = () => {
  clearTimeout(timer);
  timer = setTimeout(advance, Math.max(0, now.startedAt + now.track.duration * 1000 - Date.now()));
};

const advance = () => (advancing ??= doAdvance().finally(() => { advancing = null; }));
async function doAdvance() {
  clearTimeout(timer);
  try {
    if (now) await pool.query('UPDATE tracks SET peak_listeners=GREATEST(peak_listeners,$2) WHERE id=$1', [now.track.id, now.peak]);
    // File vide hors morceau courant : on rejoue le courant s'il est toujours approuvé.
    const next = (await upcoming(1))[0]
      ?? (now && (await pool.query(`${TRACK_SQL} WHERE t.id=$1 AND t.status='approved'`, [now.track.id])).rows[0]);
    if (!next) {
      const wasOn = !!now;
      now = null; await saveState();
      if (wasOn) io.emit('state', await snapshot());
      timer = setTimeout(advance, 5000); return;
    }
    await pool.query('UPDATE tracks SET last_played_at=now(), plays=plays+1 WHERE id=$1', [next.id]);
    const track = (await pool.query(`${TRACK_SQL} WHERE t.id=$1`, [next.id])).rows[0];
    now = { track, startedAt: Date.now(), peak: listeners() };
    await saveState(); schedule();
    io.emit('state', await snapshot());
    if (track.submitted_by) io.to(`user:${track.submitted_by}`).emit('on-air', { title: track.title, listeners: totalListeners() });
  } catch (e) { console.error('advance:', e); timer = setTimeout(advance, 5000); }
}
// Au redémarrage, on reprend le morceau en cours là où il en était.
async function restore() {
  try {
    const s = (await pool.query('SELECT track_id, started_at FROM radio_state WHERE id=1')).rows[0];
    if (s?.track_id) {
      const t = (await pool.query(`${TRACK_SQL} WHERE t.id=$1 AND t.status='approved'`, [s.track_id])).rows[0];
      const startedAt = +new Date(s.started_at);
      if (t && startedAt + t.duration * 1000 > Date.now() + 2000) { now = { track: t, startedAt, peak: 0 }; schedule(); return; }
    }
  } catch (e) { console.error('restore:', e); }
  advance();
}

io.on('connection', async socket => {
  const uid = socket.request.session?.userId;
  if (uid) socket.join(`user:${uid}`);
  socket.on('time', cb => typeof cb === 'function' && cb(Date.now()));       // synchronisation d'horloge
  socket.on('react', e => {
    if (!now || !REACTIONS.includes(e) || tooFast(`r:${socket.id}`, 350)) return;
    socket.broadcast.emit('react', e);
  });
  socket.on('disconnect', () => { if (socket.data.listener) emitListeners(); });
  if (socket.handshake.auth?.listener) { socket.data.listener = true; emitListeners(); }
  socket.emit('listeners', totalListeners());
  socket.emit('state', await snapshot());
});

/* ---------- Upvotes ---------- */
app.get('/api/vote', requireAuth, async (req, res) => {
  if (!now) return res.json({ voted: false });
  const r = await pool.query('SELECT 1 FROM votes WHERE user_id=$1 AND track_id=$2', [req.me.id, now.track.id]);
  res.json({ voted: r.rowCount > 0 });
});
app.post('/api/vote', requireAuth, async (req, res) => {
  if (!now) return res.status(409).json({ error: 'Aucune piste en cours' });
  if (tooFast(`v:${req.me.id}`, 600)) return res.status(429).json({ error: 'Doucement !' });
  const id = now.track.id;
  const del = await pool.query('DELETE FROM votes WHERE user_id=$1 AND track_id=$2', [req.me.id, id]);
  if (!del.rowCount) await pool.query('INSERT INTO votes VALUES($1,$2) ON CONFLICT DO NOTHING', [req.me.id, id]);
  const count = await votesCount(id);
  io.emit('votes', { trackId: id, count });
  res.json({ voted: !del.rowCount, count });
});

/* ---------- Pages publiques : historique, classement, mes morceaux ---------- */
app.get('/api/history', async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM (${TRACK_SQL} WHERE t.status='approved' AND t.last_played_at IS NOT NULL AND t.id <> $1) q
     ORDER BY q.last_played_at DESC LIMIT 15`, [now?.track.id ?? 0]);
  res.json(rows.map(t => publicTrack(t)));
});
app.get('/api/charts', async (_req, res) => {
  const tracks = (await pool.query(
    `SELECT * FROM (${TRACK_SQL} WHERE t.status='approved') q WHERE q.likes > 0
     ORDER BY q.likes DESC, q.plays DESC LIMIT 10`)).rows.map(t => publicTrack(t));
  const users = (await pool.query(
    `SELECT u.name, count(DISTINCT t.id)::int AS tracks, count(v.user_id)::int AS likes
     FROM tracks t JOIN users u ON u.id=t.submitted_by LEFT JOIN votes v ON v.track_id=t.id
     WHERE t.status='approved' GROUP BY u.id ORDER BY likes DESC, tracks DESC LIMIT 5`)).rows;
  res.json({ tracks, users });
});
app.get('/api/my/tracks', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM (${TRACK_SQL} WHERE t.submitted_by=$1) q ORDER BY q.created_at DESC LIMIT 50`, [req.me.id]);
  res.json(rows.map(t => publicTrack(t, { status: t.status, peak: t.peak_listeners })));
});

/* ---------- Soumission de morceaux ---------- */
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_q, f, cb) => cb(null, crypto.randomUUID() + safeExt(f.originalname)),
  }),
  limits: { fileSize: MAX_BYTES, files: 1 },
  fileFilter: (_q, f, cb) => safeExt(f.originalname)
    ? cb(null, true) : cb(new UserError('Format non pris en charge (MP3, OGG, M4A, WAV, FLAC).')),
});
const up = (req, res, next) => upload.single('file')(req, res, err => err
  ? res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Fichier trop volumineux (30 Mo max).' : err.message })
  : next());

async function quota(req, res, next) {
  if (req.me.is_admin) return next();
  const q = (await pool.query(
    `SELECT count(*) FILTER (WHERE status='pending')::int AS pending,
            count(*) FILTER (WHERE created_at > now() - interval '24 hours')::int AS today
     FROM tracks WHERE submitted_by=$1`, [req.me.id])).rows[0];
  if (q.pending >= PENDING_LIMIT) return res.status(429).json({ error: `Tu as déjà ${PENDING_LIMIT} morceaux en attente de validation, patiente un peu.` });
  if (q.today >= DAILY_LIMIT) return res.status(429).json({ error: `Limite de ${DAILY_LIMIT} morceaux par jour atteinte, reviens demain.` });
  next();
}

// Téléchargement par lien direct, protégé contre le SSRF (adresses privées, redirections, taille).
const isPrivateIp = ip => {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) { const t = v.slice(7); return net.isIPv4(t) ? isPrivateIp(t) : true; }
  return v === '::1' || v === '::' || /^f[cd]/.test(v) || v.startsWith('fe80');
};
async function downloadAudio(url) {
  let u;
  try { u = new URL(url); } catch { throw new UserError('Lien invalide.'); }
  let r;
  for (let hop = 0; hop < 4; hop++) {
    if (!['http:', 'https:'].includes(u.protocol)) throw new UserError('Lien invalide.');
    const addrs = await dns.lookup(u.hostname, { all: true }).catch(() => []);
    if (!addrs.length || addrs.some(a => isPrivateIp(a.address))) throw new UserError('Ce lien n\'est pas accessible.');
    r = await fetch(u, { redirect: 'manual', signal: AbortSignal.timeout(30000) });
    const loc = r.headers.get('location');
    if (r.status >= 300 && r.status < 400 && loc) { u = new URL(loc, u); continue; }
    break;
  }
  const type = (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!r.ok || !type.startsWith('audio/') || !r.body) throw new UserError('Le lien doit pointer directement vers un fichier audio.');
  const ext = safeExt(u.pathname) || MIME_EXT[type];
  if (!ext) throw new UserError('Format audio non pris en charge.');
  const name = crypto.randomUUID() + ext, dest = path.join(UPLOAD_DIR, name);
  let n = 0;
  const cap = new Transform({ transform(chunk, _e, cb) {
    n += chunk.length;
    n > MAX_BYTES ? cb(new UserError('Fichier trop volumineux (30 Mo max).')) : cb(null, chunk);
  } });
  await pipeline(Readable.fromWeb(r.body), cap, fs.createWriteStream(dest)).catch(e => { fs.rm(dest, () => {}); throw e; });
  return name;
}

app.post('/api/tracks', requireAuth, quota, up, async (req, res) => {
  let file = req.file?.filename;
  const fail = (code, error) => { if (file) fs.rm(path.join(UPLOAD_DIR, file), () => {}); return res.status(code).json({ error }); };
  try {
    if (req.body.rights !== 'on') return fail(400, 'Coche la case pour confirmer que tu as le droit de diffuser ce morceau.');
    if (!file && req.body.url?.trim()) file = await downloadAudio(req.body.url.trim());
    if (!file) return fail(400, 'Ajoute un fichier audio ou un lien direct vers un fichier audio.');
    const full = path.join(UPLOAD_DIR, file);
    const meta = await parseFile(full).catch(() => null);
    const duration = meta?.format.duration;
    const title = (req.body.title || meta?.common.title || '').trim().slice(0, 120);
    const artist = (req.body.artist || meta?.common.artist || '').trim().slice(0, 120);
    if (!duration) return fail(400, 'Fichier audio illisible.');
    if (duration < MIN_SEC || duration > MAX_SEC) return fail(400, `Durée acceptée : de ${MIN_SEC} secondes à ${MAX_SEC / 60} minutes.`);
    if (!title || !artist) return fail(400, 'Titre ou artiste manquant : renseigne-les dans le formulaire.');
    let link = null;
    const raw = (req.body.spotifyUrl || '').trim();
    if (raw) {
      try { const u = new URL(raw); if (u.protocol !== 'https:' || raw.length > 300) throw 0; link = u.href; }
      catch { return fail(400, 'Le lien d\'écoute doit être une adresse https valide.'); }
    }
    const h = (await pool.query(
      `SELECT count(*) FILTER (WHERE status='approved')::int AS ok, count(*) FILTER (WHERE status='rejected')::int AS ko
       FROM tracks WHERE submitted_by=$1`, [req.me.id])).rows[0];
    const trusted = AUTO_APPROVE_AFTER > 0 && h.ok >= AUTO_APPROVE_AFTER && h.ko === 0;
    const status = req.me.is_admin || trusted ? 'approved' : 'pending';
    const sha = await sha256(full);
    const { rows: [row] } = await pool.query(
      `INSERT INTO tracks(title,artist,spotify_url,file,duration,status,submitted_by,sha)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [title, artist, link, file, duration, status, req.me.id, sha]);
    io.emit('pending-changed');
    if (status === 'approved') { await broadcastQueue(); if (!now) advance(); }
    res.json({ status, id: row.id });
  } catch (e) {
    if (e.code === '23505') return fail(409, 'Ce morceau est déjà sur la radio.');
    if (e instanceof UserError) return fail(400, e.message);
    console.error('upload:', e); fail(500, 'Erreur serveur, réessaie dans un instant.');
  }
});

/* ---------- Modération ---------- */
app.get('/api/admin/pending', requireAdmin, async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM (${TRACK_SQL} WHERE t.status='pending') q ORDER BY q.created_at`);
  res.json(rows.map(t => publicTrack(t)));
});
app.get('/api/admin/live', requireAdmin, async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM (${TRACK_SQL} WHERE t.status='approved') q ORDER BY q.created_at DESC LIMIT 300`);
  res.json({ current: now?.track.id ?? null, tracks: rows.map(t => publicTrack(t)) });
});
app.post('/api/admin/skip', requireAdmin, async (_req, res) => { await advance(); res.json({ ok: true }); });
app.post('/api/admin/tracks/:id/:action', requireAdmin, async (req, res) => {
  const id = Number(req.params.id), { action } = req.params;
  const moves = { approve: ['pending', 'approved'], reject: ['pending', 'rejected'], remove: ['approved', 'rejected'] };
  if (!moves[action] || !Number.isInteger(id)) return res.sendStatus(400);
  const [from, to] = moves[action];
  const r = await pool.query('UPDATE tracks SET status=$1 WHERE id=$2 AND status=$3 RETURNING file,title,submitted_by', [to, id, from]);
  if (!r.rowCount) return res.json({ ok: false });
  const t = r.rows[0];
  if (to === 'rejected') rmLater(t.file);
  if (t.submitted_by && action !== 'remove') io.to(`user:${t.submitted_by}`).emit('my-track', { title: t.title, status: to });
  io.emit('pending-changed');
  if (now?.track.id === id && to === 'rejected') await advance();
  else await broadcastQueue();
  if (to === 'approved' && !now) advance();
  res.json({ ok: true });
});

/* ---------- Bibliothèque : tout fichier déposé dans ./library est publié au démarrage ---------- */
async function importLibrary() {
  if (!fs.existsSync(LIBRARY_DIR)) return;
  for (const f of fs.readdirSync(LIBRARY_DIR)) {
    const ext = safeExt(f);
    if (!ext || (await pool.query('SELECT 1 FROM tracks WHERE source=$1', [f])).rowCount) continue;
    try {
      const src = path.join(LIBRARY_DIR, f), meta = await parseFile(src);
      const duration = meta.format.duration, artist = meta.common.artist, title = meta.common.title || path.parse(f).name;
      if (!duration || !artist) { console.warn(`[bibliothèque] ${f} ignoré : durée ou tag « artiste » manquant.`); continue; }
      const sha = await sha256(src);
      if ((await pool.query(`SELECT 1 FROM tracks WHERE sha=$1 AND status<>'rejected'`, [sha])).rowCount) continue;
      const name = crypto.randomUUID() + ext;
      await fs.promises.copyFile(src, path.join(UPLOAD_DIR, name));
      await pool.query(
        `INSERT INTO tracks(title,artist,file,duration,status,sha,source) VALUES($1,$2,$3,$4,'approved',$5,$6)`,
        [title, artist, name, duration, sha, f]);
      console.log(`[bibliothèque] ajouté : ${artist} – ${title}`);
    } catch (e) { console.warn(`[bibliothèque] ${f} ignoré :`, e.message); }
  }
}

app.use((err, _req, res, _next) => { console.error(err); res.status(500).json({ error: 'Erreur serveur' }); });
process.on('unhandledRejection', e => console.error('unhandledRejection:', e));
process.on('SIGTERM', () => { server.close(); pool.end().finally(() => process.exit(0)); });

await importLibrary();
server.listen(PORT, () => console.log(`Discoveradio sur ${BASE_URL} (Google: ${googleEnabled ? 'oui' : devLogin ? 'login dev' : 'non'}, chat: ${CHAT_ENABLED === '1' ? 'oui' : 'non'})`));
restore();
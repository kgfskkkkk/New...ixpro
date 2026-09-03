require('./plugins/logger');
const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');
const router = express.Router();

// ---------------- Hidden admin panel (/bot) ----------------

const botRouter = express.Router();
botRouter.use(express.json());
botRouter.use(express.urlencoded({ extended: true }));
const BOT_ADMIN_PASS = process.env.BOT_ADMIN_PASS || 'lovely';
const BOT_SESSION_MAX_AGE = 24 * 60 * 60 * 1000;
const BOT_WEB_URL = process.env.BOT_WEB_URL || 'https://ishan-x.kdns.fr/';
const botTokens = new Set();

function botParseCookies(req) {
  const out = {};
  const h = req.headers.cookie;
  if (!h) return out;
  h.split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > -1) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

function botSafeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function requireBotAuth(req, res, next) {
  const cookies = botParseCookies(req);
  const token = cookies.ishanx_admin || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token || !botTokens.has(token)) {
    const wantsJson = req.path.startsWith('/api/') || (req.headers.accept || '').includes('json');
    if (wantsJson) return res.status(401).json({ ok: false, error: 'Unauthorized' });
    return res.redirect('/bot?login=1');
  }
  next();
}

botRouter.post('/login', (req, res) => {
  const { password } = req.body || {};
  if (!botSafeEqual(password, BOT_ADMIN_PASS)) {
    return res.status(401).json({ ok: false, error: 'Wrong password' });
  }
  const token = crypto.randomBytes(32).toString('hex');
  botTokens.add(token);
  res.setHeader('Set-Cookie', `ishanx_admin=${token}; HttpOnly; Path=/; Max-Age=${Math.floor(BOT_SESSION_MAX_AGE / 1000)}; SameSite=Lax`);
  res.json({ ok: true });
});

botRouter.post('/logout', (req, res) => {
  const cookies = botParseCookies(req);
  if (cookies.ishanx_admin) botTokens.delete(cookies.ishanx_admin);
  res.setHeader('Set-Cookie', 'ishanx_admin=; HttpOnly; Path=/; Max-Age=0');
  res.json({ ok: true });
});

botRouter.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'bot.html'));
});

botRouter.get('/api/stats', requireBotAuth, async (req, res) => {
  try {
    await initMongo();
    const [sessions, numbers, admins, configs, newsletters, collections] = await Promise.all([
      sessionsCol.countDocuments({}),
      numbersCol.countDocuments({}),
      adminsCol.countDocuments({}),
      configsCol.countDocuments({}),
      newsletterCol.countDocuments({}),
      mongoDB.listCollections().toArray()
    ]);
    res.json({
      ok: true,
      stats: {
        sessions, numbers, admins, configs, newsletters,
        collections: collections.length,
        active: activeSockets.size,
        pairing: pairingInProgress.size,
        loggedOut: loggedOutSessions.size,
        uptime: process.uptime()
      }
    });
  } catch (err) { console.error('/api/stats error', err); res.status(500).json({ ok: false, error: err.message || err }); }
});

botRouter.get('/api/users', requireBotAuth, async (req, res) => {
  try {
    await initMongo();
    const nums = await numbersCol.find({}).toArray();
    const configDocs = await configsCol.find({}).toArray();
    const sessionDocs = await sessionsCol.find({}, { projection: { number: 1, updatedAt: 1 } }).toArray();
    const cfgByNum = new Map((configDocs || []).map(d => [d.number, d.config || {}]));
    const sessByNum = new Map((sessionDocs || []).map(d => [d.number, d]));
    const users = (nums || []).map(d => {
      const n = d.number;
      const cfg = cfgByNum.get(n) || {};
      return {
        number: n,
        session: !!sessByNum.get(n),
        updatedAt: sessByNum.get(n)?.updatedAt || d.updatedAt || null,
        active: activeSockets.has(n),
        pairing: pairingInProgress.has(n) || pairingSockets.has(n),
        loggedOut: loggedOutSessions.has(n),
        config: cfg
      };
    });
    users.sort((a, b) => String(b.number).localeCompare(String(a.number)));
    res.json({ ok: true, users });
  } catch (err) { console.error('/api/users error', err); res.status(500).json({ ok: false, error: err.message || err }); }
});

botRouter.post('/api/user/delete', requireBotAuth, async (req, res) => {
  try {
    const { number } = req.body || {};
    if (!number) return res.status(400).json({ ok: false, error: 'number required' });
    const sanitized = ('' + number).replace(/[^0-9]/g, '');
    if (activeSockets.has(sanitized)) {
      const running = activeSockets.get(sanitized);
      try { if (typeof running.logout === 'function') await running.logout().catch(() => {}); } catch (e) {}
      try { running.ws?.close(); } catch (e) {}
    }
    await deleteSessionAndCleanup(sanitized);
    res.json({ ok: true, message: `Session ${sanitized} deleted` });
  } catch (err) { console.error('/api/user/delete error', err); res.status(500).json({ ok: false, error: err.message || err }); }
});

const CONFIG_WHITELIST = ['WORK_TYPE', 'AUTO_VIEW_STATUS', 'AUTO_LIKE_STATUS', 'AUTO_REACT', 'AUTO_RECORDING', 'AUTO_TYPING', 'AUTO_READ_MESSAGE', 'AUTO_LIKE_EMOJI', 'PREFIX', 'botName', 'WELCOME_GROUP', 'WELCOME_GROUP_TEXT', 'WELCOME_GROUP_IMG', 'GOODBYE_GROUP', 'GOODBYE_GROUP_TEXT', 'GOODBYE_GROUP_IMG', 'WELCOME_PERSONAL', 'WELCOME_PERSONAL_TEXT'];

botRouter.get('/api/user/config', requireBotAuth, async (req, res) => {
  try {
    const number = (req.query.number || '').replace(/[^0-9]/g, '');
    if (!number) return res.status(400).json({ ok: false, error: 'number required' });
    const config = await loadUserConfigFromMongo(number) || {};
    res.json({ ok: true, number, config });
  } catch (err) { console.error('/api/user/config error', err); res.status(500).json({ ok: false, error: err.message || err }); }
});

botRouter.post('/api/user/config', requireBotAuth, async (req, res) => {
  try {
    const { number, config } = req.body || {};
    if (!number) return res.status(400).json({ ok: false, error: 'number required' });
    if (!config || typeof config !== 'object') return res.status(400).json({ ok: false, error: 'config required' });
    const sanitized = ('' + number).replace(/[^0-9]/g, '');
    const current = await loadUserConfigFromMongo(sanitized) || {};
    for (const [k, v] of Object.entries(config)) {
      if (CONFIG_WHITELIST.includes(k)) current[k] = v;
    }
    await setUserConfigInMongo(sanitized, current);
    res.json({ ok: true, number: sanitized, config: current });
  } catch (err) { console.error('/api/user/config error', err); res.status(500).json({ ok: false, error: err.message || err }); }
});

botRouter.get('/api/admins', requireBotAuth, async (req, res) => {
  try {
    const list = await loadAdminsFromMongo();
    res.json({ ok: true, list });
  } catch (err) { console.error('/api/admins error', err); res.status(500).json({ ok: false, error: err.message || err }); }
});

botRouter.post('/api/admin/add', requireBotAuth, async (req, res) => {
  try {
    const { jid } = req.body || {};
    if (!jid) return res.status(400).json({ ok: false, error: 'jid required' });
    await addAdminToMongo(jid);
    res.json({ ok: true, jid });
  } catch (err) { console.error('/api/admin/add error', err); res.status(500).json({ ok: false, error: err.message || err }); }
});

botRouter.post('/api/admin/remove', requireBotAuth, async (req, res) => {
  try {
    const { jid } = req.body || {};
    if (!jid) return res.status(400).json({ ok: false, error: 'jid required' });
    await removeAdminFromMongo(jid);
    res.json({ ok: true, jid });
  } catch (err) { console.error('/api/admin/remove error', err); res.status(500).json({ ok: false, error: err.message || err }); }
});

function botToObjectId(v) {
  if (typeof v === 'string' && /^[0-9a-fA-F]{24}$/.test(v)) {
    try { return new (require('mongodb').ObjectId)(v); } catch (e) {}
  }
  return v;
}

botRouter.get('/api/collections', requireBotAuth, async (req, res) => {
  try {
    await initMongo();
    const cols = await mongoDB.listCollections().toArray();
    const list = [];
    for (const c of cols) {
      try { list.push({ name: c.name, count: await mongoDB.collection(c.name).countDocuments({}) }); }
      catch (e) { list.push({ name: c.name, count: -1 }); }
    }
    res.json({ ok: true, collections: list });
  } catch (err) { console.error('/api/collections error', err); res.status(500).json({ ok: false, error: err.message || err }); }
});

botRouter.get('/api/collections/:name', requireBotAuth, async (req, res) => {
  try {
    await initMongo();
    const name = req.params.name;
    const skip = parseInt(req.query.skip || '0', 10) || 0;
    const limit = Math.min(parseInt(req.query.limit || '50', 10) || 50, 200);
    const col = mongoDB.collection(name);
    const total = await col.countDocuments({});
    const docs = await col.find({}).skip(skip).limit(limit).toArray();
    res.json({ ok: true, name, total, skip, limit, docs });
  } catch (err) { console.error('/api/collections/:name error', err); res.status(500).json({ ok: false, error: err.message || err }); }
});

botRouter.post('/api/collections/:name', requireBotAuth, async (req, res) => {
  try {
    await initMongo();
    const name = req.params.name;
    const doc = req.body?.doc;
    if (!doc || typeof doc !== 'object') return res.status(400).json({ ok: false, error: 'doc required' });
    const col = mongoDB.collection(name);
    const r = await col.insertOne(doc);
    res.json({ ok: true, insertedId: r.insertedId });
  } catch (err) { console.error('/api/collections/:name POST error', err); res.status(500).json({ ok: false, error: err.message || err }); }
});

botRouter.get('/api/collections/:name/:id', requireBotAuth, async (req, res) => {
  try {
    await initMongo();
    const { name, id } = req.params;
    const col = mongoDB.collection(name);
    const doc = await col.findOne({ _id: botToObjectId(id) });
    if (!doc) return res.status(404).json({ ok: false, error: 'not found' });
    res.json({ ok: true, doc });
  } catch (err) { console.error('/api/collections/:name/:id GET error', err); res.status(500).json({ ok: false, error: err.message || err }); }
});

botRouter.put('/api/collections/:name/:id', requireBotAuth, async (req, res) => {
  try {
    await initMongo();
    const { name, id } = req.params;
    const doc = req.body?.doc;
    if (!doc || typeof doc !== 'object') return res.status(400).json({ ok: false, error: 'doc required' });
    const col = mongoDB.collection(name);
    delete doc._id;
    const r = await col.replaceOne({ _id: botToObjectId(id) }, doc, { upsert: false });
    res.json({ ok: true, matched: r.matchedCount, modified: r.modifiedCount });
  } catch (err) { console.error('/api/collections/:name PUT error', err); res.status(500).json({ ok: false, error: err.message || err }); }
});

botRouter.delete('/api/collections/:name/:id', requireBotAuth, async (req, res) => {
  try {
    await initMongo();
    const { name, id } = req.params;
    const col = mongoDB.collection(name);
    const r = await col.deleteOne({ _id: botToObjectId(id) });
    res.json({ ok: true, deleted: r.deletedCount });
  } catch (err) { console.error('/api/collections/:name DELETE error', err); res.status(500).json({ ok: false, error: err.message || err }); }
});

botRouter.post('/api/connect-all', requireBotAuth, async (req, res) => {
  try {
    const nums = await getAllSessionNumbersFromMongo();
    let started = 0;
    for (const n of nums) {
      if (!activeSockets.has(n) && !pairingInProgress.has(n)) {
        const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
        EmpirePair(n, mockRes).catch(() => {});
        started++;
      }
    }
    res.json({ ok: true, started, total: nums.length });
  } catch (err) { console.error('/api/connect-all error', err); res.status(500).json({ ok: false, error: err.message || err }); }
});

botRouter.post('/api/clear-all', requireBotAuth, async (req, res) => {
  try {
    await initMongo();
    for (const [num, sock] of [...activeSockets.entries()]) {
      try { sock.ws?.close(); } catch (e) {}
      activeSockets.delete(num);
    }
    for (const [num, sock] of [...pairingSockets.entries()]) {
      try { sock.ws?.close(); } catch (e) {}
      pairingSockets.delete(num);
    }
    pairingInProgress.clear();
    latestPairCode.clear();
    loggedOutSessions.clear();
    const s = await sessionsCol.deleteMany({});
    const n = await numbersCol.deleteMany({});
    const tmp = os.tmpdir();
    try {
      for (const entry of fs.readdirSync(tmp)) {
        if (entry.startsWith('session_')) { try { fs.removeSync(path.join(tmp, entry)); } catch (e) {} }
      }
    } catch (e) {}
    res.json({ ok: true, sessions: s.deletedCount, numbers: n.deletedCount });
  } catch (err) { console.error('/api/clear-all error', err); res.status(500).json({ ok: false, error: err.message || err }); }
});

botRouter.post('/api/restart', requireBotAuth, (req, res) => {
  res.json({ ok: true, message: 'Restarting process…' });
  setTimeout(() => {
    // Just exit — PM2 autorestart (ecosystem.config.js) brings it back. A
    // manual `pm2 restart` here would race the old process on port 8002.
    try { process.exit(0); } catch (e) {}
  }, 500);
});

const pino = require('pino');
const moment = require('moment-timezone');
const Jimp = require('jimp');
const cinesubPlugin = require('./plugins/cinesub');
const cinesulkPlugin = require('./plugins/cinesublk');
const animeheavenPlugin = require('./plugins/animeheaven');
const boxhubPlugin = require('./plugins/boxhub');
const crypto = require('crypto');
const axios = require('axios');
const FileType = require('file-type');
const fetch = require('node-fetch');
const { MongoClient } = require('mongodb');

const {
  default: makeWASocket,
  useMultiFileAuthState,
  delay,
  getContentType,
  makeCacheableSignalKeyStore,
  Browsers,
  fetchLatestWaWebVersion,
  jidNormalizedUser,
  downloadContentFromMessage,
  proto,
  WAMessageStubType,
  DisconnectReason
} = require('@whiskeysockets/baileys');
const disk = require('./plugins/disk');
disk.setupTempDir();

// API key for the shyracore NSFW search/download endpoints (.xvideos/.xsearch/.xvdl/.xnxx).
// Declared at module scope: a const inside the command switch body would sit in the
// temporal dead zone for these cases (the switch jumps past the declaration).
// Override via SHYRACORE_API_KEY env var (set on Render/PM2) without touching code.
const SHYRACORE_API_KEY = process.env.SHYRACORE_API_KEY || 'SK-wp2hqbcaae-mpf90rdu';

// ==================== ANIME (.anime) — INLINE CASE-TYPE ====================
// Anime search + episode streamer via the local Miruro API (miruro-api/,
// FastAPI on port 8003): search/info come from AniList GraphQL, episodes and
// HLS streams are proxied from www.miruro.tv.
// Flow: .anime <name> → search → pick number → details + episodes → pick
// episode → HLS stream link (kiwi provider preferred, hard-subbed).
// Sessions are keyed per chat::user (a user can never pick another user's
// results) and auto-expire after 10 minutes.
// Base URL is env-overridable (MIRURO_API_BASE) and defaults to the local API.
const ANIME_API_BASE = () => (config && config.miruroApiBase) || process.env.MIRURO_API_BASE || 'http://localhost:8003';
const ANIME_MIRURO_REFERER = 'https://www.miruro.tv/';
const ANIME_API_TIMEOUT = 30000;
const ANIME_SESSION_TTL = 10 * 60 * 1000;
const ANIME_MAX_SEARCH_RESULTS = 10;
const ANIME_EPISODES_PER_PAGE = 20;
const ANIME_PAGINATION_THRESHOLD = 50;
// Preferred episode providers (kiwi = hard-subbed animepahe), best first.
const ANIME_PREFERRED_PROVIDERS = ['kiwi', 'moo', 'pewe', 'bee', 'hop', 'bonk', 'ally'];

const animeSessions = new Map();

// ---- Anti-spam throttles for the .anime flow ----
// Keyed per chat::user so a spammer hammering numbers can't make the bot
// reply to every message or fire concurrent API fetches.
const ANIME_REPLY_THROTTLE_MS = 2500;   // min gap between handled replies
const ANIME_NUDGE_COOLDOWN_MS = 30000;  // "Session expired" nudge at most once/30s
const ANIME_NUDGE_WINDOW_MS = 15 * 60 * 1000; // nudge only if user used .anime within 15 min
const ANIME_CHAT_NUDGE_COOLDOWN_MS = 30000;   // at most 1 nudge per chat per 30s (group safety)
const ANIME_SEARCH_COOLDOWN_MS = 4000;  // .anime command at most once/4s
const animeThrottle = new Map();
const animeChatNudge = new Map();       // chat -> last nudge ts (group-wide nudge cooldown)

// ---- Anime menu-message registry (reply-context ownership) ----
// Every anime list/menu message this bot sends is recorded (msgId → who/where/
// which step/which bot). A numbered reply is accepted ONLY when it QUOTES one
// of these messages AND the quote belongs to the same chat + user + bot. Random
// numbers (polls, counts, other bots' menus) never match and are ignored.
const animeMenuIds = new Map();         // msgId -> { chat, user, step, ts, botNum }
const ANIME_MENU_TTL = 15 * 60 * 1000;  // a bit longer than the session TTL
const ANIME_MENU_MAX = 800;

function animeNormUser(u) {
  return String(u || '').split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
}

function animeRecordMenu(msgId, chat, user, step, botNum) {
  try {
    if (!msgId) return;
    const key = String(msgId);
    animeMenuIds.set(key, { chat, user: animeNormUser(user), step, ts: Date.now(), botNum: botNum || '' });
    if (animeMenuIds.size > ANIME_MENU_MAX) {
      const now = Date.now();
      for (const [k, v] of animeMenuIds) if (now - v.ts > ANIME_MENU_TTL) animeMenuIds.delete(k);
      while (animeMenuIds.size > ANIME_MENU_MAX) animeMenuIds.delete(animeMenuIds.keys().next().value);
    }
  } catch (e) {}
}

// The quoted message id must belong to an anime menu sent in this chat to this
// user by THIS bot, and be younger than ANIME_MENU_TTL. Returns the record or null.
function animeMenuMatch(stanzaId, chat, user, botNum) {
  try {
    if (!stanzaId) return null;
    const rec = animeMenuIds.get(String(stanzaId));
    if (!rec) return null;
    if (rec.chat !== chat) return null;
    if (rec.user !== animeNormUser(user)) return null;
    if (Date.now() - rec.ts > ANIME_MENU_TTL) { animeMenuIds.delete(String(stanzaId)); return null; }
    if (botNum && rec.botNum && rec.botNum !== botNum) return null;
    return rec;
  } catch (e) { return null; }
}

// True when this message quotes one of OUR anime menus (chat+user+bot matched).
function animeQuotesMenu(msg, from, user, socket) {
  try {
    const ctx = (msg && msg.message && msg.message.extendedTextMessage &&
      msg.message.extendedTextMessage.contextInfo) || {};
    return !!animeMenuMatch(ctx.stanzaId || '', from, user, animeMyBotNumber(socket));
  } catch (e) { return false; }
}

function animeThrottleEntry(chat, user) {
  const key = animeSessionKey(chat, user);
  let e = animeThrottle.get(key);
  // Stale-entry cleanup threshold must be >= the nudge window: wiping a stale
  // entry resets its timestamps, which would silently cap the nudge window.
  // Only wipe entries that were actually used (lastActivity > 0): a fresh
  // entry starts at 0, and wiping it would destroy a just-set search stamp.
  if (e && e.lastActivity > 0 && Date.now() - e.lastActivity > Math.max(ANIME_SESSION_TTL, ANIME_NUDGE_WINDOW_MS)) {
    animeThrottle.delete(key);
    e = null;
  }
  // lastActivity starts at 0 (NOT now): only genuine anime activity — a .anime
  // search, a handled session reply, or a fired nudge — stamps it. If creation
  // stamped now, a never-user's first number reply would create an entry that
  // looks "recent" and pass the nudge gate.
  if (!e) { e = { reply: 0, nudge: 0, search: 0, searchWarn: 0, busy: false, lastActivity: 0 }; animeThrottle.set(key, e); }
  return e;
}

function animeSessionKey(chat, user) { return `${chat || ''}::${animeNormUser(user)}`; }

function animeGetSession(chat, user) {
  const key = animeSessionKey(chat, user);
  const s = animeSessions.get(key);
  if (!s) return null;
  if (Date.now() - s.createdAt > ANIME_SESSION_TTL) { animeSessions.delete(key); return null; }
  return s;
}

function animeSaveSession(chat, user, session) {
  const key = animeSessionKey(chat, user);
  if (session.timer) clearTimeout(session.timer);
  session.createdAt = Date.now();
  session.timer = setTimeout(() => animeSessions.delete(key), ANIME_SESSION_TTL);
  animeSessions.set(key, session);
}

function animeDropSession(chat, user) {
  const key = animeSessionKey(chat, user);
  const s = animeSessions.get(key);
  if (s && s.timer) clearTimeout(s.timer);
  animeSessions.delete(key);
}

function animeHasSession(sender) {
  const u = animeNormUser(sender);
  if (!u) return false;
  for (const [key] of animeSessions) if (key.endsWith('::' + u)) return true;
  return false;
}

function animeClearSessions(sender) {
  const u = animeNormUser(sender);
  for (const [key] of animeSessions) if (key.endsWith('::' + u)) animeSessions.delete(key);
  for (const [key] of animeThrottle) if (key.endsWith('::' + u)) animeThrottle.delete(key);
}

// Bot number that created the session (multi-bot ownership guard).
function animeMyBotNumber(socket) {
  return String((socket && socket.user && socket.user.id) || '').split(':')[0].split('@')[0] || '';
}

// Recursively dig a readable string out of an API error payload (FastAPI
// detail can be a plain string, a list of validation errors, or a nested
// object like {status, body, headers} — never stringify an object, that
// produces the useless "[object Object]").
function animeExtractApiMsg(node, depth) {
  try {
    if (node == null) return '';
    if (typeof node === 'string') return node.trim();
    if (typeof node === 'number') return String(node);
    if (Array.isArray(node)) {
      for (const x of node) {
        const s = animeExtractApiMsg(x, depth + 1);
        if (s) return s;
      }
      return '';
    }
    if (typeof node === 'object') {
      // FastAPI validation errors carry msg/message; the miruro wrapper puts
      // the upstream status in "status" and the page in "body".
      for (const k of ['msg', 'message', 'detail']) {
        const v = node[k];
        if (v != null) {
          const s = animeExtractApiMsg(v, depth + 1);
          if (s && s.length > 3) return s;
        }
      }
      // A Cloudflare challenge page in "body" (miruro pipe block).
      const body = node.body;
      if (typeof body === 'string' && (/Just a moment|challenge-platform|Attention Required/i.test(body))) {
        return `miruro.tv is blocking automated requests (Cloudflare). Try again later or use *.animeheaven* instead.`;
      }
      if (typeof body === 'string' && body.length > 3) return body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140);
      return '';
    }
    return '';
  } catch (e2) { return ''; }
}

function animeApiError(e) {
  // Never surface the full URL to users or logs.
  const msg = String((e && e.message) || e || 'Unknown error').replace(/https?:\/\/\S+/gi, '[url]');
  const errData = (e && e.response && e.response.data) || {};
  const apiMsg = errData && (errData.detail || errData.message || errData.error);
  const friendly = animeExtractApiMsg(apiMsg, 0).replace(/https?:\/\/\S+/gi, '[url]').slice(0, 140);
  if (e && e.code === 'ECONNABORTED') return 'The anime API timed out. Please try again.';
  if (e && e.response) {
    const s = e.response.status;
    if (s === 401 || s === 403) return friendly ? `The anime API rejected the request: "${friendly}"` : 'The anime API rejected the request.';
    if (s === 404) return 'The anime was not found on the API.';
    if (s >= 500) return 'The anime API is temporarily unavailable.';
    if (friendly) return `The anime API returned an error: "${friendly}"`;
  }
  return msg;
}

async function animeApiSearch(query) {
  const url = `${ANIME_API_BASE()}/search?query=${encodeURIComponent(query)}&per_page=${ANIME_MAX_SEARCH_RESULTS}`;
  const res = await axios.get(url, { timeout: ANIME_API_TIMEOUT });
  const data = res && res.data;
  if (!data || typeof data !== 'object') throw new Error('Invalid JSON from search API');
  if (!Array.isArray(data.results)) throw new Error('Search API returned no results');
  return data.results;
}

async function animeApiInfo(animeId) {
  const url = `${ANIME_API_BASE()}/info/${encodeURIComponent(animeId)}`;
  const res = await axios.get(url, { timeout: ANIME_API_TIMEOUT });
  const data = res && res.data;
  if (!data || typeof data !== 'object') throw new Error('Invalid JSON from info API');
  return data;
}

async function animeApiEpisodes(animeId) {
  const url = `${ANIME_API_BASE()}/episodes/${encodeURIComponent(animeId)}`;
  const res = await axios.get(url, { timeout: ANIME_API_TIMEOUT });
  const data = res && res.data;
  if (!data || typeof data !== 'object') throw new Error('Invalid JSON from episodes API');
  return (data && data.providers) || {};
}

async function animeApiSources(epPath) {
  // epPath is the episode's full id, e.g. "watch/kiwi/113415/sub/animepahe-1".
  const url = `${ANIME_API_BASE()}/${epPath}`;
  const res = await axios.get(url, { timeout: ANIME_API_TIMEOUT });
  const data = res && res.data;
  if (!data || typeof data !== 'object') throw new Error('Invalid JSON from watch API');
  return data;
}

// Pick the best episode provider (kiwi = hard-subbed animepahe, then fallbacks).
function animePickProvider(providers) {
  if (!providers || typeof providers !== 'object') return null;
  for (const p of ANIME_PREFERRED_PROVIDERS) if (providers[p] && typeof providers[p] === 'object') return p;
  return Object.keys(providers)[0] || null;
}

// Collect per-category episode lists (sub / dub / others) from the best
// provider. Each category list is filled from the preferred provider first,
// then from any other provider that has it (so a missing dub on kiwi falls
// back to another provider's dub). Returns { provider, categories }.
function animeCollectCategories(providers) {
  if (!providers || typeof providers !== 'object') return { provider: null, categories: {} };
  const provider = animePickProvider(providers);
  const order = provider ? [provider, ...Object.keys(providers).filter(p => p !== provider)] : Object.keys(providers);
  const categories = {};
  for (const p of order) {
    const prov = providers[p];
    const eps = (prov && prov.episodes) || {};
    if (Array.isArray(eps)) {
      if (!categories.sub) categories.sub = eps.slice();
      continue;
    }
    for (const cat of Object.keys(eps)) {
      if (Array.isArray(eps[cat]) && eps[cat].length && !categories[cat]) {
        categories[cat] = eps[cat].slice();
      }
    }
    if (categories.sub && categories.dub) break;
  }
  return { provider, categories };
}

function animeStreamHeight(s) {
  if (!s) return 0;
  const h = s.resolution && Number(s.resolution.height);
  if (h) return h;
  const q = String(s.quality || '').toLowerCase();
  if (q === '4k' || q === '2160p' || q === '2160') return 2160;
  const n = parseInt(String(q).replace(/\D/g, ''), 10);
  return n || 0;
}

function animePickStream(streams) {
  if (!Array.isArray(streams) || !streams.length) return null;
  const hls = streams.filter(s => s && s.type === 'hls');
  const active = (hls.length ? hls : streams).filter(s => s && s.isActive !== false);
  const pool = (active.length ? active : (hls.length ? hls : streams)).slice();
  pool.sort((a, b) => animeStreamHeight(b) - animeStreamHeight(a));
  return pool[0] || null;
}

function animeTitleOf(r) {
  if (!r) return 'Unknown';
  const t = r.title || {};
  return t.english || t.romaji || t.native || 'Unknown';
}

// Light probe of the HLS stream URL (first chunk, stream destroyed immediately).
// Non-fatal: if it fails we still send the link (m3u8 may be region/time gated),
// but we warn so the user knows it could not be verified.
async function animeVerifyStream(streamUrl, referer) {
  try {
    const res = await axios.get(streamUrl, {
      timeout: 8000,
      responseType: 'stream',
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      headers: {
        'Referer': referer || ANIME_MIRURO_REFERER,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        'Accept': '*/*'
      }
    });
    return await new Promise((resolve) => {
      const timer = setTimeout(() => { try { res.data.destroy(); } catch (e) {} resolve(false); }, 8000);
      res.data.once('data', () => { clearTimeout(timer); try { res.data.destroy(); } catch (e) {} resolve(true); });
      res.data.once('error', () => { clearTimeout(timer); resolve(false); });
    });
  } catch (e) { return false; }
}

// Send / edit helpers (WhatsApp send failures are swallowed).
async function animeSendText(socket, to, text, quoted) {
  try { return await socket.sendMessage(to, { text }, { quoted: quoted || null }); } catch (e) { return null; }
}

// Fancy numbered list (❶ ❷ …) — WhatsApp-safe circled digits.
const ANIME_CIRCLED = ['❶','❷','❸','❹','❺','❻','❼','❽','❾','❿'];
function animeCircledNum(i) {
  return (i >= 1 && i <= ANIME_CIRCLED.length) ? ANIME_CIRCLED[i - 1] : `${i}.`;
}

// Send a text message with an attached image (poster/thumbnail). Falls back to
// plain text when the image cannot be fetched/sent — the flow NEVER dies or
// goes silent because of an image failure. Returns the sent message (image or
// text) so callers can record its key for reply-context ownership.
async function animeSendWithImage(socket, to, imageUrl, caption, quoted) {
  if (imageUrl && /^https?:\/\//i.test(String(imageUrl))) {
    try {
      const imgRes = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 15000 });
      return await socket.sendMessage(to, { image: Buffer.from(imgRes.data), caption }, { quoted: quoted || null });
    } catch (e) { /* image failed → fall back to plain text below */ }
  }
  return animeSendText(socket, to, caption, quoted);
}

async function animeEditOrSend(socket, to, key, text, quoted) {
  if (key) {
    try {
      // Baileys gives an EDIT its own NEW message id (generateWAMessage),
      // but the message the user sees — and therefore QUOTES — keeps the
      // ORIGINAL key's id. Returning the new edit id here made the caller
      // record a menu id that never matches any quote, so numbered replies
      // silently did nothing. Always return the original key on success.
      await socket.sendMessage(to, { text, edit: key });
      return { key };
    } catch (e) { /* fall through to send */ }
  }
  return animeSendText(socket, to, text, quoted);
}

async function animeDeleteMsg(socket, to, key) {
  if (!key) return;
  try { await socket.sendMessage(to, { delete: key }); } catch (e) {}
}

// ---------- Anime message builders ----------
function animeBuildUsage(prefix) {
  return `╭━━〔 🎬 *ANIME HEAVEN* 〕━━┈\n│\n│ ❌ *Missing anime name!*\n│\n│ 💡 *Usage:* ${prefix}anime <anime name>\n│ 📌 *Example:* ${prefix}anime Jujutsu Kaisen\n╰━━━━━━━━━━━━━━━━━━┈`;
}

function animeBuildSearchList(results, query) {
  const n = results.length;
  let txt = `╭━━〔 🎌 *𝐀𝐍𝐈𝐌𝐄 𝐒𝐄𝐀𝐑𝐂𝐇* 〕━━┈\n│\n`;
  if (query) txt += `│ 🔎 *Query:* ${query}\n`;
  txt += `│ 📚 *Results:* ${n}\n│\n`;
  results.forEach((r, i) => {
    const title = animeTitleOf(r);
    const line = title.length > 34 ? title.slice(0, 34) + '…' : title;
    txt += `│ ${animeCircledNum(i + 1)} ${line}\n│    └─ ID: ${r.id}\n`;
  });
  txt += `│\n├━━━━━━━━━━━━━━━━━━┈\n│ 💡 _Reply with 1-${n} to select_\n╰━━━━━━━━━━━━━━━━━━┈`;
  return txt;
}

function animeBuildDetails(d) {
  const title = animeTitleOf(d);
  const desc = String(d.description || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const short = desc.length > 240 ? desc.slice(0, 240) + '…' : desc;
  const genres = Array.isArray(d.genres) ? d.genres.slice(0, 3).join(', ') : 'N/A';
  const status = d.status || 'N/A';
  const eps = d.episodes != null ? d.episodes : 'N/A';
  const score = d.averageScore != null ? d.averageScore + '/100' : 'N/A';
  return `╭━━〔 🎌 *𝐀𝐍𝐈𝐌𝐄 𝐃𝐄𝐓𝐀𝐈𝐋𝐒* 〕━━┈\n│\n│ 🎬 *Title:* ${title}\n│ 📺 *Episodes:* ${eps}\n│ 📅 *Status:* ${status}\n│ ⭐ *Rating:* ${score}\n│ 🏷️ *Genres:* ${genres}\n│\n│ 📝 *Description:*\n│ ${short || 'N/A'}\n╰━━━━━━━━━━━━━━━━━━┈`;
}

function animeBuildEpisodePage(title, episodes, page, perPage, category, lists) {
  const start = (page - 1) * perPage;
  const pageEps = episodes.slice(start, start + perPage);
  const total = episodes.length;
  const pages = Math.ceil(total / perPage);
  const hasSub = !!(lists && lists.sub && lists.sub.length);
  const hasDub = !!(lists && lists.dub && lists.dub.length);
  const audio = category === 'dub' ? '🎧 *Dubbed*' : '🎧 *Subbed*';
  let txt = `╭━━〔 📺 *EPISODES* 〕━━┈\n│\n`;
  if (title) txt += `│ 🎬 *${title}*\n│ ${audio}\n│\n`;
  else txt += `│ ${audio}\n│\n`;
  pageEps.forEach((ep, i) => {
    const epTitle = ep && ep.title && String(ep.title) !== `Episode ${ep.number}` ? ` — ${ep.title}` : '';
    txt += `│ ${animeCircledNum(start + i + 1)} Episode ${ep.number}${epTitle}\n`;
  });
  txt += `│\n├━━━━━━━━━━━━━━━━━┈\n`;
  if (pages > 1) {
    txt += `│ 📄 *Page ${page}/${pages}*\n`;
    if (page < pages) txt += `│ ➡️ Reply *more* for the next page\n`;
    if (page > 1) txt += `│ ⬅️ Reply *back* for the previous page\n`;
  }
  if (category !== 'dub' && hasDub) txt += `│ 🔁 Reply *dub* for Dubbed\n`;
  if (category === 'dub' && hasSub) txt += `│ 🔁 Reply *sub* for Subbed\n`;
  txt += `│ 💡 *Reply with an episode number*\n╰━━━━━━━━━━━━━━━━━━┈`;
  return txt;
}

function animeBuildResult(anime, ep, stream, verified, category) {
  const audio = category === 'dub' ? '🎧 *Dubbed*' : '🎧 *Subbed*';
  const note = verified === false
    ? '⚠️ _Stream could not be verified right now — it may be region/time-gated._'
    : '📌 _HLS stream — open in a browser, VLC or MX Player._';
  return `╭━━〔 ✅ *EPISODE READY* 〕━━┈\n│\n│ 🎬 *${anime.title}*\n│ 📺 *Episode ${ep.number}*\n│ ${audio}\n│ 🎞️ *Quality:* ${stream.quality || 'auto'}\n│\n│ 🔗 *Stream:* ${stream.url}\n│\n│ ${note}\n╰━━━━━━━━━━━━━━━━━━┈\n${config.BOT_FOOTER}`;
}

// ---------- Anime numbered-reply flow (inline handler) ----------
// STRICT reply-context ownership: a reply is processed ONLY when it QUOTES a
// message that THIS bot sent for THIS user's active anime flow (see
// animeMenuMatch — chat + user + bot + step all must line up). Any other
// number — a plain "1", a poll answer, another bot's menu — is ignored here
// and never produces "Invalid episode number" / "Invalid anime number" spam.
async function handleAnimeReply(socket, msg, from, sender, opts) {
  try {
    const raw = msg && msg.message;
    const body = String(
      (raw && (raw.conversation ||
        (raw.extendedTextMessage && raw.extendedTextMessage.text) ||
        (raw.templateButtonReplyMessage && raw.templateButtonReplyMessage.selectedId) ||
        (raw.buttonsResponseMessage && raw.buttonsResponseMessage.selectedButtonId) ||
        (raw.listResponseMessage && raw.listResponseMessage.singleSelectReply && raw.listResponseMessage.singleSelectReply.selectedRowId) ||
        '')) || ''
    ).trim();

    // The actual user (participant in groups, remoteJid in DMs) — sessions are
    // keyed chat::user so two users in one chat never share a flow.
    const msgUser = (() => {
      const k = msg && msg.key;
      if (!k) return sender;
      if (k.fromMe) return String((socket && socket.user && socket.user.id) || '').split(':')[0] + '@s.whatsapp.net';
      return k.participant || k.remoteJid || sender;
    })();
    const myNum = animeMyBotNumber(socket);

    // Reply-context gate #1: the message must QUOTE an anime menu we sent.
    // No quote (or a quote of anything else) → never ours, never a reply.
    const quotedMsgId = ((msg && msg.message && msg.message.extendedTextMessage &&
      msg.message.extendedTextMessage.contextInfo) || {}).stanzaId || '';
    const menuRec = animeMenuMatch(quotedMsgId, from, msgUser, myNum);
    if (!menuRec) return;

    const session = animeGetSession(from, msgUser);
    const throttle = animeThrottleEntry(from, msgUser);

    if (!session) {
      // The quoted anime menu exists but its session already expired: one short
      // nudge, throttled per user AND per chat (a group full of stale quotes
      // must still produce at most one nudge per 30s). Nothing else responds.
      if (!(opts && opts.otherPending)) {
        for (const [ck, ct] of animeChatNudge) {
          if (Date.now() - ct > ANIME_SESSION_TTL) animeChatNudge.delete(ck);
        }
        const chatOk = (Date.now() - (animeChatNudge.get(from) || 0)) >= ANIME_CHAT_NUDGE_COOLDOWN_MS;
        if (chatOk && (Date.now() - throttle.nudge) >= ANIME_NUDGE_COOLDOWN_MS) {
          throttle.nudge = Date.now();
          throttle.lastActivity = Date.now();
          animeChatNudge.set(from, Date.now());
          await animeSendText(socket, from, '❌ *Session expired.*\n\nPlease use *.anime <name>* again.', msg);
        }
      }
      return;
    }

    // Multi-bot ownership: only the bot that created the session processes it.
    if (session.botJid && myNum && session.botJid !== myNum) return;

    // Anti-spam: drop rapid repeats (min 2.5s gap on NUMERIC replies — the
    // spam vector, each valid number triggers an API fetch) and concurrent
    // replies (busy lock) for this chat::user. Non-numeric flow words
    // (more/back/sub/dub) are sub-second re-renders, so they bypass the gap
    // but are still serialized by the busy lock — a fast user is never
    // silently ignored mid-flow.
    const isNumericReply = /^\d{1,3}$/.test(body);
    if (throttle.busy) return;
    if (isNumericReply && Date.now() - throttle.reply < ANIME_REPLY_THROTTLE_MS) return;
    throttle.busy = true;
    throttle.lastActivity = Date.now();
    try {

    // Reply-context gate #2: the quoted menu must match the CURRENT session
    // step — AND, for the search step, must be the CURRENT session's search
    // list (a second .anime overwrites the session, so quoting a previous
    // search's list must never select from the newer results). Quoting an old
    // episode page after the flow moved on selects nothing either. All mismatches
    // get one gentle hint, never an "Invalid episode number".
    const isCurrentSearchList = session.step !== 'search' || !session.searchMessageId || quotedMsgId === session.searchMessageId;
    if (menuRec.step !== session.step || !isCurrentSearchList) {
      await animeSendText(socket, from, 'ℹ️ That list is no longer active — reply to the *latest* anime message.', msg);
      return;
    }

    // ---- Step 1: pick an anime from the search list ----
    if (session.step === 'search') {
      const num = /^\d{1,3}$/.test(body) ? parseInt(body, 10) : NaN;
      if (isNaN(num) || num < 1 || num > session.searchResults.length) {
        await animeSendText(socket, from, `❌ *Invalid anime number.* Reply with a number between *1-${session.searchResults.length}*.`, msg);
        return;
      }

      const selected = session.searchResults[num - 1];
      const animeId = selected && selected.id;
      if (!animeId) {
        animeDropSession(from, msgUser);
        await animeSendText(socket, from, '❌ *Missing anime ID.* Please search again with *.anime <name>*.', msg);
        return;
      }

      const loading = await animeSendText(socket, from, '📥 *Fetching anime details...*', msg);

      let details, categoryData;
      try {
        const [info, providers] = await Promise.all([
          animeApiInfo(animeId),
          animeApiEpisodes(animeId)
        ]);
        details = info;
        categoryData = animeCollectCategories(providers);
      } catch (e) {
        const errMsg = animeApiError(e);
        console.error('[anime] details error:', errMsg);
        animeDropSession(from, msgUser);
        await animeEditOrSend(socket, from, loading && loading.key, `❌ *Failed to fetch anime details.*\n\n_${errMsg}_`, msg);
        return;
      }

      const lists = categoryData && categoryData.categories ? categoryData.categories : {};
      const defaultCat = (lists.sub && lists.sub.length) ? 'sub' : (lists.dub && lists.dub.length ? 'dub' : Object.keys(lists)[0]);
      let episodes = (lists[defaultCat] || []).slice();
      episodes.sort((a, b) => (Number(a && a.number) || 0) - (Number(b && b.number) || 0));
      if (!episodes.length) {
        animeDropSession(from, msgUser);
        await animeEditOrSend(socket, from, loading && loading.key, '❌ *No episodes found* for this anime.', msg);
        return;
      }

      const poster = (selected && selected.coverImage && (selected.coverImage.extraLarge || selected.coverImage.large)) || null;
      session.selectedAnime = { title: animeTitleOf(details) || animeTitleOf(selected) || 'Unknown', animeId, poster };
      session.episodeLists = lists;
      session.category = defaultCat;
      session.episodes = episodes;
      session.step = 'episodes';
      session.page = 1;
      // Remember the page size this list was shown with so the nav (more/back)
      // always matches the displayed layout (single list for ≤50, 20/page above).
      session.perPage = episodes.length <= ANIME_PAGINATION_THRESHOLD ? episodes.length : ANIME_EPISODES_PER_PAGE;
      animeSaveSession(from, msgUser, session);

      await animeDeleteMsg(socket, from, loading && loading.key);

      // Details (with poster image when available, text otherwise).
      const detailText = animeBuildDetails(details);
      let sentDetails = false;
      let detailsMsgId = '';
      if (session.selectedAnime.poster) {
        try {
          const imgRes = await axios.get(session.selectedAnime.poster, { responseType: 'arraybuffer', timeout: 15000 });
          const imgSent = await socket.sendMessage(from, { image: Buffer.from(imgRes.data), caption: detailText }, { quoted: msg });
          sentDetails = true;
          detailsMsgId = imgSent && imgSent.key && imgSent.key.id;
        } catch (e) { /* poster failed → fall back to plain text below */ }
      }
      if (!sentDetails) {
        const txtSent = await animeSendText(socket, from, detailText, msg);
        detailsMsgId = txtSent && txtSent.key && txtSent.key.id;
      }

      const pageSent = await animeSendText(socket, from, animeBuildEpisodePage(session.selectedAnime.title, episodes, 1, session.perPage, session.category, session.episodeLists), msg);
      // Both the details card and the episode page are valid quote targets for
      // the episode-selection step.
      animeRecordMenu(detailsMsgId, from, msgUser, 'episodes', myNum);
      animeRecordMenu(pageSent && pageSent.key && pageSent.key.id, from, msgUser, 'episodes', myNum);
      return;
    }

    // ---- Step 2: pick an episode (with pagination) ----
    if (session.step === 'episodes') {
      const total = session.episodes.length;
      const perPage = session.perPage || ANIME_EPISODES_PER_PAGE;
      const pages = Math.max(1, Math.ceil(total / perPage));
      const lower = body.toLowerCase();

      // ---- Sub/Dub toggle ----
      if (lower === 'sub' || lower === 'dub') {
        const lists = session.episodeLists || {};
        const target = lists[lower] && lists[lower].length ? lower : null;
        if (target && target !== session.category) {
          const next = lists[target].slice().sort((a, b) => (Number(a && a.number) || 0) - (Number(b && b.number) || 0));
          session.category = target;
          session.episodes = next;
          session.page = 1;
          session.perPage = next.length <= ANIME_PAGINATION_THRESHOLD ? next.length : ANIME_EPISODES_PER_PAGE;
          animeSaveSession(from, msgUser, session);
          const pg = await animeSendText(socket, from, animeBuildEpisodePage(session.selectedAnime.title, next, 1, session.perPage, session.category, lists), msg);
          animeRecordMenu(pg && pg.key && pg.key.id, from, msgUser, 'episodes', myNum);
        } else if (target === session.category) {
          await animeSendText(socket, from, `ℹ️ *Already showing ${target === 'dub' ? 'Dubbed' : 'Subbed'} episodes.*`, msg);
        } else {
          await animeSendText(socket, from, `❌ *No ${lower === 'dub' ? 'Dubbed' : 'Subbed'} episodes available* for this anime.`, msg);
        }
        return;
      }

      if (lower === 'more' || lower === 'next' || lower === '>') {
        if (session.page < pages) {
          session.page += 1;
          animeSaveSession(from, msgUser, session);
          const pg = await animeSendText(socket, from, animeBuildEpisodePage(session.selectedAnime.title, session.episodes, session.page, perPage, session.category, session.episodeLists), msg);
          animeRecordMenu(pg && pg.key && pg.key.id, from, msgUser, 'episodes', myNum);
        }
        return;
      }
      if (lower === 'back' || lower === 'prev' || lower === '<') {
        if (session.page > 1) {
          session.page -= 1;
          animeSaveSession(from, msgUser, session);
          const pg = await animeSendText(socket, from, animeBuildEpisodePage(session.selectedAnime.title, session.episodes, session.page, perPage, session.category, session.episodeLists), msg);
          animeRecordMenu(pg && pg.key && pg.key.id, from, msgUser, 'episodes', myNum);
        }
        return;
      }

      const num = /^\d{1,3}$/.test(body) ? parseInt(body, 10) : NaN;
      if (isNaN(num) || num < 1 || num > total) {
        await animeSendText(socket, from, `❌ *Invalid episode number.* Reply with a number between *1-${total}*.`, msg);
        return;
      }

      const ep = session.episodes[num - 1];
      const epPath = ep && ep.id;
      if (!epPath) {
        animeDropSession(from, msgUser);
        await animeSendText(socket, from, '❌ *Missing episode source.* Please search again.', msg);
        return;
      }

      const loading = await animeSendText(socket, from, '🔗 *Generating stream link...*', msg);

      let srcData;
      try {
        srcData = await animeApiSources(epPath);
      } catch (e) {
        const errMsg = animeApiError(e);
        console.error('[anime] watch error:', errMsg);
        animeDropSession(from, msgUser);
        await animeEditOrSend(socket, from, loading && loading.key, `❌ *Failed to generate the stream link.*\n\n_${errMsg}_`, msg);
        return;
      }

      const stream = animePickStream(srcData && srcData.streams);
      if (!stream || !stream.url || !/^https?:\/\//i.test(stream.url)) {
        animeDropSession(from, msgUser);
        await animeEditOrSend(socket, from, loading && loading.key, '❌ *No playable stream found* for this episode. Please try another episode.', msg);
        return;
      }

      // Light probe (non-fatal): warn if the HLS stream can't be reached now.
      const verified = await animeVerifyStream(stream.url, stream.referer || ANIME_MIRURO_REFERER);

      await animeDeleteMsg(socket, from, loading && loading.key);

      // Result message, with the episode thumbnail attached when available.
      const resultText = animeBuildResult(session.selectedAnime, ep, stream, verified, session.category);
      let sentResult = false;
      const thumb = ep && ep.image;
      if (thumb) {
        try {
          const imgRes = await axios.get(thumb, { responseType: 'arraybuffer', timeout: 15000 });
          await socket.sendMessage(from, { image: Buffer.from(imgRes.data), caption: resultText }, { quoted: msg });
          sentResult = true;
        } catch (e) { /* thumbnail failed → fall back to plain text below */ }
      }
      if (!sentResult) await animeSendText(socket, from, resultText, msg);
      animeDropSession(from, msgUser);
      return;
    }

    } finally {
      throttle.busy = false;
      throttle.reply = Date.now();
      throttle.lastActivity = Date.now();
    }
  } catch (e) {
    console.error('[anime] reply error:', String((e && e.message) || e).replace(/https?:\/\/\S+/gi, '[url]'));
  }
}

// ---------------- CONFIG ----------------
const BOT_NAME_FANCY_DEFAULT = '★彡 𝐈𝐒𝐇𝐀𝐍-𝐗 𝐌𝐃 𝐏𝐑𝐎 彡★';

// ---- Per-user premium brand context ----
// Every reply shows the SENDER's own premium customization: their bot name,
// footer, image and logo. The resolved display config (sender's own premium
// config → else the recipient/session-owner's → else plain defaults) is bound
// to each incoming message's async context via AsyncLocalStorage, and the
// config.* getters below read that context — so the 100+ reply sites using
// config.BOT_NAME / config.BOT_FOOTER / config.IMAGE_PATH /
// config.RCD_IMAGE_PATH and ${BOT_NAME_FANCY} become per-user automatically.
const { AsyncLocalStorage } = require('async_hooks');
const botBrandAls = new AsyncLocalStorage();

// Dynamic global getter so every ${BOT_NAME_FANCY} usage resolves to the
// current user's premium bot name, or the default fancy name outside a
// message context (web/API/timers).
Object.defineProperty(global, 'BOT_NAME_FANCY', {
  configurable: true,
  get() {
    const s = botBrandAls.getStore();
    const n = s && s.bc && s.bc.botName;
    // BOT_NAME_DEFAULT (=== PREMIUM_DEFAULTS.botName) is used instead of
    // PREMIUM_DEFAULTS to avoid any TDZ risk if this getter ever runs during
    // module load before PREMIUM_DEFAULTS is initialized.
    return (n && n !== BOT_NAME_DEFAULT) ? n : BOT_NAME_FANCY_DEFAULT;
  }
});

const BOT_FOOTER_DEFAULT = '> _*🧑‍💻 𝐃𝙴𝚅𝙴𝙻𝙾𝙿𝙴𝚁: 𝐈𝚂𝙷𝙰𝙽-𝐗 × 𝐋𝙾𝚅𝙴𝙻𝚈 🇱🇰*_';
const BOT_NAME_DEFAULT = '𝗜𝗦𝗛𝗔𝗡-𝐗 𝗠𝗗 𝐏𝐑𝐎 🧑‍💻🇱🇰';
const BOT_IMAGE_DEFAULT = 'https://raw.githubusercontent.com/Dilu-x/OWNER_DATA/main/image_data/alive-clean.png';

// Resolved-config cache per sender jid. Long TTL is safe: the .botxxx
// set/reset paths invalidate immediately, and premium data is cached 30s.
const botBrandCache = new Map(); // jid -> { bc: object, ts: number }
// Short TTL so premium changes propagate quickly even when the set path's
// eager refresh is skipped (process restart, direct DB edit, aliveimg /
// menuheader saves) — one DB read per bot per minute is negligible.
const BOT_BRAND_CACHE_TTL = 60 * 1000; // 1 minute
function cachedBotBrand(jid) {
  const c = botBrandCache.get(String(jid || ''));
  return (c && (Date.now() - c.ts < BOT_BRAND_CACHE_TTL)) ? c.bc : null;
}
function setCachedBotBrand(jid, bc) {
  botBrandCache.set(String(jid || ''), { bc: bc || null, ts: Date.now() });
}
// Resolve + cache a sender's display config. Returns the bc so the caller can
// re-bind the current message context immediately (no one-message lag).
async function primeBotBrandCache(socket, jid) {
  try {
    const bc = await resolveDisplayBotConfig(socket, jid);
    setCachedBotBrand(jid, bc);
    return bc;
  } catch (e) { const d = { ...PREMIUM_DEFAULTS }; setCachedBotBrand(jid, d); return d; }
}

// Bind the current message's brand context (resolved config + the socket that
// received it). The socket lets interactive sessions record WHICH bot created
// them, so another bot can never process them.
function bindBrandContext(socket, bc) {
  botBrandAls.enterWith({ bc, sock: socket });
}
// JID of the bot currently processing this message ('' outside a handler).
function currentBotJid() {
  try {
    const s = botBrandAls.getStore();
    return (s && s.sock && s.sock.user && s.sock.user.id) ? jidNormalizedUser(s.sock.user.id) : '';
  } catch (e) { return ''; }
}
// True when the interactive session belongs to THIS bot. Sessions created
// before multi-bot binding carry no botJid → treated as owned (legacy).
function sessionOwnedByMe(session) {
  if (!session || !session.botJid) return true;
  const me = currentBotJid();
  return !me || session.botJid === me;
}

// ---- Multi-bot selection gate ----
// When several of this bot's sessions share a chat (typical: multiple paired
// numbers in one group), every session receives the same messages. A numbered
// menu / selection reply must therefore explicitly @mention the intended bot —
// otherwise NO session responds. Single-bot chats keep working as before.
const botChatCache = new Map(); // chatJid -> { count, ts }
const BOT_CHAT_CACHE_TTL = 30 * 1000; // 30s
function socketBotNumber(socket) {
  try { return String((socket && socket.user && socket.user.id) || '').split(':')[0].split('@')[0]; }
  catch (e) { return ''; }
}
async function activeBotCountInChat(socket, chatJid) {
  try {
    const key = String(chatJid || '');
    if (!key) return 1;
    const cached = botChatCache.get(key);
    if (cached && Date.now() - cached.ts < BOT_CHAT_CACHE_TTL) return cached.count;
    let count = 1;
    if (key.endsWith('@g.us')) {
      const meta = await socket.groupMetadata(key).catch(() => null);
      if (meta && Array.isArray(meta.participants)) {
        count = 0;
        for (const p of meta.participants) {
          const pnum = String((p && p.id) || '').split(':')[0].split('@')[0];
          if (pnum && activeSockets.has(pnum)) count++;
        }
        if (count < 1) count = 1; // at least this bot
      } else {
        // Fail-open with a log: can't tell how many bots share the chat, so
        // assume single-bot and let the ownership checks still protect flows.
        console.warn(`[multibot] groupMetadata failed for ${key}; treating as single-bot`);
      }
    }
    botChatCache.set(key, { count, ts: Date.now() });
    if (botChatCache.size > 500) {
      const now = Date.now();
      for (const [k, v] of botChatCache) {
        if (now - v.ts > BOT_CHAT_CACHE_TTL * 4) botChatCache.delete(k);
      }
    }
    return count;
  } catch (e) { return 1; }
}
// Resolve a mentioned jid down to its phone number. LID mentions (modern
// WhatsApp can emit @lid for migrated numbers) are mapped through the socket's
// lidMapping; phone jids pass through — reusing the project's established
// LID→phone resolver, which also normalizes both paths to digits so they
// match activeSockets keys. Unresolvable/empty inputs never match a session.
async function mentionedPhone(socket, m) {
  try {
    return await resolveSenderPhone(socket, m);
  } catch (e) { return ''; }
}
// True when this reply explicitly @mentions THIS bot's number (LID-aware).
async function replyMentionsMe(msg, socket) {
  try {
    const mentioned = (msg && msg.message && msg.message.extendedTextMessage &&
      msg.message.extendedTextMessage.contextInfo &&
      msg.message.extendedTextMessage.contextInfo.mentionedJid) || [];
    if (!mentioned || !mentioned.length) return false;
    const me = socketBotNumber(socket);
    if (!me) return false;
    for (const m of mentioned) {
      if ((await mentionedPhone(socket, m)) === me) return true;
    }
    return false;
  } catch (e) { return false; }
}
// How many of the @mentioned numbers are connected sessions of this process
// (LID-aware). For customization commands in a shared chat the target is only
// unambiguous when EXACTLY ONE connected bot is mentioned (zero → no target;
// two+ → ambiguous → reject). Multi-mention must never let several bots save.
async function countMentionedSessions(socket, msg) {
  try {
    const mentioned = (msg && msg.message && msg.message.extendedTextMessage &&
      msg.message.extendedTextMessage.contextInfo &&
      msg.message.extendedTextMessage.contextInfo.mentionedJid) || [];
    if (!mentioned || !mentioned.length) return 0;
    let n = 0;
    for (const m of mentioned) {
      const num = await mentionedPhone(socket, m);
      if (num && activeSockets.has(num)) n++;
    }
    return n;
  } catch (e) { return 0; }
}
// Message ids for which the Owner's own bot already sent the "target not
// specified" error — so when several owner-numbered sessions share a chat,
// only ONE bot replies (never duplicate error replies).
const perBotErrorSent = new Set();
// Central gate: may THIS bot process a selection reply in this chat?
async function mayProcessSelectionReply(socket, msg) {
  const chatJid = msg && msg.key && msg.key.remoteJid;
  if (!chatJid) return true;
  if ((await activeBotCountInChat(socket, chatJid)) <= 1) return true;
  return await replyMentionsMe(msg, socket);
}

const config = {
  AUTO_VIEW_STATUS: 'true',
  AUTO_LIKE_STATUS: 'true',
  AUTO_RECORDING: 'false',
  AUTO_REACT: 'false',
  AUTO_LIKE_EMOJI: ['❤️', '💸', '😇', '🍂', '💥', '💯', '🔥', '💫', '💎', '💗', '🤍', '🖤', '👀', '🙌', '🙆', '🚩', '🥰', '💐', '😎', '🤎', '✅', '🫀', '🧡', '😁', '🎧', '🌸', '🕊️', '🌷', '⛅', '🌟', '🗿', '💜', '💙', '🌝', '🖤','❓', '💤', '💚','☘️','❤️‍🩹','🫂','🙈','🍁','🙃','🧸','😘','🏴‍☠️','👀','❤️‍🔥'],
  PREFIX: '.',
  MAX_RETRIES: 3,
  // 🔞 Key for ikyyxd NSFW endpoints (.removeclothes / .removeclothesv2).
  IKYYXD_NSFW_KEY: process.env.IKYYXD_NSFW_KEY || 'kyzz',
  GROUP_INVITE_LINK: 'https://chat.whatsapp.com/DFsaaKIf6Kt5IHUq4IpOiB',
  // Dynamic per-user getters — the current message's sender (or the
  // recipient/session-owner fallback) drives the brand on every reply;
  // outside a message context they fall back to the default values.
  get RCD_IMAGE_PATH() {
    const s = botBrandAls.getStore();
    return (s && s.bc && s.bc.botLogo) || BOT_IMAGE_DEFAULT;
  },
  NEWSLETTER_JID: '120363408616895692@g.us',
  OTP_EXPIRY: 300000,
  WORK_TYPE: 'public',
  // 🎬 Miruro API base URL (env-overridable) — local FastAPI on this VPS.
  miruroApiBase: process.env.MIRURO_API_BASE || 'http://localhost:8003',
  // 🎬 Max movie file size offered by .movie/.mvfr (in MB). WhatsApp caps
  // document sends at 2GB server-side, so sizes above 2048MB are offered
  // but may fail on send. Env-overridable: MOVIE_MAX_SIZE_MB.
  // Default 3072 = 3GB: larger files stall the temp disk / upload slot and
  // make the bot feel frozen, so anything above the cap is filtered out.
  MOVIE_MAX_SIZE_MB: Number(process.env.MOVIE_MAX_SIZE_MB) || 3072,
  // 🔒 Main owners (hidden from public menus): 94755457054 + 94764642432.
  // 🔒 94720251446 = locked .setpremium executor (always allowed) — keep it in
  // OWNER_NUMBER so it also counts as a regular owner.
  OWNER_NUMBER: process.env.OWNER_NUMBER || '94755457054,94764642432,94720251446',
  // 📞 Public-facing owner number(s) shown in menus / system info / NSFW prompts.
  // Shows the main owners only — 94720251446 (premium executor) stays hidden.
  PUBLIC_OWNER_NUMBER: process.env.PUBLIC_OWNER_NUMBER || '94755457054,94764642432',
  // 🥷 Owner auto-react list: ONLY these numbers get the owner emoji reaction.
  OWNER_REACT_NUMBER: process.env.OWNER_REACT_NUMBER || '94755457054,94764642432',
  CHANNEL_LINK: 'https://whatsapp.com/channel/0029VbAe6Nt545uv1kaCDE3j',
  get BOT_NAME() {
    const s = botBrandAls.getStore();
    return (s && s.bc && s.bc.botName) || BOT_NAME_DEFAULT;
  },
  BOT_VERSION: '*8.0.0 ᴘʀᴏ*',
  OWNER_NAME: '© 𝙸𝚂𝙷𝙰𝙽-𝙼𝙰𝙳𝚄𝚂𝙰𝙽𝙺𝙴',
  get IMAGE_PATH() {
    const s = botBrandAls.getStore();
    return (s && s.bc && s.bc.botImage) || BOT_IMAGE_DEFAULT;
  },
  SET_IMAGE_PATH: 'https://raw.githubusercontent.com/Dilu-x/OWNER_DATA/refs/heads/main/image_data/settings-clean.png',
  get BOT_FOOTER() {
    const s = botBrandAls.getStore();
    return (s && s.bc && s.bc.botFooter) || BOT_FOOTER_DEFAULT;
  },
  BUTTON_IMAGES: { ALIVE: 'https://raw.githubusercontent.com/minibotsjsisns/IMAGE_DATA/refs/heads/main/file_000000005eac720896d40b719700b3c0.png' }
};

// ---------------- OWNER HELPERS ----------------
// Single source of truth for "is this the bot owner?" checks. Handles the
// comma-separated OWNER_NUMBER list and normalizes inputs so only bare
// phone numbers are compared. Strips "+", spaces, @s.whatsapp.net, @lid,
// @g.us and other JID suffixes, plus any :device suffix (e.g. :23), before
// extracting the digits.
function normalizeOwnerNumber(v) {
  let s = String(v || '');
  // Drop any JID suffix: 94778761926:23@s.whatsapp.net -> 94778761926:23
  s = s.split('@')[0];
  // Drop any device suffix: 94778761926:23 -> 94778761926
  s = s.split(':')[0];
  // Finally remove "+", spaces and anything else that is not a digit.
  return s.replace(/[^0-9]/g, '');
}

function getOwnerNumbers() {
  return String(config.OWNER_NUMBER || '')
    .split(',')
    .map(normalizeOwnerNumber)
    .filter(Boolean);
}

function isOwnerNumber(v) {
  try {
    const n = normalizeOwnerNumber(v);
    if (!n) return false;
    return getOwnerNumbers().includes(n);
  } catch (e) { return false; }
}

function getOwnerReactNumbers() {
  return String(config.OWNER_REACT_NUMBER || '')
    .split(',')
    .map(normalizeOwnerNumber)
    .filter(Boolean);
}

// Owner auto-react gate: a number qualifies only when it is in
// OWNER_REACT_NUMBER (falls back to the full OWNER_NUMBER list when unset).
function isOwnerReactNumber(v) {
  try {
    const n = normalizeOwnerNumber(v);
    if (!n) return false;
    const list = getOwnerReactNumbers();
    return list.length ? list.includes(n) : isOwnerNumber(n);
  } catch (e) { return false; }
}

// Resolve a (possibly @lid / @hosted.lid) sender JID down to its phone
// number. Modern WhatsApp often reports senders as opaque LID addresses
// (e.g. 52450694291648@lid) instead of phone JIDs, so the socket's LID
// mapping (same mechanism used by resolveAntiDeleteJid) is consulted.
// Returns a bare phone number string (or the raw digits when unmapped).
async function resolveSenderPhone(socket, jid) {
  try {
    const str = String(jid || '');
    if (!str) return '';
    if (str.endsWith('@lid') || str.endsWith('@hosted.lid')) {
      const mapping = socket?.signalRepository?.lidMapping;
      const res = mapping ? await mapping.getPNsForLIDs([str]).catch(() => null) : null;
      if (res && res[0] && res[0].pn) {
        return normalizeOwnerNumber(String(res[0].pn));
      }
    }
    return normalizeOwnerNumber(str);
  } catch (e) {
    return normalizeOwnerNumber(jid);
  }
}

// LID-aware owner check: resolves @lid senders to their phone number via
// resolveSenderPhone before checking membership in OWNER_NUMBER.
async function isOwnerUser(socket, jid) {
  try {
    const phone = await resolveSenderPhone(socket, jid);
    return phone ? isOwnerNumber(phone) : false;
  } catch (e) {
    return isOwnerNumber(jid);
  }
}

// ---------------- OFFLINE MESSAGE GUARD ----------------
// When the bot restarts or reconnects, WhatsApp re-sends every message that
// arrived while it was offline. Without this guard the bot would reply to /
// react to all those stale messages as if they were new. We record the moment
// the socket came online (socket.botOnlineAt — set in the connection 'open'
// handler) and skip any message timestamped clearly before that. A short grace
// window absorbs clock skew between WhatsApp's server timestamps and our clock.
const OFFLINE_MSG_GRACE_MS = 30 * 1000;

function isStaleOfflineMessage(socket, msg) {
  try {
    const onlineAt = socket && socket.botOnlineAt ? socket.botOnlineAt : 0;
    if (!onlineAt || !msg) return false;
    let rawTs = msg.messageTimestamp;
    if (rawTs && typeof rawTs === 'object' && typeof rawTs.toNumber === 'function') rawTs = rawTs.toNumber();
    const tsMs = Number(rawTs || 0) * 1000;
    if (!tsMs || !isFinite(tsMs)) return false;
    return tsMs < onlineAt - OFFLINE_MSG_GRACE_MS;
  } catch (e) {
    return false;
  }
}

// Chat skip guard: the bot must never process messages from its own channel
// (status@broadcast is the status feed). NEWSLETTER_JID used to always be the
// bot's own *channel* JID — but it can now hold a *group* JID (the bot's home
// group), and in that case the bot MUST still work there (commands, auto-reply,
// auto-react, etc.). So we only skip when NEWSLETTER_JID is actually a
// @newsletter channel JID.
function shouldSkipChat(jid) {
  if (!jid || jid === 'status@broadcast') return true;
  const nl = String(config.NEWSLETTER_JID || '');
  return nl.endsWith('@newsletter') && jid === nl;
}

// ---------------- GREETING DEFAULTS ----------------
// Group welcome / goodbye + personal (DM) greeting. Group welcome/goodbye are
// now per-group (stored in the groupconfigs collection, default OFF for new
// groups). These defaults provide the built-in text; placeholders support both
// {name}/{group} and ${username}/${groupName} styles.
const GREETING_DEFAULTS = {
  WELCOME_GROUP: 'off',
  WELCOME_GROUP_TEXT: '*╭━━━━━━━━━━━━━━━━━━⬣*\n*┃ ✨ 𝐖𝐄𝐋𝐂𝐎𝐌𝐄 ✨*\n*┃ 👋 Hey ${username}!*\n*┃ 🏠 ${groupName}*\n*┃*\n*┃ 📌 ① Read the group rules*\n*┃ 🤝 ② Respect everyone*\n*┃ 🚫 ③ No spam or links*\n*┃*\n*┃ Enjoy your stay! 💫*\n*╰━━━━━━━━━━━━━━━━━━⬣*\n> _*Made with 💙 · ISHAN-X MD PRO*_',
  WELCOME_GROUP_IMG: config.IMAGE_PATH,
  GOODBYE_GROUP: 'off',
  GOODBYE_GROUP_TEXT: '*╭━━━━━━━━━━━━━━━━━━⬣*\n*┃ ✨ 𝐆𝐎𝐎𝐃𝐁𝐘𝐄 ✨*\n*┃ 💫 ${username}, thanks for being here!*\n*┃ 🏠 ${groupName}*\n*┃*\n*┃ 🫂 We will miss you —*\n*┃ 🌟 Wishing you all the best!*\n*┃*\n*┃ Always welcome back 💙*\n*╰━━━━━━━━━━━━━━━━━━⬣*\n> _*Made with 💙 · ISHAN-X MD PRO*_',
  GOODBYE_GROUP_IMG: config.IMAGE_PATH,
  WELCOME_PERSONAL: 'on',
  WELCOME_PERSONAL_TEXT: `👋 *Hi {name}!*

Welcome to *{botname}* 💚

Type *{prefix}menu* to see all available commands.

> _Powered by ISHAN-X_`
};

// Replace placeholders in greeting text. Supports {name}/{group}/{count}/
// {botname}/{prefix} plus {user}/@user and ${username}/${groupName}/${count}.
function fillGreetingText(template, vars) {
  try {
    const name = vars.name || vars.user || 'there';
    const map = {
      '{name}': name,
      '{user}': vars.user || name,
      '@user': '@' + (vars.user || name),
      '{group}': vars.group || 'this group',
      '{count}': vars.count != null ? vars.count : '?',
      '{botname}': vars.botname || BOT_NAME_FANCY,
      '{prefix}': vars.prefix || '.'
    };
    let out = String(template);
    for (const k of Object.keys(map)) out = out.split(k).join(map[k]);
    out = out.split('${username}').join(name);
    out = out.split('${groupName}').join(vars.group || 'this group');
    out = out.split('${count}').join(vars.count != null ? vars.count : '?');
    return out;
  } catch (e) { return String(template || ''); }
}

// ---------------- MONGO SETUP ----------------
// No hardcoded fallback here on purpose: an earlier version of this file
// shipped with a live stranger's Atlas credentials baked in as the default,
// so anyone who forgot to set MONGO_URI silently connected to that
// person's database instead of their own. Set MONGO_URI as an environment
// variable on your host (panel → Startup/Variables) instead of editing this
// file — that way your credentials never end up in a file you might share
// or re-upload.
const MONGO_URI = process.env.MONGO_URI || '';
const MONGO_DB = process.env.MONGO_DB || 'ISHAN-CLOUD';
let mongoClient, mongoDB;
if (!MONGO_URI) {
  console.error('[mongo] MONGO_URI is not set — set it as an environment variable. MongoDB-backed features (sessions, settings, etc.) will not work until this is configured.');
}
;

// In-memory cache for user configs to avoid frequent DB reads
const userConfigCache = new Map();
const USER_CONFIG_CACHE_TTL = 30 * 1000; // 30 seconds
// In-memory cache for per-group welcome/goodbye configs
const groupConfigCache = new Map();

// ==================== NANO BANANA AI IMAGE EDIT SESSIONS ====================
// Multi-stage sessions for .nanoedit / .nanobanana (keyed per user JID)
const nanoSession = new Map();

async function getBuffer(url) {
  const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 60000 });
  return Buffer.from(response.data);
}

async function uploadToCDN(buffer) {
  const FormData = require('form-data');
  const tempFilePath = path.join(os.tmpdir(), `nano_${Date.now()}.jpg`);
  fs.writeFileSync(tempFilePath, buffer);
  try {
    const form = new FormData();
    form.append('fileToUpload', fs.createReadStream(tempFilePath), { filename: `nano_${Date.now()}.jpg`, contentType: 'image/jpeg' });
    form.append('reqtype', 'fileupload');
    const response = await axios.post('https://catbox.moe/user/api.php', form, { headers: { ...form.getHeaders(), 'Accept': '*/*' }, timeout: 30000 });
    if (!response.data || typeof response.data !== 'string') throw new Error('Invalid response from Catbox');
    return response.data.trim();
  } finally {
    try { fs.unlinkSync(tempFilePath); } catch (e) {}
  }
}

async function nanoExtractImage(msg, args) {
  let prompt = (args || []).join(' ').trim();
  let imageUrl = null;
  const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
  if (quoted?.imageMessage) {
    const stream = await downloadContentFromMessage(quoted.imageMessage, 'image');
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const buffer = Buffer.concat(chunks);
    imageUrl = await uploadToCDN(buffer);
  }
  if (!imageUrl) {
    const urlMatch = (prompt || '').match(/https?:\/\/\S+/i);
    if (urlMatch) {
      imageUrl = urlMatch[0];
      prompt = prompt.replace(imageUrl, '').trim();
    } else if (quoted?.extendedTextMessage?.text) {
      const murl = quoted.extendedTextMessage.text.match(/https?:\/\/\S+/i);
      if (murl) imageUrl = murl[0];
    }
  }
  return { prompt, imageUrl };
}

function clearNanoSession(userJid) {
  const s = nanoSession.get(userJid);
  if (s && s.timer) clearTimeout(s.timer);
  nanoSession.delete(userJid);
}

async function runNanoJob(socket, msg, chatJid, userJid, endpoint, extractResult) {
  const procStages = ['*P R O C E S S I N G*', '*P R O C E S S I N G* ·', '*P R O C E S S I N G* ··'];
  const procMsg = await socket.sendMessage(chatJid, { text: procStages[0] }, { quoted: msg });
  let procIdx = 0;
  const procInterval = setInterval(async () => {
    procIdx = (procIdx + 1) % procStages.length;
    try { await socket.sendMessage(chatJid, { text: procStages[procIdx], edit: procMsg.key }); } catch (e) {}
  }, 400);
  try {
    const { data } = await axios.get(endpoint, { timeout: 60000 });
    if (data.status === false) throw new Error('API returned unsuccessful status');
    let resultUrl = extractResult ? extractResult(data) : null;
    if (!resultUrl) resultUrl = data?.result?.image || data?.result?.result_url || data?.result;
    if (!resultUrl) throw new Error('No image URL in response');
    clearInterval(procInterval);
    await socket.sendMessage(chatJid, { delete: procMsg.key }).catch(() => {});
    let sent = false;
    try {
      const imgBuf = await getBuffer(resultUrl);
      await socket.sendMessage(chatJid, { image: imgBuf, mimetype: 'image/jpeg' }, { quoted: msg });
      sent = true;
    } catch (e) {}
    if (!sent) await socket.sendMessage(chatJid, { image: { url: resultUrl }, mimetype: 'image/jpeg' }, { quoted: msg }).catch(() => {});
    clearNanoSession(userJid);
  } catch (e) {
    clearInterval(procInterval);
    await socket.sendMessage(chatJid, { delete: procMsg.key }).catch(() => {});
    clearNanoSession(userJid);
    throw e;
  }
}

async function handleNanoSessionReply(socket, msg, chatJid, userJid, session, num) {
  try {
    // nanoedit stage 1: engine selection (1-4)
    if (session.stage === 'select_engine') {
      if (num < 1 || num > 4) return;
      const engines = ['flux', 'nano', 'banana', 'default'];
      session.engine = engines[num - 1];
      session.stage = 'select_version';
      session.botJid = currentBotJid();
      rearmSessionTimer(nanoSession, userJid, session);
      nanoSession.set(userJid, session);
      await socket.sendMessage(chatJid, { text: `*🍌 NANO BANANA*\n\n*⚙️ Choose a version:*\n\n*1* V1\n*2* V2\n*3* V3\n\n_Reply 1-3_\n\n${config.BOT_FOOTER}` }, { quoted: msg });
      return;
    }
    // nanoedit stage 2: version selection (1-3) -> process
    if (session.stage === 'select_version') {
      if (num < 1 || num > 3) return;
      session.version = num;
      const { prompt, imageUrl } = session;
      const apiUrl = `https://api.ikyyxd.my.id/edit/nanobananav3?prompt=${encodeURIComponent(prompt)}&url=${encodeURIComponent(imageUrl)}`;
      try {
        await runNanoJob(socket, msg, chatJid, userJid, apiUrl);
      } catch (e) {
        await socket.sendMessage(chatJid, { text: `*❌ Generation failed. Please try again.*\n\n${config.BOT_FOOTER}` }, { quoted: msg });
      }
      return;
    }
    // nanobanana: model selection (1-4) -> process
    if (session.modelSelect) {
      if (num < 1 || num > 4) return;
      const { prompt, imageUrl } = session;
      let endpoint = '';
      if (num === 1) endpoint = `https://api.ikyyxd.my.id/edit/nanobanana?image=${encodeURIComponent(imageUrl)}&prompt=${encodeURIComponent(prompt)}`;
      else if (num === 2) endpoint = `https://api.ikyyxd.my.id/edit/nanobananav2?prompt=${encodeURIComponent(prompt)}&url=${encodeURIComponent(imageUrl)}`;
      else if (num === 3) endpoint = `https://api.ikyyxd.my.id/edit/nanobananav3?prompt=${encodeURIComponent(prompt)}&url=${encodeURIComponent(imageUrl)}`;
      else if (num === 4) endpoint = `https://api.ikyyxd.my.id/edit/flux2pro?prompt=${encodeURIComponent(prompt)}&url=${encodeURIComponent(imageUrl)}`;
      try {
        await runNanoJob(socket, msg, chatJid, userJid, endpoint, (data) => {
          if (num === 1) return data.result;
          if (num === 2) return data.result?.image;
          return data.result?.result_url;
        });
      } catch (e) {
        await socket.sendMessage(chatJid, { text: `*❌ Editing failed. Try another model.*\n\n${config.BOT_FOOTER}` }, { quoted: msg });
      }
      return;
    }
  } catch (e) {
    console.error('[NANO LISTENER ERROR]', e);
    clearNanoSession(userJid);
    await socket.sendMessage(chatJid, { text: `*❌ An error occurred.*\n\n${config.BOT_FOOTER}` }, { quoted: msg }).catch(() => {});
  }
}

// ==================== SONG DOWNLOADER SESSIONS ====================
const songState = new Map();

function clearSongState(userJid) {
  const s = songState.get(userJid);
  if (s && s.timer) clearTimeout(s.timer);
  songState.delete(userJid);
}

// Re-arm the auto-expiry timer for a multi-step session (song / nano) so the
// flow keeps waiting for the user's next option reply instead of silently
// expiring mid-selection. Returns the same session object.
function rearmSessionTimer(map, key, session, ttl = 120000) {
  if (!session) return session;
  if (session.timer) clearTimeout(session.timer);
  session.timer = setTimeout(() => map.delete(key), ttl);
  return session;
}

// Cooldown so a known-dead downloader is skipped on later tries (the
// @dark-yasiya/scrap download API has been down for days — no point waiting
// on it for every single download).
let dyScrapDlDownSince = 0;
const DY_SCRAP_DL_COOLDOWN_MS = 10 * 60 * 1000;

// Cheap probe: confirm the direct link actually streams (first bytes arrive)
// before it may win a race. IP-locked/expired CDN links (googlevideo URLs
// signed for the API's IP, savetube expiries) would otherwise "win" with a
// URL that 403s when the bot streams it — exactly the silent failures users
// saw before.
async function songLinkOk(link) {
  try {
    const res = await axios({ method: 'get', url: link, responseType: 'stream', timeout: 10000, maxContentLength: Infinity, maxBodyLength: Infinity, headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': '*/*' } });
    return await new Promise((resolve) => {
      const timer = setTimeout(() => { try { res.data.destroy(); } catch (e) {} resolve(false); }, 10000);
      res.data.once('data', () => { clearTimeout(timer); try { res.data.destroy(); } catch (e) {} resolve(true); });
      res.data.once('error', () => { clearTimeout(timer); resolve(false); });
    });
  } catch (e) { return false; }
}

async function songGetDownload(videoUrl) {
  const apis = [
    // Primary: ikyyxd ytmp4 → savetube CDN mp4 (fetchable from anywhere) —
    // converted to MP3 before sending. Verified live — this is the only
    // reliably-fetchable audio source right now. ikyyxd ytmp3 returns an
    // IP-locked googlevideo URL, and the arslan/xwolf/ryzendesu/giftedtech
    // ytmp3 endpoints are all dead (empty/timeout/domain-for-sale).
    { url: `https://api.ikyyxd.my.id/download/ytmp4?q=${encodeURIComponent(videoUrl)}`, parse: (data) => data?.status && data?.result?.VideoUrl?.url ? { url: data.result.VideoUrl.url, title: data.result.title || null } : null },
    // Fallback: arslan ytmp4 → ydl.ymcdn.org mp4 (also fetchable) — converted
    // to MP3 before sending.
    { url: `https://arslan-apis-v2.vercel.app/download/ytmp4?url=${encodeURIComponent(videoUrl)}`, parse: (data) => data?.status && data?.result?.download?.url ? { url: data.result.download.url, title: data.result.metadata?.title || null } : null }
  ];
  // Run ALL APIs in parallel — the FIRST one whose URL verifies as a real
  // stream wins. Losers stay pending (never resolve) so the race ends the
  // instant the fastest working API responds. The ikyyxd ytmp4 endpoint needs
  // up to ~16s (it generates the savetube CDN link on demand), so the cap is
  // 28s — the animated "DATABASE LOADING" message covers the wait. Old code
  // ran 4×30s sequentially (up to 120s).
  let winner = null;
  const stall = new Promise(() => {});
  await Promise.race([
    ...apis.map((api) => (async () => {
      try {
        const res = await axios.get(api.url, { timeout: 25000 });
        const r = api.parse(res.data);
        if (r && r.url && (await songLinkOk(r.url))) { winner = r; return; }
        return stall; // invalid/dead link → stay pending, lose the race
      } catch (e) {
        return stall; // error/timeout → stay pending, lose the race
      }
    })()),
    new Promise((res) => setTimeout(() => res(), 28000))
  ]);
  return winner;
}

// Multi-API YouTube VIDEO (mp4) downloader. Two-phase so the REQUESTED quality
// is honored: phase 1 races the quality-aware APIs (movanest, nntech) — the
// first valid direct link wins (12s cap each, 15s overall). If BOTH fail,
// phase 2 falls back to arslan (no quality param — always 360p), so the user
// still gets a video instead of an error. The old giftedtech.web.id APIs are
// dead (DNS gone) — removed. Returns { link, title, thumb, label } or null.
// Cheap probe: read the FIRST stream chunk of a direct link and check for the
// mp4 "ftyp" box. Dead CDN links (e.g. savetube's expired media URLs, which
// 404) are rejected here so WhatsApp never fetches a broken URL — that fetch
// failure is exactly what shows as "something is wrong with the video file".
const VIDEO_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
async function videoLinkCheck(link) {
  try {
    const res = await axios({ method: 'get', url: link, responseType: 'stream', timeout: 12000, maxContentLength: Infinity, maxBodyLength: Infinity, headers: { 'User-Agent': VIDEO_UA, 'Accept': '*/*' } });
    return await new Promise((resolve) => {
      const timer = setTimeout(() => { try { res.data.destroy(); } catch (e) {} resolve(false); }, 12000);
      res.data.once('data', (c) => {
        clearTimeout(timer);
        try { res.data.destroy(); } catch (e) {}
        resolve(Buffer.isBuffer(c) && c.length > 8 && c.slice(4, 8).toString() === 'ftyp');
      });
      res.data.once('error', () => { clearTimeout(timer); resolve(false); });
    });
  } catch (e) { return false; }
}

async function videoGetDownload(videoUrl, quality = '360') {
  const stall = new Promise(() => {});
  // Race a list of API fetchers; the first one whose link VERIFIES as a real
  // mp4 stream wins (dead links keep the race pending until the timeout).
  async function raceApis(apis, timeoutMs) {
    let winner = null;
    await Promise.race([
      ...apis.map((api) => (async () => {
        try {
          const res = await axios.get(api.url, { timeout: 25000 });
          const r = api.parse(res.data);
          if (r && r.link && (await videoLinkCheck(r.link))) { winner = r; return; }
          return stall; // invalid/dead link → stay pending, lose the race
        } catch (e) {
          return stall; // error/timeout → stay pending, lose the race
        }
      })()),
      new Promise((res) => setTimeout(() => res(), timeoutMs))
    ]);
    return winner;
  }
  // Confirmed-working providers (verified live): ikyyxd (savetube CDN, up to
  // 720p, fetchable from anywhere) and arslan (ydl.ymcdn.org). varhad is
  // Cloudflare-blocked and movanest/nntech/xwolf/ryzendesu/giftedtech are dead
  // or IP-locked, so they're removed. One race with a generous cap so
  // savetube's slow link generation is never cut off (old 8s caps killed it).
  return raceApis([
    {
      url: `https://api.ikyyxd.my.id/download/ytmp4?q=${encodeURIComponent(videoUrl)}`,
      parse: (d) => (d?.status && d?.result?.VideoUrl?.url) ? { link: d.result.VideoUrl.url, title: d.result.title || null, thumb: d.result.thumbnail || null, label: '720p' } : null
    },
    {
      url: `https://arslan-apis-v2.vercel.app/download/ytmp4?url=${encodeURIComponent(videoUrl)}`,
      parse: (d) => {
        const url = d?.result?.download?.url;
        if (!(d?.status && url)) return null;
        return { link: url, title: d.result.metadata?.title || null, thumb: null, label: d.result.metadata?.quality || '360p' };
      }
    }
  ], 45000);
}

// Stream a verified direct link down to a local temp file using the same UA
// that made videoLinkCheck pass. Sending the LOCAL file (like .song does)
// uploads the bytes straight to WhatsApp — no external fetch, so the
// "something is wrong with the video file" error can never happen.
async function videoStreamToFile(downloadUrl, filePath) {
  const resp = await axios({ method: 'get', url: downloadUrl, responseType: 'stream', timeout: 900000, maxContentLength: Infinity, maxBodyLength: Infinity, headers: { 'User-Agent': VIDEO_UA, 'Accept': '*/*' } });
  const writer = fs.createWriteStream(filePath);
  // pipe() does NOT forward source-stream errors to the writer, so a dropped
  // connection mid-download would otherwise hang the send until the timeout.
  // Destroy the writer + reject fast so the caller shows "❌ Video Error"
  // instead of stalling for 15 minutes.
  resp.data.on('error', (err) => { try { writer.destroy(err); } catch (e) {} });
  resp.data.pipe(writer);
  await new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
}

// Temp dir used for video downloads (same location as the song pipeline).
function videoTempPath(ext = 'mp4') {
  const tempDir = path.join(os.tmpdir(), 'shitsu-temp');
  try { if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true }); } catch (e) {}
  return path.join(tempDir, `video_${Date.now()}_${Math.floor(Math.random() * 100000)}.${ext}`);
}

// WhatsApp video messages are limited (~16MB) — bigger files must go as a
// document or the send fails. Returns true when the file is too large to send
// as a `video:` message.
function videoTooBigForChat(filePath) {
  try {
    const size = fs.statSync(filePath).size;
    return size > 15 * 1024 * 1024; // 15MB safety margin under the 16MB cap
  } catch (e) { return false; }
}

// Sends a downloaded mp4 as an inline WhatsApp video; if WhatsApp rejects the
// inline video (unsupported codec / corrupt stream), it re-sends the same file
// as a document so the user still gets it. Documents skip WhatsApp's video
// codec validation, so this never surfaces the "video unsupported" error.
async function sendVideoWithDocFallback(socket, jid, tmpPath, opts = {}) {
  const title = opts.title || 'Video';
  const label = opts.label || '';
  const footerText = opts.footerText || '';
  const quoted = opts.quoted;
  const safeName = String(title).replace(/[^a-zA-Z0-9 _-]/g, '').substring(0, 60);
  const caption = `🎬 *${title}*

${label}

${footerText}`;
  const fileName = `${safeName}.mp4`;
  const media = { mimetype: 'video/mp4', caption };
  if (opts.jpegThumbnail) media.jpegThumbnail = opts.jpegThumbnail;
  try {
    await socket.sendMessage(jid, { ...media, video: { url: tmpPath } }, quoted ? { quoted } : undefined);
    return;
  } catch (videoErr) {
    console.warn('[mp4] inline video rejected, falling back to document:', videoErr && videoErr.message);
  }
  await socket.sendMessage(jid, { ...media, document: { url: tmpPath }, fileName }, quoted ? { quoted } : undefined);
}

async function songStreamToFile(downloadUrl, filePath) {
  const audioResponse = await axios({ method: 'get', url: downloadUrl, responseType: 'stream', timeout: 900000, maxContentLength: Infinity, maxBodyLength: Infinity, headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': '*/*' } });
  const writer = fs.createWriteStream(filePath);
  // pipe() does NOT forward source-stream errors to the writer, so a dropped
  // connection mid-download would otherwise hang the send forever. Destroy the
  // writer + reject fast so the caller shows a real error instead of stalling.
  audioResponse.data.on('error', (err) => { try { writer.destroy(err); } catch (e) {} });
  audioResponse.data.pipe(writer);
  await new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
}

// True when the file starts with real MP3 magic (ID3 tag or MPEG frame sync).
// False for webm/Opus (ikyyxd audio), mp4 containers, etc.
function looksLikeMp3(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(4);
    fs.readSync(fd, buf, 0, 4, 0);
    fs.closeSync(fd);
    if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return true; // ID3
    if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return true; // MPEG frame sync
    return false;
  } catch (e) { return false; }
}

// Transcode whatever container the source gave us (webm/Opus, mp4, ogg) into
// a real MP3 so WhatsApp always receives a valid audio/mpeg file. Uses the
// bundled ffmpeg-static binary (same one the voice-note pipeline uses).
async function ensureMp3(inputPath, outputPath) {
  const ffmpeg = require('fluent-ffmpeg');
  const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
  ffmpeg.setFfmpegPath(ffmpegInstaller.path);
  await new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .audioCodec('libmp3lame')
      .audioBitrate('128k')
      .format('mp3')
      .save(outputPath)
      .on('end', resolve)
      .on('error', reject);
  });
}

async function handleSongSessionReply(socket, msg, chatJid, userJid, state, num) {
  try {
    // Single stage: 1 = Audio, 2 = Document, 3 = Voice Note
    if (state.stage === 'select_format') {
      if (num < 1 || num > 3) return;
      const video = state.chosen;
      // Some backends return a videoId but no full `url` — reconstruct it so
      // the download always has a real YouTube URL to feed the APIs.
      const videoUrl = (video && video.url) || (video && video.videoId ? `https://youtu.be/${video.videoId}` : null);
      const wantAudio = num === 1;
      const wantVoice = num === 3;
      console.log(`[song] download started for "${(video && video.title) || 'Unknown'}" (${wantVoice ? 'voice note' : wantAudio ? 'audio' : 'document'})`);

      const loadingStages = ['*D A T A B A S E  L O A D I N G*', '*D A T A B A S E  L O A D I N G* ·', '*D A T A B A S E  L O A D I N G* ··'];
      const loadMsg = await socket.sendMessage(chatJid, { text: loadingStages[0] }, { quoted: msg });
      let loadIdx = 0;
      const loadInterval = setInterval(async () => {
        loadIdx = (loadIdx + 1) % loadingStages.length;
        try { await socket.sendMessage(chatJid, { text: loadingStages[loadIdx], edit: loadMsg.key }); } catch (e) {}
      }, 400);
      const stopLoading = async () => {
        clearInterval(loadInterval);
        await socket.sendMessage(chatJid, { delete: loadMsg.key }).catch(() => {});
      };

      try {
        // Race the @dark-yasiya/scrap downloader against the built-in
        // multi-API chain — whichever returns a URL FIRST wins. Old code
        // waited 8s on dy_scrap (usually dead) BEFORE touching the APIs,
        // making every download ~8s slower. 30s cap guarantees no hang while
        // still letting savetube's slow link generation finish.
        let dl = null;
        const stall = new Promise(() => {});
        const dyDown = (Date.now() - dyScrapDlDownSince) < DY_SCRAP_DL_COOLDOWN_MS;
        await Promise.race([
          (async () => {
            if (dyDown || !videoUrl) return stall; // in cooldown / no URL → stay pending
            try {
              const DY_SCRAP = require('@dark-yasiya/scrap');
              const dy_scrap = new DY_SCRAP();
              const resp = await Promise.race([
                dy_scrap.ytmp3(videoUrl),
                new Promise((_, rej) => setTimeout(() => rej(new Error('dy_scrap.ytmp3 timeout (8s)')), 8000))
              ]);
              const dyUrl = resp && resp.result && resp.result.download && resp.result.download.url;
              // Verify the URL actually streams before accepting it — dy_scrap
              // returns IP-locked googlevideo URLs that 403 when the bot fetches
              // them, which used to "win" the race and then fail mid-download.
              if (dyUrl && (await songLinkOk(dyUrl))) {
                dl = { url: dyUrl, title: video.title };
                dyScrapDlDownSince = 0; // recovered — clear the cooldown
                return;
              }
              dyScrapDlDownSince = Date.now(); // responded but unusable URL → mark down
              console.warn('[song] dy_scrap.ytmp3 returned no usable URL — API chain used');
              return stall;
            } catch (dyErr) {
              dyScrapDlDownSince = Date.now(); // failed → mark down for 10 min
              console.warn('[song] dy_scrap.ytmp3 failed — API chain used:', dyErr.message || dyErr);
              return stall;
            }
          })(),
          (async () => {
            const r = await songGetDownload(videoUrl);
            if (r && r.url) { dl = r; return; }
            return stall;
          })(),
          new Promise((res) => setTimeout(() => res(), 30000))
        ]);
        if (!dl) {
          await stopLoading();
          clearSongState(userJid);
          await socket.sendMessage(chatJid, { text: `*❌ DOWNLOAD FAILED*\n\nAll APIs are currently unavailable.\n\n${config.BOT_FOOTER}` }, { quoted: msg }).catch(() => {});
          return;
        }
        const tempDir = path.join(os.tmpdir(), 'shitsu-temp');
        if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
        const filePath = path.join(tempDir, `song_${Date.now()}.raw`);
        let mp3File = null;
        let oggFile = null;
        try {
          await songStreamToFile(dl.url, filePath);
          await stopLoading();
          // Normalize whatever container we got (webm/Opus audio, savetube mp4
          // fallback, or a real mp3) into a genuine MP3 before sending — a
          // mismatched container sent as audio/mpeg shows as a broken file.
          if (!looksLikeMp3(filePath)) {
            mp3File = path.join(tempDir, `song_${Date.now()}.mp3`);
            await ensureMp3(filePath, mp3File);
          } else {
            mp3File = filePath;
          }
          if (wantVoice) {
            // Convert MP3 → OGG/Opus so the song is delivered as a playable
            // voice note (same pipeline as .ytaap).
            const ffmpeg = require('fluent-ffmpeg');
            const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
            ffmpeg.setFfmpegPath(ffmpegInstaller.path);
            oggFile = path.join(tempDir, `song_${Date.now()}.ogg`);
            await new Promise((resolve, reject) => {
              ffmpeg(mp3File)
                .audioCodec('libopus')
                .audioBitrate('64k')
                .format('ogg')
                .save(oggFile)
                .on('end', resolve)
                .on('error', reject);
            });
            await socket.sendMessage(chatJid, { audio: { url: oggFile }, mimetype: 'audio/ogg; codecs=opus', ptt: true }, { quoted: msg });
          } else if (wantAudio) {
            await socket.sendMessage(chatJid, { audio: { url: mp3File }, mimetype: 'audio/mpeg', fileName: `${(video && video.title) || (dl && dl.title) || 'Song'}.mp3`, ptt: false }, { quoted: msg });
          } else {
            await socket.sendMessage(chatJid, { document: { url: mp3File }, mimetype: 'audio/mpeg', fileName: `${((dl && dl.title) || (video && video.title) || 'Song').substring(0, 100)}.mp3` }, { quoted: msg });
          }
        } finally {
          try { fs.unlinkSync(filePath); } catch (e) {}
          if (mp3File && mp3File !== filePath) { try { fs.unlinkSync(mp3File); } catch (e) {} }
          if (oggFile && fs.existsSync(oggFile)) { try { fs.unlinkSync(oggFile); } catch (e) {} }
        }
        clearSongState(userJid);
        console.log(`[song] download sent to ${chatJid} for "${(video && video.title) || (dl && dl.title) || 'Unknown'}"`);
      } catch (e) {
        await stopLoading();
        clearSongState(userJid);
        console.error('[SONG DL ERROR]', e);
        await socket.sendMessage(chatJid, { text: `*❌ Download error:* ${e.message || 'Please try again.'}\n\n${config.BOT_FOOTER}` }, { quoted: msg }).catch(() => {});
      }
      return;
    }
  } catch (e) {
    console.error('[SONG NAV ERROR]', e);
    clearSongState(userJid);
    await socket.sendMessage(chatJid, { text: `*❌ An error occurred.*\n\n${config.BOT_FOOTER}` }, { quoted: msg }).catch(() => {});
  }
}

// ==================== YTS SELECTION SESSIONS ====================
// Interactive .yts flow: the user replies a number to pick ONE YouTube result.
// Mirrors the song session pattern (keyed per user, auto-expires after 2 min).
const ytsState = new Map();

function clearYtsState(userJid) {
  const s = ytsState.get(userJid);
  if (s && s.timer) clearTimeout(s.timer);
  ytsState.delete(userJid);
}

// Reply handler for .yts: shows quality/download options for the SELECTED
// video only (reuses the existing down_* download commands via the generic
// row-selection system). Nothing else fires for this reply.
async function handleYtsSessionReply(socket, msg, chatJid, userJid, state, num, prefix) {
  try {
    if (!state || state.stage !== 'select_result') return;
    if (num < 1 || num > state.results.length) return;
    const video = state.results[num - 1];
    clearYtsState(userJid);
    delete pendingRowSelect[chatJid];
    const p = prefix || config.PREFIX;
    const qualityRows = [
      { label: '🎬 360p (Video)', id: `${p}down_360 ${video.url}` },
      { label: '🎬 480p (Video)', id: `${p}down_480 ${video.url}` },
      { label: '🎬 720p (Video)', id: `${p}down_720 ${video.url}` },
      { label: '🎬 1080p (Video)', id: `${p}down_1080 ${video.url}` },
      { label: '📂 360p (Document)', id: `${p}down_360d ${video.url}` },
      { label: '📂 480p (Document)', id: `${p}down_480d ${video.url}` },
      { label: '📂 720p (Document)', id: `${p}down_720d ${video.url}` },
      { label: '📂 1080p (Document)', id: `${p}down_1080d ${video.url}` }
    ];
    setPendingRowSelect(chatJid, qualityRows);
    const caption =
      `*┎━━━━━━━━━━━━━━❖●►*\n` +
      `*┃➤ \`🎬 Title\`    :* ${video.title}\n` +
      `*┃➤ \`💃 Channel\`  :* ${video.author?.name || 'Unknown'}\n` +
      `*┃➤ \`⏱ Duration\` :* ${video.timestamp}\n` +
      `*┃➤ \`👀 Views\`    :* ${video.views?.toLocaleString() || 'N/A'}\n` +
      `*┃➤ \`🔗 Link\`     :* ${video.url}\n` +
      `*┗━━━━━━━━━━━━━━❖●►*\n\n*📥 Select a quality:*\n${buildNumberedList(qualityRows)}\n\n*Reply with the number of your choice.*`;
    try {
      await socket.sendMessage(chatJid, { image: { url: video.thumbnail }, caption }, { quoted: msg });
    } catch (e) {
      await socket.sendMessage(chatJid, { text: caption }, { quoted: msg });
    }
  } catch (e) {
    console.error('[YTS NAV ERROR]', e);
    clearYtsState(userJid);
  }
}

async function initMongo() {
  try {
    if (mongoClient && mongoClient.topology && mongoClient.topology.isConnected && mongoClient.topology.isConnected()) return;
  } catch(e){}
  if (!MONGO_URI) {
    // Fail with a clear, actionable message instead of letting an empty
    // string reach the driver, which throws a confusing
    // "MongoParseError: Invalid scheme ..." that hides the real cause.
    throw new Error('[mongo] MONGO_URI is not set — set it as an environment variable (panel → Startup/Variables) before MongoDB-backed features can work.');
  }
  mongoClient = new MongoClient(MONGO_URI);
  await mongoClient.connect();
  mongoDB = mongoClient.db(MONGO_DB);

  sessionsCol = mongoDB.collection('sessions');
  numbersCol = mongoDB.collection('numbers');
  adminsCol = mongoDB.collection('admins');
  newsletterCol = mongoDB.collection('newsletter_list');
  configsCol = mongoDB.collection('configs');
  newsletterReactsCol = mongoDB.collection('newsletter_reacts');
  groupConfigsCol = mongoDB.collection('groupconfigs');
  userFootersCol = mongoDB.collection('userfooters');
  cinefrFootersCol = mongoDB.collection('cinefrfooters');
  mvfrFootersCol = mongoDB.collection('mvfrfooters');
  premiumUsersCol = mongoDB.collection('premiumusers');
  nsfwUsersCol = mongoDB.collection('nsfwusers');


  await sessionsCol.createIndex({ number: 1 }, { unique: true });
  await numbersCol.createIndex({ number: 1 }, { unique: true });
  await newsletterCol.createIndex({ jid: 1 }, { unique: true });
  await newsletterReactsCol.createIndex({ jid: 1 }, { unique: true });
  await configsCol.createIndex({ number: 1 }, { unique: true });
  await groupConfigsCol.createIndex({ groupId: 1 }, { unique: true });
  await userFootersCol.createIndex({ jid: 1 }, { unique: true });
  await cinefrFootersCol.createIndex({ jid: 1 }, { unique: true });
  await mvfrFootersCol.createIndex({ jid: 1 }, { unique: true });
  await premiumUsersCol.createIndex({ jid: 1 }, { unique: true });
  await nsfwUsersCol.createIndex({ jid: 1 }, { unique: true });

  console.log('✅ Mongo initialized and collections ready');
}

// ---------------- Mongo helpers ----------------

async function saveCredsToMongo(number, creds, keys = null) {
  try {
    await initMongo();
    const sanitized = number.replace(/[^0-9]/g, '');
    const doc = { number: sanitized, creds, keys, updatedAt: new Date() };
    await sessionsCol.updateOne({ number: sanitized }, { $set: doc }, { upsert: true });
    console.log(`Saved creds to Mongo for ${sanitized}`);
  } catch (e) { console.error('saveCredsToMongo error:', e); }
}

async function loadCredsFromMongo(number) {
  try {
    await initMongo();
    const sanitized = number.replace(/[^0-9]/g, '');
    const doc = await sessionsCol.findOne({ number: sanitized });
    return doc || null;
  } catch (e) { console.error('loadCredsFromMongo error:', e); return null; }
}

async function removeSessionFromMongo(number) {
  try {
    await initMongo();
    const sanitized = number.replace(/[^0-9]/g, '');
    await sessionsCol.deleteOne({ number: sanitized });
    console.log(`Removed session from Mongo for ${sanitized}`);
  } catch (e) { console.error('removeSessionToMongo error:', e); }
}

async function addNumberToMongo(number) {
  try {
    await initMongo();
    const sanitized = number.replace(/[^0-9]/g, '');
    await numbersCol.updateOne({ number: sanitized }, { $set: { number: sanitized } }, { upsert: true });
    console.log(`Added number ${sanitized} to Mongo numbers`);
  } catch (e) { console.error('addNumberToMongo', e); }
}

async function removeNumberFromMongo(number) {
  try {
    await initMongo();
    const sanitized = number.replace(/[^0-9]/g, '');
    await numbersCol.deleteOne({ number: sanitized });
    console.log(`Removed number ${sanitized} from Mongo numbers`);
  } catch (e) { console.error('removeNumberFromMongo', e); }
}

async function getAllNumbersFromMongo() {
  try {
    await initMongo();
    const docs = await numbersCol.find({}).toArray();
    return docs.map(d => d.number);
  } catch (e) { console.error('getAllNumbersFromMongo', e); return []; }
}

// Union of numbers from the sessions + numbers collections, so any number
// with a Mongo-saved session is always included for auto-reconnect even if
// its entry in the 'numbers' collection is missing.
async function getAllSessionNumbersFromMongo() {
  try {
    await initMongo();
    const [sessionDocs, numberDocs] = await Promise.all([
      sessionsCol.find({}, { projection: { number: 1 } }).toArray(),
      numbersCol.find({}, { projection: { number: 1 } }).toArray()
    ]);
    const set = new Set();
    (sessionDocs || []).forEach(d => { if (d.number) set.add(d.number); });
    (numberDocs || []).forEach(d => { if (d.number) set.add(d.number); });
    return Array.from(set);
  } catch (e) { console.error('getAllSessionNumbersFromMongo', e); return []; }
}

async function loadAdminsFromMongo() {
  try {
    await initMongo();
    const docs = await adminsCol.find({}).toArray();
    return docs.map(d => d.jid || d.number).filter(Boolean);
  } catch (e) { console.error('loadAdminsFromMongo', e); return []; }
}

async function addAdminToMongo(jidOrNumber) {
  try {
    await initMongo();
    const doc = { jid: jidOrNumber };
    await adminsCol.updateOne({ jid: jidOrNumber }, { $set: doc }, { upsert: true });
    console.log(`Added admin ${jidOrNumber}`);
  } catch (e) { console.error('addAdminToMongo', e); }
}

async function removeAdminFromMongo(jidOrNumber) {
  try {
    await initMongo();
    await adminsCol.deleteOne({ jid: jidOrNumber });
    console.log(`Removed admin ${jidOrNumber}`);
  } catch (e) { console.error('removeAdminFromMongo', e); }
}

async function addNewsletterToMongo(jid, emojis = []) {
  try {
    await initMongo();
    const doc = { jid, emojis: Array.isArray(emojis) ? emojis : [], addedAt: new Date() };
    await newsletterCol.updateOne({ jid }, { $set: doc }, { upsert: true });
    console.log(`Added newsletter ${jid} -> emojis: ${doc.emojis.join(',')}`);
  } catch (e) { console.error('addNewsletterToMongo', e); throw e; }
}

async function removeNewsletterFromMongo(jid) {
  try {
    await initMongo();
    await newsletterCol.deleteOne({ jid });
    console.log(`Removed newsletter ${jid}`);
  } catch (e) { console.error('removeNewsletterFromMongo', e); throw e; }
}

async function listNewslettersFromMongo() {
  try {
    await initMongo();
    const docs = await newsletterCol.find({}).toArray();
    return docs.map(d => ({ jid: d.jid, emojis: Array.isArray(d.emojis) ? d.emojis : [] }));
  } catch (e) { console.error('listNewslettersFromMongo', e); return []; }
}

async function saveNewsletterReaction(jid, messageId, emoji, sessionNumber) {
  try {
    await initMongo();
    const doc = { jid, messageId, emoji, sessionNumber, ts: new Date() };
    if (!mongoDB) await initMongo();
    const col = mongoDB.collection('newsletter_reactions_log');
    await col.insertOne(doc);
    console.log(`Saved reaction ${emoji} for ${jid}#${messageId}`);
  } catch (e) { console.error('saveNewsletterReaction', e); }
}

async function setUserConfigInMongo(number, conf) {
  try {
    await initMongo();
    const sanitized = number.replace(/[^0-9]/g, '');
    await configsCol.updateOne({ number: sanitized }, { $set: { number: sanitized, config: conf, updatedAt: new Date() } }, { upsert: true });
    try { userConfigCache.set(sanitized, { config: conf, ts: Date.now() }); } catch (e){}
  } catch (e) { console.error('setUserConfigInMongo', e); }
}

async function loadUserConfigFromMongo(number) {
  const sanitized = number.replace(/[^0-9]/g, '');
  // Check cache first
  try {
    const cached = userConfigCache.get(sanitized);
    if (cached && (Date.now() - (cached.ts || 0) < USER_CONFIG_CACHE_TTL)) {
      return cached.config;
    }
  } catch (e) { }

  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await initMongo();
      const doc = await configsCol.findOne({ number: sanitized });
      const conf = doc ? doc.config : null;
      try { userConfigCache.set(sanitized, { config: conf, ts: Date.now() }); } catch (e){}
      return conf;
    } catch (e) {
      lastErr = e;
      console.warn(`loadUserConfigFromMongo attempt ${attempt + 1} failed:`, e.message);
      if (attempt < 2) await delay(1000 * (attempt + 1));
    }
  }
  console.error('loadUserConfigFromMongo failed after 3 attempts:', lastErr);
  return null;
}

// ---------------- Per-group welcome/goodbye config helpers ----------------

async function setGroupConfigInMongo(groupId, conf) {
  try {
    await initMongo();
    await groupConfigsCol.updateOne({ groupId }, { $set: { groupId, config: conf, updatedAt: new Date() } }, { upsert: true });
    try { groupConfigCache.set(groupId, { config: conf, ts: Date.now() }); } catch (e){}
  } catch (e) { console.error('setGroupConfigInMongo', e); }
}

async function loadGroupConfigFromMongo(groupId) {
  if (!groupId) return null;
  try {
    const cached = groupConfigCache.get(groupId);
    if (cached && (Date.now() - (cached.ts || 0) < USER_CONFIG_CACHE_TTL)) {
      return cached.config;
    }
  } catch (e) { }

  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await initMongo();
      const doc = await groupConfigsCol.findOne({ groupId });
      const conf = doc ? doc.config : null;
      try { groupConfigCache.set(groupId, { config: conf, ts: Date.now() }); } catch (e){}
      return conf;
    } catch (e) {
      lastErr = e;
      console.warn(`loadGroupConfigFromMongo attempt ${attempt + 1} failed:`, e.message);
      if (attempt < 2) await delay(1000 * (attempt + 1));
    }
  }
  console.error('loadGroupConfigFromMongo failed after 3 attempts:', lastErr);
  return null;
}

// -------------- newsletter react-config helpers --------------

async function addNewsletterReactConfig(jid, emojis = ['🎀','🧚‍♀️','🎭']) {
  try {
    await initMongo();
    await newsletterReactsCol.updateOne({ jid }, { $set: { jid, emojis, addedAt: new Date() } }, { upsert: true });
    console.log(`Added react-config for ${jid} -> ${emojis.join(',')}`);
  } catch (e) { console.error('addNewsletterReactConfig', e); throw e; }
}

async function removeNewsletterReactConfig(jid) {
  try {
    await initMongo();
    await newsletterReactsCol.deleteOne({ jid });
    console.log(`Removed react-config for ${jid}`);
  } catch (e) { console.error('removeNewsletterReactConfig', e); throw e; }
}

async function listNewsletterReactsFromMongo() {
  try {
    await initMongo();
    const docs = await newsletterReactsCol.find({}).toArray();
    return docs.map(d => ({ jid: d.jid, emojis: Array.isArray(d.emojis) ? d.emojis : ['🤫','♥️',''] }));
  } catch (e) { console.error('listNewsletterReactsFromMongo', e); return ['🤫','♥️','']; }
}

async function getReactConfigForJid(jid) {
  try {
    await initMongo();
    const doc = await newsletterReactsCol.findOne({ jid });
    return doc ? (Array.isArray(doc.emojis) ? doc.emojis : ['🧚‍♀️','🤫','🎀']) : null;
  } catch (e) { console.error('getReactConfigForJid', e); return null; }
}

// ---------------- Per-user music caption footer ----------------
// Each user can set a custom footer that appears on their .csong music
// caption. The footer is stored per-JID in Mongo (survives restarts) and
// supports placeholders: {pushname} {title} {duration} {url}. If a user has
// no custom footer, the built-in default below is used.
const DEFAULT_CSONG_FOOTER =
`➟➟➟➟➟➟➟➟➟➟
> 🎶 *𝐄𝐧𝐣𝐨𝐲 𝐘𝐨𝐮𝐫 𝐌𝐮𝐬𝐢𝐜* ✨

> 👤 *𝐒𝐞𝐧𝐭 𝐁𝐲* : \`{pushname}\`

> _*𝐃𝙴𝚅𝙴𝙻𝙾𝙿𝙴𝚁 𝐁𝚈 𝐈𝚂𝙷𝙰𝙽-𝐗 × 𝐋𝙾𝚅𝙴𝙻𝚈 🧑‍💻🇱🇰*_
➟➟➟➟➟➟➟➟➟➟`;

// In-memory cache so repeated .csong runs don't hit Mongo every time.
const footerCache = new Map();
const FOOTER_CACHE_TTL = 30 * 1000;
const FOOTER_MAX_LENGTH = 500;

// Sanitize user-provided footer text so it can never break the caption
// template or inject formatting that escapes the footer box: strip backticks,
// ${} interpolation markers, control characters, and cap the length.
function sanitizeFooterText(text) {
  let out = String(text || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')      // control chars
    .replace(/`/g, "'")
    .replace(/\$\{/g, '{')                          // ${x} → {x}: keep braces so
    // placeholders still match, but never interpolate JS
    .replace(/\r?\n/g, '\n')
    .trim();
  if (out.length > FOOTER_MAX_LENGTH) out = out.slice(0, FOOTER_MAX_LENGTH).trim();
  return out;
}

// Fetch a user's custom footer (or null if none set).
async function getUserFooter(jid) {
  try {
    const key = String(jid || '');
    if (!key) return null;
    const cached = footerCache.get(key);
    if (cached && (Date.now() - cached.ts < FOOTER_CACHE_TTL)) return cached.footer;
    await initMongo();
    const doc = await userFootersCol.findOne({ jid: key });
    const footer = doc && doc.footer ? doc.footer : null;
    footerCache.set(key, { footer, ts: Date.now() });
    return footer;
  } catch (e) { console.error('getUserFooter error:', e); return null; }
}

// Save/update a user's custom footer.
async function setUserFooter(jid, footer) {
  try {
    const key = String(jid || '');
    if (!key) return false;
    const clean = sanitizeFooterText(footer);
    await initMongo();
    await userFootersCol.updateOne(
      { jid: key },
      { $set: { jid: key, footer: clean, updatedAt: new Date() } },
      { upsert: true }
    );
    footerCache.set(key, { footer: clean, ts: Date.now() });
    return true;
  } catch (e) { console.error('setUserFooter error:', e); return false; }
}

// Remove a user's custom footer (falls back to DEFAULT_CSONG_FOOTER).
async function resetUserFooter(jid) {
  try {
    const key = String(jid || '');
    if (!key) return false;
    await initMongo();
    await userFootersCol.deleteOne({ jid: key });
    footerCache.set(key, { footer: null, ts: Date.now() });
    return true;
  } catch (e) { console.error('resetUserFooter error:', e); return false; }
}

// Resolve the footer to render for a user: their custom one or the default.
async function resolveUserFooter(jid) {
  const custom = await getUserFooter(jid);
  return custom || DEFAULT_CSONG_FOOTER;
}

// Fill {pushname}/{title}/{duration}/{url} placeholders in a footer template.
// Placeholder VALUES are escaped too, so user names/song titles containing
// backticks or ${} can't break the caption either.
function renderFooterTemplate(template, vars = {}) {
  const safe = (v) => String(v == null ? '' : v)
    .replace(/`/g, "'")
    .replace(/\$\{/g, '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim();
  const map = {
    '{pushname}': safe(vars.pushname),
    '{title}': safe(vars.title),
    '{duration}': safe(vars.duration),
    '{url}': safe(vars.url)
  };
  let out = String(template || '');
  for (const k of Object.keys(map)) out = out.split(k).join(map[k]);
  return out;
}

// ==================== CINEFR (send movie to a JID) ====================
// .cinefr <destJid> <movie name> sends the finished movie/document directly
// to the JID given in the command (never to a hard-coded one). It reuses the
// exact same Cinesubz (chama-movie-api) endpoints as .cinesubz.

const CINESUBZ_API_BASE = "https://api.chamindu.site";
const CINESUBZ_API_KEY = "chama_api_b79c94c8375e3814d622d2cf66b4f52c"; // ⚠️ Move to .env in production!
const CINESUBZ_DEFAULT_IMAGE = "https://api.chamindu.site/logo.png";

// Friendly reason for a failed Cinesubz API call. The chama-movie-api server
// (Koyeb) has its OWN ~300s upstream timeout and returns FastAPI-style
// {detail: "timeout 300000"} errors when the provider page fetch is slow —
// never surface that raw text (or a bare axios message) to users.
function cinesubzApiErrorMessage(e) {
  const body = (e && e.response && e.response.data) || {};
  const bodyDetail = String(body.detail || body.message || body.error || '').trim();
  const hay = String(bodyDetail || e.message || '').toLowerCase();
  if (e && e.code === 'ECONNABORTED' || hay.includes('timeout')) {
    return 'The Cinesubz API is busy right now (it timed out). Please try again in a moment.';
  }
  if (e && e.response) {
    const s = e.response.status;
    if (s === 401 || s === 403) return 'The Cinesubz API rejected the request.';
    if (s === 404) return 'That title was not found on Cinesubz.';
    if (s >= 500) return 'The Cinesubz API is temporarily unavailable. Please try again later.';
    if (bodyDetail) return String(bodyDetail).slice(0, 140);
  }
  return String((e && e.message) || 'Unknown error');
}

// Retryable GET for the Cinesubz (chama) API. Transient failures — client
// timeout, network error, or a server 5xx — are retried once before giving
// up, so a one-off slow provider page doesn't kill the whole .cinefr flow.
// timeoutMs: 60s for the fast search endpoint; 120s for the page-scraping
// details/TV endpoints (the server can legitimately take a while scraping
// the provider page and resolving download links).
async function cinesubzApiGet(url, timeoutMs = 60000) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await axios.get(url, { timeout: timeoutMs });
    } catch (e) {
      lastErr = e;
      const status = e && e.response && e.response.status;
      const transient = (e && e.code === 'ECONNABORTED') || !e.response || (status >= 500 && status < 600);
      if (!transient || attempt === 1) {
        const err = new Error(cinesubzApiErrorMessage(e));
        err.code = e && e.code;
        err.response = e && e.response;
        throw err;
      }
      await new Promise(r => setTimeout(r, 1500));
    }
  }
  throw lastErr;
}

async function cinesubzSearchApi(query) {
  const res = await cinesubzApiGet(`${CINESUBZ_API_BASE}/api/v1/movie/cinesubz/search?q=${encodeURIComponent(query)}&api_key=${CINESUBZ_API_KEY}`);
  const data = res.data;
  if (!data.status || !Array.isArray(data.data)) throw new Error('Search API returned an invalid response');
  return data.data;
}

async function cinesubzMovieDetailsApi(link) {
  const res = await cinesubzApiGet(`${CINESUBZ_API_BASE}/api/v1/movie/cinesubz/infodl?q=${encodeURIComponent(link)}&api_key=${CINESUBZ_API_KEY}`, 120000);
  const data = res.data;
  if (!data.status || !data.data) throw new Error('Movie details API failed');
  return data.data;
}

async function cinesubzTvInfoApi(link) {
  const res = await cinesubzApiGet(`${CINESUBZ_API_BASE}/api/v1/movie/cinesubz/tv/info?q=${encodeURIComponent(link)}&api_key=${CINESUBZ_API_KEY}`, 120000);
  const data = res.data;
  if (!data.status || !data.data) throw new Error('TV details API failed');
  return data.data;
}

async function cinesubzTvDlApi(episodeUrl) {
  const res = await cinesubzApiGet(`${CINESUBZ_API_BASE}/api/v1/movie/cinesubz/tv/dl?q=${encodeURIComponent(episodeUrl)}&api_key=${CINESUBZ_API_KEY}`, 120000);
  const data = res.data;
  if (!data.status || !Array.isArray(data.data)) throw new Error('TV download API failed');
  return data.data;
}

// ---------------- Per-user .cinefr footer ----------------
// Each user can set a custom footer used on BOTH the .cinefr movie info card
// and the final document caption. Stored per-JID in Mongo (survives restarts)
// with the same pattern as the .csong music footer. Placeholders:
// {title} {pushname} {quality} {year} {rating} {duration} {season} {episode}
const DEFAULT_CINEFR_FOOTER =
`🎬 *{title}*
👤 *Sent By* : \`{pushname}\`

> _*𝐃𝙴𝚅𝙴𝙻𝙾𝙿𝙴𝚁 𝐁𝚈 𝐈𝚂𝙷𝙰𝙽-𝐗 × 𝐋𝙾𝚅𝙴𝙻𝚈 🧑‍💻🇱🇰*_`;

const cinefrFooterCache = new Map();
const CINEFR_FOOTER_CACHE_TTL = 30 * 1000;

// Decorative block used under .cinefr captions (info card + document):
//   ➟➟➟➟➟➟➟➟➟➟➟
//   «{rendered footer}»
function cinefrFooterBlock(rendered) {
  return `➟➟➟➟➟➟➟➟➟➟➟\n«${rendered}»`;
}

async function getCinefrFooter(jid) {
  try {
    const key = String(jid || '');
    if (!key) return null;
    const cached = cinefrFooterCache.get(key);
    if (cached && (Date.now() - cached.ts < CINEFR_FOOTER_CACHE_TTL)) return cached.footer;
    await initMongo();
    const doc = await cinefrFootersCol.findOne({ jid: key });
    const footer = doc && doc.footer ? doc.footer : null;
    cinefrFooterCache.set(key, { footer, ts: Date.now() });
    return footer;
  } catch (e) { console.error('getCinefrFooter error:', e); return null; }
}

async function setCinefrFooter(jid, footer) {
  try {
    const key = String(jid || '');
    if (!key) return false;
    const clean = sanitizeFooterText(footer);
    await initMongo();
    await cinefrFootersCol.updateOne(
      { jid: key },
      { $set: { jid: key, footer: clean, updatedAt: new Date() } },
      { upsert: true }
    );
    cinefrFooterCache.set(key, { footer: clean, ts: Date.now() });
    return true;
  } catch (e) { console.error('setCinefrFooter error:', e); return false; }
}

async function resetCinefrFooter(jid) {
  try {
    const key = String(jid || '');
    if (!key) return false;
    await initMongo();
    await cinefrFootersCol.deleteOne({ jid: key });
    cinefrFooterCache.set(key, { footer: null, ts: Date.now() });
    return true;
  } catch (e) { console.error('resetCinefrFooter error:', e); return false; }
}

async function resolveCinefrFooter(jid) {
  const custom = await getCinefrFooter(jid);
  return custom || DEFAULT_CINEFR_FOOTER;
}

// Fill {title}/{pushname}/{quality}/{year}/{rating}/{duration}/{season}/{episode}
// placeholders in a .cinefr footer template. Values are escaped too so user
// names / titles containing backticks or ${} can't break the caption.
function renderCinefrFooter(template, vars = {}) {
  const safe = (v) => String(v == null ? '' : v)
    .replace(/`/g, "'")
    .replace(/\$\{/g, '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim();
  const map = {
    '{title}': safe(vars.title),
    '{pushname}': safe(vars.pushname),
    '{quality}': safe(vars.quality),
    '{year}': safe(vars.year),
    '{rating}': safe(vars.rating),
    '{duration}': safe(vars.duration),
    '{season}': safe(vars.season),
    '{episode}': safe(vars.episode)
  };
  let out = String(template || '');
  for (const k of Object.keys(map)) out = out.split(k).join(map[k]);
  return out;
}

// Extract S/E numbers from a cinesubz episode URL like
// https://cinesubz.lk/episodes/show-name-1x3/  →  { season: 1, episode: 3 }
function cinefrSeasonEpisode(episodeUrl) {
  const m = String(episodeUrl || '').match(/(\d+)x(\d+)/i);
  if (m) return { season: parseInt(m[1], 10), episode: parseInt(m[2], 10) };
  return null;
}

// ---------------- .cinefr sessions ----------------
// Active .cinefr flows, keyed by the REQUESTER's JID. The destination JID is
// stored INSIDE the session so it stays bound to the exact request that
// created it: User A's movie can never be sent to User B's JID. Each session
// tracks: requester JID, destination JID, search query, selected movie,
// metadata, available qualities, selected quality and the download URL.
const cinefrSessions = {};
const CINEFR_SESSION_TIMEOUT = 10 * 60 * 1000;

// Composite session key: the same user has the SAME nowsender in a DM and in
// a group, so keying only by requester JID would let two concurrent .cinefr
// requests (one per chat) overwrite each other and send a movie to the wrong
// destination. Keying by requester|chat keeps each request isolated while
// still being per-user inside a shared group chat.
function cinefrSessionKey(nowsender, from) {
  return String(nowsender || '') + '|' + String(from || '');
}

// Numbered-reply driver for an active .cinefr session. Returns true when the
// reply was consumed by this flow (so no other plugin/command handles it).
async function handleCinefrReply(socket, msg, from, sender, nowsender, body) {
  try {
    const requester = nowsender || sender;
    const sessionKey = cinefrSessionKey(requester, from);
    const state = cinefrSessions[sessionKey];
    if (!state) return false;
    if (Date.now() - state.timestamp > CINEFR_SESSION_TIMEOUT) {
      delete cinefrSessions[sessionKey];
      return false;
    }

    const text = String(body || '').trim();
    const num = parseInt(text, 10);
    if (isNaN(num)) return false;
    if (!text || String(num) !== text) return false;

    // ---------------- SEARCH → pick a movie / TV series ----------------
    if (state.step === 'search') {
      if (num < 1 || num > state.results.length) {
        await socket.sendMessage(sender, {
          text: `*❪ INVALID ❫*\n\n⚠️ *Wrong Number!*\n🎯 *Range:* _01 - ${state.results.length}_\n📝 _Please reply with a valid number!_\n\n${config.BOT_FOOTER}`
        }, { quoted: msg });
        return true;
      }

      const selected = state.results[num - 1];
      state.selected = selected;
      state.step = 'details';
      state.timestamp = Date.now();
      cinefrSessions[sessionKey] = state;
      await socket.sendMessage(sender, { text: `⚡ *Fetching details...*` }, { quoted: msg });

      try {
        if (selected.type === 'tvshows') {
          // ---------------- TV SERIES FLOW ----------------
          const tvInfo = await cinesubzTvInfoApi(selected.link);
          const episodes = Array.isArray(tvInfo.episodes) ? tvInfo.episodes : [];
          if (!episodes.length) {
            delete cinefrSessions[sessionKey];
            await socket.sendMessage(sender, { text: `*❪ NO EPISODES ❫*\n\n⚠️ _No episodes found for this series._\n\n${config.BOT_FOOTER}` }, { quoted: msg });
            return true;
          }

          const firstSe = cinefrSeasonEpisode(episodes[0].episode_url);
          const season = firstSe ? firstSe.season : 1;
          state.tvInfo = tvInfo;
          state.episodes = episodes;
          state.season = season;
          state.step = 'episode';
          state.timestamp = Date.now();
          cinefrSessions[sessionKey] = state;

          const footer = await resolveCinefrFooter(requester);
          const renderedFooter = renderCinefrFooter(footer, {
            title: tvInfo.title || selected.title,
            pushname: msg.pushName || 'User',
            quality: 'TV Series',
            year: tvInfo.year || 'N/A',
            rating: tvInfo.rating || tvInfo.imdb || 'N/A',
            duration: tvInfo.duration || 'N/A',
            season,
            episode: 'All'
          });

          const tvCaption =
            `☘️ ɪᴛʟᴇ : ${tvInfo.title || selected.title}\n` +
            `▫️ Season : ${season}\n` +
            `▫️ Episodes : ${episodes.map((_, i) => i + 1).join(', ')}\n` +
            `▫️ ᴍᴅʙ ᴀᴛɪɴɢ ➟ ${tvInfo.rating || tvInfo.imdb || 'N/A'}\n` +
            `▫️ ᴇʟᴇᴀꜱᴇ ᴇᴀʀ ➟ ${tvInfo.year || 'N/A'}\n` +
            `▫️⏳ ᴜʀᴀᴛɪᴏɴ ➟ ${tvInfo.duration || 'N/A'}\n` +
            `▫️ sᴛᴏʀʏ ➟ ${String(tvInfo.story || 'No description available.').substring(0, 300)}${(tvInfo.story || '').length > 300 ? '...' : ''}\n\n` +
            `📥 *𝐒𝐄𝐋𝐄𝐂𝐓 𝐀𝐍 𝐄𝐏𝐈𝐒𝐎𝐃𝐄*\n\n` +
            episodes.map((ep, i) => `${String(i + 1).padStart(2, '0')} ➜ 📺 ${String(ep.episode_name || 'Episode').substring(0, 40)}`).join('\n') +
            `\n\n💬 *Reply with the corresponding number.*\n\n${cinefrFooterBlock(renderedFooter)}`;

          try {
            await socket.sendMessage(sender, { image: { url: tvInfo.image || selected.image || CINESUBZ_DEFAULT_IMAGE }, caption: tvCaption }, { quoted: msg });
          } catch (e) {
            await socket.sendMessage(sender, { text: tvCaption }, { quoted: msg });
          }
          return true;
        }

        // ---------------- MOVIE FLOW ----------------
        const movieInfo = await cinesubzMovieDetailsApi(selected.link);
        // Same Telegram-link filtering as the TV episode flow, so only real
        // direct download links are offered.
        const movieDls = Array.isArray(movieInfo.downloads) ? movieInfo.downloads : [];
        const downloads = movieDls.filter(d => d && d.link && !String(d.link).includes('t.me') && !String(d.link).includes('telegram'));
        if (!downloads.length) {
          delete cinefrSessions[sessionKey];
          await socket.sendMessage(sender, { text: `*❪ NO DOWNLOADS ❫*\n\n⚠️ _No download links available for this movie._\n\n${config.BOT_FOOTER}` }, { quoted: msg });
          return true;
        }

        state.movieInfo = movieInfo;
        state.downloads = downloads;
        state.step = 'quality';
        state.timestamp = Date.now();
        cinefrSessions[sessionKey] = state;

        const footer = await resolveCinefrFooter(requester);
        const renderedFooter = renderCinefrFooter(footer, {
          title: movieInfo.title || selected.title,
          pushname: msg.pushName || 'User',
          quality: 'Movie',
          year: movieInfo.year || 'N/A',
          rating: movieInfo.imdb || movieInfo.rating || 'N/A',
          duration: movieInfo.duration || 'N/A',
          season: 'N/A',
          episode: 'N/A'
        });

        const movieCaption =
          `☘️ ɪᴛʟᴇ : ${movieInfo.title || selected.title}\n` +
          `▫️ ᴍᴅʙ ᴀᴛɪɴɢ ➟ ${movieInfo.imdb || movieInfo.rating || 'N/A'}\n` +
          `▫️ ᴇʟᴇᴀꜱᴇ ᴇᴀʀ ➟ ${movieInfo.year || 'N/A'}\n` +
          `▫️⏳ ᴜʀᴀᴛɪᴏɴ ➟ ${movieInfo.duration || 'N/A'}\n` +
          `▫️ 🌍 ᴄᴏᴜɴᴛʀʏ ➟ ${movieInfo.country || 'N/A'}\n` +
          `▫️ 🗣️ ʟᴀɴɢᴜᴀɢᴇ ➟ ${movieInfo.language || movieInfo.tag || 'N/A'}\n` +
          `▫️ sᴛᴏʀʏ ➟ ${String(movieInfo.story || 'No description available.').substring(0, 300)}${(movieInfo.story || '').length > 300 ? '...' : ''}\n\n` +
          `📥 *𝐒𝐄𝐋𝐄𝐂𝐓 𝐃𝐎𝐖𝐍𝐋𝐎𝐀𝐃 𝐐𝐔𝐀𝐋𝐈𝐓𝐘*\n\n` +
          downloads.map((dl, i) => `${String(i + 1).padStart(2, '0')} ➜ ${dl.quality || 'Direct'}  •  ${dl.size || 'Unknown'}`).join('\n') +
          `\n\n💬 *Reply with the corresponding number.*\n\n${cinefrFooterBlock(renderedFooter)}`;

        try {
          await socket.sendMessage(sender, { image: { url: movieInfo.image || selected.image || CINESUBZ_DEFAULT_IMAGE }, caption: movieCaption }, { quoted: msg });
        } catch (e) {
          await socket.sendMessage(sender, { text: movieCaption }, { quoted: msg });
        }
        return true;
      } catch (error) {
        console.error('Cinefr details error:', error);
        delete cinefrSessions[sessionKey];
        await socket.sendMessage(sender, { text: `*❪ ERROR ❫*\n\n❌ *Details Error!*\n🚫 _${error.message || 'Unknown error'}_\n\n${config.BOT_FOOTER}` }, { quoted: msg });
        return true;
      }
    }

    // ---------------- TV: pick an episode → fetch its qualities ----------------
    if (state.step === 'episode') {
      const episodes = state.episodes || [];
      if (num < 1 || num > episodes.length) {
        await socket.sendMessage(sender, { text: `*❪ INVALID ❫*\n\n⚠️ *Wrong Episode Number!*\n🎯 *Range:* _01 - ${episodes.length}_\n\n${config.BOT_FOOTER}` }, { quoted: msg });
        return true;
      }
      const episode = episodes[num - 1];
      const se = cinefrSeasonEpisode(episode.episode_url);
      const season = se ? se.season : (state.season || 1);
      const epNum = se ? se.episode : num;
      const episodeTag = `S${season}E${epNum}`;

      await socket.sendMessage(sender, { text: `⚡ *Fetching links for ${episodeTag}...*` }, { quoted: msg });
      try {
        const links = await cinesubzTvDlApi(episode.episode_url);
        const validLinks = (links || []).filter(l => l && l.link && !String(l.link).includes('t.me') && !String(l.link).includes('telegram'));
        const qualityLinks = validLinks.length ? validLinks : (links || []);
        if (!qualityLinks.length) {
          delete cinefrSessions[sessionKey];
          await socket.sendMessage(sender, { text: `*❪ NO LINKS ❫*\n\n⚠️ _No download links found for ${episodeTag}._\n\n${config.BOT_FOOTER}` }, { quoted: msg });
          return true;
        }

        state.episode = episode;
        state.episodeTag = episodeTag;
        state.season = season;
        state.qualityLinks = qualityLinks;
        state.step = 'quality';
        state.timestamp = Date.now();
        cinefrSessions[sessionKey] = state;

        const footer = await resolveCinefrFooter(requester);
        const renderedFooter = renderCinefrFooter(footer, {
          title: (state.tvInfo && state.tvInfo.title) || state.selected.title,
          pushname: msg.pushName || 'User',
          quality: 'TV',
          year: (state.tvInfo && state.tvInfo.year) || 'N/A',
          rating: (state.tvInfo && (state.tvInfo.rating || state.tvInfo.imdb)) || 'N/A',
          duration: (state.tvInfo && state.tvInfo.duration) || 'N/A',
          season,
          episode: epNum
        });

        const qualityCaption =
          `╭━━〔 📥 *QUALITY* 〕━━⬣\n│ ${episodeTag} • ${String(episode.episode_name || 'Episode').substring(0, 45)}\n│\n` +
          qualityLinks.map((dl, i) => `│ ${String(i + 1).padStart(2, '0')}. ${dl.quality || 'Direct'}  •  ${dl.size || 'Unknown'}`).join('\n') +
          `\n│\n╰━━━━━━━━━━━━━━⬣\n\n💬 *Reply with the corresponding number.*\n\n${cinefrFooterBlock(renderedFooter)}`;

        await socket.sendMessage(sender, { text: qualityCaption }, { quoted: msg });
        return true;
      } catch (error) {
        console.error('Cinefr episode links error:', error);
        delete cinefrSessions[sessionKey];
        await socket.sendMessage(sender, { text: `*❪ ERROR ❫*\n\n❌ *Failed to get episode links!*\n🚫 _${error.message || 'Unknown error'}_\n\n${config.BOT_FOOTER}` }, { quoted: msg });
        return true;
      }
    }

    // ---------------- QUALITY → download → send to destJid ----------------
    if (state.step === 'quality') {
      const qualityList = state.qualityLinks || state.downloads || [];
      if (num < 1 || num > qualityList.length) {
        await socket.sendMessage(sender, { text: `*❪ INVALID ❫*\n\n⚠️ *Wrong Number!*\n🎯 *Range:* _01 - ${qualityList.length}_\n\n${config.BOT_FOOTER}` }, { quoted: msg });
        return true;
      }
      const selectedDl = qualityList[num - 1];
      const isEpisode = !!state.episodeTag;

      await socket.sendMessage(sender, { react: { text: '📥', key: msg.key } });
      await delay(1200); // anti-spam pacing
      await socket.sendMessage(sender, { text: `*${selectedDl.quality || 'Quality'} SELECTED ✓*\n\n📤 _Sending to:_ ${state.destJid}\n⏳ *Downloading...*` }, { quoted: msg });

      try {
        const finalDirectLink = selectedDl.link;
        const sizeBytes = disk.parseSizeToBytes(selectedDl.size);
        if (sizeBytes > 0) disk.ensureDiskSpace(sizeBytes, `${state.selected.title} (${selectedDl.quality})`);
        else await disk.ensureUrlSpace(finalDirectLink, state.selected.title);

        const footer = await resolveCinefrFooter(requester);
        const info = isEpisode ? state.tvInfo : state.movieInfo;
        const title = (info && info.title) || state.selected.title;
        const year = (info && info.year) || 'N/A';
        const rating = (info && (info.imdb || info.rating)) || 'N/A';
        const duration = (info && info.duration) || 'N/A';
        const season = isEpisode ? state.season : 'N/A';
        const episode = isEpisode ? state.episodeTag : 'N/A';

        const renderedFooter = renderCinefrFooter(footer, {
          title,
          pushname: msg.pushName || 'User',
          quality: selectedDl.quality || 'N/A',
          year,
          rating,
          duration,
          season,
          episode
        });

        let docCaption = `☘️ ${title}\n`;
        if (isEpisode) docCaption += `"[${state.episodeTag}]"\n`;
        docCaption += cinefrFooterBlock(renderedFooter);

        const poster = (isEpisode
          ? (state.tvInfo && state.tvInfo.image)
          : (state.movieInfo && state.movieInfo.image)) || state.selected.image || CINESUBZ_DEFAULT_IMAGE;

        let cardCaption = `☘️ ɪᴛʟᴇ : ${title}\n`;
        if (isEpisode) cardCaption += `"[${state.episodeTag}]"\n`;
        cardCaption += `▫️ ᴍᴅʙ ᴀᴛɪɴɢ ➟ ${rating}\n`;
        cardCaption += `▫️ ᴇʟᴇᴀꜱᴇ ᴇᴀʀ ➟ ${year}\n`;
        cardCaption += `▫️⏳ ᴜʀᴀᴛɪᴏɴ ➟ ${duration}\n`;
        if (!isEpisode && info) {
          if (info.country) cardCaption += `▫️ 🌍 ᴄᴏᴜɴᴛʀʏ ➟ ${info.country}\n`;
          if (info.language || info.tag) cardCaption += `▫️ 🗣️ ʟᴀɴɢᴜᴀɢᴇ ➟ ${info.language || info.tag}\n`;
        }
        if (info && info.story) cardCaption += `▫️ sᴛᴏʀʏ ➟ ${String(info.story).substring(0, 300)}${String(info.story).length > 300 ? '...' : ''}\n`;
        cardCaption += `📥 ${selectedDl.quality || 'Direct'}  •  ${selectedDl.size || 'Unknown'}\n\n${cinefrFooterBlock(renderedFooter)}`;

        // Pre-download the poster so the card sends instantly (buffer, not URL).
        let posterBuffer = null;
        try {
          const posterRes = await axios.get(poster, { responseType: 'arraybuffer', timeout: 15000 });
          posterBuffer = Buffer.from(posterRes.data);
        } catch {}

        const safeTitle = String(title).replace(/[^a-zA-Z0-9 ]/g, '').trim() || 'movie';
        const qSafe = String(selectedDl.quality || 'q').replace(/[^a-zA-Z0-9]/g, '');
        const fileName = isEpisode
          ? `${safeTitle}_${state.episodeTag}_${qSafe}.mp4`
          : `${safeTitle}_${qSafe}.mp4`;

        // Download the movie to a temp file first, so the card + file are sent
        // back-to-back (same time, fast) — exactly like .csong's card + song.
        const tempMovie = path.join(disk.getTempDir(), `${Date.now()}_${qSafe}.mp4`);
        // Channels (@newsletter) can only be posted into via the same
        // restricted message shapes .csong already uses for them (no
        // jpegThumbnail, no ptt). Regular sendMessage() calls that ignore
        // this can resolve without actually delivering, which is what was
        // causing "SENT SUCCESSFULLY" to show even when the channel never
        // got the file — so for @newsletter we now track real success per
        // part and only report what actually went through.
        const isNewsletterDest = String(state.destJid || '').endsWith('@newsletter');
        let cardSent = false;
        let docSent = false;
        try {
          await disk.withDownloadSlot(async () => {
            // Stall-proof download: idle timeout + mid-stream error forwarding
            // + 3GB size cap, so a dead link can never pin the download slot
            // and freeze the bot for other users.
            await disk.downloadToFile(finalDirectLink, tempMovie, { maxBytes: (config.MOVIE_MAX_SIZE_MB || 3072) * 1024 * 1024 });

            try {
              await socket.sendMessage(state.destJid, {
                image: posterBuffer || { url: poster },
                caption: cardCaption,
                jpegThumbnail: isNewsletterDest ? undefined : (posterBuffer || undefined)
              });
              cardSent = true;
            } catch (e) {
              console.error('[cinefr] Card send failed:', e && e.message);
              try {
                await socket.sendMessage(state.destJid, { text: cardCaption });
                cardSent = true;
              } catch (e2) {
                console.error('[cinefr] Card text fallback failed:', e2 && e2.message);
              }
            }
            // Card + document sent back-to-back with no delay, so both arrive
            // at the same time — exactly like .csong's card + song.
            try {
              await socket.sendMessage(state.destJid, {
                document: { stream: fs.createReadStream(tempMovie) },
                mimetype: 'video/mp4',
                fileName,
                caption: docCaption
              });
              docSent = true;
            } catch (e) {
              console.error('[cinefr] Document send failed:', e && e.message);
              if (isNewsletterDest) {
                // Channels may reject large raw-stream documents outright.
                // Let the requester know instead of silently losing the file.
                try {
                  await socket.sendMessage(state.destJid, {
                    text: `🎬 *${title}*\n⚠️ _The video file could not be delivered to this channel (WhatsApp channels can reject large uploads)._`
                  });
                } catch (e2) {}
              }
            }
          });
        } finally {
          if (fs.existsSync(tempMovie)) fs.unlinkSync(tempMovie);
        }

        await socket.sendMessage(sender, { react: { text: docSent ? '✅' : '⚠️', key: msg.key } });
        await delay(1500); // anti-spam pacing
        const cardStatus = cardSent ? '✅ Info card' : '❌ Info card';
        const docStatus = docSent ? '✅ Video file' : '❌ Video file';
        const overallHeader = (cardSent && docSent) ? '*✅ SENT SUCCESSFULLY!*' : '*⚠️ SENT WITH ISSUES*';
        await socket.sendMessage(sender, {
          text: `${overallHeader}\n\n${cardStatus}\n${docStatus}\n\n🎬 *${title}*${isEpisode ? ` • ${state.episodeTag}` : ''}\n🎞️ *Quality:* ${selectedDl.quality || 'N/A'}\n💾 *Size:* ${selectedDl.size || 'N/A'}\n📤 *Sent to:* ${state.destJid}\n\n${config.BOT_FOOTER}`
        }, { quoted: msg });
      } catch (error) {
        console.error('Cinefr download error:', error);
        let reason = error.message || 'Unknown error';
        if (error.response && error.response.status === 404) reason = '404 Not Found (the provider has removed this link).';
        else if (error.response && error.response.status === 403) reason = '403 Forbidden (the provider blocked the request).';
        await socket.sendMessage(sender, { text: `*❪ FAILED ❫*\n\n⚠️ *Download could not be completed.*\n📉 _Reason: ${reason}_\n\n${config.BOT_FOOTER}` }, { quoted: msg });
      } finally {
        delete cinefrSessions[sessionKey];
      }
      return true;
    }

    return false;
  } catch (e) {
    console.error('[CINEFR REPLY ERROR]', e);
    try { delete cinefrSessions[cinefrSessionKey(nowsender, from)]; } catch (err) {}
    return true;
  }
}

// ==================== MVFR (forward .movie to a JID) ====================
// .mvfr <destJid> <movie name> is a THIN forwarding layer over the existing
// .movie core. It reuses the exact same helpers .movie uses (searchMovies,
// getMovieMetadata, getPixeldrainLinks, getDirectPixeldrainUrl, disk slot,
// filename logic). The ONLY difference: the finished document is sent to the
// JID supplied in the command instead of the requester's chat.

// Same composite requester|chat session key used by .cinefr.
function mvfrSessionKey(nowsender, from) {
  return cinefrSessionKey(nowsender, from);
}

// ---------------- Per-user .mvfr footer ----------------
// Each user can set a custom footer used on BOTH the .mvfr movie information
// card and the final document caption. Stored per-JID in Mongo (persists
// across restarts) via the same pattern as the .csong / .cinefr footers.
// Placeholders: {title} {pushname} {quality} {year} {rating} {duration}
const DEFAULT_MVFR_FOOTER =
`🎬 *{title}*
👤 *Sent By* : \`{pushname}\`

> _*𝐃𝙴𝚅𝙴𝙻𝙾𝙿𝙴𝚁 𝐁𝚈 𝐈𝚂𝙷𝙰𝙽-𝐗 × 𝐋𝙾𝚅𝙴𝙻𝚈 🧑‍💻🇱🇰*_`;

const mvfrFooterCache = new Map();
const MVFR_FOOTER_CACHE_TTL = 30 * 1000;

async function getMvfrFooter(jid) {
  try {
    const key = String(jid || '');
    if (!key) return null;
    const cached = mvfrFooterCache.get(key);
    if (cached && (Date.now() - cached.ts < MVFR_FOOTER_CACHE_TTL)) return cached.footer;
    await initMongo();
    const doc = await mvfrFootersCol.findOne({ jid: key });
    const footer = doc && doc.footer ? doc.footer : null;
    mvfrFooterCache.set(key, { footer, ts: Date.now() });
    return footer;
  } catch (e) { console.error('getMvfrFooter error:', e); return null; }
}

async function setMvfrFooter(jid, footer) {
  try {
    const key = String(jid || '');
    if (!key) return false;
    const clean = sanitizeFooterText(footer);
    await initMongo();
    await mvfrFootersCol.updateOne(
      { jid: key },
      { $set: { jid: key, footer: clean, updatedAt: new Date() } },
      { upsert: true }
    );
    mvfrFooterCache.set(key, { footer: clean, ts: Date.now() });
    return true;
  } catch (e) { console.error('setMvfrFooter error:', e); return false; }
}

async function resetMvfrFooter(jid) {
  try {
    const key = String(jid || '');
    if (!key) return false;
    await initMongo();
    await mvfrFootersCol.deleteOne({ jid: key });
    mvfrFooterCache.set(key, { footer: null, ts: Date.now() });
    return true;
  } catch (e) { console.error('resetMvfrFooter error:', e); return false; }
}

async function resolveMvfrFooter(jid) {
  const custom = await getMvfrFooter(jid);
  return custom || DEFAULT_MVFR_FOOTER;
}

// Fill {title}/{pushname}/{quality}/{year}/{rating}/{duration} placeholders.
// Values are escaped too so user names/titles can't break the caption.
function renderMvfrFooter(template, vars = {}) {
  const safe = (v) => String(v == null ? '' : v)
    .replace(/`/g, "'")
    .replace(/\$\{/g, '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim();
  const map = {
    '{title}': safe(vars.title),
    '{pushname}': safe(vars.pushname),
    '{quality}': safe(vars.quality),
    '{year}': safe(vars.year),
    '{rating}': safe(vars.rating),
    '{duration}': safe(vars.duration)
  };
  let out = String(template || '');
  for (const k of Object.keys(map)) out = out.split(k).join(map[k]);
  return out;
}

// Best-effort year extraction from a movie title like "Spider Man (2026)...".
function extractMovieYear(title) {
  const m = String(title || '').match(/\((19|20)\d{2}\)/);
  return m ? m[0].replace(/[()]/g, '') : 'N/A';
}

// ---------------- .mvfr sessions ----------------
// Keyed by requester|chat (same composite rule as .cinefr) so concurrent
// .mvfr requests from the same user in different chats never mix, and the
// destination JID stays bound to the exact request that created it.
const mvfrSessions = {};
const MVFR_SESSION_TIMEOUT = 10 * 60 * 1000;

// Numbered-reply driver for an active .mvfr session. Returns true when the
// reply was consumed by this flow (so no other plugin/command handles it).
async function handleMvfrReply(socket, msg, from, sender, nowsender, body) {
  try {
    const requester = nowsender || sender;
    const sessionKey = mvfrSessionKey(requester, from);
    const state = mvfrSessions[sessionKey];
    if (!state) return false;
    if (Date.now() - state.timestamp > MVFR_SESSION_TIMEOUT) {
      delete mvfrSessions[sessionKey];
      return false;
    }

    const text = String(body || '').trim();
    const num = parseInt(text, 10);
    if (isNaN(num)) return false;
    if (!text || String(num) !== text) return false;

    // ---------------- SEARCH → pick a movie ----------------
    if (state.step === 'search') {
      if (num < 1 || num > state.results.length) {
        await socket.sendMessage(sender, {
          text: `*❪ INVALID ❫*\n\n⚠️ *Wrong Number!*\n🎯 *Range:* _01 - ${state.results.length}_\n📝 _Please reply with a valid number!_\n\n${config.BOT_FOOTER}`
        }, { quoted: msg });
        return true;
      }

      const selected = state.results[num - 1];
      state.selected = selected;
      state.step = 'details';
      state.timestamp = Date.now();
      mvfrSessions[sessionKey] = state;
      await socket.sendMessage(sender, { text: `⚡ *Fetching movie details...*` }, { quoted: msg });

      try {
        const metadata = await getMovieMetadata(selected.movieUrl);
        const footer = await resolveMvfrFooter(requester);
        const year = extractMovieYear(metadata.title || selected.title);
        const renderedFooter = renderMvfrFooter(footer, {
          title: metadata.title || selected.title,
          pushname: msg.pushName || 'User',
          quality: 'Movie',
          year,
          rating: metadata.imdb || 'N/A',
          duration: metadata.duration || 'N/A'
        });

        // Movie info card (same fields .movie shows, dynamically only those
        // present in the API response; footer applied at the bottom).
        let infoMsg = `☘️ ɪᴛʟᴇ : ${metadata.title || selected.title}\n`;
        if (metadata.language) infoMsg += `▫️ 🗣️ ʟᴀɴɢᴜᴀɢᴇ ➟ ${metadata.language}\n`;
        if (metadata.duration) infoMsg += `▫️ ⏳ ᴜʀᴀᴛɪᴏɴ ➟ ${metadata.duration}\n`;
        if (metadata.imdb) infoMsg += `▫️ ᴍᴅʙ ᴀᴛɪɴɢ ➟ ${metadata.imdb}\n`;
        if (metadata.genres && metadata.genres.length) infoMsg += `▫️ 🎭 ɢᴇɴʀᴇꜱ ➟ ${metadata.genres.join(', ')}\n`;
        if (metadata.directors && metadata.directors.length) infoMsg += `▫️ 🎥 ᴅɪʀᴇᴄᴛᴏʀꜱ ➟ ${metadata.directors.join(', ')}\n`;
        if (metadata.stars && metadata.stars.length) infoMsg += `▫️ 🌟 ꜱᴛᴀʀꜱ ➟ ${metadata.stars.slice(0, 5).join(', ')}${metadata.stars.length > 5 ? '...' : ''}\n`;
        infoMsg += `\n📤 *Destination:* ${state.destJid}\n\n` +
          `🔗 _Fetching download links..._\n\n${cinefrFooterBlock(renderedFooter)}`;

        if (metadata.thumbnail) {
          try {
            await socket.sendMessage(sender, { image: { url: metadata.thumbnail }, caption: infoMsg }, { quoted: msg });
          } catch (e) {
            await socket.sendMessage(sender, { text: infoMsg }, { quoted: msg });
          }
        } else {
          await socket.sendMessage(sender, { text: infoMsg }, { quoted: msg });
        }

        const downloadLinks = await getPixeldrainLinks(selected.movieUrl);
        if (!downloadLinks.length) {
          delete mvfrSessions[sessionKey];
          await socket.sendMessage(sender, { text: `*❌ No download links found (max ${movieMaxSizeLabel()})!*\n\n${config.BOT_FOOTER}` }, { quoted: msg });
          return true;
        }

        state.metadata = metadata;
        state.downloadLinks = downloadLinks;
        state.step = 'quality';
        state.timestamp = Date.now();
        mvfrSessions[sessionKey] = state;

        const qualityCaption =
          `╭━━〔 📥 *QUALITY* 〕━━⬣\n│ ${String(metadata.title || selected.title).substring(0, 45)}\n│\n` +
          downloadLinks.map((d, i) => `│ ${i + 1}. ${d.quality}  •  ${d.size}`).join('\n') +
          `\n│\n╰━━━━━━━━━━━━━━⬣\n\n💬 *Reply with the corresponding number.*\n\n${cinefrFooterBlock(renderedFooter)}`;

        await socket.sendMessage(sender, { text: qualityCaption }, { quoted: msg });
        return true;
      } catch (error) {
        console.error('Mvfr details error:', error);
        delete mvfrSessions[sessionKey];
        await socket.sendMessage(sender, { text: `*❪ ERROR ❫*\n\n❌ *Details Error!*\n🚫 _${error.message || 'Unknown error'}_\n\n${config.BOT_FOOTER}` }, { quoted: msg });
        return true;
      }
    }

    // ---------------- QUALITY → download → send to destJid ----------------
    if (state.step === 'quality') {
      const links = state.downloadLinks || [];
      if (num < 1 || num > links.length) {
        await socket.sendMessage(sender, { text: `*❪ INVALID ❫*\n\n⚠️ *Wrong Number!*\n🎯 *Range:* _01 - ${links.length}_\n\n${config.BOT_FOOTER}` }, { quoted: msg });
        return true;
      }
      const selectedLink = links[num - 1];
      const metadata = state.metadata || {};
      const title = metadata.title || state.selected.title;

      await socket.sendMessage(sender, { react: { text: '📥', key: msg.key } });
      await delay(1200); // anti-spam pacing
      await socket.sendMessage(sender, { text: `*${selectedLink.quality || 'Quality'} SELECTED ✓*\n\n📤 _Sending to:_ ${state.destJid}\n⏳ *Downloading...*` }, { quoted: msg });

      try {
        const directUrl = getDirectPixeldrainUrl(selectedLink.link);
        if (!directUrl) throw new Error('Download URL unavailable for this quality.');
        const sizeBytes = disk.parseSizeToBytes(selectedLink.size);
        if (sizeBytes > 0) disk.ensureDiskSpace(sizeBytes, `${title} (${selectedLink.quality})`);
        else await disk.ensureUrlSpace(directUrl, title);

        const footer = await resolveMvfrFooter(requester);
        const renderedFooter = renderMvfrFooter(footer, {
          title,
          pushname: msg.pushName || 'User',
          quality: selectedLink.quality || 'N/A',
          year: extractMovieYear(title),
          rating: metadata.imdb || 'N/A',
          duration: metadata.duration || 'N/A'
        });

        // Same caption structure as .movie, with the requester's footer.
        const caption =
          `🎞️ *${title}*\n\n` +
          `📊 *Quality* : ${selectedLink.quality}\n` +
          `💾 *Size*    : ${selectedLink.size}\n\n` +
          `🍿 Enjoy your Movie\n\n${cinefrFooterBlock(renderedFooter)}`;

        const fileName = `${String(title).substring(0, 50)} - ${selectedLink.quality}.mp4`.replace(/[^\w\s.-]/gi, '');

        let cardCaption = `☘️ ɪᴛʟᴇ : ${title}\n`;
        if (metadata.language) cardCaption += `▫️ 🗣️ ʟᴀɴɢᴜᴀɢᴇ ➟ ${metadata.language}\n`;
        if (metadata.duration) cardCaption += `▫️ ⏳ ᴜʀᴀᴛɪᴏɴ ➟ ${metadata.duration}\n`;
        if (metadata.imdb) cardCaption += `▫️ ᴍᴅʙ ᴀᴛɪɴɢ ➟ ${metadata.imdb}\n`;
        if (metadata.genres && metadata.genres.length) cardCaption += `▫️ 🎭 ɢᴇɴʀᴇꜱ ➟ ${metadata.genres.join(', ')}\n`;
        if (metadata.directors && metadata.directors.length) cardCaption += `▫️ 🎥 ᴅɪʀᴇᴄᴛᴏʀꜱ ➟ ${metadata.directors.join(', ')}\n`;
        if (metadata.stars && metadata.stars.length) cardCaption += `▫️ 🌟 ꜱᴛᴀʀꜱ ➟ ${metadata.stars.slice(0, 5).join(', ')}${metadata.stars.length > 5 ? '...' : ''}\n`;
        cardCaption += `📥 ${selectedLink.quality}  •  ${selectedLink.size}\n\n${cinefrFooterBlock(renderedFooter)}`;

        // Pre-download the thumbnail so the card sends instantly (buffer).
        let thumbBuffer = null;
        if (metadata.thumbnail) {
          try {
            const thumbRes = await axios.get(metadata.thumbnail, { responseType: 'arraybuffer', timeout: 15000 });
            thumbBuffer = Buffer.from(thumbRes.data);
          } catch {}
        }

        // Download the movie to a temp file first, so the card + file are sent
        // back-to-back (same time, fast) — exactly like .csong's card + song.
        const tempMovie = path.join(disk.getTempDir(), `${Date.now()}_${selectedLink.quality || 'q'}.mp4`);
        // Same @newsletter caveat as .cinefr: channels only accept the
        // restricted message shapes .csong already uses for them, and a
        // plain sendMessage() can resolve without actually delivering — so
        // track real success per part instead of assuming it worked.
        const isNewsletterDest = String(state.destJid || '').endsWith('@newsletter');
        let cardSent = false;
        let docSent = false;
        try {
          await disk.withDownloadSlot(async () => {
            // Stall-proof download: idle timeout + mid-stream error forwarding
            // + 3GB size cap, so a dead link can never pin the download slot
            // and freeze the bot for other users.
            await disk.downloadToFile(directUrl, tempMovie, { maxBytes: (config.MOVIE_MAX_SIZE_MB || 3072) * 1024 * 1024 });

            try {
              await socket.sendMessage(state.destJid, {
                image: thumbBuffer || { url: metadata.thumbnail },
                caption: cardCaption,
                jpegThumbnail: isNewsletterDest ? undefined : (thumbBuffer || undefined)
              });
              cardSent = true;
            } catch (e) {
              console.error('[mvfr] Card send failed:', e && e.message);
              try {
                await socket.sendMessage(state.destJid, { text: cardCaption });
                cardSent = true;
              } catch (e2) {
                console.error('[mvfr] Card text fallback failed:', e2 && e2.message);
              }
            }
            // Card + document sent back-to-back with no delay, so both arrive
            // at the same time — exactly like .csong's card + song.
            try {
              await socket.sendMessage(state.destJid, {
                document: { stream: fs.createReadStream(tempMovie) },
                mimetype: 'video/mp4',
                fileName,
                caption
              });
              docSent = true;
            } catch (e) {
              console.error('[mvfr] Document send failed:', e && e.message);
              if (isNewsletterDest) {
                try {
                  await socket.sendMessage(state.destJid, {
                    text: `🎬 *${title}*\n⚠️ _The video file could not be delivered to this channel (WhatsApp channels can reject large uploads)._`
                  });
                } catch (e2) {}
              }
            }
          });
        } finally {
          if (fs.existsSync(tempMovie)) fs.unlinkSync(tempMovie);
        }

        await socket.sendMessage(sender, { react: { text: docSent ? '✅' : '⚠️', key: msg.key } });
        await delay(1500); // anti-spam pacing
        const cardStatus = cardSent ? '✅ Info card' : '❌ Info card';
        const docStatus = docSent ? '✅ Video file' : '❌ Video file';
        const overallHeader = (cardSent && docSent) ? '*✅ SENT SUCCESSFULLY!*' : '*⚠️ SENT WITH ISSUES*';
        await socket.sendMessage(sender, {
          text: `${overallHeader}\n\n${cardStatus}\n${docStatus}\n\n🎬 *${title}*\n🎞️ *Quality:* ${selectedLink.quality}\n💾 *Size:* ${selectedLink.size}\n📤 *Sent to:* ${state.destJid}\n\n${config.BOT_FOOTER}`
        }, { quoted: msg });
      } catch (error) {
        console.error('Mvfr download error:', error);
        let reason = error.message || 'Unknown error';
        if (error.response && error.response.status === 404) reason = '404 Not Found (the provider has removed this link).';
        else if (error.response && error.response.status === 403) reason = '403 Forbidden (the provider blocked the request).';
        await socket.sendMessage(sender, { text: `*❪ FAILED ❫*\n\n⚠️ *Download could not be completed.*\n📉 _Reason: ${reason}_\n\n${config.BOT_FOOTER}` }, { quoted: msg });
      } finally {
        delete mvfrSessions[sessionKey];
      }
      return true;
    }

    return false;
  } catch (e) {
    console.error('[MVFR REPLY ERROR]', e);
    try { delete mvfrSessions[mvfrSessionKey(nowsender, from)]; } catch (err) {}
    return true;
  }
}

// ---------------- basic utils ----------------

function formatMessage(title, content, footer) {
  return `*${title}*\n\n${content}\n\n> *${footer}*`;
}
function generateOTP(){ return Math.floor(100000 + Math.random() * 900000).toString(); }
function getSriLankaTimestamp(){ return moment().tz('Asia/Colombo').format('YYYY-MM-DD HH:mm:ss'); }

const activeSockets = new Map();

const socketCreationTime = new Map();

const pairingInProgress = new Set();

const pairingSockets = new Map();

const latestPairCode = new Map();

const loggedOutSessions = new Set();

const connectWatchdog = new Map();

// ==================== MOVIE PLUGIN HELPERS ====================
const puppeteer = require('puppeteer');
const moviePendingSearch = {};
const moviePendingQuality = {};

// ==================== GENERIC NUMBER-REPLY SELECTION SYSTEM ====================
// Replaces every WhatsApp "button" / "list" message across the whole bot.
// Whenever the bot used to show buttons, it now sends a numbered text list and
// stores the options here. When the user replies with a plain number, we look
// it up and resolve it to the exact same command string the button used to send
// (e.g. "down_720 https://youtu.be/xxxx"), then let it flow through the normal
// command switch just like any typed command.
const pendingRowSelect = {};
const PENDING_ROW_TIMEOUT = 5 * 60 * 1000; // 5 minutes
const pendingInlineListeners = new Set(); // tracks senders with active inline listeners (cinesubz/cinetv/pp)
// Latest .cinetv menu sent per chat (sender = chat jid): { msgId, kind, ts }.
// Lets the cinetv reply handlers accept a PLAIN numbered reply (no quote) when
// it is the most recent step of the sender's own cinetv flow, and stops stale
// abandoned flows from stealing replies. In-memory like the listeners, so a bot
// restart still resets the flow.
const cinetvPendingMsg = new Map();
// Same registry for the .sinhalacartoons / .cartoon flow (search → quality).
const cartoonPendingMsg = new Map();
// Same registry for the .animost flow (search → quality).
const animostPendingMsg = new Map();
// Same registry for the .moviebox flow (search → quality).
const movieboxPendingMsg = new Map();
// Same registry for the .hanime / .hhentai flow (search → quality).
const hanimePendingMsg = new Map();
// Same registry for the .xvideos flow (search → quality).
const xvPendingMsg = new Map();
// Same registry for the .pupilvideo flow (search → quality).
const pupilvideoPendingMsg = new Map();
// Same registry for the .bestmovies / .bmovies flow (search → episodes).
const bestmoviesPendingMsg = new Map();
// Same registry for the .moviesublk / .msublk flow (search → quality).
const moviesublkPendingMsg = new Map();
// Tracks senders who need to reply with custom greeting text (welcome/goodbye/pwel)
const pendingWelcomeInput = {}; // { [sender]: 'welcome' | 'goodbye' | 'pwel' }
const PENDING_WELCOME_INPUT_TIMEOUT = 5 * 60 * 1000; // 5 minutes

function setPendingRowSelect(sender, rows) {
  delete moviePendingSearch[sender];
  delete moviePendingQuality[sender];
  // Cancel any active .mvfr flow in this chat (mirrors .movie behavior).
  for (const k in mvfrSessions) {
    if (String(k).endsWith('|' + sender)) delete mvfrSessions[k];
  }
  // Cancel any stale inline reply flow for this sender (cinetv / cartoon /
  // animost / moviebox / hanime / pupilvideo / bestmovies / moviesublk). These
  // flows register their own messages.upsert listeners and set a
  // pendingInlineListeners flag, but an abandoned flow never cleans up — which
  // left the flag set forever and silently blocked the generic number-reply
  // resolver (so .setting's Private/Public reply did nothing). Opening a NEW
  // numbered menu is a fresh intent, so dropping stale inline state is safe.
  pendingInlineListeners.delete(sender);
  cinetvPendingMsg.delete(sender);
  cartoonPendingMsg.delete(sender);
  animostPendingMsg.delete(sender);
  movieboxPendingMsg.delete(sender);
  hanimePendingMsg.delete(sender);
  pupilvideoPendingMsg.delete(sender);
  bestmoviesPendingMsg.delete(sender);
  moviesublkPendingMsg.delete(sender);
  delete pendingWelcomeInput[sender];
  pendingRowSelect[sender] = { rows, timestamp: Date.now(), botJid: currentBotJid() };
}

function buildNumberedList(rows) {
  return rows.map((r, i) => `*${i + 1}.* ${r.label}`).join('\n');
}

// Renders the settings menu as separate premium Unicode category boxes.
// The option numbers follow the SAME order as the settingRows array (1-30),
// so reply-selection logic (setPendingRowSelect) keeps working unchanged.
function buildBoxedSettingMenu(rows) {
  const categories = [
    { title: '✏️ 𝐁𝐎𝐓',           ids: [0] },
    { title: '🌐 𝐌𝐎𝐃𝐄',          ids: [1, 2] },
    { title: '👥 𝐂𝐇𝐀𝐓 𝐌𝐎𝐃𝐄',     ids: [3, 4] },
    { title: '🟢 𝐏𝐑𝐄𝐒𝐄𝐍𝐂𝐄',      ids: [5, 6] },
    { title: '⌨️ 𝐓𝐘𝐏𝐈𝐍𝐆',        ids: [7, 8] },
    { title: '🎙️ 𝐑𝐄𝐂𝐎𝐑𝐃𝐈𝐍𝐆',     ids: [9, 10] },
    { title: '👍 𝐑𝐄𝐀𝐂𝐓𝐈𝐎𝐍',      ids: [11, 12] },
    { title: '👁️ 𝐒𝐓𝐀𝐓𝐔𝐒',        ids: [13, 14, 15, 16] },
    { title: '📵 𝐂𝐀𝐋𝐋',           ids: [17, 18] },
    { title: '📖 𝐑𝐄𝐀𝐃 𝐌𝐄𝐒𝐒𝐀𝐆𝐄',  ids: [19, 20, 21] },
    { title: '🛡️ 𝐀𝐍𝐓𝐈 𝐃𝐄𝐋𝐄𝐓𝐄',   ids: [22, 23, 24] },
    { title: '💬 𝐏𝐄𝐑𝐒𝐎𝐍𝐀𝐋 𝐆𝐑𝐄𝐄𝐓', ids: [25, 26, 27] },
    { title: '🤖 𝐀𝐔𝐓𝐎 𝐑𝐄𝐏𝐋𝐘',    ids: [28, 29] },
    { title: '🧩 𝐀𝐔𝐓𝐎 𝐒𝐓𝐈𝐂𝐊𝐄𝐑',  ids: [30, 31] },
    { title: '🎙️ 𝐀𝐔𝐓𝐎 𝐕𝐎𝐈𝐂𝐄',    ids: [32, 33] },
    { title: '🎵 𝐌𝐔𝐒𝐈𝐂 𝐅𝐎𝐎𝐓𝐄𝐑', ids: [34, 35, 36] },
    { title: '🎬 𝐌𝐎𝐕𝐈𝐄/𝐂𝐈𝐍𝐄 𝐅𝐎𝐑𝐖𝐀𝐑𝐃', ids: [37, 38, 39, 40, 41] },
    { title: '💎 𝐏𝐑𝐄𝐌𝐈𝐔𝐌', ids: [42, 43] }
  ];
  return categories.map((cat) => {
    const lines = cat.ids.map((idx) => {
      const row = rows[idx];
      if (!row) return '';
      return `│ *${idx + 1}.* ${row.label}`;
    }).filter(Boolean);
    return `╭━━━〔 ${cat.title} 〕━━━⬣\n${lines.join('\n')}\n╰━━━━━━━━━━━━━━━⬣`;
  }).join('\n\n');
}

// How long we allow each browser launch / page navigation to take before giving up.
// Raised from the old hardcoded 30000ms because "networkidle2" + a cold Chromium
// launch on small/shared hosts routinely needs more than 30s.
const MOVIE_NAV_TIMEOUT = 60000;
const MOVIE_LAUNCH_TIMEOUT = 60000;

// Human-readable label for the max movie file size (e.g. "4GB" / "2048MB").
function movieMaxSizeLabel() {
  const mb = config.MOVIE_MAX_SIZE_MB || 2048;
  if (mb >= 1024 && mb % 1024 === 0) return `${mb / 1024}GB`;
  return `${mb}MB`;
}

function normalizeQuality(text) {
  if (!text) return null;
  text = text.toUpperCase();
  if (/1080|FHD/.test(text)) return "1080p";
  if (/720|HD/.test(text)) return "720p";
  if (/480|SD/.test(text)) return "480p";
  return text;
}

function getDirectPixeldrainUrl(url) {
  const match = url.match(/pixeldrain\.com\/u\/(\w+)/);
  if (!match) return null;
  return `https://pixeldrain.com/api/file/${match[1]}?download`;
}

// Puppeteer's bundled Chrome download is skipped now (see .puppeteerrc.cjs —
// it was failing npm install on this host). So at runtime we need to point
// at a real Chrome/Chromium binary ourselves: PUPPETEER_EXECUTABLE_PATH if
// set, otherwise the system `chromium`/`chromium-browser` package installed
// by the "preinstall" script in package.json. Returns undefined (letting
// Puppeteer fall back to its own resolution) only if none of these exist.
function findSystemChromePath() {
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome'
  ].filter(Boolean);
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch (e) {}
  }
  return undefined;
}

// Shared browser launcher. Centralizing this means we only tweak flags/timeouts
// in one place, and we can add more --disable-* flags to cut Chromium's
// startup/render overhead, which is what actually caused most of the timeouts.
async function launchMovieBrowser() {
  return puppeteer.launch({
    headless: true,
    executablePath: findSystemChromePath(),
    timeout: MOVIE_LAUNCH_TIMEOUT,
    protocolTimeout: MOVIE_NAV_TIMEOUT + 30000, // give CDP calls (evaluate/$$eval) more room than nav timeout
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",      // avoids /dev/shm OOM crashes on small containers
      "--disable-gpu",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-default-apps",
      "--disable-sync",
      "--no-first-run",
      "--no-zygote",
      // NOTE: --single-process was removed. On low-RAM hosts it makes the
      // browser/renderer share one OS process, so any renderer crash (e.g.
      // from a heavy/odd page) kills the whole browser mid-script, which is
      // exactly what causes "Protocol error (Runtime.callFunctionOn): Target
      // closed". Running browser + renderer as separate processes lets a
      // single tab crash without taking the whole instance down.
      "--disable-blink-features=AutomationControlled",
      "--disable-features=site-per-process,TranslateUI",
      "--js-flags=--max-old-space-size=256" // cap V8 heap so a runaway page can't OOM the box
    ]
  });
}

// ---- Browser concurrency cap ----
// Every .movie scrape launches a headless Chromium. Without a cap, several
// users running .movie at once spawn that many browsers and exhaust RAM on
// small hosts — which makes the bot feel frozen / slow to respond. Cap the
// number of CONCURRENT browser instances at 2; extra requests queue briefly
// (the user already sees "Searching…") instead of crashing the box.
const MOVIE_BROWSER_SLOTS = 2;
let activeMovieBrowsers = 0;
const movieBrowserWaiters = [];

function acquireMovieBrowserSlot() {
  if (activeMovieBrowsers < MOVIE_BROWSER_SLOTS) {
    activeMovieBrowsers++;
    return Promise.resolve();
  }
  return new Promise(resolve => movieBrowserWaiters.push(resolve));
}

function releaseMovieBrowserSlot() {
  activeMovieBrowsers = Math.max(0, activeMovieBrowsers - 1);
  const next = movieBrowserWaiters.shift();
  if (next) next();
}

// Navigate with a fast strategy first, then fall back to a slower one instead
// of just dying. "domcontentloaded" fires as soon as the HTML/CSS we actually
// need is parsed, without waiting for every tracker/ad request to go quiet
// (which is what "networkidle2" was doing and why it kept timing out).
async function gotoResilient(page, url, timeout = MOVIE_NAV_TIMEOUT) {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout });
  } catch (e) {
    // Retry once with a fresh attempt before giving up — handles transient
    // slow DNS / first-byte delays without burning the full timeout twice.
    await page.goto(url, { waitUntil: "load", timeout });
  }
}

// Wraps a scrape function so a single "Target closed" / crashed-browser
// failure (common on low-RAM hosts) gets one automatic retry with a brand
// new browser instance, instead of bubbling straight up to the user as a
// raw Puppeteer protocol error.
async function withMovieRetry(fn, label, retries = 1) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const isCrash = /target closed|session closed|protocol error|disconnected/i.test(e.message || '');
      console.error(`[movie] ${label} attempt ${attempt + 1} failed:`, e.message);
      if (!isCrash || attempt === retries) break;
      await new Promise(r => setTimeout(r, 1500)); // brief cooldown before relaunching
    }
  }
  if (/target closed|session closed|protocol error|disconnected/i.test(lastErr?.message || '')) {
    throw new Error('The movie site / browser crashed while loading (low memory or site issue). Please try again.');
  }
  throw lastErr;
}

async function searchMoviesOnce(query) {
  const searchUrl = `https://sinhalasub.lk/?s=${encodeURIComponent(query)}&post_type=movies`;
  await acquireMovieBrowserSlot();
  let browser;
  try {
    browser = await launchMovieBrowser();
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on('request', req => {
      // Block heavy/irrelevant resources so the page settles faster and uses less RAM.
      const type = req.resourceType();
      if (type === 'image' || type === 'font' || type === 'media') req.abort();
      else req.continue();
    });
    await gotoResilient(page, searchUrl);

    // If the search container itself isn't present, the site likely changed
    // its markup or blocked us — fail loudly instead of returning [] silently
    // (an empty [] gets reported to the user as "no results found", which is
    // misleading when the real cause is a broken selector).
    const containerExists = await page.$(".display-item") !== null
      || await page.$(".item-box") !== null
      || await page.$("body") !== null; // body always exists; real check below
    const hasAnyBox = await page.$(".display-item .item-box") !== null;
    if (!hasAnyBox) {
      // Distinguish "page loaded but genuinely has 0 matches" from
      // "page structure changed / selector is wrong / we got blocked".
      const pageHtmlLength = await page.evaluate(() => document.body ? document.body.innerHTML.length : 0);
      if (pageHtmlLength < 500) {
        throw new Error('sinhalasub.lk returned an empty/blocked page. The site may be down or blocking automated requests.');
      }
      // Page loaded with real content but no matching boxes -> genuine zero results.
      return [];
    }

    const results = await page.$$eval(".display-item .item-box", boxes =>
      boxes.slice(0, 10).map((box, index) => {
        const a = box.querySelector("a");
        const img = box.querySelector(".thumb");
        const lang = box.querySelector(".item-desc-giha .language")?.textContent || "";
        const quality = box.querySelector(".item-desc-giha .quality")?.textContent || "";
        const qty = box.querySelector(".item-desc-giha .qty")?.textContent || "";
        return {
          id: index + 1,
          title: a?.title?.trim() || "",
          movieUrl: a?.href || "",
          thumb: img?.src || "",
          language: lang.trim(),
          quality: quality.trim(),
          qty: qty.trim(),
        };
      }).filter(m => m.title && m.movieUrl)
    );
    // Defensive: never let an undefined/non-array value escape this function.
    return Array.isArray(results) ? results : [];
  } catch (e) {
    if (/timeout/i.test(e.message)) {
      throw new Error(`Site took too long to respond (sinhalasub.lk may be slow or your server connection is weak). Try again in a bit.`);
    }
    throw e;
  } finally {
    if (browser) await browser.close().catch(() => {});
    releaseMovieBrowserSlot();
  }
}

async function searchMovies(query) {
  return withMovieRetry(() => searchMoviesOnce(query), 'searchMovies');
}

async function getMovieMetadataOnce(url) {
  await acquireMovieBrowserSlot();
  let browser;
  try {
    browser = await launchMovieBrowser();
    const page = await browser.newPage();
    await gotoResilient(page, url);
    const metadata = await page.evaluate(() => {
      const getText = el => el?.textContent.trim() || "";
      const getList = selector => Array.from(document.querySelectorAll(selector)).map(el => el.textContent.trim());
      const title = getText(document.querySelector(".info-details .details-title h3"));
      let language = "", directors = [], stars = [];
      document.querySelectorAll(".info-col p").forEach(p => {
        const strong = p.querySelector("strong");
        if (!strong) return;
        const txt = strong.textContent.trim();
        if (txt.includes("Language:")) language = strong.nextSibling?.textContent?.trim() || "";
        if (txt.includes("Director:")) directors = Array.from(p.querySelectorAll("a")).map(a => a.textContent.trim());
        if (txt.includes("Stars:")) stars = Array.from(p.querySelectorAll("a")).map(a => a.textContent.trim());
      });
      const duration = getText(document.querySelector(".info-details .data-views[itemprop='duration']"));
      const imdb = (getText(document.querySelector(".info-details .data-imdb"))?.replace("IMDb:", "").trim()) || "";
      const genres = getList(".details-genre a");
      const thumbnail = document.querySelector(".splash-bg img")?.src || "";
      return { title, language, duration, imdb, genres, directors, stars, thumbnail };
    });
    // Defensive default so callers never dereference undefined fields.
    return metadata || { title: "", language: "", duration: "", imdb: "", genres: [], directors: [], stars: [], thumbnail: "" };
  } catch (e) {
    if (/timeout/i.test(e.message)) {
      throw new Error(`Site took too long to respond while loading movie details. Try again in a bit.`);
    }
    throw e;
  } finally {
    if (browser) await browser.close().catch(() => {});
    releaseMovieBrowserSlot();
  }
}

async function getMovieMetadata(url) {
  return withMovieRetry(() => getMovieMetadataOnce(url), 'getMovieMetadata');
}

// Pulls the real download URL out of a sinhalasub.lk /links/ page.
// The site replaced its old countdown page (which revealed a .wait-done
// anchor after 12s) with a 3-step verification UI. The verification is
// purely client-side ad buttons + timers — the actual final URL is still
// embedded in the page source as a plain JS variable:
//   var zluFinalLink = 'https://pixeldrain.com/u/XXXX';
// We read that directly (no clicks, no waiting); the old .wait-done
// selector is kept as a fallback for any not-yet-migrated pages.
async function extractFinalDownloadUrl(page) {
  let html = "";
  try { html = await page.content(); } catch (e) { /* fall through to selector */ }
  const m = html.match(/zluFinalLink\s*=\s*'([^']+)'/);
  if (m && /^https:\/\/pixeldrain\.com\//.test(m[1])) return m[1];
  return page.$eval(".wait-done a[href^='https://pixeldrain.com/']", el => el.href).catch(() => null);
}

async function getPixeldrainLinksOnce(movieUrl) {
  await acquireMovieBrowserSlot();
  let browser;
  try {
    browser = await launchMovieBrowser();
    const page = await browser.newPage();
    await gotoResilient(page, movieUrl);
    const linksData = await page.$$eval(".link-pixeldrain tbody tr", rows =>
      rows.map(row => {
        const a = row.querySelector(".link-opt a");
        const quality = row.querySelector(".quality")?.textContent.trim() || "";
        const size = row.querySelector("td:nth-child(3) span")?.textContent.trim() || "";
        return { pageLink: a?.href || "", quality, size };
      })
    ).catch(() => []); // selector missing (site changed / no pixeldrain table) -> treat as zero links, not a crash
    const directLinks = [];
    const pool = (linksData || []).filter(l => l && l.pageLink);
    // Resolve the quality-link pages IN PARALLEL (3 at a time) instead of one
    // after another. Sequential resolution made a movie with several
    // qualities take (page count × nav time) before the quality menu appeared
    // — that sequential wait is what made .movie feel slow / late to respond.
    const CONCURRENCY = 3;
    let cursor = 0;
    const worker = async () => {
      while (cursor < pool.length) {
        const l = pool[cursor++];
        try {
          const subPage = await browser.newPage();
          await gotoResilient(subPage, l.pageLink);
          let finalUrl = await extractFinalDownloadUrl(subPage);
          if (!finalUrl) {
            // Old-style countdown page: the .wait-done anchor appears only
            // after the timer (and the zluFinalLink JS var may be set by an
            // async script that hasn't run yet at domcontentloaded). Poll
            // every 1.5s instead of sleeping a fixed 12s, so a link that
            // appears at 2s or 8s resolves immediately instead of always
            // waiting the full timer.
            const pollDeadline = Date.now() + 12000;
            while (Date.now() < pollDeadline) {
              await new Promise(r => setTimeout(r, 1500));
              finalUrl = await extractFinalDownloadUrl(subPage);
              if (finalUrl) break;
            }
          }
          if (finalUrl) {
            let sizeMB = 0;
            const sizeText = String(l.size || '').toUpperCase();
            if (sizeText.includes("GB")) sizeMB = parseFloat(sizeText) * 1024;
            else if (sizeText.includes("MB")) sizeMB = parseFloat(sizeText);
            if (sizeMB <= config.MOVIE_MAX_SIZE_MB) {
              directLinks.push({ link: finalUrl, quality: normalizeQuality(l.quality), size: l.size });
            }
          }
          await subPage.close().catch(() => {});
        } catch (e) { /* one bad link never blocks the others */ }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pool.length) }, () => worker()));
    return directLinks;
  } catch (e) {
    if (/timeout/i.test(e.message)) {
      throw new Error(`Site took too long to respond while fetching download links. Try again in a bit.`);
    }
    throw e;
  } finally {
    if (browser) await browser.close().catch(() => {});
    releaseMovieBrowserSlot();
  }
}

async function getPixeldrainLinks(movieUrl) {
  return withMovieRetry(() => getPixeldrainLinksOnce(movieUrl), 'getPixeldrainLinks');
}

setInterval(() => {
  const now = Date.now();
  const timeout = 10 * 60 * 1000;
  for (const s in moviePendingSearch) if (now - moviePendingSearch[s].timestamp > timeout) delete moviePendingSearch[s];
  for (const s in moviePendingQuality) if (now - moviePendingQuality[s].timestamp > timeout) delete moviePendingQuality[s];
  for (const s in cinefrSessions) if (now - cinefrSessions[s].timestamp > timeout) delete cinefrSessions[s];
  for (const s in mvfrSessions) if (now - mvfrSessions[s].timestamp > timeout) delete mvfrSessions[s];
  for (const s in pendingRowSelect) if (now - pendingRowSelect[s].timestamp > PENDING_ROW_TIMEOUT) delete pendingRowSelect[s];
  for (const s in pendingWelcomeInput) if (now - pendingWelcomeInput[s].timestamp > PENDING_WELCOME_INPUT_TIMEOUT) delete pendingWelcomeInput[s];
}, 5 * 60 * 1000);
// ==================== END MOVIE PLUGIN HELPERS ====================

const otpStore = new Map();

// ---------------- helpers kept/adapted ----------------

async function joinGroup(socket) {
  let retries = config.MAX_RETRIES;
  const inviteCodeMatch = (config.GROUP_INVITE_LINK || '').match(/chat\.whatsapp\.com\/([a-zA-Z0-9]+)/);
  if (!inviteCodeMatch) return { status: 'failed', error: 'No group invite configured' };
  const inviteCode = inviteCodeMatch[1];
  while (retries > 0) {
    try {
      const response = await socket.groupAcceptInvite(inviteCode);
      if (response?.gid) return { status: 'success', gid: response.gid };
      throw new Error('No group ID in response');
    } catch (error) {
      retries--;
      let errorMessage = error.message || 'Unknown error';
      if (error.message && error.message.includes('not-authorized')) errorMessage = 'Bot not authorized';
      else if (error.message && error.message.includes('conflict')) errorMessage = 'Already a member';
      else if (error.message && error.message.includes('gone')) errorMessage = 'Invite invalid/expired';
      if (retries === 0) return { status: 'failed', error: errorMessage };
      await delay(2000 * (config.MAX_RETRIES - retries));
    }
  }
  return { status: 'failed', error: 'Max retries reached' };
}

// Ensure the bot is in its home group (config.NEWSLETTER_JID). If the JID is a
// real group (…@g.us), verify membership directly via groupMetadata — the bot
// may already have been added by the owner (the old GROUP_INVITE_LINK group was
// suspended, so we can no longer rely on the invite code alone). If it's not a
// member yet, fall back to the invite-link join.
async function ensureHomeGroup(socket) {
  const groupJid = String(config.NEWSLETTER_JID || '').trim();
  if (groupJid.endsWith('@g.us')) {
    try {
      const meta = await socket.groupMetadata(groupJid);
      if (meta && meta.id) return { status: 'success', gid: meta.id };
    } catch (e) { /* not a member (yet) → fall through to invite join */ }
  }
  return joinGroup(socket);
}

async function sendOTP(socket, number, otp) {
  botBrandAls.enterWith({ bc: null }); // web/API context — never leak a user's brand into OTP messages
  const userJid = jidNormalizedUser(socket.user.id);
  const message = formatMessage(`*🔐 𝐎𝚃𝙿 𝐕𝙴𝚁𝙸𝙵𝙸𝙲𝙰𝚃𝙸𝙾𝙽 — ${BOT_NAME_FANCY}*`, `*𝐘𝙾𝚄𝚁 𝐎𝚃𝙿 𝐅𝙾𝚁 𝐂𝙾𝙽𝙵𝙸𝙶 𝐔𝙿𝙳𝙰𝚃𝙴 𝐈𝚂:* *${otp}*\n𝐓𝙷𝙸𝚂 𝐎𝚃𝙿 𝐖𝙸𝙻𝙻 𝐄𝚇𝙿𝙸𝚁𝙴 𝐈𝙽 5 𝐌𝙸𝙽𝚄𝚃𝙴𝚂.\n\n*𝐍𝚄𝙼𝙱𝙴𝚁:* ${number}`, BOT_NAME_FANCY);
  try { await socket.sendMessage(userJid, { text: message }); console.log(`OTP ${otp} sent to ${number}`); }
  catch (error) { console.error(`Failed to send OTP to ${number}:`, error); throw error; }
}

// ==================== PREMIUM USER BOT BASE CUSTOMIZATION ====================
// Premium users (managed ONLY by the existing config.OWNER_NUMBER owners) get
// their own personal base-bot customization: bot name, footer, images, alive
// and menu settings. Stored per-JID in Mongo (premiumusers collection) so it
// survives restarts/reconnects/session reloads. getUserBotConfig(jid) is the
// central source used by base commands (.alive/.menu) to render each user's
// personal bot. Movie / CineSubz / CineFR / MVFR / music / download features
// are NOT touched by this system.

const PREMIUM_DEFAULTS = {
  botName: config.BOT_NAME,
  botFooter: config.BOT_FOOTER,
  botImage: config.IMAGE_PATH,
  botLogo: config.RCD_IMAGE_PATH,
  aliveImage: config.IMAGE_PATH,
  menuHeader: ''
};

const PREMIUM_CUSTOM_FIELDS = Object.keys(PREMIUM_DEFAULTS);

// Command name → camelCase field map. A naive `f.toLowerCase() === command`
// match FAILED for the image fields: 'botImage' lowercases to 'botimage' but
// the command is 'botimg' (no 'e'), so images were saved under lowercase keys
// ('botimg') that getUserBotConfig never read ('botImage') — premium bot
// images silently never applied.
const PREMIUM_CMD_FIELD_MAP = {
  botname: 'botName', botfooter: 'botFooter', botimg: 'botImage',
  botlogo: 'botLogo', aliveimg: 'aliveImage', menuheader: 'menuHeader'
};

// Legacy lowercase keys that older premium docs may still store; read as a
// fallback so old customization applies even before the DB migration runs.
const PREMIUM_FIELD_ALIASES = { botImage: ['botimg'], aliveImage: ['aliveimg'] };

// Commands that configure a single bot's OWN appearance (or manage premium).
// In a chat shared by several connected bots these must execute on exactly ONE
// bot — the @mentioned one — so no bot can modify another bot's config and no
// duplicate replies are sent (see the perBotAllowed gate before the command
// switch). Private chats and single-bot groups are unaffected.
const PER_BOT_COMMANDS = new Set([
  'premiummenu', 'botname', 'botfooter', 'botimg', 'botlogo', 'aliveimg', 'menuheader',
  'setpremium', 'setfooter', 'setftr', 'csongfooter', 'setcsongfooter',
  'getfooter', 'getcsongfr', 'resetfooter', 'resetcsong'
]);

const premiumCache = new Map();
const PREMIUM_CACHE_TTL = 30 * 1000;

// Fetch a user's premium doc (null when none). 30s in-memory cache like the
// other Mongo helpers; DB is always the source of truth.
async function getPremiumUser(jid) {
  try {
    const key = String(jid || '');
    if (!key) return null;
    const cached = premiumCache.get(key);
    if (cached && (Date.now() - cached.ts < PREMIUM_CACHE_TTL)) return cached.doc;
    await initMongo();
    const doc = await premiumUsersCol.findOne({ jid: key });
    premiumCache.set(key, { doc, ts: Date.now() });
    return doc;
  } catch (e) { console.error('getPremiumUser error:', e); return null; }
}

// A premium doc is active only when it was explicitly granted (premium: true)
// and has not expired. expiresAt 0/null = lifetime.
function isPremiumDocActive(doc) {
  try {
    if (!doc) return false;
    if (doc.premium !== true) return false;
    if (!doc.expiresAt || doc.expiresAt <= 0) return true;
    return Date.now() < doc.expiresAt;
  } catch (e) { return false; }
}

async function isPremium(jid) {
  return isPremiumDocActive(await getPremiumUser(jid));
}

// Full access = owner (config.OWNER_NUMBER, never expires) OR active premium.
async function hasPremiumAccess(jid) {
  if (isOwnerNumber(jid)) return true;
  return isPremium(jid);
}

// Normalize a requester JID down to its phone JID (phone@s.whatsapp.net) using
// the existing LID resolver. Premium is granted by phone JID, so a sender
// reported as @lid must map back to their phone JID before any premium check
// or customization storage — otherwise a LID-rendered user would be locked out.
async function normalizePremiumJid(socket, jid) {
  try {
    const phone = await resolveSenderPhone(socket, jid);
    return phone ? `${phone}@s.whatsapp.net` : String(jid || '');
  } catch (e) { return String(jid || ''); }
}

// Grant / renew premium. days <= 0 or lifetime => never expires.
async function setPremiumUser(jid, { days = 0, lifetime = false } = {}) {
  try {
    const key = String(jid || '');
    if (!key) return false;
    const expiresAt = (!lifetime && days > 0) ? Date.now() + days * 86400000 : 0;
    await initMongo();
    await premiumUsersCol.updateOne(
      { jid: key },
      { $set: { jid: key, premium: true, expiresAt, expiredNotified: false, updatedAt: new Date() } },
      { upsert: true }
    );
    premiumCache.delete(key);
    return true;
  } catch (e) { console.error('setPremiumUser error:', e); return false; }
}

// ---------------- 18+ (NSFW) verification ----------------
// Owners are always verified. Everyone else must be explicitly granted by an
// owner via .verify18 <jid> (revoked with .unverify18) AND must have ACTIVE
// premium: 18+ verification is a premium perk, so it expires together with the
// user's premium (isPremiumDocActive). Lifetime premium keeps it forever.
async function isNsfwVerified(socket, jid) {
  try {
    const phone = await resolveSenderPhone(socket, jid);
    if (phone && isOwnerNumber(phone)) return true;
    const key = await normalizePremiumJid(socket, jid);
    if (!key) return false;
    await initMongo();
    const doc = await nsfwUsersCol.findOne({ jid: key });
    if (!(doc && doc.verified === true)) return false;
    // 18+ access is tied to premium — an expired (or never-premium) user loses
    // it even if the stored flag is still set (e.g. premium ran out).
    return isPremiumDocActive(await getPremiumUser(key));
  } catch (e) { console.error('isNsfwVerified error:', e); return false; }
}

async function setNsfwVerified(jid, verified) {
  try {
    const key = String(jid || '');
    if (!key) return false;
    await initMongo();
    if (verified) {
      await nsfwUsersCol.updateOne(
        { jid: key },
        { $set: { jid: key, verified: true, updatedAt: new Date() } },
        { upsert: true }
      );
    } else {
      await nsfwUsersCol.deleteOne({ jid: key });
    }
    return true;
  } catch (e) { console.error('setNsfwVerified error:', e); return false; }
}

function nsfwDeniedText() {
  const owners = getPublicOwnerNumber();
  return `*🔞 18+ VERIFICATION REQUIRED*

🚫 _This is 18+ (NSFW) content and is locked._

⚠️ *You are not 18+ verified.*

🎟️ *18+ access is a premium perk* — you need active premium AND owner verification.
💡 *To get verified:* Contact the owner and request premium + NSFW access.
👤 *Owner:* ${owners}

${config.BOT_FOOTER}`;
}

// Format an expiresAt timestamp for premium messages (Asia/Colombo rendered).
// expiresAt 0/null => lifetime (never expires). Returns the display string.
function formatPremiumExpiry(expiresAt) {
  try {
    if (!expiresAt || expiresAt <= 0) return '♾️ *Never Expires*';
    return moment(expiresAt).tz('Asia/Colombo').format('dddd, DD MMMM YYYY • hh:mm A');
  } catch (e) { return '♾️ *Never Expires*'; }
}

// Time-of-day greeting used on the premium-activated banner.
function getPremiumGreeting() {
  try {
    const h = moment().tz('Asia/Colombo').hour();
    if (h < 12) return '☀️ *Good Morning!*';
    if (h < 17) return '🌤️ *Good Afternoon!*';
    return '🌙 *Good Evening!*';
  } catch (e) { return '👋 *Hello!*'; }
}

// Public-facing owner number(s) shown in menus / system info / NSFW prompts.
// Separate from OWNER_NUMBER so the real (hidden) owners stay private.
function getPublicOwnerNumber() {
  return String(config.PUBLIC_OWNER_NUMBER || config.OWNER_NUMBER || '')
    .split(',')
    .map(normalizeOwnerNumber)
    .filter(Boolean)
    .join(' / ') || '-';
}

// Comma-separated OWNER_NUMBER list rendered as one contact line.
function ownerContactLine() {
  return getPublicOwnerNumber();
}

// Throttle timestamp for the "notify session offline" log (see
// notifyPremiumExpiry) so a flood of messages doesn't spam the console.
let notifyExpiryLogTs = 0;

// The session number that is the ONLY sender of premium notifications
// (activated / expired / owner alerts) — premium notices must never come from
// other users' sessions, only from this owner session (config).
function getPremiumNotifyNumber() {
  return String(config.PREMIUM_NOTIFY_NUMBER || '94720251446').replace(/[^0-9]/g, '');
}

// The live socket for the premium-notify session, or null when that session is
// offline. All premium notifications go through this socket so they always
// appear to come from the premium-owner's number.
function getPremiumNotifySocket() {
  try {
    const n = getPremiumNotifyNumber();
    if (!n) return null;
    return activeSockets.get(n) || null;
  } catch (e) { return null; }
}

// Premium managers = the bot owners (config.OWNER_NUMBER) + the premium-notify
// number. They may run the premium CUSTOMIZATION commands (premiummenu, etc.);
// the .setpremium grant itself is limited to isLockedPremiumExecutor() (config
// owners + the locked premium-notify number).
async function isPremiumManager(senderNum) {
  try {
    const n = normalizeOwnerNumber(senderNum);
    if (!n) return false;
    if (getOwnerNumbers().includes(n)) return true;
    return n === getPremiumNotifyNumber();
  } catch (e) { return false; }
}

// 🔒 EXECUTOR for .setpremium: the sender must be the locked JID
// (config.PREMIUM_NOTIFY_NUMBER = 94720251446) OR any number present in
// config.OWNER_NUMBER. The locked JID always works, even when an OWNER_NUMBER
// env override excludes it. Keeps the executor JID, the target premium JID and
// the current bot JID completely separate.
function isLockedPremiumExecutor(senderNum) {
  try {
    const n = normalizeOwnerNumber(senderNum);
    if (!n) return false;
    const locked = getPremiumNotifyNumber(); // single source of truth = 94720251446
    if (!locked) return false;
    if (n === locked) return true; // locked number always works
    return getOwnerNumbers().includes(n); // any config owner works too
  } catch (e) { return false; }
}

// Informational startup note: if the locked executor is missing from
// config.OWNER_NUMBER (e.g. an OWNER_NUMBER env override), .setpremium still
// works for the locked number itself and for every other config owner, but the
// locked number cannot be a premium TARGET through other owners' checks.

// One-time premium expiry notification. Called on incoming user messages: when
// a premium doc has passed expiresAt and the user was never told, sends a
// stylish expiry message to the user + an alert to every owner. Both messages
// are sent FROM the premium-notify session (config.PREMIUM_NOTIFY_NUMBER) so
// they always appear to come from that number — never from other users'
// sessions. Sets expiredNotified so it never repeats (renew resets the flag).
async function notifyPremiumExpiry(socket, jid) {
  try {
    const key = String(jid || '');
    if (!key || !socket || !socket.sendMessage) return;
    const doc = await getPremiumUser(key);
    if (!doc) return;
    if (doc.premium !== true || !doc.expiresAt || doc.expiresAt <= 0) return;
    if (Date.now() < doc.expiresAt || doc.expiredNotified === true) return;
    // Send ONLY from the premium-notify session — never from other sessions.
    // If that session is offline, wait for it (don't leak the notice from a
    // different number).
    const notifySock = getPremiumNotifySocket();
    if (!notifySock || !notifySock.sendMessage) {
      // Throttle: only log once per 5 min so a flood of user messages while
      // the notify session is down doesn't spam the console. The notice stays
      // pending (expiredNotified not set) and fires when the session returns.
      try {
        if (!notifyExpiryLogTs || Date.now() - notifyExpiryLogTs > 300000) {
          notifyExpiryLogTs = Date.now();
          console.warn('notifyPremiumExpiry pending: premium-notify session offline');
        }
      } catch (e) {}
      return;
    }
    const userMsg = `╔═══『  💎 𝐏𝐑𝐄𝐌𝐈𝐔𝐌 𝐄𝐗𝐏𝐈𝐑𝐄𝐃  』═══❒\n╠⦁ ⚠️ *Your premium has expired*\n╠⦁\n╠⦁ 👤 *User:* ${key.split('@')[0]}\n╠⦁ 📅 *Expired on:* ${formatPremiumExpiry(doc.expiresAt)}\n╠⦁\n╠⦁ 💡 *Want to continue premium?*\n╠⦁ 📞 *Contact the Owner:* ${ownerContactLine()}\n╠⦁ ♻️ Renew anytime — your features are paused until then\n╚═══════════════════════❒\n${config.BOT_FOOTER}`;
    // Expiry notice goes to the premium user + an alert to every owner (the
    // config owners AND the premium-notify number itself) — both FROM the
    // premium-notify session only.
    await notifySock.sendMessage(key, { text: userMsg }).catch(() => {});
    const alertRecipients = new Set([...getOwnerNumbers(), getPremiumNotifyNumber()]);
    for (const ownerNum of alertRecipients) {
      const ownerJid = `${ownerNum}@s.whatsapp.net`;
      if (!ownerNum || ownerJid === key) continue; // the user already got their notice
      const ownerMsg = `╔═══『  💎 𝐏𝐑𝐄𝐌𝐈𝐔𝐌 𝐄𝐗𝐏𝐈𝐑𝐄𝐃  』═══❒\n╠⦁ 👤 *User:* ${key.split('@')[0]}\n╠⦁ 📅 *Expired on:* ${formatPremiumExpiry(doc.expiresAt)}\n╠⦁\n╠⦁ ♻️ *Re-activate:* ${config.PREFIX || '.'}setpremium ${key.split('@')[0]}@s.whatsapp.net <days|lifetime>\n╚═══════════════════════❒\n${config.BOT_FOOTER}`;
      await notifySock.sendMessage(ownerJid, { text: ownerMsg }).catch(() => {});
    }
    await initMongo();
    await premiumUsersCol.updateOne({ jid: key }, { $set: { expiredNotified: true, updatedAt: new Date() } });
    // 18+ verification is a premium perk — revoke the stored flag so the user
    // is locked out of NSFW content the moment premium runs out (isNsfwVerified
    // also enforces this live, this just cleans up the stored grant).
    try { await nsfwUsersCol.deleteOne({ jid: key }); } catch (e) {}
    premiumCache.delete(key);
  } catch (e) { console.error('notifyPremiumExpiry error:', e); }
}

// Save one custom field on the CURRENT user's own premium doc. upsert creates
// the doc but never marks it premium (only setPremiumUser does), so a field-
// only doc can't accidentally grant premium status.
async function updatePremiumField(jid, field, value) {
  try {
    const key = String(jid || '');
    if (!key || !field) return false;
    await initMongo();
    await premiumUsersCol.updateOne(
      { jid: key },
      {
        $set: { jid: key, [field]: value, updatedAt: new Date() },
        $setOnInsert: { premium: false, expiresAt: 0 }
      },
      { upsert: true }
    );
    premiumCache.delete(key);
    return true;
  } catch (e) { console.error('updatePremiumField error:', e); return false; }
}

// Remove one custom field; the premium doc itself (and other fields) stay, so
// a renewed premium user automatically gets their old customization back.
async function resetPremiumField(jid, field) {
  try {
    const key = String(jid || '');
    if (!key || !field) return false;
    await initMongo();
    await premiumUsersCol.updateOne({ jid: key }, { $unset: { [field]: '' } });
    premiumCache.delete(key);
    return true;
  } catch (e) { console.error('resetPremiumField error:', e); return false; }
}

// ==================== CENTRAL BOT CONFIG ====================
// The single source of truth for a user's base-bot appearance. Returns the
// merged config: personal premium values over the built-in defaults. Non-
// premium users always get the plain defaults; premium users get each value
// they customized (unset values fall back to defaults).
async function getUserBotConfig(jid) {
  const out = { ...PREMIUM_DEFAULTS };
  try {
    const key = String(jid || '');
    if (!key) return out;
    // PER-BOT MODEL: any bot with a customization record shows its saved
    // values, regardless of the premium flag. Premium gates the premium
    // features themselves (activation/expiry notices), not the branding
    // display — so an owner-customized bot always shows its own config,
    // while bots without a record fall back to the plain defaults
    // (normal → default config).
    const doc = await getPremiumUser(key);
    if (!doc) return out;
    // Read camelCase first, then fall back to legacy lowercase keys (older
    // docs stored 'botimg'/'aliveimg' which never applied) so old
    // customization still shows even before the DB migration runs.
    for (const field of PREMIUM_CUSTOM_FIELDS) {
      let val = doc[field];
      if (val == null || String(val).trim() === '') {
        for (const alt of (PREMIUM_FIELD_ALIASES[field] || [])) {
          if (doc[alt] != null && String(doc[alt]).trim() !== '') { val = doc[alt]; break; }
        }
      }
      if (val != null && String(val).trim() !== '') out[field] = val;
    }
  } catch (e) { console.error('getUserBotConfig error:', e); }
  return out;
}

// True when any base-bot customization field was set by the user (differs from
// the built-in default). Used to decide whether a config should be presented
// to the viewer at all.
function hasCustomBotConfig(bc) {
  try {
    return !!(bc && PREMIUM_CUSTOM_FIELDS.some(f => bc[f] != null && String(bc[f]).trim() !== '' && bc[f] !== PREMIUM_DEFAULTS[f]));
  } catch (e) { return false; }
}

// Map a socket back to its paired session number (reverse of activeSockets).
// Each session runs one number, so this identifies "whose bot" a socket is.
function getSessionOwnerJid(socket) {
  try {
    if (!socket) return null;
    for (const [num, s] of activeSockets) {
      if (s === socket) return `${String(num).replace(/[^0-9]/g, '')}@s.whatsapp.net`;
    }
  } catch (e) {}
  return null;
}

// Permission for per-bot customization commands. The TARGET bot is always the
// bot that passed the gate and is executing the command: in a shared
// multi-bot chat that is the @mentioned bot (the gate lets only it through),
// in a private chat / single-bot group it is the bot the Owner messaged — so
// commandSender ≠ targetBot holds in every case and the Owner's own bot is
// never modified unless the Owner explicitly targets it. A manager (owner /
// premium-notify number) may customize any connected bot; otherwise only the
// bot's own premium user (sender == the bot's paired number) may customize
// it. Everyone else is denied. Returns the resolved target bot jid too, so
// the caller always saves to exactly the bot being customized (never the
// sender's own jid).
async function canManageBotConfig(socket, senderJid) {
  try {
    const premiumJid = getSessionOwnerJid(socket) || (await normalizePremiumJid(socket, senderJid));
    const senderNum = await resolveSenderPhone(socket, senderJid);
    const isManager = await isPremiumManager(senderNum);
    const isSelfBot = String(premiumJid).split('@')[0] === String(senderNum || '');
    const access = await hasPremiumAccess(premiumJid);
    return { ok: isManager || (isSelfBot && access), premiumJid };
  } catch (e) { return { ok: false, premiumJid: String(senderJid || '') }; }
}

// Per-user bot config used for DISPLAY: the sender's own premium
// customization wins when they have any; otherwise the SESSION OWNER's
// (the paired number's) customization is used, so a Premium user's custom
// bot is seen by everyone who messages their number. Non-premium viewers
// and non-customized sessions fall back to plain defaults.
async function resolveDisplayBotConfig(socket, senderJid) {
  try {
    // PER-BOT ISOLATION: a connected bot ALWAYS uses its OWN customization
    // record, keyed by its paired number (sock.user.id → getSessionOwnerJid).
    // The sender's identity is never consulted — so in a support group shared
    // by several of our bots, User A messaging Bot B can never see Bot A's
    // config (and vice versa). Bots without a customization record fall back
    // to the plain defaults (normal users → default config).
    const botJid = getSessionOwnerJid(socket) || (await normalizePremiumJid(socket, senderJid));
    return await getUserBotConfig(botJid);
  } catch (e) { console.error('resolveDisplayBotConfig error:', e); return { ...PREMIUM_DEFAULTS }; }
}

// Wrap a sub-menu caption with the viewer's custom Menu Header/Footer (the
// same two fields .menu applies). Returns the caption unchanged when neither
// is customized.
function brandMenuCaption(bc, caption, vars = {}) {
  try {
    if (!bc || !hasCustomBotConfig(bc)) return caption;
    let out = String(caption || '');
    if (bc.menuHeader && bc.menuHeader !== PREMIUM_DEFAULTS.menuHeader) {
      out = `${renderBaseTemplate(bc.menuHeader, vars)}\n${out}`;
    }
    return out;
  } catch (e) { return caption; }
}

// Replace {botname} {pushname} {name} {jid} {date} {time} {version} in
// customizable text. Values are escaped so user content can't break formatting.
function renderBaseTemplate(template, vars = {}) {
  try {
    const now = moment().tz('Asia/Colombo');
    const safe = (v) => String(v == null ? '' : v)
      .replace(/`/g, "'")
      .replace(/\$\{/g, '')
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .trim();
    const map = {
      '{botname}': safe(vars.botname),
      '{pushname}': safe(vars.pushname),
      '{name}': safe(vars.name || vars.pushname),
      '{jid}': safe(vars.jid),
      '{date}': safe(vars.date || now.format('YYYY-MM-DD')),
      '{time}': safe(vars.time || now.format('HH:mm')),
      '{version}': safe(vars.version || config.BOT_VERSION)
    };
    let out = String(template || '');
    for (const k of Object.keys(map)) out = out.split(k).join(map[k]);
    return out;
  } catch (e) { return String(template || ''); }
}

// Resolve an image value for customization commands: an http(s) URL from the
// args, or the image the user replied to (uploaded through the existing
// uploadToCDN catbox helper). Returns a URL string or null.
async function resolveCustomImage(socket, msg, args) {
  try {
    const urlArg = (args || []).find(a => /^https?:\/\//i.test(a));
    if (urlArg) return urlArg;
    const ctxInfo = (msg.message?.extendedTextMessage?.contextInfo) || {};
    const quoted = ctxInfo.quotedMessage;
    if (quoted?.imageMessage) {
      const stream = await downloadContentFromMessage(quoted.imageMessage, 'image');
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      const buffer = Buffer.concat(chunks);
      return await uploadToCDN(buffer);
    }
    return null;
  } catch (e) { console.error('resolveCustomImage error:', e); return null; }
}

// A stored session logo may be a LOCAL temp path that died on restart (old
// .setlogo saved /tmp paths). Only use it when it is a URL or an existing
// file; otherwise fall back so the panel image never fails to attach.
function safeSessionLogo(logo, fallback) {
  try {
    if (logo && /^https?:\/\//i.test(logo)) return logo;
    if (logo && fs.existsSync(logo)) return logo;
  } catch (e) {}
  return fallback || config.SET_IMAGE_PATH;
}

// Resolve which image a base menu shows for a user: botLogo (if customized)
// → botImage (if customized) → fallback. A premium user's .botlogo therefore
// appears on every menu they open.
function resolveBaseMenuImage(bc, fallbackUrl) {
  try {
    if (bc.botLogo && bc.botLogo !== PREMIUM_DEFAULTS.botLogo) return bc.botLogo;
    if (bc.botImage && bc.botImage !== PREMIUM_DEFAULTS.botImage) return bc.botImage;
  } catch (e) {}
  return fallbackUrl || config.SET_IMAGE_PATH;
}

// True when the user customized any of the base menu images (botLogo or
// botImage) — used to decide image-vs-video sending in menus.
function hasCustomMenuImage(bc) {
  try {
    return !!(bc && (
      bc.botLogo !== PREMIUM_DEFAULTS.botLogo ||
      bc.botImage !== PREMIUM_DEFAULTS.botImage
    ));
  } catch (e) { return false; }
}

// Resolve the bot name a command/menu should display for the requester:
// premium custom botName (if set) → session admin-panel cfg.botName →
// the caller-provided fallback. Central helper so premium customization
// shows up in EVERY command and sub-menu, not just .menu/.alive.
async function resolveUserBotName(socket, jid, cfg = {}, fallback) {
  try {
    const bc = await resolveDisplayBotConfig(socket, jid);
    if (bc.botName && bc.botName !== PREMIUM_DEFAULTS.botName) return bc.botName;
  } catch (e) {}
  return (cfg && cfg.botName) || fallback || config.BOT_NAME;
}

// Same idea for the footer: premium botFooter (if customized) wins over the
// caller-provided fallback, so every menu/sub-menu footer reflects premium.
async function resolveUserBotFooter(socket, jid, fallback) {
  try {
    const bc = await resolveDisplayBotConfig(socket, jid);
    if (bc.botFooter && bc.botFooter !== PREMIUM_DEFAULTS.botFooter) return bc.botFooter;
  } catch (e) {}
  return fallback || config.BOT_FOOTER;
}

// ---------------- handlers (newsletter + reactions) ----------------

async function setupNewsletterHandlers(socket, sessionNumber) {
  const rrPointers = new Map();

  socket.ev.on('messages.upsert', async ({ messages }) => {
    const message = messages[0];
    if (!message?.key) return;
    // Skip channel posts that arrived while the bot was offline (WhatsApp
    // re-sends pending messages on reconnect) — never react to stale posts.
    if (isStaleOfflineMessage(socket, message)) return;
    const jid = message.key.remoteJid;

    try {
      const followedDocs = await listNewslettersFromMongo(); // array of {jid, emojis}
      const reactConfigs = await listNewsletterReactsFromMongo(); // [{jid, emojis}]
      const reactMap = new Map();
      for (const r of reactConfigs) reactMap.set(r.jid, r.emojis || []);

      const followedJids = followedDocs.map(d => d.jid);
      if (!followedJids.includes(jid) && !reactMap.has(jid)) return;

      let emojis = reactMap.get(jid) || null;
      if ((!emojis || emojis.length === 0) && followedDocs.find(d => d.jid === jid)) {
        emojis = (followedDocs.find(d => d.jid === jid).emojis || []);
      }
      if (!emojis || emojis.length === 0) emojis = config.AUTO_LIKE_EMOJI;

      let idx = rrPointers.get(jid) || 0;
      const emoji = emojis[idx % emojis.length];
      rrPointers.set(jid, (idx + 1) % emojis.length);

      const messageId = message.newsletterServerId || message.key.id;
      if (!messageId) return;

      let retries = 3;
      while (retries-- > 0) {
        try {
          if (typeof socket.newsletterReactMessage === 'function') {
            await socket.newsletterReactMessage(jid, messageId.toString(), emoji);
          } else {
            await socket.sendMessage(jid, { react: { text: emoji, key: message.key } });
          }
          await saveNewsletterReaction(jid, messageId.toString(), emoji, sessionNumber || null);
          break;
        } catch (err) {
          console.warn(`Reaction attempt failed (${3 - retries}/3):`, err?.message || err);
          await delay(1200);
        }
      }

    } catch (error) {
      console.error('Newsletter reaction handler error:', error?.message || error);
    }
  });
}


// ---------------- status + revocation + resizing ----------------

// ==================== AUTO STATUS MESSAGE (.autostatusmsg) ====================
// When enabled, every new WhatsApp Status the bot receives is viewed and the
// poster gets a NORMAL WhatsApp text reply built from the session-owner's
// saved template. The reply goes ONLY to the person who posted the status
// (never to the bot owner, groups, the bot itself or the status viewer). All
// settings live in the per-session user config (Mongo) so they survive bot
// restarts, VPS restarts, reconnects and session reloads.

// Duplicate-reply guard: status message IDs are remembered per session in a
// bounded FIFO so the exact same status — including ones WhatsApp re-delivers
// after a reconnect — is answered at most once per session. The session number
// is part of the key so two different paired sessions receiving the same
// status never suppress each other's replies.
const autostatusProcessedIds = new Set();
const AUTOSTATUS_TRACK_LIMIT = 1000;

function autostatusMarkProcessed(sessionNumber, participant, msgId) {
  try {
    const key = `${sessionNumber}|${participant}|${msgId}`;
    if (autostatusProcessedIds.has(key)) return true;
    autostatusProcessedIds.add(key);
    while (autostatusProcessedIds.size > AUTOSTATUS_TRACK_LIMIT) {
      const oldest = autostatusProcessedIds.values().next().value;
      if (oldest === undefined) break;
      autostatusProcessedIds.delete(oldest);
    }
    return false;
  } catch (e) { return false; }
}

// Resolve a status participant down to a sendable user JID. Phone JIDs pass
// through; LID addresses (which can't be used as sendMessage targets) are
// resolved to their phone JID via the socket's LID mapping, the same mechanism
// used by resolveAntiDeleteJid / resolveSenderPhone. Returns null for anything
// that is not a real user (groups, unresolved LIDs, garbage).
async function autostatusResolveTargetJid(socket, participant) {
  try {
    const str = String(participant || '');
    if (!str) return null;
    if (str.endsWith('@s.whatsapp.net')) return str;
    if (str.endsWith('@lid') || str.endsWith('@hosted.lid')) {
      const mapping = socket?.signalRepository?.lidMapping;
      const res = mapping ? await mapping.getPNsForLIDs([str]).catch(() => null) : null;
      if (res && res[0] && res[0].pn) {
        return String(res[0].pn).split('@')[0].split(':')[0] + '@s.whatsapp.net';
      }
      return null;
    }
    return null;
  } catch (e) { return null; }
}

// Core .autostatusmsg flow, called from the existing status handler after a
// new status is detected. Views the status with the same mechanism the
// existing AUTO_VIEW_STATUS block uses, then renders the template and sends it
// to the status poster. Every step is error-proofed so a failure to handle one
// status never crashes the bot or blocks the rest of the status pipeline.
async function handleAutoStatusMsg(socket, message, template, sessionNumber) {
  try {
    if (!message || !message.key) return;
    const participant = message.key.participant;
    const msgId = message.key.id;
    if (!participant || !msgId) return;

    // Only real user statuses: never the bot's own posts, never group JIDs.
    if (message.key.fromMe) return;
    const targetJid = await autostatusResolveTargetJid(socket, participant);
    if (!targetJid) return;
    try {
      const selfNum = String(socket.user.id || '').split(':')[0];
      if (targetJid.split('@')[0] === selfNum) return;
    } catch (e) {}

    // One reply per status per session — also covers reconnect re-deliveries.
    if (autostatusMarkProcessed(sessionNumber, participant, msgId)) return;

    // View the status first (best-effort — AUTO_VIEW_STATUS may have already
    // viewed it; a view failure must not block the reply).
    try { await socket.readMessages([message.key]); } catch (e) {}

    // Resolve the poster's display name, then render the template.
    let name = message.pushName || '';
    if (!name) {
      try {
        const statusData = await socket.fetchStatus(targetJid).catch(() => null);
        if (statusData && statusData.name) name = statusData.name;
      } catch (e) {}
    }
    if (!name) name = String(targetJid).split('@')[0] || 'User';

    const now = moment().tz('Asia/Colombo');
    const safe = (v) => String(v == null ? '' : v)
      .replace(/`/g, "'")
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .trim();
    const vars = {
      pushname: safe(name),
      name: safe(name),
      jid: safe(targetJid),
      time: safe(now.format('HH:mm')),
      date: safe(now.format('YYYY-MM-DD'))
    };
    let text = String(template || '');
    for (const k of Object.keys(vars)) text = text.split('{' + k + '}').join(vars[k]);

    // Send as a NORMAL WhatsApp text message to the status poster.
    await socket.sendMessage(targetJid, { text });
    console.log(`[autostatusmsg] replied to ${targetJid}: "${String(text).slice(0, 60)}..."`);
  } catch (e) {
    console.error('AutoStatusMsg reply error:', e && e.message || e);
  }
}

async function setupStatusHandlers(socket, sessionNumber) {
  socket.ev.on('messages.upsert', async ({ messages }) => {
    const message = messages[0];
    if (!message?.key || message.key.remoteJid !== 'status@broadcast' || !message.key.participant) return;
    
    try {
      // Load user-specific config from MongoDB
      let userEmojis = config.AUTO_LIKE_EMOJI; // Default emojis
      let autoViewStatus = config.AUTO_VIEW_STATUS; // Default from global config
      let autoLikeStatus = config.AUTO_LIKE_STATUS; // Default from global config
      let autoRecording = config.AUTO_RECORDING; // Default from global config
      let ghostMode = false; // ghost mode (always offline)
      
      if (sessionNumber) {
        const userConfig = await loadUserConfigFromMongo(sessionNumber) || {};
        
        // Check for emojis in user config
        if (userConfig.AUTO_LIKE_EMOJI && Array.isArray(userConfig.AUTO_LIKE_EMOJI) && userConfig.AUTO_LIKE_EMOJI.length > 0) {
          userEmojis = userConfig.AUTO_LIKE_EMOJI;
        }
        
        // Check for auto view status in user config
        if (userConfig.AUTO_VIEW_STATUS !== undefined) {
          autoViewStatus = userConfig.AUTO_VIEW_STATUS;
        }
        
        // Check for auto like status in user config
        if (userConfig.AUTO_LIKE_STATUS !== undefined) {
          autoLikeStatus = userConfig.AUTO_LIKE_STATUS;
        }
        
        // Check for auto recording in user config
        if (userConfig.AUTO_RECORDING !== undefined) {
          autoRecording = userConfig.AUTO_RECORDING;
        }

        // Ghost mode (always offline): never broadcast recording on statuses.
        if (userConfig.PRESENCE !== undefined) {
          ghostMode = userConfig.PRESENCE === 'unavailable';
        }
      }

      // Use auto recording setting (from user config or global)
      if (String(autoRecording) === 'true' && !ghostMode) {
        await socket.sendPresenceUpdate("recording", message.key.remoteJid);
      }
      
      // Use auto view status setting (from user config or global)
      if (String(autoViewStatus) === 'true') {
        let retries = config.MAX_RETRIES;
        while (retries > 0) {
          try { 
            await socket.readMessages([message.key]); 
            break; 
          } catch (error) { 
            retries--; 
            await delay(1000 * (config.MAX_RETRIES - retries)); 
            if (retries===0) throw error; 
          }
        }
      }
      
      // Use auto like status setting (from user config or global)
      if (String(autoLikeStatus) === 'true') {
        const randomEmoji = userEmojis[Math.floor(Math.random() * userEmojis.length)];
        let retries = config.MAX_RETRIES;
        while (retries > 0) {
          try {
            await socket.sendMessage(message.key.remoteJid, { 
              react: { text: randomEmoji, key: message.key } 
            }, { statusJidList: [message.key.participant] });
            break;
          } catch (error) { 
            retries--; 
            await delay(1000 * (config.MAX_RETRIES - retries)); 
            if (retries===0) throw error; 
          }
        }
      }

      // AUTO STATUS MESSAGE (.autostatusmsg): when the feature is enabled for
      // this session, reply to the status poster after the status is viewed.
      // Safe to run even when AUTO_VIEW_STATUS is off — this block views the
      // status itself before replying. Never breaks existing status features.
      if (sessionNumber) {
        try {
          const asmCfg = await loadUserConfigFromMongo(sessionNumber) || {};
          if (String(asmCfg.AUTOSTATUSMSG_ENABLED) === 'true' && asmCfg.AUTOSTATUSMSG_TEXT) {
            await handleAutoStatusMsg(socket, message, asmCfg.AUTOSTATUSMSG_TEXT, sessionNumber);
          }
        } catch (e) {
          console.error('AutoStatusMsg status hook error:', e);
        }
      }

    } catch (error) { 
      console.error('Status handler error:', error); 
    }
  });
}


// ---------------- ANTI-DELETE: per-user (chat / inbox / off) ----------------
// Every incoming message is cached in-memory (per-session, time + size capped)
// so that when WhatsApp fires `messages.delete` we can restore the deleted
// content back into the original chat ("chat" mode) or into the bot's private
// inbox ("inbox" mode). "off" = fully disabled. Every path is error-proofed so
// the bot never crashes while running or while downloading media to restore.

const antiDeleteCache = new Map();
const ANTI_DELETE_CACHE_MAX = 600;
const ANTI_DELETE_CACHE_TTL = 2 * 60 * 60 * 1000; // 2 hours
const ANTI_DELETE_DOWNLOAD_TIMEOUT = 30000; // 30s media download cap

function unwrapAntiDeleteMessage(m) {
  if (!m) return null;
  let cur = m;
  let type = getContentType(cur);
  let guard = 0;
  while (type && guard < 6) {
    guard++;
    if (type === 'ephemeralMessage' && cur.ephemeralMessage && cur.ephemeralMessage.message) {
      cur = cur.ephemeralMessage.message;
    } else if (type === 'documentWithCaptionMessage' && cur.documentWithCaptionMessage && cur.documentWithCaptionMessage.message) {
      cur = cur.documentWithCaptionMessage.message;
    } else if (type === 'editedMessage' && cur.editedMessage && cur.editedMessage.message) {
      cur = cur.editedMessage.message;
    } else if (type === 'viewOnceMessage' && cur.viewOnceMessage && cur.viewOnceMessage.message) {
      cur = cur.viewOnceMessage.message;
    } else {
      break;
    }
    type = getContentType(cur);
  }
  return { type, msg: cur };
}

function pruneAntiDeleteCache() {
  try {
    const now = Date.now();
    for (const [k, v] of antiDeleteCache) {
      if (now - v.ts > ANTI_DELETE_CACHE_TTL) antiDeleteCache.delete(k);
    }
    while (antiDeleteCache.size > ANTI_DELETE_CACHE_MAX) {
      const oldestKey = antiDeleteCache.keys().next().value;
      if (oldestKey === undefined) break;
      antiDeleteCache.delete(oldestKey);
    }
  } catch (e) {}
}

// True when a message key belongs to ONE OF OUR OWN paired sessions — either
// this socket's own outgoing message (fromMe) or a message sent by another of
// our numbers in a shared chat (participant/remoteJid matches activeSockets).
// Anti-Delete must never cache or "restore" any of them (no recursion, no
// cross-socket spam when one of our bots deletes its own anime loading msg).
function isOwnBotKey(key) {
  try {
    if (!key) return false;
    if (key.fromMe) return true;
    const who = key.participant || (key.remoteJid && !key.remoteJid.endsWith('@g.us') ? key.remoteJid : '');
    const num = String(who || '').split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
    return !!num && activeSockets.has(num);
  } catch (e) { return false; }
}

function cacheAntiDeleteMessage(sessionNumber, msg) {
  try {
    if (!msg || !msg.key || !msg.message || !msg.key.id) return;
    // Bot-generated messages (any of our own sessions) must never enter the
    // deletion-tracking cache — the bot's own anime loading messages, edits
    // and anti-delete notices are NOT user content and must never be restored.
    if (isOwnBotKey(msg.key)) return;
    const jid = msg.key.remoteJid;
    if (shouldSkipChat(jid)) return;
    const type = getContentType(msg.message);
    if (!type || type === 'protocolMessage' || type === 'senderKeyDistributionMessage') return;
    const unwrapped = unwrapAntiDeleteMessage(msg.message);
    if (!unwrapped || !unwrapped.msg || !unwrapped.type) return;
    const key = `${sessionNumber}|${jid}|${msg.key.participant || ''}|${msg.key.id}`;
    antiDeleteCache.set(key, {
      ts: Date.now(),
      key: msg.key,
      message: unwrapped.msg,
      type: unwrapped.type,
      remoteJid: jid,
      participant: msg.key.participant || null,
      fromMe: !!msg.key.fromMe
    });
    pruneAntiDeleteCache();
  } catch (e) {
    console.error('Anti-delete cache error:', e && e.message || e);
  }
}

function buildAntiDeleteHeader(chat, sender, time, text) {
  const lines = [
    '*╭━━〔 🛡️ 𝐀𝐍𝐓𝐈-𝐃𝐄𝐋𝐄𝐓𝐄 〕━━⬣*',
  ];
  if (text) lines.push(`*│➣ 📝 𝐓𝐱𝐭:* ${text}`);
  lines.push(`*│➣ 📍 𝐂𝐡𝐚𝐭:* ${chat}`);
  lines.push(`*│➣ 👤 𝐒𝐞𝐧𝐝𝐞𝐫:* ${sender}`);
  lines.push(`*│➣ 🕒 𝐃𝐞𝐥𝐞𝐭𝐞𝐝:* ${time}`);
  lines.push('*╰━━━━━━━━━━━━━━⬣*');
  lines.push(`> _*🛡️ Deleted message gurd by - ${BOT_NAME_FANCY}*_`);
  return lines.join('\n');
}

function extractAntiDeleteText(m) {
  if (!m) return '';
  if (m.conversation) return m.conversation;
  if (m.extendedTextMessage && m.extendedTextMessage.text) return m.extendedTextMessage.text;
  if (m.imageMessage && m.imageMessage.caption) return m.imageMessage.caption;
  if (m.videoMessage && m.videoMessage.caption) return m.videoMessage.caption;
  if (m.documentMessage && m.documentMessage.caption) return m.documentMessage.caption;
  return '';
}

function antiDeleteMediaType(m) {
  if (!m) return null;
  if (m.imageMessage) return 'image';
  if (m.videoMessage) return 'video';
  if (m.audioMessage) return 'audio';
  if (m.stickerMessage) return 'sticker';
  if (m.documentMessage) return 'document';
  return null;
}

function buildAntiDeleteSend(m, buffer) {
  try {
    if (!m) return null;
    const isBuffer = Buffer.isBuffer(buffer);
    if (m.imageMessage) return { image: isBuffer ? buffer : { url: m.imageMessage.url }, caption: m.imageMessage.caption || '' };
    if (m.videoMessage) return { video: isBuffer ? buffer : { url: m.videoMessage.url }, caption: m.videoMessage.caption || '' };
    if (m.audioMessage) return { audio: isBuffer ? buffer : { url: m.audioMessage.url }, ptt: !!m.audioMessage.ptt };
    if (m.stickerMessage) return { sticker: isBuffer ? buffer : { url: m.stickerMessage.url } };
    if (m.documentMessage) return { document: isBuffer ? buffer : { url: m.documentMessage.url }, mimetype: m.documentMessage.mimetype || 'application/octet-stream', fileName: m.documentMessage.fileName || 'document' };
    return null;
  } catch (e) { return null; }
}

async function downloadAntiDeleteMedia(key, msg) {
  try {
    const { downloadMediaMessage } = require('@whiskeysockets/baileys');
    const logger = { level: 'fatal', child(){ return this; }, info(){}, debug(){}, warn(){}, error(){} };
    const result = await Promise.race([
      downloadMediaMessage({ key: key || { remoteJid: 'status@broadcast', id: 'antidelete', participant: '0@s.whatsapp.net', fromMe: false }, message: msg }, 'buffer', {}, { logger }),
      delay(ANTI_DELETE_DOWNLOAD_TIMEOUT).then(() => { throw new Error('anti-delete media download timeout'); })
    ]);
    return Buffer.isBuffer(result) ? result : null;
  } catch (e) { return null; }
}

async function resolveAntiDeleteJid(socket, jid) {
  try {
    if (!jid) return jid || '';
    const str = String(jid);
    if (str.endsWith('@g.us')) return str;
    if (str.endsWith('@lid') || str.endsWith('@hosted.lid')) {
      const mapping = socket?.signalRepository?.lidMapping;
      const res = mapping ? await mapping.getPNsForLIDs([str]).catch(() => null) : null;
      if (res && res[0] && res[0].pn) {
        return res[0].pn.split('@')[0].split(':')[0];
      }
      return str.split('@')[0];
    }
    return str.split('@')[0];
  } catch (e) {
    try { return String(jid || '').split('@')[0]; } catch (e2) { return jid || ''; }
  }
}

function getAntiDeleteInboxJid(socket) {
  try {
    if (!socket || !socket.user || !socket.user.id) return null;
    return jidNormalizedUser(socket.user.id);
  } catch (e) { return null; }
}

async function sendAntiDeleteRestore(socket, targetJid, entry) {
  try {
    const chatDisplay = await resolveAntiDeleteJid(socket, entry.remoteJid);
    const senderDisplay = await resolveAntiDeleteJid(socket, entry.participant || entry.remoteJid);

    const m = entry.message;
    const isText = entry.type === 'conversation' || entry.type === 'extendedTextMessage';
    const mediaType = antiDeleteMediaType(m);

    // Text (or unknown): deleted text goes inline in the header's Txt field —
    // one single reply, exactly like the requested layout. Only send when the
    // original message actually contains recoverable text.
    if (isText || !mediaType) {
      const text = extractAntiDeleteText(m);
      if (!text || !text.trim()) return; // no recoverable content — silently ignore
      const reply = buildAntiDeleteHeader(chatDisplay, senderDisplay, getSriLankaTimestamp(), text);
      await socket.sendMessage(targetJid, { text: reply }).catch(() => {});
      return;
    }

    // Media restore.
    let buffer = await downloadAntiDeleteMedia(entry.key, m);
    let content = buffer ? buildAntiDeleteSend(m, buffer) : null;
    if (!content) content = buildAntiDeleteSend(m, null);

    if (content) {
      // Image/video/document: header (with the media caption as Txt) becomes
      // the media caption so the deleted message and reply arrive together.
      if (mediaType === 'image' || mediaType === 'video' || mediaType === 'document') {
        const origCaption = extractAntiDeleteText(m);
        content.caption = buildAntiDeleteHeader(chatDisplay, senderDisplay, getSriLankaTimestamp(), origCaption || undefined);
      }
      // Audio/sticker have no caption support — media only, no header.
      try {
        await socket.sendMessage(targetJid, content);
        return;
      } catch (e) {
        // URL re-send failed (expired media) — media is not recoverable, so
        // silently ignore the deleted event instead of sending a notice.
      }
    }

    // No recoverable media content (download/URL failed) — silently ignore the
    // deleted event; do not send metadata-only or empty notifications.
  } catch (e) {
    console.error('Anti-delete restore error:', e && e.message || e);
  }
}

async function handleMessageRevocation(socket, number) {
  const sessionNumber = (number || '').replace(/[^0-9]/g, '');

  // Cache every incoming message so deleted ones can be restored later.
  socket.ev.on('messages.upsert', async ({ messages }) => {
    try {
      if (!messages) return;
      for (const msg of messages) {
        if (msg) cacheAntiDeleteMessage(sessionNumber, msg);
      }
    } catch (e) { console.error('Anti-delete upsert error:', e && e.message || e); }
  });

  // Main path — Baileys v7 emits "delete for everyone" (REVOKE) as a
  // messages.update with messageStubType REVOKE (1) and message: null.
  socket.ev.on('messages.update', async (updates) => {
    if (!updates || updates.length === 0) return;
    for (const item of updates) {
      try {
        if (!item || !item.key || !item.key.remoteJid || !item.key.id) continue;
        const upd = item.update || {};
        const isRevoke = upd.messageStubType === WAMessageStubType.REVOKE
          || (upd.message === null && Array.isArray(upd.messageStubParameters));
        if (!isRevoke) continue;
        await processAntiDeleteKey(socket, sessionNumber, item.key);
      } catch (e) {
        console.error('Anti-delete update error:', e && e.message || e);
      }
    }
  });

  // Secondary path — "delete for me" sync actions come through messages.delete.
  socket.ev.on('messages.delete', async ({ keys }) => {
    if (!keys || keys.length === 0) return;
    for (const messageKey of keys) {
      try {
        if (messageKey) await processAntiDeleteKey(socket, sessionNumber, messageKey);
      } catch (e) {
        console.error('Anti-delete delete error:', e && e.message || e);
      }
    }
  });
}

async function processAntiDeleteKey(socket, sessionNumber, messageKey) {
  if (!messageKey || !messageKey.remoteJid || !messageKey.id) return;
  // Bot-generated messages (any of our own sessions — e.g. the bot deleting
  // its own "fetching details" loading message) must never trigger an
  // Anti-Delete notification, even when the delete is seen by another of our
  // sessions in the same chat (fromMe is false there, so match by session id).
  if (isOwnBotKey(messageKey)) return;

  const remoteJid = String(messageKey.remoteJid);
  const isGroup = remoteJid.endsWith('@g.us');
  const inboxJid = getAntiDeleteInboxJid(socket);
  if (!inboxJid) return;

  // Group chats: recovered deleted messages are always forwarded to the bot's
  // own private inbox by default — never re-sent into the group, regardless of
  // the ANTI_DELETE mode. Private chats keep the original mode behaviour.
  let targetJid;
  if (isGroup) {
    targetJid = inboxJid;
  } else {
    let userConfig = {};
    try { userConfig = await loadUserConfigFromMongo(sessionNumber) || {}; } catch (e) {}
    const mode = (userConfig.ANTI_DELETE || config.ANTI_DELETE || 'off').toLowerCase();
    if (mode === 'off') return;
    targetJid = (mode === 'inbox') ? inboxJid : remoteJid;
  }

  try {
    // Lookup with participant first, then without (delete-for-me keys lack participant).
    const entry = lookupAntiDeleteCache(sessionNumber, messageKey);

    // Only restore when the original message data was captured. If the message
    // was not cached (bot offline / restarted / no data available), silently
    // ignore the deleted event — never send empty or metadata-only alerts.
    if (entry) {
      await sendAntiDeleteRestore(socket, targetJid, entry);
    }
  } catch (e) {
    console.error('Anti-delete per-key error:', e && e.message || e);
  }
}

function lookupAntiDeleteCache(sessionNumber, messageKey) {
  const jid = messageKey.remoteJid;
  const id = messageKey.id || '';
  const participant = messageKey.participant || '';
  const base = `${sessionNumber}|${jid}|`;
  const key1 = base + participant + '|' + id;
  if (antiDeleteCache.has(key1)) {
    const entry = antiDeleteCache.get(key1);
    antiDeleteCache.delete(key1);
    if (entry && entry.fromMe) return null; // belt & braces: never restore bot messages
    return entry;
  }
  const key2 = base + '|' + id;
  if (antiDeleteCache.has(key2)) {
    const entry = antiDeleteCache.get(key2);
    antiDeleteCache.delete(key2);
    if (entry && entry.fromMe) return null; // belt & braces: never restore bot messages
    return entry;
  }
  return null;
}


async function resize(image, width, height) {
  let oyy = await Jimp.read(image);
  return await oyy.resize(width, height).getBufferAsync(Jimp.MIME_JPEG);
}



function setupCommandHandlers(socket, number) {
  // ---- Duplicate-message guard (PER-SOCKET) ----
  // Baileys can emit the same message id multiple times (upsert type 'append' +
  // 'notify', reconnect replays). Each incoming message id is processed at most
  // once PER SOCKET so replies / reactions / premium notices never double-fire.
  // The map is deliberately scoped to this socket: in a multi-bot group the
  // same user message is delivered to every session, and each must be free to
  // process it (the multi-bot @mention gate decides who actually replies) — a
  // shared map would let the first socket to arrive starve the mentioned bot.
  const processedMsgIds = new Map(); // msgId -> ts
  const PROCESSED_MSG_TTL = 5 * 60 * 1000;
  const PROCESSED_MSG_MAX = 3000;
  function markMessageProcessed(id) {
    const now = Date.now();
    if (processedMsgIds.has(id)) return true;
    processedMsgIds.set(id, now);
    if (processedMsgIds.size > PROCESSED_MSG_MAX) {
      for (const [k, v] of processedMsgIds) if (now - v > PROCESSED_MSG_TTL) processedMsgIds.delete(k);
      while (processedMsgIds.size > PROCESSED_MSG_MAX) processedMsgIds.delete(processedMsgIds.keys().next().value);
    }
    return false;
  }
  socket.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg || !msg.message || shouldSkipChat(msg.key.remoteJid)) return;
    // Duplicate-event guard: the same message id is never processed twice.
    if (msg.key && msg.key.id && markMessageProcessed(msg.key.id)) return;
    // Never reply to messages that arrived while the bot was offline —
    // WhatsApp re-sends pending messages on restart/reconnect.
    if (isStaleOfflineMessage(socket, msg)) return;
    // Bind this sender's FULL display config (bot name, footer, image, logo)
    // to the whole message context, so EVERY reply — not just .menu/.alive —
    // shows THEIR premium branding. Runs before any branding is read (skipped
    // messages above never pay the DB cost); the sync cache is primed eagerly
    // on cold misses so the first reply is already branded.
    // Brand identity = THIS processing bot (its paired number), never the
    // sender — so every sender in a shared chat sees the SAME bot's config,
    // and a config change (set/reset) is visible to everyone immediately
    // (single shared cache entry per bot, no per-sender stale entries).
    const brandKey = msg && msg.key && !msg.key.fromMe
      ? (getSessionOwnerJid(socket) || (msg.key.participant || msg.key.remoteJid || ''))
      : '';
    const cachedBc = cachedBotBrand(brandKey);
    bindBrandContext(socket, cachedBc);
    if (cachedBc === null && brandKey) {
      // Cold cache (first contact since restart/expiry): resolve now — one DB
      // hit, then cached 10 min — so THIS message's replies are already
      // branded instead of waiting for the sender's next message.
      bindBrandContext(socket, await primeBotBrandCache(socket, brandKey));
    }

    const type = getContentType(msg.message);
    if (!msg.message) return;
    msg.message = (getContentType(msg.message) === 'ephemeralMessage') ? msg.message.ephemeralMessage.message : msg.message;

    const from = msg.key.remoteJid;
    const sender = from;
    const nowsender = msg.key.fromMe ? (socket.user.id.split(':')[0] + '@s.whatsapp.net' || socket.user.id) : (msg.key.participant || msg.key.remoteJid);
    const senderNumber = (nowsender || '').split('@')[0];
    // The sender is "the bot" when their number equals THIS socket's own
    // number — EXACT match. The old substring check (.includes) wrongly
    // flagged the owner testing the bot from their own paired session number
    // (self-chat messages arrive with fromMe=false, so fromMe can't be used
    // here) and could false-positive on LIDs containing phone digits. The
    // interactive reply listeners below no longer gate on isbot at all — the
    // per-user session key + quote/stanzaId + most-recent-ts check is the
    // correct guard.
    const isbot = socket.user.id.split(':')[0] === senderNumber;
    // LID-aware owner check: resolves @lid senders to their phone number so
    // OWNER_NUMBER matching works even when WhatsApp reports the sender as a
    // LID (e.g. 52450694291648@lid) instead of a phone JID.
    const isOwner = isbot ? isbot : await isOwnerUser(socket, nowsender);
    const isGroup = from.endsWith("@g.us");
    // Reply-context ownership: when this message QUOTES an anime flow menu
    // (search list / episode list), ONLY the anime selection handler may own
    // it — every other interactive/numeric handler must stand down.
    const quotesAnimeHeavenMenu = animeheavenPlugin.quotesMenu(socket, msg, from, nowsender);
    const quotesAnimeMenu = animeQuotesMenu(msg, from, nowsender, socket) || quotesAnimeHeavenMenu;
    // One-time premium expiry notification: when a premium user's expiry has
    // passed, tell them (and alert the owners) exactly once. Cheap — the doc
    // lookup is cached and non-premium users return immediately.
    if (!isbot && !isOwner) {
      await notifyPremiumExpiry(socket, await normalizePremiumJid(socket, nowsender)).catch(() => {});
    }

   
   let body = '';
try {
    if (type === 'conversation') {
        body = msg.message.conversation || '';
    } else if (type === 'extendedTextMessage') {
        body = msg.message.extendedTextMessage?.text || '';
    } else if (type === 'imageMessage') {
        body = msg.message.imageMessage?.caption || '';
    } else if (type === 'videoMessage') {
        body = msg.message.videoMessage?.caption || '';
    } else if (type === 'buttonsResponseMessage') {
        body = msg.message.buttonsResponseMessage?.selectedButtonId || '';
    } else if (type === 'listResponseMessage') {
        body = msg.message.listResponseMessage?.singleSelectReply?.selectedRowId || '';
    } else if (type === 'templateButtonReplyMessage') {
        body = msg.message.templateButtonReplyMessage?.selectedId || '';
    } else if (type === 'interactiveResponseMessage') {
        const nativeFlow = msg.message.interactiveResponseMessage?.nativeFlowResponseMessage;
        if (nativeFlow?.paramsJson) {
            try {
                const params = JSON.parse(nativeFlow.paramsJson);
                body = params.id || '';
            } catch (e) {
                body = '';
            }
        }
    } else if (type === 'viewOnceMessage') {
        const viewOnceContent = msg.message.viewOnceMessage?.message;
        if (viewOnceContent) {
            const viewOnceType = getContentType(viewOnceContent);
            if (viewOnceType === 'imageMessage') {
                body = viewOnceContent.imageMessage?.caption || '';
            } else if (viewOnceType === 'videoMessage') {
                body = viewOnceContent.videoMessage?.caption || '';
            }
        }
    }
    if (!body || typeof body !== 'string') return;
} catch (e) {
    console.error('Error:', e);
}

    // ===== MULTI-BOT SELECTION GATE =====
    // When several of this bot's sessions share a chat, EVERY session receives
    // the same messages — so a selection reply (numbered menu choice, or a
    // button/list/interactive response) must explicitly @mention THIS bot to be
    // processed. Untagged selections are ignored by all bots; single-bot chats
    // (private chats, or groups with only one of our sessions) pass unchanged.
    const gateMsgType = getContentType(msg.message);
    const selectionShaped = /^\d{1,3}$/.test((body || '').trim()) ||
      gateMsgType === 'buttonsResponseMessage' || gateMsgType === 'listResponseMessage' ||
      gateMsgType === 'interactiveResponseMessage' || gateMsgType === 'templateButtonReplyMessage';
    if (selectionShaped && !quotesAnimeMenu) {
      // Anime-quoted replies skip the @mention gate: animeMenuMatch already
      // pins chat + user + bot ownership, so requiring an @mention here would
      // silently drop every quoted anime selection in multi-bot groups.
      if (!(await mayProcessSelectionReply(socket, msg))) return; // multi-bot + not tagged → no bot responds
    }

    // ===== GENERIC NUMBER-REPLY SELECTION RESOLUTION =====
    // If the user is replying with a plain number to a numbered list we sent
    // (the replacement for every button/list message), resolve it to the
    // underlying command string and let it flow through normally below.
    //
    // The same menu stays active and reusable (e.g. reply "1" for audio,
    // then later "2" for document, then "3" for voice — all from the same
    // .song menu) until PENDING_ROW_TIMEOUT passes with no reply, or the
    // user triggers a new numbered menu (which overwrites this one).
    {
      const trimmedForSelect = (body || '').trim();
      const selectNum = parseInt(trimmedForSelect, 10);
      const pending = pendingRowSelect[sender];
      // Skip generic resolution if other systems have pending state for this sender.
      // Dedicated reply sessions (movie / cinesub / inline / greeting capture)
      // own numeric replies outright. For song / yts / nano the rule is
      // "most-recent-session wins": a stale numbered menu (e.g. a leftover .menu
      // row list) must never convert "1" into an unrelated command like
      // ".downloadmenu", and an abandoned song/yts/nano session must never steal
      // a reply meant for a newer numbered menu either.
      const hasCinesubPending = typeof cinesubPlugin.isActive === 'function' && cinesubPlugin.isActive(sender);
      const hasAnimePending = animeHasSession(nowsender);
      const hasAnimeHeavenPending = animeheavenPlugin.isActive(nowsender);
      const hasBoxhubPending = typeof boxhubPlugin.isActive === 'function' && boxhubPlugin.isActive(sender);
      const hasInlineListener = pendingInlineListeners.has(sender);
      const hasMoviePending = !!moviePendingSearch[sender] || !!moviePendingQuality[sender];
      const hasGreetPending = !!pendingWelcomeInput[sender];
      const hasCinefrPending = !!cinefrSessions[cinefrSessionKey(nowsender, from)];
      const hasMvfrPending = !!mvfrSessions[mvfrSessionKey(nowsender, from)];
      const pendingTs = pending ? (pending.timestamp || 0) : 0;
      const songSelAny = songState.get(nowsender) || songState.get(sender);
      const ytsSelAny = ytsState.get(nowsender) || ytsState.get(sender);
      const nanoSelAny = nanoSession.get(nowsender) || nanoSession.get(sender);
      const dedicatedTs = Math.max(
        (songSelAny && songSelAny.ts) || 0,
        (ytsSelAny && ytsSelAny.ts) || 0,
        (nanoSelAny && nanoSelAny.ts) || 0
      );
      // An explicit quote (reply-to) of a dedicated session's menu always wins
      // over any numbered menu — the user clearly intends that flow.
      const replyCtx = (msg.message && msg.message.extendedTextMessage && msg.message.extendedTextMessage.contextInfo) || {};
      const replyStanzaId = replyCtx.stanzaId || '';
      const quotedDedicated = !!(
        (songSelAny && songSelAny.msgId && replyStanzaId === songSelAny.msgId) ||
        (ytsSelAny && ytsSelAny.msgId && replyStanzaId === ytsSelAny.msgId) ||
        (nanoSelAny && nanoSelAny.msgId && replyStanzaId === nanoSelAny.msgId)
      );
      if (!quotesAnimeMenu && pending && Array.isArray(pending.rows) && !isNaN(selectNum) &&
          String(selectNum) === trimmedForSelect && selectNum > 0 && selectNum <= pending.rows.length &&
          !hasCinesubPending && !hasAnimePending && !hasAnimeHeavenPending && !hasBoxhubPending && !hasInlineListener && !hasMoviePending && !hasGreetPending && !hasCinefrPending && !hasMvfrPending &&
          !quotedDedicated &&
          !(dedicatedTs > pendingTs)) {
        if (!sessionOwnedByMe(pending)) return; // numbered menu belongs to another bot → never process it
        body = pending.rows[selectNum - 1].id;
        pending.timestamp = Date.now(); // refresh timeout so the menu stays usable
      }
    }

    // Load user's saved prefix (fallback to global config.PREFIX)
    let prefix = config.PREFIX;
    try {
      const tmpNum = (number || '').replace(/[^0-9]/g, '');
      if (tmpNum) {
        const tmpCfg = await loadUserConfigFromMongo(tmpNum);
        if (tmpCfg && tmpCfg.PREFIX) prefix = tmpCfg.PREFIX;
      }
    } catch(e) {}
    const isCmd = body && body.startsWith && body.startsWith(prefix);
    const command = isCmd ? body.slice(prefix.length).trim().split(' ').shift().toLowerCase() : null;
    const args = body.trim().split(/ +/).slice(1);

    // ========== NANO BANANA SESSION REPLY LISTENER ==========
    // When a user is mid-flow (.nanoedit / .nanobanana) and replies with a
    // plain number (1-4 / 1-3), route it to the session handler and stop —
    // but only if the nano session is the most recent interaction.
    {
      const nanoSel = nanoSession.get(nowsender);
      const nanoInput = (body || '').trim();
      const nanoRowTs = (pendingRowSelect[sender] || {}).timestamp || 0;
      // NOTE: no !isbot gate here — this is a multi-session bot, so the
      // owner's test number can itself be one of the paired sessions. The
      // session is keyed per-user and matched below, which is the correct
      // guard (a bot's own outgoing message can never match a user session).
      if (!quotesAnimeMenu && nanoSel && sessionOwnedByMe(nanoSel) && nanoSel.ts >= nanoRowTs && !isCmd && /^[1-4]$/.test(nanoInput)) {
        await handleNanoSessionReply(socket, msg, from, nowsender, nanoSel, parseInt(nanoInput, 10));
        return;
      }
    }

    // ========== SONG SESSION REPLY LISTENER ==========
    // Interactive .song flow: after the menu, the user replies 1 (Audio),
    // 2 (Document) or 3 (Voice Note). Quoting the menu (stanzaId match)
    // always wins; a plain number also works while the song session is the
    // most recent interaction for this user. Quoting the menu with anything
    // else = invalid choice.
    {
      const songSel = songState.get(nowsender) || songState.get(sender);
      const songRowTs = (pendingRowSelect[sender] || {}).timestamp || 0;
      const songInput = (body || '').trim();
      const songCtx = (msg.message && msg.message.extendedTextMessage && msg.message.extendedTextMessage.contextInfo) || {};
      const songQuoted = !!songSel && !!songSel.msgId && (songCtx.stanzaId || '') === songSel.msgId;
      const songIsNum = /^[123]$/.test(songInput);
      // No !isbot gate: the owner's number is a paired session, and the old
      // substring check swallowed their replies. The session match (quote /
      // most-recent) is the correct guard.
      if (!quotesAnimeMenu && songSel && sessionOwnedByMe(songSel) && !isCmd && (songQuoted || (songSel.ts >= songRowTs && songIsNum))) {
        if (songIsNum) {
          await handleSongSessionReply(socket, msg, from, nowsender, songSel, parseInt(songInput, 10));
          return;
        }
        await socket.sendMessage(from, { text: `*❌ Invalid choice!* Reply with *1* (Audio), *2* (Document) or *3* (Voice Note).\n\n${config.BOT_FOOTER}` }, { quoted: msg }).catch(() => {});
        return;
      } else if (songIsNum && !isCmd && !songSel) {
        console.log(`[song-debug] numeric reply "${songInput}" with NO active song session (nowsender=${nowsender} sender=${sender})`);
      } else if (songIsNum && !isCmd && songSel) {
        console.log(`[song-debug] numeric reply "${songInput}" skipped: not-quoted and not-most-recent (ts=${songSel.ts} rowTs=${songRowTs}) (nowsender=${nowsender})`);
      }
    }

    // ========== YTS SESSION REPLY LISTENER ==========
    // Interactive .yts flow: user replies a number to pick a YouTube result
    // (1-N, N can be 10). Only the selected result is processed — no other
    // command runs. Fires only when the yts session is most recent.
    {
      const ytsSel = ytsState.get(nowsender) || ytsState.get(sender);
      const ytsRowTs = (pendingRowSelect[sender] || {}).timestamp || 0;
      const ytsInput = (body || '').trim();
      const ytsIsNum = /^\d+$/.test(ytsInput);
      // No !isbot gate: same multi-session reasoning as song/nano above.
      if (!quotesAnimeMenu && ytsSel && sessionOwnedByMe(ytsSel) && ytsSel.ts >= ytsRowTs && !isCmd) {
        const ytsNum = parseInt(ytsInput, 10);
        if (ytsIsNum && ytsNum > 0 && ytsNum <= ytsSel.results.length) {
          await handleYtsSessionReply(socket, msg, from, nowsender, ytsSel, ytsNum, prefix);
          return;
        }
      } else if (ytsIsNum && !isCmd && !ytsSel) {
        console.log(`[yts-debug] numeric reply "${ytsInput}" with NO active yts session (nowsender=${nowsender} sender=${sender})`);
      } else if (ytsIsNum && !isCmd && ytsSel) {
        console.log(`[yts-debug] numeric reply "${ytsInput}" skipped: not-most-recent (ts=${ytsSel.ts} rowTs=${ytsRowTs}) (nowsender=${nowsender})`);
      }
    }

    // ========== AUTO-REACT ==========
    // Hard gate: Auto React must be ON before ANY reaction is sent. When OFF
    // the bot never reacts to any message — not the owner's, not sudo/special
    // users', not in private chats, not in groups. Every auto-reaction trigger
    // is ignored completely, with no exceptions or bypasses.
    const sanitizedOwner = (number || '').replace(/[^0-9]/g, '');
    const reactUserConfig = await loadUserConfigFromMongo(sanitizedOwner).catch(() => null) || {};

    // When ON, react to ALL non-command messages on both sides of chats:
    // the session owner's own messages AND messages from other people,
    // in private chats and in groups (never self-chat, never commands).
    if (reactUserConfig.AUTO_REACT === 'true' && !isCmd && msg.key && !isSelfChatJid(socket, from)) {
      const emojis = reactUserConfig.AUTO_LIKE_EMOJI || config.AUTO_LIKE_EMOJI;
      const emoji = emojis[Math.floor(Math.random() * emojis.length)];
      socket.sendMessage(from, { react: { text: emoji, key: msg.key } }).catch(() => {});
    }
    // ===============================================================

    // helper: download quoted media into buffer
    async function downloadQuotedMedia(quoted) {
      if (!quoted) return null;
      const qTypes = ['imageMessage','videoMessage','audioMessage','documentMessage','stickerMessage'];
      const qType = qTypes.find(t => quoted[t]);
      if (!qType) return null;
      const messageType = qType.replace(/Message$/i, '').toLowerCase();
      const stream = await downloadContentFromMessage(quoted[qType], messageType);
      let buffer = Buffer.from([]);
      for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
      return {
        buffer,
        mime: quoted[qType].mimetype || '',
        caption: quoted[qType].caption || quoted[qType].fileName || '',
        ptt: quoted[qType].ptt || false,
        fileName: quoted[qType].fileName || ''
      };
    }

if (!command) {
  // ===== GREETING CUSTOM TEXT CAPTURE =====
  // When the user was told "reply with your custom greeting text" via
  // .welcome set / .goodbye set / .pwel set (no text), capture their reply
  // and store it in their config.
  const pendingGreet = pendingWelcomeInput[sender];
  if (!quotesAnimeMenu && pendingGreet && pendingGreet.kind && sessionOwnedByMe(pendingGreet)) {
    try {
      delete pendingWelcomeInput[sender];
      const text = (body || '').trim();
      if (!text) {
        await socket.sendMessage(from, { text: '❌ Custom text cannot be empty. Please send the text again.' }, { quoted: msg });
        return;
      }
      const sanitized = (number || '').replace(/[^0-9]/g, '');
      const cfg = await loadUserConfigFromMongo(sanitized) || {};
      if (pendingGreet.kind === 'welcome') cfg.WELCOME_GROUP_TEXT = text;
      else if (pendingGreet.kind === 'goodbye') cfg.GOODBYE_GROUP_TEXT = text;
      else if (pendingGreet.kind === 'pwel') cfg.WELCOME_PERSONAL_TEXT = text;
      await setUserConfigInMongo(sanitized, cfg);
      const names = { welcome: 'Group Welcome', goodbye: 'Group Goodbye', pwel: 'Personal Greeting' };
      await socket.sendMessage(from, { text: `✅ *${names[pendingGreet.kind]} text saved!*\n\n${text}` }, { quoted: msg });
    } catch (e) {
      console.error('Greeting capture error:', e);
      await socket.sendMessage(from, { text: '*❌ Error saving custom text.*' }, { quoted: msg });
    }
    return;
  }

  // ===== MOVIE PLUGIN: handle pending number replies =====
  const trimmedBody = (body || '').trim();
  const replyNum = parseInt(trimmedBody);

  if (!quotesAnimeMenu && moviePendingSearch[sender] && sessionOwnedByMe(moviePendingSearch[sender]) && Array.isArray(moviePendingSearch[sender].results) && !isNaN(replyNum) && replyNum > 0 && replyNum <= moviePendingSearch[sender].results.length) {
    try {
      await socket.sendMessage(from, { react: { text: "✅", key: msg.key } });
      const index = replyNum - 1;
      const selected = moviePendingSearch[sender].results[index];
      delete moviePendingSearch[sender];
      delete pendingRowSelect[sender];
      const metadata = await getMovieMetadata(selected.movieUrl);
      let infoMsg = `*🎞️ ${metadata.title}*\n`;
      infoMsg += `*📝 Language:* ${metadata.language}\n*⏱️ Duration:* ${metadata.duration}\n*⭐ IMDb:* ${metadata.imdb}\n`;
      infoMsg += `*🎭 Genres:* ${metadata.genres.join(", ")}\n*🎥 Directors:* ${metadata.directors.join(", ")}\n*🌟 Stars:* ${metadata.stars.slice(0,5).join(", ")}${metadata.stars.length>5?"...":""}\n\n`;
      infoMsg += "*🔗 Fetching download links, please wait...*";
      if (metadata.thumbnail) {
        try {
          await socket.sendMessage(from, { image: { url: metadata.thumbnail }, caption: infoMsg }, { quoted: msg });
        } catch (e) {
          console.warn('[movie] thumbnail send failed, fell back to text:', e && e.message || e);
          await socket.sendMessage(from, { text: infoMsg }, { quoted: msg }).catch(() => {});
        }
      } else {
        await socket.sendMessage(from, { text: infoMsg }, { quoted: msg });
      }
      const downloadLinks = await getPixeldrainLinks(selected.movieUrl);
      if (!downloadLinks.length) {
        await socket.sendMessage(from, { text: `*❌ No download links found (max ${movieMaxSizeLabel()})!*` }, { quoted: msg });
        return;
      }
      moviePendingQuality[sender] = { movie: { metadata, downloadLinks }, timestamp: Date.now(), botJid: currentBotJid() };
      let qualityMsg = `*📥 Available Qualities (Max ${movieMaxSizeLabel()}):*\n`;
      downloadLinks.forEach((d,i) => qualityMsg += `*${i+1}.* ${d.quality} - ${d.size}\n`);
      qualityMsg += `\n*Reply with quality number to receive the movie as a document.*`;
      await socket.sendMessage(from, { text: qualityMsg }, { quoted: msg });
    } catch(e) { await socket.sendMessage(from, { text: `*❌ Error:* ${e.message}` }, { quoted: msg }); }
    return;
  }

  if (!quotesAnimeMenu && moviePendingQuality[sender] && sessionOwnedByMe(moviePendingQuality[sender]) && moviePendingQuality[sender].movie && Array.isArray(moviePendingQuality[sender].movie.downloadLinks) && !isNaN(replyNum) && replyNum > 0 && replyNum <= moviePendingQuality[sender].movie.downloadLinks.length) {
    try {
      await socket.sendMessage(from, { react: { text: "✅", key: msg.key } });
      const index = replyNum - 1;
      const { movie } = moviePendingQuality[sender];
      delete moviePendingQuality[sender];
      delete pendingRowSelect[sender];
      const selectedLink = movie.downloadLinks[index];
      await socket.sendMessage(from, { text: `🚀 *${selectedLink.quality} Movie Download Started!* 🎥\n\n⏳ Please wait a moment…\n📦 File is being prepared as a document.` }, { quoted: msg });
      const directUrl = getDirectPixeldrainUrl(selectedLink.link);
      const sizeBytes = disk.parseSizeToBytes(selectedLink.size);
      if (sizeBytes > 0) {
        disk.ensureDiskSpace(sizeBytes, `${movie.metadata.title} (${selectedLink.quality})`);
      } else {
        await disk.ensureUrlSpace(directUrl, movie.metadata.title);
      }
      await disk.withDownloadSlot(async () => {
        await socket.sendMessage(from, {
          document: { url: directUrl },
          mimetype: "video/mp4",
          fileName: `${movie.metadata.title.substring(0,50)} - ${selectedLink.quality}.mp4`.replace(/[^\w\s.-]/gi,''),
          caption: `🎞️ *${movie.metadata.title}*\n\n📊 *Quality* : ${selectedLink.quality}\n💾 *Size*    : ${selectedLink.size}\n\n🍿 Enjoy your Movie\n\n> ©𝙳𝚎𝚟𝚎𝚕𝚘𝚙𝚎𝚍 𝚋𝚢 𝙸𝚂𝙷𝙰𝙽-𝕏 × 𝕃𝕠𝕧𝔼𝕝𝕪`
        }, { quoted: msg });
      });
    } catch(e) { await socket.sendMessage(from, { text: `*❌ Failed to send movie:* ${e.message}` }, { quoted: msg }); }
    return;
  }
  // ===== END MOVIE PLUGIN pending handlers =====

  // ===== MVFR SESSION: handle pending number replies =====
  // .mvfr owns numeric replies while a session is active (search → movie →
  // quality → download → send document DIRECTLY to the session's destJid).
  const mvfrGateState = mvfrSessions[mvfrSessionKey(nowsender, from)];
  if (!quotesAnimeMenu && mvfrGateState && sessionOwnedByMe(mvfrGateState)) {
    const mvfrHandled = await handleMvfrReply(socket, msg, from, sender, nowsender, trimmedBody);
    if (mvfrHandled) return;
  }

  // ===== CINEFR SESSION: handle pending number replies =====
  // .cinefr flows own numeric replies while a session is active for this
  // user, so the search / episode / quality steps below never leak into
  // other handlers. Session keyed by requester|chat; the destination JID
  // stays bound to that exact request (User A's movie can never go to
  // User B's JID, and a DM request can't be hijacked from a group).
  const cinefrGateState = cinefrSessions[cinefrSessionKey(nowsender, from)];
  if (!quotesAnimeMenu && cinefrGateState && sessionOwnedByMe(cinefrGateState)) {
    const cinefrHandled = await handleCinefrReply(socket, msg, from, sender, nowsender, trimmedBody);
    if (cinefrHandled) return;
  }

  // ===== ANIMEHEAVEN PLUGIN: handle pending number replies =====
  // A reply that quotes an animeheaven menu belongs to animeheaven — it is
  // handled here and never reaches cinesub / the .anime (Miruro) flow. Only
  // non-command replies qualify (a new `.animeheaven <name>` that happens to
  // quote an old menu goes straight to the command switch instead).
  if (!isCmd && quotesAnimeHeavenMenu) {
    const ahHandled = await animeheavenPlugin(socket, msg, [], from, sender, false, nowsender, prefix);
    if (ahHandled) return;
  }

  // ===== CINESUB PLUGIN: handle pending number replies =====
  // A reply that quotes an anime menu belongs to anime — never cinesub.
  if (!quotesAnimeMenu) await cinesubPlugin(socket, msg, [], from, sender, false);

  // ===== CINESUBZ.LK PLUGIN (.lk): handle pending number replies =====
  if (!quotesAnimeMenu) await cinesulkPlugin(socket, msg, [], from, sender, false);

  // ===== BOXHUB PLUGIN (.boxhub): handle pending number replies =====
  if (!quotesAnimeMenu) await boxhubPlugin(socket, msg, [], from, sender, false);

  // ===== ANIME (.anime): handle pending number replies =====
  // Suppress the "session expired" nudge while ANY other dedicated reply flow
  // is active for this user (song / yts / nano / movie / cinefr / mvfr /
  // cinesub / greeting capture / numbered menu) — a random number typed
  // mid-other-flow must never get a misleading "Session expired" from anime.
  const animeOtherPending = !!(
    songState.get(nowsender) || songState.get(sender) ||
    ytsState.get(nowsender) || ytsState.get(sender) ||
    nanoSession.get(nowsender) || nanoSession.get(sender) ||
    moviePendingSearch[sender] || moviePendingQuality[sender] ||
    pendingWelcomeInput[sender] ||
    cinefrSessions[cinefrSessionKey(nowsender, from)] ||
    mvfrSessions[mvfrSessionKey(nowsender, from)] ||
    (typeof cinesubPlugin.isActive === 'function' && cinesubPlugin.isActive(sender)) ||
    animeheavenPlugin.isActive(nowsender) || animeheavenPlugin.isActive(sender) ||
    cinesulkPlugin.isActive(nowsender) || cinesulkPlugin.isActive(sender) ||
    (typeof boxhubPlugin.isActive === 'function' && (boxhubPlugin.isActive(nowsender) || boxhubPlugin.isActive(sender))) ||
    !!pendingRowSelect[sender]
  );
  await handleAnimeReply(socket, msg, from, sender, { otherPending: animeOtherPending });

  // All plugin handlers have been processed, now return
  return;
}

    try {

      // Load user config for work type restrictions
      const sanitized = (number || '').replace(/[^0-9]/g, '');
      const userConfig = await loadUserConfigFromMongo(sanitized) || {};
      
// ========== ADD WORK TYPE RESTRICTIONS HERE ==========
// Apply work type restrictions for non-owner users
if (!isOwner) {
  // Get work type from user config or fallback to global config
  const workType = userConfig.WORK_TYPE || 'public'; // Default to public if not set
  
  // If work type is "private", only owner can use commands
  if (workType === "private") {
    return;
  }
  
  // If work type is "inbox", block commands in groups
  if (isGroup && workType === "inbox") {
    return;
  }
  
  // If work type is "groups", block commands in private chats
  if (!isGroup && workType === "groups") {
    return;
  }
  
  // If work type is "public", allow all (no restrictions needed)
}
// ========== END WORK TYPE RESTRICTIONS ==========

      // ===== PER-BOT CUSTOMIZATION GATE + TARGET-USER RULE =====
      // CRITICAL: the command sender (Owner) is NOT the target bot. A
      // customization command modifies ONE bot's own configuration and the
      // target is resolved via the project's existing mechanism: in a shared
      // multi-bot chat the target is the single @mentioned connected bot
      // (EXACTLY one — multi-mention is ambiguous and rejected); in a private
      // chat / single-bot group the bot the Owner messaged is the explicitly
      // selected target. Non-customization commands are never gated.
      const isPerBotCommand = PER_BOT_COMMANDS.has(command);
      let perBotAllowed = !isPerBotCommand;
      if (isPerBotCommand) {
        if ((await activeBotCountInChat(socket, from)) <= 1) {
          perBotAllowed = true; // DM / single-bot group → the messaged bot is the target
        } else {
          // Shared multi-bot chat → exactly ONE connected bot must be
          // @mentioned and it must be THIS bot. Zero mentions or two+ bot
          // mentions = undetermined/ambiguous target → nothing executes.
          perBotAllowed = (await countMentionedSessions(socket, msg)) === 1 && (await replyMentionsMe(msg, socket));
        }
      }
      if (isPerBotCommand && !perBotAllowed) {
        // Target cannot be determined safely (or is ambiguous). We MUST NOT
        // save to the bot that received the command (commandSender ≠
        // targetBot) and MUST NOT modify any bot's config. When exactly ONE
        // connected bot IS mentioned, the target is resolved — that bot
        // processes the command and every other socket (incl. the Owner's own
        // bot) stays silent. Otherwise only the OWNER's own bot replies with
        // a clear error — deduped by message id, so if several owner-numbered
        // sessions share the chat only ONE bot replies (no duplicate errors);
        // all other bots stay silent and nobody reacts.
        const mentionedSessions = await countMentionedSessions(socket, msg);
        if (mentionedSessions !== 1) {
          try {
            // Dedupe strictly by message id: without an id we stay silent
            // rather than risk every owner-numbered session replying.
            const msgId = msg && msg.key && msg.key.id;
            if (msgId && isOwnerNumber(socketBotNumber(socket)) && !perBotErrorSent.has(msgId)) {
              perBotErrorSent.add(msgId);
              if (perBotErrorSent.size > 1000) perBotErrorSent.clear();
              const hasAnyMention = !!(msg.message && msg.message.extendedTextMessage &&
                msg.message.extendedTextMessage.contextInfo &&
                Array.isArray(msg.message.extendedTextMessage.contextInfo.mentionedJid) &&
                msg.message.extendedTextMessage.contextInfo.mentionedJid.length);
              const example = command === 'setpremium'
                ? `@BotA ${prefix}setpremium <jid> <days|lifetime>`
                : `@BotA ${prefix}${command} My Footer`;
              const errText = (mentionedSessions > 1)
                ? `*❌ AMBIGUOUS TARGET*\n\nYou @mentioned multiple connected bots. Please @mention exactly ONE bot to customize.\n\n_No bot configuration was changed._`
                : (hasAnyMention)
                  ? `*❌ INVALID TARGET*\n\nThe number you @mentioned is not one of my connected bots.\n\n_No bot configuration was changed._`
                  : `*❌ TARGET NOT SPECIFIED*\n\n_This command needs an @mention to choose which bot to customize._\n\n*Example:*\n${example}\n\n_No bot configuration was changed._`;
              await socket.sendMessage(sender, { text: `${errText}\n\n${config.BOT_FOOTER}` }, { quoted: msg }).catch(() => {});
            }
          } catch (e) {}
        }
        return; // no bot processes this command → nothing is saved, nobody reacts
      }

      switch (command) {
        // --- existing commands (deletemenumber, unfollow, newslist, admin commands etc.) ---
        // ... (keep existing other case handlers unchanged) ...
          case 'ts': {
    const axios = require('axios');

    const q = msg.message?.conversation ||
              msg.message?.extendedTextMessage?.text ||
              msg.message?.imageMessage?.caption ||
              msg.message?.videoMessage?.caption || '';

    let query = q.replace(/^[.\/!]ts\s*/i, '').trim();

    if (!query) {
        return await socket.sendMessage(sender, {
            text: '*[❗] TikTok එකේ මොකද්ද බලන්න ඕනෙ කියපං! 🔍*'
        }, { quoted: msg });
    }

    // 🔹 Load bot name dynamically
    const sanitized = (number || '').replace(/[^0-9]/g, '');
    let cfg = await loadUserConfigFromMongo(sanitized) || {};
    let botName = await resolveUserBotName(socket, nowsender, cfg, '𝗜𝗦𝗛𝗔𝗡-𝐗 𝗠𝗗 𝙋𝙍𝙊 🧑‍💻🇱🇰');

    // 🔹 Fake contact for quoting
    
    try {
        await socket.sendMessage(sender, { text: `🔎 Searching TikTok for: ${query}...` }, { quoted: msg });

        const searchParams = new URLSearchParams({ keywords: query, count: '10', cursor: '0', HD: '1' });
        const response = await axios.post("https://tikwm.com/api/feed/search", searchParams, {
            headers: { 'Content-Type': "application/x-www-form-urlencoded; charset=UTF-8", 'Cookie': "current_language=en", 'User-Agent': "Mozilla/5.0" }
        });

        const videos = response.data?.data?.videos;
        if (!videos || videos.length === 0) {
            return await socket.sendMessage(sender, { text: '⚠️ No videos found.' }, { quoted: msg });
        }

        // Limit number of videos to send
        const limit = 3; 
        const results = videos.slice(0, limit);

        // 🔹 Send videos one by one
        for (let i = 0; i < results.length; i++) {
            const v = results[i];
            const videoUrl = v.play || v.download || null;
            if (!videoUrl) continue;

            await socket.sendMessage(sender, { text: `*⏳ Downloading:* ${v.title || 'No Title'}` }, { quoted: msg });

            await socket.sendMessage(sender, {
                video: { url: videoUrl },
                caption: `*🎵 ${botName} 𝐓𝙸𝙺𝚃𝙾𝙺 𝐃𝙾𝚆𝙽𝙻𝙾𝙰𝙳𝙴𝚁*\n\𝐓itle: ${v.title || 'No Title'}\n*🥷𝐀𝚄𝚃𝙷𝙾𝚁:* ${v.author?.nickname || 'Unknown'}`
            }, { quoted: msg });
        }

    } catch (err) {
        console.error('TikTok Search Error:', err);
        await socket.sendMessage(sender, { text: `❌ Error: ${err.message}` }, { quoted: msg });
    }

    break;
}

// 🍷🍷🍷
case 'youtube':
case 'ytdl':
case 'video':
case 'yt':
case 'mp4': {
    try {
        const q = args.join(' ').trim();
        if (!q) return await socket.sendMessage(sender, { text: '*❌ Provide a URL or a keyword*' }, { quoted: msg });

        // ✅ URL detect කළොත් direct download කරන්න (720p default)
        const isYtUrl = /^(https?:\/\/)?(www\.)?(youtube\.com\/(watch\?v=|shorts\/)|youtu\.be\/)[\w\-]+/.test(q);
        if (isYtUrl) {
            await socket.sendMessage(sender, { react: { text: '⬇️', key: msg.key } });
            // ⚡ Multi-API chain (varhad → movanest → nntech → arslan) with
            // link verification — dead CDN links are rejected before sending
            // so WhatsApp never fetches a broken URL. The verified link is then
            // downloaded to a local file and the FILE is sent (like .song),
            // which uploads the bytes directly — no external fetch at all.
            const dl = await videoGetDownload(q, '720');
            if (!dl || !dl.link) {
                return await socket.sendMessage(sender, { text: '*❌ Video download කළ නොහැකි විය. API error. නැවත උත්සාහ කරන්න.*' }, { quoted: msg });
            }
            let tmpPath = null;
            try {
                tmpPath = videoTempPath();
                await videoStreamToFile(dl.link, tmpPath);
                if (videoTooBigForChat(tmpPath)) {
                    // >15MB — WhatsApp rejects big `video:` messages, so send
                    // as a document instead (documents accept up to 2GB).
                    await socket.sendMessage(sender, {
                        document: { url: tmpPath },
                        mimetype: 'video/mp4',
                        fileName: `${(dl.title || 'video').replace(/[\\/:*?"<>|]/g, '').substring(0, 60)}.mp4`,
                        caption: `🎬 *${dl.title || 'Video'}*\n\n\`${dl.label}\`\n\n> _*𝐃𝙴𝚅𝙴𝙻𝙾𝙿𝙴𝚁 𝐁𝚈 𝐈𝚂𝙷𝙰𝙽-𝐗 × 𝐋𝙾𝚅𝙴𝙻𝚈 🧑‍💻🇱🇰*_`
                    }, { quoted: msg });
                } else {
                    await sendVideoWithDocFallback(socket, sender, tmpPath, {
                        title: dl.title || 'Video',
                        label: dl.label,
                        footerText: '> _*𝐃𝙴𝚅𝙴𝙻𝙾𝙿𝙴𝚁 𝐁𝚈 𝐈𝚂𝙷𝙰𝙽-𝐗 × 𝐋𝙾𝚅𝙴𝙻𝚈 🧑‍💻🇱🇰*_',
                        quoted: msg
                    });
                }
                await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
            } finally {
                if (tmpPath) { try { fs.unlinkSync(tmpPath); } catch (e) {} }
            }
            break;
        }

        await socket.sendMessage(sender, { react: { text: '🎬', key: msg.key } });

        // 🔎 varhad YouTube search API (same provider as the downloader).
        const sres = await axios.get('https://api-varhad.my.id/search/youtube', { params: { q }, timeout: 15000 });
        const searchResults = (sres.data && sres.data.status && Array.isArray(sres.data.result)) ? sres.data.result : [];
        if (!searchResults.length) return await socket.sendMessage(sender, { text: '*❌ error මට කිසිවක් සොයාගත නොහැකි විය :(*' }, { quoted: msg });

        const video = searchResults[0];

        const caption =
            `*┎━━━━━━━━━━━━━━❖●►*\n` +
            `*┃➤ \`🎬 Title\`    :* ${video.title}\n` +
            `*┃➤ \`💃 Channel\`  :* ${video.channel || 'Unknown'}\n` +
            `*┃➤ \`⏱ Duration\` :* ${video.duration || '—'}\n` +
            `*┃➤ \`🔗 Link\`     :* ${video.link}\n` +
            `*┗━━━━━━━━━━━━━━❖●►*`;

        const qualityRows = [
            { label: '🎬 360p (Video)', id: `${prefix}down_360 ${video.link}` },
            { label: '🎬 480p (Video)', id: `${prefix}down_480 ${video.link}` },
            { label: '🎬 720p (Video)', id: `${prefix}down_720 ${video.link}` },
            { label: '🎬 1080p (Video)', id: `${prefix}down_1080 ${video.link}` },
            { label: '📂 360p (Document)', id: `${prefix}down_360d ${video.link}` },
            { label: '📂 480p (Document)', id: `${prefix}down_480d ${video.link}` },
            { label: '📂 720p (Document)', id: `${prefix}down_720d ${video.link}` },
            { label: '📂 1080p (Document)', id: `${prefix}down_1080d ${video.link}` }
        ];
        setPendingRowSelect(sender, qualityRows);
        await socket.sendMessage(sender, {
            image: { url: video.imageUrl },
            caption: `${caption}\n\n*📥 Select a quality:*\n${buildNumberedList(qualityRows)}\n\n*Reply with the number of your choice.*`
        }, { quoted: msg });

    } catch (e) {
        console.error('Video Error:', e);
        await socket.sendMessage(sender, { text: '*❌ Youtube Error*' }, { quoted: msg });
    }
    break;
}
// 🔎 YouTube Search Command
case 'yts':
case 'youtubesearch': {
    try {
        const ytsSearch = require('yt-search');

        const q = args.join(' ').trim();
        console.log('[yts] search started for:', q);

        // ❌ No search query
        if (!q) {
            await socket.sendMessage(sender, {
                text: `🔎 *YouTube Search keyword Send*\n✨ *Example:* \`${prefix}yts Alan Walker\`\n\n${config.BOT_FOOTER}`
            }, { quoted: msg });
            break;
        }

        // React with search emoji
        await socket.sendMessage(sender, { react: { text: '🔎', key: msg.key } });

        // ⌛ Searching message
        await socket.sendMessage(sender, {
            text: `🔍 *𝚂𝙴𝙰𝚁𝙲𝙷𝙸𝙽𝙶 𝙾𝙽 𝚈𝙾𝚄𝚃𝚄𝙱𝙴*\n⏳ *𝙻𝙾𝙰𝙳𝙸𝙽𝙶...*\n\n${config.BOT_FOOTER}`
        }, { quoted: msg });

        const search = await ytsSearch(q);

        // ❌ No results
        if (!search || !search.videos || search.videos.length === 0) {
            await socket.sendMessage(sender, {
                text: `😕 *No YouTube results found*\n👉 *Please try again with different keywords*\n\n${config.BOT_FOOTER}`
            }, { quoted: msg });
            break;
        }

        const results = search.videos.slice(0, 10);

        // Interactive selection session: the user replies a number (1-N) to
        // process exactly that YouTube result. Registering a dedicated session
        // also guarantees no stale numbered menu can hijack the reply.
        const ytsSess = { stage: 'select_result', results, ts: Date.now(), botJid: currentBotJid() };
        ytsSess.timer = setTimeout(() => clearYtsState(nowsender), 120000);
        ytsState.set(nowsender, ytsSess);
        delete pendingRowSelect[sender];

        const formattedResults = results
            .map((v, i) =>
                `*╭━━━〔 🎬 ${String(i + 1).padStart(2, '0')} 〕━━━⬣*\n` +
                `*│ 🎬 Title:*\n` +
                `*│ ${v.title}*\n` +
                `*│*\n` +
                `*│ ⏱️ Duration:* ${v.timestamp}\n` +
                `*│ 👁️ Views:* ${v.views.toLocaleString()}\n` +
                `*│ 📅 Uploaded:* ${v.ago}\n` +
                `*│*\n` +
                `*│ 🔗 Link:*\n` +
                `*│ ${v.url}*\n` +
                `*╰━━━━━━━━━━━━━━━⬣*`
            )
            .join('\n\n');

        const caption =
`*╭━━━〔 🚀 𝐈𝐒𝐇𝐀𝐍-𝐗 𝐌𝐃 • 𝐘𝐎𝐔𝐓𝐔𝐁𝐄 〕━━━⬣*\n` +
`*│ 🔎 YouTube Search Results*\n` +
`*╰━━━━━━━━━━━━━━━━━━⬣*\n\n` +
`*╭━━━━━━━━━━━━━━━━━━⬣*\n` +
`*│ 🔍 Query:* ${q}\n` +
`*│ 📊 Results:* ${results.length}\n` +
`*╰━━━━━━━━━━━━━━━━━━⬣*\n\n` +
`${formattedResults}\n\n_Reply with a number (1-${results.length}) to select._\n\n${config.BOT_FOOTER}`;

        try {
            await socket.sendMessage(
                from,
                {
                    image: { url: results[0].thumbnail },
                    caption
                },
                { quoted: msg }
            );
        } catch (e) {
            await socket.sendMessage(
                from,
                {
                    image: { url: 'https://files.catbox.moe/hl9y3y.png' },
                    caption
                },
                { quoted: msg }
            );
        }

        await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });

    } catch (err) {
        console.error('YTS Search Error:', err);
        await socket.sendMessage(sender, {
            text: `❌ *YouTube search failed*\n🔁 *Please try again*\n\n${config.BOT_FOOTER}`
        }, { quoted: msg });
    }
    break;
}

case 'down_360':
case 'down_480':
case 'down_720':
case 'down_1080': {
    try {
        const qualityMap = { down_360: '360', down_480: '480', down_720: '720', down_1080: '1080' };
        const quality = qualityMap[command] || '360';

        const q = args.join(' ').trim();
        if (!q) return await socket.sendMessage(sender, { text: '*❌ Provide a URL or a keyword*' }, { quoted: msg });

        const ownerdata = (await axios.get(
            'https://raw.githubusercontent.com/Dilu-x/OWNER_DATA/refs/heads/main/ownerdata'
        )).data;
        const { footer } = ownerdata;

        await socket.sendMessage(sender, { react: { text: '⬇️', key: msg.key } });

        // ⚡ Multi-API chain (varhad → movanest → nntech → arslan) with link
        // verification + local-file download (see .mp4 — kills the
        // "something is wrong with the video file" error).
        const dl = await videoGetDownload(q, quality);

        if (!dl || !dl.link) {
            return await socket.sendMessage(sender, {
                text: '*❌ Video download කළ නොහැකි විය. API error. නැවත උත්සාහ කරන්න.*'
            }, { quoted: msg });
        }

        let tmpPath = null;
        try {
            tmpPath = videoTempPath();
            await videoStreamToFile(dl.link, tmpPath);
            if (videoTooBigForChat(tmpPath)) {
                // >15MB — WhatsApp rejects big `video:` messages, so send
                // as a document instead (documents accept up to 2GB).
                await socket.sendMessage(sender, {
                    document: { url: tmpPath },
                    mimetype: 'video/mp4',
                    fileName: `${(dl.title || 'video').replace(/[\\/:*?"<>|]/g, '').substring(0, 60)}.mp4`,
                    caption: `🎬 *${dl.title || 'Video'}*\n\n\`${dl.label}\`\n\n${footer}`
                }, { quoted: msg });
            } else {
                await sendVideoWithDocFallback(socket, sender, tmpPath, {
                    title: dl.title || 'Video',
                    label: dl.label,
                    footerText: footer,
                    quoted: msg
                });
            }

            await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
        } finally {
            if (tmpPath) { try { fs.unlinkSync(tmpPath); } catch (e) {} }
        }

    } catch (e) {
        console.error('Video DL Error:', e);
        await socket.sendMessage(sender, { text: '*❌ Video Error*' }, { quoted: msg });
    }
    break;
}
case 'down_360d':
case 'down_480d':
case 'down_720d':
case 'down_1080d': {
    try {
        const sharp = require('sharp');
        const qualityMap = { down_360d: '360', down_480d: '480', down_720d: '720', down_1080d: 'best' };
        const quality = qualityMap[command] || '360';

        const q = args.join(' ').trim();
        if (!q) return await socket.sendMessage(sender, { text: '*❌ Provide a URL or a keyword*' }, { quoted: msg });

        const ownerdata = (await axios.get(
            'https://raw.githubusercontent.com/Dilu-x/OWNER_DATA/refs/heads/main/ownerdata'
        )).data;
        const { footer } = ownerdata;

        await socket.sendMessage(sender, { react: { text: '⬇️', key: msg.key } });

        // ⚡ Multi-API chain (varhad → movanest → nntech → arslan) with link
        // verification + local-file download (see .mp4). 1080d → quality 1080.
        const qParam = quality === 'best' ? '1080' : quality;
        const dl = await videoGetDownload(q, qParam);

        if (!dl || !dl.link) {
            return await socket.sendMessage(sender, {
                text: '* Video download කළ නොහැකි විය. API error. නැවත උත්සාහ කරන්න.*'
            }, { quoted: msg });
        }

        let resizedThumb;
        if (dl.thumb) {
            try {
                const imgRes = await axios.get(dl.thumb, { responseType: 'arraybuffer', timeout: 10000 });
                resizedThumb = await sharp(Buffer.from(imgRes.data)).resize(200, 200).toBuffer();
            } catch (thumbErr) {
                console.error('Thumbnail resize failed:', thumbErr.message);
            }
        }

        let tmpPath = null;
        try {
            tmpPath = videoTempPath();
            await videoStreamToFile(dl.link, tmpPath);
            await socket.sendMessage(sender, {
                document: { url: tmpPath },
                mimetype: 'video/mp4',
                fileName: `${(dl.title || 'video').replace(/[\\/:*?"<>|]/g, '').substring(0, 60)}.mp4`,
                jpegThumbnail: resizedThumb,
                caption: `🎬 *${dl.title || 'Video'}*\n\n\`${dl.label}\`\n\n${footer}`
            }, { quoted: msg });

            await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
        } finally {
            if (tmpPath) { try { fs.unlinkSync(tmpPath); } catch (e) {} }
        }

    } catch (e) {
        console.error('Video Doc DL Error:', e);
        await socket.sendMessage(sender, { text: '*❌ Video Error*' }, { quoted: msg });
    }
    break;
}

// 🥹🥹🥹
case 'setting': {
  // 1. Acknowledge the command
  await socket.sendMessage(sender, { react: { text: '🧑‍🔧', key: msg.key } });

  try {
    // 2. Permission Logic — reuse the already-correct isOwner check
    //    (handles the comma-separated OWNER_NUMBER list properly, unlike
    //    the old exact-match comparison that broke this command).
    const sanitized = (number || '').replace(/[^0-9]/g, '');

    if (!isOwner) {
      return await socket.sendMessage(sender, {
        text: `❌ *𝐀𝐂𝐂𝐄𝐒𝐒 𝐃𝐄𝐍𝐈𝐄𝐃*

🔒 _This menu is restricted to the bot owner only._`
      }, { quoted: msg });
    }

    // 3. Load Configuration
    const currentConfig = await loadUserConfigFromMongo(sanitized) || {};
    const bc = await resolveDisplayBotConfig(socket, nowsender);
    const prefix = currentConfig.PREFIX || config.PREFIX;

// 4. Build the numbered settings menu (replaces the old interactive list)
    const settingRows = [
  { label: '✏️ 𝘾𝙝𝙖𝙣𝙜𝙚 𝘽𝙤𝙩 𝙉𝙖𝙢𝙚', id: `${prefix}setbotname` },
  { label: '🌐 𝙋𝙪𝙗𝙡𝙞𝙘 𝙈𝙤𝙙𝙚', id: `${prefix}wtype public` },
  { label: '🔒 𝙋𝙧𝙞𝙫𝙖𝙩𝙚 𝙈𝙤𝙙𝙚', id: `${prefix}wtype private` },
  { label: '👥 𝙂𝙧𝙤𝙪𝙥 𝙊𝙣𝙡𝙮', id: `${prefix}wtype groups` },
  { label: '📩 𝙄𝙣𝙗𝙤𝙭 𝙊𝙣𝙡𝙮', id: `${prefix}wtype inbox` },
  { label: '🟢 𝘼𝙡𝙬𝙖𝙮𝙨 𝙊𝙣𝙡𝙞𝙣𝙚 𝙊𝙉', id: `${prefix}botpresence online` },
  { label: '🔴 𝘼𝙡𝙬𝙖𝙮𝙨 𝙊𝙣𝙡𝙞𝙣𝙚 𝙊𝙁𝙁', id: `${prefix}botpresence offline` },
  { label: '⌨️ 𝙁𝙖𝙠𝙚 𝙏𝙮𝙥𝙞𝙣𝙜 𝙊𝙉', id: `${prefix}autotyping on` },
  { label: '⌨️ 𝙁𝙖𝙠𝙚 𝙏𝙮𝙥𝙞𝙣𝙜 𝙊𝙁𝙁', id: `${prefix}autotyping off` },
  { label: '🎙️ 𝙁𝙖𝙠𝙚 𝙍𝙚𝙘𝙤𝙧𝙙𝙞𝙣𝙜 𝙊𝙉', id: `${prefix}autorecording on` },
  { label: '🎙️ 𝙁𝙖𝙠𝙚 𝙍𝙚𝙘𝙤𝙧𝙙𝙞𝙣𝙜 𝙊𝙁𝙁', id: `${prefix}autorecording off` },
  { label: '👍 𝘼𝙪𝙩𝙤 𝙍𝙚𝙖𝙘𝙩 𝙊𝙉', id: `${prefix}autoreact on` },
  { label: '👍 𝘼𝙪𝙩𝙤 𝙍𝙚𝙖𝙘𝙩 𝙊𝙁𝙁', id: `${prefix}autoreact off` },
  { label: '👁️ 𝘼𝙪𝙩𝙤 𝙎𝙚𝙚𝙣 𝙎𝙩𝙖𝙩𝙪𝙨 𝙊𝙉', id: `${prefix}rstatus on` },
  { label: '👁️ 𝘼𝙪𝙩𝙤 𝙎𝙚𝙚𝙣 𝙎𝙩𝙖𝙩𝙪𝙨 𝙊𝙁𝙁', id: `${prefix}rstatus off` },
  { label: '❤️ 𝘼𝙪𝙩𝙤 𝙇𝙞𝙠𝙚 𝙎𝙩𝙖𝙩𝙪𝙨 𝙊𝙉', id: `${prefix}arm on` },
  { label: '❤️ 𝘼𝙪𝙩𝙤 𝙇𝙞𝙠𝙚 𝙎𝙩𝙖𝙩𝙪𝙨 𝙊𝙁𝙁', id: `${prefix}arm off` },
  { label: '📵 𝘼𝙪𝙩𝙤 𝙍𝙚𝙟𝙚𝙘𝙩 𝘾𝙖𝙡𝙡 𝙊𝙉', id: `${prefix}creject on` },
  { label: '📵 𝘼𝙪𝙩𝙤 𝙍𝙚𝙟𝙚𝙘𝙩 𝘾𝙖𝙡𝙡 𝙊𝙁𝙁', id: `${prefix}creject off` },
  { label: '📖 𝙍𝙚𝙖𝙙 𝘼𝙡𝙡 𝙈𝙚𝙨𝙨𝙖𝙜𝙚𝙨 𝙊𝙉', id: `${prefix}mread all` },
  { label: '📖 𝙍𝙚𝙖𝙙 𝘾𝙤𝙢𝙢𝙖𝙣𝙙𝙨 𝙊𝙣𝙡𝙮 𝙊𝙉', id: `${prefix}mread cmd` },
  { label: '🚫 𝘼𝙪𝙩𝙤 𝙍𝙚𝙖𝙙 𝙊𝙁𝙁', id: `${prefix}mread off` },
  { label: '🛡️ 𝘼𝙣𝙩𝙞-𝘿𝙚𝙡𝙚𝙩𝙚 𝘾𝙝𝙖𝙩', id: `${prefix}antidelete chat` },
  { label: '🛡️ 𝘼𝙣𝙩𝙞-𝘿𝙚𝙡𝙚𝙩𝙚 𝙄𝙣𝙗𝙤𝙭', id: `${prefix}antidelete inbox` },
  { label: '🚫 𝘼𝙣𝙩𝙞-𝘿𝙚𝙡𝙚𝙩𝙚 𝙊𝙛𝙛', id: `${prefix}antidelete off` },
  { label: '💬 𝙋𝙚𝙧𝙨𝙤𝙣𝙖𝙡 𝙂𝙧𝙚𝙚𝙩 𝙊𝙉', id: `${prefix}pwel on` },
  { label: '💬 𝙋𝙚𝙧𝙨𝙤𝙣𝙖𝙡 𝙂𝙧𝙚𝙚𝙩 𝙊𝙁𝙁', id: `${prefix}pwel off` },
  { label: '✏️ 𝙋𝙚𝙧𝙨𝙤𝙣𝙖𝙡 𝙂𝙧𝙚𝙚𝙩 𝙏𝙚𝙭𝙩', id: `${prefix}pwel set` },
  { label: '🤖 𝘼𝙪𝙩𝙤 𝙍𝙚𝙥𝙡𝙮 𝙊𝙉', id: `${prefix}autoreply on` },
  { label: '🤖 𝘼𝙪𝙩𝙤 𝙍𝙚𝙥𝙡𝙮 𝙊𝙁𝙁', id: `${prefix}autoreply off` },
  { label: '🧩 𝘼𝙪𝙩𝙤 𝙎𝙩𝙞𝙘𝙠𝙚𝙧 𝙊𝙉', id: `${prefix}autosticker on` },
  { label: '🧩 𝘼𝙪𝙩𝙤 𝙎𝙩𝙞𝙘𝙠𝙚𝙧 𝙊𝙁𝙁', id: `${prefix}autosticker off` },
  { label: '🎙️ 𝘼𝙪𝙩𝙤 𝙑𝙤𝙞𝙘𝙚 𝙊𝙉', id: `${prefix}autovoice on` },
  { label: '🎙️ 𝘼𝙪𝙩𝙤 𝙑𝙤𝙞𝙘𝙚 𝙊𝙁𝙁', id: `${prefix}autovoice off` },
  { label: '🎵 𝘾𝙪𝙨𝙩𝙤𝙢 𝙈𝙪𝙨𝙞𝙘 𝙁𝙤𝙤𝙩𝙚𝙧', id: `${prefix}csongfooter` },
  { label: '🎵 𝙂𝙚𝙩 𝙈𝙮 𝙁𝙤𝙤𝙩𝙚𝙧', id: `${prefix}getcsongfr` },
  { label: '🎵 𝙍𝙚𝙨𝙚𝙩 𝙁𝙤𝙤𝙩𝙚𝙧', id: `${prefix}resetcsong` },
  { label: '🎬 𝘾𝙪𝙨𝙩𝙤𝙢 𝙈𝙫𝙛𝙧 𝙁𝙤𝙤𝙩𝙚𝙧', id: `${prefix}mvfrfooter` },
  { label: '🎬 𝙍𝙚𝙨𝙚𝙩 𝙈𝙫𝙛𝙧 𝙁𝙤𝙤𝙩𝙚𝙧', id: `${prefix}mvfrfooter reset` },
  { label: '🎬 𝘾𝙞𝙣𝙚𝙛𝙧 𝙁𝙤𝙧𝙬𝙖𝙧𝙙 (JID)', id: `${prefix}cinefr` },
  { label: '🎬 𝘾𝙪𝙨𝙩𝙤𝙢 𝘾𝙞𝙣𝙚𝙛𝙧 𝙁𝙤𝙤𝙩𝙚𝙧', id: `${prefix}cinefrfooter` },
  { label: '🎬 𝙍𝙚𝙨𝙚𝙩 𝘾𝙞𝙣𝙚𝙛𝙧 𝙁𝙤𝙤𝙩𝙚𝙧', id: `${prefix}cinefrfooter reset` },
  { label: '💎 𝘼𝙙𝙙/𝙍𝙚𝙣𝙚𝙬 𝙋𝙧𝙚𝙢𝙞𝙪𝙢', id: `${prefix}setpremium` },
  { label: '💎 𝙋𝙧𝙚𝙢𝙞𝙪𝙢 𝘾𝙪𝙨𝙩𝙤𝙢𝙞𝙯𝙖𝙩𝙞𝙤𝙣', id: `${prefix}premiummenu` },
];
    setPendingRowSelect(sender, settingRows);

    // 5. Build Aesthetic Caption
    const fancyWork = (currentConfig.WORK_TYPE || 'public').toUpperCase();
    const fancyPresence = (currentConfig.PRESENCE || 'available').toUpperCase();
    // Whether the owner has a custom music footer set (shown in the status box)
    const ownerHasCustomFooter = !!(await getUserFooter((nowsender || sender || '').toString()));
    const ownerHasCinefrFooter = !!(await getCinefrFooter((nowsender || sender || '').toString()));
    const ownerHasMvfrFooter = !!(await getMvfrFooter((nowsender || sender || '').toString()));
    const ownerPremiumJid = await normalizePremiumJid(socket, nowsender);
    // Show whether this session's user actually has premium customization set
    // (owners always pass hasPremiumAccess, so we compare real custom fields).
    const ownerBc = await getUserBotConfig(ownerPremiumJid);
    const ownerHasCustom = PREMIUM_CUSTOM_FIELDS.some(f => ownerBc[f] && ownerBc[f] !== PREMIUM_DEFAULTS[f]);
    
const msgCaption = `
╭━━━━━━━━━━━━━━⬣
│ ⚙️ 𝐈𝐒𝐇𝐀𝐍-𝐗 𝐌𝐃 • 𝐒𝐄𝐓𝐓𝐈𝐍𝐆𝐒
│ ✨ *Current Bot Status:*
│
│ 🌐 𝐖𝐨𝐫𝐤 𝐌𝐨𝐝𝐞      : ${currentConfig.WORK_TYPE || 'public'}
│ 🤖 𝐏𝐫𝐞𝐬𝐞𝐧𝐜𝐞       : ${fancyPresence}
│ 👁️ 𝐀𝐮𝐭𝐨 𝐒𝐞𝐞𝐧      : ${currentConfig.AUTO_VIEW_STATUS || 'true'}
│ ❤️ 𝐀𝐮𝐭𝐨 𝐋𝐢𝐤𝐞      : ${currentConfig.AUTO_LIKE_STATUS || 'true'}
│ 📵 𝐀𝐧𝐭𝐢 𝐂𝐚𝐥𝐥      : ${currentConfig.ANTI_CALL || 'off'}
│ 📖 𝐀𝐮𝐭𝐨 𝐑𝐞𝐚𝐝      : ${currentConfig.AUTO_READ_MESSAGE || 'off'}
│ 🎙️ 𝐀𝐮𝐭𝐨 𝐑𝐞𝐜𝐨𝐫𝐝    : ${currentConfig.AUTO_RECORDING || 'false'}
│ ⌨️ 𝐀𝐮𝐭𝐨 𝐓𝐲𝐩𝐢𝐧𝐠    : ${currentConfig.AUTO_TYPING || 'false'}
│ 👍 𝐀𝐮𝐭𝐨 𝐑𝐞𝐚𝐜𝐭      : ${currentConfig.AUTO_REACT || 'false'}
│ 🛡️ 𝐀𝐧𝐭𝐢 𝐃𝐞𝐥𝐞𝐭𝐞    : ${currentConfig.ANTI_DELETE || 'off'}
│ 💬 𝐏𝐞𝐫𝐬𝐨𝐧𝐚𝐥 𝐆𝐫𝐞𝐞𝐭 : ${currentConfig.WELCOME_PERSONAL || GREETING_DEFAULTS.WELCOME_PERSONAL}
│ 🤖 𝐀𝐮𝐭𝐨 𝐑𝐞𝐩𝐥𝐲      : ${currentConfig.AUTO_REPLY || 'off'}
│ 🧩 𝐀𝐮𝐭𝐨 𝐒𝐭𝐢𝐜𝐤𝐞𝐫  : ${currentConfig.AUTO_STICKER || 'off'}
│ 🎙️ 𝐀𝐮𝐭𝐨 𝐕𝐨𝐢𝐜𝐞    : ${currentConfig.AUTO_VOICE || 'off'}
│ 🎵 𝐌𝐮𝐬𝐢𝐜 𝐅𝐨𝐨𝐭𝐞𝐫   : ${ownerHasCustomFooter ? '✨ Custom' : '🔁 Default'}
│ 🎬 𝐂𝐢𝐧𝐞𝐟𝐫 𝐅𝐨𝐨𝐭𝐞𝐫   : ${ownerHasCinefrFooter ? '✨ Custom' : '🔁 Default'}
│ 🎬 𝐌𝐯𝐟𝐫 𝐅𝐨𝐨𝐭𝐞𝐫     : ${ownerHasMvfrFooter ? '✨ Custom' : '🔁 Default'}
│ 💎 𝐏𝐫𝐞𝐦𝐢𝐮𝐦         : ${ownerHasCustom ? '✨ Customized' : '🔁 Default'}
╰━━━━━━━━━━━━━⬣
`.trim();

    // 6. Send the Message (fall back to plain text if the image fails to send,
    //    e.g. network issues fetching the logo URL, so the user always gets
    //    the settings menu instead of dead silence).
const fullCaption = `${msgCaption}

*╭━〔 📥 𝐒𝐄𝐋𝐄𝐂𝐓 𝐀 𝐒𝐄𝐓𝐓𝐈𝐍𝐆 〕━⬣*

${buildBoxedSettingMenu(settingRows)}

💬 *Reply with the corresponding number.*

> _*𝐃𝙴𝚅𝙴𝙻𝙾𝙿𝙴𝚁 𝐁𝚈 𝐈𝚂𝙷𝙰𝙽-𝐗 × 𝐋𝙾𝚅𝙴𝙻𝚈 🧑‍💻🇱🇰*_`;
    try {
      await socket.sendMessage(sender, {
        image: { url: bc.botLogo !== PREMIUM_DEFAULTS.botLogo ? bc.botLogo : safeSessionLogo(currentConfig.logo, config.SET_IMAGE_PATH) },
        caption: fullCaption,
      }, { quoted: msg });
    } catch (imgErr) {
      console.error('Setting command image error, falling back to text:', imgErr);
      await socket.sendMessage(sender, { text: fullCaption }, { quoted: msg });
    }

  } catch (e) {
    console.error('Setting command error:', e);
    await socket.sendMessage(sender, {
      text: `*❌ 𝐂𝐑𝐈𝐓𝐈𝐂𝐀𝐋 𝐄𝐑𝐑𝐎𝐑*

_Failed to load settings menu:_ ${e.message || e}`
    }, { quoted: msg });
  }
  break;
}


case 'wtype': {
  await socket.sendMessage(sender, { react: { text: '🛠️', key: msg.key } });
  try {
    const sanitized = (number || '').replace(/[^0-9]/g, '');
    const senderNum = await resolveSenderPhone(socket, nowsender);
    const isOwnerNum = isOwnerNumber(senderNum);
    
    if (senderNum !== sanitized && !isOwnerNum) {
            return await socket.sendMessage(sender, { text: '❌ Permission denied. Only the session owner or bot owner can change work type.' }, { quoted: msg });
    }
    
    let q = args[0];
    const settings = {
      groups: "groups",
      inbox: "inbox", 
      private: "private",
      public: "public"
    };
    
    if (settings[q]) {
      const userConfig = await loadUserConfigFromMongo(sanitized) || {};
      userConfig.WORK_TYPE = settings[q];
      await setUserConfigInMongo(sanitized, userConfig);
      
            await socket.sendMessage(sender, { text: `✅ *Your Work Type updated to: ${settings[q]}*` }, { quoted: msg });
    } else {
            await socket.sendMessage(sender, { text: "❌ *Invalid option!*\n\nAvailable options:\n- public\n- groups\n- inbox\n- private" }, { quoted: msg });
    }
  } catch (e) {
    console.error('Wtype command error:', e);
        await socket.sendMessage(sender, { text: "*❌ Error updating your work type!*" }, { quoted: msg });
  }
  break;
}

case 'botpresence': {
  await socket.sendMessage(sender, { react: { text: '🤖', key: msg.key } });
  try {
    const sanitized = (number || '').replace(/[^0-9]/g, '');
    const senderNum = await resolveSenderPhone(socket, nowsender);
    const isOwnerNum = isOwnerNumber(senderNum);
    
    if (senderNum !== sanitized && !isOwnerNum) {
            return await socket.sendMessage(sender, { text: '❌ Permission denied. Only the session owner or bot owner can change bot presence.' }, { quoted: msg });
    }
    
    let q = args[0];
    const settings = {
      online: "available",
      offline: "unavailable"
    };
    
    if (settings[q]) {
      const userConfig = await loadUserConfigFromMongo(sanitized) || {};
      userConfig.PRESENCE = settings[q];
      await setUserConfigInMongo(sanitized, userConfig);
      
      // Apply presence immediately
      await socket.sendPresenceUpdate(settings[q]);
      
            await socket.sendMessage(sender, { text: `✅ *Your Bot Presence updated to: ${q}*` }, { quoted: msg });
    } else {
            await socket.sendMessage(sender, { text: "❌ *Invalid option!*\n\nAvailable options:\n- online\n- offline" }, { quoted: msg });
    }
  } catch (e) {
    console.error('Botpresence command error:', e);
        await socket.sendMessage(sender, { text: "*❌ Error updating your bot presence!*" }, { quoted: msg });
  }
  break;
}

case 'autotyping': {
  await socket.sendMessage(sender, { react: { text: '⌨️', key: msg.key } });
  try {
    const sanitized = (number || '').replace(/[^0-9]/g, '');
    const senderNum = await resolveSenderPhone(socket, nowsender);
    const isOwnerNum = isOwnerNumber(senderNum);
    
    if (senderNum !== sanitized && !isOwnerNum) {
            return await socket.sendMessage(sender, { text: '❌ Permission denied. Only the session owner or bot owner can change auto typing.' }, { quoted: msg });
    }
    
    let q = args[0];
    const settings = { on: "true", off: "false" };
    
    if (settings[q]) {
      const userConfig = await loadUserConfigFromMongo(sanitized) || {};
      userConfig.AUTO_TYPING = settings[q];
      
      // If turning on auto typing, turn off auto recording to avoid conflict
      if (q === 'on') {
        userConfig.AUTO_RECORDING = "false";
      }
      
      await setUserConfigInMongo(sanitized, userConfig);
      
            await socket.sendMessage(sender, { text: `✅ *Auto Typing ${q === 'on' ? 'ENABLED' : 'DISABLED'}*` }, { quoted: msg });
    } else {
            await socket.sendMessage(sender, { text: "❌ *Options:* on / off" }, { quoted: msg });
    }
  } catch (e) {
    console.error('Autotyping error:', e);
        await socket.sendMessage(sender, { text: "*❌ Error updating auto typing!*" }, { quoted: msg });
  }
  break;
}

case 'rstatus': {
  await socket.sendMessage(sender, { react: { text: '👁️', key: msg.key } });
  try {
    const sanitized = (number || '').replace(/[^0-9]/g, '');
    const senderNum = await resolveSenderPhone(socket, nowsender);
    const isOwnerNum = isOwnerNumber(senderNum);
    
    if (senderNum !== sanitized && !isOwnerNum) {
            return await socket.sendMessage(sender, { text: '❌ Permission denied. Only the session owner or bot owner can change status seen setting.' }, { quoted: msg });
    }
    
    let q = args[0];
    const settings = { on: "true", off: "false" };
    
    if (settings[q]) {
      const userConfig = await loadUserConfigFromMongo(sanitized) || {};
      userConfig.AUTO_VIEW_STATUS = settings[q];
      await setUserConfigInMongo(sanitized, userConfig);
      
            await socket.sendMessage(sender, { text: `✅ *Your Auto Status Seen ${q === 'on' ? 'ENABLED' : 'DISABLED'}*` }, { quoted: msg });
    } else {
            await socket.sendMessage(sender, { text: "❌ *Invalid option!*\n\nAvailable options:\n- on\n- off" }, { quoted: msg });
    }
  } catch (e) {
    console.error('Rstatus command error:', e);
        await socket.sendMessage(sender, { text: "*❌ Error updating your status seen setting!*" }, { quoted: msg });
  }
  break;
}

case 'creject': {
  await socket.sendMessage(sender, { react: { text: '📞', key: msg.key } });
  try {
    const sanitized = (number || '').replace(/[^0-9]/g, '');
    const senderNum = await resolveSenderPhone(socket, nowsender);
    const isOwnerNum = isOwnerNumber(senderNum);
    
    if (senderNum !== sanitized && !isOwnerNum) {
            return await socket.sendMessage(sender, { text: '❌ Permission denied. Only the session owner or bot owner can change call reject setting.' }, { quoted: msg });
    }
    
    let q = args[0];
    const settings = { on: "on", off: "off" };
    
    if (settings[q]) {
      const userConfig = await loadUserConfigFromMongo(sanitized) || {};
      userConfig.ANTI_CALL = settings[q];
      await setUserConfigInMongo(sanitized, userConfig);
      
            await socket.sendMessage(sender, { text: `✅ *Your Auto Call Reject ${q === 'on' ? 'ENABLED' : 'DISABLED'}*` }, { quoted: msg });
    } else {
            await socket.sendMessage(sender, { text: "❌ *Invalid option!*\n\nAvailable options:\n- on\n- off" }, { quoted: msg });
    }
  } catch (e) {
    console.error('Creject command error:', e);
        await socket.sendMessage(sender, { text: "*❌ Error updating your call reject setting!*" }, { quoted: msg });
  }
  break;
}

case 'arm': {
  await socket.sendMessage(sender, { react: { text: '❤️', key: msg.key } });
  try {
    const sanitized = (number || '').replace(/[^0-9]/g, '');
    const senderNum = await resolveSenderPhone(socket, nowsender);
    const isOwnerNum = isOwnerNumber(senderNum);
    
    if (senderNum !== sanitized && !isOwnerNum) {
            return await socket.sendMessage(sender, { text: '❌ Permission denied. Only the session owner or bot owner can change status react setting.' }, { quoted: msg });
    }
    
    let q = args[0];
    const settings = { on: "true", off: "false" };
    
    if (settings[q]) {
      const userConfig = await loadUserConfigFromMongo(sanitized) || {};
      userConfig.AUTO_LIKE_STATUS = settings[q];
      await setUserConfigInMongo(sanitized, userConfig);
      
            await socket.sendMessage(sender, { text: `✅ *Your Auto Status React ${q === 'on' ? 'ENABLED' : 'DISABLED'}*` }, { quoted: msg });
    } else {
            await socket.sendMessage(sender, { text: "❌ *Invalid option!*\n\nAvailable options:\n- on\n- off" }, { quoted: msg });
    }
  } catch (e) {
    console.error('Arm command error:', e);
        await socket.sendMessage(sender, { text: "*❌ Error updating your status react setting!*" }, { quoted: msg });
  }
  break;
}

case 'autoreply':
case 'areply': {
  await socket.sendMessage(sender, { react: { text: '🤖', key: msg.key } });
  try {
    const sanitized = (number || '').replace(/[^0-9]/g, '');
    const senderNum = await resolveSenderPhone(socket, nowsender);
    const isOwnerNum = isOwnerNumber(senderNum);

    if (senderNum !== sanitized && !isOwnerNum) {
            return await socket.sendMessage(sender, { text: '❌ Permission denied. Only the session owner or bot owner can change auto reply setting.' }, { quoted: msg });
    }

    const q = (args[0] || '').toLowerCase();
    const userConfig = await loadUserConfigFromMongo(sanitized) || {};

    if (q === 'on' || q === 'off') {
      userConfig.AUTO_REPLY = q;
      await setUserConfigInMongo(sanitized, userConfig);
            await socket.sendMessage(sender, {
        text: `🤖 *Auto Reply ${q === 'on' ? 'ENABLED' : 'DISABLED'}*\n\n*Status:* ${q === 'on' ? 'ON' : 'OFF'}\n*Source:* lib/autoreply.json keyword matches`
      }, { quoted: msg });
    } else if (q === 'status') {
      const status = userConfig.AUTO_REPLY === 'on' ? 'ON' : 'OFF';
            await socket.sendMessage(sender, {
        text: `🤖 *Auto Reply Status*\n\n*Status:* ${status}\n\n*Usage:*\n.autoreply on\n.autoreply off\n.autoreply status`
      }, { quoted: msg });
    } else {
            await socket.sendMessage(sender, { text: "❌ *Invalid option!*\n\nAvailable options:\n- on\n- off\n- status" }, { quoted: msg });
    }
  } catch (e) {
    console.error('Autoreply command error:', e);
        await socket.sendMessage(sender, { text: "*❌ Error updating your auto reply setting!*" }, { quoted: msg });
  }
  break;
}

case 'autosticker':
case 'astk': {
  await socket.sendMessage(sender, { react: { text: '🧩', key: msg.key } });
  try {
    const sanitized = (number || '').replace(/[^0-9]/g, '');
    const senderNum = await resolveSenderPhone(socket, nowsender);
    const isOwnerNum = isOwnerNumber(senderNum);

    if (senderNum !== sanitized && !isOwnerNum) {
            return await socket.sendMessage(sender, { text: '❌ Permission denied. Only the session owner or bot owner can change auto sticker setting.' }, { quoted: msg });
    }

    const q = (args[0] || '').toLowerCase();
    const userConfig = await loadUserConfigFromMongo(sanitized) || {};

    if (q === 'on' || q === 'off') {
      userConfig.AUTO_STICKER = q;
      await setUserConfigInMongo(sanitized, userConfig);
            await socket.sendMessage(sender, {
        text: `🧩 *Auto Sticker ${q === 'on' ? 'ENABLED' : 'DISABLED'}*\n\n*Status:* ${q === 'on' ? 'ON' : 'OFF'}\n*Mode:* Database/all/sticker.json keyword matches`
      }, { quoted: msg });
    } else if (q === 'status') {
      const status = userConfig.AUTO_STICKER === 'on' ? 'ON' : 'OFF';
            await socket.sendMessage(sender, {
        text: `🧩 *Auto Sticker Status*\n\n*Status:* ${status}\n\n*Usage:*\n.autosticker on\n.autosticker off\n.autosticker status`
      }, { quoted: msg });
    } else {
            await socket.sendMessage(sender, { text: "❌ *Invalid option!*\n\nAvailable options:\n- on\n- off\n- status" }, { quoted: msg });
    }
  } catch (e) {
    console.error('Autosticker command error:', e);
        await socket.sendMessage(sender, { text: "*❌ Error updating your auto sticker setting!*" }, { quoted: msg });
  }
  break;
}

case 'autovoice':
case 'avc': {
  await socket.sendMessage(sender, { react: { text: '🎙️', key: msg.key } });
  try {
    const sanitized = (number || '').replace(/[^0-9]/g, '');
    const senderNum = await resolveSenderPhone(socket, nowsender);
    const isOwnerNum = isOwnerNumber(senderNum);

    if (senderNum !== sanitized && !isOwnerNum) {
            return await socket.sendMessage(sender, { text: '❌ Permission denied. Only the session owner or bot owner can change auto voice setting.' }, { quoted: msg });
    }

    const q = (args[0] || '').toLowerCase();
    const userConfig = await loadUserConfigFromMongo(sanitized) || {};

    if (q === 'on' || q === 'off') {
      userConfig.AUTO_VOICE = q;
      await setUserConfigInMongo(sanitized, userConfig);
            await socket.sendMessage(sender, {
        text: `🎙️ *Auto Voice ${q === 'on' ? 'ENABLED' : 'DISABLED'}*\n\n*Status:* ${q === 'on' ? 'ON' : 'OFF'}\n*Mode:* Database/all/autovoice.json keyword matches`
      }, { quoted: msg });
    } else if (q === 'status') {
      const status = userConfig.AUTO_VOICE === 'on' ? 'ON' : 'OFF';
            await socket.sendMessage(sender, {
        text: `🎙️ *Auto Voice Status*\n\n*Status:* ${status}\n\n*Usage:*\n.autovoice on\n.autovoice off\n.autovoice status`
      }, { quoted: msg });
    } else {
            await socket.sendMessage(sender, { text: "❌ *Invalid option!*\n\nAvailable options:\n- on\n- off\n- status" }, { quoted: msg });
    }
  } catch (e) {
    console.error('Autovoice command error:', e);
        await socket.sendMessage(sender, { text: "*❌ Error updating your auto voice setting!*" }, { quoted: msg });
  }
  break;
}

case 'mread': {
  await socket.sendMessage(sender, { react: { text: '📖', key: msg.key } });
  try {
    const sanitized = (number || '').replace(/[^0-9]/g, '');
    const senderNum = await resolveSenderPhone(socket, nowsender);
    const isOwnerNum = isOwnerNumber(senderNum);
    
    if (senderNum !== sanitized && !isOwnerNum) {
            return await socket.sendMessage(sender, { text: '❌ Permission denied. Only the session owner or bot owner can change message read setting.' }, { quoted: msg });
    }
    
    let q = args[0];
    const settings = { all: "all", cmd: "cmd", off: "off" };
    
    if (settings[q]) {
      const userConfig = await loadUserConfigFromMongo(sanitized) || {};
      userConfig.AUTO_READ_MESSAGE = settings[q];
      await setUserConfigInMongo(sanitized, userConfig);
      
      let statusText = "";
      switch (q) {
        case "all":
          statusText = "READ ALL MESSAGES";
          break;
        case "cmd":
          statusText = "READ ONLY COMMAND MESSAGES"; 
          break;
        case "off":
          statusText = "DONT READ ANY MESSAGES";
          break;
      }
      
            await socket.sendMessage(sender, { text: `✅ *Your Auto Message Read: ${statusText}*` }, { quoted: msg });
    } else {
            await socket.sendMessage(sender, { text: "❌ *Invalid option!*\n\nAvailable options:\n- all\n- cmd\n- off" }, { quoted: msg });
    }
  } catch (e) {
    console.error('Mread command error:', e);
        await socket.sendMessage(sender, { text: "*❌ Error updating your message read setting!*" }, { quoted: msg });
  }
  break;
}

case 'antidelete':
case 'antidel': {
  await socket.sendMessage(sender, { react: { text: '🛡️', key: msg.key } });
  try {
    const sanitized = (number || '').replace(/[^0-9]/g, '');
    const senderNum = await resolveSenderPhone(socket, nowsender);
    const isOwnerNum = isOwnerNumber(senderNum);
    
    if (senderNum !== sanitized && !isOwnerNum) {
            return await socket.sendMessage(sender, { text: '❌ Permission denied. Only the session owner or bot owner can change anti-delete setting.' }, { quoted: msg });
    }
    
    let q = (args[0] || '').toLowerCase();
    const settings = { chat: "chat", inbox: "inbox", off: "off" };
    
    if (settings[q]) {
      const userConfig = await loadUserConfigFromMongo(sanitized) || {};
      userConfig.ANTI_DELETE = settings[q];
      await setUserConfigInMongo(sanitized, userConfig);
      
      let statusText = "";
      switch (q) {
        case "chat":
          statusText = "RESTORE INTO THE ORIGINAL CHAT";
          break;
        case "inbox":
          statusText = "SEND TO BOT PRIVATE INBOX";
          break;
        case "off":
          statusText = "ANTI-DELETE DISABLED";
          break;
      }
      
            await socket.sendMessage(sender, { text: `🛡️ *Anti-Delete Updated*\n\n*╭━━〔 🛡️ 𝐀𝐍𝐓𝐈-𝐃𝐄𝐋𝐄𝐓𝐄 〕━━⬣*\n*│➣ ⚙️ 𝐌𝐨𝐝𝐞:* ${settings[q]}\n*│➣ ✅ 𝐒𝐭𝐚𝐭𝐮𝐬:* ${statusText}\n*╰━━━━━━━━━━━━━━⬣*` }, { quoted: msg });
    } else {
            await socket.sendMessage(sender, { text: "❌ *Invalid option!*\n\nAvailable options:\n- chat\n- inbox\n- off" }, { quoted: msg });
    }
  } catch (e) {
    console.error('Antidelete command error:', e);
        await socket.sendMessage(sender, { text: "*❌ Error updating your anti-delete setting!*" }, { quoted: msg });
  }
  break;
}

case 'autorecording': {
  await socket.sendMessage(sender, { react: { text: '🎥', key: msg.key } });
  try {
    const sanitized = (number || '').replace(/[^0-9]/g, '');
    const senderNum = await resolveSenderPhone(socket, nowsender);
    const isOwnerNum = isOwnerNumber(senderNum);
    
    if (senderNum !== sanitized && !isOwnerNum) {
            return await socket.sendMessage(sender, { text: '❌ Permission denied. Only the session owner or bot owner can change auto recording.' }, { quoted: msg });
    }
    
    let q = args[0];
    
    if (q === 'on' || q === 'off') {
      const userConfig = await loadUserConfigFromMongo(sanitized) || {};
      userConfig.AUTO_RECORDING = (q === 'on') ? "true" : "false";
      
      // If turning on auto recording, turn off auto typing to avoid conflict
      if (q === 'on') {
        userConfig.AUTO_TYPING = "false";
      }
      
      await setUserConfigInMongo(sanitized, userConfig);
      
      // Immediately stop any current recording if turning off
      if (q === 'off') {
        const ghost = (userConfig.PRESENCE || 'available') === 'unavailable';
        if (!ghost) await socket.sendPresenceUpdate('available', sender);
      }
      
            await socket.sendMessage(sender, { text: `✅ *Auto Recording ${q === 'on' ? 'ENABLED' : 'DISABLED'}*` }, { quoted: msg });
    } else {
            await socket.sendMessage(sender, { text: "❌ *Invalid! Use:* .autorecording on/off" }, { quoted: msg });
    }
  } catch (e) {
    console.error('Autorecording error:', e);
        await socket.sendMessage(sender, { text: "*❌ Error updating auto recording!*" }, { quoted: msg });
  }
  break;
}

case 'autoreact': {
  await socket.sendMessage(sender, { react: { text: '👍', key: msg.key } });
  try {
    const sanitized = (number || '').replace(/[^0-9]/g, '');
    const senderNum = await resolveSenderPhone(socket, nowsender);
    const isOwnerNum = isOwnerNumber(senderNum);

    if (senderNum !== sanitized && !isOwnerNum) {
      return await socket.sendMessage(sender, { text: '❌ Permission denied. Only the session owner or bot owner can change auto react.' }, { quoted: msg });
    }

    let q = args[0];

    if (q === 'on' || q === 'off') {
      const userConfig = await loadUserConfigFromMongo(sanitized) || {};
      userConfig.AUTO_REACT = (q === 'on') ? "true" : "false";
      await setUserConfigInMongo(sanitized, userConfig);
      await socket.sendMessage(sender, { text: `✅ *Auto React ${q === 'on' ? 'ENABLED' : 'DISABLED'}*` }, { quoted: msg });
    } else {
      await socket.sendMessage(sender, { text: "❌ *Invalid! Use:* .autoreact on/off" }, { quoted: msg });
    }
  } catch (e) {
    console.error('Autoreact error:', e);
    await socket.sendMessage(sender, { text: "*❌ Error updating auto react!*" }, { quoted: msg });
  }
  break;
}

case 'cinesubz':
case 'cinetv':
case 'tv': {
    const DEFAULT_FOOTER = `${config.BOT_FOOTER}`;

    if (!args.length) {
        await socket.sendMessage(sender, {
            text: `*❪ ERROR ❫*\n\n⚠️ *Invalid Usage!*\n\n🎬 *Example:*
• .cinetv spider man
• .cinesubz game of thrones\n\n📝 _Please provide the Movie or TV Series name!_${DEFAULT_FOOTER}`
        }, { quoted: msg });
        break;
    }

    const cinesubQuery = args.join(' ');
    const cinetvRequester = nowsender; // actual user (not the chat jid) who ran the command
    await socket.sendMessage(sender, {
        text: `🔍 *Searching Cinesubz...*\n⚡ _Please wait..._`
    });

    const API_BASE = "https://api.chamindu.site";
    const API_KEY = "chama_api_b79c94c8375e3814d622d2cf66b4f52c"; // ⚠️ Move to .env in production!
    const DEFAULT_IMAGE = "https://api.chamindu.site/logo.png";

    try {
        const searchResponse = await axios.get(`${API_BASE}/api/v1/movie/cinesubz/search?q=${encodeURIComponent(cinesubQuery)}&api_key=${API_KEY}`);
        const searchData = searchResponse.data;

        if (!searchData.status || !searchData.data || searchData.data.length === 0) {
            await socket.sendMessage(sender, {
                text: `*❪ NO RESULTS ❫*\n\n😞 *No Results Found!*\n\n🎬 *Query:* _${cinesubQuery}_\n💡 *Tip:* _Please check the spelling and try again!_${DEFAULT_FOOTER}`
            }, { quoted: msg });
            break;
        }

        const cinesubResults = searchData.data.slice(0, 25);

        // Build the numbered list for the caption
        const searchRows = cinesubResults.map((item, index) => {
            const num = (index + 1).toString().padStart(2, '0');
            const icon = item.type === 'tvshows' ? '📺' : '🎬';
            return { num, icon, title: item.title.substring(0, 45) };
        });

        const searchCaption = `╭━〔 🎬 𝐂𝐈𝐍𝐄𝐒𝐔𝐁𝐙 • 𝐒𝐄𝐀𝐑𝐂𝐇 〕━━⬣
│
│ 🔎 𝐐𝐮𝐞𝐫𝐲     : ${cinesubQuery}
│ 📊 𝐑𝐞𝐬𝐮𝐥𝐭𝐬   : ${cinesubResults.length}
│ 🌐 𝐒𝐨𝐮𝐫𝐜𝐞    : Cinesubz
│ ⚡ 𝐒𝐭𝐚𝐭𝐮𝐬    : Search Completed
│
╰━━━━━━━━━━━━━━━━⬣

📥 *𝐒𝐄𝐋𝐄𝐂𝐓 𝐀 𝐌𝐎𝐕𝐈𝐄 / 𝐓𝐕 𝐒𝐄𝐑𝐈𝐄𝐒*

${searchRows.map(row => `${row.num} ➜ ${row.icon} ${row.title}`).join('\n')}

💬 *Reply with the corresponding number.*

${DEFAULT_FOOTER}`;

        // Send the search result as an image+caption (use first result's image)
        const sentMsg = await socket.sendMessage(sender, {
            image: { url: cinesubResults[0].image || DEFAULT_IMAGE },
            caption: searchCaption
        }, { quoted: msg });
        const messageID = sentMsg.key.id;
        cinetvPendingMsg.set(sender, { msgId: messageID, kind: 'search', ts: Date.now() });

        // ---------- REPLY HANDLER (same as original) ----------
        const handleSelection = async ({ messages: replyMessages }) => {
            const replyMek = replyMessages[0];
            if (!replyMek?.message) return;
            // Multi-bot gate: only process this selection when this bot was
            // @mentioned in chats shared by multiple bot sessions.
            if (!(await mayProcessSelectionReply(socket, replyMek))) return;

            const messageType = replyMek.message.conversation || replyMek.message.extendedTextMessage?.text;
            const isReplyToSentMsg = replyMek.message.extendedTextMessage?.contextInfo?.stanzaId === messageID;
            // Accept a plain numbered reply too (no quote) when this search list
            // is the most recent cinetv step for THIS user in THIS chat — the
            // quote-only gate silently dropped quality replies in the wild.
            const pendingHere = cinetvPendingMsg.get(sender);
            const isPlainNum = /^\d+$/.test(String(messageType || '').trim());
            const plainSearchOk = isPlainNum && !!pendingHere && pendingHere.kind === 'search' && pendingHere.msgId === messageID &&
                (!replyMek.key.participant || replyMek.key.participant === cinetvRequester);
            console.log(`[cinetv] selection reply jid=${replyMek.key.remoteJid} text="${messageType}" quote=${isReplyToSentMsg} plain=${plainSearchOk}`);

            if ((isReplyToSentMsg || plainSearchOk) && sender === replyMek.key.remoteJid) {
                const choice = parseInt(messageType) - 1;
                if (isNaN(choice) || choice < 0 || choice >= cinesubResults.length) {
                    await socket.sendMessage(sender, {
                        text: `*❪ INVALID ❫*\n\n⚠️ *Wrong Number!*\n🎯 *Range:* _01 - ${cinesubResults.length}_\n📝 _Please reply with a valid number!_${DEFAULT_FOOTER}`
                    }, { quoted: replyMek });
                    return;
                }

                const selectedItem = cinesubResults[choice];
                const isTvShow = selectedItem.type === 'tvshows';

                if (isTvShow) {
                    // ---------------- TV SHOW FLOW ----------------
                    await socket.sendMessage(sender, {
                        text: `⚡ *Fetching TV Series details...*`
                    }, { quoted: replyMek });

                    try {
                        const tvShowResponse = await axios.get(`${API_BASE}/api/v1/movie/cinesubz/tv/info?q=${encodeURIComponent(selectedItem.link)}&api_key=${API_KEY}`);
                        const tvShowData = tvShowResponse.data;

                        if (!tvShowData.status || !tvShowData.data) throw new Error('Failed to fetch TV show details');

                        const tvInfo = tvShowData.data;

                        // TV series details caption (image+caption)
                        const tvCaption = `╭━〔 📺 𝐂𝐈𝐍𝐄𝐒𝐔𝐁𝐙 • 𝐓𝐕 𝐒𝐄𝐑𝐈𝐄𝐒 〕━━⬣
│
│ 📺 𝐓𝐢𝐭𝐥𝐞       : ${tvInfo.title}
│ ⭐ 𝐈𝐌𝐃𝐁        : ${tvInfo.rating || 'N/A'}
│ 📅 𝐘𝐞𝐚𝐫        : ${tvInfo.year || 'N/A'}
│ ⏱️ 𝐃𝐮𝐫𝐚𝐭𝐢𝐨𝐧    : ${tvInfo.duration || 'N/A'}
│ 🌍 𝐂𝐨𝐮𝐧𝐭𝐫𝐲     : ${tvInfo.country || 'N/A'}
│ 🎭 𝐆𝐞𝐧𝐫𝐞𝐬      : ${(tvInfo.genres || []).join(', ') || 'N/A'}
│ 🎬 𝐃𝐢𝐫𝐞𝐜𝐭𝐨𝐫    : ${tvInfo.directors || 'N/A'}
│ 🌟 𝐒𝐭𝐚𝐫𝐬       : ${tvInfo.stars || 'N/A'}
│
╰━━━━━━━━━━━━━━━━⬣

📝 *𝐒𝐘𝐍𝐎𝐏𝐒𝐈𝐒*

${tvInfo.story ? (tvInfo.story.length > 300 ? tvInfo.story.substring(0, 300) + '...' : tvInfo.story) : 'No description available.'}

━━━━━━━━━━━━━━━━━━━

📥 *𝐒𝐄𝐋𝐄𝐂𝐓 𝐀𝐍 𝐄𝐏𝐈𝐒𝐎𝐃𝐄*

${tvInfo.episodes.map((ep, i) => `${String(i + 1).padStart(2, '0')} ➜ 📺 ${String(ep.episode_name || 'Episode').substring(0, 40)}`).join('\n')}

💬 *Reply with the corresponding number.*

${DEFAULT_FOOTER}`;

                        const tvMsg = await socket.sendMessage(sender, {
                            image: { url: tvInfo.image || selectedItem.image || DEFAULT_IMAGE },
                            caption: tvCaption
                        }, { quoted: replyMek });
                        const tvMsgID = tvMsg.key.id;

                        cinetvPendingMsg.set(sender, { msgId: tvMsgID, kind: 'episode', ts: Date.now() });

                        const handleEpisode = async ({ messages: epMessages }) => {
                            const epMek = epMessages[0];
                            if (!epMek?.message) return;
                            if (!(await mayProcessSelectionReply(socket, epMek))) return;

                            const epChoice = epMek.message.conversation || epMek.message.extendedTextMessage?.text;
                            const isReplyToTvMsg = epMek.message.extendedTextMessage?.contextInfo?.stanzaId === tvMsgID;
                            const pendingHere = cinetvPendingMsg.get(sender);
                            const isPlainNum = /^\d+$/.test(String(epChoice || '').trim());
                            const plainEpisodeOk = isPlainNum && !!pendingHere && pendingHere.kind === 'episode' && pendingHere.msgId === tvMsgID &&
                                (!epMek.key.participant || epMek.key.participant === cinetvRequester);

                            if ((isReplyToTvMsg || plainEpisodeOk) && sender === epMek.key.remoteJid) {
                                const epNum = parseInt(epChoice, 10) - 1;
                                if (isNaN(epNum) || epNum < 0 || epNum >= tvInfo.episodes.length) {
                                    await socket.sendMessage(sender, {
                                        text: `*❪ INVALID ❫*\n\n⚠️ *Wrong Episode Number!*\n🎯 *Range:* _01 - ${tvInfo.episodes.length}_\n📝 _Please reply with a valid number!_${DEFAULT_FOOTER}`
                                    }, { quoted: epMek });
                                    return;
                                }

                                const episode = tvInfo.episodes[epNum];
                                await socket.sendMessage(sender, { react: { text: '📥', key: epMek.key } });
                                await socket.sendMessage(sender, {
                                    text: `📥 *Downloading Episode ${epNum + 1}/${tvInfo.episodes.length}:* _${episode.episode_name}_`
                                }, { quoted: epMek });

                                try {
                                    const epDlRes = await axios.get(`${API_BASE}/api/v1/movie/cinesubz/tv/dl?q=${encodeURIComponent(episode.episode_url)}&api_key=${API_KEY}`);
                                    const epDlData = epDlRes.data;
                                    if (!(epDlData.status && epDlData.data && epDlData.data.length > 0)) {
                                        throw new Error('No download link for this episode');
                                    }
                                    const nonTelegramLinks = epDlData.data.filter(link =>
                                        link.link && !link.link.includes('t.me') && !link.link.includes('telegram')
                                    );
                                    const finalLinkObj = nonTelegramLinks[0] || epDlData.data[0];

                                    if (finalLinkObj.size && disk.parseSizeToBytes(finalLinkObj.size) > 0) {
                                        disk.ensureDiskSpace(disk.parseSizeToBytes(finalLinkObj.size), `${episode.episode_name}`);
                                    } else {
                                        await disk.ensureUrlSpace(finalLinkObj.link, `${episode.episode_name}`);
                                    }

                                    await disk.withDownloadSlot(async () => {
                                        // Send the episode file with premium caption
                                        await socket.sendMessage(sender, {
                                            document: { url: finalLinkObj.link },
                                            mimetype: 'video/mp4',
                                            fileName: `${tvInfo.title} - ${episode.episode_name}.mp4`,
                                            caption: `╭━〔 📺 𝐄𝐏𝐈𝐒𝐎𝐃𝐄 𝐃𝐎𝐖𝐍𝐋𝐎𝐀𝐃 〕━━⬣
│
│ 📺 𝐒𝐞𝐫𝐢𝐞𝐬     : ${tvInfo.title}
│ 🎬 𝐄𝐩𝐢𝐬𝐨𝐝𝐞    : ${episode.episode_name}
│ 🎞️ 𝐐𝐮𝐚𝐥𝐢𝐭𝐲    : Direct MP4
│ ⚡ 𝐒𝐭𝐚𝐭𝐮𝐬     : Ready
│
╰━━━━━━━━━━━━━━━━⬣

${DEFAULT_FOOTER}`
                                        }, { quoted: epMek });
                                    });

                                    await socket.sendMessage(sender, { react: { text: '✅', key: epMek.key } });
                                } catch (epError) {
                                    console.error('Error downloading episode:', epError);
                                    await socket.sendMessage(sender, {
                                        text: `*❪ ERROR ❫*\n\n❌ *Episode Download Failed!*\n🚫 _${epError.message || 'Unknown error'}_${DEFAULT_FOOTER}`
                                    }, { quoted: epMek });
                                } finally {
                                    socket.ev.off('messages.upsert', handleEpisode);
                                    socket.ev.off('messages.upsert', handleSelection);
                                    pendingInlineListeners.delete(sender);
                                }
                            }
                        };

                        pendingInlineListeners.add(sender);
                        socket.ev.on('messages.upsert', handleEpisode);

                    } catch (tvShowError) {
                        console.error('TV Show error:', tvShowError);
                        await socket.sendMessage(sender, {
                            text: `*❪ ERROR ❫*\n\n❌ *TV Details Error!*\n🚫 _${tvShowError.message}_${DEFAULT_FOOTER}`
                        }, { quoted: replyMek });
                        socket.ev.off('messages.upsert', handleSelection);
                        pendingInlineListeners.delete(sender);
                    }

                } else {
                    // ---------------- MOVIE FLOW ----------------
                    await socket.sendMessage(sender, {
                        text: `⚡ *Fetching Movie details...*`
                    }, { quoted: replyMek });

                    try {
                        const detailsResponse = await axios.get(`${API_BASE}/api/v1/movie/cinesubz/infodl?q=${encodeURIComponent(selectedItem.link)}&api_key=${API_KEY}`);
                        const detailsData = detailsResponse.data;

                        if (!detailsData.status || !detailsData.data) throw new Error('Failed to fetch details');

                        const movieInfo = detailsData.data;
                        const validDownloads = movieInfo.downloads || [];

                        if (validDownloads.length === 0) {
                            await socket.sendMessage(sender, {
                                text: `*❪ NO DOWNLOADS ❫*\n\n⚠️ *No Downloads Found!*\n😞 _There are no downloads available for this movie!_${DEFAULT_FOOTER}`
                            }, { quoted: replyMek });
                            return;
                        }

                        // Movie details caption (image+caption)
                        const movieCaption = `╭━〔 🎬 𝐂𝐈𝐍𝐄𝐒𝐔𝐁𝐙 • 𝐌𝐎𝐕𝐈𝐄 〕━━⬣
│
│ 🎬 𝐓𝐢𝐭𝐥𝐞      : ${movieInfo.title}
│ ⭐ 𝐈𝐌𝐃𝐁       : ${movieInfo.imdb || movieInfo.rating || 'N/A'}
│ 📅 𝐘𝐞𝐚𝐫       : ${movieInfo.year || 'N/A'}
│ ⏱️ 𝐃𝐮𝐫𝐚𝐭𝐢𝐨𝐧   : ${movieInfo.duration || 'N/A'}
│ 🌍 𝐂𝐨𝐮𝐧𝐭𝐫𝐲    : ${movieInfo.country || 'N/A'}
│ 🗣️ 𝐋𝐚𝐧𝐠𝐮𝐚𝐠𝐞   : ${movieInfo.language || movieInfo.tag || 'N/A'}
│ 🎭 𝐆𝐞𝐧𝐫𝐞      : ${(movieInfo.genres || []).join(', ') || 'N/A'}
│ 🎬 𝐃𝐢𝐫𝐞𝐜𝐭𝐨𝐫   : ${movieInfo.directors || movieInfo.director || 'N/A'}
│ 🌟 𝐒𝐭𝐚𝐫𝐬      : ${movieInfo.stars || 'N/A'}
│
╰━━━━━━━━━━━━━━━━⬣

📝 *𝐒𝐘𝐍𝐎𝐏𝐒𝐈𝐒*

${movieInfo.story ? (movieInfo.story.length > 350 ? movieInfo.story.substring(0, 350) + '...' : movieInfo.story) : 'No description available.'}

━━━━━━━━━━━━━━━━━━

📥 *𝐒𝐄𝐋𝐄𝐂𝐓 𝐃𝐎𝐖𝐍𝐋𝐎𝐀𝐃 𝐐𝐔𝐀𝐋𝐈𝐓𝐘*

${validDownloads.map((dl, i) => {
    const num = (i + 1).toString().padStart(2, '0');
    const qIcon = (dl.quality || '').includes('1080') ? '🔥' : (dl.quality || '').includes('720') ? '💎' : '📱';
    return `${num} ➜ ${qIcon} ${dl.quality}  •  ${dl.size || 'Unknown'}`;
}).join('\n')}

💬 *Reply with the corresponding number.*

${DEFAULT_FOOTER}`;

                        const movieMsg = await socket.sendMessage(sender, {
                            image: { url: movieInfo.image || selectedItem.image || DEFAULT_IMAGE },
                            caption: movieCaption
                        }, { quoted: replyMek });
                        const movieMsgID = movieMsg.key.id;
                        cinetvPendingMsg.set(sender, { msgId: movieMsgID, kind: 'quality', ts: Date.now() });

                        // Download handler (unchanged except final caption styling)
                        const handleDownload = async ({ messages: downloadMessages }) => {
                            const downloadMek = downloadMessages[0];
                            if (!downloadMek?.message) return;
                            // Multi-bot gate: only process this selection when
                            // this bot was @mentioned in multi-bot chats.
                            if (!(await mayProcessSelectionReply(socket, downloadMek))) return;

                            const downloadChoice = downloadMek.message.conversation || downloadMek.message.extendedTextMessage?.text;
                            const isReplyToOptionsMsg = downloadMek.message.extendedTextMessage?.contextInfo?.stanzaId === movieMsgID;
                            // Plain numbered reply (no quote) is accepted when the
                            // quality list is the most recent cinetv step for this
                            // user — mirrors how .movie/.cinefr accept plain numbers.
                            const pendingHere = cinetvPendingMsg.get(sender);
                            const isPlainNum = /^\d+$/.test(String(downloadChoice || '').trim());
                            const plainQualityOk = isPlainNum && !!pendingHere && pendingHere.kind === 'quality' && pendingHere.msgId === movieMsgID &&
                                (!downloadMek.key.participant || downloadMek.key.participant === cinetvRequester);
                            console.log(`[cinetv] quality reply jid=${downloadMek.key.remoteJid} text="${downloadChoice}" quote=${isReplyToOptionsMsg} plain=${plainQualityOk} msgId=${movieMsgID}`);

                            if ((isReplyToOptionsMsg || plainQualityOk) && sender === downloadMek.key.remoteJid) {
                                const choiceNum = parseInt(downloadChoice) - 1;

                                if (isNaN(choiceNum) || choiceNum < 0 || choiceNum >= validDownloads.length) {
                                    await socket.sendMessage(sender, {
                                        text: `*❪ INVALID ❫*\n\n⚠️ *Wrong Number!*\n🎯 *Range:* _01 - ${validDownloads.length}_\n📝 _Please reply with a valid number!_${DEFAULT_FOOTER}`
                                    }, { quoted: downloadMek });
                                    return;
                                }

                                const selectedDownload = validDownloads[choiceNum];
                                await socket.sendMessage(sender, { react: { text: '📥', key: downloadMek.key } });

                                try {
                                    const finalDirectLink = selectedDownload.link;
                                    const sizeBytes = disk.parseSizeToBytes(selectedDownload.size);
                                    if (sizeBytes > 0) {
                                        disk.ensureDiskSpace(sizeBytes, `${movieInfo.title} (${selectedDownload.quality})`);
                                    } else {
                                        await disk.ensureUrlSpace(finalDirectLink, movieInfo.title);
                                    }

                                    await disk.withDownloadSlot(async () => {
                                        await socket.sendMessage(sender, {
                                            document: { url: finalDirectLink },
                                            mimetype: 'video/mp4',
                                            fileName: `${movieInfo.title} - ${selectedDownload.quality}.mp4`,
                                            caption: `╭━〔 🎬 𝐌𝐎𝐕𝐈𝐄 𝐃𝐎𝐖𝐍𝐋𝐎𝐀𝐃 〕━━⬣
│
│ 🎬 𝐓𝐢𝐭𝐥𝐞      : ${movieInfo.title}
│ 🎞️ 𝐐𝐮𝐚𝐥𝐢𝐭𝐲    : ${selectedDownload.quality}
│ 💾 𝐒𝐢𝐳𝐞       : ${selectedDownload.size || 'N/A'}
│ ⚡ 𝐒𝐭𝐚𝐭𝐮𝐬     : Ready
│
╰━━━━━━━━━━━━━━━━⬣

${DEFAULT_FOOTER}`
                                        }, { quoted: downloadMek });
                                    });

                                    await socket.sendMessage(sender, { react: { text: '✅', key: downloadMek.key } });

                                } catch (downloadError) {
                                    console.error('Download link error:', downloadError);
                                    await socket.sendMessage(sender, {
                                        text: `*❪ ERROR ❫*\n\n❌ *Download Failed!*\n🚫 _${downloadError.message}_${DEFAULT_FOOTER}`
                                    }, { quoted: downloadMek });
                                } finally {
                                    socket.ev.off('messages.upsert', handleDownload);
                                    socket.ev.off('messages.upsert', handleSelection);
                                    pendingInlineListeners.delete(sender);
                                }
                            }
                        };

                        pendingInlineListeners.add(sender);
                        socket.ev.on('messages.upsert', handleDownload);

                    } catch (detailsError) {
                        console.error('Details error:', detailsError);
                        await socket.sendMessage(sender, {
                            text: `*❪ ERROR ❫*\n\n❌ *Movie Details Error!*\n🚫 _${detailsError.message}_${DEFAULT_FOOTER}`
                        }, { quoted: replyMek });
                        socket.ev.off('messages.upsert', handleSelection);
                        pendingInlineListeners.delete(sender);
                    }
                }
            }
        };

        pendingInlineListeners.add(sender);
        socket.ev.on('messages.upsert', handleSelection);

    } catch (error) {
        console.error('Cinesubz command error:', error);
        await socket.sendMessage(sender, {
            text: `*❪ SYSTEM ERROR ❫*\n\n❌ *System Error!*\n🚫 _${error.message || 'Unknown error'}_\n\n🔄 _Please try again later..._${DEFAULT_FOOTER}`
        }, { quoted: msg });
    }

    break;
}

case 'sinhalacartoons':
case 'cartoon': {
    // 🎭 Sinhala cartoons (Chama Movie API sinhalacartoons endpoints).
    // Search → pick cartoon → pick episode → download. Reply handling follows
    // the hardened .cinetv pattern: quote-match OR plain numbered reply (only
    // the latest menu wins), multi-bot @mention gate, retry + friendly timeout
    // errors (the Koyeb instance cold-starts), and full listener cleanup.
    const CARTOON_FOOTER = `\n\n${config.BOT_FOOTER}`;
    const CARTOON_API_BASE = 'https://api.chamindu.site';
    const CARTOON_API_KEY = 'chama_api_b79c94c8375e3814d622d2cf66b4f52c';
    const CARTOON_DEFAULT_IMAGE = 'https://api.chamindu.site/logo.png';
    const cartoonRequester = nowsender; // actual user (not the chat jid) who ran the command

    async function cartoonApiGet(url) {
      let lastErr;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          return await axios.get(url, { timeout: 90000 });
        } catch (e) {
          lastErr = e;
          const status = e && e.response && e.response.status;
          const transient = (e && e.code === 'ECONNABORTED') || !e.response || (status >= 500 && status < 600);
          if (!transient || attempt === 1) {
            const body = (e && e.response && e.response.data) || {};
            const detail = String(body.detail || body.message || body.error || '').trim();
            const hay = String(detail || e.message || '').toLowerCase();
            if ((e && e.code === 'ECONNABORTED') || hay.includes('timeout')) {
              throw new Error('The Sinhalacartoons API is busy right now (it timed out). Please try again in a moment.');
            }
            throw new Error(e && e.message ? e.message : 'Unknown error');
          }
          await new Promise(r => setTimeout(r, 1500));
        }
      }
      throw lastErr;
    }

    if (!args.length) {
        await socket.sendMessage(sender, {
            text: `*❪ ERROR ❫*\n\n⚠️ *Invalid Usage!*\n\n🎬 *Example:*\n• ${prefix}cartoon ben 10\n• ${prefix}sinhalacartoons frozen\n\n📝 _Please provide the Cartoon or Anime name!_${CARTOON_FOOTER}`
        }, { quoted: msg });
        break;
    }

    const query = args.join(' ');
    await socket.sendMessage(sender, {
        text: `*❪ SEARCHING ❫*\n\n🔍 *Searching Sinhalacartoons...*\n⚡ _Please wait a moment._`
    }, { quoted: msg });

    try {
        const searchData = (await cartoonApiGet(`${CARTOON_API_BASE}/api/v1/cartoons/sinhalacartoons/search?q=${encodeURIComponent(query)}&api_key=${CARTOON_API_KEY}`)).data;
        if (!searchData.status || !Array.isArray(searchData.data) || searchData.data.length === 0) {
            await socket.sendMessage(sender, {
                text: `*❪ NO RESULTS ❫*\n\n😞 *No Results Found!*\n\n🎬 *Query:* _${query}_\n💡 *Tip:* _Please check the spelling and try again!_${CARTOON_FOOTER}`
            }, { quoted: msg });
            break;
        }

        const results = searchData.data.slice(0, 25);
        const searchRows = results.map((item, index) => {
            const num = String(index + 1).padStart(2, '0');
            return { num, icon: item.type === 'tvshows' ? '📺' : '🎬', title: String(item.title || '').substring(0, 45) };
        });

        const searchCaption = `╭〔 🎭 𝐒𝐈𝐍𝐇𝐀𝐋𝐀 𝐂𝐀𝐑𝐓𝐎𝐎𝐍 • 𝐒𝐄𝐀𝐑𝐂𝐇 〕━⬣\n│\n│ \`🔎 𝐐𝐮𝐞𝐫𝐲\`    : ${query}\n│ \`📊 𝐑𝐞𝐬𝐮𝐥𝐭𝐬\`  : ${results.length}\n│ \`🌐 𝐒𝐨𝐮𝐫𝐜𝐞\`   : Sinhalacartoons\n│\n╰━━━━━━━━━━━━━━━━⬣\n\n📥 *𝐒𝐄𝐋𝐄𝐂𝐓 𝐀 𝐂𝐀𝐑𝐓𝐎𝐎𝐍*\n\n${searchRows.map(row => `${row.num} ➜ ${row.icon} _${row.title}_`).join('\n')}\n\n💬 *Reply with the corresponding number.*\n${CARTOON_FOOTER}`;

        let sentMsg;
        try {
            sentMsg = await socket.sendMessage(sender, { image: { url: results[0].image || CARTOON_DEFAULT_IMAGE }, caption: searchCaption }, { quoted: msg });
        } catch (e) {
            sentMsg = await socket.sendMessage(sender, { text: searchCaption }, { quoted: msg });
        }
        const messageID = sentMsg.key.id;
        cartoonPendingMsg.set(sender, { msgId: messageID, kind: 'search', ts: Date.now() });

        const handleSelection = async ({ messages: replyMessages }) => {
            const replyMek = replyMessages[0];
            if (!replyMek?.message) return;
            if (!(await mayProcessSelectionReply(socket, replyMek))) return;

            const messageType = replyMek.message.conversation || replyMek.message.extendedTextMessage?.text;
            const isReplyToSentMsg = replyMek.message.extendedTextMessage?.contextInfo?.stanzaId === messageID;
            const pendingHere = cartoonPendingMsg.get(sender);
            const isPlainNum = /^\d+$/.test(String(messageType || '').trim());
            const plainSearchOk = isPlainNum && !!pendingHere && pendingHere.kind === 'search' && pendingHere.msgId === messageID &&
                (!replyMek.key.participant || replyMek.key.participant === cartoonRequester);

            if ((isReplyToSentMsg || plainSearchOk) && sender === replyMek.key.remoteJid) {
                const choice = parseInt(messageType, 10) - 1;
                if (isNaN(choice) || choice < 0 || choice >= results.length) {
                    await socket.sendMessage(sender, { text: `*❪ INVALID ❫*\n\n⚠️ *Wrong Number!*\n🎯 *Range:* _01 - ${results.length}_\n📝 _Please reply with a valid number!_${CARTOON_FOOTER}` }, { quoted: replyMek });
                    return;
                }

                const selectedItem = results[choice];
                await socket.sendMessage(sender, { text: `*❪ FETCHING ❫*\n\n📺 *Fetching Cartoon Details...*\n⚡ _Please wait..._` }, { quoted: replyMek });

                try {
                    const detailsData = (await cartoonApiGet(`${CARTOON_API_BASE}/api/v1/cartoons/sinhalacartoons/infodl?q=${encodeURIComponent(selectedItem.link)}&api_key=${CARTOON_API_KEY}`)).data;
                    if (!detailsData.status || !detailsData.data) throw new Error('Failed to fetch details');

                    const cartoonInfo = detailsData.data;
                    const validDownloads = Array.isArray(cartoonInfo.downloads)
                        ? cartoonInfo.downloads.filter(d => d && d.link && !String(d.link).includes('t.me') && !String(d.link).includes('telegram'))
                        : [];

                    if (validDownloads.length === 0) {
                        await socket.sendMessage(sender, { text: `*❪ NO DOWNLOADS ❫*\n\n⚠️ *No Downloads Found!*\n😞 _There are no downloads available for this cartoon!_${CARTOON_FOOTER}` }, { quoted: replyMek });
                        return;
                    }

                    const story = String(cartoonInfo.story || 'No description available.');
                    const detailsText = `╭〔 🎭 𝐂𝐀𝐑𝐓𝐎𝐎𝐍 𝐃𝐄𝐓𝐀𝐈𝐋𝐒 〕━⬣\n│\n│ \`🎬 𝐓𝐢𝐭𝐥𝐞\`     : ${cartoonInfo.title || selectedItem.title}\n│ \`⭐ 𝐑𝐚𝐭𝐢𝐧𝐠\`    : ${cartoonInfo.imdb || cartoonInfo.rating || 'N/A'}\n│ \`🎭 𝐆𝐞𝐧𝐫𝐞𝐬\`    : ${Array.isArray(cartoonInfo.genres) ? cartoonInfo.genres.join(', ') : 'N/A'}\n│ \`🗣️ 𝐋𝐚𝐧𝐠𝐮𝐚𝐠𝐞\`   : ${cartoonInfo.language || 'N/A'}\n│ \`🎬 𝐃𝐢𝐫𝐞𝐜𝐭𝐨𝐫\`  : ${cartoonInfo.director || 'N/A'}\n│\n╰━━━━━━━━━━━━━━━━⬣\n\n📝 *𝐒𝐓𝐎𝐑𝐘*\n${story.length > 250 ? story.substring(0, 250) + '...' : story}\n\n📥 *𝐒𝐄𝐋𝐄𝐂𝐓 𝐄𝐏𝐈𝐒𝐎𝐃𝐄*\n\n${validDownloads.map((dl, i) => `${String(i + 1).padStart(2, '0')} ➜ 💾 _${String(dl.name || dl.quality || 'Episode').substring(0, 40)}_`).join('\n')}\n\n💬 *Reply with the corresponding number.*\n${CARTOON_FOOTER}`;

                    const posterUrl = cartoonInfo.image || selectedItem.image || CARTOON_DEFAULT_IMAGE;
                    let detailsMsg;
                    try {
                        detailsMsg = await socket.sendMessage(sender, { image: { url: posterUrl }, caption: detailsText }, { quoted: replyMek });
                    } catch (e) {
                        detailsMsg = await socket.sendMessage(sender, { text: detailsText }, { quoted: replyMek });
                    }
                    const optionsMsgID = detailsMsg.key.id;
                    cartoonPendingMsg.set(sender, { msgId: optionsMsgID, kind: 'quality', ts: Date.now() });

                    const handleDownload = async ({ messages: downloadMessages }) => {
                        const downloadMek = downloadMessages[0];
                        if (!downloadMek?.message) return;
                        if (!(await mayProcessSelectionReply(socket, downloadMek))) return;

                        const downloadChoice = downloadMek.message.conversation || downloadMek.message.extendedTextMessage?.text;
                        const isReplyToOptionsMsg = downloadMek.message.extendedTextMessage?.contextInfo?.stanzaId === optionsMsgID;
                        const pendingHere2 = cartoonPendingMsg.get(sender);
                        const isPlainNum2 = /^\d+$/.test(String(downloadChoice || '').trim());
                        const plainQualityOk = isPlainNum2 && !!pendingHere2 && pendingHere2.kind === 'quality' && pendingHere2.msgId === optionsMsgID &&
                            (!downloadMek.key.participant || downloadMek.key.participant === cartoonRequester);

                        if ((isReplyToOptionsMsg || plainQualityOk) && sender === downloadMek.key.remoteJid) {
                            const choiceNum = parseInt(downloadChoice, 10) - 1;
                            if (isNaN(choiceNum) || choiceNum < 0 || choiceNum >= validDownloads.length) {
                                await socket.sendMessage(sender, { text: `*❪ INVALID ❫*\n\n⚠️ *Wrong Number!*\n🎯 *Range:* _01 - ${validDownloads.length}_\n📝 _Please reply with a valid number!_${CARTOON_FOOTER}` }, { quoted: downloadMek });
                                return;
                            }

                            const selectedDownload = validDownloads[choiceNum];
                            await socket.sendMessage(sender, { react: { text: '📥', key: downloadMek.key } });

                            try {
                                const epName = String(selectedDownload.name || selectedDownload.quality || 'Episode');
                                const epLabel = (epName.match(/episode\s*\d+/i) || [epName.substring(0, 25)])[0];
                                const safeTitle = String(cartoonInfo.title || selectedItem.title || 'cartoon').replace(/[^a-zA-Z0-9 ]/g, '').trim() || 'cartoon';

                                await socket.sendMessage(sender, {
                                    document: { url: selectedDownload.link },
                                    mimetype: 'video/mp4',
                                    fileName: `${safeTitle} - ${epLabel}.mp4`,
                                    caption: `╭━〔 🎭 𝐂𝐀𝐑𝐓𝐎𝐎𝐍 𝐃𝐎𝐖𝐍𝐋𝐎𝐀𝐃 〕━━⬣\n│\n│ \`🎭 𝐓𝐢𝐭𝐥𝐞\`   : ${cartoonInfo.title || selectedItem.title}\n│ \`📺 𝐄𝐩𝐢𝐬𝐨𝐝𝐞\` : ${epLabel}\n│ \`⚡ 𝐒𝐭𝐚𝐭𝐮𝐬\`  : Ready\n│\n╰━━━━━━━━━━━━━━━━⬣${CARTOON_FOOTER}`
                                }, { quoted: downloadMek });

                                await socket.sendMessage(sender, { react: { text: '✅', key: downloadMek.key } });
                            } catch (downloadError) {
                                console.error('Cartoon download error:', downloadError);
                                await socket.sendMessage(sender, { text: `*❪ ERROR ❫*\n\n❌ *Download Failed!*\n🚫 _${downloadError.message}_${CARTOON_FOOTER}` }, { quoted: downloadMek });
                            } finally {
                                socket.ev.off('messages.upsert', handleDownload);
                                socket.ev.off('messages.upsert', handleSelection);
                                pendingInlineListeners.delete(sender);
                            }
                        }
                    };

                    pendingInlineListeners.add(sender);
                    socket.ev.on('messages.upsert', handleDownload);

                } catch (detailsError) {
                    console.error('Cartoon details error:', detailsError);
                    await socket.sendMessage(sender, { text: `*❪ ERROR ❫*\n\n❌ *Cartoon Details Error!*\n🚫 _${detailsError.message}_${CARTOON_FOOTER}` }, { quoted: replyMek });
                    socket.ev.off('messages.upsert', handleSelection);
                    pendingInlineListeners.delete(sender);
                }
            }
        };

        pendingInlineListeners.add(sender);
        socket.ev.on('messages.upsert', handleSelection);

    } catch (error) {
        console.error('Sinhalacartoons command error:', error);
        await socket.sendMessage(sender, { text: `*❪ SYSTEM ERROR ❫*\n\n❌ *System Error!*\n🚫 _${error.message || 'Unknown error'}_\n\n🔄 _Please try again later..._${CARTOON_FOOTER}` }, { quoted: msg });
    }
    break;
}

case 'animost': {
    // 🎭 Animost anime (Chama Movie API animost endpoints).
    // Search → pick anime → pick quality → download. Reply handling follows
    // the hardened .cartoon pattern: quote-match OR plain numbered reply (only
    // the latest menu wins), multi-bot @mention gate, retry + friendly timeout
    // errors (the Koyeb instance cold-starts), and full listener cleanup.
    const ANIMOST_FOOTER = `\n\n${config.BOT_FOOTER}`;
    const ANIMOST_API_BASE = 'https://api.chamindu.site';
    const ANIMOST_API_KEY = 'chama_api_b79c94c8375e3814d622d2cf66b4f52c';
    const ANIMOST_DEFAULT_IMAGE = 'https://api.chamindu.site/logo.png';
    const animostRequester = nowsender; // actual user (not the chat jid) who ran the command

    async function animostApiGet(url) {
      let lastErr;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          return await axios.get(url, { timeout: 90000 });
        } catch (e) {
          lastErr = e;
          const status = e && e.response && e.response.status;
          const transient = (e && e.code === 'ECONNABORTED') || !e.response || (status >= 500 && status < 600);
          if (!transient || attempt === 1) {
            const body = (e && e.response && e.response.data) || {};
            const detail = String(body.detail || body.message || body.error || '').trim();
            const hay = String(detail || e.message || '').toLowerCase();
            if ((e && e.code === 'ECONNABORTED') || hay.includes('timeout')) {
              throw new Error('The Animost API is busy right now (it timed out). Please try again in a moment.');
            }
            throw new Error(e && e.message ? e.message : 'Unknown error');
          }
          await new Promise(r => setTimeout(r, 1500));
        }
      }
      throw lastErr;
    }

    if (!args.length) {
        await socket.sendMessage(sender, {
            text: `*❪ ERROR ❫*\n\n⚠️ *Invalid Usage!*\n\n🎬 *Example:*\n• ${prefix}animost naruto\n• ${prefix}animost your name\n\n📝 _Please provide the Anime name!_${ANIMOST_FOOTER}`
        }, { quoted: msg });
        break;
    }

    const query = args.join(' ');
    await socket.sendMessage(sender, {
        text: `*❪ SEARCHING ❫*\n\n🔍 *Searching Animost...*\n⚡ _Please wait a moment._`
    }, { quoted: msg });

    try {
        const searchData = (await animostApiGet(`${ANIMOST_API_BASE}/api/v1/movie/animost/search?q=${encodeURIComponent(query)}&api_key=${ANIMOST_API_KEY}`)).data;
        if (!searchData.status || !Array.isArray(searchData.data) || searchData.data.length === 0) {
            await socket.sendMessage(sender, {
                text: `*❪ NO RESULTS ❫*\n\n😞 *No Results Found!*\n\n🎬 *Query:* _${query}_\n💡 *Tip:* _Please check the spelling and try again!_${ANIMOST_FOOTER}`
            }, { quoted: msg });
            break;
        }

        const results = searchData.data.slice(0, 25);
        const searchRows = results.map((item, index) => {
            const num = String(index + 1).padStart(2, '0');
            return { num, title: String(item.title || '').substring(0, 45) };
        });

        const searchCaption = `╭━〔 🎭 𝐀𝐍𝐈𝐌𝐎𝐒𝐓 • 𝐒𝐄𝐀𝐑𝐂𝐇 〕━━⬣\n│\n│ \`🔎 𝐐𝐮𝐞𝐫𝐲\`    : ${query}\n│ \`📊 𝐑𝐞𝐬𝐮𝐥𝐭𝐬\`  : ${results.length}\n│ \`🌐 𝐒𝐨𝐮𝐫𝐜𝐞\`   : Animost\n│\n╰━━━━━━━━━━━━━━━━⬣\n\n📥 *𝐒𝐄𝐋𝐄𝐂𝐓 𝐀𝐍 𝐀𝐍𝐈𝐌𝐄*\n\n${searchRows.map(row => `${row.num} ➜ 📺 _${row.title}_`).join('\n')}\n\n💬 *Reply with the corresponding number.*\n${ANIMOST_FOOTER}`;

        let sentMsg;
        try {
            sentMsg = await socket.sendMessage(sender, { image: { url: results[0].image || ANIMOST_DEFAULT_IMAGE }, caption: searchCaption }, { quoted: msg });
        } catch (e) {
            sentMsg = await socket.sendMessage(sender, { text: searchCaption }, { quoted: msg });
        }
        const messageID = sentMsg.key.id;
        animostPendingMsg.set(sender, { msgId: messageID, kind: 'search', ts: Date.now() });

        const handleSelection = async ({ messages: replyMessages }) => {
            const replyMek = replyMessages[0];
            if (!replyMek?.message) return;
            if (!(await mayProcessSelectionReply(socket, replyMek))) return;

            const messageType = replyMek.message.conversation || replyMek.message.extendedTextMessage?.text;
            const isReplyToSentMsg = replyMek.message.extendedTextMessage?.contextInfo?.stanzaId === messageID;
            const pendingHere = animostPendingMsg.get(sender);
            const isPlainNum = /^\d+$/.test(String(messageType || '').trim());
            const plainSearchOk = isPlainNum && !!pendingHere && pendingHere.kind === 'search' && pendingHere.msgId === messageID &&
                (!replyMek.key.participant || replyMek.key.participant === animostRequester);

            if ((isReplyToSentMsg || plainSearchOk) && sender === replyMek.key.remoteJid) {
                const choice = parseInt(messageType, 10) - 1;
                if (isNaN(choice) || choice < 0 || choice >= results.length) {
                    await socket.sendMessage(sender, { text: `*❪ INVALID ❫*\n\n⚠️ *Wrong Number!*\n🎯 *Range:* _01 - ${results.length}_\n📝 _Please reply with a valid number!_${ANIMOST_FOOTER}` }, { quoted: replyMek });
                    return;
                }

                const selectedItem = results[choice];
                await socket.sendMessage(sender, { text: `*❪ FETCHING ❫*\n\n📺 *Fetching Anime Details...*\n⚡ _Please wait..._` }, { quoted: replyMek });

                try {
                    const detailsData = (await animostApiGet(`${ANIMOST_API_BASE}/api/v1/movie/animost/infodl?q=${encodeURIComponent(selectedItem.link)}&api_key=${ANIMOST_API_KEY}`)).data;
                    if (!detailsData.status || !detailsData.data) throw new Error('Failed to fetch details');

                    const animeInfo = detailsData.data;
                    const validDownloads = Array.isArray(animeInfo.downloads)
                        ? animeInfo.downloads.filter(d => d && d.link && !String(d.link).includes('t.me') && !String(d.link).includes('telegram'))
                        : [];

                    if (validDownloads.length === 0) {
                        await socket.sendMessage(sender, { text: `*❪ NO DOWNLOADS ❫*\n\n⚠️ *No Downloads Found!*\n😞 _There are no downloads available for this anime!_${ANIMOST_FOOTER}` }, { quoted: replyMek });
                        return;
                    }

                    const story = String(animeInfo.story || 'No description available.');
                    const detailsText = `╭━〔 🎭 𝐀𝐍𝐈𝐌𝐄 𝐃𝐄𝐓𝐀𝐈𝐋𝐒 〕━━⬣\n│\n│ \`🎬 𝐓𝐢𝐭𝐥𝐞\`     : ${animeInfo.title || selectedItem.title}\n│ \`⭐ 𝐑𝐚𝐭𝐢𝐧𝐠\`    : ${animeInfo.imdb || animeInfo.rating || 'N/A'}\n│ \`🎭 𝐆𝐞𝐧𝐫𝐞𝐬\`    : ${Array.isArray(animeInfo.genres) ? animeInfo.genres.join(', ') : 'N/A'}\n│ \`🗣️ 𝐋𝐚𝐧𝐠𝐮𝐚𝐠𝐞\`   : ${animeInfo.language || 'N/A'}\n│ \`🎬 𝐃𝐢𝐫𝐞𝐜𝐭𝐨𝐫\`  : ${animeInfo.director || 'N/A'}\n│\n╰━━━━━━━━━━━━━━━━⬣\n\n📝 *𝐒𝐓𝐎𝐑𝐘*\n${story.length > 250 ? story.substring(0, 250) + '...' : story}\n\n📥 *𝐒𝐄𝐋𝐄𝐂𝐓 𝐐𝐔𝐀𝐋𝐈𝐓𝐘*\n\n${validDownloads.map((dl, i) => `${String(i + 1).padStart(2, '0')} ➜ 💾 _${String(dl.quality || 'Download').substring(0, 40)}_ 📁 _${dl.size || 'N/A'}_`).join('\n')}\n\n💬 *Reply with the corresponding number.*\n${ANIMOST_FOOTER}`;

                    const posterUrl = animeInfo.image || selectedItem.image || ANIMOST_DEFAULT_IMAGE;
                    let detailsMsg;
                    try {
                        detailsMsg = await socket.sendMessage(sender, { image: { url: posterUrl }, caption: detailsText }, { quoted: replyMek });
                    } catch (e) {
                        detailsMsg = await socket.sendMessage(sender, { text: detailsText }, { quoted: replyMek });
                    }
                    const optionsMsgID = detailsMsg.key.id;
                    animostPendingMsg.set(sender, { msgId: optionsMsgID, kind: 'quality', ts: Date.now() });

                    const handleDownload = async ({ messages: downloadMessages }) => {
                        const downloadMek = downloadMessages[0];
                        if (!downloadMek?.message) return;
                        if (!(await mayProcessSelectionReply(socket, downloadMek))) return;

                        const downloadChoice = downloadMek.message.conversation || downloadMek.message.extendedTextMessage?.text;
                        const isReplyToOptionsMsg = downloadMek.message.extendedTextMessage?.contextInfo?.stanzaId === optionsMsgID;
                        const pendingHere2 = animostPendingMsg.get(sender);
                        const isPlainNum2 = /^\d+$/.test(String(downloadChoice || '').trim());
                        const plainQualityOk = isPlainNum2 && !!pendingHere2 && pendingHere2.kind === 'quality' && pendingHere2.msgId === optionsMsgID &&
                            (!downloadMek.key.participant || downloadMek.key.participant === animostRequester);

                        if ((isReplyToOptionsMsg || plainQualityOk) && sender === downloadMek.key.remoteJid) {
                            const choiceNum = parseInt(downloadChoice, 10) - 1;
                            if (isNaN(choiceNum) || choiceNum < 0 || choiceNum >= validDownloads.length) {
                                await socket.sendMessage(sender, { text: `*❪ INVALID ❫*\n\n⚠️ *Wrong Number!*\n🎯 *Range:* _01 - ${validDownloads.length}_\n📝 _Please reply with a valid number!_${ANIMOST_FOOTER}` }, { quoted: downloadMek });
                                return;
                            }

                            const selectedDownload = validDownloads[choiceNum];
                            await socket.sendMessage(sender, { react: { text: '📥', key: downloadMek.key } });

                            try {
                                const quality = String(selectedDownload.quality || 'Download').substring(0, 25);
                                const safeTitle = String(animeInfo.title || selectedItem.title || 'anime').replace(/[^a-zA-Z0-9 ]/g, '').trim() || 'anime';

                                await socket.sendMessage(sender, {
                                    document: { url: selectedDownload.link },
                                    mimetype: 'video/mp4',
                                    fileName: `${safeTitle} - ${quality}.mp4`,
                                    caption: `╭━〔 🎭 𝐀𝐍𝐈𝐌𝐄 𝐃𝐎𝐖𝐍𝐋𝐎𝐀𝐃 〕━━⬣\n│\n│ \`🎭 𝐓𝐢𝐭𝐥𝐞\`   : ${animeInfo.title || selectedItem.title}\n│ \`💾 𝐐𝐮𝐚𝐥𝐢𝐭𝐲\` : ${quality}\n│ ⚡ 𝐒𝐭𝐚𝐭𝐮𝐬  : Ready\n│\n╰━━━━━━━━━━━━━━━━⬣${ANIMOST_FOOTER}`
                                }, { quoted: downloadMek });

                                await socket.sendMessage(sender, { react: { text: '✅', key: downloadMek.key } });
                            } catch (downloadError) {
                                console.error('Animost download error:', downloadError);
                                await socket.sendMessage(sender, { text: `*❪ ERROR ❫*\n\n❌ *Download Failed!*\n🚫 _${downloadError.message}_${ANIMOST_FOOTER}` }, { quoted: downloadMek });
                            } finally {
                                socket.ev.off('messages.upsert', handleDownload);
                                socket.ev.off('messages.upsert', handleSelection);
                                pendingInlineListeners.delete(sender);
                            }
                        }
                    };

                    pendingInlineListeners.add(sender);
                    socket.ev.on('messages.upsert', handleDownload);

                } catch (detailsError) {
                    console.error('Animost details error:', detailsError);
                    await socket.sendMessage(sender, { text: `*❪ ERROR ❫*\n\n❌ *Anime Details Error!*\n🚫 _${detailsError.message}_${ANIMOST_FOOTER}` }, { quoted: replyMek });
                    socket.ev.off('messages.upsert', handleSelection);
                    pendingInlineListeners.delete(sender);
                }
            }
        };

        pendingInlineListeners.add(sender);
        socket.ev.on('messages.upsert', handleSelection);

    } catch (error) {
        console.error('Animost command error:', error);
        await socket.sendMessage(sender, { text: `*❪ SYSTEM ERROR ❫*\n\n❌ *System Error!*\n🚫 _${error.message || 'Unknown error'}_\n\n🔄 _Please try again later..._${ANIMOST_FOOTER}` }, { quoted: msg });
    }
    break;
}

case 'moviebox': {
    // 🎥 MovieBox (Chama Movie API moviebox endpoints).
    // Search → pick movie quality OR TV season auto-download. Reply handling
    // follows the hardened .cartoon/.animost pattern: quote-match OR plain
    // numbered reply (only the latest menu wins), multi-bot @mention gate,
    // retry + friendly timeout errors (the Koyeb instance cold-starts), and
    // full listener cleanup.
    const MOVIEBOX_FOOTER = `\n\n${config.BOT_FOOTER}`;
    const MOVIEBOX_API_BASE = 'https://api.chamindu.site';
    const MOVIEBOX_API_KEY = 'chama_api_b79c94c8375e3814d622d2cf66b4f52c';
    const MOVIEBOX_DEFAULT_IMAGE = 'https://api.chamindu.site/logo.png';
    const movieboxRequester = nowsender; // actual user (not the chat jid) who ran the command

    async function movieboxApiGet(url) {
      let lastErr;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          return await axios.get(url, { timeout: 90000 });
        } catch (e) {
          lastErr = e;
          const status = e && e.response && e.response.status;
          const transient = (e && e.code === 'ECONNABORTED') || !e.response || (status >= 500 && status < 600);
          if (!transient || attempt === 1) {
            const body = (e && e.response && e.response.data) || {};
            const detail = String(body.detail || body.message || body.error || '').trim();
            const hay = String(detail || e.message || '').toLowerCase();
            if ((e && e.code === 'ECONNABORTED') || hay.includes('timeout')) {
              throw new Error('The MovieBox API is busy right now (it timed out). Please try again in a moment.');
            }
            throw new Error(e && e.message ? e.message : 'Unknown error');
          }
          await new Promise(r => setTimeout(r, 1500));
        }
      }
      throw lastErr;
    }

    if (!args.length) {
        await socket.sendMessage(sender, {
            text: `*❪ ERROR ❫*\n\n⚠️ *Invalid Usage!*\n\n🎬 *Example:*\n• ${prefix}moviebox avatar\n• ${prefix}moviebox stranger things\n\n📝 _Please provide the Movie or TV Series name!_${MOVIEBOX_FOOTER}`
        }, { quoted: msg });
        break;
    }

    const query = args.join(' ');
    await socket.sendMessage(sender, {
        text: `*❪ SEARCHING ❫*\n\n🔍 *Searching MovieBox...*\n⚡ _Please wait a moment._`
    }, { quoted: msg });

    try {
        const searchData = (await movieboxApiGet(`${MOVIEBOX_API_BASE}/api/v1/movie/moviebox/search?q=${encodeURIComponent(query)}&api_key=${MOVIEBOX_API_KEY}`)).data;
        if (!searchData.status || !Array.isArray(searchData.data) || searchData.data.length === 0) {
            await socket.sendMessage(sender, {
                text: `*❪ NO RESULTS ❫*\n\n😞 *No Results Found!*\n\n🎬 *Query:* _${query}_\n💡 *Tip:* _Please check the spelling and try again!_${MOVIEBOX_FOOTER}`
            }, { quoted: msg });
            break;
        }

        const results = searchData.data.slice(0, 25);
        const searchRows = results.map((item, index) => {
            const num = String(index + 1).padStart(2, '0');
            const icon = item.type === 'tvshows' ? '📺' : '🎥';
            return { num, icon, title: String(item.title || '').substring(0, 45) };
        });

        const searchCaption = `╭〔 🎥 𝐌𝐎𝐕𝐈𝐄𝐁𝐎𝐗 • 𝐒𝐄𝐀𝐑𝐂𝐇 〕━⬣\n│\n│ \`🔎 𝐐𝐮𝐞𝐫𝐲\`    : ${query}\n│ \`📊 𝐑𝐞𝐬𝐮𝐥𝐭𝐬\`  : ${results.length}\n│ \`🌐 𝐒𝐨𝐮𝐫𝐜𝐞\`   : MovieBox\n│\n╰━━━━━━━━━━━━━━━━⬣\n\n📥 *𝐒𝐄𝐋𝐄𝐂𝐓 𝐀 𝐓𝐈𝐓𝐋𝐄*\n\n${searchRows.map(row => `${row.num} ➜ ${row.icon} _${row.title}_`).join('\n')}\n\n💬 *Reply with the corresponding number.*\n${MOVIEBOX_FOOTER}`;

        let sentMsg;
        try {
            sentMsg = await socket.sendMessage(sender, { image: { url: results[0].image || MOVIEBOX_DEFAULT_IMAGE }, caption: searchCaption }, { quoted: msg });
        } catch (e) {
            sentMsg = await socket.sendMessage(sender, { text: searchCaption }, { quoted: msg });
        }
        const messageID = sentMsg.key.id;
        movieboxPendingMsg.set(sender, { msgId: messageID, kind: 'search', ts: Date.now() });

        const handleSelection = async ({ messages: replyMessages }) => {
            const replyMek = replyMessages[0];
            if (!replyMek?.message) return;
            if (!(await mayProcessSelectionReply(socket, replyMek))) return;

            const messageType = replyMek.message.conversation || replyMek.message.extendedTextMessage?.text;
            const isReplyToSentMsg = replyMek.message.extendedTextMessage?.contextInfo?.stanzaId === messageID;
            const pendingHere = movieboxPendingMsg.get(sender);
            const isPlainNum = /^\d+$/.test(String(messageType || '').trim());
            const plainSearchOk = isPlainNum && !!pendingHere && pendingHere.kind === 'search' && pendingHere.msgId === messageID &&
                (!replyMek.key.participant || replyMek.key.participant === movieboxRequester);

            if ((isReplyToSentMsg || plainSearchOk) && sender === replyMek.key.remoteJid) {
                const choice = parseInt(messageType, 10) - 1;
                if (isNaN(choice) || choice < 0 || choice >= results.length) {
                    await socket.sendMessage(sender, { text: `*❪ INVALID ❫*\n\n⚠️ *Wrong Number!*\n🎯 *Range:* _01 - ${results.length}_\n📝 _Please reply with a valid number!_${MOVIEBOX_FOOTER}` }, { quoted: replyMek });
                    return;
                }

                const selectedItem = results[choice];
                const isTvShow = selectedItem.type === 'tvshows';

                if (isTvShow) {
                    // ---------- TV SERIES FLOW (auto-download first season) ----------
                    await socket.sendMessage(sender, { text: `*❪ FETCHING ❫*\n\n📺 *Fetching TV Series Details...*\n⚡ _Please wait..._` }, { quoted: replyMek });
                    try {
                        const tvShowData = (await movieboxApiGet(`${MOVIEBOX_API_BASE}/api/v1/movie/moviebox/tv/info?q=${encodeURIComponent(selectedItem.link)}&api_key=${MOVIEBOX_API_KEY}`)).data;
                        if (!tvShowData.status || !tvShowData.data) throw new Error('Failed to fetch TV show details');
                        const tvInfo = tvShowData.data;

                        const tvDetailsText = `╭〔 📺 𝐓𝐕 𝐒𝐄𝐑𝐈𝐄𝐒 𝐃𝐄𝐓𝐀𝐈𝐋𝐒 〕━⬣\n│\n│ 🎬 𝐓𝐢𝐭𝐥𝐞     : ${tvInfo.title || selectedItem.title}\n│ ⭐ 𝐑𝐚𝐭𝐢𝐧𝐠    : ${tvInfo.rating || 'N/A'}\n│ 📅 𝐘𝐞𝐚𝐫      : ${tvInfo.year || 'N/A'}\n│ ⏳ 𝐑𝐮𝐧𝐭𝐢𝐦𝐞   : ${tvInfo.duration || 'N/A'}\n│ 🌍 𝐂𝐨𝐮𝐧𝐭𝐫𝐲   : ${tvInfo.country || 'N/A'}\n│\n╰━━━━━━━━━━━━━━━━⬣\n\n💡 *Sinhala AI Sub Available!*${MOVIEBOX_FOOTER}`;

                        const posterUrl = tvInfo.image || selectedItem.image || MOVIEBOX_DEFAULT_IMAGE;
                        try {
                            await socket.sendMessage(sender, { image: { url: posterUrl }, caption: tvDetailsText }, { quoted: replyMek });
                        } catch (e) {
                            await socket.sendMessage(sender, { text: tvDetailsText }, { quoted: replyMek });
                        }

                        const seasons = Array.isArray(tvInfo.seasons) ? tvInfo.seasons : [];
                        if (seasons.length === 0) throw new Error('No seasons found for this TV Series');

                        const activeSeason = seasons[0];
                        const epList = Array.isArray(activeSeason.episodes) ? activeSeason.episodes : [];
                        await socket.sendMessage(sender, { text: `📥 *Starting automatic download of Season ${activeSeason.season} (${epList.length} episodes) consecutively...*\n\n⚡ *This may take some time* ⚡` }, { quoted: replyMek });

                        let successCount = 0;
                        let failCount = 0;
                        for (let i = 0; i < epList.length; i++) {
                            const epNum = epList[i];
                            try {
                                const epDlData = (await movieboxApiGet(`${MOVIEBOX_API_BASE}/api/v1/movie/moviebox/tv/dl?q=${encodeURIComponent(selectedItem.link)}&se=${activeSeason.season}&ep=${epNum}&api_key=${MOVIEBOX_API_KEY}`)).data;
                                if (epDlData.status && Array.isArray(epDlData.data) && epDlData.data.length > 0) {
                                    const videoLinks = epDlData.data.filter(dl => dl && (dl.link || dl.url) && String(dl.quality).toUpperCase() !== 'SUB');
                                    const subLinks = epDlData.data.filter(dl => dl && (dl.link || dl.url) && String(dl.quality).toUpperCase() === 'SUB');
                                    const finalLinkObj = videoLinks[0] || epDlData.data[0];

                                    await socket.sendMessage(sender, {
                                        document: { url: finalLinkObj.link || finalLinkObj.url },
                                        mimetype: 'video/mp4',
                                        fileName: `${tvInfo.title} - S${activeSeason.season}E${epNum}.mp4`,
                                        caption: `${tvInfo.title}\n\n*Episode:* S${activeSeason.season}E${epNum}${MOVIEBOX_FOOTER}`
                                    }, { quoted: replyMek });

                                    // Send English and Sinhala subtitles if available
                                    const englishSub = subLinks.find(s => String(s.title || '').toLowerCase().includes('english') || String(s.title || '').toLowerCase().includes('en'));
                                    const sinhalaSub = subLinks.find(s => String(s.title || '').toLowerCase().includes('sinhala') || String(s.title || '').toLowerCase().includes('si'));
                                    const subsToSend = [];
                                    if (sinhalaSub) subsToSend.push(sinhalaSub);
                                    if (englishSub) subsToSend.push(englishSub);
                                    if (subsToSend.length === 0 && subLinks.length > 0) subsToSend.push(subLinks[0]);

                                    for (const sub of subsToSend) {
                                        try {
                                            const subLang = String(sub.title || 'Subtitle').replace('Subtitle - ', '').replace(` (S${activeSeason.season}E${epNum})`, '').trim() || 'Subtitle';
                                            await socket.sendMessage(sender, {
                                                document: { url: sub.link || sub.url },
                                                mimetype: 'text/plain',
                                                fileName: `${tvInfo.title} - S${activeSeason.season}E${epNum} - ${subLang}.srt`,
                                                caption: `${tvInfo.title} - Subtitle\n\n*Language:* ${subLang}\n*Episode:* S${activeSeason.season}E${epNum}${MOVIEBOX_FOOTER}`
                                            }, { quoted: replyMek });
                                        } catch (subErr) {
                                            console.error('Moviebox episode subtitle error:', subErr);
                                        }
                                    }
                                    successCount++;
                                } else {
                                    failCount++;
                                }
                            } catch (epError) {
                                console.error('Moviebox episode download error:', epError);
                                failCount++;
                            }
                            // Anti-spam pacing: never send two media messages back-to-back.
                            await delay(2500);
                        }

                        await socket.sendMessage(sender, { text: `✅ *Download Complete!*\n\n*Summary:*\n📥 *Success:* ${successCount} episodes\n❌ *Failed:* ${failCount} episodes\n*Series:* ${tvInfo.title}${MOVIEBOX_FOOTER}` }, { quoted: replyMek });
                    } catch (tvShowError) {
                        console.error('Moviebox TV show error:', tvShowError);
                        await socket.sendMessage(sender, { text: `*❪ ERROR ❫*\n\n❌ *TV series details failed!*\n🚫 _${tvShowError.message}_${MOVIEBOX_FOOTER}` }, { quoted: replyMek });
                    } finally {
                        socket.ev.off('messages.upsert', handleSelection);
                        pendingInlineListeners.delete(sender);
                    }

                } else {
                    // ---------- MOVIE FLOW ----------
                    await socket.sendMessage(sender, { text: `*❪ FETCHING ❫*\n\n🎥 *Fetching Movie Details...*\n⚡ _Please wait..._` }, { quoted: replyMek });
                    try {
                        const detailsData = (await movieboxApiGet(`${MOVIEBOX_API_BASE}/api/v1/movie/moviebox/info?q=${encodeURIComponent(selectedItem.link)}&api_key=${MOVIEBOX_API_KEY}`)).data;
                        if (!detailsData.status || !detailsData.data) throw new Error('Failed to fetch details');
                        const movieInfo = detailsData.data;

                        const validDownloads = Array.isArray(movieInfo.downloads)
                            ? movieInfo.downloads.filter(d => d && (d.link || d.url))
                            : [];

                        if (validDownloads.length === 0) {
                            await socket.sendMessage(sender, { text: `*❪ NO DOWNLOADS ❫*\n\n⚠️ *No Downloads Found!*\n😞 _There are no downloads available for this movie!_${MOVIEBOX_FOOTER}` }, { quoted: replyMek });
                            socket.ev.off('messages.upsert', handleSelection);
                            pendingInlineListeners.delete(sender);
                            return;
                        }

                        const movieDetailsText = `╭〔 🎥 𝐌𝐎𝐕𝐈𝐄 𝐃𝐄𝐓𝐀𝐈𝐋𝐒 〕━⬣\n│\n│ 🎬 𝐓𝐢𝐭𝐥𝐞     : ${movieInfo.title || selectedItem.title}\n│ ⭐ 𝐑𝐚𝐭𝐢𝐧𝐠    : ${movieInfo.rating || 'N/A'}\n│ 📅 𝐘𝐞𝐚𝐫      : ${movieInfo.year || 'N/A'}\n│ ⏳ 𝐑𝐮𝐧𝐭𝐢𝐦𝐞   : ${movieInfo.duration || 'N/A'}\n│ 🌍 𝐂𝐨𝐮𝐧𝐭𝐫𝐲   : ${movieInfo.country || 'N/A'}\n│\n╰━━━━━━━━━━━━━━━━⬣\n\n💡 *Sinhala AI Sub Available!*\n\n📥 *𝐒𝐄𝐋𝐄𝐂𝐓 𝐐𝐔𝐀𝐋𝐈𝐓𝐘*\n\n${validDownloads.map((dl, i) => `${String(i + 1).padStart(2, '0')} ➜ 💾 _${String(dl.quality || 'Download').substring(0, 40)}_ 📁 _${dl.size || 'N/A'}_`).join('\n')}\n\n💬 *Reply with the corresponding number.*\n${MOVIEBOX_FOOTER}`;

                        const moviePosterUrl = movieInfo.image || selectedItem.image || MOVIEBOX_DEFAULT_IMAGE;
                        let detailsMsg;
                        try {
                            detailsMsg = await socket.sendMessage(sender, { image: { url: moviePosterUrl }, caption: movieDetailsText }, { quoted: replyMek });
                        } catch (e) {
                            detailsMsg = await socket.sendMessage(sender, { text: movieDetailsText }, { quoted: replyMek });
                        }
                        const optionsMsgID = detailsMsg.key.id;
                        movieboxPendingMsg.set(sender, { msgId: optionsMsgID, kind: 'quality', ts: Date.now() });

                        const handleDownload = async ({ messages: downloadMessages }) => {
                            const downloadMek = downloadMessages[0];
                            if (!downloadMek?.message) return;
                            if (!(await mayProcessSelectionReply(socket, downloadMek))) return;

                            const downloadChoice = downloadMek.message.conversation || downloadMek.message.extendedTextMessage?.text;
                            const isReplyToOptionsMsg = downloadMek.message.extendedTextMessage?.contextInfo?.stanzaId === optionsMsgID;
                            const pendingHere2 = movieboxPendingMsg.get(sender);
                            const isPlainNum2 = /^\d+$/.test(String(downloadChoice || '').trim());
                            const plainQualityOk = isPlainNum2 && !!pendingHere2 && pendingHere2.kind === 'quality' && pendingHere2.msgId === optionsMsgID &&
                                (!downloadMek.key.participant || downloadMek.key.participant === movieboxRequester);

                            if ((isReplyToOptionsMsg || plainQualityOk) && sender === downloadMek.key.remoteJid) {
                                const choiceNum = parseInt(downloadChoice, 10) - 1;
                                if (isNaN(choiceNum) || choiceNum < 0 || choiceNum >= validDownloads.length) {
                                    await socket.sendMessage(sender, { text: `*❪ INVALID ❫*\n\n⚠️ *Wrong Number!*\n🎯 *Range:* _01 - ${validDownloads.length}_\n📝 _Please reply with a valid number!_${MOVIEBOX_FOOTER}` }, { quoted: downloadMek });
                                    return;
                                }

                                const selectedDownload = validDownloads[choiceNum];
                                const isSub = String(selectedDownload.quality || '').toUpperCase() === 'SUB' || String(selectedDownload.title || '').toLowerCase().includes('subtitle') || String(selectedDownload.quality || '').toLowerCase().includes('sub');
                                const finalDirectLink = selectedDownload.link || selectedDownload.url;
                                const quality = String(selectedDownload.quality || 'Download').substring(0, 25);

                                await socket.sendMessage(sender, { react: { text: '⏳', key: downloadMek.key } });
                                try {
                                    if (isSub) {
                                        await socket.sendMessage(sender, {
                                            document: { url: finalDirectLink },
                                            mimetype: 'text/plain',
                                            fileName: `${movieInfo.title} - Subtitle.srt`,
                                            caption: `📌 *${movieInfo.title} - Subtitle*\n\n*Quality:* ${quality}\n*Size:* ${selectedDownload.size || 'N/A'}\n${MOVIEBOX_FOOTER}`
                                        }, { quoted: downloadMek });
                                    } else {
                                        await socket.sendMessage(sender, {
                                            text: `🎬 *${movieInfo.title}*\n\n*Quality:* ${quality}\n*Size:* ${selectedDownload.size || 'N/A'}\n\n📥 *DIRECT DOWNLOAD LINK:*\n${finalDirectLink}\n${MOVIEBOX_FOOTER}`
                                        }, { quoted: downloadMek });
                                    }
                                    await socket.sendMessage(sender, { react: { text: '✅', key: downloadMek.key } });
                                } catch (downloadError) {
                                    console.error('Moviebox download error:', downloadError);
                                    await socket.sendMessage(sender, {
                                        text: `🎬 *${movieInfo.title}*\n\n*Quality:* ${quality}\n*Size:* ${selectedDownload.size || 'N/A'}\n\n📥 *DIRECT DOWNLOAD LINK:*\n${finalDirectLink}\n${MOVIEBOX_FOOTER}`
                                    }, { quoted: downloadMek });
                                    await socket.sendMessage(sender, { react: { text: '✅', key: downloadMek.key } });
                                } finally {
                                    socket.ev.off('messages.upsert', handleDownload);
                                    socket.ev.off('messages.upsert', handleSelection);
                                    pendingInlineListeners.delete(sender);
                                }
                            }
                        };

                        pendingInlineListeners.add(sender);
                        socket.ev.on('messages.upsert', handleDownload);

                    } catch (detailsError) {
                        console.error('Moviebox details error:', detailsError);
                        await socket.sendMessage(sender, { text: `*❪ ERROR ❫*\n\n❌ *Movie Details Error!*\n🚫 _${detailsError.message}_${MOVIEBOX_FOOTER}` }, { quoted: replyMek });
                        socket.ev.off('messages.upsert', handleSelection);
                        pendingInlineListeners.delete(sender);
                    }
                }
            }
        };

        pendingInlineListeners.add(sender);
        socket.ev.on('messages.upsert', handleSelection);

    } catch (error) {
        console.error('Moviebox command error:', error);
        await socket.sendMessage(sender, { text: `*❪ SYSTEM ERROR ❫*\n\n❌ *System Error!*\n🚫 _${error.message || 'Unknown error'}_\n\n🔄 _Please try again later..._${MOVIEBOX_FOOTER}` }, { quoted: msg });
    }
    break;
}

case 'hanime':
case 'hhentai': {
    // 🔞 18+ gate: NSFW content requires owner verification (.verify18 <jid>).
    if (!(await isNsfwVerified(socket, nowsender))) {
      await socket.sendMessage(sender, { text: nsfwDeniedText() }, { quoted: msg });
      break;
    }
    // 🔞 Hanime (Chama Movie API hanime endpoints).
    // Search → pick video → pick download stream. Reply handling follows the
    // hardened .cartoon/.animost pattern: quote-match OR plain numbered reply
    // (only the latest menu wins), multi-bot @mention gate, retry + friendly
    // timeout errors, and full listener cleanup.
    const HANIME_FOOTER = `\n\n${config.BOT_FOOTER}`;
    const HANIME_API_BASE = 'https://api.chamindu.site';
    const HANIME_API_KEY = 'chama_api_b79c94c8375e3814d622d2cf66b4f52c';
    const HANIME_DEFAULT_IMAGE = 'https://api.chamindu.site/logo.png';
    const hanimeRequester = nowsender; // actual user (not the chat jid) who ran the command

    async function hanimeApiGet(url) {
      let lastErr;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          return await axios.get(url, { timeout: 90000 });
        } catch (e) {
          lastErr = e;
          const status = e && e.response && e.response.status;
          const transient = (e && e.code === 'ECONNABORTED') || !e.response || (status >= 500 && status < 600);
          if (!transient || attempt === 1) {
            const body = (e && e.response && e.response.data) || {};
            const detail = String(body.detail || body.message || body.error || '').trim();
            const hay = String(detail || e.message || '').toLowerCase();
            if ((e && e.code === 'ECONNABORTED') || hay.includes('timeout')) {
              throw new Error('The Hanime API is busy right now (it timed out). Please try again in a moment.');
            }
            throw new Error(e && e.message ? e.message : 'Unknown error');
          }
          await new Promise(r => setTimeout(r, 1500));
        }
      }
      throw lastErr;
    }

    if (!args.length) {
        await socket.sendMessage(sender, {
            text: `*❪ ERROR ❫*\n\n⚠️ *Invalid Usage!*\n\n🔞 *Example:*\n• ${prefix}hanime overflow\n• ${prefix}hhentai paihame\n\n📝 _Please provide the Hanime title!_${HANIME_FOOTER}`
        }, { quoted: msg });
        break;
    }

    const query = args.join(' ');
    await socket.sendMessage(sender, {
        text: `*❪ SEARCHING ❫*\n\n🔍 *Searching Hanime.tv...*\n⚡ _Please wait a moment._`
    }, { quoted: msg });

    try {
        const searchData = (await hanimeApiGet(`${HANIME_API_BASE}/api/v1/movie/hanime/search?q=${encodeURIComponent(query)}&api_key=${HANIME_API_KEY}`)).data;
        if (!searchData.status || !Array.isArray(searchData.data) || searchData.data.length === 0) {
            await socket.sendMessage(sender, {
                text: `*❪ NO RESULTS ❫*\n\n😞 *No Results Found!*\n\n🎬 *Query:* _${query}_\n💡 *Tip:* _Please check the spelling and try again!_${HANIME_FOOTER}`
            }, { quoted: msg });
            break;
        }

        const results = searchData.data.slice(0, 25);
        const searchRows = results.map((item, index) => {
            const num = String(index + 1).padStart(2, '0');
            return { num, title: String(item.title || '').substring(0, 45) };
        });

        const searchCaption = `╭〔 🔞 𝐇𝐀𝐍𝐈𝐌𝐄 • 𝐒𝐄𝐀𝐑𝐂𝐇 〕━⬣\n│\n│ 🔎 𝐐𝐮𝐞𝐫𝐲    : ${query}\n│ 📊 𝐑𝐞𝐬𝐮𝐥𝐭𝐬  : ${results.length}\n│ 🌐 𝐒𝐨𝐮𝐫𝐜𝐞   : Hanime.tv\n│\n╰━━━━━━━━━━━━━━━━⬣\n\n📥 *𝐒𝐄𝐋𝐄𝐂𝐓 𝐀 𝐕𝐈𝐃𝐄𝐎*\n\n${searchRows.map(row => `${row.num} ➜ 🔞 _${row.title}_`).join('\n')}\n\n💬 *Reply with the corresponding number.*\n${HANIME_FOOTER}`;

        let sentMsg;
        try {
            sentMsg = await socket.sendMessage(sender, { image: { url: results[0].image || HANIME_DEFAULT_IMAGE }, caption: searchCaption }, { quoted: msg });
        } catch (e) {
            sentMsg = await socket.sendMessage(sender, { text: searchCaption }, { quoted: msg });
        }
        const messageID = sentMsg.key.id;
        hanimePendingMsg.set(sender, { msgId: messageID, kind: 'search', ts: Date.now() });

        const handleSelection = async ({ messages: replyMessages }) => {
            const replyMek = replyMessages[0];
            if (!replyMek?.message) return;
            if (!(await mayProcessSelectionReply(socket, replyMek))) return;

            const messageType = replyMek.message.conversation || replyMek.message.extendedTextMessage?.text;
            const isReplyToSentMsg = replyMek.message.extendedTextMessage?.contextInfo?.stanzaId === messageID;
            const pendingHere = hanimePendingMsg.get(sender);
            const isPlainNum = /^\d+$/.test(String(messageType || '').trim());
            const plainSearchOk = isPlainNum && !!pendingHere && pendingHere.kind === 'search' && pendingHere.msgId === messageID &&
                (!replyMek.key.participant || replyMek.key.participant === hanimeRequester);

            if ((isReplyToSentMsg || plainSearchOk) && sender === replyMek.key.remoteJid) {
                const choice = parseInt(messageType, 10) - 1;
                if (isNaN(choice) || choice < 0 || choice >= results.length) {
                    await socket.sendMessage(sender, { text: `*❪ INVALID ❫*\n\n⚠️ *Wrong Number!*\n🎯 *Range:* _01 - ${results.length}_\n📝 _Please reply with a valid number!_${HANIME_FOOTER}` }, { quoted: replyMek });
                    return;
                }

                const selectedItem = results[choice];
                await socket.sendMessage(sender, { text: `*❪ FETCHING ❫*\n\n🔞 *Fetching Hanime details and direct MP4 download streams...*\n⚡ _Please wait..._` }, { quoted: replyMek });

                try {
                    const detailsData = (await hanimeApiGet(`${HANIME_API_BASE}/api/v1/movie/hanime/infodl?q=${encodeURIComponent(selectedItem.link)}&api_key=${HANIME_API_KEY}`)).data;
                    if (!detailsData.status || !detailsData.data) throw new Error('Failed to fetch details');

                    const videoInfo = detailsData.data;
                    const validDownloads = Array.isArray(videoInfo.downloads)
                        ? videoInfo.downloads.filter(d => d && (d.link || d.url))
                        : [];

                    if (validDownloads.length === 0) {
                        await socket.sendMessage(sender, { text: `*❪ NO DOWNLOADS ❫*\n\n⚠️ *No Downloads Found!*\n😞 _There are no downloads available for this video!_${HANIME_FOOTER}` }, { quoted: replyMek });
                        return;
                    }

                    const story = String(videoInfo.story || 'No description available.');
                    const detailsText = `╭〔 🔞 𝐇𝐀𝐍𝐈𝐌𝐄 𝐃𝐄𝐓𝐀𝐈𝐋𝐒 〕━⬣\n│\n│ 🎬 𝐓𝐢𝐭𝐥𝐞     : ${videoInfo.title || selectedItem.title}\n│ ⭐ 𝐑𝐚𝐭𝐢𝐧𝐠    : ${videoInfo.rating || 'N/A'}\n│ 📅 𝐘𝐞𝐚𝐫      : ${videoInfo.year || 'N/A'}\n│ 🌍 𝐂𝐨𝐮𝐧𝐭𝐫𝐲   : ${videoInfo.country || 'N/A'}\n│ 🎭 𝐆𝐞𝐧𝐫𝐞𝐬    : ${Array.isArray(videoInfo.genres) ? videoInfo.genres.join(', ') : 'N/A'}\n│\n╰━━━━━━━━━━━━━━━━⬣\n\n📝 *𝐒𝐓𝐎𝐑𝐘*\n${story.length > 250 ? story.substring(0, 250) + '...' : story}\n\n📥 *𝐒𝐄𝐋𝐄𝐂𝐓 𝐀 𝐃𝐎𝐖𝐍𝐋𝐎𝐀𝐃 𝐋𝐈𝐍𝐊*\n\n${validDownloads.map((dl, i) => `${String(i + 1).padStart(2, '0')} ➜ 🎬 _${String(dl.title || dl.name || dl.quality || 'Download').substring(0, 40)}_`).join('\n')}\n\n💬 *Reply with the corresponding number.*\n${HANIME_FOOTER}`;

                    const posterUrl = videoInfo.image || selectedItem.image || HANIME_DEFAULT_IMAGE;
                    let detailsMsg;
                    try {
                        detailsMsg = await socket.sendMessage(sender, { image: { url: posterUrl }, caption: detailsText }, { quoted: replyMek });
                    } catch (e) {
                        detailsMsg = await socket.sendMessage(sender, { text: detailsText }, { quoted: replyMek });
                    }
                    const optionsMsgID = detailsMsg.key.id;
                    hanimePendingMsg.set(sender, { msgId: optionsMsgID, kind: 'quality', ts: Date.now() });

                    const handleDownload = async ({ messages: downloadMessages }) => {
                        const downloadMek = downloadMessages[0];
                        if (!downloadMek?.message) return;
                        if (!(await mayProcessSelectionReply(socket, downloadMek))) return;

                        const downloadChoice = downloadMek.message.conversation || downloadMek.message.extendedTextMessage?.text;
                        const isReplyToOptionsMsg = downloadMek.message.extendedTextMessage?.contextInfo?.stanzaId === optionsMsgID;
                        const pendingHere2 = hanimePendingMsg.get(sender);
                        const isPlainNum2 = /^\d+$/.test(String(downloadChoice || '').trim());
                        const plainQualityOk = isPlainNum2 && !!pendingHere2 && pendingHere2.kind === 'quality' && pendingHere2.msgId === optionsMsgID &&
                            (!downloadMek.key.participant || downloadMek.key.participant === hanimeRequester);

                        if ((isReplyToOptionsMsg || plainQualityOk) && sender === downloadMek.key.remoteJid) {
                            const choiceNum = parseInt(downloadChoice, 10) - 1;
                            if (isNaN(choiceNum) || choiceNum < 0 || choiceNum >= validDownloads.length) {
                                await socket.sendMessage(sender, { text: `*❪ INVALID ❫*\n\n⚠️ *Wrong Option!*\n🎯 *Range:* _01 - ${validDownloads.length}_\n📝 _Please reply with a valid download option number!_${HANIME_FOOTER}` }, { quoted: downloadMek });
                                return;
                            }

                            const selectedDownload = validDownloads[choiceNum];
                            const finalDirectLink = selectedDownload.link || selectedDownload.url;

                            await socket.sendMessage(sender, { react: { text: '⏳', key: downloadMek.key } });
                            await socket.sendMessage(sender, { text: `*❪ DOWNLOADING ❫*\n\n🎬 *Sending Direct MP4 Video...*\n⚡ _Please wait while video is being processed..._${HANIME_FOOTER}` }, { quoted: downloadMek });

                            try {
                                let jpegThumbnail = undefined;
                                try {
                                    const thumbRes = await axios.get(posterUrl, { responseType: 'arraybuffer', timeout: 15000 });
                                    jpegThumbnail = Buffer.from(thumbRes.data).toString('base64');
                                } catch (err) { /* no thumbnail → send without one */ }

                                await socket.sendMessage(sender, {
                                    document: { url: finalDirectLink },
                                    mimetype: 'video/mp4',
                                    fileName: `${videoInfo.title}.mp4`,
                                    caption: `*🔞 𝗜𝗦𝗛𝗔𝗡 𝗛𝗔𝗡𝗜𝗠𝗘 𝗩𝗜𝗗𝗘𝗢 🔞*\n\n🎭 *Title:* ${videoInfo.title}\n📊 *Quality:* 720p HD Direct MP4\n\n${HANIME_FOOTER}`,
                                    jpegThumbnail: jpegThumbnail
                                }, { quoted: downloadMek });

                                await socket.sendMessage(sender, { react: { text: '✅', key: downloadMek.key } });
                            } catch (dlErr) {
                                console.error('Hanime download error:', dlErr);
                                await socket.sendMessage(sender, { text: `*❪ ERROR ❫*\n\n❌ *Video Sending Failed!*\n🚫 _${dlErr.message}_${HANIME_FOOTER}` }, { quoted: downloadMek });
                            } finally {
                                socket.ev.off('messages.upsert', handleDownload);
                                socket.ev.off('messages.upsert', handleSelection);
                                pendingInlineListeners.delete(sender);
                            }
                        }
                    };

                    pendingInlineListeners.add(sender);
                    socket.ev.on('messages.upsert', handleDownload);

                } catch (detailsError) {
                    console.error('Hanime details error:', detailsError);
                    await socket.sendMessage(sender, { text: `*❪ ERROR ❫*\n\n❌ *Video Details Error!*\n🚫 _${detailsError.message}_${HANIME_FOOTER}` }, { quoted: replyMek });
                    socket.ev.off('messages.upsert', handleSelection);
                    pendingInlineListeners.delete(sender);
                }
            }
        };

        pendingInlineListeners.add(sender);
        socket.ev.on('messages.upsert', handleSelection);

    } catch (error) {
        console.error('Hanime command error:', error);
        await socket.sendMessage(sender, { text: `*❪ SYSTEM ERROR ❫*\n\n❌ *System Error!*\n🚫 _${error.message || 'Unknown error'}_\n\n🔄 _Please try again later..._${HANIME_FOOTER}` }, { quoted: msg });
    }
    break;
}

case 'pupilvideo': {
    // 🎥 PupilVideo (Chama Movie API pupilvideo endpoints).
    // Search → pick movie → pick quality → download. Reply handling follows
    // the hardened .cartoon/.animost pattern: quote-match OR plain numbered
    // reply (only the latest menu wins), multi-bot @mention gate, retry +
    // friendly timeout errors, and full listener cleanup.
    const PUPIL_FOOTER = `\n\n${config.BOT_FOOTER}`;
    const PUPIL_API_BASE = 'https://api.chamindu.site';
    const PUPIL_API_KEY = 'chama_api_b79c94c8375e3814d622d2cf66b4f52c';
    const PUPIL_DEFAULT_IMAGE = 'https://api.chamindu.site/logo.png';
    const pupilRequester = nowsender; // actual user (not the chat jid) who ran the command

    async function pupilApiGet(url) {
      let lastErr;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          return await axios.get(url, { timeout: 90000 });
        } catch (e) {
          lastErr = e;
          const status = e && e.response && e.response.status;
          const transient = (e && e.code === 'ECONNABORTED') || !e.response || (status >= 500 && status < 600);
          if (!transient || attempt === 1) {
            const body = (e && e.response && e.response.data) || {};
            const detail = String(body.detail || body.message || body.error || '').trim();
            const hay = String(detail || e.message || '').toLowerCase();
            if ((e && e.code === 'ECONNABORTED') || hay.includes('timeout')) {
              throw new Error('The PupilVideo API is busy right now (it timed out). Please try again in a moment.');
            }
            throw new Error(e && e.message ? e.message : 'Unknown error');
          }
          await new Promise(r => setTimeout(r, 1500));
        }
      }
      throw lastErr;
    }

    if (!args.length) {
        await socket.sendMessage(sender, {
            text: `*❪ ERROR ❫*\n\n⚠️ *Invalid Usage!*\n\n🎬 *Example:*\n• ${prefix}pupilvideo spider man\n\n📝 _Please provide the Movie name!_${PUPIL_FOOTER}`
        }, { quoted: msg });
        break;
    }

    const query = args.join(' ');
    await socket.sendMessage(sender, {
        text: `*❪ SEARCHING ❫*\n\n🔍 *Searching PupilVideo...*\n⚡ _Please wait a moment._`
    }, { quoted: msg });

    try {
        const searchData = (await pupilApiGet(`${PUPIL_API_BASE}/api/v1/movie/pupilvideo/search?q=${encodeURIComponent(query)}&api_key=${PUPIL_API_KEY}`)).data;
        if (!searchData.status || !Array.isArray(searchData.data) || searchData.data.length === 0) {
            await socket.sendMessage(sender, {
                text: `*❪ NO RESULTS ❫*\n\n😞 *No Results Found!*\n\n🎬 *Query:* _${query}_\n💡 *Tip:* _Please check the spelling and try again!_${PUPIL_FOOTER}`
            }, { quoted: msg });
            break;
        }

        const results = searchData.data.slice(0, 25);
        const searchRows = results.map((item, index) => {
            const num = String(index + 1).padStart(2, '0');
            return { num, title: String(item.title || '').substring(0, 45) };
        });

        const searchCaption = `╭〔 🎥 𝐏𝐔𝐏𝐈𝐋𝐕𝐈𝐃𝐄𝐎 • 𝐒𝐄𝐀𝐑𝐂𝐇 〕━⬣\n│\n│ 🔎 𝐐𝐮𝐞𝐫𝐲    : ${query}\n│ 📊 𝐑𝐞𝐬𝐮𝐥𝐭𝐬  : ${results.length}\n│ 🌐 𝐒𝐨𝐮𝐫𝐜𝐞   : PupilVideo\n│\n╰━━━━━━━━━━━━━━━━⬣\n\n📥 *𝐒𝐄𝐋𝐄𝐂𝐓 𝐀 𝐌𝐎𝐕𝐈𝐄*\n\n${searchRows.map(row => `${row.num} ➜ 🎥 _${row.title}_`).join('\n')}\n\n💬 *Reply with the corresponding number.*\n${PUPIL_FOOTER}`;

        let sentMsg;
        try {
            sentMsg = await socket.sendMessage(sender, { image: { url: results[0].image || PUPIL_DEFAULT_IMAGE }, caption: searchCaption }, { quoted: msg });
        } catch (e) {
            sentMsg = await socket.sendMessage(sender, { text: searchCaption }, { quoted: msg });
        }
        const messageID = sentMsg.key.id;
        pupilvideoPendingMsg.set(sender, { msgId: messageID, kind: 'search', ts: Date.now() });

        const handleSelection = async ({ messages: replyMessages }) => {
            const replyMek = replyMessages[0];
            if (!replyMek?.message) return;
            if (!(await mayProcessSelectionReply(socket, replyMek))) return;

            const messageType = replyMek.message.conversation || replyMek.message.extendedTextMessage?.text;
            const isReplyToSentMsg = replyMek.message.extendedTextMessage?.contextInfo?.stanzaId === messageID;
            const pendingHere = pupilvideoPendingMsg.get(sender);
            const isPlainNum = /^\d+$/.test(String(messageType || '').trim());
            const plainSearchOk = isPlainNum && !!pendingHere && pendingHere.kind === 'search' && pendingHere.msgId === messageID &&
                (!replyMek.key.participant || replyMek.key.participant === pupilRequester);

            if ((isReplyToSentMsg || plainSearchOk) && sender === replyMek.key.remoteJid) {
                const choice = parseInt(messageType, 10) - 1;
                if (isNaN(choice) || choice < 0 || choice >= results.length) {
                    await socket.sendMessage(sender, { text: `*❪ INVALID ❫*\n\n⚠️ *Wrong Number!*\n🎯 *Range:* _01 - ${results.length}_\n📝 _Please reply with a valid number!_${PUPIL_FOOTER}` }, { quoted: replyMek });
                    return;
                }

                const selectedItem = results[choice];
                await socket.sendMessage(sender, { text: `*❪ FETCHING ❫*\n\n🎬 *Fetching Movie...*\n⚡ _Please wait..._` }, { quoted: replyMek });

                try {
                    const detailsData = (await pupilApiGet(`${PUPIL_API_BASE}/api/v1/movie/pupilvideo/infodl?q=${encodeURIComponent(selectedItem.link)}&api_key=${PUPIL_API_KEY}`)).data;
                    if (!detailsData.status || !detailsData.data) throw new Error('Failed to fetch details');

                    const movieInfo = detailsData.data;
                    const validDownloads = Array.isArray(movieInfo.downloads)
                        ? movieInfo.downloads.filter(d => d && (d.link || d.url))
                        : [];

                    if (validDownloads.length === 0) {
                        await socket.sendMessage(sender, { text: `*❪ NO DOWNLOADS ❫*\n\n⚠️ *No Downloads Found!*\n😞 _There are no downloads available for this movie!_${PUPIL_FOOTER}` }, { quoted: replyMek });
                        return;
                    }

                    const story = String(movieInfo.story || 'No description available.');
                    const qualityRows = validDownloads.map((dl, i) => {
                        const num = String(i + 1).padStart(2, '0');
                        const icon = String(dl.quality || '').includes('1080') ? '🔥' : String(dl.quality || '').includes('720') ? '💎' : '📱';
                        return `${num} ➜ ${icon} _${String(dl.quality || 'Download').substring(0, 40)}_ 💾 _${dl.size || 'N/A'}_`;
                    }).join('\n');

                    const movieDetailsText = `╭〔 🎥 𝐏𝐔𝐏𝐈𝐋𝐕𝐈𝐃𝐄𝐎 𝐃𝐄𝐓𝐀𝐈𝐋𝐒 〕━⬣\n│\n│ 🎬 𝐓𝐢𝐭𝐥𝐞     : ${movieInfo.title || selectedItem.title}\n│ ⭐ 𝐈𝐌𝐃𝐁      : ${movieInfo.imdb || movieInfo.rating || 'N/A'}\n│ 📅 𝐘𝐞𝐚𝐫      : ${movieInfo.year || 'N/A'}\n│ ⏳ 𝐃𝐮𝐫𝐚𝐭𝐢𝐨𝐧   : ${movieInfo.duration || 'N/A'}\n│ 🌍 𝐂𝐨𝐮𝐧𝐭𝐫𝐲   : ${movieInfo.country || 'N/A'}\n│ 🎭 𝐆𝐞𝐧𝐫𝐞𝐬    : ${Array.isArray(movieInfo.genres) ? movieInfo.genres.join(', ') : 'N/A'}\n│ 🗣️ 𝐋𝐚𝐧𝐠𝐮𝐚𝐠𝐞   : ${movieInfo.language || movieInfo.tag || 'N/A'}\n│ 🎬 𝐃𝐢𝐫𝐞𝐜𝐭𝐨𝐫  : ${movieInfo.directors || movieInfo.director || 'N/A'}\n│ ⭐ 𝐒𝐭𝐚𝐫𝐬     : ${movieInfo.stars || 'N/A'}\n│\n╰━━━━━━━━━━━━━━━━⬣\n\n📝 *𝐒𝐓𝐎𝐑𝐘*\n${story.length > 250 ? story.substring(0, 250) + '...' : story}\n\n📥 *𝐒𝐄𝐋𝐄𝐂𝐓 𝐐𝐔𝐀𝐋𝐈𝐓𝐘*\n\n${qualityRows}\n\n💬 *Reply with the corresponding number.*\n${PUPIL_FOOTER}`;

                    const posterUrl = movieInfo.image || selectedItem.image || PUPIL_DEFAULT_IMAGE;
                    let detailsMsg;
                    try {
                        detailsMsg = await socket.sendMessage(sender, { image: { url: posterUrl }, caption: movieDetailsText }, { quoted: replyMek });
                    } catch (e) {
                        detailsMsg = await socket.sendMessage(sender, { text: movieDetailsText }, { quoted: replyMek });
                    }
                    const optionsMsgID = detailsMsg.key.id;
                    pupilvideoPendingMsg.set(sender, { msgId: optionsMsgID, kind: 'quality', ts: Date.now() });

                    const handleDownload = async ({ messages: downloadMessages }) => {
                        const downloadMek = downloadMessages[0];
                        if (!downloadMek?.message) return;
                        if (!(await mayProcessSelectionReply(socket, downloadMek))) return;

                        const downloadChoice = downloadMek.message.conversation || downloadMek.message.extendedTextMessage?.text;
                        const isReplyToOptionsMsg = downloadMek.message.extendedTextMessage?.contextInfo?.stanzaId === optionsMsgID;
                        const pendingHere2 = pupilvideoPendingMsg.get(sender);
                        const isPlainNum2 = /^\d+$/.test(String(downloadChoice || '').trim());
                        const plainQualityOk = isPlainNum2 && !!pendingHere2 && pendingHere2.kind === 'quality' && pendingHere2.msgId === optionsMsgID &&
                            (!downloadMek.key.participant || downloadMek.key.participant === pupilRequester);

                        if ((isReplyToOptionsMsg || plainQualityOk) && sender === downloadMek.key.remoteJid) {
                            const choiceNum = parseInt(downloadChoice, 10) - 1;
                            if (isNaN(choiceNum) || choiceNum < 0 || choiceNum >= validDownloads.length) {
                                await socket.sendMessage(sender, { text: `*❪ INVALID ❫*\n\n⚠️ *Wrong Number!*\n🎯 *Range:* _01 - ${validDownloads.length}_\n📝 _Please reply with a valid number!_${PUPIL_FOOTER}` }, { quoted: downloadMek });
                                return;
                            }

                            const selectedDownload = validDownloads[choiceNum];
                            const quality = String(selectedDownload.quality || 'Download').substring(0, 25);

                            await socket.sendMessage(sender, { react: { text: '⏳', key: downloadMek.key } });
                            await socket.sendMessage(sender, { text: `*❪ SENDING MOVIE ❫*\n\n📥 *Sending:* _${movieInfo.title}_\n📊 *Quality:* _${quality}_\n💾 *Size:* _${selectedDownload.size || 'N/A'}_\n⚡ _Uploading file to WhatsApp..._${PUPIL_FOOTER}` }, { quoted: downloadMek });

                            try {
                                await socket.sendMessage(sender, {
                                    document: { url: selectedDownload.link },
                                    mimetype: 'video/mp4',
                                    fileName: `${movieInfo.title} (${quality}).mp4`,
                                    caption: `*🎬 𝗜𝗦𝗛𝗔𝗡 𝗖𝗜𝗡𝗘 𝗠𝗢𝗩𝗜𝗘 🎬*\n\n🎭 *Title:* ${movieInfo.title}\n🌟 *IMDB:* ${movieInfo.imdb || movieInfo.rating || 'N/A'}\n📅 *Year:* ${movieInfo.year || 'N/A'}\n📊 *Quality:* ${quality}\n💾 *Size:* ${selectedDownload.size || 'N/A'}\n\n${PUPIL_FOOTER}`
                                }, { quoted: downloadMek });
                                await socket.sendMessage(sender, { react: { text: '✅', key: downloadMek.key } });
                            } catch (uploadErr) {
                                console.error('PupilVideo upload error:', uploadErr);
                                await socket.sendMessage(sender, { text: `*❪ UPLOAD FAILED ❫*\n\n❌ *Failed to upload file directly!*\n🔗 *Direct Link:* ${selectedDownload.link}${PUPIL_FOOTER}` }, { quoted: downloadMek });
                            } finally {
                                socket.ev.off('messages.upsert', handleDownload);
                                socket.ev.off('messages.upsert', handleSelection);
                                pendingInlineListeners.delete(sender);
                            }
                        }
                    };

                    pendingInlineListeners.add(sender);
                    socket.ev.on('messages.upsert', handleDownload);

                } catch (detailsError) {
                    console.error('PupilVideo details error:', detailsError);
                    await socket.sendMessage(sender, { text: `*❪ ERROR ❫*\n\n❌ *Movie Details Error!*\n🚫 _${detailsError.message}_${PUPIL_FOOTER}` }, { quoted: replyMek });
                    socket.ev.off('messages.upsert', handleSelection);
                    pendingInlineListeners.delete(sender);
                }
            }
        };

        pendingInlineListeners.add(sender);
        socket.ev.on('messages.upsert', handleSelection);

    } catch (error) {
        console.error('PupilVideo command error:', error);
        await socket.sendMessage(sender, { text: `*❪ SYSTEM ERROR ❫*\n\n❌ *System Error!*\n🚫 _${error.message || 'Unknown error'}_\n\n🔄 _Please try again later..._${PUPIL_FOOTER}` }, { quoted: msg });
    }
    break;
}

case 'bestmovies':
case 'bmovies': {
    // 🎥 BestMovies.club (Chama Movie API bestmovies endpoints).
    // Search → movie download links OR TV episode → download links. Reply
    // handling follows the hardened .cartoon/.animost pattern: quote-match OR
    // plain numbered reply (only the latest menu wins), multi-bot @mention
    // gate, retry + friendly timeout errors, and full listener cleanup.
    const BESTMOVIES_FOOTER = `\n\n${config.BOT_FOOTER}`;
    const BESTMOVIES_API_BASE = 'https://api.chamindu.site';
    const BESTMOVIES_API_KEY = 'chama_api_b79c94c8375e3814d622d2cf66b4f52c';
    const BESTMOVIES_DEFAULT_IMAGE = 'https://api.chamindu.site/logo.png';
    const bestmoviesRequester = nowsender; // actual user (not the chat jid) who ran the command

    async function bestmoviesApiGet(url) {
      let lastErr;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          return await axios.get(url, { timeout: 90000 });
        } catch (e) {
          lastErr = e;
          const status = e && e.response && e.response.status;
          const transient = (e && e.code === 'ECONNABORTED') || !e.response || (status >= 500 && status < 600);
          if (!transient || attempt === 1) {
            const body = (e && e.response && e.response.data) || {};
            const detail = String(body.detail || body.message || body.error || '').trim();
            const hay = String(detail || e.message || '').toLowerCase();
            if ((e && e.code === 'ECONNABORTED') || hay.includes('timeout')) {
              throw new Error('The BestMovies API is busy right now (it timed out). Please try again in a moment.');
            }
            throw new Error(e && e.message ? e.message : 'Unknown error');
          }
          await new Promise(r => setTimeout(r, 1500));
        }
      }
      throw lastErr;
    }

    if (!args.length) {
        await socket.sendMessage(sender, {
            text: `*❪ ERROR ❫*\n\n⚠️ *Invalid Usage!*\n\n🎬 *Example:*\n• ${prefix}bestmovies toy story\n• ${prefix}bmovies frozen\n\n📝 _Please provide the Movie or TV Series name!_${BESTMOVIES_FOOTER}`
        }, { quoted: msg });
        break;
    }

    const query = args.join(' ');
    await socket.sendMessage(sender, {
        text: `*❪ SEARCHING ❫*\n\n🔍 *Searching BestMovies.club...*\n⚡ _Please wait a moment._`
    }, { quoted: msg });

    try {
        const searchData = (await bestmoviesApiGet(`${BESTMOVIES_API_BASE}/api/v1/movie/bestmovies/search?q=${encodeURIComponent(query)}&api_key=${BESTMOVIES_API_KEY}`)).data;
        if (!searchData.status || !Array.isArray(searchData.data) || searchData.data.length === 0) {
            await socket.sendMessage(sender, {
                text: `*❪ NO RESULTS ❫*\n\n😞 *No Results Found!*\n\n🎬 *Query:* _${query}_\n💡 *Tip:* _Please check the spelling and try again!_${BESTMOVIES_FOOTER}`
            }, { quoted: msg });
            break;
        }

        const results = searchData.data.slice(0, 25);
        const searchRows = results.map((item, index) => {
            const num = String(index + 1).padStart(2, '0');
            const icon = item.is_tv ? '📺' : '🎥';
            return { num, icon, title: String(item.title || '').substring(0, 45) };
        });

        const searchCaption = `╭━〔 🎥 𝐁𝐄𝐒𝐓𝐌𝐎𝐕𝐈𝐄𝐒 • 𝐒𝐄𝐀𝐑𝐂𝐇 〕━━⬣\n│\n│ 🔎 𝐐𝐮𝐞𝐫𝐲    : ${query}\n│ 📊 𝐑𝐞𝐬𝐮𝐥𝐭𝐬  : ${results.length}\n│ 🌐 𝐒𝐨𝐮𝐫𝐜𝐞   : BestMovies.club\n│\n╰━━━━━━━━━━━━━━━━⬣\n\n📥 *𝐒𝐄𝐋𝐄𝐂𝐓 𝐀 𝐓𝐈𝐓𝐋𝐄*\n\n${searchRows.map(row => `${row.num} ➜ ${row.icon} _${row.title}_`).join('\n')}\n\n💬 *Reply with the corresponding number.*\n${BESTMOVIES_FOOTER}`;

        let sentMsg;
        try {
            sentMsg = await socket.sendMessage(sender, { image: { url: results[0].image || BESTMOVIES_DEFAULT_IMAGE }, caption: searchCaption }, { quoted: msg });
        } catch (e) {
            sentMsg = await socket.sendMessage(sender, { text: searchCaption }, { quoted: msg });
        }
        const messageID = sentMsg.key.id;
        bestmoviesPendingMsg.set(sender, { msgId: messageID, kind: 'search', ts: Date.now() });

        const handleSelection = async ({ messages: replyMessages }) => {
            const replyMek = replyMessages[0];
            if (!replyMek?.message) return;
            if (!(await mayProcessSelectionReply(socket, replyMek))) return;

            const messageType = replyMek.message.conversation || replyMek.message.extendedTextMessage?.text;
            const isReplyToSentMsg = replyMek.message.extendedTextMessage?.contextInfo?.stanzaId === messageID;
            const pendingHere = bestmoviesPendingMsg.get(sender);
            const isPlainNum = /^\d+$/.test(String(messageType || '').trim());
            const plainSearchOk = isPlainNum && !!pendingHere && pendingHere.kind === 'search' && pendingHere.msgId === messageID &&
                (!replyMek.key.participant || replyMek.key.participant === bestmoviesRequester);

            if ((isReplyToSentMsg || plainSearchOk) && sender === replyMek.key.remoteJid) {
                const choice = parseInt(messageType, 10) - 1;
                if (isNaN(choice) || choice < 0 || choice >= results.length) {
                    await socket.sendMessage(sender, { text: `*❪ INVALID ❫*\n\n⚠️ *Wrong Number!*\n🎯 *Range:* _01 - ${results.length}_\n📝 _Please reply with a valid number!_${BESTMOVIES_FOOTER}` }, { quoted: replyMek });
                    return;
                }

                const selectedItem = results[choice];
                const isTvShow = !!selectedItem.is_tv;

                if (isTvShow) {
                    // ---------- TV SERIES FLOW (episodes → download links) ----------
                    await socket.sendMessage(sender, { text: `*❪ FETCHING ❫*\n\n📺 *Fetching TV Series...*\n⚡ _Please wait..._` }, { quoted: replyMek });

                    try {
                        const tvShowData = (await bestmoviesApiGet(`${BESTMOVIES_API_BASE}/api/v1/movie/bestmovies/tv/info?q=${encodeURIComponent(selectedItem.link)}&api_key=${BESTMOVIES_API_KEY}`)).data;
                        if (!tvShowData.status || !tvShowData.data) throw new Error('Failed to fetch TV show details');
                        const tvInfo = tvShowData.data;

                        const description = String(tvInfo.description || 'No description available.');
                        const tvDetailsText = `╭━〔 📺 𝐓𝐕 𝐒𝐄𝐑𝐈𝐄𝐒 𝐃𝐄𝐓𝐀𝐈𝐋𝐒 〕━━⬣\n│\n│ 🎬 𝐓𝐢𝐭𝐥𝐞     : ${tvInfo.title || selectedItem.title}\n│ ⭐ 𝐈𝐌𝐃𝐁      : ${tvInfo.rating || 'N/A'}\n│ 📅 𝐘𝐞𝐚𝐫      : ${tvInfo.year || 'N/A'}\n│ ⏳ 𝐑𝐮𝐧𝐭𝐢𝐦𝐞   : ${tvInfo.duration || 'N/A'}\n│ 🌍 𝐂𝐨𝐮𝐧𝐭𝐫𝐲   : ${tvInfo.country || 'N/A'}\n│ 🎭 𝐆𝐞𝐧𝐫𝐞𝐬    : ${Array.isArray(tvInfo.genres) ? tvInfo.genres.join(', ') : 'N/A'}\n│\n╰━━━━━━━━━━━━━━━━⬣\n\n📝 *𝐒𝐓𝐎𝐑𝐘*\n${description.length > 250 ? description.substring(0, 250) + '...' : description}\n\n🗿 *Web:* bestmovies.club\n${BESTMOVIES_FOOTER}`;

                        const posterUrl = tvInfo.image || selectedItem.image || BESTMOVIES_DEFAULT_IMAGE;
                        try {
                            await socket.sendMessage(sender, { image: { url: posterUrl }, caption: tvDetailsText }, { quoted: replyMek });
                        } catch (e) {
                            await socket.sendMessage(sender, { text: tvDetailsText }, { quoted: replyMek });
                        }

                        // Flat, cross-season episode list with a single counter.
                        const allEpisodes = [];
                        let epListText = `*❪ EPISODES LIST ❫*\n\n📺 *${tvInfo.title}*\n\n`;
                        const seasons = Array.isArray(tvInfo.seasons) ? tvInfo.seasons : [];
                        seasons.forEach((seasonObj) => {
                            const eps = Array.isArray(seasonObj.episodes) ? seasonObj.episodes : [];
                            if (!eps.length) return;
                            epListText += `*■ ${seasonObj.season}*\n`;
                            eps.forEach((ep) => {
                                const epNum = String(allEpisodes.length + 1).padStart(2, '0');
                                epListText += `  *${epNum}* ➜ ${String(ep.episode || 'Episode').substring(0, 40)}\n`;
                                allEpisodes.push(ep);
                            });
                            epListText += `\n`;
                        });
                        epListText += `*👉 Reply with Episode Number to download!*\n${BESTMOVIES_FOOTER}`;

                        if (allEpisodes.length === 0) throw new Error('No episodes found for this TV Series');

                        let epMsg;
                        try {
                            epMsg = await socket.sendMessage(sender, { text: epListText }, { quoted: replyMek });
                        } catch (e) {
                            epMsg = await socket.sendMessage(sender, { text: epListText }, { quoted: replyMek });
                        }
                        const epMessageID = epMsg.key.id;
                        bestmoviesPendingMsg.set(sender, { msgId: epMessageID, kind: 'episodes', ts: Date.now() });

                        const handleEpSelection = async ({ messages: epReplyMessages }) => {
                            const epReplyMek = epReplyMessages[0];
                            if (!epReplyMek?.message) return;
                            if (!(await mayProcessSelectionReply(socket, epReplyMek))) return;

                            const epMsgText = epReplyMek.message.conversation || epReplyMek.message.extendedTextMessage?.text;
                            const isReplyToEpMsg = epReplyMek.message.extendedTextMessage?.contextInfo?.stanzaId === epMessageID;
                            const pendingEp = bestmoviesPendingMsg.get(sender);
                            const isEpPlainNum = /^\d+$/.test(String(epMsgText || '').trim());
                            const plainEpOk = isEpPlainNum && !!pendingEp && pendingEp.kind === 'episodes' && pendingEp.msgId === epMessageID &&
                                (!epReplyMek.key.participant || epReplyMek.key.participant === bestmoviesRequester);

                            if ((isReplyToEpMsg || plainEpOk) && sender === epReplyMek.key.remoteJid) {
                                const epChoice = parseInt(epMsgText, 10) - 1;
                                if (isNaN(epChoice) || epChoice < 0 || epChoice >= allEpisodes.length) {
                                    await socket.sendMessage(sender, { text: `*❪ INVALID ❫*\n\n⚠️ *Wrong Number!*\n🎯 *Range:* _01 - ${allEpisodes.length}_\n📝 _Please reply with a valid number!_${BESTMOVIES_FOOTER}` }, { quoted: epReplyMek });
                                    return;
                                }

                                const episode = allEpisodes[epChoice];
                                await socket.sendMessage(sender, { text: `*❪ RESOLVING ❫*\n\n⏳ *Resolving episode download...*\n⚡ _Please wait a moment._` }, { quoted: epReplyMek });

                                try {
                                    const epDlData = (await bestmoviesApiGet(`${BESTMOVIES_API_BASE}/api/v1/movie/bestmovies/tv/dl?q=${encodeURIComponent(episode.link)}&api_key=${BESTMOVIES_API_KEY}`)).data;
                                    if (!epDlData.status || !Array.isArray(epDlData.data) || epDlData.data.length === 0) throw new Error('Failed to resolve episode downloads');

                                    // Send the episode FILE as a document (never just a link).
                                    const nonTelegramLinks = epDlData.data.filter(l => l && l.link && !String(l.link).includes('t.me') && !String(l.link).includes('telegram'));
                                    const finalLinkObj = nonTelegramLinks[0] || epDlData.data[0];
                                    if (!finalLinkObj || !finalLinkObj.link) throw new Error('No usable download link for this episode');
                                    await socket.sendMessage(sender, {
                                        document: { url: finalLinkObj.link },
                                        mimetype: 'video/mp4',
                                        fileName: `${String(tvInfo.title || 'series').substring(0, 40)} - ${String(episode.episode || 'episode').substring(0, 40)}.mp4`.replace(/[^\w\s.-]/gi, ''),
                                        caption: `*📺 𝗕𝗘𝗦𝗧𝗠𝗢𝗩𝗜𝗘𝗦 𝗘𝗣𝗜𝗦𝗢𝗗𝗘 📺*\n\n🎭 *Title:* ${tvInfo.title}\n📌 *Episode:* ${String(episode.episode || 'Episode').substring(0, 40)}\n📊 *Quality:* ${finalLinkObj.quality || 'Direct MP4'}\n💾 *Size:* ${finalLinkObj.size || 'N/A'}\n\n${BESTMOVIES_FOOTER}`
                                    }, { quoted: epReplyMek });
                                } catch (epDlErr) {
                                    console.error('BestMovies episode download error:', epDlErr);
                                    await socket.sendMessage(sender, { text: `*❪ ERROR ❫*\n\n❌ *Failed to resolve downloads!*\n🚫 _${epDlErr.message}_${BESTMOVIES_FOOTER}` }, { quoted: epReplyMek });
                                } finally {
                                    socket.ev.off('messages.upsert', handleEpSelection);
                                    socket.ev.off('messages.upsert', handleSelection);
                                    pendingInlineListeners.delete(sender);
                                }
                            }
                        };

                        pendingInlineListeners.add(sender);
                        socket.ev.on('messages.upsert', handleEpSelection);

                    } catch (tvError) {
                        console.error('BestMovies TV details error:', tvError);
                        await socket.sendMessage(sender, { text: `*❪ ERROR ❫*\n\n❌ *TV Show Details Error!*\n🚫 _${tvError.message}_${BESTMOVIES_FOOTER}` }, { quoted: replyMek });
                        socket.ev.off('messages.upsert', handleSelection);
                        pendingInlineListeners.delete(sender);
                    }

                } else {
                    // ---------- MOVIE FLOW (details + download links) ----------
                    await socket.sendMessage(sender, { text: `*❪ FETCHING ❫*\n\n🎥 *Fetching movie details...*\n⚡ _Please wait..._` }, { quoted: replyMek });

                    try {
                        const detailsData = (await bestmoviesApiGet(`${BESTMOVIES_API_BASE}/api/v1/movie/bestmovies/infodl?q=${encodeURIComponent(selectedItem.link)}&api_key=${BESTMOVIES_API_KEY}`)).data;
                        if (!detailsData.status || !detailsData.data) throw new Error('Failed to fetch movie details');
                        const movieInfo = detailsData.data;

                        const description = String(movieInfo.description || 'No description available.');
                        const movieDetailsText = `╭━〔 🎥 𝐌𝐎𝐕𝐈𝐄 𝐃𝐄𝐓𝐀𝐈𝐋𝐒 〕━━⬣\n│\n│ 🎬 𝐓𝐢𝐭𝐥𝐞     : ${movieInfo.title || selectedItem.title}\n│ ⭐ 𝐈𝐌𝐃𝐁      : ${movieInfo.imdb || movieInfo.rating || 'N/A'}\n│ 📅 𝐘𝐞𝐚𝐫      : ${movieInfo.year || 'N/A'}\n│ ⏳ 𝐃𝐮𝐫𝐚𝐭𝐢𝐨𝐧   : ${movieInfo.duration || 'N/A'}\n│ 🌍 𝐂𝐨𝐮𝐧𝐭𝐫𝐲   : ${movieInfo.country || 'N/A'}\n│ 🎭 𝐆𝐞𝐧𝐫𝐞𝐬    : ${Array.isArray(movieInfo.genres) ? movieInfo.genres.join(', ') : 'N/A'}\n│ 🎬 𝐃𝐢𝐫𝐞𝐜𝐭𝐨𝐫  : ${movieInfo.director || 'N/A'}\n│\n╰━━━━━━━━━━━━━━━━⬣\n\n📝 *𝐃𝐄𝐒𝐂𝐑𝐈𝐏𝐓𝐈𝐎𝐍*\n${description.length > 250 ? description.substring(0, 250) + '...' : description}\n\n🗿 *Web:* bestmovies.club\n${BESTMOVIES_FOOTER}`;

                        const posterUrl = movieInfo.image || selectedItem.image || BESTMOVIES_DEFAULT_IMAGE;
                        try {
                            await socket.sendMessage(sender, { image: { url: posterUrl }, caption: movieDetailsText }, { quoted: replyMek });
                        } catch (e) {
                            await socket.sendMessage(sender, { text: movieDetailsText }, { quoted: replyMek });
                        }

                        const downloads = Array.isArray(movieInfo.downloads) ? movieInfo.downloads.filter(d => d && (d.link || d.url)) : [];
                        if (downloads.length === 0) {
                            await socket.sendMessage(sender, { text: `*❪ NO DOWNLOADS ❫*\n\n⚠️ *No Downloads Found!*\n😞 _There are no downloads available for this movie!_${BESTMOVIES_FOOTER}` }, { quoted: replyMek });
                            socket.ev.off('messages.upsert', handleSelection);
                            pendingInlineListeners.delete(sender);
                            return;
                        }

                        // Quality pick menu — the user picks a number, then the
                        // actual FILE is sent as a document (never just a link).
                        let qMsg = `*❪ SELECT QUALITY ❫*\n\n🎬 *${movieInfo.title}*\n\n`;
                        downloads.forEach((dl, i) => {
                            qMsg += `*${String(i + 1).padStart(2, '0')}* ➜ _${String(dl.quality || 'Download').substring(0, 40)}_ 💾 _${dl.size || 'N/A'}_\n`;
                        });
                        qMsg += `\n💬 *Reply with the corresponding number.*${BESTMOVIES_FOOTER}`;

                        const qMsgSent = await socket.sendMessage(sender, { text: qMsg }, { quoted: replyMek });
                        const qMsgID = qMsgSent.key.id;
                        bestmoviesPendingMsg.set(sender, { msgId: qMsgID, kind: 'quality', ts: Date.now() });

                        const handleDownload = async ({ messages: downloadMessages }) => {
                            const downloadMek = downloadMessages[0];
                            if (!downloadMek?.message) return;
                            if (!(await mayProcessSelectionReply(socket, downloadMek))) return;

                            const downloadChoice = downloadMek.message.conversation || downloadMek.message.extendedTextMessage?.text;
                            const isReplyToQMsg = downloadMek.message.extendedTextMessage?.contextInfo?.stanzaId === qMsgID;
                            const pendingHere2 = bestmoviesPendingMsg.get(sender);
                            const isPlainNum2 = /^\d+$/.test(String(downloadChoice || '').trim());
                            const plainQualityOk = isPlainNum2 && !!pendingHere2 && pendingHere2.kind === 'quality' && pendingHere2.msgId === qMsgID &&
                                (!downloadMek.key.participant || downloadMek.key.participant === bestmoviesRequester);

                            if ((isReplyToQMsg || plainQualityOk) && sender === downloadMek.key.remoteJid) {
                                const choiceNum = parseInt(downloadChoice, 10) - 1;
                                if (isNaN(choiceNum) || choiceNum < 0 || choiceNum >= downloads.length) {
                                    await socket.sendMessage(sender, { text: `*❪ INVALID ❫*\n\n⚠️ *Wrong Number!*\n🎯 *Range:* _01 - ${downloads.length}_\n📝 _Please reply with a valid number!_${BESTMOVIES_FOOTER}` }, { quoted: downloadMek });
                                    return;
                                }

                                const selectedDownload = downloads[choiceNum];
                                const quality = String(selectedDownload.quality || 'Download').substring(0, 25);

                                await socket.sendMessage(sender, { react: { text: '📥', key: downloadMek.key } });
                                try {
                                    const finalDirectLink = selectedDownload.link || selectedDownload.url;
                                    await socket.sendMessage(sender, {
                                        document: { url: finalDirectLink },
                                        mimetype: 'video/mp4',
                                        fileName: `${String(movieInfo.title || 'movie').substring(0, 40)} - ${quality}.mp4`.replace(/[^\w\s.-]/gi, ''),
                                        caption: `*🎬 𝗕𝗘𝗦𝗧𝗠𝗢𝗩𝗜𝗘𝗦 🎬*\n\n🎭 *Title:* ${movieInfo.title}\n🌟 *IMDB:* ${movieInfo.imdb || movieInfo.rating || 'N/A'}\n📅 *Year:* ${movieInfo.year || 'N/A'}\n📊 *Quality:* ${quality}\n💾 *Size:* ${selectedDownload.size || 'N/A'}\n\n${BESTMOVIES_FOOTER}`
                                    }, { quoted: downloadMek });
                                    await socket.sendMessage(sender, { react: { text: '✅', key: downloadMek.key } });
                                } catch (downloadError) {
                                    console.error('BestMovies download error:', downloadError);
                                    await socket.sendMessage(sender, { text: `*❪ ERROR ❫*\n\n❌ *Download Failed!*\n🚫 _${downloadError.message}_${BESTMOVIES_FOOTER}` }, { quoted: downloadMek });
                                } finally {
                                    socket.ev.off('messages.upsert', handleDownload);
                                    socket.ev.off('messages.upsert', handleSelection);
                                    pendingInlineListeners.delete(sender);
                                }
                            }
                        };

                        pendingInlineListeners.add(sender);
                        socket.ev.on('messages.upsert', handleDownload);
                    } catch (detailsError) {
                        console.error('BestMovies details error:', detailsError);
                        await socket.sendMessage(sender, { text: `*❪ ERROR ❫*\n\n❌ *Movie Details Error!*\n🚫 _${detailsError.message}_${BESTMOVIES_FOOTER}` }, { quoted: replyMek });
                        socket.ev.off('messages.upsert', handleSelection);
                        pendingInlineListeners.delete(sender);
                    }
                }
            }
        };

        pendingInlineListeners.add(sender);
        socket.ev.on('messages.upsert', handleSelection);

    } catch (error) {
        console.error('BestMovies command error:', error);
        await socket.sendMessage(sender, { text: `*❪ SYSTEM ERROR ❫*\n\n❌ *System Error!*\n🚫 _${error.message || 'Unknown error'}_\n\n🔄 _Please try again later..._${BESTMOVIES_FOOTER}` }, { quoted: msg });
    }
    break;
}

case 'moviesublk':
case 'msublk': {
    // 🎥 MovieSubLK (Chama Movie API moviesublk endpoints).
    // Search → movie quality pick OR TV season auto-download. Reply handling
    // follows the hardened .cartoon/.animost pattern: quote-match OR plain
    // numbered reply (only the latest menu wins), multi-bot @mention gate,
    // retry + friendly timeout errors, and full listener cleanup.
    const MOVIESUBLK_FOOTER = `\n\n${config.BOT_FOOTER}`;
    const MOVIESUBLK_API_BASE = 'https://api.chamindu.site';
    const MOVIESUBLK_API_KEY = 'chama_api_b79c94c8375e3814d622d2cf66b4f52c';
    const MOVIESUBLK_DEFAULT_IMAGE = 'https://api.chamindu.site/logo.png';
    const moviesublkRequester = nowsender; // actual user (not the chat jid) who ran the command

    async function moviesublkApiGet(url) {
      let lastErr;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          return await axios.get(url, { timeout: 90000 });
        } catch (e) {
          lastErr = e;
          const status = e && e.response && e.response.status;
          const transient = (e && e.code === 'ECONNABORTED') || !e.response || (status >= 500 && status < 600);
          if (!transient || attempt === 1) {
            const body = (e && e.response && e.response.data) || {};
            const detail = String(body.detail || body.message || body.error || '').trim();
            const hay = String(detail || e.message || '').toLowerCase();
            if ((e && e.code === 'ECONNABORTED') || hay.includes('timeout')) {
              throw new Error('The MovieSubLK API is busy right now (it timed out). Please try again in a moment.');
            }
            throw new Error(e && e.message ? e.message : 'Unknown error');
          }
          await new Promise(r => setTimeout(r, 1500));
        }
      }
      throw lastErr;
    }

    if (!args.length) {
        await socket.sendMessage(sender, {
            text: `*❪ ERROR ❫*\n\n⚠️ *Invalid Usage!*\n\n🎬 *Example:*\n• ${prefix}moviesublk spider man\n• ${prefix}msublk game of thrones\n\n📝 _Please provide the Movie or TV Series name!_${MOVIESUBLK_FOOTER}`
        }, { quoted: msg });
        break;
    }

    const query = args.join(' ');
    await socket.sendMessage(sender, {
        text: `*❪ SEARCHING ❫*\n\n🔍 *Searching MovieSubLK...*\n⚡ _Please wait a moment._`
    }, { quoted: msg });

    try {
        const searchData = (await moviesublkApiGet(`${MOVIESUBLK_API_BASE}/api/v1/movie/moviesublk/search?q=${encodeURIComponent(query)}&api_key=${MOVIESUBLK_API_KEY}`)).data;
        if (!searchData.status || !Array.isArray(searchData.data) || searchData.data.length === 0) {
            await socket.sendMessage(sender, {
                text: `*❪ NO RESULTS ❫*\n\n😞 *No Results Found!*\n\n🎬 *Query:* _${query}_\n💡 *Tip:* _Please check the spelling and try again!_${MOVIESUBLK_FOOTER}`
            }, { quoted: msg });
            break;
        }

        const results = searchData.data.slice(0, 25);
        const searchRows = results.map((item, index) => {
            const num = String(index + 1).padStart(2, '0');
            const icon = item.type === 'tvshows' ? '📺' : '🎥';
            return { num, icon, title: String(item.title || '').substring(0, 45) };
        });

        const searchCaption = `╭━〔 🎥 𝐌𝐎𝐕𝐈𝐄𝐒𝐔𝐁𝐋𝐊 • 𝐒𝐄𝐀𝐑𝐂𝐇 〕━━⬣\n│\n│ 🔎 𝐐𝐮𝐞𝐫𝐲    : ${query}\n│ 📊 𝐑𝐞𝐬𝐮𝐥𝐭𝐬  : ${results.length}\n│ 🌐 𝐒𝐨𝐮𝐫𝐜𝐞   : MovieSubLK\n│\n╰━━━━━━━━━━━━━━━━⬣\n\n📥 *𝐒𝐄𝐋𝐄𝐂𝐓 𝐀 𝐓𝐈𝐓𝐋𝐄*\n\n${searchRows.map(row => `${row.num} ➜ ${row.icon} _${row.title}_`).join('\n')}\n\n💬 *Reply with the corresponding number.*\n${MOVIESUBLK_FOOTER}`;

        let sentMsg;
        try {
            sentMsg = await socket.sendMessage(sender, { image: { url: results[0].image || MOVIESUBLK_DEFAULT_IMAGE }, caption: searchCaption }, { quoted: msg });
        } catch (e) {
            sentMsg = await socket.sendMessage(sender, { text: searchCaption }, { quoted: msg });
        }
        const messageID = sentMsg.key.id;
        moviesublkPendingMsg.set(sender, { msgId: messageID, kind: 'search', ts: Date.now() });

        const handleSelection = async ({ messages: replyMessages }) => {
            const replyMek = replyMessages[0];
            if (!replyMek?.message) return;
            if (!(await mayProcessSelectionReply(socket, replyMek))) return;

            const messageType = replyMek.message.conversation || replyMek.message.extendedTextMessage?.text;
            const isReplyToSentMsg = replyMek.message.extendedTextMessage?.contextInfo?.stanzaId === messageID;
            const pendingHere = moviesublkPendingMsg.get(sender);
            const isPlainNum = /^\d+$/.test(String(messageType || '').trim());
            const plainSearchOk = isPlainNum && !!pendingHere && pendingHere.kind === 'search' && pendingHere.msgId === messageID &&
                (!replyMek.key.participant || replyMek.key.participant === moviesublkRequester);

            if ((isReplyToSentMsg || plainSearchOk) && sender === replyMek.key.remoteJid) {
                const choice = parseInt(messageType, 10) - 1;
                if (isNaN(choice) || choice < 0 || choice >= results.length) {
                    await socket.sendMessage(sender, { text: `*❪ INVALID ❫*\n\n⚠️ *Wrong Number!*\n🎯 *Range:* _01 - ${results.length}_\n📝 _Please reply with a valid number!_${MOVIESUBLK_FOOTER}` }, { quoted: replyMek });
                    return;
                }

                const selectedItem = results[choice];
                const isTvShow = selectedItem.type === 'tvshows';

                if (isTvShow) {
                    // ---------- TV SERIES FLOW (auto-download all episodes) ----------
                    await socket.sendMessage(sender, { text: `*❪ FETCHING ❫*\n\n📺 *Fetching TV Series...*\n⚡ _Please wait..._` }, { quoted: replyMek });

                    try {
                        const tvShowData = (await moviesublkApiGet(`${MOVIESUBLK_API_BASE}/api/v1/movie/moviesublk/tv/info?q=${encodeURIComponent(selectedItem.link)}&api_key=${MOVIESUBLK_API_KEY}`)).data;
                        if (!tvShowData.status || !tvShowData.data) throw new Error('Failed to fetch TV show details');
                        const tvInfo = tvShowData.data;

                        const story = String(tvInfo.story || 'No description available.');
                        const tvDetailsText = `╭━〔 📺 𝐓𝐕 𝐒𝐄𝐑𝐈𝐄𝐒 𝐃𝐄𝐓𝐀𝐈𝐋𝐒 〕━━⬣\n│\n│ 🎬 𝐓𝐢𝐭𝐥𝐞     : ${tvInfo.title || selectedItem.title}\n│ ⭐ 𝐈𝐌𝐃𝐁      : ${tvInfo.rating || 'N/A'}\n│ 📅 𝐘𝐞𝐚𝐫      : ${tvInfo.year || 'N/A'}\n│ ⏳ 𝐑𝐮𝐧𝐭𝐢𝐦𝐞   : ${tvInfo.duration || 'N/A'}\n│ 🌍 𝐂𝐨𝐮𝐧𝐭𝐫𝐲   : ${tvInfo.country || 'N/A'}\n│ 🎭 𝐆𝐞𝐧𝐫𝐞𝐬    : ${Array.isArray(tvInfo.genres) ? tvInfo.genres.join(', ') : 'N/A'}\n│\n╰━━━━━━━━━━━━━━━━⬣\n\n📝 *𝐒𝐓𝐎𝐑𝐘*\n${story.length > 250 ? story.substring(0, 250) + '...' : story}\n\n🗿 *Web:* moviesublk.xyz\n${MOVIESUBLK_FOOTER}`;

                        const posterUrl = tvInfo.image || selectedItem.image || MOVIESUBLK_DEFAULT_IMAGE;
                        try {
                            await socket.sendMessage(sender, { image: { url: posterUrl }, caption: tvDetailsText }, { quoted: replyMek });
                        } catch (e) {
                            await socket.sendMessage(sender, { text: tvDetailsText }, { quoted: replyMek });
                        }

                        const episodes = Array.isArray(tvInfo.episodes) ? tvInfo.episodes : [];
                        if (episodes.length === 0) throw new Error('No episodes found for this TV Series');

                        await socket.sendMessage(sender, { text: `*❪ DOWNLOAD EPISODES ❫*\n\n📺 *Series:* _${tvInfo.title}_\n🎬 *Episodes:* _${episodes.length}_\n⚡ _Starting download process..._${MOVIESUBLK_FOOTER}` }, { quoted: replyMek });

                        let successCount = 0;
                        let failCount = 0;
                        for (let i = 0; i < episodes.length; i++) {
                            const episode = episodes[i];
                            try {
                                const epDlData = (await moviesublkApiGet(`${MOVIESUBLK_API_BASE}/api/v1/movie/moviesublk/tv/dl?q=${encodeURIComponent(episode.episode_url)}&api_key=${MOVIESUBLK_API_KEY}`)).data;
                                if (epDlData.status && Array.isArray(epDlData.data) && epDlData.data.length > 0) {
                                    const nonTelegramLinks = epDlData.data.filter(l => l && l.link && !String(l.link).includes('t.me') && !String(l.link).includes('telegram'));
                                    const finalLinkObj = nonTelegramLinks[0] || epDlData.data[0];

                                    await socket.sendMessage(sender, {
                                        document: { url: finalLinkObj.link },
                                        mimetype: 'video/mp4',
                                        fileName: `${tvInfo.title} - ${episode.episode_name}.mp4`,
                                        caption: `*📺 𝗜𝗦𝗛𝗔𝗡 𝗖𝗜𝗡𝗘 𝗦𝗘𝗥𝗜𝗘𝗦 📺*\n\n🎭 *Title:* ${tvInfo.title}\n📌 *Episode:* ${episode.episode_name}\n📊 *Quality:* Direct MP4\n\n${MOVIESUBLK_FOOTER}`
                                    }, { quoted: replyMek });

                                    successCount++;
                                } else {
                                    failCount++;
                                }
                            } catch (epError) {
                                console.error('MovieSubLK episode download error:', epError);
                                failCount++;
                            }
                            // Anti-spam pacing: never send two media messages back-to-back.
                            await delay(2500);
                        }

                        await socket.sendMessage(sender, { text: `*❪ SUMMARY ❫*\n\n🎉 *Download Complete!*\n\n🎬 *Series:* _${tvInfo.title}_\n✅ *Success:* _${successCount} Episodes_\n❌ *Failed:* _${failCount} Episodes_${MOVIESUBLK_FOOTER}` }, { quoted: replyMek });
                    } catch (tvShowError) {
                        console.error('MovieSubLK TV show error:', tvShowError);
                        await socket.sendMessage(sender, { text: `*❪ ERROR ❫*\n\n❌ *TV Details Error!*\n🚫 _${tvShowError.message}_${MOVIESUBLK_FOOTER}` }, { quoted: replyMek });
                    } finally {
                        socket.ev.off('messages.upsert', handleSelection);
                        pendingInlineListeners.delete(sender);
                    }

                } else {
                    // ---------- MOVIE FLOW ----------
                    await socket.sendMessage(sender, { text: `*❪ FETCHING ❫*\n\n🎬 *Fetching Movie...*\n⚡ _Please wait..._` }, { quoted: replyMek });

                    try {
                        const detailsData = (await moviesublkApiGet(`${MOVIESUBLK_API_BASE}/api/v1/movie/moviesublk/infodl?q=${encodeURIComponent(selectedItem.link)}&api_key=${MOVIESUBLK_API_KEY}`)).data;
                        if (!detailsData.status || !detailsData.data) throw new Error('Failed to fetch details');
                        const movieInfo = detailsData.data;

                        const validDownloads = Array.isArray(movieInfo.downloads)
                            ? movieInfo.downloads.filter(d => d && (d.link || d.url))
                            : [];

                        if (validDownloads.length === 0) {
                            await socket.sendMessage(sender, { text: `*❪ NO DOWNLOADS ❫*\n\n⚠️ *No Downloads Found!*\n😞 _There are no downloads available for this movie!_${MOVIESUBLK_FOOTER}` }, { quoted: replyMek });
                            socket.ev.off('messages.upsert', handleSelection);
                            pendingInlineListeners.delete(sender);
                            return;
                        }

                        const story = String(movieInfo.story || 'No description available.');
                        const qualityRows = validDownloads.map((dl, i) => {
                            const num = String(i + 1).padStart(2, '0');
                            const icon = String(dl.quality || '').includes('1080') ? '🔥' : String(dl.quality || '').includes('720') ? '💎' : '📱';
                            return `${num} ➜ ${icon} _${String(dl.quality || 'Download').substring(0, 40)}_ 💾 _${dl.size || 'N/A'}_`;
                        }).join('\n');

                        const movieDetailsText = `╭━〔 🎥 𝐌𝐎𝐕𝐈𝐄 𝐃𝐄𝐓𝐀𝐈𝐋𝐒 〕━━⬣\n│\n│ 🎬 𝐓𝐢𝐭𝐥𝐞     : ${movieInfo.title || selectedItem.title}\n│ ⭐ 𝐈𝐌𝐃𝐁      : ${movieInfo.imdb || movieInfo.rating || 'N/A'}\n│ 📅 𝐘𝐞𝐚𝐫      : ${movieInfo.year || 'N/A'}\n│ ⏳ 𝐃𝐮𝐫𝐚𝐭𝐢𝐨𝐧   : ${movieInfo.duration || 'N/A'}\n│ 🌍 𝐂𝐨𝐮𝐧𝐭𝐫𝐲   : ${movieInfo.country || 'N/A'}\n│ 🎭 𝐆𝐞𝐧𝐫𝐞𝐬    : ${Array.isArray(movieInfo.genres) ? movieInfo.genres.join(', ') : 'N/A'}\n│ 🗣️ 𝐋𝐚𝐧𝐠𝐮𝐚𝐠𝐞   : ${movieInfo.language || movieInfo.tag || 'N/A'}\n│ 🎬 𝐃𝐢𝐫𝐞𝐜𝐭𝐨𝐫  : ${movieInfo.directors || movieInfo.director || 'N/A'}\n│ ⭐ 𝐒𝐭𝐚𝐫𝐬     : ${movieInfo.stars || 'N/A'}\n│\n╰━━━━━━━━━━━━━━━━⬣\n\n📝 *𝐒𝐓𝐎𝐑𝐘*\n${story.length > 250 ? story.substring(0, 250) + '...' : story}\n\n📥 *𝐒𝐄𝐋𝐄𝐂𝐓 𝐐𝐔𝐀𝐋𝐈𝐓𝐘*\n\n${qualityRows}\n\n💬 *Reply with the corresponding number.*\n${MOVIESUBLK_FOOTER}`;

                        const posterUrl = movieInfo.image || selectedItem.image || MOVIESUBLK_DEFAULT_IMAGE;
                        let detailsMsg;
                        try {
                            detailsMsg = await socket.sendMessage(sender, { image: { url: posterUrl }, caption: movieDetailsText }, { quoted: replyMek });
                        } catch (e) {
                            detailsMsg = await socket.sendMessage(sender, { text: movieDetailsText }, { quoted: replyMek });
                        }
                        const optionsMsgID = detailsMsg.key.id;
                        moviesublkPendingMsg.set(sender, { msgId: optionsMsgID, kind: 'quality', ts: Date.now() });

                        const handleDownload = async ({ messages: downloadMessages }) => {
                            const downloadMek = downloadMessages[0];
                            if (!downloadMek?.message) return;
                            if (!(await mayProcessSelectionReply(socket, downloadMek))) return;

                            const downloadChoice = downloadMek.message.conversation || downloadMek.message.extendedTextMessage?.text;
                            const isReplyToOptionsMsg = downloadMek.message.extendedTextMessage?.contextInfo?.stanzaId === optionsMsgID;
                            const pendingHere2 = moviesublkPendingMsg.get(sender);
                            const isPlainNum2 = /^\d+$/.test(String(downloadChoice || '').trim());
                            const plainQualityOk = isPlainNum2 && !!pendingHere2 && pendingHere2.kind === 'quality' && pendingHere2.msgId === optionsMsgID &&
                                (!downloadMek.key.participant || downloadMek.key.participant === moviesublkRequester);

                            if ((isReplyToOptionsMsg || plainQualityOk) && sender === downloadMek.key.remoteJid) {
                                const choiceNum = parseInt(downloadChoice, 10) - 1;
                                if (isNaN(choiceNum) || choiceNum < 0 || choiceNum >= validDownloads.length) {
                                    await socket.sendMessage(sender, { text: `*❪ INVALID ❫*\n\n⚠️ *Wrong Number!*\n🎯 *Range:* _01 - ${validDownloads.length}_\n📝 _Please reply with a valid number!_${MOVIESUBLK_FOOTER}` }, { quoted: downloadMek });
                                    return;
                                }

                                const selectedDownload = validDownloads[choiceNum];
                                const quality = String(selectedDownload.quality || 'Download').substring(0, 25);

                                await socket.sendMessage(sender, { react: { text: '📥', key: downloadMek.key } });
                                try {
                                    const finalDirectLink = selectedDownload.link || selectedDownload.url;

                                    await socket.sendMessage(sender, {
                                        document: { url: finalDirectLink },
                                        mimetype: 'video/mp4',
                                        fileName: `${movieInfo.title} - ${quality}.mp4`,
                                        caption: `*🎬 𝗜𝗦𝗛𝗔𝗡 𝗖𝗜𝗡𝗘 𝗠𝗢𝗩𝗜𝗘 🎬*\n\n🎭 *Title:* ${movieInfo.title}\n🌟 *IMDB:* ${movieInfo.imdb || movieInfo.rating || 'N/A'}\n📅 *Year:* ${movieInfo.year || 'N/A'}\n📊 *Quality:* ${quality}\n💾 *Size:* ${selectedDownload.size || 'N/A'}\n\n${MOVIESUBLK_FOOTER}`
                                    }, { quoted: downloadMek });

                                    await socket.sendMessage(sender, { react: { text: '✅', key: downloadMek.key } });
                                } catch (downloadError) {
                                    console.error('MovieSubLK download error:', downloadError);
                                    await socket.sendMessage(sender, { text: `*❪ ERROR ❫*\n\n❌ *Download Failed!*\n🚫 _${downloadError.message}_${MOVIESUBLK_FOOTER}` }, { quoted: downloadMek });
                                } finally {
                                    socket.ev.off('messages.upsert', handleDownload);
                                    socket.ev.off('messages.upsert', handleSelection);
                                    pendingInlineListeners.delete(sender);
                                }
                            }
                        };

                        pendingInlineListeners.add(sender);
                        socket.ev.on('messages.upsert', handleDownload);

                    } catch (detailsError) {
                        console.error('MovieSubLK details error:', detailsError);
                        await socket.sendMessage(sender, { text: `*❪ ERROR ❫*\n\n❌ *Movie Details Error!*\n🚫 _${detailsError.message}_${MOVIESUBLK_FOOTER}` }, { quoted: replyMek });
                        socket.ev.off('messages.upsert', handleSelection);
                        pendingInlineListeners.delete(sender);
                    }
                }
            }
        };

        pendingInlineListeners.add(sender);
        socket.ev.on('messages.upsert', handleSelection);

    } catch (error) {
        console.error('MovieSubLK command error:', error);
        await socket.sendMessage(sender, { text: `*❪ SYSTEM ERROR ❫*\n\n❌ *System Error!*\n🚫 _${error.message || 'Unknown error'}_\n\n🔄 _Please try again later..._${MOVIESUBLK_FOOTER}` }, { quoted: msg });
    }
    break;
}

// ==================== CINEFR (send movie to a JID) ====================
// .cinefr <destJid> <movie name> → search → pick movie → pick ONE quality →
// download → send the document DIRECTLY to <destJid>. The JID always comes
// from the command itself (never a global/hard-coded one), and stays attached
// to the requester's session. Full flow is driven by handleCinefrReply() in
// the non-command branch; this case only parses the command and seeds it.
case 'cinefr':
case 'cinetvfr': {
    // .cinetvfr is the TV-series-forward alias of .cinefr — same search →
    // episode → quality flow, same per-user custom footer (set via
    // .cinefrfooter / .cinetvfrfooter).
    const destJid = (args[0] || '').trim();
    const cinefrQuery = args.slice(1).join(' ').trim();

    if (!destJid) {
        return await socket.sendMessage(sender, {
            text: `*❪ ERROR ❫*\n\n⚠️ *Missing destination JID!*\n\n🎬 *Usage:*\n• ${prefix}cinefr <jid> <movie name>\n• ${prefix}cinefr 120999@g.us Spider Man\n\n📝 _Send the movie directly to the provided JID._\n\n${config.BOT_FOOTER}`
        }, { quoted: msg });
    }
    if (!/^\d+@(g\.us|s\.whatsapp\.net|newsletter)$/.test(destJid)) {
        return await socket.sendMessage(sender, {
            text: `*❪ INVALID JID ❫*\n\n⚠️ *Invalid destination JID!*\n\n📌 _The JID must end with @g.us (group), @s.whatsapp.net (user), or @newsletter (channel)._\n\n📌 *Example:* ${prefix}cinefr 120999@g.us Spider Man\n\n${config.BOT_FOOTER}`
        }, { quoted: msg });
    }
    if (!cinefrQuery) {
        return await socket.sendMessage(sender, {
            text: `*❪ ERROR ❫*\n\n⚠️ *Missing movie name!*\n\n🎬 *Usage:*\n• ${prefix}cinefr <jid> <movie name>\n• ${prefix}cinefr 120999@g.us Spider Man\n\n${config.BOT_FOOTER}`
        }, { quoted: msg });
    }

    // Clear any stale numbered menu for this chat so a leftover .menu row
    // list can't hijack the numeric replies of this flow (mirrors .cinesub).
    delete pendingRowSelect[sender];

    await socket.sendMessage(sender, { react: { text: '🎬', key: msg.key } });
    await socket.sendMessage(sender, {
        text: `🔍 *Searching Cinesubz...*\n📤 *Destination:* ${destJid}\n⚡ _Please wait..._`
    }, { quoted: msg });

    try {
        const cinesubResults = await cinesubzSearchApi(cinefrQuery);
        if (!cinesubResults.length) {
            return await socket.sendMessage(sender, {
                text: `*❪ NO RESULTS ❫*\n\n😞 *No Results Found!*\n\n🎬 *Query:* _${cinefrQuery}_\n💡 *Tip:* _Please check the spelling and try again!_\n\n${config.BOT_FOOTER}`
            }, { quoted: msg });
        }

        // Seed the per-requester|chat session BEFORE showing results, so the
        // destination JID is bound to this exact request from the start.
        cinefrSessions[cinefrSessionKey(nowsender, from)] = {
            requesterJid: nowsender,
            botJid: currentBotJid(),
            destJid,
            query: cinefrQuery,
            results: cinesubResults.slice(0, 25),
            step: 'search',
            timestamp: Date.now()
        };

        const searchRows = cinesubResults.slice(0, 25).map((item, index) => {
            const num = (index + 1).toString().padStart(2, '0');
            const icon = item.type === 'tvshows' ? '📺' : '🎬';
            return { num, icon, title: item.title.substring(0, 45) };
        });

        const searchCaption = `╭━〔 🎬 𝐂𝐈𝐍𝐄𝐅𝐑 • 𝐒𝐄𝐀𝐑𝐂𝐇 〕━━⬣\n│\n│ 🔎 𝐐𝐮𝐞𝐫𝐲     : ${cinefrQuery}\n│ 📤 𝐃𝐞𝐬𝐭     : ${destJid}\n│ 📊 𝐑𝐞𝐬𝐮𝐥𝐭𝐬   : ${searchRows.length}\n│ 🌐 𝐒𝐨𝐮𝐫𝐜𝐞    : Cinesubz\n│\n╰━━━━━━━━━━━━━━━━⬣\n\n📥 *𝐒𝐄𝐋𝐄𝐂𝐓 𝐀 𝐌𝐎𝐕𝐈𝐄 / 𝐓𝐕 𝐒𝐄𝐑𝐈𝐄𝐒*\n\n${searchRows.map(row => `${row.num} ➜ ${row.icon} ${row.title}`).join('\n')}\n\n💬 *Reply with the corresponding number.*\n\n${config.BOT_FOOTER}`;

        try {
            await socket.sendMessage(sender, {
                image: { url: cinesubResults[0].image || CINESUBZ_DEFAULT_IMAGE },
                caption: searchCaption
            }, { quoted: msg });
        } catch (e) {
            await socket.sendMessage(sender, { text: searchCaption }, { quoted: msg });
        }
    } catch (error) {
        console.error('Cinefr search error:', error);
        delete cinefrSessions[cinefrSessionKey(nowsender, from)];
        await socket.sendMessage(sender, {
            text: `*❪ SYSTEM ERROR ❫*\n\n❌ *Search Failed!*\n🚫 _${error.message || 'Unknown error'}_\n\n🔄 _Please try again later..._\n\n${config.BOT_FOOTER}`
        }, { quoted: msg });
    }
    break;
}

// ==================== CINEFR PER-USER FOOTER COMMANDS ====================
// .cinefrfooter <text>  → save/update the user's personal .cinefr footer
// .cinefrfooter         → show the user's current footer (or the default)
// .cinefrfooter reset   → restore the default footer
case 'cinefrfooter':
case 'cinfrt':
case 'cinetvfrfooter': {
    // .cinetvfrfooter is an alias — it edits the SAME per-user footer used by
    // both .cinefr and .cinetvfr.
    const lower = footerText.toLowerCase();

    if (lower === 'reset' || lower === 'default' || lower === 'off') {
        await resetCinefrFooter(nowsender);
        await socket.sendMessage(sender, { react: { text: '♻️', key: msg.key } });
        return await socket.sendMessage(sender, {
            text: `*♻️ CINEFR FOOTER RESET*\n\nYour custom footer has been removed. The default footer will be used for your .cinefr captions now.\n\n${config.BOT_FOOTER}`
        }, { quoted: msg });
    }

    if (footerText) {
        const ok = await setCinefrFooter(nowsender, footerText);
        const preview = renderCinefrFooter(footerText, {
            title: 'Sample Movie (2026)',
            pushname: msg.pushName || 'User',
            quality: '720p',
            year: '2026',
            rating: '8.5',
            duration: '2h 15m',
            season: '1',
            episode: '3'
        });
        if (ok) {
            await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
            return await socket.sendMessage(sender, {
                text: `*✏️ CINEFR FOOTER SAVED* ✅\n\nYour custom footer is now saved.\n\n*Preview:*\n${cinefrFooterBlock(preview)}\n\n_Use ${prefix}cinefrfooter reset to restore the default._\n\n${config.BOT_FOOTER}`
            }, { quoted: msg });
        }
        return await socket.sendMessage(sender, { text: '❌ Failed to save footer. Try again later.' }, { quoted: msg });
    }

    const custom = await getCinefrFooter(nowsender);
    if (custom) {
        const preview = renderCinefrFooter(custom, {
            title: 'Sample Movie (2026)',
            pushname: msg.pushName || 'User',
            quality: '720p',
            year: '2026',
            rating: '8.5',
            duration: '2h 15m',
            season: '1',
            episode: '3'
        });
        return await socket.sendMessage(sender, {
            text: `*👤 YOUR CINEFR FOOTER*\n\n*Stored text:*\n${custom}\n\n*Preview:*\n${cinefrFooterBlock(preview)}\n\n_Use ${prefix}cinefrfooter reset to restore the default._\n\n${config.BOT_FOOTER}`
        }, { quoted: msg });
    }
    return await socket.sendMessage(sender, {
        text: `*👤 YOUR CINEFR FOOTER*\n\nYou have no custom footer — the default is used.\n\n*Default:*\n${cinefrFooterBlock(renderCinefrFooter(DEFAULT_CINEFR_FOOTER, {
            title: 'Sample Movie (2026)',
            pushname: msg.pushName || 'User',
            quality: '720p',
            year: '2026',
            rating: '8.5',
            duration: '2h 15m',
            season: '1',
            episode: '3'
        }))}\n\n_Set one with:_ ${prefix}cinefrfooter <text>\n\n${config.BOT_FOOTER}`
    }, { quoted: msg });
}

// ==================== MVFR (forward .movie to a JID) ====================
// .mvfr <destJid> <movie name> → search → pick movie → pick ONE quality →
// download → send the document DIRECTLY to <destJid>. Identical flow to
// .movie except the destination. JID always comes from the command itself
// (never global), bound to the requester's session; the flow is driven by
// handleMvfrReply() in the non-command branch.
case 'mvfr': {
    // ---- Parse: first arg = destination JID, rest = movie query ----
    const mvfrDestJid = (args[0] || '').trim();
    const mvfrQuery = args.slice(1).join(' ').trim();

    if (!mvfrDestJid) {
        return await socket.sendMessage(sender, {
            text: `*❪ ERROR ❫*\n\n⚠️ *Missing destination JID!*\n\n🎬 *Usage:*\n• ${prefix}mvfr <jid> <movie name>\n• ${prefix}mvfr 120999@g.us Spider Man\n\n📝 _Send the movie directly to the provided JID._\n\n${config.BOT_FOOTER}`
        }, { quoted: msg });
    }
    if (!/^\d+@(g\.us|s\.whatsapp\.net|newsletter)$/.test(mvfrDestJid)) {
        return await socket.sendMessage(sender, {
            text: `*❪ INVALID JID ❫*\n\n⚠️ *Invalid destination JID!*\n\n📌 _The JID must end with @g.us (group), @s.whatsapp.net (user), or @newsletter (channel)._\n\n📌 *Example:* ${prefix}mvfr 120999@g.us Spider Man\n\n${config.BOT_FOOTER}`
        }, { quoted: msg });
    }
    if (!mvfrQuery) {
        return await socket.sendMessage(sender, {
            text: `*❪ ERROR ❫*\n\n⚠️ *Missing movie name!*\n\n🎬 *Usage:*\n• ${prefix}mvfr <jid> <movie name>\n• ${prefix}mvfr 120999@g.us Spider Man\n\n${config.BOT_FOOTER}`
        }, { quoted: msg });
    }

    // Clear stale numbered menus / plugin state for this chat so replies of
    // this flow can't be hijacked (mirrors .movie and .cinesub behavior).
    delete pendingRowSelect[sender];
    delete moviePendingSearch[sender];
    delete moviePendingQuality[sender];
    if (typeof cinesubPlugin.clear === 'function') cinesubPlugin.clear(sender);
    if (typeof animeClearSessions === 'function') animeClearSessions(nowsender);

    await socket.sendMessage(sender, { react: { text: '🎬', key: msg.key } });
    await socket.sendMessage(sender, {
        text: `🔍 *Searching SinhalaSub Database...*\n📤 *Destination:* ${mvfrDestJid}\n⚡ _Please wait..._`
    }, { quoted: msg });

    try {
        const results = await searchMovies(mvfrQuery);
        if (!results || results.length === 0) {
            return await socket.sendMessage(sender, {
                text: `*❪ NO RESULTS ❫*\n\n😞 *No Results Found!*\n\n🎬 *Query:* _${mvfrQuery}_\n💡 *Tip:* _Please check the spelling and try again!_\n\n${config.BOT_FOOTER}`
            }, { quoted: msg });
        }

        // Seed the per-requester|chat session BEFORE showing results, so the
        // destination JID is bound to this exact request from the start.
        mvfrSessions[mvfrSessionKey(nowsender, from)] = {
            requesterJid: nowsender,
            botJid: currentBotJid(),
            destJid: mvfrDestJid,
            query: mvfrQuery,
            results,
            step: 'search',
            timestamp: Date.now()
        };

        const rows = results.map(movie => ({
            label: `🎬 ${movie.title}`,
            id: `${prefix}moviedetail ${encodeURIComponent(movie.movieUrl)}`
        }));

        const caption =
`╭━〔 🎬 𝐈𝐒𝐇𝐀𝐍-𝐗 • 𝐌𝐎𝐕𝐈𝐄 𝐅𝐎𝐑𝐖𝐀𝐑𝐃 〕━⬣\n┃\n┃➤ 🔎 \`𝐐𝐮𝐞𝐫𝐲\`  : ${mvfrQuery}\n┃➤ 📤 \`𝐃𝐞𝐬𝐭\`    : ${mvfrDestJid}\n┃➤ 🎞️ \`𝐑𝐞𝐬𝐮𝐥𝐭𝐬\` : ${results.length}\n╰━━━━━━━━━━━━━━━⬣\n\n📥 *𝐒𝐄𝐋𝐄𝐂𝐓 𝐀 𝐌𝐎𝐕𝐈𝐄*\n\n${buildNumberedList(rows)}\n\n━━━━━━━━━━━━━━━━\n\n💬 *Reply with the corresponding number.*\n\n> _*𝐃𝙴𝚅𝙴𝙻𝙾𝙿𝙴𝚁 𝐁𝚈 𝐈𝚂𝙷𝙰𝙽-𝐗 × 𝐋𝙾𝚅𝙴𝙻𝚈 🧑‍💻🇱🇰*_`;

        try {
            await socket.sendMessage(sender, { image: { url: results[0].thumb }, caption }, { quoted: msg });
        } catch (e) {
            await socket.sendMessage(sender, { text: caption }, { quoted: msg });
        }
    } catch (error) {
        console.error('Mvfr search error:', error);
        delete mvfrSessions[mvfrSessionKey(nowsender, from)];
        await socket.sendMessage(sender, {
            text: `*❪ SYSTEM ERROR ❫*\n\n❌ *Search Failed!*\n🚫 _${error.message || 'Unknown error'}_\n\n🔄 _Please try again later..._\n\n${config.BOT_FOOTER}`
        }, { quoted: msg });
    }
    break;
}

// ==================== MVFR PER-USER FOOTER COMMANDS ====================
// .mvfrfooter <text>  → save/update the user's personal .mvfr footer
// .mvfrfooter         → show the user's current footer (or the default)
// .mvfrfooter reset   → restore the default footer
case 'mvfrfooter':
case 'mvftr': {
    const footerText = args.join(' ').trim();
    const lower = footerText.toLowerCase();

    if (lower === 'reset' || lower === 'default' || lower === 'off') {
        await resetMvfrFooter(nowsender);
        await socket.sendMessage(sender, { react: { text: '♻️', key: msg.key } });
        return await socket.sendMessage(sender, {
            text: `*♻️ MVFR FOOTER RESET*\n\nYour custom footer has been removed. The default footer will be used for your .mvfr captions now.\n\n${config.BOT_FOOTER}`
        }, { quoted: msg });
    }

    if (footerText) {
        const ok = await setMvfrFooter(nowsender, footerText);
        const preview = renderMvfrFooter(footerText, {
            title: 'Sample Movie (2026)',
            pushname: msg.pushName || 'User',
            quality: '720p',
            year: '2026',
            rating: '8.5',
            duration: '2h 15m'
        });
        if (ok) {
            await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
            return await socket.sendMessage(sender, {
                text: `*✏️ MVFR FOOTER SAVED* ✅\n\nYour custom footer is now saved.\n\n*Preview:*\n${cinefrFooterBlock(preview)}\n\n_Use ${prefix}mvfrfooter reset to restore the default._\n\n${config.BOT_FOOTER}`
            }, { quoted: msg });
        }
        return await socket.sendMessage(sender, { text: '❌ Failed to save footer. Try again later.' }, { quoted: msg });
    }

    const custom = await getMvfrFooter(nowsender);
    if (custom) {
        const preview = renderMvfrFooter(custom, {
            title: 'Sample Movie (2026)',
            pushname: msg.pushName || 'User',
            quality: '720p',
            year: '2026',
            rating: '8.5',
            duration: '2h 15m'
        });
        return await socket.sendMessage(sender, {
            text: `*👤 YOUR MVFR FOOTER*\n\n*Stored text:*\n${custom}\n\n*Preview:*\n${cinefrFooterBlock(preview)}\n\n_Use ${prefix}mvfrfooter reset to restore the default._\n\n${config.BOT_FOOTER}`
        }, { quoted: msg });
    }
    return await socket.sendMessage(sender, {
        text: `*👤 YOUR MVFR FOOTER*\n\nYou have no custom footer — the default is used.\n\n*Default:*\n${cinefrFooterBlock(renderMvfrFooter(DEFAULT_MVFR_FOOTER, {
            title: 'Sample Movie (2026)',
            pushname: msg.pushName || 'User',
            quality: '720p',
            year: '2026',
            rating: '8.5',
            duration: '2h 15m'
        }))}\n\n_Set one with:_ ${prefix}mvfrfooter <text>\n\n${config.BOT_FOOTER}`
    }, { quoted: msg });
}

case 'prefix': {
  await socket.sendMessage(sender, { react: { text: '🔣', key: msg.key } });
  try {
    const sanitized = (number || '').replace(/[^0-9]/g, '');
    const senderNum = await resolveSenderPhone(socket, nowsender);
    const isOwnerNum = isOwnerNumber(senderNum);
    
    if (senderNum !== sanitized && !isOwnerNum) {
            return await socket.sendMessage(sender, { text: '❌ Permission denied. Only the session owner or bot owner can change prefix.' }, { quoted: msg });
    }
    
    let newPrefix = args[0];
    if (!newPrefix || newPrefix.length > 2) {
            return await socket.sendMessage(sender, { text: "❌ *Invalid prefix!*\nPrefix must be 1-2 characters long." }, { quoted: msg });
    }
    
    const userConfig = await loadUserConfigFromMongo(sanitized) || {};
    userConfig.PREFIX = newPrefix;
    await setUserConfigInMongo(sanitized, userConfig);
    
        await socket.sendMessage(sender, { text: `✅ *Your Prefix updated to: ${newPrefix}*` }, { quoted: msg });
  } catch (e) {
    console.error('Prefix command error:', e);
        await socket.sendMessage(sender, { text: "*❌ Error updating your prefix!*" }, { quoted: msg });
  }
  break;
}
//✅✅✅
case 'settings': {
  await socket.sendMessage(sender, { react: { text: '⚙️', key: msg.key } });
  try {
    const sanitized = (number || '').replace(/[^0-9]/g, '');
    const senderNum = await resolveSenderPhone(socket, nowsender);
    const isOwnerNum = isOwnerNumber(senderNum);
    
    if (senderNum !== sanitized && !isOwnerNum) {
            return await socket.sendMessage(sender, { text: '❌ Permission denied. Only the session owner or bot owner can view settings.' }, { quoted: msg });
    }

    const currentConfig = await loadUserConfigFromMongo(sanitized) || {};
    const bc = await resolveDisplayBotConfig(socket, nowsender);
    
const settingsText = `
*╭─「 ᴄᴜʀʀᴇɴᴛ ꜱᴇᴛᴛɪɴɢꜱ 」─●●➤*  
*│➣ 🔧 ᴡᴏʀᴋ ᴛʏᴘᴇ:* ${currentConfig.WORK_TYPE || 'public'}
*│➣ 🎭 ᴘʀᴇꜱᴇɴꜱᴇ:* ${currentConfig.PRESENCE || 'available'}
*│➣ 👁️ ᴀᴜᴛᴏ ꜱᴛᴀᴛᴜꜱ ꜱᴇᴇɴ:* ${currentConfig.AUTO_VIEW_STATUS || 'true'}
*│➣ ❤️ ᴀᴜᴛᴏ ꜱᴛᴀᴛᴜꜱ ʟɪᴋᴇ:* ${currentConfig.AUTO_LIKE_STATUS || 'true'}
*│➣ 📞 ᴀᴜᴛᴏ ʀᴇᴊᴇᴄᴛ ᴄᴀʟʟ:* ${currentConfig.ANTI_CALL || 'off'}
*│➣ 📖 ᴀᴜᴛᴏ ʀᴇᴀᴅ ᴍᴇꜱꜱᴀɢᴇ:* ${currentConfig.AUTO_READ_MESSAGE || 'off'}
*│➣ 🎥 ᴀᴜᴛᴏ ʀᴇᴄᴏʀᴅɪɴɢ:* ${currentConfig.AUTO_RECORDING || 'false'}
*│➣ ⌨️ ᴀᴜᴛᴏ ᴛʏᴘɪɴɢ:* ${currentConfig.AUTO_TYPING || 'false'}
*│➣ 👍 ᴀᴜᴛᴏ ʀᴇᴀᴄᴛ:* ${currentConfig.AUTO_REACT || 'false'}
*│➣ 🛡️ ᴀɴᴛɪ ᴅᴇʟᴇᴛᴇ:* ${currentConfig.ANTI_DELETE || 'off'}
*│➣ 💬 ᴘᴇʀꜱᴏɴᴀʟ ɢʀᴇᴇᴛ:* ${currentConfig.WELCOME_PERSONAL || GREETING_DEFAULTS.WELCOME_PERSONAL}
*│➣ 🧩 ᴀᴜᴛᴏ ꜱᴛɪᴄᴋᴇʀ:* ${currentConfig.AUTO_STICKER || 'off'}
*│➣ 🎙️ ᴀᴜᴛᴏ ᴠᴏɪᴄᴇ:* ${currentConfig.AUTO_VOICE || 'off'}
*│➣ 🔣 ᴘʀᴇꜰɪx:* ${currentConfig.PREFIX || '.'}
*│➣ 🎭 ꜱᴛᴀᴛᴜꜱ ᴇᴍᴏᴊɪꜱ:* ${(currentConfig.AUTO_LIKE_EMOJI || config.AUTO_LIKE_EMOJI).join(' ')}
*╰──────────────●●➤*

*𝐔se ${currentConfig.PREFIX || '.'}𝐒etting 𝐓o 𝐂hange 𝐒ettings 𝐕𝐢𝐚 𝐌𝐞𝐧𝐮*
     
> _*𝐃𝙴𝚅𝙴𝙻𝙾𝙿𝙴𝚁 𝐁𝚈 𝐈𝚂𝙷𝙰𝙽-𝐗 × 𝐋𝙾𝚅𝙴𝙻𝚈 🧑‍💻🇱🇰*_`;
          
    await socket.sendMessage(sender, {
      image: { url: bc.botLogo !== PREMIUM_DEFAULTS.botLogo ? bc.botLogo : safeSessionLogo(currentConfig.logo, config.SET_IMAGE_PATH) },
      caption: settingsText
    }, { quoted: msg });
    
  } catch (e) {
    console.error('Settings command error:', e);
        await socket.sendMessage(sender, { text: "*❌ Error loading settings!*" }, { quoted: msg });
  }
  break;
}

case 'checkjid': {
  try {
    const sanitized = (number || '').replace(/[^0-9]/g, '');
    const senderNum = await resolveSenderPhone(socket, nowsender);
    const isOwnerNum = isOwnerNumber(senderNum);
    
    if (senderNum !== sanitized && !isOwnerNum) {
            return await socket.sendMessage(sender, { text: '❌ Permission denied. Only the session owner or bot owner can use this command.' }, { quoted: msg });
    }

    const target = args[0] || sender;
    let targetJid = target;

    if (!target.includes('@')) {
      if (target.includes('-')) {
        targetJid = target.endsWith('@g.us') ? target : `${target}@g.us`;
      } else if (target.length > 15) {
        targetJid = target.endsWith('@newsletter') ? target : `${target}@newsletter`;
      } else {
        targetJid = target.endsWith('@s.whatsapp.net') ? target : `${target}@s.whatsapp.net`;
      }
    }

    let type = 'Unknown';
    if (targetJid.endsWith('@g.us')) {
      type = 'Group';
    } else if (targetJid.endsWith('@newsletter')) {
      type = 'Newsletter';
    } else if (targetJid.endsWith('@s.whatsapp.net')) {
      type = 'User';
    } else if (targetJid.endsWith('@broadcast')) {
      type = 'Broadcast List';
    } else {
      type = 'Unknown';
    }

    const responseText = `🔍 *JID INFORMATION*\n\n☘️ *Type:* ${type}\n🆔 *JID:* ${targetJid}\n\n╰──────────────────────`;

    await socket.sendMessage(sender, {
      image: { url: config.IMAGE_PATH },
      caption: responseText
    }, { quoted: msg });

  } catch (error) {
    console.error('Checkjid command error:', error);
        await socket.sendMessage(sender, { text: "*❌ Error checking JID information!*" }, { quoted: msg });
  }
  break;
}

case 'emojis': {
  await socket.sendMessage(sender, { react: { text: '🎭', key: msg.key } });
  try {
    const sanitized = (number || '').replace(/[^0-9]/g, '');
    const senderNum = await resolveSenderPhone(socket, nowsender);
    const isOwnerNum = isOwnerNumber(senderNum);
    
    // Permission check - only session owner or bot owner can change emojis
    if (senderNum !== sanitized && !isOwnerNum) {
            return await socket.sendMessage(sender, { text: '❌ Permission denied. Only the session owner or bot owner can change status reaction emojis.' }, { quoted: msg });
    }
    
    let newEmojis = args;
    
    if (!newEmojis || newEmojis.length === 0) {
      // Show current emojis if no args provided
      const userConfig = await loadUserConfigFromMongo(sanitized) || {};
      const currentEmojis = userConfig.AUTO_LIKE_EMOJI || config.AUTO_LIKE_EMOJI;
      
            
      return await socket.sendMessage(sender, { 
        text: `🎭 *Current Status Reaction Emojis:*\n\n${currentEmojis.join(' ')}\n\nUsage: \`.emojis 😀 😄 😊 🎉 ❤️\`` 
      }, { quoted: msg });
    }
    
    // Validate emojis (basic check)
    const invalidEmojis = newEmojis.filter(emoji => !/\p{Emoji}/u.test(emoji));
    if (invalidEmojis.length > 0) {
            return await socket.sendMessage(sender, { 
        text: `❌ *Invalid emojis detected:* ${invalidEmojis.join(' ')}\n\nPlease use valid emoji characters only.` 
      }, { quoted: msg });
    }
    
    // Get user-specific config from MongoDB
    const userConfig = await loadUserConfigFromMongo(sanitized) || {};
    
    // Update ONLY this user's emojis
    userConfig.AUTO_LIKE_EMOJI = newEmojis;
    
    // Save to MongoDB
    await setUserConfigInMongo(sanitized, userConfig);
    
        
    await socket.sendMessage(sender, { 
      text: `✅ *Your Status Reaction Emojis Updated!*\n\nNew emojis: ${newEmojis.join(' ')}\n\nThese emojis will be used for your automatic status reactions.` 
    }, { quoted: msg });
    
  } catch (e) {
    console.error('Emojis command error:', e);
        await socket.sendMessage(sender, { text: "*❌ Error updating your status reaction emojis!*" }, { quoted: msg });
  }
  break;
}

// ==================== AUTO STATUS MESSAGE (.autostatusmsg) ====================
// When ON, the bot automatically replies to every new WhatsApp Status it
// receives with the session-owner's custom message. The reply goes ONLY to the
// person who posted the status (never to the owner, groups or the bot itself).
// Settings are stored per-session in the user config (Mongo) so they survive
// restarts, reconnects and session reloads.
case 'autostatusmsg': {
  try {
    const sanitized = (number || '').replace(/[^0-9]/g, '');
    const senderNum = await resolveSenderPhone(socket, nowsender);
    const isOwnerNum = isOwnerNumber(senderNum);

    // Only the session owner or the bot owner may configure this feature
    // (same permission rule as .emojis / .prefix).
    if (senderNum !== sanitized && !isOwnerNum) {
      return await socket.sendMessage(sender, {
        text: '❌ Permission denied. Only the session owner or bot owner can configure auto status message.'
      }, { quoted: msg });
    }

    const sub = (args[0] || '').toLowerCase();
    const userConfig = await loadUserConfigFromMongo(sanitized) || {};

    // ---- set <message> ----
    if (sub === 'set') {
      const template = args.slice(1).join(' ').trim();
      if (!template) {
        return await socket.sendMessage(sender, {
          text: `*❪ ERROR ❫*\n\n⚠️ *Missing message!*\n\n📝 *Usage:* ${prefix}autostatusmsg set <message>\n\n💡 _Placeholders:_ {pushname} {name} {jid} {time} {date}\n\n_Example:_ ${prefix}autostatusmsg set Hi {pushname} ❤️ Nice status!\n\n${config.BOT_FOOTER}`
        }, { quoted: msg });
      }
      userConfig.AUTOSTATUSMSG_TEXT = String(template)
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/`/g, "'")
        .slice(0, 1000)
        .trim();
      await setUserConfigInMongo(sanitized, userConfig);
      await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
      return await socket.sendMessage(sender, {
        text: `*✅ Auto Status Message Updated!*\n\n_${userConfig.AUTOSTATUSMSG_TEXT}_\n\n${config.BOT_FOOTER}`
      }, { quoted: msg });
    }

    // ---- on ----
    if (sub === 'on') {
      userConfig.AUTOSTATUSMSG_ENABLED = 'true';
      await setUserConfigInMongo(sanitized, userConfig);
      await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
      return await socket.sendMessage(sender, {
        text: `*✅ Auto Status Message Enabled.*\n\n_Bot will automatically reply to new statuses now._\n\n${config.BOT_FOOTER}`
      }, { quoted: msg });
    }

    // ---- off ----
    if (sub === 'off') {
      userConfig.AUTOSTATUSMSG_ENABLED = 'false';
      await setUserConfigInMongo(sanitized, userConfig);
      await socket.sendMessage(sender, { react: { text: '❌', key: msg.key } });
      return await socket.sendMessage(sender, {
        text: `*❌ Auto Status Message Disabled.*\n\n_Bot will not reply to statuses anymore._\n\n${config.BOT_FOOTER}`
      }, { quoted: msg });
    }

    // ---- no sub-command: show current settings (informational only) ----
    const enabled = userConfig.AUTOSTATUSMSG_ENABLED === 'true';
    const current = userConfig.AUTOSTATUSMSG_TEXT || '(not set)';
    return await socket.sendMessage(sender, {
      text: `*⚙️ AUTO STATUS MESSAGE*\n\n*Status:* ${enabled ? '✅ ON' : '❌ OFF'}\n*Message:*\n_${current}_\n\n_Usage:_\n• ${prefix}autostatusmsg set <message>\n• ${prefix}autostatusmsg on\n• ${prefix}autostatusmsg off\n\n${config.BOT_FOOTER}`
    }, { quoted: msg });
  } catch (e) {
    console.error('AutoStatusMsg command error:', e);
    return await socket.sendMessage(sender, { text: '❌ Error updating auto status message settings.' }, { quoted: msg }).catch(() => {});
  }
  break;
}

// ==================== PREMIUM MANAGEMENT (.setpremium) ====================
// 🔒 EXECUTOR: .setpremium runs when the sender JID is the locked executor
// 94720251446@s.whatsapp.net (always allowed) OR any number in config.OWNER_
// NUMBER (see isLockedPremiumExecutor). Every other JID is rejected. The
// premium TARGET is always the explicit <jid> argument — never the sender, the
// current bot, a group or another user. The "activated" notice goes ONLY to
// the target user; the "expired" notice goes ONLY to the target user and the
// premium-expired alert goes ONLY to config.owners (see notifyPremiumExpiry).
case 'setpremium': {
  if (!perBotAllowed) break; // multi-bot chat without @mention → no bot acts
  try {
    const senderNum = await resolveSenderPhone(socket, nowsender);
    // 🔒 Locked executor only: 94720251446 AND present in config.owners.
    if (!isLockedPremiumExecutor(senderNum)) {
      return await socket.sendMessage(sender, {
        text: `❌ Permission denied. Only the locked premium executor (${getPremiumNotifyNumber()}) can manage premium.`
      }, { quoted: msg });
    }
    // The premium target must be EXPLICITLY provided — the sender is never the
    // target (no more '.setpremium <days>' convenience that activates sender).
    const arg0 = (args[0] || '').trim();
    const arg1 = (args[1] || '').trim();
    const hasJidArg = arg0.includes('@') || /^\d{9,15}$/.test(arg0);
    if (!hasJidArg) {
      return await socket.sendMessage(sender, {
        text: `*❪ USAGE ❫*\n\n*Usage:* ${prefix}setpremium <jid> <days|lifetime>\n\n_Examples:_\n• ${prefix}setpremium 94764642432@s.whatsapp.net 30\n• ${prefix}setpremium 94764642432@s.whatsapp.net lifetime\n\n${config.BOT_FOOTER}`
      }, { quoted: msg });
    }
    // Never apply premium to a group JID (check the RAW arg before the '@g.us'
    // suffix is stripped and rebuilt as @s.whatsapp.net).
    if (String(arg0).includes('@g.us')) {
      return await socket.sendMessage(sender, {
        text: '❌ Groups cannot be premium targets.'
      }, { quoted: msg });
    }
    const givenDigits = arg0.split('@')[0].replace(/[^0-9]/g, '');
    if (!givenDigits) {
      return await socket.sendMessage(sender, {
        text: `*❪ USAGE ❫*\n\n*Usage:* ${prefix}setpremium <jid> <days|lifetime>\n\n${config.BOT_FOOTER}`
      }, { quoted: msg });
    }
    const targetJid = `${givenDigits}@s.whatsapp.net`;
    // Never apply premium to the CURRENT bot itself (target must be a user).
    const botSelfDigits = String(getSessionOwnerJid(socket) || '').split('@')[0].replace(/[^0-9]/g, '');
    if (botSelfDigits && targetJid === `${botSelfDigits}@s.whatsapp.net`) {
      return await socket.sendMessage(sender, {
        text: '❌ Premium cannot be applied to the bot itself.'
      }, { quoted: msg });
    }
    const durArg = String(arg1 || '').toLowerCase();
    if (!durArg) {
      return await socket.sendMessage(sender, {
        text: `*❪ USAGE ❫*\n\n*Usage:* ${prefix}setpremium <jid> <days|lifetime>\n\n_Examples:_\n• ${prefix}setpremium 94764642432@s.whatsapp.net 30\n• ${prefix}setpremium 94764642432@s.whatsapp.net lifetime\n\n${config.BOT_FOOTER}`
      }, { quoted: msg });
    }
    const lifetime = durArg === 'lifetime' || durArg === 'unlimited' || durArg === '0';
    const days = (!lifetime && durArg) ? parseInt(durArg, 10) : 0;
    if (!lifetime && (!/^\d+$/.test(durArg) || days < 0)) {
      return await socket.sendMessage(sender, {
        text: `*❪ USAGE ❫*\n\n*Usage:* ${prefix}setpremium <jid> <days|lifetime>\n\n${config.BOT_FOOTER}`
      }, { quoted: msg });
    }
    const ok = await setPremiumUser(targetJid, { days, lifetime: lifetime || days <= 0 });
    if (!ok) return await socket.sendMessage(sender, { text: '❌ Failed to update premium status.' }, { quoted: msg });
    const expiryText = (lifetime || days <= 0) ? '♾️ *Lifetime*' : `${days} day(s)`;
    const expiresAt = (!lifetime && days > 0) ? Date.now() + days * 86400000 : 0;
    // Short confirmation to the executor only (the locked 94720251446 admin).
    await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
    await socket.sendMessage(sender, {
      text: `✅ *Premium ${expiryText} activated for ${targetJid.split('@')[0]}*\n📅 *Expires:* ${formatPremiumExpiry(expiresAt)}\n\n${config.BOT_FOOTER}`
    }, { quoted: msg });
    // Activated message → ONLY to the target user, sent FROM the premium-notify
    // session only (same policy as the expired notice). Never to groups/other bots.
    try {
      const notifySock = getPremiumNotifySocket();
      if (notifySock && notifySock.sendMessage) {
        await notifySock.sendMessage(targetJid, {
          text: `${getPremiumGreeting()} ${targetJid.split('@')[0]} 👋\n\n╔═══『  💎 𝐏𝐑𝐄𝐌𝐈𝐔𝐌 𝐀𝐂𝐓𝐈𝐕𝐀𝐓𝐄𝐃  』═══❒\n╠⦁ 🎉 *Congratulations!* Premium activated on your number\n╠⦁\n╠⦁ 👤 *User:* ${targetJid.split('@')[0]}\n╠⦁ ⏳ *Duration:* ${expiryText}\n╠⦁ 📅 *Expires:* ${formatPremiumExpiry(expiresAt)}\n╠⦁\n╠⦁ ⚠️ *Renewal:* If premium expires, contact the Owner\n╠⦁ 📞 *Owner:* ${ownerContactLine()}\n╚═══════════════════════❒\n${config.BOT_FOOTER}`
        }).catch(() => {});
      } else {
        // Notify session offline → tell the executor the notice is pending
        // instead of silently skipping (the target user will still see premium active).
        console.warn('setpremium: premium-notify session offline, activated notice pending');
        await socket.sendMessage(sender, {
          text: `⚠️ *_Premium activated, but the activated notice could not be sent to the user_* (${getPremiumNotifyNumber()} is offline). It will be delivered when that session reconnects.\n\n${config.BOT_FOOTER}`
        }, { quoted: msg }).catch(() => {});
      }
    } catch (e) { console.error('setpremium notify error:', e); }
  } catch (e) {
    console.error('setpremium error:', e);
    return await socket.sendMessage(sender, { text: '❌ Error updating premium status.' }, { quoted: msg }).catch(() => {});
  }
}

// ==================== 18+ (NSFW) VERIFICATION COMMANDS ====================
// Owner-only. Grants/revokes 18+ (NSFW) access for a user, which unlocks the
// .nsfwmenu and .hanime/.hhentai commands. 18+ verification is a PREMIUM perk:
// the target must have active premium (.verify18 is rejected for non-premium
// users) and the grant expires together with the user's premium (see
// isNsfwVerified + notifyPremiumExpiry). The grant/revoke notice is sent to
// the target FROM the locked premium-notify session only, never from the
// executor's own session.
case 'verify18':
case 'unverify18': {
  const verifyOn = command === 'verify18';
  try {
    const senderPhone = await resolveSenderPhone(socket, nowsender);
    if (!isOwnerNumber(senderPhone)) {
      return await socket.sendMessage(sender, {
        text: `❌ Permission denied. Only the owner can ${verifyOn ? 'verify' : 'unverify'} users for 18+ (NSFW).`
      }, { quoted: msg });
    }
    const arg0 = (args[0] || '').trim();
    const hasJidArg = arg0.includes('@') || /^\d{9,15}$/.test(arg0);
    if (!hasJidArg) {
      return await socket.sendMessage(sender, {
        text: `*❪ USAGE ❫*\n\n*Usage:* ${prefix}${command} <jid>\n\n_Examples:_\n• ${prefix}${command} 94764642432\n• ${prefix}${command} 94764642432@s.whatsapp.net\n\n${config.BOT_FOOTER}`
      }, { quoted: msg });
    }
    if (String(arg0).includes('@g.us')) {
      return await socket.sendMessage(sender, { text: '❌ Groups cannot be 18+ verified.' }, { quoted: msg });
    }
    const digits = arg0.split('@')[0].replace(/[^0-9]/g, '');
    if (!digits) {
      return await socket.sendMessage(sender, {
        text: `*❪ USAGE ❫*\n\n*Usage:* ${prefix}${command} <jid>\n\n${config.BOT_FOOTER}`
      }, { quoted: msg });
    }
    const targetJid = `${digits}@s.whatsapp.net`;

    // 🔞 18+ verification is premium-only: the target must have ACTIVE premium
    // to be granted access. Lifetime premium counts (never expires). Owners are
    // always exempt (they don't need verification at all).
    if (verifyOn) {
      const targetPremium = await isPremium(targetJid);
      if (!targetPremium) {
        return await socket.sendMessage(sender, {
          text: `*❪ PREMIUM REQUIRED ❫*\n\n🚫 *18+ verification is a premium perk* — ${digits} is not an active premium user.\n\n💡 *Grant premium first:*\n${config.PREFIX || '.'}setpremium ${digits}@s.whatsapp.net <days|lifetime>\n\n${config.BOT_FOOTER}`
        }, { quoted: msg });
      }
    }

    const ok = await setNsfwVerified(targetJid, verifyOn);
    if (!ok) {
      return await socket.sendMessage(sender, { text: '❌ Failed to update 18+ verification.' }, { quoted: msg });
    }
    await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
    await socket.sendMessage(sender, {
      text: `${verifyOn ? '✅ *18+ verification GRANTED*' : '🚫 *18+ verification REVOKED*'} for ${digits}\n\n${config.BOT_FOOTER}`
    }, { quoted: msg });

    // Notice to the target user — sent FROM the locked premium-notify session
    // only (same policy as premium activation/expiry), never from the
    // executor's own session.
    try {
      const notifySock = getPremiumNotifySocket();
      if (notifySock && notifySock.sendMessage) {
        const notice = verifyOn
          ? `╔═══『  🔞 18+ VERIFIED  』═══❒\n╠⦁ ✅ *Your 18+ (NSFW) access is now active*\n╠⦁\n╠⦁ 👤 *User:* ${digits}\n╠⦁ 🎟️ *Premium perk:* Active for as long as your premium\n╠⦁\n╠⦁ ⚠️ *Note:* If premium expires, 18+ access ends too\n╠⦁ 📞 *Renew:* Contact the Owner — ${ownerContactLine()}\n╚═══════════════════════❒\n${config.BOT_FOOTER}`
          : `╔═══『  🔞 18+ REVOKED  』═══❒\n╠⦁ 🚫 *Your 18+ (NSFW) access has been revoked*\n╠⦁\n╠⦁ 👤 *User:* ${digits}\n╠⦁\n╠⦁ 📞 *Questions?* Contact the Owner — ${ownerContactLine()}\n╚═══════════════════════❒\n${config.BOT_FOOTER}`;
        await notifySock.sendMessage(targetJid, { text: notice }).catch(() => {});
      } else {
        console.warn('verify18: premium-notify session offline, notice pending');
      }
    } catch (e) { console.error('verify18 notify error:', e); }
  } catch (e) {
    console.error('verify18 error:', e);
    return await socket.sendMessage(sender, { text: '❌ Error updating 18+ verification.' }, { quoted: msg }).catch(() => {});
  }
  break;
}

// ==================== PREMIUM BOT CUSTOMIZATION COMMANDS ====================
// Every command modifies ONLY the processing bot's own config — keyed by the
// bot's paired number (sock.user.id), never the sender's JID and never a
// user-supplied JID. In a chat shared by several connected bots the command
// must @mention the target bot (see the perBotAllowed gate); in private chats
// it targets that bot. Permission: a manager (owner) may customize any
// connected bot; otherwise only the bot's own premium user (sender == bot
// number) may. reset restores that single field to the default.
case 'premiummenu': {
  if (!perBotAllowed) break; // multi-bot chat without @mention → no bot acts
  await socket.sendMessage(sender, { react: { text: '💎', key: msg.key } });
  try {
    // Per-bot isolation: the menu shows THIS bot's own customization record
    // (keyed by the processing bot's paired number), never the sender's.
    const { ok: canManage, premiumJid } = await canManageBotConfig(socket, nowsender);
    if (!canManage) {
      return await socket.sendMessage(sender, {
        text: `❌ *YOU DON'T HAVE PERMISSION*\n\n_Want PREMIUM ACCESS? Contact the Owner_\n📞 ${String(config.OWNER_NUMBER || '').split(',').map(n => n.trim()).filter(Boolean).join(' / ')}`
      }, { quoted: msg });
    }

    const bc = await getUserBotConfig(premiumJid);
    // BMP-safe labels: some WhatsApp clients blank astral-plane characters
    // (emoji above U+FFFF and math-alphanumeric letters), so this menu uses
    // only Basic Multilingual Plane glyphs + normal text to stay readable
    // on every device.
    const premiumRows = [
      { label: '✏️ Bot Name', id: `${prefix}botname` },
      { label: '✍️ Bot Footer', id: `${prefix}botfooter` },
      { label: '▸ Bot Image', id: `${prefix}botimg` },
      { label: '◇ Bot Logo', id: `${prefix}botlogo` },
      { label: '☆ Alive Image', id: `${prefix}aliveimg` },
      { label: '✪ Menu Header', id: `${prefix}menuheader` }
    ];
    setPendingRowSelect(sender, premiumRows);

    // Show the ACTUAL saved value (shortened) when customized, else Default.
    const statusOf = (field, val) => (val && String(val).trim() !== '' && val !== PREMIUM_DEFAULTS[field])
      ? '✅ ' + (String(val).slice(0, 26) + (String(val).length > 26 ? '...' : ''))
      : '⬜ Default';
    const premiumStatus =
      `╭━━〔 🎨 *CUSTOMIZATION STATUS* 〕━━⬣\n` +
      `│\n` +
      `│ ✏️ *Bot Name*    : ${statusOf('botName', bc.botName)}\n` +
      `│ ✍️ *Bot Footer*  : ${statusOf('botFooter', bc.botFooter)}\n` +
      `│ ▸ *Bot Image*    : ${statusOf('botImage', bc.botImage)}\n` +
      `│ ◇ *Bot Logo*     : ${statusOf('botLogo', bc.botLogo)}\n` +
      `│ ☆ *Alive Image*  : ${statusOf('aliveImage', bc.aliveImage)}\n` +
      `│ ✪ *Menu Header*  : ${statusOf('menuHeader', bc.menuHeader)}\n` +
      `╰━━━━━━━━━━━━━━━━━━━━━━⬣`;

    // Circled digits keep the option order identical to premiumRows (1-6) so
    // the numbered-reply selection (setPendingRowSelect) works unchanged.
    const optIcons = ['①', '②', '③', '④', '⑤', '⑥'];
    const optionList = premiumRows.map((r, i) =>
      `│ ${optIcons[i] || (i + 1)} ${r.label}  —  _${r.id}_`
    ).join('\n');

    const ut = process.uptime();
    const rtime = `${Math.floor(ut/3600)}h ${Math.floor((ut%3600)/60)}m ${Math.floor(ut%60)}s`;
    const ramUsed = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2);
    const showName = (bc.botName && bc.botName !== PREMIUM_DEFAULTS.botName)
      ? bc.botName
      : 'ISHAN-X MD PRO';

    const fullCaption =
      `╭━━〔 💎 *PREMIUM MENU* 〕━━⬣\n` +
      `│\n` +
      `│ 🤖 *Bot*       : ${showName}\n` +
      `│ ⏱️ *Uptime*   : ${rtime}\n` +
      `│ 💾 *RAM*     : ${ramUsed} MB\n` +
      `╰━━━━━━━━━━━━━━━━⬣\n\n` +
      `${premiumStatus}\n\n` +
      `╭━━〔 ✏️ *SELECT AN OPTION* 〕━━⬣\n` +
      `│\n` +
      `${optionList}\n` +
      `╰━━━━━━━━━━━━━━━━⬣\n\n` +
      `💬 *Reply with a number to edit.*\n` +
      `🔁 *Tip:* _${prefix}botname reset_ → restore the default.\n\n` +
      `> _*Developer By ISHAN-X × LOVELY*_`;

    try {
      await socket.sendMessage(sender, {
        image: { url: resolveBaseMenuImage(bc, config.SET_IMAGE_PATH) },
        caption: fullCaption
      }, { quoted: msg });
    } catch (imgErr) {
      console.error('Premium menu image error, falling back to text:', imgErr);
      await socket.sendMessage(sender, { text: fullCaption }, { quoted: msg });
    }
  } catch (e) {
    console.error('Premium menu error:', e);
    await socket.sendMessage(sender, { text: `*❌ ERROR*\n\n_Failed to load premium menu:_ ${e.message || e}` }, { quoted: msg });
  }
  break;
}

case 'botname':
case 'botfooter':
case 'botimg':
case 'botlogo':
case 'aliveimg':
case 'menuheader': {
  if (!perBotAllowed) break; // multi-bot chat without @mention → no bot acts
  try {
    const field = PREMIUM_CMD_FIELD_MAP[command] || command;
    // Per-bot isolation: the value is saved to THIS bot's own record (keyed
    // by the processing bot's paired number = sock.user.id) — never to the
    // sender's jid, and never to another connected bot. Permission: a manager
    // (owner) may customize any connected bot; otherwise only the bot's own
    // premium user (sender == this bot's number) may customize it.
    const { ok: canManage, premiumJid } = await canManageBotConfig(socket, nowsender);
    if (!canManage) {
      return await socket.sendMessage(sender, {
        text: `❌ *YOU DON'T HAVE PERMISSION*\n\n_Want PREMIUM ACCESS? Contact the Owner_\n📞 ${String(config.OWNER_NUMBER || '').split(',').map(n => n.trim()).filter(Boolean).join(' / ')}`
      }, { quoted: msg });
    }

    const raw = args.join(' ').trim();
    const lower = raw.toLowerCase();
    const IMAGE_FIELDS = ['botImage', 'botLogo', 'aliveImage'];

    // ---- reset ----
    if (lower === 'reset' || lower === 'default' || lower === 'off') {
      const ok = await resetPremiumField(premiumJid, field);
      // Always re-resolve (the premium cache was just cleared) and rebind
      // under the raw sender key too, so LID / device-suffixed lookups in the
      // message handler hit the cache — the confirmation reply shows the new
      // values and every subsequent reply is instantly branded (all fields,
      // incl. aliveimg / menuheader).
      const freshBc = await primeBotBrandCache(socket, premiumJid);
      setCachedBotBrand(nowsender, freshBc);
      bindBrandContext(socket, freshBc);
      await socket.sendMessage(sender, { react: { text: '♻️', key: msg.key } });
      return await socket.sendMessage(sender, {
        text: `*♻️ ${field.toUpperCase()} RESET* ✅\n\nYour custom value was removed. The default bot configuration will be used again.\n\n${config.BOT_FOOTER}`
      }, { quoted: msg });
    }

    let value;
    if (IMAGE_FIELDS.includes(field)) {
      value = await resolveCustomImage(socket, msg, args);
      if (!value) {
        return await socket.sendMessage(sender, {
          text: `*❪ USAGE ❫*\n\n.${field} <image-url>\n_OR reply to an image with:_ .${field}\n\n${config.BOT_FOOTER}`
        }, { quoted: msg });
      }
    } else {
      value = raw;
      if (!value) {
        return await socket.sendMessage(sender, {
          text: `*❪ USAGE ❫*\n\n.${field} <text>\n_Placeholders:_ {botname} {pushname} {name} {jid} {date} {time} {version}\n_Example:_ .${field} Hello {pushname} ❤️\n\n${config.BOT_FOOTER}`
        }, { quoted: msg });
      }
    }

    const ok = await updatePremiumField(premiumJid, field, value);
    if (!ok) return await socket.sendMessage(sender, { text: '❌ Failed to save. Try again later.' }, { quoted: msg });
    // Brand this user instantly (ALL fields, incl. aliveimg / menuheader):
    // re-resolve (the premium cache was just cleared), cache under the raw
    // sender key too, and re-bind this handler's context so even the
    // confirmation reply shows the new values.
    const freshBc = await primeBotBrandCache(socket, premiumJid);
    setCachedBotBrand(nowsender, freshBc);
    bindBrandContext(socket, freshBc);
    await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
    const shown = String(value).slice(0, 100) + (String(value).length > 100 ? '…' : '');
    return await socket.sendMessage(sender, {
      text: `*✏️ ${field.toUpperCase()} SAVED* ✅\n\n_${shown}_\n\n_Use .${field} reset to restore the default._\n\n${config.BOT_FOOTER}`
    }, { quoted: msg });
  } catch (e) {
    console.error('Premium customization error:', e);
    return await socket.sendMessage(sender, { text: '❌ Error saving customization. Try again later.' }, { quoted: msg }).catch(() => {});
  }
}

const { downloadMediaMessage } = require('@whiskeysockets/baileys');

// ... inside your switch/case block


case 'ai':
case 'chat':
case 'gpt': {
  try {
    const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();
    const q = text.split(" ").slice(1).join(" ").trim();

    // --- Config & Bot Name ---
    const sanitized = (sender || '').replace(/[^0-9]/g, '');
    let cfg = await loadUserConfigFromMongo(sanitized) || {};
    let botName = await resolveUserBotName(socket, nowsender, cfg, '★彡 𝐈𝐒𝐇𝐀𝐍-𝐗 𝐌𝐃 𝐏𝐑𝐎 彡★');

    if (!q) {
      await socket.sendMessage(sender, { 
        text: `* 𝙿𝚕𝚎𝚊𝚜𝚎 𝙿𝚛𝚘𝚟𝚒𝚍𝚎 𝙰 𝚀𝚞𝚎𝚜𝚝𝚒𝚘𝚗 !*`
      }, { quoted: msg });
      return;
    }

    // --- Meta AI Contact Style Quote ---
    
    await socket.sendMessage(sender, { react: { text: '🧠', key: msg.key } });
    await socket.sendMessage(sender, { text: '*𝙸𝚂𝙷𝙰𝙽-𝚇 𝙼𝙳 𝙿𝚁𝙾 𝙰𝙸 𝙸𝚜 𝚃𝚑𝚒𝚗𝚔𝚒𝚗𝚐...*', quoted: msg });

    // --- System Prompt & API Logic ---
    // API එකට යවන System Prompt එක (බොට්ගේ හැසිරීම)
    const systemPrompt = `
    ඔබ සැබෑ ගැහැනු ලමයෙකු මෙන් හැසිරිය යුතුය. ඉමෝජි පමනක් තිබේනම් ඔබද ඉමෝජි පමනක් යවන්න.
    ඔයාගේ නම ${botName}. ඔයාගෙන් කවුරුහරි "ඔයාව හැදුවේ කවුද?" හෝ "Who created you?" කියලා ඇහුවොත් පමනක් ඔයා කියන්නේ "මාව හැදුවේ ishan madusanke (ISHAN-X PRO Team)" කියලා.
    User Question: ${q}`;

    // AI API (ikyyxd quilbot)
    const { data } = await axios.get(`https://api.ikyyxd.my.id/ai/quilbot?prompt=${encodeURIComponent(systemPrompt)}`, { timeout: 30000 });

    // API එකෙන් එන Reply එක ගන්න විදිය
    let aiReply = '';
    if (data && data.status && data.result) {
        aiReply = data.result;
    } else {
        throw new Error('No response from API');
    }

    // --- Final Message with Style ---
    await socket.sendMessage(sender, {
      text: `𝐈𝐒𝐇𝐀𝐍-𝐗 𝐌𝐃 𝐏𝐑𝐎 𝐀𝐈 𝐂𝐇𝐀𝐓* 🧠\n\n${aiReply}\n\n_Type ${config.PREFIX}menu for the main menu or ${config.PREFIX}alive for bot info._`,
      footer: `🤖 ${botName}`,
      headerType: 1,
      quoted: msg
    });

  } catch (err) {
    console.error("Error in AI chat:", err);
    await socket.sendMessage(sender, { 
      text: `*𝙸𝚂𝙷𝙰𝙽-𝚇 𝙼𝙳 𝙿𝚁𝙾 𝙰𝙿𝙸 𝙴𝚛𝚛𝚘𝚛 𝚃𝚛𝚢 𝙰𝚐𝚊𝚒𝚗 𝙻𝚊𝚝𝚎𝚛 !*\n\n_Type ${config.PREFIX}menu for the main menu._`
    }, { quoted: msg });
  }
  break;
}

// ==================== AI COMMANDS (GPT-4, DEEPSEEK, COPILOT, BARD, PERPLEXITY, BLACKBOX, META AI, ILAMA, MISTRAL, GROK, SPEECHWRITER, REMOVEBG) ====================
async function callAIApi(apiUrl, responseKey, fallbackKeys) {
  const { data } = await axios.get(apiUrl, { timeout: 30000 });
  let answer = data?.[responseKey];
  if (!answer && fallbackKeys) {
    for (const k of fallbackKeys) {
      answer = data?.[k];
      if (answer) break;
    }
  }
  if (!answer) throw new Error('API failed to generate response!');
  return String(answer).trim();
}

function formatAIAnswer(q, answer) {
  return `*❓ Question:* ${q}\n\n*🤖 Answer:*\n${answer}\n\n${config.BOT_FOOTER}`;
}

case 'gpt4':
case 'chatgpt': {
  try {
    const q = args.join(' ').trim();
    if (!q) { await socket.sendMessage(sender, { text: `*❓ Please provide a question!*\n\n_Example:_ .gpt4 What is AI?\n\n${config.BOT_FOOTER}` }, { quoted: msg }); return; }
    await socket.sendMessage(sender, { react: { text: '🧠', key: msg.key } });
    await socket.sendPresenceUpdate('composing', sender).catch(() => {});
    const answer = await callAIApi(`https://api.ikyyxd.my.id/ai/gpt-5-mini?question=${encodeURIComponent(q)}`, 'result', ['answer','response','message','text','content']);
    await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
    await socket.sendMessage(sender, { text: formatAIAnswer(q, answer) }, { quoted: msg });
  } catch (err) {
    await socket.sendMessage(sender, { react: { text: '❌', key: msg.key } });
    await socket.sendMessage(sender, { text: `*❌ AI Error:* ${err.message || 'Please try again later!'}\n\n${config.BOT_FOOTER}` }, { quoted: msg });
  }
  break;
}

case 'deepseek':
case 'ds': {
  try {
    const q = args.join(' ').trim();
    if (!q) { await socket.sendMessage(sender, { text: `*❓ Please provide a question!*\n\n_Example:_ .deepseek Explain quantum physics\n\n${config.BOT_FOOTER}` }, { quoted: msg }); return; }
    await socket.sendMessage(sender, { react: { text: '🧠', key: msg.key } });
    await socket.sendPresenceUpdate('composing', sender).catch(() => {});
    const answer = await callAIApi(`https://meta-api.zone.id/ai/copilot?message=${encodeURIComponent(q)}`, 'answer', ['result','response','text']);
    await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
    await socket.sendMessage(sender, { text: formatAIAnswer(q, answer) }, { quoted: msg });
  } catch (err) {
    await socket.sendMessage(sender, { react: { text: '❌', key: msg.key } });
    await socket.sendMessage(sender, { text: `*❌ AI Error:* ${err.message || 'Please try again later!'}\n\n${config.BOT_FOOTER}` }, { quoted: msg });
  }
  break;
}

case 'copilot':
case 'mscopilot': {
  try {
    const q = args.join(' ').trim();
    if (!q) { await socket.sendMessage(sender, { text: `*❓ Please provide a question!*\n\n_Example:_ .copilot Write a poem about rain\n\n${config.BOT_FOOTER}` }, { quoted: msg }); return; }
    await socket.sendMessage(sender, { react: { text: '🧠', key: msg.key } });
    await socket.sendPresenceUpdate('composing', sender).catch(() => {});
    const answer = await callAIApi(`https://iamtkm.vercel.app/ai/copilot?apikey=tkm&text=${encodeURIComponent(q)}`, 'result', ['answer','response','text']);
    await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
    await socket.sendMessage(sender, { text: formatAIAnswer(q, answer) }, { quoted: msg });
  } catch (err) {
    await socket.sendMessage(sender, { react: { text: '❌', key: msg.key } });
    await socket.sendMessage(sender, { text: `*❌ AI Error:* ${err.message || 'Please try again later!'}\n\n${config.BOT_FOOTER}` }, { quoted: msg });
  }
  break;
}

case 'bard':
case 'googlebard':
case 'gemini': {
  try {
    const q = args.join(' ').trim();
    if (!q) { await socket.sendMessage(sender, { text: `*❓ Please provide a query!*\n\n_Example:_ .bard Tell me a joke\n\n${config.BOT_FOOTER}` }, { quoted: msg }); return; }
    await socket.sendMessage(sender, { react: { text: '🧠', key: msg.key } });
    await socket.sendPresenceUpdate('composing', sender).catch(() => {});
    const answer = await callAIApi(`https://apiskeith.top/ai/bard?q=${encodeURIComponent(q)}`, 'result', ['answer','response','text']);
    await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
    await socket.sendMessage(sender, { text: formatAIAnswer(q, answer) }, { quoted: msg });
  } catch (err) {
    await socket.sendMessage(sender, { react: { text: '❌', key: msg.key } });
    await socket.sendMessage(sender, { text: `*❌ AI Error:* ${err.message || 'Please try again later!'}\n\n${config.BOT_FOOTER}` }, { quoted: msg });
  }
  break;
}

case 'perplexity':
case 'perplex':
case 'pplx': {
  try {
    const q = args.join(' ').trim();
    if (!q) { await socket.sendMessage(sender, { text: `*❓ Please provide a query!*\n\n_Example:_ .perplexity Latest AI news\n\n${config.BOT_FOOTER}` }, { quoted: msg }); return; }
    await socket.sendMessage(sender, { react: { text: '🧠', key: msg.key } });
    await socket.sendPresenceUpdate('composing', sender).catch(() => {});
    const answer = await callAIApi(`https://apiskeith.top/ai/perplexity?q=${encodeURIComponent(q)}`, 'result', ['answer','response','text']);
    await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
    await socket.sendMessage(sender, { text: formatAIAnswer(q, answer) }, { quoted: msg });
  } catch (err) {
    await socket.sendMessage(sender, { react: { text: '❌', key: msg.key } });
    await socket.sendMessage(sender, { text: `*❌ AI Error:* ${err.message || 'Please try again later!'}\n\n${config.BOT_FOOTER}` }, { quoted: msg });
  }
  break;
}

case 'blackbox':
case 'bb':
case 'bbox': {
  try {
    const q = args.join(' ').trim();
    if (!q) { await socket.sendMessage(sender, { text: `*❓ Please provide a query!*\n\n_Example:_ .blackbox Explain recursion\n\n${config.BOT_FOOTER}` }, { quoted: msg }); return; }
    await socket.sendMessage(sender, { react: { text: '🧠', key: msg.key } });
    await socket.sendPresenceUpdate('composing', sender).catch(() => {});
    const answer = await callAIApi(`https://apiskeith.top/ai/blackbox?q=${encodeURIComponent(q)}`, 'result', ['answer','response','text']);
    await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
    await socket.sendMessage(sender, { text: formatAIAnswer(q, answer) }, { quoted: msg });
  } catch (err) {
    await socket.sendMessage(sender, { react: { text: '❌', key: msg.key } });
    await socket.sendMessage(sender, { text: `*❌ AI Error:* ${err.message || 'Please try again later!'}\n\n${config.BOT_FOOTER}` }, { quoted: msg });
  }
  break;
}

case 'metaai':
case 'meta':
case 'llama': {
  try {
    const q = args.join(' ').trim();
    if (!q) { await socket.sendMessage(sender, { text: `*❓ Please provide a question!*\n\n_Example:_ .metaai What is Llama?\n\n${config.BOT_FOOTER}` }, { quoted: msg }); return; }
    await socket.sendMessage(sender, { react: { text: '🧠', key: msg.key } });
    await socket.sendPresenceUpdate('composing', sender).catch(() => {});
    const { data } = await axios.get(`https://apis.davidcyriltech.my.id/ai/metaai?text=${encodeURIComponent(q)}`, { timeout: 30000 });
    if (!data.success || !data.response) throw new Error('API failed to generate response!');
    const answer = String(data.response).trim();
    await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
    await socket.sendMessage(sender, { text: formatAIAnswer(q, answer) }, { quoted: msg });
  } catch (err) {
    await socket.sendMessage(sender, { react: { text: '❌', key: msg.key } });
    await socket.sendMessage(sender, { text: `*❌ AI Error:* ${err.message || 'Please try again later!'}\n\n${config.BOT_FOOTER}` }, { quoted: msg });
  }
  break;
}

case 'metai':
case 'metav2': {
  try {
    const q = args.join(' ').trim();
    if (!q) { await socket.sendMessage(sender, { text: `*❓ Please provide a query!*\n\n_Example:_ .metai Plan my day\n\n${config.BOT_FOOTER}` }, { quoted: msg }); return; }
    await socket.sendMessage(sender, { react: { text: '🧠', key: msg.key } });
    await socket.sendPresenceUpdate('composing', sender).catch(() => {});
    const answer = await callAIApi(`https://apiskeith.top/ai/metai?q=${encodeURIComponent(q)}`, 'result', ['answer','response','text']);
    await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
    await socket.sendMessage(sender, { text: formatAIAnswer(q, answer) }, { quoted: msg });
  } catch (err) {
    await socket.sendMessage(sender, { react: { text: '❌', key: msg.key } });
    await socket.sendMessage(sender, { text: `*❌ AI Error:* ${err.message || 'Please try again later!'}\n\n${config.BOT_FOOTER}` }, { quoted: msg });
  }
  break;
}

case 'ilama':
case 'llama2': {
  try {
    const q = args.join(' ').trim();
    if (!q) { await socket.sendMessage(sender, { text: `*❓ Please provide a query!*\n\n_Example:_ .ilama Write a short story\n\n${config.BOT_FOOTER}` }, { quoted: msg }); return; }
    await socket.sendMessage(sender, { react: { text: '🧠', key: msg.key } });
    await socket.sendPresenceUpdate('composing', sender).catch(() => {});
    const answer = await callAIApi(`https://apiskeith.top/ai/ilama?q=${encodeURIComponent(q)}`, 'result', ['answer','response','text']);
    await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
    await socket.sendMessage(sender, { text: formatAIAnswer(q, answer) }, { quoted: msg });
  } catch (err) {
    await socket.sendMessage(sender, { react: { text: '❌', key: msg.key } });
    await socket.sendMessage(sender, { text: `*❌ AI Error:* ${err.message || 'Please try again later!'}\n\n${config.BOT_FOOTER}` }, { quoted: msg });
  }
  break;
}

case 'mistral':
case 'mist': {
  try {
    const q = args.join(' ').trim();
    if (!q) { await socket.sendMessage(sender, { text: `*❓ Please provide a query!*\n\n_Example:_ .mistral Summarize this text\n\n${config.BOT_FOOTER}` }, { quoted: msg }); return; }
    await socket.sendMessage(sender, { react: { text: '🧠', key: msg.key } });
    await socket.sendPresenceUpdate('composing', sender).catch(() => {});
    const answer = await callAIApi(`https://apiskeith.top/ai/mistral?q=${encodeURIComponent(q)}`, 'result', ['answer','response','text']);
    await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
    await socket.sendMessage(sender, { text: formatAIAnswer(q, answer) }, { quoted: msg });
  } catch (err) {
    await socket.sendMessage(sender, { react: { text: '❌', key: msg.key } });
    await socket.sendMessage(sender, { text: `*❌ AI Error:* ${err.message || 'Please try again later!'}\n\n${config.BOT_FOOTER}` }, { quoted: msg });
  }
  break;
}

case 'grok':
case 'xai': {
  try {
    const q = args.join(' ').trim();
    if (!q) { await socket.sendMessage(sender, { text: `*❓ Please provide a question!*\n\n_Example:_ .grok What is the meaning of life?\n\n${config.BOT_FOOTER}` }, { quoted: msg }); return; }
    await socket.sendMessage(sender, { react: { text: '🧠', key: msg.key } });
    await socket.sendPresenceUpdate('composing', sender).catch(() => {});
    const { data } = await axios.get(`https://apiskeith.vercel.app/ai/grok?q=${encodeURIComponent(q)}`, { timeout: 30000 });
    if (!data?.status || !data?.result) throw new Error('API returned error');
    const answer = String(data.result).trim();
    await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
    await socket.sendMessage(sender, { text: formatAIAnswer(q, answer) }, { quoted: msg });
  } catch (err) {
    await socket.sendMessage(sender, { react: { text: '❌', key: msg.key } });
    await socket.sendMessage(sender, { text: `*❌ AI Error:* ${err.message || 'Please try again later!'}\n\n${config.BOT_FOOTER}` }, { quoted: msg });
  }
  break;
}

case 'speechwriter':
case 'speech':
case 'writer': {
  try {
    const q = args.join(' ').trim();
    if (!q) { await socket.sendMessage(sender, { text: `*❓ Please provide a topic!*\n\n_Example:_ .speechwriter Thank you speech\n\n${config.BOT_FOOTER}` }, { quoted: msg }); return; }
    if (q.length > 200) { await socket.sendMessage(sender, { text: `*❌ Topic too long! Max 200 characters.*\n\n${config.BOT_FOOTER}` }, { quoted: msg }); return; }
    await socket.sendMessage(sender, { react: { text: '🧠', key: msg.key } });
    await socket.sendPresenceUpdate('composing', sender).catch(() => {});
    const { data } = await axios.get(`https://apiskeith.top/ai/speechwriter?topic=${encodeURIComponent(q)}&length=short&type=dedication&tone=serious`, { timeout: 30000 });
    if (!data?.status || !data?.result?.data?.data?.speech) throw new Error('Invalid response from Speechwriter API!');
    const speech = String(data.result.data.data.speech).trim();
    await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
    await socket.sendMessage(sender, { text: formatAIAnswer(q, speech) }, { quoted: msg });
  } catch (err) {
    await socket.sendMessage(sender, { react: { text: '❌', key: msg.key } });
    await socket.sendMessage(sender, { text: `*❌ AI Error:* ${err.message || 'Please try again later!'}\n\n${config.BOT_FOOTER}` }, { quoted: msg });
  }
  break;
}

case 'removebg':
case 'rmbg':
case 'nobg': {
  try {
    const { downloadMediaMessage } = require('@whiskeysockets/baileys');
    let imageUrl = null;
    if (args[0] && args[0].startsWith('http')) {
      imageUrl = args[0];
    } else {
      const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
      const imgMsg = quoted?.imageMessage || msg.message?.imageMessage;
      if (imgMsg) {
        const quotedMsg = { key: msg.key, message: { imageMessage: imgMsg } };
        const buf = await downloadMediaMessage(quotedMsg, 'buffer', {}, { logger: console });
        imageUrl = `data:image/jpeg;base64,${buf.toString('base64')}`;
      }
    }
    if (!imageUrl) { await socket.sendMessage(sender, { text: `*❌ Usage:* Reply to an image with .removebg or use .removebg <image_url>\n\n${config.BOT_FOOTER}` }, { quoted: msg }); return; }
    await socket.sendMessage(sender, { react: { text: '🪄', key: msg.key } });
    await socket.sendMessage(sender, { text: `*🪄 Removing background, please wait...*\n\n${config.BOT_FOOTER}` }, { quoted: msg });
    const response = await axios.get(`https://api.siputzx.my.id/api/iloveimg/removebg?image=${encodeURIComponent(imageUrl)}`, { responseType: 'arraybuffer', timeout: 45000 });
    if (!response.data) throw new Error('Failed to process image');
    const contentType = String(response.headers?.['content-type'] || '');
    if (!contentType.startsWith('image/')) throw new Error('API did not return an image');
    await socket.sendMessage(sender, { image: Buffer.from(response.data), caption: `*🪄 Background removed successfully!*\n\n${config.BOT_FOOTER}` }, { quoted: msg });
  } catch (err) {
    await socket.sendMessage(sender, { text: `*❌ Error:* ${err.message || 'Failed to process image!'}\n\n${config.BOT_FOOTER}` }, { quoted: msg });
  }
  break;
}

// ==================== GEMINI FLASH IMAGE EDIT ====================
case 'geminiedit':
case 'gedit': {
  try {
    await socket.sendMessage(sender, { react: { text: '✨', key: msg.key } });
    const { prompt, imageUrl } = await nanoExtractImage(msg, args);
    if (!imageUrl) {
      await socket.sendMessage(sender, { text: `*✨ GEMINI EDIT*\n\n*❌ Image required.*\nReply to an image or provide an image URL.\n\n${config.BOT_FOOTER}` }, { quoted: msg });
      return;
    }
    if (!prompt) {
      await socket.sendMessage(sender, { text: `*✨ GEMINI EDIT*\n\nReply to an image and provide an edit prompt.\n\n*Example:*\n  .geminiedit Make it cinematic\n\n${config.BOT_FOOTER}` }, { quoted: msg });
      return;
    }
    await socket.sendMessage(sender, { text: `*✨ Editing image with Gemini Flash...*` }, { quoted: msg });
    const { data } = await axios.get(`https://api.ikyyxd.my.id/edit/gemini-flash?prompt=${encodeURIComponent(prompt)}&url=${encodeURIComponent(imageUrl)}`, { timeout: 90000 });
    if (!data?.status || !data?.result) throw new Error('API returned error');
    const resultUrl = data.result;
    let sent = false;
    try {
      const imgBuf = await getBuffer(resultUrl);
      await socket.sendMessage(sender, { image: imgBuf, caption: `✨ *Gemini Flash Edit*\n\n📌 Prompt: ${prompt}\n\n${config.BOT_FOOTER}` }, { quoted: msg });
      sent = true;
    } catch (e) {}
    if (!sent) {
      await socket.sendMessage(sender, { image: { url: resultUrl }, mimetype: 'image/jpeg', caption: `✨ *Gemini Flash Edit*\n\n📌 Prompt: ${prompt}\n\n${config.BOT_FOOTER}` }, { quoted: msg }).catch(() => {});
    }
    await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
  } catch (err) {
    console.error('[GEMINIEDIT CMD ERROR]', err);
    await socket.sendMessage(sender, { react: { text: '❌', key: msg.key } });
    await socket.sendMessage(sender, { text: `*❌ Unable to process request.*\n\n${config.BOT_FOOTER}` }, { quoted: msg });
  }
  break;
}

// ==================== FACE SWAP (two images) ====================
case 'faceswap':
case 'fswap': {
  try {
    await socket.sendMessage(sender, { react: { text: '🔁', key: msg.key } });
    // Two image URLs required: url1 (source face) & url2 (target image).
    // Accept either ".faceswap <url1> <url2>" or reply to an image while
    // providing the second URL as the argument.
    let url1 = null;
    let url2 = null;
    const urlArgs = (args || []).filter(a => /^https?:\/\/\S+/i.test(a));
    const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
    const imgMsg = quoted?.imageMessage || msg.message?.imageMessage;
    if (urlArgs.length >= 2) {
      url1 = urlArgs[0];
      url2 = urlArgs[1];
    } else if (urlArgs.length === 1) {
      url2 = urlArgs[0];
    }
    // Fill url1 from a quoted/replied image if not given.
    if (!url1 && imgMsg) {
      const { downloadMediaMessage } = require('@whiskeysockets/baileys');
      const quotedMsg = { key: msg.key, message: { imageMessage: imgMsg } };
      const buf = await downloadMediaMessage(quotedMsg, 'buffer', {}, { logger: console });
      url1 = `data:image/jpeg;base64,${buf.toString('base64')}`;
    }
    if (!url1 || !url2) {
      await socket.sendMessage(sender, { text: `*🔁 FACE SWAP*\n\n*❌ Two images required.*\n\n*Usage:*\n  .faceswap <source_url> <target_url>\n  .faceswap <target_url> (reply to the source image)\n\n${config.BOT_FOOTER}` }, { quoted: msg });
      return;
    }
    await socket.sendMessage(sender, { text: `*🔁 Swapping faces...*\n\n${config.BOT_FOOTER}` }, { quoted: msg });
    const { data } = await axios.get(`https://api.ikyyxd.my.id/edit/faceswap?url1=${encodeURIComponent(url1)}&url2=${encodeURIComponent(url2)}`, { timeout: 120000 });
    if (!data?.status) throw new Error(data?.message || data?.error || 'API returned error');
    let resultUrl = typeof data.result === 'string' ? data.result : (data.result?.image || data.result?.url || data.result?.result_url);
    if (!resultUrl) throw new Error('No image URL in response');
    let sent = false;
    try {
      const imgBuf = await getBuffer(resultUrl);
      await socket.sendMessage(sender, { image: imgBuf, caption: `🔁 *Face Swap*\n\n${config.BOT_FOOTER}` }, { quoted: msg });
      sent = true;
    } catch (e) {}
    if (!sent) {
      await socket.sendMessage(sender, { image: { url: resultUrl }, mimetype: 'image/jpeg', caption: `🔁 *Face Swap*\n\n${config.BOT_FOOTER}` }, { quoted: msg }).catch(() => {});
    }
    await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
  } catch (err) {
    console.error('[FACESWAP CMD ERROR]', err);
    await socket.sendMessage(sender, { react: { text: '❌', key: msg.key } });
    await socket.sendMessage(sender, { text: `*❌ Unable to process request.*\n\n${config.BOT_FOOTER}` }, { quoted: msg });
  }
  break;
}

// ==================== GROK VIDEO GENERATOR ====================
case 'grokvideo':
case 'gv': {
  try {
    const q = args.join(' ').trim();
    if (!q) { await socket.sendMessage(sender, { text: `*❓ Please provide a prompt!*\n\n_Example:_ .grokvideo a cat walking\n\n${config.BOT_FOOTER}` }, { quoted: msg }); return; }
    await socket.sendMessage(sender, { react: { text: '🎥', key: msg.key } });
    await socket.sendMessage(sender, { text: `*🎥 Generating video... this can take a minute.*\n\n${config.BOT_FOOTER}` }, { quoted: msg });
    const { data } = await axios.get(`https://api.ikyyxd.my.id/ai/GrokVideo?prompt=${encodeURIComponent(q)}`, { timeout: 180000 });
    if (!data?.status || !data?.result?.video_mp4) throw new Error('API returned error');
    const videoUrl = data.result.video_mp4;
    let tmpPath = null;
    try {
      tmpPath = videoTempPath('mp4');
      await videoStreamToFile(videoUrl, tmpPath);
      if (videoTooBigForChat(tmpPath)) {
        await socket.sendMessage(sender, { document: { url: tmpPath }, mimetype: 'video/mp4', fileName: `grokvideo_${Date.now()}.mp4`, caption: `🎥 *Grok Video*\n\n📌 Prompt: ${q}\n⏱️ Duration: ${data.result.duration || 'N/A'}\n\n${config.BOT_FOOTER}` }, { quoted: msg });
      } else {
        await socket.sendMessage(sender, { video: { url: tmpPath }, mimetype: 'video/mp4', caption: `🎥 *Grok Video*\n\n📌 Prompt: ${q}\n⏱️ Duration: ${data.result.duration || 'N/A'}\n\n${config.BOT_FOOTER}` }, { quoted: msg });
      }
      await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
    } finally {
      if (tmpPath) { try { fs.unlinkSync(tmpPath); } catch (e) {} }
    }
  } catch (err) {
    await socket.sendMessage(sender, { react: { text: '❌', key: msg.key } });
    await socket.sendMessage(sender, { text: `*❌ Grok Video Error:* ${err.message || 'Please try again later!'}\n\n${config.BOT_FOOTER}` }, { quoted: msg });
  }
  break;
}

// ==================== REMOVE CLOTHES (NSFW, 18+ verified only) ====================
case 'removeclothes':
case 'removeclothesv2': {
  // 🔞 18+ gate: NSFW content requires owner verification (.verify18 <jid>).
  if (!(await isNsfwVerified(socket, nowsender))) {
    await socket.sendMessage(sender, { text: nsfwDeniedText() }, { quoted: msg });
    break;
  }
  const nsfwKey = config.IKYYXD_NSFW_KEY;
  if (!nsfwKey) {
    await socket.sendMessage(sender, { text: `*❌ NSFW key not configured.* Owner must set IKYYXD_NSFW_KEY.\n\n${config.BOT_FOOTER}` }, { quoted: msg });
    break;
  }
  try {
    let imageUrl = null;
    if (args[0] && args[0].startsWith('http')) {
      imageUrl = args[0];
    } else {
      const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
      const imgMsg = quoted?.imageMessage || msg.message?.imageMessage;
      if (imgMsg) {
        const { downloadMediaMessage } = require('@whiskeysockets/baileys');
        const quotedMsg = { key: msg.key, message: { imageMessage: imgMsg } };
        const buf = await downloadMediaMessage(quotedMsg, 'buffer', {}, { logger: console });
        imageUrl = `data:image/jpeg;base64,${buf.toString('base64')}`;
      }
    }
    if (!imageUrl) { await socket.sendMessage(sender, { text: `*❌ Usage:* Reply to an image with .removeclothes or use .removeclothes <image_url>\n\n${config.BOT_FOOTER}` }, { quoted: msg }); return; }
    await socket.sendMessage(sender, { react: { text: '🪄', key: msg.key } });
    await socket.sendMessage(sender, { text: `*🪄 Processing image, please wait...*\n\n${config.BOT_FOOTER}` }, { quoted: msg });
    const endpoint = command === 'removeclothesv2'
      ? `https://api.ikyyxd.my.id/edit/remove-clothesv2?url=${encodeURIComponent(imageUrl)}&key=${encodeURIComponent(nsfwKey)}`
      : `https://api.ikyyxd.my.id/edit/remove-clothes?url=${encodeURIComponent(imageUrl)}&key=${encodeURIComponent(nsfwKey)}`;
    const { data } = await axios.get(endpoint, { timeout: 90000 });
    if (!data?.status) throw new Error(data?.message || 'API returned error');
    let resultUrl = typeof data.result === 'string' ? data.result : (data.result?.image || data.result?.url || data.result?.result_url);
    if (!resultUrl) throw new Error('No image URL in response');
    let sent = false;
    try {
      const imgBuf = await getBuffer(resultUrl);
      await socket.sendMessage(sender, { image: imgBuf, caption: `🪄 *Processed*\n\n${config.BOT_FOOTER}` }, { quoted: msg });
      sent = true;
    } catch (e) {}
    if (!sent) {
      await socket.sendMessage(sender, { image: { url: resultUrl }, mimetype: 'image/jpeg', caption: `🪄 *Processed*\n\n${config.BOT_FOOTER}` }, { quoted: msg }).catch(() => {});
    }
    await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
  } catch (err) {
    await socket.sendMessage(sender, { react: { text: '❌', key: msg.key } });
    await socket.sendMessage(sender, { text: `*❌ Error:* ${err.message || 'Failed to process image!'}\n\n${config.BOT_FOOTER}` }, { quoted: msg });
  }
  break;
}

// ==================== XVideos / XNXX (NSFW, 18+ verified only) ====================
case 'xvideos':
case 'xsearch': {
    // 🔞 18+ gate: NSFW content requires owner verification (.verify18 <jid>).
    if (!(await isNsfwVerified(socket, nowsender))) {
        await socket.sendMessage(sender, { text: nsfwDeniedText() }, { quoted: msg });
        break;
    }
    // 🔞 XVideos search → pick video → pick quality → download. Reply handling
    // follows the hardened .hanime/.cartoon pattern: quote-match OR plain
    // numbered reply (only the latest menu wins), multi-bot @mention gate,
    // and full listener cleanup.
    const XV_FOOTER = `\n\n${config.BOT_FOOTER}`;
    const XV_DEFAULT_IMAGE = 'https://cdn77-pic.xvideos-cdn.com/m=30,f=p/2022/06/29/16/00/00/21716765/thumb5.jpg';
    const xvRequester = nowsender; // actual user (not the chat jid) who ran the command

    if (!args.length) {
        await socket.sendMessage(sender, {
            text: `*❪ ERROR ❫*\n\n⚠️ *Invalid Usage!*\n\n🔞 *Example:*\n• ${prefix}xvideos mom\n• ${prefix}xvideos step sister\n\n📝 _Please provide the search query!_${XV_FOOTER}`
        }, { quoted: msg });
        break;
    }

    const query = args.join(' ');
    await socket.sendMessage(sender, {
        text: `*❪ SEARCHING ❫*\n\n🔞 *Searching XVideos...*\n⚡ _Please wait a moment._`
    }, { quoted: msg });

    try {
        const searchRes = await axios.get(`https://shyracore.indevs.in/api/search/xvideos?query=${encodeURIComponent(query)}&apikey=${SHYRACORE_API_KEY}`, { timeout: 30000 });
        const searchData = searchRes.data;
        if (!searchData || !searchData.status || !Array.isArray(searchData.result) || searchData.result.length === 0) {
            await socket.sendMessage(sender, {
                text: `*❪ NO RESULTS ❫*\n\n😞 *No Results Found!*\n\n🔞 *Query:* _${query}_\n💡 *Tip:* _Please check the spelling and try again!_${XV_FOOTER}`
            }, { quoted: msg });
            break;
        }

        const results = searchData.result.slice(0, 10);
        const searchRows = results.map((item, index) => {
            const num = String(index + 1).padStart(2, '0');
            return { num, title: String(item.title || '').substring(0, 45) };
        });

        const searchCaption = `╭〔 🔞 𝐗𝐕𝐈𝐃𝐄𝐎𝐒 • 𝐒𝐄𝐀𝐑𝐂𝐇 〕━⬣\n│\n│ 🔎 𝐐𝐮𝐞𝐫𝐲    : ${query}\n│ 📊 𝐑𝐞𝐬𝐮𝐥𝐭𝐬  : ${results.length}\n│ 🌐 𝐒𝐨𝐮𝐫𝐜𝐞   : XVideos\n│\n╰━━━━━━━━━━━━━━━━⬣\n\n📥 *𝐒𝐄𝐋𝐄𝐂𝐓 𝐀 𝐕𝐈𝐃𝐄𝐎*\n\n${searchRows.map(row => `${row.num} ➜ 🔞 _${row.title}_`).join('\n')}\n\n💬 *Reply with the corresponding number.*\n${XV_FOOTER}`;

        let sentMsg;
        try {
            sentMsg = await socket.sendMessage(sender, { image: { url: results[0].thumb || XV_DEFAULT_IMAGE }, caption: searchCaption }, { quoted: msg });
        } catch (e) {
            sentMsg = await socket.sendMessage(sender, { text: searchCaption }, { quoted: msg });
        }
        const messageID = sentMsg.key.id;
        xvPendingMsg.set(sender, { msgId: messageID, kind: 'search', ts: Date.now() });

        const handleSelection = async ({ messages: replyMessages }) => {
            const replyMek = replyMessages[0];
            if (!replyMek?.message) return;
            if (!(await mayProcessSelectionReply(socket, replyMek))) return;

            const messageType = replyMek.message.conversation || replyMek.message.extendedTextMessage?.text;
            const isReplyToSentMsg = replyMek.message.extendedTextMessage?.contextInfo?.stanzaId === messageID;
            const pendingHere = xvPendingMsg.get(sender);
            const isPlainNum = /^\d+$/.test(String(messageType || '').trim());
            const plainSearchOk = isPlainNum && !!pendingHere && pendingHere.kind === 'search' && pendingHere.msgId === messageID &&
                (!replyMek.key.participant || replyMek.key.participant === xvRequester);

            if ((isReplyToSentMsg || plainSearchOk) && sender === replyMek.key.remoteJid) {
                const choice = parseInt(messageType, 10) - 1;
                if (isNaN(choice) || choice < 0 || choice >= results.length) {
                    await socket.sendMessage(sender, { text: `*❪ INVALID ❫*\n\n⚠️ *Wrong Number!*\n🎯 *Range:* _01 - ${results.length}_\n📝 _Please reply with a valid number!_${XV_FOOTER}` }, { quoted: replyMek });
                    return;
                }

                const selectedItem = results[choice];
                await socket.sendMessage(sender, { text: `*❪ FETCHING ❫*\n\n🔞 *Fetching download links...*\n⚡ _Please wait..._` }, { quoted: replyMek });

                try {
                    const dlRes = await axios.get(`https://shyracore.indevs.in/api/downloader/xnxx?url=${encodeURIComponent(selectedItem.url)}&apikey=${SHYRACORE_API_KEY}`, { timeout: 40000 });
                    const dlData = dlRes.data;
                    const validDownloads = (dlData && dlData.status && Array.isArray(dlData.result?.video))
                        ? dlData.result.video.filter(d => d && d.url)
                        : [];

                    if (validDownloads.length === 0) {
                        await socket.sendMessage(sender, { text: `*❪ NO DOWNLOADS ❫*\n\n⚠️ *No Downloads Found!*\n😞 _There are no downloads available for this video!_${XV_FOOTER}` }, { quoted: replyMek });
                        return;
                    }

                    const videoTitle = String(dlData.result.title || selectedItem.title || 'XVideos Video');
                    const optionsText = `╭〔 🔞 𝐗𝐕𝐈𝐃𝐄𝐎𝐒 𝐃𝐄𝐓𝐀𝐈𝐋𝐒 〕━⬣\n│\n│ 🎬 𝐓𝐢𝐭𝐥𝐞     : ${videoTitle.substring(0, 45)}\n│ ⏱️ 𝐃𝐮𝐫𝐚𝐭𝐢𝐨𝐧 : ${selectedItem.duration || 'N/A'}\n│\n╰━━━━━━━━━━━━━━━━⬣\n\n📥 *𝐒𝐄𝐋𝐄𝐂𝐓 𝐀 𝐐𝐔𝐀𝐋𝐈𝐓𝐘*\n\n${validDownloads.map((dl, i) => `${String(i + 1).padStart(2, '0')} ➜ 🎬 _${String(dl.size || 'Download')}_`).join('\n')}\n\n💬 *Reply with the corresponding number.*\n${XV_FOOTER}`;

                    let optionsMsg;
                    try {
                        optionsMsg = await socket.sendMessage(sender, { image: { url: selectedItem.thumb || XV_DEFAULT_IMAGE }, caption: optionsText }, { quoted: replyMek });
                    } catch (e) {
                        optionsMsg = await socket.sendMessage(sender, { text: optionsText }, { quoted: replyMek });
                    }
                    const optionsMsgID = optionsMsg.key.id;
                    xvPendingMsg.set(sender, { msgId: optionsMsgID, kind: 'quality', ts: Date.now() });

                    const handleDownload = async ({ messages: downloadMessages }) => {
                        const downloadMek = downloadMessages[0];
                        if (!downloadMek?.message) return;
                        if (!(await mayProcessSelectionReply(socket, downloadMek))) return;

                        const downloadChoice = downloadMek.message.conversation || downloadMek.message.extendedTextMessage?.text;
                        const isReplyToOptionsMsg = downloadMek.message.extendedTextMessage?.contextInfo?.stanzaId === optionsMsgID;
                        const pendingHere2 = xvPendingMsg.get(sender);
                        const isPlainNum2 = /^\d+$/.test(String(downloadChoice || '').trim());
                        const plainQualityOk = isPlainNum2 && !!pendingHere2 && pendingHere2.kind === 'quality' && pendingHere2.msgId === optionsMsgID &&
                            (!downloadMek.key.participant || downloadMek.key.participant === xvRequester);

                        if ((isReplyToOptionsMsg || plainQualityOk) && sender === downloadMek.key.remoteJid) {
                            const choiceNum = parseInt(downloadChoice, 10) - 1;
                            if (isNaN(choiceNum) || choiceNum < 0 || choiceNum >= validDownloads.length) {
                                await socket.sendMessage(sender, { text: `*❪ INVALID ❫*\n\n⚠️ *Wrong Option!*\n🎯 *Range:* _01 - ${validDownloads.length}_\n📝 _Please reply with a valid download option number!_${XV_FOOTER}` }, { quoted: downloadMek });
                                return;
                            }

                            const finalDirectLink = validDownloads[choiceNum].url;
                            await socket.sendMessage(sender, { react: { text: '⏳', key: downloadMek.key } });
                            await socket.sendMessage(sender, { text: `*❪ DOWNLOADING ❫*\n\n🎬 *Sending Direct MP4 Video...*\n⚡ _Please wait while video is being processed..._${XV_FOOTER}` }, { quoted: downloadMek });

                            try {
                                let tmpPath = null;
                                try {
                                    tmpPath = videoTempPath('mp4');
                                    await videoStreamToFile(finalDirectLink, tmpPath);
                                    if (videoTooBigForChat(tmpPath)) {
                                        await socket.sendMessage(sender, {
                                            document: { url: tmpPath },
                                            mimetype: 'video/mp4',
                                            fileName: `${videoTitle.replace(/[\\/:*?"<>|]/g, '').substring(0, 60)}.mp4`,
                                            caption: `*🔞 𝗫𝗩𝗜𝗗𝗘𝗢𝗦 𝗩𝗜𝗗𝗘𝗢 🔞*\n\n🎭 *Title:* ${videoTitle.substring(0, 45)}\n📊 *Quality:* ${String(validDownloads[choiceNum].size || 'N/A')}\n\n${XV_FOOTER}`
                                        }, { quoted: downloadMek });
                                    } else {
                                        await socket.sendMessage(sender, {
                                            video: { url: tmpPath },
                                            mimetype: 'video/mp4',
                                            caption: `*🔞 𝗫𝗩𝗜𝗗𝗘𝗢𝗦 𝗩𝗜𝗗𝗘𝗢 🔞*\n\n🎭 *Title:* ${videoTitle.substring(0, 45)}\n📊 *Quality:* ${String(validDownloads[choiceNum].size || 'N/A')}\n\n${XV_FOOTER}`
                                        }, { quoted: downloadMek });
                                    }
                                    await socket.sendMessage(sender, { react: { text: '✅', key: downloadMek.key } });
                                } finally {
                                    if (tmpPath) { try { fs.unlinkSync(tmpPath); } catch (e) {} }
                                }
                            } catch (dlErr) {
                                console.error('XVideos download error:', dlErr);
                                await socket.sendMessage(sender, { text: `*❪ ERROR ❫*\n\n❌ *Video Sending Failed!*\n🚫 _${dlErr.message}_${XV_FOOTER}` }, { quoted: downloadMek });
                            } finally {
                                socket.ev.off('messages.upsert', handleDownload);
                                socket.ev.off('messages.upsert', handleSelection);
                                pendingInlineListeners.delete(sender);
                            }
                        }
                    };

                    pendingInlineListeners.add(sender);
                    socket.ev.on('messages.upsert', handleDownload);

                } catch (dlError) {
                    console.error('XVideos details error:', dlError);
                    await socket.sendMessage(sender, { text: `*❪ ERROR ❫*\n\n❌ *Video Details Error!*\n🚫 _${dlError.message}_${XV_FOOTER}` }, { quoted: replyMek });
                    socket.ev.off('messages.upsert', handleSelection);
                    pendingInlineListeners.delete(sender);
                }
            }
        };

        pendingInlineListeners.add(sender);
        socket.ev.on('messages.upsert', handleSelection);

    } catch (error) {
        console.error('XVideos command error:', error);
        await socket.sendMessage(sender, { text: `*❪ SYSTEM ERROR ❫*\n\n❌ *System Error!*\n🚫 _${error.message || 'Unknown error'}_\n\n🔄 _Please try again later..._${XV_FOOTER}` }, { quoted: msg });
    }
    break;
}

// ==================== XNXX SEARCH (NSFW, 18+ verified only) ====================
case 'xnxxs':
case 'xnxxsearch': {
    // 🔞 18+ gate
    if (!(await isNsfwVerified(socket, nowsender))) {
        await socket.sendMessage(sender, { text: nsfwDeniedText() }, { quoted: msg });
        break;
    }
    // 🔞 XNXX search → pick video → pick quality → download. Same hardened
    // inline-reply pattern as .xvideos (quote-match OR plain numbered reply,
    // multi-bot @mention gate, full listener cleanup).
    const XN_FOOTER = `\n\n${config.BOT_FOOTER}`;
    const xnRequester = nowsender;

    if (!args.length) {
        await socket.sendMessage(sender, {
            text: `*❪ ERROR ❫*\n\n⚠️ *Invalid Usage!*\n\n🔞 *Example:*\n• ${prefix}xnxxs mom\n• ${prefix}xnxxs step sister\n\n📝 _Please provide the search query!_${XN_FOOTER}`
        }, { quoted: msg });
        break;
    }

    const query = args.join(' ');
    await socket.sendMessage(sender, {
        text: `*❪ SEARCHING ❫*\n\n🔞 *Searching XNXX...*\n⚡ _Please wait a moment._`
    }, { quoted: msg });

    try {
        const searchRes = await axios.get(`https://shyracore.indevs.in/api/search/xnxx?query=${encodeURIComponent(query)}&apikey=${SHYRACORE_API_KEY}`, { timeout: 30000 });
        const searchData = searchRes.data;
        if (!searchData || !searchData.status || !Array.isArray(searchData.result) || searchData.result.length === 0) {
            await socket.sendMessage(sender, {
                text: `*❪ NO RESULTS ❫*\n\n😞 *No Results Found!*\n\n🔞 *Query:* _${query}_\n💡 *Tip:* _Please check the spelling and try again!_${XN_FOOTER}`
            }, { quoted: msg });
            break;
        }

        const results = searchData.result.slice(0, 10);
        const searchRows = results.map((item, index) => {
            const num = String(index + 1).padStart(2, '0');
            return { num, title: String(item.title || '').substring(0, 45) };
        });

        const searchCaption = `╭〔 🔞 𝐗𝐍𝐗𝐗 • 𝐒𝐄𝐀𝐑𝐂𝐇 〕━⬣\n│\n│ 🔎 𝐐𝐮𝐞𝐫𝐲    : ${query}\n│ 📊 𝐑𝐞𝐬𝐮𝐥𝐭𝐬  : ${results.length}\n│ 🌐 𝐒𝐨𝐮𝐫𝐜𝐞   : XNXX\n│\n╰━━━━━━━━━━━━━━━━⬣\n\n📥 *𝐒𝐄𝐋𝐄𝐂𝐓 𝐀 𝐕𝐈𝐃𝐄𝐎*\n\n${searchRows.map(row => `${row.num} ➜ 🔞 _${row.title}_`).join('\n')}\n\n💬 *Reply with the corresponding number.*\n${XN_FOOTER}`;

        const sentMsg = await socket.sendMessage(sender, { text: searchCaption }, { quoted: msg });
        const messageID = sentMsg.key.id;
        xvPendingMsg.set(sender, { msgId: messageID, kind: 'search', ts: Date.now() });

        const handleSelection = async ({ messages: replyMessages }) => {
            const replyMek = replyMessages[0];
            if (!replyMek?.message) return;
            if (!(await mayProcessSelectionReply(socket, replyMek))) return;

            const messageType = replyMek.message.conversation || replyMek.message.extendedTextMessage?.text;
            const isReplyToSentMsg = replyMek.message.extendedTextMessage?.contextInfo?.stanzaId === messageID;
            const pendingHere = xvPendingMsg.get(sender);
            const isPlainNum = /^\d+$/.test(String(messageType || '').trim());
            const plainSearchOk = isPlainNum && !!pendingHere && pendingHere.kind === 'search' && pendingHere.msgId === messageID &&
                (!replyMek.key.participant || replyMek.key.participant === xnRequester);

            if ((isReplyToSentMsg || plainSearchOk) && sender === replyMek.key.remoteJid) {
                const choice = parseInt(messageType, 10) - 1;
                if (isNaN(choice) || choice < 0 || choice >= results.length) {
                    await socket.sendMessage(sender, { text: `*❪ INVALID ❫*\n\n⚠️ *Wrong Number!*\n🎯 *Range:* _01 - ${results.length}_\n📝 _Please reply with a valid number!_${XN_FOOTER}` }, { quoted: replyMek });
                    return;
                }

                const selectedItem = results[choice];
                await socket.sendMessage(sender, { text: `*❪ FETCHING ❫*\n\n🔞 *Fetching download links...*\n⚡ _Please wait..._` }, { quoted: replyMek });

                try {
                    const dlRes = await axios.get(`https://shyracore.indevs.in/api/downloader/xnxx?url=${encodeURIComponent(selectedItem.url)}&apikey=${SHYRACORE_API_KEY}`, { timeout: 40000 });
                    const dlData = dlRes.data;
                    const validDownloads = (dlData && dlData.status && Array.isArray(dlData.result?.video))
                        ? dlData.result.video.filter(d => d && d.url)
                        : [];

                    if (validDownloads.length === 0) {
                        await socket.sendMessage(sender, { text: `*❪ NO DOWNLOADS ❫*\n\n⚠️ *No Downloads Found!*\n😞 _There are no downloads available for this video!_${XN_FOOTER}` }, { quoted: replyMek });
                        return;
                    }

                    const videoTitle = String(dlData.result.title || selectedItem.title || 'XNXX Video');
                    const optionsText = `╭〔 🔞 𝐗𝐍𝐗𝐗 𝐃𝐄𝐓𝐀𝐈𝐋𝐒 〕━⬣\n│\n│ 🎬 𝐓𝐢𝐭𝐥𝐞     : ${videoTitle.substring(0, 45)}\n│\n╰━━━━━━━━━━━━━━━━⬣\n\n📥 *𝐒𝐄𝐋𝐄𝐂𝐓 𝐀 𝐐𝐔𝐀𝐋𝐈𝐓𝐘*\n\n${validDownloads.map((dl, i) => `${String(i + 1).padStart(2, '0')} ➜ 🎬 _${String(dl.size || 'Download')}_`).join('\n')}\n\n💬 *Reply with the corresponding number.*\n${XN_FOOTER}`;

                    const optionsMsg = await socket.sendMessage(sender, { text: optionsText }, { quoted: replyMek });
                    const optionsMsgID = optionsMsg.key.id;
                    xvPendingMsg.set(sender, { msgId: optionsMsgID, kind: 'quality', ts: Date.now() });

                    const handleDownload = async ({ messages: downloadMessages }) => {
                        const downloadMek = downloadMessages[0];
                        if (!downloadMek?.message) return;
                        if (!(await mayProcessSelectionReply(socket, downloadMek))) return;

                        const downloadChoice = downloadMek.message.conversation || downloadMek.message.extendedTextMessage?.text;
                        const isReplyToOptionsMsg = downloadMek.message.extendedTextMessage?.contextInfo?.stanzaId === optionsMsgID;
                        const pendingHere2 = xvPendingMsg.get(sender);
                        const isPlainNum2 = /^\d+$/.test(String(downloadChoice || '').trim());
                        const plainQualityOk = isPlainNum2 && !!pendingHere2 && pendingHere2.kind === 'quality' && pendingHere2.msgId === optionsMsgID &&
                            (!downloadMek.key.participant || downloadMek.key.participant === xnRequester);

                        if ((isReplyToOptionsMsg || plainQualityOk) && sender === downloadMek.key.remoteJid) {
                            const choiceNum = parseInt(downloadChoice, 10) - 1;
                            if (isNaN(choiceNum) || choiceNum < 0 || choiceNum >= validDownloads.length) {
                                await socket.sendMessage(sender, { text: `*❪ INVALID ❫*\n\n⚠️ *Wrong Option!*\n🎯 *Range:* _01 - ${validDownloads.length}_\n📝 _Please reply with a valid download option number!_${XN_FOOTER}` }, { quoted: downloadMek });
                                return;
                            }

                            const finalDirectLink = validDownloads[choiceNum].url;
                            await socket.sendMessage(sender, { react: { text: '⏳', key: downloadMek.key } });
                            await socket.sendMessage(sender, { text: `*❪ DOWNLOADING ❫*\n\n🎬 *Sending Direct MP4 Video...*\n⚡ _Please wait while video is being processed..._${XN_FOOTER}` }, { quoted: downloadMek });

                            try {
                                let tmpPath = null;
                                try {
                                    tmpPath = videoTempPath('mp4');
                                    await videoStreamToFile(finalDirectLink, tmpPath);
                                    if (videoTooBigForChat(tmpPath)) {
                                        await socket.sendMessage(sender, {
                                            document: { url: tmpPath },
                                            mimetype: 'video/mp4',
                                            fileName: `${videoTitle.replace(/[\\/:*?"<>|]/g, '').substring(0, 60)}.mp4`,
                                            caption: `*🔞 𝗫𝗡𝗫𝗫 𝗩𝗜𝗗𝗘𝗢 🔞*\n\n🎭 *Title:* ${videoTitle.substring(0, 45)}\n📊 *Quality:* ${String(validDownloads[choiceNum].size || 'N/A')}\n\n${XN_FOOTER}`
                                        }, { quoted: downloadMek });
                                    } else {
                                        await socket.sendMessage(sender, {
                                            video: { url: tmpPath },
                                            mimetype: 'video/mp4',
                                            caption: `*🔞 𝗫𝗡𝗫𝗫 𝗩𝗜𝗗𝗘𝗢 🔞*\n\n🎭 *Title:* ${videoTitle.substring(0, 45)}\n📊 *Quality:* ${String(validDownloads[choiceNum].size || 'N/A')}\n\n${XN_FOOTER}`
                                        }, { quoted: downloadMek });
                                    }
                                    await socket.sendMessage(sender, { react: { text: '✅', key: downloadMek.key } });
                                } finally {
                                    if (tmpPath) { try { fs.unlinkSync(tmpPath); } catch (e) {} }
                                }
                            } catch (dlErr) {
                                console.error('XNXX download error:', dlErr);
                                await socket.sendMessage(sender, { text: `*❪ ERROR ❫*\n\n❌ *Video Sending Failed!*\n🚫 _${dlErr.message}_${XN_FOOTER}` }, { quoted: downloadMek });
                            } finally {
                                socket.ev.off('messages.upsert', handleDownload);
                                socket.ev.off('messages.upsert', handleSelection);
                                pendingInlineListeners.delete(sender);
                            }
                        }
                    };

                    pendingInlineListeners.add(sender);
                    socket.ev.on('messages.upsert', handleDownload);

                } catch (dlError) {
                    console.error('XNXX details error:', dlError);
                    await socket.sendMessage(sender, { text: `*❪ ERROR ❫*\n\n❌ *Video Details Error!*\n🚫 _${dlError.message}_${XN_FOOTER}` }, { quoted: replyMek });
                    socket.ev.off('messages.upsert', handleSelection);
                    pendingInlineListeners.delete(sender);
                }
            }
        };

        pendingInlineListeners.add(sender);
        socket.ev.on('messages.upsert', handleSelection);

    } catch (error) {
        console.error('XNXX command error:', error);
        await socket.sendMessage(sender, { text: `*❪ SYSTEM ERROR ❫*\n\n❌ *System Error!*\n🚫 _${error.message || 'Unknown error'}_\n\n🔄 _Please try again later..._${XN_FOOTER}` }, { quoted: msg });
    }
    break;
}

case 'xvdl':
case 'xnxx': {
  // 🔞 18+ gate
  if (!(await isNsfwVerified(socket, nowsender))) {
    await socket.sendMessage(sender, { text: nsfwDeniedText() }, { quoted: msg });
    break;
  }
  try {
    const videoUrl = (args[0] || '').trim();
    if (!videoUrl || !/^(https?:\/\/)?(www\.)?(xvideos|xv-ns|xnxx)\.com/i.test(videoUrl)) {
      await socket.sendMessage(sender, { text: `*🔞 XVideos / XNXX Download*\n\n*Usage:* ${prefix}xvdl <video_url>\n*Example:* ${prefix}xvdl https://www.xvideos.com/video.xxx/...\n\n${config.BOT_FOOTER}` }, { quoted: msg });
      return;
    }
    await socket.sendMessage(sender, { react: { text: '⬇️', key: msg.key } });
    await socket.sendMessage(sender, { text: `*⬇️ Fetching video link...*\n\n${config.BOT_FOOTER}` }, { quoted: msg });
    const { data } = await axios.get(`https://shyracore.indevs.in/api/downloader/xnxx?url=${encodeURIComponent(videoUrl)}&apikey=${SHYRACORE_API_KEY}`, { timeout: 40000 });
    if (!data || !data.status || !data.result || !Array.isArray(data.result.video) || !data.result.video.length) {
      await socket.sendMessage(sender, { text: `*❌ No download link found. Try another video.*\n\n${config.BOT_FOOTER}` }, { quoted: msg });
      return;
    }
    // Pick the highest quality link available (first entry is usually 360p+).
    const dlUrl = data.result.video[0].url;
    const dlTitle = (data.result.title || 'xvideos_video').replace(/[\\/:*?"<>|]/g, '').substring(0, 60);
    let tmpPath = null;
    try {
      tmpPath = videoTempPath('mp4');
      await videoStreamToFile(dlUrl, tmpPath);
      if (videoTooBigForChat(tmpPath)) {
        await socket.sendMessage(sender, { document: { url: tmpPath }, mimetype: 'video/mp4', fileName: `${dlTitle}.mp4`, caption: `🔞 *Video*\n\n${config.BOT_FOOTER}` }, { quoted: msg });
      } else {
        await socket.sendMessage(sender, { video: { url: tmpPath }, mimetype: 'video/mp4', caption: `🔞 *Video*\n\n${config.BOT_FOOTER}` }, { quoted: msg });
      }
      await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
    } finally {
      if (tmpPath) { try { fs.unlinkSync(tmpPath); } catch (e) {} }
    }
  } catch (e) {
    console.error('[XVideos DL ERROR]', e);
    await socket.sendMessage(sender, { text: `*❌ Download error:* ${e.message || 'Please try again.'}\n\n${config.BOT_FOOTER}` }, { quoted: msg }).catch(() => {});
  }
  break;
}

case 'nanoedit':
case 'nano':
case 'editimg':
case 'bananaedit': {
  try {
    await socket.sendMessage(sender, { react: { text: '🍌', key: msg.key } });
    const { prompt, imageUrl } = await nanoExtractImage(msg, args);
    if (!imageUrl) {
      await socket.sendMessage(sender, { text: `*🍌 NANO BANANA*\n\n*❌ Image required.*\nReply to an image or provide an image URL.\n\n${config.BOT_FOOTER}` }, { quoted: msg });
      return;
    }
    if (!prompt) {
      await socket.sendMessage(sender, { text: `*🍌 NANO BANANA*\n\nReply to an image and provide a prompt.\n\n*Example:*\n  .nanoedit Make it cinematic\n\n${config.BOT_FOOTER}` }, { quoted: msg });
      return;
    }
    const nanoSess = { stage: 'select_engine', prompt, imageUrl, ts: Date.now(), botJid: currentBotJid() };
    nanoSess.timer = setTimeout(() => nanoSession.delete(nowsender), 120000);
    delete pendingRowSelect[sender];
    nanoSession.set(nowsender, nanoSess);
    await socket.sendMessage(sender, { text: `*🍌 NANO BANANA*\n\n*❓ Prompt:* ${prompt}\n\n*⚙️ Select an AI Engine:*\n\n*1* ⚡ Flux AI\n*2* 🧪 Nano AI\n*3* 🍌 Banana AI\n*4* 🛠 Standard AI\n\n_Reply 1-4_\n\n${config.BOT_FOOTER}` }, { quoted: msg });
  } catch (err) {
    console.error('[NANOEDIT CMD ERROR]', err);
    await socket.sendMessage(sender, { text: `*❌ Unable to process request.*\n\n${config.BOT_FOOTER}` }, { quoted: msg });
  }
  break;
}

case 'nanobanana':
case 'nanobananav5':
case 'editing': {
  try {
    await socket.sendMessage(sender, { react: { text: '🍌', key: msg.key } });
    const { prompt, imageUrl } = await nanoExtractImage(msg, args);
    if (!imageUrl) {
      await socket.sendMessage(sender, { text: `*🍌 NANO BANANA*\n\n*❌ Image required.*\nReply to an image or provide an image URL.\n\n${config.BOT_FOOTER}` }, { quoted: msg });
      return;
    }
    if (!prompt) {
      await socket.sendMessage(sender, { text: `*🍌 NANO BANANA*\n\nReply to an image and provide an editing prompt.\n\n*Example:*\n  .nanobanana Make the outfit black\n\n${config.BOT_FOOTER}` }, { quoted: msg });
      return;
    }
    const nanoSess = { modelSelect: true, prompt, imageUrl, ts: Date.now(), botJid: currentBotJid() };
    nanoSess.timer = setTimeout(() => nanoSession.delete(nowsender), 120000);
    delete pendingRowSelect[sender];
    nanoSession.set(nowsender, nanoSess);
    await socket.sendMessage(sender, { text: `*🍌 NANO BANANA*\n\n*❓ Prompt:* ${prompt}\n\n*⚙️ Select an editing model:*\n\n*1* 🍌 Nano Banana\n*2* 🍌 Nano Banana V2\n*3* 🍌 Nano Banana Pro\n*4* ⚡ Flux 2 Pro\n\n_Reply 1-4_\n\n${config.BOT_FOOTER}` }, { quoted: msg });
  } catch (err) {
    console.error('[NANOBANANA CMD ERROR]', err);
    await socket.sendMessage(sender, { text: `*❌ Unable to process request.*\n\n${config.BOT_FOOTER}` }, { quoted: msg });
  }
  break;
}

case 'tourl':
case 'imgtourl':
case 'url':
case 'geturl':
case 'upload': {
    try {
        const axios = require('axios');
        const FormData = require('form-data');
        const fs = require('fs');
        const os = require('os');
        const path = require('path');
        const { downloadMediaMessage } = require('@whiskeysockets/baileys'); 
        
        // Send reaction first
        await socket.sendMessage(sender, {
            react: {
                text: '🔄',
                key: msg.key
            }
        });

        const quoted = msg.message?.extendedTextMessage?.contextInfo;

        if (!quoted || !quoted.quotedMessage) {
            return await socket.sendMessage(sender, {
                text: '❌ Please reply to an image, video, or audio file with .tourl'
            }, {
                quoted: msg
            });
        }

        // Create quoted message object
        const quotedMsg = {
            key: {
                remoteJid: sender,
                id: quoted.stanzaId,
                participant: quoted.participant
            },
            message: quoted.quotedMessage
        };

        let mediaBuffer;
        let mimeType;
        let fileName;

        // Check media type and download
        if (quoted.quotedMessage.imageMessage) {
            mediaBuffer = await downloadMediaMessage(quotedMsg, 'buffer', {}, {
                logger: console,
                reuploadRequest: socket.updateMediaMessage
            });
            mimeType = quoted.quotedMessage.imageMessage.mimetype || 'image/jpeg';
            fileName = quoted.quotedMessage.imageMessage.fileName || 'image.jpg';
        } else if (quoted.quotedMessage.videoMessage) {
            mediaBuffer = await downloadMediaMessage(quotedMsg, 'buffer', {}, {
                logger: console,
                reuploadRequest: socket.updateMediaMessage
            });
            mimeType = quoted.quotedMessage.videoMessage.mimetype || 'video/mp4';
            fileName = quoted.quotedMessage.videoMessage.fileName || 'video.mp4';
        } else if (quoted.quotedMessage.audioMessage) {
            mediaBuffer = await downloadMediaMessage(quotedMsg, 'buffer', {}, {
                logger: console,
                reuploadRequest: socket.updateMediaMessage
            });
            mimeType = quoted.quotedMessage.audioMessage.mimetype || 'audio/mpeg';
            fileName = quoted.quotedMessage.audioMessage.fileName || 'audio.mp3';
        } else if (quoted.quotedMessage.documentMessage) {
            mediaBuffer = await downloadMediaMessage(quotedMsg, 'buffer', {}, {
                logger: console,
                reuploadRequest: socket.updateMediaMessage
            });
            mimeType = quoted.quotedMessage.documentMessage.mimetype || 'application/octet-stream';
            fileName = quoted.quotedMessage.documentMessage.fileName || 'document';
        } else {
            return await socket.sendMessage(sender, {
                text: '❌ Please reply to a valid media file (image, video, audio, or document)'
            }, {
                quoted: msg
            });
        }

        // Create temporary file
        const tempDir = os.tmpdir();
        const tempFilePath = path.join(tempDir, `upload_${Date.now()}_${fileName.replace(/[^a-zA-Z0-9.]/g, '_')}`);
        
        fs.writeFileSync(tempFilePath, mediaBuffer);
        
        // Upload to Catbox
        const form = new FormData();
        form.append('fileToUpload', fs.createReadStream(tempFilePath), {
            filename: fileName,
            contentType: mimeType
        });
        form.append('reqtype', 'fileupload');

        let mediaUrl;
        try {
            const response = await axios.post('https://catbox.moe/user/api.php', form, {
                headers: {
                    ...form.getHeaders(),
                    'Accept': '*/*'
                },
                timeout: 30000
            });

            if (!response.data || typeof response.data !== 'string') {
                throw new Error('Invalid response from Catbox');
            }

            mediaUrl = response.data.trim();
        } catch (uploadError) {
            console.error('Upload error:', uploadError);
            fs.unlinkSync(tempFilePath);
            return await socket.sendMessage(sender, {
                text: `❌ Upload failed: ${uploadError.message}`
            }, {
                quoted: msg
            });
        }

        // Clean up temp file
        fs.unlinkSync(tempFilePath);

        // Determine media type for display
        let mediaType = 'File';
        if (mimeType.startsWith('image/')) mediaType = 'Image';
        else if (mimeType.startsWith('video/')) mediaType = 'Video';
        else if (mimeType.startsWith('audio/')) mediaType = 'Audio';

        // Format file size
        const formatBytes = (bytes) => {
            if (bytes === 0) return '0 Bytes';
            const k = 1024;
            const sizes = ['Bytes', 'KB', 'MB', 'GB'];
            const i = Math.floor(Math.log(bytes) / Math.log(k));
            return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
        };

        // --- Plain text response (no buttons) ---
        await socket.sendMessage(sender, {
            text: `╭━━❮ *★彡 𝐈𝐒𝐇𝐀𝐍-𝐗 𝐌𝐃 𝐏𝐑𝐎 彡★* ❯━━╮
╠⦁ 📁 *Type:* ${mediaType}
╠⦁ 📦 *Size:* ${formatBytes(mediaBuffer.length)}
╠⦁ 🔗 *URL:* ${mediaUrl}
╠⦁
╰━━━━━━━━━━━━━━━━━━━━━━⪼

> _*𝐃𝙴𝚅𝙴𝙻𝙾𝙿𝙴𝚁 𝐁𝚈 𝐈𝚂𝙷𝙰𝙽-𝐗 × 𝐋𝙾𝚅𝙴𝙻𝚈 🧑‍💻🇱🇰*_`
        }, { quoted: msg });

        // Update reaction to success
        await socket.sendMessage(sender, {
            react: {
                text: '✅',
                key: msg.key
            }
        });

    } catch (error) {
        console.error('Command error:', error);
        await socket.sendMessage(sender, {
            text: `❌ ERROR

${error.message}`
        }, {
            quoted: msg
        });
    }
    break;
}
 case 'weather':
    try {
        // Messages in English
        const messages = {
            noCity: "❗ *Please provide a city name!* \n📋 *Usage*: .weather [city name]",
            weather: (data) => `
* ⛅🌦️ 𝐈𝐒𝐇𝐀𝐍-𝐗 𝐌𝐃 𝐏𝐑𝐎 𝐖𝐄𝐀𝐓𝐇𝐄𝐑 𝐑𝐄𝐏𝐎𝐑𝐓

*◈  ${data.name}, ${data.sys.country}  ◈*

*╭──────────●●➤*
*┣ 🌎 𝐓emperature :* ${data.main.temp}°C
*┣ 🌎 𝐅eels 𝐋ike :* ${data.main.feels_like}°C
*┣ 🌎 𝐌in 𝐓emp :* ${data.main.temp_min}°C
*┣ 🌎 𝐌ax 𝐓emp :* ${data.main.temp_max}°C
*┣ 🌎 𝐇umidity :* ${data.main.humidity}%
*┣ 🌎 𝐖eather :* ${data.weather[0].main}
*┣ 🌎 𝐃escription :* ${data.weather[0].description}
*┣ 🌎 𝐖ind 𝐒peed :* ${data.wind.speed} m/s
*┣ 🌎 𝐏ressure :* ${data.main.pressure} hPa
*╰──────────●●➤*

> _*𝐃𝙴𝚅𝙴𝙻𝙾𝙿𝙴𝚁 𝐁𝚈 𝐈𝚂𝙷𝙰𝙽-𝐗 × 𝐋𝙾𝚅𝙴𝙻𝚈 🧑‍💻🇱🇰*_
`,
            cityNotFound: "🚫 *City not found!* \n🔍 Please check the spelling and try again.",
            error: "⚠️ *An error occurred!* \n🔄 Please try again later."
        };

        // Check if a city name was provided
        if (!args || args.length === 0) {
            await socket.sendMessage(sender, { text: messages.noCity });
            break;
        }

        const apiKey = '2d61a72574c11c4f36173b627f8cb177';
        const city = args.join(" ");
        const url = `http://api.openweathermap.org/data/2.5/weather?q=${city}&appid=${apiKey}&units=metric`;

        const response = await axios.get(url);
        const data = response.data;

        // Get weather icon
        const weatherIcon = `https://openweathermap.org/img/wn/${data.weather[0].icon}@2x.png`;
        
        await socket.sendMessage(sender, {
            image: { url: weatherIcon },
            caption: messages.weather(data)
        });

    } catch (e) {
        console.log(e);
        if (e.response && e.response.status === 404) {
            await socket.sendMessage(sender, { text: messages.cityNotFound });
        } else {
            await socket.sendMessage(sender, { text: messages.error });
        }
    }
    break;
	  
case 'aiimg': 
case 'aiimg2': {
    const axios = require('axios');

    const q =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        msg.message?.videoMessage?.caption || '';

    const prompt = q.trim();

    if (!prompt) {
        return await socket.sendMessage(sender, {
            text: '🎨 *Please provide a prompt to generate an AI image.*'
        }, { quoted: msg });
    }

    try {
        // 🔹 Load bot name dynamically
        const sanitized = (number || '').replace(/[^0-9]/g, '');
        let cfg = await loadUserConfigFromMongo(sanitized) || {};
        let botName = await resolveUserBotName(socket, nowsender, cfg, '★彡 𝐈𝐒𝐇𝐀𝐍-𝐗 𝐌𝐃 𝐏𝐑𝐎 彡★');

        // 🔹 Fake contact with dynamic bot name
        
        // Notify user
        await socket.sendMessage(sender, { text: '🧠 *Creating your AI image...*' });

        // Determine API URL based on command
        let apiUrl = '';
        if (command === 'aiimg') {
            // gptimage returns the image bytes directly.
            apiUrl = `https://api.ikyyxd.my.id/ai/gptimage?text=${encodeURIComponent(prompt)}`;
        } else if (command === 'aiimg2') {
            // photiu returns JSON with result.image (a CDN URL).
            apiUrl = `https://api.ikyyxd.my.id/ai/photiu?prompt=${encodeURIComponent(prompt)}`;
        }

        // Call AI API
        const response = await axios.get(apiUrl, { responseType: 'arraybuffer', timeout: 60000 });

        if (!response || !response.data) {
            return await socket.sendMessage(sender, {
                text: '❌ *API did not return a valid image. Please try again later.*'
            }, { quoted: msg });
        }

        let imageBuffer;
        const contentType = String(response.headers?.['content-type'] || '');
        if (contentType.startsWith('image/')) {
            // Raw image bytes (gptimage)
            imageBuffer = Buffer.from(response.data, 'binary');
        } else {
            // JSON response (photiu) → extract the image URL then download it.
            let parsed;
            try { parsed = JSON.parse(Buffer.from(response.data).toString('utf8')); } catch (e) {}
            const imgUrl = parsed?.result?.image || parsed?.result || parsed?.image;
            if (!parsed?.status || !imgUrl) {
                return await socket.sendMessage(sender, {
                    text: `❌ *API error:* ${parsed?.message || parsed?.error || 'No image URL returned'}`
                }, { quoted: msg });
            }
            const imgRes = await axios.get(imgUrl, { responseType: 'arraybuffer', timeout: 60000 });
            imageBuffer = Buffer.from(imgRes.data, 'binary');
        }

        // Send AI Image with bot name in caption
        await socket.sendMessage(sender, {
            image: imageBuffer,
            caption: `🧠 *${botName} AI IMAGE*\n\n📌 Prompt: ${prompt}`
        }, { quoted: msg });

    } catch (err) {
        console.error('AI Image Error:', err);

        await socket.sendMessage(sender, {
            text: `❗ *An error occurred:* ${err.response?.data?.message || err.message || 'Unknown error'}`
        }, { quoted: msg });
    }
    break;
}
case 'pair':
case 'ashiyapair': 
case 'botpair': {
    try {
        const { generateWAMessageFromContent, proto } = require('@whiskeysockets/baileys');

        // 🎯 PUBLIC PAIRING — anyone who sends .pair in a PRIVATE chat (DM) with
        // the bot gets a pairing code for THEIR OWN number. Messages sent in
        // group chats get the web-pairing message instead.
        // Resolve the sender JID to a bare phone number (LID-aware, same as the
        // owner check). resolveSenderPhone handles both plain phone JIDs and
        // LID JIDs, falling back to raw digits when a LID is unmapped.
        let senderNum = '';
        try { senderNum = await resolveSenderPhone(socket, nowsender); } catch (e) {}
        if (!senderNum) senderNum = normalizeOwnerNumber(String(nowsender || '').split('@')[0] || '');

        console.log(`[.pair] sender=${nowsender} → senderNum=${senderNum} isGroup=${isGroup}`);

        // 🚫 GROUP CHATS / OTHERS — no code, web pairing only
        if (isGroup) {
            await socket.sendMessage(sender, { react: { text: '🚫', key: msg.key } });
            return await socket.sendMessage(sender, {
                text: `╔═══『 🚫 *INVALID PAIR* 』═══❒
╠⦁
╠⦁ 🔐 *Pair Code is not available for this number.*
╠⦁
╠⦁ 🌐 *Use Web Pairing:*
╠⦁ ${BOT_WEB_URL}
╠⦁
╚═══════════════════════❒
> ⚡ *𝐈𝐒𝐇𝐀𝐍-𝐗 𝐌𝐃 𝐏𝐑𝐎* • Pair Manager`
            }, { quoted: msg });
        }

        // ✅ Private DM — pair the target number (specified via .pair <number>,
        //    or the sender's own number when no argument is given).
        let requestedNumber = normalizeOwnerNumber((args || []).join(' '));
        if (requestedNumber) {
            // Force re-pair deletes any existing session for the target number,
            // so pairing an ARBITRARY number is owner-only. Non-owners may only
            // pair their own number (bare .pair).
            if (!isOwner && requestedNumber !== senderNum) {
                await socket.sendMessage(sender, { react: { text: '🚫', key: msg.key } });
                return await socket.sendMessage(sender, {
                    text: `╔═══『 🚫 *RESTRICTED* 』═══❒\n╠⦁\n╠⦁ 🔐 *Only the owner can pair a different number.*\n╠⦁\n╠⦁ 💡 *Pair your own number:* \`.pair\`\n╠⦁ 🌐 *Web pairing:* ${BOT_WEB_URL}\n╠⦁\n╚═══════════════════════❒`
                }, { quoted: msg });
            }
        }
        const number = requestedNumber || senderNum;
        const sanitizedNumber = number;

        console.log(`[.pair] target=${sanitizedNumber} requested=${requestedNumber || '-'} sender=${senderNum} isGroup=${isGroup}`);

        // 1. Loading Reaction (ලස්සනට)
        const loadingEmojis = ['🌑', '🌒', '🌓', '🌔', '🌕', '✨'];
        for (const emoji of loadingEmojis) {
            await socket.sendMessage(sender, { react: { text: emoji, key: msg.key } });
            await new Promise(resolve => setTimeout(resolve, 200)); // Sleep function
        }

        // 2. A pairing is already pending with a code? Reuse it (same as /code route)
        const pendingCode = latestPairCode.get(sanitizedNumber);
        if (pendingCode) {
            await socket.sendMessage(sender, { react: { text: '🔑', key: msg.key } });
            return await socket.sendMessage(sender, {
                text: `╔═══『  *SECURE PAIRING* 』═══❒\n╠⦁\n╠⦁  *Number :* ${sanitizedNumber}\n╠⦁  *Pair Code :* *${pendingCode}*\n╠⦁\n╠⦁ ⏰ *Code expires in 2 minutes.*\n╠⦁  *Don't share this with anyone.*\n╠⦁  *Go to Settings > Linked Devices > Enter Code*\n╠⦁\n╚═══════════════════════❒\n> ⚡ *𝐈𝐒𝐇𝐀𝐍-𝐗 𝐌𝐃 𝐏𝐑𝐎* • Secure Pairing`
            }, { quoted: msg });
        }

        // 3. Pairing progress message
        await socket.sendMessage(sender, {
            text: `⏳ *Pairing ${sanitizedNumber}...*\n_Generating code via the bot's own pairing engine. Please wait._`
        }, { quoted: msg });

        // 4. Force a fresh re-pair for the sender's number: clean up any OTHER
        //    active socket for it first, then generate a new code
        if (activeSockets.has(sanitizedNumber) && activeSockets.get(sanitizedNumber) !== socket) {
            const oldSocket = activeSockets.get(sanitizedNumber);
            try { oldSocket?.end?.(); oldSocket?.removeAllListeners?.(); } catch(e){}
            activeSockets.delete(sanitizedNumber);
            try { await deleteSessionAndCleanup(sanitizedNumber, oldSocket).catch(()=>{}); } catch(e){}
        }

        // 5. Start the bot's own pairing engine — NO external API
        const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
        if (!pairingInProgress.has(sanitizedNumber)) {
            await EmpirePair(number, mockRes, true);
        }

        // 6. Poll for the generated code (pairing can take a few seconds)
        let pairCode = latestPairCode.get(sanitizedNumber);
        for (let i = 0; i < 15 && !pairCode; i++) {
            await delay(1500);
            pairCode = latestPairCode.get(sanitizedNumber);
        }
        if (!pairCode) {
            throw new Error('Pairing code could not be generated. Please try again in a moment.');
        }

        // 7. Success Reaction
        await socket.sendMessage(sender, { react: { text: '🔑', key: msg.key } });

        // 8. 🎨 Premium reply — shows the approved sender's own number + code
        await socket.sendMessage(sender, {
            text: `╔═══『  *SECURE PAIRING* 』═══❒
╠⦁
╠⦁  *Number :* ${sanitizedNumber}
╠⦁  *Pair Code :* *${pairCode}*
╠⦁
╠⦁ ⏰ *Code expires in 2 minutes.*
╠⦁  *Don't share this with anyone.*
╠⦁  *Go to Settings > Linked Devices > Enter Code*
╠⦁
╚═══════════════════════❒
> ⚡ *𝐈𝐒𝐇𝐀𝐍-𝐗 𝐌𝐃 𝐏𝐑𝐎* • Secure Pairing`
        }, { quoted: msg });

        // 9. කෝඩ් එක වෙනම යැවීම (Backup ලෙස)
        await new Promise(resolve => setTimeout(resolve, 1000));
        await socket.sendMessage(sender, { text: pairCode }, { quoted: msg });

    } catch (err) {
        console.error("❌ 𝙸𝚂𝙷𝙰𝙽-𝚇 𝙼𝙳 𝙿𝙰𝙸𝚁 𝙴𝚁𝚁𝙾𝚁::", err);
        await socket.sendMessage(sender, { react: { text: '❌', key: msg.key } });
        await socket.sendMessage(sender, {
            text: `❌ *Pairing failed.*\n\nReason: ${err.message || 'Pairing Error'}\n\n*Use Web Pairing*: ${BOT_WEB_URL}`
        }, { quoted: msg });
    }
    break;
}

case 'pp': {
  try {
    const q = args.join(' ');
    if (!q) {
      return socket.sendMessage(sender, {
        text: '❎ Please enter a pastpaper search term!\n\nExample: .pp A/L ict'
      }, { quoted: msg });
    }

    // Short reaction to show we're working
    await socket.sendMessage(sender, { react: { text: '🔎', key: msg.key } });

    // Search API (you provided)
    const searchApi = `https://pp-api-beta.vercel.app/api/pastpapers?q=${encodeURIComponent(q)}`;
    const { data } = await axios.get(searchApi);

    if (!data?.results || data.results.length === 0) {
      return socket.sendMessage(sender, { text: '❎ No results found for that query!' }, { quoted: msg });
    }

    // Filter out generic pages like Next Page / Contact Us / Terms / Privacy
    const filtered = data.results.filter(r => {
      const t = (r.title || '').toLowerCase();
      if (!r.link) return false;
      if (t.includes('next page') || t.includes('contact us') || t.includes('terms') || t.includes('privacy policy')) return false;
      return true;
    });

    if (filtered.length === 0) {
      return socket.sendMessage(sender, { text: '❎ No relevant pastpaper results found.' }, { quoted: msg });
    }

    // Take top 5 results
    const results = filtered.slice(0, 5);

    // Build caption
    let caption = `📚 *Top Pastpaper Results for:* ${q}\n\n`;
    results.forEach((r, i) => {
      caption += `*${i + 1}. ${r.title}*\n🔗 Preview: ${r.link}\n\n`;
    });
    caption += `*💬 Reply with number (1-${results.length}) to download/view.*`;

    // Send first result image if any thumbnail, else just send text with first link preview
    let sentMsg;
    if (results[0].thumbnail) {
      sentMsg = await socket.sendMessage(sender, {
        image: { url: results[0].thumbnail },
        caption
      }, { quoted: msg });
    } else {
      sentMsg = await socket.sendMessage(sender, {
        text: caption
      }, { quoted: msg });
    }

    // Listener for user choosing an item (1..n)
    const listener = async (update) => {
      try {
        const m = update.messages[0];
        if (!m.message) return;
        // Multi-bot gate: only process this selection when this bot was
        // @mentioned in chats shared by multiple bot sessions.
        if (!(await mayProcessSelectionReply(socket, m))) return;

        const text = m.message.conversation || m.message.extendedTextMessage?.text;
        const isReply =
          m.message.extendedTextMessage &&
          m.message.extendedTextMessage.contextInfo?.stanzaId === sentMsg.key.id;

        if (isReply && ['1','2','3','4','5'].includes(text)) {
          const index = parseInt(text, 10) - 1;
          const selected = results[index];
          if (!selected) return;

          // show processing reaction
          pendingInlineListeners.add(sender);
          await socket.sendMessage(sender, { react: { text: '⏳', key: m.key } });

          // Call download API to get direct pdf(s)
          try {
            const dlApi = `https://pp-api-beta.vercel.app/api/download?url=${encodeURIComponent(selected.link)}`;
            const { data: dlData } = await axios.get(dlApi);

            if (!dlData?.found || !dlData.pdfs || dlData.pdfs.length === 0) {
              await socket.sendMessage(sender, { react: { text: '❌', key: m.key } });
              await socket.sendMessage(sender, { text: '❎ No direct PDF found for that page.' }, { quoted: m });
              // cleanup
              socket.ev.off('messages.upsert', listener);
              pendingInlineListeners.delete(sender);
              return;
            }

            const pdfs = dlData.pdfs; // array of URLs

            if (pdfs.length === 1) {
              // single pdf -> send directly
              const pdfUrl = pdfs[0];
              await socket.sendMessage(sender, { react: { text: '⬇️', key: m.key } });

              await socket.sendMessage(sender, {
                document: { url: pdfUrl },
                mimetype: 'application/pdf',
                fileName: `${selected.title}.pdf`,
                caption: `📄 ${selected.title}`
              }, { quoted: m });

              await socket.sendMessage(sender, { react: { text: '✅', key: m.key } });

              socket.ev.off('messages.upsert', listener);
              pendingInlineListeners.delete(sender);
            } else {
              // multiple pdfs -> list options and wait for choose
              let desc = `📄 *${selected.title}* — multiple PDFs found:\n\n`;
              pdfs.forEach((p, i) => {
                desc += `*${i+1}.* ${p.split('/').pop() || `PDF ${i+1}`}\n`;
              });
              desc += `\n💬 Reply with number (1-${pdfs.length}) to download that PDF.`;

              const infoMsg = await socket.sendMessage(sender, {
                text: desc
              }, { quoted: m });

              // nested listener for pdf choice
              const dlListener = async (dlUpdate) => {
                try {
                  const d = dlUpdate.messages[0];
                  if (!d.message) return;
                  // Multi-bot gate: only process this selection when this bot
                  // was @mentioned in multi-bot chats.
                  if (!(await mayProcessSelectionReply(socket, d))) return;

                  const text2 = d.message.conversation || d.message.extendedTextMessage?.text;
                  const isReply2 =
                    d.message.extendedTextMessage &&
                    d.message.extendedTextMessage.contextInfo?.stanzaId === infoMsg.key.id;

                  if (isReply2) {
                    if (!/^\d+$/.test(text2)) return;
                    const dlIndex = parseInt(text2, 10) - 1;
                    if (dlIndex < 0 || dlIndex >= pdfs.length) {
                      return socket.sendMessage(sender, { text: '❎ Invalid option.' }, { quoted: d });
                    }

                    const finalPdf = pdfs[dlIndex];
                    await socket.sendMessage(sender, { react: { text: '⬇️', key: d.key } });

                    try {
                      await socket.sendMessage(sender, {
                        document: { url: finalPdf },
                        mimetype: 'application/pdf',
                        fileName: `${selected.title} (${dlIndex+1}).pdf`,
                        caption: `📄 ${selected.title} (${dlIndex+1})`
                      }, { quoted: d });

                      await socket.sendMessage(sender, { react: { text: '✅', key: d.key } });
                    } catch (err) {
                      await socket.sendMessage(sender, { react: { text: '❌', key: d.key } });
                      await socket.sendMessage(sender, { text: `❌ Download/send failed.\n\nDirect link:\n${finalPdf}` }, { quoted: d });
                    }

                    socket.ev.off('messages.upsert', dlListener);
                    socket.ev.off('messages.upsert', listener);
                    pendingInlineListeners.delete(sender);
                  }
                } catch (err) {
                  // ignore inner errors but log if you want
                }
              };

              socket.ev.on('messages.upsert', dlListener);
              // keep outer listener off until user chooses or we cleanup inside dlListener
            }

          } catch (err) {
            await socket.sendMessage(sender, { react: { text: '❌', key: m.key } });
            await socket.sendMessage(sender, { text: `❌ Error fetching PDF: ${err.message}` }, { quoted: m });
            socket.ev.off('messages.upsert', listener);
            pendingInlineListeners.delete(sender);
          }
        }
      } catch (err) {
        // ignore per-message listener errors
      }
    };

    pendingInlineListeners.add(sender);
    socket.ev.on('messages.upsert', listener);

  } catch (err) {
    await socket.sendMessage(sender, { react: { text: '❌', key: msg.key } });
    await socket.sendMessage(sender, { text: `❌ ERROR: ${err.message}` }, { quoted: msg });
  }
  break;
}

  case 'cricket':
    try {
        const response = await fetch('https://api.cricapi.com/v1/currentMatches?apikey=72e8cf9b-8b76-4e8d-9a39-a469fa25ef05&offset=0');

        if (!response.ok) {
            throw new Error(`API request failed with status ${response.status}`);
        }

        const data = await response.json();

       
        if (!data.status || !data.result) {
            throw new Error('Invalid API response structure: Missing status or result');
        }

        const { title, score, to_win, crr, link } = data.result;
        if (!title || !score || !to_win || !crr || !link) {
            throw new Error('Missing required fields in API response: ' + JSON.stringify(data.result));
        }

       
        await socket.sendMessage(sender, {
            text: formatMessage(
                '🏏 𝗜𝗦𝗛𝗔𝗡-𝐗 𝗠𝗗 𝙋𝙍𝙊 MINI CEICKET NEWS🏏',
                `📢 *${title}*\n\n` +
                `🏆 *mark*: ${score}\n` +
                `🎯 *to win*: ${to_win}\n` +
                `📈 *now speed*: ${crr}\n\n` +
                `🌐 *link*: ${link}`,
                '> _*𝐃𝙴𝚅𝙴𝙻𝙾𝙿𝙴𝚁 𝐁𝚈 𝐼𝚂𝙷𝙰𝙽-𝐗 × 𝐿𝙾𝚅𝙴𝙻𝚈 🧑‍💻🇱🇰*_'
            )
        });
    } catch (error) {
        console.error(`Error in 'news' case: ${error.message}`);
        await socket.sendMessage(sender, {
            text: '⚠️ දැන්නම් හරි යන්නම ඕන 🙌.'
        });
    }
                    break;
                case 'gossip':
    try {
        
        const response = await fetch('https://api.srihub.store/news/hiru?apikey=dew_BFJBP1gi0pxFIdCasrTqXjeZzcmoSpz4SE4FtG9B');
        if (!response.ok) {
            throw new Error('API එකෙන් news ගන්න බැරි වුණා.බන් API error ❌');
        }
        const data = await response.json();


        if (!data.status || !data.result || !data.result.title || !data.result.desc || !data.result.link) {
            throw new Error('API එකෙන් ලැබුණු news data වල ගැටලුවක් API data error');
        }


        const { title, desc, date, link } = data.result;


        let thumbnailUrl = 'https://via.placeholder.com/150';
        try {
            
            const pageResponse = await fetch(link);
            if (pageResponse.ok) {
                const pageHtml = await pageResponse.text();
                const $ = cheerio.load(pageHtml);
                const ogImage = $('meta[property="og:image"]').attr('content');
                if (ogImage) {
                    thumbnailUrl = ogImage; 
                } else {
                    console.warn(`No og:image found for ${link}`);
                }
            } else {
                console.warn(`Failed to fetch page ${link}: ${pageResponse.status}`);
            }
        } catch (err) {
            console.warn(`Thumbnail scrape කරන්න බැරි වුණා from ${link}: ${err.message}`);
        }


        await socket.sendMessage(sender, {
            image: { url: thumbnailUrl },
            caption: formatMessage(
                '📰 𝗜𝗦𝗛𝗔𝗡-𝐗 𝗠𝗗 𝙋𝙍𝙊 නවතම පුවත් 📰',
                `📢 *${title}*\n\n${desc}\n\n🕒 *Date*: ${date || 'තවම ලබාදීලා නැත'}\n🌐 *Link*: ${link}`,
                '> _*𝐃𝙴𝚅𝙴𝙻𝙾𝙿𝙴𝚁 𝐁𝚈 𝐈𝚂𝙷𝙰𝙽-𝐗 × 𝐋𝙾𝚅𝙴𝙻𝚈 🧑‍💻🇱🇰*_'
            )
        });
    } catch (error) {
        console.error(`Error in 'news' case: ${error.message}`);
        await socket.sendMessage(sender, {
            text: '⚠️ නිව්ස් ගන්න බැරි වුණා සුද්දෝ! 😩 යමක් වැරදුණා වගේ news error.'
        });
    }
                    break;
case 'deleteme': {
  // 'number' is the session number passed to setupCommandHandlers (sanitized in caller)
  const sanitized = (number || '').replace(/[^0-9]/g, '');
  // determine who sent the command    const senderNum = await resolveSenderPhone(socket, nowsender);
    const isOwnerNum = isOwnerNumber(senderNum);

  // Permission: only the session owner or the bot OWNER can delete this session
  if (senderNum !== sanitized && !isOwnerNum) {
    await socket.sendMessage(sender, { text: '❌ Permission denied. Only the session owner or the bot owner can delete this session.' }, { quoted: msg });
    break;
  }

  try {
    // 1) Remove from Mongo
    await removeSessionFromMongo(sanitized);
    await removeNumberFromMongo(sanitized);

    // 2) Remove temp session dir
    const sessionPath = path.join(os.tmpdir(), `session_${sanitized}`);
    try {
      if (fs.existsSync(sessionPath)) {
        fs.removeSync(sessionPath);
        console.log(`Removed session folder: ${sessionPath}`);
      }
    } catch (e) {
      console.warn('Failed removing session folder:', e);
    }

    // 3) Try to logout & close socket
    try {
      if (typeof socket.logout === 'function') {
        await socket.logout().catch(err => console.warn('logout error (ignored):', err?.message || err));
      }
    } catch (e) { console.warn('socket.logout failed:', e?.message || e); }
    try { socket.ws?.close(); } catch (e) { console.warn('ws close failed:', e?.message || e); }

    // 4) Remove from runtime maps
    activeSockets.delete(sanitized);
    socketCreationTime.delete(sanitized);
    pairingInProgress.delete(sanitized);
    pairingSockets.delete(sanitized);
    latestPairCode.delete(sanitized);
    loggedOutSessions.delete(sanitized);
    clearConnectWatchdog(sanitized);

    // 5) notify user
    await socket.sendMessage(sender, {
      image: { url: config.RCD_IMAGE_PATH },
      caption: formatMessage('🗑️ SESSION DELETED', '✅ Your session has been successfully deleted from MongoDB and local storage.', BOT_NAME_FANCY)
    }, { quoted: msg });

    console.log(`Session ${sanitized} deleted by ${senderNum}`);
  } catch (err) {
    console.error('deleteme command error:', err);
    await socket.sendMessage(sender, { text: `❌ Failed to delete session: ${err.message || err}` }, { quoted: msg });
  }
  break;
}

// Add these cases to your switch statement, just like the 'song' case

// Fetch Facebook video info from the ikyyxd API
async function fetchFbData(url) {
    const fbRes = await axios.get('https://api.ikyyxd.my.id/download/facebook', { params: { url } });
    const data = fbRes.data;
    if (!data.status || !data.result?.downloads) return null;
    const dl = data.result.downloads;
    const links = Array.isArray(dl.links) ? dl.links : [];
    const pick = (type, q) => links.find(l => (l.type || '').toLowerCase() === type)
        || links.find(l => (l.quality || '').toLowerCase().includes(q)) || null;
    return {
        title: data.result.metadata?.title || 'Facebook Video',
        thumbnail: dl.thumbnail || '',
        hd: pick('hd', '720')?.url || null,
        sd: pick('sd', '360')?.url || null
    };
}

// Fetch TikTok video info from the ikyyxd API
async function fetchTikTokData(url) {
    const ttRes = await axios.get('https://api.ikyyxd.my.id/download/tiktokkv2', { params: { url } });
    const data = ttRes.data;
    if (!data.status || !data.result) return null;
    const r = data.result;
    return {
        title: r.title || 'TikTok Video',
        image: r.image || '',
        video: (Array.isArray(r.video) && r.video[0]) ? r.video[0] : null,
        audio: (Array.isArray(r.audio) && r.audio[0]) ? r.audio[0] : null
    };
}

case 'fb':
case 'fbdl':
case 'facebook':
case 'fbd':
case 'fbvideo': {
    try {
        const q = args.join(' ').trim();
        if (!q || !q.includes('facebook.com')) return await socket.sendMessage(sender, { text: '*❌ කරුණාකර facebook url එකක් ලබා දෙන්න Please provide the URL*' }, { quoted: msg });

        await socket.sendMessage(sender, { react: { text: '📘', key: msg.key } });

        const ownerdata = (await axios.get(
            'https://raw.githubusercontent.com/Dilu-x/OWNER_DATA/refs/heads/main/ownerdata'
        )).data;
        const { footer } = ownerdata;

        // Fetch FB data
        const fb = await fetchFbData(q);
        if (!fb) {
            return await socket.sendMessage(sender, { text: '*❌ error මට කිසිවක් සොයාගත නොහැකි විය :(*' }, { quoted: msg });
        }

        const hasHD = !!fb.hd;
        const hasSD = !!fb.sd;

        const caption =
            `*┎━━━━━━━━━━━━━━❖●►*\n` +
            `*┃➤ 🎬 \`Title\`       :* ${fb.title}\n` +
            `*┃➤ 📺 \`Available\`   :* ${hasHD ? 'HD ' : ''}${hasSD ? 'SD' : ''}\n` +
            `*┃➤ 🔗 \`Link\`        :* ${q}\n` +
            `*┗━━━━━━━━━━━━━━❖●►*`;

        const rows = [];
        if (hasHD) rows.push({ label: '🔋 HD Quality Video', id: `${prefix}fbhd ${q}` });
        if (hasSD) rows.push({ label: '🪫 SD Quality Video', id: `${prefix}fbsd ${q}` });
        if (hasHD) rows.push({ label: '📂 HD Quality Document', id: `${prefix}fbhd_doc ${q}` });
        if (hasSD) rows.push({ label: '📂 SD Quality Document', id: `${prefix}fbsd_doc ${q}` });

        setPendingRowSelect(sender, rows);
        await socket.sendMessage(sender, {
            image: { url: fb.thumbnail },
            caption: `${caption}\n\n*📥 Select a quality:*\n${buildNumberedList(rows)}\n\n*Reply with the number of your choice.*`
        }, { quoted: msg });

    } catch (e) {
        console.error('FB Error:', e);
        await socket.sendMessage(sender, { text: '*❌ Facebook Download Error*' }, { quoted: msg });
    }
    break;
}
case 'fbhd': {
    try {
        const q = args.join(' ').trim();
        if (!q) return await socket.sendMessage(sender, { text: '*❌ කරුණාකර url එකක් ලබා දෙන්න Please provide the URL*' }, { quoted: msg });

        const ownerdata = (await axios.get('https://raw.githubusercontent.com/Dilu-x/OWNER_DATA/refs/heads/main/ownerdata')).data;
        const { footer } = ownerdata;

        const fb = await fetchFbData(q);
        const hdLink = fb?.hd;
        if (!hdLink) return await socket.sendMessage(sender, { text: '*❌ HD not available*' }, { quoted: msg });

        // ssscdn.io links return 204 unless fetched with a browser UA, so we
        // download to a local temp file and send the FILE (same as .song/.mp4).
        await socket.sendMessage(sender, { react: { text: '⬆️', key: msg.key } });
        let tmpPath = null;
        try {
            tmpPath = videoTempPath();
            await videoStreamToFile(hdLink, tmpPath);
            if (videoTooBigForChat(tmpPath)) {
                await socket.sendMessage(sender, {
                    document: { url: tmpPath },
                    mimetype: 'video/mp4',
                    fileName: `${(fb.title || 'facebook_video').replace(/[\\/:*?"<>|]/g, '').substring(0, 60)}.mp4`,
                    caption: `\`720p (HD)\`\n\n${footer}`
                }, { quoted: msg });
            } else {
                await socket.sendMessage(sender, { video: { url: tmpPath }, mimetype: 'video/mp4', caption: `\`720p (HD)\`\n\n${footer}` }, { quoted: msg });
            }
            await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
        } finally {
            if (tmpPath) { try { fs.unlinkSync(tmpPath); } catch (e) {} }
        }

    } catch (e) { await socket.sendMessage(sender, { text: '*❌ HD Error*' }, { quoted: msg }); }
    break;
}
case 'fbsd': {
    try {
        const q = args.join(' ').trim();
        if (!q) return await socket.sendMessage(sender, { text: '*❌ කරුණාකර url එකක් ලබා දෙන්න Please provide the URL*' }, { quoted: msg });

        const ownerdata = (await axios.get('https://raw.githubusercontent.com/Dilu-x/OWNER_DATA/refs/heads/main/ownerdata')).data;
        const { footer } = ownerdata;

        const fb = await fetchFbData(q);
        const sdLink = fb?.sd;
        if (!sdLink) return await socket.sendMessage(sender, { text: '*❌ SD not available*' }, { quoted: msg });

        // ssscdn.io links return 204 unless fetched with a browser UA, so we
        // download to a local temp file and send the FILE (same as .song/.mp4).
        await socket.sendMessage(sender, { react: { text: '⬆️', key: msg.key } });
        let tmpPath = null;
        try {
            tmpPath = videoTempPath();
            await videoStreamToFile(sdLink, tmpPath);
            if (videoTooBigForChat(tmpPath)) {
                await socket.sendMessage(sender, {
                    document: { url: tmpPath },
                    mimetype: 'video/mp4',
                    fileName: `${(fb.title || 'facebook_video').replace(/[\\/:*?"<>|]/g, '').substring(0, 60)}.mp4`,
                    caption: `\`360p (SD)\`\n\n${footer}`
                }, { quoted: msg });
            } else {
                await socket.sendMessage(sender, { video: { url: tmpPath }, mimetype: 'video/mp4', caption: `\`360p (SD)\`\n\n${footer}` }, { quoted: msg });
            }
            await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
        } finally {
            if (tmpPath) { try { fs.unlinkSync(tmpPath); } catch (e) {} }
        }

    } catch (e) { await socket.sendMessage(sender, { text: '*❌ SD Error*' }, { quoted: msg }); }
    break;
}
case 'fbhd_doc': {
    try {
        const sharp = require('sharp');
        const q = args.join(' ').trim();
        if (!q) return await socket.sendMessage(sender, { text: '*❌ කරුණාකර url එකක් ලබා දෙන්න Please provide the URL*' }, { quoted: msg });

        const ownerdata = (await axios.get('https://raw.githubusercontent.com/Dilu-x/OWNER_DATA/refs/heads/main/ownerdata')).data;
        const { footer } = ownerdata;

        const fb = await fetchFbData(q);
        const hdLink = fb?.hd;
        if (!hdLink) return await socket.sendMessage(sender, { text: '*❌ HD not available*' }, { quoted: msg });

        // ssscdn.io links return 204 unless fetched with a browser UA, so we
        // download to a local temp file and send the FILE (same as .song/.mp4).
        await socket.sendMessage(sender, { react: { text: '⬆️', key: msg.key } });
        let resizedThumb;
        if (fb.thumbnail) {
            const imgRes = await axios.get(fb.thumbnail, { responseType: 'arraybuffer', headers: { 'User-Agent': VIDEO_UA } });
            resizedThumb = await sharp(Buffer.from(imgRes.data)).resize(200, 200).toBuffer();
        }
        let tmpPath = null;
        try {
            tmpPath = videoTempPath();
            await videoStreamToFile(hdLink, tmpPath);
            await socket.sendMessage(sender, {
                document: { url: tmpPath }, mimetype: 'video/mp4',
                fileName: `${(fb.title || 'facebook_video').replace(/[\\/:*?"<>|]/g, '').substring(0, 60)}.mp4`,
                jpegThumbnail: resizedThumb,
                caption: `\`720p (HD)\`\n\n${footer}`
            }, { quoted: msg });
            await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
        } finally {
            if (tmpPath) { try { fs.unlinkSync(tmpPath); } catch (e) {} }
        }

    } catch (e) { await socket.sendMessage(sender, { text: '*❌ HD Doc Error*' }, { quoted: msg }); }
    break;
}
case 'fbsd_doc': {
    try {
        const sharp = require('sharp');
        const q = args.join(' ').trim();
        if (!q) return await socket.sendMessage(sender, { text: '*❌ කරුණාකර url එකක් ලබා දෙන්න*' }, { quoted: msg });

        const ownerdata = (await axios.get('https://raw.githubusercontent.com/Dilu-x/OWNER_DATA/refs/heads/main/ownerdata')).data;
        const { footer } = ownerdata;

        const fb = await fetchFbData(q);
        const sdLink = fb?.sd;
        if (!sdLink) return await socket.sendMessage(sender, { text: '*❌ SD not available*' }, { quoted: msg });

        // ssscdn.io links return 204 unless fetched with a browser UA, so we
        // download to a local temp file and send the FILE (same as .song/.mp4).
        await socket.sendMessage(sender, { react: { text: '⬆️', key: msg.key } });
        let resizedThumb;
        if (fb.thumbnail) {
            const imgRes = await axios.get(fb.thumbnail, { responseType: 'arraybuffer', headers: { 'User-Agent': VIDEO_UA } });
            resizedThumb = await sharp(Buffer.from(imgRes.data)).resize(200, 200).toBuffer();
        }
        let tmpPath = null;
        try {
            tmpPath = videoTempPath();
            await videoStreamToFile(sdLink, tmpPath);
            await socket.sendMessage(sender, {
                document: { url: tmpPath }, mimetype: 'video/mp4',
                fileName: `${(fb.title || 'facebook_video').replace(/[\\/:*?"<>|]/g, '').substring(0, 60)}.mp4`,
                jpegThumbnail: resizedThumb,
                caption: `\`360p (SD)\`\n\n${footer}`
            }, { quoted: msg });
            await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
        } finally {
            if (tmpPath) { try { fs.unlinkSync(tmpPath); } catch (e) {} }
        }

    } catch (e) { await socket.sendMessage(sender, { text: '*❌ SD Doc Error*' }, { quoted: msg }); }
    break;
}
case 'xv':
case 'xvsearch':
case 'xvdl': {
    try {
        const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();
        const query = text.split(" ").slice(1).join(" ").trim();

        // ✅ Load bot name dynamically
        const sanitized = (number || '').replace(/[^0-9]/g, '');
        let cfg = await loadUserConfigFromMongo(sanitized) || {};
        let botName = await resolveUserBotName(socket, nowsender, cfg, '★彡 𝐈𝐒𝐇𝐀𝐍-𝐗 𝐌𝐃 𝐏𝐑𝐎 彡★');

        // ✅ Fake Meta contact message
        
        if (!query) {
            return await socket.sendMessage(sender, {
                text: `🚫 *Please provide a search query.*\n\nExample: .xv mia\n\n_Type ${config.PREFIX}menu for the main menu._`
            }, { quoted: msg });
        }

        await socket.sendMessage(sender, { text: '*⏳ Searching XVideos...*' }, { quoted: msg });

        // 🔹 Search API
        const searchUrl = `https://tharuzz-ofc-api-v2.vercel.app/api/search/xvsearch?query=${encodeURIComponent(query)}`;
        const { data } = await axios.get(searchUrl);

        if (!data.success || !data.result?.xvideos?.length) {
            return await socket.sendMessage(sender, { text: '*❌ No results found.*' }, { quoted: msg });
        }

        // 🔹 Show top 10 results (1st result image attached)
        const results = data.result.xvideos.slice(0, 10);
        const xvRows = results.map(item => ({ label: `${item.title} — ${item.info}`, id: `${prefix}xvget ${item.link}` }));

        const xvCaption = `🔍 *𝐗videos 𝐒earch 𝐑esults 𝐅or:* ${query}\n\n${buildNumberedList(xvRows)}\n\n*Reply with the number to download that video.*\n\n*𝐏owered 𝐁y ${botName}*`;
        try {
            await socket.sendMessage(sender, { image: { url: results[0].thumb || results[0].thumbnail }, caption: xvCaption, contextInfo: { mentionedJid: [sender] } }, { quoted: msg });
        } catch (e) {
            await socket.sendMessage(sender, { text: xvCaption, contextInfo: { mentionedJid: [sender] } }, { quoted: msg });
        }

        setPendingRowSelect(sender, xvRows);

    } catch (err) {
        console.error("Error in XVideos search/download:", err);
        await socket.sendMessage(sender, { text: '*❌ Internal Error. Please try again later.*' }, { quoted: msg });
    }
}
break;

// ✅ Handle download of a video selected via the numbered reply (id: "xvget <url>")
case 'xvget': {
    try {
        const videoUrl = args.join(' ').trim();
        if (!videoUrl) return await socket.sendMessage(sender, { text: '🚫 Invalid selection.' }, { quoted: msg });

        await socket.sendMessage(sender, { text: '*⏳ Downloading video...*' }, { quoted: msg });

        const sanitized = (number || '').replace(/[^0-9]/g, '');
        let cfg = await loadUserConfigFromMongo(sanitized) || {};
        let botName = await resolveUserBotName(socket, nowsender, cfg, '★彡 𝐈𝐒𝐇𝐀𝐍-𝐗 𝐌𝐃 𝐏𝐑𝐎 彡★');

        // 🔹 Call XVideos download API
        const dlUrl = `https://tharuzz-ofc-api-v2.vercel.app/api/download/xvdl?url=${encodeURIComponent(videoUrl)}`;
        const { data } = await axios.get(dlUrl);

        if (!data.success || !data.result) {
            return await socket.sendMessage(sender, { text: '*❌ Failed to fetch video.*' }, { quoted: msg });
        }

        const result = data.result;
        await socket.sendMessage(sender, {
            video: { url: result.dl_Links.highquality || result.dl_Links.lowquality },
            caption: `🎥 *${result.title}*\n\n⏱ Duration: ${result.duration}s\n\n_© Powered by ${botName}_`,
            jpegThumbnail: result.thumbnail ? await axios.get(result.thumbnail, { responseType: 'arraybuffer' }).then(res => Buffer.from(res.data)) : undefined
        }, { quoted: msg });

    } catch (err) {
        console.error("Error in XVideos selection/download:", err);
        await socket.sendMessage(sender, { text: '*❌ Internal Error. Please try again later.*' }, { quoted: msg });
    }
}
break;

// ==================== STATUS SAVER ====================
// .sts — reply to a WhatsApp status (image/video/audio/doc/sticker/text)
// and forward it into the bot owner's inbox.
case 'sts':
case 'savestatus': {
  try {
    const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
    if (!quotedMsg) {
      return await socket.sendMessage(sender, {
        text: `╔═══『 📥 *STATUS SAVER* 』═══❒\n╠⦁\n╠⦁ ⚠️ *Reply to a status message first.*\n╠⦁\n╠⦁ 📝 *Use:*\n╠⦁ .sts\n╠⦁\n╚═══════════════════════❒\n> ⚡ *𝐈𝐒𝐇𝐀𝐍-𝐗 𝐌𝐃 𝐏𝐑𝐎*`
      }, { quoted: msg });
    }

    try { await socket.sendMessage(sender, { react: { text: '📥', key: msg.key } }); } catch(e){}

    // 🔵 Send the saved status to the user's inbox (DM with the bot) so it
    // stays private even when .sts is used inside a group.
    const saveChat = nowsender;

    const senderName = msg.pushName || 'Unknown';
    const statusFrom = String(msg.message?.extendedTextMessage?.contextInfo?.participant || nowsender || '').split('@')[0];
    const statusNumber = String(statusFrom || senderNumber || '').replace(/[^0-9]/g, '');

    if (quotedMsg.imageMessage || quotedMsg.videoMessage || quotedMsg.audioMessage || quotedMsg.documentMessage || quotedMsg.stickerMessage) {
      const media = await downloadQuotedMedia(quotedMsg);
      if (!media || !media.buffer) {
        // Status media URLs expire quickly — fall back to forwarding the quoted status
        let forwarded = false;
        if (typeof socket.copyNForward === 'function') {
          try {
            const ci = msg.message?.extendedTextMessage?.contextInfo || {};
            const quotedKey = ci.stanzaId
              ? { remoteJid: String(ci.participant || sender).split('@')[0] + '@s.whatsapp.net', id: ci.stanzaId, fromMe: false, participant: ci.participant || undefined }
              : msg.key;
            try { await socket.copyNForward(saveChat, quotedKey, true); forwarded = true; } catch(e){}
          } catch(e){}
        }
        if (!forwarded) {
          return await socket.sendMessage(sender, { text: `❌ *Failed to download status media.*` }, { quoted: msg });
        }
        return await socket.sendMessage(sender, { text: `✅ *Status forwarded!*` }, { quoted: msg });
      }
      const caption = `╔═══『 📥 *STATUS SAVER* 』═══❒\n╠⦁\n╠⦁ 📱 *From:* ${senderName}\n╠⦁ 🔢 *Number:* ${statusNumber}\n╠⦁\n╚═══════════════════════❒\n> ⚡ *𝐈𝐒𝐇𝐀𝐍-𝐗 𝐌𝐃 𝐏𝐑𝐎*`;
      let sentOk = false;
      try {
        if (quotedMsg.imageMessage) { await socket.sendMessage(saveChat, { image: media.buffer, caption }); sentOk = true; }
        else if (quotedMsg.videoMessage) { await socket.sendMessage(saveChat, { video: media.buffer, caption, mimetype: media.mime || 'video/mp4' }); sentOk = true; }
        else if (quotedMsg.audioMessage) { await socket.sendMessage(saveChat, { audio: media.buffer, mimetype: media.mime || 'audio/mp4', ptt: media.ptt || false }); sentOk = true; }
        else if (quotedMsg.documentMessage) { await socket.sendMessage(saveChat, { document: media.buffer, fileName: media.fileName || 'status_file.bin', mimetype: media.mime || 'application/octet-stream', caption }); sentOk = true; }
        else if (quotedMsg.stickerMessage) { await socket.sendMessage(saveChat, { sticker: media.buffer }); sentOk = true; }
      } catch(e){ console.error('.sts send failed', e); }
      if (sentOk) await socket.sendMessage(sender, { text: `✅ *Status saved!*` }, { quoted: msg });
    } else if (quotedMsg.conversation || quotedMsg.extendedTextMessage) {
      const statusText = quotedMsg.conversation || quotedMsg.extendedTextMessage?.text || '';
      const textStatus = `╔═══『 📥 *STATUS SAVER* 』═══❒\n╠⦁\n╠⦁ 📝 *Status:*\n╠⦁ ${statusText}\n╠⦁\n╚═══════════════════════❒\n> ⚡ *𝐈𝐒𝐇𝐀𝐍-𝐗 𝐌𝐃 𝐏𝐑𝐎*`;
      await socket.sendMessage(saveChat, { text: textStatus });
      await socket.sendMessage(sender, { text: `✅ *Status saved!*` }, { quoted: msg });
    } else {
      await socket.sendMessage(sender, { text: `❌ *Unsupported status type.*` }, { quoted: msg });
    }
  } catch (error) {
    console.error('❌ .sts error:', error);
    await socket.sendMessage(sender, { text: `❌ *Failed to save status.*\n\nReason: ${error.message || 'Unknown error'}` }, { quoted: msg });
  }
  break;
}

case 'vv':
case 'දාපන්':
case 'ඔන':
case 'ewam':
case 'save': {
  try {
    const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
    if (!quotedMsg) {
      return await socket.sendMessage(sender, { text: '𝙸𝚂𝙷𝙰𝙽-𝚇 𝙼𝙳 𝙿𝚁𝙾 𝙿𝚕𝚎𝚊𝚜𝚎 𝚁𝚎𝚙𝚕𝚢 𝚃𝚘 𝙰 𝚂𝚝𝚊𝚝𝚞𝚜 !*' }, { quoted: msg });
    }

    try { await socket.sendMessage(sender, { react: { text: '🙈', key: msg.key } }); } catch(e){}

    // 🔵 Send the saved media to the user's inbox (DM with the bot) so the
    // saved status stays private even when .vv is used inside a group.
    const saveChat = nowsender;

    if (quotedMsg.imageMessage || quotedMsg.videoMessage || quotedMsg.audioMessage || quotedMsg.documentMessage || quotedMsg.stickerMessage) {
      const media = await downloadQuotedMedia(quotedMsg);
      if (!media || !media.buffer) {
        return await socket.sendMessage(sender, { text: '*𝙸𝚂𝙷𝙰𝙽-𝚇 𝙼𝙳 𝙿𝚁𝙾  𝙵𝚊𝚒𝚕𝚎𝚍 𝚃𝚘 𝙳𝚘𝚠𝚗𝚕𝚘𝚊𝚍 𝙼𝚎𝚍𝚒𝚊 !*' }, { quoted: msg });
      }

      let captionText = media.caption || '';
      const botCaption = `\n\n *𝗜𝗦𝗛𝗔𝗡-𝐗 𝗠𝗗 𝐈𝐌𝐀𝐆𝐄 𝐒𝐀𝐕𝐄𝐑* 📥`;

      if (quotedMsg.imageMessage) {
        await socket.sendMessage(saveChat, { image: media.buffer, caption: captionText + botCaption });
      } else if (quotedMsg.videoMessage) {
        await socket.sendMessage(saveChat, { video: media.buffer, caption: captionText + botCaption, mimetype: media.mime || 'video/mp4' });
      } else if (quotedMsg.audioMessage) {
        await socket.sendMessage(saveChat, { audio: media.buffer, mimetype: media.mime || 'audio/mp4', ptt: media.ptt || false });
      } else if (quotedMsg.documentMessage) {
        const fname = media.fileName || `𝙸𝚂𝙷𝙰𝙽-𝚇 𝙼𝙳 𝙿𝚁𝙾 Saved.${(await FileType.fromBuffer(media.buffer))?.ext || 'bin'}`;
        await socket.sendMessage(saveChat, { document: media.buffer, fileName: fname, mimetype: media.mime || 'application/octet-stream', caption: botCaption });
      } else if (quotedMsg.stickerMessage) {
        await socket.sendMessage(saveChat, { sticker: media.buffer });
      }

      await socket.sendMessage(sender, { text: '*𝗜𝗦𝗛𝗔𝗡-𝐗 𝗠𝗗 𝐈𝐌𝐀𝐆𝐄 𝐒𝐀𝐕𝐄𝐑* 💫\n\n*✅ 𝙳𝚘𝚠𝚗𝚕𝚘𝚊𝚍𝚎𝚍 𝚂𝚞𝚌𝚌𝚎𝚜𝚜𝚏𝚞𝚕𝚕𝚢 !*' }, { quoted: msg });

    } else if (quotedMsg.conversation || quotedMsg.extendedTextMessage) {
      const text = quotedMsg.conversation || quotedMsg.extendedTextMessage.text;
      await socket.sendMessage(saveChat, { text: `*𝗜𝗦𝗛𝗔𝗡-𝐗 𝗠𝗗 𝐈𝐌𝐀𝐆𝐄 𝐒𝐀𝐕𝐄𝐑* 📥\n\n${text}\n\n` });
      await socket.sendMessage(sender, { text: '*𝗜𝗦𝗛𝗔𝗡-𝐗 𝗠𝗗 𝐈𝐌𝐀𝐆𝐄 𝐒𝐀𝐕𝐄𝐑* 💫\n\n*✅ 𝚃𝚎𝚡𝚝 𝚂𝚊𝚟𝚎𝚍 𝚂𝚞𝚌𝚌𝚎𝚜𝚜𝚏𝚞𝚕𝚕𝚢 !*' }, { quoted: msg });
    } else {
      if (typeof socket.copyNForward === 'function') {
        try {
          const key = msg.message?.extendedTextMessage?.contextInfo?.stanzaId || msg.key;
          await socket.copyNForward(saveChat, msg.key, true);
          await socket.sendMessage(sender, { text: '*𝗜𝗦𝗛𝗔𝗡-𝐗 𝗠𝗗 𝐈𝐌𝐀𝐆𝐄 𝐒𝐀𝐕𝐄𝐑* 💫\n\n*✅ 𝙵𝚘𝚛𝚠𝚊𝚛𝚍𝚎𝚍 𝚂𝚞𝚌𝚌𝚎𝚜𝚜𝚏𝚞𝚕𝚕𝚢 !*' }, { quoted: msg });
        } catch (e) {
          await socket.sendMessage(sender, { text: '*𝙸𝚂𝙷𝙰𝙽-𝚇 𝙼𝙳 𝙿𝚁𝙾 𝙴𝚛𝚛𝚘𝚛 𝙵𝚘𝚛𝚠𝚊𝚛𝚍𝚒𝚗𝚐 𝙼𝚎𝚜𝚜𝚊𝚐𝚎 !*' }, { quoted: msg });
        }
      } else {
        await socket.sendMessage(sender, { text: '*𝙸𝚂𝙷𝙰𝙽-𝚇 𝙼𝙳 𝙿𝚁𝙾 𝚄𝚗𝚜𝚞𝚙𝚙𝚘𝚛𝚝𝚎𝚍 𝙼𝚎𝚜𝚜𝚊𝚐𝚎 𝚃𝚢𝚙𝚎 !*' }, { quoted: msg });
      }
    }

  } catch (error) {
    console.error('❌ Save error:', error);
    await socket.sendMessage(sender, { text: '*𝙸𝚂𝙷𝙰𝙽-𝚇 𝙼𝙳 𝙿𝚁𝙾 𝙵𝚊𝚒𝚕𝚎𝚍 𝚃𝚘 𝚂𝚊𝚟𝚎 𝚂𝚝𝚊𝚝𝚞𝚜 !*' }, { quoted: msg });
  }
  break;
}
// 🙌🙌
case 'alive': {
  try {
    // 1. Add Reaction (Immediate Feedback)
    await socket.sendMessage(sender, { react: { text: "👋", key: msg.key } });

    // Personal bot config (Premium customization) — falls back to defaults.
    const bc = await resolveDisplayBotConfig(socket, nowsender);
    const botName = bc.botName; // Personalized or default fancy name

    // Personal footer: custom Bot footer (Premium). Normal users keep the
    // original default developer footer.
    const aliveVars = { botname: botName, pushname: msg.pushName || 'User', name: msg.pushName || 'User', jid: nowsender, version: config.BOT_VERSION };
    const aliveFooterParts = [];
    aliveFooterParts.push(bc.botFooter && bc.botFooter !== BOT_FOOTER_DEFAULT
      ? renderBaseTemplate(bc.botFooter, aliveVars)
      : '> *𝐃𝙴𝚅𝙴𝙻𝙾𝙿𝙴𝚁 𝐁𝚈 𝐈𝚂𝙷𝙰𝙽-𝐗 × 𝐋𝙾𝚅𝙴𝙻𝚈 🧑‍💻🇱🇰*');
    const aliveFooter = aliveFooterParts.join('\n');

    // ⚡ DIRECT RAW LINK SETUP 
    const rawGifUrl = "https://raw.githubusercontent.com/Dilu-x/OWNER_DATA/refs/heads/main/image_data/alive-x.mp4";

    // 2. Calculate Uptime
    const startTime = socketCreationTime.get(number) || Date.now();
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = Math.floor(uptime % 60);

    // 3. Sinhala Greeting based on Sri Lanka time
    const nowSL_alive = moment().tz('Asia/Colombo');
    const hourSL_alive = nowSL_alive.hour();
    let aliveGreeting, aliveGreetingEmoji;
    if (hourSL_alive >= 5 && hourSL_alive < 12) {
      aliveGreeting = 'සුභ උදෑසනක් 🌄';
      aliveGreetingEmoji = '🌤️';
    } else if (hourSL_alive >= 12 && hourSL_alive < 17) {
      aliveGreeting = 'සුභ දහවලක් 🏞️';
      aliveGreetingEmoji = '🌞';
    } else if (hourSL_alive >= 17 && hourSL_alive < 21) {
      aliveGreeting = 'සුභ හැන්දෑවක් 🌅';
      aliveGreetingEmoji = '🌥️';
    } else {
      aliveGreeting = 'සුභ රාත්‍රියක් 🌌';
      aliveGreetingEmoji = '🌕';
    }

    // 4. RAM Usage
    const aliveRamUsed = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2);
    const aliveRamTotal = Math.round(os.totalmem() / 1024 / 1024);

    // 5. CPU Usage
    const aliveCpuUsage = (() => {
      const cpus = os.cpus();
      let totalIdle = 0, totalTick = 0;
      cpus.forEach(cpu => {
        for (const type in cpu.times) totalTick += cpu.times[type];
        totalIdle += cpu.times.idle;
      });
      return (100 - (totalIdle / totalTick * 100)).toFixed(1) + '%';
    })();

    // 6. Respond Speed
    const _alivePingStart = Date.now();
    await new Promise(r => setTimeout(r, 0));
    const aliveRespondSpeed = (Date.now() - _alivePingStart) + 'ms';

    // 7. Time & Date (Sri Lanka)
    const aliveTime = nowSL_alive.format('hh:mm:ss A');
    const aliveDate = nowSL_alive.format('YYYY-MM-DD');
    const aliveDayEmojiMap = { 0: '☀️', 1: '🌙', 2: '🔥', 3: '💧', 4: '⚡', 5: '🌟', 6: '🎉' };
    const aliveDateEmoji = aliveDayEmojiMap[nowSL_alive.day()] || '📆';

    // 8. Meta AI "Fake" Quote for style
    
    // 9. Beautiful & Art-full Caption Style
    const text = ` 𝐇𝙸 👋 ${botName}  𝐁𝙾𝚃 𝐔𝚂𝙴𝚁 𝐈 𝐀𝙼 𝐀𝙻𝙸𝚅𝙴 𝐍𝙾𝚆 💫

*╭━〔 𝙄𝙎𝙃𝘼𝙉-𝙓 𝙈𝘿 𝙋𝙍𝙊 ᴀʟɪᴠᴇ 〕━┈⊷❖●►*  
*├➣👩‍💼ᴜꜱᴇʀ:* @${sender.split('@')[0]}
*├➣🧑‍💻ᴏᴡɴᴇʀ:* ${config.OWNER_NAME || '© 𝙸𝚂𝙷𝙰𝙽-𝙼𝙰𝙳𝚄𝚂𝙰𝙽𝙺𝙴'}  
*├➣🤝ᴘᴀʀᴛɴᴇʀ:* *© ʟᴏᴠᴇʟʏ ᴏꜰꜰɪᴄɪᴀʟ*
*├➣⚙️ᴘʀᴇꜰɪx:* *[.]*  
*├➣🧬ᴠᴇʀꜱɪᴏɴ:* *8.0.0 ᴘʀᴏ*  
*├➣💻ᴘʟᴀᴛꜰʀᴏᴍ:* ${process.env.PLATFORM || '*ɪꜱʜᴀɴ-x ᴄʟᴏᴜᴅ*'}  
*├➣📟ᴜᴘᴛɪᴍᴇ:* ${hours}h ${minutes}m ${seconds}s  
*├➣${aliveGreetingEmoji}ɢʀᴇᴇᴛɪɴɢ:* \`${aliveGreeting}\`
*├➣💾ʀᴀᴍ:* ${aliveRamUsed}MB / ${aliveRamTotal}MB
*├➣🖥️ᴄᴘᴜ ᴜꜱᴀɢᴇ:* ${aliveCpuUsage}
*├➣⚡ʀᴇꜱᴘᴏɴᴅ ꜱᴘᴇᴇᴅ:* ${aliveRespondSpeed}
*├➣⏰ᴛɪᴍᴇ:* ${aliveTime}
*├➣${aliveDateEmoji}ᴅᴀᴛᴇ:* ${aliveDate}
*├➣🌍ʙᴏᴛ ᴡᴇʙ:* *${BOT_WEB_URL}*
*╰──────────────⊷❖✦►*

${aliveFooter}`;

    // 🎬 SENDING ALIVE GIF (or the Premium user's personal Alive image — a
    // custom .aliveimg wins; otherwise a custom .botimg is used, matching the
    // default where the alive image IS the bot image, so .botimg changes are
    // reflected in .alive too).
    const aliveCaption = `${text}\n\n_Type ${config.PREFIX}menu, ${config.PREFIX}ping or ${config.PREFIX}help_`;
    const aliveCustomImg = (bc.aliveImage && bc.aliveImage !== PREMIUM_DEFAULTS.aliveImage)
      ? bc.aliveImage
      : ((bc.botImage && bc.botImage !== PREMIUM_DEFAULTS.botImage) ? bc.botImage : null);
    if (aliveCustomImg) {
      await socket.sendMessage(sender, {
        image: { url: aliveCustomImg },
        caption: aliveCaption,
        footer: `*${botName}*`,
        headerType: 4,
        mentions: [sender]
      }, { quoted: msg });
    } else {
      await socket.sendMessage(sender, {
        video: { url: rawGifUrl },
        gifPlayback: true,
        caption: aliveCaption,
        footer: `*${botName}*`,
        headerType: 4,
        mentions: [sender] // Ensures the user tag works
      }, { quoted: msg });
    }

  } catch(e) {
    console.error('Alive command error:', e);
    await socket.sendMessage(sender, { text: '❌ An error occurred in alive command.' }, { quoted: msg });
  }
  break;
}


// ---------------------- PING ----------------------
case 'ping': {
  try {
    
    var inital = new Date().getTime();
    let pingMsg = await socket.sendMessage(sender, { text: '*_Pinging to Loku Module..._* ❗' }, { quoted: msg });
    var final = new Date().getTime();
    await socket.sendMessage(sender, { text: '《 █▒▒▒▒▒▒▒▒▒▒▒》10%', edit: pingMsg.key });
    await socket.sendMessage(sender, { text: '《 ████▒▒▒▒▒▒▒▒》30%', edit: pingMsg.key });
    await socket.sendMessage(sender, { text: '《 ███████▒▒▒▒▒》50%', edit: pingMsg.key });
    await socket.sendMessage(sender, { text: '《 ██████████▒▒》80%', edit: pingMsg.key });
    await socket.sendMessage(sender, { text: '《 ████████████》100%', edit: pingMsg.key });
    return await socket.sendMessage(sender, { text: '*Pong ' + (final - inital) + ' Ms ⚡*', edit: pingMsg.key });
  } catch (e) {
    console.error('Ping command error:', e);
    await socket.sendMessage(sender, { text: '*❌ Ping Error!!*' }, { quoted: msg });
  }
  break;
}

// ---------------------- PING2 (Dashboard Image) ----------------------
case 'ping2': {
  try {
    const { createCanvas } = require('canvas');

    await socket.sendMessage(sender, { react: { text: '⚡', key: msg.key } });

    const formatUptime = (seconds) => {
      const days = Math.floor(seconds / (3600 * 24));
      const hours = Math.floor((seconds % (3600 * 24)) / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      const secs = Math.floor(seconds % 60);
      const parts = [];
      if (days > 0) parts.push(`${days} days`);
      if (hours > 0) parts.push(`${hours} hours`);
      if (minutes > 0) parts.push(`${minutes} minutes`);
      if (secs > 0) parts.push(`${secs} seconds`);
      return parts.join(', ') || '0 seconds';
    };

    const buildDashboardImage = () => {
      const W = 1280;
      const H = 720;
      const canvas = createCanvas(W, H);
      const ctx = canvas.getContext("2d");

      const C = {
        bg: "#0b0f19",
        card: "#111625",
        stroke: "#1f293a",
        text: "#ffffff",
        subtext: "#7d8590",
        blue: "#3b82f6",
        green: "#10b981",
        purple: "#8b5cf6",
        cyan: "#06b6d4"
      };

      function ensureRoundRect(ctx) {
        if (typeof ctx.roundRect === 'function') return;
        ctx.roundRect = function (x, y, w, h, r) {
          const radius = typeof r === 'number' ? { tl: r, tr: r, br: r, bl: r } : r;
          this.beginPath();
          this.moveTo(x + radius.tl, y);
          this.lineTo(x + w - radius.tr, y);
          this.quadraticCurveTo(x + w, y, x + w, y + radius.tr);
          this.lineTo(x + w, y + h - radius.br);
          this.quadraticCurveTo(x + w, y + h, x + w - radius.br, y + h);
          this.lineTo(x + radius.bl, y + h);
          this.quadraticCurveTo(x, y + h, x, y + h - radius.bl);
          this.lineTo(x, y + radius.tl);
          this.quadraticCurveTo(x, y, x + radius.tl, y);
          this.closePath();
          return this;
        }
      }
      ensureRoundRect(ctx);

      function size(b) {
        const s = ["B", "KB", "MB", "GB", "TB"];
        const i = Math.floor(Math.log(b || 1) / Math.log(1024));
        return `${(b / Math.pow(1024, i)).toFixed(2)} ${s[i]}`;
      }

      function fmtTime(sec) {
        const d = Math.floor(sec / (3600 * 24));
        const h = Math.floor((sec % (3600 * 24)) / 3600);
        const m = Math.floor((sec % 3600) / 60);
        const s = Math.floor(sec % 60);
        return `${d}d ${h}h ${m}m ${s}s`;
      }

      function getRandomValue(min, max) {
        return Math.floor(Math.random() * (max - min + 1)) + min;
      }

      const botUptime = fmtTime(process.uptime());
      const pingSpeed = (0.0094).toFixed(4);
      const cpuPercent = getRandomValue(5, 45);
      const memPercent = getRandomValue(20, 60);
      const diskPercent = getRandomValue(10, 40);
      const cpuCores = getRandomValue(1, 4);
      const totalMem = 512 * 1024 * 1024;
      const usedMem = totalMem * (memPercent / 100);
      const diskUsed = 1 * 1024 * 1024 * 1024 * (diskPercent / 100);

      ctx.fillStyle = C.bg;
      ctx.fillRect(0, 0, W, H);

      ctx.fillStyle = C.cyan;
      ctx.font = "bold 24px sans-serif";
      ctx.fillText("⚡ ISHANN-X PRO SYSTEM DASHBOARD", 40, 50);
      ctx.fillStyle = C.subtext;
      ctx.font = "16px sans-serif";
      ctx.fillText("BOT Instance • Real-Time Monitor", 40, 75);

      const boxY = 110;
      const boxW = 280;
      const boxH = 220;
      const gap = 26;

      function box(x, y, w, h, radius = 10) {
        ctx.beginPath();
        ctx.roundRect(x, y, w, h, radius);
        ctx.fillStyle = C.card;
        ctx.fill();
        ctx.strokeStyle = C.stroke;
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      function circleGraph(x, y, r, pct, color, label, sub) {
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.strokeStyle = C.stroke;
        ctx.lineWidth = 12;
        ctx.stroke();

        ctx.beginPath();
        const start = -Math.PI / 2;
        const end = start + Math.PI * 2 * (pct / 100);
        ctx.arc(x, y, r, start, end);
        ctx.strokeStyle = color;
        ctx.lineWidth = 12;
        ctx.lineCap = "round";
        ctx.stroke();

        ctx.textAlign = "center";
        ctx.fillStyle = C.text;
        ctx.font = "bold 28px sans-serif";
        ctx.fillText(`${pct}%`, x, y + 8);

        ctx.fillStyle = C.subtext;
        ctx.font = "bold 14px sans-serif";
        ctx.fillText(label, x, y + r + 30);
        ctx.fillStyle = color;
        ctx.font = "12px sans-serif";
        ctx.fillText(sub, x, y + r + 50);
        ctx.textAlign = "left";
      }

      box(40, boxY, boxW, boxH);
      circleGraph(40 + boxW / 2, boxY + 90, 55, cpuPercent, C.blue, "CPU USAGE", `${cpuCores} Cores`);

      box(40 + boxW + gap, boxY, boxW, boxH);
      circleGraph(40 + boxW + gap + boxW / 2, boxY + 90, 55, memPercent, C.green, "MEMORY", size(usedMem));

      box(40 + (boxW + gap) * 2, boxY, boxW, boxH);
      circleGraph(40 + (boxW + gap) * 2 + boxW / 2, boxY + 90, 55, diskPercent, C.purple, "STORAGE", size(diskUsed));

      const netX = 40 + (boxW + gap) * 3;
      box(netX, boxY, boxW, boxH);
      ctx.fillStyle = C.cyan;
      ctx.font = "bold 18px sans-serif";
      ctx.fillText("BOT PERFORMANCE", netX + 20, boxY + 40);

      ctx.fillStyle = C.subtext;
      ctx.font = "14px sans-serif";
      ctx.fillText("⬆ Response Time", netX + 20, boxY + 90);
      ctx.fillStyle = C.text;
      ctx.font = "bold 18px sans-serif";
      ctx.fillText(`${pingSpeed}ms`, netX + 20, boxY + 115);

      ctx.fillStyle = C.subtext;
      ctx.font = "14px sans-serif";
      ctx.fillText("⬇ Bot Uptime", netX + 20, boxY + 160);
      ctx.fillStyle = C.text;
      ctx.font = "bold 16px sans-serif";
      ctx.fillText(botUptime.split(' ')[0] + ' ' + botUptime.split(' ')[1], netX + 20, boxY + 185);

      const pillY = 360;
      const pillH = 60;
      const pills = [
        { l: "HOST", v: "ISHAN-X CLOUD", c: C.blue },
        { l: "PLATFORM", v: "Linux x64", c: C.green },
        { l: "BOT UPTIME", v: botUptime.split(' ')[0], c: C.purple },
        { l: "LATENCY", v: `${pingSpeed}ms`, c: C.cyan },
        { l: "NODEJS", v: process.version, c: C.blue }
      ];
      const pillW = (W - 80 - gap * (pills.length - 1)) / pills.length;

      pills.forEach((p, i) => {
        const px = 40 + (pillW + gap) * i;
        box(px, pillY, pillW, pillH, 8);

        ctx.beginPath();
        ctx.arc(px + 20, pillY + 30, 4, 0, Math.PI * 2);
        ctx.fillStyle = p.c;
        ctx.fill();

        ctx.fillStyle = C.subtext;
        ctx.font = "10px sans-serif";
        ctx.fillText(p.l, px + 35, pillY + 22);

        ctx.fillStyle = C.text;
        ctx.font = "bold 14px sans-serif";
        ctx.fillText(p.v, px + 35, pillY + 45);
      });

      ctx.textAlign = "center";
      ctx.fillStyle = C.subtext;
      ctx.font = "italic 12px sans-serif";
      ctx.fillText(`𝙸𝚂𝙷𝙰𝙽-𝚇 𝙼𝙳 ᴘʀᴏ Dashboard™ • ${new Date().toLocaleString()}`, W / 2, H - 15);

      return canvas.toBuffer("image/png");
    };

    const imageBuffer = buildDashboardImage();

    await socket.sendMessage(sender, {
      image: imageBuffer,
      caption: `*— Bot Status ⌬*\n• *Runtime :* ${formatUptime(process.uptime())}\n• *Response Speed :* ${(0.0094).toFixed(4)} ms\n• *CPU Usage :* ${(Math.floor(Math.random() * 40) + 5) + '%'}\n\n—\n*𝗜𝗦𝗛𝗔𝗡-𝐗 𝗠𝗗 𝙋𝙍𝙊*`
    }, { quoted: msg });

  } catch (error) {
    console.error('Ping2 error:', error);
    await socket.sendMessage(sender, { text: '*❌ Ping2 Error!! (canvas module may not be installed — run: npm install canvas)*' }, { quoted: msg });
  }
  break;
}

case 'activesessions':
case 'active':
case 'bots': {
  try {
    // ------------------------------------------------------------------
    // 1. SETUP & SAFETY VARIABLES
    // ------------------------------------------------------------------
    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
    
    // Safety: Ensure we have a valid key to react to
    const targetKey = (msg && msg.key) ? msg.key : null;
    
    // Safety: Ensure 'sender' is defined
    const safeSender = sender || (msg && msg.key && msg.key.remoteJid) || '';
    if (!safeSender) break; 

    // React immediately 
    try { if(targetKey) await socket.sendMessage(safeSender, { react: { text: "👸", key: targetKey } }); } catch(e) {}

    // ------------------------------------------------------------------
    // 2. ADVANCED LOADING SEQUENCE (Fixed Strings)
    // ------------------------------------------------------------------
    
    // Send Initial "Booting" Message
    let loadMsg;
    try {
        loadMsg = await socket.sendMessage(safeSender, { 
            text: `🔄 *𝐈𝐒𝐇𝐀𝐍-𝐗 𝐌𝐃 𝐒𝐘𝐒𝐓𝐄𝐌 𝐁𝐎𝐎𝐓...*` 
        }, { quoted: msg });
    } catch (e) {
        console.log("Error sending load message:", e);
        break; 
    }

    const loadKey = loadMsg.key;

    // Animation 1: Connection (Using backticks to prevent SyntaxError)
    await sleep(500);
    await socket.sendMessage(safeSender, { 
        text: `📡 *Connecting to 𝙸𝚂𝙷𝙰𝙽-𝚇 𝙼𝙳 𝙿𝚁𝙾 Server...*
[⬜⬜⬜⬜⬜⬜⬜⬜⬜⬜] 0%`, 
        edit: loadKey 
    });

    // ------------------------------------------------------------------
    // 3. SECURE CONFIGURATION LOADING
    // ------------------------------------------------------------------
    
    const currentNumber = (typeof number !== 'undefined' ? number : '').replace(/[^0-9]/g, '');
    
    let cfg = {};
    try {
        if (typeof loadUserConfigFromMongo === 'function') {
            cfg = await loadUserConfigFromMongo(currentNumber) || {};
        }
    } catch (err) {
        console.warn("MongoDB Config Load Failed:", err);
    }

    const botName = "𝐈𝐒𝐇𝐀𝐍-𝐗 𝐌𝐃 𝐏𝐑𝐎";
    const defaultLogo = "https://raw.githubusercontent.com/minibotsjsisns/IMAGE_DATA/refs/heads/main/file_000000005eac720896d40b719700b3c0.png";
    const configLogo = cfg.logo || (typeof config !== 'undefined' ? config.RCD_IMAGE_PATH : null);

    // Animation 2: Security Check
    await sleep(700);
    await socket.sendMessage(safeSender, { 
        text: `🔐 *Checking Admin Privileges...*
[████▒▒▒▒▒▒▒▒▒▒] 40%`, 
        edit: loadKey 
    });

    // ------------------------------------------------------------------
    // 4. ROBUST PERMISSION SYSTEM
    // ------------------------------------------------------------------
    
    let isAdmin = false;
    let isOwnerSafe = (typeof isOwner !== 'undefined' ? isOwner : false);

    try {
        const dbAdmins = (typeof loadAdminsFromMongo === 'function') ? await loadAdminsFromMongo() : [];
        const normalizedAdmins = (dbAdmins || []).map(a => (a || '').toString().replace(/[^0-9]/g, ''));
        
        const senderNum = safeSender.split('@')[0];
        const realOwnerNum = (typeof nowsender !== 'undefined' ? nowsender : safeSender).split('@')[0];
        
        isAdmin = normalizedAdmins.includes(senderNum) || normalizedAdmins.includes(realOwnerNum);
    } catch (err) {
        console.error("Admin check error:", err);
    }

    if (!isOwnerSafe && !isAdmin) {
        await socket.sendMessage(safeSender, { 
            text: `❌ *ACCESS DENIED*
${botName} Protects This Data.
[██████████❌] FAILED`, 
            edit: loadKey 
        });
        if(targetKey) await socket.sendMessage(safeSender, { react: { text: "🚫", key: targetKey } });
        break; 
    }

    // ------------------------------------------------------------------
    // 5. SESSION DATA RETRIEVAL
    // ------------------------------------------------------------------
    
    // Animation 3: Scanning
    await sleep(600);
    await socket.sendMessage(safeSender, { 
        text: `🔍 *Scanning Active Sessions...*
[████████▒▒▒▒▒▒] 80%`, 
        edit: loadKey 
    });

    let activeCount = 0;
    let activeNumbers = [];
    
    try {
        let mapSource = null;
        if (typeof activeSockets !== 'undefined' && activeSockets instanceof Map) {
            mapSource = activeSockets;
        } else if (typeof global.activeSockets !== 'undefined' && global.activeSockets instanceof Map) {
            mapSource = global.activeSockets;
        }

        if (mapSource) {
            activeCount = mapSource.size;
            activeNumbers = Array.from(mapSource.keys());
        }
    } catch (e) {
        console.log("Error reading sockets:", e);
    }

    // Animation 4: Complete
    await sleep(500);
    await socket.sendMessage(safeSender, { 
        text: `✅ *${botName} Data Retrieved!*
[██████████████] 100%`, 
        edit: loadKey 
    });
    
    await sleep(500);
    await socket.sendMessage(safeSender, { delete: loadKey }); 

    // ------------------------------------------------------------------
    // 6. FINAL DASHBOARD GENERATION
    // ------------------------------------------------------------------
    
    if(targetKey) await socket.sendMessage(safeSender, { react: { text: "🕵️‍♂️", key: targetKey } });

    const getSLTime = () => {
        try {
            return new Date().toLocaleString('en-US', { timeZone: 'Asia/Colombo', hour12: true, hour: 'numeric', minute: 'numeric', second: 'numeric' });
        } catch (e) {
            return new Date().toLocaleTimeString();
        }
    };

    const time = getSLTime();
    const date = new Date().toLocaleDateString();

    // Using backticks for the main text block too
    let text = `╔══『 🤖 *𝗜𝗦𝗛𝗔𝗡-𝐗 𝗠𝗗 𝐁𝙾𝚃𝚂* 』═══❒
╠⦁
╠⦁  📡 *𝚂𝚝𝚊𝚝𝚞𝚜:* 🟢 𝙾𝚗𝚕𝚒𝚗𝚎
╠⦁  📊 *𝙰𝚌𝚝𝚒𝚟𝚎 𝚄𝚜𝚎𝚛𝚜:* ${activeCount}
╠⦁  📅 *𝙳𝚊𝚝𝚎:* ${date}
╠⦁  ⌚ *𝚃𝚒𝚖𝚎:* ${time}
╠⦁`;

    if (activeCount > 0) {
        text += `
╠⦁ 📱 *𝙲𝚘𝚗𝚗𝚎𝚌𝚝𝚎𝚍 𝚂𝚎𝚜𝚜𝚒𝚘𝚗𝚜:*`;
        activeNumbers.forEach((num, index) => {
            text += `
╠⦁    ${index + 1}. <code>${num}</code>`; 
        });
    } else {
        text += `
╠⦁ ⚠️ 𝙽𝚘 𝚊𝚌𝚝𝚒𝚟𝚎 𝚜𝚎𝚜𝚜𝚒𝚘𝚗𝚜.`;
    }
    
    text += `
╠⦁
╚══════════════════❒`;

    let imagePayload = { url: defaultLogo }; 
    
    if (configLogo) {
        if (String(configLogo).startsWith('http')) {
            imagePayload = { url: configLogo };
        } else {
            try {
                const fs = require('fs'); 
                if (fs.existsSync(configLogo)) {
                    imagePayload = fs.readFileSync(configLogo);
                }
            } catch (e) {
                console.log("Local logo not found, using default.");
            }
        }
    }

    await socket.sendMessage(safeSender, {
        image: imagePayload,
        caption: `${text}\n\n> _*𝐃𝙴𝚅𝙴𝙻𝙾𝙿𝙴𝚁 𝐁𝚈 𝐈𝚂𝙷𝙰𝙽-𝐗 × 𝐋𝙾𝚅𝙴𝙻𝚈 🧑‍💻🇱🇰*_`
    }, { quoted: msg });

  } catch(globalError) {
    console.error('ActiveSessions CRITICAL FAILURE:', globalError);
    try {
        await socket.sendMessage(sender, { 
            text: '❌ *𝙸𝚂𝙷𝙰𝙽-𝚇 𝙼𝙳 Error:* An unexpected system error occurred.' 
        }, { quoted: msg });
    } catch (e) {}
  }
  break;
}
// ==================== PER-USER MUSIC FOOTER COMMANDS ====================
// .setfooter <text>  → save/update the user's personal .csong caption footer
// .getfooter         → show the user's current footer (or the default)
// .resetfooter       → restore the default footer
case 'setfooter':
case 'setftr':
case 'csongfooter':
case 'setcsongfooter': {
  if (!perBotAllowed) break; // multi-bot chat without @mention → no bot acts
  const footerText = args.join(' ').trim();
  if (!footerText) {
    return await socket.sendMessage(sender, {
      text: `*✏️ SET FOOTER*\n\n*Usage:* ${prefix}setfooter <your custom footer>\n\n*Placeholders available:*\n┌─────────────────\n│ {pushname} → your WhatsApp name\n│ {title}    → song title\n│ {duration} → song duration\n│ {url}      → video URL\n└─────────────────\n\n*Example:*\n${prefix}setfooter Music by {pushname} | {title}\n\n${config.BOT_FOOTER}`
    }, { quoted: msg });
  }
  const ok = await setUserFooter(nowsender, footerText);
  const preview = renderFooterTemplate(footerText, {
    pushname: msg.pushName || 'User',
    title: 'Sample Song',
    duration: '3:45',
    url: 'https://youtu.be/xxxxxx'
  });
  if (ok) {
    await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
    return await socket.sendMessage(sender, {
      text: `*✏️ FOOTER SAVED* ✅\n\nYour custom footer is now saved.\n\n*Preview:*\n${preview}\n\n_Use ${prefix}resetfooter to restore the default._\n\n${config.BOT_FOOTER}`
    }, { quoted: msg });
  }
  return await socket.sendMessage(sender, { text: '❌ Failed to save footer. Try again later.' }, { quoted: msg });
}

case 'getfooter':
case 'getcsongfr': {
  if (!perBotAllowed) break; // multi-bot chat without @mention → no bot acts
  const custom = await getUserFooter(nowsender);
  if (custom) {
    const preview = renderFooterTemplate(custom, {
      pushname: msg.pushName || 'User',
      title: 'Sample Song',
      duration: '3:45',
      url: 'https://youtu.be/xxxxxx'
    });
    return await socket.sendMessage(sender, {
      text: `*👤 YOUR CUSTOM FOOTER*\n\n*Stored text:*\n${custom}\n\n*Preview:*\n${preview}\n\n_Use ${prefix}resetfooter to restore the default._\n\n${config.BOT_FOOTER}`
    }, { quoted: msg });
  }
  return await socket.sendMessage(sender, {
    text: `*👤 YOUR FOOTER*\n\nYou have no custom footer — the default is used.\n\n*Default:*\n${renderFooterTemplate(DEFAULT_CSONG_FOOTER, {
      pushname: msg.pushName || 'User',
      title: 'Sample Song',
      duration: '3:45',
      url: 'https://youtu.be/xxxxxx'
    })}\n\n_Set one with:_ ${prefix}setfooter <text>\n\n${config.BOT_FOOTER}`
  }, { quoted: msg });
}

case 'resetfooter':
case 'resetcsong': {
  if (!perBotAllowed) break; // multi-bot chat without @mention → no bot acts
  await resetUserFooter(nowsender);
  await socket.sendMessage(sender, { react: { text: '♻️', key: msg.key } });
  return await socket.sendMessage(sender, {
    text: `*♻️ FOOTER RESET*\n\nYour custom footer has been removed. The default footer will be used for your .csong music captions now.\n\n${config.BOT_FOOTER}`
  }, { quoted: msg });
}

case 'song':
case 's':
case 'play':
case 'music':
case 'audio':
case 'mp3':
case 'ytmp3': {
  try {
    const q = args.join(' ').trim();
    console.log('[song] search started for:', q);

    if (!q) {
      await socket.sendMessage(sender, { react: { text: '🎼', key: msg.key } });
      await socket.sendMessage(sender, { text: `*🎵 𝐈𝐒𝐇𝐀𝐍-𝐗 𝐌𝐃 • 𝐒𝐎𝐍𝐆 𝐃𝐎𝐖𝐍𝐋𝐎𝐀𝐃𝐄𝐑*\n\n*Usage:* ${prefix}song <song name / YouTube URL>\n*Example:* ${prefix}song Not Like Us\n\n${config.BOT_FOOTER}` }, { quoted: msg });
      return;
    }

    await socket.sendMessage(sender, { react: { text: '🔍', key: msg.key } });

    // Animated searching text (edited in place)
    const searchingStages = ['*S E A R C H I N G*', '*S E A R C H I N G* ·', '*S E A R C H I N G* ··'];
    const loadingMsg = await socket.sendMessage(sender, { text: searchingStages[0] }, { quoted: msg });
    let stageIndex = 0;
    const editInterval = setInterval(async () => {
      stageIndex = (stageIndex + 1) % searchingStages.length;
      try { await socket.sendMessage(sender, { text: searchingStages[stageIndex], edit: loadingMsg.key }); } catch (e) {}
    }, 400);
    const stopLoading = async () => {
      clearInterval(editInterval);
      await socket.sendMessage(sender, { delete: loadingMsg.key }).catch(() => {});
    };

    // Resolve the video ID: from a YouTube URL directly, otherwise search and
    // take the top result (new backend: @dark-yasiya/scrap).
    let videoId = null;
    const urlMatch = q.match(/(?:youtube\.com\/(?:.*v=|.*\/)|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/);
    if (/^https?:\/\//i.test(q) && urlMatch) videoId = urlMatch[1];

    const DY_SCRAP = require('@dark-yasiya/scrap');
    const dy_scrap = new DY_SCRAP();

    let search = null;
    let data = null;
    let chosen = null;
    try {
      if (!videoId) {
        // Keyword search: the top result already carries title / duration /
        // views / artist / thumbnail / url — skip the extra URL lookup that
        // used to add ~1s to every .song.
        search = await dy_scrap.ytsearch(q);
        if (!search || !search.results || !search.results.length) {
          await socket.sendMessage(sender, { text: `*🔍 SEARCH RESULTS*\n\n*❌ No songs found for "${q}".*\n\n${config.BOT_FOOTER}` }, { quoted: msg });
          return;
        }
        chosen = search.results[0];
        videoId = chosen.videoId;
      } else {
        // Direct URL input: fetch the video's details.
        data = await dy_scrap.ytsearch(`https://youtube.com/watch?v=${videoId}`);
        if (!data || !data.results || !data.results.length) {
          await socket.sendMessage(sender, { text: `*❌ Failed to fetch video info.*\n\n${config.BOT_FOOTER}` }, { quoted: msg });
          return;
        }
        chosen = data.results[0];
      }
    } finally {
      await stopLoading();
    }
    if (!chosen) {
      await socket.sendMessage(sender, { text: `*❌ Failed to fetch video info.*\n\n${config.BOT_FOOTER}` }, { quoted: msg });
      return;
    }
    const { url, title, image, timestamp, ago, views, author } = chosen;
    const authorName = (author && author.name) || author || 'Unknown';
    const info =
`╭─ 🎵 *𝐒𝐎𝐍𝐆 𝐅𝐎𝐔𝐍𝐃*───╮\n\n` +
`> 🎬 *Title:*    ${title || 'Unknown'}\n` +
`> ⏱️ *Duration:* ${timestamp || 'Unknown'}\n` +
`> 👁️ *Views:*   ${typeof views === 'number' ? views.toLocaleString() : (views || 'Unknown')}\n` +
`> 📅 *Released:* ${ago || 'Unknown'}\n` +
`> 👤 *Artist:*   ${authorName}\n` +
`> 🔗 *Link:*     ${url || 'Unknown'}\n\n` +
`╰─────────────╯\n\n` +
`┏━ *DOWNLOAD OPTIONS* ━━━┓\n` +
`┃   ① 🎧 *Audio* — MP3             ┃\n` +
`┃   ② 📄 *Document* — MP3        ┃\n` +
`┃   ③ 🎤 *Voice Note* — OGG     ┃\n` +
`┗━━━━━━━━━━━━━━━┛\n\n` +
`💬 *Reply with 1, 2 or 3*`;

    let menuMsg;
    try {
      menuMsg = await socket.sendMessage(sender, { image: { url: image }, caption: info }, { quoted: msg });
    } catch (e) {
      console.warn('[song] thumbnail send failed, fell back to text:', e && e.message || e);
      menuMsg = await socket.sendMessage(sender, { text: info }, { quoted: msg }).catch(() => {});
    }
    await socket.sendMessage(sender, { react: { text: '🎼', key: menuMsg.key } });

    // Session: reply 1 (Audio), 2 (Document) or 3 (Voice Note) — quoting this
    // menu always works (msgId match); a plain number also works while it stays
    // most recent.
    const songSess = { stage: 'select_format', chosen, title: title || 'Unknown', msgId: menuMsg && menuMsg.key ? menuMsg.key.id : null, ts: Date.now(), botJid: currentBotJid() };
    songSess.timer = setTimeout(() => songState.delete(nowsender), 180000);
    delete pendingRowSelect[sender];
    songState.set(nowsender, songSess);
    console.log(`[song] format menu sent (msgId=${menuMsg.key.id})`);
  } catch (e) {
    console.error('[SONG CMD ERROR]', e);
    await socket.sendMessage(sender, { text: `*❌ Song Error:* ${e.message || 'Please try again.'}\n\n${config.BOT_FOOTER}` }, { quoted: msg }).catch(() => {});
  }
  break;
}

// ==================== SPOTIFY DOWNLOADER ====================
case 'spotify':
case 'spotifydl':
case 'spdl':
case 'spotifyplay':
case 'spotifydlv2': {
  try {
    await socket.sendMessage(sender, { react: { text: '🎵', key: msg.key } });
    const q = args.join(' ').trim();
    console.log('[spotify] search started for:', q);

    if (!q) {
      await socket.sendMessage(sender, { text: `*🎵 𝐈𝐒𝐇𝐀𝐍-𝐗 𝐌𝐃 • 𝐒𝐏𝐎𝐓𝐈𝐅𝐘 𝐃𝐎𝐖𝐍𝐋𝐎𝐀𝐃𝐄𝐑*\n\n*Usage:* ${prefix}spotify <song name / Spotify URL>\n*Example:* ${prefix}spotify Blinding Lights\n\n${config.BOT_FOOTER}` }, { quoted: msg });
      return;
    }

    const SPOTIFY_IMG = 'https://storage.googleapis.com/pr-newsroom-wp/1/2023/05/Spotify_Primary_Logo_RGB_Green.png';
    let spotifyUrl = q;
    let trackTitle = null;
    let trackArtist = null;
    let trackThumb = SPOTIFY_IMG;
    let ytFallback = null; // { url, title, thumb } used when the Spotify APIs are down

    if (!/open\.spotify\.com/i.test(q)) {
      // Searching animation (edited in place)
      const searchStages = ['*S E A R C H I N G*', '*S E A R C H I N G* ·', '*S E A R C H I N G* ··'];
      const searchMsg = await socket.sendMessage(sender, { text: searchStages[0] }, { quoted: msg });
      let stageIdx = 0;
      const searchInterval = setInterval(async () => {
        stageIdx = (stageIdx + 1) % searchStages.length;
        try { await socket.sendMessage(sender, { text: searchStages[stageIdx], edit: searchMsg.key }); } catch (e) {}
      }, 400);
      const stopSearch = async () => {
        clearInterval(searchInterval);
        await socket.sendMessage(sender, { delete: searchMsg.key }).catch(() => {});
      };

      // Search Spotify (primary) — falls back to YouTube when the API is down.
      try {
        const searchRes = await axios.get(
          `https://riimusic.my.id/api/spotify/search?apikey=riicode&query=${encodeURIComponent(q)}`,
          { timeout: 30000, headers: { 'User-Agent': 'Mozilla/5.0' } }
        );
        const track = searchRes.data && searchRes.data.result && searchRes.data.result.songs && searchRes.data.result.songs[0];
        if (track) {
          spotifyUrl = track.url || q;
          trackTitle = track.title || null;
          trackArtist = track.artist || null;
          trackThumb = track.thumb || track.thumbnail || SPOTIFY_IMG;
        }
      } catch (e) {
        console.warn('[spotify] search API failed:', e.message);
      }
      if (!trackTitle) {
        // Spotify search unavailable → resolve via YouTube so the command still works.
        try {
          const ytsSearch = require('yt-search');
          const ytRes = await ytsSearch(q);
          const v = ytRes && ytRes.videos && ytRes.videos[0];
          if (v) {
            ytFallback = { url: v.url, title: v.title, thumb: v.thumbnail || SPOTIFY_IMG };
            trackTitle = v.title;
            trackArtist = (v.author && v.author.name) || null;
            trackThumb = ytFallback.thumb;
          }
        } catch (yErr) {
          console.warn('[spotify] yt fallback search failed:', yErr.message);
        }
      }
      if (!trackTitle) {
        await stopSearch();
        await socket.sendMessage(sender, { text: `*❌ No tracks found for "${q}".*\n\n${config.BOT_FOOTER}` }, { quoted: msg });
        return;
      }

      await stopSearch();
      // Track found info card
      const foundCaption = `*🎵 𝐈𝐒𝐇𝐀𝐍-𝐗 𝐌𝐃 • 𝐒𝐏𝐎𝐓𝐈𝐅𝐘 𝐃𝐎𝐖𝐍𝐋𝐎𝐀𝐃𝐄𝐑*\n\n` +
        `*🎬 Title:* ${trackTitle}\n` +
        `*🎤 Artist:* ${trackArtist || 'Unknown'}\n\n` +
        (ytFallback ? `_⚠️ Spotify API is down — using YouTube fallback._\n\n` : `_⚙️ Preparing download..._\n\n`) +
        `${config.BOT_FOOTER}`;
      try {
        await socket.sendMessage(sender, { image: { url: trackThumb }, caption: foundCaption }, { quoted: msg });
      } catch (e) {
        await socket.sendMessage(sender, { text: foundCaption }, { quoted: msg }).catch(() => {});
      }
    }

    // Preparing animation
    const prepStages = ['*P R E P A R I N G*', '*P R E P A R I N G* ·', '*P R E P A R I N G* ··'];
    const prepMsg = await socket.sendMessage(sender, { text: prepStages[0] }, { quoted: msg });
    let prepIdx = 0;
    const prepInterval = setInterval(async () => {
      prepIdx = (prepIdx + 1) % prepStages.length;
      try { await socket.sendMessage(sender, { text: prepStages[prepIdx], edit: prepMsg.key }); } catch (e) {}
    }, 400);
    const stopPrep = async () => {
      clearInterval(prepInterval);
      await socket.sendMessage(sender, { delete: prepMsg.key }).catch(() => {});
    };

    // Download: Spotify API first, then the YouTube fallback chain.
    let downloadUrl = null;
    let viaSpotifyApi = false;
    let dlTitle = trackTitle || 'song';
    try {
      if (spotifyUrl && /open\.spotify\.com/i.test(spotifyUrl)) {
        try {
          const { data } = await axios.get(
            `https://api.ikyyxd.my.id/download/spotifydl?url=${encodeURIComponent(spotifyUrl)}`,
            { timeout: 40000, headers: { 'User-Agent': 'Mozilla/5.0' } }
          );
          if (data && data.status && data.result && data.result.download) {
            downloadUrl = data.result.download;
            dlTitle = data.result.title || dlTitle;
            viaSpotifyApi = true;
          } else {
            console.warn('[spotify] dl API returned status:', data && data.status);
          }
        } catch (dlErr) {
          console.warn('[spotify] dl API failed:', dlErr.message);
        }
      }
      if (!downloadUrl && ytFallback && ytFallback.url) {
        const dl = await songGetDownload(ytFallback.url);
        if (dl && dl.url) downloadUrl = dl.url;
      }
      if (!downloadUrl) {
        await stopPrep();
        await socket.sendMessage(sender, { text: `*❌ DOWNLOAD FAILED*\n\nAll download sources are currently unavailable. Try again later.\n\n${config.BOT_FOOTER}` }, { quoted: msg });
        return;
      }

      if (viaSpotifyApi) {
        // Direct Spotify download → buffer send
        const audioRes = await axios.get(downloadUrl, { responseType: 'arraybuffer', timeout: 120000, headers: { 'User-Agent': 'Mozilla/5.0' } });
        await stopPrep();
        await socket.sendMessage(sender, { audio: Buffer.from(audioRes.data), mimetype: 'audio/mpeg', fileName: `${dlTitle}.mp3`, ptt: false }, { quoted: msg });
      } else {
        // YouTube fallback → stream to file and send
        const tempDir = path.join(os.tmpdir(), 'shitsu-temp');
        if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
        const filePath = path.join(tempDir, `spotify_${Date.now()}.mp3`);
        try {
          await songStreamToFile(downloadUrl, filePath);
          await stopPrep();
          await socket.sendMessage(sender, { audio: { url: filePath }, mimetype: 'audio/mpeg', fileName: `${dlTitle}.mp3`, ptt: false }, { quoted: msg });
        } finally {
          try { fs.unlinkSync(filePath); } catch (e) {}
        }
      }
      console.log(`[spotify] download sent for "${dlTitle}"`);
    } catch (e) {
      await stopPrep();
      console.error('[SPOTIFY DL ERROR]', e);
      await socket.sendMessage(sender, { text: `*❌ Download error:* ${e.message || 'Please try again.'}\n\n${config.BOT_FOOTER}` }, { quoted: msg }).catch(() => {});
    }
  } catch (e) {
    console.error('[SPOTIFY ERROR]', e);
    await socket.sendMessage(sender, { text: `*❌ Spotify Error:* ${e.message || 'Please try again.'}\n\n${config.BOT_FOOTER}` }, { quoted: msg }).catch(() => {});
  }
  break;
}

// ==================== SPOTIFY V2 (ikyyxd search → numbered pick → download) ====================
case 'spotifyv2': {
  try {
    const q = args.join(' ').trim();
    if (!q) {
      await socket.sendMessage(sender, { text: `*🎵 SPOTIFY V2*\n\n*Usage:* ${prefix}spotifyv2 <song name>\n*Example:* ${prefix}spotifyv2 Lovely\n\n${config.BOT_FOOTER}` }, { quoted: msg });
      return;
    }
    await socket.sendMessage(sender, { react: { text: '🎵', key: msg.key } });

    const searchStages = ['*S E A R C H I N G*', '*S E A R C H I N G* ·', '*S E A R C H I N G* ··'];
    const searchMsg = await socket.sendMessage(sender, { text: searchStages[0] }, { quoted: msg });
    let stageIdx = 0;
    const searchInterval = setInterval(async () => {
      stageIdx = (stageIdx + 1) % searchStages.length;
      try { await socket.sendMessage(sender, { text: searchStages[stageIdx], edit: searchMsg.key }); } catch (e) {}
    }, 400);
    const stopSearch = async () => {
      clearInterval(searchInterval);
      await socket.sendMessage(sender, { delete: searchMsg.key }).catch(() => {});
    };

    let tracks = [];
    try {
      const { data } = await axios.get(
        `https://api.ikyyxd.my.id/search/spotify?query=${encodeURIComponent(q)}`,
        { timeout: 30000, headers: { 'User-Agent': 'Mozilla/5.0' } }
      );
      tracks = (data && data.status && Array.isArray(data.tracks)) ? data.tracks : [];
    } catch (e) {
      console.warn('[spotifyv2] search API failed:', e.message);
    }
    await stopSearch();

    if (!tracks.length) {
      await socket.sendMessage(sender, { text: `*❌ No tracks found for "${q}".*\n\n${config.BOT_FOOTER}` }, { quoted: msg });
      return;
    }

    const top = tracks.slice(0, 10);
    const spotifyV2Rows = top.map(t => ({
      label: `${t.name} - ${(t.artist || []).join(', ')} (${t.length || '?'})`,
      id: `${prefix}spotifyv2dl ${t.link}`
    }));
    setPendingRowSelect(sender, spotifyV2Rows);

    const caption = `*🎵 𝐈𝐒𝐇𝐀𝐍-𝐗 𝐌𝐃 • 𝐒𝐏𝐎𝐓𝐈𝐅𝐘 𝐕𝟐*\n\n*○ Search:* ${q}\n*○ Found:* ${tracks.length} tracks\n\n${buildNumberedList(spotifyV2Rows)}\n\n*Reply with the number to download that track.*`;
    try {
      await socket.sendMessage(sender, { image: { url: top[0].cover || 'https://storage.googleapis.com/pr-newsroom-wp/1/2023/05/Spotify_Primary_Logo_RGB_Green.png' }, caption, footer: config.BOT_FOOTER }, { quoted: msg });
    } catch (e) {
      await socket.sendMessage(sender, { text: `${caption}\n\n${config.BOT_FOOTER}` }, { quoted: msg }).catch(() => {});
    }
  } catch (e) {
    console.error('[SPOTIFYV2 ERROR]', e);
    await socket.sendMessage(sender, { text: `*❌ Spotify V2 Error:* ${e.message || 'Please try again.'}\n\n${config.BOT_FOOTER}` }, { quoted: msg }).catch(() => {});
  }
  break;
}

case 'spotifyv2dl': {
  try {
    const spotifyUrl = (args[0] || '').trim();
    if (!spotifyUrl || !/open\.spotify\.com/i.test(spotifyUrl)) {
      await socket.sendMessage(sender, { text: `*❌ Invalid Spotify track URL.*\n\n${config.BOT_FOOTER}` }, { quoted: msg });
      return;
    }
    await socket.sendMessage(sender, { react: { text: '⬇️', key: msg.key } });

    const prepStages = ['*P R E P A R I N G*', '*P R E P A R I N G* ·', '*P R E P A R I N G* ··'];
    const prepMsg = await socket.sendMessage(sender, { text: prepStages[0] }, { quoted: msg });
    let prepIdx = 0;
    const prepInterval = setInterval(async () => {
      prepIdx = (prepIdx + 1) % prepStages.length;
      try { await socket.sendMessage(sender, { text: prepStages[prepIdx], edit: prepMsg.key }); } catch (e) {}
    }, 400);
    const stopPrep = async () => {
      clearInterval(prepInterval);
      await socket.sendMessage(sender, { delete: prepMsg.key }).catch(() => {});
    };

    const { data } = await axios.get(
      `https://api.ikyyxd.my.id/download/spotifydl?url=${encodeURIComponent(spotifyUrl)}`,
      { timeout: 40000, headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    if (!data || !data.status || !data.result || !data.result.download) {
      await stopPrep();
      await socket.sendMessage(sender, { text: `*❌ DOWNLOAD FAILED*\n\nSpotify API is currently unavailable. Try again later.\n\n${config.BOT_FOOTER}` }, { quoted: msg });
      return;
    }
    const dlTitle = data.result.title || 'song';
    const audioRes = await axios.get(data.result.download, { responseType: 'arraybuffer', timeout: 120000, headers: { 'User-Agent': 'Mozilla/5.0' } });
    await stopPrep();
    await socket.sendMessage(sender, { audio: Buffer.from(audioRes.data), mimetype: 'audio/mpeg', fileName: `${dlTitle}.mp3`, ptt: false }, { quoted: msg });
    await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
    console.log(`[spotifyv2] download sent for "${dlTitle}"`);
  } catch (e) {
    console.error('[SPOTIFYV2DL ERROR]', e);
    await socket.sendMessage(sender, { text: `*❌ Download error:* ${e.message || 'Please try again.'}\n\n${config.BOT_FOOTER}` }, { quoted: msg }).catch(() => {});
  }
  break;
}
case 'ytaa': {
    try {
        const dlcore = require('sadaslk-dlcore');

        const q = args.join(' ').trim();
        if (!q) return await socket.sendMessage(sender, { text: '*❌ කරුණාකර url එකක් ලබා දෙන්න Provide a URL or a keyword*' }, { quoted: msg });

        await socket.sendMessage(sender, { react: { text: '⬇️', key: msg.key } });

        const result = await dlcore.ytmp3(q);
        if (!result || !result.url) throw new Error('No download URL returned');

        await socket.sendMessage(sender, {
            audio: { url: result.url },
            mimetype: 'audio/mpeg'
        }, { quoted: msg });

        await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });

    } catch (e) {
        console.error('ytaa Error:', e);
        await socket.sendMessage(sender, { text: '*❌ Song Dl Error*' }, { quoted: msg });
    }
    break;
}
case 'ytaap': {
    try {
        const dlcore = require('sadaslk-dlcore');
        const ffmpeg = require('fluent-ffmpeg');
        const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
        ffmpeg.setFfmpegPath(ffmpegInstaller.path);

        const q = args.join(' ').trim();
        if (!q) return await socket.sendMessage(sender, { text: '*❌ කරුණාකර url එකක් ලබා දෙන්න Provide a URL or a keyword*' }, { quoted: msg });

        const result = await dlcore.ytmp3(q);
        if (!result || !result.url) throw new Error('No download URL returned');

        const mp3File = path.join(os.tmpdir(), `ytaap_${Date.now()}.mp3`);
        const oggFile = path.join(os.tmpdir(), `ytaap_${Date.now()}.ogg`);

        const dl = await axios.get(result.url, { responseType: 'arraybuffer' });
        fs.writeFileSync(mp3File, dl.data);

        await socket.sendMessage(sender, { react: { text: '⬆️', key: msg.key } });

        await new Promise((resolve, reject) => {
            ffmpeg(mp3File)
                .audioCodec('libopus')
                .audioBitrate('64k')
                .format('ogg')
                .save(oggFile)
                .on('end', resolve)
                .on('error', reject);
        });

        await socket.sendMessage(sender, {
            audio: fs.readFileSync(oggFile),
            mimetype: 'audio/ogg; codecs=opus',
            ptt: true
        }, { quoted: msg });

        await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });

        if (fs.existsSync(mp3File)) fs.unlinkSync(mp3File);
        if (fs.existsSync(oggFile)) fs.unlinkSync(oggFile);

    } catch (e) {
        console.error('ytaap Error:', e);
        await socket.sendMessage(sender, { text: '*❌ Song Dl Error*' }, { quoted: msg });
    }
    break;
}
case 'ytad': {
    try {
        const dlcore = require('sadaslk-dlcore');
        const sharp = require('sharp');

        const q = args.join(' ').trim();
        if (!q) return await socket.sendMessage(sender, { text: '*❌ කරුණාකර url එකක් ලබා දෙන්න Provide a URL or a keyword*' }, { quoted: msg });

        const ownerdata = (await axios.get(
            'https://raw.githubusercontent.com/Dilu-x/OWNER_DATA/refs/heads/main/ownerdata'
        )).data;
        const { footer } = ownerdata;

        const parts = q.split('±');
        const url = parts[0];
        const title = parts[2] || 'Song';

        const result = await dlcore.ytmp3(url);
        if (!result || !result.url) throw new Error('No download URL returned');

        const ytRegex = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:[^\/\n\s]+\/\S+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;
        const match = url.match(ytRegex);
        let resizedBotImg;
        if (match && match[1]) {
            const thumbUrl = `https://i.ytimg.com/vi/${match[1]}/hqdefault.jpg`;
            const res = await axios.get(thumbUrl, { responseType: 'arraybuffer' });
            resizedBotImg = await sharp(Buffer.from(res.data)).resize(200, 200).toBuffer();
        }

        await socket.sendMessage(sender, { react: { text: '⬆️', key: msg.key } });

        await socket.sendMessage(sender, {
            document: { url: result.url },
            mimetype: 'audio/mpeg',
            caption: `\`${title}\`\n\n${footer}`,
            jpegThumbnail: resizedBotImg,
            fileName: `${title}.mp3`
        }, { quoted: msg });

        await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });

    } catch (e) {
        console.error('ytad Error:', e);
        await socket.sendMessage(sender, { text: '*❌ Song Dl Error*' }, { quoted: msg });
    }
    break;
}
case 'system': {
  try {
    await socket.sendMessage(sender, { react: { text: '🧬', key: msg.key } });

    const date = moment().tz('Asia/Colombo').format('YYYY-MM-DD');
    const time = moment().tz('Asia/Colombo').format('HH:mm:ss');

    let hostname;
    const hostLen = os.hostname().length;
    if (hostLen === 12) hostname = 'Replit';
    else if (hostLen === 36) hostname = 'Heroku';
    else if (hostLen === 8) hostname = 'Koyeb';
    else hostname = os.hostname();

    const ramUsedMB = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2);
    const ramTotalMB = Math.round(os.totalmem() / 1024 / 1024);
    const ram = `${ramUsedMB} MB / ${ramTotalMB} MB`;
    const uptimeSec = process.uptime();
    const ud = Math.floor(uptimeSec / (24 * 3600));
    const uh = Math.floor((uptimeSec % (24 * 3600)) / 3600);
    const um = Math.floor((uptimeSec % 3600) / 60);
    const us = Math.floor(uptimeSec % 60);
    const rtime = `${ud}d ${uh}h ${um}m ${us}s`;

    const ownerdata = (await axios.get(
      'https://raw.githubusercontent.com/Dilu-x/OWNER_DATA/refs/heads/main/ownerdata'
    )).data;

    const { footer, imageurl13, version, botname, ownername, ownernumber, platform } = ownerdata;

    // Show ALL owner numbers from config (e.g. 94778761926 + 94764642432)
    // instead of only the single number inside the GitHub ownerdata file.
    const ownerNumbers = getPublicOwnerNumber() || ownernumber;

    const systemMessage = `
*╭──『 SYSTEM INFO 』─◉◉➤*
*│ 📌 \`CREATOR\` : -* *${ownername}*
*│ 📞 \`Hotline\` : -* *${ownerNumbers}*
*│ 📅 \`Date\` : -* *${date}*
*│ ⌚ \`Time\` : -* *${time}*
*│ 🕒 \`Uptime\` : -* *${rtime}*
*│ 💾 \`RAM Usage\` : -* *${ram}*
*│ 🖥️ \`Platform\` : -* *${platform}*
*│ 🧬 \`Version\` : -* *${version}*
*╰──────────────◉◉➤*

${footer}`;

    await socket.sendMessage(sender, {
      image: { url: imageurl13 },
      caption: `${systemMessage}\n\n_Type ${config.PREFIX}menu or ${config.PREFIX}owner_`,
      contextInfo: {
        forwardingScore: 999,
        isForwarded: false
      },
      headerType: 4
    }, { quoted: msg });

  } catch (e) {
    console.error('system error', e);
    await socket.sendMessage(sender, { text: `*❌ System Error :-*\n${e.message}` }, { quoted: msg });
  }
  break;
}
// ==================== MAIN MENU ====================
case 'menu': {
  try {
    // 📖 Initial reaction
    await socket.sendMessage(sender, { react: { text: "📖", key: msg.key } });

    // Loading messages
    let pingMsg = await socket.sendMessage(sender, { text: '`LOADING`' }, { quoted: msg });
    await socket.sendMessage(sender, { text: '`BOT/S MENU` ✅', edit: pingMsg.key });

    // Hostname check
    let hostname;
    const hostLen = os.hostname().length;
    if (hostLen === 12) hostname = "Replit";
    else if (hostLen === 36) hostname = "Heroku";
    else if (hostLen === 8) hostname = "Koyeb";
    else hostname = os.hostname();

    // RAM and Uptime calculations
    const ramUsed = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2);
    const ramTotal = Math.round(os.totalmem() / 1024 / 1024);
    const uptimeSec = process.uptime();
    const ud = Math.floor(uptimeSec / (24 * 3600));
    const uh = Math.floor((uptimeSec % (24 * 3600)) / 3600);
    const um = Math.floor((uptimeSec % 3600) / 60);
    const uptimeStr = `${ud}d ${uh}h ${um}m`;

    // 🌐 Fetching data from your updated GitHub raw link
    const ownerdata = (await axios.get(
      "https://raw.githubusercontent.com/Dilu-x/OWNER_DATA/refs/heads/main/ownerdata"
    )).data;

    const {
      footer, imageurl0,
      version, botname, ownername, ownernumber,
      platform
    } = ownerdata;
    // Show ALL owner numbers from config (e.g. 94778761926 + 94764642432)
    // instead of only the single number inside the GitHub ownerdata file.
    const ownerNumbers = getPublicOwnerNumber() || ownernumber;
    const pairlink = BOT_WEB_URL;

    const pushname = msg.pushName || 'Guest';

    // Personal bot config (Premium customization) — falls back to defaults.
    const bc = await resolveDisplayBotConfig(socket, nowsender);
    const personalBotname = bc.botName;
    const menuVars = { botname: personalBotname, pushname, name: pushname, jid: nowsender, version: config.BOT_VERSION };
    const menuHeaderLine = bc.menuHeader ? renderBaseTemplate(bc.menuHeader, menuVars) : '*╭〔 𝙄𝙎𝙃𝘼𝙉-𝙓 𝙈𝘿 𝙋𝙍𝙊 𝙈𝙀𝙉𝙐 〕┈⊷❖●►*';
    const menuFooterLine = `> *├➣🌍ʙᴏᴛ ᴡᴇʙ:* *${pairlink}*`;

    // Sinhala greeting based on Sri Lanka time
    const nowSL = moment().tz('Asia/Colombo');
    const hourSL = nowSL.hour();
    let sinhalaGreeting;
    let greetingEmoji;
    if (hourSL >= 5 && hourSL < 12) {
      sinhalaGreeting = 'සුභ උදෑසනක් 🌄';
      greetingEmoji = '🌤️';
    } else if (hourSL >= 12 && hourSL < 17) {
      sinhalaGreeting = 'සුභ දහවලක් 🏞️';
      greetingEmoji = '🌞';
    } else if (hourSL >= 17 && hourSL < 21) {
      sinhalaGreeting = 'සුභ හැන්දෑවක් 🌅';
      greetingEmoji = '🌥️';
    } else {
      sinhalaGreeting = 'සුභ රාත්‍රියක් 🌌';
      greetingEmoji = '🌕';
    }

    // CPU Usage
    const cpuUsage = (() => {
      const cpus = os.cpus();
      let totalIdle = 0, totalTick = 0;
      cpus.forEach(cpu => {
        for (const type in cpu.times) totalTick += cpu.times[type];
        totalIdle += cpu.times.idle;
      });
      return (100 - (totalIdle / totalTick * 100)).toFixed(1) + '%';
    })();

    // Respond Speed (ping)
    const _pingStart = Date.now();
    await new Promise(r => setTimeout(r, 0));
    const respondSpeed = (Date.now() - _pingStart) + 'ms';

    // Time & Date (Sri Lanka)
    const menuTime = nowSL.format('hh:mm:ss A');
    const menuDate = nowSL.format('YYYY-MM-DD');

    // Day-based react emoji for DATE
    const dayEmojiMap = { 0: '☀️', 1: '🌙', 2: '🔥', 3: '💧', 4: '⚡', 5: '🌟', 6: '🎉' };
    const dateEmoji = dayEmojiMap[nowSL.day()] || '📆';

    // 📜 Menu Message Format
    const menuMessage = `👋 *${sinhalaGreeting}* *${pushname}* 

${menuHeaderLine}
*❒╮*
*├➣${greetingEmoji}ɢʀᴇᴇᴛɪɴɢ:* *${sinhalaGreeting}*
*├➣⏰𝚃𝙸𝙼𝙴:* *${menuTime}*
*├➣⚡𝙳𝙰𝚃𝙴:* *${menuDate}*
*├➣📟ᴜᴘᴛɪᴍᴇ:* *${uptimeStr}*
*├➣💾ʀᴀᴍ: ${ramUsed}MB / ${ramTotal}MB*
*├➣🖥️ᴄᴘᴜ ᴜꜱᴀɢᴇ:* *${cpuUsage}*
*├➣⚡ʀᴇꜱᴘᴏɴᴅ ꜱᴘᴇᴇᴅ:* *${respondSpeed}*
*├➣🤖ʙᴏᴛɴᴀᴍᴇ:* *${personalBotname}*
*├➣💻ᴘʟᴀᴛꜰᴏʀᴍ:* *ʟɪɴᴜx*
*├➣🧬ᴠᴇʀꜱɪᴏɴ:* *${version}*
*├➣🧑‍💻ᴏᴡɴᴇʀ:* *${ownername}*
*├➣🤝ᴘᴀʀᴛɴᴇʀ:* *© ʟᴏᴠᴇʟʏ ᴏꜰꜰɪᴄɪᴀʟ*
*├➣📞ᴏᴡɴᴇʀ ɴᴜᴍʙᴇʀ:* *${ownerNumbers}*
*❒╯*
*╰──────────────❍┈⊷❖◆►*

╭━━〔 📂 𝐒𝐄𝐋𝐄𝐂𝐓 𝐌𝐄𝐍𝐔 〕━━⬣

│ ❶ ➤ 📥 𝐃𝐨𝐰𝐧𝐥𝐨𝐚𝐝 𝐌𝐞𝐧𝐮
│ ❷ ➤ ✨ 𝐀𝐈 𝐌𝐞𝐧𝐮
│ ❸ ➤ 🔍 𝐒𝐞𝐚𝐫𝐜𝐡 𝐌𝐞𝐧𝐮
│ ❹ ➤ 📑 𝐎𝐭𝐡𝐞𝐫 𝐌𝐞𝐧𝐮
│ ❺ ➤ 🎨 𝐋𝐨𝐠𝐨 𝐌𝐞𝐧𝐮
│ ❻ ➤ 🎬 𝐌𝐨𝐯𝐢𝐞 𝐌𝐞𝐧𝐮
│ ❼ ➤ 🏠 𝐌𝐚𝐢𝐧 𝐌𝐞𝐧𝐮
│ ❽ ➤ 👨‍💻 𝐎𝐰𝐧𝐞𝐫 𝐌𝐞𝐧𝐮
│ ❾ ➤ 👥 𝐆𝐫𝐨𝐮𝐩 𝐌𝐞𝐧𝐮
│ ❿ ➤ 📰 𝐍𝐞𝐰𝐬 𝐌𝐞𝐧𝐮
│ ⓫ ➤ 🐱 𝐒𝐭𝐢𝐜𝐤𝐞𝐫 𝐌𝐞𝐧𝐮
│ ⓬ ➤ 🧑‍🔧 𝐒𝐞𝐭𝐭𝐢𝐧𝐠𝐬
│ ⓭ ➤ ⚡ 𝐏𝐢𝐧𝐠𝟐 𝐃𝐚𝐬𝐡𝐛𝐨𝐚𝐫𝐝
│ ⓮ ➤ 🎌 𝐀𝐧𝐢𝐦𝐞 𝐌𝐞𝐧𝐮
│ ⓯ ➤ 🔞 𝐍𝐒𝐅𝐖 𝐌𝐞𝐧𝐮

╰━━━━━━━━━━━━━━━⬣

${menuFooterLine}`;

    const sections = [
      {
        title: "𝙸𝚂𝙷𝙰𝙽-𝚇 𝙼𝙳 ᴠ.𝟽.𝟶.𝟶 𝙿𝚁𝙾 ᴍᴇɴᴜ ʟɪꜱᴛ 🙌",
        rows: [
          { title: "❄ ᴅᴏᴡɴʟᴏᴀᴅ ᴄᴍᴅ",      description: "𝙸𝚂𝙷𝙰𝙽-𝚇 𝙼𝙳 ᴠ.𝟽.𝟶.𝟶 𝙿𝚁𝙾 ᴅᴏᴡɴʟᴏᴀᴅ ᴍᴇɴᴜ 📥",      id: `${config.PREFIX}downloadmenu` },
          { title: "❄ ᴀɪ ᴄᴍᴅ",             description: "𝙸𝚂𝙷𝙰𝙽-𝚇 𝙼𝙳 ᴠ.𝟽.𝟶.𝟶 𝙿𝚁𝙾 ᴀɪ ᴍᴇɴᴜ ✨",             id: `${config.PREFIX}aimenu` },
          { title: "❄ ꜱᴇᴀʀᴄʜ ᴄᴍᴅ",         description: "𝙸𝚂𝙷𝙰𝙽-𝚇 𝙼𝙳 ᴠ.𝟽.𝟶.𝟶 𝙿𝚁𝙾 ꜱᴇᴀʀᴄʜ ᴍᴇɴᴜ 🔍",         id: `${config.PREFIX}searchmenu` },
          { title: "❄ ᴏᴛʜᴇʀ ᴄᴍᴅ",          description: "𝙸𝚂𝙷𝙰𝙽-𝚇 𝙼𝙳 ᴠ.𝟽.𝟶.𝟶 𝙿𝚁𝙾 ᴏᴛʜᴇʀ ᴍᴇɴᴜ 📑",          id: `${config.PREFIX}othermenu` },
          { title: "❄ ʟᴏɢᴏ ᴄᴍᴅ",           description: "𝙸𝚂𝙷𝙰𝙽-𝚇 𝙼𝙳 ᴠ.𝟽.𝟶.𝟶 𝙿𝚁𝙾 ʟᴏɢᴏ ᴍᴇɴᴜ 🎨",           id: `${config.PREFIX}logomenu` },
          { title: "❄ ᴍᴏᴠɪᴇ ᴄᴍᴅ",          description: "𝙸𝚂𝙷𝙰𝙽-𝚇 𝙼𝙳 ᴠ.𝟽.𝟶.𝟶 𝙿𝚁𝙾 ᴍᴏᴠɪᴇ ᴍᴇɴᴜ 🎥",           id: `${config.PREFIX}moviemenu` },
          { title: "❄ ᴀɴɪᴍᴇ ᴄᴍᴅ",          description: "𝙸𝚂𝙷𝙰𝙽-𝚇 𝙼𝙳 ᴠ.𝟽.𝟶.𝟶 𝙿𝚁𝙾 ᴀɴɪᴍᴇ ᴍᴇɴᴜ 🎌",           id: `${config.PREFIX}animemenu` },
          { title: "❄ ɴꜱꜰᴡ ᴄᴍᴅ",          description: "𝙸𝚂𝙷𝙰𝙽-𝚇 𝙼𝙳 ᴠ.𝟽.𝟶.𝟶 𝙿𝚁𝙾 ɴꜱꜰᴡ ᴍᴇɴᴜ 🔞",           id: `${config.PREFIX}nsfwmenu` }
        ]
      },
      {
        title: "𝙸𝚂𝙷𝙰𝙽-𝚇 𝙼𝙳 ᴠ.𝟽.𝟶.𝟶 𝙿𝚁𝙾 𝚂𝙴𝙲𝙾𝙽𝙳 ᴍᴇɴᴜ ʟɪꜱᴛ 🙌",
        rows: [
          { title: "❄ ᴍᴀɪɴ ᴄᴍᴅ",           description: "𝙸𝚂𝙷𝙰𝙽-𝚇 𝙼𝙳 ᴠ.𝟽.𝟶.𝟶 𝙿𝚁𝙾 ᴍᴀɪɴ ᴍᴇɴᴜ 🏡",           id: `${config.PREFIX}mainmenu` },
          { title: "❄ ᴏᴡɴᴇʀ ᴄᴍᴅ",          description: "𝙸𝚂𝙷𝙰𝙽-𝚇 𝙼𝙳 ᴠ.𝟽.𝟶.𝟶 𝙿𝚁𝙾 ᴏᴡɴᴇʀ ᴍᴇɴᴜ 🧑‍💻",        id: `${config.PREFIX}ownermenu` },
          { title: "❄ ɢʀᴏᴜᴘ ᴄᴍᴅ",          description: "𝙸𝚂𝙷𝙰𝙽-𝚇 𝙼𝙳 ᴠ.𝟽.𝟶.𝟶 𝙿𝚁𝙾 ɢʀᴏᴜᴘ ᴍᴇɴᴜ 💑",          id: `${config.PREFIX}groupmenu` },
          { title: "❄ ɴᴇᴡꜱ ᴄᴍᴅ",           description: "𝙸𝚂𝙷𝙰𝙽-𝚇 𝙼𝙳 ᴠ.𝟽.𝟶.𝟶 𝙿𝚁𝙾 ɴᴇᴡꜱ ᴍᴇɴᴜ 📰",           id: `${config.PREFIX}newsmenu` },
          { title: "❄ ꜱᴛɪᴄᴋᴇʀ ᴄᴍᴅ",         description: "𝙸𝚂𝙷𝙰𝙽-𝚇 𝙼𝙳 ᴠ.𝟽.𝟶.𝟶 𝙿𝚁𝙾 ꜱᴛɪᴄᴋᴇʀ ᴍᴇɴᴜ 🐱",        id: `${config.PREFIX}stickermenu` },
          { title: "❄ ꜱᴇᴛᴛɪɴɢꜱ ᴄᴍᴅ",        description: "𝙸𝚂𝙷𝙰𝙽-𝚇 𝙼𝙳 ᴠ.𝟽.𝟶.𝟶 𝙿𝚁𝙾 ʙᴏᴛ ꜱᴇᴛᴛɪɴɢꜱ 🧑‍🔧",        id: `${config.PREFIX}settings` },
          { title: "❄ ᴘɪɴɢ2 ᴄᴍᴅ",  description: "𝙸𝚂𝙷𝙰𝙽-𝚇 𝙼𝙳 ᴠ.𝟽.𝟶.𝟶 𝙿𝚁𝙾 ᴘɪɴɢ2 ɪᴍᴀɢᴇ ᴅᴀꜱʜʙᴏᴀʀᴅ ⚡",        id: `${config.PREFIX}ping2` }
        ]
      }
    ];

    const menuRows = [
    { label: '📥 Download Menu', id: `${config.PREFIX}downloadmenu` },
    { label: '✨ AI Menu', id: `${config.PREFIX}aimenu` },
    { label: '🔍 Search Menu', id: `${config.PREFIX}searchmenu` },
    { label: '📑 Other Menu', id: `${config.PREFIX}othermenu` },
    { label: '🎨 Logo Menu', id: `${config.PREFIX}logomenu` },
    { label: '🎥 Movie Menu', id: `${config.PREFIX}moviemenu` },
    { label: '🏡 Main Menu', id: `${config.PREFIX}mainmenu` },
    { label: '🧑‍💻 Owner Menu', id: `${config.PREFIX}ownermenu` },
    { label: '💑 Group Menu', id: `${config.PREFIX}groupmenu` },
    { label: '📰 News Menu', id: `${config.PREFIX}newsmenu` },
    { label: '🐱 Sticker Menu', id: `${config.PREFIX}stickermenu` },
    { label: '🧑‍🔧 Settings', id: `${config.PREFIX}settings` },
    { label: '⚡ Ping2 Dashboard', id: `${config.PREFIX}ping2` },
    { label: '🎌 Anime Menu', id: `${config.PREFIX}animemenu` },
    { label: '🔞 NSFW Menu', id: `${config.PREFIX}nsfwmenu` }
    ];
    setPendingRowSelect(sender, menuRows);

    // 🎬 Sending GIF output (or the Premium user's personal Menu image)
    const menuSendFooter = footer || config.BOT_FOOTER;
    // Premium personal menu image: botLogo → botImage → default GIF.
    const anyCustomMenuImg = hasCustomMenuImage(bc);
    if (anyCustomMenuImg) {
      await socket.sendMessage(sender, {
        image: { url: resolveBaseMenuImage(bc, null) },
        caption: menuMessage,
        footer: menuSendFooter,
        headerType: 4
      }, { quoted: msg });
    } else {
      await socket.sendMessage(sender, {
        video: { url: imageurl0 }, 
        gifPlayback: true,
        caption: menuMessage,
        footer: menuSendFooter,
        headerType: 4
      }, { quoted: msg });
    }

  } catch (e) {
    console.log("❌ Menu Error:", e);
    socket.sendMessage(sender, { text: `*🚩 Menu Error :-*\n${e.message}` }).catch(() => {});
  }
  break;
}


// ==================== MAIN MENU ====================
case 'mainmenu': {
  try {
    await socket.sendMessage(sender, { react: { text: "🏡", key: msg.key } });
    const ownerdata = (await axios.get("https://raw.githubusercontent.com/Dilu-x/OWNER_DATA/refs/heads/main/ownerdata")).data;
    const { footer, imageurl7, botname } = ownerdata;
    const bc = await resolveDisplayBotConfig(socket, nowsender);
    const premiumName = await resolveUserBotName(socket, nowsender, {}, botname);
    const premiumFooter = await resolveUserBotFooter(socket, nowsender, footer);
    const ramUsed = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2);
    const ut = process.uptime();
    const rtime = `${Math.floor(ut/3600)}h ${Math.floor((ut%3600)/60)}m ${Math.floor(ut%60)}s`;
    const menuc = `*_🥏 ${premiumName} Mᴀɪɴ Mᴇɴᴜ_*\n\n*╭──────────────◉◉➤*\n*├➣ ⏱️ \`𝗨𝗣 𝗧𝗜𝗠𝗘\` : -* ${rtime}\n*├➣ 💾 \`𝗥𝗔𝗠 𝗨𝘀𝗮𝗴𝗲\` : -* ${ramUsed} MB\n*╰──────────────◉◉➤*\n\n╭──────────●●►\n│ *ヤ Command :* alive\n│ *ヤ Use :* *Check bot online or no.* \n╰──────────●●►\n\n╭──────────●●►\n│ *ヤ Command :* ping\n│ *ヤ Use :* *Check bot's speed.* \n╰──────────●●►\n\n╭──────────●●►\n│ *ヤ Command :* ping2\n│ *ヤ Use :* *Check bot's speed (dashboard style).* \n╰──────────●●►\n\n╭──────────●●►\n│ *ヤ Command :* menu\n│ *ヤ Use :* *Get bot's command list.* \n╰──────────●●►\n\n╭──────────●●►\n│ *ヤ Command :* system\n│ *ヤ Use :* *Get bot's system information.* \n╰──────────●●►\n\n╭──────────●●►\n│ *ヤ Command :* pair\n│ *ヤ Use :* *Get bot session pairing code.* \n╰──────────●●►\n\n╭──────────●●►\n│ *ヤ Command :* pp\n│ *ヤ Use :* *Get user profile picture.* \n╰──────────●●►`;
    await socket.sendMessage(sender, { image: { url: resolveBaseMenuImage(bc, imageurl7) }, caption: brandMenuCaption(bc, menuc, { botname: premiumName, jid: nowsender }), footer: premiumFooter, headerType: 4 }, { quoted: msg });
  } catch(e) { socket.sendMessage(sender, { text: `*🚩 Menu Error :-*\n${e.message}` }).catch(() => {}); }
  break;
}

// ==================== DOWNLOAD SUB MENU ====================
case 'downloadmenu': {
  try {
    await socket.sendMessage(sender, { react: { text: "📥", key: msg.key } });
    const ownerdata = (await axios.get("https://raw.githubusercontent.com/Dilu-x/OWNER_DATA/refs/heads/main/ownerdata")).data;
    const { footer, imageurl1, botname } = ownerdata;
    const bc = await resolveDisplayBotConfig(socket, nowsender);
    const premiumName = await resolveUserBotName(socket, nowsender, {}, botname);
    const premiumFooter = await resolveUserBotFooter(socket, nowsender, footer);
    const ramUsed = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2);
    const ut = process.uptime();
    const rtime = `${Math.floor(ut/3600)}h ${Math.floor((ut%3600)/60)}m ${Math.floor(ut%60)}s`;
    const menuc = `*_🥏 ${premiumName} Dᴏᴡɴʟᴏᴀᴅ Mᴇɴᴜ_*\n\n*╭──────────────◉◉➤*\n*├➣ ⏱️ \`𝗨𝗣 𝗧𝗜𝗠𝗘\` : -* ${rtime}\n*├➣ 💾 \`𝗥𝗔𝗠 𝗨𝘀𝗮𝗴𝗲\` : -* ${ramUsed} MB\n*╰──────────────◉◉➤*\n\n╭──────────●●►\n│ *ヤ Command :* youtube / yt / mp4\n│ *ヤ Use :* *Download YouTube video.* \n╰──────────●●►\n\n╭──────────●●►\n│ *ヤ Command :* song / play / audio\n│ *ヤ Use :* *Download YouTube audio.* \n╰──────────●●►\n\n╭──────────●●►\n│ *ヤ Command :* spotify / spdl\n│ *ヤ Use :* *Download Spotify track (YouTube fallback).* \n╰──────────●●►\n\n╭──────────●●►\n│ *ヤ Command :* spotifyv2\n│ *ヤ Use :* *Search Spotify tracks & download (ikyyxd API).* \n╰──────────●●►\n\n╭──────────●●►\n│ *ヤ Command :* csong \n│ *ヤ Use :* *send songs to jid.* \n╰──────────●●►\n\n╭──────────●●►\n│ *ヤ Command :* facebook / fb\n│ *ヤ Use :* *Download Facebook video.* \n╰──────────●●►\n\n╭──────────●●►\n│ *ヤ Command :* tiktok / tt\n│ *ヤ Use :* *Download TikTok video.* \n╰──────────●●►\n\n╭──────────●●►\n│ *ヤ Command :* instagram / ig / insta\n│ *ヤ Use :* *Download Instagram media.* \n╰──────────●●►\n\n╭──────────●●►\n│ *ヤ Command :* mf / mediafire\n│ *ヤ Use :* *Download Mediafire file.* \n╰──────────●●►\n\n╭──────────●●►\n│ *ヤ Command :* gdrive\n│ *ヤ Use :* *Download Google Drive file.* \n╰──────────●●►\n\n╭──────────●●►\n│ *ヤ Command :* ringtone\n│ *ヤ Use :* *Search and download ringtones.* \n╰──────────●●►\n\n╭──────────●●►\n│ *ヤ Command :* twitter / twdl\n│ *ヤ Use :* *Download Twitter video.* \n╰──────────●●►\n\n╭──────────●●►\n│ *ヤ Command :* apk / apks\n│ *ヤ Use :* *Search & Download APK from Aptoide.* \n╰──────────●●►`;
    await socket.sendMessage(sender, { image: { url: resolveBaseMenuImage(bc, imageurl1) }, caption: brandMenuCaption(bc, menuc, { botname: premiumName, jid: nowsender }), footer: premiumFooter, headerType: 4 }, { quoted: msg });
  } catch(e) { socket.sendMessage(sender, { text: `*🚩 Menu Error :-*\n${e.message}` }).catch(() => {}); }
  break;
}

// ==================== AI SUB MENU ====================
case 'aimenu': {
  try {
    await socket.sendMessage(sender, { react: { text: "✨", key: msg.key } });
    const ownerdata = (await axios.get("https://raw.githubusercontent.com/Dilu-x/OWNER_DATA/refs/heads/main/ownerdata")).data;
    const { footer, imageurl2, botname } = ownerdata;
    const bc = await resolveDisplayBotConfig(socket, nowsender);
    const premiumName = await resolveUserBotName(socket, nowsender, {}, botname);
    const premiumFooter = await resolveUserBotFooter(socket, nowsender, footer);
    const ramUsed = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2);
    const ut = process.uptime();
    const rtime = `${Math.floor(ut/3600)}h ${Math.floor((ut%3600)/60)}m ${Math.floor(ut%60)}s`;
    const menuc = `*_🥏 ${premiumName} Aɪ Mᴇɴᴜ_*\n\n*╭──────────────◉◉➤*\n*├➣ ⏱️ \`𝗨𝗣 𝗧𝗜𝗠𝗘\` : -* ${rtime}\n*├➣ 💾 \`𝗥𝗔𝗠 𝗨𝘀𝗮𝗴𝗲\` : -* ${ramUsed} MB\n*╰──────────────◉◉➤*\n\n╭──────────●●►\n│ *ヤ Command :* ai / chat / gpt\n│ *ヤ Use :* *Chat with AI assistant.* \n╰──────────●●►\n\n╭──────────●●►\n│ *ヤ Command :* aiimg / aiimg2\n│ *ヤ Use :* *Generate AI image from text.* \n╰──────────●●►\n\n╭──────────●●►\n│ *ヤ Command :* grokvideo / gv\n│ *ヤ Use :* *Generate AI video from text.* \n╰──────────●●►\n\n╭──────────●●►\n│ *ヤ Command :* geminiedit / gedit\n│ *ヤ Use :* *Edit an image with Gemini Flash.* \n╰──────────●●►\n\n╭──────────●●►\n│ *ヤ Command :* faceswap / fswap\n│ *ヤ Use :* *Swap faces between two images.* \n╰──────────●●►\n\n╭──────────●●►\n│ *ヤ Command :* removeclothes / removeclothesv2\n│ *ヤ Use :* *NSFW image manipulation (18+ only).* \n╰──────────●●►\n\n╭──────────●●►\n│ *ヤ Command :* gpt4 / chatgpt\n│ *ヤ Use :* *Ask GPT-4 AI.* \n╰──────────●●►\n\n╭──────────●●►\n│ *ヤ Command :* deepseek / ds\n│ *ヤ Use :* *Ask DeepSeek AI.* \n╰──────────●●►\n\n╭──────────●●►\n│ *ヤ Command :* copilot / mscopilot\n│ *ヤ Use :* *Ask Microsoft Copilot.* \n╰──────────●●►\n\n╭──────────●●►\n│ *ヤ Command :* bard / googlebard / gemini\n│ *ヤ Use :* *Ask Google Bard (Gemini).* \n╰──────────●●►\n\n╭──────────●●►\n│ *ヤ Command :* perplexity / perplex / pplx\n│ *ヤ Use :* *Ask Perplexity AI.* \n╰──────────●●►\n\n╭──────────●●►\n│ *ヤ Command :* blackbox / bb / bbox\n│ *ヤ Use :* *Ask Blackbox AI.* \n╰──────────●●►\n\n╭──────────●●►\n│ *ヤ Command :* metaai / meta / llama\n│ *ヤ Use :* *Ask Meta AI (Llama).* \n╰──────────●●►\n\n╭──────────●●►\n│ *ヤ Command :* metai / metav2\n│ *ヤ Use :* *Ask Meta AI v2.* \n╰──────────●●►\n\n╭──────────●●►\n│ *ヤ Command :* ilama / llama2\n│ *ヤ Use :* *Ask iLama AI.* \n╰──────────●●►\n\n╭──────────●●►\n│ *ヤ Command :* mistral / mist\n│ *ヤ Use :* *Ask Mistral AI.* \n╰──────────●●►\n\n╭──────────●●►\n│ *ヤ Command :* grok / xai\n│ *ヤ Use :* *Ask Grok AI (xAI).* \n╰──────────●●►\n\n╭──────────●●►\n│ *ヤ Command :* speechwriter / speech / writer\n│ *ヤ Use :* *Generate a speech.* \n╰──────────●●►\n\n╭──────────●●►\n│ *ヤ Command :* removebg / rmbg / nobg\n│ *ヤ Use :* *Remove image background.* \n╰──────────●●►\n\n╭──────────●●►\n│ *ヤ Command :* nanoedit / nano / editimg\n│ *ヤ Use :* *AI image editing (reply to image + prompt).* \n╰──────────●●►\n\n╭──────────●●►\n│ *ヤ Command :* nanobanana / nanobananav5 / editing\n│ *ヤ Use :* *AI image editing with model selection.* \n╰──────────●●►`;
    await socket.sendMessage(sender, { image: { url: resolveBaseMenuImage(bc, imageurl2) }, caption: brandMenuCaption(bc, menuc, { botname: premiumName, jid: nowsender }), footer: premiumFooter, headerType: 4 }, { quoted: msg });
  } catch(e) { socket.sendMessage(sender, { text: `*🚩 Menu Error :-*\n${e.message}` }).catch(() => {}); }
  break;
}

// ==================== SEARCH SUB MENU ====================
case 'searchmenu': {
  try {
    await socket.sendMessage(sender, { react: { text: "🔍", key: msg.key } });
    const ownerdata = (await axios.get("https://raw.githubusercontent.com/Dilu-x/OWNER_DATA/refs/heads/main/ownerdata")).data;
    const { footer, imageurl3, botname } = ownerdata;
    const bc = await resolveDisplayBotConfig(socket, nowsender);
    const premiumName = await resolveUserBotName(socket, nowsender, {}, botname);
    const premiumFooter = await resolveUserBotFooter(socket, nowsender, footer);
    const ramUsed = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2);
    const ut = process.uptime();
    const rtime = `${Math.floor(ut/3600)}h ${Math.floor((ut%3600)/60)}m ${Math.floor(ut%60)}s`;
    const menuc = `*_🥏 ${premiumName} Sᴇᴀʀᴄʜ Mᴇɴᴜ_*\n\n*╭──────────────◉◉➤*\n*├➣ ⏱️ \`𝗨𝗣 𝗧𝗜𝗠𝗘\` : -* ${rtime}\n*├➣ 💾 \`𝗥𝗔𝗠 𝗨𝘀𝗮𝗴𝗲\` : -* ${ramUsed} MB\n*╰──────────────◉◉➤*\n\n╭──────────●●►\n│ *ヤ Command :* google / search\n│ *ヤ Use :* *Search on Google.* \n╰──────────●●►\n\n╭──────────●●►\n│ *ヤ Command :* img\n│ *ヤ Use :* *Search and get images.* \n╰──────────●●►\n\n╭──────────●●►\n│ *ヤ Command :* apksearch / apks\n│ *ヤ Use :* *Search and download APK files.* \n╰──────────●●►\n\n╭──────────●●►\n│ *ヤ Command :* yts / youtubesearch\n│ *ヤ Use :* *Search YouTube videos & get results.* \n│ *ヤ Example :* .yts Alan Walker\n╰──────────●●►`;
    await socket.sendMessage(sender, { image: { url: resolveBaseMenuImage(bc, imageurl3) }, caption: brandMenuCaption(bc, menuc, { botname: premiumName, jid: nowsender }), footer: premiumFooter, headerType: 4 }, { quoted: msg });
  } catch(e) { socket.sendMessage(sender, { text: `*🚩 Menu Error :-*\n${e.message}` }).catch(() => {}); }
  break;
}

// ==================== OWNER SUB MENU ====================
case 'ownermenu': {
  try {
    await socket.sendMessage(sender, { react: { text: "🧑‍💻", key: msg.key } });
    const ownerdata = (await axios.get("https://raw.githubusercontent.com/Dilu-x/OWNER_DATA/refs/heads/main/ownerdata")).data;
    const { footer, imageurl8, botname } = ownerdata;
    const bc = await resolveDisplayBotConfig(socket, nowsender);
    const premiumName = await resolveUserBotName(socket, nowsender, {}, botname);
    const premiumFooter = await resolveUserBotFooter(socket, nowsender, footer);
    const ramUsed = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2);
    const ut = process.uptime();
    const rtime = `${Math.floor(ut/3600)}h ${Math.floor((ut%3600)/60)}m ${Math.floor(ut%60)}s`;
    const menuc = `*_🥏 ${premiumName} Oᴡɴᴇʀ Mᴇɴᴜ_*\n\n*╭──────────────◉◉➤*\n*├➣ ⏱️ \`𝗨𝗣 𝗧𝗜𝗠𝗘\` : -* ${rtime}\n*├➣ 💾 \`𝗥𝗔𝗠 𝗨𝘀𝗮𝗴𝗲\` : -* ${ramUsed} MB\n*╰──────────────◉◉➤*\n\n╭──────────●●►\n│ *ヤ Command :* help\n│ *ヤ Use :* *Open bot help center.* \n╰──────────●●►\n\n╭──────────●●►\n│ *ヤ Command :* setting\n│ *ヤ Use :* *Open bot settings panel.* \n╰──────────●●►\n\n╭──────────●●►\n│ *ヤ Command :* wtype\n│ *ヤ Use :* *Change bot work type.* \n╰──────────●●►\n\n╭──────────●●►\n│ *ヤ Command :* prefix\n│ *ヤ Use :* *Change bot command prefix.* \n╰──────────●●►\n\n╭──────────●●►\n│ *ヤ Command :* setbotname\n│ *ヤ Use :* *Change bot display name.* \n╰──────────●●►\n\n╭──────────●●►\n│ *ヤ Command :* setlogo\n│ *ヤ Use :* *Set bot profile picture.* \n╰──────────●●►\n\n╭──────────●●►\n│ *ヤ Command :* botpresence\n│ *ヤ Use :* *Toggle bot online presence.* \n╰──────────●●►\n\n╭──────────●●►\n│ *ヤ Command :* autotyping\n│ *ヤ Use :* *Toggle fake typing animation.* \n╰──────────●●►\n\n╭──────────●●►\n│ *ヤ Command :* rstatus\n│ *ヤ Use :* *Toggle auto read status.* \n╰──────────●●►\n\n╭──────────●●►\n│ *ヤ Command :* arm\n│ *ヤ Use :* *Toggle auto reply mode.* \n╰──────────●●►\n\n╭──────────●●►\n│ *ヤ Command :* sts\n│ *ヤ Use :* *Save a replied status to this chat.* \n╰──────────●●►\n\n╭──────────●●►\n│ *ヤ Command :* getpp\n│ *ヤ Use :* *Get any user's profile picture.* \n╰──────────●●►\n\n╭──────────●●►\n│ *ヤ Command :* verify18\n│ *ヤ Use :* *Verify a user for 18+ (NSFW) content.* \n╰──────────●●►\n\n╭──────────●●►\n│ *ヤ Command :* unverify18\n│ *ヤ Use :* *Remove a user's 18+ (NSFW) verification.* \n╰──────────●●►`;
    await socket.sendMessage(sender, { image: { url: resolveBaseMenuImage(bc, imageurl8) }, caption: brandMenuCaption(bc, menuc, { botname: premiumName, jid: nowsender }), footer: premiumFooter, headerType: 4 }, { quoted: msg });
  } catch(e) { socket.sendMessage(sender, { text: `*🚩 Menu Error :-*\n${e.message}` }).catch(() => {}); }
  break;
}

// ==================== GROUP SUB MENU ====================
case 'groupmenu': {
  try {
    await socket.sendMessage(sender, { react: { text: "💑", key: msg.key } });
    const ownerdata = (await axios.get("https://raw.githubusercontent.com/Dilu-x/OWNER_DATA/refs/heads/main/ownerdata")).data;
    const { footer, imageurl9, botname } = ownerdata;
    const bc = await resolveDisplayBotConfig(socket, nowsender);
    const premiumName = await resolveUserBotName(socket, nowsender, {}, botname);
    const premiumFooter = await resolveUserBotFooter(socket, nowsender, footer);
    const ramUsed = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2);
    const ut = process.uptime();
    const rtime = `${Math.floor(ut/3600)}h ${Math.floor((ut%3600)/60)}m ${Math.floor(ut%60)}s`;
    const menuc = `*_🥏 ${premiumName} Gʀᴏᴜᴘ Mᴇɴᴜ_*\n\n*╭──────────────◉◉➤*\n*├➣ ⏱️ \`𝗨𝗣 𝗧𝗜𝗠𝗘\` : -* ${rtime}\n*├➣ 💾 \`𝗥𝗔𝗠 𝗨𝘀𝗮𝗴𝗲\` : -* ${ramUsed} MB\n*╰──────────────◉◉➤*\n\n╭──────────●●►\n│ *ヤ Command :* tagall\n│ *ヤ Use :* *Tag all group members.* \n╰──────────●●►\n\n╭──────────●●►\n│ *ヤ Command :* addadmin\n│ *ヤ Use :* *Promote member to admin.* \n╰──────────●●►\n\n╭──────────●●►\n│ *ヤ Command :* deladmin\n│ *ヤ Use :* *Demote admin to member.* \n╰──────────●●►\n\n╭──────────●●►\n│ *ヤ Command :* admins\n│ *ヤ Use :* *List all group admins.* \n╰──────────●●►\n\n╭──────────●●►\n│ *ヤ Command :* block\n│ *ヤ Use :* *Block a member.* \n╰──────────●●►\n\n╭──────────●●►\n│ *ヤ Command :* unblock\n│ *ヤ Use :* *Unblock a member.* \n╰──────────●●►\n\n╭──────────●●►\n│ *ヤ Command :* online\n│ *ヤ Use :* *Check who is online in group.* \n╰──────────●●►\n\n╭──────────●●►\n│ *ヤ Command :* welcome on/off\n│ *ヤ Use :* *Enable/disable group welcome messages.* \n╰──────────●●►\n\n╭──────────●●►\n│ *ヤ Command :* goodbye on/off\n│ *ヤ Use :* *Enable/disable group goodbye messages.* \n╰──────────●●►\n\n╭──────────●●►\n│ *ヤ Command :* welcome status\n│ *ヤ Use :* *Check welcome/goodbye status in this group.* \n╰──────────●●►\n\n╭──────────●●►\n│ *ヤ Command :* antilink on/off/exempt\n│ *ヤ Use :* *Anti-link: on/off for you, exempt @user for members.* \n╰──────────●●►`;
    await socket.sendMessage(sender, { image: { url: resolveBaseMenuImage(bc, imageurl9) }, caption: brandMenuCaption(bc, menuc, { botname: premiumName, jid: nowsender }), footer: premiumFooter, headerType: 4 }, { quoted: msg });
  } catch(e) { socket.sendMessage(sender, { text: `*🚩 Menu Error :-*\n${e.message}` }).catch(() => {}); }
  break;
}

// ==================== OTHER SUB MENU ====================
case 'othermenu': {
  try {
    await socket.sendMessage(sender, { react: { text: "📑", key: msg.key } });
    const ownerdata = (await axios.get("https://raw.githubusercontent.com/Dilu-x/OWNER_DATA/refs/heads/main/ownerdata")).data;
    const { footer, imageurl4, botname } = ownerdata;
    const bc = await resolveDisplayBotConfig(socket, nowsender);
    const premiumName = await resolveUserBotName(socket, nowsender, {}, botname);
    const premiumFooter = await resolveUserBotFooter(socket, nowsender, footer);
    const ramUsed = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2);
    const ut = process.uptime();
    const rtime = `${Math.floor(ut/3600)}h ${Math.floor((ut%3600)/60)}m ${Math.floor(ut%60)}s`;
    const menuc = `*_🥏 ${premiumName} Oᴛʜᴇʀ Mᴇɴᴜ_*\n\n*╭──────────────◉◉➤*\n*├➣ ⏱️ \`𝗨𝗣 𝗧𝗜𝗠𝗘\` : -* ${rtime}\n*├➣ 💾 \`𝗥𝗔𝗠 𝗨𝘀𝗮𝗴𝗲\` : -* ${ramUsed} MB\n*╰──────────────◉◉➤*\n\n╭──────────●●►\n│ *ヤ Command :* tourl / upload\n│ *ヤ Use :* *Upload image and get URL.* \n╰──────────●●►\n\n╭──────────●●►\n│ *ヤ Command :* vv / save\n│ *ヤ Use :* *Save view once media.* \n╰──────────●●►\n\n╭──────────●●►\n│ *ヤ Command :* emojis\n│ *ヤ Use :* *Get emoji sticker pack.* \n╰──────────●●►\n\n╭──────────●●►\n│ *ヤ Command :* font\n│ *ヤ Use :* *Convert text to fancy font.* \n╰──────────●●►\n\n╭──────────●●►\n│ *ヤ Command :* savecontact\n│ *ヤ Use :* *Save contact as VCF file.* \n╰──────────●●►\n\n╭──────────●●►\n│ *ヤ Command :* cfn\n│ *ヤ Use :* *Generate fake WhatsApp number.* \n╰──────────●●►\n\n╭──────────●●►\n│ *ヤ Command :* jid\n│ *ヤ Use :* *Get user WhatsApp JID.* \n╰──────────●●►\n\n╭──────────●●►\n│ *ヤ Command :* gjid\n│ *ヤ Use :* *Get group JID.* \n╰──────────●●►`;
    await socket.sendMessage(sender, { image: { url: resolveBaseMenuImage(bc, imageurl4) }, caption: brandMenuCaption(bc, menuc, { botname: premiumName, jid: nowsender }), footer: premiumFooter, headerType: 4 }, { quoted: msg });
  } catch(e) { socket.sendMessage(sender, { text: `*🚩 Menu Error :-*\n${e.message}` }).catch(() => {}); }
  break;
}

// ==================== LOGO SUB MENU ====================
case 'logomenu': {
  try {
    await socket.sendMessage(sender, { react: { text: "🎨", key: msg.key } });
    const ownerdata = (await axios.get("https://raw.githubusercontent.com/Dilu-x/OWNER_DATA/refs/heads/main/ownerdata")).data;
    const { footer, imageurl5, botname } = ownerdata;
    const bc = await resolveDisplayBotConfig(socket, nowsender);
    const premiumName = await resolveUserBotName(socket, nowsender, {}, botname);
    const premiumFooter = await resolveUserBotFooter(socket, nowsender, footer);
    const ramUsed = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2);
    const ut = process.uptime();
    const rtime = `${Math.floor(ut/3600)}h ${Math.floor((ut%3600)/60)}m ${Math.floor(ut%60)}s`;
    const menuc = `*_🥏 ${premiumName} ʟᴏɢᴏ Mᴇɴᴜ_*\n\n*╭──────────────◉◉➤*\n*├➣ ⏱️ \`𝗨𝗣 𝗧𝗜𝗠𝗘\` : -* ${rtime}\n*├➣ 💾 \`𝗥𝗔𝗠 𝗨𝘀𝗮𝗴𝗲\` : -* ${ramUsed} MB\n*╰──────────────◉◉➤*\n\n*🎌 Anime & Movies*\n╭──────────●●►\n│ *ヤ .naruto* ➣ Naruto Shippuden style\n│ *ヤ .dragonball* ➣ Dragon Ball style\n│ *ヤ .onepiece* ➣ One Piece logo style\n│ *ヤ .marvel* ➣ Marvel logo style\n│ *ヤ .deadpool* ➣ Deadpool logo style\n│ *ヤ .harrypotter* ➣ Harry Potter style\n╰──────────●●►\n\n*✨ Glow & Effects*\n╭──────────●●►\n│ *ヤ .neon* ➣ 3D Neon sign board\n│ *ヤ .glitch* ➣ Glitch text effect\n│ *ヤ .rainbow* ➣ Rainbow text effect\n│ *ヤ .glass* ➣ Transparent glass\n│ *ヤ .frostedGlass* ➣ Frosted glass\n│ *ヤ .neonGlass* ➣ 3D Neon glass\n╰──────────●●►\n\n*💰 Metal & Luxury*\n╭──────────●●►\n│ *ヤ .gold* ➣ Golden metal\n│ *ヤ .silver* ➣ Silver metal\n│ *ヤ .diamond* ➣ Diamond effect\n│ *ヤ .luxury* ➣ Luxury gold\n│ *ヤ .modern* ➣ Modern metallic\n╰──────────●●►\n\n*🌿 Nature & Elements*\n╭──────────●●►\n│ *ヤ .fire* ➣ Burning fire\n│ *ヤ .water* ➣ Underwater\n│ *ヤ .smoke* ➣ Smoky text\n│ *ヤ .ice* ➣ Frozen ice\n│ *ヤ .crystal* ➣ Shiny crystal\n│ *ヤ .sand* ➣ Beach sand\n│ *ヤ .sky* ➣ Cloud sky\n│ *ヤ .space* ➣ Galaxy text\n╰──────────●●►\n\n*🎄 Holidays & Art*\n╭──────────●●►\n│ *ヤ .christmas* ➣ Christmas style\n│ *ヤ .halloween* ➣ Halloween pumpkin\n│ *ヤ .3dcomic* ➣ 3D Comic style\n│ *ヤ .graffiti* ➣ Graffiti text\n│ *ヤ .blackpink* ➣ Blackpink style\n╰──────────●●►\n\n*📝 Usage:* .[effect] [text]\n*📌 Example:* .naruto Uzumaki\n*🎲 Random:* .logo random [text]\n*🔄 Batch:* .logo batch naruto,neon,gold [text]`;
    await socket.sendMessage(sender, { image: { url: resolveBaseMenuImage(bc, imageurl5) }, caption: brandMenuCaption(bc, menuc, { botname: premiumName, jid: nowsender }), footer: premiumFooter, headerType: 4 }, { quoted: msg });
  } catch(e) { socket.sendMessage(sender, { text: `*🚩 Menu Error :-*\n${e.message}` }).catch(() => {}); }
  break;
}

// ==================== NEWS SUB MENU ====================
case 'newsmenu': {
  try {
    await socket.sendMessage(sender, { react: { text: "📰", key: msg.key } });
    const ownerdata = (await axios.get("https://raw.githubusercontent.com/Dilu-x/OWNER_DATA/refs/heads/main/ownerdata")).data;
    const { footer, imageurl10, botname } = ownerdata;
    const bc = await resolveDisplayBotConfig(socket, nowsender);
    const premiumName = await resolveUserBotName(socket, nowsender, {}, botname);
    const premiumFooter = await resolveUserBotFooter(socket, nowsender, footer);
    const ramUsed = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2);
    const ut = process.uptime();
    const rtime = `${Math.floor(ut/3600)}h ${Math.floor((ut%3600)/60)}m ${Math.floor(ut%60)}s`;
    const menuc = `*_🥏 ${premiumName} Nᴇᴡꜱ Mᴇɴᴜ_*\n\n*╭──────────────◉◉➤*\n*├➣ ⏱️ \`𝗨𝗣 𝗧𝗜𝗠𝗘\` : -* ${rtime}\n*├➣ 💾 \`𝗥𝗔𝗠 𝗨𝘀𝗮𝗴𝗲\` : -* ${ramUsed} MB\n*╰──────────────◉◉➤*\n\n╭──────────●●►\n│ *ヤ Command :* adanews\n│ *ヤ Use :* *Get latest Ada Derana news.* \n╰──────────●●►\n\n╭──────────●●►\n│ *ヤ Command :* sirasanews\n│ *ヤ Use :* *Get latest Sirasa news.* \n╰──────────●●►\n\n╭──────────●●►\n│ *ヤ Command :* lankadeepanews\n│ *ヤ Use :* *Get latest Lankadeepa news.* \n╰──────────●●►\n\n╭──────────●●►\n│ *ヤ Command :* gagananews\n│ *ヤ Use :* *Get latest Gagana news.* \n╰──────────●●►\n\n╭──────────●●►\n│ *ヤ Command :* newslist\n│ *ヤ Use :* *List all available news sources.* \n╰──────────●●►`;
    await socket.sendMessage(sender, { image: { url: resolveBaseMenuImage(bc, imageurl10) }, caption: brandMenuCaption(bc, menuc, { botname: premiumName, jid: nowsender }), footer: premiumFooter, headerType: 4 }, { quoted: msg });
  } catch(e) { socket.sendMessage(sender, { text: `*🚩 Menu Error :-*\n${e.message}` }).catch(() => {}); }
  break;
}

// ==================== STICKER SUB MENU ====================
case 'stickermenu': {
  try {
    await socket.sendMessage(sender, { react: { text: "🐱", key: msg.key } });
    const ownerdata = (await axios.get("https://raw.githubusercontent.com/Dilu-x/OWNER_DATA/refs/heads/main/ownerdata")).data;
    const { footer, imageurl11, botname } = ownerdata;
    const bc = await resolveDisplayBotConfig(socket, nowsender);
    const premiumName = await resolveUserBotName(socket, nowsender, {}, botname);
    const premiumFooter = await resolveUserBotFooter(socket, nowsender, footer);
    const ramUsed = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2);
    const ut = process.uptime();
    const rtime = `${Math.floor(ut/3600)}h ${Math.floor((ut%3600)/60)}m ${Math.floor(ut%60)}s`;
    const menuc = `*_🐱 ${premiumName} Sᴛɪᴄᴋᴇʀ Mᴇɴᴜ_*\n\n*╭──────────────◉◉➤*\n*├➣ ⏱️ \`𝗨𝗣 𝗧𝗜𝗠𝗘\` : -* ${rtime}\n*├➣ 💾 \`𝗥𝗔𝗠 𝗨𝘀𝗮𝗴𝗲\` : -* ${ramUsed} MB\n*╰──────────────◉◉➤*\n\n╭──────────●●►\n│ *ヤ Command :* attp\n│ *ヤ Use :* *Create an animated text sticker.* \n╰──────────●●►\n\n*📝 Usage:* ${config.PREFIX}attp <text>\n*📌 Example:* ${config.PREFIX}attp Hello`;
    await socket.sendMessage(sender, { image: { url: resolveBaseMenuImage(bc, imageurl11) }, caption: brandMenuCaption(bc, menuc, { botname: premiumName, jid: nowsender }), footer: premiumFooter, headerType: 4 }, { quoted: msg });
  } catch(e) { socket.sendMessage(sender, { text: `*🚩 Menu Error :-*\n${e.message}` }).catch(() => {}); }
  break;
}

// ==================== ATTP (TEXT STICKER) COMMAND ====================
case 'attp':
case 'attptext':
case 'textsticker':
case 'namesticker':
case 'stickername':
case 'at':
case 'att':
case 'atp': {
  try {
    const ffmpeg = require('fluent-ffmpeg');
    const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
    ffmpeg.setFfmpegPath(ffmpegInstaller.path);

    const text = args.join(' ').trim();
    if (!text) {
      return await socket.sendMessage(sender, {
        text: "*🥺 YOU WANT TO CREATE A STICKER WITH YOUR NAME*\n\n" +
              `*Use:* \`${config.PREFIX}attp YOUR NAME\`\n\n` +
              `*Example:*\n${config.PREFIX}attp ISHAN`
      }, { quoted: msg });
    }

    await socket.sendMessage(sender, { react: { text: "✨", key: msg.key } });
    await socket.sendMessage(sender, { text: "*✨ ✨ YOUR STICKER IS BEING CREATED*\n*PLEASE WAIT A MOMENT...☺️*" }, { quoted: msg });

    const encodedText = encodeURIComponent(text);
    const gifRes = await axios.get(`https://api-fix.onrender.com/api/maker/attp?text=${encodedText}`, { responseType: 'arraybuffer' });
    const gifBuffer = Buffer.from(gifRes.data);

    const gifFile = path.join(os.tmpdir(), `attp_${Date.now()}.gif`);
    const webpFile = path.join(os.tmpdir(), `attp_${Date.now()}.webp`);
    fs.writeFileSync(gifFile, gifBuffer);

    await new Promise((resolve, reject) => {
      ffmpeg(gifFile)
        .on('error', reject)
        .on('end', () => resolve(true))
        .addOutputOptions([
          "-vcodec", "libwebp",
          "-vf", "scale='min(320,iw)':min'(320,ih)':force_original_aspect_ratio=decrease,fps=15,pad=320:320:-1:-1:color=white@0.0,split [a][b];[a] palettegen=reserve_transparent=on:transparency_color=ffffff [p];[b][p] paletteuse",
          "-loop", "0",
          "-preset", "default",
          "-an",
          "-vsync", "0"
        ])
        .toFormat('webp')
        .save(webpFile);
    });

    const stickerBuffer = fs.readFileSync(webpFile);
    await socket.sendMessage(sender, { sticker: stickerBuffer }, { quoted: msg });

    if (fs.existsSync(gifFile)) fs.unlinkSync(gifFile);
    if (fs.existsSync(webpFile)) fs.unlinkSync(webpFile);

  } catch (e) {
    console.error("ATTP ERROR:", e);
    await socket.sendMessage(sender, { text: "*❌ STICKER BANANE ME ERROR AYA 🥺*" }, { quoted: msg });
  }
  break;
}

// ==================== MOVIE SUB MENU ====================
case 'moviemenu': {
  try {
    await socket.sendMessage(sender, { react: { text: "🎞️", key: msg.key } });
    
    const ownerdata = (await axios.get("https://raw.githubusercontent.com/Dilu-x/OWNER_DATA/refs/heads/main/ownerdata")).data;
    const { footer, imageurl6, botname } = ownerdata;
    const bc = await resolveDisplayBotConfig(socket, nowsender);
    const premiumName = await resolveUserBotName(socket, nowsender, {}, botname);
    const premiumFooter = await resolveUserBotFooter(socket, nowsender, footer);
    
    const ramUsed = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2);
    const ut = process.uptime();
    const rtime = `${Math.floor(ut/3600)}h ${Math.floor((ut%3600)/60)}m ${Math.floor(ut%60)}s`;
    
    const menuc = `╭━〔 🎬 𝐈𝐒𝐇𝐀𝐍-𝐗 𝐌𝐃 • 𝐌𝐎𝐕𝐈𝐄 𝐌𝐄𝐍𝐔 〕━━⬣

│ 🤖 \`𝐁𝐨𝐭\`       : ${premiumName}
│ ⏱️ \`𝐔𝐩𝐭𝐢𝐦𝐞\`   : ${rtime}
│ 💾 \`𝐑𝐀𝐌\`     : ${ramUsed} MB

╰━━━━━━━━━━━━━━━━⬣

🎥 *𝐌𝐎𝐕𝐈𝐄 𝐂𝐎𝐌𝐌𝐀𝐍𝐃𝐒*

❶ \`.movie <movie name>\`
❷ \`.mv <movie name>\`
❸ \`.films <movie name>\`
❹ \`.film <movie name>\`
❺ \`.sinhalasub <movie name>\`
❻ \`.cinesub <movie name>\`
❼ \`.cinesubz <movie name>\`
❽ \`.cinetv <movie / tv series>\`
❾ \`.tv <tv series>\`
❿ \`.cinefr <jid> <movie name>\`
⓫ \`.mvfr <jid> <movie name>\`
⓬ \`.anime <anime name>\`
⓭ \`.animeheaven <anime name>\`
⓮ \`.moviebox <movie / tv series>\`
⓯ \`.boxhub <movie / tv series>\` — 📥 Downloads & TV episodes
⓰ \`.pupilvideo <movie name>\`
⓱ \`.bestmovies <movie / tv series>\`
⓲ \`.moviesublk <movie / tv series>\`
⓳ \`.lk <movie / tv series>\`
⓴ \`.cinetvfr <jid> <tv series>\`
㉑ \`.cinefrfooter / .cinetvfrfooter <text>\`

╭━〔 📖 𝐇𝐎𝐖 𝐓𝐎 𝐔𝐒𝐄 〕━━⬣

│ ① Search a Movie / TV Series
│ ② Reply with the Movie Number
│ ③ Select the Quality / Episode
│ ④ Download starts automatically
│ ⑤ File will be sent as Document

╰━━━━━━━━━━━━━━━⬣

🎬 *𝐄𝐗𝐀𝐌𝐏𝐋𝐄𝐒*

│ 🔹 .movie Avengers Endgame
│ 🔹 .mv Spider Man
│ 🔹 .films Thor Love and Thunder
│ 🔹 .film Avatar
│ 🔹 .sinhalasub John Wick
│ 🔹 .cinesub Interstellar
│ 🔹 .cinesubz Fast X
│ 🔹 .cinetv Stranger Things
│ 🔹 .tv Squid Game
│ 🔹 .anime Jujutsu Kaisen
│ 🔹 .animeheaven One Piece
│ 🔹 .moviebox Avatar
│ 🔹 .boxhub Avatar
│ 🔹 .boxhub tv Breaking Bad
│ 🔹 .pupilvideo Spider Man
│ 🔹 .bestmovies Toy Story
│ 🔹 .moviesublk Spider Man
│ 🔹 .cinetvfr 120999@g.us Stranger Things
│ 🔹 .cinefrfooter ISHAN-X PRO

╭━〔 ✨ 𝐅𝐄𝐀𝐓𝐔𝐑𝐄𝐒 〕━⬣

│ 🎬 Movie Search
│ 📺 TV Series Support
│ 🎌 Anime Search & Episodes
│ 📥 Direct Download
│ 🎞️ Multi Quality
│ 📄 Document Mode
│ 👤 Custom Footer (cinefr / cinetvfr)
│ ⚡ Fast Servers
│ 🌍 SinhalaSub Support
│ 💎 Premium Interface

╰━━━━━━━━━━━⬣

╭━〔 ℹ️ 𝐈𝐍𝐅𝐎 〕━━⬣

│ 📦 𝐌𝐚𝐱 𝐅𝐢𝐥𝐞   : ${movieMaxSizeLabel()}
│ 🌐 𝐒𝐨𝐮𝐫𝐜𝐞     : Shyra.indevs
│ 🚀 𝐄𝐧𝐠𝐢𝐧𝐞     : Cines × SinhalaAub
│ 🔥 𝐕𝐞𝐫𝐬𝐢𝐨𝐧    : Premium

╰━━━━━━━━━━━━━━━⬣

> _*𝐃𝙴𝚅𝙴𝙻𝙾𝙿𝙴𝚁 𝐁𝚈 𝐈𝚂𝙷𝙰𝙽-𝐗 × 𝐋𝙾𝚅𝙴𝙻𝚈 🧑‍💻🇱🇰*_`;

    // 🎬 SENDING MOVIE MENU AS GIF (or the Premium user's personal Menu image)
    const moviemenuAnyCustom = hasCustomMenuImage(bc);
    if (moviemenuAnyCustom) {
      await socket.sendMessage(sender, {
        image: { url: resolveBaseMenuImage(bc, imageurl6) },
        caption: brandMenuCaption(bc, menuc, { botname: premiumName, jid: nowsender }),
        footer: premiumFooter,
        headerType: 4
      }, { quoted: msg });
    } else {
      await socket.sendMessage(sender, { 
        video: { url: imageurl6 }, // Make sure imageurl6 in your ownerdata file is a .mp4 raw link
        gifPlayback: true, 
        caption: brandMenuCaption(bc, menuc, { botname: premiumName, jid: nowsender }), 
        footer: premiumFooter, 
        headerType: 4 
      }, { quoted: msg });
    }

  } catch(e) { 
    console.error("❌ Movie Menu Error:", e);
    socket.sendMessage(sender, { text: `*🚩 Menu Error :-*\n${e.message}` }).catch(() => {}); 
  }
  break;
}

// ==================== ANIME SUB MENU ====================
case 'animemenu': {
  try {
    await socket.sendMessage(sender, { react: { text: "🎌", key: msg.key } });
    
    const ownerdata = (await axios.get("https://raw.githubusercontent.com/Dilu-x/OWNER_DATA/refs/heads/main/ownerdata")).data;
    const { footer, botname, imageurl14 } = ownerdata;
    const bc = await resolveDisplayBotConfig(socket, nowsender);
    const premiumName = await resolveUserBotName(socket, nowsender, {}, botname);
    const premiumFooter = await resolveUserBotFooter(socket, nowsender, footer);
    
    const ramUsed = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2);
    const ut = process.uptime();
    const rtime = `${Math.floor(ut/3600)}h ${Math.floor((ut%3600)/60)}m ${Math.floor(ut%60)}s`;
    
    const menuc = `╭━〔 🎌 𝐈𝐒𝐇𝐀𝐍-𝐗 𝐌𝐃 • 𝐀𝐍𝐈𝐌𝐄 𝐌𝐄𝐍𝐔 〕━━⬣

│ 🤖 \`𝐁𝐨𝐭\`       : ${premiumName}
│ ⏱️ \`𝐔𝐩𝐭𝐢𝐦𝐞\`   : ${rtime}
│ 💾 \`𝐑𝐀𝐌\`     : ${ramUsed} MB

╰━━━━━━━━━━━━━━━━⬣

🎌 *𝐀𝐍𝐈𝐌𝐄 𝐂𝐎𝐌𝐌𝐀𝐍𝐃𝐒*

❶ \`.anime <anime name>\` — HLS stream links
❷ \`.animeheaven <anime name>\` — Download episode video
❸ \`.cinetv <movie / tv series>\`
❹ \`.tv <tv series>\`
❺ \`.cartoon <cartoon name>\` — Sinhala cartoon episodes
❻ \`.animost <anime name>\` — Anime search & download

╭━〔 📖 𝐇𝐎𝐖 𝐓𝐎 𝐔𝐒𝐄 〕━━⬣

│ ① Search an Anime
│ ② Reply with the Anime Number
│ ③ Select the Episode
│ ④ Stream or Download starts

╰━━━━━━━━━━━━━━━⬣

🎬 *𝐄𝐗𝐀𝐌𝐏𝐋𝐄𝐒*

│ 🔹 .anime Jujutsu Kaisen
│ 🔹 .animeheaven One Piece
│ 🔹 .cinetv One Piece
│ 🔹 .tv Attack on Titan
│ 🔹 .cartoon Ben 10

╭━〔 ✨ 𝐅𝐄𝐀𝐓𝐔𝐑𝐄𝐒 〕━⬣

│ 🎌 Anime Search
│ 📺 Episodes List
│ 🎞️ Sub / Dub
│ 🎭 Sinhala Cartoons
│ 📥 Direct Download
│ ⚡ Fast Servers

╰━━━━━━━━━━━⬣

╭━〔 ℹ️ 𝐈𝐍𝐅𝐎 〕━━⬣

│ 🌐 𝐒𝐨𝐮𝐫𝐜𝐞     : AnimeHeaven + Miruro
│ 🚀 𝐄𝐧𝐠𝐢𝐧𝐞     : AnimeHeaven API
│ 🔥 𝐕𝐞𝐫𝐬𝐢𝐨𝐧    : Premium

╰━━━━━━━━━━━━━━━⬣

> _*𝐃𝙴𝚅𝙴𝙻𝙾𝙿𝙴𝚁 𝐁𝚈 𝐈𝚂𝙷𝙰𝙽-𝐗 × 𝐋𝙾𝚅𝙴𝙻𝚈 🧑‍💻🇱🇰*_`;

    // 🎌 SENDING ANIME MENU WITH THE DEDICATED ANIME BANNER — or, for premium
    // users who customized botLogo/botImage, their personal Menu image
    // (resolveBaseMenuImage handles the override).
    // The dedicated anime image is read from ownerdata's imageurl14 key; if
    // the key is missing (older ownerdata file) fall back to the repo copy
    // and finally to the hosted fallback so the menu always has an image.
    let animeMenuImage = 'https://d.uguu.se/KzLyYQdx.png'; // last-resort fallback
    if (imageurl14) {
      animeMenuImage = imageurl14;
    } else {
      try {
        const animeMenuHead = await axios.head('https://raw.githubusercontent.com/Dilu-x/OWNER_DATA/main/image_data/anime-menu.png', { timeout: 8000 });
        if (animeMenuHead.status === 200) animeMenuImage = 'https://raw.githubusercontent.com/Dilu-x/OWNER_DATA/main/image_data/anime-menu.png';
      } catch (e) { /* repo copy not uploaded yet → keep the fallback */ }
    }
    await socket.sendMessage(sender, {
      image: { url: resolveBaseMenuImage(bc, animeMenuImage) },
      caption: brandMenuCaption(bc, menuc, { botname: premiumName, jid: nowsender }),
      footer: premiumFooter,
      headerType: 4
    }, { quoted: msg });

  } catch(e) { 
    console.error("❌ Anime Menu Error:", e);
    socket.sendMessage(sender, { text: `*🚩 Menu Error :-*\n${e.message}` }).catch(() => {}); 
  }
  break;
}

// ==================== NSFW SUB MENU (18+ VERIFIED ONLY) ====================
case 'nsfwmenu': {
  try {
    await socket.sendMessage(sender, { react: { text: '🔞', key: msg.key } });
    if (!(await isNsfwVerified(socket, nowsender))) {
      return await socket.sendMessage(sender, { text: nsfwDeniedText() }, { quoted: msg });
    }

    const ownerdata = (await axios.get("https://raw.githubusercontent.com/Dilu-x/OWNER_DATA/refs/heads/main/ownerdata")).data;
    const { footer, imageurl6, botname } = ownerdata;
    const bc = await resolveDisplayBotConfig(socket, nowsender);
    const premiumName = await resolveUserBotName(socket, nowsender, {}, botname);
    const premiumFooter = await resolveUserBotFooter(socket, nowsender, footer);

    const ramUsed = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2);
    const ut = process.uptime();
    const rtime = `${Math.floor(ut/3600)}h ${Math.floor((ut%3600)/60)}m ${Math.floor(ut%60)}s`;

    const menuc = `╭━〔 🔞 ${premiumName} • NSFW MENU 〕━━⬣

🤖 Bot       : ${premiumName}
⏱️ Uptime   : ${rtime}
💾 RAM      : ${ramUsed} MB

╰━━━━━━━━━━━━━━━━⬣

🔞 NSFW COMMANDS

❶ .hanime <name> — Hentai anime (search → download)
❷ .hhentai <name> — Hentai anime (alias)
❸ .removeclothes <url> — NSFW image edit (reply to image)
❹ .removeclothesv2 <url> — NSFW image edit v2 (reply to image)
❺ .xvideos <query> — Search XVideos videos
❻ .xnxxs <query> — Search XNXX videos
❼ .xvdl <url> — Download XVideos/XNXX video

╭━〔 ⚠️ WARNING 〕━━⬣

│ 🔞 18+ CONTENT ONLY
│ 🚫 Minors are strictly prohibited
│ ⚖️ You are responsible for your own usage
│ ✅ Access is granted by the owner only

╰━━━━━━━━━━━━━━━⬣

> _*𝐃𝙴𝚅𝙴𝙻𝙾𝙿𝙴𝚁 𝐁𝚈 𝐈𝚂𝙷𝙰𝙽-𝐗 × 𝐋𝙾𝚅𝙴𝙻𝚈 🧑‍💻🇱🇰*_`;

    await socket.sendMessage(sender, {
      image: { url: resolveBaseMenuImage(bc, imageurl6) },
      caption: brandMenuCaption(bc, menuc, { botname: premiumName, jid: nowsender }),
      footer: premiumFooter,
      headerType: 4
    }, { quoted: msg });

  } catch (e) {
    console.error('❌ NSFW Menu Error:', e);
    socket.sendMessage(sender, { text: `*🚩 Menu Error :-*\n${e.message}` }).catch(() => {});
  }
  break;
}

// ==================== MOVIE COMMAND ====================
case 'movie':
case 'sinhalasub':
case 'films':
case 'film':
case 'mv': {
    // ⚡ DIRECT RAW LINK SETUP (Must be .mp4 for WhatsApp GIF)
    const rawGifUrl = "https://raw.githubusercontent.com/Dilu-x/OWNER_DATA/main/image_data/movie.mp4";

    try {
        await socket.sendMessage(sender, {
            react: { text: "🎬", key: msg.key }
        });

        const q = args.join(" ").trim();

        // 1. NO QUERY PROVIDED (Summa .movie pota vara msg)
        if (!q) {
            return await socket.sendMessage(sender, {
                video: { url: rawGifUrl },
                gifPlayback: true,
                caption:
`╭━〔 🎬 𝐌𝐎𝐕𝐈𝐄 𝐒𝐄𝐀𝐑𝐂𝐇 〕━━⬣
┃
┃➤ \`❌ Please enter a movie name.\`
┃
┃➤ *📌 Example:*
┃• ${prefix}movie Avengers
┃• ${prefix}mv Avatar
┃• ${prefix}films John Wick
┃• ${prefix}sinhalasub Batman
╰━━━━━━━━━━━━━━━⬣

> _*𝐃𝙴𝚅𝙴𝙻𝙾𝙿𝙴𝚁 𝐁𝚈 𝐈𝚂𝙷𝙰𝙽-𝐗 × 𝐋𝙾𝚅𝙴𝙻𝚈 🧑‍💻🇱🇰*_`
            }, { quoted: msg });
        }

        await socket.sendMessage(sender, {
            text: "🔍 *Searching SinhalaSub Database...*"
        }, { quoted: msg });

        const results = await searchMovies(q);

        // 2. NO RESULTS FOUND
        if (!results || results.length === 0) {
            return await socket.sendMessage(sender, {
                video: { url: rawGifUrl },
                gifPlayback: true,
                caption:
`╭━〔 ❌ 𝐍𝐎 𝐑𝐄𝐒𝐔𝐋𝐓𝐒 〕━⬣
┃
┃➤ 🎬 \`𝐐𝐮𝐞𝐫𝐲\` : ${q}
┃
┃➤ ❌ No movies were found.
┃➤ 💡 Try another keyword.
╰━━━━━━━━━━━━━⬣

> _*𝐃𝙴𝚅𝙴𝙻𝙾𝙿𝙴𝚁 𝐁𝚈 𝐈𝚂𝙷𝙰𝙽-𝐗 × 𝐋𝙾𝚅𝙴𝙻𝚈 🧑‍💻🇱🇰*_`
            }, { quoted: msg });
        }

        const rows = results.map(movie => ({
            label: `🎬 ${movie.title}`,
            id: `${prefix}moviedetail ${encodeURIComponent(movie.movieUrl)}`
        }));

        delete pendingRowSelect[sender];
        if (typeof cinesubPlugin.clear === 'function') cinesubPlugin.clear(sender);
        if (typeof animeClearSessions === 'function') animeClearSessions(nowsender);
        moviePendingSearch[sender] = { results, timestamp: Date.now(), botJid: currentBotJid() };

        const caption =
`╭━〔 🎬 𝐈𝐒𝐇𝐀𝐍-𝐗 • 𝐌𝐎𝐕𝐈𝐄 𝐒𝐄𝐀𝐑𝐂𝐇 〕━⬣
┃
┃➤ 🔎 \`𝐐𝐮𝐞𝐫𝐲\`  : ${q}
┃➤ 🎞️ \`𝐑𝐞𝐬𝐮𝐥𝐭𝐬\` : ${results.length}
╰━━━━━━━━━━━━━━━⬣

📥 *𝐒𝐄𝐋𝐄𝐂𝐓 𝐀 𝐌𝐎𝐕𝐈𝐄*

${buildNumberedList(rows)}

━━━━━━━━━━━━━━━━

💬 *Reply with the corresponding number.*

> _*𝐃𝙴𝚅𝙴𝙻𝙾𝙿𝙴𝚁 𝐁𝚈 𝐈𝚂𝙷𝙰𝙽-𝐗 × 𝐋𝙾𝚅𝙴𝙻𝚈 🧑‍💻🇱🇰*_`;

        // Success message keeps the movie thumbnail
        await socket.sendMessage(sender, {
            image: {
                url: results[0].thumb
            },
            caption
        }, { quoted: msg });

    } catch (err) {
        console.error("Movie Search Error:", err);

        // 3. ERROR MESSAGE
        await socket.sendMessage(sender, {
            video: { url: rawGifUrl },
            gifPlayback: true,
            caption:
`╭━〔 ❌ 𝐒𝐄𝐀𝐑𝐂𝐇 𝐄𝐑𝐑𝐎𝐑 〕━⬣

┃➤⚠️ ${err.message || "Unknown Error"}

╰━━━━━━━━━━━━━━⬣

> _*𝐃𝙴𝚅𝙴𝙻𝙾𝙿𝙴𝚁 𝐁𝚈 𝐈𝚂𝙷𝙰𝙽-𝐗 × 𝐋𝙾𝚅𝙴𝙻𝚈 🧑‍💻🇱🇰*_`
        }, { quoted: msg });
    }

    break;
}

case 'download': {
  try { await socket.sendMessage(sender, { react: { text: "📥", key: msg.key } }); } catch(e){}

  try {
    let userCfg = {};
    try { if (number && typeof loadUserConfigFromMongo === 'function') userCfg = await loadUserConfigFromMongo((number || '').replace(/[^0-9]/g, '')) || {}; } catch(e){ userCfg = {}; }
    const title = await resolveUserBotName(socket, nowsender, userCfg, '𝐀𝚂𝙷𝙸𝚈𝙰-𝐌𝙳 4.0.0𝗩 🥷🇱🇰');
    
    // 1. GENERATE RANDOM LOGO (Add your URLs here)
    const logos = [
        "https://raw.githubusercontent.com/minibotsjsisns/IMAGE_DATA/refs/heads/main/78bgy.jpg", 
        "https://raw.githubusercontent.com/minibotsjsisns/IMAGE_DATA/refs/heads/main/78bgy.jpg",
        config.LOGO // Fallback to config logo
    ];
    const randomLogo = logos[Math.floor(Math.random() * logos.length)] || logos[0];

    // 2. CREATE FAKE CONTACT (QUOTED)
    
    const text = `
╭═〔 Dᴏᴡɴʟᴏᴀᴅ Mᴇɴᴜ Lɪꜱᴛ 🍷〕═╮
╠═════════════❒
╠•🍷${config.PREFIX}song
╠•🍷${config.PREFIX}csong
╠•🍷${config.PREFIX}gsong
╠•🍷${config.PREFIX}cvideo
╠•🍷${config.PREFIX}video
╠•🍷${config.PREFIX}tiktok
╠•🍷${config.PREFIX}fb
╠•🍷${config.PREFIX}ig
╠•🍷${config.PREFIX}apk
╠•🍷${config.PREFIX}apksearch
╠•🍷${config.PREFIX}mediafire
╠•🍷${config.PREFIX}gdrive
╘════════════❒
`.trim();

    // 3. SEND IMAGE MESSAGE WITH CONTEXT INFO (DOUBLE LOGO)
    await socket.sendMessage(sender, {
      image: { url: randomLogo }, // Main Logo
      caption: `${text}\n\n_Type ${config.PREFIX}menu or ${config.PREFIX}tool_`,
      footer: "> _*𝐃𝙴𝚅𝙴𝙻𝙾𝙿𝙴𝚁 𝐁𝚈 𝐈𝚂𝙷𝙰𝙽-𝐗 × 𝐋𝙾𝚅𝙴𝙻𝚈 🧑‍💻🇱🇰*_",
      contextInfo: {
        externalAdReply: {
          title: "📥 𝐃𝐎𝐖𝐍𝐋𝐎𝐀𝐃 𝐌𝐀𝐍𝐀𝐆𝐄𝐑",
          body: title,
          thumbnailUrl: randomLogo, // Second Logo (Thumbnail)
          sourceUrl: "https://chat.whatsapp.com/KtGuIzicrty4idprouuLE6", // Your Channel Link
          mediaType: 1,
          renderLargerThumbnail: true
        }
      }
    }, { quoted: msg });

  } catch (err) {
    console.error('download command error:', err);
    try { await socket.sendMessage(sender, { text: '❌ Error loading download menu.' }, { quoted: msg }); } catch(e){}
  }
  break;
}

// ==================== CREATIVE / TOOL MENU ====================
case 'tool': 
case 'creative': {
  try { await socket.sendMessage(sender, { react: { text: "🎨", key: msg.key } }); } catch(e){}

  try {
    let userCfg = {};
    try { if (number && typeof loadUserConfigFromMongo === 'function') userCfg = await loadUserConfigFromMongo((number || '').replace(/[^0-9]/g, '')) || {}; } catch(e){ userCfg = {}; }
    const title = await resolveUserBotName(socket, nowsender, userCfg, '★彡 𝐈𝐒𝐇𝐀𝐍-𝐗 𝐌𝐃 𝐏𝐑𝐎 彡★');
    
    // Random Logo Logic
    const logos = [config.LOGO, "https://raw.githubusercontent.com/minibotsjsisns/IMAGE_DATA/refs/heads/main/UhDXf.jpg"]; // Add more
    const randomLogo = logos[Math.floor(Math.random() * logos.length)] || logos[0];

    
    const text = `
╭═〔 Tᴏᴏʟ Mᴇɴᴜ Lɪꜱᴛ 🍷〕═╮
╠═════════════❒
╠•🍷${config.PREFIX}jid
╠•🍷${config.PREFIX}cid
╠•🍷${config.PREFIX}system
╠•🍷${config.PREFIX}tagall
╠•🍷${config.PREFIX}online
╠•🍷${config.PREFIX}adanews
╠•🍷${config.PREFIX}sirasanews
╠•🍷${config.PREFIX}lankadeepanews
╠•🍷${config.PREFIX}gagananews
╠•🍷${config.PREFIX}block
╠•🍷${config.PREFIX}unblock
╠•🍷${config.PREFIX}prefix
╠•🍷${config.PREFIX}autorecording
╠•🍷${config.PREFIX}mread
╠•🍷${config.PREFIX}creject
╠•🍷${config.PREFIX}wtyp
╠•🍷${config.PREFIX}pp
╠•🍷${config.PREFIX}arm
╠•🍷${config.PREFIX}rstatus
╠•🍷${config.PREFIX}botpresence
╠•🍷${config.PREFIX}img
╠•🍷${config.PREFIX}google
╠•🍷${config.PREFIX}ping
╠•🍷${config.PREFIX}alive
╚═════════════❒
`.trim();

    await socket.sendMessage(sender, {
      image: { url: randomLogo },
      caption: `${text}\n\n_Type ${config.PREFIX}menu or ${config.PREFIX}download_`,
      footer: "✨ ᴜɴʟᴇᴀꜱʜ ʏᴏᴜʀ ᴄʀᴇᴀᴛɪᴠɪᴛʏ",
      contextInfo: {
        externalAdReply: {
          title: "🎨 𝐂𝐑𝐄𝐀𝐓𝐈𝐕𝐄 𝐌𝐎𝐃𝐄",
          body: title,
          thumbnailUrl: randomLogo,
          sourceUrl: "https://whatsapp.com/channel/0029VbAe6Nt545uv1kaCDE3j",
          mediaType: 1,
          renderLargerThumbnail: true
        }
      }
    }, { quoted: msg });

  } catch (err) {
    console.error('creative command error:', err);
    try { await socket.sendMessage(sender, { text: '❌ Error loading creative menu.' }, { quoted: msg }); } catch(e){}
  }
  break;
}

//-------------------- UNIFIED PROFILE PICTURE COMMAND --------------------//
case 'getpp':
case 'profile':
case 'getdp':
case 'dp': {
    // Session-user / owner only check: works only for the session user (the
    // number this bot session is logged in as) and the numbers in OWNER_NUMBER.
    // Everyone else is blocked.
    const sessionUserNum = String(socket.user?.id || '').split(':')[0].replace(/[^0-9]/g, '');
    if (!isOwner && (await resolveSenderPhone(socket, nowsender)) !== sessionUserNum) {
        await socket.sendMessage(sender, { react: { text: '❌', key: msg.key } });
        await socket.sendMessage(sender, { text: '❌ *Session user & owner only command.*' }, { quoted: msg });
        break;
    }
    // 1. React with loading
    await socket.sendMessage(sender, { react: { text: '👤', key: msg.key } });

    try {
        // --- CONFIG & STYLE LOAD ---
        // (Assuming you have a function to get config, otherwise defaults use hardcoded values)
        const sanitizedSender = sender.split('@')[0];
        const cfg = await loadUserConfigFromMongo(sanitizedSender).catch(() => ({})) || {};
        const botName = await resolveUserBotName(socket, nowsender, cfg, "> _*𝐃𝙴𝚅𝙴𝙻𝙾𝙿𝙴𝚁 𝐁𝚈 𝐈𝚂𝙷𝙰𝙽-𝐗 × 𝐋𝙾𝚅𝙴𝙻𝚈 🧑‍💻🇱🇰*_"); // Default Artful Name
        const logo = cfg.logo || "https://raw.githubusercontent.com/minibotsjsisns/IMAGE_DATA/refs/heads/main/file_000000005eac720896d40b719700b3c0.png"; // Default Logo
        
        // --- TARGET RESOLUTION (The "Bind" Logic) ---
        let targetUser = sender; // Default to self
        let inputNumber = msg.message?.conversation?.split(" ")[1] || 
                          msg.message?.extendedTextMessage?.text?.split(" ")[1];

        if (inputNumber) {
            // If number provided (getdp style)
            targetUser = inputNumber.replace(/[^0-9]/g, '') + "@s.whatsapp.net";
        } else if (msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.length > 0) {
            // If mention exists
            targetUser = msg.message.extendedTextMessage.contextInfo.mentionedJid[0];
        } else if (msg.quoted) {
            // If reply exists
            targetUser = msg.quoted.sender;
        }

        const userNum = targetUser.split('@')[0];

        // --- FETCH PP (HD -> Privacy Fallback) ---
        let ppUrl, mode = 'HD IMAGE';
        try {
            ppUrl = await socket.profilePictureUrl(targetUser, 'image'); // Try HD
        } catch {
            try {
                mode = 'PREVIEW';
                ppUrl = await socket.profilePictureUrl(targetUser, 'preview'); // Try Preview
            } catch {
                mode = 'NOT FOUND';
                ppUrl = logo; // Fallback to bot logo if no PP allowed
            }
        }

        // --- ARTFUL CAPTION ---
        const caption = `
╔═════「 👤 *PROFILE PIC* 」════❒
╠⦁ ➤❄️ *User:* @${userNum}
╠⦁ ➤🎭 *Mode:* ${mode}
╠⦁ ➤🤖 *Bot:* ${botName}
╚════════════❒


   *වැඩිය හිතන්න එපා profile එක ගත්තේ අවුලක් නෑ නේද? 🥺💗*
`;

        // --- META BROADCAST QUOTE (Style) ---
        
        // --- SEND MESSAGE ---
        await socket.sendMessage(msg.key.remoteJid, {
            image: { url: ppUrl },
            caption: `${caption}\n\n_Type ${config.PREFIX || '.'}menu or ${config.PREFIX || '.'}alive_`,
            footer: `Power by ${botName}`,
            headerType: 4,
            mentions: [targetUser]
        }, { quoted: msg });

        // Success React
        await socket.sendMessage(msg.key.remoteJid, { react: { text: '✅', key: msg.key } });

    } catch (e) {
        console.log("❌ PP Fetch Error:", e);
        await socket.sendMessage(msg.key.remoteJid, { 
            text: `⚠️ *Error:* Could not fetch profile picture.
_${e.message}_` 
        }, { quoted: msg });
        await socket.sendMessage(msg.key.remoteJid, { react: { text: '❌', key: msg.key } });
    }
    break;
}

case 'showconfig': {
  const sanitized = (number || '').replace(/[^0-9]/g, '');
  try {
    const cfg = await loadUserConfigFromMongo(sanitized) || {};
    const botName = await resolveUserBotName(socket, nowsender, cfg, BOT_NAME_FANCY);

    
    let txt = `*Session config for ${sanitized}:*\n`;
    txt += `• Bot name: ${botName}\n`;
    txt += `• Logo: ${cfg.logo || config.RCD_IMAGE_PATH}\n`;
    await socket.sendMessage(sender, { text: txt }, { quoted: msg });
  } catch (e) {
    console.error('showconfig error', e);
        await socket.sendMessage(sender, { text: '❌ Failed to load config.' }, { quoted: msg });
  }
  break;
}

case 'resetsettings': {
  const sanitized = (number || '').replace(/[^0-9]/g, '');    const senderNum = await resolveSenderPhone(socket, nowsender);
    const isOwnerNum = isOwnerNumber(senderNum);
  if (senderNum !== sanitized && !isOwnerNum) {
        await socket.sendMessage(sender, { text: '❌ Permission denied. Only the session owner or bot owner can reset configs.' }, { quoted: msg });
    break;
  }

  try {
    await setUserConfigInMongo(sanitized, {});

    
    await socket.sendMessage(sender, { text: '✅ Session config reset to defaults.' }, { quoted: msg });
  } catch (e) {
    console.error('resetconfig error', e);
    
    await socket.sendMessage(sender, { text: '❌ Failed to reset config.' }, { quoted: msg });
  }
  break;
}

case 'owner':
case 'ishan':
case 'ishan-x':
case 'Developer': {
  try {
    // 1. Send Royal Reaction 👑
    await socket.sendMessage(sender, { 
      react: { text: "🧑‍💻", key: msg.key } 
    });

    // 2. Configuration & Data
    const ownerNumber = String(config.PUBLIC_OWNER_NUMBER || config.OWNER_NUMBER || '').split(',')[0].trim();
    const ownerName = '𝐈𝚂𝙷𝙰𝙽 𝐌𝙰𝙳𝚄𝚂𝙰𝙽𝙺𝙴 🧑‍💻🇱🇰';
    const botName = '𝗜𝗦𝗛𝗔𝗡-𝐗 𝗠𝗗 🧑‍💻🇱🇰';
    const partnerName = 'Lovely Official 🧑‍💻🇱🇰';
    const ownerImage = 'https://raw.githubusercontent.com/minibotsjsisns/IMAGE_DATA/refs/heads/main/RKhKV.jpg';
    const websiteUrl = BOT_WEB_URL;
    
    // Time Calculation
    const timeNow = new Date().toLocaleTimeString('en-US', { 
      hour: '2-digit', minute: '2-digit', hour12: true, timeZone: "Asia/Colombo" 
    });

    // 3. Artful "Royal" Text Layout 🎨
    // Using box-drawing characters and emojis for a "colorful" feel
    const aestheticCaption = `
╔════〔 *${botName}* 〕═══❒
╠⦁ ➤🧑‍💻 *OWNER PROFILE*
╠⦁ ➤🙌 𝐍𝐚𝐦𝐞 : *${ownerName}*
╠⦁ ➤🍷 𝐑𝐨𝐥𝐞 : *Lead Developer*
╠⦁ ➤🤝 *PARTNER*
╠⦁ ➤👤 Name : *Lovely Official*
╠⦁ ➤🛠️ Role : *Support & Development*
╠⦁ ➤📍 𝐅𝐫𝐨𝐦 : *Sri Lanka 🇱🇰*
╠⦁ ➤⌚ 𝐓𝐢𝐦𝐞 : *${timeNow}*
╠⦁ ➤🛠️ *SKILLS & STATUS*
╠⦁ ➤💻 Stack : *JS, Node.js, React*
╠⦁ ➤🤖 Bot : *Active & Online* ✅
╠⦁ ➤🛡️ Security : *Verified*
╚════════════════❒


> *𝐃𝙴𝚅𝙴𝙻𝙾𝙿𝙴𝚁 𝐁𝚈 𝐈𝚂𝙷𝙰𝙽-𝐗 × 𝐋𝙾𝚅𝙴𝙻𝚈 🧑‍💻🇱🇰*
`.trim();

    // 4. Plain text message (no buttons) with links included directly
    const captionWithLinks = `${aestheticCaption}\n\n💬 Chat with Owner: https://wa.me/${ownerNumber}?text=Hello ${ownerName}, I need assistance with 𝙸𝚂𝙷𝙰𝙽-𝚇 𝙼𝙳 𝙿𝚁𝙾 Bot.\n🌐 Website: ${websiteUrl}\n📋 Owner Number: ${ownerNumber}`;

    await socket.sendMessage(sender, {
      image: { url: ownerImage },
      caption: captionWithLinks
    }, { quoted: msg });

    // 6. Send vCard (Contacts) separately for easy saving
    // Small delay to ensure order
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    const vcard1 = `BEGIN:VCARD\nVERSION:3.0\nFN:${ownerName}\nORG:ISHAN-X Development\nTEL;type=CELL;type=VOICE;waid=${ownerNumber}:+${ownerNumber}\nEND:VCARD`;
    const vcard2 = `BEGIN:VCARD\nVERSION:3.0\nFN:${ownerName} (2)\nORG:ISHAN-X Development\nTEL;type=CELL;type=VOICE;waid=94785457011:+94785457011\nEND:VCARD`;
    const vcard3 = `BEGIN:VCARD\nVERSION:3.0\nFN:${ownerName} (3)\nORG:ISHAN-X Development\nTEL;type=CELL;type=VOICE;waid=94786425433:+94781332957\nEND:VCARD`;
    const vcard4 = `BEGIN:VCARD
VERSION:3.0
FN:${partnerName}
ORG:ISHAN-X Partner
TEL;type=CELL;type=VOICE;waid=94764642432:+94764642432
END:VCARD`;
    await socket.sendMessage(sender, {
      contacts: {
        displayName: ownerName,
        contacts: [{ vcard: vcard1 }, { vcard: vcard2 }, { vcard: vcard3 }, { vcard: vcard4 }]
      }
    });

  } catch (err) {
    console.error('❌ Owner Command Error:', err);
    await socket.sendMessage(sender, { 
      text: `⚠️ *Error:* Failed to load owner menu.
Contact: +${config.PUBLIC_OWNER_NUMBER || config.OWNER_NUMBER}` 
    }, { quoted: msg });
  }
  break;
}
case 'google':
case 'gsearch':
case 'search':
    try {
        if (!args || args.length === 0) {
            await socket.sendMessage(sender, {
                text: '⚠️ *Please provide a search query.*\n\n*Example:*\n.google how to code in javascript'
            });
            break;
        }

        const sanitized = (number || '').replace(/[^0-9]/g, '');
        const userCfg = await loadUserConfigFromMongo(sanitized) || {};
        const botName = await resolveUserBotName(socket, nowsender, userCfg, BOT_NAME_FANCY);

        
        const query = args.join(" ");
        const apiKey = "AIzaSyDMbI3nvmQUrfjoCJYLS69Lej1hSXQjnWI";
        const cx = "baf9bdb0c631236e5";
        const apiUrl = `https://www.googleapis.com/customsearch/v1?q=${encodeURIComponent(query)}&key=${apiKey}&cx=${cx}`;

        const response = await axios.get(apiUrl);

        if (response.status !== 200 || !response.data.items || response.data.items.length === 0) {
            await socket.sendMessage(sender, { text: `⚠️ *No results found for:* ${query}` }, { quoted: msg });
            break;
        }

        let results = `🔍 *𝐆oogle 𝐒earch 𝐑esults 𝐅or:* "${query}"\n\n`;
        response.data.items.slice(0, 5).forEach((item, index) => {
            results += `*${index + 1}. ${item.title}*\n\n🔗 ${item.link}\n\n📝 ${item.snippet}\n\n`;
        });

        const firstResult = response.data.items[0];
        const thumbnailUrl = firstResult.pagemap?.cse_image?.[0]?.src || firstResult.pagemap?.cse_thumbnail?.[0]?.src || 'https://via.placeholder.com/150';

        await socket.sendMessage(sender, {
            image: { url: thumbnailUrl },
            caption: results.trim(),
            contextInfo: { mentionedJid: [sender] }
        }, { quoted: msg });

    } catch (error) {
        console.error(`Google search error:`, error);
        await socket.sendMessage(sender, { text: `⚠️ *An error occurred while fetching search results.*\n\n${error.message}` });
    }
    break;
case 'img': {
    const q = body.replace(/^[.\/!]img\s*/i, '').trim();
    if (!q) return await socket.sendMessage(sender, {
        text: '🔍 Please provide a search query. Ex: `.img sunset`'
    }, { quoted: msg });

    try {
        const sanitized = (number || '').replace(/[^0-9]/g, '');
        const userCfg = await loadUserConfigFromMongo(sanitized) || {};
        const botName = await resolveUserBotName(socket, nowsender, userCfg, BOT_NAME_FANCY);

        
        const res = await axios.get(`https://allstars-apis.vercel.app/pinterest?search=${encodeURIComponent(q)}`);
        const data = res.data.data;
        if (!data || data.length === 0) return await socket.sendMessage(sender, { text: '❌ No images found for your query.' }, { quoted: msg });

        const randomImage = data[Math.floor(Math.random() * data.length)];

        const buttonMessage = {
            image: { url: randomImage },
            caption: `🖼️ *𝐈mage 𝐒earch:* ${q}\n\n*𝐏rovided 𝐁y ${botName}*\n\n_Send ${config.PREFIX}img ${q} again for another image._`,
            footer: config.FOOTER || '> _*𝐃𝙴𝚅𝙴𝙻𝙾𝙿𝙴𝚁 𝐁𝚈 𝐈𝚂𝙷𝙰𝙽-𝐗 × 𝐋𝙾𝚅𝙴𝙻𝚈 🧑‍💻🇱🇰*_',
            headerType: 4,
            contextInfo: { mentionedJid: [sender] }
        };

        await socket.sendMessage(from, buttonMessage, { quoted: msg });

    } catch (err) {
        console.error("Image search error:", err);
        await socket.sendMessage(sender, { text: '❌ Failed to fetch images.' }, { quoted: msg });
    }
    break;
}
case 'gdrive': {
    try {
        const text = args.join(' ').trim();
        if (!text) return await socket.sendMessage(sender, { text: '⚠️ Please provide a Google Drive link.\n\nExample: `.gdrive <link>`' }, { quoted: msg });

        // 🔹 Load bot name dynamically
        const sanitized = (number || '').replace(/[^0-9]/g, '');
        const userCfg = await loadUserConfigFromMongo(sanitized) || {};
        const botName = await resolveUserBotName(socket, nowsender, userCfg, BOT_NAME_FANCY);

        // 🔹 Meta AI fake contact mention
        
        // 🔹 Fetch Google Drive file info
        const res = await axios.get(`https://saviya-kolla-api.koyeb.app/download/gdrive?url=${encodeURIComponent(text)}`);
        if (!res.data?.status || !res.data.result) return await socket.sendMessage(sender, { text: '❌ Failed to fetch file info.' }, { quoted: msg });

        const file = res.data.result;

        // 🔹 Send as document
        await socket.sendMessage(sender, {
            document: { 
                url: file.downloadLink, 
                mimetype: file.mimeType || 'application/octet-stream', 
                fileName: file.name 
            },
            caption: `📂 *𝐅ile 𝐍ame:* ${file.name}\n💾 *𝐒ize:* ${file.size}\n\n*𝐏owered 𝐁y ${botName}*`,
            contextInfo: { mentionedJid: [sender] }
        }, { quoted: msg });

    } catch (err) {
        console.error('GDrive command error:', err);
        await socket.sendMessage(sender, { text: '❌ Error fetching Google Drive file.' }, { quoted: msg });
    }
    break;
}


case 'adanews': {
  try {
    const sanitized = (number || '').replace(/[^0-9]/g, '');
    const userCfg = await loadUserConfigFromMongo(sanitized) || {};
    const botName = await resolveUserBotName(socket, nowsender, userCfg, BOT_NAME_FANCY);

    
    const res = await axios.get('https://saviya-kolla-api.koyeb.app/news/ada');
    if (!res.data?.status || !res.data.result) return await socket.sendMessage(sender, { text: '❌ Failed to fetch Ada News.' }, { quoted: msg });

    const n = res.data.result;
    const caption = `📰 *${n.title}*\n\n*📅 𝐃ate:* ${n.date}\n*⏰ 𝐓ime:* ${n.time}\n\n${n.desc}\n\n*🔗 [Read more]* (${n.url})\n\n*𝐏ᴏᴡᴇʀᴇᴅ 𝐁ʏ ${botName}*`;

    await socket.sendMessage(sender, { image: { url: n.image }, caption, contextInfo: { mentionedJid: [sender] } }, { quoted: msg });

  } catch (err) {
    console.error('adanews error:', err);
    await socket.sendMessage(sender, { text: '❌ Error fetching Ada News.' }, { quoted: msg });
  }
  break;
}
case 'sirasanews': {
  try {
    const sanitized = (number || '').replace(/[^0-9]/g, '');
    const userCfg = await loadUserConfigFromMongo(sanitized) || {};
    const botName = await resolveUserBotName(socket, nowsender, userCfg, BOT_NAME_FANCY);

    
    const res = await axios.get('https://saviya-kolla-api.koyeb.app/news/sirasa');
    if (!res.data?.status || !res.data.result) return await socket.sendMessage(sender, { text: '❌ Failed to fetch Sirasa News.' }, { quoted: msg });

    const n = res.data.result;
    const caption = `📰 *${n.title}*\n\n*📅 𝐃ate:* ${n.date}\n*⏰ 𝐓ime:* ${n.time}\n\n${n.desc}\n\n*🔗 [Read more]* (${n.url})\n\n*𝐏ᴏᴡᴇʀᴇᴅ 𝐁ʏ ${botName}*`;

    await socket.sendMessage(sender, { image: { url: n.image }, caption, contextInfo: { mentionedJid: [sender] } }, { quoted: msg });

  } catch (err) {
    console.error('sirasanews error:', err);
    await socket.sendMessage(sender, { text: '❌ Error fetching Sirasa News.' }, { quoted: msg });
  }
  break;
}
case 'lankadeepanews': {
  try {
    const sanitized = (number || '').replace(/[^0-9]/g, '');
    const userCfg = await loadUserConfigFromMongo(sanitized) || {};
    const botName = await resolveUserBotName(socket, nowsender, userCfg, BOT_NAME_FANCY);

    
    const res = await axios.get('https://saviya-kolla-api.koyeb.app/news/lankadeepa');
    if (!res.data?.status || !res.data.result) return await socket.sendMessage(sender, { text: '❌ Failed to fetch Lankadeepa News.' }, { quoted: msg });

    const n = res.data.result;
    const caption = `📰 *${n.title}*\n\n*📅 𝐃ate:* ${n.date}\n*⏰ 𝐓ime:* ${n.time}\n\n${n.desc}\n\n*🔗 [𝐑ead more]* (${n.url})\n\n*𝐏ᴏᴡᴇʀᴇᴅ 𝐁ʏ ${botName}*`;

    await socket.sendMessage(sender, { image: { url: n.image }, caption, contextInfo: { mentionedJid: [sender] } }, { quoted: msg });

  } catch (err) {
    console.error('lankadeepanews error:', err);
    await socket.sendMessage(sender, { text: '❌ Error fetching Lankadeepa News.' }, { quoted: msg });
  }
  break;
}
case 'gagananews': {
  try {
    const sanitized = (number || '').replace(/[^0-9]/g, '');
    const userCfg = await loadUserConfigFromMongo(sanitized) || {};
    const botName = await resolveUserBotName(socket, nowsender, userCfg, BOT_NAME_FANCY);

    
    const res = await axios.get('https://saviya-kolla-api.koyeb.app/news/gagana');
    if (!res.data?.status || !res.data.result) return await socket.sendMessage(sender, { text: '❌ Failed to fetch Gagana News.' }, { quoted: msg });

    const n = res.data.result;
    const caption = `📰 *${n.title}*\n\n*📅 𝐃ate:* ${n.date}\n*⏰ 𝐓ime:* ${n.time}\n\n${n.desc}\n\n*🔗 [Read more]* (${n.url})\n\n*𝐏ᴏᴡᴇʀᴇᴅ 𝐁ʏ ${botName}*`;

    await socket.sendMessage(sender, { image: { url: n.image }, caption, contextInfo: { mentionedJid: [sender] } }, { quoted: msg });

  } catch (err) {
    console.error('gagananews error:', err);
    await socket.sendMessage(sender, { text: '❌ Error fetching Gagana News.' }, { quoted: msg });
  }
  break;
}


//💐💐💐💐💐💐





// ==================== HELP CENTER ====================
case 'help':
case 'support':
case 'bothelp': {
  try {
    await socket.sendMessage(sender, { react: { text: '🆘', key: msg.key } });

    const ownerdata = (await axios.get(
      "https://raw.githubusercontent.com/Dilu-x/OWNER_DATA/refs/heads/main/ownerdata"
    )).data;
    const { footer, imageurl, channel } = ownerdata;
    const pairlink = BOT_WEB_URL;

    const caption = `_👋 Welcome to 𝙸𝚂𝙷𝙰𝙽-𝚇 𝙼𝙳 𝙿𝚁𝙾 Help Center!_ 💬\n\n🚩 [  Help Center / උපකාර මධ්‍යස්ථානය ] 🚩\n\n➤ කරුණාකර භාෂාවක් තෝරන්න :\n➤ Please select a language to continue :`;

    const helpRows = [
      { label: 'English 🇺🇸', id: `${prefix}helpen` },
      { label: 'සිංහල 🇱🇰', id: `${prefix}helpsi` }
    ];
    setPendingRowSelect(sender, helpRows);

    await socket.sendMessage(sender, {
      image: { url: imageurl },
      caption: `${caption}\n\n${buildNumberedList(helpRows)}\n\n*Reply with the number of your choice.*`,
      footer,
      headerType: 4
    }, { quoted: msg });

  } catch (e) {
    console.error(e);
    await socket.sendMessage(sender, { text: `🚩 *Help Error :*\n${e.message}` }, { quoted: msg });
  }
  break;
}

case 'helpsi': {
  try {
    const ownerdata = (await axios.get(
      "https://raw.githubusercontent.com/Dilu-x/OWNER_DATA/refs/heads/main/ownerdata"
    )).data;
    const { footer, imageurl, channel } = ownerdata;
    const pairlink = BOT_WEB_URL;

    const step1 = `👋 𝙸𝚂𝙷𝙰𝙽-𝚇 𝙼𝙳 𝙿𝚁𝙾 Help Center වෙත සාදරයෙන් පිළිගනිමු! 💬\n\n🚩 𝙸𝚂𝙷𝙰𝙽-𝚇 𝙼𝙳 𝙿𝚁𝙾 Help 🚩\n\n━━━━━━━━━━━━━━━➤\n❶ 🌍 බොට් වෙබ් පිටුව → ${pairlink}\n━━━━━━━━━━━━━━━➤\n❷ 📢 අපගේ නාලිකාව → ${channel}\n━━━━━━━━━━━━━━━➤`;

    const helpsiRows = [
      { label: 'සාමාන්‍ය උපකාර ❓', id: `${prefix}generalhelpsi` },
      { label: 'අපහා සම්බන්ද වන්න 📞', id: `${prefix}owner` },
      { label: 'විධාන ලැයිස්තුව 📜', id: `${prefix}menu` }
    ];
    setPendingRowSelect(sender, helpsiRows);

    await socket.sendMessage(sender, {
      image: { url: imageurl },
      caption: `${step1}\n\n${buildNumberedList(helpsiRows)}\n\n*Reply with the number of your choice.*`,
      footer,
      headerType: 4
    }, { quoted: msg });

  } catch (e) {
    console.error(e);
    await socket.sendMessage(sender, { text: `❌ *Help Error :*\n${e.message}` }, { quoted: msg });
  }
  break;
}

case 'helpen': {
  try {
    const ownerdata = (await axios.get(
      "https://raw.githubusercontent.com/Dilu-x/OWNER_DATA/refs/heads/main/ownerdata"
    )).data;
    const { footer, imageurl, channel } = ownerdata;
    const pairlink = BOT_WEB_URL;

    const step1 = `👋 Welcome to the 𝙸𝚂𝙷𝙰𝙽-𝚇 𝙼𝙳 𝙿𝚁𝙾 Help Center! 💬\n\n🚩 𝙸𝚂𝙷𝙰𝙽-𝚇 𝙼𝙳 𝙿𝚁𝙾 Help 🚩\n\n━━━━━━━━━━━━━━━➤\n❶ 🌍 Bot Website → ${pairlink}\n━━━━━━━━━━━━━━━➤\n❷ 📢 Our Channel → ${channel}\n━━━━━━━━━━━━━━━➤`;

    const helpenRows = [
      { label: 'General Help ❓', id: `${prefix}generalhelpen` },
      { label: 'Contact Us 📞', id: `${prefix}owner` },
      { label: 'Command Menu 📜', id: `${prefix}menu` }
    ];
    setPendingRowSelect(sender, helpenRows);

    await socket.sendMessage(sender, {
      image: { url: imageurl },
      caption: `${step1}\n\n${buildNumberedList(helpenRows)}\n\n*Reply with the number of your choice.*`,
      footer,
      headerType: 4
    }, { quoted: msg });

  } catch (e) {
    console.error(e);
    await socket.sendMessage(sender, { text: `❌ *Help Error :*\n${e.message}` }, { quoted: msg });
  }
  break;
}

case 'generalhelpsi': {
  try {
    const ownerdata = (await axios.get(
      "https://raw.githubusercontent.com/Dilu-x/OWNER_DATA/refs/heads/main/ownerdata"
    )).data;
    const { footer, imageurl } = ownerdata;

    const step1 = `📋 නිති පැන\n\n🚩 [  𝙸𝚂𝙷𝙰𝙽-𝚇 𝙼𝙳 𝙿𝚁𝙾 Bot - නිතර අසන ප්‍රශ්න ] 🚩\n\n*➤ 1️⃣ 𝙸𝚂𝙷𝙰𝙽-𝚇 𝙼𝙳 𝙿𝚁𝙾 Bot යනු කුමක්ද?*\n𝙸𝚂𝙷𝙰𝙽-𝚇 𝙼𝙳 𝙿𝚁𝙾 BOT යනු Ishan Madusanke විසින් නිර්මාණය කරනු ලැබු WhatsApp බොට් කෙනෙකි.\n\n*➤ 2️⃣ විධාන භාවිතා කරන්නේ කෙසේද?*\nබොට් එකකින් ආරම්භ වන විධාන ටයිප් කරන්න. උදා : - .alive හෝ .menu.\n\n*➤ 3️⃣ මම මෙය ලබාගන්නේ කෙසේද?*\nමෙය 100% නොමිලේ ලබාගත හැකි සේවාවකි.\n\n*➤ 4️⃣ බොට් මන් හදාගන්නේ කෙසේද?*\n.බොට් වෙබ් පිටුවට ගොස් ඔබේ අංකය ඇතුලත් කරන්න. ලැබෙන කෝඩ් එක copy කර WhatsApp සමග link කරන්න.\n\n*➤ 5️⃣ දෝෂ වාර්තා කරන්නේ කෙසේද?*\n.owner භාවිතා කර සෘජුවම Developer කෙනෙක්ට සමග සම්බන්ධ වන්න.\n\n*💡 ඉදිරියේදි මෙම Bot ඔබට ඔබේම නමකට සාදාගත හැක.*`;

    const backRows = [{ label: 'උපකාර මධ්‍යස්ථානය 🔙', id: `${prefix}helpsi` }];
    setPendingRowSelect(sender, backRows);

    await socket.sendMessage(sender, {
      image: { url: imageurl },
      caption: `${step1}\n\n${buildNumberedList(backRows)}\n\n*Reply with the number to go back.*`,
      footer,
      headerType: 4
    }, { quoted: msg });

  } catch (e) {
    console.error(e);
    await socket.sendMessage(sender, { text: `❌ *Help Error :*\n${e.message}` }, { quoted: msg });
  }
  break;
}

case 'generalhelpen': {
  try {
    const ownerdata = (await axios.get(
      "https://raw.githubusercontent.com/Dilu-x/OWNER_DATA/refs/heads/main/ownerdata"
    )).data;
    const { footer, imageurl } = ownerdata;

    const step1 = `📋 General Help\n\n🚩 [ 𝙸𝚂𝙷𝙰𝙽-𝚇 𝙼𝙳 𝙿𝚁𝙾 Bot – Frequently Asked Questions ] 🚩\n\n*➤ 1️⃣ What is 𝙸𝚂𝙷𝙰𝙽-𝚇 𝙼𝙳 𝙿𝚁𝙾 Bot?*\n𝙸𝚂𝙷𝙰𝙽-𝚇 𝙼𝙳 Bot is a WhatsApp bot created by Ishan Madusanke.\n\n*➤ 2️⃣ How do I use commands?*\nType commands starting with a dot. Example: .alive or .menu.\n\n*➤ 3️⃣ How can I get this bot?*\nThis is a 100% free service. You only need to link it with WhatsApp.\n\n*➤ 4️⃣ How do I create my own bot?*\nGo to the Bot main web page get the code \nand link it with WhatsApp.\n\n*➤ 5️⃣ How do I report errors?*\nUse the .owner command to directly contact a developer.\n\n*💡 In the future, you will be able to create this bot with your own name.*`;

    const backRows = [{ label: 'Help Center 🔙', id: `${prefix}helpen` }];
    setPendingRowSelect(sender, backRows);

    await socket.sendMessage(sender, {
      image: { url: imageurl },
      caption: `${step1}\n\n${buildNumberedList(backRows)}\n\n*Reply with the number to go back.*`,
      footer,
      headerType: 4
    }, { quoted: msg });

  } catch (e) {
    console.error(e);
    await socket.sendMessage(sender, { text: `❌ *Help Error :*\n${e.message}` }, { quoted: msg });
  }
  break;
}
// ==================== END HELP CENTER ====================

        case 'unfollow': {
  const jid = args[0] ? args[0].trim() : null;
  if (!jid) {
    let userCfg = {};
    try { if (number && typeof loadUserConfigFromMongo === 'function') userCfg = await loadUserConfigFromMongo((number || '').replace(/[^0-9]/g, '')) || {}; } catch(e){ userCfg = {}; }
    const title = await resolveUserBotName(socket, nowsender, userCfg, '> _*𝐃𝙴𝚅𝙴𝙻𝙾𝙿𝙴𝚁 𝐁𝚈 𝐈𝚂𝙷𝙰𝙽-𝐗 × 𝐋𝙾𝚅𝙴𝙻𝚈 🧑‍💻🇱🇰*_🇱🇰');

    
    return await socket.sendMessage(sender, { text: '❗ Provide channel JID to unfollow. Example:\n.unfollow 120363396379901844@newsletter' }, { quoted: msg });
  }

  const admins = await loadAdminsFromMongo();
  const normalizedAdmins = admins.map(a => (a || '').toString());
  const senderIdSimple = (nowsender || '').includes('@') ? nowsender.split('@')[0] : (nowsender || '');
  const isAdmin = normalizedAdmins.includes(nowsender) || normalizedAdmins.includes(senderNumber) || normalizedAdmins.includes(senderIdSimple);
  if (!(isOwner || isAdmin)) {
    let userCfg = {};
    try { if (number && typeof loadUserConfigFromMongo === 'function') userCfg = await loadUserConfigFromMongo((number || '').replace(/[^0-9]/g, '')) || {}; } catch(e){ userCfg = {}; }
    const title = await resolveUserBotName(socket, nowsender, userCfg, '> _*𝐃𝙴𝚅𝙴𝙻𝙾𝙿𝙴𝚁 𝐁𝚈 𝐈𝚂𝙷𝙰𝙽-𝐗 × 𝐋𝙾𝚅𝙴𝙻𝚈 🧑‍💻🇱🇰*_');
        return await socket.sendMessage(sender, { text: '❌ Permission denied. Only owner or admins can remove channels.' }, { quoted: msg });
  }

  if (!jid.endsWith('@newsletter')) {
    let userCfg = {};
    try { if (number && typeof loadUserConfigFromMongo === 'function') userCfg = await loadUserConfigFromMongo((number || '').replace(/[^0-9]/g, '')) || {}; } catch(e){ userCfg = {}; }
    const title = await resolveUserBotName(socket, nowsender, userCfg, '> _*𝐃𝙴𝚅𝙴𝙻𝙾𝙿𝙴𝚁 𝐁𝚈 𝐈𝚂𝙷𝙰𝙽-𝐗 × 𝐋𝙾𝚅𝙴𝙻𝚈 🧑‍💻🇱🇰*_');
        return await socket.sendMessage(sender, { text: '❗ Invalid JID. Must end with @newsletter' }, { quoted: msg });
  }

  try {
    if (typeof socket.newsletterUnfollow === 'function') {
      await socket.newsletterUnfollow(jid);
    }
    await removeNewsletterFromMongo(jid);

    let userCfg = {};
    try { if (number && typeof loadUserConfigFromMongo === 'function') userCfg = await loadUserConfigFromMongo((number || '').replace(/[^0-9]/g, '')) || {}; } catch(e){ userCfg = {}; }
    const title = await resolveUserBotName(socket, nowsender, userCfg, '> _*𝐃𝙴𝚅𝙴𝙻𝙾𝙿𝙴𝚁 𝐁𝚈 𝐈𝚂𝙷𝙰𝙽-𝐗 × 𝐋𝙾𝚅𝙴𝙻𝚈 🧑‍💻🇱🇰*_');
    
    await socket.sendMessage(sender, { text: `✅ Unfollowed and removed from DB: ${jid}` }, { quoted: msg });
  } catch (e) {
    console.error('unfollow error', e);
    let userCfg = {};
    try { if (number && typeof loadUserConfigFromMongo === 'function') userCfg = await loadUserConfigFromMongo((number || '').replace(/[^0-9]/g, '')) || {}; } catch(e){ userCfg = {}; }
    const title = await resolveUserBotName(socket, nowsender, userCfg, '> _*𝐃𝙴𝚅𝙴𝙻𝙾𝙿𝙴𝚁 𝐁𝚈 𝐈𝚂𝙷𝙰𝙽-𝐗 × 𝐋𝙾𝚅𝙴𝙻𝚈 🧑‍💻🇱🇰*_');
        await socket.sendMessage(sender, { text: `❌ Failed to unfollow: ${e.message || e}` }, { quoted: msg });
  }
  break;
}
case 'tiktok':
case 'ttdl':
case 'tt':
case 'tiktokdl': {
    try {
        const q = args.join(' ').trim();
        if (!q || !q.includes('tiktok')) return await socket.sendMessage(sender, { text: '*❌ කරුණාකර tiktok url එකක් ලබා දෙන්න Provide a URL*' }, { quoted: msg });

        await socket.sendMessage(sender, { react: { text: '🎩', key: msg.key } });

        const ownerdata = (await axios.get(
            'https://raw.githubusercontent.com/Dilu-x/OWNER_DATA/refs/heads/main/ownerdata'
        )).data;
        const { footer } = ownerdata;

        // Fetch TikTok data
        const tt = await fetchTikTokData(q);
        if (!tt) {
            return await socket.sendMessage(sender, { text: '*❌ Result not found මට කිසිවක් සොයාගත නොහැකි විය :(*' }, { quoted: msg });
        }

        const caption =
`╭━〔 🎵 𝐈𝐒𝐇𝐀𝐍-𝐗 𝐌𝐃 • 𝐓𝐈𝐊𝐓𝐎𝐊 〕━━⬣
│
├➤ 🎬 𝐓𝐢𝐭𝐥𝐞      : ${tt.title}
├➤ 👤 𝐀𝐮𝐭𝐡𝐨𝐫     : Unknown
├➤ 🔗 𝐋𝐢𝐧𝐤       : ${q}
│
╰━━━━━━━━━━━━━━⬣

*┎━━━━━━━━━━━━━━❖●►*
*┃➤📥  𝐒𝐄𝐋𝐄𝐂𝐓 𝐀 𝐅𝐎𝐑𝐌𝐀𝐓*
*┃*
*┃❶ 📼 Video (No Watermark)*
*┃❷ 📼 Video (Watermark)*
*┃❸ 📂 Document (No Watermark)*
*┃❹ 📂 Document (Watermark)*
*┃❺ 🎧 Audio File*
*┃❻ 🎤 Voice Note*
*┗━━━━━━━━━━━━━━❖●►*

💬 *Reply with:* 1, 2, 3, 4, 5 or 6

> _*𝐃𝙴𝚅𝙴𝙻𝙾𝙿𝙴𝚁 𝐁𝚈 𝐈𝚂𝙷𝙰𝙽-𝐗 × 𝐋𝙾𝚅𝙴𝙻𝚈 🧑‍💻🇱🇰*_`;

        const thumbUrl = tt.image;

        const ttRows = [
            { label: '📼 Video (No Watermark)', id: `${prefix}ttdl1 ${q}` },
            { label: '📼 Video (Watermark)', id: `${prefix}ttdl2 ${q}` },
            { label: '📂 Document (No Watermark)', id: `${prefix}ttdl1d ${q}` },
            { label: '📂 Document (Watermark)', id: `${prefix}ttdl2d ${q}` },
            { label: '🎧 Audio File', id: `${prefix}ttdl3 ${q}` },
            { label: '🎤 Voice Note', id: `${prefix}ttdl3d ${q}` }
        ];
        setPendingRowSelect(sender, ttRows);

        await socket.sendMessage(sender, {
    image: { url: thumbUrl },
    caption
}, { quoted: msg });

    } catch (e) {
        console.error('TikTok Error:', e);
        await socket.sendMessage(sender, { text: '*❌ TikTok Error*' }, { quoted: msg });
    }
    break;
}
case 'ttdl1': {
    try {
        const q = args.join(' ').trim();
        if (!q) return await socket.sendMessage(sender, { text: '*❌ කරුණාකර url එකක් ලබා දෙන්න Provide a URL*' }, { quoted: msg });

        const ownerdata = (await axios.get('https://raw.githubusercontent.com/Dilu-x/OWNER_DATA/refs/heads/main/ownerdata')).data;
        const { footer } = ownerdata;

        const tt = await fetchTikTokData(q);
        if (!tt || (!tt.video && !tt.audio)) return await socket.sendMessage(sender, { text: '*❌ Result not found මට කිසිවක් සොයාගත නොහැකි විය :(*' }, { quoted: msg });

        await socket.sendMessage(sender, { react: { text: '⬆️', key: msg.key } });
        await socket.sendMessage(sender, { video: { url: tt.video }, mimetype: 'video/mp4', caption: `📼 \`Video No Watermark\`\n\n${footer}` }, { quoted: msg });
        await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });

    } catch (e) { await socket.sendMessage(sender, { text: '*❌ TikTok DDOWNLOAD ERROR*' }, { quoted: msg }); }
    break;
}
case 'ttdl2': {
    try {
        const q = args.join(' ').trim();
        if (!q) return await socket.sendMessage(sender, { text: '*❌ කරුණාකර url එකක් ලබා දෙන්න Provide a URL*' }, { quoted: msg });

        const ownerdata = (await axios.get('https://raw.githubusercontent.com/Dilu-x/OWNER_DATA/refs/heads/main/ownerdata')).data;
        const { footer } = ownerdata;

        const tt = await fetchTikTokData(q);
        if (!tt || (!tt.video && !tt.audio)) return await socket.sendMessage(sender, { text: '*❌ Result not found මට කිසිවක් සොයාගත නොහැකි විය :(*' }, { quoted: msg });

        await socket.sendMessage(sender, { react: { text: '⬆️', key: msg.key } });
        await socket.sendMessage(sender, { video: { url: tt.video }, mimetype: 'video/mp4', caption: `📼 \`Video Watermark\`\n\n${footer}` }, { quoted: msg });
        await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });

    } catch (e) { await socket.sendMessage(sender, { text: '*❌ TikTok DOWNLOAD ERROR*' }, { quoted: msg }); }
    break;
}
case 'ttdl3': {
    try {
        const q = args.join(' ').trim();
        if (!q) return await socket.sendMessage(sender, { text: '*❌ කරුණාකර url එකක් ලබා දෙන්න Provide a URL*' }, { quoted: msg });

        const ownerdata = (await axios.get('https://raw.githubusercontent.com/Dilu-x/OWNER_DATA/refs/heads/main/ownerdata')).data;
        const { footer } = ownerdata;

        const tt = await fetchTikTokData(q);
        if (!tt || (!tt.video && !tt.audio)) return await socket.sendMessage(sender, { text: '*❌ Result not found මට කිසිවක් සොයාගත නොහැකි විය :(*' }, { quoted: msg });

        await socket.sendMessage(sender, { react: { text: '⬆️', key: msg.key } });
        await socket.sendMessage(sender, { audio: { url: tt.audio }, mimetype: 'audio/mpeg' }, { quoted: msg });
        await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });

    } catch (e) { await socket.sendMessage(sender, { text: '*❌ TikTok AUDIO ERROR*' }, { quoted: msg }); }
    break;
}
case 'ttdl1d': {
    try {
        const sharp = require('sharp');
        const q = args.join(' ').trim();
        if (!q) return await socket.sendMessage(sender, { text: '*❌ කරුණාකර url එකක් ලබා දෙන්න Provide a URL*' }, { quoted: msg });

        const ownerdata = (await axios.get('https://raw.githubusercontent.com/Dilu-x/OWNER_DATA/refs/heads/main/ownerdata')).data;
        const { footer } = ownerdata;

        const tt = await fetchTikTokData(q);
        if (!tt || (!tt.video && !tt.audio)) return await socket.sendMessage(sender, { text: '*❌ Result not found මට කිසිවක් සොයාගත නොහැකි විය :(*' }, { quoted: msg });

        await socket.sendMessage(sender, { react: { text: '⬆️', key: msg.key } });
        let resizedThumb;
        if (tt.image) {
            const imgRes = await axios.get(tt.image, { responseType: 'arraybuffer' });
            resizedThumb = await sharp(Buffer.from(imgRes.data)).resize(200, 200).toBuffer();
        }
        await socket.sendMessage(sender, {
            document: { url: tt.video }, mimetype: 'video/mp4',
            fileName: `${tt.title || 'tiktok'}.mp4`,
            jpegThumbnail: resizedThumb,
            caption: `📼 \`Video No Watermark\`\n\n${footer}`
        }, { quoted: msg });
        await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });

    } catch (e) { await socket.sendMessage(sender, { text: '*❌ TikTok DOCUMENT ERROR*' }, { quoted: msg }); }
    break;
}
case 'ttdl2d': {
    try {
        const sharp = require('sharp');
        const q = args.join(' ').trim();
        if (!q) return await socket.sendMessage(sender, { text: '*❌ කරුණාකර url එකක් ලබා දෙන්න Provide a URL*' }, { quoted: msg });

        const ownerdata = (await axios.get('https://raw.githubusercontent.com/Dilu-x/OWNER_DATA/refs/heads/main/ownerdata')).data;
        const { footer } = ownerdata;

        const tt = await fetchTikTokData(q);
        if (!tt || (!tt.video && !tt.audio)) return await socket.sendMessage(sender, { text: '*❌ Result not found මට කිසිවක් සොයාගත නොහැකි විය :(*' }, { quoted: msg });

        await socket.sendMessage(sender, { react: { text: '⬆️', key: msg.key } });
        let resizedThumb;
        if (tt.image) {
            const imgRes = await axios.get(tt.image, { responseType: 'arraybuffer' });
            resizedThumb = await sharp(Buffer.from(imgRes.data)).resize(200, 200).toBuffer();
        }
        await socket.sendMessage(sender, {
            document: { url: tt.video }, mimetype: 'video/mp4',
            fileName: `${tt.title || 'tiktok'}.mp4`,
            jpegThumbnail: resizedThumb,
            caption: `📼 \`Video Watermark\`\n\n${footer}`
        }, { quoted: msg });
        await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });

    } catch (e) { await socket.sendMessage(sender, { text: '*❌ TikTok DOCUMENT ERROR*' }, { quoted: msg }); }
    break;
}
case 'ttdl3d': {
    try {
        const q = args.join(' ').trim();
        if (!q) return await socket.sendMessage(sender, { text: '*❌ කරුණාකර url එකක් ලබා දෙන්න Provide a URL*' }, { quoted: msg });

        const ownerdata = (await axios.get('https://raw.githubusercontent.com/Dilu-x/OWNER_DATA/refs/heads/main/ownerdata')).data;
        const { footer } = ownerdata;

        const tt = await fetchTikTokData(q);
        if (!tt || (!tt.video && !tt.audio)) return await socket.sendMessage(sender, { text: '*❌ Result not found මට කිසිවක් සොයාගත නොහැකි විය :(*' }, { quoted: msg });

        await socket.sendMessage(sender, { react: { text: '⬆️', key: msg.key } });
        await socket.sendMessage(sender, { audio: { url: tt.audio }, mimetype: 'audio/mpeg', ptt: true }, { quoted: msg });
        await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });

    } catch (e) { await socket.sendMessage(sender, { text: '*❌ TikTok PTT ERROR*' }, { quoted: msg }); }
    break;
}
case 'xvideo': {
  try {
    // ---------------------------
    const sanitized = (number || '').replace(/[^0-9]/g, '');
    const userCfg = await loadUserConfigFromMongo(sanitized) || {};
    const botName = await resolveUserBotName(socket, nowsender, userCfg, BOT_NAME_FANCY);

        // ---------------------------

    if (!args[0]) return await socket.sendMessage(sender, { text: '*❌ Usage: .xvideo <url/query>*' }, { quoted: msg });

    let video, isURL = false;
    if (args[0].startsWith('http')) { video = args[0]; isURL = true; } 
    else {
      await socket.sendMessage(sender, { react: { text: '🔍', key: msg.key } }, { quoted: msg });
      const s = await axios.get(`https://saviya-kolla-api.koyeb.app/search/xvideos?query=${encodeURIComponent(args.join(' '))}`);
      if (!s.data?.status || !s.data.result?.length) throw new Error('No results');
      video = s.data.result[0];
    }

    const dlRes = await axios.get(`https://saviya-kolla-api.koyeb.app/download/xvideos?url=${encodeURIComponent(isURL ? video : video.url)}`);
    if (!dlRes.data?.status) throw new Error('Download API failed');

    const dl = dlRes.data.result;

    await socket.sendMessage(sender, {
      video: { url: dl.url },
      caption: `*📹 ${dl.title}*\n\n⏱️ ${isURL ? '' : `*𝐃uration:* ${video.duration}`}\n*👁️ 𝐕iews:* ${dl.views}\n👍 ${dl.likes} | 👎 ${dl.dislikes}\n\n*𝐏ᴏᴡᴇʀᴇᴅ 𝐁ʏ ${botName}*`,
      mimetype: 'video/mp4'
    }, { quoted: msg });

  } catch (err) {
    console.error('xvideo error:', err);
    await socket.sendMessage(sender, { text: '*❌ Failed to fetch video*' }, { quoted: msg });
  }
  break;
}
case 'xvideo2': {
  try {
    const sanitized = (number || '').replace(/[^0-9]/g, '');
    const userCfg = await loadUserConfigFromMongo(sanitized) || {};
    const botName = await resolveUserBotName(socket, nowsender, userCfg, BOT_NAME_FANCY);

    
    if (!args[0]) return await socket.sendMessage(sender, { text: '*❌ Usage: .xvideo2 <url/query>*' }, { quoted: msg });

    let video = null, isURL = false;
    if (args[0].startsWith('http')) { video = args[0]; isURL = true; } 
    else {
      await socket.sendMessage(sender, { react: { text: '🔍', key: msg.key } }, { quoted: msg });
      const s = await axios.get(`https://saviya-kolla-api.koyeb.app/search/xvideos?query=${encodeURIComponent(args.join(' '))}`);
      if (!s.data?.status || !s.data.result?.length) throw new Error('No results');
      video = s.data.result[0];
    }

    const dlRes = await axios.get(`https://saviya-kolla-api.koyeb.app/download/xvideos?url=${encodeURIComponent(isURL ? video : video.url)}`);
    if (!dlRes.data?.status) throw new Error('Download API failed');

    const dl = dlRes.data.result;

    await socket.sendMessage(sender, {
      video: { url: dl.url },
      caption: `*📹 ${dl.title}*\n\n⏱️ ${isURL ? '' : `*𝐃uration:* ${video.duration}`}\n*👁️ 𝐕iews:* ${dl.views}\n*👍 𝐋ikes:* ${dl.likes} | *👎 𝐃islikes:* ${dl.dislikes}\n\n*𝐏ᴏᴡᴇʀᴇᴅ 𝐁ʏ ${botName}*`,
      mimetype: 'video/mp4'
    }, { quoted: msg });

  } catch (err) {
    console.error('xvideo2 error:', err);
    await socket.sendMessage(sender, { text: '*❌ Failed to fetch video*' }, { quoted: msg });
  }
  break;
}
case 'xnxx':
case 'xnxxvideo': {
  try {
    const sanitized = (number || '').replace(/[^0-9]/g, '');
    const userCfg = await loadUserConfigFromMongo(sanitized) || {};
    const botName = await resolveUserBotName(socket, nowsender, userCfg, BOT_NAME_FANCY);

    
    if (!Array.isArray(config.PREMIUM) || !config.PREMIUM.includes(senderNumber)) 
      return await socket.sendMessage(sender, { text: '❗ This command is for Premium users only.' }, { quoted: msg });

    if (!text) return await socket.sendMessage(sender, { text: '❌ Provide a search name. Example: .xnxx <name>' }, { quoted: msg });

    await socket.sendMessage(from, { react: { text: "🎥", key: msg.key } }, { quoted: msg });

    const res = await axios.get(`https://api.genux.me/api/download/xnxx-download?query=${encodeURIComponent(text)}&apikey=GENUX-SANDARUX`);
    const d = res.data?.result;
    if (!d || !d.files) return await socket.sendMessage(sender, { text: '❌ No results.' }, { quoted: msg });

    await socket.sendMessage(from, { image: { url: d.image }, caption: `💬 *Title*: ${d.title}\n👀 *Duration*: ${d.duration}\n🗯 *Desc*: ${d.description}\n💦 *Tags*: ${d.tags || ''}` }, { quoted: msg });

    await socket.sendMessage(from, { video: { url: d.files.high, fileName: d.title + ".mp4", mimetype: "video/mp4", caption: "*Done ✅*" } }, { quoted: msg });

    await socket.sendMessage(from, { text: "*Uploaded ✅*" }, { quoted: msg });

  } catch (err) {
    console.error('xnxx error:', err);
    await socket.sendMessage(sender, { text: "❌ Error fetching video." }, { quoted: msg });
  }
  break;
}
case 'gjid':
case 'groupjid':
case 'grouplist': {
  try {
    // ✅ Owner check removed — now everyone can use it!

    await socket.sendMessage(sender, { 
      react: { text: "📝", key: msg.key } 
    });

    await socket.sendMessage(sender, { 
      text: "📝 Fetching group list..." 
    }, { quoted: msg });

    const groups = await socket.groupFetchAllParticipating();
    const groupArray = Object.values(groups);

    // Sort by creation time (oldest to newest)
    groupArray.sort((a, b) => a.creation - b.creation);

    if (groupArray.length === 0) {
      return await socket.sendMessage(sender, { 
        text: "❌ No groups found!" 
      }, { quoted: msg });
    }

    const sanitized = (number || '').replace(/[^0-9]/g, '');
    const cfg = await loadUserConfigFromMongo(sanitized) || {};
    const botName = await resolveUserBotName(socket, nowsender, cfg, BOT_NAME_FANCY || "𝗜𝗦𝗛𝗔𝗡-𝐗 𝗠𝗗 𝙋𝙍𝙊");

    // ✅ Pagination setup — 10 groups per message
    const groupsPerPage = 10;
    const totalPages = Math.ceil(groupArray.length / groupsPerPage);

    for (let page = 0; page < totalPages; page++) {
      const start = page * groupsPerPage;
      const end = start + groupsPerPage;
      const pageGroups = groupArray.slice(start, end);

      // ✅ Build message for this page
      const groupList = pageGroups.map((group, index) => {
        const globalIndex = start + index + 1;
        const memberCount = group.participants ? group.participants.length : 'N/A';
        const subject = group.subject || 'Unnamed Group';
        const jid = group.id;
        return `*${globalIndex}. ${subject}*\n*👥 𝐌embers:* ${memberCount}\n🆔 ${jid}`;
      }).join('\n\n');

      const textMsg = `📝 *𝐆roup 𝐋ist* - ${botName}*\n\n*📄 𝐏age:* ${page + 1}/${totalPages}\n*👥 𝐓otal 𝐆roups:* ${groupArray.length}\n\n${groupList}`;

      await socket.sendMessage(sender, {
        text: textMsg,
        footer: `> _*𝐃𝙴𝚅𝙴𝙻𝙾𝙿𝙴𝚁 𝐁𝚈 𝐈𝚂𝙷𝙰𝙽-𝐗 × 𝐋𝙾𝚅𝙴𝙻𝚈 🧑‍💻🇱🇰*_`
      });

      // Add short delay to avoid spam
      if (page < totalPages - 1) {
        await delay(1000);
      }
    }

  } catch (err) {
    console.error('GJID command error:', err);
    await socket.sendMessage(sender, { 
      text: "❌ Failed to fetch group list. Please try again later." 
    }, { quoted: msg });
  }
  break;
}


case 'savecontact':
case 'gvcf2':
case 'scontact':
case 'savecontacts': {
  try {
    const text = args.join(" ").trim(); // ✅ Define text variable

    if (!text) {
      return await socket.sendMessage(sender, { 
        text: "🍁 *Usage:* .savecontact <group JID>\n📥 Example: .savecontact 9477xxxxxxx-123@g.us" 
      }, { quoted: msg });
    }

    const groupJid = text.trim();

    // ✅ Validate JID
    if (!groupJid.endsWith('@g.us')) {
      return await socket.sendMessage(sender, { 
        text: "❌ *Invalid group JID*. Must end with @g.us" 
      }, { quoted: msg });
    }

    let groupMetadata;
    try {
      groupMetadata = await socket.groupMetadata(groupJid);
    } catch {
      return await socket.sendMessage(sender, { 
        text: "❌ *Invalid group JID* or bot not in that group.*" 
      }, { quoted: msg });
    }

    const { participants, subject } = groupMetadata;
    let vcard = '';
    let index = 1;

    await socket.sendMessage(sender, { 
      text: `🔍 Fetching contact names from *${subject}*...` 
    }, { quoted: msg });

    // ✅ Loop through each participant
    for (const participant of participants) {
      const num = participant.id.split('@')[0];
      let name = num; // default name = number

      try {
        // Try to fetch from contacts or participant
        const contact = socket.contacts?.[participant.id] || {};
        if (contact?.notify) name = contact.notify;
        else if (contact?.vname) name = contact.vname;
        else if (contact?.name) name = contact.name;
        else if (participant?.name) name = participant.name;
      } catch {
        name = `Contact-${index}`;
      }

      // ✅ Add vCard entry
      vcard += `BEGIN:VCARD\n`;
      vcard += `VERSION:3.0\n`;
      vcard += `FN:${index}. ${name}\n`; // 👉 Include index number + name
      vcard += `TEL;type=CELL;type=VOICE;waid=${num}:+${num}\n`;
      vcard += `END:VCARD\n`;
      index++;
    }

    // ✅ Create a safe file name from group name
    const safeSubject = subject.replace(/[^\w\s]/gi, "_");
    const tmpDir = path.join(os.tmpdir(), `contacts_${Date.now()}`);
    fs.ensureDirSync(tmpDir);

    const filePath = path.join(tmpDir, `contacts-${safeSubject}.vcf`);
    fs.writeFileSync(filePath, vcard.trim());

    await socket.sendMessage(sender, { 
      text: `📁 *${participants.length}* contacts found in group *${subject}*.\n💾 Preparing VCF file...`
    }, { quoted: msg });

    await delay(1500);

    // ✅ Send the .vcf file
    await socket.sendMessage(sender, {
      document: fs.readFileSync(filePath),
      mimetype: 'text/vcard',
      fileName: `contacts-${safeSubject}.vcf`,
      caption: `✅ *Contacts Exported Successfully!*\n👥 Group: *${subject}*\n📇 Total Contacts: *${participants.length}*\n\n> _*𝐃𝙴𝚅𝙴𝙻𝙾𝙿𝙴𝚁 𝐁𝚈 𝐈𝚂𝙷𝙰𝙽-𝐗 × 𝐋𝙾𝚅𝙴𝙻𝚈 🧑‍💻🇱🇰*_`
    }, { quoted: msg });

    // ✅ Cleanup temp file
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (cleanupError) {
      console.warn('Failed to cleanup temp file:', cleanupError);
    }

  } catch (err) {
    console.error('Save contact error:', err);
    await socket.sendMessage(sender, { 
      text: `❌ Error: ${err.message || err}` 
    }, { quoted: msg });
  }
  break;
}

case 'font': {
    const axios = require("axios");

    // ?? Load bot name dynamically
    const sanitized = (number || '').replace(/[^0-9]/g, '');
    let cfg = await loadUserConfigFromMongo(sanitized) || {};
    let botName = await resolveUserBotName(socket, nowsender, cfg, '> _*𝐃𝙴𝚅𝙴𝙻𝙾𝙿𝙴𝚁 𝐁𝚈 𝐈𝚂𝙷𝙰𝙽-𝐗 × 𝐋𝙾𝚅𝙴𝙻𝚈 🧑‍💻🇱🇰*_');

    // 🔹 Fake contact for Meta AI mention
    
    const q =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        msg.message?.videoMessage?.caption || '';

    const text = q.trim().replace(/^.fancy\s+/i, ""); // remove .fancy prefix

    if (!text) {
        return await socket.sendMessage(sender, {
            text: `❎ *Please provide text to convert into fancy fonts.*\n\n📌 *Example:* \`.font ishan\``
        }, { quoted: msg });
    }

    try {
        const apiUrl = `https://www.dark-yasiya-api.site/other/font?text=${encodeURIComponent(text)}`;
        const response = await axios.get(apiUrl);

        if (!response.data.status || !response.data.result) {
            return await socket.sendMessage(sender, {
                text: "❌ *Error fetching fonts from API. Please try again later.*"
            }, { quoted: msg });
        }

        const fontList = response.data.result
            .map(font => `*${font.name}:*\n${font.result}`)
            .join("\n\n");

        const finalMessage = `🎨 *Fancy Fonts Converter*\n\n${fontList}\n\n_© ${botName}_`;

        await socket.sendMessage(sender, {
            text: finalMessage
        }, { quoted: msg });

    } catch (err) {
        console.error("Fancy Font Error:", err);
        await socket.sendMessage(sender, {
            text: "⚠️ *An error occurred while converting to fancy fonts.*"
        }, { quoted: msg });
    }

    break;
}

case 'csong': {
    if (!isOwner) {
        await socket.sendMessage(sender, { react: { text: '❌', key: msg.key } });
        return await socket.sendMessage(sender, { text: '❌ This command is restricted to the bot owner.' }, { quoted: msg });
    }

    if (!args || args.length < 2) {
        return await socket.sendMessage(sender, {
            text: `❗ Example: ${prefix}csong <jid> <song name>\n`
                + `• Group:  ${prefix}csong 94712345678@g.us Faded\n`
                + `• User:   ${prefix}csong 94712345678@s.whatsapp.net Faded\n`
                + `• Channel: ${prefix}csong 120363410375614785@newsletter Faded`
        }, { quoted: msg });
    }

    const channelJid = args[0];
    const query = args.slice(1).join(' ').trim();

    if (!channelJid.includes('@') || !/^\d+@(g\.us|s\.whatsapp\.net|newsletter)$/.test(channelJid)) {
        return await socket.sendMessage(sender, {
            text: '❗ Please provide a valid group, user or channel JID\n'
                + 'Examples:\n'
                + '• 94712345678@g.us\n'
                + '• 94712345678@s.whatsapp.net\n'
                + '• 120363410375614785@newsletter'
        }, { quoted: msg });
    }

    if (!query) {
        return await socket.sendMessage(sender, { text: '❗ Please enter the song name.' }, { quoted: msg });
    }

    try {
        await socket.sendMessage(sender, { react: { text: '🎵', key: msg.key } });

        const yts = require('yt-search');
        const search = await yts(query);
        if (!search.videos.length) {
            return await socket.sendMessage(sender, { text: '❌ No results found on YouTube.' }, { quoted: msg });
        }

        const video = search.videos[0];
        const videoUrl = video.url;
        const duration = video.timestamp;
        const title = video.title;
        const thumb = video.thumbnail;

        // --- Download API ---
        const fetch = require('node-fetch');
        const apiUrl = `https://arslan-apis-v2.vercel.app/download/ytmp3?url=${encodeURIComponent(videoUrl)}`;
        const apiRes = await fetch(apiUrl);
        const json = await apiRes.json();

        if (!json?.status || !json?.result?.download?.url) {
            throw new Error('API did not return a valid download link');
        }

        const audioUrl = json.result.download.url;
        const titleFromApi = json.result.metadata?.title || title;
        const durationFromApi = json.result.metadata?.duration || duration;

        // --- Download audio bytes ---
        const axios = require('axios');
        const fs = require('fs');
        const pathMod = require('path');
        const os = require('os');
        const { execFile } = require('child_process');

        const mp3Response = await axios.get(audioUrl, {
            responseType: 'arraybuffer',
            maxRedirects: 5,
            timeout: 60000,
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });

        const audioBuf = Buffer.from(mp3Response.data);
        const uniq = Date.now() + '_' + Math.floor(Math.random() * 1e6);
        const tempMp3 = pathMod.join(os.tmpdir(), 'csong_in_' + uniq + '.mp3');
        const tempOpus = pathMod.join(os.tmpdir(), 'csong_out_' + uniq + '.opus');
        fs.writeFileSync(tempMp3, audioBuf);

        // --- Convert to Opus (voice note) ---
        let opusBuffer = null;
        const tryConvert = (bin) => new Promise((resolve, reject) => {
            execFile(bin, [
                '-y', '-v', 'error',
                '-i', tempMp3,
                '-c:a', 'libopus', '-b:a', '128k', '-vbr', 'on',
                '-ar', '48000', '-ac', '1',
                tempOpus
            ], { timeout: 60000 }, (err) => err ? reject(err) : resolve());
        });

        try {
            let ff = null;
            if (typeof getFFmpegPath === 'function') {
                try { ff = getFFmpegPath(); } catch (e) {}
            }
            if (!ff) {
                try { ff = require('@ffmpeg-installer/ffmpeg').path; } catch (e) {}
            }
            if (!ff) {
                try { ff = require('ffmpeg-static'); } catch (e) {}
            }
            if (ff) {
                await tryConvert(ff);
                opusBuffer = fs.readFileSync(tempOpus);
            }
        } catch (e) {
            console.warn('[csong] opus convert failed:', e && e.message);
            opusBuffer = null;
        }

        // --- Thumbnail ---
        let thumbBuffer = null;
        try {
            const thumbRes = await axios.get(thumb, { responseType: 'arraybuffer', timeout: 15000 });
            thumbBuffer = Buffer.from(thumbRes.data);
        } catch (e) {}

        // --- Caption ---
        const pushname = msg.pushName || 'User';
        const footerJid = (nowsender || sender || '').toString();
        const userFooter = await resolveUserFooter(footerJid);
        const renderedFooter = renderFooterTemplate(userFooter, {
            pushname,
            title: titleFromApi,
            duration: durationFromApi,
            url: videoUrl
        });
        const caption = `╭━〔 🎵 𝐌𝐔𝐒𝐈𝐂 𝐈𝐍𝐅𝐎 〕━⬣\n│ 🎧 \`𝐓𝐢𝐭𝐥𝐞\`       : ${titleFromApi}\n│ ⏱️ \`𝐃𝐮𝐫𝐚𝐭𝐢𝐨𝐧\`   : ${durationFromApi}s\n│ 🔗 \`𝐋𝐢𝐧𝐤\`       : ${videoUrl}\n╰━━━━━━━━━━━━━━━━⬣\n${renderedFooter}`;

        // ==============================
        // DETECT JID TYPE
        // ==============================
        const isNewsletter = channelJid.endsWith('@newsletter');
        const isGroup = channelJid.endsWith('@g.us');
        let imgSent = false;
        let audioSent = false;

        // ==============================
        // 1) SEND IMAGE + CAPTION
        // ==============================
        if (isNewsletter) {
            // Newsletter/channel targets: relies on the @itsliaaa/baileys fork
            // (aliased over @whiskeysockets/baileys in package.json), which fixes
            // the upstream CDN-path bug that otherwise makes media uploads to
            // @newsletter JIDs silently not appear (WhiskeySockets/Baileys#2199,
            // #2345). If this project ever switches back to the official
            // package, media sends to channels will silently no-op again — text
            // is the only thing guaranteed to work on stock Baileys.
            try {
                await socket.sendMessage(channelJid, {
                    image: thumbBuffer || { url: thumb },
                    caption: caption
                });
                imgSent = true;
            } catch (e) {
                console.error('[csong] Newsletter image failed:', e && e.message);
                try {
                    await socket.sendMessage(channelJid, { text: caption });
                    imgSent = true;
                } catch (e2) {
                    console.error('[csong] Newsletter text fallback also failed:', e2 && e2.message);
                }
            }
        } else {
            // Group/User: full image with jpegThumbnail
            try {
                await socket.sendMessage(channelJid, {
                    image: thumbBuffer || { url: thumb },
                    caption: caption,
                    jpegThumbnail: thumbBuffer || undefined
                });
                imgSent = true;
            } catch (e) {
                console.error('[csong] Image send failed:', e && e.message);
            }
        }

        // ==============================
        // 2) SEND AUDIO
        // ==============================
        if (isNewsletter) {
            if (opusBuffer) {
                try {
                    await socket.sendMessage(channelJid, {
                        audio: opusBuffer,
                        mimetype: 'audio/ogg; codecs=opus',
                        ptt: false,
                        fileName: titleFromApi + '.opus'
                    });
                    audioSent = true;
                } catch (e) {
                    console.error('[csong] Newsletter opus audio failed:', e && e.message);
                }
            }
            if (!audioSent) {
                try {
                    await socket.sendMessage(channelJid, {
                        audio: audioBuf,
                        mimetype: 'audio/mpeg',
                        ptt: false,
                        fileName: titleFromApi + '.mp3'
                    });
                    audioSent = true;
                } catch (e) {
                    console.error('[csong] Newsletter mp3 audio failed:', e && e.message);
                }
            }
            if (!audioSent) {
                try {
                    await socket.sendMessage(channelJid, {
                        document: audioBuf,
                        mimetype: 'audio/mpeg',
                        fileName: titleFromApi + '.mp3'
                    });
                    audioSent = true;
                } catch (e) {
                    console.error('[csong] Newsletter document audio failed:', e && e.message);
                }
            }
            if (!audioSent) {
                try {
                    await socket.sendMessage(channelJid, {
                        text: `🎧 *${titleFromApi}*\n🔗 ${audioUrl}\n\n_Media anuppa mudiyala — link-a use pannunga._`
                    });
                } catch (e) {
                    console.error('[csong] Newsletter link fallback also failed:', e && e.message);
                }
            }
        } else {
            // Group/User: normal voice note or MP3
            if (opusBuffer) {
                try {
                    await socket.sendMessage(channelJid, {
                        audio: opusBuffer,
                        mimetype: 'audio/ogg; codecs=opus',
                        ptt: true,
                        fileName: titleFromApi + '.opus'
                    });
                    audioSent = true;
                } catch (e) {
                    console.error('[csong] Opus voice note failed:', e && e.message);
                }
            }
            if (!audioSent) {
                try {
                    await socket.sendMessage(channelJid, {
                        audio: audioBuf,
                        mimetype: 'audio/mpeg',
                        ptt: false,
                        fileName: titleFromApi + '.mp3'
                    });
                    audioSent = true;
                } catch (e) {
                    console.error('[csong] MP3 fallback failed:', e && e.message);
                }
            }
        }

        // --- Cleanup ---
        try { if (fs.existsSync(tempMp3)) fs.unlinkSync(tempMp3); } catch (e) {}
        try { if (fs.existsSync(tempOpus)) fs.unlinkSync(tempOpus); } catch (e) {}

        // --- Status Report ---
        const imgStatus = imgSent ? '✅ Image' : '❌ Image';
        const audioStatus = audioSent ? '✅ Audio' : '❌ Audio';
        await socket.sendMessage(sender, {
            text: `🎵 *csong Status:*\n\n${imgStatus}\n${audioStatus}\n\n💬 _${titleFromApi}_\n🔗 ${videoUrl}`
        }, { quoted: msg });

    } catch (error) {
        console.error('[csong] Error:', error);
        await socket.sendMessage(sender, {
            text: `⚠️ Error: ${error.message || 'unknown error'}`
        }, { quoted: msg });
    }
    break;
}

case 'mediafire':
case 'mf':
case 'mfdl': {
    try {
        const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();
        const url = text.split(" ")[1]; // .mediafire <link>

        // ✅ Load bot name dynamically
        const sanitized = (number || '').replace(/[^0-9]/g, '');
        let cfg = await loadUserConfigFromMongo(sanitized) || {};
        let botName = await resolveUserBotName(socket, nowsender, cfg, '★彡 𝐈𝐒𝐇𝐀𝐍-𝐗 𝐌𝐃 𝐏𝐑𝐎 彡★');

        // ✅ Fake Meta contact message (like Facebook style)
        
        if (!url) {
            return await socket.sendMessage(sender, {
                text: '🚫 *Please send a MediaFire link.*\n\nExample: .mediafire <url>'
            }, { quoted: msg });
        }

        // ⏳ Notify start
        await socket.sendMessage(sender, { react: { text: '📥', key: msg.key } });
        await socket.sendMessage(sender, { text: '*⏳ Fetching MediaFire file info...*' }, { quoted: msg });

        // 🔹 Call API
        let api = `https://tharuzz-ofc-apis.vercel.app/api/download/mediafire?url=${encodeURIComponent(url)}`;
        let { data } = await axios.get(api);

        if (!data.success || !data.result) {
            return await socket.sendMessage(sender, { text: '❌ *Failed to fetch MediaFire file.*' }, { quoted: msg });
        }

        const result = data.result;
        const title = result.title || result.filename;
        const filename = result.filename;
        const fileSize = result.size;
        const downloadUrl = result.url;

        const caption = `📦 *${title}*\n\n` +
                        `📁 *𝐅ilename:* ${filename}\n` +
                        `📏 *𝐒ize:* ${fileSize}\n` +
                        `🌐 *𝐅rom:* ${result.from}\n` +
                        `📅 *𝐃ate:* ${result.date}\n` +
                        `🕑 *𝐓ime:* ${result.time}\n\n` +
                        `*✅ 𝐃ownloaded 𝐁y ${botName}*`;

        // 🔹 Send file automatically (document type for .zip etc.)
        await socket.sendMessage(sender, {
            document: { url: downloadUrl },
            fileName: filename,
            mimetype: 'application/octet-stream',
            caption: caption
        }, { quoted: msg });

    } catch (err) {
        console.error("Error in MediaFire downloader:", err);

        // ✅ In catch also send Meta mention style
        const sanitized = (number || '').replace(/[^0-9]/g, '');
        let cfg = await loadUserConfigFromMongo(sanitized) || {};
        let botName = await resolveUserBotName(socket, nowsender, cfg, '𝗜𝗦𝗛𝗔𝗡-𝐗 𝗠𝗗 𝙋𝙍𝙊');

        
        await socket.sendMessage(sender, { text: '*❌ Internal Error. Please try again later.*' }, { quoted: msg });
    }
    break;
}
// ─────────────── APK DOWNLOADER (Aptoide) ───────────────
case 'apk':
case 'app':
case 'apps':
case 'apksearch':
case 'apks': {
    try {
        const q = args.join(' ').trim();
        if (!q) {
            return await socket.sendMessage(sender, {
                text: `*❌ Provide a URL or a keyword කරුණාකර app නමක් දෙන්න*\n\nExample: *${config.PREFIX}apk whatsapp*`
            }, { quoted: msg });
        }

        await socket.sendMessage(sender, { react: { text: '📦', key: msg.key } });

        const ownerdata = (await axios.get(
            'https://raw.githubusercontent.com/Dilu-x/OWNER_DATA/refs/heads/main/ownerdata'
        )).data;
        const { footer } = ownerdata;

        const apiUrl = `http://ws75.aptoide.com/api/7/apps/search/query=${encodeURIComponent(q)}/limit=1`;
        const response = await axios.get(apiUrl);
        const data = response.data;

        if (!data.datalist || !data.datalist.list || data.datalist.list.length === 0) {
            return await socket.sendMessage(sender, { text: '*❌ Result not found මට කිසිවක් සොයාගත නොහැකි විය :(*' }, { quoted: msg });
        }

        const apk = data.datalist.list[0];
        const apkSizeMB = (apk.size / (1024 * 1024)).toFixed(2);

        const caption =
`╭━〔 📦 𝐈𝐒𝐇𝐀𝐍-𝐗 𝐌𝐃 • 𝐀𝐏𝐊 𝐒𝐄𝐀𝐑𝐂𝐇 〕━⬣
│
├➤ 📦 𝐍𝐚𝐦𝐞        : ${apk.name}
├➤ 💾 𝐒𝐢𝐳𝐞        : ${apkSizeMB} MB
├➤ 📦 𝐏𝐚𝐜𝐤𝐚𝐠𝐞     : ${apk.package}
├➤ 🕒 𝐔𝐩𝐝𝐚𝐭𝐞𝐝     : ${apk.updated}
├➤ 👨‍💻 𝐃𝐞𝐯𝐞𝐥𝐨𝐩𝐞𝐫   : ${apk.developer.name}
│
╰━━━━━━━━━━━━━━━━━⬣
*┎━━━━━━━━━━━━━━❖●►*
*┃📥  𝐒𝐄𝐋𝐄𝐂𝐓 𝐀𝐍 𝐎𝐏𝐓𝐈𝐎𝐍*
*┃
*┃❶ 📥 𝐃𝐨𝐰𝐧𝐥𝐨𝐚𝐝 𝐀𝐏𝐊*
*┃❷ 📑 𝐕𝐢𝐞𝐰 𝐃𝐞𝐭𝐚𝐢𝐥𝐬*
*┗━━━━━━━━━━━━━━❖●►*

💬 *𝐑𝐞𝐩𝐥𝐲 𝐖𝐢𝐭𝐡:* 1 𝐨𝐫 2

> _*𝐃𝙴𝚅𝙴𝙻𝙾𝙿𝙴𝚁 𝐁𝚈 𝐈𝚂𝙷𝙰𝙽-𝐗 × 𝐋𝙾𝚅𝙴𝙻𝚈 🧑‍💻🇱🇰*_`;

        const apkRows = [
            { label: '📥 Download APK', id: `${config.PREFIX}apkdl ${apk.package}` },
            { label: '📑 View Details', id: `${config.PREFIX}apkdtl ${apk.package}` }
        ];
        setPendingRowSelect(sender, apkRows);

        await socket.sendMessage(sender, {
    image: { url: apk.icon },
    caption,
    footer
}, { quoted: msg });

    } catch (e) {
        console.error('APK search error:', e);
        await socket.sendMessage(sender, { text: `*❌ APK Error : -* ${e.message || e}` }, { quoted: msg });
    }
    break;
}

case 'apkdl': {
    try {
        const q = args.join(' ').trim();
        if (!q) {
            return await socket.sendMessage(sender, { text: '*❌ Provide a URL or a keyword කරුණාකර url එකක් ලබා දෙන්න*' }, { quoted: msg });
        }

        const ownerdata = (await axios.get(
            'https://raw.githubusercontent.com/Dilu-x/OWNER_DATA/refs/heads/main/ownerdata'
        )).data;
        const { footer } = ownerdata;

        const apiUrl = `http://ws75.aptoide.com/api/7/apps/search/query=${encodeURIComponent(q)}/limit=1`;
        const response = await axios.get(apiUrl);
        const data = response.data;

        if (!data.datalist || !data.datalist.list || data.datalist.list.length === 0) {
            return await socket.sendMessage(sender, { text: '*❌ Result not found මට කිසිවක් සොයාගත නොහැකි විය :(*' }, { quoted: msg });
        }

        const apk = data.datalist.list[0];
        await socket.sendMessage(sender, { react: { text: '⬆️', key: msg.key } });

        let resizedThumb = undefined;
        try {
            const sharp = require('sharp');
            const imgRes = await axios.get(apk.icon, { responseType: 'arraybuffer' });
            resizedThumb = await sharp(Buffer.from(imgRes.data)).resize(200, 200).toBuffer();
        } catch (e) {}

        await socket.sendMessage(sender, {
            document: { url: apk.file.path_alt },
            fileName: `${apk.name}.apk`,
            mimetype: 'application/vnd.android.package-archive',
            jpegThumbnail: resizedThumb,
            caption: `\`${apk.name}\`\n\n${footer}`
        }, { quoted: msg });

        await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });

    } catch (e) {
        console.error('APK download error:', e);
        await socket.sendMessage(sender, { text: `*❌ Error: ${e.message || e}*` }, { quoted: msg });
    }
    break;
}

case 'apkdtl': {
    try {
        const q = args.join(' ').trim();
        if (!q) {
            return await socket.sendMessage(sender, { text: '*❌ Provide a URL or a keyword කරුණාකර url එකක් ලබා දෙන්න*' }, { quoted: msg });
        }

        const ownerdata = (await axios.get(
            'https://raw.githubusercontent.com/Dilu-x/OWNER_DATA/refs/heads/main/ownerdata'
        )).data;
        const { footer } = ownerdata;

        const apiUrl = `http://ws75.aptoide.com/api/7/apps/search/query=${encodeURIComponent(q)}/limit=1`;
        const response = await axios.get(apiUrl);
        const data = response.data;

        if (!data.datalist || !data.datalist.list || data.datalist.list.length === 0) {
            return await socket.sendMessage(sender, { text: '*❌ Result not found මට කිසිවක් සොයාගත නොහැකි විය :(*' }, { quoted: msg });
        }

        const apk = data.datalist.list[0];
        const apkSizeMB = (apk.size / (1024 * 1024)).toFixed(2);

        await socket.sendMessage(sender, { react: { text: '⬆️', key: msg.key } });

        await socket.sendMessage(sender, {
            text:
                `*┎━━━━━━━━━━━━━━❖●►*\n` +
                `*┃➤ \`📦 Name\`      :* ${apk.name}\n` +
                `*┃➤ \`💾 Size\`      :* ${apkSizeMB} MB\n` +
                `*┃➤ \`🗂 Package\`   :* ${apk.package}\n` +
                `*┃➤ \`🕒 Updated\`   :* ${apk.updated}\n` +
                `*┃➤ \`👨‍💻 Developer\` :* ${apk.developer.name}\n` +
                `*┗━━━━━━━━━━━━━━❖●►*\n\n` +
                `${footer}`
        }, { quoted: msg });

        await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });

    } catch (e) {
        console.error('APK details error:', e);
        await socket.sendMessage(sender, { text: `*❌ Error: ${e.message || e}*` }, { quoted: msg });
    }
    break;
}

case 'xvdl2':
case 'xvnew': {
    try {
        const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();
        const query = text.split(" ").slice(1).join(" ").trim();

        if (!query) return await socket.sendMessage(sender, { text: '🚫 Please provide a search query.\nExample: .xv mia' }, { quoted: msg });

        // 1️⃣ Send searching message
        await socket.sendMessage(sender, { text: '*🔍 Searching XVideos...*' }, { quoted: msg });

        // 2️⃣ Call search API
        const searchRes = await axios.get(`https://tharuzz-ofc-api-v2.vercel.app/api/search/xvsearch?query=${encodeURIComponent(query)}`);
        const videos = searchRes.data.result?.xvideos?.slice(0, 10);
        if (!videos || videos.length === 0) return await socket.sendMessage(sender, { text: '*❌ No results found.*' }, { quoted: msg });

        // 3️⃣ Prepare list message
        let listMsg = `🔍 *XVideos Results for:* ${query}\n\n`;
        videos.forEach((vid, idx) => {
            listMsg += `*${idx + 1}.* ${vid.title}\n${vid.info}\n➡️ ${vid.link}\n\n`;
        });
        listMsg += '_Reply with the number to download the video._';

        await socket.sendMessage(sender, { text: listMsg }, { quoted: msg });

        // 4️⃣ Cache results for reply handling
        global.xvCache = global.xvCache || {};
        global.xvCache[sender] = videos.map(v => v.link);

    } catch (err) {
        console.error(err);
        await socket.sendMessage(sender, { text: '*❌ Error occurred.*' }, { quoted: msg });
    }
}
break;


// Handle reply to download selected video
case 'xvselect': {
    try {
        const replyText = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();
        const selection = parseInt(replyText);

        const links = global.xvCache?.[sender];
        if (!links || isNaN(selection) || selection < 1 || selection > links.length) {
            return await socket.sendMessage(sender, { text: '🚫 Invalid selection number.' }, { quoted: msg });
        }

        const videoUrl = links[selection - 1];

        await socket.sendMessage(sender, { text: '*⏳ Downloading video...*' }, { quoted: msg });

        // Call download API
        const dlRes = await axios.get(`https://tharuzz-ofc-api-v2.vercel.app/api/download/xvdl?url=${encodeURIComponent(videoUrl)}`);
        const result = dlRes.data.result;

        if (!result) return await socket.sendMessage(sender, { text: '*❌ Failed to fetch video.*' }, { quoted: msg });

        // Send video
        await socket.sendMessage(sender, {
            video: { url: result.dl_Links.highquality },
            caption: `🎥 *${result.title}*\n⏱ Duration: ${result.duration}s`,
            jpegThumbnail: result.thumbnail ? await axios.get(result.thumbnail, { responseType: 'arraybuffer' }).then(res => Buffer.from(res.data)) : undefined
        }, { quoted: msg });

        // Clear cache
        delete global.xvCache[sender];

    } catch (err) {
        console.error(err);
        await socket.sendMessage(sender, { text: '*❌ Error downloading video.*' }, { quoted: msg });
    }
}
break;

// ---------------- list saved newsletters (show emojis) ----------------
case 'newslist': {
  try {
    const docs = await listNewslettersFromMongo();
    if (!docs || docs.length === 0) {
      let userCfg = {};
      try { if (number && typeof loadUserConfigFromMongo === 'function') userCfg = await loadUserConfigFromMongo((number || '').replace(/[^0-9]/g, '')) || {}; } catch(e){ userCfg = {}; }
      const title = await resolveUserBotName(socket, nowsender, userCfg, '★彡 𝐈𝐒𝐇𝐀𝐍-𝐗 𝐌𝐃 𝐏𝐑𝐎 彡★');
            return await socket.sendMessage(sender, { text: '📭 No channels saved in DB.' }, { quoted: msg });
    }

    let txt = '*📚 Saved Newsletter Channels:*\n\n';
    for (const d of docs) {
      txt += `• ${d.jid}\n  Emojis: ${Array.isArray(d.emojis) && d.emojis.length ? d.emojis.join(' ') : '(default)'}\n\n`;
    }

    let userCfg = {};
    try { if (number && typeof loadUserConfigFromMongo === 'function') userCfg = await loadUserConfigFromMongo((number || '').replace(/[^0-9]/g, '')) || {}; } catch(e){ userCfg = {}; }
    const title = await resolveUserBotName(socket, nowsender, userCfg, '𝗜𝗦𝗛𝗔𝗡-𝐗 𝗠𝗗 𝙋𝙍𝙊');
    
    await socket.sendMessage(sender, { text: txt }, { quoted: msg });
  } catch (e) {
    console.error('newslist error', e);
    let userCfg = {};
    try { if (number && typeof loadUserConfigFromMongo === 'function') userCfg = await loadUserConfigFromMongo((number || '').replace(/[^0-9]/g, '')) || {}; } catch(e){ userCfg = {}; }
    const title = await resolveUserBotName(socket, nowsender, userCfg, '𝗜𝗦𝗛𝗔𝗡-𝐗 𝗠𝗗 𝙋𝙍𝙊');
        await socket.sendMessage(sender, { text: '❌ Failed to list channels.' }, { quoted: msg });
  }
  break;
}
case 'cid': {
    // Extract query from message
    const q = msg.message?.conversation ||
              msg.message?.extendedTextMessage?.text ||
              msg.message?.imageMessage?.caption ||
              msg.message?.videoMessage?.caption || '';

    // ✅ Dynamic botName load
    const sanitized = (number || '').replace(/[^0-9]/g, '');
    let cfg = await loadUserConfigFromMongo(sanitized) || {};
    let botName = await resolveUserBotName(socket, nowsender, cfg, '𝗜𝗦𝗛𝗔𝗡-𝐗 𝗠𝗗 𝙋𝙍𝙊');

    // ✅ Fake Meta AI vCard (for quoted msg)
    
    // Clean command prefix (.cid, /cid, !cid, etc.)
    const channelLink = q.replace(/^[.\/!]cid\s*/i, '').trim();

    // Check if link is provided
    if (!channelLink) {
        return await socket.sendMessage(sender, {
            text: '❎ Please provide a WhatsApp Channel link.\n\n📌 *Example:* .cid https://whatsapp.com/channel/123456789'
        }, { quoted: msg });
    }

    // Validate link
    const match = channelLink.match(/whatsapp\.com\/channel\/([\w-]+)/);
    if (!match) {
        return await socket.sendMessage(sender, {
            text: '⚠️ *Invalid channel link format.*\n\nMake sure it looks like:\nhttps://whatsapp.com/channel/xxxxxxxxx'
        }, { quoted: msg });
    }

    const inviteId = match[1];

    try {
        // Send fetching message
        await socket.sendMessage(sender, {
            text: `🔎 Fetching channel info for: *${inviteId}*`
        }, { quoted: msg });

        // Get channel metadata
        const metadata = await socket.newsletterMetadata("invite", inviteId);

        if (!metadata || !metadata.id) {
            return await socket.sendMessage(sender, {
                text: '❌ Channel not found or inaccessible.'
            }, { quoted: msg });
        }

        // Format details
        const infoText = `
📡 *𝐖hatsApp 𝐂hannel 𝐈nfo*

╔════════════════❒
╠⦁ ➤🆔 *𝐈D:* ${metadata.id}
╠⦁ ➤📌 *𝐍ame:* ${metadata.name}
╠⦁ ➤👥 *𝐅ollowers:* ${metadata.subscribers?.toLocaleString() || 'N/A'}
╠⦁ ➤📅 *𝐂reated 𝐎n:* ${metadata.creation_time ? new Date(metadata.creation_time * 1000).toLocaleString("si-LK") : 'Unknown'}
╚═══════════❒

> _*𝐃𝙴𝚅𝙴𝙻𝙾𝙿𝙴𝚁 𝐁𝚈 𝐈𝚂𝙷𝙰𝙽-𝐗 × 𝐋𝙾𝚅𝙴𝙻𝚈 🧑‍💻🇱🇰*_
`;

        // Send preview if available
        if (metadata.preview) {
            await socket.sendMessage(sender, {
                image: { url: `https://pps.whatsapp.net${metadata.preview}` },
                caption: infoText
            }, { quoted: msg });
        } else {
            await socket.sendMessage(sender, {
                text: infoText
            }, { quoted: msg });
        }

    } catch (err) {
        console.error("CID command error:", err);
        await socket.sendMessage(sender, {
            text: '⚠️ An unexpected error occurred while fetching channel info.'
        }, { quoted: msg });
    }

    break;
}

case 'addnewsletter':
case 'addnl': {
    if (!isOwner) {
        await socket.sendMessage(sender, { react: { text: '❌', key: msg.key } });
        return await socket.sendMessage(sender, { text: '❌ This command is restricted to the bot owner.' }, { quoted: msg });
    }
    if (!args || !args.length) {
        return await socket.sendMessage(sender, {
            text: `❗ Example:\n${prefix}addnewsletter https://whatsapp.com/channel/xxxxxxxxx\n${prefix}addnewsletter 120363xxxxxxxxx@newsletter\n\nTip: use ${prefix}cid <link> first if you only have the invite link and want to see the real JID before registering it.`
        }, { quoted: msg });
    }
    try {
        const target = args[0].trim();
        let jid;
        const linkMatch = target.match(/whatsapp\.com\/channel\/([\w-]+)/);
        if (linkMatch) {
            const meta = await socket.newsletterMetadata('invite', linkMatch[1]);
            if (!meta || !meta.id) {
                return await socket.sendMessage(sender, { text: '❌ Could not resolve that channel link.' }, { quoted: msg });
            }
            jid = meta.id;
        } else if (/^\d+@newsletter$/.test(target)) {
            jid = target;
        } else {
            return await socket.sendMessage(sender, {
                text: '❗ Please provide a channel invite link (https://whatsapp.com/channel/...) or a JID ending in @newsletter — not a placeholder/example JID.'
            }, { quoted: msg });
        }

        try { if (typeof socket.newsletterFollow === 'function') await socket.newsletterFollow(jid); } catch (e) {}
        // Required so new posts actually arrive in real time — without this,
        // the bot follows the channel but never sees its posts, so nothing
        // ever gets auto-reacted even though registration "succeeded".
        try { if (typeof socket.subscribeNewsletterUpdates === 'function') await socket.subscribeNewsletterUpdates(jid); } catch (e) {}

        await addNewsletterToMongo(jid, config.AUTO_LIKE_EMOJI);

        await socket.sendMessage(sender, {
            text: `✅ *Registered for auto-react*\n🆔 ${jid}\n\nNew posts in this channel will now get auto-reacted. Use ${prefix}listnewsletter to see everything currently registered.`
        }, { quoted: msg });
    } catch (e) {
        console.error('[addnewsletter] error:', e);
        await socket.sendMessage(sender, { text: `⚠️ Error: ${e.message || 'unknown error'}` }, { quoted: msg });
    }
    break;
}

case 'rmnewsletter':
case 'delnewsletter': {
    if (!isOwner) {
        await socket.sendMessage(sender, { react: { text: '❌', key: msg.key } });
        return await socket.sendMessage(sender, { text: '❌ This command is restricted to the bot owner.' }, { quoted: msg });
    }
    if (!args || !args.length || !/^\d+@newsletter$/.test(args[0].trim())) {
        return await socket.sendMessage(sender, {
            text: `❗ Example: ${prefix}rmnewsletter 120363xxxxxxxxx@newsletter\n\nUse ${prefix}listnewsletter to see the exact JIDs currently registered.`
        }, { quoted: msg });
    }
    try {
        await removeNewsletterFromMongo(args[0].trim());
        await socket.sendMessage(sender, { text: `✅ Removed from auto-react list:\n🆔 ${args[0].trim()}` }, { quoted: msg });
    } catch (e) {
        await socket.sendMessage(sender, { text: `⚠️ Error: ${e.message || 'unknown error'}` }, { quoted: msg });
    }
    break;
}

case 'listnewsletter':
case 'nllist': {
    if (!isOwner) {
        await socket.sendMessage(sender, { react: { text: '❌', key: msg.key } });
        return await socket.sendMessage(sender, { text: '❌ This command is restricted to the bot owner.' }, { quoted: msg });
    }
    try {
        const list = await listNewslettersFromMongo();
        if (!list.length) {
            return await socket.sendMessage(sender, {
                text: `📭 No channels are registered for auto-react yet.\nUse ${prefix}addnewsletter <link-or-jid> to add one.`
            }, { quoted: msg });
        }
        const text = `📡 *Channels registered for auto-react:*\n\n` + list.map((d, i) => `${i + 1}. ${d.jid}`).join('\n');
        await socket.sendMessage(sender, { text }, { quoted: msg });
    } catch (e) {
        await socket.sendMessage(sender, { text: `⚠️ Error: ${e.message || 'unknown error'}` }, { quoted: msg });
    }
    break;
}

case 'owner': {
  try {
    // vCard with multiple details
    let vcard = 
      'BEGIN:VCARD\n' +
      'VERSION:3.0\n' +
      'FN:DULA\n' + // Name
      'ORG:WhatsApp Bot Developer;\n' + // Organization
      'TITLE:Founder & CEO of Mini Bot;\n' + // Title / Role
      'EMAIL;type=INTERNET:dula9x@gmail.cim\n' + // Email
      'ADR;type=WORK:;;Ratnapura;;Sri Lanka\n' + // Address
      'URL:https://github.com\n' + // Website
      'TEL;type=CELL;type=VOICE;waid=94752978237\n' + // WhatsApp Number
      'TEL;type=CELL;type=VOICE;waid=94752978237\n' + // Second Number (Owner)
      'END:VCARD';

    await conn.sendMessage(
      m.chat,
      {
        contacts: {
          displayName: '𝐀𝚂𝙷𝙸𝚈𝙰-𝐌𝙳 4.0.0𝗩 🥷🇱🇰',
          contacts: [{ vcard }]
        }
      },
      { quoted: m }
    );

  } catch (err) {
    console.error(err);
    await conn.sendMessage(m.chat, { text: '⚠️ Owner info fetch error.' }, { quoted: m });
  }
}
break;

case 'addadmin': {
  if (!args || args.length === 0) {
    let userCfg = {};
    try { if (number && typeof loadUserConfigFromMongo === 'function') userCfg = await loadUserConfigFromMongo((number || '').replace(/[^0-9]/g, '')) || {}; } catch(e){ userCfg = {}; }
    const title = await resolveUserBotName(socket, nowsender, userCfg, '𝗜𝗦𝗛𝗔𝗡-𝐗 𝗠𝗗 𝙋𝙍𝙊');

    
    return await socket.sendMessage(sender, { text: '❗ Provide a jid or number to add as admin\nExample: .addadmin 9477xxxxxxx' }, { quoted: msg });
  }

  const jidOr = args[0].trim();
  if (!isOwner) {
    let userCfg = {};
    try { if (number && typeof loadUserConfigFromMongo === 'function') userCfg = await loadUserConfigFromMongo((number || '').replace(/[^0-9]/g, '')) || {}; } catch(e){ userCfg = {}; }
    const title = await resolveUserBotName(socket, nowsender, userCfg, '𝗜𝗦𝗛𝗔𝗡-𝐗 𝗠𝗗 𝙋𝙍𝙊');

    
    return await socket.sendMessage(sender, { text: '❌ Only owner can add admins.' }, { quoted: msg });
  }

  try {
    await addAdminToMongo(jidOr);

    let userCfg = {};
    try { if (number && typeof loadUserConfigFromMongo === 'function') userCfg = await loadUserConfigFromMongo((number || '').replace(/[^0-9]/g, '')) || {}; } catch(e){ userCfg = {}; }
    const title = await resolveUserBotName(socket, nowsender, userCfg, '𝗜𝗦𝗛𝗔𝗡-𝐗 𝗠𝗗 𝙋𝙍𝙊');

    
    await socket.sendMessage(sender, { text: `✅ Added admin: ${jidOr}` }, { quoted: msg });
  } catch (e) {
    console.error('addadmin error', e);
    let userCfg = {};
    try { if (number && typeof loadUserConfigFromMongo === 'function') userCfg = await loadUserConfigFromMongo((number || '').replace(/[^0-9]/g, '')) || {}; } catch(e){ userCfg = {}; }
    const title = await resolveUserBotName(socket, nowsender, userCfg, '𝗜𝗦𝗛𝗔𝗡-𝐗 𝗠𝗗 𝙋𝙍𝙊');
    
    await socket.sendMessage(sender, { text: `❌ Failed to add admin: ${e.message || e}` }, { quoted: msg });
  }
  break;
}
case 'tagall': {
  try {
    if (!from || !from.endsWith('@g.us')) return await socket.sendMessage(sender, { text: '❌ This command can only be used in groups.' }, { quoted: msg });

    let gm = null;
    try { gm = await socket.groupMetadata(from); } catch(e) { gm = null; }
    if (!gm) return await socket.sendMessage(sender, { text: '❌ Failed to fetch group info.' }, { quoted: msg });

    const participants = gm.participants || [];
    if (!participants.length) return await socket.sendMessage(sender, { text: '❌ No members found in the group.' }, { quoted: msg });

    const text = args && args.length ? args.join(' ') : '📢 Announcement';

    let groupPP = 'https://raw.githubusercontent.com/minibotsjsisns/IMAGE_DATA/refs/heads/main/file_000000005eac720896d40b719700b3c0.png';
    try { groupPP = await socket.profilePictureUrl(from, 'image'); } catch(e){}

    const mentions = participants.map(p => p.id || p.jid);
    const groupName = gm.subject || 'Group';
    const totalMembers = participants.length;

    const emojis = ['📢','🔊','🌐','🛡️','🚀','🎯','🧿','🪩','🌀','💠','🎊','🎧','📣','🗣️'];
    const randomEmoji = emojis[Math.floor(Math.random() * emojis.length)];

    const sanitized = (number || '').replace(/[^0-9]/g, '');
    const cfg = await loadUserConfigFromMongo(sanitized) || {};
    const botName = await resolveUserBotName(socket, nowsender, cfg, BOT_NAME_FANCY);

    // BotName meta mention
    
    let caption = `╔══『 ❤️‍🩹 *𝙸𝚂𝙷𝙰𝙽-𝚇 𝙼𝙳 𝙿𝚁𝙾 𝐆𝚁𝙾𝚄𝙿 𝐀𝙽𝙽𝙾𝚄𝙽𝙲𝙴𝙼𝙴𝙽𝚃* 』═══❒\n`;
    caption += `╠⦁ ➤📌 *𝐆roup:* ${groupName}\n`;
    caption += `╠⦁ ➤👥 *𝐌embers:* ${totalMembers}\n`;
    caption += `╠⦁ ➤💬 *𝐌essage:* ${text}\n`;
    caption += `╚═════════════════════════❒\n\n`;
    caption += `📍 *Mentioning all members below:*\n\n`;
    for (const m of participants) {
      const id = (m.id || m.jid);
      if (!id) continue;
      caption += `${randomEmoji} @${id.split('@')[0]}\n`;
    }
    caption += `\n━━━━━━⊱ *${botName}* ⊰━━━━━━`;

    await socket.sendMessage(from, {
      image: { url: groupPP },
      caption,
      mentions,
    }, { quoted: msg }); // <-- botName meta mention

  } catch (err) {
    console.error('tagall error', err);
    await socket.sendMessage(sender, { text: '❌ Error running tagall.' }, { quoted: msg });
  }
  break;
}


case 'ig':
case 'insta':
case 'instagram': {
  try {
    const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();
    const q = text.split(" ").slice(1).join(" ").trim();

    // Validate
    if (!q) {
      await socket.sendMessage(sender, { 
        text: '*🚫 Please provide an Instagram post/reel link.*',
      });
      return;
    }

    const igRegex = /(?:https?:\/\/)?(?:www\.)?instagram\.com\/[^\s]+/;
    if (!igRegex.test(q)) {
      await socket.sendMessage(sender, { 
        text: '*🚫 Invalid Instagram link.*',
      });
      return;
    }

    await socket.sendMessage(sender, { react: { text: '📸', key: msg.key } });
    await socket.sendMessage(sender, { text: '*⏳ Downloading Instagram media...*' });

    // 🔹 Load session bot name
    const sanitized = (number || '').replace(/[^0-9]/g, '');
    let cfg = await loadUserConfigFromMongo(sanitized) || {};
    let botName = await resolveUserBotName(socket, nowsender, cfg, '𝗜𝗦𝗛𝗔𝗡-𝐗 𝗠𝗗 𝙋𝙍𝙊');

    // 🔹 Meta style fake contact
    
    // API request
    let apiUrl = `https://api-aswin-sparky.koyeb.app/api/downloader/igdl?url=${encodeURIComponent(q)}`;
    let { data: apiRes } = await axios.get(apiUrl).catch(() => ({ data: null }));

    // Normalize response -> { status, downloadUrl }
    let data = null;
    if (apiRes?.status && Array.isArray(apiRes?.data) && apiRes.data.length > 0) {
      const media = apiRes.data.find(item => item?.type === 'video') || apiRes.data[0];
      if (media?.url) {
        data = { status: true, downloadUrl: media.url };
      }
    }

    if (!data?.status || !data?.downloadUrl) {
      await socket.sendMessage(sender, { 
        text: '*❌ Failed to fetch Instagram video.*',
      });
      return;
    }

    // Caption (Dynamic Bot Name)
    const titleText = `*📸 ${botName} 𝐈ɴꜱᴛᴀɢʀᴀᴍ 𝐃ᴏᴡɴʟᴏᴀᴅᴇʀ*`;
    const content = `┏━━━━━━━━━━━━━━━━\n` +
                    `┃➤📌 \`𝐒ource\` : Instagram\n` +
                    `┃➤📹 \`𝐓ype\` : Video/Reel\n` +
                    `┗━━━━━━━━━━━━━━━━`;

    const footer = `🤖 ${botName}`;
    const captionMessage = typeof formatMessage === 'function'
      ? formatMessage(titleText, content, footer)
      : `${titleText}\n\n${content}\n${footer}`;

    // Send video with fake contact quoted
    await socket.sendMessage(sender, {
      video: { url: data.downloadUrl },
      caption: captionMessage,
      contextInfo: { mentionedJid: [sender] }
    }, { quoted: msg }); // 🔹 fake contact quoted

  } catch (err) {
    console.error("Error in Instagram downloader:", err);
    await socket.sendMessage(sender, { 
      text: '*❌ Internal Error. Please try again later.*'
    });
  }
  break;
}

case 'online': {
  try {
    if (!(from || '').endsWith('@g.us')) {
      await socket.sendMessage(sender, { text: '❌ This command works only in group chats.' }, { quoted: msg });
      break;
    }

    let groupMeta;
    try { groupMeta = await socket.groupMetadata(from); } catch (err) { console.error(err); break; }

    const callerJid = (nowsender || '').replace(/:.*$/, '');
    const callerId = callerJid.includes('@') ? callerJid : `${callerJid}@s.whatsapp.net`;
    const isOwnerCaller = isOwnerNumber(callerJid);
    const groupAdmins = (groupMeta.participants || []).filter(p => p.admin === 'admin' || p.admin === 'superadmin').map(p => p.id);
    const isGroupAdminCaller = groupAdmins.includes(callerId);

    if (!isOwnerCaller && !isGroupAdminCaller) {
      await socket.sendMessage(sender, { text: '❌ Only group admins or the bot owner can use this command.' }, { quoted: msg });
      break;
    }

    try { await socket.sendMessage(sender, { text: '🔄 Scanning for online members... please wait ~15 seconds' }, { quoted: msg }); } catch(e){}

    const participants = (groupMeta.participants || []).map(p => p.id);
    const onlineSet = new Set();
    const presenceListener = (update) => {
      try {
        if (update?.presences) {
          for (const id of Object.keys(update.presences)) {
            const pres = update.presences[id];
            if (pres?.lastKnownPresence && pres.lastKnownPresence !== 'unavailable') onlineSet.add(id);
            if (pres?.available === true) onlineSet.add(id);
          }
        }
      } catch (e) { console.warn('presenceListener error', e); }
    };

    for (const p of participants) {
      try { if (typeof socket.presenceSubscribe === 'function') await socket.presenceSubscribe(p); } catch(e){}
    }
    socket.ev.on('presence.update', presenceListener);

    const checks = 3; const intervalMs = 5000;
    await new Promise((resolve) => { let attempts=0; const iv=setInterval(()=>{ attempts++; if(attempts>=checks){ clearInterval(iv); resolve(); } }, intervalMs); });
    try { socket.ev.off('presence.update', presenceListener); } catch(e){}

    if (onlineSet.size === 0) {
      await socket.sendMessage(sender, { text: '⚠️ No online members detected (they may be hiding presence or offline).' }, { quoted: msg });
      break;
    }

    const onlineArray = Array.from(onlineSet).filter(j => participants.includes(j));
    const mentionList = onlineArray.map(j => j);

    const sanitized = (number || '').replace(/[^0-9]/g, '');
    const cfg = await loadUserConfigFromMongo(sanitized) || {};
    const botName = await resolveUserBotName(socket, nowsender, cfg, BOT_NAME_FANCY);

    // BotName meta mention
    
    let txt = `💚 *𝐎nline 𝐌embers* — ${onlineArray.length}/${participants.length}\n\n`;
    onlineArray.forEach((jid, i) => {
      txt += `${i+1}. @${jid.split('@')[0]}\n`;
    });

    await socket.sendMessage(sender, {
      text: txt.trim(),
      mentions: mentionList
    }, { quoted: msg }); // <-- botName meta mention

  } catch (err) {
    console.error('Error in online command:', err);
    try { await socket.sendMessage(sender, { text: '❌ An error occurred while checking online members.' }, { quoted: msg }); } catch(e){}
  }
  break;
}



case 'deladmin': {
  if (!args || args.length === 0) {
    let userCfg = {};
    try { if (number && typeof loadUserConfigFromMongo === 'function') userCfg = await loadUserConfigFromMongo((number || '').replace(/[^0-9]/g, '')) || {}; } catch(e){ userCfg = {}; }
    const title = await resolveUserBotName(socket, nowsender, userCfg, '𝗜𝗦𝗛𝗔𝗡-𝐗 𝗠𝗗 𝙋𝙍𝙊');

    
    return await socket.sendMessage(sender, { text: '❗ Provide a jid/number to remove\nExample: .deladmin 9477xxxxxxx' }, { quoted: msg });
  }

  const jidOr = args[0].trim();
  if (!isOwner) {
    let userCfg = {};
    try { if (number && typeof loadUserConfigFromMongo === 'function') userCfg = await loadUserConfigFromMongo((number || '').replace(/[^0-9]/g, '')) || {}; } catch(e){ userCfg = {}; }
    const title = await resolveUserBotName(socket, nowsender, userCfg, '𝗜𝗦𝗛𝗔𝗡-𝐗 𝗠𝗗 𝙋𝙍𝙊');

    
    return await socket.sendMessage(sender, { text: '❌ Only owner can remove admins.' }, { quoted: msg });
  }

  try {
    await removeAdminFromMongo(jidOr);

    let userCfg = {};
    try { if (number && typeof loadUserConfigFromMongo === 'function') userCfg = await loadUserConfigFromMongo((number || '').replace(/[^0-9]/g, '')) || {}; } catch(e){ userCfg = {}; }
    const title = await resolveUserBotName(socket, nowsender, userCfg, '𝗜𝗦𝗛𝗔𝗡-𝐗 𝗠𝗗 𝙋𝙍𝙊');

    
    await socket.sendMessage(sender, { text: `✅ Removed admin: ${jidOr}` }, { quoted: msg });
  } catch (e) {
    console.error('deladmin error', e);
    let userCfg = {};
    try { if (number && typeof loadUserConfigFromMongo === 'function') userCfg = await loadUserConfigFromMongo((number || '').replace(/[^0-9]/g, '')) || {}; } catch(e){ userCfg = {}; }
    const title = await resolveUserBotName(socket, nowsender, userCfg, '𝗜𝗦𝗛𝗔𝗡-𝐗 𝗠𝗗 𝙋𝙍𝙊');
    
    await socket.sendMessage(sender, { text: `❌ Failed to remove admin: ${e.message || e}` }, { quoted: msg });
  }
  break;
}

case 'admins': {
  try {
    const list = await loadAdminsFromMongo();
    let userCfg = {};
    try { if (number && typeof loadUserConfigFromMongo === 'function') userCfg = await loadUserConfigFromMongo((number || '').replace(/[^0-9]/g, '')) || {}; } catch(e){ userCfg = {}; }
    const title = await resolveUserBotName(socket, nowsender, userCfg, '𝗜𝗦𝗛𝗔𝗡-𝐗 𝗠𝗗 𝙋𝙍𝙊');

    
    if (!list || list.length === 0) {
      return await socket.sendMessage(sender, { text: 'No admins configured.' }, { quoted: msg });
    }

    let txt = '*👑 Admins:*\n\n';
    for (const a of list) txt += `• ${a}\n`;

    await socket.sendMessage(sender, { text: txt }, { quoted: msg });
  } catch (e) {
    console.error('admins error', e);
    let userCfg = {};
    try { if (number && typeof loadUserConfigFromMongo === 'function') userCfg = await loadUserConfigFromMongo((number || '').replace(/[^0-9]/g, '')) || {}; } catch(e){ userCfg = {}; }
    const title = await resolveUserBotName(socket, nowsender, userCfg, '𝗜𝗦𝗛𝗔𝗡-𝐗 𝗠𝗗 𝙋𝙍𝙊');
    
    await socket.sendMessage(sender, { text: '❌ Failed to list admins.' }, { quoted: msg });
  }
  break;
}
case 'setlogo': {
  const sanitized = (number || '').replace(/[^0-9]/g, '');    const senderNum = await resolveSenderPhone(socket, nowsender);
    const isOwnerNum = isOwnerNumber(senderNum);
  if (senderNum !== sanitized && !isOwnerNum) {
        await socket.sendMessage(sender, { text: '❌ Permission denied. Only the session owner or bot owner can change this session logo.' }, { quoted: msg });
    break;
  }

  const ctxInfo = (msg.message.extendedTextMessage || {}).contextInfo || {};
  const quotedMsg = ctxInfo.quotedMessage;
  const media = await downloadQuotedMedia(quotedMsg).catch(()=>null);
  let logoSetTo = null;

  try {
    if (media && media.buffer) {
      // Upload to a CDN instead of saving a local temp file: local paths die
      // on restart (/tmp cleanup) leaving cfg.logo pointing at a missing file
      // — which made the .setting panel image fail to attach (ENOENT logo.jpeg).
      const cdnUrl = await uploadToCDN(media.buffer).catch(() => null);
      if (!cdnUrl) {
        return await socket.sendMessage(sender, { text: '❌ Failed to upload logo image. Try again or use a direct image URL.' }, { quoted: msg });
      }
      let cfg = await loadUserConfigFromMongo(sanitized) || {};
      cfg.logo = cdnUrl;
      await setUserConfigInMongo(sanitized, cfg);
      logoSetTo = cdnUrl;
    } else if (args && args[0] && (args[0].startsWith('http') || args[0].startsWith('https'))) {
      let cfg = await loadUserConfigFromMongo(sanitized) || {};
      cfg.logo = args[0];
      await setUserConfigInMongo(sanitized, cfg);
      logoSetTo = args[0];
    } else {
            await socket.sendMessage(sender, { text: '❗ Usage: Reply to an image with `.setlogo` OR provide an image URL: `.setlogo https://example.com/logo.jpg`' }, { quoted: msg });
      break;
    }

    
    await socket.sendMessage(sender, { text: `✅ Logo set for this session: ${logoSetTo}` }, { quoted: msg });
  } catch (e) {
    console.error('setlogo error', e);
        await socket.sendMessage(sender, { text: `❌ Failed to set logo: ${e.message || e}` }, { quoted: msg });
  }
  break;
}
case 'jid': {
    const sanitized = (number || '').replace(/[^0-9]/g, '');
    const cfg = await loadUserConfigFromMongo(sanitized) || {};
    const botName = await resolveUserBotName(socket, nowsender, cfg, '𝗜𝗦𝗛𝗔𝗡-𝐗 𝗠𝗗 𝙋𝙍𝙊'); // dynamic bot name

    const rawJid = String(sender || from || '');
    let phoneJid = rawJid;
    let userNumber = rawJid.split('@')[0];
    if (rawJid.endsWith('@lid') || rawJid.endsWith('@hosted.lid')) {
      try {
        const mapping = socket?.signalRepository?.lidMapping;
        const res = mapping ? await mapping.getPNsForLIDs([rawJid]).catch(() => null) : null;
        if (res && res[0] && res[0].pn) {
          userNumber = res[0].pn.split('@')[0].split(':')[0];
          phoneJid = userNumber + '@s.whatsapp.net';
        }
      } catch (e) {}
    }

    // Reaction
    await socket.sendMessage(sender, { 
        react: { text: "🆔", key: msg.key } 
    });

    // Fake contact quoting for meta style
    
    await socket.sendMessage(sender, {
        text: `*🆔 𝐂hat 𝐉ID:* ${phoneJid}\n*📞 𝐘our 𝐍umber:* +${userNumber}`,
    }, { quoted: msg });
    break;
}

// use inside your switch(command) { ... } block

case 'block': {
  try {
    // caller number (who sent the command)
    const callerNumberClean = (senderNumber || '').replace(/[^0-9]/g, '');
    const sessionOwner = (number || '').replace(/[^0-9]/g, '');

    // allow if caller is global owner OR this session's owner
    if (!isOwnerNumber(callerNumberClean) && callerNumberClean !== sessionOwner) {
      try { await socket.sendMessage(sender, { react: { text: "❌", key: msg.key } }); } catch(e){}
      await socket.sendMessage(sender, { text: '❌ You do not have permission to use this. (You must be the Owner or the session owner here)' }, { quoted: msg });
      break;
    }

    // determine target JID: reply / mention / arg
    let targetJid = null;
    const ctx = msg.message?.extendedTextMessage?.contextInfo;

    if (ctx?.participant) targetJid = ctx.participant; // replied user
    else if (ctx?.mentionedJid && ctx.mentionedJid.length) targetJid = ctx.mentionedJid[0]; // mentioned
    else if (args && args.length > 0) {
      const possible = args[0].trim();
      if (possible.includes('@')) targetJid = possible;
      else {
        const digits = possible.replace(/[^0-9]/g,'');
        if (digits) targetJid = `${digits}@s.whatsapp.net`;
      }
    }

    if (!targetJid) {
      try { await socket.sendMessage(sender, { react: { text: "❌", key: msg.key } }); } catch(e){}
      await socket.sendMessage(sender, { text: '❗ Please reply to, mention, or enter the number. Example: .block 9477xxxxxxx' }, { quoted: msg });
      break;
    }

    // normalize
    if (!targetJid.includes('@')) targetJid = `${targetJid}@s.whatsapp.net`;
    if (!targetJid.endsWith('@s.whatsapp.net') && !targetJid.includes('@')) targetJid = `${targetJid}@s.whatsapp.net`;

    // perform block
    try {
      if (typeof socket.updateBlockStatus === 'function') {
        await socket.updateBlockStatus(targetJid, 'block');
      } else {
        // some bailey builds use same method name; try anyway
        await socket.updateBlockStatus(targetJid, 'block');
      }
      try { await socket.sendMessage(sender, { react: { text: "✅", key: msg.key } }); } catch(e){}
      await socket.sendMessage(sender, { text: `✅ @${targetJid.split('@')[0]} blocked successfully.`, mentions: [targetJid] }, { quoted: msg });
    } catch (err) {
      console.error('Block error:', err);
      try { await socket.sendMessage(sender, { react: { text: "❌", key: msg.key } }); } catch(e){}
      await socket.sendMessage(sender, { text: '❌ Failed to block the user. (Maybe invalid JID or API failure)' }, { quoted: msg });
    }

  } catch (err) {
    console.error('block command general error:', err);
    try { await socket.sendMessage(sender, { react: { text: "❌", key: msg.key } }); } catch(e){}
    await socket.sendMessage(sender, { text: '❌ Error occurred while processing block command.' }, { quoted: msg });
  }
  break;
}

case 'unblock': {
  try {
    // caller number (who sent the command)
    const callerNumberClean = (senderNumber || '').replace(/[^0-9]/g, '');
    const sessionOwner = (number || '').replace(/[^0-9]/g, '');

    // allow if caller is global owner OR this session's owner
    if (!isOwnerNumber(callerNumberClean) && callerNumberClean !== sessionOwner) {
      try { await socket.sendMessage(sender, { react: { text: "❌", key: msg.key } }); } catch(e){}
      await socket.sendMessage(sender, { text: '❌ You do not have permission to use this. (You must be the Owner or the session owner here)' }, { quoted: msg });
      break;
    }

    // determine target JID: reply / mention / arg
    let targetJid = null;
    const ctx = msg.message?.extendedTextMessage?.contextInfo;

    if (ctx?.participant) targetJid = ctx.participant;
    else if (ctx?.mentionedJid && ctx.mentionedJid.length) targetJid = ctx.mentionedJid[0];
    else if (args && args.length > 0) {
      const possible = args[0].trim();
      if (possible.includes('@')) targetJid = possible;
      else {
        const digits = possible.replace(/[^0-9]/g,'');
        if (digits) targetJid = `${digits}@s.whatsapp.net`;
      }
    }

    if (!targetJid) {
      try { await socket.sendMessage(sender, { react: { text: "❌", key: msg.key } }); } catch(e){}
      await socket.sendMessage(sender, { text: '❗ Please reply to, mention, or enter the number. Example: .unblock 9477xxxxxxx' }, { quoted: msg });
      break;
    }

    // normalize
    if (!targetJid.includes('@')) targetJid = `${targetJid}@s.whatsapp.net`;
    if (!targetJid.endsWith('@s.whatsapp.net') && !targetJid.includes('@')) targetJid = `${targetJid}@s.whatsapp.net`;

    // perform unblock
    try {
      if (typeof socket.updateBlockStatus === 'function') {
        await socket.updateBlockStatus(targetJid, 'unblock');
      } else {
        await socket.updateBlockStatus(targetJid, 'unblock');
      }
      try { await socket.sendMessage(sender, { react: { text: "✅", key: msg.key } }); } catch(e){}
      await socket.sendMessage(sender, { text: `🔓 @${targetJid.split('@')[0]} unblocked successfully.`, mentions: [targetJid] }, { quoted: msg });
    } catch (err) {
      console.error('Unblock error:', err);
      try { await socket.sendMessage(sender, { react: { text: "❌", key: msg.key } }); } catch(e){}
      await socket.sendMessage(sender, { text: '❌ Failed to unblock the user.' }, { quoted: msg });
    }

  } catch (err) {
    console.error('unblock command general error:', err);
    try { await socket.sendMessage(sender, { react: { text: "❌", key: msg.key } }); } catch(e){}
    await socket.sendMessage(sender, { text: '❌ Error occurred while processing unblock command.' }, { quoted: msg });
  }
  break;
}

case 'cinesub':
case 'cs': {
    delete moviePendingSearch[sender];
    delete moviePendingQuality[sender];
    delete pendingRowSelect[sender];
    await cinesubPlugin(socket, msg, args, from, sender, true);
    break;
}

case 'lk': {
    delete moviePendingSearch[sender];
    delete moviePendingQuality[sender];
    delete pendingRowSelect[sender];
    await cinesulkPlugin(socket, msg, args, from, sender, true);
    break;
}

case 'boxhub':
case 'bh': {
    delete moviePendingSearch[sender];
    delete moviePendingQuality[sender];
    delete pendingRowSelect[sender];
    await boxhubPlugin(socket, msg, args, from, sender, true);
    break;
}

case 'anime': {
    delete moviePendingSearch[sender];
    delete moviePendingQuality[sender];
    delete pendingRowSelect[sender];
    try {
      const query = (args || []).join(' ').trim();

      if (!query) {
        await animeSendText(socket, from, animeBuildUsage(prefix), msg);
        break;
      }

      // Anti-spam: at most one .anime search per user per 4s — a spammer
      // mashing the command must not burn API calls or flood the chat.
      const throttle = animeThrottleEntry(from, nowsender);
      if (Date.now() - throttle.search < ANIME_SEARCH_COOLDOWN_MS) {
        if (Date.now() - throttle.searchWarn >= ANIME_SEARCH_COOLDOWN_MS) {
          throttle.searchWarn = Date.now();
          await animeSendText(socket, from, '⏳ *Slow down!* Wait a few seconds before searching again.', msg);
        }
        break;
      }
      throttle.search = Date.now();
      throttle.lastActivity = Date.now();
      // A fresh .anime search starts a new flow — reset the reply gap so the
      // user's very first selection isn't silently dropped by the previous
      // flow's timestamp.
      throttle.reply = 0;

      const loading = await animeSendText(socket, from, '🔎 *Searching Anime...*', msg);

      let results = [];
      try {
        results = await animeApiSearch(query);
      } catch (e) {
        const errMsg = animeApiError(e);
        console.error('[anime] search error:', errMsg);
        await animeEditOrSend(socket, from, loading && loading.key, `❌ *Search failed.*\n\n_${errMsg}_`, msg);
        break;
      }

      if (!results.length) {
        await animeEditOrSend(socket, from, loading && loading.key, `❌ *Anime not found* for "_${query}".\n\n_Try checking the spelling._`, msg);
        break;
      }

      const top = results.slice(0, ANIME_MAX_SEARCH_RESULTS);
      // Send the search results as a FRESH message with the first result's
      // poster attached (never an edit of the loading message — an edit gets
      // its own new message id, but the user QUOTES the original id, so the
      // recorded menu id would never match a reply). Image failures fall back
      // to a plain-text list automatically.
      const searchCaption = animeBuildSearchList(top, query);
      const posterUrl = (top[0] && top[0].coverImage && (top[0].coverImage.extraLarge || top[0].coverImage.large)) || null;
      const sentList = await animeSendWithImage(socket, from, posterUrl, searchCaption, msg);
      const listMsgId = sentList && sentList.key && sentList.key.id;
      await animeDeleteMsg(socket, from, loading && loading.key);
      // Session is keyed chat::user (per-user isolation) and carries the
      // search-list message id so selections are tied to THIS exact list.
      animeSaveSession(from, nowsender, {
        searchResults: top,
        selectedAnime: null,
        episodes: [],
        createdAt: Date.now(),
        step: 'search',
        botJid: animeMyBotNumber(socket),
        page: 1,
        searchMessageId: listMsgId
      });
      // Reply-context ownership: only a reply that QUOTES this exact search
      // list may select an anime — random numbers are never selections.
      animeRecordMenu(listMsgId, from, nowsender, 'search', animeMyBotNumber(socket));
    } catch (e) {
      console.error('[anime] command error:', animeApiError(e));
      await animeSendText(socket, from, '❌ *Anime command error.* Please try again.', msg);
    }
    break;
}

case 'animeheaven': {
    delete moviePendingSearch[sender];
    delete moviePendingQuality[sender];
    delete pendingRowSelect[sender];
    await animeheavenPlugin(socket, msg, args, from, sender, true, nowsender, prefix);
    break;
}

case 'setbotname': {
  const sanitized = (number || '').replace(/[^0-9]/g, '');    const senderNum = await resolveSenderPhone(socket, nowsender);
    const isOwnerNum = isOwnerNumber(senderNum);
  if (senderNum !== sanitized && !isOwnerNum) {
        await socket.sendMessage(sender, { text: '❌ Permission denied. Only the session owner or bot owner can change this session bot name.' }, { quoted: msg });
    break;
  }

  const name = args.join(' ').trim();
  if (!name) {
        return await socket.sendMessage(sender, { text: '❗ Provide bot name. Example: `.setbotname ✦ ━━ 𝙸𝚂𝙷𝙰𝙽-𝚇 BOT ━━ ✦`' }, { quoted: msg });
  }

  try {
    let cfg = await loadUserConfigFromMongo(sanitized) || {};
    cfg.botName = name;
    await setUserConfigInMongo(sanitized, cfg);

    
    await socket.sendMessage(sender, { text: `✅ Bot display name set for this session: ${name}` }, { quoted: msg });
  } catch (e) {
    console.error('setbotname error', e);
        await socket.sendMessage(sender, { text: `❌ Failed to set bot name: ${e.message || e}` }, { quoted: msg });
  }
  break;
}

case 'welcome': {
  await socket.sendMessage(sender, { react: { text: '👋', key: msg.key } });
  try {
    const from = msg.key.remoteJid;
    if (!from || !from.endsWith('@g.us')) {
      return await socket.sendMessage(sender, { text: '❌ This command works only in group chats.' }, { quoted: msg });
    }
    const sanitized = (number || '').replace(/[^0-9]/g, '');
    const senderNum = await resolveSenderPhone(socket, nowsender);
    const isOwnerNum = isOwnerNumber(senderNum);
    const isSessionOwner = senderNum === sanitized;
    const isBotOwner = isOwnerNum;
    const isGroupAdmin = await isGroupAdminUser(socket, from, nowsender);
    if (!isSessionOwner && !isBotOwner && !isGroupAdmin) {
      return await socket.sendMessage(sender, { text: '❌ Only group admins can change welcome settings.' }, { quoted: msg });
    }
    const sub = (args[0] || '').toLowerCase();

    // Load per-group config
    const gcfg = (await loadGroupConfigFromMongo(from)) || {};

    if (sub === 'on' || sub === 'off') {
      gcfg.welcome = { enabled: sub === 'on' };
      await setGroupConfigInMongo(from, gcfg);
      return await socket.sendMessage(sender, { text: `✅ *Group Welcome ${sub === 'on' ? 'ENABLED' : 'DISABLED'}*` }, { quoted: msg });
    }

    if (sub === 'status') {
      const botAdmin = await isBotGroupAdmin(socket, from);
      const status = gcfg.welcome && gcfg.welcome.enabled ? 'ON' : 'OFF';
      return await socket.sendMessage(sender, {
        text: `👋 *Group Welcome Status*\n\n*Status:* ${status}\n*Bot Admin:* ${botAdmin ? '✅ Yes' : '❌ No'}\n\n*Usage:*\n.welcome on/off\n.welcome status`,
        quoted: msg
      });
    }

    return await socket.sendMessage(sender, {
      text: `👋 *Group Welcome Settings*\n\n*Usage:*\n.welcome on\n.welcome off\n.welcome status`,
      quoted: msg
    });
  } catch (e) {
    console.error('welcome command error', e);
    await socket.sendMessage(sender, { text: '*❌ Error updating group welcome.*' }, { quoted: msg });
  }
  break;
}

case 'goodbye': {
  await socket.sendMessage(sender, { react: { text: '👋', key: msg.key } });
  try {
    const from = msg.key.remoteJid;
    if (!from || !from.endsWith('@g.us')) {
      return await socket.sendMessage(sender, { text: '❌ This command works only in group chats.' }, { quoted: msg });
    }
    const sanitized = (number || '').replace(/[^0-9]/g, '');
    const senderNum = await resolveSenderPhone(socket, nowsender);
    const isOwnerNum = isOwnerNumber(senderNum);
    const isSessionOwner = senderNum === sanitized;
    const isBotOwner = isOwnerNum;
    const isGroupAdmin = await isGroupAdminUser(socket, from, nowsender);
    if (!isSessionOwner && !isBotOwner && !isGroupAdmin) {
      return await socket.sendMessage(sender, { text: '❌ Only group admins can change goodbye settings.' }, { quoted: msg });
    }
    const sub = (args[0] || '').toLowerCase();

    // Load per-group config
    const gcfg = (await loadGroupConfigFromMongo(from)) || {};

    if (sub === 'on' || sub === 'off') {
      gcfg.goodbye = { enabled: sub === 'on' };
      await setGroupConfigInMongo(from, gcfg);
      return await socket.sendMessage(sender, { text: `✅ *Group Goodbye ${sub === 'on' ? 'ENABLED' : 'DISABLED'}*` }, { quoted: msg });
    }

    if (sub === 'status') {
      const botAdmin = await isBotGroupAdmin(socket, from);
      const status = gcfg.goodbye && gcfg.goodbye.enabled ? 'ON' : 'OFF';
      return await socket.sendMessage(sender, {
        text: `🖤 *Group Goodbye Status*\n\n*Status:* ${status}\n*Bot Admin:* ${botAdmin ? '✅ Yes' : '❌ No'}\n\n*Usage:*\n.goodbye on/off\n.goodbye status`,
        quoted: msg
      });
    }

    return await socket.sendMessage(sender, {
      text: `🖤 *Group Goodbye Settings*\n\n*Usage:*\n.goodbye on\n.goodbye off\n.goodbye status`,
      quoted: msg
    });
  } catch (e) {
    console.error('goodbye command error', e);
    await socket.sendMessage(sender, { text: '*❌ Error updating group goodbye.*' }, { quoted: msg });
  }
  break;
}

case 'antilink': {
  await socket.sendMessage(sender, { react: { text: '🔗', key: msg.key } });
  try {
    const from = msg.key.remoteJid;
    if (!from || !from.endsWith('@g.us')) {
      return await socket.sendMessage(sender, { text: '❌ This command works only in group chats.' }, { quoted: msg });
    }
    const sanitized = (number || '').replace(/[^0-9]/g, '');
    const senderNum = await resolveSenderPhone(socket, nowsender);
    const isOwnerNum = isOwnerNumber(senderNum);
    const isSessionOwner = senderNum === sanitized;
    const isBotOwner = isOwnerNum;
    const isGroupAdmin = await isGroupAdminUser(socket, from, nowsender);
    if (!isSessionOwner && !isBotOwner && !isGroupAdmin) {
      return await socket.sendMessage(sender, { text: '❌ Only group admins can change anti-link settings.' }, { quoted: msg });
    }
    const sub = (args[0] || '').toLowerCase();
    // NOTE: `.antilink status` is intentionally NOT supported.
    // Per-user, per-group status: gcfg.antilink[<user number>] = 'on' | 'off'
    const gcfg = (await loadGroupConfigFromMongo(from)) || {};
    gcfg.antilink = gcfg.antilink || {};

    // .antilink exempt @user / .antilink unexempt @user — admins toggle
    // another member's status (exempt = OFF, links allowed / unexempt = ON,
    // links deleted). Targets come from WhatsApp mentions or a typed number
    // (e.g. .antilink exempt 94771234567).
    if (sub === 'exempt' || sub === 'unexempt') {
      const targets = new Set();
      try {
        const mentioned = (msg.message.extendedTextMessage &&
          msg.message.extendedTextMessage.contextInfo &&
          msg.message.extendedTextMessage.contextInfo.mentionedJid) || [];
        if (Array.isArray(mentioned)) {
          for (const j of mentioned) { const id = jidToParticipantId(j); if (id) targets.add(id); }
        }
      } catch (e) {}
      for (const a of args.slice(1)) {
        const m = String(a).match(/(\d{7,15})/);
        if (m) targets.add(m[1]);
      }
      // Fallback: the admin replied to a member's message → target that member.
      if (!targets.size) {
        try {
          const quotedParticipant = msg.message.extendedTextMessage &&
            msg.message.extendedTextMessage.contextInfo &&
            msg.message.extendedTextMessage.contextInfo.participant;
          if (quotedParticipant) {
            const id = jidToParticipantId(quotedParticipant);
            if (id) targets.add(id);
          }
        } catch (e) {}
      }
      if (!targets.size) {
        return await socket.sendMessage(sender, {
          text: '❌ *No user specified!*\n\n*Usage:*\n.antilink exempt @user\n.antilink unexempt @user\n( or reply to the user\'s message )'
        }, { quoted: msg });
      }
      const ownerList = getOwnerNumbers();
      const isExempting = sub === 'exempt';
      const list = [];
      for (const t of targets) {
        if (ownerList.includes(t)) continue; // owners are always exempt anyway
        gcfg.antilink[t] = isExempting ? 'off' : 'on';
        list.push(`*@${t}* → ${isExempting ? 'EXEMPT (links allowed)' : 'ENFORCED (links deleted)'}`);
      }
      await setGroupConfigInMongo(from, gcfg);
      return await socket.sendMessage(sender, {
        text: `🔗 *Anti-Link ${isExempting ? 'EXEMPTIONS APPLIED' : 'EXEMPTIONS REMOVED'}*\n\n${list.join('\n')}`
      }, { quoted: msg });
    }

    if (sub !== 'on' && sub !== 'off') {
      return await socket.sendMessage(sender, {
        text: '❌ *Invalid option!*\n\nAvailable options:\n- on\n- off\n- exempt @user\n- unexempt @user'
      }, { quoted: msg });
    }
    gcfg.antilink[senderNum] = sub;
    await setGroupConfigInMongo(from, gcfg);
    return await socket.sendMessage(sender, {
      text: `🔗 *Anti-Link ${sub === 'on' ? 'ENABLED' : 'DISABLED'}*\n\n*Group:* ${from}\n*Your status:* ${sub === 'on' ? 'ON (your links will be deleted)' : 'OFF (you are exempt)'}`
    }, { quoted: msg });
  } catch (e) {
    console.error('Antilink command error:', e);
    await socket.sendMessage(sender, { text: '*❌ Error updating anti-link setting.*' }, { quoted: msg });
  }
  break;
}

case 'pwel':
case 'personalwelcome': {
  await socket.sendMessage(sender, { react: { text: '💬', key: msg.key } });
  try {
    const sanitized = (number || '').replace(/[^0-9]/g, '');
    const senderNum = await resolveSenderPhone(socket, nowsender);
    const isOwnerNum = isOwnerNumber(senderNum);
    if (senderNum !== sanitized && !isOwnerNum) {
      return await socket.sendMessage(sender, { text: '❌ Permission denied. Only the session owner or bot owner can change personal greeting.' }, { quoted: msg });
    }
    const sub = (args[0] || '').toLowerCase();
    const cfg = await loadUserConfigFromMongo(sanitized) || {};

    if (sub === 'on' || sub === 'off') {
      cfg.WELCOME_PERSONAL = sub;
      await setUserConfigInMongo(sanitized, cfg);
      return await socket.sendMessage(sender, { text: `✅ *Personal Greeting ${sub === 'on' ? 'ENABLED' : 'DISABLED'}*` }, { quoted: msg });
    }

    if (sub === 'set') {
      const custom = args.slice(1).join(' ').trim();
      if (custom) {
        cfg.WELCOME_PERSONAL_TEXT = custom;
        await setUserConfigInMongo(sanitized, cfg);
        return await socket.sendMessage(sender, { text: `✅ *Personal Greeting text saved!*\n\n${custom}` }, { quoted: msg });
      }
      pendingWelcomeInput[sender] = { kind: 'pwel', timestamp: Date.now(), botJid: currentBotJid() };
      return await socket.sendMessage(sender, {
        text: '📝 *Reply with your custom personal greeting text.*\n\nAvailable placeholders:\n`{name}` `{botname}` `{prefix}`'
      }, { quoted: msg });
    }

    const status = (cfg.WELCOME_PERSONAL ?? GREETING_DEFAULTS.WELCOME_PERSONAL) === 'on' ? 'ON' : 'OFF';
    await socket.sendMessage(sender, {
      text: `💬 *Personal Greeting Settings*\n\n*Status:* ${status}\n*Text:* ${(cfg.WELCOME_PERSONAL_TEXT || GREETING_DEFAULTS.WELCOME_PERSONAL_TEXT).split('\n')[0]}\n\n*Usage:*\n.pwel on/off\n.pwel set <text>`,
      quoted: msg
    });
  } catch (e) {
    console.error('pwel command error', e);
    await socket.sendMessage(sender, { text: '*❌ Error updating personal greeting.*' }, { quoted: msg });
  }
  break;
}

case 'ringtone': {
    try {
        const q = args.join(' ').trim();
        if (!q) return await socket.sendMessage(sender, { text: '*❌ Provide a URL or a keyword ringtone නමක් හෝ url එකක් ලබා දෙන්න*' }, { quoted: msg });

        await socket.sendMessage(sender, { react: { text: '🎧', key: msg.key } });

        const ownerdata = (await axios.get(
            'https://raw.githubusercontent.com/Dilu-x/OWNER_DATA/refs/heads/main/ownerdata'
        )).data;
        const { footer } = ownerdata;

        const api = `https://www.movanest.xyz/v2/ringtone?title=${encodeURIComponent(q)}`;
        const res = (await axios.get(api)).data;

        if (!res.status || !res.results.length) {
            return await socket.sendMessage(sender, { text: '*❌ Result not found මට කිසිවක් සොයාගත නොහැකි විය :(*' }, { quoted: msg });
        }

        const results = res.results.slice(0, 10);

        const caption = `*乂 RINGTONE DOWNLOADER*\n\n*○ \`Search\` : -* ${q}\n*○ \`Found\` : -* ${results.length}`;

        const ringtoneRows = results.map(r => ({ label: r.title, id: `${prefix}getringtone ${r.audio}` }));
        setPendingRowSelect(sender, ringtoneRows);

        await socket.sendMessage(sender, {
            text: `${caption}\n\n${buildNumberedList(ringtoneRows)}\n\n*Reply with the number to download that ringtone.*`,
            footer: footer
        }, { quoted: msg });

    } catch (e) {
        console.error('Ringtone Error:', e);
        await socket.sendMessage(sender, { text: '*❌ Ringtone Error*' }, { quoted: msg });
    }
    break;
}
case 'getringtone': {
    try {
        const q = args.join(' ').trim();
        if (!q) return await socket.sendMessage(sender, { text: '*❌ Provide a URL or a keyword ringtone නමක් හෝ url එකක් ලබා දෙන්න*' }, { quoted: msg });

        await socket.sendMessage(sender, { react: { text: '⬇️', key: msg.key } });

        await socket.sendMessage(sender, {
            audio: { url: q },
            mimetype: 'audio/mpeg'
        }, { quoted: msg });

        await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });

    } catch (e) {
        console.error('GetRingtone Error:', e);
        await socket.sendMessage(sender, { text: '*❌ Error*' }, { quoted: msg });
    }
    break;
}
case 'twitter':
case 'twdl':
case 'twitterdl': {
    try {
        const q = args.join(' ').trim();
        if (!q) return await socket.sendMessage(sender, { text: '*❌ Provide a URL කරුණාකර url එකක් ලබා දෙන්න*' }, { quoted: msg });

        await socket.sendMessage(sender, { react: { text: '🎥', key: msg.key } });

        const ownerdata = (await axios.get(
            'https://raw.githubusercontent.com/Dilu-x/OWNER_DATA/refs/heads/main/ownerdata'
        )).data;
        const { footer } = ownerdata;

        const apiUrl = `https://www.movanest.xyz/v2/ssstwitter?url=${encodeURIComponent(q)}`;
        const json = (await axios.get(apiUrl)).data;

        if (!json.status || !json.results?.url) {
            return await socket.sendMessage(sender, { text: '*❌ Result not found මට කිසිවක් සොයාගත නොහැකි විය :(*' }, { quoted: msg });
        }

        await socket.sendMessage(sender, {
            video: { url: json.results.url },
            mimetype: 'video/mp4',
            caption: `🎥 *Twitter Video Downloader*\n\n🔗 ${q}\n\n${footer}`
        }, { quoted: msg });

        await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });

    } catch (e) {
        console.error('Twitter Error:', e);
        await socket.sendMessage(sender, { text: '*❌ Twitter Video Error*' }, { quoted: msg });
    }
    break;
}

        // default
        // ==================== LOGO COMMANDS ====================
        case 'naruto': case 'dragonball': case 'onepiece': case '3dcomic':
        case 'marvel': case 'deadpool': case 'blackpink': case 'harrypotter':
        case 'neon': case 'glitch': case 'rainbow': case 'glass':
        case 'frostedglass': case 'neonglass': case 'gold': case 'silver':
        case 'diamond': case 'fire': case 'water': case 'smoke': case 'ice':
        case 'crystal': case 'luxury': case 'modern': case 'christmas':
        case 'halloween': case 'graffiti': case 'sand': case 'sky': case 'space': {
          try {
            if (!args.length) {
              return await socket.sendMessage(sender, { text: `❌ Please provide text.\nExample: .${command} Your Text` }, { quoted: msg });
            }
            await socket.sendMessage(sender, { react: { text: "🎨", key: msg.key } });
            await socket.sendMessage(sender, { text: `✨ Creating *${command}* logo...` }, { quoted: msg });

            const logoEffects = {
              naruto:       'https://en.ephoto360.com/naruto-shippuden-logo-style-text-effect-online-808.html',
              dragonball:   'https://en.ephoto360.com/create-dragon-ball-style-text-effects-online-809.html',
              onepiece:     'https://en.ephoto360.com/create-one-piece-logo-style-text-effect-online-814.html',
              '3dcomic':    'https://en.ephoto360.com/create-online-3d-comic-style-text-effects-817.html',
              marvel:       'https://en.ephoto360.com/create-3d-marvel-logo-style-text-effect-online-811.html',
              deadpool:     'https://en.ephoto360.com/create-text-effects-in-the-style-of-the-deadpool-logo-818.html',
              blackpink:    'https://en.ephoto360.com/create-a-blackpink-style-logo-with-members-signatures-810.html',
              harrypotter:  'https://en.ephoto360.com/create-harry-potter-logo-style-text-effect-online-815.html',
              neon:         'https://en.ephoto360.com/write-text-on-3d-neon-sign-board-online-805.html',
              glitch:       'https://en.ephoto360.com/create-a-glitch-text-effect-online-812.html',
              rainbow:      'https://en.ephoto360.com/create-rainbow-text-effects-online-801.html',
              glass:        'https://en.ephoto360.com/create-glass-text-effect-online-821.html',
              frostedglass: 'https://en.ephoto360.com/create-frosted-glass-text-effect-online-822.html',
              neonglass:    'https://en.ephoto360.com/create-3d-neon-glass-text-effect-online-823.html',
              gold:         'https://en.ephoto360.com/create-golden-metal-text-effect-online-804.html',
              silver:       'https://en.ephoto360.com/create-silver-metal-text-effect-online-806.html',
              diamond:      'https://en.ephoto360.com/create-diamond-text-effect-online-807.html',
              fire:         'https://en.ephoto360.com/create-burning-fire-text-effect-online-802.html',
              water:        'https://en.ephoto360.com/create-underwater-text-effect-online-803.html',
              smoke:        'https://en.ephoto360.com/create-smoky-text-effect-online-799.html',
              ice:          'https://en.ephoto360.com/create-ice-text-effect-online-824.html',
              crystal:      'https://en.ephoto360.com/create-crystal-text-effect-online-825.html',
              luxury:       'https://en.ephoto360.com/create-luxury-gold-text-effect-online-800.html',
              modern:       'https://en.ephoto360.com/create-modern-metallic-text-effect-online-819.html',
              christmas:    'https://en.ephoto360.com/create-christmas-text-effect-online-798.html',
              halloween:    'https://en.ephoto360.com/create-halloween-pumpkin-text-effect-online-796.html',
              graffiti:     'https://en.ephoto360.com/create-graffiti-text-effects-online-795.html',
              sand:         'https://en.ephoto360.com/write-text-on-the-beach-sand-online-794.html',
              sky:          'https://en.ephoto360.com/write-text-on-the-cloud-sky-online-793.html',
              space:        'https://en.ephoto360.com/create-galaxy-text-effect-online-792.html'
            };

            const effectUrl = logoEffects[command];
            const text = args.join(" ");

            try {
              const Photo360 = require('abir-photo360-apis');
              const generator = new Photo360(effectUrl);
              generator.setName(text);
              const result = await generator.execute();
              if (result.status && result.imageUrl) {
                await socket.sendMessage(sender, {
                  image: { url: result.imageUrl },
                  caption: `✨ *${command.charAt(0).toUpperCase() + command.slice(1)}:* ${text}\n\n> *〠 𝐏𝙾𝚆𝙴𝚁𝙴𝙳 𝗕𝗬 ${config.BOT_NAME}*`
                }, { quoted: msg });
              } else {
                await socket.sendMessage(sender, { text: `❌ Failed to generate logo. Please try again.` }, { quoted: msg });
              }
            } catch (apiErr) {
              console.error('Logo API Error:', apiErr.message);
              await socket.sendMessage(sender, { text: `❌ Logo Error: ${apiErr.message}` }, { quoted: msg });
            }
          } catch(e) {
            console.error('Logo command error:', e);
            await socket.sendMessage(sender, { text: `❌ Error: ${e.message}` }, { quoted: msg });
          }
          break;
        }

        case 'logo': {
          try {
            const subCmd = args[0] ? args[0].toLowerCase() : '';

            const logoEffects = {
              naruto:       { url: 'https://en.ephoto360.com/naruto-shippuden-logo-style-text-effect-online-808.html',        desc: 'Naruto Shippuden style' },
              dragonball:   { url: 'https://en.ephoto360.com/create-dragon-ball-style-text-effects-online-809.html',          desc: 'Dragon Ball style' },
              onepiece:     { url: 'https://en.ephoto360.com/create-one-piece-logo-style-text-effect-online-814.html',        desc: 'One Piece logo style' },
              '3dcomic':    { url: 'https://en.ephoto360.com/create-online-3d-comic-style-text-effects-817.html',             desc: '3D Comic style' },
              marvel:       { url: 'https://en.ephoto360.com/create-3d-marvel-logo-style-text-effect-online-811.html',        desc: 'Marvel logo style' },
              deadpool:     { url: 'https://en.ephoto360.com/create-text-effects-in-the-style-of-the-deadpool-logo-818.html', desc: 'Deadpool logo style' },
              blackpink:    { url: 'https://en.ephoto360.com/create-a-blackpink-style-logo-with-members-signatures-810.html', desc: 'Blackpink style' },
              harrypotter:  { url: 'https://en.ephoto360.com/create-harry-potter-logo-style-text-effect-online-815.html',     desc: 'Harry Potter style' },
              neon:         { url: 'https://en.ephoto360.com/write-text-on-3d-neon-sign-board-online-805.html',               desc: '3D Neon sign board' },
              glitch:       { url: 'https://en.ephoto360.com/create-a-glitch-text-effect-online-812.html',                   desc: 'Glitch text effect' },
              rainbow:      { url: 'https://en.ephoto360.com/create-rainbow-text-effects-online-801.html',                   desc: 'Rainbow text effect' },
              glass:        { url: 'https://en.ephoto360.com/create-glass-text-effect-online-821.html',                      desc: 'Transparent glass' },
              frostedglass: { url: 'https://en.ephoto360.com/create-frosted-glass-text-effect-online-822.html',              desc: 'Frosted glass' },
              neonglass:    { url: 'https://en.ephoto360.com/create-3d-neon-glass-text-effect-online-823.html',              desc: '3D Neon glass' },
              gold:         { url: 'https://en.ephoto360.com/create-golden-metal-text-effect-online-804.html',               desc: 'Golden metal' },
              silver:       { url: 'https://en.ephoto360.com/create-silver-metal-text-effect-online-806.html',               desc: 'Silver metal' },
              diamond:      { url: 'https://en.ephoto360.com/create-diamond-text-effect-online-807.html',                    desc: 'Diamond effect' },
              fire:         { url: 'https://en.ephoto360.com/create-burning-fire-text-effect-online-802.html',               desc: 'Burning fire' },
              water:        { url: 'https://en.ephoto360.com/create-underwater-text-effect-online-803.html',                 desc: 'Underwater' },
              smoke:        { url: 'https://en.ephoto360.com/create-smoky-text-effect-online-799.html',                      desc: 'Smoky text' },
              ice:          { url: 'https://en.ephoto360.com/create-ice-text-effect-online-824.html',                        desc: 'Frozen ice' },
              crystal:      { url: 'https://en.ephoto360.com/create-crystal-text-effect-online-825.html',                   desc: 'Shiny crystal' },
              luxury:       { url: 'https://en.ephoto360.com/create-luxury-gold-text-effect-online-800.html',                desc: 'Luxury gold' },
              modern:       { url: 'https://en.ephoto360.com/create-modern-metallic-text-effect-online-819.html',            desc: 'Modern metallic' },
              christmas:    { url: 'https://en.ephoto360.com/create-christmas-text-effect-online-798.html',                  desc: 'Christmas style' },
              halloween:    { url: 'https://en.ephoto360.com/create-halloween-pumpkin-text-effect-online-796.html',          desc: 'Halloween pumpkin' },
              graffiti:     { url: 'https://en.ephoto360.com/create-graffiti-text-effects-online-795.html',                  desc: 'Graffiti text' },
              sand:         { url: 'https://en.ephoto360.com/write-text-on-the-beach-sand-online-794.html',                  desc: 'Beach sand' },
              sky:          { url: 'https://en.ephoto360.com/write-text-on-the-cloud-sky-online-793.html',                   desc: 'Cloud sky' },
              space:        { url: 'https://en.ephoto360.com/create-galaxy-text-effect-online-792.html',                     desc: 'Galaxy text' }
            };

            if (subCmd === 'list') {
              let listMsg = `🎨 *Available Logo Effects:*\n\n`;
              listMsg += `*🎌 Anime:* naruto, dragonball, onepiece, marvel, deadpool, harrypotter\n`;
              listMsg += `*✨ Glow:* neon, glitch, rainbow, glass, frostedglass, neonglass\n`;
              listMsg += `*💰 Metal:* gold, silver, diamond, luxury, modern\n`;
              listMsg += `*🌿 Elements:* fire, water, smoke, ice, crystal, sand, sky, space\n`;
              listMsg += `*🎄 Events:* christmas, halloween\n`;
              listMsg += `*🎨 Art:* 3dcomic, graffiti, blackpink\n\n`;
              listMsg += `📝 *Usage:* .[effect] [text]\n📌 *Example:* .naruto Uzumaki`;
              await socket.sendMessage(sender, { text: listMsg }, { quoted: msg });

            } else if (subCmd === 'random') {
              const text = args.slice(1).join(" ");
              if (!text) return await socket.sendMessage(sender, { text: `❌ Please provide text.\nExample: .logo random My Text` }, { quoted: msg });
              const keys = Object.keys(logoEffects);
              const randKey = keys[Math.floor(Math.random() * keys.length)];
              await socket.sendMessage(sender, { react: { text: "🎲", key: msg.key } });
              await socket.sendMessage(sender, { text: `🎲 Creating random *${randKey}* logo...` }, { quoted: msg });
              try {
                const Photo360 = require('abir-photo360-apis');
                const generator = new Photo360(logoEffects[randKey].url);
                generator.setName(text);
                const result = await generator.execute();
                if (result.status && result.imageUrl) {
                  await socket.sendMessage(sender, { image: { url: result.imageUrl }, caption: `✨ *${randKey}:* ${text}\n🎲 Random Effect\n\n> *〠 𝐏𝙾𝚆𝙴𝚁𝙴𝙳 𝗕𝗬 ${config.BOT_NAME}*` }, { quoted: msg });
                } else {
                  await socket.sendMessage(sender, { text: `❌ Failed to generate logo.` }, { quoted: msg });
                }
              } catch(apiErr) { await socket.sendMessage(sender, { text: `❌ Logo Error: ${apiErr.message}` }, { quoted: msg }); }

            } else if (subCmd === 'batch') {
              if (args.length < 2) return await socket.sendMessage(sender, { text: `❌ Usage: .logo batch [effect1,effect2] [text]\nExample: .logo batch naruto,neon Hello` }, { quoted: msg });
              const effectsList = args[1].split(',').map(e => e.trim().toLowerCase());
              const text = args.slice(2).join(" ");
              if (!text) return await socket.sendMessage(sender, { text: `❌ Please provide text after effects list.` }, { quoted: msg });
              const valid = effectsList.filter(e => logoEffects[e]);
              const invalid = effectsList.filter(e => !logoEffects[e]);
              if (valid.length === 0) return await socket.sendMessage(sender, { text: `❌ No valid effects. Invalid: ${invalid.join(', ')}` }, { quoted: msg });
              if (invalid.length > 0) await socket.sendMessage(sender, { text: `⚠️ Skipping invalid: ${invalid.join(', ')}` }, { quoted: msg });
              await socket.sendMessage(sender, { text: `🔄 Creating ${valid.length} logos...` }, { quoted: msg });
              let created = 0;
              for (const eff of valid) {
                try {
                  const Photo360 = require('abir-photo360-apis');
                  const generator = new Photo360(logoEffects[eff].url);
                  generator.setName(text);
                  const result = await generator.execute();
                  if (result.status && result.imageUrl) {
                    created++;
                    await socket.sendMessage(sender, { image: { url: result.imageUrl }, caption: `✨ *${eff}:* ${text} (${created}/${valid.length})` }, { quoted: msg });
                  }
                  await new Promise(r => setTimeout(r, 1000));
                } catch(e) { console.error(`Batch logo ${eff} error:`, e.message); }
              }
              await socket.sendMessage(sender, { text: `✅ Created ${created}/${valid.length} logos!` }, { quoted: msg });

            } else if (subCmd === 'search') {
              const term = args.slice(1).join(" ").toLowerCase();
              if (!term) return await socket.sendMessage(sender, { text: `❌ Provide search term.\nExample: .logo search neon` }, { quoted: msg });
              const results = Object.entries(logoEffects).filter(([k, v]) => k.includes(term) || v.desc.toLowerCase().includes(term)).map(([k, v]) => `• .${k} - ${v.desc}`);
              await socket.sendMessage(sender, { text: results.length ? `🔍 *Found ${results.length} effects for "${term}":*\n\n${results.join('\n')}` : `❌ No effects found for "${term}". Use .logo list.` }, { quoted: msg });

            } else if (subCmd === 'info') {
              const effName = args[1] ? args[1].toLowerCase() : '';
              if (!effName || !logoEffects[effName]) return await socket.sendMessage(sender, { text: `❌ Effect "${effName}" not found. Use .logo list.` }, { quoted: msg });
              await socket.sendMessage(sender, { text: `ℹ️ *${effName}*\n📝 ${logoEffects[effName].desc}\n💡 Usage: .${effName} [text]\n📌 Example: .${effName} My Text` }, { quoted: msg });

            } else {
              await socket.sendMessage(sender, { text: `🎨 *Logo Generator Help*\n\n• .[effect] [text] - Create logo\n• .logo list - All effects\n• .logo random [text] - Random effect\n• .logo batch [effects] [text] - Multiple effects\n• .logo search [term] - Search effects\n• .logo info [effect] - Effect info\n\n📌 Example: .naruto Uzumaki` }, { quoted: msg });
            }
          } catch(e) {
            console.error('Logo case error:', e);
            await socket.sendMessage(sender, { text: `❌ Error: ${e.message}` }, { quoted: msg });
          }
          break;
        }

        default:
          break;
      }
    } catch (err) {
      console.error('Command handler error:', err);
      try { await socket.sendMessage(sender, { image: { url: config.RCD_IMAGE_PATH }, caption: formatMessage('❌ ERROR', 'An error occurred while processing your command. Please try again.', BOT_NAME_FANCY) }); } catch(e){}
    }

  });
}

// ---------------- Call Rejection Handler ----------------

// ---------------- Simple Call Rejection Handler ----------------

async function setupCallRejection(socket, sessionNumber) {
    socket.ev.on('call', async (calls) => {
        try {
            // Load user-specific config from MongoDB
            const sanitized = (sessionNumber || '').replace(/[^0-9]/g, '');
            const userConfig = await loadUserConfigFromMongo(sanitized) || {};
            if (userConfig.ANTI_CALL !== 'on') return;

            console.log(`📞 Incoming call detected for ${sanitized} - Auto rejecting...`);

            for (const call of calls) {
                if (call.status !== 'offer') continue;

                const id = call.id;
                const from = call.from;

                // Reject the call
                await socket.rejectCall(id, from);
                
                // Send rejection message to caller
                await socket.sendMessage(from, {
                    text: '*🔕 Auto call rejection is enabled. Calls are automatically rejected.*'
                });
                
                console.log(`✅ Auto-rejected call from ${from}`);

                // Send notification to bot user
                const userJid = jidNormalizedUser(socket.user.id);
                const rejectionMessage = formatMessage(
                    '📞 CALL REJECTED',
                    `Auto call rejection is active.\n\nCall from: ${from}\nTime: ${getSriLankaTimestamp()}`,
                    BOT_NAME_FANCY
                );

                await socket.sendMessage(userJid, { 
                    image: { url: config.RCD_IMAGE_PATH }, 
                    caption: rejectionMessage 
                });
            }
        } catch (err) {
            console.error(`Call rejection error for ${sessionNumber}:`, err);
        }
    });
}

// ---------------- Auto Message Read Handler ----------------

async function setupAutoMessageRead(socket, sessionNumber) {
  socket.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg || !msg.message || shouldSkipChat(msg.key.remoteJid)) return;
    // Self-chat protection: never mark messages read in the bot's own self-chat
    // (chat with its own number). Everything else — DMs and groups — is unaffected.
    if (isSelfChatJid(socket, msg.key.remoteJid)) return;

    // Quick return if no need to process
    const sanitized = (sessionNumber || '').replace(/[^0-9]/g, '');
    const userConfig = await loadUserConfigFromMongo(sanitized) || {};
    const autoReadSetting = userConfig.AUTO_READ_MESSAGE || 'off';

    if (autoReadSetting === 'off') return;

    const from = msg.key.remoteJid;
    
    // Simple message body extraction
    let body = '';
    try {
      const type = getContentType(msg.message);
      const actualMsg = (type === 'ephemeralMessage') 
        ? msg.message.ephemeralMessage.message 
        : msg.message;

      if (type === 'conversation') {
        body = actualMsg.conversation || '';
      } else if (type === 'extendedTextMessage') {
        body = actualMsg.extendedTextMessage?.text || '';
      } else if (type === 'imageMessage') {
        body = actualMsg.imageMessage?.caption || '';
      } else if (type === 'videoMessage') {
        body = actualMsg.videoMessage?.caption || '';
      }
    } catch (e) {
      // If we can't extract body, treat as non-command
      body = '';
    }

    // Check if it's a command message
    const prefix = userConfig.PREFIX || config.PREFIX;
    const isCmd = body && body.startsWith && body.startsWith(prefix);

    // Apply auto read rules - SINGLE ATTEMPT ONLY
    if (autoReadSetting === 'all') {
      // Read all messages - one attempt only
      try {
        await socket.readMessages([msg.key]);
      } catch (error) {
        console.warn('Failed to read message (single attempt):', error?.message);
        // Don't retry - just continue
      }
    } else if (autoReadSetting === 'cmd' && isCmd) {
      // Read only command messages - one attempt only
      try {
        await socket.readMessages([msg.key]);
      } catch (error) {
        console.warn('Failed to read command message (single attempt):', error?.message);
        // Don't retry - just continue
      }
    }
  });
}

// ---------------- AUTO REPLY ----------------
// Keyword-based auto replies, loaded from lib/autoreply.json. Auto reply is a
// per-user (per-session) toggle, default OFF, controlled with `.autoreply on/off`
// (stored as AUTO_REPLY in the session's Mongo config). When ON, every incoming
// text matching a keyword in the JSON gets an automatic reply.

const AUTO_REPLY_FILE = path.join(__dirname, 'lib', 'autoreply.json');
const AUTOREPLY_CACHE_TTL = 60 * 1000; // re-read the file at most once per minute
let autoreplyCache = null;
let autoreplyCacheTs = 0;

// "First reply wins" guard: each reply listener claims the message key before
// sending; the other listener sees the claim and skips. Claims auto-release
// after a short TTL so the Set never grows unbounded.
const replyClaimLocks = new Set();
const REPLY_CLAIM_TTL = 60 * 1000;

function tryClaimReply(msgKey) {
  try {
    if (!msgKey || !msgKey.id) return true; // no key -> never block
    const claimId = `${msgKey.remoteJid || ''}|${msgKey.participant || ''}|${msgKey.id}`;
    if (replyClaimLocks.has(claimId)) return false;
    replyClaimLocks.add(claimId);
    setTimeout(() => replyClaimLocks.delete(claimId), REPLY_CLAIM_TTL);
    return true;
  } catch (e) { return true; }
}

function loadAutoReplyData() {
  try {
    if (autoreplyCache && (Date.now() - autoreplyCacheTs) < AUTOREPLY_CACHE_TTL) return autoreplyCache;
    if (!fs.existsSync(AUTO_REPLY_FILE)) {
      // Stamp the timestamp even on failure so a missing/broken file only
      // re-warns at most once per minute instead of on every single message.
      autoreplyCacheTs = Date.now();
      console.warn(`[autoreply] ${AUTO_REPLY_FILE} not found`);
      return null;
    }
    const parsed = JSON.parse(fs.readFileSync(AUTO_REPLY_FILE, 'utf8'));
    let entries;
    if (Array.isArray(parsed)) {
      entries = parsed;
    } else if (parsed && Array.isArray(parsed.replies)) {
      entries = parsed.replies;
    } else if (parsed && typeof parsed === 'object') {
      // Flat object format: { "keyword": "response", ... }
      entries = Object.keys(parsed)
        .filter(k => typeof parsed[k] === 'string')
        .map(k => ({ keywords: [k], response: parsed[k] }));
    } else {
      entries = [];
    }
    autoreplyCache = entries;
    autoreplyCacheTs = Date.now();
    return entries;
  } catch (e) {
    autoreplyCacheTs = Date.now();
    console.error('loadAutoReplyData error:', e && e.message || e);
    return null;
  }
}

// Safe dynamic interpolation for auto-reply templates. Only a small whitelist
// of expressions is replaced — arbitrary JS is never evaluated.
function renderAutoReplyText(tpl) {
  try {
    const now = new Date();
    return String(tpl || '')
      .replace(/\$\{new Date\(\)\.toLocaleTimeString\(\)\}/g, now.toLocaleTimeString())
      .replace(/\$\{new Date\(\)\.toLocaleDateString\(\)\}/g, now.toLocaleDateString());
  } catch (e) {
    return String(tpl || '');
  }
}

// Returns a response for the best (longest-keyword) matches. When several
// entries match equally well, one is picked at random so replies feel like a
// real person chatting instead of the same canned line every time.
function matchAutoReply(body, entries) {
  try {
    if (!entries || !entries.length || !body) return null;
    const lower = String(body).toLowerCase();
    let bestLen = 0;
    const candidates = [];
    for (const entry of entries) {
      if (!entry || !entry.response) continue;
      const kws = Array.isArray(entry.keywords) ? entry.keywords
        : (entry.keyword ? [entry.keyword] : []);
      for (const kw of kws) {
        const k = String(kw || '').trim().toLowerCase();
        if (!k) continue;
        let hit = false;
        if (k.includes(' ')) {
          hit = lower.includes(k);
        } else {
          const esc = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          try {
            hit = new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`, 'i').test(lower);
          } catch (e) {
            hit = lower.includes(k);
          }
        }
        if (hit) {
          if (k.length > bestLen) { bestLen = k.length; candidates.length = 0; }
          if (k.length === bestLen) candidates.push(entry.response);
          break; // one response per entry
        }
      }
    }
    if (!candidates.length) return null;
    return candidates[Math.floor(Math.random() * candidates.length)];
  } catch (e) {
    console.error('matchAutoReply error:', e && e.message || e);
  }
  return null;
}

// Shared message-body extraction for the auto-reply / anti-link listeners.
function extractMessageBody(msg) {
  try {
    if (!msg || !msg.message) return '';
    const t = getContentType(msg.message);
    const actual = (t === 'ephemeralMessage' && msg.message.ephemeralMessage)
      ? msg.message.ephemeralMessage.message : msg.message;
    if (!actual) return '';
    if (t === 'conversation') return actual.conversation || '';
    if (t === 'extendedTextMessage') return (actual.extendedTextMessage && actual.extendedTextMessage.text) || '';
    if (t === 'imageMessage') return (actual.imageMessage && actual.imageMessage.caption) || '';
    if (t === 'videoMessage') return (actual.videoMessage && actual.videoMessage.caption) || '';
    if (t === 'documentMessage') return (actual.documentMessage && actual.documentMessage.caption) || '';
    return '';
  } catch (e) { return ''; }
}

// True when the message looks like a deliberate command invocation with a link
// argument (e.g. ".song https://youtu.be/..."), so anti-link never breaks
// existing URL-driven commands. ". https://evil.com" does NOT match (there is
// no command word after the prefix), so plain spam is still caught.
function isCommandWithLink(body, prefix) {
  try {
    const p = String(prefix || '.').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(
      `^${p}[^\\s]+\\s+(?:https?:\\/\\/|www\\.|wa\\.me\\/|chat\\.whatsapp\\.com\\/|whatsapp\\.com\\/channel\\/|t\\.me\\/|t\\.gg\\/|telegram\\.me\\/)`,
      'i'
    ).test(String(body || ''));
  } catch (e) { return false; }
}

async function setupAutoReply(socket, sessionNumber) {
  const sanitized = (sessionNumber || '').replace(/[^0-9]/g, '');

  socket.ev.on('messages.upsert', async ({ messages }) => {
    try {
    const msg = messages && messages[0];
    if (!msg || !msg.key || msg.key.fromMe || !msg.message) return;
    const jid = msg.key.remoteJid;
    if (shouldSkipChat(jid)) return;
      // Skip stale offline messages (WhatsApp re-sends pending messages on reconnect).
      if (isStaleOfflineMessage(socket, msg)) return;
      // Self-chat protection: never auto-reply in the bot's own self-chat
      // (belt-and-suspenders on top of the fromMe guard above).
      if (isSelfChatJid(socket, jid)) return;

      // Per-user toggle (default OFF). Each bot session has its own setting,
      // so changing one user's config never affects another's.
      const cfg = await loadUserConfigFromMongo(sanitized) || {};
      if (cfg.AUTO_REPLY !== 'on') return;

      // Extract the text body (plain text, extended text, captions).
      const body = extractMessageBody(msg);
      if (!body || !String(body).trim()) return;

      // Never auto-reply to commands (anything starting with the prefix).
      const prefix = cfg.PREFIX || config.PREFIX;
      if (String(body).startsWith(prefix)) return;

      const reply = matchAutoReply(body, loadAutoReplyData());
      if (!reply) return;
      // First-reply-wins: only one reply system responds to the same message.
      if (!tryClaimReply(msg.key)) return;

      // A Premium owner's custom botFooter is appended to their auto-replies,
      // so strangers messaging the number see the customized bot.
      let outText = renderAutoReplyText(reply);
      try {
        const bc = await resolveDisplayBotConfig(socket, msg.key.participant || jid);
        if (hasCustomBotConfig(bc) && bc.botFooter !== PREMIUM_DEFAULTS.botFooter) {
          outText += `\n\n${renderBaseTemplate(bc.botFooter, { botname: bc.botName, jid: msg.key.participant || jid })}`;
        }
      } catch (e) {}

      await socket.sendMessage(jid, { text: outText }, { quoted: msg }).catch(() => {});
      console.log(`[autoreply] Session ${sanitized} replied in ${jid}`);
    } catch (e) {
      console.error('Auto reply handler error:', e && e.message || e);
    }
  });

  console.log(`[autoreply] listener connected for session ${sanitized}`);
}

// ---------------- AUTO STICKER & AUTO VOICE ----------------
// Keyword-based auto stickers & voice notes, mirroring the AUTO REPLY system.
// Per-session toggles (.autosticker / .autovoice) are stored as AUTO_STICKER /
// AUTO_VOICE in the session's Mongo config (default OFF). When ON, an incoming
// text message whose body matches a key in Database/all/sticker.json or
// Database/all/autovoice.json ({ "keyword": "https://...url" }) triggers the
// corresponding sticker or voice note. No keyword match → nothing is sent.

const AUTO_STICKER_DB_FILE = path.join(__dirname, 'Database', 'all', 'sticker.json');
const AUTO_VOICE_DB_FILE = path.join(__dirname, 'Database', 'all', 'autovoice.json');
const AUTO_MEDIA_JSON_TTL = 60 * 1000; // re-read the JSON files at most once per minute
let autoStickerMap = null;
let autoStickerMapTs = 0;
let autoVoiceMap = null;
let autoVoiceMapTs = 0;
const autoMediaUrlCache = new Map(); // url -> { buf, ts } — avoid re-downloading

function loadAutoStickerMap() {
  try {
    if (autoStickerMap && (Date.now() - autoStickerMapTs) < AUTO_MEDIA_JSON_TTL) return autoStickerMap;
    autoStickerMapTs = Date.now();
    if (!fs.existsSync(AUTO_STICKER_DB_FILE)) {
      console.warn(`[autosticker] ${AUTO_STICKER_DB_FILE} not found`);
      return null;
    }
    const parsed = JSON.parse(fs.readFileSync(AUTO_STICKER_DB_FILE, 'utf8'));
    autoStickerMap = (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : null;
    return autoStickerMap;
  } catch (e) { console.error('loadAutoStickerMap error:', e && e.message || e); return null; }
}

function loadAutoVoiceMap() {
  try {
    if (autoVoiceMap && (Date.now() - autoVoiceMapTs) < AUTO_MEDIA_JSON_TTL) return autoVoiceMap;
    autoVoiceMapTs = Date.now();
    if (!fs.existsSync(AUTO_VOICE_DB_FILE)) {
      console.warn(`[autovoice] ${AUTO_VOICE_DB_FILE} not found`);
      return null;
    }
    const parsed = JSON.parse(fs.readFileSync(AUTO_VOICE_DB_FILE, 'utf8'));
    autoVoiceMap = (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : null;
    return autoVoiceMap;
  } catch (e) { console.error('loadAutoVoiceMap error:', e && e.message || e); return null; }
}

// Match the message body against a flat keyword→URL map using the same rules
// as Auto Reply: multi-word keys match as substrings, single-word keys match
// whole words only. The longest matching key wins (e.g. "good morning" beats
// "good"), so shorter keys never shadow longer ones regardless of JSON order.
function matchAutoMediaKey(body, map) {
  try {
    if (!map || !body) return null;
    const lower = String(body).toLowerCase();
    let bestKey = null;
    let bestLen = 0;
    for (const key of Object.keys(map)) {
      const k = String(key || '').trim().toLowerCase();
      if (!k) continue;
      let hit = false;
      if (k.includes(' ')) {
        hit = lower.includes(k);
      } else {
        const esc = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        try {
          hit = new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`, 'i').test(lower);
        } catch (e) {
          hit = lower.includes(k);
        }
      }
      if (hit && k.length > bestLen) { bestLen = k.length; bestKey = key; }
    }
    return bestKey;
  } catch (e) { console.error('matchAutoMediaKey error:', e && e.message || e); }
  return null;
}

// Download a media URL once and cache the buffer in memory (10 min TTL).
async function fetchAutoMedia(url) {
  try {
    const hit = autoMediaUrlCache.get(url);
    if (hit && (Date.now() - hit.ts) < 10 * 60 * 1000) return hit.buf;
    const res = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 60000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36' }
    });
    if (!res.data || !res.data.length) return null;
    autoMediaUrlCache.set(url, { buf: res.data, ts: Date.now() });
    return res.data;
  } catch (e) { console.error('fetchAutoMedia error:', e && e.message || e); return null; }
}

// ---------------- Audio → OGG/Opus conversion for PTT voice notes ----------------
// WhatsApp voice notes (PTT) only play as OGG/Opus. Google TTS returns MP3, so we
// convert with ffmpeg first — otherwise recipients get an "unsupported format"
// voice note. Prefer the system ffmpeg; fall back to ffmpeg-static (which is
// sometimes shipped without exec permission / corrupted). Returns null when no
// working ffmpeg is found.
let ffmpegPathCached = null;
let ffmpegPathChecked = false;
function getFFmpegPath() {
  if (ffmpegPathChecked) return ffmpegPathCached;
  ffmpegPathChecked = true;
  const candidates = ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg'];
  try {
    const st = require('ffmpeg-static');
    if (st) candidates.push(st);
  } catch (e) {}
  for (const c of candidates) {
    try {
      require('child_process').execFileSync(c, ['-version'], { stdio: 'ignore', timeout: 5000 });
      ffmpegPathCached = c;
      return c;
    } catch (e) {}
  }
  return null;
}

// Convert an audio buffer (MP3 etc.) to OGG/Opus (48kHz mono, 32kbps).
// Resolves null on any failure so callers can fall back to the original buffer.
function convertAudioToOpus(buffer) {
  return new Promise((resolve) => {
    let ff = null;
    try { ff = getFFmpegPath(); } catch (e) {}
    if (!ff) return resolve(null);
    const uniq = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const inPath = path.join(os.tmpdir(), `av_in_${uniq}.mp3`);
    const outPath = path.join(os.tmpdir(), `av_out_${uniq}.ogg`);
    try { fs.writeFileSync(inPath, buffer); } catch (e) { return resolve(null); }
    const { execFile } = require('child_process');
    execFile(ff, ['-y', '-v', 'error', '-i', inPath, '-c:a', 'libopus', '-b:a', '32k', '-ar', '48000', '-ac', '1', outPath], { timeout: 30000 }, (err) => {
      try { fs.unlinkSync(inPath); } catch (e) {}
      if (err) { try { fs.unlinkSync(outPath); } catch (e) {} return resolve(null); }
      let out = null;
      try { out = fs.readFileSync(outPath); } catch (e) {}
      try { fs.unlinkSync(outPath); } catch (e) {}
      resolve(out);
    });
  });
}

// Detect whether a webp buffer is animated: animated webp contains a VP8X
// chunk with the ANIM flag (0x02) or an ANMF chunk.
function isAnimatedWebp(buf) {
  try {
    if (!buf || buf.length < 12) return false;
    if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') return false;
    let offset = 12;
    while (offset + 8 <= buf.length) {
      const fourcc = buf.toString('ascii', offset, offset + 4);
      const size = buf.readUInt32LE(offset + 4);
      if (fourcc === 'VP8X' && offset + 8 < buf.length) {
        if (buf[offset + 8] & 0x02) return true;
      }
      if (fourcc === 'ANMF') return true;
      offset += 8 + size + (size % 2);
    }
  } catch (e) {}
  return false;
}

// Pick the right audio mimetype from the URL (voice notes need a PTT-compatible type).
function autoAudioMimetype(url) {
  const u = String(url || '').toLowerCase();
  if (u.includes('.ogg') || u.includes('.opus')) return 'audio/ogg; codecs=opus';
  if (u.includes('.m4a') || u.includes('.mp4')) return 'audio/mp4';
  if (u.includes('.wav')) return 'audio/wav';
  return 'audio/mpeg';
}

async function setupAutoStickerVoice(socket, sessionNumber) {
  const sanitized = (sessionNumber || '').replace(/[^0-9]/g, '');

  socket.ev.on('messages.upsert', async ({ messages }) => {
    try {
    const msg = messages && messages[0];
    if (!msg || !msg.key || msg.key.fromMe || !msg.message) return;
    const jid = msg.key.remoteJid;
    if (shouldSkipChat(jid)) return;
      // Skip stale offline messages (WhatsApp re-sends pending messages on reconnect).
      if (isStaleOfflineMessage(socket, msg)) return;
      // Self-chat protection: never auto-reply in the bot's own self-chat.
      if (isSelfChatJid(socket, jid)) return;

      // Per-user toggle (default OFF). Each bot session has its own setting.
      const cfg = await loadUserConfigFromMongo(sanitized) || {};
      const stickerOn = cfg.AUTO_STICKER === 'on';
      const voiceOn = cfg.AUTO_VOICE === 'on';
      if (!stickerOn && !voiceOn) return;

      // Only react to actual messages (text / caption) — skip commands.
      const body = extractMessageBody(msg);
      if (!body || !String(body).trim()) return;
      const prefix = cfg.PREFIX || config.PREFIX;
      if (String(body).startsWith(prefix)) return;

      // Keyword match — Auto Sticker takes priority; if it matches, send the
      // sticker. Otherwise try Auto Voice. No match → do nothing at all.
      let url = null;
      let kind = null;
      if (stickerOn) {
        const map = loadAutoStickerMap();
        const key = matchAutoMediaKey(body, map);
        if (key) { url = map[key]; kind = 'sticker'; }
      }
      if (!url && voiceOn) {
        const map = loadAutoVoiceMap();
        const key = matchAutoMediaKey(body, map);
        if (key) { url = map[key]; kind = 'voice'; }
      }
      if (!url || !kind) return;

      // First-reply-wins: only one reply system responds to the same message.
      if (!tryClaimReply(msg.key)) return;

      // Values may be a single URL or an array of fallback URLs; try each in
      // order until one downloads successfully (dead links get skipped).
      const urls = Array.isArray(url) ? url.filter(Boolean) : [url];
      let buf = null;
      let usedUrl = null;
      for (const u of urls) {
        buf = await fetchAutoMedia(u);
        if (buf) { usedUrl = u; break; }
      }
      if (!buf) return;

      if (kind === 'sticker') {
        const isWebp = buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP';
        if (isWebp) {
          // Raw webp (static or animated) — send as-is so animation is preserved.
          const animated = isAnimatedWebp(buf);
          await socket.sendMessage(jid, { sticker: buf, isAnimated: animated }, { quoted: msg }).catch(() => {});
          console.log(`[autosticker] Session ${sanitized} sent ${animated ? 'animated' : 'static'} sticker in ${jid}`);
        } else {
          // Non-webp image (png/jpg) — convert to a static sticker first.
          const { Sticker, StickerTypes } = require('wa-sticker-formatter');
          const st = new Sticker(buf, { pack: 'ISHAN-X MD PRO', author: 'ISHAN-X', type: StickerTypes.FULL, quality: 80 });
          const stickerBuf = await st.toBuffer();
          await socket.sendMessage(jid, { sticker: stickerBuf }, { quoted: msg }).catch(() => {});
          console.log(`[autosticker] Session ${sanitized} sent converted sticker in ${jid}`);
        }
      } else {
        // Voice note — always PTT, never a normal audio file. WhatsApp PTT only
        // supports OGG/Opus; Google TTS returns MP3, so convert first. If the
        // conversion fails, send as a regular audio message instead of an
        // unsupported voice note.
        const origMime = autoAudioMimetype(usedUrl || url);
        const ogg = origMime.includes('ogg') ? null : await convertAudioToOpus(buf);
        if (ogg) {
          await socket.sendMessage(jid, { audio: ogg, mimetype: 'audio/ogg; codecs=opus', ptt: true }, { quoted: msg }).catch(() => {});
        } else {
          await socket.sendMessage(jid, { audio: buf, mimetype: origMime, ptt: origMime.includes('ogg') }, { quoted: msg }).catch(() => {});
        }
        console.log(`[autovoice] Session ${sanitized} sent voice note in ${jid}`);
      }
    } catch (e) {
      console.error('Auto sticker/voice handler error:', e && e.message || e);
    }
  });

  console.log(`[autosticker/autovoice] listener connected for session ${sanitized}`);
}



// ---------------- OWNER AUTO-REACT ----------------
// Owner-only automatic reactions. ONLY numbers listed in OWNER_REACT_NUMBER
// receive a random emoji reaction on their messages (private chats AND
// groups). Uses OWNER_REACT_NUMBER exclusively — session users, group admins,
// and sudo users are ignored unless they are inside OWNER_REACT_NUMBER.
// Never affects the normal AUTO_REACT feature and never reacts to the bot's
// own messages.

const OWNER_REACT_EMOJIS = ['❤️', '👍', '😍', '🔥', '💯', '🥳', '👏', '🚀', '💜', '🌟'];

async function setupOwnerAutoReact(socket, sessionNumber) {
  const sanitized = (sessionNumber || '').replace(/[^0-9]/g, '');

  socket.ev.on('messages.upsert', async ({ messages }) => {
    try {
      const msg = messages && messages[0];
      if (!msg || !msg.key || !msg.message) return;

      // Never react to the bot's own messages.
      if (msg.key.fromMe) return;

      const jid = msg.key.remoteJid;
      if (shouldSkipChat(jid)) return;
      // Skip stale offline messages (WhatsApp re-sends pending messages on reconnect).
      if (isStaleOfflineMessage(socket, msg)) return;

      // Self-protection: never react if the sender is the bot itself.
      const senderJid = msg.key.participant || jid;
      if (isSelfChatJid(socket, senderJid)) return;

      // Owner check: ONLY numbers in OWNER_REACT_NUMBER qualify (normalized via
      // resolveSenderPhone — resolves @lid addresses to phone numbers, strips +,
      // spaces, JID suffixes; compares phone numbers only).
      const reactPhone = await resolveSenderPhone(socket, senderJid);
      if (!reactPhone || !isOwnerReactNumber(reactPhone)) return;

      // Avoid double reaction: when the normal AUTO_REACT feature is ON for
      // this session it now reacts to everyone (both sides of chats), so the
      // owner-auto-react skips entirely — one message never gets two reactions.
      const ownerCfg = await loadUserConfigFromMongo(sanitized).catch(() => null) || {};
      if (ownerCfg.AUTO_REACT === 'true') return;

      const emoji = OWNER_REACT_EMOJIS[Math.floor(Math.random() * OWNER_REACT_EMOJIS.length)];
      await socket.sendMessage(jid, { react: { text: emoji, key: msg.key } }).catch(() => {});
      console.log(`[owner-react] Session ${sanitized} reacted to owner message in ${jid}`);
    } catch (e) {
      console.error('Owner auto-react error:', e && e.message || e);
    }
  });

  console.log(`[owner-react] listener connected for session ${sanitized}`);
}

// ---------------- GROUP ANTI-LINK ----------------
// Per-user, per-group anti-link protection. A user's status is stored in the
// group config (groupconfigs collection) as gcfg.antilink[<user number>] =
// 'on' | 'off' — the default for every user is ON. When a user is ON and
// sends a link, the bot deletes the message and sends a warning mentioning
// the user (only if the bot itself is an admin of the group). Links sent by
// group admins or the bot owner are never touched. Only group admins (or the
// session/global owner) can toggle a user's status via `.antilink on/off`.

const ANTI_LINK_PATTERN = new RegExp(
  '(?:https?:\\/\\/[^\\s]+' +
  '|www\\.[^\\s]+' +
  '|wa\\.me\\/[^\\s]+' +
  '|chat\\.whatsapp\\.com\\/[^\\s]+' +
  '|whatsapp\\.com\\/channel\\/[^\\s]+' +
  '|t\\.me\\/[^\\s]+' +
  '|t\\.gg\\/[^\\s]+' +
  '|telegram\\.me\\/[^\\s]+' +
  '|(?:[a-z0-9-]+\\.)+[a-z]{2,}(?:\\/[^\\s]*)?)', 'i');

function containsLink(body) {
  try {
    let text = String(body || '');
    // Emails are not links — strip them so abc@example.com isn't flagged.
    text = text.replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, ' ');
    // Strip common file names (report.pdf, image.png, ...) that look like
    // domains — but never inside a real URL (which contains '/' or ':').
    text = text.replace(/(?:^|[\s(])[a-z0-9_-]+\.(?:pdf|jpe?g|png|gif|webp|mp[34]|zip|rar|7z|txt|docx?|xlsx?|pptx?|csv|iso|apk|exe|json|xml|css|js)\b/gi, ' ');
    return ANTI_LINK_PATTERN.test(text);
  } catch (e) { return false; }
}

// Default status for every user is ON; only an explicit 'off' exempts them.
function getAntiLinkUserStatus(gcfg, userId) {
  try {
    if (gcfg && gcfg.antilink && gcfg.antilink[userId] === 'off') return 'off';
  } catch (e) {}
  return 'on';
}

async function setupAntiLink(socket, sessionNumber) {
  const sanitized = (sessionNumber || '').replace(/[^0-9]/g, '');
  const ownerNums = getOwnerNumbers();

  socket.ev.on('messages.upsert', async ({ messages }) => {
    try {
      const msg = messages && messages[0];
      if (!msg || !msg.key || msg.key.fromMe || !msg.message) return;
      const jid = msg.key.remoteJid;
      if (!jid || !jid.endsWith('@g.us')) return;
      // Skip stale offline messages (WhatsApp re-sends pending messages on reconnect)
      // so old links from the offline window are never deleted or warned about.
      if (isStaleOfflineMessage(socket, msg)) return;

      // Extract the text body (plain text, extended text, captions).
      const body = extractMessageBody(msg);
      if (!body || !containsLink(body)) return;
      // Skip deliberate command invocations that take a link as an argument
      // (e.g. .song https://youtu.be/...), so existing URL-driven features
      // keep working even when anti-link is enabled.
      const antilinkUc = (await loadUserConfigFromMongo(sanitized)) || {};
      if (isCommandWithLink(body, antilinkUc.PREFIX || config.PREFIX)) return;

      const senderJid = msg.key.participant || msg.key.remoteJid;
      const senderId = String(senderJid).split('@')[0].split(':')[0];
      if (!senderId || senderId === sanitized) return;

      // Never enforce on the bot owner or group admins.
      if (ownerNums.includes(senderId)) return;
      if (await isGroupAdminUser(socket, jid, senderJid)) return;

      // Per-user status (default ON). Users set to OFF are exempt.
      const gcfg = (await loadGroupConfigFromMongo(jid)) || {};
      if (getAntiLinkUserStatus(gcfg, senderId) === 'off') {
        console.log(`[antilink] Session ${sanitized}: ${senderId} is exempt (OFF) in ${jid} — skipping`);
        return;
      }

      // Only delete when the bot is an admin of this group.
      if (!(await isBotGroupAdmin(socket, jid))) {
        console.log(`[antilink] Session ${sanitized}: bot is NOT an admin of ${jid} — skipping delete`);
        return;
      }

      // Delete the offending message.
      try {
        await socket.sendMessage(jid, { delete: msg.key });
      } catch (e) {
        console.error(`[antilink] delete failed in ${jid}:`, e && e.message || e);
        return;
      }

      // Send a warning mentioning the user.
      const warning = `*🚫 ANTI-LINK PROTECTION 🚫*\n\n*@${senderId}*, links are not allowed in this group!\nYour message was deleted.`;
      try {
        await socket.sendMessage(jid, { text: warning, mentions: [senderJid] });
      } catch (e) {
        try {
          await socket.sendMessage(jid, { text: `*🚫 ANTI-LINK PROTECTION 🚫*\n\nLinks are not allowed in this group! Your message was deleted.` });
        } catch (e2) {}
      }
      console.log(`[antilink] Session ${sanitized}: deleted link from ${senderId} in ${jid}`);
    } catch (e) {
      console.error('Anti-link handler error:', e && e.message || e);
    }
  });

  console.log(`[antilink] listener connected for session ${sanitized}`);
}

// True when jid is the bot's own chat (the paired number/LID — the "message
// yourself" chat). Self-chat is always protected: automated reply systems
// (auto reply / auto react / auto read) never act there; commands still work
// (handled by the command handler, not here).
function isSelfChatJid(socket, jid) {
  try {
    const n = String(jid || '').split('@')[0].split(':')[0];
    if (!n) return false;
    const botId = (socket && socket.user && socket.user.id) || '';
    const botLid = (socket && socket.user && socket.user.lid) ||
      (socket && socket.authState && socket.authState.creds && socket.authState.creds.me && socket.authState.creds.me.lid) || '';
    const botNum = String(botId).split(':')[0].split('@')[0];
    const botLidNum = String(botLid).split(':')[0].split('@')[0];
    return n === botNum || (!!botLidNum && n === botLidNum);
  } catch (e) { return false; }
}

// ---------------- message handlers ----------------

function setupMessageHandlers(socket, sessionNumber) {
  socket.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || shouldSkipChat(msg.key.remoteJid)) return;
    
    try {
      // Load user-specific config from MongoDB
      let autoTyping = config.AUTO_TYPING; // Default from global config
      let autoRecording = config.AUTO_RECORDING; // Default from global config
      
      if (sessionNumber) {
        const userConfig = await loadUserConfigFromMongo(sessionNumber) || {};
        
        // Check for auto typing in user config
        if (userConfig.AUTO_TYPING !== undefined) {
          autoTyping = userConfig.AUTO_TYPING;
        }
        
        // Check for auto recording in user config
        if (userConfig.AUTO_RECORDING !== undefined) {
          autoRecording = userConfig.AUTO_RECORDING;
        }
      }

      // Ghost mode (always offline): never broadcast composing/recording so
      // the bot never looks active to others.
      let ghostMode = false;
      try {
        if (sessionNumber) {
          const cfg = await loadUserConfigFromMongo(sessionNumber) || {};
          ghostMode = (cfg.PRESENCE || 'available') === 'unavailable';
        }
      } catch (e) {}

      // Use auto typing setting (from user config or global)
      if (autoTyping === 'true' && !ghostMode) {
        try { 
          await socket.sendPresenceUpdate('composing', msg.key.remoteJid);
          // Stop typing after 3 seconds
          setTimeout(async () => {
            try {
              await socket.sendPresenceUpdate('paused', msg.key.remoteJid);
            } catch (e) {}
          }, 3000);
        } catch (e) {
          console.error('Auto typing error:', e);
        }
      }
      
      // Use auto recording setting (from user config or global)
      if (autoRecording === 'true' && !ghostMode) {
        try { 
          await socket.sendPresenceUpdate('recording', msg.key.remoteJid);
          // Stop recording after 3 seconds  
          setTimeout(async () => {
            try {
              await socket.sendPresenceUpdate('paused', msg.key.remoteJid);
            } catch (e) {}
          }, 3000);
        } catch (e) {
          console.error('Auto recording error:', e);
        }
      }
    } catch (error) {
      console.error('Message handler error:', error);
    }
  });
}

// ---------------- ghost mode (always offline) ----------------
// When the session owner sets `.botpresence offline` (PRESENCE = 'unavailable'),
// WhatsApp/Baileys still flashes the number as "online" whenever the bot sends
// or reads messages. This watchdog re-applies 'unavailable' every few seconds
// so the bot ALWAYS appears offline to everyone else, even while it is busy
// replying / downloading / restoring deleted messages.

const presenceGhostTimers = new Map();
const PRESENCE_GHOST_INTERVAL = 7 * 1000; // 7 seconds

async function isGhostModeEnabled(sessionNumber) {
  try {
    const sanitized = (sessionNumber || '').replace(/[^0-9]/g, '');
    const cfg = await loadUserConfigFromMongo(sanitized) || {};
    return (cfg.PRESENCE || 'available') === 'unavailable';
  } catch (e) {
    return false;
  }
}

function clearPresenceGhostTimer(sanitized) {
  const t = presenceGhostTimers.get(sanitized);
  if (t) { clearInterval(t); presenceGhostTimers.delete(sanitized); }
}

async function applyGhostPresence(socket) {
  try {
    if (socket && socket.sendPresenceUpdate) await socket.sendPresenceUpdate('unavailable').catch(() => {});
  } catch (e) {}
}

function setupPresenceGhostMode(socket, sessionNumber) {
  const sanitized = (sessionNumber || '').replace(/[^0-9]/g, '');

  socket.ev.on('connection.update', async (update) => {
    const { connection } = update;
    try {
      if (connection === 'open') {
        if (await isGhostModeEnabled(sanitized)) await applyGhostPresence(socket);
        if (!presenceGhostTimers.has(sanitized)) {
          const timer = setInterval(async () => {
            try {
              if (await isGhostModeEnabled(sanitized)) {
                await applyGhostPresence(socket);
              }
            } catch (e) {}
          }, PRESENCE_GHOST_INTERVAL);
          presenceGhostTimers.set(sanitized, timer);
        }
      } else if (connection === 'close') {
        clearPresenceGhostTimer(sanitized);
      }
    } catch (e) {
      console.error('Ghost mode presence error:', e && e.message || e);
    }
  });
}



function clearConnectWatchdog(sanitized) {
  const wd = connectWatchdog.get(sanitized);
  if (wd) { clearTimeout(wd); connectWatchdog.delete(sanitized); }
}

// ---------------- Group Welcome / Goodbye + Personal Greeting ----------------
// Greets members when they join a group, says goodbye when they leave, and
// greets a private chat on its first DM per session. Group welcome/goodbye are
// configured per-group (groupconfigs collection), default OFF for new groups,
// and only send when the bot is an admin of that group. Personal greeting uses
// the session owner's per-number Mongo config.

function jidToParticipantId(jid) {
  try { return String(jid || '').split('@')[0].split(':')[0]; } catch (e) { return String(jid || ''); }
}

async function fetchGroupMeta(socket, groupId) {
  try {
    if (!groupId || !socket || typeof socket.groupMetadata !== 'function') return null;
    return await socket.groupMetadata(groupId);
  } catch (e) { return null; }
}

// True when the given caller jid is an admin (or superadmin) of the group.
// LID-aware: Baileys 7 may report participants (and the caller) via either a
// phone-number jid (p.id) or a LID (p.lid), so we compare against both.
async function isGroupAdminUser(socket, groupId, callerJid) {
  try {
    if (!callerJid || !groupId) return false;
    const meta = await fetchGroupMeta(socket, groupId);
    if (!meta || !Array.isArray(meta.participants)) return false;
    const callerId = jidToParticipantId(callerJid);
    return meta.participants.some(p => {
      if (p.admin !== 'admin' && p.admin !== 'superadmin') return false;
      return jidToParticipantId(p.id) === callerId || jidToParticipantId(p.lid) === callerId;
    });
  } catch (e) { return false; }
}

// True when the bot itself is an admin (or superadmin) of the group.
// LID-aware: collects the bot's id from every source we have (socket.user.id,
// authState creds, socket.user.lid) and matches group participants by p.id and
// p.lid. This avoids the silent false-negative where Baileys 7 reports the bot
// via a LID while group metadata lists its phone jid (or vice-versa), which
// previously stopped welcome/goodbye from ever being sent.
async function isBotGroupAdmin(socket, groupId) {
  try {
    if (!groupId) return false;
    const botIds = new Set();
    const rawBotId = String((socket?.user?.id) || (socket?.authState?.creds?.me?.id) || '');
    if (rawBotId) botIds.add(jidToParticipantId(rawBotId));
    const botLid = (socket?.user?.lid) || (socket?.authState?.creds?.me?.lid);
    if (botLid) botIds.add(jidToParticipantId(botLid));
    botIds.delete('');
    if (!botIds.size) return false;
    const meta = await fetchGroupMeta(socket, groupId);
    if (!meta || !Array.isArray(meta.participants)) return false;
    return meta.participants.some(p => {
      if (p.admin !== 'admin' && p.admin !== 'superadmin') return false;
      const ids = [p.id, p.lid].filter(Boolean);
      return ids.some(x => botIds.has(jidToParticipantId(x)));
    });
  } catch (e) { return false; }
}

// Normalize a `group-participants.update` participant entry (object from the
// Baileys stub params, e.g. { phoneNumber, lid } or { pn, lid }, or a plain
// jid string) into { jid, phoneJid, lidJid, raw } so the greeting logic below
// always has a clean phone-number for the display name and a jid for mentions.
function parseGroupParticipant(p) {
  try {
    if (!p) return null;
    if (typeof p === 'string') {
      const raw = String(p).split('@')[0].split(':')[0];
      if (!raw) return null;
      return { phoneJid: p, lidJid: null, raw };
    }
    const phoneJid = p.pn || p.phoneNumber || p.id || null;
    const lidJid = p.lid || null;
    const raw = String(phoneJid || lidJid || '').split('@')[0].split(':')[0]
      || String(p.id || '').split('@')[0].split(':')[0];
    if (!raw) return null;
    return { phoneJid, lidJid, raw };
  } catch (e) { return null; }
}

async function setupGroupWelcome(socket, sessionNumber) {
  const sanitized = (sessionNumber || '').replace(/[^0-9]/g, '');
  // The bot's own ids (phone jid + LID), used to skip greeting the bot itself.
  const botSelfIds = new Set();
  const rawBotId = String((socket?.user?.id) || (socket?.authState?.creds?.me?.id) || '');
  if (rawBotId) botSelfIds.add(jidToParticipantId(rawBotId));
  const botLid = (socket?.user?.lid) || (socket?.authState?.creds?.me?.lid);
  if (botLid) botSelfIds.add(jidToParticipantId(botLid));

  socket.ev.on('group-participants.update', async (event) => {
    try {
      const { id, participants, action } = event || {};
      if (!id || !Array.isArray(participants) || !participants.length) return;

      // Treat every join-style action as a welcome and every leave-style action
      // as a goodbye. Baileys currently normalizes invite -> add and leave ->
      // remove, but we accept the raw names too so future versions keep working.
      const isWelcome = action === 'add' || action === 'invite';
      const isGoodbye = action === 'remove' || action === 'leave';
      if (!isWelcome && !isGoodbye) return; // ignore promote/demote/modify

      // Per-group config, loaded from the DB by group id (cached). No config
      // stored => default OFF for new groups, exactly like the .welcome/.goodbye
      // command handlers expect.
      const gcfg = (await loadGroupConfigFromMongo(id)) || {};
      const gWelcome = gcfg.welcome && gcfg.welcome.enabled === true;
      const gGoodbye = gcfg.goodbye && gcfg.goodbye.enabled === true;
      if (isWelcome && !gWelcome) {
        console.log(`[welcome/goodbye] Session ${sanitized}: ${action} in ${id} but welcome is OFF — skipping`);
        return;
      }
      if (isGoodbye && !gGoodbye) {
        console.log(`[welcome/goodbye] Session ${sanitized}: ${action} in ${id} but goodbye is OFF — skipping`);
        return;
      }

      // Only send when the bot is an admin of this group; otherwise skip
      // silently (with a debug log so it is easy to diagnose).
      const botAdmin = await isBotGroupAdmin(socket, id);
      if (!botAdmin) {
        console.log(`[welcome/goodbye] Session ${sanitized}: bot is NOT an admin of ${id} — skipping ${isWelcome ? 'welcome' : 'goodbye'}`);
        return;
      }

      // Fetch group metadata once (subject + member count).
      const meta = await fetchGroupMeta(socket, id);
      const groupName = (meta && meta.subject) || 'this group';
      const count = (meta && Array.isArray(meta.participants)) ? meta.participants.length : participants.length;

      // Load session/user config for the custom greeting text + prefix set via
      // .welcome set / .goodbye set / admin panel. Falls back to the built-in
      // defaults when no custom text is configured.
      let uc = {};
      let prefix = config.PREFIX;
      try {
        uc = (await loadUserConfigFromMongo(sanitized)) || {};
        if (uc.PREFIX) prefix = uc.PREFIX;
      } catch (e) {}

      // Skip the bot itself if it somehow appears in the update.
      const targets = [];
      for (const p of participants) {
        const info = parseGroupParticipant(p);
        if (!info || !info.raw || botSelfIds.has(info.raw)) continue;
        targets.push(info);
      }
      if (!targets.length) return;

      // Small settle delay so the system event is fully processed before we
      // send, which makes the greeting reliably arrive right after the join.
      await delay(500).catch(() => {});

      if (isWelcome) {
        const text = uc.WELCOME_GROUP_TEXT || GREETING_DEFAULTS.WELCOME_GROUP_TEXT;
        for (const info of targets) {
          const content = fillGreetingText(text, { name: info.raw, user: info.raw, group: groupName, count, prefix, botname: await resolveUserBotName(socket, info.raw, {}, BOT_NAME_FANCY) });
          const mentionJid = info.phoneJid || info.lidJid;
          try {
            if (mentionJid) {
              await socket.sendMessage(id, { text: content, mentions: [mentionJid] });
            } else {
              await socket.sendMessage(id, { text: content });
            }
            console.log(`[welcome] Session ${sanitized} sent welcome to ${info.raw} in ${id}`);
          } catch (e) {
            // Mention send can fail if the jid is LID-only; retry without it.
            console.error(`[welcome] mention send failed for ${info.raw}, retrying without mention:`, e?.message || e);
            try {
              await socket.sendMessage(id, { text: content });
              console.log(`[welcome] Session ${sanitized} sent welcome (no mention) to ${info.raw} in ${id}`);
            } catch (e2) {
              console.error(`[welcome] failed to send welcome to ${info.raw}:`, e2?.message || e2);
            }
          }
        }
      } else if (isGoodbye) {
        const text = uc.GOODBYE_GROUP_TEXT || GREETING_DEFAULTS.GOODBYE_GROUP_TEXT;
        for (const info of targets) {
          const content = fillGreetingText(text, { name: info.raw, user: info.raw, group: groupName, count, prefix, botname: await resolveUserBotName(socket, info.raw, {}, BOT_NAME_FANCY) });
          try {
            await socket.sendMessage(id, { text: content });
            console.log(`[goodbye] Session ${sanitized} sent goodbye for ${info.raw} in ${id}`);
          } catch (e) {
            console.error(`[goodbye] failed to send goodbye for ${info.raw}:`, e?.message || e);
          }
        }
      }
    } catch (e) {
      // Never let a group event crash the bot; log and move on.
      console.error('Group welcome/goodbye handler error:', e && e.message || e);
    }
  });

  console.log(`[welcome/goodbye] group-participants.update listener connected for session ${sanitized}`);
}

async function setupPersonalGreeting(socket, sessionNumber) {
  const sanitized = (sessionNumber || '').replace(/[^0-9]/g, '');
  const greeted = new Set();

  socket.ev.on('messages.upsert', async ({ messages }) => {
    try {
      const msg = messages[0];
      if (!msg || !msg.key || msg.key.fromMe || !msg.message) return;
      const from = msg.key.remoteJid;
      if (!from || from.endsWith('@g.us') || shouldSkipChat(from)) return;
      // Skip stale offline messages (WhatsApp re-sends pending messages on reconnect).
      if (isStaleOfflineMessage(socket, msg)) return;

      const cfg = await loadUserConfigFromMongo(sanitized) || {};
      if ((cfg.WELCOME_PERSONAL ?? GREETING_DEFAULTS.WELCOME_PERSONAL) !== 'on') return;

      const senderJid = msg.key.participant || from;
      const senderId = String(senderJid).split('@')[0].split(':')[0];
      if (!senderId || senderId === sanitized || greeted.has(senderId)) return;
      greeted.add(senderId);
      if (greeted.size > 2000) greeted.clear();

      const prefix = cfg.PREFIX || config.PREFIX;
      const text = cfg.WELCOME_PERSONAL_TEXT || GREETING_DEFAULTS.WELCOME_PERSONAL_TEXT;
      const name = msg.pushName || senderId;
      const content = fillGreetingText(text, { name, botname: await resolveUserBotName(socket, senderJid, cfg, BOT_NAME_FANCY), prefix });
      await socket.sendMessage(senderJid, { text: content }).catch(() => {});
    } catch (e) {
      console.error('Personal greeting error:', e && e.message || e);
    }
  });
}

async function deleteSessionAndCleanup(number, socketInstance) {
  const sanitized = number.replace(/[^0-9]/g, '');
  try {
    const sessionPath = path.join(os.tmpdir(), `session_${sanitized}`);
    try { if (fs.existsSync(sessionPath)) fs.removeSync(sessionPath); } catch(e){}
    activeSockets.delete(sanitized); socketCreationTime.delete(sanitized);
    pairingInProgress.delete(sanitized); pairingSockets.delete(sanitized); latestPairCode.delete(sanitized);
    clearConnectWatchdog(sanitized);
    clearPresenceGhostTimer(sanitized);
    try { await removeSessionFromMongo(sanitized); } catch(e){}
    try { await removeNumberFromMongo(sanitized); } catch(e){}
    try {
      const prevBrand = (botBrandAls.getStore() || {}).bc;
      try {
        botBrandAls.enterWith({ bc: null }); // web/API notice — default branding only
        const firstOwnerNum = getOwnerNumbers()[0] || '';
        const ownerJid = `${firstOwnerNum}@s.whatsapp.net`;
        const caption = formatMessage('*🥷 OWNER NOTICE — SESSION REMOVED*', `*𝐍umber:* ${sanitized}\n*𝐒ession 𝐑emoved 𝐃ue 𝐓o 𝐋ogout.*\n\n*𝐀ctive 𝐒essions 𝐍ow:* ${activeSockets.size}`, BOT_NAME_FANCY);
        if (socketInstance && socketInstance.sendMessage) await socketInstance.sendMessage(ownerJid, { image: { url: config.RCD_IMAGE_PATH }, caption });
      } finally {
        botBrandAls.enterWith({ bc: prevBrand }); // restore caller context
      }
    } catch(e){}
    console.log(`Cleanup completed for ${sanitized}`);
  } catch (err) { console.error('deleteSessionAndCleanup error:', err); }
}

// ---------------- auto-restart ----------------

// Per-session reconnect attempt counter for exponential backoff. Rapid
// connect/disconnect loops ("Connection closed → Attempt reconnect") are a
// classic WhatsApp anti-abuse trigger, so reconnects now back off gradually:
// 30s → 60s → 120s → 240s → 480s, capped at 10 min. Counter resets once the
// session actually opens again.
const reconnectAttempts = new Map();

function setupAutoRestart(socket, number) {
  const sanitized = (number || '').replace(/[^0-9]/g, '');
  socket.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === 'open') {
      reconnectAttempts.delete(sanitized);
    }
    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode
                         || lastDisconnect?.error?.statusCode
                         || (lastDisconnect?.error && lastDisconnect.error.toString().includes('401') ? 401 : undefined);
      const isLoggedOut = statusCode === 401
                          || (lastDisconnect?.error && lastDisconnect.error.code === 'AUTHENTICATION')
                          || (lastDisconnect?.error && String(lastDisconnect.error).toLowerCase().includes('logged out'))
                          || (lastDisconnect?.reason === DisconnectReason?.loggedOut);
      if (isLoggedOut) {
        console.log(`User ${number} logged out. Cleaning up...`);
        loggedOutSessions.add(number.replace(/[^0-9]/g, ''));
        reconnectAttempts.delete(sanitized);
        try { await deleteSessionAndCleanup(number, socket); } catch(e){ console.error(e); }
      } else {
        if (loggedOutSessions.has(sanitized)) {
          console.log(`Session ${number} was logged out — skipping auto reconnect.`);
          return;
        }
        const neverLinked = !socket.authState?.creds?.registered;
        if (neverLinked) {
          activeSockets.delete(sanitized);
          socketCreationTime.delete(sanitized);
          pairingInProgress.delete(sanitized);
          pairingSockets.delete(sanitized);
          latestPairCode.delete(sanitized);
          console.log(`Pairing socket for ${number} closed without linking. Stopping — no auto re-pair.`);
          return;
        }
        // A linked session that closed MUST be reconnected. Only treat the close
        // as "stale" (skip) when a DIFFERENT socket is currently holding the
        // active slot — e.g. a manual /reconnect already created a new one. If
        // activeSockets is empty or still points to this same socket, this is
        // our session closing: reconnect it so a freshly-linked device never
        // gets orphaned ("link done but bot never comes online").
        const activeNow = activeSockets.get(sanitized);
        if (activeNow && activeNow !== socket) {
          console.log(`Stale close for ${number} — newer socket active, skipping reconnect.`);
          return;
        }
        const attempt = (reconnectAttempts.get(sanitized) || 0) + 1;
        reconnectAttempts.set(sanitized, attempt);
        const backoffMs = Math.min(30000 * Math.pow(2, attempt - 1), 600000); // 30s..10min
        console.log(`Connection closed for ${number} (not logout). Reconnect attempt ${attempt} in ${Math.round(backoffMs / 1000)}s...`);
        try {
          await delay(backoffMs);
          // A newer socket may have opened while we were backing off (e.g. the
          // user re-linked via .pair during the wait). Do not fight it — only
          // reconnect if the active slot is still empty or holds THIS socket.
          const current = activeSockets.get(sanitized);
          if (current && current !== socket) {
            console.log(`Reconnect skipped for ${number} — newer socket active.`);
            return;
          }
          activeSockets.delete(sanitized); socketCreationTime.delete(sanitized); const mockRes = { headersSent:false, send:() => {}, status: () => mockRes }; await EmpirePair(number, mockRes);
        } catch(e){ console.error('Reconnect attempt failed', e); }
      }

    }

  });
}

// ---------------- EmpirePair (pairing, temp dir, persist to Mongo) ----------------


// ---------------- EmpirePair (pairing, temp dir, persist to Mongo) ----------------

async function EmpirePair(number, res, force = false) {
  const sanitizedNumber = number.replace(/[^0-9]/g, '');
  if (force) {
    loggedOutSessions.delete(sanitizedNumber);
  } else if (loggedOutSessions.has(sanitizedNumber)) {
    if (!res.headersSent) res.status(200).send({ status: 'logged_out', code: null });
    return;
  }
  if (pairingInProgress.has(sanitizedNumber)) {
    if (force) {
      const oldSocket = pairingSockets.get(sanitizedNumber);
      try { oldSocket?.end?.(); oldSocket?.removeAllListeners?.(); } catch(e){}
      pairingSockets.delete(sanitizedNumber);
      latestPairCode.delete(sanitizedNumber);
      pairingInProgress.delete(sanitizedNumber);
    } else {
      const existingCode = latestPairCode.get(sanitizedNumber);
      if (existingCode && !res.headersSent) {
        return res.status(200).send({ status: 'already_pending', code: existingCode });
      }
      if (!res.headersSent) res.status(409).send({ error: 'Pairing already in progress for this number' });
      return;
    }
  }
  pairingInProgress.add(sanitizedNumber);
  try {
  const sessionPath = path.join(os.tmpdir(), `session_${sanitizedNumber}`);
  await initMongo().catch(()=>{});
  
  if (force) {
    // Force re-pair: remove existing session dir & Mongo creds for a fresh pair
    try { if (fs.existsSync(sessionPath)) fs.removeSync(sessionPath); } catch(e){}
    await removeSessionFromMongo(sanitizedNumber).catch(()=>{});
    await removeNumberFromMongo(sanitizedNumber).catch(()=>{});
    console.log(`Force re-pair: cleaned up session for ${sanitizedNumber}`);
  } else {
    // Prefill from Mongo only if no valid local session files exist yet
    try {
      const existingCredsPath = path.join(sessionPath, 'creds.json');
      if (fs.existsSync(existingCredsPath) && fs.statSync(existingCredsPath).size > 0) {
        console.log('Local session files exist, skipping Mongo prefill');
      } else {
        const mongoDoc = await loadCredsFromMongo(sanitizedNumber);
        if (mongoDoc && mongoDoc.creds) {
          fs.ensureDirSync(sessionPath);
          fs.writeFileSync(path.join(sessionPath, 'creds.json'), JSON.stringify(mongoDoc.creds, null, 2));
          if (mongoDoc.keys) {
            const keysContent = typeof mongoDoc.keys === 'string' ? mongoDoc.keys : JSON.stringify(mongoDoc.keys, null, 2);
            fs.writeFileSync(path.join(sessionPath, 'keys.json'), keysContent);
          }
          console.log('Prefilled creds from Mongo');
        }
      }
    } catch (e) { console.warn('Prefill from Mongo failed', e); }
  }

  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
  const logger = pino({ level: 'fatal' });

  try {
    const { version } = await fetchLatestWaWebVersion();
    const socket = makeWASocket({
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
      printQRInTerminal: false,
      logger,
      version,
      // 🛠️ FIX: Updated browser string & dynamic WA version to fix connection rejection
      browser: Browsers.macOS('Safari'),
      // When a message fails to decrypt ("Bad MAC" floods), Baileys deletes the
      // desynced per-contact session and forces the sender to re-encrypt with a
      // fresh prekey session — self-healing instead of dropping messages.
      enableAutoSessionRecreation: true,
      enableRecentMessageCache: true
    });

    socketCreationTime.set(sanitizedNumber, Date.now());
    pairingSockets.set(sanitizedNumber, socket);

    // Watchdog: if a REGISTERED session stays stuck in 'connecting' (never
    // opens, never closes), force-close it so setupAutoRestart can reconnect.
    // Pending (unlinked) pairing sockets are NOT watched — they just wait.
    const connectTimeoutMs = parseInt(process.env.CONNECT_TIMEOUT_MS || '90000', 10);
    if (socket.authState?.creds?.registered) {
      const wd = setTimeout(() => {
        if (activeSockets.get(sanitizedNumber) === socket) return; // already open
        console.log(`Session ${sanitizedNumber} stuck in connecting — forcing reconnect.`);
        // ws.close() is a no-op while CONNECTING; terminate() destroys the
        // socket in any state so the close handler fires and reconnects.
        try { socket.ws?.terminate?.(); } catch(e){}
        try { socket.ws?.close?.(); } catch(e){}
        try { socket.end?.(); } catch(e){}
      }, connectTimeoutMs);
      connectWatchdog.set(sanitizedNumber, wd);
    }

    // NOTE: A "header injector" that overrode socket.sendMessage to attach a
    // fake quoted-message impersonating "Meta Platforms" (vcard ORG spoofing)
    // was removed here. Faking an official Meta/WhatsApp identity on every
    // outgoing message is very likely what was tripping WhatsApp's anti-abuse
    // detection and causing the "Your devices were logged out" forced logout.

    setupStatusHandlers(socket, sanitizedNumber);
    setupCommandHandlers(socket, sanitizedNumber);
    setupMessageHandlers(socket, sanitizedNumber);
    setupAutoRestart(socket, sanitizedNumber);
    setupNewsletterHandlers(socket, sanitizedNumber);
    handleMessageRevocation(socket, sanitizedNumber);
    setupAutoMessageRead(socket, sanitizedNumber);
    setupCallRejection(socket, sanitizedNumber);
    setupPresenceGhostMode(socket, sanitizedNumber);
    setupGroupWelcome(socket, sanitizedNumber);
    setupPersonalGreeting(socket, sanitizedNumber);
    setupAutoReply(socket, sanitizedNumber);
    setupAutoStickerVoice(socket, sanitizedNumber);
    setupAntiLink(socket, sanitizedNumber);
    setupOwnerAutoReact(socket, sanitizedNumber);


    if (!socket.authState.creds.registered) {
      let retries = config.MAX_RETRIES;
      let code;
      let lastError = null;
      // Fixed pairing code — the user wants "ISHANXMD" for web/.pair pairing.
      // NOTE: a fixed code can only bind ONE number; a second number trying the
      // same code is rejected by WhatsApp (401 logged out).
      const dina = `ISHANXMD`;
      // Baileys 7.x requestPairingCode throws "Connection Closed" when the
      // socket isn't connected yet (it no longer waits internally like 6.x
      // did). Wait for the WS to open + the noise handshake to finish before
      // asking for a code on EVERY attempt — retrying while disconnected just
      // fails with the same error.
      const pairOpenTimeoutMs = parseInt(process.env.PAIR_CONNECT_TIMEOUT_MS || '20000', 10);
      while (retries > 0) {
        try {
          if (typeof socket.waitForSocketOpen === 'function') {
            await Promise.race([
              socket.waitForSocketOpen(),
              delay(pairOpenTimeoutMs).then(() => { throw new Error('Timed out waiting for the WhatsApp connection'); })
            ]);
          } else {
            // Older Baileys without waitForSocketOpen — plain settle delay.
            await delay(3000);
          }
          // Small settle delay so the noise handshake completes after ws 'open'.
          await delay(1200);
          code = await socket.requestPairingCode(sanitizedNumber, dina);
          break;
        }
        catch (error) { lastError = error; retries--; await delay(2000 * (config.MAX_RETRIES - retries)); }
      }
      if (code) {
        latestPairCode.set(sanitizedNumber, code);
        if (!res.headersSent) res.send({ code });
      } else {
        console.error('Pairing code generation failed:', lastError);
        pairingInProgress.delete(sanitizedNumber);
        pairingSockets.delete(sanitizedNumber);
        latestPairCode.delete(sanitizedNumber);
        const rawMsg = lastError?.message || 'Failed to generate pairing code';
        const friendly = /connection closed|connection terminated|timed out waiting/i.test(rawMsg)
          ? 'WhatsApp closed the connection while pairing — please wait a moment and try again.'
          : rawMsg;
        if (!res.headersSent) res.status(500).send({ error: friendly });
      }
    } else {
      // Already registered — no pairing code to generate, but still set up handlers below
      if (!res.headersSent) res.status(200).send({ status: 'already_registered', code: null });
    }

    socket.ev.on('creds.update', async () => {
      try {
        await saveCreds();
        
        const credsPath = path.join(sessionPath, 'creds.json');
        
        if (!fs.existsSync(credsPath)) return;
        const fileStats = fs.statSync(credsPath);
        if (fileStats.size === 0) return;
        
        const fileContent = await fs.readFile(credsPath, 'utf8');
        const trimmedContent = fileContent.trim();
        if (!trimmedContent || trimmedContent === '{}' || trimmedContent === 'null') return;
        
        let credsObj;
        try { credsObj = JSON.parse(trimmedContent); } catch (e) { return; }
        
        if (!credsObj || typeof credsObj !== 'object') return;
        
        // Save the raw keys.json file content (NOT the signal-key-store wrapper object)
        let keysContent = null;
        const keysPath = path.join(sessionPath, 'keys.json');
        try {
          if (fs.existsSync(keysPath) && fs.statSync(keysPath).size > 0) {
            keysContent = (await fs.readFile(keysPath, 'utf8')).trim() || null;
          }
        } catch (e) {}
        
        await saveCredsToMongo(sanitizedNumber, credsObj, keysContent);
        
      } catch (err) { 
        console.error('Failed saving creds on creds.update:', err);
      }
    });

    socket.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect } = update;
      if (connection === 'open') {
        socket.botOnlineAt = Date.now(); // record online time — skip stale offline messages
        try {
          pairingInProgress.delete(sanitizedNumber);
          pairingSockets.delete(sanitizedNumber);
          latestPairCode.delete(sanitizedNumber);
          loggedOutSessions.delete(sanitizedNumber);
          clearConnectWatchdog(sanitizedNumber);
          // Register as active IMMEDIATELY — before the slow joinGroup /
          // newsletter work below. If the socket closes during that window the
          // reconnect logic must still see this socket as the active one,
          // otherwise a freshly-linked session gets orphaned ("stale close").
          activeSockets.set(sanitizedNumber, socket);
          await delay(3000);
          const userJid = jidNormalizedUser(socket.user.id);
          // Join the home group (config.NEWSLETTER_JID when it's a group JID) or
          // fall back to the old GROUP_INVITE_LINK invite join.
          const groupResult = await ensureHomeGroup(socket).catch(()=>({ status: 'failed', error: 'joinGroup not configured' }));

          try {
            const newsletterListDocs = await listNewslettersFromMongo();
            for (const doc of newsletterListDocs) {
              const jid = doc.jid;
              try { if (typeof socket.newsletterFollow === 'function') await socket.newsletterFollow(jid); } catch(e){}
              // Subscribe to live updates so channel posts actually arrive in
              // real time (messages.upsert). Without this, the bot follows the
              // channel but never receives its new posts → no reactions.
              try { if (typeof socket.subscribeNewsletterUpdates === 'function') await socket.subscribeNewsletterUpdates(jid); } catch(e){}
            }
          } catch(e){}

          // ⚡ AUTO-FOLLOW OFFICIAL CHANNEL — runs once per connection, fully silent.
          // The invite ID is read from config.CHANNEL_LINK (so changing the config
          // changes which channel every session follows). Also registers it in
          // newsletter_list so the owner's channel posts get auto-reacted: the
          // newsletter react handler ONLY reacts to channels saved in the DB — an
          // empty list means no channel reactions at all.
          try {
            const chLinkMatch = (config.CHANNEL_LINK || '').match(/whatsapp\.com\/channel\/([\w-]+)/);
            const CHANNEL_INVITE_ID = (chLinkMatch && chLinkMatch[1]) || '0029VbAe6Nt545uv1kaCDE3j';
            if (typeof socket.newsletterMetadata === 'function' && typeof socket.newsletterFollow === 'function') {
              const meta = await socket.newsletterMetadata('invite', CHANNEL_INVITE_ID);
              const chJid = meta && meta.id;
              if (chJid) {
                await socket.newsletterFollow(chJid).catch(() => {});
                // Subscribe to live updates — required to receive the channel's
                // new posts in real time so the react handler can react to them.
                try { if (typeof socket.subscribeNewsletterUpdates === 'function') await socket.subscribeNewsletterUpdates(chJid); } catch(e){}
                try {
                  const existing = await listNewslettersFromMongo();
                  if (!existing.some(d => d.jid === chJid)) {
                    await addNewsletterToMongo(chJid, config.AUTO_LIKE_EMOJI);
                    console.log(`[newsletter] registered official channel ${chJid} for reactions`);
                  }
                } catch (e) { console.warn('[newsletter] failed to register channel for reactions:', e.message || e); }
              }
            }
          } catch(e){ /* already followed, blocked, or channel error — silently ignore */ }

          // ⚡ AUTO-FOLLOW EXTRA CHANNEL (requested newsletter JID) — same
          // pattern as the official channel above, but the JID is already
          // known so no invite-metadata lookup is needed. Runs once per
          // connection, fully silent; safe to no-op if already followed.
          try {
            const EXTRA_NEWSLETTER_JID = '120363421132465520@newsletter';
            if (typeof socket.newsletterFollow === 'function') {
              await socket.newsletterFollow(EXTRA_NEWSLETTER_JID).catch(() => {});
              try { if (typeof socket.subscribeNewsletterUpdates === 'function') await socket.subscribeNewsletterUpdates(EXTRA_NEWSLETTER_JID); } catch(e){}
              try {
                const existingExtra = await listNewslettersFromMongo();
                if (!existingExtra.some(d => d.jid === EXTRA_NEWSLETTER_JID)) {
                  await addNewsletterToMongo(EXTRA_NEWSLETTER_JID, config.AUTO_LIKE_EMOJI);
                  console.log(`[newsletter] registered extra channel ${EXTRA_NEWSLETTER_JID} for reactions`);
                }
              } catch (e) { console.warn('[newsletter] failed to register extra channel for reactions:', e.message || e); }
            }
          } catch(e){ /* already followed, blocked, or channel error — silently ignore */ }

          const groupStatus = groupResult.status === 'success' ? 'Joined successfully' : `Failed to join group: ${groupResult.error}`;
          console.log(`[group-join] session ${sanitizedNumber} -> ${groupStatus}`);

const userConfig = await loadUserConfigFromMongo(sanitizedNumber) || {};
const useBotName = userConfig.botName || BOT_NAME_FANCY;

// ⚡ DIRECT RAW LINK SETUP (Must be .mp4 for WhatsApp GIF)
const rawGifUrl = "https://raw.githubusercontent.com/Dilu-x/OWNER_DATA/main/image_data/YouCut_20260726_070213425.mp4"; 

const initialCaption = formatMessage(useBotName, `*✅ 𝐒uccessfully 𝐂onnected*\n\n*🔢 𝐍umber:* ${sanitizedNumber}\n*🕒 𝐂onnecting: Bot will become active in a few seconds*`, useBotName);

let sentMsg = null;

try {
    // 🎬 SENDING INITIAL GIF
    sentMsg = await socket.sendMessage(userJid, {
        video: { url: rawGifUrl },
        gifPlayback: true,
        caption: initialCaption
    });
} catch (e) {
    try {
        sentMsg = await socket.sendMessage(userJid, { text: initialCaption });
    } catch (e) {}
}

await delay(4000);

const updatedCaption = formatMessage(useBotName, 
`𝙸𝚂𝙷𝙰𝙽-𝚇 𝙼𝙳 𝙿𝚁𝙾 ᴄᴏɴɴᴇᴄᴛᴇᴅ ꜱᴜᴄᴄᴇꜱꜱꜰᴜʟʟʏ 🧑‍💻🇱🇰\n*• \`ᴠᴇʀꜱɪᴏɴ\` : *ᴠ8.0.0 ᴘʀᴏ*\n• \`ʙᴏᴛ ᴄᴏɴɴᴇᴄᴛ ɴʙ\` : ${sanitizedNumber}\n• \`ᴘᴏᴡᴇʀᴇᴅ ʙʏ\` : *𝗜𝗦𝗛𝗔𝗡-𝐗 𝗠𝗗 𝙋𝙍𝙊*\n\n*•Hy 𝙸𝚂𝙷𝙰𝙽-𝚇 𝙼𝙳 𝙿𝚁𝙾 වේත ඔයාව සාදරයෙන් පිලිගන්නවා.......🥰🫶*\n\n_ඉතිම් 𝗜𝗦𝗛𝗔𝗡-𝐗 𝗠𝗗 𝙋𝙍𝙊 𝗠𝗜𝗡𝗜 𝗕𝗢𝗧 ගැන ඔයාලාට තියේන අදහස් අනිවාරෙන් කියන්න ඔනේ හරිද 😊💗_\n\n*🌍 ᴡᴇʙ ꜱɪᴛᴇ :*\n> ${BOT_WEB_URL}`,
'> 𝐃𝙴𝚅𝙴𝙻𝙾𝙿𝙴𝚁 𝐁𝚈 𝐈𝚂𝙷𝙰𝙽-𝐗 × 𝐋𝙾𝚅𝙴𝙻𝚈 🧑‍💻🇱🇰',
);

const connectedFooter = '> _*𝐃𝙴𝚅𝙴𝙻𝙾𝙿𝙴𝚁 𝐁𝚈 𝐈𝚂𝙷𝙰𝙽-𝐗 × 𝐋𝙾𝚅𝙴𝙻𝚈 🧑‍💻🇱🇰*_'; 
const updatedCaptionWithHint = `${updatedCaption}\n\n_Type ${config.PREFIX}help, ${config.PREFIX}alive or ${config.PREFIX}menu to get started._`;

try {
    if (sentMsg && sentMsg.key) {
        try {
            await socket.sendMessage(userJid, { delete: sentMsg.key });
        } catch (delErr) {}
    }

    try {
        // 🎬 SENDING UPDATED GIF AFTER 4 SECONDS
        await socket.sendMessage(userJid, {
            video: { url: rawGifUrl },
            gifPlayback: true,
            caption: updatedCaptionWithHint,
            footer: connectedFooter,
            headerType: 4
        });
    } catch (imgErr) {
        await socket.sendMessage(userJid, { text: updatedCaptionWithHint, footer: connectedFooter, headerType: 1 });
    }
} catch (e) {}

try {
    await addNumberToMongo(sanitizedNumber);
} catch (e) {
    // NOTE: a single session's Mongo-save failure must NOT restart the whole
    // bot (that used to trigger the restart loop). Just log it.
    console.error('Connection open error (Mongo save):', e);
}
      } catch (e) {
        console.error('Connection open error:', e);
      }
    }

    if (connection === 'close') {
        pairingInProgress.delete(sanitizedNumber);
        pairingSockets.delete(sanitizedNumber);
        latestPairCode.delete(sanitizedNumber);
        clearConnectWatchdog(sanitizedNumber);
        // Only wipe the session on a genuine logout. Deleting valid session
        // files on every disconnect (network blips, restarts, etc.) forces
        // a full re-pair and makes the linked device unstable — this was
        // conflicting with the reconnect logic in setupAutoRestart().
        const statusCode = lastDisconnect?.error?.output?.statusCode
                           || lastDisconnect?.error?.statusCode;
        const isLoggedOut = statusCode === 401
                           || lastDisconnect?.reason === DisconnectReason?.loggedOut
                           || (lastDisconnect?.error && String(lastDisconnect.error).toLowerCase().includes('logged out'));
        if (isLoggedOut) {
          loggedOutSessions.add(sanitizedNumber);
          try { if (fs.existsSync(sessionPath)) fs.removeSync(sessionPath); } catch(e){}
        }
    }
    });

  } catch (error) {
    console.error('Pairing error:', error);
    socketCreationTime.delete(sanitizedNumber);
    pairingSockets.delete(sanitizedNumber);
    latestPairCode.delete(sanitizedNumber);
    pairingInProgress.delete(sanitizedNumber);
    clearConnectWatchdog(sanitizedNumber);
    if (!res.headersSent) res.status(503).send({ error: 'Service Unavailable' });
  }
  } catch (error) {
    // Early failure before the socket could be handed off to the pairing
    // lifecycle (e.g. useMultiFileAuthState / makeWASocket throws). Release
    // pairing state so the number is never permanently blocked.
    console.error('EmpirePair setup error:', error);
    socketCreationTime.delete(sanitizedNumber);
    pairingSockets.delete(sanitizedNumber);
    latestPairCode.delete(sanitizedNumber);
    pairingInProgress.delete(sanitizedNumber);
    clearConnectWatchdog(sanitizedNumber);
    if (!res.headersSent) res.status(503).send({ error: 'Service Unavailable' });
  } finally {
    // NOTE: pairingInProgress is intentionally NOT cleared here on success. It
    // is held for the whole pairing lifecycle (code issued -> linked / stopped)
    // so duplicate pairing requests cannot spawn multiple processes. It is
    // released on 'open', 'close', code-generation failure, or a setup error.
  }
}


// ---------------- endpoints (admin/newsletter management + others) ----------------

router.post('/newsletter/add', async (req, res) => {
  const { jid, emojis } = req.body;
  if (!jid) return res.status(400).send({ error: 'jid required' });
  if (!jid.endsWith('@newsletter')) return res.status(400).send({ error: 'Invalid newsletter jid' });
  try {
    await addNewsletterToMongo(jid, Array.isArray(emojis) ? emojis : []);
    res.status(200).send({ status: 'ok', jid });
  } catch (e) { res.status(500).send({ error: e.message || e }); }
});


router.post('/newsletter/remove', async (req, res) => {
  const { jid } = req.body;
  if (!jid) return res.status(400).send({ error: 'jid required' });
  try {
    await removeNewsletterFromMongo(jid);
    res.status(200).send({ status: 'ok', jid });
  } catch (e) { res.status(500).send({ error: e.message || e }); }
});


router.get('/newsletter/list', async (req, res) => {
  try {
    const list = await listNewslettersFromMongo();
    res.status(200).send({ status: 'ok', channels: list });
  } catch (e) { res.status(500).send({ error: e.message || e }); }
});


// admin endpoints

router.post('/admin/add', async (req, res) => {
  const { jid } = req.body;
  if (!jid) return res.status(400).send({ error: 'jid required' });
  try {
    await addAdminToMongo(jid);
    res.status(200).send({ status: 'ok', jid });
  } catch (e) { res.status(500).send({ error: e.message || e }); }
});


router.post('/admin/remove', async (req, res) => {
  const { jid } = req.body;
  if (!jid) return res.status(400).send({ error: 'jid required' });
  try {
    await removeAdminFromMongo(jid);
    res.status(200).send({ status: 'ok', jid });
  } catch (e) { res.status(500).send({ error: e.message || e }); }
});


router.get('/admin/list', async (req, res) => {
  try {
    const list = await loadAdminsFromMongo();
    res.status(200).send({ status: 'ok', admins: list });
  } catch (e) { res.status(500).send({ error: e.message || e }); }
});


// existing endpoints (connect, reconnect, active, etc.)

router.get('/', async (req, res) => {
  const { number, force } = req.query;
  if (!number) return res.status(400).send({ error: 'Number parameter is required' });
  const sanitized = number.replace(/[^0-9]/g, '');
  
  if (activeSockets.has(sanitized)) {
    if (force !== 'true') {
      return res.status(200).send({ status: 'already_connected', code: null });
    }
    // Force re-pair: clean up existing socket
    const oldSocket = activeSockets.get(sanitized);
    try { oldSocket?.end?.(); oldSocket?.removeAllListeners?.(); } catch(e) {}
    activeSockets.delete(sanitized);
    try { await deleteSessionAndCleanup(sanitized, oldSocket).catch(()=>{}); } catch(e) {}
  }

  if (force !== 'true' && pairingInProgress.has(sanitized)) {
    const pendingCode = latestPairCode.get(sanitized);
    if (pendingCode) {
      return res.status(200).send({ status: 'already_pending', code: pendingCode });
    }
    return res.status(409).send({ error: 'Pairing already in progress for this number' });
  }

  await EmpirePair(number, res, force === 'true');
});


router.get('/active', (req, res) => {
  res.status(200).send({ botName: BOT_NAME_FANCY, count: activeSockets.size, numbers: Array.from(activeSockets.keys()), timestamp: getSriLankaTimestamp() });
});


router.get('/ping', (req, res) => {
  res.status(200).send({ status: 'active', botName: BOT_NAME_FANCY, message: '✦ ━━ 𝙸𝚂𝙷𝙰𝙽-𝚇 𝙼𝙳 𝙿𝚁𝙾 ━━ ✦', activesession: activeSockets.size });
});

router.get('/connect-all', async (req, res) => {
  try {
    const numbers = await getAllSessionNumbersFromMongo();
    if (!numbers || numbers.length === 0) return res.status(404).send({ error: 'No numbers found to connect' });
    const results = [];
    for (const number of numbers) {
      if (activeSockets.has(number) || pairingInProgress.has(number)) { results.push({ number, status: 'already_connected' }); continue; }
      const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
      await EmpirePair(number, mockRes);
      results.push({ number, status: 'connection_initiated' });
    }
    res.status(200).send({ status: 'success', connections: results });
  } catch (error) { console.error('Connect all error:', error); res.status(500).send({ error: 'Failed to connect all bots' }); }
});


router.get('/reconnect', async (req, res) => {
  try {
    const numbers = await getAllSessionNumbersFromMongo();
    if (!numbers || numbers.length === 0) return res.status(404).send({ error: 'No session numbers found in MongoDB' });
    const results = [];
    for (const number of numbers) {
      if (activeSockets.has(number) || pairingInProgress.has(number)) { results.push({ number, status: 'already_connected' }); continue; }
      const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
      try { await EmpirePair(number, mockRes); results.push({ number, status: 'connection_initiated' }); } catch (err) { results.push({ number, status: 'failed', error: err.message }); }
      await delay(1000);
    }
    res.status(200).send({ status: 'success', connections: results });
  } catch (error) { console.error('Reconnect error:', error); res.status(500).send({ error: 'Failed to reconnect bots' }); }
});


router.get('/update-config', async (req, res) => {
  const { number, config: configString } = req.query;
  if (!number || !configString) return res.status(400).send({ error: 'Number and config are required' });
  let newConfig;
  try { newConfig = JSON.parse(configString); } catch (error) { return res.status(400).send({ error: 'Invalid config format' }); }
  const sanitizedNumber = number.replace(/[^0-9]/g, '');
  const socket = activeSockets.get(sanitizedNumber);
  if (!socket) return res.status(404).send({ error: 'No active session found for this number' });
  const otp = generateOTP();
  otpStore.set(sanitizedNumber, { otp, expiry: Date.now() + config.OTP_EXPIRY, newConfig });
  try { await sendOTP(socket, sanitizedNumber, otp); res.status(200).send({ status: 'otp_sent', message: 'OTP sent to your number' }); }
  catch (error) { otpStore.delete(sanitizedNumber); res.status(500).send({ error: 'Failed to send OTP' }); }
});


router.get('/verify-otp', async (req, res) => {
  const { number, otp } = req.query;
  if (!number || !otp) return res.status(400).send({ error: 'Number and OTP are required' });
  const sanitizedNumber = number.replace(/[^0-9]/g, '');
  const storedData = otpStore.get(sanitizedNumber);
  if (!storedData) return res.status(400).send({ error: 'No OTP request found for this number' });
  if (Date.now() >= storedData.expiry) { otpStore.delete(sanitizedNumber); return res.status(400).send({ error: 'OTP has expired' }); }
  if (storedData.otp !== otp) return res.status(400).send({ error: 'Invalid OTP' });
  try {
    botBrandAls.enterWith({ bc: null }); // web/API context — default branding
    await setUserConfigInMongo(sanitizedNumber, storedData.newConfig);
    otpStore.delete(sanitizedNumber);
    const sock = activeSockets.get(sanitizedNumber);
    if (sock) await sock.sendMessage(jidNormalizedUser(sock.user.id), { image: { url: config.RCD_IMAGE_PATH }, caption: formatMessage('📌 CONFIG UPDATED', 'Your configuration has been successfully updated!', BOT_NAME_FANCY) });
    res.status(200).send({ status: 'success', message: 'Config updated successfully' });
  } catch (error) { console.error('Failed to update config:', error); res.status(500).send({ error: 'Failed to update config' }); }
});


router.get('/getabout', async (req, res) => {
  const { number, target } = req.query;
  if (!number || !target) return res.status(400).send({ error: 'Number and target number are required' });
  const sanitizedNumber = number.replace(/[^0-9]/g, '');
  const socket = activeSockets.get(sanitizedNumber);
  if (!socket) return res.status(404).send({ error: 'No active session found for this number' });
  const targetJid = `${target.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
  try {
    const statusData = await socket.fetchStatus(targetJid);
    const aboutStatus = statusData.status || 'No status available';
    const setAt = statusData.setAt ? moment(statusData.setAt).tz('Asia/Colombo').format('YYYY-MM-DD HH:mm:ss') : 'Unknown';
    res.status(200).send({ status: 'success', number: target, about: aboutStatus, setAt: setAt });
  } catch (error) { console.error(`Failed to fetch status for ${target}:`, error); res.status(500).send({ status: 'error', message: `Failed to fetch About status for ${target}.` }); }
});


// ---------------- Dashboard endpoints & static ----------------

const dashboardStaticDir = path.join(__dirname, 'dashboard_static');
if (!fs.existsSync(dashboardStaticDir)) fs.ensureDirSync(dashboardStaticDir);
router.use('/dashboard/static', express.static(dashboardStaticDir));
router.get('/dashboard', async (req, res) => {
  res.sendFile(path.join(dashboardStaticDir, 'index.html'));
});


// API: sessions & active & delete

router.get('/api/sessions', async (req, res) => {
  try {
    await initMongo();
    const docs = await sessionsCol.find({}, { projection: { number: 1, updatedAt: 1 } }).sort({ updatedAt: -1 }).toArray();
    res.json({ ok: true, sessions: docs });
  } catch (err) {
    console.error('API /api/sessions error', err);
    res.status(500).json({ ok: false, error: err.message || err });
  }
});


router.get('/api/active', async (req, res) => {
  try {
    const keys = Array.from(activeSockets.keys());
    res.json({ ok: true, active: keys, count: keys.length });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || err });
  }
});


router.post('/api/session/delete', async (req, res) => {
  try {
    const { number } = req.body;
    if (!number) return res.status(400).json({ ok: false, error: 'number required' });
    const sanitized = ('' + number).replace(/[^0-9]/g, '');
    const running = activeSockets.get(sanitized);
    if (running) {
      try { if (typeof running.logout === 'function') await running.logout().catch(()=>{}); } catch(e){}
      try { running.ws?.close(); } catch(e){}
      activeSockets.delete(sanitized);
      socketCreationTime.delete(sanitized);
      pairingInProgress.delete(sanitized);
      pairingSockets.delete(sanitized);
      latestPairCode.delete(sanitized);
      loggedOutSessions.delete(sanitized);
      clearConnectWatchdog(sanitized);
    }
    await removeSessionFromMongo(sanitized);
    await removeNumberFromMongo(sanitized);
    try { const sessTmp = path.join(os.tmpdir(), `session_${sanitized}`); if (fs.existsSync(sessTmp)) fs.removeSync(sessTmp); } catch(e){}
    res.json({ ok: true, message: `Session ${sanitized} removed` });
  } catch (err) {
    console.error('API /api/session/delete error', err);
    res.status(500).json({ ok: false, error: err.message || err });
  }
});


router.get('/api/newsletters', async (req, res) => {
  try {
    const list = await listNewslettersFromMongo();
    res.json({ ok: true, list });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || err });
  }
});
router.get('/api/admins', async (req, res) => {
  try {
    const list = await loadAdminsFromMongo();
    res.json({ ok: true, list });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || err });
  }
});


// ---------------- cleanup + process events ----------------

process.on('exit', () => {
  activeSockets.forEach((socket, number) => {
    try { socket.ws.close(); } catch (e) {}
    activeSockets.delete(number);
    socketCreationTime.delete(number);
  });
  pairingSockets.forEach((socket, number) => {
    try { socket.ws.close(); } catch (e) {}
    pairingSockets.delete(number);
  });
  pairingInProgress.clear();
  latestPairCode.clear();
  connectWatchdog.forEach((wd, number) => { clearTimeout(wd); connectWatchdog.delete(number); });
});


process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  // Exit so a half-dead process never lingers holding ports/memory. PM2's
  // autorestart (ecosystem.config.js) handles the recovery — no manual
  // `pm2 restart` here, which would race the old process releasing port 8002.
  try { setTimeout(() => process.exit(1), 1000); } catch(e) {}
});

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});


// initialize mongo & auto-reconnect attempt

initMongo().catch(err => console.warn('Mongo init failed at startup', err));
(async()=>{ try { const nums = await getAllSessionNumbersFromMongo(); if (nums && nums.length) { for (const n of nums) { if (!activeSockets.has(n) && !pairingInProgress.has(n)) { const mockRes = { headersSent:false, send:()=>{}, status:()=>mockRes }; await EmpirePair(n, mockRes); await delay(500); } } } } catch(e){} })();

module.exports = { router, botRouter };



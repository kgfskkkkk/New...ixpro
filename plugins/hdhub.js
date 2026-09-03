// plugins/hdhub.js — .hdhub command
// HDHub4u scraper (new1.hdhub4u.af): search → details → download links
// Author: Ryusei Hoshino (adapted to CommonJS)
const axios = require('axios');
const cheerio = require('cheerio');

const BASE = 'https://new1.hdhub4u.af';
const SEARCH_API = 'https://search.pingora.fyi/collections/post/documents/search';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';

const htmlHeaders = {
  'User-Agent': UA,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

const apiHeaders = {
  'User-Agent': UA,
  Accept: 'application/json',
  Origin: BASE,
  Referer: BASE + '/',
  'X-TYPESENSE-CACHE-CONFIG': 'none',
  'X-TYPESENSE-DATA': 'search',
};

const INFO_LABELS = ['iMDB Rating:', 'Genre:', 'Stars:', 'Director:', 'Language:', 'Quality:'];

const SESSION_TTL = 10 * 60 * 1000;
const MENU_TTL = 15 * 60 * 1000;
const MENU_MAX = 800;
const MAX_RESULTS = 10;

const sessions = new Map();
const menuIds = new Map();
const throttle = new Map();
const chatNudge = new Map();
const REPLY_THROTTLE_MS = 2500;
const SEARCH_COOLDOWN_MS = 4000;
const NUDGE_COOLDOWN_MS = 30000;

function normUser(u) {
  return String(u || '').split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
}
function sessionKey(chat, user) { return `${chat || ''}::${normUser(user)}`; }
function safeErr(e) { return String((e && e.message) || e || 'Unknown error').replace(/https?:\/\/\S+/gi, '[url]'); }
function botNumber(socket) { return String((socket && socket.user && socket.user.id) || '').split(':')[0].split('@')[0] || ''; }
function getQuotedMessageId(msg) {
  try {
    if (!msg || !msg.message) return '';
    const ctx = msg.message.extendedTextMessage && msg.message.extendedTextMessage.contextInfo;
    return ctx && ctx.stanzaId ? String(ctx.stanzaId) : '';
  } catch (e) { return ''; }
}

function toAbsolute(url) {
  if (!url) return null;
  return url.startsWith('http') ? url : BASE + url;
}

function getSession(chat, user) {
  const key = sessionKey(chat, user);
  const s = sessions.get(key);
  if (!s) return null;
  if (s.expiresAt && Date.now() > s.expiresAt) { sessions.delete(key); return null; }
  return s;
}
function saveSession(chat, user, session) {
  const key = sessionKey(chat, user);
  if (session.timer) clearTimeout(session.timer);
  session.createdAt = Date.now();
  session.expiresAt = session.createdAt + SESSION_TTL;
  session.timer = setTimeout(() => sessions.delete(key), SESSION_TTL);
  sessions.set(key, session);
}
function dropSession(chat, user) { const key = sessionKey(chat, user); const s = sessions.get(key); if (s && s.timer) clearTimeout(s.timer); sessions.delete(key); }
function isActive(user) { const u = normUser(user); if (!u) return false; for (const [key] of sessions) if (key.endsWith('::' + u)) return true; return false; }
function clear(user) { const u = normUser(user); if (!u) return; for (const [key] of sessions) if (key.endsWith('::' + u)) sessions.delete(key); for (const [key] of throttle) if (key.endsWith('::' + u)) throttle.delete(key); }

function recordMenu(msgId, chat, user, step, botNum) {
  try {
    if (!msgId) return;
    menuIds.set(String(msgId), { chat, user: normUser(user), step, ts: Date.now(), botNum: botNum || '' });
    if (menuIds.size > MENU_MAX) { const now = Date.now(); for (const [k, v] of menuIds) if (now - v.ts > MENU_TTL) menuIds.delete(k); while (menuIds.size > MENU_MAX) menuIds.delete(menuIds.keys().next().value); }
  } catch (e) {}
}
function menuMatch(stanzaId, chat, user, botNum) {
  try {
    if (!stanzaId) return null;
    const rec = menuIds.get(String(stanzaId));
    if (!rec) return null;
    if (rec.chat !== chat) return null;
    if (rec.user !== normUser(user)) return null;
    if (Date.now() - rec.ts > MENU_TTL) { menuIds.delete(String(stanzaId)); return null; }
    if (botNum && rec.botNum && rec.botNum !== botNum) return null;
    return rec;
  } catch (e) { return null; }
}

function throttleEntry(chat, user) {
  const key = sessionKey(chat, user);
  let e = throttle.get(key);
  if (e && e.lastActivity > 0 && Date.now() - e.lastActivity > SESSION_TTL) { throttle.delete(key); e = null; }
  if (!e) { e = { reply: 0, search: 0, searchWarn: 0, nudge: 0, busy: false, lastActivity: 0 }; throttle.set(key, e); }
  return e;
}

// ---- API functions ----
async function searchMovie(query) {
  const { data } = await axios.get(SEARCH_API, {
    params: { q: query.trim(), query_by: 'post_title,category,stars,director,imdb_id', query_by_weights: '4,2,2,2,4', sort_by: 'sort_by_date:desc', limit: 15, page: 1 },
    headers: apiHeaders, timeout: 30000,
  });
  const results = (data.hits || []).map(hit => {
    const doc = hit.document || {};
    return { title: doc.post_title || null, url: toAbsolute(doc.permalink || ''), image: doc.post_thumbnail || null, id: doc.id || null, imdb_id: doc.imdb_id || null, categories: doc.category || [], stars: doc.stars || [], director: Array.isArray(doc.director) ? doc.director[0] : doc.director || null };
  });
  return { totalResults: data.found || 0, count: results.length, results };
}

async function detailMovie(url) {
  const targetUrl = toAbsolute(url);
  const { data } = await axios.get(targetUrl, { headers: htmlHeaders, timeout: 30000 });
  const $ = cheerio.load(data);
  const info = { url: targetUrl };
  info.title = $('h1.page-title span.material-text').first().text().trim() || null;
  info.image = $('main.page-body img.aligncenter').first().attr('src') || null;
  const meta = {};
  for (const label of INFO_LABELS) {
    const $strong = $('main.page-body strong').filter((_, el) => $(el).text().trim() === label).first();
    if ($strong.length) { const value = $strong.parent().text().replace(label, '').trim(); const key = label.replace(/:$/, '').replace(/\s+/g, ''); meta[key] = value; }
  }
  info.imdbRating = meta.iMDBRating || null;
  info.genre = meta.Genre ? meta.Genre.split('|').map(s => s.trim()).filter(Boolean) : null;
  info.stars = meta.Stars ? meta.Stars.split(',').map(s => s.trim()).filter(Boolean) : null;
  info.director = meta.Director || null;
  info.language = meta.Language || null;
  info.quality = meta.Quality || null;
  const downloadLinks = [];
  const watchLinks = [];
  $('main.page-body h3 a, main.page-body h4 a').each((_, el) => {
    const $a = $(el);
    const text = $a.text().trim();
    const href = $a.attr('href');
    if (!href) return;
    const $img = $a.find('img').first();
    if (/watch|player/i.test(text)) { watchLinks.push({ text, url: toAbsolute(href) }); return; }
    if (text && !$img.length) downloadLinks.push({ text, url: toAbsolute(href) });
  });
  info.downloadLinks = downloadLinks;
  info.watchLinks = watchLinks;
  // storyline
  const $span = $('div.kno-rdesc span').filter((_, el) => $(el).find('strong').length).first();
  if ($span.length) {
    const $inner = $span.parent();
    const $clone = $inner.clone();
    $clone.find('h2').remove(); $clone.find('p').remove(); $clone.find('strong').remove();
    info.storyline = $clone.text().trim() || null;
  } else { info.storyline = null; }
  return info;
}

// ---- Send helpers ----
async function sendText(socket, to, text, quoted) {
  try { return await socket.sendMessage(to, { text }, { quoted: quoted || null }); } catch (e) { return null; }
}
async function editOrSend(socket, to, key, text, quoted) {
  if (key) { try { return await socket.sendMessage(to, { text, edit: key }); } catch (e) {} }
  return sendText(socket, to, text, quoted);
}
async function deleteMsg(socket, to, key) { if (!key) return; try { await socket.sendMessage(to, { delete: key }); } catch (e) {} }

// ---- Message builders ----
function buildUsage(prefix) {
  return `╭━━〔 🎬 *HDHUB4U* 〕━━┈\n│\n│ ❌ *Missing movie name!*\n│\n│ 💡 *Usage:* ${prefix}hdhub <movie name>\n│ 📌 *Example:* ${prefix}hdhub Pushpa 2\n╰━━━━━━━━━━━━━━━━━━┈`;
}

function buildSearchList(results) {
  let txt = `╭━━〔 🎬 *HDHUB SEARCH* 〕━━┈\n│\n`;
  results.forEach((r, i) => {
    const imdb = r.imdb_id ? ` [${r.imdb_id}]` : '';
    txt += `│ *${i + 1}.* ${r.title || 'Unknown'}${imdb}\n`;
  });
  txt += `│\n├━━━━━━━━━━━━━━━━━┈\n│ 💡 *Reply with a number (1-${results.length})*\n│ _to select a movie._\n╰━━━━━━━━━━━━━━━━━━┈`;
  return txt;
}

function buildDetails(data) {
  let txt = `╭━━〔 🎬 *MOVIE INFO* 〕━━┈\n`;
  txt += `│ 🎞️ *Title:* ${data.title || 'Unknown'}\n`;
  if (data.language) txt += `│ 🌐 *Language:* ${data.language}\n`;
  if (data.quality) txt += `│ 🎯 *Quality:* ${data.quality}\n`;
  if (data.imdbRating) txt += `│ ⭐ *IMDb:* ${data.imdbRating}\n`;
  if (data.genre && data.genre.length) txt += `│ 🏷️ *Genre:* ${data.genre.join(', ')}\n`;
  if (data.stars && data.stars.length) txt += `│ 🎭 *Stars:* ${data.stars.slice(0, 3).join(', ')}${data.stars.length > 3 ? '...' : ''}\n`;
  if (data.director) txt += `│ 🎬 *Director:* ${data.director}\n`;
  if (data.storyline) {
    const s = String(data.storyline).replace(/\n+/g, ' ').slice(0, 400);
    txt += `│ 📝 *Storyline:*\n│ ${s}${String(data.storyline).length > 400 ? '...' : ''}\n`;
  }
  txt += `╰━━━━━━━━━━━━━━━━━━━━━━╯`;
  return txt;
}

function buildLinksList(data) {
  let txt = `╭━━〔 ⬇️ *DOWNLOAD LINKS* 〕━━┈\n│\n`;
  if (data.downloadLinks && data.downloadLinks.length) {
    data.downloadLinks.forEach((l, i) => {
      txt += `│ *${i + 1}.* ${l.text}\n`;
    });
  }
  txt += `╰━━━━━━━━━━━━━━━━━━━━━━╯\n\n💡 *Reply with a number to get the link*`;
  if (data.watchLinks && data.watchLinks.length) {
    txt += `\n\n╭━━〔 ▶️ *WATCH LINKS* 〕━━┈\n│\n`;
    data.watchLinks.forEach((l, i) => {
      txt += `│ *${i + 1}.* ${l.text}\n`;
    });
    txt += `╰━━━━━━━━━━━━━━━━━━━━━━╯\n💡 *Reply with watch <number> to watch*`;
  }
  return txt;
}

// ---- Command handler ----
async function handleCommand(socket, msg, args, from, sender, nowsender, prefix) {
  const query = (args || []).join(' ').trim();
  if (!query) { await sendText(socket, from, buildUsage(prefix || '.'), msg); return; }

  const thr = throttleEntry(from, nowsender);
  if (Date.now() - thr.search < SEARCH_COOLDOWN_MS) {
    if (Date.now() - thr.searchWarn >= SEARCH_COOLDOWN_MS) { thr.searchWarn = Date.now(); await sendText(socket, from, '⏳ *Slow down!* Wait a few seconds.', msg); }
    return;
  }
  thr.search = Date.now();
  thr.lastActivity = Date.now();
  thr.reply = 0;

  const loading = await sendText(socket, from, '🔎 *Searching HDHub4u...*', msg);

  let results = [];
  try {
    const res = await searchMovie(query);
    results = (res.results || []).slice(0, MAX_RESULTS);
  } catch (e) {
    console.error('[hdhub] search failed:', safeErr(e));
    await editOrSend(socket, from, loading && loading.key, '❌ *Search failed.*\n\n_API may be down._', msg);
    return;
  }

  if (!results.length) {
    await editOrSend(socket, from, loading && loading.key, `❌ *No results for "_${query}_"*`, msg);
    return;
  }

  let listMsgId = null;
  try {
    const first = results[0];
    if (first && first.image) {
      const imgRes = await axios.get(first.image, { responseType: 'arraybuffer', timeout: 15000 });
      const sent = await socket.sendMessage(from, { image: Buffer.from(imgRes.data), caption: buildSearchList(results) }, { quoted: msg });
      listMsgId = sent && sent.key && sent.key.id;
    }
  } catch (e) { /* image failed, fall through to text */ }
  if (!listMsgId) {
    const sent = await editOrSend(socket, from, loading && loading.key, buildSearchList(results), msg);
    listMsgId = sent && sent.key && sent.key.id;
  }
  saveSession(from, nowsender, { step: 'search', searchResults: results, detail: null, page: 1, botJid: botNumber(socket), searchMessageId: listMsgId });
  recordMenu(listMsgId, from, nowsender, 'search', botNumber(socket));
}

// ---- Reply handler ----
async function handleReply(socket, msg, from, sender, nowsender) {
  const raw = msg && msg.message;
  const body = String(
    (raw && (raw.conversation ||
      (raw.extendedTextMessage && raw.extendedTextMessage.text) ||
      '')) || ''
  ).trim();
  if (!body) return false;

  const msgUser = (() => {
    const k = msg && msg.key;
    if (!k) return sender;
    if (k.fromMe) return String((socket && socket.user && socket.user.id) || '').split(':')[0] + '@s.whatsapp.net';
    return k.participant || k.remoteJid || sender;
  })();
  const myNum = botNumber(socket);

  const quotedMsgId = getQuotedMessageId(msg);
  const menuRec = menuMatch(quotedMsgId, from, msgUser, myNum);
  if (!menuRec) return false;

  const session = getSession(from, msgUser);
  const thr = throttleEntry(from, msgUser);

  if (!session) {
    const chatOk = (Date.now() - (chatNudge.get(from) || 0)) >= NUDGE_COOLDOWN_MS;
    if (chatOk && (Date.now() - thr.nudge) >= NUDGE_COOLDOWN_MS) {
      thr.nudge = Date.now(); thr.lastActivity = Date.now(); chatNudge.set(from, Date.now());
      await sendText(socket, from, '⚠️ *Session expired.* Use *.hdhub <name>* again.', msg);
    }
    return true;
  }

  if (session.botJid && myNum && session.botJid !== myNum) return true;
  const isNumericReply = /^\d{1,3}$/.test(body);
  if (thr.busy) return true;
  if (isNumericReply && Date.now() - thr.reply < REPLY_THROTTLE_MS) return true;
  thr.busy = true;
  thr.lastActivity = Date.now();

  try {
    const isCurrentList = session.step !== 'search' || !session.searchMessageId || quotedMsgId === session.searchMessageId;
    if (menuRec.step !== session.step || !isCurrentList) {
      await sendText(socket, from, 'ℹ️ That list is no longer active — reply to the *latest* hdhub message.', msg);
      return true;
    }

    // Step 1: pick movie
    if (session.step === 'search') {
      const num = parseInt(body, 10);
      if (isNaN(num) || num < 1 || num > session.searchResults.length) {
        await sendText(socket, from, `❌ *Invalid number.* Reply 1-${session.searchResults.length}.`, msg);
        return true;
      }
      const chosen = session.searchResults[num - 1];
      if (!chosen || !chosen.url) {
        dropSession(from, msgUser);
        await sendText(socket, from, '❌ *Invalid result.* Search again with *.hdhub <name>*.', msg);
        return true;
      }

      const loading = await sendText(socket, from, '📥 *Fetching movie details...*', msg);

      let data;
      try {
        data = await detailMovie(chosen.url);
      } catch (e) {
        console.error('[hdhub] detail failed:', safeErr(e));
        dropSession(from, msgUser);
        await editOrSend(socket, from, loading && loading.key, '❌ *Failed to fetch details.*', msg);
        return true;
      }

      if (!data.downloadLinks || !data.downloadLinks.length) {
        dropSession(from, msgUser);
        await editOrSend(socket, from, loading && loading.key, '❌ *No download links found.*', msg);
        return true;
      }

      session.step = 'links';
      session.detail = data;
      saveSession(from, msgUser, session);
      await deleteMsg(socket, from, loading && loading.key);

      // send details image + info
      if (data.image) {
        try {
          const imgRes = await axios.get(data.image, { responseType: 'arraybuffer', timeout: 15000 });
          await socket.sendMessage(from, { image: Buffer.from(imgRes.data), caption: buildDetails(data) }, { quoted: msg });
        } catch (e) {
          await sendText(socket, from, buildDetails(data), msg);
        }
      } else {
        await sendText(socket, from, buildDetails(data), msg);
      }
      const linksMsg = await sendText(socket, from, buildLinksList(data), msg);
      recordMenu(linksMsg && linksMsg.key && linksMsg.key.id, from, msgUser, 'links', myNum);
      return true;
    }

    // Step 2: pick download link
    if (session.step === 'links') {
      const detail = session.detail;
      if (!detail) { dropSession(from, msgUser); await sendText(socket, from, '❌ Session lost. Search again.', msg); return true; }

      const lower = body.toLowerCase().trim();

      // watch command
      if (lower.startsWith('watch ')) {
        const wNum = parseInt(lower.replace('watch', '').trim(), 10);
        if (isNaN(wNum) || wNum < 1 || wNum > (detail.watchLinks || []).length) {
          await sendText(socket, from, `❌ *Invalid watch number.* Reply with watch 1-${(detail.watchLinks || []).length}.`, msg);
          return true;
        }
        const link = detail.watchLinks[wNum - 1];
        await sendText(socket, from, `▶️ *${link.text}*\n\n${link.url}`, msg);
        session.createdAt = Date.now();
        saveSession(from, msgUser, session);
        return true;
      }

      const num = parseInt(body, 10);
      if (isNaN(num) || num < 1 || num > detail.downloadLinks.length) {
        await sendText(socket, from, `❌ *Invalid number.* Reply 1-${detail.downloadLinks.length}.`, msg);
        return true;
      }

      const link = detail.downloadLinks[num - 1];
      const txt = `⬇️ *${link.text}*\n\n🔗 ${link.url}`;
      await sendText(socket, from, txt, msg);

      session.createdAt = Date.now();
      saveSession(from, msgUser, session);
      return true;
    }
  } catch (e) {
    console.error('[hdhub] reply error:', safeErr(e));
    await sendText(socket, from, '❌ *Something went wrong.*\n\nTry *.hdhub <name>* again.', msg).catch(() => {});
  } finally {
    thr.busy = false;
    thr.reply = Date.now();
    thr.lastActivity = Date.now();
  }
  return true;
}

function quotesMenu(socket, msg, from, user) {
  try {
    const ctx = (msg && msg.message && msg.message.extendedTextMessage &&
      msg.message.extendedTextMessage.contextInfo) || {};
    return !!menuMatch(ctx.stanzaId || '', from, user, botNumber(socket));
  } catch (e) { return false; }
}

module.exports = async function hdhubHandler(socket, msg, args, from, sender, isCommand, nowsender, prefix) {
  if (isCommand) { await handleCommand(socket, msg, args, from, sender, nowsender, prefix); return; }
  return handleReply(socket, msg, from, sender, nowsender);
};
module.exports.isActive = isActive;
module.exports.clear = clear;
module.exports.quotesMenu = quotesMenu;

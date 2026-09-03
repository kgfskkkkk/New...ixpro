// plugins/animeheaven.js — .animeheaven command
// AnimeHeaven API (scraper-murex-rho.vercel.app): search → details → episode
// video file, sent straight to the chat (document fallback when the video
// send fails, plain link as the last resort).
const axios = require('axios');
const disk = require('./disk');

// ---------- API constants ----------
const API_BASE = 'https://scraper-murex-rho.vercel.app/api';
const API_TIMEOUT = 15000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

// ---------- Flow limits ----------
const SESSION_TTL = 10 * 60 * 1000;
const MENU_TTL = 15 * 60 * 1000;
const MENU_MAX = 800;
const MAX_SEARCH_RESULTS = 10;
const EPISODES_PER_PAGE = 50;

// ---------- Anti-spam ----------
const REPLY_THROTTLE_MS = 2500;
const SEARCH_COOLDOWN_MS = 4000;
const NUDGE_COOLDOWN_MS = 30000;

// ---------- State stores ----------
const sessions = new Map();
const menuIds = new Map();
const throttle = new Map();
const chatNudge = new Map();

// ---------- Helpers ----------
function normUser(u) {
  return String(u || '').split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
}

function getQuotedMessageId(msg) {
  try {
    if (!msg || !msg.message) return '';
    const ctx = msg.message.extendedTextMessage && msg.message.extendedTextMessage.contextInfo;
    return ctx && ctx.stanzaId ? String(ctx.stanzaId) : '';
  } catch (e) { return ''; }
}

function botNumber(socket) {
  return String((socket && socket.user && socket.user.id) || '').split(':')[0].split('@')[0] || '';
}

function sessionKey(chat, user) { return `${chat || ''}::${normUser(user)}`; }

function safeErr(e) {
  return String((e && e.message) || e || 'Unknown error').replace(/https?:\/\/\S+/gi, '[url]');
}

// ---------- Session management ----------
function getSession(chat, user) {
  const key = sessionKey(chat, user);
  const s = sessions.get(key);
  if (!s) return null;
  if (s.expiresAt && Date.now() > s.expiresAt) { sessions.delete(key); return null; }
  if (Date.now() - s.createdAt > SESSION_TTL) { sessions.delete(key); return null; }
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

function dropSession(chat, user) {
  const key = sessionKey(chat, user);
  const s = sessions.get(key);
  if (s && s.timer) clearTimeout(s.timer);
  sessions.delete(key);
}

function isActive(user) {
  const u = normUser(user);
  if (!u) return false;
  for (const [key] of sessions) if (key.endsWith('::' + u)) return true;
  return false;
}

function clear(user) {
  const u = normUser(user);
  if (!u) return;
  for (const [key] of sessions) if (key.endsWith('::' + u)) sessions.delete(key);
  for (const [key] of throttle) if (key.endsWith('::' + u)) throttle.delete(key);
}

// ---------- Menu registry ----------
function recordMenu(msgId, chat, user, step, botNum) {
  try {
    if (!msgId) return;
    menuIds.set(String(msgId), { chat, user: normUser(user), step, ts: Date.now(), botNum: botNum || '' });
    if (menuIds.size > MENU_MAX) {
      const now = Date.now();
      for (const [k, v] of menuIds) if (now - v.ts > MENU_TTL) menuIds.delete(k);
      while (menuIds.size > MENU_MAX) menuIds.delete(menuIds.keys().next().value);
    }
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

function quotesMenu(socket, msg, from, user) {
  try {
    const ctx = (msg && msg.message && msg.message.extendedTextMessage &&
      msg.message.extendedTextMessage.contextInfo) || {};
    return !!menuMatch(ctx.stanzaId || '', from, user, botNumber(socket));
  } catch (e) { return false; }
}

// ---------- Anti-spam throttle ----------
function throttleEntry(chat, user) {
  const key = sessionKey(chat, user);
  let e = throttle.get(key);
  if (e && e.lastActivity > 0 && Date.now() - e.lastActivity > SESSION_TTL) {
    throttle.delete(key);
    e = null;
  }
  if (!e) { e = { reply: 0, search: 0, searchWarn: 0, nudge: 0, busy: false, lastActivity: 0 }; throttle.set(key, e); }
  return e;
}

// ---------- API wrappers ----------
async function apiSearch(query) {
  const url = `${API_BASE}/search?q=${encodeURIComponent(query)}`;
  const res = await axios.get(url, { timeout: API_TIMEOUT, headers: { 'User-Agent': UA } });
  const d = res && res.data;
  if (!d || !Array.isArray(d.results)) throw new Error('Search API returned no results');
  return d.results;
}

async function apiDetails(id) {
  const url = `${API_BASE}/anime/${encodeURIComponent(id)}`;
  const res = await axios.get(url, { timeout: API_TIMEOUT, headers: { 'User-Agent': UA } });
  const d = res && res.data;
  if (!d || !d.title) throw new Error('Details API returned nothing');
  return d;
}

async function apiGetEpisode(animeId, episode) {
  const url = `${API_BASE}/episode/${encodeURIComponent(animeId)}/${encodeURIComponent(episode)}`;
  const res = await axios.get(url, { timeout: API_TIMEOUT, headers: { 'User-Agent': UA } });
  const d = res && res.data;
  if (!d || !d.video_url) throw new Error('Episode link unavailable');
  return d.video_url;
}

// ---------- Send helpers ----------
async function sendText(socket, to, text, quoted) {
  try { return await socket.sendMessage(to, { text }, { quoted: quoted || null }); } catch (e) { return null; }
}

async function editOrSend(socket, to, key, text, quoted) {
  if (key) {
    try { return await socket.sendMessage(to, { text, edit: key }); } catch (e) { /* fall through */ }
  }
  return sendText(socket, to, text, quoted);
}

async function deleteMsg(socket, to, key) {
  if (!key) return;
  try { await socket.sendMessage(to, { delete: key }); } catch (e) {}
}

// ---------- Message builders ----------
function buildUsage(prefix) {
  return `╭━━〔 🎬 *ANIME HEAVEN* 〕━━┈\n│\n│ ❌ *Missing anime name!*\n│\n│ 💡 *Usage:* ${prefix}animeheaven <anime name>\n│ 📌 *Example:* ${prefix}animeheaven One Piece\n╰━━━━━━━━━━━━━━━━━━┈`;
}

function buildSearchList(results) {
  let txt = `╭━━〔 🎬 *ANIME SEARCH* 〕━━┈\n│\n`;
  results.forEach((r, i) => {
    txt += `│ *${i + 1}.* ${r.title || 'Unknown'}\n`;
  });
  txt += `│\n├━━━━━━━━━━━━━━━━━┈\n│ 💡 *Reply with a number (1-${results.length})*\n│ _to select an anime._\n╰━━━━━━━━━━━━━━━━━━┈`;
  return txt;
}

function buildDetails(data) {
  const episodes = Array.isArray(data.episode_list) ? data.episode_list : [];
  let info = `╭━━〔 🎬 *ANIME INFO* 〕━━┈\n`;
  info += `│ 🎞️ *Title:* ${data.title || 'Unknown'}\n`;
  if (data.year) info += `│ 📅 *Year:* ${data.year}\n`;
  if (data.score != null && data.score !== '') info += `│ ⭐ *Score:* ${data.score}/10\n`;
  info += `│ 📺 *Episodes:* ${data.episodes_count || episodes.length || '?'}\n`;
  if (data.description) {
    const d = String(data.description).replace(/\n+/g, ' ').slice(0, 420);
    info += `│ 📝 *Description:*\n│ ${d}${String(data.description).length > 420 ? '...' : ''}\n`;
  }
  if (Array.isArray(data.tags) && data.tags.length) {
    info += `│ 🏷️ *Tags:* ${data.tags.join(' • ')}\n`;
  }
  info += `╰━━━━━━━━━━━━━━━━━━━━━━╯`;
  return info;
}

function buildEpisodePage(title, episodes, page, perPage) {
  const start = (page - 1) * perPage;
  const end = Math.min(start + perPage, episodes.length);
  const totalPages = Math.ceil(episodes.length / perPage) || 1;
  let txt = `╭━━〔 📺 *EPISODES* 〕━━┈\n`;
  if (title) txt += `│ 🎬 *${title}*\n│\n`;
  for (let i = start; i < end; i++) {
    const ep = episodes[i];
    txt += `│ *${i + 1}.* Episode ${(ep && ep.episode != null) ? ep.episode : (i + 1)}\n`;
  }
  txt += `╰━━━━━━━━━━━━━━━━━━━━━━╯\n`;
  if (totalPages > 1) {
    txt += `\n📄 *Page ${page}/${totalPages}* (Episodes ${start + 1}-${end} of ${episodes.length})`;
    if (page > 1) txt += `\n⬅️ Reply *back* for the previous page`;
    if (page < totalPages) txt += `\n➡️ Reply *more* for the next page`;
    txt += `\n\nOr reply with the episode number.`;
  } else {
    txt += `\nReply with the episode number.`;
  }
  return txt;
}

// ---------- Episode sending ----------
async function sendEpisode(socket, from, mediaUrl, title, epNumber, quoted) {
  const caption = `✅ *Episode ready*\n🎞️ ${title} — Episode ${epNumber}`;
  const fileName = `Episode_${epNumber}.mp4`;
  try {
    await disk.ensureUrlSpace(mediaUrl, fileName);
  } catch (e) {
    console.warn('[animeheaven] not enough disk for episode, falling back to link:', safeErr(e));
    return { ok: false, link: mediaUrl };
  }
  try {
    await disk.withDownloadSlot(async () => {
      await socket.sendMessage(from, {
        video: { url: mediaUrl },
        mimetype: 'video/mp4',
        caption
      }, { quoted });
    });
    return { ok: true };
  } catch (e) {
    try {
      await disk.withDownloadSlot(async () => {
        await socket.sendMessage(from, {
          document: { url: mediaUrl },
          mimetype: 'video/mp4',
          fileName,
          caption
        }, { quoted });
      });
      return { ok: true };
    } catch (e2) {
      console.warn('[animeheaven] video/document send failed, falling back to link:', safeErr(e2));
      return { ok: false, link: mediaUrl };
    }
  }
}

// ---------- Command handler ----------
async function handleCommand(socket, msg, args, from, sender, nowsender, prefix) {
  const query = (args || []).join(' ').trim();
  if (!query) {
    await sendText(socket, from, buildUsage(prefix || '.'), msg);
    return;
  }

  const thr = throttleEntry(from, nowsender);
  if (Date.now() - thr.search < SEARCH_COOLDOWN_MS) {
    if (Date.now() - thr.searchWarn >= SEARCH_COOLDOWN_MS) {
      thr.searchWarn = Date.now();
      await sendText(socket, from, '⏳ *Slow down!* Wait a few seconds before searching again.', msg);
    }
    return;
  }
  thr.search = Date.now();
  thr.lastActivity = Date.now();
  thr.reply = 0;

  const loading = await sendText(socket, from, '🔎 *Searching Anime...*', msg);

  let results = [];
  try {
    results = await apiSearch(query);
  } catch (e) {
    console.error('[animeheaven] search failed:', safeErr(e));
    await editOrSend(socket, from, loading && loading.key, '❌ *Anime search failed.*\n\n_API may be down, try again later._', msg);
    return;
  }

  const top = (results || []).slice(0, MAX_SEARCH_RESULTS);
  if (!top.length) {
    await editOrSend(socket, from, loading && loading.key, `❌ *Anime not found* for "_${query}_".\n\n_Try checking the spelling._`, msg);
    return;
  }

  let listMsgId = null;
  try {
    const first = top[0];
    let poster = first && first.cover_image;
    if (poster) {
      try {
        const imgRes = await axios.get(poster, { responseType: 'arraybuffer', timeout: API_TIMEOUT });
        const sent = await socket.sendMessage(from, { image: Buffer.from(imgRes.data), caption: buildSearchList(top) }, { quoted: msg });
        listMsgId = sent && sent.key && sent.key.id;
      } catch (e) {
        const sentList = await editOrSend(socket, from, loading && loading.key, buildSearchList(top), msg);
        listMsgId = sentList && sentList.key && sentList.key.id;
      }
    } else {
      const sentList = await editOrSend(socket, from, loading && loading.key, buildSearchList(top), msg);
      listMsgId = sentList && sentList.key && sentList.key.id;
    }
  } catch (e) {
    const sentList = await editOrSend(socket, from, loading && loading.key, buildSearchList(top), msg);
    listMsgId = sentList && sentList.key && sentList.key.id;
  }

  saveSession(from, nowsender, {
    step: 'search',
    searchResults: top,
    selectedAnime: null,
    episodes: [],
    page: 1,
    createdAt: Date.now(),
    botJid: botNumber(socket),
    searchMessageId: listMsgId
  });
  recordMenu(listMsgId, from, nowsender, 'search', botNumber(socket));
}

// ---------- Reply handler ----------
async function handleReply(socket, msg, from, sender, nowsender) {
  const raw = msg && msg.message;
  const body = String(
    (raw && (raw.conversation ||
      (raw.extendedTextMessage && raw.extendedTextMessage.text) ||
      (raw.templateButtonReplyMessage && raw.templateButtonReplyMessage.selectedId) ||
      (raw.buttonsResponseMessage && raw.buttonsResponseMessage.selectedButtonId) ||
      (raw.listResponseMessage && raw.listResponseMessage.singleSelectReply && raw.listResponseMessage.singleSelectReply.selectedRowId) ||
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
      thr.nudge = Date.now();
      thr.lastActivity = Date.now();
      chatNudge.set(from, Date.now());
      await sendText(socket, from, '⚠️ *This search has expired.*\n\nPlease use *.animeheaven <name>* again.', msg);
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
    const isCurrentSearchList = session.step !== 'search' || !session.searchMessageId || quotedMsgId === session.searchMessageId;
    if (menuRec.step !== session.step || !isCurrentSearchList) {
      await sendText(socket, from, 'ℹ️ That list is no longer active — reply to the *latest* animeheaven message.', msg);
      return true;
    }

    // ---- Step 1: pick anime ----
    if (session.step === 'search') {
      const num = parseInt(body, 10);
      if (isNaN(num) || num < 1 || num > session.searchResults.length) {
        await sendText(socket, from, `❌ *Invalid anime number.* Reply with a number between *1-${session.searchResults.length}*.`, msg);
        return true;
      }

      const chosen = session.searchResults[num - 1];
      const title = chosen && chosen.title;
      const animeId = chosen && chosen.id;
      if (!animeId) {
        dropSession(from, msgUser);
        await sendText(socket, from, '❌ *Missing anime ID.* Please search again with *.animeheaven <name>*.', msg);
        return true;
      }

      const loading = await sendText(socket, from, '📥 *Fetching anime details...*', msg);

      let data;
      try {
        data = await apiDetails(animeId);
      } catch (e) {
        console.error('[animeheaven] details failed:', safeErr(e));
        dropSession(from, msgUser);
        await editOrSend(socket, from, loading && loading.key, '❌ *Failed to fetch anime details.*\n\n_Try another title._', msg);
        return true;
      }

      const episodes = (Array.isArray(data.episode_list) ? data.episode_list : [])
        .slice()
        .sort((a, b) => (Number(a && a.episode) || 0) - (Number(b && b.episode) || 0));
      if (!episodes.length) {
        dropSession(from, msgUser);
        await editOrSend(socket, from, loading && loading.key, '❌ *No episodes found* for this anime.', msg);
        return true;
      }

      session.selectedAnime = { title: data.title || title || 'Unknown', animeId, cover: data.cover_image || null };
      session.episodes = episodes;
      session.step = 'episodes';
      session.page = 1;
      saveSession(from, msgUser, session);

      await deleteMsg(socket, from, loading && loading.key);

      const detailText = buildDetails(data);
      let sentDetails = false;
      let detailsMsgId = '';

      if (data.cover_image) {
        try {
          const imgRes = await axios.get(data.cover_image, { responseType: 'arraybuffer', timeout: API_TIMEOUT });
          const imgSent = await socket.sendMessage(from, { image: Buffer.from(imgRes.data), caption: detailText }, { quoted: msg });
          sentDetails = true;
          detailsMsgId = imgSent && imgSent.key && imgSent.key.id;
        } catch (e) { /* fall through */ }
      }
      if (!sentDetails) {
        const txtSent = await sendText(socket, from, detailText, msg);
        detailsMsgId = txtSent && txtSent.key && txtSent.key.id;
      }

      const pageSent = await sendText(socket, from, buildEpisodePage(session.selectedAnime.title, episodes, 1, EPISODES_PER_PAGE), msg);
      recordMenu(detailsMsgId, from, msgUser, 'episodes', myNum);
      recordMenu(pageSent && pageSent.key && pageSent.key.id, from, msgUser, 'episodes', myNum);
      return true;
    }

    // ---- Step 2: pick episode ----
    if (session.step === 'episodes') {
      const episodes = session.episodes || [];
      const total = episodes.length;
      const perPage = EPISODES_PER_PAGE;
      const totalPages = Math.ceil(total / perPage) || 1;
      const lower = body.toLowerCase();

      if (lower === 'more' || lower === 'next' || lower === '>') {
        if (session.page >= totalPages) {
          await sendText(socket, from, '❌ *Already on the last page.*', msg);
        } else {
          session.page += 1;
          saveSession(from, msgUser, session);
          const pg = await sendText(socket, from, buildEpisodePage(session.selectedAnime.title, episodes, session.page, perPage), msg);
          recordMenu(pg && pg.key && pg.key.id, from, msgUser, 'episodes', myNum);
        }
        return true;
      }
      if (lower === 'back' || lower === 'prev' || lower === '<') {
        if (session.page <= 1) {
          await sendText(socket, from, '❌ *Already on the first page.*', msg);
        } else {
          session.page -= 1;
          saveSession(from, msgUser, session);
          const pg = await sendText(socket, from, buildEpisodePage(session.selectedAnime.title, episodes, session.page, perPage), msg);
          recordMenu(pg && pg.key && pg.key.id, from, msgUser, 'episodes', myNum);
        }
        return true;
      }

      const pick = parseInt(body, 10);
      if (isNaN(pick) || pick < 1 || pick > total) {
        await sendText(socket, from, `❌ *Invalid episode number.* Reply with a number between *1-${total}*.`, msg);
        return true;
      }

      const epData = episodes[pick - 1];
      const epNum = epData && epData.episode != null ? epData.episode : pick;
      const animeId = session.selectedAnime && session.selectedAnime.animeId;

      if (!animeId || !epNum) {
        await sendText(socket, from, '❌ *Invalid episode data.*\n\n_Please select again._', msg);
        return true;
      }

      const loading = await sendText(socket, from, '🔗 *Generating episode link...*', msg);

      let mediaUrl;
      try {
        mediaUrl = await apiGetEpisode(animeId, epNum);
      } catch (e) {
        console.error('[animeheaven] episode failed:', safeErr(e));
        await editOrSend(socket, from, loading && loading.key, '❌ *Episode link is unavailable.*\n\n_Please select the episode again._', msg);
        return true;
      }

      await deleteMsg(socket, from, loading && loading.key);

      const title = (session.selectedAnime && session.selectedAnime.title) || 'Anime';
      const sent = await sendEpisode(socket, from, mediaUrl, title, epNum, msg);
      if (!sent.ok && sent.link) {
        await sendText(socket, from, `✅ *Episode ready*\n🎞️ ${title} — Episode ${epNum}\n\n${sent.link}`, msg);
      }

      session.createdAt = Date.now();
      saveSession(from, msgUser, session);
      return true;
    }
  } catch (e) {
    console.error('[animeheaven] reply error:', safeErr(e));
    await sendText(socket, from, '❌ *Something went wrong.*\n\nTry *.animeheaven <name>* again.', msg).catch(() => {});
  } finally {
    thr.busy = false;
    thr.reply = Date.now();
    thr.lastActivity = Date.now();
  }
  return true;
}

// ---------- Main exported handler ----------
module.exports = async function animeheavenHandler(socket, msg, args, from, sender, isCommand, nowsender, prefix) {
  if (isCommand) {
    await handleCommand(socket, msg, args, from, sender, nowsender, prefix);
    return;
  }
  return handleReply(socket, msg, from, sender, nowsender);
};

module.exports.isActive = isActive;
module.exports.clear = clear;
module.exports.quotesMenu = quotesMenu;

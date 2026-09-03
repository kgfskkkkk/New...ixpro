// plugins/cinesublk.js — .lk command: scrapes cinesubz.net directly.
//
// What is scraped straight from the website (no third-party API):
//   • search results  (https://cinesubz.net/?s=<query>)
//   • movie details   (title / poster / director / year / country)
//   • TV episode list (per-season episode links)
//
// The final download URLs are resolved through the chama-movie-api backend
// (the same one .cinesubz / .cinetv use). cinesubz's OWN link pages sit
// behind a multi-layer anti-bot gauntlet (placeholder-domain mapping →
// session-gated /api/download-data → obfuscated anti-bot JS → Telegram
// bots), so they can't be reliably scraped with plain HTTP; chama returns
// direct avatarzone CDN links that work.
const axios = require('axios');
const disk = require('./disk');

// ---------- API constants ----------
const BASE = 'https://cinesubz.net';
const DL_API = 'https://apis.laksidu.site/dl/cinesubz';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

const CINESUBZ_API_BASE = 'https://apis.laksidu.site';

const SESSION_TTL = 10 * 60 * 1000;

// ---------- User state store ----------
const userStates = new Map();

// ---------- Helpers ----------
function decodeEntities(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

function normUser(u) {
  return String(u || '').split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
}

async function fetchHtml(url) {
  const res = await axios.get(url, {
    timeout: 30000,
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' }
  });
  return typeof res.data === 'string' ? res.data : String(res.data);
}

// ---------- Site scraping (regex, no extra deps) ----------
function scrapeSearch(html) {
  const results = [];
  const cards = html.split('class="display-item"').slice(1);
  for (const card of cards) {
    if (!card.includes('item-box')) continue;
    const href = (card.match(/<a href="([^"]+)"/) || [])[1] || '';
    const ptype = (card.match(/data-ptype="([^"]+)"/) || [])[1] || '';
    const title = (card.match(/<a href="[^"]+"[^>]*title="([^"]*)"/) || [])[1] || '';
    const thumb = (card.match(/class="thumb[^"]*" src="([^"]+)"/) || [])[1] || '';
    const imdb = (card.match(/imdb-score">([^<]*)</) || [])[1] || '';
    if (href && title) {
      results.push({ title: decodeEntities(title), url: href, thumb, imdb, type: ptype || (href.includes('/tvshows/') ? 'tvshows' : 'movies') });
      if (results.length >= 12) break;
    }
  }
  return results;
}

function scrapeMovie(html) {
  const title = (html.match(/details-title">\s*<h3>([^<]*)<\/h3>/) || [])[1] || '';
  const poster = (html.match(/class="poster-img" src="([^"]+)"/) || [])[1] || '';
  const director = (html.match(/<strong>Director:<\/strong>\s*<a[^>]*>([^<]*)<\/a>/) || [])[1] || '';
  const year = (html.match(/<strong>Year:<\/strong>\s*<a[^>]*>([^<]*)<\/a>/) || [])[1] || '';
  const country = (html.match(/<strong>Country:<\/strong>\s*<span>([^<]*)<\/span>/) || [])[1] || '';
  // Download rows shown on the movie page: "WEB-DL 1080p • 5.2 GB • Telugu"
  const rows = [];
  const rowRe = /movie-download-link-item' id='link-row-\d+'><a href='([^']+)'[^>]*>.*?movie-download-meta'>([^<]*)<\/span>/g;
  let m;
  while ((m = rowRe.exec(html)) !== null && rows.length < 12) {
    rows.push({ link: m[1], meta: decodeEntities(m[2]) });
  }
  return { title: decodeEntities(title), poster, director, year, country, rows };
}

function scrapeEpisodes(html) {
  const eps = [];
  const epRe = /<a class='episode-link' href='([^']+)'[^>]*>\s*<span class='ep-num'>([^<]*)<\/span>.*?<span class='ep-title'>([^<]*)<\/span>/g;
  let m;
  while ((m = epRe.exec(html)) !== null && eps.length < 90) {
    eps.push({ url: m[1], num: String(m[2]).trim(), title: decodeEntities(m[3]) });
  }
  return eps;
}

// ---------- chama link resolution ----------
async function chamaGet(url) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await axios.get(url, { timeout: 120000 });
    } catch (e) {
      lastErr = e;
      const status = e && e.response && e.response.status;
      const transient = (e && e.code === 'ECONNABORTED') || !e.response || (status >= 500 && status < 600);
      if (!transient || attempt === 1) throw e;
      await new Promise(r => setTimeout(r, 1500));
    }
  }
  throw lastErr;
}

async function chamaMovieLinks(pageUrl) {
  const res = await chamaGet(`${CINESUBZ_API_BASE}/cinesubz/details?url=${encodeURIComponent(pageUrl)}`);
  const data = res.data && res.data.data;
  if (!data || !Array.isArray(data.downloads)) return [];
  return data.downloads.map(dl => ({
    quality: dl.quality || '',
    size: (dl.quality || '').match(/[\d.]+\s*[GM]b/i)?.[0] || '',
    language: '',
    link: dl.url || ''
  }));
}

async function chamaEpisodeLinks(episodeUrl) {
  const res = await chamaGet(`${CINESUBZ_API_BASE}/api/episode?url=${encodeURIComponent(episodeUrl)}`);
  const data = res.data && res.data.data;
  if (!data || !Array.isArray(data.download_links)) return [];
  return data.download_links.map(dl => ({
    quality: dl.meta || '',
    size: (dl.meta || '').match(/[\d.]+\s*[GM]b/i)?.[0] || '',
    language: '',
    link: dl.url || ''
  }));
}

function qualityKey(text) {
  const q = String(text || '').toLowerCase();
  if (/1080/.test(q)) return '1080p';
  if (/720/.test(q)) return '720p';
  if (/480/.test(q)) return '480p';
  if (/360/.test(q)) return '360p';
  return q.replace(/[^a-z0-9]/gi, '');
}

function pickLink(links, preferredKey) {
  // Prefer a link whose quality matches, then any non-telegram link.
  const nonTg = (links || []).filter(l => l && l.link && !/t\.me|telegram/i.test(l.link));
  const pool = nonTg.length ? nonTg : (links || []).filter(l => l && l.link);
  if (!pool.length) return null;
  if (preferredKey) {
    const match = pool.find(l => qualityKey(l.quality) === preferredKey);
    if (match) return match;
  }
  return pool[0];
}

// ---------- Send as document ----------
async function sendFileAsDocument(socket, from, downloadUrl, fileName, quotedMsg) {
  // Bypass the chama proxy hop (slow, HEAD/Range-broken) and stream straight
  // from the CDN with the referer it requires. Falls back to the proxy URL
  // when the link isn't a recognized proxy link or the direct CDN fails.
  const resolved = disk.resolveDirectUrl(downloadUrl) || { url: downloadUrl };
  const secureUrl = String(resolved.url).replace('http://', 'https://');
  const referer = resolved.referer;
  const dlHeaders = Object.assign({ 'User-Agent': UA }, referer ? { Referer: referer } : {});
  await disk.ensureUrlSpace(secureUrl, fileName, dlHeaders);
  await disk.withDownloadSlot(async () => {
    const response = await axios({
      method: 'GET',
      url: secureUrl,
      responseType: 'stream',
      headers: dlHeaders,
      timeout: 60000 // a stalled server must not pin the download slot forever
    });
    // See boxhub.js: swallow the unattached stream's 'error' so a mid-flight
    // source reset can't become an uncaughtException and kill the whole
    // process. Baileys surfaces the real error via sendMessage.
    response.data.on('error', () => {});
    const caption = `╭━━〔 ✅ *SUCCESS* 〕━━┈\n│\n│ 🎬 *File:* ${fileName}\n│ 🍿 _Enjoy!_\n│\n╰━━━━━━━━━━━━━━━━━━━━┈`;
    await socket.sendMessage(from, {
      document: { stream: response.data },
      mimetype: 'video/mp4',
      fileName: fileName || 'movie.mp4',
      caption
    }, { quoted: quotedMsg });
  });
}

function safeName(title) {
  return String(title || 'movie').replace(/[^a-zA-Z0-9 ]/g, '').trim().substring(0, 60) || 'movie';
}

async function resolveZtLink(ztUrl) {
  if (!ztUrl || !ztUrl.includes('cinesubz.net/zt-links')) return ztUrl;
  try {
    const res = await axios.get(`${DL_API}?url=${encodeURIComponent(ztUrl)}`, { timeout: 120000 });
    if (res.data.status && res.data.data) {
      const links = res.data.data.download || [];
      const pix = links.find(l => l.url && l.url.includes('pixeldrain'));
      const other = links.find(l => l.url && !l.url.includes('pixeldrain'));
      return (pix || other)?.url || ztUrl;
    }
  } catch (e) { console.error('[.lk] DL API resolve failed:', e.message); }
  return ztUrl;
}

// ---------- Main exported handler ----------
module.exports = async function cinesulkHandler(socket, msg, args, from, sender, isCommand) {
  const myNum = normUser(socket && socket.user && socket.user.id);

  if (isCommand) {
    try {
      await socket.sendMessage(from, { react: { text: '🎬', key: msg.key } });
      const query = args.join(' ').trim();
      if (!query) {
        await socket.sendMessage(from, {
          text: `╭━━〔 🎬 *C I N E S U B Z . L K* 〕━━┈\n│\n│ ❌ *Missing Movie / TV Name*\n│\n│ 💡 *Usage:* .lk <movie or tv name>\n│ 📌 *Example:* .lk pushpa\n│\n╰━━━━━━━━━━━━━━━━━┈`
        }, { quoted: msg });
        return;
      }

      await socket.sendMessage(from, { text: '🔍 _Scraping CineSubz.lk..._' }, { quoted: msg });
      const html = await fetchHtml(`${BASE}/?s=${encodeURIComponent(query)}`);
      const results = scrapeSearch(html);
      if (!results.length) {
        await socket.sendMessage(from, {
          text: `╭━━〔 🎬 *C I N E S U B Z . L K* 〕━━┈\n│\n│ ❌ *No results for "${query}"*\n│ _Try checking the spelling!_\n│\n╰━━━━━━━━━━━━━━━━━┈`
        }, { quoted: msg });
        return;
      }

      userStates.set(sender, {
        step: 'search',
        results,
        timestamp: Date.now(),
        botJid: myNum
      });

      let listText = `╭━━〔 🎞️ *C I N E S U B Z . L K* 〕━━┈\n│ 🔎 _${query}_\n│\n`;
      results.forEach((item, idx) => {
        const icon = item.type === 'tvshows' ? '📺' : '🎬';
        listText += `│ *${idx + 1}.* ${icon} ${item.title.substring(0, 42)}\n`;
        if (item.imdb) listText += `│    ⭐ _${item.imdb}_\n`;
        listText += `│\n`;
      });
      listText += `├━━━━━━━━━━━━━━━━━┈\n│ 💡 *Reply with a number (1-${results.length})*\n╰━━━━━━━━━━━━━━━━━━┈`;

      const firstPoster = results[0] && results[0].thumb;
      if (firstPoster) {
        try {
          const imgRes = await axios.get(firstPoster, { responseType: 'arraybuffer', timeout: 20000 });
          await socket.sendMessage(from, { image: Buffer.from(imgRes.data), caption: listText }, { quoted: msg });
        } catch {
          await socket.sendMessage(from, { text: listText }, { quoted: msg });
        }
      } else {
        await socket.sendMessage(from, { text: listText }, { quoted: msg });
      }
    } catch (error) {
      console.error('CineSubz.lk command error:', error);
      await socket.sendMessage(from, { text: `❌ *System Error:* _${error.message}_` }, { quoted: msg });
    }
    return;
  }

  // ---------- Reply handling ----------
  const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
  const trimmed = String(text || '').trim();
  const state = userStates.get(sender);
  if (!state) return;

  // Multi-bot ownership: only the bot that created the session processes it.
  if (state.botJid && myNum && state.botJid !== myNum) return;
  if (Date.now() - state.timestamp > SESSION_TTL) { userStates.delete(sender); return; }

  const num = parseInt(trimmed, 10);
  if (isNaN(num)) return;

  // ---------------- SEARCH → details / episodes ----------------
  if (state.step === 'search') {
    if (num < 1 || num > state.results.length) {
      await socket.sendMessage(from, { text: `⚠️ *Wrong Number!* 🎯 _01 - ${state.results.length}_` }, { quoted: msg });
      return;
    }
    const selected = state.results[num - 1];
    state.selected = selected;
    state.timestamp = Date.now();

    try {
      await socket.sendMessage(from, { text: `⏳ _Loading ${selected.type === 'tvshows' ? 'TV series' : 'movie'}..._` }, { quoted: msg });
      const html = await fetchHtml(selected.url);

      // ---------- TV SHOW → episode list (scraped from the page) ----------
      if (selected.type === 'tvshows') {
        const episodes = scrapeEpisodes(html);
        if (!episodes.length) {
          await socket.sendMessage(from, { text: `❌ *No episodes found* for _${selected.title}_` }, { quoted: msg });
          userStates.delete(sender);
          return;
        }
        state.episodes = episodes;
        state.step = 'episodes';
        state.timestamp = Date.now();
        userStates.set(sender, state);

        let epText = `╭━━〔 📺 *EPISODES* 〕━━┈\n│ ${selected.title.substring(0, 40)}\n│ 📊 _${episodes.length} episodes_\n│\n`;
        episodes.forEach((ep, i) => {
          epText += `│ *${i + 1}.* S${String(ep.num).padStart(2, '0')} - ${ep.title.substring(0, 30)}\n`;
        });
        epText += `│\n├━━━━━━━━━━━━━━━━┈\n│ 💡 *Reply with a number (1-${episodes.length})*\n╰━━━━━━━━━━━━━━━━━━┈`;
        await socket.sendMessage(from, { text: epText }, { quoted: msg });
        return;
      }

      // ---------- MOVIE → details + quality menu ----------
      const movie = scrapeMovie(html);
      const title = movie.title || selected.title;

      // Quality menu: prefer the site's own rows; fall back to chama.
      let qualities = movie.rows.map(r => r.meta);
      let chamaFallback = [];
      if (!qualities.length) {
        try { chamaFallback = await chamaMovieLinks(selected.url); } catch (e) { /* ignore */ }
        qualities = chamaFallback.map(d => `${d.quality || '?'} • ${d.size || '?'} ${d.language ? '• ' + d.language : ''}`.trim());
      }

      let infoMsg = `╭━━〔 🎬 *MOVIE* 〕━━┈\n│ 🎞️ ${title.substring(0, 45)}\n`;
      if (movie.director) infoMsg += `│ 🎥 ${movie.director}\n`;
      if (movie.year) infoMsg += `│ 📅 ${movie.year}\n`;
      if (movie.country) infoMsg += `│ 🌍 ${movie.country}\n`;
      infoMsg += `│\n├━━━━━━━━━━━━━━━━┈\n│ 📥 *Available Qualities:*\n`;
      if (!qualities.length) {
        infoMsg += `│ ❌ _No download links found_\n╰━━━━━━━━━━━━━━━━┈`;
        await socket.sendMessage(from, { text: infoMsg }, { quoted: msg });
        userStates.delete(sender);
        return;
      }
      qualities.forEach((q, i) => { infoMsg += `│ *${i + 1}.* ${q.substring(0, 45)}\n`; });
      infoMsg += `│\n├━━━━━━━━━━━━━━━━┈\n│ 💡 *Reply with a number (1-${qualities.length})*\n╰━━━━━━━━━━━━━━━━━━┈`;

      state.movie = movie;
      state.chamaFallback = chamaFallback;
      state.step = 'quality';
      state.timestamp = Date.now();
      userStates.set(sender, state);

      if (movie.poster) {
        try {
          const imgRes = await axios.get(movie.poster, { responseType: 'arraybuffer', timeout: 20000 });
          await socket.sendMessage(from, { image: Buffer.from(imgRes.data), caption: infoMsg }, { quoted: msg });
        } catch {
          await socket.sendMessage(from, { text: infoMsg }, { quoted: msg });
        }
      } else {
        await socket.sendMessage(from, { text: infoMsg }, { quoted: msg });
      }
    } catch (error) {
      console.error('CineSubz.lk details error:', error);
      await socket.sendMessage(from, { text: `❌ *Failed to load details:* _${error.message}_` }, { quoted: msg });
      userStates.delete(sender);
    }
    return;
  }

  // ---------------- MOVIE QUALITY → download ----------------
  if (state.step === 'quality') {
    const total = state.movie.rows.length || state.chamaFallback.length || 0;
    if (num < 1 || num > total) {
      await socket.sendMessage(from, { text: `⚠️ *Wrong Number!* 🎯 _01 - ${total}_` }, { quoted: msg });
      return;
    }
    const title = state.movie.title || state.selected.title;
    const fileName = `${safeName(title)}_${num}.mp4`;
    await socket.sendMessage(from, { text: `🚀 *${fileName}*\n⏳ _Resolving download link..._` }, { quoted: msg });

    try {
      let links = [];
      try { links = await chamaMovieLinks(state.selected.url); } catch (e) { console.error('[.lk] chama infodl failed:', e.message); }

      // Preferred quality from the site's own row metadata (if present).
      let preferredKey = '';
      const row = state.movie.rows[num - 1];
      if (row) {
        const qm = String(row.meta).match(/(1080|720|480|360)/i);
        preferredKey = qm ? qm[1] + 'p' : '';
      } else if (state.chamaFallback[num - 1]) {
        preferredKey = qualityKey(state.chamaFallback[num - 1].quality);
      }

      const chosen = pickLink(links, preferredKey);
      if (!chosen) {
        await socket.sendMessage(from, { text: `❌ *No working download link found* for this quality.\n_Try another quality or use .cinesubz._` }, { quoted: msg });
        return;
      }
      userStates.delete(sender);
      const resolvedUrl = await resolveZtLink(chosen.link);
      await sendFileAsDocument(socket, from, resolvedUrl, fileName, msg);
    } catch (error) {
      console.error('CineSubz.lk download error:', error);
      let reason = error.message;
      if (error.response?.status === 404) reason = '404 — the provider removed this link.';
      await socket.sendMessage(from, { text: `❌ *Download failed:* _${reason}_` }, { quoted: msg });
    }
    return;
  }

  // ---------------- EPISODE → download ----------------
  if (state.step === 'episodes') {
    if (num < 1 || num > state.episodes.length) {
      await socket.sendMessage(from, { text: `⚠️ *Wrong Number!* 🎯 _01 - ${state.episodes.length}_` }, { quoted: msg });
      return;
    }
    const ep = state.episodes[num - 1];
    const title = state.selected.title;
    const fileName = `${safeName(title)}_${String(ep.num).padStart(2, '0')}.mp4`;
    await socket.sendMessage(from, { text: `📥 _Downloading ${title.substring(0, 30)} - Ep ${ep.num}..._` }, { quoted: msg });

    try {
      const links = await chamaEpisodeLinks(ep.url);
      const chosen = pickLink(links);
      if (!chosen) {
        await socket.sendMessage(from, { text: `❌ *No download link found* for this episode.` }, { quoted: msg });
        return;
      }
      userStates.delete(sender);
      const resolvedUrl = await resolveZtLink(chosen.link);
      await sendFileAsDocument(socket, from, resolvedUrl, fileName, msg);
    } catch (error) {
      console.error('CineSubz.lk episode error:', error);
      let reason = error.message;
      if (error.response?.status === 404) reason = '404 — the provider removed this episode.';
      await socket.sendMessage(from, { text: `❌ *Episode download failed:* _${reason}_` }, { quoted: msg });
    }
    return;
  }
};

module.exports.isActive = (sender) => userStates.has(sender);

module.exports.clear = (sender) => userStates.delete(sender);

// plugins/boxhub.js — .boxhub / .bh : movies & TV shows with BOTH direct
// downloads and stream links.
//
// Two backends are combined:
//   1. Search & details:  MovieBox API (api.silvatech.co.ke, @SilvaTechB) —
//      TMDB-backed, covers movies/TV in every language. Its /stream and
//      /download endpoints only return player EMBED links (vidsrc, 2embed,
//      ...), not direct files, so we pair it with:
//   2. Direct downloads:  chama-movie-api (the same backend .moviebox uses)
//      scrapes themoviebox.xyz and returns DIRECT mp4 links (quality + size).
//      The picked title is matched by normalized name + year.
//
// Movie flow:   .boxhub <name> → search → pick → details menu (direct
//               download qualities + stream servers) → pick → file or link.
// TV flow:      .boxhub tv <name> → search → pick → seasons + stream
//               servers menu → pick season → episode list → pick episode →
//               quality menu (or direct send) → file sent to chat.
//   • .boxhub trending    → this week's trending movies
//   • .boxhub popular     → popular movies right now
const axios = require('axios');
const disk = require('./disk');

// ---------- API constants ----------
const API_BASE = 'https://api.silvatech.co.ke/movie/moviebox';
const CHAMA_API_BASE = 'https://chama-movie-api.koyeb.app';
const CHAMA_API_KEY = 'chama_api_548ca4b34cb9a9b339b00ef8e329a204';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const SESSION_TTL = 10 * 60 * 1000;
// 3GB download cap — matches config.MOVIE_MAX_SIZE_MB. Files above this are
// not offered at all, so a huge link can never stall the temp disk / upload
// slot and make the bot feel frozen.
const MAX_DOWNLOAD_MB = 3072;

// ---------- User state store ----------
const userStates = new Map();

// ---------- silvatech API helpers ----------
async function apiGet(path) {
    const res = await axios.get(`${API_BASE}${path}`, {
        timeout: 30000,
        headers: { 'User-Agent': UA }
    });
    if (!res.data || res.data.status !== true) throw new Error('MovieBox API error');
    return res.data.result;
}

async function searchApi(query, type) {
    const result = await apiGet(`/search?q=${encodeURIComponent(query)}&type=${type}&page=1`);
    return (result && result.results) || [];
}

async function detailsApi(id) {
    return await apiGet(`/details?id=${encodeURIComponent(id)}`);
}

async function streamApi(id) {
    return await apiGet(`/stream?id=${encodeURIComponent(id)}`);
}

async function trendingApi(time, type) {
    const result = await apiGet(`/trending?time=${encodeURIComponent(time)}&type=${encodeURIComponent(type)}`);
    return (result && result.results) || [];
}

async function homepageApi() {
    const result = await apiGet('/homepage');
    return (result && result.popular) || [];
}

// ---------- chama (direct download) helpers ----------
async function chamaGet(url) {
    let lastErr;
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            return await axios.get(url, { timeout: 90000 });
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

async function chamaSearch(query) {
    const res = await chamaGet(`${CHAMA_API_BASE}/api/v1/movie/moviebox/search?q=${encodeURIComponent(query)}&api_key=${CHAMA_API_KEY}`);
    const d = res.data;
    if (!d || d.status !== true || !Array.isArray(d.data)) return [];
    return d.data;
}

async function chamaMovieDownloads(link) {
    const res = await chamaGet(`${CHAMA_API_BASE}/api/v1/movie/moviebox/info?q=${encodeURIComponent(link)}&api_key=${CHAMA_API_KEY}`);
    const data = res.data && res.data.data;
    if (!data || !Array.isArray(data.downloads)) return [];
    return data.downloads.filter(x => x && (x.link || x.url));
}

async function chamaTvInfo(link) {
    const res = await chamaGet(`${CHAMA_API_BASE}/api/v1/movie/moviebox/tv/info?q=${encodeURIComponent(link)}&api_key=${CHAMA_API_KEY}`);
    const d = res.data;
    if (!d || d.status !== true || !d.data) return null;
    return d.data;
}

async function chamaTvEpLinks(link, season, episode) {
    const res = await chamaGet(`${CHAMA_API_BASE}/api/v1/movie/moviebox/tv/dl?q=${encodeURIComponent(link)}&se=${season}&ep=${episode}&api_key=${CHAMA_API_KEY}`);
    const d = res.data;
    if (!d || d.status !== true || !Array.isArray(d.data)) return [];
    return d.data.filter(x => x && (x.link || x.url));
}

// ---------- Title matching (silvatech result → chama result) ----------
function normTitle(t) {
    return String(t || '')
        .toLowerCase()
        .replace(/\[[^\]]*\]/g, ' ')
        .replace(/[^a-z0-9 ]/g, ' ')
        .replace(/\b(the|a|an)\b/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

// Match a movie: normalized title equality (or strong containment) + year.
// Returns null when nothing matches well enough (no download offered).
function matchChamaMovieItem(silvaTitle, silvaYear, chamaItems) {
    const nt = normTitle(silvaTitle);
    let best = null;
    let bestScore = 0;
    for (const item of chamaItems || []) {
        if (String(item.type || '').toLowerCase() !== 'movies') continue;
        const it = normTitle(item.title);
        let score = 0;
        if (it === nt) score += 2;
        else if (it.includes(nt) || nt.includes(it)) score += 1;
        if (score > 0 && String(item.year || '') === String(silvaYear || '')) score += 1;
        if (score > bestScore) { bestScore = score; best = item; }
    }
    return bestScore >= 2 ? best : null;
}

// Match a TV show: chama returns one item PER SEASON (e.g. "Breaking Bad S1")
// but they all share the same series link, so containment is enough.
function matchChamaTvItem(silvaTitle, silvaYear, chamaItems) {
    const nt = normTitle(silvaTitle);
    let best = null;
    let bestScore = 0;
    for (const item of chamaItems || []) {
        if (String(item.type || '').toLowerCase() !== 'tvshows') continue;
        const it = normTitle(item.title);
        let score = 0;
        if (it === nt) score += 3;
        else if (it.includes(nt) || nt.includes(it)) score += 2;
        if (score > 0 && String(item.year || '') === String(silvaYear || '')) score += 1;
        if (score > bestScore) { bestScore = score; best = item; }
    }
    return bestScore >= 2 ? best : null;
}

// ---------- Small helpers ----------
function botNumber(socket) {
    return String((socket && socket.user && socket.user.id) || '').split(':')[0].split('@')[0] || '';
}

function truncate(s, n) {
    const str = String(s || '');
    return str.length > n ? str.substring(0, n - 1) + '…' : str;
}

function formatDuration(mins) {
    if (!mins) return 'N/A';
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return h ? `${h}h ${m}m` : `${m}m`;
}

function resultId(item) {
    return item.imdbId || item.id;
}

// silvatech's details/stream endpoints always resolve numeric ids against
// TMDB's MOVIE id space, so a TV show whose id collides with a movie id
// resolves to the wrong title (e.g. tv 1396 = Breaking Bad → "Mirror").
// Verify the resolved title against the one the user picked; on mismatch we
// fall back to the search-result fields + chama (title-based) downloads.
function titlesMatch(a, b) {
    const na = normTitle(a);
    const nb = normTitle(b);
    if (!na || !nb) return true;
    return na === nb || na.includes(nb) || nb.includes(na);
}

function safeName(title) {
    return String(title || 'movie').replace(/[^a-zA-Z0-9 ]/g, '').trim().substring(0, 50) || 'movie';
}

function dlSizeMb(dl) {
    const size = String(dl.size || '');
    const sm = size.match(/([\d.]+)\s*(GB|MB|KB)/i);
    if (!sm) return 0;
    const v = parseFloat(sm[1]);
    const unit = sm[2].toUpperCase();
    return unit === 'GB' ? v * 1024 : unit === 'MB' ? v : v / 1024;
}

// Skip subtitle entries (quality "SUB" / tiny file) AND anything above the
// 3GB download cap.
function isOfferedDownload(dl) {
    const q = String(dl.quality || dl.title || '').trim();
    if (/^sub\b/i.test(q)) return false;
    const mb = dlSizeMb(dl);
    if (mb > 0 && mb < 5) return false; // subtitles / tiny files
    if (mb > MAX_DOWNLOAD_MB) return false; // above the 3GB cap
    return true;
}

function absUrl(u) {
    return String(u).startsWith('http') ? u : `${CHAMA_API_BASE}${u}`;
}

// Fetch stream servers for an id (silvatech), falling back to /download.
async function fetchStreamSources(streamId) {
    try {
        const stream = await streamApi(streamId);
        let sources = (stream && stream.sources) || [];
        if (!sources.length) {
            const dl = await apiGet(`/download?id=${encodeURIComponent(streamId)}`);
            sources = (dl && dl.embedSources) || [];
        }
        return sources || [];
    } catch (e) {
        console.error('[boxhub] stream lookup failed:', e.message);
        return [];
    }
}

// ---------- Message builders ----------
function buildSearchList(results, query, typeLabel) {
    let text = `╭━━〔 🎬 *B O X H U B* 〕━━┈\n│ 🔎 _${truncate(query, 30)}_ — ${typeLabel}\n│ 📊 _${results.length} results_\n│\n`;
    results.forEach((item, idx) => {
        text += `│ *${idx + 1}.* ${truncate(item.title, 42)}\n`;
        text += `│    📅 ${item.year || 'N/A'}  ${item.rating ? '⭐ ' + item.rating : ''}\n│\n`;
    });
    text += `├━━━━━━━━━━━━━━━━━┈\n│ 💡 *Reply with a number (1-${results.length})*\n│ _to see downloads & streams_\n╰━━━━━━━━━━━━━━━━━━┈`;
    return text;
}

function detailsHeader(details) {
    let text = `╭━━〔 🎬 *B O X H U B* 〕━━┈\n│ 🎞️ *${truncate(details.title, 40)}*\n`;
    if (details.year) text += `│ 📅 ${details.year}\n`;
    if (details.rating) text += `│ ⭐ ${details.rating} (${details.votes || '?'} votes)\n`;
    if (details.runtime) text += `│ ⏱️ ${formatDuration(details.runtime)}\n`;
    if (details.genres && details.genres.length) text += `│ 🏷️ ${details.genres.slice(0, 3).join(', ')}\n`;
    if (details.overview) text += `│ 📝 ${truncate(details.overview, 120)}\n`;
    return text;
}

// Combined movie menu: direct-download qualities first, then stream servers.
function buildOptionsMenu(details, options) {
    let text = detailsHeader(details) + `│\n`;
    const downloads = options.filter(o => o.kind === 'download');
    const streams = options.filter(o => o.kind === 'stream');
    let num = 1;
    if (downloads.length) {
        text += `├━━━━━━━━━━━━━━━━━┈\n│ 📥 *Direct Download:*\n`;
        downloads.forEach(o => {
            text += `│ *${num}.* 💾 ${truncate(o.label, 40)}\n`;
            num++;
        });
    }
    if (streams.length) {
        text += `├━━━━━━━━━━━━━━━━━┈\n│ 📺 *Stream (open in browser):*\n`;
        streams.forEach(o => {
            text += `│ *${num}.* ${truncate(o.label, 40)}\n`;
            num++;
        });
    }
    text += `│\n├━━━━━━━━━━━━━━━━━┈\n│ 💡 *Reply with a number (1-${options.length})*\n╰━━━━━━━━━━━━━━━━━━┈`;
    return text;
}

// TV menu: seasons (episode downloads) first, then stream servers.
function buildTvMenu(details, seasons, streams) {
    let text = detailsHeader(details) + `│\n`;
    let num = 1;
    if (seasons.length) {
        text += `├━━━━━━━━━━━━━━━━━┈\n│ 📥 *Episodes (download):*\n`;
        seasons.forEach(s => {
            text += `│ *${num}.* 📺 Season ${s.season} (${s.episodes.length} eps)\n`;
            num++;
        });
    }
    if (streams.length) {
        text += `├━━━━━━━━━━━━━━━━━┈\n│ 📺 *Stream (open in browser):*\n`;
        streams.forEach(o => {
            text += `│ *${num}.* ${truncate(o.label, 40)}\n`;
            num++;
        });
    }
    text += `│\n├━━━━━━━━━━━━━━━━━┈\n│ 💡 *Reply with a number (1-${num - 1})*\n╰━━━━━━━━━━━━━━━━━━┈`;
    return text;
}

function buildEpisodesMenu(details, season) {
    let text = `╭━━〔 🎬 *B O X H U B* 〕━━┈\n│ 🎞️ *${truncate(details.title, 35)}* — Season ${season.season}\n│ 📊 _${season.episodes.length} episodes_\n│\n`;
    season.episodes.forEach((ep, i) => {
        text += `│ *${i + 1}.* 📺 Episode ${ep}\n`;
    });
    text += `│\n├━━━━━━━━━━━━━━━━━┈\n│ 💡 *Reply with a number (1-${season.episodes.length})*\n╰━━━━━━━━━━━━━━━━━━┈`;
    return text;
}

function buildEpisodeQualityMenu(details, season, episode, links) {
    let text = `╭━━〔 🎬 *B O X H U B* 〕━━┈\n│ 🎞️ *${truncate(details.title, 35)}* — S${season}E${episode}\n│\n`;
    links.forEach((l, i) => {
        text += `│ *${i + 1}.* 💾 ${truncate(String(l.quality || l.title || 'Download').substring(0, 30), 30)}${l.size ? ' • ' + l.size : ''}\n`;
    });
    text += `│\n├━━━━━━━━━━━━━━━━━┈\n│ 💡 *Reply with a number (1-${links.length})*\n╰━━━━━━━━━━━━━━━━━━┈`;
    return text;
}

function buildLinkMessage(details, source) {
    return `╭━━〔 🎬 *B O X H U B* 〕━━┈\n│\n│ 🎞️ *${truncate(details.title, 40)}*\n│ 📺 Server: *${source.server}* (${source.quality || 'HD'})\n│\n│ 🔗 *Open in browser:*\n│ ${source.embed}\n│\n├━━━━━━━━━━━━━━━━━┈\n│ ⚠️ _This API has no direct file\n│    download for stream servers —\n│    some players (e.g. VidSrc) have\n│    a download button inside them._\n╰━━━━━━━━━━━━━━━━━━┈`;
}

// ---------- Send a direct file as document ----------
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
            timeout: 60000
        });
        // Swallow the stream's own 'error' events. Between axios resolving and
        // baileys attaching its reader (inside sendMessage), a mid-flight
        // source error (ECONNRESET etc.) would otherwise fire on an unattached
        // stream and become an uncaughtException — killing the whole process
        // (and every session) via the process-level handler. Baileys forwards
        // the real error through its own read loop, which our try/catch sees.
        response.data.on('error', () => {});
        const caption = `╭━━〔 ✅ *SUCCESS* 〕━━┈\n│\n│ 🎬 *File:* ${fileName}\n│ 🍿 _Enjoy your movie!_\n│\n╰━━━━━━━━━━━━━━━━━━━━┈`;
        await socket.sendMessage(from, {
            document: { stream: response.data },
            mimetype: 'video/mp4',
            fileName: fileName || 'movie.mp4',
            caption
        }, { quoted: quotedMsg });
    });
}

async function sendDownloading(socket, from, title, label, quotedMsg) {
    await socket.sendMessage(from, {
        text: `╭━〔 🚀 *D O W N L O A D I N G* 〕━┈\n│\n│ 🎬 *${truncate(title, 35)}*\n│ 💾 ${truncate(label, 30)}\n│ ⏳ _Uploading to chat..._\n│\n╰━━━━━━━━━━━━━━━━━━━━┈`
    }, { quoted: quotedMsg });
}

async function sendDownloadError(socket, from, error, quotedMsg) {
    console.error('BoxHub download error:', error);
    let reason = error.message;
    if (error.response?.status === 404) reason = '404 — the provider removed this link.';
    else if (error.response?.status === 403) reason = '403 — the provider blocked the request.';
    await socket.sendMessage(from, {
        text: `╭━〔 ❌ *F A I L E D* 〕━┈\n│\n│ ⚠️ *Download could not be completed.*\n│ 📉 _Reason: ${reason}_\n│\n╰━━━━━━━━━━━━━━━━┈`
    }, { quoted: quotedMsg });
}

// Send the search list as an image (first poster) when possible, else text.
async function sendSearchList(socket, from, msg, results, caption) {
    const poster = results[0] && results[0].poster;
    if (poster) {
        try {
            const imgRes = await axios.get(poster, { responseType: 'arraybuffer', timeout: 20000 });
            await socket.sendMessage(from, { image: Buffer.from(imgRes.data), caption }, { quoted: msg });
            return;
        } catch { /* fall through to text */ }
    }
    await socket.sendMessage(from, { text: caption }, { quoted: msg });
}

// Send a caption with the poster image when available.
async function sendWithPoster(socket, from, msg, poster, caption) {
    if (poster) {
        try {
            const imgRes = await axios.get(poster, { responseType: 'arraybuffer', timeout: 20000 });
            await socket.sendMessage(from, { image: Buffer.from(imgRes.data), caption }, { quoted: msg });
            return;
        } catch { /* fall through to text */ }
    }
    await socket.sendMessage(from, { text: caption }, { quoted: msg });
}

// ---------- Movie selection (search step → options menu) ----------
async function handleMovieSelection(socket, from, msg, sender, state, selected, details, streamId) {
    const options = [];

    // ----- Direct downloads: chama moviebox backend -----
    try {
        const chamaItems = await chamaSearch(details.title);
        const match = matchChamaMovieItem(details.title, details.year || selected.year, chamaItems);
        if (match) {
            const downloads = await chamaMovieDownloads(match.link);
            for (const dl of downloads) {
                if (options.filter(o => o.kind === 'download').length >= 6) break;
                const dlUrl = dl.link || dl.url;
                if (!dlUrl || !isOfferedDownload(dl)) continue;
                const q = String(dl.quality || 'Download').trim();
                const size = String(dl.size || '');
                options.push({
                    kind: 'download',
                    label: `${q.substring(0, 30)}${size ? ' • ' + size : ''}`.trim(),
                    link: absUrl(dlUrl),
                    fileName: `${safeName(details.title)}_${q.replace(/[^a-zA-Z0-9]/g, '').substring(0, 12) || 'download'}.mp4`
                });
            }
        }
    } catch (e) {
        console.error('[boxhub] chama download lookup failed:', e.message);
    }

        // ----- Stream servers: silvatech API (only when the id resolved right) -----
    if (streamId) {
        const sources = await fetchStreamSources(streamId);
        for (const s of sources) {
            options.push({
                kind: 'stream',
                label: `${s.server} (${s.quality || 'HD'})`,
                embed: s.embed,
                server: s.server,
                quality: s.quality || 'HD'
            });
        }
    }

    if (!options.length) {
        await socket.sendMessage(from, {
            text: `╭━━〔 ⚠️ *U N A V A I L A B L E* 〕━━┈\n│\n│ ❌ *No links found for:*\n│ _${truncate(details.title, 35)}_\n│\n╰━━━━━━━━━━━━━━━━┈`
        }, { quoted: msg });
        userStates.delete(sender);
        return;
    }

    state.details = details;
    state.options = options;
    state.step = 'option';
    state.timestamp = Date.now();
    userStates.set(sender, state);

    await sendWithPoster(socket, from, msg, details.poster, buildOptionsMenu(details, options));
}

// ---------- TV selection (search step → seasons + streams menu) ----------
async function handleTvSelection(socket, from, msg, sender, state, selected, details, streamId) {
    // Stream servers only when the silvatech id resolved to the right title.
    let streams = [];
    if (streamId) {
        const sources = await fetchStreamSources(streamId);
        streams = sources.map(s => ({
            kind: 'stream',
            label: `${s.server} (${s.quality || 'HD'})`,
            embed: s.embed,
            server: s.server,
            quality: s.quality || 'HD'
        }));
    }

    // ----- Seasons: chama moviebox TV backend -----
    let seasons = [];
    try {
        const chamaItems = await chamaSearch(details.title);
        const match = matchChamaTvItem(details.title, details.year || selected.year, chamaItems);
        if (match) {
            const tvInfo = await chamaTvInfo(match.link);
            if (tvInfo && Array.isArray(tvInfo.seasons)) {
                seasons = tvInfo.seasons.filter(s => s && Array.isArray(s.episodes) && s.episodes.length);
                state.chamaLink = match.link;
            }
        }
    } catch (e) {
        console.error('[boxhub] tv info lookup failed:', e.message);
    }

    if (!seasons.length && !streams.length) {
        await socket.sendMessage(from, {
            text: `╭━━〔 ⚠️ *U N A V A I L A B L E* 〕━━┈\n│\n│ ❌ *No episodes or streams found for:*\n│ _${truncate(details.title, 35)}_\n│\n╰━━━━━━━━━━━━━━━━┈`
        }, { quoted: msg });
        userStates.delete(sender);
        return;
    }

    state.details = details;
    state.seasons = seasons;
    state.sources = streams;
    state.step = 'tvmenu';
    state.timestamp = Date.now();
    userStates.set(sender, state);

    await sendWithPoster(socket, from, msg, details.poster, buildTvMenu(details, seasons, streams));
}

// ---------- Main exported handler ----------
module.exports = async function boxhubHandler(socket, msg, args, from, sender, isCommand) {
    if (isCommand) {
        try {
            await socket.sendMessage(from, { react: { text: '🎬', key: msg.key } });
            const raw = (args || []).join(' ').trim();
            const first = (args || [])[0] || '';

            // ----- no args: usage -----
            if (!raw) {
                await socket.sendMessage(from, {
                    text: `╭━━〔 🎬 *B O X H U B* 〕━━┈\n│\n│ ❌ *Missing movie / TV name*\n│\n│ 💡 *Usage:*\n│ • .boxhub <name>       _movie search_\n│ • .boxhub tv <name>    _TV search_\n│ • .boxhub trending     _trending movies_\n│ • .boxhub popular      _popular movies_\n│ 📌 *Example:* .boxhub avengers\n│\n╰━━━━━━━━━━━━━━━━━┈`
                }, { quoted: msg });
                return;
            }

            // ----- trending / popular: no-name list flows -----
            if (first.toLowerCase() === 'trending' || first.toLowerCase() === 'popular') {
                await socket.sendMessage(from, { text: '🔍 _Fetching the list..._' }, { quoted: msg });
                let items = [];
                let label = 'Trending';
                if (first.toLowerCase() === 'trending') {
                    items = await trendingApi('week', 'movie');
                } else {
                    items = await homepageApi();
                }
                if (!items.length) {
                    await socket.sendMessage(from, { text: '❌ *No results.* Try again later.' }, { quoted: msg });
                    return;
                }
                const top = items.slice(0, 10);
                userStates.set(sender, {
                    step: 'search',
                    results: top,
                    query: label,
                    type: 'movie',
                    timestamp: Date.now(),
                    botJid: botNumber(socket)
                });
                await sendSearchList(socket, from, msg, top, buildSearchList(top, label, label));
                return;
            }

            // ----- tv subcommand -----
            let type = 'movie';
            let query = raw;
            if (first.toLowerCase() === 'tv') {
                type = 'tv';
                query = raw.split(/\s+/).slice(1).join(' ').trim();
                if (!query) {
                    await socket.sendMessage(from, {
                        text: `╭━━〔 🎬 *B O X H U B* 〕━━┈\n│\n│ ❌ *Missing TV show name*\n│\n│ 💡 *Usage:* .boxhub tv <name>\n│ 📌 *Example:* .boxhub tv breaking bad\n│\n╰━━━━━━━━━━━━━━━━━┈`
                    }, { quoted: msg });
                    return;
                }
            }

            await socket.sendMessage(from, { text: '🔍 _Searching BoxHub..._' }, { quoted: msg });
            const results = await searchApi(query, type);
            if (!results.length) {
                await socket.sendMessage(from, {
                    text: `╭━━〔 🎬 *B O X H U B* 〕━━┈\n│\n│ ❌ *No results for "${truncate(query, 30)}"*\n│ _Try checking the spelling!_\n│\n╰━━━━━━━━━━━━━━━━━┈`
                }, { quoted: msg });
                return;
            }

            const top = results.slice(0, 10);
            userStates.set(sender, {
                step: 'search',
                results: top,
                query: query,
                type: type,
                timestamp: Date.now(),
                botJid: botNumber(socket)
            });
            await sendSearchList(socket, from, msg, top, buildSearchList(top, query, type === 'tv' ? '📺 TV' : '🎬 Movie'));
        } catch (error) {
            console.error('BoxHub command error:', error);
            await socket.sendMessage(from, { text: `❌ *System Error:* _${error.message}_` }, { quoted: msg });
        }
        return;
    }

    // ---------- Reply handling ----------
    const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
    const trimmed = String(text || '').trim();
    const state = userStates.get(sender);
    if (!state) return;

    // Multi-bot ownership: the session belongs to the bot that created it.
    const myNum = botNumber(socket);
    if (state.botJid && myNum && state.botJid !== myNum) return;
    if (Date.now() - state.timestamp > SESSION_TTL) { userStates.delete(sender); return; }

    const num = parseInt(trimmed, 10);
    if (isNaN(num)) return;

    // ---------------- SEARCH → details + menu ----------------
    if (state.step === 'search') {
        if (num < 1 || num > state.results.length) return;

        const selected = state.results[num - 1];
        state.selected = selected;
        userStates.set(sender, state);

        await socket.sendMessage(from, {
            text: `⏳ _Loading ${truncate(selected.title, 30)}..._`
        }, { quoted: msg });

        try {
            // Details accepts both the imdb and tmdb id. Verify the resolved
            // title matches what the user picked — silvatech's numeric-id
            // lookup is wrong for some TV shows (see titlesMatch).
            const details = await detailsApi(resultId(selected));
            let effectiveDetails = details;
            let streamId = details.imdbId || selected.imdbId || selected.id;
            if (!titlesMatch(details.title, selected.title)) {
                console.warn('[boxhub] silvatech details mismatch:', details.title, '!=', selected.title);
                effectiveDetails = {
                    title: selected.title,
                    year: selected.year,
                    rating: selected.rating,
                    poster: selected.poster,
                    overview: selected.overview
                };
                streamId = null;
            }

            if (state.type === 'tv') {
                await handleTvSelection(socket, from, msg, sender, state, selected, effectiveDetails, streamId);
            } else {
                await handleMovieSelection(socket, from, msg, sender, state, selected, effectiveDetails, streamId);
            }
        } catch (error) {
            console.error('BoxHub details error:', error);
            await socket.sendMessage(from, {
                text: `❌ *Failed to load details:* _${error.message}_`
            }, { quoted: msg });
            userStates.delete(sender);
        }
        return;
    }

    // ---------------- TV MENU → season or stream ----------------
    if (state.step === 'tvmenu') {
        const total = state.seasons.length + state.sources.length;
        if (num < 1 || num > total) return;

        if (num <= state.seasons.length) {
            const season = state.seasons[num - 1];
            state.season = season;
            state.step = 'episodes';
            state.timestamp = Date.now();
            userStates.set(sender, state);
            await socket.sendMessage(from, {
                text: buildEpisodesMenu(state.details, season)
            }, { quoted: msg });
            return;
        }

        const opt = state.sources[num - state.seasons.length - 1];
        userStates.delete(sender);
        await socket.sendMessage(from, {
            text: buildLinkMessage(state.details, opt)
        }, { quoted: msg });
        return;
    }

    // ---------------- EPISODES → pick episode ----------------
    if (state.step === 'episodes') {
        const eps = state.season.episodes;
        if (num < 1 || num > eps.length) return;
        const ep = eps[num - 1];
        state.episode = ep;
        state.timestamp = Date.now();
        userStates.set(sender, state);

        await socket.sendMessage(from, {
            text: `⏳ _Fetching S${state.season.season}E${ep} links..._`
        }, { quoted: msg });

        try {
            const links = await chamaTvEpLinks(state.chamaLink, state.season.season, ep);
            const videos = links.filter(isOfferedDownload);
            if (!videos.length) {
                await socket.sendMessage(from, {
                    text: `❌ *No video link found* for S${state.season.season}E${ep}.`
                }, { quoted: msg });
                userStates.delete(sender);
                return;
            }

            const title = state.details.title;
            const fileName = `${safeName(title)}_S${state.season.season}E${ep}.mp4`;

            if (videos.length === 1) {
                // Single quality → download immediately.
                userStates.delete(sender);
                await sendDownloading(socket, from, title, `${videos[0].quality || 'Download'} • ${videos[0].size || ''}`.trim(), msg);
                try {
                    await sendFileAsDocument(socket, from, absUrl(videos[0].link || videos[0].url), fileName, msg);
                } catch (e) {
                    await sendDownloadError(socket, from, e, msg);
                }
                return;
            }

            state.epLinks = videos;
            state.step = 'epdl';
            state.timestamp = Date.now();
            userStates.set(sender, state);
            await socket.sendMessage(from, {
                text: buildEpisodeQualityMenu(state.details, state.season.season, ep, videos)
            }, { quoted: msg });
        } catch (error) {
            console.error('BoxHub episode links error:', error);
            await socket.sendMessage(from, {
                text: `❌ *Failed to get episode links:* _${error.message}_`
            }, { quoted: msg });
            userStates.delete(sender);
        }
        return;
    }

    // ---------------- EPISODE QUALITY → download file ----------------
    if (state.step === 'epdl') {
        if (num < 1 || num > state.epLinks.length) return;
        const v = state.epLinks[num - 1];
        const title = state.details.title;
        const fileName = `${safeName(title)}_S${state.season.season}E${state.episode}.mp4`;
        userStates.delete(sender);

        await sendDownloading(socket, from, title, `${v.quality || 'Download'} • ${v.size || ''}`.trim(), msg);
        try {
            await sendFileAsDocument(socket, from, absUrl(v.link || v.url), fileName, msg);
        } catch (e) {
            await sendDownloadError(socket, from, e, msg);
        }
        return;
    }

    // ---------------- MOVIE OPTION → download file or send stream link ----------------
    if (state.step === 'option') {
        if (num < 1 || num > state.options.length) return;
        const opt = state.options[num - 1];
        userStates.delete(sender);

        if (opt.kind === 'download') {
            await sendDownloading(socket, from, state.details.title, opt.label, msg);
            try {
                await sendFileAsDocument(socket, from, opt.link, opt.fileName, msg);
            } catch (e) {
                await sendDownloadError(socket, from, e, msg);
            }
            return;
        }

        await socket.sendMessage(from, {
            text: buildLinkMessage(state.details, opt)
        }, { quoted: msg });
        return;
    }
};

module.exports.isActive = (sender) => userStates.has(sender);

module.exports.clear = (sender) => userStates.delete(sender);

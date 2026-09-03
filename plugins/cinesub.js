// plugins/cinesub.js
const axios = require('axios');
const disk = require('./disk');

// ---------- API constants ----------
const SEARCH_API = 'https://apis.laksidu.site/cinesubz/search';
const DETAILS_API = 'https://apis.laksidu.site/cinesubz/details';
const DL_API = 'https://apis.laksidu.site/dl/cinesubz';

function normalizeQualityKey(text) {
  const q = String(text || '').toLowerCase();
  if (/1080/.test(q)) return '1080p';
  if (/720/.test(q)) return '720p';
  if (/480/.test(q)) return '480p';
  if (/360/.test(q)) return '360p';
  const clean = q.replace(/[^a-z0-9]/gi, '').trim();
  return clean || 'default';
}

// ---------- User state store ----------
const userStates = new Map();

// ---------- Helpers ----------
async function searchCinesub(query) {
    const url = `${SEARCH_API}?query=${encodeURIComponent(query)}`;
    const res = await axios.get(url, { timeout: 30000 });
    if (!res.data.status) throw new Error('Search API error');
    return (res.data.results || []).map(r => ({
        title: r.title || '',
        url: r.link || '',
        image: r.poster || '',
        year: (r.title || '').match(/\((\d{4})\)/)?.[1] || ''
    }));
}

async function getMovieDetails(pageUrl) {
    const url = `${DETAILS_API}?url=${encodeURIComponent(pageUrl)}`;
    const res = await axios.get(url, { timeout: 120000 });
    if (!res.data.status || !res.data.data) throw new Error('Details API failed');
    const data = res.data.data;
    const downloads = [];
    for (const dl of (data.downloads || [])) {
        if (!dl || !dl.url) continue;
        const key = normalizeQualityKey(dl.quality);
        const sizeMatch = (dl.quality || '').match(/([\d.]+)\s*([GM]b)/i);
        const size = sizeMatch ? sizeMatch[0] : '';
        downloads.push({ key, quality: dl.quality || key, size, ztUrl: dl.url });
    }
    return { title: data.title || '', poster: data.poster || '', downloads };
}

async function resolveZtLinks(ztUrl) {
    const url = `${DL_API}?url=${encodeURIComponent(ztUrl)}`;
    const res = await axios.get(url, { timeout: 120000 });
    if (!res.data.status || !res.data.data) throw new Error('DL API failed');
    const data = res.data.data;
    const links = data.download || [];
    // Prefer pixeldrain links (reliable, no token expiry)
    const pixLinks = links.filter(l => l.url && l.url.includes('pixeldrain'));
    const otherLinks = links.filter(l => l.url && !l.url.includes('pixeldrain'));
    const ordered = [...pixLinks, ...otherLinks];
    if (!ordered.length) throw new Error('No download links found');
    return { title: data.title || '', size: data.size || '', url: ordered[0].url };
}

async function sendFileAsDocument(socket, from, downloadUrl, fileName, quotedMsg) {
    const resolved = disk.resolveDirectUrl(downloadUrl) || { url: downloadUrl };
    const secureUrl = String(resolved.url).replace('http://', 'https://');
    const referer = resolved.referer;
    const dlHeaders = Object.assign({
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
    }, referer ? { Referer: referer } : {});
    await disk.ensureUrlSpace(secureUrl, fileName, dlHeaders);

    await disk.withDownloadSlot(async () => {
        const response = await axios({
            method: 'GET',
            url: secureUrl,
            responseType: 'stream',
            headers: dlHeaders,
            timeout: 120000
        });
        response.data.on('error', () => {});

        const caption = `╭━━〔 ✅ *SUCCESS* 〕━━┈
│ 
│ 🎬 *File:* ${fileName}
│ 🍿 _Enjoy your movie!_
│
╰━━━━━━━━━━━━━━━━━━━━┈`;

        await socket.sendMessage(from, {
            document: { stream: response.data },
            mimetype: 'video/mp4',
            fileName: fileName || 'movie.mp4',
            caption: caption,
        }, { quoted: quotedMsg });
    });
}

// ---------- Main exported handler ----------
module.exports = async function cinesubHandler(socket, msg, args, from, sender, isCommand) {
    if (isCommand) {
        try {
            await socket.sendMessage(from, { react: { text: '🎬', key: msg.key } });
            const query = args.join(' ').trim();
            
            if (!query) {
                await socket.sendMessage(from, {
                    text: `╭━━〔 🎬 *C I N E S U B Z* 〕━━┈\n│\n│ ❌ *Oops! Missing Movie Name*\n│\n│ 💡 *Usage:* .cinesubz <movie_name>\n│ 📌 *Example:* .cinesubz pushpa\n│\n╰━━━━━━━━━━━━━━━━━┈`
                }, { quoted: msg });
                return;
            }
            
            await socket.sendMessage(from, { text: '🔍 _Searching the CineSubz vault..._' }, { quoted: msg });
            const results = await searchCinesub(query);
            
            if (!results.length) {
                await socket.sendMessage(from, { 
                    text: `╭━━〔 🎬 *C I N E S U B Z* 〕━━┈\n│\n│ ❌ *No movies found for "${query}"*\n│ _Try checking the spelling!_\n│\n╰━━━━━━━━━━━━━━━━━┈` 
                }, { quoted: msg });
                return;
            }
            
            userStates.set(sender, {
                step: 'search',
                results,
                timestamp: Date.now(),
                botJid: String((socket && socket.user && socket.user.id) || '').split(':')[0].split('@')[0] || ''
            });
            
            let listText = `╭━━〔 🎞️ *S E A R C H  R E S U L T S* 〕━━┈\n│\n`;
            results.forEach((item, idx) => {
                listText += `│ *${idx + 1}.* ${item.title}\n│ 📅 _Year: ${item.year || 'N/A'}_\n│\n`;
            });
            listText += `├━━━━━━━━━━━━━━━━━┈\n│ 💡 *Reply with a number (1-${results.length})*\n│ _to get the download links!_\n╰━━━━━━━━━━━━━━━━━━┈`;
            
            const firstPoster = results[0]?.image;
            if (firstPoster) {
                try {
                    const imgRes = await axios.get(firstPoster, { responseType: 'arraybuffer' });
                    const imgBuffer = Buffer.from(imgRes.data, 'binary');
                    await socket.sendMessage(from, {
                        image: imgBuffer,
                        caption: listText,
                    }, { quoted: msg });
                } catch {
                    await socket.sendMessage(from, { text: listText }, { quoted: msg });
                }
            } else {
                await socket.sendMessage(from, { text: listText }, { quoted: msg });
            }
        } catch (error) {
            console.error('CineSubz command error:', error);
            await socket.sendMessage(from, { text: `❌ *System Error:* _${error.message}_` }, { quoted: msg });
        }
        return;
    }

    // ---------- Reply handling ----------
    const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
    const trimmed = text.trim();
    const state = userStates.get(sender);
    
    if (!state) return;
    
    const cinesubMyNum = String((socket && socket.user && socket.user.id) || '').split(':')[0].split('@')[0];
    if (state.botJid && cinesubMyNum && state.botJid !== cinesubMyNum) return;
    
    if (Date.now() - state.timestamp > 10 * 60 * 1000) {
        userStates.delete(sender);
        return;
    }

    // ===== STEP 1: Search → pick movie =====
    if (state.step === 'search') {
        const num = parseInt(trimmed, 10);
        if (isNaN(num) || num < 1 || num > state.results.length) return;
        
        const selected = state.results[num - 1];
        state.selectedMovie = selected;
        state.step = 'details';
        userStates.set(sender, state);
        
        await socket.sendMessage(from, { 
            text: `⏳ _Extracting links for_ *${selected.title}*...` 
        }, { quoted: msg });
        
        try {
            const details = await getMovieDetails(selected.url);
            state.downloads = details.downloads || [];
            state.movieTitle = details.title || selected.title;
            state.moviePoster = details.poster || '';
            state.step = 'quality';
            userStates.set(sender, state);
            
            if (!state.downloads.length) {
                await socket.sendMessage(from, { 
                    text: `╭━━〔 ⚠️ *U N A V A I L A B L E* 〕━━┈\n│\n│ ❌ *No download links found for:*\n│ _${state.movieTitle}_\n│\n╰━━━━━━━━━━━━━━━━┈` 
                }, { quoted: msg });
                userStates.delete(sender);
                return;
            }
            
            let qualityText = `╭━━〔 📥 *A V A I L A B L E  Q U A L I T I E S* 〕━━┈\n│\n│ 🎬 *${state.movieTitle}*\n│\n`;
            state.downloads.forEach((dl, idx) => {
                qualityText += `│ *${idx + 1}.* 📺 ${dl.quality}${dl.size ? ' — ' + dl.size : ''}\n`;
            });
            qualityText += `│\n├━━━━━━━━━━━━━━━━┈\n│ 💡 *Reply with a number (1-${state.downloads.length})*\n│ _to start downloading!_\n╰━━━━━━━━━━━━━━━━━━┈`;
            
            if (state.moviePoster) {
                try {
                    const imgRes = await axios.get(state.moviePoster, { responseType: 'arraybuffer', timeout: 15000 });
                    await socket.sendMessage(from, { image: Buffer.from(imgRes.data), caption: qualityText }, { quoted: msg });
                } catch {
                    await socket.sendMessage(from, { text: qualityText }, { quoted: msg });
                }
            } else {
                await socket.sendMessage(from, { text: qualityText }, { quoted: msg });
            }
        } catch (error) {
            console.error('Details fetch error:', error);
            await socket.sendMessage(from, { 
                text: `❌ *Failed to get links:* _${error.message}_` 
            }, { quoted: msg });
            userStates.delete(sender);
        }
        return;
    }

    // ===== STEP 2: Pick quality → resolve zt-links → download =====
    if (state.step === 'quality') {
        const num = parseInt(trimmed, 10);
        if (isNaN(num)) return;
        if (num < 1 || num > state.downloads.length) return;
        
        const selectedDl = state.downloads[num - 1];
        userStates.delete(sender);
        
        const safeTitle = (state.movieTitle || 'movie').replace(/[^a-zA-Z0-9 ]/g, "").trim();
        const fileName = `${safeTitle}_${selectedDl.key}.mp4`;

        await socket.sendMessage(from, { 
            text: `╭━〔 🔄 *R E S O L V I N G* 〕━┈\n│\n│ 📺 *Quality:* ${selectedDl.quality}\n│ ⏳ _Resolving download link..._\n│\n╰━━━━━━━━━━━━━━━━━━━━┈` 
        }, { quoted: msg });
        
        try {
            const resolved = await resolveZtLinks(selectedDl.ztUrl);
            const finalUrl = resolved.url;
            const sizeLabel = resolved.size || selectedDl.size || '';

            await socket.sendMessage(from, { 
                text: `╭━〔 🚀 *D O W N L O A D I N G* 〕━┈\n│\n│ 🎬 *${state.movieTitle}*\n│ 📺 *Quality:* ${selectedDl.quality}\n${sizeLabel ? '│ 💾 *Size:* ' + sizeLabel + '\n' : ''}│ ⏳ _Uploading to chat..._\n│\n╰━━━━━━━━━━━━━━━━━━━━┈` 
            }, { quoted: msg });

            await sendFileAsDocument(socket, from, finalUrl, fileName, msg);
        } catch (error) {
            console.error('CineSubz download error:', error);
            
            let errorMsg = error.message;
            if (error.response?.status === 404) {
                errorMsg = "404 Not Found (The link has expired or been removed).";
            } else if (error.response?.status === 403) {
                errorMsg = "403 Forbidden (The API blocked the request).";
            }

            await socket.sendMessage(from, { 
                text: `╭━〔 ❌ *F A I L E D* 〕━┈\n│\n│ ⚠️ *Download could not be completed.*\n│ 📉 _Reason: ${errorMsg}_\n│\n╰━━━━━━━━━━━━━━━━┈` 
            }, { quoted: msg });
        }
    }
};

module.exports.isActive = (sender) => userStates.has(sender);

module.exports.clear = (sender) => userStates.delete(sender);

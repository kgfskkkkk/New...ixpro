const os = require('os');
const fs = require('fs');
const path = require('path');

let tempDir = '';
let activeDownloads = 0;
// Max simultaneous file downloads. Each slot covers the WHOLE pipeline:
// download from the source CDN + encrypt + upload to WhatsApp. The download
// leg is fast (direct CDN), so the real bottleneck is the WhatsApp upload —
// run too many at once and the host's upload bandwidth saturates and baileys
// throws "Media upload failed on all hosts". Default 12: lets many users
// download at once (rarely queues) while keeping concurrent WhatsApp uploads
// low enough to succeed. Set MAX_CONCURRENT_DOWNLOADS=<n> to tune (20+ works
// only on hosts with strong upload bandwidth).
const MAX_CONCURRENT = Math.max(1, Number(process.env.MAX_CONCURRENT_DOWNLOADS) || 12);
const waiters = [];

// Baileys leaves media-upload temp files behind (media<id>-enc / -original /
// .jpg thumbs) whenever a send is killed mid-flight (OOM kill, forced restart,
// process crash). They never get cleaned because the process died before the
// `finally` that unlinks them ran. Over weeks these accumulate and fill the
// temp disk, which then makes every download fail (ensureDiskSpace throws).
// Called once at startup: delete any such leftovers older than 1h (anything
// younger is an in-flight upload from THIS process — but setupTempDir runs
// before any socket exists, so nothing here is ever in use).
function cleanupStaleTempFiles(dir) {
    try {
        const now = Date.now();
        const cutoff = now - 60 * 60 * 1000;
        for (const entry of fs.readdirSync(dir)) {
            try {
                const isMediaTmp = /-enc$|-original$|\.jpg$/i.test(entry) && /^[a-z]+[0-9A-Za-z]+/i.test(entry);
                if (!isMediaTmp) continue;
                const fp = path.join(dir, entry);
                const st = fs.statSync(fp);
                if (st.isFile() && st.mtimeMs < cutoff) {
                    fs.unlinkSync(fp);
                    console.log(`[disk] cleaned stale temp file: ${entry} (${(st.size / 1048576).toFixed(1)} MB)`);
                }
            } catch (e) { /* skip unreadable entries */ }
        }
    } catch (e) { /* dir may not exist yet — ignore */ }
}

function setupTempDir() {
    const dir = process.env.BOT_TMPDIR || path.join(__dirname, '..', 'tmp');
    fs.mkdirSync(dir, { recursive: true });
    process.env.TMPDIR = dir;
    tempDir = dir;
    os.tmpdir = () => dir;
    cleanupStaleTempFiles(dir);
    // Periodic sweep so media leftovers from sends that failed mid-flight
    // (which baileys never got to unlink) don't fill the temp disk over the
    // bot's lifetime. Files are only removed once untouched for >1h, so an
    // in-flight upload (its mtime advances as bytes are written) is safe.
    setInterval(() => cleanupStaleTempFiles(dir), 6 * 60 * 60 * 1000).unref();
    return dir;
}

function getTempDir() {
    return tempDir || setupTempDir();
}

function getFreeSpace() {
    try {
        const { bavail, bsize } = fs.statfsSync(getTempDir());
        return bavail * bsize;
    } catch (e) {
        return 0;
    }
}

function parseSizeToBytes(sizeStr) {
    if (typeof sizeStr !== 'string') return 0;
    const m = sizeStr.trim().match(/^([\d.]+)\s*(B|KB|MB|GB|TB)?$/i);
    if (!m) return 0;
    const value = parseFloat(m[1]);
    const unit = (m[2] || 'B').toUpperCase();
    const mult = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };
    return Math.round(value * (mult[unit] || 1));
}

function ensureDiskSpace(bytesNeeded, label = 'file') {
    const free = getFreeSpace();
    const min = (Number(bytesNeeded) || 0) + (512 * 1024 * 1024);
    if (free < min) {
        throw new Error(`Not enough free space to download this ${label} (need ~${(min / 1073741824).toFixed(1)}GB, only ${(free / 1073741824).toFixed(1)}GB free on temp disk). Use a lower quality or try again later.`);
    }
}

// Some download backends proxy the real CDN file behind their own server
// (e.g. chama-movie-api.koyeb.app/api/v1/download/proxy?url=<CDN>&referer=<ref>)
// purely to inject a Referer header the CDN requires. That proxy hop is slow
// and, worse, rejects HEAD and ignores Range — so size probes against it pull
// the ENTIRE file. When a URL matches that pattern we return the inner CDN URL
// + referer so callers can stream straight from the CDN (2-3x faster, HEAD/
// Range work). Returns null when the URL is not a recognized proxy link.
function resolveDirectUrl(url) {
    if (typeof url !== 'string') return null;
    let parsed;
    try { parsed = new URL(url); } catch (e) { return null; }
    if (!/^https?:$/.test(parsed.protocol)) return null;
    const path = parsed.pathname || '';
    if (!/\/api\/v1\/download\/proxy\/?$/i.test(path) &&
        !/\/download\/proxy\/?$/i.test(path)) return null;
    const inner = parsed.searchParams.get('url');
    if (!inner || !/^https?:\/\//i.test(inner)) return null;
    const referer = parsed.searchParams.get('referer') || '';
    return { url: inner, referer: referer || undefined };
}

async function getRemoteSize(url, headers = {}) {
    const axios = require('axios');
    try {
        const head = await axios.head(url, { timeout: 15000, headers });
        const len = Number(head.headers['content-length']);
        if (len && len > 0) return len;
    } catch (e) {}
    try {
        const range = await axios.get(url, {
            headers: Object.assign({ Range: 'bytes=0-0' }, headers),
            responseType: 'stream',
            timeout: 20000
        });
        const len = Number(range.headers['content-length']);
        // Servers that ignore Range start streaming the whole body here. We
        // only need the header — destroy the stream so the leaked download
        // (which can run for minutes on a multi-GB file) stops immediately
        // instead of pinning a connection and burning bandwidth.
        try { if (range.data && typeof range.data.destroy === 'function') range.data.destroy(); } catch (e) {}
        if (len && len > 0) return len;
    } catch (e) {}
    return 0;
}

async function ensureUrlSpace(url, label = 'file', headers = {}) {
    const size = await getRemoteSize(url, headers);
    if (size > 0) ensureDiskSpace(size, label);
    return size;
}

async function withDownloadSlot(fn) {
    // MAX_CONCURRENT 0 = unlimited: every download starts immediately, nobody
    // queues behind someone else's send. With a cap (>0), later callers wait
    // for a free slot (FIFO).
    if (MAX_CONCURRENT > 0 && activeDownloads >= MAX_CONCURRENT) {
        await new Promise(resolve => waiters.push(resolve));
    }
    activeDownloads++;
    try {
        return await fn();
    } finally {
        activeDownloads--;
        if (waiters.length) waiters.shift()();
    }
}

// Download a URL to a temp file with guardrails against stalled downloads.
// Without these, a connection that stops mid-stream never resolves and pins a
// download slot forever (MAX_CONCURRENT is small), which makes every later
// download queue up and the bot feel frozen.
//   • maxBytes   – reject fast when the remote content-length exceeds the cap
//   • idleMs     – abort when no data arrives for this long (stalled server)
//   • deadlineMs – overall cap on total download time
//   • forwards mid-stream source errors (e.g. ECONNRESET) to the caller
async function downloadToFile(url, filePath, opts = {}) {
    const axios = require('axios');
    const fs = require('fs');
    const maxBytes = Number(opts.maxBytes) || 0;
    const idleMs = Number(opts.idleMs) || 45000;
    const deadlineMs = Number(opts.deadlineMs) || 40 * 60 * 1000;
    const headers = Object.assign({
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
    }, opts.headers || {});

    // Size pre-check (HEAD / range probe) so oversized files fail fast
    // instead of downloading for minutes and then being rejected.
    if (maxBytes > 0) {
        const size = await getRemoteSize(url);
        if (size > maxBytes) {
            throw new Error(`File too large: ${(size / 1073741824).toFixed(2)}GB exceeds the ${(maxBytes / 1073741824).toFixed(1)}GB limit.`);
        }
    }

    const controller = new AbortController();
    const res = await axios({
        method: 'GET',
        url,
        responseType: 'stream',
        headers,
        signal: controller.signal,
        timeout: 30000, // response headers must arrive within 30s
        maxContentLength: Infinity,
        maxBodyLength: Infinity
    });

    const writer = fs.createWriteStream(filePath);
    let lastData = Date.now();
    // Idle watchdog: abort when no bytes have arrived for idleMs (a stalled
    // server mid-file). Checked every 5s so abort fires within ~5s of the stall.
    const idleTimer = setInterval(() => {
        if (Date.now() - lastData > idleMs) controller.abort();
    }, 5000);
    const deadlineTimer = setTimeout(() => controller.abort(), deadlineMs);
    const cleanup = () => { clearInterval(idleTimer); clearTimeout(deadlineTimer); };

    return new Promise((resolve, reject) => {
        let settled = false;
        const done = (fn, arg) => { if (!settled) { settled = true; cleanup(); fn(arg); } };
        res.data.on('data', () => { lastData = Date.now(); });
        res.data.on('error', (e) => done(reject, e));
        writer.on('error', (e) => done(reject, e));
        writer.on('finish', () => done(resolve));
        res.data.pipe(writer);
    });
}

function activeDownloadCount() {
    return activeDownloads;
}

module.exports = {
    setupTempDir,
    getTempDir,
    getFreeSpace,
    parseSizeToBytes,
    ensureDiskSpace,
    getRemoteSize,
    ensureUrlSpace,
    resolveDirectUrl,
    withDownloadSlot,
    downloadToFile,
    activeDownloadCount,
    MAX_CONCURRENT
};

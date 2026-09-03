// Load variables from a local .env file (if present) into process.env,
// BEFORE anything else (like ./pair) reads process.env.MONGO_URI etc.
// Values already set on the host/panel (Startup → Variables) are left
// untouched — dotenv never overwrites an existing process.env value, so
// panel-based setups keep working exactly as before.
require('dotenv').config();

require('./plugins/logger');
const { 
    downloadMediaMessage, 
    generateWAMessageFromContent, 
    proto 
} = require('@whiskeysockets/baileys');
const { spawn } = require('child_process');
const net = require('net');
const express = require('express');
const path = require('path');
const app = express();
__path = process.cwd()
const bodyParser = require("body-parser");
const PORT = process.env.PORT || 8002;
const { setupTempDir } = require('./plugins/disk');
setupTempDir();
const { router: code, botRouter } = require('./pair'); 

require('events').EventEmitter.defaultMaxListeners = 500;

// ---------------- Miruro anime API (uvicorn, port 8003) ----------------
// The .anime flow needs the local Miruro FastAPI (miruro-api/main.py) on port
// 8003. Instead of requiring a second manual process, spawn it here so a single
// `npm start` runs BOTH the WhatsApp bot and the anime API. Graceful handling:
//   • MIRURO_API_DISABLED=1 skips it entirely (e.g. a remote API is configured)
//   • if port 8003 is already serving (a previous instance / manual uvicorn),
//     reuse it instead of starting a duplicate
//   • if the API fails to boot, the bot keeps running — .anime falls back to
//     its own error text (animeApiError)
const MIRURO_API_PORT = Number(process.env.MIRURO_API_PORT) || 8003;
const FLARESOLVERR_PORT = Number(process.env.FLARESOLVERR_PORT) || 8191;
let miruroProc = null;

function portInUse(port) {
  return new Promise((resolve) => {
    const s = net.createConnection({ port, host: '127.0.0.1' });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
    s.setTimeout(1500, () => { s.destroy(); resolve(false); });
  });
}

// Run a command and resolve with { code, out, err } (never rejects).
function runCmd(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    try {
      const p = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      p.stdout && p.stdout.on('data', d => { out += String(d); });
      p.stderr && p.stderr.on('data', d => { err += String(d); });
      p.on('error', e => resolve({ code: -1, out, err: e.message }));
      p.on('close', code => resolve({ code, out, err }));
    } catch (e) {
      resolve({ code: -1, out: '', err: e && e.message });
    }
  });
}

// Make sure the Miruro FastAPI's Python deps are present before spawning
// uvicorn. Does a fast import check first; only runs pip when something is
// missing. Returns true when uvicorn/fastapi/curl_cffi/dotenv are importable.
async function ensureMiruroDeps(apiDir) {
  try {
    const reqs = path.join(apiDir, 'requirements.txt');
    const check = await runCmd('python3', ['-c', 'import uvicorn, fastapi, curl_cffi, dotenv']);
    if (check.code === 0) return true;

    // Some minimal/container Python images ship without pip at all (not just
    // "externally managed") — every installer below still shells out to pip,
    // so if pip itself is missing they all fail identically with
    // "No module named pip". ensurepip is part of the Python standard library
    // (no apt/root/network access needed) and bootstraps pip in that case, so
    // try it once, up front, before any pip invocation.
    const pipCheck = await runCmd('python3', ['-c', 'import pip']);
    if (pipCheck.code !== 0) {
      console.log('[miruro-api] pip missing — bootstrapping via ensurepip ...');
      const boot = await runCmd('python3', ['-m', 'ensurepip', '--upgrade', '--default-pip']);
      if (boot.code !== 0) {
        console.warn('[miruro-api] ensurepip failed:', (boot.err || boot.out || '').trim().slice(0, 300));
      }
    }

    const installers = [
      ['python3', ['-m', 'pip', 'install', '-r', reqs]],
      // Ubuntu 24.04 (GitHub Actions runners) marks system Python as
      // "externally managed" (PEP 668) — --break-system-packages allows a
      // root/system install there.
      ['python3', ['-m', 'pip', 'install', '--break-system-packages', '-r', reqs]],
      // Non-root runners (GitHub Actions) can't write to system site-packages,
      // so fall back to a --user install (also bypasses PEP 668).
      ['python3', ['-m', 'pip', 'install', '--user', '-r', reqs]],
      ['pip3', ['install', '-r', reqs]],
      ['pip3', ['install', '--user', '-r', reqs]],
      ['pip', ['install', '-r', reqs]],
    ];
    for (const [cmd, args] of installers) {
      console.log(`[miruro-api] installing Python deps via ${cmd} ...`);
      const r = await runCmd(cmd, args, { cwd: apiDir });
      if (r.code === 0) return true;
      console.warn(`[miruro-api] ${cmd} install failed:`, (r.err || r.out || '').trim().slice(0, 300));
    }
    return false;
  } catch (e) {
    console.error('[miruro-api] ensure deps error:', e && e.message);
    return false;
  }
}

async function startMiruroApi() {
  if (process.env.MIRURO_API_DISABLED === '1' || process.env.MIRURO_API_DISABLED === 'true') {
    console.log('[miruro-api] disabled via MIRURO_API_DISABLED — skipping');
    return;
  }
  if (await portInUse(MIRURO_API_PORT)) {
    console.log(`[miruro-api] port ${MIRURO_API_PORT} already serving — reusing it`);
    return;
  }
  const apiDir = path.join(__path, 'miruro-api');
  try {
    // Install the FastAPI deps if they're missing (idempotent: fast import
    // check first, pip only runs when uvicorn/fastapi/curl_cffi aren't there).
    const depsOk = await ensureMiruroDeps(apiDir);
    if (!depsOk) {
      console.error('[miruro-api] Python deps missing and pip install failed — API will not start (bot keeps running)');
      return;
    }
    miruroProc = spawn('python3', ['-m', 'uvicorn', 'main:app', '--host', '127.0.0.1', '--port', String(MIRURO_API_PORT)], {
      cwd: apiDir,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    miruroProc.stdout.on('data', d => {
      const s = String(d).trim();
      if (s) console.log('[miruro-api]', s.split('\n').join('\n[miruro-api] '));
    });
    miruroProc.stderr.on('data', d => {
      const s = String(d).trim();
      if (s) console.log('[miruro-api]', s.split('\n').join('\n[miruro-api] '));
    });
    miruroProc.on('error', (e) => console.error('[miruro-api] failed to start:', e.message));
    miruroProc.on('exit', (code, sig) => {
      console.log(`[miruro-api] stopped (code=${code} signal=${sig})`);
      miruroProc = null;
    });
    console.log(`[miruro-api] starting on http://localhost:${MIRURO_API_PORT} (${apiDir})`);
  } catch (e) {
    console.error('[miruro-api] start error:', e.message);
  }
}

// ---------------- FlareSolverr (free Cloudflare solver, port 8191) ----------------
// Optional: if Docker is available, start the FlareSolverr container so the
// miruro-api can solve Miruro's Cloudflare "Just a moment" challenge. Runs
// under the same `npm start`. Non-fatal: if Docker is missing we just warn and
// the bot continues (the anime API still falls back to scraper keys).
async function ensureFlareSolverr() {
  try {
    if (await portInUse(FLARESOLVERR_PORT)) {
      console.log(`[flaresolverr] already running on ${FLARESOLVERR_PORT}`);
      return;
    }
    const docker = await runCmd('docker', ['--version']);
    if (docker.code !== 0) {
      console.warn('[flaresolverr] Docker not installed — skipping (run ./setup-flaresolverr.sh once on your VPS to enable the free CF bypass)');
      return;
    }
    let r = await runCmd('docker', ['start', 'flaresolverr']);
    if (r.code !== 0) {
      r = await runCmd('docker', ['run', '-d', '--name', 'flaresolverr', '--restart', 'unless-stopped', '-p', `127.0.0.1:${FLARESOLVERR_PORT}:8191`, '-e', 'LOG_LEVEL=info', 'ghcr.io/flaresolverr/flaresolverr:latest']);
    }
    if (r.code === 0) {
      console.log(`[flaresolverr] started on ${FLARESOLVERR_PORT}`);
    } else {
      console.warn('[flaresolverr] failed to start:', (r.err || r.out || '').trim().slice(0, 200));
    }
  } catch (e) {
    console.warn('[flaresolverr] error:', e && e.message);
  }
}

startMiruroApi();
ensureFlareSolverr();

// Stop the anime API when the bot exits (no orphan uvicorn on restarts).
process.on('exit', () => { try { miruroProc && miruroProc.kill(); } catch (e) {} });

// Shared assets (style.css, site.js) served from /public
app.use(express.static(path.join(__path, 'public')));

app.use('/code', code);
app.use('/bot', botRouter);

app.get('/pair', (req, res) => {
    res.sendFile(path.join(__path, 'pair.html'));
});

app.get('/docs', (req, res) => {
    res.sendFile(path.join(__path, 'docs.html'));
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__path, 'index.html'));
});

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

app.listen(PORT, () => {
    console.log(`
Don't Forget To Give Star !!


Server running on http://localhost:` + PORT)
});

module.exports = app;

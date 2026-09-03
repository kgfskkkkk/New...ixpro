// plugins/logger.js — patches global console with colored, stylish output.
// Load this ONCE at the very top of the entry file. Every console.log/warn/
// error/info/debug call afterwards is formatted with a timestamp + level tag.

const util = require('util');

const COLORS = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  black: '\x1b[30m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
  white: '\x1b[97m'
};

// Colors on if TTY, or forced via FORCE_COLOR; disabled by NO_COLOR.
const NO_COLOR = process.env.NO_COLOR;
const FORCE_COLOR = process.env.FORCE_COLOR;
const ENABLED = NO_COLOR ? false : (FORCE_COLOR ? true : !!(process.stdout && process.stdout.isTTY));

function paint(text, codes) {
  return ENABLED ? `${codes}${text}${COLORS.reset}` : text;
}

function ts() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return paint(`${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`, COLORS.dim + COLORS.gray);
}

function fmt(args) {
  return args.map(a => (typeof a === 'string' ? a : util.inspect(a, { depth: 4, colors: ENABLED }))).join(' ');
}

const BADGE = paint(' ISHAN-X ', COLORS.bold + COLORS.magenta);

const LEVELS = {
  log:   { icon: '⟡', label: 'LOG',   color: COLORS.cyan },
  info:  { icon: '●', label: 'INFO',  color: COLORS.blue },
  warn:  { icon: '⚠', label: 'WARN',  color: COLORS.yellow },
  error: { icon: '✖', label: 'ERROR', color: COLORS.red },
  debug: { icon: '◈', label: 'DEBUG', color: COLORS.magenta }
};

if (!global.__ISHANX_LOGGER_PATCHED__) {
  global.__ISHANX_LOGGER_PATCHED__ = true;

  for (const [level, cfg] of Object.entries(LEVELS)) {
    const tag = paint(` ${cfg.icon} ${cfg.label} `, COLORS.bold + cfg.color);
    const stream = (level === 'error' || level === 'warn') ? process.stderr : process.stdout;
    console[level] = (...args) => {
      stream.write(`${BADGE} ${ts()} ${tag} ${fmt(args)}\n`);
    };
  }
}

module.exports = { paint, COLORS };

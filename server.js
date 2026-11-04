// Hebrew Subtitle Fix - Stremio addon (no dependencies, Node 18+)
// Fetches Hebrew subtitles from upstream subtitle addons (OpenSubtitles by default),
// fixes encoding, strips hidden bidi characters and serves clean WebVTT/SRT.

const http = require('http');
const zlib = require('zlib');

const PORT = process.env.PORT || 7000;
const FORMAT = (process.env.FORMAT || 'vtt').toLowerCase(); // vtt | srt
const UPSTREAMS = (process.env.UPSTREAMS || 'https://opensubtitles-v3.strem.io')
  .split(',')
  .map((s) => s.trim().replace(/\/manifest\.json$/, '').replace(/\/$/, ''))
  .filter(Boolean);

const MODES = {
  plain: 'ניקוי תווים נסתרים בלבד',
  rlm: 'ניקוי + RLM בתחילת כל שורה',
  rle: 'ניקוי + RLE/PDF סביב כל שורה',
  visual: 'ניקוי + היפוך ויזואלי של השורה',
};

const HEB_LANGS = new Set(['heb', 'he', 'iw', 'hebrew', 'עברית']);
const BIDI_CHARS = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;
const BIDI_ENTITIES = /&(?:rlm|lrm);/gi;

// ---------- decoding ----------
function decode(buf) {
  if (buf.length > 1 && buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('windows-1255').decode(buf);
  }
}

// ---------- line transforms ----------
const MIRROR = { '(': ')', ')': '(', '[': ']', ']': '[', '{': '}', '}': '{', '<': '>', '>': '<' };

function visualReverse(line) {
  const reversed = [...line].reverse().map((c) => MIRROR[c] || c).join('');
  // put latin/digit runs back in reading order
  return reversed.replace(/[A-Za-z0-9][A-Za-z0-9.,:'%-]*/g, (run) => [...run].reverse().join(''));
}

function fixLine(line, mode) {
  let t = line.replace(BIDI_ENTITIES, '').replace(BIDI_CHARS, '');
  const hasHebrew = /[\u0590-\u05FF]/.test(t);
  if (!hasHebrew || !t.trim()) return t;
  switch (mode) {
    case 'rlm':
      return '\u200F' + t + '\u200F';
    case 'rle':
      return '\u202B' + t + '\u202C';
    case 'visual':
      return visualReverse(t.replace(/<[^>]+>/g, ''));
    default:
      return t;
  }
}

// ---------- SRT / VTT processing ----------
function processSubs(raw, mode, fmt) {
  const text = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').replace(/^WEBVTT[^\n]*\n+/, '');
  const blocks = text.split(/\n{2,}/);
  const out = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    const ti = lines.findIndex((l) => l.includes('-->'));
    if (ti === -1) continue;
    const timing = lines[ti].trim();
    const body = lines.slice(ti + 1).map((l) => fixLine(l, mode)).filter((l) => l.trim() !== '');
    if (!body.length) continue;
    out.push({ timing, body });
  }
  if (fmt === 'srt') {
    return out
      .map((c, i) => `${i + 1}\n${c.timing.replace(/\./g, ',')}\n${c.body.join('\n')}`)
      .join('\n\n') + '\n';
  }
  return (
    'WEBVTT\n\n' +
    out.map((c, i) => `${i + 1}\n${c.timing.replace(/,/g, '.')}\n${c.body.join('\n')}`).join('\n\n') +
    '\n'
  );
}

// ---------- http helpers ----------
function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, {
    'Content-Type': type,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Cache-Control': 'public, max-age=300',
  });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function baseUrl(req) {
  if (process.env.BASE_URL) return process.env.BASE_URL.replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] || 'http';
  return `${proto}://${req.headers.host}`;
}

function manifest(mode) {
  return {
    id: `community.hebfix.${mode}`,
    version: '1.0.0',
    name: `Hebrew Subtitle Fix (${mode})`,
    description: `כתוביות בעברית עם תיקון קידוד וכיווניות. מצב: ${MODES[mode]}`,
    resources: ['subtitles'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    catalogs: [],
  };
}

async function getSubtitles(req, restPath, mode) {
  const base = baseUrl(req);
  const results = await Promise.all(
    UPSTREAMS.map(async (up) => {
      try {
        const r = await fetch(`${up}/${restPath}`, { signal: AbortSignal.timeout(10000) });
        if (!r.ok) return [];
        const j = await r.json();
        return j.subtitles || [];
      } catch {
        return [];
      }
    })
  );
  const seen = new Set();
  const subs = [];
  results.flat().forEach((s, i) => {
    if (!s || !s.url || !HEB_LANGS.has(String(s.lang || '').toLowerCase())) return;
    if (seen.has(s.url)) return;
    seen.add(s.url);
    subs.push({
      id: `hebfix-${mode}-${s.id || i}`,
      url: `${base}/${mode}/sub.${FORMAT}?u=${encodeURIComponent(s.url)}`,
      lang: 'heb',
    });
  });
  return { subtitles: subs };
}

async function serveSub(res, upstreamUrl, mode) {
  const r = await fetch(upstreamUrl, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) return send(res, 502, 'upstream error', 'text/plain');
  const buf = Buffer.from(await r.arrayBuffer());
  const out = processSubs(decode(buf), mode, FORMAT);
  send(res, 200, out, FORMAT === 'srt' ? 'application/x-subrip; charset=utf-8' : 'text/vtt; charset=utf-8');
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return send(res, 204, '');
    const url = new URL(req.url, 'http://x');
    const parts = url.pathname.split('/').filter(Boolean);

    if (!parts.length) {
      const base = baseUrl(req);
      const links = Object.keys(MODES)
        .map((m) => `<li><b>${m}</b> - ${MODES[m]}<br><code>${base}/${m}/manifest.json</code></li>`)
        .join('');
      return send(res, 200, `<meta charset="utf-8"><body dir="rtl" style="font-family:sans-serif"><h2>Hebrew Subtitle Fix</h2><p>הדבק אחת מהכתובות ב-Stremio (Addons ← Add addon):</p><ul>${links}</ul></body>`, 'text/html; charset=utf-8');
    }

    const mode = parts[0];
    if (!MODES[mode]) return send(res, 404, { error: 'unknown mode' });

    if (parts[1] === 'manifest.json') return send(res, 200, manifest(mode));

    if (parts[1] === 'subtitles') {
      return send(res, 200, await getSubtitles(req, parts.slice(1).join('/'), mode));
    }

    if (parts[1] && parts[1].startsWith('sub.')) {
      const u = url.searchParams.get('u');
      if (!/^https?:\/\//i.test(u || '')) return send(res, 400, 'bad url', 'text/plain');
      return await serveSub(res, u, mode);
    }

    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, 500, String(e && e.message), 'text/plain');
  }
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`Hebrew Subtitle Fix listening on :${PORT}`));
}

module.exports = { decode, processSubs, fixLine };

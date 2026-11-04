// Hebrew Subtitle Fix - Stremio addon (no dependencies, Node 18+)
// Fetches Hebrew subtitles from upstream subtitle addons (OpenSubtitles by default),
// fixes encoding, strips hidden bidi characters and serves clean WebVTT/SRT.

const http = require('http');
const zlib = require('zlib');
const crypto = require('crypto');

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
  tv: 'ניקוי + רווח רחב בין מילים (מותאם לטלוויזיה)',
  test: 'בדיקה: כתובית לדוגמה עם וריאציות רווח',
};

// word-space variants (the TV swallows or shrinks a regular space)
const SPACES = {
  regular: ' ',
  nbsp: ' ',
  nbsp2: '  ',
  ensp: ' ',
  emsp: ' ',
  figure: ' ',
};
const TV_SPACE = SPACES[process.env.TV_SPACE] ? process.env.TV_SPACE : 'emsp';
const TV_VISUAL = process.env.TV_VISUAL === '1';

// ---------- per-install config (list of upstream addons, stored in the URL path) ----------
const ALLOW_PRIVATE = process.env.ALLOW_PRIVATE === '1'; // for local testing only

function cleanBase(s) {
  return String(s).trim().replace(/\/manifest\.json$/i, '').replace(/\/$/, '');
}

function isSafeUrl(u) {
  try {
    const x = new URL(u);
    if (!/^https?:$/.test(x.protocol)) return false;
    if (ALLOW_PRIVATE) return true;
    const h = x.hostname.toLowerCase();
    if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || h.startsWith('[')) return false;
    if (/^(0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h)) return false;
    return true;
  } catch {
    return false;
  }
}

function parseCfg(str) {
  try {
    const arr = JSON.parse(Buffer.from(str, 'base64url').toString('utf8'));
    if (!Array.isArray(arr)) return null;
    const list = arr.map(cleanBase).filter(isSafeUrl).slice(0, 10);
    return list.length ? list : null;
  } catch {
    return null;
  }
}

const CONFIG_PAGE = `<!doctype html><html dir="rtl" lang="he"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Hebrew Subtitle Fix</title>
<body style="font-family:sans-serif;max-width:680px;margin:2em auto;padding:0 1em;line-height:1.5">
<h2>Hebrew Subtitle Fix</h2>
<p>הדבק כתובות manifest של addons כתוביות (אחת בכל שורה). השרת יאחד מהם את הכתוביות בעברית, ינקה ויגיש אותן.</p>
<label><input type="checkbox" id="os" checked> כלול OpenSubtitles</label><br><br>
<textarea id="ups" rows="5" style="width:100%;direction:ltr" placeholder="https://example.com/manifest.json"></textarea><br><br>
<label>מצב ניקוי: <select id="mode">__MODES__</select></label><br><br>
<button onclick="gen()">צור קישור התקנה</button>
<div id="out" style="margin-top:1em"></div>
<script>
function gen(){
  var lines=document.getElementById('ups').value.split('\\n').map(function(s){return s.trim().replace(/\\/manifest\\.json$/i,'').replace(/\\/$/,'');}).filter(Boolean);
  if(document.getElementById('os').checked) lines.unshift('https://opensubtitles-v3.strem.io');
  var out=document.getElementById('out');
  if(!lines.length){out.textContent='הוסף לפחות addon אחד.';return;}
  var cfg=btoa(JSON.stringify(lines)).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');
  var path='/'+document.getElementById('mode').value+'/'+cfg+'/manifest.json';
  var https=location.origin+path, st='stremio://'+location.host+path;
  out.innerHTML='<p><a href="'+st+'">התקן ב-Stremio</a></p><p>או הדבק ידנית ב-Addons:</p><textarea readonly rows="3" style="width:100%;direction:ltr" onclick="this.select()">'+https+'</textarea>';
}
</script></body></html>`;

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
    case 'tv': {
      const s = TV_VISUAL ? visualReverse(t.replace(/<[^>]+>/g, '')) : t;
      return s.replace(/ +/g, SPACES[TV_SPACE]);
    }
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

// ---------- test track: same sentence, many space variants ----------
function tsrt(sec) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(sec / 3600))}:${p(Math.floor((sec % 3600) / 60))}:${p(Math.floor(sec % 60))},000`;
}

function buildTest() {
  const sentence = 'שלום עולם, זה הסרט הכי יפה שראיתי';
  const names = Object.keys(SPACES);
  const cues = ['1\n00:00:00,500 --> 00:00:03,000\nHEBFIX TEST OK'];
  let t = 4;
  for (let round = 0; round < 20; round++) {
    names.forEach((n, i) => {
      [['1', false], ['2', true]].forEach(([o, vis]) => {
        const base = vis ? visualReverse(sentence) : sentence;
        const body = base.replace(/ /g, SPACES[n]);
        cues.push(`${cues.length + 1}\n${tsrt(t)} --> ${tsrt(t + 4)}\n${String.fromCharCode(65 + i)}${o}\n${body}`);
        t += 5;
      });
    });
  }
  return processSubs(cues.join('\n\n') + '\n', 'plain', FORMAT);
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

function manifest(mode, cfgStr) {
  const suffix = cfgStr ? '.' + crypto.createHash('sha1').update(cfgStr).digest('hex').slice(0, 8) : '';
  return {
    id: `community.hebfix.${mode}${suffix}`,
    version: '1.0.0',
    name: mode === 'tv' ? 'Hebrew Subtitle Fix' : `Hebrew Subtitle Fix (${mode}${cfgStr ? ', custom' : ''})`,
    description: `כתוביות בעברית עם תיקון קידוד וכיווניות. מצב: ${MODES[mode]}`,
    resources: ['subtitles'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    catalogs: [],
  };
}

async function getSubtitles(req, restPath, mode, upstreams) {
  const base = baseUrl(req);
  const results = await Promise.all(
    upstreams.map(async (up) => {
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
    console.log(new Date().toISOString(), req.method, url.pathname.slice(0, 120));

    if (!parts.length) {
      const opts = `<option value="tv">${MODES.tv}</option>`;
      return send(res, 200, CONFIG_PAGE.replace('__MODES__', opts), 'text/html; charset=utf-8');
    }

    const mode = parts[0];
    if (!MODES[mode]) return send(res, 404, { error: 'unknown mode' });

    // optional config segment: /<mode>/<base64url cfg>/manifest.json
    let rest = parts.slice(1);
    let cfgStr = '';
    let upstreams = UPSTREAMS;
    if (rest[0] && rest[0] !== 'manifest.json' && rest[0] !== 'subtitles' && !rest[0].startsWith('sub.')) {
      cfgStr = rest[0];
      upstreams = parseCfg(cfgStr);
      if (!upstreams) return send(res, 400, { error: 'bad config' });
      rest = rest.slice(1);
    }

    if (rest[0] === 'manifest.json') return send(res, 200, manifest(mode, cfgStr));

    if (rest[0] === 'subtitles' && mode === 'test') {
      return send(res, 200, { subtitles: [{ id: 'hebfix-test', url: `${baseUrl(req)}/test/sub.${FORMAT}`, lang: 'heb' }] });
    }

    if (rest[0] === 'subtitles') {
      return send(res, 200, await getSubtitles(req, rest.join('/'), mode, upstreams));
    }

    if (rest[0] && rest[0].startsWith('sub.') && mode === 'test') {
      return send(res, 200, buildTest(), FORMAT === 'srt' ? 'application/x-subrip; charset=utf-8' : 'text/vtt; charset=utf-8');
    }

    if (rest[0] && rest[0].startsWith('sub.')) {
      const u = url.searchParams.get('u');
      if (!isSafeUrl(u || '')) return send(res, 400, 'bad url', 'text/plain');
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

'use strict';
/*
 * Brainrot — a fanfic reading tracker for Obsidian.
 * One note per fic: AO3 metadata, your tier, read dates (rereads count), podfic listens,
 * imports from Calibre or a spreadsheet, and a year-end "Brainrot Wrapped".
 * Plain JavaScript, no build step.
 */
const obsidian = require('obsidian');
const {
  Plugin, ItemView, Modal, Notice, Setting, PluginSettingTab, TFile,
  MarkdownRenderChild, normalizePath, requestUrl, setIcon, debounce,
} = obsidian;

const VIEW_TYPE = 'brainrot-view';
const STATUSES = ['unread', 'reading', 'read'];
const STATUS_LABEL = { '': 'Not set', unread: 'Unread', reading: 'Reading', read: 'Read' };
const AO3_RATINGS = ['General Audiences', 'Teen And Up Audiences', 'Mature', 'Explicit', 'Not Rated'];
const RATING_SHORT = { 'General Audiences': 'G', 'Teen And Up Audiences': 'T', Mature: 'M', Explicit: 'E', 'Not Rated': 'NR' };
const LENGTHS = [
  ['drabble', 'Under 5k', 0, 5000],
  ['short', '5k–20k', 5000, 20000],
  ['mid', '20k–50k', 20000, 50000],
  ['long', '50k–100k', 50000, 100000],
  ['epic', '100k+', 100000, Infinity],
];

const DEFAULT_SETTINGS = {
  ficsFolder: 'Fics',
  importsFolder: 'Imports',
  exportsFolder: 'Exports',
  pageSize: 100,
  tiers: ['Evergreen', 'Favorites', 'Great'],
  openOnStartup: true,
};

/* ------------------------------------------------------------------ */
/* Pure helpers                                                       */
/* ------------------------------------------------------------------ */

function pad(n) { return String(n).padStart(2, '0'); }
function todayStr(d) { d = d || new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function toDateStr(v) {
  if (!v) return '';
  if (v instanceof Date) return isNaN(v) ? '' : v.toISOString().slice(0, 10);
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  m = s.match(/^(\d{4})[/.](\d{1,2})[/.](\d{1,2})/);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${pad(m[1])}-${pad(m[2])}`;
  m = s.match(/^(\d{4})$/);
  return m ? m[1] : '';
}
function yearOf(d) { const m = String(d || '').match(/^(\d{4})/); return m ? m[1] : ''; }
function parseLocal(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, (m || 1) - 1, d || 1); }
function niceDate(s) {
  if (!s) return '';
  if (/^\d{4}$/.test(s)) return s;
  return parseLocal(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
function fmtNum(n) { return Number(n || 0).toLocaleString('en-US'); }
function fmtWords(n) {
  if (!n) return '';
  if (n >= 1000000) return `${(n / 1000000).toFixed(1).replace(/\.0$/, '')}M words`;
  if (n >= 1000) return `${Math.round(n / 100) / 10}k words`.replace('.0k', 'k');
  return `${n} words`;
}
function sleep(ms) { return new Promise((r) => window.setTimeout(r, ms)); }

function stripLink(v) {
  let s = String(v == null ? '' : v).trim();
  const m = s.match(/^\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]$/);
  if (m) s = m[2] || m[1].split('/').pop();
  return s.replace(/\.md$/i, '').trim();
}

/** YAML list, nested arrays, or a comma string → clean unique list. AO3 tags never contain commas. */
function toList(v) {
  if (v == null || v === '' || v === false || v === true) return [];
  const arr = Array.isArray(v) ? v.flat(Infinity) : String(v).split(/\s*,\s*/);
  const out = [];
  for (const x of arr) {
    if (x == null || x === true || x === false) continue;
    const s = stripLink(x);
    if (s && !out.some((o) => o.toLowerCase() === s.toLowerCase())) out.push(s);
  }
  return out;
}

function truthy(v) {
  if (v === true) return true;
  return /^(true|yes|y|1|x|✓|✔|checked)$/i.test(String(v == null ? '' : v).trim());
}

function normStatus(v) {
  const s = String(v == null ? '' : v).toLowerCase().trim();
  if (/^(read|finished|done)$/.test(s)) return 'read';
  if (/^(reading|currently reading|current|started)$/.test(s)) return 'reading';
  if (/^(unread|to read|tbr|marked for later|later)$/.test(s)) return 'unread';
  return '';
}

/** AO3 completion. Returns true, false or null when the value is not about completion. */
function normComplete(v) {
  const s = String(v == null ? '' : v).toLowerCase().trim();
  if (/^(complete|completed|finished work|done)$/.test(s)) return true;
  if (/^(in progress|in-progress|wip|incomplete|ongoing)$/.test(s)) return false;
  return null;
}

function normRating(v) {
  const s = String(v || '').trim().toLowerCase();
  if (!s) return '';
  if (/^(e|explicit)$/.test(s)) return 'Explicit';
  if (/^(m|mature)$/.test(s)) return 'Mature';
  if (/^(t|teen|teen and up|teen and up audiences)$/.test(s)) return 'Teen And Up Audiences';
  if (/^(g|gen|general|general audiences)$/.test(s)) return 'General Audiences';
  if (/^(nr|not rated)$/.test(s)) return 'Not Rated';
  return AO3_RATINGS.find((r) => r.toLowerCase() === s) || String(v).trim();
}

function toWords(v) {
  const n = parseInt(String(v == null ? '' : v).replace(/[^\d]/g, ''), 10);
  return Number.isFinite(n) ? n : 0;
}

function workIdOf(v) {
  const m = String(v || '').match(/archiveofourown\.org\/works\/(\d+)/) || String(v || '').match(/^\s*(\d{3,})\s*$/);
  return m ? m[1] : '';
}
function workUrl(id) { return id ? `https://archiveofourown.org/works/${id}` : ''; }

/** AO3 co-creators come as "A, B" or "A & B". */
function splitAuthors(s) {
  if (Array.isArray(s)) return toList(s);
  return String(s || '').split(/\s*(?:&|,|;|\band\b)\s*/i).map((a) => a.trim()).filter((a) => a && !/^(anonymous|orphan_account)$/i.test(a));
}

function foldText(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[’'`´]/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
}
function titleKey(title, author) { const t = foldText(title); return t ? `${t}|${foldText(splitAuthors(author)[0] || '')}` : ''; }
function libKey(library, id) { return library && id ? `${foldText(library)}#${String(id).trim()}` : ''; }

function lengthOf(words) {
  if (!words) return null;
  return LENGTHS.find(([, , lo, hi]) => words >= lo && words < hi) || null;
}

function ficFromFrontmatter(path, basename, fm) {
  fm = fm || {};
  const read = toList(fm.read).map(toDateStr).filter(Boolean).sort();
  const listenedRaw = fm.listened;
  return {
    path,
    basename,
    title: String(fm.title || basename),
    author: Array.isArray(fm.author) ? fm.author.join(', ') : String(fm.author || ''),
    fandoms: toList(fm.fandoms),
    ships: toList(fm.relationships),
    characters: toList(fm.characters),
    tags: toList(fm.tags),
    rating: normRating(fm.rating),
    words: toWords(fm.words),
    chapters: fm.chapters ? String(fm.chapters) : '',
    series: fm.series ? String(fm.series) : '',
    complete: fm.complete === true || fm.complete === false ? fm.complete : normComplete(fm.complete),
    status: normStatus(fm.status) || (read.length ? 'read' : ''),
    tier: fm.my_rating ? String(fm.my_rating) : '',
    read,
    started: toDateStr(fm.started),
    podfic: truthy(fm.podfic) || !!fm.podfic_link,
    narrator: fm.narrator ? String(fm.narrator) : '',
    podficLink: fm.podfic_link ? String(fm.podfic_link) : '',
    listened: toList(listenedRaw).map(toDateStr).filter(Boolean).sort(),
    listenedUndated: truthy(listenedRaw),
    link: fm.link ? String(fm.link) : workUrl(fm.work_id),
    workId: fm.work_id ? String(fm.work_id) : workIdOf(fm.link),
    library: fm.library ? String(fm.library) : '',
    calibreId: fm.calibre_id != null && fm.calibre_id !== '' ? String(fm.calibre_id) : '',
    source: fm.source ? String(fm.source) : '',
    added: toDateStr(fm.added),
  };
}

function hasListened(f) { return f.listened.length > 0 || f.listenedUndated; }

function byTitle(a, b) {
  const x = a._st || (a._st = foldText(a.title).replace(/^(the|a|an) /, ''));
  const y = b._st || (b._st = foldText(b.title).replace(/^(the|a|an) /, ''));
  return x.localeCompare(y) || a.title.localeCompare(b.title);
}
function byAuthor(a, b) { return foldText(splitAuthors(a.author)[0] || '~').localeCompare(foldText(splitAuthors(b.author)[0] || '~')) || byTitle(a, b); }
function lastRead(f) { return f.read.length ? f.read[f.read.length - 1] : ''; }

function safeFileName(s) {
  return String(s).replace(/[\\/:*?"<>|#^[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Untitled';
}
function yamlStr(s) { return JSON.stringify(String(s == null ? '' : s)); }

const FIC_FIELDS = ['title', 'author', 'fandoms', 'relationships', 'characters', 'tags', 'rating', 'words', 'chapters', 'series', 'complete',
  'status', 'my_rating', 'read', 'started', 'podfic', 'narrator', 'podfic_link', 'listened', 'link', 'work_id', 'library', 'calibre_id', 'source', 'added'];

function buildFicNote(f) {
  const L = ['---'];
  const list = (key, vals) => {
    if (vals && vals.length) { L.push(`${key}:`); vals.forEach((v) => L.push(`  - ${yamlStr(v)}`)); } else L.push(`${key}: []`);
  };
  L.push(`title: ${yamlStr(f.title)}`, `author: ${yamlStr(f.author || '')}`);
  list('fandoms', f.fandoms); list('relationships', f.ships); list('characters', f.characters); list('tags', f.tags);
  L.push(`rating: ${yamlStr(f.rating || '')}`, `words: ${f.words || 0}`, `chapters: ${yamlStr(f.chapters || '')}`, `series: ${yamlStr(f.series || '')}`);
  L.push(`complete: ${f.complete === true ? 'true' : f.complete === false ? 'false' : ''}`.trimEnd());
  L.push(`status: ${f.status || ''}`.trimEnd(), `my_rating: ${yamlStr(f.tier || '')}`);
  if (f.read && f.read.length) { L.push('read:'); f.read.forEach((d) => L.push(`  - ${d}`)); } else L.push('read: []');
  L.push(f.started ? `started: ${f.started}` : 'started:');
  L.push(`podfic: ${f.podfic || f.podficLink ? 'true' : 'false'}`, `narrator: ${yamlStr(f.narrator || '')}`, `podfic_link: ${yamlStr(f.podficLink || '')}`);
  if (f.listened && f.listened.length) { L.push('listened:'); f.listened.forEach((d) => L.push(`  - ${d}`)); } else L.push(`listened: ${f.listenedUndated ? 'true' : '[]'}`);
  L.push(`link: ${yamlStr(f.link || workUrl(f.workId))}`, `work_id: ${yamlStr(f.workId || '')}`, `library: ${yamlStr(f.library || '')}`,
    `calibre_id: ${yamlStr(f.calibreId || '')}`, `source: ${yamlStr(f.source || '')}`, `added: ${f.added || todayStr()}`, '---', '',
    '```brainrot', 'show: fic', '```', '', '## Summary', '');
  if (f.summary && f.summary.trim()) L.push(f.summary.trim(), '');
  L.push('', '## Notes', '');
  if (f.notes && f.notes.trim()) L.push(f.notes.trim(), '');
  L.push('');
  return L.join('\n');
}

/* ---------------------------- AO3 page parsing ---------------------------- */

function decodeHtml(s) {
  return String(s || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>\s*<p[^>]*>/gi, '\n\n').replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&#x27;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/[ \t]+/g, ' ').trim();
}

/** Work metadata from the HTML of an AO3 work page. Returns null for a login or error page. */
function parseAo3Work(html, url) {
  if (!/<dl class="work meta group"/.test(html)) return null;
  const dd = (cls) => { const m = html.match(new RegExp(`<dd class="${cls}[^"]*">([\\s\\S]*?)</dd>`)); return m ? m[1] : ''; };
  const tags = (cls) => [...dd(cls).matchAll(/<a class="tag"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => decodeHtml(m[1]));
  const title = decodeHtml((html.match(/<h2 class="title heading">([\s\S]*?)<\/h2>/) || [])[1]);
  const authors = [...((html.match(/<h3 class="byline heading">([\s\S]*?)<\/h3>/) || [])[1] || '').matchAll(/<a rel="author"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => decodeHtml(m[1]));
  const summary = decodeHtml((html.match(/<div class="summary module"[\s\S]*?<blockquote class="userstuff">([\s\S]*?)<\/blockquote>/) || [])[1]);
  const chapters = decodeHtml(dd('chapters'));
  const series = decodeHtml((dd('series').match(/<span class="position">([\s\S]*?)<\/span>/) || [])[1] || '').replace(/^Part (\d+) of (.+)$/, '$2 #$1');
  const ch = chapters.match(/(\d+)\s*\/\s*(\d+|\?)/);
  return {
    title, author: authors.join(', '), fandoms: tags('fandom tags'), ships: tags('relationship tags'), characters: tags('character tags'),
    tags: tags('freeform tags'), rating: normRating(tags('rating tags')[0] || ''), words: toWords(decodeHtml(dd('words'))), chapters,
    complete: ch ? ch[1] === ch[2] : null, series, summary, workId: workIdOf(url), link: workUrl(workIdOf(url)),
  };
}

/* ---------------------------- Import ---------------------------- */

function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  const counts = { ',': 0, '\t': 0, ';': 0 };
  let q = false;
  for (const ch of firstLine) { if (ch === '"') q = !q; else if (!q && ch in counts) counts[ch]++; }
  const delim = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; } else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === delim) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  if (!rows.length) return { headers: [], rows: [] };
  const headers = rows[0].map((h) => h.trim());
  return { headers, rows: rows.slice(1).map((r) => headers.map((_, i) => (r[i] || '').trim())) };
}

const HEADER_ALIASES = {
  title: ['title', 'work', 'work title', 'fic', 'story'],
  author: ['author', 'authors', 'creator', 'creators', 'writer'],
  fandoms: ['fandom', 'fandoms', 'category'],
  ships: ['relationship', 'relationships', 'ship', 'ships', 'pairing', 'pairings'],
  characters: ['character', 'characters'],
  tags: ['tags', 'additional tags', 'freeform', 'freeform tags', 'freeforms'],
  rating: ['rating', 'ao3 rating', 'content rating'],
  words: ['words', 'word count', 'wordcount', 'length'],
  chapters: ['chapters', 'chapter count'],
  series: ['series'],
  status: ['status', 'reading status', 'read status', 'complete', 'completed', 'work status'],
  read: ['read', 'date read', 'read on', 'read date', 'read dates', 'finished'],
  tier: ['my rating', 'calibre my rating', 'tier', 'rec', 'rec tier'],
  podfic: ['podfic', 'podfic available', 'has podfic'],
  narrator: ['narrator', 'reader', 'podficcer'],
  podficLink: ['podfic link', 'podfic url'],
  listened: ['listened', 'listened on', 'date listened'],
  link: ['link', 'url', 'ao3 link', 'work url', 'ao3 url'],
  workId: ['ao3 work id', 'work id', 'ao3 id'],
  library: ['library', 'calibre library'],
  calibreId: ['calibre id', 'calibre_id', 'id'],
  source: ['source', 'site'],
  summary: ['summary', 'description', 'comments'],
  notes: ['notes', 'note', 'my notes'],
  added: ['added', 'date added'],
};
const IGNORE_HEADERS = ['calibre my tags', 'finished', 'kudos', 'hits', 'bookmarks', 'comments count'];

function guessField(header) {
  const h = foldText(header);
  if (IGNORE_HEADERS.includes(h)) return '';
  for (const [k, aliases] of Object.entries(HEADER_ALIASES)) if (aliases.includes(h)) return k;
  return '';
}

/** CSV text → candidate fics. Recognized columns map by name; others are ignored. */
function rowsToFics(csv, opts) {
  opts = opts || {};
  const map = csv.headers.map(guessField);
  const out = [];
  for (const row of csv.rows) {
    const f = { fandoms: [], ships: [], characters: [], tags: [], read: [], listened: [], extraStatus: '' };
    map.forEach((k, i) => {
      const v = (row[i] || '').trim();
      if (!k || !v) return;
      switch (k) {
        case 'fandoms': case 'ships': case 'characters': case 'tags': f[k].push(...toList(v)); break;
        case 'words': f.words = toWords(v); break;
        case 'rating': f.rating = normRating(v); break;
        case 'status': {
          const c = normComplete(v);
          if (c !== null) f.complete = c; else if (normStatus(v)) f.status = normStatus(v);
          break;
        }
        case 'read': {
          const parts = v.split(/[;,]/).map(toDateStr).filter(Boolean);
          if (parts.length) f.read.push(...parts); else if (truthy(v)) f.status = 'read'; else if (/^(false|no|0)$/i.test(v)) f.readNo = true;
          break;
        }
        case 'tier': f.tier = v.split(/\s*,\s*/)[0]; break;
        case 'podfic': f.podfic = truthy(v); break;
        case 'listened': {
          const parts = v.split(/[;,]/).map(toDateStr).filter(Boolean);
          if (parts.length) f.listened.push(...parts); else if (truthy(v)) f.listenedUndated = true;
          break;
        }
        case 'link': f.link = v; if (!f.workId) f.workId = workIdOf(v); break;
        case 'workId': f.workId = workIdOf(v) || v; break;
        case 'added': f.added = toDateStr(v); break;
        default: f[k] = v;
      }
    });
    if (!f.title) continue;
    if (!f.library && opts.library) f.library = opts.library;
    if (f.read.length) f.status = 'read';
    if (!f.status && f.tier && !f.readNo) f.status = 'read'; // a fic you rated is a fic you read
    if (!f.status && opts.status) f.status = opts.status;
    if (f.podficLink || f.narrator) f.podfic = true;
    if (f.workId && !f.link) f.link = workUrl(f.workId);
    for (const k of ['fandoms', 'ships', 'characters', 'tags']) f[k] = toList(f[k]);
    f.read = [...new Set(f.read)].sort();
    f.listened = [...new Set(f.listened)].sort();
    out.push(f);
  }
  return out;
}

function ficKeys(f) { return [f.workId && `ao3#${f.workId}`, libKey(f.library, f.calibreId), titleKey(f.title, f.author)].filter(Boolean); }

/** Fields the source owns (refreshed on every import) and fields that are yours (filled only when empty). */
const SOURCE_FIELDS = ['title', 'author', 'fandoms', 'ships', 'characters', 'tags', 'rating', 'words', 'chapters', 'series', 'complete', 'link', 'workId', 'library', 'calibreId', 'source'];
const MINE_FIELDS = ['status', 'tier', 'podfic', 'narrator', 'podficLink'];
const FM_KEY = { ships: 'relationships', tier: 'my_rating', podficLink: 'podfic_link', workId: 'work_id', calibreId: 'calibre_id' };

function emptyVal(v) { return v == null || v === '' || v === false || (Array.isArray(v) && !v.length) || v === 0; }

/** What an import would change on an existing fic: { key: newValue } in frontmatter terms. */
function ficPatch(existing, incoming) {
  const patch = {};
  for (const k of SOURCE_FIELDS) {
    const v = incoming[k];
    if (emptyVal(v) && v !== false) continue;
    const cur = existing[k];
    const same = Array.isArray(v) ? JSON.stringify(toList(v)) === JSON.stringify(toList(cur)) : String(v) === String(cur == null ? '' : cur);
    if (!same) patch[FM_KEY[k] || k] = v;
  }
  for (const k of MINE_FIELDS) {
    if (!emptyVal(existing[k]) || emptyVal(incoming[k])) continue;
    patch[FM_KEY[k] || k] = incoming[k];
  }
  const reads = [...new Set([...existing.read, ...(incoming.read || [])])].sort();
  if (reads.length !== existing.read.length) { patch.read = reads; if (existing.status !== 'reading') patch.status = 'read'; }
  const listens = [...new Set([...existing.listened, ...(incoming.listened || [])])].sort();
  if (listens.length !== existing.listened.length) patch.listened = listens;
  else if (incoming.listenedUndated && !hasListened(existing)) patch.listened = true;
  return patch;
}

/** Sort candidates into new fics, updates to existing fics, and unchanged fics. */
function planImport(candidates, library) {
  const index = new Map();
  for (const f of library) for (const k of ficKeys(f)) if (!index.has(k)) index.set(k, f);
  const plan = { fresh: [], updates: [], same: [], fills: [] };
  const seen = new Map();
  for (const c of candidates) {
    const keys = ficKeys(c);
    const match = keys.map((k) => index.get(k)).find(Boolean);
    if (match) {
      if (c.notes || c.summary) plan.fills.push({ fic: match, notes: c.notes || '', summary: c.summary || '' });
      const patch = ficPatch(match, c);
      if (Object.keys(patch).length) plan.updates.push({ fic: match, patch, incoming: c }); else plan.same.push(match);
      continue;
    }
    const dupe = keys.map((k) => seen.get(k)).find(Boolean);
    if (dupe) continue; // the same fic twice in one file
    keys.forEach((k) => seen.set(k, c));
    plan.fresh.push(c);
  }
  return plan;
}

/** Put text into an empty "## Heading" section. A section that has text is left alone. */
function fillEmptySection(content, heading, text) {
  text = String(text || '').trim();
  if (!text) return content;
  const m = new RegExp(`^##[ \\t]+${heading}[ \\t]*$`, 'im').exec(content);
  if (!m) return `${content.replace(/\s*$/, '')}\n\n## ${heading}\n\n${text}\n`;
  const start = m.index + m[0].length;
  const next = /^#{1,2}\s/m.exec(content.slice(start));
  const end = next ? start + next.index : content.length;
  if (content.slice(start, end).trim()) return content;
  return `${content.slice(0, start)}\n\n${text}\n\n${content.slice(end).replace(/^\s*/, '')}`;
}

/* ---------------------------- Browsing ---------------------------- */

const DIMENSIONS = {
  fandom: { label: 'Fandoms', values: (f) => f.fandoms },
  ship: { label: 'Relationships', values: (f) => f.ships },
  character: { label: 'Characters', values: (f) => f.characters },
  author: { label: 'Authors', values: (f) => splitAuthors(f.author) },
  tag: { label: 'Tags', values: (f) => f.tags },
  series: { label: 'Series', values: (f) => (f.series ? [f.series.replace(/\s*#\d+$/, '')] : []) },
  rating: { label: 'Ratings', values: (f) => (f.rating ? [f.rating] : []) },
  tier: { label: 'My rating', values: (f) => (f.tier ? [f.tier] : []) },
  length: { label: 'Length', values: (f) => { const l = lengthOf(f.words); return l ? [l[1]] : []; } },
  library: { label: 'Libraries', values: (f) => (f.library ? [f.library] : []) },
  year: { label: 'Year read', values: (f) => [...new Set(f.read.map(yearOf))] },
};

function tally(fics, dim) {
  const fn = DIMENSIONS[dim].values;
  const m = new Map();
  for (const f of fics) for (const v of fn(f)) {
    if (!v) continue;
    const k = v.toLowerCase();
    if (!m.has(k)) m.set(k, { value: v, count: 0, read: 0 });
    const e = m.get(k); e.count++; if (f.read.length || f.status === 'read') e.read++;
  }
  return [...m.values()];
}

function matchesFilter(f, q) {
  const eq = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();
  const has = (list, v) => list.some((x) => eq(x, v));
  if (q.status && q.status !== 'any' && f.status !== q.status) return false;
  if (q.tier && (q.tier === '__any' ? !f.tier : q.tier === '__none' ? !!f.tier : !eq(f.tier, q.tier))) return false;
  if (q.fandom && !has(f.fandoms, q.fandom)) return false;
  if (q.ship && !has(f.ships, q.ship)) return false;
  if (q.character && !has(f.characters, q.character)) return false;
  if (q.tag && !has(f.tags, q.tag)) return false;
  if (q.author && !has(splitAuthors(f.author), q.author)) return false;
  if (q.series && !eq(f.series.replace(/\s*#\d+$/, ''), q.series)) return false;
  if (q.rating && !eq(f.rating, q.rating)) return false;
  if (q.library && !eq(f.library, q.library)) return false;
  if (q.length) { const l = lengthOf(f.words); if (!l || (l[0] !== q.length && l[1] !== q.length)) return false; }
  if (q.podfic === 'yes' && !f.podfic) return false;
  if (q.podfic === 'listened' && !hasListened(f)) return false;
  if (q.podfic === 'not yet' && (!f.podfic || hasListened(f))) return false;
  if (q.year && !f.read.some((d) => d.startsWith(q.year))) return false;
  if (q.query) {
    const words = foldText(q.query).split(' ');
    const hay = foldText([f.title, f.author, f.series, ...f.fandoms, ...f.ships, ...f.characters, ...f.tags].join(' '));
    if (!words.every((w) => hay.includes(w))) return false;
  }
  return true;
}

/* ---------------------------- Exports ---------------------------- */

const CSV_COLS = ['Title', 'Author', 'Fandoms', 'Relationships', 'Characters', 'Tags', 'Rating', 'Words', 'Chapters', 'Series', 'Complete',
  'Reading status', 'My rating', 'Date read', 'Podfic', 'Narrator', 'Podfic link', 'Listened', 'Link', 'AO3 work ID', 'Library', 'Calibre ID', 'Source', 'Added'];
function exportCsv(fics) {
  const q = (s) => `"${String(s == null ? '' : s).replace(/"/g, '""')}"`;
  const rows = [...fics].sort(byTitle).map((f) => [f.title, f.author, f.fandoms.join(', '), f.ships.join(', '), f.characters.join(', '), f.tags.join(', '),
    f.rating, f.words || '', f.chapters, f.series, f.complete === true ? 'Complete' : f.complete === false ? 'In progress' : '', f.status, f.tier,
    f.read.join('; '), f.podfic ? 'yes' : '', f.narrator, f.podficLink, f.listened.length ? f.listened.join('; ') : (f.listenedUndated ? 'yes' : ''),
    f.link, f.workId, f.library, f.calibreId, f.source, f.added]);
  return [CSV_COLS, ...rows].map((r) => r.map(q).join(',')).join('\n') + '\n';
}

/** Lines like "- 2026-03-02 · Finished. Loved it." from a note's Reading log → { date: text }. */
function readingLogThoughts(content) {
  const out = {};
  const m = /^##[ \t]+Reading log[ \t]*$/im.exec(content || '');
  if (!m) return out;
  const rest = content.slice(m.index + m[0].length);
  const next = /^#{1,2}\s/m.exec(rest);
  for (const line of (next ? rest.slice(0, next.index) : rest).split('\n')) {
    const x = line.match(/^\s*-\s+(\d{4}(?:-\d\d-\d\d)?)\s+·\s+Finished\.?\s*(.*)$/);
    if (x && x[2].trim()) out[x[1]] = x[2].trim();
  }
  return out;
}

/* --- year-in-reading report core v1 (shared by In the Margins, Brown Bag, The Stacks and Brainrot) --- */
/*
 * Each plugin builds a report object in the year-in-reading/1 shape, then calls
 * renderReportMarkdown() for the note and JSON.stringify() for the .json file.
 * The JSON is what the Year in Reading page reads.
 *
 * {
 *   schema: 'year-in-reading/1',
 *   source: { plugin, name, unit, units },          // unit: 'book' | 'fic' | 'session'
 *   year: '2026', generated: '2026-12-31', title,
 *   covers: [{ title, cover }],
 *   stats: [{ label, value }],                       // "At a glance"
 *   top: [{ label, name, count, of }],               // "Most read" (heading: topHeading)
 *   highlights: ['markdown', ...],
 *   months: { label, values: [12], secondary: { label, values: [12] } | null },
 *   sections: [{ heading, items: [item] }],
 *   tables: [{ heading, columns: [...], rows: [[...]] }],
 * }
 * item: { title, author, link, linkLabel, cover, date, meta: ['markdown'], fields: [{ label, text }],
 *         checklist: [{ text, done }], quote, tags: [] }
 */
const REPORT_SCHEMA = 'year-in-reading/1';
const REPORT_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function rMd(s) { return String(s == null ? '' : s).replace(/([*_`[\]|])/g, '\\$1'); }
function rAttr(s) { return String(s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }
function rImg(title, cover, width) {
  return cover ? `<img src="${rAttr(cover)}" alt="${rAttr(`Cover of ${title}`)}" width="${width}">` : '';
}
function rPlural(n, one, many) { return `${n} ${n === 1 ? one : (many || `${one}s`)}`; }
function rNum(n) { return typeof n === 'number' ? n.toLocaleString('en-US') : String(n == null ? '' : n); }
function rOneLine(s) { return String(s || '').replace(/\s*\n+\s*/g, ' ').trim(); }
function rDate(d) {
  if (!/^\d{4}-\d\d-\d\d$/.test(d || '')) return d || '';
  const [y, m, day] = d.split('-').map(Number);
  return new Date(y, m - 1, day).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Count values → [{ name, count }] sorted by count, then name. */
function rRank(values) {
  const m = new Map();
  for (const v of values) {
    if (v == null || v === '') continue;
    const key = String(v).toLowerCase();
    if (!m.has(key)) m.set(key, { name: String(v), count: 0 });
    m.get(key).count++;
  }
  return [...m.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** The "Most read" row for one dimension: ties share the top spot. */
function rTop(label, ranked, of) {
  if (!ranked.length) return null;
  const best = ranked.filter((x) => x.count === ranked[0].count);
  if ((ranked[0].count < 2 && of > 1) || best.length > 3) return null; // no clear favorite
  return { label, name: best.map((x) => x.name).join(', '), count: ranked[0].count, of };
}

function rMonthCounts(dates) {
  const out = new Array(12).fill(0);
  for (const d of dates) { const m = /^\d{4}-(\d\d)/.exec(d || ''); if (m) out[Number(m[1]) - 1]++; }
  return out;
}

/** Year-end reports cover a finished year: the default is last year, and the current year waits for January 1. */
function lastYear() { return String(new Date().getFullYear() - 1); }
function reportYearProblem(year) {
  const y = String(year || '').trim();
  if (!/^\d{4}$/.test(y)) return 'Enter a four-digit year.';
  const now = new Date().getFullYear();
  if (Number(y) >= now) return `The ${y} report opens on January 1, ${Number(y) + 1}, once the year is over.`;
  return '';
}

function newReport(source, year, title) {
  return {
    schema: REPORT_SCHEMA, source, year: String(year), generated: (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })(),
    title, covers: [], stats: [], top: [], highlights: [], months: null, sections: [], tables: [],
  };
}

function renderReportMarkdown(r) {
  const out = [`# ${r.title}`, '', `*Made ${rDate(r.generated)} from ${r.source.name}.*`, ''];
  const itemCount = r.sections.reduce((n, s) => n + s.items.length, 0);
  if (!itemCount && !r.stats.length) { out.push(`Nothing logged in ${r.year}.`, ''); return out.join('\n'); }
  const covers = r.covers.filter((c) => c.cover);
  if (covers.length) out.push(covers.map((c) => rImg(c.title, c.cover, 72)).join(' '), '');

  if (r.stats.length) {
    out.push('## At a glance', '', '| | |', '| --- | --- |', ...r.stats.map((s) => `| ${rMd(s.label)} | ${rNum(s.value)} |`), '');
  }
  const top = r.top.filter(Boolean);
  if (top.length) {
    out.push(`## ${r.topHeading || 'Most read'}`, '', `| | Top | ${r.source.units[0].toUpperCase()}${r.source.units.slice(1)} |`, '| --- | --- | --- |',
      ...top.map((t) => `| ${rMd(t.label)} | ${rMd(t.name)} | ${t.count} of ${t.of} |`), '');
  }
  if (r.highlights.length) out.push('## Highlights', '', ...r.highlights.map((h) => `- ${h}`), '');

  if (r.months && r.months.values.some(Boolean)) {
    const v = r.months.values, sec = r.months.secondary;
    const max = Math.max(...v);
    out.push('## Month by month', '', '```');
    REPORT_MONTHS.forEach((m, i) => {
      const bar = v[i] ? '█'.repeat(Math.max(1, Math.round((v[i] / max) * 24))) : '';
      const extra = sec && sec.values[i] ? `  ${rNum(sec.values[i])} ${sec.label}` : '';
      out.push(`${m.slice(0, 3)}  ${bar.padEnd(25)}${v[i] || ''}${extra}`.trimEnd());
    });
    out.push('```', `*${r.months.label}${sec ? `, with ${sec.label}` : ''}.*`, '');
  }

  for (const s of r.sections) {
    if (!s.items.length) continue;
    out.push(`## ${s.heading}`, '');
    for (const it of s.items) {
      out.push(`### ${rMd(it.title)}`, '');
      if (it.cover) out.push(rImg(it.title, it.cover, 120), '');
      const meta = [...(it.author ? [`*${rMd(it.author)}*`] : []), ...(it.meta || [])];
      if (it.link) meta.push(`[${it.linkLabel || 'Link'}](${it.link})`);
      if (meta.length) out.push(meta.join(' · '), '');
      for (const f of it.fields || []) if (f.text) out.push(`**${f.label}:** ${rOneLine(f.text)}`, '');
      if (it.checklist && it.checklist.length) out.push(...it.checklist.map((c) => `- [${c.done ? 'x' : ' '}] ${c.text}`), '');
      if (it.quote) out.push(String(it.quote).trim().split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n'), '');
    }
  }
  for (const t of r.tables) {
    if (!t.rows.length) continue;
    out.push(`## ${t.heading}`, '', `| ${t.columns.join(' | ')} |`, `| ${t.columns.map(() => '---').join(' | ')} |`,
      ...t.rows.map((row) => `| ${row.map((c) => rMd(rNum(c))).join(' | ')} |`), '');
  }
  return out.join('\n');
}
/* --- end report core --- */

/**
 * Year-end report data (year-in-reading/1): "Brainrot Wrapped". Every fic read in the year,
 * words read, fandoms, ships, characters, tags, tiers, rereads and podfic listens.
 */
function buildYearReport(fics, year, thoughts, tiers) {
  thoughts = thoughts || {};
  tiers = tiers || DEFAULT_SETTINGS.tiers;
  const y = String(year);
  const entries = [];
  for (const f of fics) for (const d of f.read) if (d.startsWith(y)) entries.push({ d, f });
  const sortDate = (d) => (/^\d{4}$/.test(d) ? `${d}-99` : d);
  entries.sort((a, b) => sortDate(a.d).localeCompare(sortDate(b.d)) || byTitle(a.f, b.f));
  const listens = [];
  for (const f of fics) for (const d of f.listened) if (d.startsWith(y)) listens.push({ d, f });
  listens.sort((a, b) => a.d.localeCompare(b.d));
  const r = newReport({ plugin: 'brainrot', name: 'Brainrot', unit: 'fic', units: 'fics' }, y, `${y} Brainrot Wrapped`);
  r.topHeading = 'Brainrot rankings';
  if (!entries.length && !listens.length) return r;
  const read = [...new Set(entries.map((e) => e.f))];
  const words = entries.reduce((n, e) => n + (e.f.words || 0), 0);
  const rereads = read.filter((f) => f.read.some((d, i) => i > 0 && d.startsWith(y)));

  r.stats.push({ label: 'Fics read', value: read.length });
  if (entries.length !== read.length) r.stats.push({ label: 'Reads, counting rereads', value: entries.length });
  if (words) {
    r.stats.push({ label: 'Words read', value: words });
    r.stats.push({ label: 'In novels (90k words each)', value: `about ${Math.max(1, Math.round(words / 90000))}` });
    r.stats.push({ label: 'Average fic', value: fmtWords(Math.round(words / entries.length)) });
  }
  if (rereads.length) r.stats.push({ label: 'Rereads', value: rereads.length });
  if (listens.length) r.stats.push({ label: 'Podfics listened', value: listens.length });
  const topTier = tiers[0];
  const topTierRead = read.filter((f) => f.tier === topTier);
  if (topTierRead.length) r.stats.push({ label: topTier, value: topTierRead.length });

  const of = read.length;
  r.top = [rTop('Fandom', rRank(read.flatMap((f) => f.fandoms)), of), rTop('Relationship', rRank(read.flatMap((f) => f.ships)), of),
    rTop('Character', rRank(read.flatMap((f) => f.characters)), of), rTop('Author', rRank(read.flatMap((f) => splitAuthors(f.author))), of),
    rTop('Tag', rRank(read.flatMap((f) => f.tags)), of), rTop('Rating', rRank(read.map((f) => f.rating)), of),
    rTop('Length', rRank(read.map((f) => (lengthOf(f.words) || [])[1])), of)].filter(Boolean);

  const hi = r.highlights;
  const sized = read.filter((f) => f.words);
  const longest = [...sized].sort((a, b) => b.words - a.words)[0];
  const shortest = [...sized].sort((a, b) => a.words - b.words)[0];
  if (longest) hi.push(`**Longest:** *${rMd(longest.title)}*, ${fmtWords(longest.words)}.`);
  if (shortest && shortest !== longest) hi.push(`**Shortest:** *${rMd(shortest.title)}*, ${fmtWords(shortest.words)}.`);
  const months = rMonthCounts(entries.map((e) => e.d));
  const monthWords = new Array(12).fill(0);
  for (const e of entries) { const m = /^\d{4}-(\d\d)/.exec(e.d); if (m) monthWords[Number(m[1]) - 1] += e.f.words || 0; }
  const peak = Math.max(...months);
  if (peak > 1) hi.push(`**Peak brainrot:** ${REPORT_MONTHS.filter((_, i) => months[i] === peak).join(' and ')}, with ${rPlural(peak, 'fic')}.`);
  if (words) hi.push(`**Every day:** about ${fmtNum(Math.round(words / 365))} words a day, on average.`);
  const priorAuthors = new Set(fics.filter((f) => f.read.some((d) => d < y)).flatMap((f) => splitAuthors(f.author).map((a) => a.toLowerCase())));
  const newAuthors = [...new Set(read.flatMap((f) => splitAuthors(f.author)))].filter((a) => !priorAuthors.has(a.toLowerCase()));
  if (priorAuthors.size && newAuthors.length) hi.push(`**New to me:** ${rPlural(newAuthors.length, 'author')} I hadn't read before.`);
  if (rereads.length) hi.push(`**Comfort reads:** ${rereads.slice(0, 8).map((f) => `*${rMd(f.title)}*${f.read.length > 2 ? ` (${f.read.length} reads in all)` : ''}`).join(', ')}${rereads.length > 8 ? ` and ${rereads.length - 8} more` : ''}.`);
  if (topTierRead.length) hi.push(`**${topTier} reads:** ${topTierRead.slice(0, 8).map((f) => `*${rMd(f.title)}*`).join(', ')}${topTierRead.length > 8 ? ` and ${topTierRead.length - 8} more` : ''}.`);
  const series = rRank(read.filter((f) => f.series).map((f) => f.series.replace(/\s*#\d+$/, '')));
  if (series.length && series[0].count > 1) hi.push(`**Series binge:** ${series[0].count} fics from *${rMd(series[0].name)}*.`);

  r.months = { label: 'Fics read', values: months, secondary: words ? { label: 'words', values: monthWords } : null };
  const groups = new Map();
  for (const { d, f } of entries) {
    const heading = /^\d{4}$/.test(d) ? 'Sometime this year' : REPORT_MONTHS[Number(d.slice(5, 7)) - 1];
    if (!groups.has(heading)) groups.set(heading, []);
    groups.get(heading).push({
      title: f.title, author: f.author, date: d, link: f.link, linkLabel: f.link ? 'AO3' : '',
      meta: [f.fandoms.slice(0, 2).join(', '), f.ships[0], fmtWords(f.words), RATING_SHORT[f.rating] || f.rating, f.tier,
        f.read.length > 1 && `read ${f.read.length} times`, hasListened(f) && 'podfic'].filter(Boolean),
      fields: [], quote: (thoughts[f.path] || {})[d] || '',
      tags: [f.tier || 'Read', ...f.fandoms, ...f.ships],
    });
  }
  r.sections = [...groups].map(([heading, items]) => ({ heading, items }));
  const top = (list, n) => list.slice(0, n).map((x) => [x.name, x.count]);
  r.tables.push({ heading: 'By fandom', columns: ['Fandom', 'Fics'], rows: top(rRank(read.flatMap((f) => f.fandoms)), 25) });
  r.tables.push({ heading: 'By relationship', columns: ['Relationship', 'Fics'], rows: top(rRank(read.flatMap((f) => f.ships)), 20) });
  r.tables.push({ heading: 'Top tags', columns: ['Tag', 'Fics'], rows: top(rRank(read.flatMap((f) => f.tags)), 20) });
  r.tables.push({ heading: 'Podfics', columns: ['Date', 'Fic', 'Narrator'], rows: listens.map((e) => [rDate(e.d), e.f.title, e.f.narrator]) });
  return r;
}

/* ------------------------------------------------------------------ */
/* Plugin                                                             */
/* ------------------------------------------------------------------ */

class BrainrotPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.busy = false;
    this.registerView(VIEW_TYPE, (leaf) => new BrainrotView(leaf, this));
    this.addRibbonIcon('sparkles', 'Open Brainrot', () => this.activateView());
    this.registerMarkdownCodeBlockProcessor('brainrot', (source, el, ctx) => ctx.addChild(new BrainrotBlock(el, this, source, ctx.sourcePath)));

    this.addCommand({ id: 'open', name: 'Open the library', callback: () => this.activateView() });
    this.addCommand({ id: 'add-fic', name: 'Add a fic', callback: () => new AddFicModal(this).open() });
    this.addCommand({ id: 'import', name: 'Import fics from a CSV', callback: () => new ImportModal(this).open() });
    this.addCommand({ id: 'start-current', name: 'Start reading this fic', checkCallback: (c) => this.withCurrent(c, (f) => this.startReading(f)) });
    this.addCommand({ id: 'read-current', name: 'Mark this fic read', checkCallback: (c) => this.withCurrent(c, (f) => new ReadModal(this, f).open()) });
    this.addCommand({ id: 'listen-current', name: 'Log a podfic listen for this fic', checkCallback: (c) => this.withCurrent(c, (f) => new ListenModal(this, f).open()) });
    this.addCommand({ id: 'year-report', name: 'Year-end report', callback: () => new PromptModal(this.app, 'Year-end report for which year?', lastYear(), (y) => this.yearReport(y)).open() });
    this.addCommand({ id: 'export-csv', name: 'Export all fics as CSV', callback: () => this.exportAll() });

    this.addSettingTab(new BrainrotSettingTab(this.app, this));
    this.app.workspace.onLayoutReady(() => { if (this.settings.openOnStartup) this.activateView(); });
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    if (!Array.isArray(this.settings.tiers) || !this.settings.tiers.length) this.settings.tiers = [...DEFAULT_SETTINGS.tiers];
  }
  async saveSettings() { await this.saveData(this.settings); }

  inFolder(path) { const f = normalizePath(this.settings.ficsFolder || ''); return !f || f === '/' || path.startsWith(`${f}/`); }
  readFic(file) { const f = ficFromFrontmatter(file.path, file.basename, this.app.metadataCache.getFileCache(file)?.frontmatter); f.file = file; return f; }
  getFics() { return this.app.vault.getMarkdownFiles().filter((f) => this.inFolder(f.path)).map((f) => this.readFic(f)); }
  getFic(path) { const f = this.app.vault.getAbstractFileByPath(path); return f instanceof TFile && this.inFolder(f.path) ? this.readFic(f) : null; }

  withCurrent(checking, fn) {
    const file = this.app.workspace.getActiveFile();
    const fic = file && this.getFic(file.path);
    if (!fic) return false;
    if (!checking) fn(fic);
    return true;
  }

  values(fics, dim) { return tally(fics, dim).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value)).map((x) => x.value); }

  async ensureFolder(path) { const p = normalizePath(path); if (!this.app.vault.getAbstractFileByPath(p)) await this.app.vault.createFolder(p); }
  async writeFile(path, content) {
    path = normalizePath(path);
    const f = this.app.vault.getAbstractFileByPath(path);
    if (f instanceof TFile) { await this.app.vault.modify(f, content); return f; }
    return this.app.vault.create(path, content);
  }
  openFic(fic, sourcePath) { this.app.workspace.openLinkText(fic.path, sourcePath || '', 'tab'); }
  async openFile(file) { await this.app.workspace.getLeaf('tab').openFile(file); }
  refreshViews() { for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) if (leaf.view && leaf.view.renderNow) leaf.view.renderNow(); }

  pathFor(fic, taken) {
    const folder = this.settings.ficsFolder;
    const free = (p) => !this.app.vault.getAbstractFileByPath(p) && !(taken && taken.has(p.toLowerCase()));
    const base = safeFileName(fic.title);
    let p = normalizePath(`${folder}/${base}.md`);
    if (free(p)) return p;
    const a = splitAuthors(fic.author)[0];
    if (a) { p = normalizePath(`${folder}/${safeFileName(`${base} (${a})`)}.md`); if (free(p)) return p; }
    for (let i = 2; ; i++) { p = normalizePath(`${folder}/${base} (${i}).md`); if (free(p)) return p; }
  }

  async createFic(fic) {
    await this.ensureFolder(this.settings.ficsFolder);
    return this.app.vault.create(this.pathFor(fic), buildFicNote({ ...fic, added: fic.added || todayStr() }));
  }

  async setTier(fic, tier) {
    await this.app.fileManager.processFrontMatter(fic.file, (fm) => { fm.my_rating = fm.my_rating === tier ? '' : tier; });
  }

  async startReading(fic) {
    await this.app.fileManager.processFrontMatter(fic.file, (fm) => { fm.status = 'reading'; fm.started = todayStr(); });
    await this.appendLog(fic, `${todayStr()} · Started`);
    new Notice(`Reading ${fic.title}`);
  }

  async markRead(fic, date, tier, thoughts) {
    await this.app.fileManager.processFrontMatter(fic.file, (fm) => {
      const list = toList(fm.read).map(toDateStr).filter(Boolean);
      if (!list.includes(date)) list.push(date);
      fm.read = list.sort();
      fm.status = 'read';
      fm.started = null;
      if (tier !== undefined && tier !== null) fm.my_rating = tier;
    });
    const t = (thoughts || '').trim().replace(/\s*\n+\s*/g, ' ');
    await this.appendLog(fic, `${date} · Finished${t ? `. ${t}` : ''}`);
    new Notice(`${fic.title}: read`);
  }

  async logListen(fic, date) {
    await this.app.fileManager.processFrontMatter(fic.file, (fm) => {
      const list = toList(fm.listened).map(toDateStr).filter(Boolean);
      if (!list.includes(date)) list.push(date);
      fm.listened = list.sort();
      fm.podfic = true;
    });
    await this.appendLog(fic, `${date} · Listened to the podfic`);
    new Notice(`Logged a listen: ${fic.title}`);
  }

  async appendLog(fic, line) {
    await this.app.vault.process(fic.file, (data) => {
      const m = /^##[ \t]+Reading log[ \t]*$/im.exec(data);
      if (!m) return `${data.replace(/\s*$/, '')}\n\n## Reading log\n\n- ${line}\n`;
      const start = m.index + m[0].length;
      const next = /^#{1,2}\s/m.exec(data.slice(start));
      const end = next ? start + next.index : data.length;
      const after = data.slice(end);
      return `${data.slice(0, end).replace(/\s*$/, '')}\n- ${line}\n${after ? `\n${after}` : ''}`;
    });
  }

  async runImport(plan, source) {
    await this.ensureFolder(this.settings.ficsFolder);
    this.busy = true;
    const total = plan.fresh.length + plan.updates.length;
    const note = new Notice(`Importing… 0 of ${fmtNum(total)}`, 0);
    const taken = new Set();
    const created = [];
    let i = 0;
    try {
      for (const f of plan.fresh) {
        const path = this.pathFor(f, taken);
        taken.add(path.toLowerCase());
        try { await this.app.vault.create(path, buildFicNote({ ...f, added: f.added || todayStr() })); created.push(path); } catch (e) { console.error('Brainrot: could not create', path, e); }
        if (++i % 20 === 0) { note.setMessage(`Importing… ${fmtNum(i)} of ${fmtNum(total)}`); await sleep(0); }
      }
      for (const u of plan.updates) {
        await this.app.fileManager.processFrontMatter(u.fic.file, (fm) => { Object.assign(fm, u.patch); });
        if (++i % 20 === 0) { note.setMessage(`Importing… ${fmtNum(i)} of ${fmtNum(total)}`); await sleep(0); }
      }
      for (const x of plan.fills) {
        await this.app.vault.process(x.fic.file, (data) => fillEmptySection(fillEmptySection(data, 'Summary', x.summary), 'Notes', x.notes));
      }
    } finally { note.hide(); this.busy = false; }
    await this.ensureFolder(this.settings.importsFolder);
    const now = new Date();
    const name = `${todayStr(now)} ${pad(now.getHours())}${pad(now.getMinutes())} ${safeFileName(String(source || 'import').replace(/\.(csv|tsv|txt)$/i, ''))}`;
    const log = [`# Import, ${niceDate(todayStr())}`, '', `Source: ${source || 'pasted CSV'}`, '',
      `- New fics: ${fmtNum(created.length)}`, `- Updated: ${fmtNum(plan.updates.length)}`, `- Already up to date: ${fmtNum(plan.same.length)}`, ''];
    if (created.length) log.push('## New', '', ...created.map((p) => `- [[${p.replace(/\.md$/, '')}|${p.split('/').pop().replace(/\.md$/, '')}]]`), '');
    if (plan.updates.length) log.push('## Updated', '', ...plan.updates.map((u) => `- [[${u.fic.path.replace(/\.md$/, '')}|${u.fic.title}]]: ${Object.keys(u.patch).join(', ')}`), '');
    const lf = await this.writeFile(`${this.settings.importsFolder}/${name}.md`, log.join('\n'));
    new Notice(`Imported: ${fmtNum(created.length)} new, ${fmtNum(plan.updates.length)} updated`);
    window.setTimeout(() => this.refreshViews(), 800);
    return lf;
  }

  async yearReport(year) {
    year = String(year).trim();
    { const why = reportYearProblem(year); if (why) { new Notice(why); return; } }
    const fics = this.getFics();
    const thoughts = {};
    for (const f of fics) if (f.read.some((d) => d.startsWith(year))) thoughts[f.path] = readingLogThoughts(await this.app.vault.cachedRead(f.file));
    const report = buildYearReport(fics, year, thoughts, this.settings.tiers);
    await this.ensureFolder(this.settings.exportsFolder);
    const md = await this.writeFile(`${this.settings.exportsFolder}/${year} Brainrot Wrapped.md`, renderReportMarkdown(report));
    await this.writeFile(`${this.settings.exportsFolder}/${year} Brainrot Wrapped.json`, JSON.stringify(report, null, 2));
    this.openFile(md);
  }

  async exportAll() {
    await this.ensureFolder(this.settings.exportsFolder);
    const f = await this.writeFile(`${this.settings.exportsFolder}/${todayStr()} Fics.csv`, exportCsv(this.getFics()));
    new Notice(`Exported to ${f.path}`);
  }

  async fetchAo3(url) {
    const id = workIdOf(url);
    if (!id) throw new Error('That is not an AO3 work link.');
    const res = await requestUrl({ url: `https://archiveofourown.org/works/${id}?view_adult=true`, throw: false });
    const work = res.status === 200 ? parseAo3Work(res.text, url) : null;
    if (!work) throw new Error('AO3 did not send the work. It may be locked to logged-in users. Fill in the fields by hand.');
    return work;
  }

  async activateView(tab) {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) { leaf = workspace.getLeaf('tab'); await leaf.setViewState({ type: VIEW_TYPE, active: true }); }
    await workspace.revealLeaf(leaf);
    if (tab && leaf.view && leaf.view.showTab) leaf.view.showTab(tab);
  }
}

/* ------------------------------------------------------------------ */
/* Shared UI bits                                                     */
/* ------------------------------------------------------------------ */

function chip(parent, text, cls) { return parent.createSpan({ cls: `br-chip ${cls || ''}`, text }); }
function tierClass(plugin, tier) { const i = plugin.settings.tiers.indexOf(tier); return i >= 0 ? `br-tier-${Math.min(i, 2)}` : ''; }
function selectEl(parent, options, value, onChange) {
  const sel = parent.createEl('select', { cls: 'dropdown' });
  for (const [v, l] of options) sel.createEl('option', { value: v, text: l });
  sel.value = value;
  sel.addEventListener('change', () => onChange(sel.value));
  return sel;
}
function datalist(parent, id, values) {
  const dl = parent.createEl('datalist', { attr: { id } });
  for (const v of values) dl.createEl('option', { attr: { value: v } });
}
function ficMeta(f) {
  return [f.fandoms.slice(0, 2).join(', '), f.ships[0], fmtWords(f.words), RATING_SHORT[f.rating] || f.rating,
    f.complete === false ? 'WIP' : ''].filter(Boolean).join(' · ');
}

/* ------------------------------------------------------------------ */
/* Main view                                                          */
/* ------------------------------------------------------------------ */

class BrainrotView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.tab = 'library';
    this.filter = { status: 'any', query: '' };
    this.sort = 'title';
    this.shown = plugin.settings.pageSize;
    this.browseDim = 'fandom';
    this.browseQuery = '';
    this.browseShown = 200;
    this.year = '';
    this.render = debounce(() => { if (!this.plugin.busy) this.renderNow(); }, 400, true);
  }
  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return 'Brainrot'; }
  getIcon() { return 'sparkles'; }

  async onOpen() {
    this.registerEvent(this.app.metadataCache.on('changed', (file) => { if (this.plugin.inFolder(file.path)) this.render(); }));
    this.registerEvent(this.app.vault.on('delete', () => this.render()));
    this.registerEvent(this.app.vault.on('rename', () => this.render()));
    this.renderNow();
  }
  showTab(t) { this.tab = t; this.renderNow(); }

  setFilter(patch) {
    this.filter = { status: 'any', query: '', ...patch };
    this.shown = this.plugin.settings.pageSize;
    this.tab = 'library';
    this.renderNow();
  }

  renderNow() {
    const c = this.contentEl, p = this.plugin;
    const scroll = c.scrollTop;
    c.empty();
    c.addClass('br-view');
    const fics = p.getFics();
    this.fics = fics;

    const head = c.createDiv({ cls: 'br-head' });
    const t = head.createDiv();
    t.createEl('h2', { text: 'Brainrot' });
    const read = fics.filter((f) => f.status === 'read' || f.read.length).length;
    const words = fics.reduce((n, f) => n + (f.words || 0) * Math.max(1, f.read.length), 0);
    t.createDiv({ cls: 'br-muted', text: `${fmtNum(fics.length)} fics · ${fmtNum(read)} read${words ? ` · ${fmtWords(fics.filter((f) => f.read.length).reduce((n, f) => n + f.words * f.read.length, 0))} logged` : ''}` });
    const acts = head.createDiv({ cls: 'br-head-actions' });
    acts.createEl('button', { cls: 'mod-cta', text: 'Add fic' }).addEventListener('click', () => new AddFicModal(p).open());
    acts.createEl('button', { text: 'Import' }).addEventListener('click', () => new ImportModal(p).open());

    const tabs = c.createDiv({ cls: 'br-tabs' });
    for (const [k, l] of [['library', 'Library'], ['browse', 'Browse'], ['reading', 'Reading'], ['podfics', 'Podfics']]) {
      tabs.createEl('button', { cls: `br-tab ${this.tab === k ? 'is-active' : ''}`, text: l }).addEventListener('click', () => { this.tab = k; this.renderNow(); });
    }
    if (!fics.length) {
      const e = c.createDiv({ cls: 'br-empty-state' });
      e.createEl('p', { text: 'No fics yet.' });
      e.createEl('p', { cls: 'br-muted', text: 'Paste an AO3 link into Add fic, or import a CSV from Calibre or a spreadsheet.' });
      const r = e.createDiv({ cls: 'br-actions' });
      r.createEl('button', { cls: 'mod-cta', text: 'Import fics' }).addEventListener('click', () => new ImportModal(p).open());
      r.createEl('button', { text: 'Add a fic' }).addEventListener('click', () => new AddFicModal(p).open());
      return;
    }
    if (this.tab === 'library') this.renderLibrary(c, fics);
    else if (this.tab === 'browse') this.renderBrowse(c, fics);
    else if (this.tab === 'reading') this.renderReading(c, fics);
    else this.renderPodfics(c, fics);
    c.scrollTop = scroll;
  }

  row(parent, f, extra) {
    const p = this.plugin;
    const row = parent.createDiv({ cls: 'br-row' });
    const body = row.createDiv({ cls: 'br-row-body' });
    body.createEl('a', { cls: 'br-title', text: f.title, href: '#' }).addEventListener('click', (e) => { e.preventDefault(); p.openFic(f); });
    if (f.author) {
      const au = body.createDiv({ cls: 'br-author' });
      splitAuthors(f.author).forEach((name, i) => {
        if (i) au.appendText(', ');
        au.createEl('a', { cls: 'br-author-link', text: name, href: '#' }).addEventListener('click', (e) => { e.preventDefault(); this.setFilter({ author: name }); });
      });
    }
    const meta = extra || ficMeta(f);
    if (meta) body.createDiv({ cls: 'br-meta', text: meta });
    const tags = row.createDiv({ cls: 'br-row-tags' });
    if (f.tier) chip(tags, f.tier, tierClass(p, f.tier));
    if (f.status) chip(tags, STATUS_LABEL[f.status], `br-s-${f.status}`);
    if (f.read.length > 1) chip(tags, `×${f.read.length}`);
    if (f.podfic) chip(tags, hasListened(f) ? 'Podfic ✓' : 'Podfic', 'br-podfic');
    return row;
  }

  renderLibrary(c, fics) {
    const p = this.plugin, f = this.filter;
    const bar = c.createDiv({ cls: 'br-filterbar' });
    const search = bar.createEl('input', { type: 'search', cls: 'br-search', attr: { placeholder: 'Search titles, authors, ships, tags' } });
    search.value = f.query || '';
    const opt = (all, list) => [['', all], ...list.map((v) => [v, v])];
    const set = (k) => (v) => { f[k] = v; this.shown = p.settings.pageSize; this.renderNow(); };
    selectEl(bar, [['any', 'Any status'], ...STATUSES.map((s) => [s, STATUS_LABEL[s]])], f.status || 'any', set('status'));
    selectEl(bar, [['', 'Any rating of mine'], ['__any', 'Rated by me'], ['__none', 'Not rated yet'], ...p.settings.tiers.map((x) => [x, x])], f.tier || '', set('tier'));
    selectEl(bar, opt('Any fandom', p.values(fics, 'fandom')), f.fandom || '', set('fandom'));
    selectEl(bar, opt('Any relationship', p.values(fics, 'ship').slice(0, 400)), f.ship || '', set('ship'));
    selectEl(bar, opt('Any AO3 rating', AO3_RATINGS), f.rating || '', set('rating'));
    selectEl(bar, [['', 'Any length'], ...LENGTHS.map(([k, l]) => [k, l])], f.length || '', set('length'));
    selectEl(bar, [['', 'Podfic or not'], ['yes', 'Has a podfic'], ['not yet', 'Podfic, not heard'], ['listened', 'Podfic, listened']], f.podfic || '', set('podfic'));
    const libs = p.values(fics, 'library');
    if (libs.length > 1) selectEl(bar, opt('Any library', libs), f.library || '', set('library'));

    const active = ['author', 'character', 'tag', 'series', 'year'].filter((k) => f[k]);
    if (active.length) {
      const chips = c.createDiv({ cls: 'br-chips' });
      for (const k of active) chips.createEl('button', { cls: 'br-chip is-active', text: `${k === 'year' ? 'Read in' : k[0].toUpperCase() + k.slice(1) + ':'} ${f[k]} ×` })
        .addEventListener('click', () => { f[k] = ''; this.renderNow(); });
    }

    const sorters = {
      title: byTitle, author: byAuthor,
      words: (a, b) => (b.words || 0) - (a.words || 0) || byTitle(a, b),
      read: (a, b) => lastRead(b).localeCompare(lastRead(a)) || byTitle(a, b),
      added: (a, b) => (b.added || '').localeCompare(a.added || '') || byTitle(a, b),
    };
    const base = fics.filter((x) => matchesFilter(x, { ...f, query: '' })).sort(sorters[this.sort] || byTitle);
    const tools = c.createDiv({ cls: 'br-toolbar' });
    const count = tools.createSpan({ cls: 'br-count' });
    const right = tools.createDiv({ cls: 'br-toolbar-right' });
    right.createSpan({ cls: 'br-muted', text: 'Sort' });
    selectEl(right, [['title', 'Title'], ['author', 'Author'], ['words', 'Longest first'], ['read', 'Recently read'], ['added', 'Recently added']], this.sort, (v) => { this.sort = v; this.renderNow(); });

    const box = c.createDiv({ cls: 'br-list' });
    const draw = () => {
      box.empty();
      const list = f.query ? base.filter((x) => matchesFilter(x, { query: f.query })) : base;
      count.setText(`${fmtNum(list.length)} ${list.length === 1 ? 'fic' : 'fics'}${list.length ? ` · ${fmtWords(list.reduce((n, x) => n + (x.words || 0), 0))}` : ''}`);
      for (const x of list.slice(0, this.shown)) this.row(box, x);
      if (!list.length) box.createDiv({ cls: 'br-empty', text: 'No fics match.' });
      if (list.length > this.shown) {
        box.createEl('button', { cls: 'br-more', text: `Show more (${fmtNum(list.length - this.shown)} left)` }).addEventListener('click', () => { this.shown += p.settings.pageSize; draw(); });
      }
    };
    search.addEventListener('input', debounce(() => { f.query = search.value; this.shown = p.settings.pageSize; draw(); }, 200, true));
    draw();
  }

  renderBrowse(c, fics) {
    const bar = c.createDiv({ cls: 'br-chips' });
    for (const [k, d] of Object.entries(DIMENSIONS)) {
      bar.createEl('button', { cls: `br-chip ${this.browseDim === k ? 'is-active' : ''}`, text: d.label })
        .addEventListener('click', () => { this.browseDim = k; this.browseQuery = ''; this.browseShown = 200; this.renderNow(); });
    }
    const search = c.createEl('input', { type: 'search', cls: 'br-search br-wide', attr: { placeholder: `Find ${DIMENSIONS[this.browseDim].label.toLowerCase()}` } });
    search.value = this.browseQuery;
    const values = tally(fics, this.browseDim);
    if (this.browseDim === 'year') values.sort((a, b) => b.value.localeCompare(a.value));
    else if (this.browseDim === 'length') values.sort((a, b) => LENGTHS.findIndex((l) => l[1] === a.value) - LENGTHS.findIndex((l) => l[1] === b.value));
    else values.sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
    c.createDiv({ cls: 'br-count', text: `${fmtNum(values.length)} ${DIMENSIONS[this.browseDim].label.toLowerCase()}` });
    const listEl = c.createDiv({ cls: 'br-browse' });
    const draw = () => {
      listEl.empty();
      const q = foldText(this.browseQuery);
      const shown = q ? values.filter((v) => foldText(v.value).includes(q)) : values;
      for (const v of shown.slice(0, this.browseShown)) {
        const row = listEl.createDiv({ cls: 'br-browse-row' });
        row.createEl('a', { text: v.value, href: '#' }).addEventListener('click', (e) => { e.preventDefault(); this.applyBrowse(v.value); });
        row.createSpan({ cls: 'br-muted', text: `${fmtNum(v.count)}${v.read ? ` · ${fmtNum(v.read)} read` : ''}` });
      }
      if (shown.length > this.browseShown) listEl.createEl('button', { cls: 'br-more', text: `Show more (${fmtNum(shown.length - this.browseShown)} left)` }).addEventListener('click', () => { this.browseShown += 200; draw(); });
      if (!shown.length) listEl.createDiv({ cls: 'br-empty', text: 'Nothing matches.' });
    };
    search.addEventListener('input', debounce(() => { this.browseQuery = search.value; this.browseShown = 200; draw(); }, 150, true));
    draw();
  }

  applyBrowse(value) {
    const d = this.browseDim;
    if (d === 'length') return this.setFilter({ length: (LENGTHS.find((l) => l[1] === value) || [''])[0] });
    if (d === 'tier') return this.setFilter({ tier: value });
    const key = { fandom: 'fandom', ship: 'ship', character: 'character', author: 'author', tag: 'tag', series: 'series', rating: 'rating', library: 'library', year: 'year' }[d];
    return this.setFilter({ [key]: value });
  }

  renderReading(c, fics) {
    const p = this.plugin;
    const now = fics.filter((f) => f.status === 'reading').sort(byTitle);
    c.createDiv({ cls: 'br-label', text: `Reading now · ${now.length}` });
    if (!now.length) c.createDiv({ cls: 'br-empty', text: 'Nothing in progress. "Start reading" on any fic puts it here.' });
    for (const f of now) {
      const row = this.row(c, f, [ficMeta(f), f.started && `since ${niceDate(f.started)}`].filter(Boolean).join(' · '));
      row.createEl('button', { cls: 'mod-cta', text: 'Finished' }).addEventListener('click', () => new ReadModal(p, f).open());
    }
    const years = new Map();
    for (const f of fics) for (const d of f.read) {
      const y = yearOf(d);
      if (!years.has(y)) years.set(y, { fics: 0, words: 0 });
      years.get(y).fics++; years.get(y).words += f.words || 0;
    }
    const ys = [...years.keys()].sort().reverse();
    c.createDiv({ cls: 'br-label', text: 'Read by year' });
    if (!ys.length) { c.createDiv({ cls: 'br-empty', text: 'No read dates yet. "Mark read" logs the date. Rereads get their own date.' }); return; }
    if (!this.year || !years.has(this.year)) this.year = ys[0];
    const chips = c.createDiv({ cls: 'br-chips' });
    for (const y of ys) chips.createEl('button', { cls: `br-chip ${this.year === y ? 'is-active' : ''}`, text: `${y} · ${years.get(y).fics}` }).addEventListener('click', () => { this.year = y; this.renderNow(); });
    const entries = [];
    for (const f of fics) for (const d of f.read) if (d.startsWith(this.year)) entries.push({ d, f });
    entries.sort((a, b) => b.d.localeCompare(a.d));
    const head = c.createDiv({ cls: 'br-toolbar' });
    head.createSpan({ cls: 'br-count', text: `${entries.length} read in ${this.year} · ${fmtWords(years.get(this.year).words)}` });
    if (!reportYearProblem(this.year)) head.createEl('button', { cls: 'mod-cta', text: 'Year-end report' }).addEventListener('click', () => p.yearReport(this.year));
    for (const { d, f } of entries.slice(0, 500)) {
      const row = this.row(c, f);
      row.createSpan({ cls: 'br-muted br-date', text: /^\d{4}$/.test(d) ? 'year only' : niceDate(d) });
    }
  }

  renderPodfics(c, fics) {
    const p = this.plugin;
    const all = fics.filter((f) => f.podfic);
    const notYet = all.filter((f) => !hasListened(f)).sort(byTitle);
    const heard = all.filter((f) => hasListened(f)).sort((a, b) => (b.listened.slice(-1)[0] || '').localeCompare(a.listened.slice(-1)[0] || '') || byTitle(a, b));
    c.createDiv({ cls: 'br-label', text: `Not heard yet · ${notYet.length}` });
    if (!all.length) c.createDiv({ cls: 'br-empty', text: 'No podfics yet. Add a podfic link or narrator on a fic, or import a sheet with a Podfic column.' });
    for (const f of notYet) {
      const row = this.row(c, f, [f.narrator && `read by ${f.narrator}`, ficMeta(f)].filter(Boolean).join(' · '));
      if (f.podficLink) row.createEl('a', { cls: 'br-ext', text: 'Listen', href: f.podficLink, attr: { target: '_blank', rel: 'noopener' } });
      row.createEl('button', { text: 'Log a listen' }).addEventListener('click', () => new ListenModal(p, f).open());
    }
    c.createDiv({ cls: 'br-label', text: `Listened · ${heard.length}` });
    for (const f of heard) {
      const row = this.row(c, f, [f.narrator && `read by ${f.narrator}`, ficMeta(f)].filter(Boolean).join(' · '));
      row.createSpan({ cls: 'br-muted br-date', text: f.listened.length ? niceDate(f.listened[f.listened.length - 1]) : 'listened' });
    }
  }
}

/* ------------------------------------------------------------------ */
/* Code block: ```brainrot```                                           */
/* ------------------------------------------------------------------ */

class BrainrotBlock extends MarkdownRenderChild {
  constructor(el, plugin, source, sourcePath) {
    super(el);
    this.plugin = plugin;
    this.sourcePath = sourcePath;
    this.opts = {};
    for (const line of source.split('\n')) { const m = line.match(/^\s*([\w ]+?)\s*:\s*(.*?)\s*$/); if (m) this.opts[m[1].toLowerCase()] = m[2]; }
    this.render = debounce(() => { if (!this.plugin.busy) this.renderNow(); }, 300, true);
  }
  onload() {
    this.registerEvent(this.plugin.app.metadataCache.on('changed', (f) => { if (f.path === this.sourcePath || this.opts.show !== 'fic') this.render(); }));
    this.renderNow();
  }

  list(el, fics) {
    const p = this.plugin;
    if (!fics.length) { el.createDiv({ cls: 'br-empty', text: 'None yet.' }); return; }
    const ul = el.createEl('ul', { cls: 'br-plain' });
    for (const f of fics.slice(0, 500)) {
      const li = ul.createEl('li');
      li.createEl('a', { cls: 'internal-link', text: f.title, href: f.path, attr: { 'data-href': f.path } }).addEventListener('click', (e) => { e.preventDefault(); p.openFic(f, this.sourcePath); });
      const extra = [f.author, f.tier].filter(Boolean).join(' · ');
      if (extra) li.createSpan({ cls: 'br-muted', text: ` · ${extra}` });
    }
    if (fics.length > 500) el.createDiv({ cls: 'br-muted', text: `…and ${fmtNum(fics.length - 500)} more` });
  }

  renderNow() {
    const el = this.containerEl, p = this.plugin, o = this.opts;
    el.empty();
    el.addClass('br-block');
    const show = (o.show || '').toLowerCase();
    const fics = p.getFics();

    if (show === 'fic') {
      const f = fics.find((x) => x.path === this.sourcePath);
      if (!f) return;
      const bar = el.createDiv({ cls: 'br-ficbar' });
      const top = bar.createDiv({ cls: 'br-ficbar-row' });
      if (f.status) chip(top, STATUS_LABEL[f.status], `br-s-${f.status}`);
      for (const t of p.settings.tiers) {
        const b = top.createEl('button', { cls: `br-tier-btn ${f.tier === t ? `is-on ${tierClass(p, t)}` : ''}`, text: t, attr: { 'aria-pressed': String(f.tier === t) } });
        b.addEventListener('click', () => p.setTier(f, t));
      }
      const meta = [f.rating, fmtWords(f.words), f.chapters && `${f.chapters} chapters`, f.complete === false ? 'WIP' : '', f.series].filter(Boolean).join(' · ');
      if (meta) bar.createDiv({ cls: 'br-muted', text: meta });
      if (f.read.length) bar.createDiv({ cls: 'br-muted', text: `Read ${f.read.map(niceDate).join(', ')}` });
      const acts = bar.createDiv({ cls: 'br-ficbar-row' });
      if (f.link) acts.createEl('a', { cls: 'br-ext', text: 'Open on AO3', href: f.link, attr: { target: '_blank', rel: 'noopener' } });
      const btn = (label, fn, cta) => acts.createEl('button', { cls: cta ? 'mod-cta' : '', text: label }).addEventListener('click', fn);
      if (f.status !== 'reading') btn(f.read.length ? 'Read again' : 'Start reading', () => p.startReading(f));
      btn('Mark read', () => new ReadModal(p, f).open(), f.status === 'reading');
      if (f.podficLink) acts.createEl('a', { cls: 'br-ext', text: f.narrator ? `Podfic by ${f.narrator}` : 'Podfic', href: f.podficLink, attr: { target: '_blank', rel: 'noopener' } });
      if (f.podfic) btn('Log a listen', () => new ListenModal(p, f).open());
      const tagLine = (label, list) => { if (list.length) { const d = bar.createDiv({ cls: 'br-taglist' }); d.createSpan({ cls: 'br-k', text: label }); d.appendText(list.join(', ')); } };
      tagLine('Fandom', f.fandoms); tagLine('Relationships', f.ships); tagLine('Characters', f.characters); tagLine('Tags', f.tags);
      const more = (label, list) => {
        if (!list.length) return;
        const det = el.createEl('details', { cls: 'br-more-by' });
        det.createEl('summary', { text: `${label} · ${list.length}` });
        this.list(det, list.sort(byTitle));
      };
      const mine = new Set(splitAuthors(f.author).map((a) => a.toLowerCase()));
      if (mine.size) more(`More by ${splitAuthors(f.author).join(', ')}`, fics.filter((x) => x.path !== f.path && splitAuthors(x.author).some((a) => mine.has(a.toLowerCase()))));
      if (f.ships[0]) more(`More ${f.ships[0]}`, fics.filter((x) => x.path !== f.path && x.ships.some((s) => s.toLowerCase() === f.ships[0].toLowerCase())));
      return;
    }

    let list = null;
    if (o.fandom) list = fics.filter((f) => matchesFilter(f, { fandom: o.fandom }));
    else if (o.relationship || o.ship) list = fics.filter((f) => matchesFilter(f, { ship: o.relationship || o.ship }));
    else if (o.author) list = fics.filter((f) => matchesFilter(f, { author: o.author }));
    else if (o.tag) list = fics.filter((f) => matchesFilter(f, { tag: o.tag }));
    else if (o.tier) list = fics.filter((f) => matchesFilter(f, { tier: o.tier }));
    else if (show === 'reading') list = fics.filter((f) => f.status === 'reading');
    else if (show === 'podfics') list = fics.filter((f) => f.podfic && !hasListened(f));
    else if (show === 'year' || o.year) {
      const y = o.year || String(new Date().getFullYear());
      list = fics.filter((f) => f.read.some((d) => d.startsWith(y)));
    }
    if (!list) { el.createDiv({ cls: 'br-empty', text: 'brainrot: use show: fic, reading, podfics or year, or fandom:, relationship:, author:, tag:, tier: or year:.' }); return; }
    el.createDiv({ cls: 'br-label', text: `${fmtNum(list.length)} ${list.length === 1 ? 'fic' : 'fics'}` });
    this.list(el, list.sort(byTitle));
  }
}

/* ------------------------------------------------------------------ */
/* Modals                                                             */
/* ------------------------------------------------------------------ */

class AddFicModal extends Modal {
  constructor(plugin) { super(plugin.app); this.plugin = plugin; }
  onOpen() {
    const c = this.contentEl, p = this.plugin;
    c.addClass('br-modal');
    this.titleEl.setText('Add a fic');
    const fics = p.getFics();
    const index = new Map();
    for (const f of fics) for (const k of ficKeys(f)) index.set(k, f);
    const d = { title: '', author: '', fandoms: [], ships: [], characters: [], tags: [], rating: '', words: 0, chapters: '', series: '', complete: null,
      status: 'unread', tier: '', readDate: todayStr(), podficLink: '', narrator: '', link: '', workId: '', summary: '', notes: '' };
    const uid = Math.random().toString(36).slice(2, 7);
    datalist(c, `br-fandoms-${uid}`, p.values(fics, 'fandom').slice(0, 500));
    datalist(c, `br-ships-${uid}`, p.values(fics, 'ship').slice(0, 1000));
    const inputs = {};
    const warn = c.createDiv({ cls: 'br-warn' });
    const check = () => {
      warn.empty();
      const hit = ficKeys(d).map((k) => index.get(k)).find(Boolean);
      warn.toggleClass('is-on', !!hit);
      if (hit) {
        warn.appendText('Already in Brainrot: ');
        warn.createEl('a', { text: hit.title, href: '#' }).addEventListener('click', (e) => { e.preventDefault(); p.openFic(hit); this.close(); });
      }
    };
    const status = c.createDiv({ cls: 'br-muted' });
    new Setting(c).setName('AO3 link').setDesc('Paste the link, then Fetch to fill in the rest.')
      .addText((t) => { inputs.link = t; t.setPlaceholder('https://archiveofourown.org/works/…').onChange((v) => { d.link = v.trim(); d.workId = workIdOf(v); check(); }); window.setTimeout(() => t.inputEl.focus(), 50); })
      .addButton((b) => b.setButtonText('Fetch').onClick(async () => {
        status.setText('Asking AO3…');
        try {
          const w = await p.fetchAo3(d.link);
          Object.assign(d, w);
          for (const [k, v] of [['title', w.title], ['author', w.author], ['fandoms', w.fandoms.join(', ')], ['ships', w.ships.join(', ')], ['tags', w.tags.join(', ')], ['words', String(w.words || '')]]) if (inputs[k]) inputs[k].setValue(v);
          if (inputs.rating) inputs.rating.setValue(w.rating || '');
          status.setText(`Filled in from AO3: ${w.title}`);
          check();
        } catch (e) { status.setText(e.message || "Couldn't reach AO3."); }
      }));
    c.appendChild(status);
    const text = (name, key, desc, list) => new Setting(c).setName(name).setDesc(desc || '').addText((t) => {
      inputs[key] = t;
      if (list) t.inputEl.setAttr('list', list);
      t.onChange((v) => { d[key] = ['fandoms', 'ships', 'characters', 'tags'].includes(key) ? toList(v) : key === 'words' ? toWords(v) : v.trim(); if (key === 'title' || key === 'author') check(); });
    });
    text('Title', 'title');
    text('Author', 'author');
    c.appendChild(warn);
    text('Fandom', 'fandoms', 'Comma-separated.', `br-fandoms-${uid}`);
    text('Relationships', 'ships', 'Comma-separated.', `br-ships-${uid}`);
    new Setting(c).setName('AO3 rating').addDropdown((dd) => { inputs.rating = dd; dd.addOption('', '—'); AO3_RATINGS.forEach((r) => dd.addOption(r, r)); dd.onChange((v) => { d.rating = v; }); });
    text('Words', 'words');
    const det = c.createEl('details', { cls: 'br-extra' });
    det.createEl('summary', { text: 'Characters, tags and podfic' });
    const textIn = (parent, name, key) => new Setting(parent).setName(name).addText((t) => { inputs[key] = t; t.onChange((v) => { d[key] = ['characters', 'tags'].includes(key) ? toList(v) : v.trim(); }); });
    textIn(det, 'Characters', 'characters');
    textIn(det, 'Tags', 'tags');
    textIn(det, 'Podfic link', 'podficLink');
    textIn(det, 'Narrator', 'narrator');

    let readRow;
    new Setting(c).setName('Status').addDropdown((dd) => {
      STATUSES.forEach((s) => dd.addOption(s, STATUS_LABEL[s]));
      dd.setValue(d.status).onChange((v) => { d.status = v; readRow.settingEl.toggleClass('br-hidden', v !== 'read'); });
    });
    readRow = new Setting(c).setName('Date read').setDesc('Or just a year.').addText((t) => t.setValue(d.readDate).onChange((v) => { d.readDate = toDateStr(v); }));
    readRow.settingEl.toggleClass('br-hidden', true);
    new Setting(c).setName('My rating').addDropdown((dd) => { dd.addOption('', '—'); p.settings.tiers.forEach((x) => dd.addOption(x, x)); dd.onChange((v) => { d.tier = v; }); });
    c.createDiv({ cls: 'br-label', text: 'Notes' });
    const notes = c.createEl('textarea', { cls: 'br-textarea', attr: { rows: '3', placeholder: 'Focus, POV, why it got you' } });
    notes.addEventListener('input', () => { d.notes = notes.value; });

    const save = async (again) => {
      if (!d.title) { new Notice('A title is the one thing Brainrot needs'); return; }
      if (d.workId && !d.link) d.link = workUrl(d.workId);
      const fic = { ...d, podfic: !!(d.podficLink || d.narrator), read: d.status === 'read' && d.readDate ? [d.readDate] : [], listened: [] };
      const file = await p.createFic(fic);
      for (const k of ficKeys(fic)) index.set(k, { ...fic, path: file.path });
      new Notice(`Added ${d.title}`);
      if (again) { this.contentEl.empty(); this.onOpen(); } else this.close();
    };
    new Setting(c).addButton((b) => b.setButtonText('Add and add another').onClick(() => save(true))).addButton((b) => b.setButtonText('Add fic').setCta().onClick(() => save(false)));
  }
  onClose() { this.contentEl.empty(); }
}

class ReadModal extends Modal {
  constructor(plugin, fic) { super(plugin.app); this.plugin = plugin; this.fic = fic; }
  onOpen() {
    const c = this.contentEl, p = this.plugin;
    c.addClass('br-modal');
    this.titleEl.setText(`Finished ${this.fic.title}`);
    let date = todayStr(), tier = this.fic.tier, thoughts = '';
    new Setting(c).setName('Date read').setDesc('Or just a year, like 2019.').addText((t) => t.setValue(date).onChange((v) => { date = toDateStr(v); }));
    new Setting(c).setName('My rating').addDropdown((dd) => { dd.addOption('', '—'); p.settings.tiers.forEach((x) => dd.addOption(x, x)); dd.setValue(tier || '').onChange((v) => { tier = v; }); });
    c.createDiv({ cls: 'br-label', text: 'A line for the reading log (optional)' });
    const ta = c.createEl('textarea', { cls: 'br-textarea', attr: { rows: '3' } });
    ta.addEventListener('input', () => { thoughts = ta.value; });
    if (this.fic.read.length) c.createDiv({ cls: 'br-muted', text: `Also read: ${this.fic.read.map(niceDate).join(', ')}. This counts as a reread.` });
    new Setting(c).addButton((b) => b.setButtonText('Save').setCta().onClick(async () => {
      if (!date) { new Notice('Type a date or a year'); return; }
      this.close();
      await p.markRead(this.fic, date, tier, thoughts);
    }));
  }
  onClose() { this.contentEl.empty(); }
}

class ListenModal extends Modal {
  constructor(plugin, fic) { super(plugin.app); this.plugin = plugin; this.fic = fic; }
  onOpen() {
    const c = this.contentEl;
    c.addClass('br-modal');
    this.titleEl.setText(`Listened to ${this.fic.title}`);
    let date = todayStr();
    new Setting(c).setName('Date').setDesc('Or just a year.').addText((t) => t.setValue(date).onChange((v) => { date = toDateStr(v); }));
    new Setting(c).addButton((b) => b.setButtonText('Save').setCta().onClick(async () => {
      if (!date) { new Notice('Type a date or a year'); return; }
      this.close();
      await this.plugin.logListen(this.fic, date);
    }));
  }
  onClose() { this.contentEl.empty(); }
}

class ImportModal extends Modal {
  constructor(plugin) { super(plugin.app); this.plugin = plugin; this.text = ''; this.source = ''; this.library = ''; this.status = ''; }
  onOpen() { this.titleEl.setText('Import fics'); this.contentEl.addClass('br-modal', 'br-import'); this.step1(); }

  step1() {
    const c = this.contentEl;
    c.empty();
    c.createEl('p', { cls: 'br-muted', text: 'Import a CSV: the Calibre export script, a spreadsheet, or a Brainrot export. Fics already here are matched by AO3 work ID, then Calibre ID, then title and author. An import refreshes the AO3 details. Your status, rating and podfic notes only fill in where they are empty, and read dates are added, never removed.' });
    const input = c.createEl('input', { type: 'file', attr: { accept: '.csv,.tsv,.txt' } });
    input.addEventListener('change', async () => {
      const f = input.files && input.files[0];
      if (!f) return;
      this.text = await f.text();
      this.source = f.name;
      if (!this.library) { this.library = f.name.replace(/\.(csv|tsv|txt)$/i, '').replace(/[-_]+/g, ' ').replace(/\b(sheet|export|library|calibre)\b/gi, '').trim(); libIn.setValue(this.library); }
    });
    let libIn;
    new Setting(c).setName('Library name').setDesc('The Calibre library these fics came from, like Heated Rivalry. Used to match Calibre IDs.')
      .addText((t) => { libIn = t; t.setValue(this.library).onChange((v) => { this.library = v.trim(); }); });
    new Setting(c).setName('Status for new fics').setDesc('Used when a row does not say.').addDropdown((dd) => {
      dd.addOption('', 'Not set'); STATUSES.forEach((s) => dd.addOption(s, STATUS_LABEL[s]));
      dd.setValue(this.status).onChange((v) => { this.status = v; });
    });
    c.createDiv({ cls: 'br-label', text: 'Or paste CSV' });
    const ta = c.createEl('textarea', { cls: 'br-textarea', attr: { rows: '6' } });
    new Setting(c).addButton((b) => b.setButtonText('Preview').setCta().onClick(() => {
      if (!this.text && ta.value.trim()) { this.text = ta.value; this.source = 'pasted CSV'; }
      if (!this.text) { new Notice('Choose a file or paste a CSV'); return; }
      this.step2();
    }));
  }

  step2() {
    const c = this.contentEl, p = this.plugin;
    c.empty();
    const csv = parseCsv(this.text);
    const used = csv.headers.map((h) => [h, guessField(h)]);
    const cands = rowsToFics(csv, { library: this.library, status: this.status });
    if (!cands.length) { c.createEl('p', { text: 'No fics found. The file needs a Title column.' }); new Setting(c).addButton((b) => b.setButtonText('Back').onClick(() => this.step1())); return; }
    const plan = planImport(cands, p.getFics());
    const sum = c.createDiv({ cls: 'br-summary' });
    for (const [n, label, cls] of [[plan.fresh.length, 'new', 'is-new'], [plan.updates.length, 'to update'], [plan.same.length, 'already up to date']]) {
      const d = sum.createDiv({ cls: `br-stat ${cls || ''}` }); d.createDiv({ cls: 'br-stat-n', text: fmtNum(n) }); d.createDiv({ text: label });
    }
    c.createDiv({ cls: 'br-muted', text: `Columns used: ${used.filter(([, k]) => k).map(([h]) => h).join(', ') || 'none'}.` });
    const skipped = used.filter(([, k]) => !k).map(([h]) => h);
    if (skipped.length) c.createDiv({ cls: 'br-muted', text: `Ignored: ${skipped.join(', ')}.` });
    if (plan.updates.length) {
      const det = c.createEl('details', { cls: 'br-extra' });
      det.createEl('summary', { text: `Updates (${fmtNum(plan.updates.length)})` });
      const ul = det.createEl('ul', { cls: 'br-plain' });
      for (const u of plan.updates.slice(0, 200)) ul.createEl('li', { text: `${u.fic.title}: ${Object.keys(u.patch).join(', ')}` });
    }
    c.createDiv({ cls: 'br-label', text: `First ${Math.min(20, plan.fresh.length)} new fics` });
    const tbl = c.createEl('table', { cls: 'br-preview' });
    const hr = tbl.createEl('tr');
    ['Title', 'Author', 'Fandom', 'Words', 'Status', 'My rating'].forEach((h) => hr.createEl('th', { text: h }));
    for (const f of plan.fresh.slice(0, 20)) {
      const tr = tbl.createEl('tr');
      [f.title, f.author, (f.fandoms || []).join(', '), f.words ? fmtNum(f.words) : '', STATUS_LABEL[f.status || ''], f.tier].forEach((v) => tr.createEl('td', { text: v || '' }));
    }
    new Setting(c)
      .addButton((b) => b.setButtonText('Back').onClick(() => this.step1()))
      .addButton((b) => b.setButtonText(`Import ${fmtNum(plan.fresh.length)} new, update ${fmtNum(plan.updates.length)}`).setCta().onClick(async () => {
        this.close();
        const log = await p.runImport(plan, this.source);
        if (log) p.openFile(log);
      }));
  }
  onClose() { this.contentEl.empty(); }
}

class PromptModal extends Modal {
  constructor(app, title, value, onSubmit) { super(app); this.t = title; this.value = value || ''; this.onSubmit = onSubmit; }
  onOpen() {
    this.titleEl.setText(this.t);
    let input;
    const submit = () => { const v = input.getValue(); this.close(); this.onSubmit(v); };
    new Setting(this.contentEl).addText((t) => {
      input = t; t.setValue(this.value);
      t.inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
      window.setTimeout(() => { t.inputEl.focus(); t.inputEl.select(); }, 50);
    });
    new Setting(this.contentEl).addButton((b) => b.setButtonText('OK').setCta().onClick(submit));
  }
  onClose() { this.contentEl.empty(); }
}

/* ------------------------------------------------------------------ */
/* Settings                                                           */
/* ------------------------------------------------------------------ */

class BrainrotSettingTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const { containerEl } = this, s = this.plugin.settings, save = () => this.plugin.saveSettings();
    containerEl.empty();
    new Setting(containerEl).setName('Open Brainrot when the vault opens').addToggle((t) => t.setValue(s.openOnStartup).onChange(async (v) => { s.openOnStartup = v; await save(); }));
    new Setting(containerEl).setName('My rating levels').setDesc('Comma-separated, best first. The first one gets its own line in the year-end report.')
      .addText((t) => t.setValue(s.tiers.join(', ')).onChange(async (v) => { const l = toList(v); if (l.length) { s.tiers = l; await save(); } }));
    new Setting(containerEl).setName('Fics per page').addText((t) => t.setValue(String(s.pageSize)).onChange(async (v) => { const n = parseInt(v, 10); if (n >= 10) { s.pageSize = n; await save(); } }));
    new Setting(containerEl).setName('Folders').setHeading();
    const folder = (name, key) => new Setting(containerEl).setName(name).addText((t) => t.setValue(s[key]).onChange(async (v) => { s[key] = v.trim() || DEFAULT_SETTINGS[key]; await save(); }));
    folder('Fics', 'ficsFolder');
    folder('Import logs', 'importsFolder');
    folder('Exports', 'exportsFolder');
  }
}

module.exports = BrainrotPlugin;
module.exports.default = BrainrotPlugin;
module.exports.helpers = {
  todayStr, toDateStr, toList, truthy, normStatus, normComplete, normRating, toWords, workIdOf, splitAuthors, foldText, titleKey, libKey,
  fillEmptySection, lengthOf, ficFromFrontmatter, buildFicNote, parseAo3Work, parseCsv, guessField, rowsToFics, ficKeys, ficPatch, planImport,
  tally, matchesFilter, exportCsv, readingLogThoughts, buildYearReport, renderReportMarkdown, DIMENSIONS, DEFAULT_SETTINGS,
};

// Builds the whole profile page from profile.json and public GitHub data:
//
//   dist/header.svg    animated banner, text from profile.json
//   dist/stats.svg     hand-drawn overview
//   dist/stars.svg     hand-drawn star history
//   dist/timeline.svg  hand-drawn build log
//   dist/stars.json    star dates seen so far (read back on the next run)
//   README.md          the page itself
//
// Runs in .github/workflows/profile.yml every six hours and whenever
// profile.json changes. No dependencies: Node 18 or later.
//
//   GITHUB_TOKEN   token for the GitHub API (the workflow's own token is enough)
//   PROFILE_LOGIN  whose profile this is (default: the repository owner, or chchaoo)
//   OUT_DIR        where the pictures go (default: dist)

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, process.env.OUT_DIR || 'dist');
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
const NOW = new Date();

// ------------------------------------------------------------------
//  Settings
// ------------------------------------------------------------------

function loadConfig() {
  const file = join(ROOT, 'profile.json');
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { return {}; }
  try { return JSON.parse(text); }
  catch (e) {
    // Point at the line, which is what someone editing in the browser needs.
    const at = /position (\d+)/.exec(e.message);
    const line = at ? text.slice(0, +at[1]).split('\n').length : '?';
    console.error(`profile.json is not valid JSON (line ${line}): ${e.message}`);
    console.error('Check for a missing comma or quote near that line. The page was left unchanged.');
    process.exit(1);
  }
}

const CFG = loadConfig();
// The account comes from the repository owner, never from the banner text,
// so the name on the banner can be changed freely.
const LOGIN = process.env.PROFILE_LOGIN || process.env.GITHUB_REPOSITORY_OWNER || 'chchaoo';
const TZ = CFG.timezone || 'UTC';
const fill = (s) => String(s ?? '').replaceAll('{login}', LOGIN);
const OUT_URL = `https://raw.githubusercontent.com/${LOGIN}/${LOGIN}/output`;

// ------------------------------------------------------------------
//  Dates, shown in the time zone from profile.json
// ------------------------------------------------------------------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ymdFormat = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const localDay = (d) => ymdFormat.format(new Date(d));                     // 2026-09-24
function showDate(ymd) {                                                     // Sep 24, 2026 or Sep 2026
  const [y, m, d] = ymd.split('-').map(Number);
  return d ? `${MONTHS[m - 1]} ${d}, ${y}` : `${MONTHS[m - 1]} ${y}`;
}
function dayValue(ymd) { const [y, m, d] = ymd.split('-').map(Number); return Date.UTC(y, m - 1, d || 15); }
const timeFormat = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit' });
function localSeconds(d) { const [h, m, s] = timeFormat.format(new Date(d)).split(':').map(Number); return h * 3600 + m * 60 + s; }
const monthYear = (d) => showDate(localDay(d).slice(0, 7));

// ------------------------------------------------------------------
//  Data
// ------------------------------------------------------------------

async function graphql(query, variables) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { Authorization: `bearer ${TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': `${LOGIN}-profile` },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (!res.ok || json.errors) throw new Error(`GraphQL: ${res.status} ${JSON.stringify(json.errors || json)}`);
  return json.data;
}

const PROFILE_QUERY = `
query($login: String!) {
  user(login: $login) {
    login createdAt
    contributionsCollection { contributionCalendar { totalContributions } }
    repositories(ownerAffiliations: OWNER, privacy: PUBLIC, isFork: false, first: 100,
                 orderBy: { field: CREATED_AT, direction: ASC }) {
      nodes {
        name url description createdAt pushedAt isArchived stargazerCount forkCount openGraphImageUrl
        licenseInfo { spdxId }
        primaryLanguage { name color }
        repositoryTopics(first: 20) { nodes { topic { name } } }
        releases(first: 10, orderBy: { field: CREATED_AT, direction: DESC }) {
          totalCount
          nodes { name tagName publishedAt url isDraft isPrerelease }
        }
        languages(first: 10, orderBy: { field: SIZE, direction: DESC }) {
          edges { size node { name color } }
        }
      }
    }
  }
}`;

const PINNED_QUERY = `
query($login: String!) {
  user(login: $login) { pinnedItems(first: 6, types: [REPOSITORY]) { nodes { ... on Repository { name } } } }
}`;

// When each star was given.
//
// The workflow's own token only covers this repository, so GitHub refuses
// it for the stargazers of the other ones, through GraphQL and REST alike,
// and the shared runners are often refused without a token too. So every
// date that could be read is kept in stars.json next to the pictures. The
// star count always comes from GraphQL: stars the saved dates do not know
// yet arrived since the last run, at most six hours ago, and are dated now.
async function starDates(repo) {
  const dates = [];
  for (let page = 1; dates.length < repo.stargazerCount && page <= 50; page++) {
    const url = `https://api.github.com/repos/${LOGIN}/${repo.name}/stargazers?per_page=100&page=${page}`;
    const headers = { Accept: 'application/vnd.github.star+json', 'User-Agent': `${LOGIN}-profile` };
    let res = await fetch(url, { headers: { ...headers, Authorization: `bearer ${TOKEN}` } });
    if (res.status === 401 || res.status === 403) res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`stargazers of ${repo.name}: HTTP ${res.status}`);
    const list = await res.json();
    if (!list.length) break;
    dates.push(...list.map((x) => x.starred_at));
  }
  return dates.sort();
}

// Read through the API rather than raw.githubusercontent.com: the token
// may read this repository, and the API is not behind a cache that could
// hand back an old copy.
async function previousStarDates() {
  try {
    const res = await fetch(`https://api.github.com/repos/${LOGIN}/${LOGIN}/contents/stars.json?ref=output`, {
      headers: { Authorization: `bearer ${TOKEN}`, Accept: 'application/vnd.github.raw+json', 'User-Agent': `${LOGIN}-profile` },
    });
    return res.ok ? await res.json() : {};
  } catch { return {}; }
}

async function loadProfile() {
  const { user } = await graphql(PROFILE_QUERY, { login: LOGIN });
  try {
    const data = await graphql(PINNED_QUERY, { login: LOGIN });
    user.pinned = data.user.pinnedItems.nodes.map((n) => n.name).filter(Boolean);
  } catch (e) {
    console.warn(`warning: pinned repositories not readable (${e.message.slice(0, 80)}); using profile.json order`);
    user.pinned = [];
  }
  const saved = await previousStarDates();
  for (const repo of user.repositories.nodes) {
    repo.topics = repo.repositoryTopics.nodes.map((n) => n.topic.name);
    repo.published = repo.releases.nodes.filter((x) => !x.isDraft && !x.isPrerelease && x.publishedAt);
    repo.starDates = [];
    if (!repo.stargazerCount) continue;
    try { repo.starDates = await starDates(repo); }
    catch (e) {
      repo.starDates = [...(saved[repo.name] || [])];
      console.warn(`warning: ${e.message}; using ${repo.starDates.length} saved dates`);
    }
    while (repo.starDates.length < repo.stargazerCount) repo.starDates.push(NOW.toISOString());
    repo.starDates = repo.starDates.slice(0, repo.stargazerCount);
  }
  user.projects = user.repositories.nodes.filter((r) => r.name.toLowerCase() !== LOGIN.toLowerCase());
  user.savedStarDates = Object.fromEntries(user.repositories.nodes.filter((r) => r.starDates.length).map((r) => [r.name, r.starDates]));
  return user;
}

const project = (name) => (CFG.projects || {})[name] || {};
function kindOf(repo) {
  const p = project(repo.name);
  if (p.kind) return p.kind;
  if (repo.topics.some((t) => /rc-plane|rc-aircraft|aircraft/.test(t))) return 'plane';
  if (repo.topics.some((t) => /game/.test(t))) return 'game';
  return 'tool';
}

// ------------------------------------------------------------------
//  Hand-drawn primitives
//
//  Every stroke is drawn twice with a little jitter and a slight bow,
//  the way a pen goes over a line twice. The random numbers are seeded
//  by the chart's name, so the same data always gives the same drawing.
// ------------------------------------------------------------------

function seeded(seed) {
  let h = 2166136261;
  for (const c of String(seed)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const f = (n) => (Math.round(n * 10) / 10).toString();
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function sketchLine(r, x1, y1, x2, y2, rough = 1, passes = 2) {
  const len = Math.hypot(x2 - x1, y2 - y1) || 1;
  const off = Math.min(len * 0.04, 2) * rough;
  const bow = Math.min(len * 0.015, 2.5) * rough;
  let d = '';
  for (let p = 0; p < passes; p++) {
    const j = () => (r() - 0.5) * 2 * off;
    const sx = x1 + j(), sy = y1 + j(), ex = x2 + j(), ey = y2 + j();
    const nx = -(ey - sy) / len, ny = (ex - sx) / len;
    const b1 = (r() - 0.5) * 2 * bow, b2 = (r() - 0.5) * 2 * bow;
    d += `M${f(sx)} ${f(sy)}C${f(sx + (ex - sx) / 3 + nx * b1)} ${f(sy + (ey - sy) / 3 + ny * b1)} `
       + `${f(sx + (ex - sx) * 2 / 3 + nx * b2)} ${f(sy + (ey - sy) * 2 / 3 + ny * b2)} ${f(ex)} ${f(ey)}`;
  }
  return d;
}

function sketchRect(r, x, y, w, h, rough = 1) {
  return sketchLine(r, x, y, x + w, y, rough) + sketchLine(r, x + w, y, x + w, y + h, rough)
       + sketchLine(r, x + w, y + h, x, y + h, rough) + sketchLine(r, x, y + h, x, y, rough);
}

// Diagonal pen strokes that fill a rectangle, like shading with a pencil.
function hachure(r, x, y, w, h, gap = 5) {
  let d = '';
  for (let k = x + y + gap / 2; k < x + w + y + h; k += gap) {
    const x0 = Math.max(x, k - (y + h)), x1 = Math.min(x + w, k - y);
    if (x1 - x0 < 1) continue;
    d += sketchLine(r, x0, k - x0, x1, k - x1, 0.35, 1);
  }
  return d;
}

// Smooth curve through points (Catmull-Rom).
function smooth(points) {
  const p = [points[0], ...points, points[points.length - 1]];
  let d = `M${f(p[1][0])} ${f(p[1][1])}`;
  for (let i = 1; i < p.length - 2; i++) {
    const [x0, y0] = p[i - 1], [x1, y1] = p[i], [x2, y2] = p[i + 1], [x3, y3] = p[i + 2];
    d += `C${f(x1 + (x2 - x0) / 6)} ${f(y1 + (y2 - y0) / 6)} ${f(x2 - (x3 - x1) / 6)} ${f(y2 - (y3 - y1) / 6)} ${f(x2)} ${f(y2)}`;
  }
  return d;
}

function sketchCircle(r, cx, cy, rad) {
  let d = '';
  for (let p = 0; p < 2; p++) {
    const n = 10, start = r() * Math.PI * 2, pts = [];
    for (let i = 0; i <= n; i++) {
      const a = start + (i / n) * Math.PI * 2.08;
      const rr = rad * (1 + (r() - 0.5) * 0.09);
      pts.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]);
    }
    d += smooth(pts);
  }
  return d;
}

// A wobbly polyline: every segment is cut into short pieces that are
// nudged sideways a little, then joined with a smooth curve.
function wobbly(r, points, amount = 1.2) {
  const out = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1], [x1, y1] = points[i];
    const len = Math.hypot(x1 - x0, y1 - y0);
    const n = Math.max(1, Math.round(len / 18));
    const nx = -(y1 - y0) / (len || 1), ny = (x1 - x0) / (len || 1);
    for (let s = 1; s <= n; s++) {
      const t = s / n, w = s === n ? 0 : (r() - 0.5) * 2 * amount;
      out.push([x0 + (x1 - x0) * t + nx * w, y0 + (y1 - y0) * t + ny * w]);
    }
  }
  return smooth(out);
}

function star(cx, cy, R) {
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5, rr = i % 2 ? R * 0.45 : R;
    pts.push(`${f(cx + Math.cos(a) * rr)},${f(cy + Math.sin(a) * rr)}`);
  }
  return pts.join(' ');
}

function arrowHead(r, x, y, dir) {   // dir: +1 points right, -1 points left
  return sketchLine(r, x - dir * 11, y - 6, x, y, 0.4) + sketchLine(r, x - dir * 11, y + 6, x, y, 0.4);
}

// ------------------------------------------------------------------
//  SVG frame for the charts: embedded font, light and dark colours
// ------------------------------------------------------------------

const fontData = (file) => readFileSync(join(ROOT, 'assets', 'fonts', file)).toString('base64');
const FONT_CSS = `@font-face{font-family:Hand;font-weight:400;src:url(data:font/woff2;base64,${fontData('ComicNeue-Regular.woff2')}) format('woff2')}`
  + `@font-face{font-family:Hand;font-weight:700;src:url(data:font/woff2;base64,${fontData('ComicNeue-Bold.woff2')}) format('woff2')}`;

function svg(w, h, label, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(label)}">
<style>${FONT_CSS}
text{font-family:Hand,'Comic Neue','Comic Sans MS','Chalkboard SE','Microsoft YaHei','PingFang SC','Noto Sans CJK SC',cursive;fill:#1f2328}
.muted{fill:#59636e}.ink{stroke:#1f2328;fill:none;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}
.faint{stroke:#8c959f;fill:none;stroke-width:1.2;stroke-linecap:round}.paper{fill:#ffffff}
@media (prefers-color-scheme:dark){text{fill:#e6edf3}.muted{fill:#9198a1}.ink{stroke:#e6edf3}.faint{stroke:#6e7681}.paper{fill:#0d1117}}
</style>
${body}
</svg>
`;
}

function title(t, sub) {
  let s = `<text x="24" y="38" style="font-weight:700;font-size:22px">${esc(t)}</text>`;
  if (sub) s += `<text class="muted" x="24" y="60" style="font-size:14px">${esc(sub)}</text>`;
  return s;
}

// ------------------------------------------------------------------
//  Banner
// ------------------------------------------------------------------

// Rough width of a character in the banner's sans-serif font, used to
// uncover the tagline one character at a time.
function charWidth(c, size) {
  const code = c.codePointAt(0);
  if (code >= 0x2e80) return size;
  if (/[A-Z]/.test(c)) return size * 0.64;
  if (/[a-z0-9]/.test(c)) return size * 0.53;
  if (c === ' ') return size * 0.3;
  return size * 0.4;
}

function typingSteps(text, size) {
  const steps = [0];
  let w = 0;
  for (const c of Array.from(text)) { w += charWidth(c, size); steps.push(Math.ceil(w + 3)); }
  steps.push(1200);   // make sure the last character is never cut
  return steps;
}

function drawHeader() {
  const b = CFG.banner || {};
  const greeting = b.greeting ?? "Hi, I'm";
  const name = b.name || LOGIN;
  const tagline = b.tagline || '';
  const taglineZh = b.tagline_zh || '';
  const cjk = (s) => Array.from(s).filter((c) => c.codePointAt(0) >= 0x2e80).length > Array.from(s).length / 2;
  const dur = (s) => Math.max(0.4, Array.from(s).length * (cjk(s) ? 0.056 : 0.031));
  const t1 = 0.7, d1 = dur(tagline), t2 = t1 + (tagline ? d1 : 0) + 0.1, d2 = dur(taglineZh);
  const steps1 = typingSteps(tagline, 19).join(';'), steps2 = typingSteps(taglineZh, 17).join(';');
  const label = `${greeting} ${name}. ${tagline} ${taglineZh}`.trim();

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="250" viewBox="0 0 1200 250" role="img" aria-label="${esc(label)}">
  <!-- Generated from profile.json by scripts/build.mjs. All motion is SMIL,
       so every part runs on one clock: the trail is drawn exactly as fast
       as the wing flies along it. -->
  <defs>
    <pattern id="dots" width="22" height="22" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="1.3" class="dot"/></pattern>
    <linearGradient id="fade" x1="0" x2="1" y1="0" y2="0">
      <stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".45" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#fff" stop-opacity="1"/>
    </linearGradient>
    <mask id="dotmask"><rect width="1200" height="250" fill="url(#fade)"/></mask>
    <path id="route" d="M600 222C730 232 840 210 912 180S1000 126 1036 98"/>
    <mask id="reveal" maskUnits="userSpaceOnUse" x="0" y="0" width="1200" height="250">
      <path d="M600 222C730 232 840 210 912 180S1000 126 1036 98" fill="none" stroke="#fff" stroke-width="10" stroke-dasharray="560" stroke-dashoffset="560">
        <animate attributeName="stroke-dashoffset" from="560" to="0" dur="2.4s" begin="0.2s" fill="freeze" calcMode="spline" keyTimes="0;1" keySplines=".45 0 .25 1"/>
      </path>
    </mask>
    <clipPath id="type1"><rect x="50" y="120" height="40" width="0">
      <animate attributeName="width" dur="${d1.toFixed(2)}s" begin="${t1}s" fill="freeze" calcMode="discrete" values="${steps1}"/>
    </rect></clipPath>
    <clipPath id="type2"><rect x="50" y="160" height="36" width="0">
      <animate attributeName="width" dur="${d2.toFixed(2)}s" begin="${t2.toFixed(2)}s" fill="freeze" calcMode="discrete" values="${steps2}"/>
    </rect></clipPath>
  </defs>
  <style>
    .bg{fill:#f6f8fa;stroke:#d0d7de}.dot{fill:#d0d7de}
    .h{fill:#1f2328;font:700 46px -apple-system,"Segoe UI","Noto Sans",Helvetica,Arial,"Microsoft YaHei","PingFang SC",sans-serif}
    .s{fill:#59636e;font:19px -apple-system,"Segoe UI","Noto Sans",Helvetica,Arial,"Microsoft YaHei","PingFang SC",sans-serif}
    .z{fill:#59636e;font:17px "Microsoft YaHei","PingFang SC","Noto Sans CJK SC","Noto Sans SC",sans-serif}
    .acc{fill:#0969da}
    .wing{fill:#2f81f7;fill-opacity:.07;stroke:#2f81f7;stroke-width:3.4;stroke-linejoin:round}
    .hinge{stroke:#e5484d;stroke-width:3;stroke-dasharray:10 7;fill:none}
    .bay{fill:#d4a72c;stroke:#9a6700;stroke-width:1.8}
    .trail{stroke:#8c959f;stroke-width:1.6;stroke-dasharray:3 7;fill:none;stroke-linecap:round}
    @media (prefers-color-scheme:dark){
      .bg{fill:#161b22;stroke:#30363d}.dot{fill:#30363d}.h{fill:#e6edf3}.s,.z{fill:#9198a1}.acc{fill:#4493f8}
      .wing{fill:#4493f8;stroke:#4493f8;fill-opacity:.09}.trail{stroke:#6e7681}
    }
  </style>
  <rect class="bg" x="1" y="1" width="1198" height="248" rx="16"/>
  <rect x="1" y="1" width="1198" height="248" rx="16" fill="url(#dots)" mask="url(#dotmask)"/>
  <g opacity="0">
    <animate attributeName="opacity" from="0" to="1" dur="0.8s" begin="0.1s" fill="freeze"/>
    <animateTransform attributeName="transform" type="translate" from="0 10" to="0 0" dur="0.8s" begin="0.1s" fill="freeze" calcMode="spline" keyTimes="0;1" keySplines=".2 .6 .3 1"/>
    <text class="h" x="56" y="104">${esc(greeting)} <tspan class="acc">${esc(name)}</tspan></text>
  </g>
  <text class="s" x="58" y="148" clip-path="url(#type1)">${esc(tagline)}</text>
  <text class="z" x="58" y="184" clip-path="url(#type2)">${esc(taglineZh)}</text>
  <use href="#route" class="trail" mask="url(#reveal)"/>
  <g>
    <animateMotion dur="2.4s" begin="0.2s" fill="freeze" rotate="auto" keyPoints="0;1" keyTimes="0;1" calcMode="spline" keySplines=".45 0 .25 1"><mpath href="#route"/></animateMotion>
    <g transform="scale(.5) rotate(90)">
      <g>
        <animateTransform attributeName="transform" type="translate" values="0 0;0 -5;0 0" dur="3.2s" begin="2.6s" repeatCount="indefinite"/>
        <path class="wing" d="M0 -6L-152 92L-152 118L-22 76L22 76L152 118L152 92Z"/>
        <path class="hinge" d="M-146 104L-26 64M146 104L26 64"/>
        <rect class="bay" x="-9" y="8" width="18" height="70" rx="3"/>
        <path class="wing" d="M-152 92L-160 94L-160 120L-152 118M152 92L160 94L160 120L152 118" style="fill:none"/>
      </g>
    </g>
  </g>
</svg>
`;
}

// ------------------------------------------------------------------
//  Chart: overview
// ------------------------------------------------------------------

function drawStats(user) {
  const r = seeded('stats');
  const repos = user.repositories.nodes;
  const tiles = [
    ['Projects', user.projects.length, 'public repositories'],
    ['Stars', repos.reduce((s, x) => s + x.stargazerCount, 0), 'on all repositories'],
    ['Releases', repos.reduce((s, x) => s + x.releases.totalCount, 0), 'published'],
    ['Forks', repos.reduce((s, x) => s + x.forkCount, 0), 'of my projects'],
    ['Contributions', user.contributionsCollection.contributionCalendar.totalContributions, 'in the last 12 months'],
  ];
  const W = 900, H = 282, c = CFG.charts || {};
  let body = title(fill(c.stats_title || '{login} on GitHub'),
    `since ${monthYear(user.createdAt)} · redrawn every six hours · last ${localDay(NOW)}`);

  const tw = 160, gap = (W - 48 - tw * 5) / 4;
  tiles.forEach(([label, value, sub], i) => {
    const x = 24 + i * (tw + gap), y = 78;
    body += `<path class="ink" d="${sketchRect(r, x, y, tw, 92)}"/>`
          + `<text x="${f(x + tw / 2)}" y="${y + 46}" text-anchor="middle" style="font-weight:700;font-size:34px">${value}</text>`
          + `<text x="${f(x + tw / 2)}" y="${y + 68}" text-anchor="middle" style="font-weight:700;font-size:14px">${label}</text>`
          + `<text class="muted" x="${f(x + tw / 2)}" y="${y + 84}" text-anchor="middle" style="font-size:11.5px">${sub}</text>`;
    if (label === 'Stars') body += `<polygon points="${star(x + tw - 18, y + 18, 9)}" style="fill:#e3b341;stroke:#9a6700;stroke-width:1"/>`;
  });

  // Languages, by bytes of code across the projects.
  const bytes = new Map();
  for (const repo of user.projects) for (const e of repo.languages.edges) {
    const cur = bytes.get(e.node.name) || { size: 0, color: e.node.color || '#8c959f' };
    cur.size += e.size; bytes.set(e.node.name, cur);
  }
  const langs = [...bytes.entries()].sort((a, b) => b[1].size - a[1].size).slice(0, 6);
  const total = langs.reduce((s, [, v]) => s + v.size, 0) || 1;
  const bx = 24, by = 214, bw = W - 48, bh = 22;
  body += `<text x="24" y="204" style="font-weight:700;font-size:15px">Languages</text>`;
  let x = bx;
  langs.forEach(([name, v], i) => {
    const w = (v.size / total) * bw;
    body += `<path d="${hachure(seeded('lang' + name), x, by, w, bh, 4.5)}" style="stroke:${v.color};stroke-width:1.6;fill:none;stroke-linecap:round"/>`;
    if (i > 0) body += `<path class="ink" d="${sketchLine(r, x, by - 2, x, by + bh + 2, 0.6)}"/>`;
    x += w;
  });
  body += `<path class="ink" d="${sketchRect(r, bx, by, bw, bh, 0.8)}"/>`;
  let lx = 24;
  for (const [name, v] of langs) {
    const pct = `${name} ${Math.round((v.size / total) * 100)}%`;
    body += `<rect x="${lx}" y="254" width="12" height="12" rx="3" style="fill:${v.color}"/><text x="${lx + 18}" y="265" style="font-size:14px">${esc(pct)}</text>`;
    lx += 36 + pct.length * 7.5;
  }
  if (!langs.length) body += `<text class="muted" x="24" y="265" style="font-size:14px">no code yet</text>`;
  return svg(W, H, `${fill(c.stats_title || '{login} on GitHub')}: ${tiles.map(([l, v]) => `${v} ${l.toLowerCase()}`).join(', ')}`, body);
}

// ------------------------------------------------------------------
//  Chart: star history
// ------------------------------------------------------------------

const PALETTE = ['#2f81f7', '#e5484d', '#1f9d55', '#8250df', '#d4a72c', '#f0883e'];

function drawStars(user) {
  const r = seeded('stars');
  const repos = user.repositories.nodes;
  const c = CFG.charts || {};
  const W = 900, H = 370, L = 78, R = 860, T = 104, B = 310;
  const created = new Date(user.createdAt);
  const t0 = Date.UTC(created.getUTCFullYear(), created.getUTCMonth(), 1);
  const t1 = NOW.getTime();
  const all = repos.flatMap((x) => x.starDates.map((d) => new Date(d).getTime())).sort((a, b) => a - b);
  const totalStars = all.length;
  const yMax = Math.max(4, Math.ceil(totalStars * 1.25));
  const step = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000].find((s) => yMax / s <= 5) || 10000;
  const X = (t) => L + ((t - t0) / (t1 - t0)) * (R - L);
  const Y = (v) => B - (v / yMax) * (B - T);

  let body = title(fill(c.stars_title || 'Star history'), fill(c.stars_subtitle || 'stars on all {login} repositories') + ' · redrawn every six hours');
  body += `<path class="ink" d="${sketchLine(r, L, B, R + 14, B)}${arrowHead(r, R + 15, B, 1)}"/>`;
  body += `<path class="ink" d="${sketchLine(r, L, B, L, T - 14)}${sketchLine(r, L - 5, T - 6, L, T - 15, 0.4)}${sketchLine(r, L + 5, T - 6, L, T - 15, 0.4)}"/>`;
  for (let v = step; v <= yMax; v += step) {
    body += `<path class="faint" d="${sketchLine(r, L - 5, Y(v), L + 5, Y(v), 0.4, 1)}"/>`
          + `<text class="muted" x="${L - 12}" y="${f(Y(v) + 5)}" text-anchor="end" style="font-size:14px">${v}</text>`;
  }
  for (let y = created.getUTCFullYear() + 1; Date.UTC(y, 0, 1) < t1; y++) {
    const x = X(Date.UTC(y, 0, 1));
    body += `<path class="faint" d="${sketchLine(r, x, B - 5, x, B + 5, 0.4, 1)}"/>`
          + `<text class="muted" x="${f(x)}" y="${B + 24}" text-anchor="middle" style="font-size:14px">${y}</text>`;
  }
  body += `<text class="muted" x="${L - 12}" y="${B + 24}" text-anchor="end" style="font-size:13px">${monthYear(user.createdAt)}</text>`;

  const starred = repos.filter((x) => x.starDates.length).sort((a, b) => b.starDates.length - a.starDates.length).slice(0, 5);
  const series = starred.map((repo, i) => ({ name: repo.name, color: PALETTE[i % PALETTE.length], times: repo.starDates.map((d) => new Date(d).getTime()) }));
  if (series.length > 1) series.unshift({ name: 'all repositories', color: '#1f2328', times: all, total: true });
  for (const s of series) {
    const pts = [[X(t0), Y(0)]];
    s.times.forEach((t, i) => { pts.push([X(t), Y(i)]); pts.push([X(t), Y(i + 1)]); });
    pts.push([X(t1), Y(s.times.length)]);
    body += `<path d="${wobbly(seeded('line' + s.name), pts, 1)}" style="fill:none;stroke:${s.color};stroke-width:${s.total ? 3.2 : 2.6};stroke-linecap:round;stroke-linejoin:round"${s.total ? ' class="ink"' : ''}/>`;
  }
  if (!series.length) body += `<path d="${wobbly(r, [[X(t0), Y(0)], [X(t1), Y(0)]], 1)}" style="fill:none;stroke:#2f81f7;stroke-width:2.6"/>`;

  let ly = T - 8;
  for (const s of series) {
    body += `<path d="${sketchLine(r, R - 250, ly - 5, R - 222, ly - 5, 0.5)}" style="stroke:${s.color};stroke-width:3;fill:none"${s.total ? ' class="ink"' : ''}/>`
          + `<text x="${R - 214}" y="${ly}" style="font-size:14px">${esc(s.name)} (${s.times.length})</text>`;
    ly += 22;
  }

  const ex = X(t1), ey = Y(totalStars);
  const note = totalStars === 0 ? 'no stars yet, be the first!' : totalStars === 1 ? 'the first star!' : `${totalStars} stars today`;
  const nx = ex - 150, ny = Math.min(B - 30, ey + 58);
  body += `<text x="${f(nx - 4)}" y="${f(ny + 5)}" text-anchor="end" style="font-size:15px;font-weight:700">${esc(note)}</text>`
        + `<path class="ink" d="${smooth([[nx, ny], [nx + 60, ny - 8], [ex - 30, ey + 22], [ex - 6, ey + 6]])}"/>`
        + `<path class="ink" d="${sketchLine(r, ex - 6, ey + 6, ex - 15, ey + 4, 0.3)}${sketchLine(r, ex - 6, ey + 6, ex - 9, ey + 15, 0.3)}"/>`;
  return svg(W, H, `Star history: ${totalStars} stars in total`, body);
}

// ------------------------------------------------------------------
//  Chart: build log
//
//  Events come from three places: the day each repository was created,
//  every published release, and the milestones written in profile.json.
//  They run left to right; when a row is full the line turns around and
//  the next row runs back, like a snake, so the chart can keep growing.
// ------------------------------------------------------------------

const KIND = { plane: '#2f81f7', game: '#8250df', tool: '#1f9d55' };

function buildEvents(user) {
  const tl = CFG.timeline || {};
  const events = [];
  for (const repo of user.projects) {
    const p = project(repo.name), kind = kindOf(repo);
    events.push({ id: `created:${repo.name}`, date: localDay(repo.createdAt), at: repo.createdAt, label: p.title || repo.name, zh: p.title_zh || 'new project · 新项目', kind });
    for (const rel of repo.published) {
      events.push({ id: `release:${repo.name}:${rel.tagName}`, date: localDay(rel.publishedAt), at: rel.publishedAt, label: `${p.title || repo.name} ${rel.tagName}`, zh: 'released · 发布', kind, release: true });
    }
  }
  for (const m of tl.milestones || []) {
    if (!/^\d{4}-\d{2}(-\d{2})?$/.test(m.date || '')) { console.warn(`warning: milestone "${m.label}" has no date like 2026-09-24, skipped`); continue; }
    events.push({ id: `milestone:${m.date}:${m.label}`, date: m.date, label: m.label, zh: m.zh || '', kind: m.kind || 'tool' });
  }
  // Milestones only have a date, so they go at the start of their day;
  // everything else is placed by its local time on that day.
  const hide = new Set(tl.hide || []);
  const key = (e) => dayValue(e.date) + (e.at ? 1000 + localSeconds(e.at) * 1000 : 0);
  return events
    .filter((e) => !hide.has(e.id))
    .map((e, i) => ({ ...e, order: i }))
    .sort((a, b) => key(a) - key(b) || a.order - b.order)
    .slice(-(tl.max || 12));
}

function drawTimeline(events) {
  const r = seeded('timeline');
  const c = CFG.charts || {};
  const PER = 6, W = 900, y0 = 172, trackH = 210, xa = 110, xb = 790, dx = (xb - xa) / (PER - 1);
  const tracks = Math.max(1, Math.ceil(events.length / PER));
  const H = y0 + (tracks - 1) * trackH + 140;
  let body = title(fill(c.timeline_title || 'Build log'), fill(c.timeline_subtitle || ''));

  const pos = events.map((e, i) => {
    const t = Math.floor(i / PER), j = i % PER;
    return { x: t % 2 === 0 ? xa + j * dx : xb - j * dx, y: y0 + t * trackH, t, j };
  });

  // the line, turning at the ends of the rows
  for (let t = 0; t < tracks; t++) {
    const y = y0 + t * trackH, last = t === tracks - 1, rightward = t % 2 === 0;
    const endItem = pos.filter((p) => p.t === t).pop();
    const from = rightward ? (t === 0 ? 30 : 60) : 840;
    const to = last ? endItem.x + (rightward ? 60 : -60) : (rightward ? 840 : 60);
    body += `<path class="ink" d="${sketchLine(r, from, y, to, y)}${last ? arrowHead(r, to + (rightward ? 1 : -1), y, rightward ? 1 : -1) : ''}"/>`;
    if (!last) {
      const ex = rightward ? 840 : 60, bulge = rightward ? 46 : -46;
      body += `<path class="ink" d="${smooth([[ex, y], [ex + bulge * 0.8, y + trackH * 0.12], [ex + bulge, y + trackH / 2], [ex + bulge * 0.8, y + trackH * 0.88], [ex, y + trackH]])}"/>`;
    }
  }

  events.forEach((e, i) => {
    const { x, y, j } = pos[i], up = j % 2 === 0, color = KIND[e.kind] || '#8c959f';
    const prev = events[i - 1];
    if (prev && pos[i - 1].t === pos[i].t && dayValue(e.date) - dayValue(prev.date) > 180 * 86400000) {
      const bx = (pos[i - 1].x + x) / 2;
      const y1 = +prev.date.slice(0, 4), y2 = +e.date.slice(0, 4);
      const skipped = y2 - y1 >= 2 ? (y2 - y1 === 2 ? `${y1 + 1}` : `${y1 + 1}–${y2 - 1}`) : '';
      body += `<rect class="paper" x="${f(bx - 7)}" y="${y - 4}" width="14" height="8"/>`
            + `<path class="ink" d="${sketchLine(r, bx - 9, y + 9, bx - 1, y - 9, 0.4)}${sketchLine(r, bx + 1, y + 9, bx + 9, y - 9, 0.4)}"/>`;
      if (skipped) body += `<text class="muted" x="${f(bx)}" y="${y + 30}" text-anchor="middle" style="font-size:12px">${skipped}</text>`;
    }
    body += `<path class="faint" d="${sketchLine(r, x, y, x, up ? y - 30 : y + 30, 0.3, 1)}"/>`;
    if (e.release) body += `<polygon points="${star(x, y, 13)}" style="fill:#e3b341;stroke:#9a6700;stroke-width:1.2"/>`;
    else body += `<circle cx="${f(x)}" cy="${y}" r="8" style="fill:${color}"/><path class="ink" d="${sketchCircle(r, x, y, 9)}"/>`;
    const lines = [[showDate(e.date), 'muted', 13, 400], [e.label, '', 15, 700], [e.zh, 'muted', 13, 400]].filter((l) => l[0]);
    lines.forEach(([txt, cls, size, weight], k) => {
      const ty = up ? y - 42 - (lines.length - 1 - k) * 19 : y + 50 + k * 19;
      body += `<text${cls ? ` class="${cls}"` : ''} x="${f(x)}" y="${f(ty)}" text-anchor="middle" style="font-size:${size}px;font-weight:${weight}">${esc(txt)}</text>`;
    });
  });

  let lx = W - 390;
  for (const [kind, color] of Object.entries(KIND)) {
    body += `<circle cx="${lx}" cy="${H - 22}" r="6" style="fill:${color}"/><text class="muted" x="${lx + 12}" y="${H - 17}" style="font-size:14px">${kind}</text>`;
    lx += 80;
  }
  body += `<polygon points="${star(lx, H - 22, 8)}" style="fill:#e3b341;stroke:#9a6700;stroke-width:1"/><text class="muted" x="${lx + 13}" y="${H - 17}" style="font-size:14px">release</text>`;
  if (!events.length) body += `<text class="muted" x="450" y="${y0 - 20}" text-anchor="middle" style="font-size:15px">nothing here yet</text>`;
  return svg(W, H, `${fill(c.timeline_title || 'Build log')}: ${events.map((e) => e.label).join(', ')}`, body);
}

// ------------------------------------------------------------------
//  README
// ------------------------------------------------------------------

function badge(label, message, color) {
  const enc = (s) => encodeURIComponent(String(s).replace(/-/g, '--').replace(/_/g, '__'));
  const alt = message ? `${label} ${message}` : label;
  return `![${alt}](https://img.shields.io/badge/${enc(label)}${message ? '-' + enc(message) : ''}-${String(color || '8c959f').replace('#', '')})`;
}
const mdEscape = (s) => String(s || '').replace(/([*_`\[\]<>|])/g, '\\$1');

function projectCard(repo) {
  const p = project(repo.name);
  const img = p.image || repo.openGraphImageUrl;
  const badges = [];
  if (repo.primaryLanguage) badges.push(badge(repo.primaryLanguage.name, '', repo.primaryLanguage.color));
  for (const b of p.badges || []) badges.push(badge(...b));
  if (repo.published[0]) badges.push(badge('release', repo.published[0].tagName, '2ea44f'));
  const spdx = repo.licenseInfo?.spdxId;
  if (spdx && spdx !== 'NOASSERTION') badges.push(badge('license', spdx, 'blue'));
  if (repo.stargazerCount) badges.push(badge('★', repo.stargazerCount, 'e3b341'));
  return `<td width="50%" valign="top">

<a href="${repo.url}"><img src="${img}" alt="${esc(p.title || repo.name)}"></a>

### [${repo.name}](${repo.url})

${p.description || mdEscape(repo.description)}
${p.zh ? `\n<sub>${p.zh}</sub>\n` : ''}
${badges.join(' ')}

</td>`;
}

function renderReadme(user) {
  const S = { ...{ projects: 'Projects', more_projects: 'More projects', planes: 'Plans', timeline: 'Build log', releases: 'Latest releases', numbers: 'By the numbers', contributions: 'Contributions' }, ...(CFG.sections || {}) };
  const b = CFG.banner || {};
  const byName = new Map(user.projects.map((r) => [r.name, r]));
  const active = user.projects.filter((r) => !r.isArchived);

  // Featured: the pinned repositories, in pinned order. If they cannot be
  // read, the order of "projects" in profile.json, then everything else.
  let featured = user.pinned.map((n) => byName.get(n)).filter(Boolean);
  if (!featured.length) featured = Object.keys(CFG.projects || {}).map((n) => byName.get(n)).filter(Boolean);
  if (!featured.length) featured = [...active].sort((a, b2) => b2.stargazerCount - a.stargazerCount || b2.pushedAt.localeCompare(a.pushedAt)).slice(0, 4);
  const featuredNames = new Set(featured.map((r) => r.name));
  const more = active.filter((r) => !featuredNames.has(r.name)).sort((a, b2) => b2.pushedAt.localeCompare(a.pushedAt));

  const out = [];
  out.push('<!-- This page is generated from profile.json by scripts/build.mjs. Edit profile.json, not this file: changes here are overwritten. See EDITING.md. -->');
  out.push('');
  out.push(`<img src="${OUT_URL}/header.svg" width="100%" alt="${esc(`${b.greeting ?? "Hi, I'm"} ${b.name || LOGIN}. ${b.tagline || ''}`)}">`);
  if (CFG.interests) out.push('', `<p align="center">\n${CFG.interests}\n</p>`);

  if (S.projects && featured.length) {
    out.push('', `## ${S.projects}`, '', '<table>');
    for (let i = 0; i < featured.length; i += 2) {
      out.push('<tr>', projectCard(featured[i]), featured[i + 1] ? projectCard(featured[i + 1]) : '<td width="50%"></td>', '</tr>');
    }
    out.push('</table>');
  }

  if (S.more_projects && more.length) {
    out.push('', `## ${S.more_projects}`, '');
    for (const r of more) {
      const p = project(r.name);
      const bits = [p.description || mdEscape(r.description) || ''];
      if (r.primaryLanguage) bits.push(r.primaryLanguage.name);
      if (r.stargazerCount) bits.push(`★ ${r.stargazerCount}`);
      out.push(`- **[${r.name}](${r.url})** · ${bits.filter(Boolean).join(' · ')}`);
    }
  }

  // Plane plans: the rows written in profile.json, plus any repository
  // tagged rc-plane that has no row yet.
  const pl = CFG.planes || {};
  const rows = [...(pl.rows || [])];
  for (const r of active) {
    if (kindOf(r) === 'plane' && !rows.some((x) => x.repo === r.name)) rows.push({ repo: r.name, name: project(r.name).title || r.name, cells: [] });
  }
  if (S.planes && rows.length) {
    const cols = pl.columns || [];
    out.push('', `## ${S.planes}`, '', `| | ${cols.join(' | ')} |`, `|---|${cols.map(() => '---').join('|')}|`);
    for (const row of rows) {
      const repo = byName.get(row.repo);
      const name = repo ? `[**${row.name}**](${repo.url})` : `**${row.name}**`;
      out.push(`| ${name} | ${cols.map((_, k) => row.cells?.[k] || '—').join(' | ')} |`);
    }
    if (pl.note) out.push('', `${pl.note}${pl.note_zh ? `<br>\n<sub>${pl.note_zh}</sub>` : ''}`);
  }

  if (S.timeline) out.push('', `## ${S.timeline}`, '', `<img src="${OUT_URL}/timeline.svg" width="100%" alt="${esc(fill(CFG.charts?.timeline_title || 'Build log'))}">`);

  if (S.releases) {
    const releases = user.projects
      .flatMap((repo) => repo.published.map((x) => ({ repo, ...x })))
      .sort((a, b2) => b2.publishedAt.localeCompare(a.publishedAt))
      .slice(0, 5);
    out.push('', `## ${S.releases}`, '');
    if (!releases.length) out.push('- nothing released yet');
    for (const x of releases) out.push(`- **[${x.repo.name}](${x.repo.url})** · [${x.name || x.tagName}](${x.url}) · ${localDay(x.publishedAt)}`);
  }

  if (S.numbers) {
    out.push('', `## ${S.numbers}`, '',
      `<img src="${OUT_URL}/stats.svg" width="100%" alt="Projects, stars, releases, forks, contributions and languages">`, '',
      `<img src="${OUT_URL}/stars.svg" width="100%" alt="Star history">`);
  }

  if (S.contributions) {
    out.push('', `## ${S.contributions}`, '', '<picture>',
      `  <source media="(prefers-color-scheme: dark)" srcset="${OUT_URL}/github-snake-dark.svg">`,
      `  <img src="${OUT_URL}/github-snake.svg" width="100%" alt="A snake eating the contribution graph">`,
      '</picture>');
  }

  if (CFG.footer) out.push('', `<p align="center"><sub>${CFG.footer}</sub></p>`);
  return out.join('\n') + '\n';
}

// ------------------------------------------------------------------

if (!TOKEN) { console.error('GITHUB_TOKEN is not set'); process.exit(1); }
const user = await loadProfile();
const events = buildEvents(user);
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'header.svg'), drawHeader());
writeFileSync(join(OUT, 'stats.svg'), drawStats(user));
writeFileSync(join(OUT, 'stars.svg'), drawStars(user));
writeFileSync(join(OUT, 'timeline.svg'), drawTimeline(events));
writeFileSync(join(OUT, 'stars.json'), JSON.stringify(user.savedStarDates, null, 1) + '\n');

const readmeFile = join(ROOT, 'README.md');
const next = renderReadme(user);
let current = '';
try { current = readFileSync(readmeFile, 'utf8'); } catch {}
if (next !== current) { writeFileSync(readmeFile, next); console.log('README.md updated'); }
else console.log('README.md unchanged');
console.log(`Wrote header, stats, stars and timeline (${events.length} events) to ${OUT}`);

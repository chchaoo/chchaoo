// Builds the hand-drawn charts on the profile page and refreshes the
// "Latest releases" list in README.md.
//
// Runs every day in .github/workflows/profile.yml. No dependencies:
// Node 18 or later (for fetch).
//
//   GITHUB_TOKEN   token for the GraphQL API (the workflow's own token is enough)
//   PROFILE_LOGIN  whose profile to draw (default: chchaoo)
//   OUT_DIR        where the SVG files go (default: dist)
//
// Output: dist/stats.svg, dist/stars.svg, dist/timeline.svg
// Every chart is one SVG that follows the viewer's light or dark theme
// and carries its own font, so it looks the same on every device.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOGIN = process.env.PROFILE_LOGIN || 'chchaoo';
const OUT = join(ROOT, process.env.OUT_DIR || 'dist');
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
const NOW = new Date();

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
    followers { totalCount }
    contributionsCollection { contributionCalendar { totalContributions } }
    repositories(ownerAffiliations: OWNER, privacy: PUBLIC, isFork: false, first: 100,
                 orderBy: { field: CREATED_AT, direction: ASC }) {
      nodes {
        name url createdAt stargazerCount forkCount
        releases(first: 10, orderBy: { field: CREATED_AT, direction: DESC }) {
          totalCount
          nodes { name tagName publishedAt url isDraft isPrerelease }
        }
        languages(first: 10, orderBy: { field: SIZE, direction: DESC }) {
          edges { size node { name color } }
        }
        stargazers(first: 100, orderBy: { field: STARRED_AT, direction: ASC }) {
          pageInfo { hasNextPage endCursor }
          edges { starredAt }
        }
      }
    }
  }
}`;

const STARS_QUERY = `
query($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    stargazers(first: 100, after: $after, orderBy: { field: STARRED_AT, direction: ASC }) {
      pageInfo { hasNextPage endCursor }
      edges { starredAt }
    }
  }
}`;

async function loadProfile() {
  const { user } = await graphql(PROFILE_QUERY, { login: LOGIN });
  for (const repo of user.repositories.nodes) {
    let page = repo.stargazers;
    repo.starDates = page.edges.map((e) => e.starredAt);
    while (page.pageInfo.hasNextPage) {
      const data = await graphql(STARS_QUERY, { owner: LOGIN, name: repo.name, after: page.pageInfo.endCursor });
      page = data.repository.stargazers;
      repo.starDates.push(...page.edges.map((e) => e.starredAt));
    }
  }
  return user;
}

// ------------------------------------------------------------------
//  Hand-drawn primitives
//
//  Every stroke is drawn twice with a little jitter and a slight bow,
//  the way a pen goes over a line twice. The random numbers come from
//  a generator seeded by the chart's name, so the same data always
//  gives the same drawing and the output only changes when data does.
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

// Smooth curve through points (Catmull-Rom), used for circles and curves.
function smooth(points, closed = false) {
  const p = closed ? [points[points.length - 1], ...points, points[0], points[1]] : [points[0], ...points, points[points.length - 1]];
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

// ------------------------------------------------------------------
//  SVG frame: embedded font, light and dark colours
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

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthYear = (d) => `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
const isoDay = (d) => new Date(d).toISOString().slice(0, 10);

// ------------------------------------------------------------------
//  Chart 1: overview
// ------------------------------------------------------------------

function drawStats(user) {
  const r = seeded('stats');
  const repos = user.repositories.nodes;
  const projects = repos.filter((x) => x.name.toLowerCase() !== LOGIN.toLowerCase());
  const tiles = [
    ['Projects', projects.length],
    ['Stars', repos.reduce((s, x) => s + x.stargazerCount, 0)],
    ['Releases', repos.reduce((s, x) => s + x.releases.totalCount, 0)],
    ['Forks', repos.reduce((s, x) => s + x.forkCount, 0)],
    ['Contributions', user.contributionsCollection.contributionCalendar.totalContributions],
  ];
  const tileSub = ['public repositories', 'on all repositories', 'published', 'of my projects', 'in the last 12 months'];

  const W = 900, H = 282;
  let body = `<text x="24" y="38" style="font-weight:700;font-size:22px">${esc(LOGIN)} on GitHub</text>`
           + `<text class="muted" x="24" y="60" style="font-size:14px">since ${monthYear(new Date(user.createdAt))} · redrawn every day · last ${isoDay(NOW)}</text>`;

  const tw = 160, gap = (W - 48 - tw * 5) / 4;
  tiles.forEach(([label, value], i) => {
    const x = 24 + i * (tw + gap), y = 78;
    body += `<path class="ink" d="${sketchRect(r, x, y, tw, 92)}"/>`;
    body += `<text x="${f(x + tw / 2)}" y="${y + 46}" text-anchor="middle" style="font-weight:700;font-size:34px">${value}</text>`;
    body += `<text x="${f(x + tw / 2)}" y="${y + 68}" text-anchor="middle" style="font-weight:700;font-size:14px">${label}</text>`;
    body += `<text class="muted" x="${f(x + tw / 2)}" y="${y + 84}" text-anchor="middle" style="font-size:11.5px">${tileSub[i]}</text>`;
    if (label === 'Stars') body += `<polygon points="${star(x + tw - 18, y + 18, 9)}" style="fill:#e3b341;stroke:#9a6700;stroke-width:1"/>`;
  });

  // Languages, by bytes of code across the projects.
  const bytes = new Map();
  for (const repo of projects) for (const e of repo.languages.edges) {
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
    body += `<rect x="${lx}" y="254" width="12" height="12" rx="3" style="fill:${v.color}"/>`
          + `<text x="${lx + 18}" y="265" style="font-size:14px">${esc(pct)}</text>`;
    lx += 36 + pct.length * 7.5;
  }
  if (!langs.length) body += `<text class="muted" x="24" y="265" style="font-size:14px">no code yet</text>`;

  return svg(W, H, `${LOGIN} on GitHub: ${tiles.map(([l, v]) => `${v} ${l.toLowerCase()}`).join(', ')}`, body);
}

// ------------------------------------------------------------------
//  Chart 2: star history
// ------------------------------------------------------------------

const PALETTE = ['#2f81f7', '#e5484d', '#1f9d55', '#8250df', '#d4a72c', '#f0883e'];

function drawStars(user) {
  const r = seeded('stars');
  const repos = user.repositories.nodes;
  const W = 900, H = 370, L = 78, R = 860, T = 104, B = 310;
  const t0 = Date.UTC(new Date(user.createdAt).getUTCFullYear(), new Date(user.createdAt).getUTCMonth(), 1);
  const t1 = NOW.getTime();
  const all = repos.flatMap((x) => x.starDates.map((d) => new Date(d).getTime())).sort((a, b) => a - b);
  const totalStars = all.length;
  const yMax = Math.max(4, Math.ceil(totalStars * 1.25));
  const step = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000].find((s) => yMax / s <= 5) || 1000;
  const X = (t) => L + ((t - t0) / (t1 - t0)) * (R - L);
  const Y = (v) => B - (v / yMax) * (B - T);

  let body = `<text x="24" y="38" style="font-weight:700;font-size:22px">Star history</text>`
           + `<text class="muted" x="24" y="60" style="font-size:14px">stars on all ${esc(LOGIN)} repositories · redrawn every day</text>`;

  // axes with arrow heads
  body += `<path class="ink" d="${sketchLine(r, L, B, R + 14, B)}${sketchLine(r, R + 6, B - 5, R + 15, B, 0.4)}${sketchLine(r, R + 6, B + 5, R + 15, B, 0.4)}"/>`;
  body += `<path class="ink" d="${sketchLine(r, L, B, L, T - 14)}${sketchLine(r, L - 5, T - 6, L, T - 15, 0.4)}${sketchLine(r, L + 5, T - 6, L, T - 15, 0.4)}"/>`;
  for (let v = step; v <= yMax; v += step) {
    body += `<path class="faint" d="${sketchLine(r, L - 5, Y(v), L + 5, Y(v), 0.4, 1)}"/>`
          + `<text class="muted" x="${L - 12}" y="${f(Y(v) + 5)}" text-anchor="end" style="font-size:14px">${v}</text>`;
  }
  for (let y = new Date(t0).getUTCFullYear() + 1; Date.UTC(y, 0, 1) < t1; y++) {
    const x = X(Date.UTC(y, 0, 1));
    body += `<path class="faint" d="${sketchLine(r, x, B - 5, x, B + 5, 0.4, 1)}"/>`
          + `<text class="muted" x="${f(x)}" y="${B + 24}" text-anchor="middle" style="font-size:14px">${y}</text>`;
  }
  body += `<text class="muted" x="${L - 12}" y="${B + 24}" text-anchor="end" style="font-size:13px">${monthYear(new Date(t0))}</text>`;

  // one line per repository with stars, at most five
  const starred = repos.filter((x) => x.starDates.length).sort((a, b) => b.starDates.length - a.starDates.length).slice(0, 5);
  const series = starred.map((repo, i) => ({ name: repo.name, color: PALETTE[i % PALETTE.length], times: repo.starDates.map((d) => new Date(d).getTime()) }));
  if (series.length > 1) series.unshift({ name: 'all repositories', color: '#1f2328', times: all, total: true });

  for (const s of series) {
    const pts = [[X(t0), Y(0)]];
    s.times.forEach((t, i) => { pts.push([X(t), Y(i)]); pts.push([X(t), Y(i + 1)]); });
    pts.push([X(t1), Y(s.times.length)]);
    body += `<path d="${wobbly(seeded('line' + s.name), pts, 1)}" style="fill:none;stroke:${s.color};stroke-width:${s.total ? 3.2 : 2.6};stroke-linecap:round;stroke-linejoin:round"${s.total ? ' class="ink"' : ''}/>`;
  }

  // legend
  let ly = T - 8;
  for (const s of series) {
    body += `<path d="${sketchLine(r, R - 250, ly - 5, R - 222, ly - 5, 0.5)}" style="stroke:${s.color};stroke-width:3;fill:none"${s.total ? ' class="ink"' : ''}/>`
          + `<text x="${R - 214}" y="${ly}" style="font-size:14px">${esc(s.name)} (${s.times.length})</text>`;
    ly += 22;
  }

  // xkcd-style note pointing at today's value
  const ex = X(t1), ey = Y(totalStars);
  const note = totalStars === 0 ? 'no stars yet, be the first!' : totalStars === 1 ? 'the first star!' : `${totalStars} stars today`;
  const nx = ex - 150, ny = Math.min(B - 30, ey + 58);
  body += `<text x="${f(nx - 4)}" y="${f(ny + 5)}" text-anchor="end" style="font-size:15px;font-weight:700">${esc(note)}</text>`
        + `<path class="ink" d="${smooth([[nx, ny], [nx + 60, ny - 8], [ex - 30, ey + 22], [ex - 6, ey + 6]])}"/>`
        + `<path class="ink" d="${sketchLine(r, ex - 6, ey + 6, ex - 15, ey + 4, 0.3)}${sketchLine(r, ex - 6, ey + 6, ex - 9, ey + 15, 0.3)}"/>`;
  if (!series.length) body += `<path d="${wobbly(r, [[X(t0), Y(0)], [X(t1), Y(0)]], 1)}" style="fill:none;stroke:#2f81f7;stroke-width:2.6"/>`;

  return svg(W, H, `Star history: ${totalStars} stars in total`, body);
}

// ------------------------------------------------------------------
//  Chart 3: build log, from scripts/timeline.json
// ------------------------------------------------------------------

const KIND = { plane: '#2f81f7', game: '#8250df', tool: '#1f9d55' };

function drawTimeline() {
  const data = JSON.parse(readFileSync(join(ROOT, 'scripts', 'timeline.json'), 'utf8'));
  const r = seeded('timeline');
  const items = data.items;
  const W = 900, H = 330, axisY = 172, x0 = 104, x1 = W - 104;
  const dx = (x1 - x0) / Math.max(1, items.length - 1);

  let body = `<text x="24" y="38" style="font-weight:700;font-size:22px">${esc(data.title)}</text>`
           + `<text class="muted" x="24" y="60" style="font-size:14px">${esc(data.subtitle)}</text>`;
  body += `<path class="ink" d="${sketchLine(r, 30, axisY, W - 22, axisY)}${sketchLine(r, W - 32, axisY - 6, W - 21, axisY, 0.4)}${sketchLine(r, W - 32, axisY + 6, W - 21, axisY, 0.4)}"/>`;

  items.forEach((it, i) => {
    const x = x0 + i * dx, up = i % 2 === 0, color = KIND[it.kind] || '#8c959f';
    // a break in the axis where a long pause in time is skipped
    if (it.gapBefore) {
      const bx = x - dx / 2;
      body += `<rect class="paper" x="${f(bx - 7)}" y="${axisY - 4}" width="14" height="8"/>`
            + `<path class="ink" d="${sketchLine(r, bx - 9, axisY + 9, bx - 1, axisY - 9, 0.4)}${sketchLine(r, bx + 1, axisY + 9, bx + 9, axisY - 9, 0.4)}"/>`
            + `<text class="muted" x="${f(bx)}" y="${axisY + 30}" text-anchor="middle" style="font-size:12px">${esc(it.gapBefore)}</text>`;
    }
    const stemTo = up ? axisY - 30 : axisY + 30;
    body += `<path class="faint" d="${sketchLine(r, x, axisY, x, stemTo, 0.3, 1)}"/>`;
    if (it.highlight) body += `<polygon points="${star(x, axisY, 13)}" style="fill:#e3b341;stroke:#9a6700;stroke-width:1.2"/>`;
    else body += `<circle cx="${f(x)}" cy="${axisY}" r="8" style="fill:${color}"/><path class="ink" d="${sketchCircle(r, x, axisY, 9)}"/>`;
    const lines = [[it.date, 'muted', 13, 400], [it.label, '', 15, 700], [it.zh, 'muted', 13, 400]].filter((l) => l[0]);
    lines.forEach(([txt, cls, size, weight], k) => {
      const y = up ? axisY - 42 - (lines.length - 1 - k) * 19 : axisY + 50 + k * 19;
      body += `<text${cls ? ` class="${cls}"` : ''} x="${f(x)}" y="${f(y)}" text-anchor="middle" style="font-size:${size}px;font-weight:${weight}">${esc(txt)}</text>`;
    });
  });

  let lx = W - 300;
  for (const [kind, color] of Object.entries(KIND)) {
    body += `<circle cx="${lx}" cy="${H - 22}" r="6" style="fill:${color}"/><text class="muted" x="${lx + 12}" y="${H - 17}" style="font-size:14px">${kind}</text>`;
    lx += 80;
  }
  return svg(W, H, `${data.title}: ${items.map((it) => it.label).join(', ')}`, body);
}

// ------------------------------------------------------------------
//  README: latest releases
// ------------------------------------------------------------------

function updateReadme(user) {
  const file = join(ROOT, 'README.md');
  const readme = readFileSync(file, 'utf8');
  const releases = user.repositories.nodes
    .flatMap((repo) => repo.releases.nodes.filter((x) => !x.isDraft && !x.isPrerelease && x.publishedAt).map((x) => ({ repo, ...x })))
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
    .slice(0, 5);
  const lines = releases.map((x) => `- **[${x.repo.name}](${x.repo.url})** · [${x.name || x.tagName}](${x.url}) · ${x.publishedAt.slice(0, 10)}`);
  if (!lines.length) lines.push('- nothing released yet');
  const start = '<!-- releases:start -->', end = '<!-- releases:end -->';
  const a = readme.indexOf(start), b = readme.indexOf(end);
  if (a < 0 || b < a) { console.log('README has no release markers, skipped'); return; }
  const next = readme.slice(0, a + start.length) + '\n' + lines.join('\n') + '\n' + readme.slice(b);
  if (next !== readme) { writeFileSync(file, next); console.log('README: release list updated'); }
  else console.log('README: release list unchanged');
}

// ------------------------------------------------------------------

if (!TOKEN) { console.error('GITHUB_TOKEN is not set'); process.exit(1); }
const user = await loadProfile();
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'stats.svg'), drawStats(user));
writeFileSync(join(OUT, 'stars.svg'), drawStars(user));
writeFileSync(join(OUT, 'timeline.svg'), drawTimeline());
updateReadme(user);
console.log(`Wrote stats.svg, stars.svg and timeline.svg to ${OUT}`);

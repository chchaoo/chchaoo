"""Build an English profile from public GitHub metadata. Python stdlib only."""
import argparse
import base64
import html
import hashlib
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from datetime import datetime
from html.parser import HTMLParser

ROOT = Path(__file__).resolve().parents[1]
GROUPS = {
    "tools": "Software & utilities",
    "aircraft": "RC aircraft & plans",
}


def api(path, data=None):
    headers = {"Accept": "application/vnd.github+json", "User-Agent": "chchaoo-profile"}
    payload = None if data is None else json.dumps(data).encode("utf-8")
    if payload is not None:
        headers["Content-Type"] = "application/json"
    token = os.environ.get("GITHUB_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    for attempt in range(3):
        try:
            request = urllib.request.Request("https://api.github.com" + path, headers=headers, data=payload)
            with urllib.request.urlopen(request, timeout=30) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            if error.code in (401, 403) and "Authorization" in headers and data is None:
                del headers["Authorization"]
                continue
            if error.code < 500 or attempt == 2:
                raise
        except (urllib.error.URLError, TimeoutError):
            if attempt == 2:
                raise
        time.sleep(attempt + 1)
    raise RuntimeError(f"Unable to fetch {path}")


def pages(path):
    result = []
    for page in range(1, 1001):
        batch = api(f"{path}{'&' if '?' in path else '?'}per_page=100&page={page}")
        if not isinstance(batch, list):
            raise ValueError("Expected a list from GitHub")
        result.extend(batch)
        if len(batch) < 100:
            return result
    raise RuntimeError("Pagination limit exceeded; leaving the profile unchanged")


def eligible(repos, login):
    return [r for r in repos if not r.get("private") and not r.get("archived")
            and r["name"].lower() != login.lower()]


def discover(config):
    login = urllib.parse.quote(config["login"], safe="")
    repos = eligible(pages(f"/users/{login}/repos?type=owner&sort=full_name"), config["login"])
    if not repos:
        raise ValueError("No public projects returned; leaving the profile unchanged")
    photos = {}
    for repo in repos:
        if group(repo, config) == "aircraft":
            photo = readme_photo(repo, config)
            if photo:
                photos[repo["name"]] = photo
    return {"repos": repos, "pinned": pinned_projects(config["login"]), "photos": photos}


def pinned_projects(login):
    query = """query($login: String!) {
      user(login: $login) {
        pinnedItems(first: 6, types: [REPOSITORY]) {
          nodes { ... on Repository { nameWithOwner } }
        }
      }
    }"""
    response = api("/graphql", {"query": query, "variables": {"login": login}})
    if response.get("errors") or not response.get("data", {}).get("user"):
        raise ValueError("Unable to read pinned projects; leaving the profile unchanged")
    return [item["nameWithOwner"] for item in response["data"]["user"]["pinnedItems"]["nodes"]]


def group(repo, config):
    return "aircraft" if repo["name"] in config["aircraft_projects"] else "tools"


def plain(value):
    return re.sub(r"\s+", " ", str(value or "")).strip()


def md(value):
    value = html.escape(plain(value), quote=False)
    return "".join("\\" + c if c in "\\[]*_|" + chr(96) else c for c in value)


def description(repo, config):
    return repo.get("description") or ""


def title(repo, config):
    return repo["name"]


class ImageTag(HTMLParser):
    def __init__(self):
        super().__init__()
        self.src = None

    def handle_starttag(self, tag, attrs):
        if tag.lower() == "img":
            self.src = dict(attrs).get("src")


def first_photo(text, repo, readme_path, login):
    # Ignore examples and comments, then inspect Markdown and HTML images in order.
    text = re.sub(r'<!--.*?-->|```.*?```|~~~.*?~~~', '', text, flags=re.S)
    refs = dict((k.casefold(), v) for k, v in re.findall(
        r'^\s*\[([^\]]+)\]:\s*<?([^\s>]+)>?', text, re.M))
    pattern = r'<img\b[^>]*>|!\[([^\]]*)\]\(\s*(<[^>]+>|[^\s)]+)(?:\s+[^)]*)?\)|!\[([^\]]*)\]\[([^\]]*)\]'
    branch = urllib.parse.quote(repo.get("default_branch", "main"), safe="")
    root = f'https://raw.githubusercontent.com/{login}/{repo["name"]}/{branch}/'
    base = urllib.parse.urljoin(root, readme_path)
    for match in re.finditer(pattern, text, re.I):
        if match.group(0).lower().startswith('<img'):
            parser = ImageTag()
            parser.feed(match.group(0))
            src = parser.src
        else:
            src = match.group(2) or refs.get((match.group(4) or match.group(3) or '').casefold())
        if not src:
            continue
        src = html.unescape(src.strip('<>'))
        # Root-relative paths refer to the repository, not raw.githubusercontent.com.
        url = urllib.parse.urljoin(root if src.startswith('/') else base, src.lstrip('/') if src.startswith('/') else src)
        parts = urllib.parse.urlsplit(url)
        if parts.scheme != 'https':
            continue
        if parts.hostname == 'github.com' and '/blob/' in parts.path:
            url = 'https://raw.githubusercontent.com' + parts.path.replace('/blob/', '/', 1)
            parts = urllib.parse.urlsplit(url)
        # README badges and vector plan diagrams are not aircraft photographs.
        if parts.hostname in ('img.shields.io', 'shields.io', 'badgen.net'):
            continue
        if not re.search(r'\.(?:jpe?g|png|webp|gif|avif)$', parts.path, re.I):
            continue
        return urllib.parse.quote(url, safe=":/?&=%#+@,;~!$'()*[]")
    return None


def readme_photo(repo, config):
    name = urllib.parse.quote(repo['name'], safe='')
    login = urllib.parse.quote(config['login'], safe='')
    try:
        readme = api(f'/repos/{login}/{name}/readme')
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return None
        raise
    text = base64.b64decode(readme['content']).decode('utf-8')
    return first_photo(text, repo, readme['path'], config['login'])


def repo_url(repo, config):
    return "https://github.com/" + config["login"] + "/" + urllib.parse.quote(repo["name"], safe="")


def ordered(repos, config, pinned=()):
    pin_rank = {name.lower(): i for i, name in enumerate(pinned)}
    return sorted(repos, key=lambda r: (
        pin_rank.get(f'{config["login"]}/{r["name"]}'.lower(), len(pin_rank)),
        -r.get("stargazers_count", 0),
        -r.get("forks_count", 0),
        -datetime.fromisoformat(r["updated_at"].replace("Z", "+00:00")).timestamp()
        if r.get("updated_at") else 0,
        r["name"].lower()))


def short_count(count):
    for scale, suffix in ((1_000_000_000, 'b'), (1_000_000, 'm'), (1_000, 'k')):
        if count >= scale or (scale > 1_000 and count >= scale * .9995):
            value = count / scale
            return (f'{value:.1f}'.rstrip('0').rstrip('.') if value < 10 else f'{value:.0f}') + suffix
    return str(count)


def metrics_path(repo):
    return f'assets/metrics/{repo["name"]}-classic.svg'


def metrics_svg(repo):
    stars, forks = repo.get('stargazers_count', 0), repo.get('forks_count', 0)
    star_text, fork_text = short_count(stars), short_count(forks)
    # Approximate 10px Verdana glyph widths, with a small trailing margin.
    left, right = 22 + 6 * len(star_text), 22 + 6 * len(fork_text)
    width = left + right
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="20" role="img" aria-label="Stars: {stars}; Forks: {forks}">
<title>Stars: {stars}; Forks: {forks}</title>
<defs><clipPath id="round"><rect width="{width}" height="20" rx="3"/></clipPath></defs>
<g clip-path="url(#round)"><path fill="#555" d="M0 0h{left}v20H0z"/><path fill="#dfb317" d="M{left} 0h{right}v20H{left}z"/></g>
<path fill="#ffd45c" d="m9 4 1.8 3.7 4.1.6-3 2.9.7 4.1L9 13.4l-3.6 1.9.7-4.1-3-2.9 4.1-.6Z"/>
<g transform="translate({left} 0)" fill="none" stroke="#292929" stroke-width="1.2"><circle cx="6" cy="5.5" r="1.5"/><circle cx="12" cy="5.5" r="1.5"/><circle cx="9" cy="14.5" r="1.5"/><path d="M6 7v2q0 2 3 2t3-2V7m-3 4v2"/></g>
<g font-family="Verdana,DejaVu Sans,sans-serif" font-size="10"><text x="18" y="14" fill="#fff">{star_text}</text><text x="{left + 18}" y="14" fill="#292929">{fork_text}</text></g>
</svg>'''



def metrics_source(repo):
    version = hashlib.sha256(metrics_svg(repo).encode('utf-8')).hexdigest()[:12]
    return metrics_path(repo) + '?v=' + version


def render(config, data):
    repos = eligible(data["repos"], config["login"])
    pinned = data.get("pinned", [])
    pin_names = {name.lower() for name in pinned}
    lines = ["<!-- Generated by scripts/build.py from profile.json and public GitHub metadata. -->",
             f'### Hi, I’m {config["login"]}', "", config["intro"], ""]
    photos = []
    for key, label in GROUPS.items():
        entries = [r for r in ordered(repos, config, pinned) if group(r, config) == key]
        if not entries:
            continue
        lines += [f"#### {label}", ""]
        starred, ordinary = [], []
        for repo in entries:
            is_pinned = f'{config["login"]}/{repo["name"]}'.lower() in pin_names
            link = f'[{md(title(repo, config))}]({repo_url(repo, config)})'
            badge = (f'<a href="{repo_url(repo, config)}"><img src="{metrics_source(repo)}" '
                     f'alt="Stars: {repo.get("stargazers_count", 0)}; Forks: {repo.get("forks_count", 0)}" '
                     'align="absmiddle"></a>')
            text = description(repo, config)
            item = link + (' ⭐' if is_pinned else '') + ' ' + badge + (f' — {md(text)}' if text else '')
            if is_pinned:
                starred.append('- ' + item)
            else:
                ordinary.append('- ' + item)
        if starred or ordinary:
            lines += starred + ordinary + ['']
        if key == "aircraft":
            photos = []
            for repo in entries:
                image = data.get("photos", {}).get(repo["name"])
                if image:
                    photos.append(
                        f'<a href="{repo_url(repo, config)}"><img src="{html.escape(image, quote=True)}" '
                        f'width="220" alt="{html.escape(title(repo, config), quote=True)}"></a>')
            if photos:
                lines += ["<p>" + " ".join(photos) + "<br>"]
    snake_root = f'https://raw.githubusercontent.com/{config["login"]}/{config["login"]}/output'
    lines += ["<picture>" if photos else "<p><picture>",
              f'  <source media="(prefers-color-scheme: dark)" srcset="{snake_root}/github-snake-dark.svg">',
              f'  <img src="{snake_root}/github-snake.svg" width="100%" alt="A snake eating the GitHub contribution graph">',
              "</picture></p>", ""]
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--fixture", type=Path, help="Use saved data instead of the API")
    parser.add_argument("--save-data", type=Path)
    args = parser.parse_args()
    config = json.loads((ROOT / "profile.json").read_text(encoding="utf-8"))
    data = json.loads(args.fixture.read_text(encoding="utf-8")) if args.fixture else discover(config)
    # Complete discovery and rendering before replacing the existing page.
    rendered = {"README.md": render(config, data)}
    rendered.update({metrics_path(repo): metrics_svg(repo)
                     for repo in eligible(data['repos'], config['login'])})
    for name, content in rendered.items():
        path = ROOT / name
        path.parent.mkdir(parents=True, exist_ok=True)
        if not path.exists() or path.read_text(encoding="utf-8") != content:
            path.write_text(content, encoding="utf-8", newline="\n")
    if args.save_data:
        args.save_data.parent.mkdir(parents=True, exist_ok=True)
        args.save_data.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f'Built English profile: {len(data["repos"])} projects.')


if __name__ == "__main__":
    main()

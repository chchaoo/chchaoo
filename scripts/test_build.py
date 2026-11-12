import base64
import json
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET
from unittest.mock import patch
from pathlib import Path

import build


class ProfileTests(unittest.TestCase):
    def setUp(self):
        self.config = json.loads((build.ROOT / 'profile.json').read_text(encoding='utf-8'))
        names = [
            'gpt-notebook', 'RCPlane-SU27', 'sha256-folder-verify',
            'external-hdd-keepalive', 'tronclass-resource-download-fixed',
            'Modified-FTVersaWing', 'MazeSolver-Astar', 'lx04-flashing-guide',
        ]
        self.repos = [{'name': n, 'description': 'Useful project', 'topics': []}
                      for n in names]
        self.data = {'repos': self.repos, 'releases': [], 'photos': {
            'RCPlane-SU27': 'https://raw.githubusercontent.com/chchaoo/RCPlane-SU27/main/docs/images/photo-2.jpg',
            'Modified-FTVersaWing': 'https://raw.githubusercontent.com/chchaoo/Modified-FTVersaWing/main/docs/images/photo-1.jpg'}}

    def test_discovery_paginates_and_excludes_hidden_projects(self):
        first = [{'name': f'project-{i}'} for i in range(100)]
        with patch.object(build, 'api', side_effect=[first, [{'name': 'last'}]]) as api:
            self.assertEqual(len(build.pages('/users/test/repos')), 101)
            self.assertIn('page=2', api.call_args.args[0])
        extra = [{'name': 'chchaoo'}, {'name': 'hidden', 'private': True},
                 {'name': 'old', 'archived': True}]
        self.assertEqual(build.eligible(self.repos + extra, 'chchaoo'), self.repos)

    def test_only_selected_aircraft_are_separate_and_all_new_projects_are_tools(self):
        self.repos.extend([{'name': 'new-plane', 'topics': ['rc-plane'], 'description': 'New plane'},
                           {'name': 'uncategorized', 'topics': [], 'description': 'New thing'}])
        self.assertEqual(build.group(self.repos[-2], self.config), 'tools')
        self.assertEqual(build.group(self.repos[-1], self.config), 'tools')
        text = build.render(self.config, self.data)
        self.assertIn('new-plane', text)
        tools, aircraft = text.split('#### RC aircraft & plans', 1)
        self.assertIn('/new-plane', tools)
        self.assertIn('/uncategorized', tools)
        self.assertNotIn('/new-plane', aircraft)
        self.assertIn('/RCPlane-SU27', aircraft)
        self.assertIn('/Modified-FTVersaWing', aircraft)

    def test_live_descriptions_and_escaping(self):
        self.repos[0]['description'] = 'Changed | [text] <img src=x>\nsecond line'
        text = build.render(self.config, self.data)
        self.assertIn('Changed \\| \\[text\\] &lt;img src=x&gt; second line', text)
        self.assertNotIn('<img src=x>', text)

    def test_pinned_projects_lead_their_own_category_with_stars(self):
        self.data['pinned'] = ['chchaoo/lx04-flashing-guide',
                               'chchaoo/Modified-FTVersaWing', 'chchaoo/gpt-notebook']
        text = build.render(self.config, self.data)
        tools, aircraft = text.split('#### RC aircraft & plans', 1)
        self.assertLess(tools.index('- [lx04-flashing-guide'), tools.index('- [gpt-notebook]'))
        self.assertLess(tools.index('- [gpt-notebook]'), tools.index('- [sha256-folder-verify'))
        self.assertLess(aircraft.index('- [Modified-FTVersaWing]'), aircraft.index('- [RCPlane-SU27]'))
        self.assertNotIn('- ⭐', text)
        self.assertEqual(text.count(' ⭐ '), 3)
        self.assertNotIn('lx04-flashing-guide', aircraft)
        self.data['pinned'] = []
        self.assertNotIn(' ⭐ ', build.render(self.config, self.data))

    def test_popularity_order_respects_pins_stars_forks_and_category_boundaries(self):
        stats = {
            'gpt-notebook': (3, 1), 'lx04-flashing-guide': (2, 100),
            'sha256-folder-verify': (10, 1), 'external-hdd-keepalive': (10, 4),
            'tronclass-resource-download-fixed': (9, 100),
            'RCPlane-SU27': (1, 99), 'Modified-FTVersaWing': (5, 0),
        }
        for repo in self.repos:
            repo['stargazers_count'], repo['forks_count'] = stats.get(repo['name'], (0, 0))
        self.data['pinned'] = ['chchaoo/lx04-flashing-guide', 'chchaoo/gpt-notebook']
        text = build.render(self.config, self.data)
        tools, aircraft = text.split('#### RC aircraft & plans', 1)
        names = ['lx04-flashing-guide', 'gpt-notebook', 'external-hdd-keepalive',
                 'sha256-folder-verify', 'tronclass-resource-download-fixed']
        positions = [tools.index('/' + name + ')') for name in names]
        self.assertEqual(positions, sorted(positions))
        self.assertLess(aircraft.index('/Modified-FTVersaWing)'), aircraft.index('/RCPlane-SU27)'))
        # Pinned aircraft still outrank more popular aircraft.
        self.data['pinned'].append('chchaoo/RCPlane-SU27')
        aircraft = build.render(self.config, self.data).split('#### RC aircraft & plans', 1)[1]
        self.assertLess(aircraft.index('/RCPlane-SU27)'), aircraft.index('/Modified-FTVersaWing)'))
        # Rearranging pins takes precedence over both popularity metrics.
        self.data['pinned'] = ['chchaoo/gpt-notebook', 'chchaoo/Modified-FTVersaWing',
                               'chchaoo/lx04-flashing-guide', 'chchaoo/RCPlane-SU27']
        self.repos[0]['stargazers_count'] = 0
        text = build.render(self.config, self.data)
        tools, aircraft = text.split('#### RC aircraft & plans', 1)
        self.assertLess(tools.index('/gpt-notebook)'), tools.index('/lx04-flashing-guide)'))
        self.assertLess(aircraft.index('/Modified-FTVersaWing)'), aircraft.index('/RCPlane-SU27)'))
        self.assertLess(aircraft.index('alt="Modified-FTVersaWing"'), aircraft.index('alt="RCPlane-SU27"'))

    def test_equal_popularity_uses_latest_update_without_overriding_pins(self):
        for repo in self.repos:
            repo['updated_at'] = '2026-11-01T00:00:00Z'
        by_name = {r['name']: r for r in self.repos}
        by_name['lx04-flashing-guide']['updated_at'] = '2026-11-06T00:00:00Z'
        by_name['Modified-FTVersaWing']['updated_at'] = '2026-11-06T00:00:00Z'
        text = build.render(self.config, self.data)
        tools, aircraft = text.split('#### RC aircraft & plans', 1)
        self.assertLess(tools.index('/lx04-flashing-guide)'), tools.index('/gpt-notebook)'))
        self.assertLess(aircraft.index('/Modified-FTVersaWing)'), aircraft.index('/RCPlane-SU27)'))
        self.assertLess(aircraft.index('alt="Modified-FTVersaWing"'), aircraft.index('alt="RCPlane-SU27"'))
        by_name['gpt-notebook']['stargazers_count'] = 1
        by_name['external-hdd-keepalive']['forks_count'] = 1
        names = [r['name'] for r in build.ordered(self.repos, self.config)]
        self.assertLess(names.index('gpt-notebook'), names.index('external-hdd-keepalive'))
        self.assertLess(names.index('external-hdd-keepalive'), names.index('lx04-flashing-guide'))
        pins = ['chchaoo/RCPlane-SU27', 'chchaoo/Modified-FTVersaWing']
        names = [r['name'] for r in build.ordered(self.repos, self.config, pins)]
        self.assertEqual(names[:2], ['RCPlane-SU27', 'Modified-FTVersaWing'])

    def test_sort_priority_pin_stars_forks_updated_at_name(self):
        def repo(name, stars, forks, updated):
            return {'name': name, 'stargazers_count': stars,
                    'forks_count': forks, 'updated_at': updated}

        old = '2026-01-01T00:00:00Z'
        new = '2026-02-01T00:00:00Z'
        repos = [
            repo('alpha', 1, 1, old),
            repo('beta', 1, 1, new),
            repo('gamma', 1, 2, old),
            repo('delta', 2, 0, old),
            repo('echo', 1, 1, new),
            repo('pinned-low', 0, 0, old),
            repo('pinned-high', 99, 99, new),
        ]
        pins = ['chchaoo/pinned-low', 'chchaoo/pinned-high']
        names = [r['name'] for r in build.ordered(repos, self.config, pins)]
        self.assertEqual(names, [
            'pinned-low', 'pinned-high', 'delta', 'gamma',
            'beta', 'echo', 'alpha',
        ])
        self.assertEqual(names, [r['name'] for r in
                         build.ordered(list(reversed(repos)), self.config, pins)])

    def test_missing_updated_at_sorts_after_present_timestamp(self):
        repos = [
            {'name': 'missing', 'stargazers_count': 0, 'forks_count': 0},
            {'name': 'dated', 'stargazers_count': 0, 'forks_count': 0,
             'updated_at': '2026-01-01T00:00:00Z'},
        ]
        self.assertEqual([r['name'] for r in build.ordered(repos, self.config)],
                         ['dated', 'missing'])

    def test_foreign_repo_with_same_name_does_not_mark_owned_project(self):
        self.data['pinned'] = ['someone-else/gpt-notebook']
        self.assertNotIn(' ⭐ ', build.render(self.config, self.data))

    def test_pinned_and_ordinary_projects_share_the_same_paragraph_spacing(self):
        self.data['pinned'] = ['chchaoo/gpt-notebook']
        tools = build.render(self.config, self.data).split('#### Software & utilities\n\n', 1)[1]
        tools = tools.split('\n\n#### RC aircraft & plans', 1)[0].strip()
        self.assertNotIn('\n\n', tools)
        self.assertEqual(sum(line.startswith('- [') for line in tools.splitlines()), 6)
        self.assertNotIn('<br>', tools)
        self.assertNotIn('assets/markers/', tools)
        self.assertIn('[gpt-notebook](https://github.com/chchaoo/gpt-notebook) ⭐ <a', tools)

    def test_titles_use_exact_repository_names(self):
        for repo in self.repos + [{'name': '中文-repo_Name'}]:
            self.assertEqual(build.title(repo, self.config), repo['name'])

    def test_compact_badge_contains_both_live_counts_immediately_after_link(self):
        repo = self.repos[0]
        repo.update(stargazers_count=1234, forks_count=56)
        text = build.render(self.config, self.data)
        expected = ('[gpt-notebook](https://github.com/chchaoo/gpt-notebook) '
                    f'<a href="https://github.com/chchaoo/gpt-notebook"><img src="{build.metrics_source(repo)}" '
                    'alt="Stars: 1234; Forks: 56" align="absmiddle"></a>')
        self.assertIn(expected, text)
        svg = ET.fromstring(build.metrics_svg(repo))
        self.assertEqual((svg.get('width'), svg.get('height')), ('80', '20'))
        self.assertEqual(svg.get('aria-label'), 'Stars: 1234; Forks: 56')
        self.assertIn('font-family="Verdana,DejaVu Sans,sans-serif"', build.metrics_svg(repo))
        self.assertNotIn('monospace', build.metrics_svg(repo))
        small = ET.fromstring(build.metrics_svg({'stargazers_count': 0, 'forks_count': 1}))
        large = ET.fromstring(build.metrics_svg({'stargazers_count': 1200, 'forks_count': 2300}))
        self.assertNotEqual(build.metrics_source({'name': 'test', 'stargazers_count': 0}),
                            build.metrics_source({'name': 'test', 'stargazers_count': 1}))
        self.assertEqual(small.get('width'), '56')
        self.assertEqual(large.get('width'), '92')
        self.assertLess(int(small.get('width')), int(svg.get('width')))

        self.assertIn('1.2k', ''.join(svg.itertext()))
        self.assertIn('56', ''.join(svg.itertext()))
        for value in [0, 999, 1000, 1234, 999999, 1000000]:
            self.assertLessEqual(len(build.short_count(value)), 4)

    def test_readme_photos_skip_badges_and_resolve_relative_paths(self):
        repo = {'name': 'plane', 'default_branch': 'main'}
        readme = '''[![Plans](https://img.shields.io/badge/plans-DXF)](plans/)
<!-- <img src="hidden.jpg"> -->
```
![Example](example.jpg)
```
<img src="images/first photo.jpg" width="49%"> ![Second](second.jpg)
'''
        self.assertEqual(build.first_photo(readme, repo, 'docs/README.md', 'chchaoo'),
                         'https://raw.githubusercontent.com/chchaoo/plane/main/docs/images/first%20photo.jpg')
        self.assertEqual(build.first_photo('![Plan](plan.svg) ![Photo](../photo.png)',
                                          repo, 'docs/README.md', 'chchaoo'),
                         'https://raw.githubusercontent.com/chchaoo/plane/main/photo.png')
        self.assertEqual(build.first_photo('![Photo][cover]\n[cover]: /images/cover.jpg',
                                          repo, 'docs/README.md', 'chchaoo'),
                         'https://raw.githubusercontent.com/chchaoo/plane/main/images/cover.jpg')
        self.assertIsNone(build.first_photo('![Badge](https://img.shields.io/badge/test.png)',
                                           repo, 'README.md', 'chchaoo'))

    def test_photo_discovery_reads_current_readme(self):
        text = '<img src="docs/photo-2.jpg"><img src="docs/photo-1.jpg">'
        data = {'path': 'README.md', 'content': base64.b64encode(text.encode()).decode()}
        with patch.object(build, 'api', return_value=data) as api:
            photo = build.readme_photo({'name': 'RCPlane-SU27', 'default_branch': 'main'}, self.config)
        self.assertTrue(photo.endswith('/main/docs/photo-2.jpg'))
        api.assert_called_once_with('/repos/chchaoo/RCPlane-SU27/readme')

    def test_photo_order_tracks_sorted_aircraft_and_missing_photo_is_omitted(self):
        self.data['pinned'] = ['chchaoo/Modified-FTVersaWing']
        text = build.render(self.config, self.data)
        self.assertLess(text.index('src="' + self.data['photos']['Modified-FTVersaWing']),
                        text.index('src="' + self.data['photos']['RCPlane-SU27']))
        self.data['photos'] = {}
        text = build.render(self.config, self.data)
        self.assertEqual(text.count('<img '), len(self.repos) + 1)  # Only the snake remains.
        self.assertIn('<p><picture>', text)

    def test_pin_api_failure_is_not_treated_as_no_pins(self):
        with patch.object(build, 'api', return_value={'errors': [{'message': 'Unavailable'}]}):
            with self.assertRaises(ValueError):
                build.pinned_projects('chchaoo')

    def test_private_or_deleted_projects_disappear(self):
        self.repos[0]['private'] = True
        self.assertNotIn('/gpt-notebook', build.render(self.config, self.data))
        self.assertIn('/RCPlane-SU27', build.render(self.config, self.data))

    def test_stable_order_and_no_empty_sections(self):
        self.assertEqual(build.render(self.config, self.data),
                         build.render(self.config, {**self.data, 'repos': list(reversed(self.repos))}))
        self.assertNotIn('Recent releases', build.render(self.config, self.data))
        self.assertNotIn('More projects', build.render(self.config, self.data))

    def test_compact_english_page_keeps_category_order_and_snake(self):
        text = build.render(self.config, self.data)
        headings = ['Software & utilities', 'RC aircraft & plans']
        positions = [text.index('#### ' + heading) for heading in headings]
        self.assertEqual(positions, sorted(positions))
        self.assertEqual(text.count('<img '), len(self.repos) + 3)
        self.assertEqual(text.count('width="220"'), 2)
        self.assertLess(text.index('#### RC aircraft & plans'), text.index('src="https://raw.githubusercontent.com/chchaoo/RCPlane-SU27/main/docs/images/photo-2.jpg"'))
        self.assertLess(text.index('src="https://raw.githubusercontent.com/chchaoo/Modified-FTVersaWing/main/docs/images/photo-1.jpg"'), text.index('<picture>'))
        self.assertNotIn('Contribution snake', text)
        self.assertIn('</a><br>\n<picture>', text)
        self.assertNotIn('<table>', text)
        self.assertNotIn('Selected work', text)
        self.assertNotIn('Games & device guides', text)
        self.assertNotIn('More projects', text)
        self.assertNotIn('Recent releases', text)
        self.assertNotRegex(text, r'^#{1,2} ', msg='Use the smaller heading levels')
        self.assertIn('prefers-color-scheme: dark', text)
        self.assertTrue(text.rstrip().endswith('</picture></p>'))
        for repo in self.repos:
            self.assertIn('/' + repo['name'], text)

    def test_original_chinese_and_bilingual_descriptions_are_preserved(self):
        originals = ['Read archives offline. 离线阅读', '泡沫板飞机图纸']
        for repo, original in zip(self.repos, originals):
            repo['description'] = original
            self.assertEqual(build.description(repo, self.config), original)
        self.repos.append({'name': 'new-project', 'description': None, 'topics': []})
        text = build.render(self.config, self.data)
        for original in originals:
            self.assertIn(original, text)
        self.assertNotIn('Source code and documentation.', text)
        self.assertRegex(text, r'- \[new-project\][^\n]+</a>\n')

    def test_api_failure_leaves_existing_pages_untouched(self):
        with tempfile.TemporaryDirectory(dir=build.ROOT) as directory:
            root = Path(directory)
            self.assertEqual(root.resolve().parent, build.ROOT.resolve())
            (root / 'profile.json').write_text(json.dumps(self.config), encoding='utf-8')
            for name in ['README.md']:
                (root / name).write_text('existing page', encoding='utf-8')
            with patch.object(build, 'ROOT', root), patch.object(sys, 'argv', ['build.py']), \
                    patch.object(build, 'discover', side_effect=RuntimeError('API unavailable')):
                with self.assertRaises(RuntimeError):
                    build.main()
            for name in ['README.md']:
                self.assertEqual((root / name).read_text(encoding='utf-8'), 'existing page')


if __name__ == '__main__':
    unittest.main()

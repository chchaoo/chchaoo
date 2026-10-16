# Editing this profile

The page is generated. **Edit [`profile.json`](profile.json)**: the README is rebuilt from this configuration and your public GitHub data, so direct README edits are overwritten.

## How to edit

1. Open `profile.json` on GitHub and click the pencil icon.
2. Change the text between the quotes, keeping valid JSON punctuation.
3. Commit the changes. The workflow rebuilds the page automatically.

The page also refreshes every hour. GitHub can delay scheduled runs. New public repositories are discovered without editing this file or configuring pins. If the JSON is invalid, the workflow reports the error and leaves the page unchanged.

## Configuration

| Field | Purpose |
|---|---|
| `timezone` | Time zone used for displayed dates |
| `banner` | Greeting, name and animated tagline; optional `tagline_extra` adds a second English line |
| `interests` | Line below the banner |
| `sections` | Section headings; an empty string hides a section |
| `discovery.featured_count` | Number of project preview cards (default 6); remaining projects appear below |
| `charts` | Chart titles and subtitles; `{login}` expands to the account name |
| `footer` | Small print at the bottom |
| `projects.<repo>` | Card title, description, image, kind and extra badges |
| `projects.<repo>.release_titles.<tag>` | English display title for a release tag |
| `project_descriptions.<repo>` | English descriptions for projects without a configured card |
| `planes` | Table columns, rows and note |
| `timeline.milestones` | Additional events with `date`, `label`, optional `detail` and `kind` |
| `timeline.hide` | Automatic event IDs to omit, such as `created:repo-name` |
| `timeline.max` | Maximum number of timeline events |

Public repositories owned by this account are discovered automatically, including forks. The profile repository and archived projects are excluded from the cards. Projects are ranked by stars, then forks, then latest push, with the repository name breaking any remaining ties. The first six get preview cards; all remaining projects appear under More projects in the same order. Deleted or private repositories disappear at the next refresh. Discovery follows pagination beyond 100 repositories.

Cards use the live repository description, language, star count, fork count and latest release. A custom GitHub social preview image takes priority, followed by an optional configured image and an automatically generated English preview. No image configuration is required for a new project. An English prefix is retained from bilingual descriptions; an optional configured English description or a generic English sentence is used for descriptions without English text. Generated images use content versions to avoid stale GitHub image caches.

The native GitHub section below this README uses Popular repositories automatically when no items are pinned. Its ranking is controlled by GitHub, independently of this README. Do not manually pin items if you want that native section to stay automatic.

The build log combines repository creation dates, releases and configured milestones. Latest releases, repository statistics, star history and the contribution snake update from public GitHub data.

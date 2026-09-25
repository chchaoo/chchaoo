# Editing this profile · 如何修改主页

The page is generated. **Edit [`profile.json`](profile.json), never `README.md`**: the README is rewritten from `profile.json` and your GitHub data, and hand edits to it are lost.

主页是自动生成的。**请修改 [`profile.json`](profile.json)，不要直接改 `README.md`**：README 会根据 `profile.json` 和 GitHub 数据重新生成，手改的内容会被覆盖。

## How to edit · 怎么改

1. Open [`profile.json`](profile.json) on GitHub and click the pencil icon.
   在 GitHub 上打开 `profile.json`，点铅笔图标编辑。
2. Change the text between the quotes. Keep the quotes and commas.
   只改引号里的文字，引号和逗号要保留。
3. Click **Commit changes**. The page is rebuilt within a minute or two.
   点 **Commit changes**，一两分钟后主页自动更新。

If the JSON is broken (a missing comma or quote), the run fails, GitHub emails you the line number, and the page stays as it was.
如果格式写错了（少了逗号或引号），这次更新会失败，GitHub 会发邮件告诉你出错的行号，主页保持原样不变。

## What updates by itself · 自动更新的部分

Every six hours, and right after `profile.json` changes · 每六小时一次，改完 `profile.json` 后也会立刻更新：

| Part · 部分 | Comes from · 来源 |
|---|---|
| Project cards · 项目卡片 | your **pinned** repositories, in pinned order · 你置顶的仓库，按置顶顺序 |
| More projects · 更多项目 | every other public repository · 其余公开仓库 |
| Plane table · 飞机图纸表 | rows in `planes`, plus any repository with the topic `rc-plane` · `planes` 里的行，加上带 `rc-plane` 话题的仓库 |
| Build log · 制作历程 | new repositories, every release, and `timeline.milestones` · 新仓库、每次发布，加上手写的里程碑 |
| Latest releases · 最新发布 | the five newest releases · 最新五个发布 |
| Numbers, star history, snake · 数据、star 曲线、贪吃蛇 | public GitHub data · GitHub 公开数据 |

Dates are shown in the `timezone` set at the top of `profile.json` (now Los Angeles).
日期按 `profile.json` 开头的 `timezone` 显示（现在是洛杉矶时间）。

## The fields · 各项说明

| Field · 字段 | What it changes · 改什么 |
|---|---|
| `banner.greeting`, `banner.name` | Big headline on the banner · 横幅大标题 |
| `banner.tagline`, `banner.tagline_zh` | The two typed lines under it. Keep each under about 60 characters, or it runs into the plane. · 下面逐字打出的两行，每行不超过约 60 个字符，否则会碰到飞机图案 |
| `interests` | The line under the banner · 横幅下面的一行 |
| `sections.*` | Section headings. An empty `""` hides that section. · 各栏标题，写成 `""` 就隐藏这一栏 |
| `charts.*` | Titles on the hand-drawn charts; `{login}` becomes your user name · 手绘图表的标题，`{login}` 会替换成用户名 |
| `footer` | Small print at the bottom · 页面底部的小字 |
| `projects.<repo>` | How a repository is shown · 某个仓库怎么显示：<br>`title`, `title_zh` short names on the build log · 时间线上的短名称<br>`description`, `zh` card text (default: the repository description) · 卡片文字（默认用仓库简介）<br>`image` card picture (default: the repository's social preview) · 卡片图片（默认用仓库的社交预览图）<br>`kind` `plane`, `game` or `tool` (the dot colour) · 类别，决定时间线圆点颜色<br>`badges` extra badges, `["label", "message", "colour"]` · 额外徽章 |
| `planes.rows` | The plane table: one row per plane · 飞机表，每架一行 |
| `timeline.milestones` | Extra points on the build log, date as `2026-09-24` or `2026-09` · 时间线上手写的节点 |
| `timeline.hide` | Automatic points to leave out, e.g. `created:repo-name`, `release:repo-name:v1` · 不想显示的自动节点 |
| `timeline.max` | How many points the build log shows · 时间线最多显示几个节点 |

## A new project · 发布新项目时

Nothing is required: it appears under *More projects* and on the build log by itself. To give it a card, **pin it** on your profile. For a nicer card, add an entry under `projects` with a description and a picture (put the picture in `assets/`), or upload a *Social preview* image in the repository's settings.

什么都不用做：它会自动出现在"更多项目"和时间线上。想让它显示成卡片，就在主页上**置顶**它。想让卡片更好看，可以在 `projects` 里加上它的简介和图片（图片放进 `assets/`），或者在仓库设置里上传一张 *Social preview* 图片。

# 滚动新闻快照采集与归档

本服务面向新闻编辑部和数据运营人员：采集经常刷新的新闻目录页面，规范化标题与链接，并在本地 SQLite 中保留每次采集及文章出现历史。一次短暂的页面缺项不会立刻从归档删除新闻；操作者可以查看快照差异、采集健康、审核记录，并导出 CSV。

## 环境

- Node.js `22.23.4`。
- 仅使用 Node 内置模块和 SQLite，无第三方包，不要求网络连接。

## 验收与演示

```sh
npm test
npm run build
npm run demo
```

演示会读取本地合成页面并在临时目录建立数据库，输出一次采集摘要后清理临时文件。生产数据库由 `ARCHIVE_DB` 指定，默认 `./var/archive.sqlite`。默认 HTTP 监听地址为 `127.0.0.1:8080`，可用 `HOST` 和 `PORT` 调整。

## HTTP 接口

- `POST /v1/feeds`：注册来源，提交 `feedId`、`baseUrl`、`allowedHosts`，以及可选的 `minimumItems`、`missingThreshold`。
- `POST /v1/feeds/:feedId/snapshots`：提交已保存的 HTML 页面；可用 `X-Captured-At` 指定采集时间。
- `POST /v1/feeds/:feedId/refresh`：手动抓取已注册来源；仅访问允许列表中的 DNS 主机。
- `GET /v1/feeds/:feedId`：查看 feed 状态、文章统计和采集健康。
- `GET /v1/feeds/:feedId/items`：分页读取文章；`visibility=visible|quiet` 可过滤状态。
- `GET /v1/feeds/:feedId/runs`：读取近期页面快照接纳/拒绝记录。
- `GET /v1/feeds/:feedId/attempts`：读取抓取请求、重试、失败和响应审计。
- `GET /v1/feeds/:feedId/changes`：比较最近两次已接纳快照；未达到两次时返回 `409`。
- `GET /v1/feeds/:feedId/health`：读取 24 小时抓取成功率、最近成功时间和异常提示。
- `GET /v1/feeds/:feedId/items.csv`：流式导出；限制输出行数并转义表格公式前缀。
- `PATCH /v1/feeds/:feedId/items/:articleId/review`：按修订号更新审核状态，状态为 `unreviewed`、`confirmed` 或 `withdrawn`。
- `GET /v1/feeds/:feedId/items/:articleId/review`：查看审核事件历史。
- `GET /v1/feeds/:feedId/items/:articleId/history`：查看文章在已接纳列表快照中的出现位置和间隔。
- `POST /v1/stories`：人工归并两个及以上来源稿为一篇稿件，提交 `articleIds` 与可选 `title`、`note`；不读取标题相似度，无自动归并。
- `POST /v1/stories/:storyId/members`：把后来采到的来源稿加入既有归并，需带 `expectedRevision`。
- `POST /v1/stories/:storyId/unmerge`：撤销误归并，提交要移出的 `articleIds` 与 `expectedRevision`；只结束当前成员关系，历史观察与事件全部保留。
- `GET /v1/stories/:storyId`：查看归并稿及其每个来源成员的来源标题、发布时间、列表出现状态和人工审核决定。
- `GET /v1/stories/:storyId/events`：查看归并、加入、撤销、解散的 append-only 审计事件流。
- `GET /v1/stories/overview`：跨来源去重总览，支持 `visibility`、`limit`、`offset`；响应内附口径说明与来源级/总览数量对账。
- `GET /health`：进程健康检查。

抓取失败、页面异常和正常列表变更有不同记录。相同页面指纹重复提交时不会重复增加文章观察次数。短暂缺失需达到来源配置的连续快照阈值后才转为 `quiet`，重新出现时恢复 `visible`。人工审核状态独立于可见性状态，旧修订号会得到冲突响应而不会覆盖新审核决定。

### 转载稿归并与两种计数口径

来源稿始终按 `(feed_id, canonical_url)` 独立存储：来源标题、发布时间、列表出现状态、滚动缺失计数与人工审核决定各自保留，归并层不复制也不覆盖它们。归并只接受显式人工指令，系统不会因标题相似而自动认定同稿。

- 来源级列表（`/v1/feeds/:feedId/items` 及其 `statistics`）按来源稿计数，同一转载稿在每个提供过它的来源各出现一次，用于回答"每个来源何时提供过它"。
- 跨来源总览（`/v1/stories/overview`）按归并后的稿件去重：每个活跃归并（story）计为一条，未归并来源稿各计一条；响应的 `reconciliation` 给出 `sourceArticleTotal - overviewTotal = difference` 的对账，差值等于活跃归并内多出来源副本数。
- 归并条目的可见性由成员聚合：任一来源成员仍在列即为 `visible`，全部连续缺项达阈值才为 `quiet`。一个来源再次采到稿件只重置该来源自己的缺失计数，不会重新激活另一个已安静的来源。
- 撤销误归并只把当前成员关系标记为 `left` 并追加审计事件；`articles` 与 `capture_items` 的历史观察一行不改，无需重造。最后一个成员离开后 story 转为 `dissolved`，其事件流仍可追溯，之后可重新归并为新 story。

仓库中的 HTML 样本为本地合成数据，仅用于离线演示和测试。实际部署前请配置准确来源域名，并遵守来源站点的使用条件。本服务不在后台隐式启动定时抓取；由操作者或外部调度器显式触发刷新。

import test from "node:test";
import assert from "node:assert/strict";
import { makeArchive, page, captureTime } from "../helpers.js";
import { createHttpServer } from "../../src/http/server.js";

const FEED_A = {
  feedId: "agency-a",
  baseUrl: "https://a.example.test/scroll-news/news1.html",
  allowedHosts: ["a.example.test"],
  minimumItems: 1,
  missingThreshold: 3
};
const FEED_B = {
  feedId: "agency-b",
  baseUrl: "https://b.example.test/scroll-news/news1.html",
  allowedHosts: ["b.example.test"],
  minimumItems: 1,
  missingThreshold: 3
};
// 不同主机、不同 canonical URL、不同来源标题：转载稿在来源侧永远是两篇独立文章。
const STORY_URL_A = "https://a.example.test/2026/11/shared-wire.html";
const STORY_URL_B = "https://b.example.test/2026/11/republished-wire.html";
const OTHER_URL_A = "https://a.example.test/2026/11/local-a.html";
const SAME_TITLE = "同题不同稿：只是标题一样";

function storyPageA(extra = []) {
  return page([
    { id: "shared", url: STORY_URL_A, title: "电讯稿：A 来源原标题" },
    ...extra
  ]);
}
function storyPageB(extra = []) {
  return page([
    { id: "shared", url: STORY_URL_B, title: "电讯稿：B 来源转载标题" },
    ...extra
  ]);
}
function pageWith(url, title) {
  return page([{ id: "x", url, title }]);
}

async function seeded(t) {
  const { archive } = await makeArchive(t, { clock: () => new Date("2026-11-17T00:00:00.000Z") });
  archive.registerFeed(FEED_A);
  archive.registerFeed(FEED_B);
  return archive;
}

function findByUrl(archive, feedId, suffix) {
  return archive.listItems(feedId, { limit: 200 }).items.find((item) => item.canonicalUrl.endsWith(suffix));
}

test("合成全流程：先人工归并、来源各自滚动缺失、再撤销且不重造历史观察", async (t) => {
  const archive = await seeded(t);

  // 阶段 0：两个来源各自采到转载稿，标题再像也不会自动归并。
  archive.importSnapshot("agency-a", storyPageA(), captureTime(10));
  archive.importSnapshot("agency-b", storyPageB(), captureTime(11));
  const articleA = findByUrl(archive, "agency-a", "shared-wire.html");
  const articleB = findByUrl(archive, "agency-b", "republished-wire.html");
  assert.ok(articleA && articleB);
  assert.notEqual(articleA.articleId, articleB.articleId);
  const initial = archive.storyOverview();
  assert.equal(initial.pagination.total, 2, "无人工指令时同稿在总览中保持两条");
  assert.equal(initial.entries.every((entry) => entry.kind === "article"), true);
  assert.equal(initial.reconciliation.difference, 0);

  // 阶段 1：显式人工归并，归并依据进入 append-only 事件流。
  const merged = archive.mergeStories({
    articleIds: [articleA.articleId, articleB.articleId],
    note: "核对电头与正文后人工确认同一转载稿"
  });
  assert.equal(merged.status, 201);
  const storyId = merged.story.storyId;
  assert.equal(merged.story.revision, 3, "created + 两个 joined 各占一个修订号");
  const afterMerge = archive.storyOverview();
  assert.equal(afterMerge.pagination.total, 1, "总览按归并稿件去重，同稿只出现一次");
  assert.equal(afterMerge.reconciliation.difference, 1, "来源稿 2 篇、总览 1 条，差值为多出来源副本");
  assert.equal(afterMerge.reconciliation.sourceArticleTotal, 2);
  const entry = afterMerge.entries[0];
  assert.equal(entry.kind, "story");
  assert.equal(entry.sourceCount, 2);
  // 来源标题、发布时间、列表出现状态各自保留。
  assert.deepEqual(entry.members.map((m) => m.feedId).sort(), ["agency-a", "agency-b"]);
  const memberA = entry.members.find((m) => m.feedId === "agency-a");
  const memberB = entry.members.find((m) => m.feedId === "agency-b");
  assert.equal(memberA.title, "电讯稿：A 来源原标题");
  assert.equal(memberB.title, "电讯稿：B 来源转载标题");
  assert.notEqual(memberA.canonicalUrl, memberB.canonicalUrl);
  assert.equal(memberA.visibility, "visible");
  assert.equal(memberB.visibility, "visible");
  // 来源级列表口径不变：仍按来源稿计数。
  assert.equal(archive.articles.stats("agency-a").total, 1);
  assert.equal(archive.articles.stats("agency-b").total, 1);

  // 阶段 2：各自滚动缺失。A 连续 3 次缺项转 quiet；B 仍在列保持 visible。
  const quietPageA = page([{ id: "other", url: OTHER_URL_A, title: "A 来源本地新闻" }]);
  archive.importSnapshot("agency-a", quietPageA, captureTime(20));
  archive.importSnapshot("agency-a", `${quietPageA}<!-- 2 -->`, captureTime(21));
  archive.importSnapshot("agency-a", `${quietPageA}<!-- 3 -->`, captureTime(22));
  archive.importSnapshot("agency-b", `${storyPageB()}<!-- again -->`, captureTime(23));

  const quietA = findByUrl(archive, "agency-a", "shared-wire.html");
  const stillVisibleB = findByUrl(archive, "agency-b", "republished-wire.html");
  assert.equal(quietA.visibility, "quiet");
  assert.equal(quietA.missingStreak, 3);
  assert.equal(stillVisibleB.visibility, "visible");
  assert.equal(stillVisibleB.missingStreak, 0);
  // story 条目按成员聚合：任一来源仍在列，稿件在总览中就是 visible，但成员级状态不被覆盖。
  const rolling = archive.storyOverview();
  const storyEntry = rolling.entries.find((item) => item.storyId === storyId);
  assert.equal(storyEntry.visibility, "visible");
  assert.equal(storyEntry.members.find((m) => m.feedId === "agency-a").visibility, "quiet");
  assert.equal(storyEntry.members.find((m) => m.feedId === "agency-b").visibility, "visible");
  // quiet 过滤口径：story 仍含 visible 成员所以留在 visible 总览；全 quiet 条目才进 quiet 总览。
  const visibleOverview = archive.storyOverview({ visibility: "visible" });
  assert.equal(visibleOverview.pagination.total, 2, "story 条目 + A 来源本地新闻条目");
  assert.ok(visibleOverview.entries.some((item) => item.storyId === storyId));
  const quietOverview = archive.storyOverview({ visibility: "quiet" });
  assert.equal(quietOverview.pagination.total, 0, "没有任何条目全成员 quiet"
  );

  // 阶段 3：B 再采到稿件，不能把已安静的 A 重新激活。
  archive.importSnapshot("agency-b", `${storyPageB()}<!-- third pass -->`, captureTime(30));
  const stillQuietA = findByUrl(archive, "agency-a", "shared-wire.html");
  assert.equal(stillQuietA.visibility, "quiet", "另一来源的新观察不会跨来源重置缺失计数");
  assert.equal(stillQuietA.missingStreak, 3);
  const refreshedB = findByUrl(archive, "agency-b", "republished-wire.html");
  assert.equal(refreshedB.seenCount, 3, "初次与两次再采集各计一次观察");
  assert.equal(refreshedB.visibility, "visible");

  // 两个来源都连续缺项后，story 才整体进入 quiet 总览，且成员仍各自保留缺失计数。
  const bOnlyPage = page([{ id: "b-local", url: "https://b.example.test/2026/11/b-local.html", title: "B 来源本地新闻" }]);
  for (const second of [40, 41, 42]) {
    archive.importSnapshot("agency-b", `${bOnlyPage}<!--${second}-->`, captureTime(second));
  }
  assert.equal(findByUrl(archive, "agency-b", "republished-wire.html").visibility, "quiet");
  const fullyQuiet = archive.storyOverview({ visibility: "quiet" });
  assert.equal(fullyQuiet.entries.filter((item) => item.storyId === storyId).length, 1);
  assert.equal(archive.storyOverview({ visibility: "visible" }).entries.some((item) => item.storyId === storyId), false);
  // B 重新出现只恢复 B 与 story 聚合状态，A 的 quiet 历史不被改写。
  archive.importSnapshot("agency-b", `${storyPageB()}<!-- back -->`, captureTime(43));
  assert.equal(findByUrl(archive, "agency-a", "shared-wire.html").visibility, "quiet");
  assert.equal(findByUrl(archive, "agency-b", "republished-wire.html").visibility, "visible");

  // 阶段 4：撤销误归并。只结束当前成员关系，历史观察一行不动。
  const historyBefore = archive.articleTimeline("agency-a", articleA.articleId).observationCount;
  assert.ok(historyBefore >= 1);
  const undone = archive.unmergeStories(storyId, {
    articleIds: [articleA.articleId, articleB.articleId],
    expectedRevision: merged.story.revision,
    note: "发现电头不同，撤销误归并"
  });
  assert.equal(undone.status, 200);
  assert.equal(undone.story.status, "dissolved");
  const finalOverview = archive.storyOverview();
  assert.equal(finalOverview.pagination.total, 4, "撤销后所有来源稿恢复为独立条目（转载稿 2 + 本地新闻 2）");
  assert.equal(finalOverview.reconciliation.difference, 0, "无活跃归并时总览与来源稿口径一致");
  assert.equal(finalOverview.entries.every((entry) => entry.kind === "article"), true);

  // 历史观察未被重造：时间线观察次数与撤销前一致，来源状态各自保留。
  const historyAfter = archive.articleTimeline("agency-a", articleA.articleId);
  assert.equal(historyAfter.observationCount, historyBefore);
  const restoredA = findByUrl(archive, "agency-a", "shared-wire.html");
  const restoredB = findByUrl(archive, "agency-b", "republished-wire.html");
  assert.equal(restoredA.visibility, "quiet");
  assert.equal(restoredB.visibility, "visible");
  assert.equal(restoredA.seenCount, 1);
  assert.equal(restoredB.seenCount, 4, "撤销不改动来源侧观察计数");

  // 事件流完整保留归并与撤销依据，可追溯。
  const events = archive.storyEvents(storyId);
  assert.deepEqual(events.map((event) => event.kind), ["dissolved", "left", "left", "joined", "joined", "created"]);
  assert.ok(events.every((event) => event.note !== null || event.kind === "dissolved"));
  const leftEvents = events.filter((event) => event.kind === "left");
  assert.deepEqual(leftEvents.map((event) => event.articleId).sort(), [articleA.articleId, articleB.articleId].sort());
  // 撤销后可重新归并（新 story），旧 story 的事件仍可查。
  const remerged = archive.mergeStories({ articleIds: [articleA.articleId, articleB.articleId], note: "二次核对确认" });
  assert.equal(remerged.status, 201);
  assert.notEqual(remerged.story.storyId, storyId);
  assert.equal(archive.storyEvents(storyId).length, 6, "旧 story 审计事件不被新归并覆盖");
  assert.equal(archive.auditIntegrity().status, "consistent");
});

test("never auto-merges on title similarity: same title across feeds stays separate until an explicit merge", async (t) => {
  const archive = await seeded(t);
  archive.importSnapshot("agency-a", pageWith("https://a.example.test/2026/11/alpha.html", SAME_TITLE), captureTime(10));
  archive.importSnapshot("agency-b", pageWith("https://b.example.test/2026/11/beta.html", SAME_TITLE), captureTime(11));
  const overview = archive.storyOverview();
  assert.equal(overview.pagination.total, 2);
  assert.equal(overview.entries.map((entry) => entry.title).every((title) => title === SAME_TITLE), true);
  assert.equal(archive.storyOverview().counts.activeStories, 0);
});

test("keeps per-source manual review decisions independent inside one merged story", async (t) => {
  const archive = await seeded(t);
  archive.importSnapshot("agency-a", storyPageA(), captureTime(10));
  archive.importSnapshot("agency-b", storyPageB(), captureTime(11));
  const articleA = findByUrl(archive, "agency-a", "shared-wire.html");
  const articleB = findByUrl(archive, "agency-b", "republished-wire.html");
  archive.reviewArticle("agency-a", articleA.articleId, { state: "confirmed", expectedRevision: 0, note: "A 已核" });
  archive.reviewArticle("agency-b", articleB.articleId, { state: "withdrawn", expectedRevision: 0, note: "B 撤稿" });
  const merged = archive.mergeStories({ articleIds: [articleA.articleId, articleB.articleId] });
  assert.equal(merged.status, 201);
  const detail = archive.storyDetail(merged.story.storyId);
  const reviews = Object.fromEntries(detail.members.map((member) => [member.feedId, member.reviewState]));
  assert.deepEqual(reviews, { "agency-a": "confirmed", "agency-b": "withdrawn" });
  // 归并不产生共享审核：来源侧修订号与事件仍各自独立。
  assert.equal(archive.reviewEvents("agency-a", articleA.articleId).events.length, 1);
  assert.equal(archive.reviewEvents("agency-b", articleB.articleId).events.length, 1);
  // 撤销后人工决定原样保留。
  archive.unmergeStories(merged.story.storyId, {
    articleIds: [articleA.articleId, articleB.articleId],
    expectedRevision: merged.story.revision
  });
  assert.equal(findByUrl(archive, "agency-a", "shared-wire.html").reviewState, "confirmed");
  assert.equal(findByUrl(archive, "agency-b", "republished-wire.html").reviewState, "withdrawn");
});

test("rejects malformed and conflicting merge requests without writing story rows", async (t) => {
  const archive = await seeded(t);
  archive.importSnapshot("agency-a", storyPageA(), captureTime(10));
  archive.importSnapshot("agency-b", storyPageB(), captureTime(11));
  const articleA = findByUrl(archive, "agency-a", "shared-wire.html");
  const articleB = findByUrl(archive, "agency-b", "republished-wire.html");

  assert.throws(() => archive.mergeStories({ articleIds: [articleA.articleId] }), /at least two/);
  assert.throws(() => archive.mergeStories({ articleIds: [articleA.articleId, "x"] }), /positive integers/);
  assert.equal(archive.mergeStories({ articleIds: [articleA.articleId, 9999] }).status, 404);

  const first = archive.mergeStories({ articleIds: [articleA.articleId, articleB.articleId] });
  assert.equal(first.status, 201);
  // 已在活跃 story 中的文章不能再被归并到别处。
  const repeat = archive.mergeStories({ articleIds: [articleA.articleId, articleB.articleId] });
  assert.equal(repeat.status, 409);
  assert.equal(repeat.error, "article_already_merged");
  assert.equal(repeat.current.storyId, first.story.storyId);
  assert.equal(archive.storyOverview().counts.activeStories, 1);

  // 乐观修订号：过期 expectedRevision 不能改动 story。
  const stale = archive.unmergeStories(first.story.storyId, {
    articleIds: [articleA.articleId], expectedRevision: 1
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.current.revision, first.story.revision);
  // 非成员文章不能从该 story 撤销。
  archive.importSnapshot("agency-a", pageWith(OTHER_URL_A, "A 来源本地新闻"), captureTime(12));
  const outsider = findByUrl(archive, "agency-a", "local-a.html");
  const notMember = archive.unmergeStories(first.story.storyId, {
    articleIds: [outsider.articleId], expectedRevision: first.story.revision
  });
  assert.equal(notMember.status, 409);
  assert.equal(notMember.error, "article_not_in_story");
  assert.equal(archive.auditIntegrity().status, "consistent");
});

test("supports adding a later source copy to an existing story without touching quiet members", async (t) => {
  const archive = await seeded(t);
  archive.importSnapshot("agency-a", storyPageA(), captureTime(10));
  archive.importSnapshot("agency-b", storyPageB(), captureTime(11));
  const articleA = findByUrl(archive, "agency-a", "shared-wire.html");
  const articleB = findByUrl(archive, "agency-b", "republished-wire.html");
  const merged = archive.mergeStories({ articleIds: [articleA.articleId, articleB.articleId] });
  const storyId = merged.story.storyId;

  // A 安静之后，B 侧再次出现只影响 B 自身。
  const quietPageA = page([{ id: "other", url: OTHER_URL_A, title: "A 来源本地新闻" }]);
  for (const second of [20, 21, 22]) {
    archive.importSnapshot("agency-a", `${quietPageA}<!--${second}-->`, captureTime(second));
  }
  assert.equal(findByUrl(archive, "agency-a", "shared-wire.html").visibility, "quiet");
  // 第三个来源后来也采到同一稿件，显式加入既有 story。
  archive.registerFeed({
    feedId: "agency-c",
    baseUrl: "https://c.example.test/scroll-news/news1.html",
    allowedHosts: ["c.example.test"],
    minimumItems: 1,
    missingThreshold: 3
  });
  archive.importSnapshot("agency-c", pageWith("https://c.example.test/2026/11/wire-copy.html", "电讯稿：C 来源再转"), captureTime(23));
  const articleC = archive.listItems("agency-c").items[0];
  const added = archive.addStoryMembers(storyId, { articleIds: [articleC.articleId], expectedRevision: merged.story.revision });
  assert.equal(added.status, 200);
  assert.equal(added.story.members.length, 3);
  const detail = archive.storyDetail(storyId);
  assert.equal(detail.members.find((m) => m.feedId === "agency-a").visibility, "quiet");
  assert.equal(detail.members.find((m) => m.feedId === "agency-c").visibility, "visible");
  assert.equal(archive.storyOverview().reconciliation.difference, 2, "三来源副本归并为一条，差值为 2");
});

test("paginates the overview with a stable de-duplicated total distinct from source-level counts", async (t) => {
  const archive = await seeded(t);
  archive.importSnapshot("agency-a", storyPageA(), captureTime(10));
  archive.importSnapshot("agency-b", storyPageB(), captureTime(11));
  archive.importSnapshot("agency-a", pageWith(OTHER_URL_A, "A 来源本地新闻"), captureTime(12));
  const articleA = findByUrl(archive, "agency-a", "shared-wire.html");
  const articleB = findByUrl(archive, "agency-b", "republished-wire.html");
  archive.mergeStories({ articleIds: [articleA.articleId, articleB.articleId] });

  // 来源级：A 有 2 篇、B 有 1 篇；总览去重后只有 2 个条目（1 story + 1 独立稿）。
  assert.equal(archive.articles.stats("agency-a").total, 2);
  assert.equal(archive.articles.stats("agency-b").total, 1);
  const first = archive.storyOverview({ limit: 1, offset: 0 });
  const second = archive.storyOverview({ limit: 1, offset: 1 });
  assert.equal(first.pagination.total, 2);
  assert.equal(second.pagination.total, 2);
  assert.equal(first.entries.length, 1);
  assert.notDeepEqual(first.entries[0].title, second.entries[0].title);
  assert.equal(archive.storyOverview({ limit: 1, offset: 5 }).entries.length, 0);
});

test("serves merge, detail, overview and unmerge through the HTTP contract", async (t) => {
  const archive = await seeded(t);
  archive.importSnapshot("agency-a", storyPageA(), captureTime(10));
  archive.importSnapshot("agency-b", storyPageB(), captureTime(11));
  const articleA = findByUrl(archive, "agency-a", "shared-wire.html");
  const articleB = findByUrl(archive, "agency-b", "republished-wire.html");
  const app = createHttpServer(archive, { host: "127.0.0.1", port: 0, logger: { error() {} } });
  const address = await app.listen();
  t.after(() => app.close());
  const base = `http://127.0.0.1:${address.port}/v1/stories`;

  const created = await fetch(base, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ articleIds: [articleA.articleId, articleB.articleId], note: "人工归并" })
  });
  assert.equal(created.status, 201);
  const story = (await created.json()).story;

  const overview = await fetch(`${base}/overview`);
  assert.equal(overview.status, 200);
  const overviewBody = await overview.json();
  assert.equal(overviewBody.pagination.total, 1);
  assert.match(overviewBody.basis, /去重/);
  assert.equal(overviewBody.reconciliation.difference, 1);

  const detail = await fetch(`${base}/${story.storyId}`);
  assert.equal(detail.status, 200);
  assert.equal((await detail.json()).members.length, 2);

  const events = await fetch(`${base}/${story.storyId}/events`);
  assert.equal(events.status, 200);
  assert.equal((await events.json()).events.length, 3);

  const undone = await fetch(`${base}/${story.storyId}/unmerge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ articleIds: [articleA.articleId, articleB.articleId], expectedRevision: story.revision })
  });
  assert.equal(undone.status, 200);
  assert.equal((await undone.json()).story.status, "dissolved");
  assert.equal((await (await fetch(`${base}/overview`)).json()).reconciliation.difference, 0);
  assert.equal((await fetch(`${base}/9999`)).status, 404);
});

test("survives a v1 database upgrade: existing articles remain readable and gains the merge layer", async (t) => {
  const { archive, filename } = await makeArchive(t);
  archive.registerFeed(FEED_A);
  archive.importSnapshot("agency-a", storyPageA(), captureTime(10));
  // 手工把落盘文件回退为真实 v1（剥离 v2 表与版本号），再重新打开触发 v1 -> v2 迁移。
  archive.database.exec(`DROP TABLE IF EXISTS story_events; DROP TABLE IF EXISTS story_memberships;
    DROP TABLE IF EXISTS stories; PRAGMA user_version = 1;`);
  archive.close();

  const { openDatabase, closeDatabase } = await import("../../src/store/database.js");
  const upgraded = openDatabase(filename);
  t.after(() => closeDatabase(upgraded));
  assert.equal(upgraded.prepare("PRAGMA user_version").get().user_version, 2);
  const rows = upgraded.prepare("SELECT article_id, title, visibility FROM articles").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, "电讯稿：A 来源原标题");
  for (const table of ["stories", "story_memberships", "story_events"]) {
    assert.equal(upgraded.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0);
  }
});

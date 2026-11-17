import { normalizeNote, normalizeStoryTitle } from "./note-text.js";

// 归并只接受显式人工指令：本服务不读取标题相似度，也不在采集路径上自动建 story。
// 来源稿（articles）的标题、发布时间、列表出现状态、滚动缺失与人工审核均各自保留，
// 归并与撤销仅改动 story_memberships / story_events，因此撤销不会重造历史观察。
export class StoryService {
  constructor({ stories, clock = () => new Date() }) {
    this.stories = stories;
    this.clock = clock;
  }

  merge(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("merge request must be an object");
    const articleIds = normalizeArticleIds(input.articleIds);
    if (articleIds.length < 2) throw new RangeError("merge requires at least two distinct article ids");
    const title = input.title ? normalizeStoryTitle(input.title) : this.defaultTitle(articleIds);
    const note = normalizeNote(input.note);
    const now = this.clock().toISOString();
    const blocked = this.claimedArticle(articleIds, null);
    if (blocked) return { status: 409, error: "article_already_merged", current: blocked };
    const missing = articleIds.find((id) => !this.stories.article(id));
    if (missing) return { status: 404, error: "article_not_found", articleId: missing };
    const story = this.stories.createStory({ title, articleIds, note, now });
    return { status: 201, story };
  }

  add(storyId, input) {
    validateStoryId(storyId);
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("story request must be an object");
    const articleIds = normalizeArticleIds(input.articleIds);
    if (articleIds.length < 1) throw new RangeError("add requires at least one article id");
    const expectedRevision = normalizeExpectedRevision(input.expectedRevision);
    const note = normalizeNote(input.note);
    const story = this.stories.findStory(storyId);
    if (!story) return { status: 404, error: "story_not_found" };
    if (story.status !== "active") return { status: 409, error: "story_dissolved", current: story };
    if (story.revision !== expectedRevision) {
      return { status: 409, error: "revision_conflict", current: story };
    }
    const blocked = this.claimedArticle(articleIds, storyId);
    if (blocked) return { status: 409, error: "article_already_merged", current: blocked };
    const missing = articleIds.find((id) => !this.stories.article(id));
    if (missing) return { status: 404, error: "article_not_found", articleId: missing };
    return { status: 200, story: this.stories.addMembers({ storyId, articleIds, note, now: this.clock().toISOString() }) };
  }

  unmerge(storyId, input) {
    validateStoryId(storyId);
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("story request must be an object");
    const articleIds = normalizeArticleIds(input.articleIds);
    if (articleIds.length < 1) throw new RangeError("unmerge requires at least one article id");
    const expectedRevision = normalizeExpectedRevision(input.expectedRevision);
    const note = normalizeNote(input.note);
    const story = this.stories.findStory(storyId);
    if (!story) return { status: 404, error: "story_not_found" };
    if (story.revision !== expectedRevision) {
      return { status: 409, error: "revision_conflict", current: story };
    }
    const outside = articleIds.find((id) => !this.stories.findActiveMembershipInStory(storyId, id));
    if (outside) return { status: 409, error: "article_not_in_story", articleId: outside, current: story };
    const updated = this.stories.removeMembers({ storyId, articleIds, note, now: this.clock().toISOString() });
    return { status: 200, story: updated, note: "unmerge closes the current memberships but keeps every capture observation and event for audit" };
  }

  story(storyId) {
    validateStoryId(storyId);
    const story = this.stories.findStory(storyId);
    if (!story) return null;
    return this.stories.detail(storyId);
  }

  events(storyId, limit) {
    validateStoryId(storyId);
    if (!this.stories.findStory(storyId)) return null;
    return this.stories.events(storyId, limit);
  }

  overview({ visibility = null, limit = 50, offset = 0 } = {}) {
    if (visibility !== null && !new Set(["visible", "quiet"]).has(visibility)) {
      throw new TypeError("visibility must be visible or quiet");
    }
    const pageSize = Math.max(1, Math.min(200, Number(limit) || 50));
    const start = Math.max(0, Number(offset) || 0);
    const rows = this.stories.overviewEntries(visibility);
    const page = rows.slice(start, start + pageSize);
    const storyRows = page.filter((row) => row.storyId !== null);
    const membersByStory = this.stories.membersByStory(storyRows.map((row) => row.storyId));
    const entries = page.map((row) => this.buildEntry(row, membersByStory));
    const counts = this.stories.overviewCounts();
    return {
      basis: "overview 口径按归并后的稿件去重：每个活跃 story 计为一条，未归并来源稿各计一条；来源级列表仍按来源稿计数，同一转载稿会在每个来源各出现一次。",
      entries,
      pagination: { limit: pageSize, offset: start, total: rows.length },
      counts: {
        overviewEntries: rows.length,
        activeStories: counts.activeStories,
        sourceArticles: counts.sourceArticles,
        mergedSourceCopies: counts.mergedSourceCopies
      },
      reconciliation: {
        sourceArticleTotal: counts.sourceArticles,
        overviewTotal: rows.length,
        difference: counts.sourceArticles - rows.length,
        explanation: "difference 等于当前活跃 story 内多出来源副本数（每个 story 的成员数减一之和）；归并不删除来源稿，撤销后差值归零。"
      }
    };
  }

  buildEntry(row, membersByStory) {
    if (row.storyId !== null) {
      const story = this.stories.findStory(row.storyId);
      const members = (membersByStory.get(row.storyId) ?? []).map(mapMember);
      return {
        kind: "story",
        storyId: row.storyId,
        title: story.title,
        status: story.status,
        revision: story.revision,
        visibility: aggregateVisibility(members),
        latestSeenAt: maxIso(members.map((member) => member.lastSeenAt)),
        sourceCount: members.length,
        members
      };
    }
    const article = this.stories.article(row.articleId);
    return {
      kind: "article",
      storyId: null,
      articleId: article.articleId,
      title: article.title,
      visibility: article.visibility,
      latestSeenAt: article.lastSeenAt,
      sourceCount: 1,
      members: [mapMember(article)]
    };
  }

  defaultTitle(articleIds) {
    const articles = articleIds.map((id) => this.stories.article(id)).filter(Boolean);
    articles.sort((a, b) => (a.lastSeenAt < b.lastSeenAt ? 1 : a.lastSeenAt === b.lastSeenAt ? b.articleId - a.articleId : -1));
    return articles[0]?.title ?? `story-${articleIds[0]}`;
  }

  // 返回第一个已在某个活跃 story 中的文章及其归属，供冲突响应说明当前状态。
  claimedArticle(articleIds, hostStoryId) {
    for (const articleId of articleIds) {
      const membership = this.stories.findActiveMembership(articleId);
      if (membership && membership.storyId !== hostStoryId) {
        return { articleId, storyId: membership.storyId };
      }
    }
    return null;
  }
}

function mapMember(article) {
  return {
    articleId: article.articleId,
    feedId: article.feedId,
    title: article.title,
    canonicalUrl: article.canonicalUrl,
    publishedAt: article.publishedAt,
    firstSeenAt: article.firstSeenAt,
    lastSeenAt: article.lastSeenAt,
    seenCount: article.seenCount,
    missingStreak: article.missingStreak,
    visibility: article.visibility,
    reviewState: article.reviewState,
    reviewRevision: article.reviewRevision
  };
}

function aggregateVisibility(members) {
  return members.some((member) => member.visibility === "visible") ? "visible" : "quiet";
}

function maxIso(values) {
  return values.filter(Boolean).sort().at(-1) ?? null;
}

function normalizeArticleIds(value) {
  if (!Array.isArray(value)) throw new TypeError("articleIds must be an array of positive integers");
  const ids = [];
  for (const id of value) {
    if (!Number.isSafeInteger(id) || id < 1) throw new TypeError("article ids must be positive integers");
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

function normalizeExpectedRevision(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("expectedRevision must be a non-negative integer");
  return value;
}

function validateStoryId(storyId) {
  if (!Number.isSafeInteger(storyId) || storyId < 1) throw new TypeError("storyId must be a positive integer");
}

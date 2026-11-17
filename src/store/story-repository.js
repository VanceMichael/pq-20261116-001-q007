// 归并仓储：只维护"人工归并层"（stories / story_memberships / story_events）。
// 来源稿仍由 ArticleRepository 管理，本仓储不写 articles / capture_items，
// 因此撤销归并不会重造或删除任何历史列表观察。
export class StoryRepository {
  constructor(database) {
    this.database = database;
    this.insertStory = database.prepare(`INSERT INTO stories
      (title, status, revision, created_at, updated_at, dissolved_at)
      VALUES (?, 'active', 1, ?, ?, NULL)`);
    this.getStoryRow = database.prepare("SELECT * FROM stories WHERE story_id = ?");
    this.insertEvent = database.prepare(`INSERT INTO story_events
      (story_id, article_id, kind, note, revision, changed_at)
      VALUES (?, ?, ?, ?, ?, ?)`);
    this.insertMembership = database.prepare(`INSERT INTO story_memberships
      (story_id, article_id, joined_at, join_event_id) VALUES (?, ?, ?, ?)`);
    this.activeMembershipByArticle = database.prepare(
      "SELECT * FROM story_memberships WHERE article_id = ? AND left_at IS NULL"
    );
    this.activeMembershipInStory = database.prepare(
      "SELECT * FROM story_memberships WHERE story_id = ? AND article_id = ? AND left_at IS NULL"
    );
    this.activeMembershipsByStory = database.prepare(
      "SELECT * FROM story_memberships WHERE story_id = ? AND left_at IS NULL ORDER BY membership_id"
    );
    // 临时表在构造时建好，预编译语句才能解析；连接期内复用，每次批量加载前清空。
    database.exec("CREATE TEMP TABLE IF NOT EXISTS temp_story_id_list (value INTEGER PRIMARY KEY);");
    this.clearTempStories = database.prepare("DELETE FROM temp_story_id_list");
    this.insertTempStory = database.prepare("INSERT INTO temp_story_id_list(value) VALUES (?)");
    this.membershipsForTempStories = database.prepare(
      "SELECT * FROM story_memberships WHERE left_at IS NULL AND story_id IN (SELECT value FROM temp_story_id_list)"
    );
    this.leaveMembership = database.prepare(`UPDATE story_memberships
      SET left_at = ?, leave_event_id = ? WHERE membership_id = ? AND left_at IS NULL`);
    this.countActiveMemberships = database.prepare(
      "SELECT COUNT(*) AS count FROM story_memberships WHERE story_id = ? AND left_at IS NULL"
    );
    this.dissolveStory = database.prepare(
      "UPDATE stories SET status = 'dissolved', updated_at = ?, dissolved_at = ? WHERE story_id = ?"
    );
    this.bumpStory = database.prepare(
      "UPDATE stories SET title = ?, revision = revision + ?, updated_at = ? WHERE story_id = ?"
    );
    this.listEvents = database.prepare(`SELECT event_id, story_id, article_id, kind, note, revision, changed_at
      FROM story_events WHERE story_id = ? ORDER BY event_id DESC LIMIT ?`);
    this.articleById = database.prepare("SELECT * FROM articles WHERE article_id = ?");
    // 总览条目：活跃 story 条目（key 为 -story_id）与未归并文章条目（key 为 article_id）的并集。
    // any_visible 为条目聚合可见性：任一来源成员仍在列则条目 visible，全部安静才 quiet。
    this.overviewRows = database.prepare(`
      SELECT entry_key, story_id, article_id, MAX(last_seen_at) AS latest_seen,
        MAX(is_visible) AS any_visible, COUNT(*) AS member_count
      FROM (
        SELECT -m.story_id AS entry_key, m.story_id AS story_id, a.article_id AS article_id,
          a.last_seen_at, CASE a.visibility WHEN 'visible' THEN 1 ELSE 0 END AS is_visible
        FROM story_memberships m JOIN articles a ON a.article_id = m.article_id
        WHERE m.left_at IS NULL
        UNION ALL
        SELECT a.article_id AS entry_key, NULL AS story_id, a.article_id AS article_id,
          a.last_seen_at, CASE a.visibility WHEN 'visible' THEN 1 ELSE 0 END AS is_visible
        FROM articles a
        WHERE NOT EXISTS (
          SELECT 1 FROM story_memberships m
          WHERE m.article_id = a.article_id AND m.left_at IS NULL
        )
      )
      GROUP BY entry_key
      HAVING ? IS NULL OR ? = MAX(is_visible)
      ORDER BY latest_seen DESC, entry_key DESC`);
    this.countStories = database.prepare("SELECT COUNT(*) AS count FROM stories WHERE status = 'active'");
    this.countSourceArticles = database.prepare("SELECT COUNT(*) AS count FROM articles");
    this.countMergedCopies = database.prepare(
      "SELECT COUNT(*) AS count FROM story_memberships WHERE left_at IS NULL"
    );
  }

  createStory({ title, articleIds, note, now }) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const storyId = Number(this.insertStory.run(title, now, now).lastInsertRowid);
      this.insertEvent.run(storyId, null, "created", note, 1, now);
      let revision = 1;
      for (const articleId of articleIds) {
        revision += 1;
        const eventId = Number(
          this.insertEvent.run(storyId, articleId, "joined", note, revision, now).lastInsertRowid
        );
        this.insertMembership.run(storyId, articleId, now, eventId);
      }
      // created 事件占修订号 1，每个 joined 事件各占一个修订号。
      this.bumpStory.run(title, articleIds.length, now, storyId);
      this.database.exec("COMMIT");
      return this.detail(storyId);
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  addMembers({ storyId, articleIds, note, now }) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      let revision = this.revisionOf(storyId);
      for (const articleId of articleIds) {
        revision += 1;
        const eventId = Number(
          this.insertEvent.run(storyId, articleId, "joined", note, revision, now).lastInsertRowid
        );
        this.insertMembership.run(storyId, articleId, now, eventId);
      }
      const current = this.getStoryRow.get(storyId);
      this.bumpStory.run(current.title, articleIds.length, now, storyId);
      this.database.exec("COMMIT");
      return this.detail(storyId);
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  removeMembers({ storyId, articleIds, note, now }) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      let revision = this.revisionOf(storyId);
      for (const articleId of articleIds) {
        const membership = this.activeMembershipInStory.get(storyId, articleId);
        if (!membership) throw new ReferenceError(`article ${articleId} is not an active member of story ${storyId}`);
        revision += 1;
        const eventId = Number(
          this.insertEvent.run(storyId, articleId, "left", note, revision, now).lastInsertRowid
        );
        const result = this.leaveMembership.run(now, eventId, membership.membership_id);
        if (Number(result.changes) !== 1) throw new Error("story membership removal lost its row");
      }
      const current = this.getStoryRow.get(storyId);
      const remaining = this.countActiveMemberships.get(storyId).count;
      if (remaining === 0) {
        // left 事件已各占一个修订号；解散事件再占一个，stories.revision 必须同步。
        this.bumpStory.run(current.title, articleIds.length + 1, now, storyId);
        revision += 1;
        this.insertEvent.run(storyId, null, "dissolved", note, revision, now);
        this.dissolveStory.run(now, now, storyId);
      } else {
        this.bumpStory.run(current.title, articleIds.length, now, storyId);
      }
      this.database.exec("COMMIT");
      return this.detail(storyId);
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  revisionOf(storyId) {
    return this.getStoryRow.get(storyId).revision;
  }

  findActiveMembership(articleId) {
    const row = this.activeMembershipByArticle.get(articleId);
    return row ? mapMembership(row) : null;
  }

  findActiveMembershipInStory(storyId, articleId) {
    const row = this.activeMembershipInStory.get(storyId, articleId);
    return row ? mapMembership(row) : null;
  }

  findStory(storyId) {
    const row = this.getStoryRow.get(storyId);
    return row ? mapStory(row) : null;
  }

  article(articleId) {
    const row = this.articleById.get(articleId);
    return row ? this.mapArticleRow(row) : null;
  }

  detail(storyId) {
    const story = this.findStory(storyId);
    if (!story) return null;
    const members = this.membersOf(storyId);
    return { ...story, members, events: this.events(storyId) };
  }

  membersOf(storyId) {
    return this.activeMembershipsByStory.all(storyId)
      .map((row) => this.mapArticleRow(this.articleById.get(row.article_id)))
      .sort(compareByLastSeen);
  }

  // 一次取回多个 story 的活跃成员，供总览页避免逐条 detail 查询。
  membersByStory(storyIds) {
    const ids = [...new Set(storyIds)].filter((id) => Number.isSafeInteger(id));
    const result = new Map();
    if (!ids.length) return result;
    this.clearTempStories.run();
    for (const id of ids) {
      this.insertTempStory.run(id);
      result.set(id, []);
    }
    for (const row of this.membershipsForTempStories.all()) {
      result.get(row.story_id).push(this.mapArticleRow(this.articleById.get(row.article_id)));
    }
    for (const members of result.values()) members.sort(compareByLastSeen);
    return result;
  }

  events(storyId, limit = 100) {
    return this.listEvents.all(storyId, Math.max(1, Math.min(200, Number(limit) || 100))).map(mapEvent);
  }

  // 返回未分页的全部条目摘要行；调用方负责分页，保证 total 与页内切片口径一致。
  overviewEntries(visibility = null) {
    const visibleFlag = visibility === null ? null : visibility === "visible" ? 1 : 0;
    return this.overviewRows.all(visibleFlag, visibleFlag).map((row) => ({
      storyId: row.story_id ?? null,
      articleId: row.article_id ?? null,
      memberCount: row.member_count,
      latestSeenAt: row.latest_seen
    }));
  }

  overviewCounts() {
    return {
      activeStories: this.countStories.get().count,
      sourceArticles: this.countSourceArticles.get().count,
      mergedSourceCopies: this.countMergedCopies.get().count
    };
  }

  mapArticleRow(row) {
    return {
      articleId: row.article_id,
      feedId: row.feed_id,
      canonicalUrl: row.canonical_url,
      title: row.title,
      publishedAt: row.published_at,
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
      seenCount: row.seen_count,
      missingStreak: row.missing_streak,
      visibility: row.visibility,
      reviewState: row.review_state,
      reviewRevision: row.review_revision
    };
  }
}

function compareByLastSeen(a, b) {
  if (a.lastSeenAt === b.lastSeenAt) return b.articleId - a.articleId;
  return a.lastSeenAt < b.lastSeenAt ? 1 : -1;
}

function mapStory(row) {
  return {
    storyId: row.story_id,
    title: row.title,
    status: row.status,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    dissolvedAt: row.dissolved_at
  };
}

function mapMembership(row) {
  return {
    membershipId: row.membership_id,
    storyId: row.story_id,
    articleId: row.article_id,
    joinedAt: row.joined_at,
    leftAt: row.left_at,
    joinEventId: row.join_event_id,
    leaveEventId: row.leave_event_id
  };
}

function mapEvent(row) {
  return {
    eventId: row.event_id,
    storyId: row.story_id,
    articleId: row.article_id,
    kind: row.kind,
    note: row.note,
    revision: row.revision,
    changedAt: row.changed_at
  };
}

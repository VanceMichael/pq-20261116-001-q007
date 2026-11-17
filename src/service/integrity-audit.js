export class IntegrityAuditService {
  constructor(database) {
    this.database = database;
    this.integrityCheck = database.prepare("PRAGMA integrity_check");
    this.foreignKeyCheck = database.prepare("PRAGMA foreign_key_check");
    this.captureLinkMismatches = database.prepare(`SELECT c.capture_id, c.normalized_count,
      COUNT(ci.article_id) AS linked_count FROM captures c
      LEFT JOIN capture_items ci ON ci.capture_id=c.capture_id
      WHERE c.accepted=1 GROUP BY c.capture_id HAVING c.normalized_count != linked_count`);
    this.articleCountMismatches = database.prepare(`SELECT a.article_id, a.seen_count,
      COUNT(ci.capture_id) AS observed_count FROM articles a
      LEFT JOIN capture_items ci ON ci.article_id=a.article_id
      GROUP BY a.article_id HAVING a.seen_count != observed_count`);
    this.feedWatermarkMismatches = database.prepare(`SELECT f.feed_id, f.last_accepted_at, f.last_item_count,
      c.captured_at AS expected_at, c.normalized_count AS expected_count
      FROM feeds f LEFT JOIN captures c ON c.capture_id=(
        SELECT capture_id FROM captures WHERE feed_id=f.feed_id AND accepted=1 ORDER BY capture_id DESC LIMIT 1
      ) WHERE (f.last_accepted_at IS NOT c.captured_at) OR (f.last_item_count != COALESCE(c.normalized_count, 0))`);
    // 归并层检查 1：每个活跃 story 至少要有一个未撤销成员，且成员不能指向已解散 story。
    this.storyMembershipMismatches = database.prepare(`SELECT s.story_id, s.status,
      COUNT(m.membership_id) AS active_members FROM stories s
      LEFT JOIN story_memberships m ON m.story_id=s.story_id AND m.left_at IS NULL
      GROUP BY s.story_id HAVING (s.status='active' AND active_members=0)
        OR (s.status='dissolved' AND active_members>0)`);
    // 归并层检查 2：story 修订号必须等于其 append-only 事件流的最大修订号。
    this.storyRevisionMismatches = database.prepare(`SELECT s.story_id, s.revision AS stored_revision,
      COALESCE(e.max_revision, 0) AS event_revision FROM stories s LEFT JOIN (
        SELECT story_id, MAX(revision) AS max_revision FROM story_events GROUP BY story_id
      ) e ON e.story_id=s.story_id WHERE s.revision != COALESCE(e.max_revision, 0)`);
  }

  run() {
    const checks = [
      { name: "sqlite_integrity", rows: this.integrityCheck.all().filter((row) => row.integrity_check !== "ok") },
      { name: "foreign_keys", rows: this.foreignKeyCheck.all() },
      { name: "capture_item_counts", rows: this.captureLinkMismatches.all() },
      { name: "article_observation_counts", rows: this.articleCountMismatches.all() },
      { name: "feed_watermarks", rows: this.feedWatermarkMismatches.all() },
      { name: "story_memberships", rows: this.storyMembershipMismatches.all() },
      { name: "story_revisions", rows: this.storyRevisionMismatches.all() }
    ].map((check) => ({
      name: check.name,
      passed: check.rows.length === 0,
      issueCount: check.rows.length,
      examples: check.rows.slice(0, 10)
    }));
    return {
      status: checks.every((check) => check.passed) ? "consistent" : "inconsistent",
      checkedAt: new Date().toISOString(),
      checks
    };
  }
}

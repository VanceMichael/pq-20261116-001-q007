// 审核与归并操作共用的人工备注规范化：保留人工原文，仅做 NFC、控制字符与空白收敛。
export function normalizeNote(note) {
  if (note === undefined || note === null || note === "") return null;
  if (typeof note !== "string") throw new TypeError("note must be text");
  const normalized = note.normalize("NFC").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized || normalized.length > 1000) throw new RangeError("note must contain 1 to 1000 characters");
  return normalized;
}

// 归并标题只用于总览展示，不参与任何自动同稿判定。
export function normalizeStoryTitle(title) {
  if (typeof title !== "string") throw new TypeError("story title must be text");
  const normalized = title.normalize("NFC").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (normalized.length < 2 || normalized.length > 500) {
    throw new RangeError("story title must contain 2 to 500 characters");
  }
  return normalized;
}

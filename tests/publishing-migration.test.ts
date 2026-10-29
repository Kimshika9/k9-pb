import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { it, expect } from "vitest";
it("adds the publishing ledger without losing legacy messages, jobs, revisions or history", () => {
  const db = new DatabaseSync(":memory:");
  try {
    for (const file of ["0001_foundation.sql", "0002_editor.sql"])
      db.exec(
        readFileSync(new URL("../migrations/" + file, import.meta.url), "utf8"),
      );
    db.prepare(
      "INSERT INTO channels(id,telegram_chat_id,title,approved_by,approved_at) VALUES('channel','-100123','Synthetic','123456789','2026-01-01')",
    ).run();
    db.prepare(
      "INSERT INTO posts(id,channel_id,title,status,telegram_message_id,published_at,revision) VALUES('legacy-post','channel','Legacy publication','published',88,'2026-01-02',3)",
    ).run();
    db.prepare(
      "INSERT INTO scheduled_jobs(id,post_id,run_at) VALUES('legacy-job','legacy-post','2026-01-03')",
    ).run();
    db.prepare(
      "INSERT INTO history(id,post_id,actor_telegram_id,action) VALUES('history','legacy-post','123456789','legacy.action')",
    ).run();
    const original = db.prepare("SELECT * FROM posts").get();
    db.exec(
      readFileSync(
        new URL("../migrations/0003_publishing.sql", import.meta.url),
        "utf8",
      ),
    );
    db.exec(
      readFileSync(
        new URL(
          "../migrations/0004_uncertain_delivery_guard.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    expect(db.prepare("SELECT * FROM posts").get()).toEqual(original);
    expect(
      db
        .prepare(
          "SELECT telegram_message_id,source_revision,status FROM publications",
        )
        .get(),
    ).toMatchObject({
      telegram_message_id: 88,
      source_revision: 3,
      status: "published",
    });
    expect(
      db
        .prepare("SELECT status,delivery_state,channel_id FROM scheduled_jobs")
        .get(),
    ).toMatchObject({
      status: "pending",
      delivery_state: "legacy_review",
      channel_id: "channel",
    });
    expect(
      db.prepare("SELECT kind,status FROM publishing_operations").get(),
    ).toMatchObject({ kind: "legacy", status: "succeeded" });
    expect(db.prepare("SELECT count(*) AS n FROM history").get()).toMatchObject(
      { n: 1 },
    );
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    db.close();
  }
});

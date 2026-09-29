/**
 * BLOCK: backup and restore - taken before R-07 replaces every bill.
 * A round trip must bring back ObjectIds, Dates and arrays exactly.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { startDb, stopDb, clearDb } from "../helpers/db.js";

let seed, Bill, mongoose, backupDatabase, restoreDatabase;

before(async () => {
  await startDb();
  seed = await import("../helpers/seed.js");
  ({ default: Bill } = await import("../../models/bill-model.js"));
  mongoose = (await import("mongoose")).default;
  ({ backupDatabase, restoreDatabase } = await import("../../utils/backup-database.js"));
});

after(async () => await stopDb());

test("a backup restores every collection exactly", async () => {
  await clearDb();
  await seed.seedAll();
  const db = mongoose.connection.db;
  const before = {};
  for (const { name } of await db.listCollections().toArray()) {
    before[name] = await db.collection(name).find({}).sort({ _id: 1 }).toArray();
  }

  const out = fs.mkdtempSync(path.join(os.tmpdir(), "svkm-backup-"));
  const { dir, counts } = await backupDatabase(db, out);
  assert.ok(Object.keys(counts).length > 0);

  await clearDb();
  await restoreDatabase(db, dir);

  for (const [name, docs] of Object.entries(before)) {
    const now = await db.collection(name).find({}).sort({ _id: 1 }).toArray();
    assert.deepEqual(now, docs, `${name} differs after restore`);
  }
  fs.rmSync(out, { recursive: true, force: true });
});

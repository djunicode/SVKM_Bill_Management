/**
 * Full backup and restore of the database MONGODB_URI names - which, for
 * this project, is PRODUCTION.
 *
 * Backup is read-only: every collection is written to
 * <out>/<timestamp>/<collection>.json as canonical Extended JSON, so ObjectIds,
 * Dates and Buffers come back exactly. mongodump is not installed here.
 *
 *   node utils/backup-database.js [--out <dir>]            # back up
 *   node utils/backup-database.js --restore <dir>          # dry run: what would be restored
 *   node utils/backup-database.js --restore <dir> --apply  # REPLACE every backed-up collection
 *
 * The default output folder is C:\codes\avkm\backups, outside the code folder.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import dotenv from "dotenv";

dotenv.config();

const { EJSON } = mongoose.mongo.BSON;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT = path.resolve(HERE, "..", "..", "backups");

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : undefined;
};

/** Write every collection of `db` into a new timestamped folder under `out`. */
export const backupDatabase = async (db, out) => {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.join(out, stamp);
  fs.mkdirSync(dir, { recursive: true });

  const counts = {};
  for (const { name } of await db.listCollections({}, { nameOnly: true }).toArray()) {
    if (name.startsWith("system.")) continue;
    const docs = await db.collection(name).find({}).toArray();
    fs.writeFileSync(path.join(dir, `${name}.json`), EJSON.stringify(docs, { relaxed: false }));
    counts[name] = docs.length;
  }
  fs.writeFileSync(path.join(dir, "_manifest.json"), JSON.stringify({ createdAt: new Date(), counts }, null, 2));
  return { dir, counts };
};

/** Read a backup folder back: { collection: docs[] }. */
export const readBackup = (dir) => {
  const out = {};
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json") || f.startsWith("_")) continue;
    out[f.slice(0, -5)] = EJSON.parse(fs.readFileSync(path.join(dir, f), "utf8"), { relaxed: false });
  }
  return out;
};

/** Replace each backed-up collection with its backed-up contents. */
export const restoreDatabase = async (db, dir) => {
  const data = readBackup(dir);
  const counts = {};
  for (const [name, docs] of Object.entries(data)) {
    const coll = db.collection(name);
    await coll.deleteMany({});
    if (docs.length) await coll.insertMany(docs, { ordered: true });
    counts[name] = await coll.countDocuments();
  }
  return counts;
};

const run = async () => {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is not set");
  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  console.log(`\nConnected to: ${mongoose.connection.host}  (database ${db.databaseName})`);

  const restoreDir = arg("--restore");
  if (!restoreDir) {
    const { dir, counts } = await backupDatabase(db, arg("--out") || DEFAULT_OUT);
    console.log(`Backup written to ${dir}`);
    for (const [k, v] of Object.entries(counts)) console.log(`  ${k.padEnd(28)} ${v}`);
  } else {
    const data = readBackup(restoreDir);
    console.log(process.argv.includes("--apply") ? "MODE: APPLY - collections will be REPLACED\n" : "MODE: dry run\n");
    for (const [k, v] of Object.entries(data)) console.log(`  ${k.padEnd(28)} ${v.length}`);
    if (process.argv.includes("--apply")) {
      const counts = await restoreDatabase(db, restoreDir);
      console.log("\nRestored:", counts);
    } else {
      console.log("\nDry run. Add --apply to restore.");
    }
  }
  await mongoose.disconnect();
};

const invokedDirectly =
  !!process.argv[1] &&
  process.argv[1].replace(/\\/g, "/").endsWith("utils/backup-database.js");

if (invokedDirectly) {
  run().catch((err) => {
    console.error("\nFailed:", err.message);
    process.exit(1);
  });
}

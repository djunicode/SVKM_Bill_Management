/**
 * R-07: replace every bill with the client's mock data (26 September).
 *
 *   "Can you upload the attached Mock data and delete all the existing line."
 *
 * Steps, in this order:
 *   1. import her vendor master (new vendors are added; existing ones kept),
 *   2. delete every bill and the workflow history that belongs to them,
 *   3. import her bills through the same importer the Mass Upload screen
 *      uses, so they get 8-digit serials and the normal field handling.
 *
 * SAFETY
 * ------
 * MONGODB_URI is PRODUCTION. Dry run by default. --apply also requires
 * --backup <dir>: a folder written by utils/backup-database.js whose bill
 * count matches the live database, so the delete cannot run without a
 * current backup to restore from.
 *
 *   node utils/load-mock-data.js --bills <xlsx> --vendors <xlsx>
 *   node utils/load-mock-data.js --bills <xlsx> --vendors <xlsx> --apply --backup <dir>
 */
import fs from "node:fs";
import path from "node:path";
import mongoose from "mongoose";
import dotenv from "dotenv";
import ExcelJS from "exceljs";
import Bill from "../models/bill-model.js";
import RegionMaster from "../models/region-master-model.js";
import { importBillsFromExcel } from "./csv-import.js";
import { insertVendorsFromExcel } from "./vendor-csv-utils.js";

dotenv.config();

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : undefined;
};

/** Collections holding per-bill workflow history; emptied with the bills. */
export const HISTORY_COLLECTIONS = ["workflowfinals", "billworkflows", "workflowtransitions"];

const dataRows = async (file) => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  let n = 0;
  wb.getWorksheet(1).eachRow((row, i) => { if (i > 1 && row.hasValues) n++; });
  return n;
};

/** The backup's bill count must equal the live count, or nothing is written. */
export const checkBackup = async (dir) => {
  const file = path.join(dir || "", "bills.json");
  if (!dir || !fs.existsSync(file)) throw new Error("--apply needs --backup <dir> containing bills.json");
  const backedUp = JSON.parse(fs.readFileSync(path.join(dir, "_manifest.json"), "utf8")).counts.bills;
  const live = await Bill.countDocuments();
  if (backedUp !== live) {
    throw new Error(`backup holds ${backedUp} bills but the database has ${live}: take a fresh backup`);
  }
  return live;
};

/*
 * Regions her sheet uses that the region master lacks. AHMEDABAD is what the
 * current bills and four users already carry (the master spells it AHMED -
 * the duplicate-region question is still open with her), so it is added
 * rather than remapped. BANGALURU, INDORE and NOIDA are mapped to the master
 * spellings in the prepared import file, as her earlier load was.
 */
export const REGIONS_TO_ADD = ["AHMEDABAD"];

export const loadMockData = async ({ billsFile, vendorsFile }) => {
  const db = mongoose.connection.db;

  const regionsAdded = [];
  for (const name of REGIONS_TO_ADD) {
    if (!(await RegionMaster.findOne({ name }))) {
      await RegionMaster.create({ name });
      regionsAdded.push(name);
    }
  }

  const vendors = await insertVendorsFromExcel(vendorsFile);

  const deletedBills = (await Bill.deleteMany({})).deletedCount;
  const deletedHistory = {};
  for (const name of HISTORY_COLLECTIONS) {
    deletedHistory[name] = (await db.collection(name).deleteMany({})).deletedCount;
  }

  const bills = await importBillsFromExcel(billsFile, [], false);
  return { regionsAdded, vendors, deletedBills, deletedHistory, bills, billsNow: await Bill.countDocuments() };
};

const run = async () => {
  const billsFile = arg("--bills");
  const vendorsFile = arg("--vendors");
  if (!billsFile || !vendorsFile) throw new Error("pass --bills <xlsx> and --vendors <xlsx>");
  const APPLY = process.argv.includes("--apply");

  await mongoose.connect(process.env.MONGODB_URI);
  console.log(`\nConnected to: ${mongoose.connection.host}`);
  console.log(APPLY ? "MODE: APPLY - every bill will be DELETED and replaced\n" : "MODE: dry run - nothing will be written\n");

  console.log(`Bills in the database now ... ${await Bill.countDocuments()}`);
  console.log(`Mock bills to import ........ ${await dataRows(billsFile)}`);
  console.log(`Mock vendors in the file .... ${await dataRows(vendorsFile)}`);

  if (APPLY) {
    const live = await checkBackup(arg("--backup"));
    console.log(`Backup checked: ${live} bills, matches.\n`);
    const r = await loadMockData({ billsFile, vendorsFile });
    console.log("Regions added:", r.regionsAdded);
    console.log("Vendors:", JSON.stringify({ inserted: r.vendors.inserted, skipped: r.vendors.skipped, errors: r.vendors.errors?.length }));
    console.log(`Bills deleted: ${r.deletedBills}; history deleted: ${JSON.stringify(r.deletedHistory)}`);
    console.log("Bill import:", JSON.stringify({
      inserted: r.bills.inserted, skipped: r.bills.skipped, errors: r.bills.errors,
    }));
    for (const e of r.bills.details?.errors || []) console.log("  row", e.row, e.error);
    console.log(`Bills in the database now ... ${r.billsNow}`);
  } else {
    console.log("\nDry run complete. Re-run with --apply --backup <dir>.\n");
  }
  await mongoose.disconnect();
};

const invokedDirectly =
  !!process.argv[1] &&
  process.argv[1].replace(/\\/g, "/").endsWith("utils/load-mock-data.js");

if (invokedDirectly) {
  run().catch((err) => {
    console.error("\nFailed:", err.message);
    process.exit(1);
  });
}

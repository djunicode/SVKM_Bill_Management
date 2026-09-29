/**
 * Backfill: Payment Status shows "-" until a bill is paid.
 *
 * The rule here was reversed by the client on 29 September, item 15:
 *
 *   "When Bill is created at site/PIMO, payment status is '-'. Hence, we don't
 *    need payment status as 'Unpaid'. It should be '-' or 'Paid' (when date of
 *    payment is filled). Also, when we are uploading bills, payment status
 *    should be '-' and not 'Unpaid'."
 *
 * This script previously filled blank statuses with "Unpaid". It now does the
 * opposite: it CLEARS any stored status that the payment date does not
 * support, so the column reads "-" on unpaid bills and "Paid" on paid ones.
 *
 * New bills need none of this - bill-model.js derives the status from the
 * payment date on every save. This is only for rows written under the old
 * rule.
 *
 * SAFETY
 * ------
 * This is the only script in the project that writes to whatever database
 * MONGODB_URI points at, and for this project that is PRODUCTION. It runs as a
 * DRY RUN by default and writes nothing unless --apply is passed.
 *
 *   node utils/backfill-payment-status.js              # report only
 *   node utils/backfill-payment-status.js --apply      # actually write
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
import Bill from "../models/bill-model.js";

dotenv.config();

const APPLY = process.argv.includes("--apply");

/** Rows whose stored status disagrees with the payment date. */
export const WRONG_STATUS = {
  $or: [
    // Says Unpaid, or anything else, with no payment date -> should be blank.
    { "accountsDept.paymentDate": null, "accountsDept.status": { $nin: [null, ""] } },
    // Has a payment date but does not say Paid.
    { "accountsDept.paymentDate": { $ne: null }, "accountsDept.status": { $ne: "Paid" } },
  ],
};

/**
 * The migration itself, separate from the command line so the tests can run
 * it against an in-memory database.
 *
 * @param {object}  model         the Bill model to operate on
 * @param {boolean} [opts.apply]  write, rather than only counting
 */
export const backfillPaymentStatus = async (model, { apply = false } = {}) => {
  const total = await model.countDocuments({});
  const blank = await model.countDocuments(WRONG_STATUS);

  // Of the wrong ones: how many should end up Paid, how many blank.
  const paid = await model.countDocuments({
    ...WRONG_STATUS,
    "accountsDept.paymentDate": { $ne: null },
  });
  const unpaid = blank - paid;

  let written = 0;
  if (apply && blank > 0) {
    const a = await model.updateMany(
      { "accountsDept.paymentDate": { $ne: null }, "accountsDept.status": { $ne: "Paid" } },
      { $set: { "accountsDept.status": "Paid" } }
    );
    const b = await model.updateMany(
      { "accountsDept.paymentDate": null, "accountsDept.status": { $nin: [null, ""] } },
      { $set: { "accountsDept.status": null } }
    );
    written = a.modifiedCount + b.modifiedCount;
  }

  return { total, blank, paid, unpaid, written };
};

const run = async () => {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is not set");

  await mongoose.connect(uri);

  // Never print the connection string; the host alone is enough to confirm
  // which cluster this is about to touch.
  const host = mongoose.connection.host;
  console.log(`\nConnected to: ${host}`);
  console.log(APPLY ? "MODE: APPLY - this will write\n" : "MODE: dry run - nothing will be written\n");

  const { total, blank, paid: wouldBePaid, unpaid: wouldBeUnpaid } =
    await backfillPaymentStatus(Bill, { apply: false });

  console.log(`Bills in total ............ ${total}`);
  console.log(`Status disagrees with date  ${blank}`);
  console.log(`  -> would become Paid .... ${wouldBePaid}  (they carry a payment date)`);
  console.log(`  -> would be cleared ..... ${wouldBeUnpaid}  (shown as "-")`);

  if (blank > 0) {
    const sample = await Bill.find(WRONG_STATUS)
      .select("srNo accountsDept.paymentDate siteStatus")
      .limit(5)
      .lean();
    console.log("\nA few of them:");
    for (const b of sample) {
      const paid = b.accountsDept?.paymentDate;
      console.log(
        `  ${b.srNo}  siteStatus=${b.siteStatus || "-"}  paymentDate=${paid ? new Date(paid).toISOString().slice(0, 10) : "none"}`
      );
    }
  }

  if (!APPLY) {
    console.log("\nDry run complete. Re-run with --apply to write these changes.\n");
  } else if (blank === 0) {
    console.log("\nNothing to do.\n");
  } else {
    const { written } = await backfillPaymentStatus(Bill, { apply: true });
    console.log(`\nWritten: ${written} row(s).`);
    console.log(`Still wrong: ${await Bill.countDocuments(WRONG_STATUS)}\n`);
  }

  await mongoose.disconnect();
};

/*
 * Only run when invoked directly from the command line.
 *
 * Without this guard, merely importing the module opened a connection to
 * whatever MONGODB_URI names - which for this project is PRODUCTION - and ran
 * the report. Importing a file must never open a database connection.
 */
const invokedDirectly =
  !!process.argv[1] &&
  process.argv[1].replace(/\\/g, "/").endsWith("utils/backfill-payment-status.js");

if (invokedDirectly) {
  run().catch((err) => {
    console.error("\nBackfill failed:", err.message);
    process.exit(1);
  });
}

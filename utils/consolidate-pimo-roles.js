/**
 * Consolidate the two PIMO roles into one (reply to question 3, 29 September).
 *
 *   "Please keep one. Please check, which Team is having all the validations
 *    and substitutions and reports data etc attached. We will go ahead with
 *    the same and remove the other one."
 *
 * The one that carries the wiring is `site_pimo`, shown as "PIMO Mumbai Team".
 * It is the role the login screen issues, and every PIMO screen, tab rule,
 * sort key, checklist, mass-upload allow-list and report button is keyed on
 * it. `pimo_mumbai` is only the internal name of the PIMO team as a Send-to
 * destination; as a role held by a user it opens nothing the other does not,
 * and a user who holds only it cannot sign in as PIMO at all.
 *
 * So `pimo_mumbai` is removed from every user who holds it. It stays in the
 * code as the Send-to team name - that is not a user role and is untouched.
 *
 * Removing it does NOT add `site_pimo` unless --grant is passed. The dry run
 * against production showed the three users holding `pimo_mumbai` without
 * `site_pimo` are all Site Officer accounts; adding `site_pimo` would let
 * them sign in as the PIMO team, which is a decision for the client, not a
 * side effect of tidying a role.
 *
 * SAFETY
 * ------
 * MONGODB_URI for this project is PRODUCTION. This runs as a DRY RUN by
 * default and writes nothing unless --apply is passed.
 *
 *   node utils/consolidate-pimo-roles.js              # report only
 *   node utils/consolidate-pimo-roles.js --apply      # actually write
 *   node utils/consolidate-pimo-roles.js --apply --grant
 *                        # also give site_pimo to those who lacked it
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
import User from "../models/user-model.js";

dotenv.config();

const APPLY = process.argv.includes("--apply");
const GRANT = process.argv.includes("--grant");

export const KEEP = "site_pimo";
export const DROP = "pimo_mumbai";

/**
 * The migration itself, separate from the command line so the tests can run
 * it against an in-memory database.
 *
 * @param {object}  model         the User model to operate on
 * @param {boolean} [opts.apply]  write, rather than only reporting
 * @param {boolean} [opts.grant]  also add site_pimo to users who lack it
 * @returns {{ affected: object[], both: number, dropOnly: number, keepOnly: number, written: number }}
 */
export const consolidatePimoRoles = async (model, { apply = false, grant = false } = {}) => {
  const holders = await model.find({ role: DROP }).select("name email role").lean();
  const keepOnly = await model.countDocuments({ role: { $in: [KEEP], $nin: [DROP] } });

  const affected = holders.map((u) => {
    const roles = Array.isArray(u.role) ? u.role : [u.role];
    const next = roles.filter((r) => r !== DROP);
    if (grant && !next.includes(KEEP)) next.push(KEEP);
    return { _id: u._id, name: u.name, email: u.email, from: roles, to: next, hadKeep: roles.includes(KEEP) };
  });

  let written = 0;
  if (apply) {
    for (const u of affected) {
      // updateOne, not save(): only the role array changes, and no other
      // validator on the user document gets a say in a role migration.
      const r = await model.updateOne({ _id: u._id }, { $set: { role: u.to } });
      written += r.modifiedCount;
    }
  }

  return {
    affected,
    both: affected.filter((u) => u.hadKeep).length,
    dropOnly: affected.filter((u) => !u.hadKeep).length,
    keepOnly,
    written,
  };
};

const run = async () => {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is not set");

  await mongoose.connect(uri);

  // Never print the connection string; the host alone confirms the cluster.
  console.log(`\nConnected to: ${mongoose.connection.host}`);
  console.log(APPLY ? "MODE: APPLY - this will write\n" : "MODE: dry run - nothing will be written\n");

  const plan = await consolidatePimoRoles(User, { apply: false, grant: GRANT });
  console.log(GRANT ? `--grant: users without ${KEEP} will be given it
` : `${KEEP} is not granted to anyone (pass --grant to do so)
`);

  console.log(`Users holding ${KEEP} only ........ ${plan.keepOnly}  (no change)`);
  console.log(`Users holding both ................ ${plan.both}  (${DROP} removed)`);
  console.log(`Users holding ${DROP} only ...... ${plan.dropOnly}  (${DROP} removed${GRANT ? `, ${KEEP} added` : ""})`);
  for (const u of plan.affected) {
    console.log(`  ${u.name}  [${u.from.join(", ")}] -> [${u.to.join(", ")}]`);
  }

  if (!APPLY) {
    console.log("\nDry run complete. Re-run with --apply to write these changes.\n");
  } else if (plan.affected.length === 0) {
    console.log("\nNothing to do.\n");
  } else {
    const { written } = await consolidatePimoRoles(User, { apply: true, grant: GRANT });
    console.log(`\nWritten: ${written} user(s).`);
    console.log(`Still holding ${DROP}: ${await User.countDocuments({ role: DROP })}\n`);
  }

  await mongoose.disconnect();
};

// Only run from the command line: importing a file must never open a
// connection to the database MONGODB_URI names.
const invokedDirectly =
  !!process.argv[1] &&
  process.argv[1].replace(/\\/g, "/").endsWith("utils/consolidate-pimo-roles.js");

if (invokedDirectly) {
  run().catch((err) => {
    console.error("\nConsolidation failed:", err.message);
    process.exit(1);
  });
}

/**
 * The duplicate-bill rule.
 *
 * Stated in the observations workbook, General sheet row 14:
 *
 *   "A bill details with combination of 'Vendor+Bill no+Bill date+Bill Amt'
 *    should give error. However this applies when only bill no column for same
 *    vendor is blank. Then this not allows to edit any detail.
 *    Exception - Advance/LC/BG, Hold/Ret Release, Petty Cash, Direct FI Entry,
 *    Proforma Invoice"
 *
 * Three things were wrong with the version this replaces, and they were written
 * out twice, once in createBill and once in patchBill:
 *
 *   - the key was vendor + bill no + bill date + REGION. Region is not part of
 *     the client's key, and the bill AMOUNT is;
 *   - only three of the five natures were exempt. Hold/Ret Release and Petty
 *     cash were not, so those bills were subject to a rule they are excused
 *     from;
 *   - the check ran even when the bill number was BLANK, so two bills for the
 *     same vendor with no bill number yet matched each other on
 *     null === null. That is the second sentence of the rule above, and it is
 *     why the pencil edit refused to save anything on an Advance, Direct FI or
 *     Hold/Ret row (observations T-03, T-06).
 *
 * "Bill no / Bill date / Bill Amt" are the tax invoice fields: columns 20, 21
 * and 23 of the Field entry register. The ledger has no separate bill-number
 * column.
 */

/** Natures of work the rule does not apply to, lower-cased for comparison. */
export const DUPLICATE_EXEMPT_NATURES = [
  "advance/lc/bg",
  "hold/ret release",
  "petty cash",
  "direct fi entry",
  "proforma invoice",
];

export const isDuplicateExempt = (natureOfWork) =>
  DUPLICATE_EXEMPT_NATURES.includes(String(natureOfWork || "").trim().toLowerCase());

/** A bill number that is present and not just whitespace. */
const hasBillNo = (taxInvNo) =>
  taxInvNo !== null && taxInvNo !== undefined && String(taxInvNo).trim() !== "";

/** The whole of one calendar day, so a time component cannot hide a match. */
const sameDay = (value) => {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return {
    $gte: new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0),
    $lte: new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999),
  };
};

/**
 * The mongo filter that finds a bill duplicating this one, or null when the
 * rule does not apply.
 *
 * @param {object}  bill              vendor, taxInvNo, taxInvDate, taxInvAmt
 * @param {string}  natureOfWork      the resolved NAME, not the ObjectId
 * @param {object}  [opts]
 * @param {*}       [opts.excludeId]  the bill being edited, so it cannot match itself
 */
export const duplicateBillQuery = (bill, natureOfWork, { excludeId } = {}) => {
  if (isDuplicateExempt(natureOfWork)) return null;
  if (!hasBillNo(bill?.taxInvNo)) return null; // the rule's own carve-out
  if (!bill?.vendor) return null;

  const query = {
    vendor: bill.vendor,
    taxInvNo: String(bill.taxInvNo).trim(),
  };

  const day = bill.taxInvDate ? sameDay(bill.taxInvDate) : null;
  if (day) query.taxInvDate = day;

  if (bill.taxInvAmt !== null && bill.taxInvAmt !== undefined && bill.taxInvAmt !== "") {
    const amount = Number(bill.taxInvAmt);
    if (!Number.isNaN(amount)) query.taxInvAmt = amount;
  }

  if (excludeId) query._id = { $ne: excludeId };

  return query;
};

export const DUPLICATE_BILL_MESSAGE =
  "A bill with the same vendor, bill no, bill date and bill amount already exists.";

export default duplicateBillQuery;

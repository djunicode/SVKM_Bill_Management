/**
 * Bill serial numbers: 8 digits (29.09, reply Q1).
 *
 *   "Serial no to be made 8 digit - first two digit for year and next six
 *    digit continuous numbering (At present it is 7)"
 *
 * The year is the financial year (April to March), as createBill has always
 * used. Bills issued before the change carry 7 digits (2-digit year + 5);
 * they are left as they are - she has confirmed the current data is mock and
 * will be erased before go-live - but numbering carries on from them, so a
 * year does not restart at 000001 while 7-digit bills of that year exist.
 */

export const SEQUENCE_DIGITS = 6;
const LEGACY_SEQUENCE_DIGITS = 5;

/** A serial the system will look up: the current 8 digits, or a legacy 7. */
export const SR_NO_PATTERN = /^\d{7,8}$/;

/** Two-digit financial-year prefix: April 2026 to March 2027 is "26". */
export const financialYearPrefix = (date) => {
  const d = date && !isNaN(new Date(date).getTime()) ? new Date(date) : new Date();
  const yy = d.getFullYear() % 100;
  const fy = d.getMonth() >= 3 ? yy : (yy + 99) % 100;
  return String(fy).padStart(2, "0");
};

export const formatSrNo = (prefix, sequence) =>
  `${prefix}${String(sequence).padStart(SEQUENCE_DIGITS, "0")}`;

/**
 * The highest sequence already used under `prefix`, across both the 8-digit
 * and the legacy 7-digit formats. Each format is queried on its own because
 * srNo is a string: sorting mixed lengths together is not numeric order.
 */
export const highestSequence = async (Bill, prefix) => {
  let highest = 0;
  for (const digits of [SEQUENCE_DIGITS, LEGACY_SEQUENCE_DIGITS]) {
    const last = await Bill.findOne(
      { srNo: { $regex: `^${prefix}\\d{${digits}}$` } },
      { srNo: 1 },
      { sort: { srNo: -1 } }
    ).lean();
    const n = last ? parseInt(last.srNo.slice(prefix.length), 10) : 0;
    if (n > highest) highest = n;
  }
  return highest;
};

/** The next serial for a bill dated `date`. */
export const nextSrNo = async (Bill, date) => {
  const prefix = financialYearPrefix(date);
  return formatSrNo(prefix, (await highestSequence(Bill, prefix)) + 1);
};

/**
 * A generator for bulk imports: one database read, then consecutive numbers.
 * Callers still check each candidate against the database.
 */
export const serialGenerator = async (Bill, date) => {
  const prefix = financialYearPrefix(date);
  let current = await highestSequence(Bill, prefix);
  return () => formatSrNo(prefix, ++current);
};

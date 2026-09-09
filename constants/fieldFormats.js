/**
 * Field formats, transcribed from the "Field entry" sheet of
 * Updated Process Flow & details.xlsx and the Notes sheet of
 * Format for update bill file.xlsx.
 *
 * The create-bill form already enforces most of these client-side, but import,
 * mass update and pencil edit all write through other paths. Validating at the
 * model keeps every path honest.
 *
 * All validators are SPARSE: an empty value passes. Most of these columns are
 * legitimately blank for much of a bill's life, and existing production rows
 * must not become unsaveable.
 */

/** True when the value is absent for validation purposes. */
export const isBlank = (v) =>
  v === undefined || v === null || (typeof v === "string" && v.trim() === "");

/** Wrap a predicate so blanks always pass. */
const sparse = (fn) => (v) => isBlank(v) || fn(v);

export const FORMATS = {
  // col 6 - "numeric 6 digits"
  vendorNo: {
    test: sparse((v) => /^[0-9]{6}$/.test(String(v))),
    message: "Vendor no must be exactly 6 digits",
  },
  // col 12 - "numeric 10 digits"
  poNo: {
    test: sparse((v) => /^[0-9]{10}$/.test(String(v).trim())),
    message: "PO no must be exactly 10 digits",
  },
  // col 20 - "text, Number 16 digit"
  taxInvNo: {
    test: sparse((v) => String(v).trim().length <= 16),
    message: "Tax Inv no must be 16 characters or fewer",
  },
  // col 31 - "% number"
  advancePercentage: {
    test: sparse((v) => {
      const n = Number(v);
      return Number.isFinite(n) && n >= 0 && n <= 100;
    }),
    message: "Advance percentage must be between 0 and 100",
  },
  // col 46 - "10 digit no only as per SAP"
  migoNo: {
    test: sparse((v) => /^[0-9]{10}$/.test(String(v).trim())),
    message: "MIGO no must be exactly 10 digits, as per SAP",
  },
  // col 72 - "10 digit no only as per SAP"
  sesNo: {
    test: sparse((v) => /^[0-9]{10}$/.test(String(v).trim())),
    message: "SES no must be exactly 10 digits, as per SAP",
  },
};

/** Shape a FORMATS entry into a mongoose `validate` option. */
export const asValidator = (key) => ({
  validator: FORMATS[key].test,
  message: FORMATS[key].message,
});

/**
 * Status at Site (col 60).
 *
 * The Logic sheet is authoritative here: Hold / Accept / Reject Invoice /
 * Proforma Invoice. (The Field entry sheet lists a fourth value "Issue", which
 * is an outlier and is not implemented.) Stored lowercase; LABELS carries the
 * wording the client expects on screen and in reports.
 */
export const SITE_STATUS = ["accept", "reject", "hold", "proforma"];

export const SITE_STATUS_LABELS = {
  hold: "Hold",
  accept: "Accept",
  reject: "Reject Invoice",
  proforma: "Proforma Invoice",
};

/**
 * What column 2 ("Created By") reads for a bill that arrived through the Excel
 * import rather than the Create Bill form.
 *
 * The importer used to stamp "SYSTEM IMPORT" into taxInvRecdBy (col 25) - a
 * real data column that records the person who took delivery of the invoice at
 * site - and left Created By empty (observations, General R12).
 */
export const SYSTEM_IMPORT_AUTHOR = "System Import";

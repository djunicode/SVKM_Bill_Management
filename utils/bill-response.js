/**
 * Shaping a bill document for the API response.
 *
 * The dashboard list endpoints flatten the populated vendor onto the bill so
 * clients can read `vendorNo` / `vendorName` / `gstNumber` / `panStatus` /
 * `compliance206AB` directly. createBill did not, so a checklist printed
 * straight after saving received a nested `vendor` and rendered those fields
 * blank (observations C-01 and C-02).
 *
 * Column numbers below refer to the "Field entry" sheet, which is the register
 * of record for this project.
 */

/**
 * @param {import("mongoose").Document} bill  a Bill with vendor, currency and
 *        natureOfWork populated (vendor in turn with PANStatus and
 *        complianceStatus populated)
 * @param {object}  [opts]
 * @param {boolean} [opts.keepVendor=false]  retain the nested `vendor` object
 *        alongside the flattened fields. The list endpoints drop it; createBill
 *        keeps it so existing clients that read `bill.vendor.*` still work.
 * @returns {object} a plain object safe to send as JSON
 */
export const flattenBill = (bill, { keepVendor = false } = {}) => {
  const obj = typeof bill?.toObject === "function" ? bill.toObject() : { ...bill };

  // region is a plain string on the schema, but some callers populate it
  obj.region = Array.isArray(obj.region)
    ? obj.region.map((r) => r?.name || r)
    : obj.region?.name || obj.region;

  // Column 2 as the grids show it: login name and team (1.10, item 10).
  // createdBy and createdByTeam stay separate for the checklists.
  obj.createdByLabel =
    [obj.createdBy, obj.createdByTeam].filter(Boolean).join(" - ") || null;

  obj.currency = obj.currency?.currency || obj.currency || null;      // col 22
  obj.natureOfWork = obj.natureOfWork?.natureOfWork || obj.natureOfWork || null; // col 3

  if (obj.vendor && typeof obj.vendor === "object") {
    obj.vendorNo = obj.vendor.vendorNo;              // col 6
    obj.vendorName = obj.vendor.vendorName;          // col 7
    obj.PAN = obj.vendor.PAN;
    obj.gstNumber = obj.vendor.GSTNumber;            // col 8
    obj.compliance206AB =
      obj.vendor.complianceStatus?.compliance206AB ||
      obj.vendor.complianceStatus ||
      null;                                          // col 9
    obj.panStatus =
      obj.vendor.PANStatus?.name || obj.vendor.PANStatus || null; // col 10

    if (!keepVendor) delete obj.vendor;
  }

  return obj;
};

export default flattenBill;

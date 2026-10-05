import VendorMaster from "../models/vendor-master-model.js";
import { isAdminRole } from "./roles.js";

export const FIELDS = {
  taxInvRecdAtSite: "taxInvRecdAtSite",
  pimoDispatch: "pimoMumbai.dateGiven",
  pimoReceived: "pimoMumbai.dateReceived",
  qsGivenForMeasure: "qsInspection.dateGiven", // col 35 - Dt given-QS for measure
  qsMeasureGiven: "qsMeasurementCheck.dateGiven", // Dt Checked by QS with Measure
  qsMeasureReturn: "vendorFinalInv.dateGiven",
  qsCopGiven: "qsCOP.dateGiven",
  qsCopReturn: "copDetails.dateReturned",
  qsMumbaiGiven: "qsMumbai.dateGiven",
  qsMumbaiReturn: "pimoMumbai.dateReturnedFromQs",
  acctsGiven: "accountsDept.dateGiven",
  acctsReceived: "accountsDept.dateReceived",
  paymentDate: "accountsDept.paymentDate",
  siteStatus: "siteStatus",
  taxInvDate: "taxInvDate",
  taxInvNo: "taxInvNo",
  vendorName: "vendorName"
};

export const endOfDay = (dateString) => {
  const date = new Date(dateString);
  date.setHours(23, 59, 59, 999);
  return date;
};

export const startOfDay = (dateString) => {
  const date = new Date(dateString);
  date.setHours(0, 0, 0, 0);
  return date;
};

/** Handles region[]=MUMBAI and other array query params from the frontend. */
export const normalizeQueryValue = (value) => {
  if (Array.isArray(value)) {
    return value.length ? value[0] : undefined;
  }
  return value;
};

export const formatDate = (dateValue) => {
  if (!dateValue) return null;
  const date = new Date(dateValue);
  if (isNaN(date.getTime())) return null;
  return `${String(date.getDate()).padStart(2, "0")}-${String(
    date.getMonth() + 1
  ).padStart(2, "0")}-${date.getFullYear()}`;
};

export const fmt = (dateValue) => formatDate(dateValue) || "";

export const dateFilled = (fieldPath) => ({
  [fieldPath]: { $ne: null, $exists: true },
});

export const dateBlank = (fieldPath) => ({
  [fieldPath]: { $eq: null },
});

/**
 * The Report logics sheet sets the default selection window at
 * 01-01-2020 to today (revised up from "today only" in the earlier spec).
 */
export const REPORT_DEFAULT_START = "2020-01-01";

/**
 * Apply the report's date window.
 *
 * Previously a range was only applied when BOTH ends were supplied, so a
 * one-sided selection silently widened to every bill ever raised. Each end is
 * now honoured on its own, and when neither is given the documented default
 * window applies.
 */
export const applyOptionalDateRange = (filter, fieldPath, query) => {
  const startDate = normalizeQueryValue(query.startDate);
  const endDate = normalizeQueryValue(query.endDate);

  const range = {};
  if (startDate) range.$gte = startOfDay(startDate);
  if (endDate) range.$lte = endOfDay(endDate);

  if (!startDate && !endDate) {
    range.$gte = startOfDay(REPORT_DEFAULT_START);
    range.$lte = endOfDay(new Date());
  }

  // Preserve any emptiness test already on this field (dateFilled / dateBlank).
  filter[fieldPath] =
    filter[fieldPath] && typeof filter[fieldPath] === "object"
      ? { ...filter[fieldPath], ...range }
      : range;
};

/**
 * Every region the caller asked for, as a de-duplicated array of strings.
 *
 * The report pages seed their region dropdown from the user's own region list
 * and send the whole list until a single region is picked, so `region` arrives
 * as `region[]=MUMBAI&region[]=INDORE`. normalizeQueryValue() kept only the
 * FIRST entry, so a user with more than one region saw one region's bills while
 * the dropdown still read "All Regions" (observations Q-08, and the reason
 * clearing a vendor name never appeared to restore the full list).
 */
export const normalizeQueryList = (value) => {
  const raw = Array.isArray(value) ? value : value == null ? [] : [value];
  return [...new Set(raw.map((v) => String(v).trim()).filter(Boolean))];
};

/**
 * Scope a report to the regions the caller is actually entitled to see.
 *
 * This used to apply only what the CLIENT asked for, and nothing else - so a
 * request with no region parameter returned every region in the system. A Site
 * or QS user could read the whole organisation's bills from any report
 * (observation N-01). Every other bill query in the codebase clamps to
 * `req.user.region`; the reports were the exception.
 *
 * Admins, and users holding the "ALL" pseudo-region, are unrestricted. For
 * everyone else the requested regions are INTERSECTED with their own, so
 * asking for a region you do not hold returns nothing rather than everything.
 *
 * @param {object} filter  the mongo filter being assembled, mutated in place
 * @param {*}      region  the region(s) requested, from the query string
 * @param {object} user    req.user - pass it, or the clamp cannot be applied
 */
export const applyRegionFilter = (filter, region, user) => {
  const asked = normalizeQueryList(region);

  const mine = Array.isArray(user?.region)
    ? user.region.filter(Boolean)
    : user?.region
    ? [user.region]
    : [];

  const unrestricted = isAdminRole(user?.role) || mine.includes("ALL");

  let values;
  if (unrestricted) {
    values = asked;
  } else if (mine.length === 0) {
    // A non-admin with no regions is entitled to nothing, not to everything.
    filter.region = { $in: [] };
    return;
  } else if (asked.length === 0) {
    values = mine;
  } else {
    values = asked.filter((r) => mine.includes(r));
    if (values.length === 0) {
      filter.region = { $in: [] };
      return;
    }
  }

  if (values.length === 1) filter.region = values[0];
  else if (values.length > 1) filter.region = { $in: values };
};

export const applyVendorFilter = async (filter, vendorName) => {
  const value = normalizeQueryValue(vendorName);
  if (!value) return;
  const vendor = await VendorMaster.find({
    vendorName: { $regex: escapeRegex(String(value).trim()), $options: "i" },
  });
  if (vendor) {
    filter.vendor = { $in: vendor.map(v => v._id) };
  }
};

export const buildReportResponse = (title, filterCriteria, data, extra = {}) => ({
  report: {
    title,
    generatedAt: new Date().toISOString(),
    filterCriteria,
    data,
    ...extra,
  },
});

export const appendGrandTotalTaxAmount = (rows) => {
  const dataRows = rows.filter((r) => !r.isGrandTotal && !r.isSubtotal);
  const totalTaxInvAmt = dataRows.reduce(
    (sum, item) => sum + (Number(item.taxInvAmt) || 0),
    0
  );
  const count = dataRows.length;
  return [
    ...rows,
    {
      count,
      isGrandTotal: true,
      grandTotalLabel: "Grand Total",
      grandTotalTaxAmount: totalTaxInvAmt,
    },
  ];
};

export const appendGrandTotalCourierStyle = (rows) => {
  const dataRows = rows.filter((r) => !r.isGrandTotal && !r.isSubtotal);
  const totalTaxInvAmt = dataRows.reduce(
    (sum, item) => sum + (Number(item.taxInvAmt) || 0),
    0
  );
  const count = dataRows.length;
  return [
    ...rows,
    {
      isGrandTotal: true,
      grandTotalLabel: "Grand Total",
      grandTotalTaxAmount: totalTaxInvAmt,
      count,
    },
  ];
};

export const sortUnpaidFirstThenAmountDesc = (bills) => {
  return [...bills].sort((a, b) => {
    const aPaid = a.accountsDept?.paymentDate ? 1 : 0;
    const bPaid = b.accountsDept?.paymentDate ? 1 : 0;
    if (aPaid !== bPaid) return aPaid - bPaid;
    return (b.taxInvAmt || 0) - (a.taxInvAmt || 0);
  });
};

export const daysBetween = (date1, date2) => {
  if (!date1 || !date2) return null;
  const d1 = new Date(date1);
  const d2 = new Date(date2);
  if (isNaN(d1.getTime()) || isNaN(d2.getTime())) return null;
  const diffTime = Math.abs(d2 - d1);
  return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
};

export const fiscalYearStartISO = () => "2025-04-01";
export const todayISO = () => new Date().toISOString().split("T")[0];

/**
 * Bill Kidhar and Bill Journey (1.10, item O-02): the date criteria apply to
 * column 24 "Dt recd at Site", not the Tax Inv Date, and the default window
 * is 01-04-2020 to today.
 */
export const KIDHAR_JOURNEY_DEFAULT_START = "2020-04-01";

// Column 24 newest first, then Sr no descending (1.10, item O-02).
export const KIDHAR_JOURNEY_SORT = { [FIELDS.taxInvRecdAtSite]: -1, srNo: -1 };

export const applyKidharJourneyDateRange = (filter, query) => {
  const startDate = normalizeQueryValue(query.startDate) || KIDHAR_JOURNEY_DEFAULT_START;
  const endDate = normalizeQueryValue(query.endDate) || todayISO();
  const field = FIELDS.taxInvRecdAtSite;
  // Keep the "filled" test the reports already put on this column.
  filter[field] = {
    ...(filter[field] && typeof filter[field] === "object" ? filter[field] : {}),
    $gte: startOfDay(startDate),
    $lte: endOfDay(endDate),
  };
  return { startDate, endDate };
};

/** The nature of work's name, whether populated or not (1.10, item O-19). */
export const natureOfWorkName = (bill) => {
  const value = bill?.natureOfWork;
  if (!value) return "";
  if (typeof value === "object" && "natureOfWork" in value) return value.natureOfWork || "";
  return typeof value === "string" ? value : "";
};

export const applyPaymentStatusFilter = (filter, paymentStatus) => {
  const value = normalizeQueryValue(paymentStatus);
  if (!value) return;
  const normalized = String(value).toLowerCase();
  if (normalized === "paid") {
    filter["accountsDept.paymentDate"] = { $ne: null, $exists: true };
  } else if (normalized === "unpaid") {
    filter["accountsDept.paymentDate"] = { $eq: null };
  }
};

export const applySrNoFilter = (filter, srNo) => {
  const value = normalizeQueryValue(srNo);
  if (value) {
    filter.srNo = value;
  }
};

export function escapeRegex(text) {
  return text.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
}

export const applyTaxInvNoFilter = (filter, taxInvNo) => {
  const value = normalizeQueryValue(taxInvNo);
  if (value) {
    filter.taxInvNo = { $regex: escapeRegex(String(value).trim()), $options: "i" };
  }
};
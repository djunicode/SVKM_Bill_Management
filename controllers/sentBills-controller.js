import Bill from "../models/bill-model.js";
import { flattenBill } from "../utils/bill-response.js";
import { tabFilter, sortValueFor, canonicalRole } from "../utils/tab-predicates.js";

/**
 * The Forwarded tab.
 *
 * Membership now comes from utils/tab-predicates.js, the same module the Home
 * and Incoming tabs use, so the three tabs cannot drift apart. Two things this
 * endpoint previously lacked:
 *
 *   - authentication. It was mounted without it, so anyone who could reach the
 *     server could read any team's bills.
 *   - region scoping. It returned every region regardless of who was asking,
 *     unlike every other bill query.
 */
export const getBillsAboveLevel = async (req, res) => {
  try {
    // team_name overrides the path param, as the dashboard sends it that way.
    const role = req.query.team_name || req.params.role;

    const scope = tabFilter(role, "forwarded");
    if (!scope) {
      return res.status(400).json({
        success: false,
        message: "Invalid role provided",
      });
    }

    const filter = { region: { $in: req.user.region }, ...scope };

    const bills = await Bill.find(filter)
      .populate("currency")
      .populate("natureOfWork")
      .populate({
        path: "vendor",
        populate: [
          { path: "PANStatus", model: "PanStatusMaster" },
          { path: "complianceStatus", model: "ComplianceMaster" },
        ],
      });

    const mappedBills = bills.map((bill) => flattenBill(bill));

    // Latest first on the tab's own sort column, Sr no as tiebreaker. Dates are
    // compared by day so that same-day bills fall through to Sr no.
    mappedBills.sort((a, b) => {
      const av = sortValueFor(a, role, "forwarded");
      const bv = sortValueFor(b, role, "forwarded");
      const da = av ? new Date(av).setHours(0, 0, 0, 0) : 0;
      const db = bv ? new Date(bv).setHours(0, 0, 0, 0) : 0;
      if (da !== db) return db - da;

      const an = Number(a.srNo);
      const bn = Number(b.srNo);
      if (!Number.isNaN(an) && !Number.isNaN(bn)) return bn - an;
      return String(b.srNo || "").localeCompare(String(a.srNo || ""));
    });

    return res.status(200).json({
      success: true,
      role: canonicalRole(role),
      data: mappedBills,
    });
  } catch (error) {
    console.error("Error fetching forwarded bills:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch forwarded bills",
      error: error.message,
    });
  }
};

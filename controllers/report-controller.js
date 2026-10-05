import Bill from "../models/bill-model.js";
import VendorMaster from "../models/vendor-master-model.js";
import {
  FIELDS,
  endOfDay,
  fmt,
  formatDate,
  dateFilled,
  dateBlank,
  applyOptionalDateRange,
  applyRegionFilter,
  applyVendorFilter,
  applyPaymentStatusFilter,
  applyTaxInvNoFilter,
  applySrNoFilter,
  applyKidharJourneyDateRange,
  normalizeQueryValue,
  normalizeQueryList,
  buildReportResponse,
  appendGrandTotalTaxAmount,
  appendGrandTotalCourierStyle,
  KIDHAR_JOURNEY_SORT,
  daysBetween,
  escapeRegex,
  natureOfWorkName,
} from "../utils/report-utils.js";

const handleReportError = (res, error, label) => {
  console.error(`Error generating ${label}:`, error);
  return res.status(500).json({
    success: false,
    message: "Error generating report",
    error: error.message,
  });
};

/**
 * Reports 1-11 sort on their own date column, then on Sr no DESCENDING.
 *
 * The second key was missing, so bills sharing a date came back in whatever
 * order mongo happened to return them and the order changed between runs
 * (observation N-05). Applying it here rather than at each of the ten call
 * sites means a new report cannot forget it.
 */
const fetchBills = (filter, sort) =>
  Bill.find(filter)
    .sort({ ...sort, srNo: -1 })
    .populate("vendor")
    .populate("natureOfWork");

// 12. Outstanding Bills Report
export const getOutstandingBillsReport = async (req, res) => {
  try {
    const { vendor, vendorName } = req.query;
    const region = normalizeQueryList(req.query.region);

    const filter = {
      ...dateFilled(FIELDS.acctsReceived),
      ...dateBlank(FIELDS.paymentDate),
      siteStatus: "accept",
    };

    /*
     * The date range keys on column 82, "Dt recd-Accts", not on the tax
     * invoice date (observation S-25: "filter is wrongly done on Tax Inv Date
     * column"). The report answers "what is outstanding in Accounts", so the
     * window that matters is when Accounts received the bill.
     *
     * Membership - column 82 filled, column 89 blank, Status Accept - is
     * already what the filter above asserts.
     */
    applyOptionalDateRange(filter, FIELDS.acctsReceived, req.query);
    applyRegionFilter(filter, region, req.user);
    await applyVendorFilter(filter, vendor || vendorName);

    const outstandingBills = await Bill.find(filter)
      .populate("vendor")
      .populate("natureOfWork");

    const vendorGroups = {};
    outstandingBills.forEach((bill) => {
      const name = bill.vendor?.vendorName || "";
      if (!vendorGroups[name]) vendorGroups[name] = [];
      vendorGroups[name].push(bill);
    });

    const sortedVendorNames = Object.keys(vendorGroups).sort();
    let reportData = [];
    let totalInvoiceAmount = 0;
    let totalCopAmount = 0;
    let totalCount = 0;

    sortedVendorNames.forEach((name) => {
      const vendorBills = vendorGroups[name];
      vendorBills.sort(
        (a, b) => new Date(a.taxInvDate || 0) - new Date(b.taxInvDate || 0)
      );

      let vendorSubtotal = 0;
      let vendorCopSubtotal = 0;
      const billCount = vendorBills.length;
      totalCount += billCount;

      vendorBills.forEach((bill) => {
        const taxInvAmt = parseFloat(
          bill.taxInvAmt || bill.accountsDept?.paymentAmt || 0
        );
        const copAmt = parseFloat(bill.copDetails?.amount || 0);
        vendorSubtotal += isNaN(taxInvAmt) ? 0 : taxInvAmt;
        vendorCopSubtotal += isNaN(copAmt) ? 0 : copAmt;
        totalInvoiceAmount += isNaN(taxInvAmt) ? 0 : taxInvAmt;
        totalCopAmount += isNaN(copAmt) ? 0 : copAmt;

        reportData.push({
          // The id lets the report save an edited Remarks for Payment
          // Instructions straight back to the bill (23.09, item 13).
          _id: bill._id,
          srNo: bill.srNo,
          natureOfWork: natureOfWorkName(bill), // reports' Nature of Work filter (1.10, item O-19)
          projectDescription: bill.projectDescription || "",
          region: bill.region || "",
          vendorNo: bill.vendor?.vendorNo || "",
          vendorName: bill.vendor?.vendorName || "",
          taxInvNo: bill.taxInvNo || "",
          taxInvDate: fmt(bill.taxInvDate),
          taxInvAmt: !isNaN(taxInvAmt) ? Number(taxInvAmt.toFixed(2)) : 0,
          copAmt: !isNaN(copAmt) ? Number(copAmt.toFixed(2)) : 0,
          dateRecdInAcctsDept: fmt(bill.accountsDept?.dateReceived),
          paymentInstructions: bill.accountsDept?.paymentInstructions || "",
          remarksForPaymentInstructions:
            bill.accountsDept?.remarksForPayInstructions || "",
        });
      });

      reportData.push({
        isSubtotal: true,
        vendorName: name,
        subtotalLabel: `Subtotal for ${name}:`,
        subtotalAmount: Number(vendorSubtotal.toFixed(2)),
        subtotalCopAmt: Number(vendorCopSubtotal.toFixed(2)),
        count: billCount,
      });
    });

    reportData.push({
      isGrandTotal: true,
      grandTotalLabel: "Grand Total:",
      grandTotalAmount: Number(totalInvoiceAmount.toFixed(2)),
      grandTotalCopAmt: Number(totalCopAmount.toFixed(2)),
      totalCount,
    });

    const vendorSubtotals = sortedVendorNames.map((name) => {
      const vendorBills = vendorGroups[name];
      const totalAmount = vendorBills.reduce((sum, bill) => {
        const amount = parseFloat(
          bill.taxInvAmt || bill.accountsDept?.paymentAmt || 0
        );
        return sum + (isNaN(amount) ? 0 : amount);
      }, 0);
      const totalCop = vendorBills.reduce((sum, bill) => {
        const copAmount = parseFloat(bill.copDetails?.amount || 0);
        return sum + (isNaN(copAmount) ? 0 : copAmount);
      }, 0);
      return {
        vendorName: name,
        totalAmount: Number(totalAmount.toFixed(2)),
        totalCopAmount: Number(totalCop.toFixed(2)),
        count: vendorBills.length,
      };
    });

    return res.status(200).json(
      buildReportResponse(
        "Outstanding Bills Report",
        {
          logic:
            "date inv recd in accts dept is filled and date of payment is empty",
          sorting: ["vendorName", "invoiceDate"],
        },
        reportData,
        {
          summary: {
            vendorSubtotals,
            totalInvoiceAmount: Number(totalInvoiceAmount.toFixed(2)),
            totalCopAmount: Number(totalCopAmount.toFixed(2)),
            recordCount:
              reportData.length - sortedVendorNames.length - 1,
          },
        }
      )
    );
  } catch (error) {
    return handleReportError(res, error, "outstanding bills report");
  }
};

// 13. Outstanding Bills Report Subtotal
export const getOutstandingBillsSubtotalReport = async (req, res) => {
  try {
    const { vendor, vendorName } = req.query;
    const region = normalizeQueryList(req.query.region);

    const filter = {
      ...dateFilled(FIELDS.acctsReceived),
      ...dateBlank(FIELDS.paymentDate),
      siteStatus: "accept",
    };

    /*
     * The date range keys on column 82, "Dt recd-Accts", not on the tax
     * invoice date (observation S-25: "filter is wrongly done on Tax Inv Date
     * column"). The report answers "what is outstanding in Accounts", so the
     * window that matters is when Accounts received the bill.
     *
     * Membership - column 82 filled, column 89 blank, Status Accept - is
     * already what the filter above asserts.
     */
    applyOptionalDateRange(filter, FIELDS.acctsReceived, req.query);
    applyRegionFilter(filter, region, req.user);
    await applyVendorFilter(filter, vendor || vendorName);

    const outstandingBills = await Bill.find(filter).populate("vendor").populate("natureOfWork");

    const vendorGroups = {};
    outstandingBills.forEach((bill) => {
      const name = bill.vendor?.vendorName || "";
      if (!vendorGroups[name]) vendorGroups[name] = [];
      vendorGroups[name].push(bill);
    });

    const sortedVendorNames = Object.keys(vendorGroups).sort();
    let reportData = [];
    let totalInvoiceAmount = 0;
    let totalCopAmount = 0;
    let totalCount = 0;

    sortedVendorNames.forEach((name) => {
      const vendorBills = vendorGroups[name];
      vendorBills.sort(
        (a, b) => new Date(a.taxInvDate || 0) - new Date(b.taxInvDate || 0)
      );

      let vendorSubtotal = 0;
      let vendorCopSubtotal = 0;
      const billCount = vendorBills.length;
      totalCount += billCount;

      vendorBills.forEach((bill) => {
        const taxInvAmt = parseFloat(bill.taxInvAmt || 0);
        const copAmt = parseFloat(bill.copDetails?.amount || 0);
        vendorSubtotal += isNaN(taxInvAmt) ? 0 : taxInvAmt;
        vendorCopSubtotal += isNaN(copAmt) ? 0 : copAmt;
        totalInvoiceAmount += isNaN(taxInvAmt) ? 0 : taxInvAmt;
        totalCopAmount += isNaN(copAmt) ? 0 : copAmt;

        reportData.push({
          srNo: bill.srNo,
          natureOfWork: natureOfWorkName(bill), // reports' Nature of Work filter (1.10, item O-19)
          region: bill.region || "",
          vendorNo: bill.vendor?.vendorNo || "",
          vendorName: bill.vendor?.vendorName || "",
          taxInvNo: bill.taxInvNo || "",
          taxInvDate: fmt(bill.taxInvDate),
          taxInvAmt: !isNaN(taxInvAmt) ? Number(taxInvAmt.toFixed(2)) : 0,
          copAmt: !isNaN(copAmt) ? Number(copAmt.toFixed(2)) : 0,
          dateRecdInAcctsDept: fmt(bill.accountsDept?.dateReceived),
        });
      });

      reportData.push({
        isSubtotal: true,
        vendorName: name,
        subtotalLabel: `Subtotal for ${name}:`,
        subtotalAmount: Number(vendorSubtotal.toFixed(2)),
        subtotalCopAmt: Number(vendorCopSubtotal.toFixed(2)),
        count: billCount,
      });
    });

    reportData.push({
      isGrandTotal: true,
      grandTotalLabel: "Grand Total:",
      grandTotalAmount: Number(totalInvoiceAmount.toFixed(2)),
      grandTotalCopAmt: Number(totalCopAmount.toFixed(2)),
      totalCount,
    });

    return res.status(200).json(
      buildReportResponse(
        "Outstanding Bills Report Subtotal",
        {
          logic:
            "date inv recd in accts dept is filled and date of payment is empty",
          sorting: ["vendorName", "invoiceDate"],
        },
        reportData,
        {
          summary: {
            totalCount,
            totalInvoiceAmount: Number(totalInvoiceAmount.toFixed(2)),
            totalCopAmount: Number(totalCopAmount.toFixed(2)),
          },
        }
      )
    );
  } catch (error) {
    return handleReportError(res, error, "outstanding bills subtotal report");
  }
};

// 1. Invoices at Site
export const getInvoicesReceivedAtSite = async (req, res) => {
  try {
    const region = normalizeQueryList(req.query.region);
    const filter = {
      ...dateFilled(FIELDS.taxInvRecdAtSite),
      ...dateBlank(FIELDS.pimoDispatch),
      siteStatus: "hold",
    };
    applyOptionalDateRange(filter, FIELDS.taxInvRecdAtSite, req.query);
    applyRegionFilter(filter, region, req.user);

    const bills = await fetchBills(filter, { taxInvRecdAtSite: -1 });
    const reportData = appendGrandTotalTaxAmount(
      bills.map((invoice) => ({
        srNo: invoice.srNo,
        natureOfWork: natureOfWorkName(invoice), // reports' Nature of Work filter (1.10, item O-19)
        region: invoice.region,
        projectDescription: invoice.projectDescription,
        vendorNo: invoice.vendor?.vendorNo || "",
        vendorName: invoice.vendor?.vendorName || "",
        taxInvNo: invoice.taxInvNo,
        taxInvDate: fmt(invoice.taxInvDate),
        taxInvAmt: invoice.taxInvAmt ?? 0,
        taxInvRecdAtSite: fmt(invoice.taxInvRecdAtSite),
        poNo: invoice.poNo,
      }))
    );

    return res.status(200).json(
      buildReportResponse(
        "Invoices Received at Site Report",
        {
          logic:
            "date of tax invoice received at site is filled and sent to Mumbai is blank",
          sorting: ["dateReceivedAtSite"],
        },
        reportData
      )
    );
  } catch (error) {
    return handleReportError(res, error, "invoices at site report");
  }
};

// 2. Invoices at PIMO
export const getInvoicesReceivedAtPIMOMumbai = async (req, res) => {
  try {
    const region = normalizeQueryList(req.query.region);
    const filter = {
      ...dateFilled(FIELDS.pimoReceived),
      ...dateBlank(FIELDS.acctsGiven),
      siteStatus: "accept",
    };
    applyOptionalDateRange(filter, FIELDS.pimoReceived, req.query);
    applyRegionFilter(filter, region, req.user);

    const bills = await fetchBills(filter, { "pimoMumbai.dateReceived": -1 });
    const reportData = appendGrandTotalTaxAmount(
      bills.map((invoice) => ({
        srNo: invoice.srNo,
        natureOfWork: natureOfWorkName(invoice), // reports' Nature of Work filter (1.10, item O-19)
        region: invoice.region,
        projectDescription: invoice.projectDescription,
        vendorNo: invoice.vendor?.vendorNo || "",
        vendorName: invoice.vendor?.vendorName || "",
        taxInvNo: invoice.taxInvNo,
        taxInvDate: fmt(invoice.taxInvDate),
        taxInvAmt: invoice.taxInvAmt ?? 0,
        pimoDateReceived: fmt(invoice.pimoMumbai?.dateReceived),
        poNo: invoice.poNo,
      }))
    );

    return res.status(200).json(
      buildReportResponse(
        "Invoices Received at Mumbai Report",
        {
          logic:
            "date of tax invoice received at Mumbai is filled and sent to accounts department is blank",
          sorting: ["vendorName", "dateReceivedAtMumbai"],
        },
        reportData
      )
    );
  } catch (error) {
    return handleReportError(res, error, "invoices at PIMO report");
  }
};

// 3. Invoices with QS Site for Measurement
export const getInvoicesGivenToQsSite = async (req, res) => {
  try {
    const region = normalizeQueryList(req.query.region);
    /*
     * Keyed on column 35, "Dt given-QS for measure" (qsInspection.dateGiven).
     *
     * It used to key on qsMeasurementCheck.dateGiven, "Dt Checked by QS with
     * Measure" - a later event. A report about invoices still WITH QS has to
     * be driven by when they went to QS, not by when QS finished with them
     * (observation N-07).
     */
    const filter = {
      ...dateFilled(FIELDS.qsGivenForMeasure),
      ...dateBlank(FIELDS.qsMeasureReturn),
      siteStatus: "hold",
    };
    applyOptionalDateRange(filter, FIELDS.qsGivenForMeasure, req.query);
    applyRegionFilter(filter, region, req.user);

    const bills = await fetchBills(filter, { [FIELDS.qsGivenForMeasure]: -1 });
    const reportData = appendGrandTotalTaxAmount(
      bills.map((invoice) => ({
        srNo: invoice.srNo,
        natureOfWork: natureOfWorkName(invoice), // reports' Nature of Work filter (1.10, item O-19)
        region: invoice.region,
        projectDescription: invoice.projectDescription,
        vendorNo: invoice.vendor?.vendorNo || "",
        vendorName: invoice.vendor?.vendorName || "",
        taxInvNo: invoice.taxInvNo,
        taxInvDate: fmt(invoice.taxInvDate),
        taxInvAmt: invoice.taxInvAmt ?? 0,
        dateGivenToQSMeasurement: fmt(invoice.qsInspection?.dateGiven), // col 35
        poNo: invoice.poNo,
      }))
    );

    return res.status(200).json(
      buildReportResponse(
        "Invoices Given to QS Site Report",
        {
          logic: "date of invoice given to QS site is filled",
          sorting: ["dateGivenToQsSite"],
        },
        reportData
      )
    );
  } catch (error) {
    return handleReportError(res, error, "invoices with QS site for measurement");
  }
};

// 4. Invoices with QS Site for Prov COP
export const getInvoicesAtQSforProvCOP = async (req, res) => {
  try {
    const region = normalizeQueryList(req.query.region);
    const filter = {
      ...dateFilled(FIELDS.qsCopGiven),
      ...dateBlank(FIELDS.qsCopReturn),
      siteStatus: "hold",
    };
    applyOptionalDateRange(filter, FIELDS.qsCopGiven, req.query);
    applyRegionFilter(filter, region, req.user);

    const bills = await fetchBills(filter, { "qsCOP.dateGiven": -1 });
    const reportData = appendGrandTotalTaxAmount(
      bills.map((invoice) => ({
        srNo: invoice.srNo,
        natureOfWork: natureOfWorkName(invoice), // reports' Nature of Work filter (1.10, item O-19)
        region: invoice.region,
        projectDescription: invoice.projectDescription,
        vendorNo: invoice.vendor?.vendorNo || "",
        vendorName: invoice.vendor?.vendorName || "",
        taxInvNo: invoice.taxInvNo,
        taxInvDate: fmt(invoice.taxInvDate),
        taxInvAmt: invoice.taxInvAmt ?? 0,
        dateGiventoQsCOP: fmt(invoice.qsCOP?.dateGiven),
        poNo: invoice.poNo,
      }))
    );

    return res.status(200).json(
      buildReportResponse(
        "Invoices Given to QS for Prov. COP report",
        {
          logic: "date of invoice given to QS site is filled",
          sorting: ["dateGivenToQsCOP"],
        },
        reportData
      )
    );
  } catch (error) {
    return handleReportError(res, error, "invoices with QS site for Prov COP");
  }
};

// 5. Invoices with QS Mumbai for COP
export const getInvoicesAtQSMumbai = async (req, res) => {
  try {
    const region = normalizeQueryList(req.query.region);
    /*
     * No Status at Site test here (observation S-31: "not working").
     *
     * It required "hold", but a bill only reaches QS Mumbai for COP after PIMO
     * has received it, and PIMO acceptance sets the status to "accept" - as the
     * client confirmed on 26 September. The report could therefore never return
     * a single row. Columns 64 and 66 alone identify the bills that are with QS
     * Mumbai.
     */
    const filter = {
      ...dateFilled(FIELDS.qsMumbaiGiven),
      ...dateBlank(FIELDS.qsMumbaiReturn),
    };
    applyOptionalDateRange(filter, FIELDS.qsMumbaiGiven, req.query);
    applyRegionFilter(filter, region, req.user);

    const bills = await fetchBills(filter, { "qsMumbai.dateGiven": -1 });
    const reportData = appendGrandTotalTaxAmount(
      bills.map((invoice) => ({
        srNo: invoice.srNo,
        natureOfWork: natureOfWorkName(invoice), // reports' Nature of Work filter (1.10, item O-19)
        region: invoice.region,
        projectDescription: invoice.projectDescription,
        vendorNo: invoice.vendor?.vendorNo || "",
        vendorName: invoice.vendor?.vendorName || "",
        taxInvNo: invoice.taxInvNo,
        taxInvDate: fmt(invoice.taxInvDate),
        taxInvAmt: invoice.taxInvAmt ?? 0,
        dateGivenToQsMumbai: fmt(invoice.qsMumbai?.dateGiven),
        poNo: invoice.poNo,
      }))
    );

    return res.status(200).json(
      buildReportResponse(
        "Invoices Given to QS for Prov. COP report",
        {
          logic: "date of invoice given to QS Mumbai is filled",
          sorting: ["dateGivenToQsMumbai"],
        },
        reportData
      )
    );
  } catch (error) {
    return handleReportError(res, error, "invoices with QS Mumbai for COP");
  }
};

// 6. Invoices Sent to PIMO Mumbai
export const getInvoicesCourierToPIMOMumbai = async (req, res) => {
  try {
    const region = normalizeQueryList(req.query.region);
    const filter = {
      ...dateFilled(FIELDS.taxInvRecdAtSite),
      ...dateFilled(FIELDS.pimoDispatch),
      ...dateBlank(FIELDS.pimoReceived),
      siteStatus: "hold",
    };
    applyOptionalDateRange(filter, FIELDS.pimoDispatch, req.query);
    applyRegionFilter(filter, region, req.user);

    const bills = await fetchBills(filter, { "pimoMumbai.dateGiven": -1 });
    const reportData = appendGrandTotalCourierStyle(
      bills.map((invoice) => ({
        srNo: invoice.srNo,
        natureOfWork: natureOfWorkName(invoice), // reports' Nature of Work filter (1.10, item O-19)
        vendorNo: invoice.vendor?.vendorNo || "", // col 6 - Report logics General #3
        vendorName: invoice.vendor?.vendorName || "",
        taxInvNo: invoice.taxInvNo,
        taxInvDate: fmt(invoice.taxInvDate),
        taxInvAmt: invoice.taxInvAmt ?? 0,
        dateDispatchedForPimo: fmt(invoice.pimoMumbai?.dateGiven),
      }))
    );

    return res.status(200).json(
      buildReportResponse(
        "Invoices Couriered to Mumbai Report",
        {
          logic:
            "date of tax invoice received at site is filled and sent to Mumbai is filled",
          sorting: ["vendorName", "courierDate"],
        },
        reportData
      )
    );
  } catch (error) {
    return handleReportError(res, error, "invoices sent to PIMO Mumbai");
  }
};

// 7. Invoices Returned by QS Site after Measurement
export const getInvoicesReturnedByQsSite = async (req, res) => {
  try {
    const region = normalizeQueryList(req.query.region);
    const filter = {
      ...dateFilled(FIELDS.qsMeasureGiven),
      ...dateFilled(FIELDS.qsMeasureReturn),
      siteStatus: "hold",
    };
    applyOptionalDateRange(filter, FIELDS.qsMeasureReturn, req.query);
    applyRegionFilter(filter, region, req.user);

    const bills = await fetchBills(filter, { "vendorFinalInv.dateGiven": -1 });
    const reportData = appendGrandTotalCourierStyle(
      bills.map((invoice) => ({
        srNo: invoice.srNo,
        natureOfWork: natureOfWorkName(invoice), // reports' Nature of Work filter (1.10, item O-19)
        vendorNo: invoice.vendor?.vendorNo || "", // col 6 - Report logics General #3
        vendorName: invoice.vendor?.vendorName || "",
        taxInvNo: invoice.taxInvNo,
        taxInvDate: fmt(invoice.taxInvDate),
        taxInvAmt: invoice.taxInvAmt ?? 0,
        dateReturnedFromQsMeasurement: fmt(invoice.vendorFinalInv?.dateGiven),
      }))
    );

    return res.status(200).json(
      buildReportResponse(
        "Invoices Couriered to Mumbai Report",
        {
          logic: "date of return of Invoice from qs measurement",
          sorting: ["returnDate"],
        },
        reportData
      )
    );
  } catch (error) {
    return handleReportError(res, error, "invoices returned by QS site after measurement");
  }
};

// 8. Invoices Returned by QS Site after Prov COP
export const getInvoicesReturnedByQsCOP = async (req, res) => {
  try {
    const region = normalizeQueryList(req.query.region);
    const filter = {
      ...dateFilled(FIELDS.qsCopGiven),
      ...dateFilled(FIELDS.qsCopReturn),
      siteStatus: "hold",
    };
    applyOptionalDateRange(filter, FIELDS.qsCopReturn, req.query);
    applyRegionFilter(filter, region, req.user);

    const bills = await fetchBills(filter, { "copDetails.dateReturned": -1 });
    const reportData = appendGrandTotalCourierStyle(
      bills.map((invoice) => ({
        srNo: invoice.srNo,
        natureOfWork: natureOfWorkName(invoice), // reports' Nature of Work filter (1.10, item O-19)
        vendorNo: invoice.vendor?.vendorNo || "", // col 6 - Report logics General #3
        vendorName: invoice.vendor?.vendorName || "",
        taxInvNo: invoice.taxInvNo,
        taxInvDate: fmt(invoice.taxInvDate),
        taxInvAmt: invoice.taxInvAmt ?? 0,
        dateDispatchedForPimo: fmt(invoice.copDetails?.dateReturned),
      }))
    );

    return res.status(200).json(
      buildReportResponse(
        "Invoices returned after Prov COP from",
        {
          logic: "date of return of Invoice from qs cop",
          sorting: ["returnDate"],
        },
        reportData
      )
    );
  } catch (error) {
    return handleReportError(res, error, "invoices returned by QS site after Prov COP");
  }
};

// 9. Invoices Returned by QS Mumbai after COP
export const getInvoicesReturnedByQSMumbai = async (req, res) => {
  try {
    const region = normalizeQueryList(req.query.region);
    const filter = {
      ...dateFilled(FIELDS.qsMumbaiGiven),
      ...dateFilled(FIELDS.qsMumbaiReturn),
      siteStatus: "accept",
    };
    applyOptionalDateRange(filter, FIELDS.qsMumbaiReturn, req.query);
    applyRegionFilter(filter, region, req.user);

    const bills = await fetchBills(filter, { "pimoMumbai.dateReturnedFromQs": -1 });
    const reportData = appendGrandTotalCourierStyle(
      bills.map((invoice) => ({
        srNo: invoice.srNo,
        natureOfWork: natureOfWorkName(invoice), // reports' Nature of Work filter (1.10, item O-19)
        vendorNo: invoice.vendor?.vendorNo || "", // col 6 - Report logics General #3
        vendorName: invoice.vendor?.vendorName || "",
        taxInvNo: invoice.taxInvNo,
        taxInvDate: fmt(invoice.taxInvDate),
        taxInvAmt: invoice.taxInvAmt ?? 0,
        dateReturnedByQS: fmt(invoice.pimoMumbai?.dateReturnedFromQs),
      }))
    );

    return res.status(200).json(
      buildReportResponse(
        "Invoices returned after Prov COP from",
        {
          logic: "date of return of Invoice from qs cop",
          sorting: ["returnDate"],
        },
        reportData
      )
    );
  } catch (error) {
    return handleReportError(res, error, "invoices returned by QS Mumbai after COP");
  }
};

// 10. Invoices Sent to Accts Team
export const getInvoicesGivenToAcctsDept = async (req, res) => {
  try {
    const region = normalizeQueryList(req.query.region);
    // Report 10, "Invoices sent to Accts Team". The spec group header for
    // reports 6-11 is "Column filled | Column FILLED": both col 62 and col 80
    // must be present. This read dateBlank(acctsGiven), which listed bills NOT
    // yet sent to Accounts - the opposite of what the report is called.
    // Selection criteria and sorting are both on col 80, the sending date.
    const filter = {
      ...dateFilled(FIELDS.pimoReceived),
      ...dateFilled(FIELDS.acctsGiven),
      siteStatus: "accept",
    };
    applyOptionalDateRange(filter, FIELDS.acctsGiven, req.query);
    applyRegionFilter(filter, region, req.user);

    const bills = await fetchBills(filter, { "accountsDept.dateGiven": -1 });
    const reportData = appendGrandTotalCourierStyle(
      bills.map((invoice) => ({
        srNo: invoice.srNo,
        natureOfWork: natureOfWorkName(invoice), // reports' Nature of Work filter (1.10, item O-19)
        vendorNo: invoice.vendor?.vendorNo || "", // col 6 - Report logics General #3
        vendorName: invoice.vendor?.vendorName || "",
        taxInvNo: invoice.taxInvNo,
        taxInvDate: fmt(invoice.taxInvDate),
        taxInvAmt: invoice.taxInvAmt ?? 0,
        dateGivenToAccounts: fmt(invoice.accountsDept?.dateGiven),
      }))
    );

    return res.status(200).json(
      buildReportResponse(
        "Invoices Given to Accounts Department Report",
        {
          logic:
            "date of tax invoice received at Mumbai is filled and sent to accounts department is blank",
          sorting: ["vendorName", "dateGivenToAccounts"],
        },
        reportData
      )
    );
  } catch (error) {
    return handleReportError(res, error, "invoices sent to Accts Team");
  }
};

// 11. Invoices Paid
export const getInvoicesPaid = async (req, res) => {
  try {
    const region = normalizeQueryList(req.query.region);
    const startDate = normalizeQueryValue(req.query.startDate);
    const endDate = normalizeQueryValue(req.query.endDate);
    const f110Identification = normalizeQueryValue(req.query.f110Identification);

    const filter = {
      ...dateFilled(FIELDS.paymentDate),
      siteStatus: "accept",
    };
    applyOptionalDateRange(filter, FIELDS.paymentDate, req.query);
    applyRegionFilter(filter, region, req.user);

    if (f110Identification) {
      filter["accountsDept.f110Identification"] = f110Identification;
    }

    const bills = await Bill.find(filter)
      .sort({ "accountsDept.paymentDate": -1 })
      .populate("vendor")
      .populate("natureOfWork");

    const reportData = bills.map((invoice) => ({
      srNo: invoice.srNo,
      natureOfWork: natureOfWorkName(invoice), // reports' Nature of Work filter (1.10, item O-19)
      dateReceivedAtAccts: fmt(invoice.accountsDept?.dateReceived),
      dateOfPayment: fmt(invoice.accountsDept?.paymentDate),
      vendorNo: invoice.vendor?.vendorNo || "",
      vendorName: invoice.vendor?.vendorName || "",
      taxInvNo: invoice?.taxInvNo || "",
      taxInvDate: fmt(invoice?.taxInvDate),
      taxInvAmt: invoice.taxInvAmt ?? 0,
      copAmount: invoice.copDetails?.amount || "",
      payentAmt: invoice.accountsDept?.paymentAmt || "",
      f110Identification: invoice.accountsDept?.f110Identification || "",
    }));

    const totalTaxInvAmt = reportData.reduce(
      (sum, item) => sum + (Number(item.taxInvAmt) || 0),
      0
    );
    const totalCopAmt = reportData.reduce(
      (sum, item) => sum + (Number(item.copAmount) || 0),
      0
    );
    const totalPaymentAmt = reportData.reduce(
      (sum, item) => sum + (Number(item.payentAmt) || 0),
      0
    );
    const count = reportData.length;

    reportData.push({
      isGrandTotal: true,
      grandTotalLabel: "Grand Total",
      grandTotalTaxAmount: totalTaxInvAmt,
      grandTotalCopAmt: totalCopAmt,
      grandTotalAmount: totalPaymentAmt,
      count,
    });

    return res.status(200).json({
      report: {
        title: "Invoices Paid",
        generatedAt: new Date().toISOString(),
        selectionCriteria: {
          dateRange:
            startDate && endDate
              ? `from ${startDate} to ${endDate}`
              : "All dates",
          f110Identification: f110Identification || "All F110 identifications",
        },
        sortingCriteria: ["Date of Payment"],
        filterLogic: "Dt of payment should be filled (Column 89)",
        data: reportData,
      },
    });
  } catch (error) {
    return handleReportError(res, error, "invoices paid report");
  }
};

// 14. Bill Kidhar Report
export const getBillKidharReport = async (req, res) => {
  try {
    const region = normalizeQueryList(req.query.region);
    const vendorName = normalizeQueryValue(req.query.vendorName);
    const paymentStatus = normalizeQueryValue(req.query.paymentStatus);
    const taxInvNo = normalizeQueryValue(req.query.taxInvNo);

    const filter = {
      ...dateFilled(FIELDS.taxInvRecdAtSite),
    };
    const dateRange = applyKidharJourneyDateRange(filter, req.query);
    applyRegionFilter(filter, region, req.user);
    applyPaymentStatusFilter(filter, paymentStatus);
    await applyVendorFilter(filter, vendorName);
    applyTaxInvNoFilter(filter, taxInvNo);

    // Column 24 newest first, then Sr no descending (1.10, item O-02).
    const sorted = await Bill.find(filter)
      .sort(KIDHAR_JOURNEY_SORT)
      .populate("vendor")
      .populate("natureOfWork");

    const rows = sorted.map((bill) => ({
      srNo: bill.srNo || "",
      natureOfWork: natureOfWorkName(bill), // reports' Nature of Work filter (1.10, item O-19)
      region: bill.region || "",
      vendorNo: bill.vendor?.vendorNo || "",
      vendorName: bill.vendor?.vendorName || "",
      taxInvNo: bill.taxInvNo || "",
      taxInvDate: fmt(bill.taxInvDate),
      taxInvAmt: bill.taxInvAmt ?? 0,
      copAmt: bill.copDetails?.amount ?? "",
      paymentAmt: bill.accountsDept?.paymentAmt ?? "",
      paymentDate: fmt(bill.accountsDept?.paymentDate),
      taxInvRecdAtSite: fmt(bill.taxInvRecdAtSite),
      qsMeasureGiven: fmt(bill.qsMeasurementCheck?.dateGiven),
      qsCopGiven: fmt(bill.qsCOP?.dateGiven),
      pimoReceived: fmt(bill.pimoMumbai?.dateReceived),
      qsMumbaiGiven: fmt(bill.qsMumbai?.dateGiven),
      acctsReceived: fmt(bill.accountsDept?.dateReceived),
    }));

    const reportData = appendGrandTotalTaxAmount(rows);

    return res.status(200).json(
      buildReportResponse(
        "Bill Kidhar Report",
        {
          dateRange: `From ${dateRange.startDate} to ${dateRange.endDate}`,
          region: region || "All",
          vendorName: vendorName || "All",
          paymentStatus: paymentStatus || "All",
          logic: "Dt recd at Site filled; date range applies to Dt recd at Site (col 24)",
          sorting: ["Dt recd at Site newest first", "Sr no descending"],
        },
        reportData
      )
    );
  } catch (error) {
    return handleReportError(res, error, "bill kidhar report");
  }
};

// 15. Bill Journey Report
export const getBillJourney = async (req, res) => {
  try {
    const region = normalizeQueryList(req.query.region);
    const vendorName = normalizeQueryValue(req.query.vendorName);
    const taxInvNo = normalizeQueryValue(req.query.taxInvNo);
    const srNo = normalizeQueryValue(req.query.srNo);
    const startDate = normalizeQueryValue(req.query.startDate);
    const endDate = normalizeQueryValue(req.query.endDate);

    const filter = {
      ...dateFilled(FIELDS.taxInvRecdAtSite),
    };
    applyKidharJourneyDateRange(filter, req.query);
    applyRegionFilter(filter, region, req.user);
    applySrNoFilter(filter, srNo);
    await applyVendorFilter(filter, vendorName);
    applyTaxInvNoFilter(filter, taxInvNo);

    // Column 24 newest first, then Sr no descending (1.10, item O-02).
    const sorted = await Bill.find(filter)
      .sort(KIDHAR_JOURNEY_SORT)
      .populate("vendor")
      .populate("natureOfWork")
      .populate("currency");

    let totalInvoiceAmount = 0;
    let totalSiteDays = 0;
    let totalMumbaiDays = 0;
    let totalAccountsDays = 0;
    let totalPaymentDays = 0;
    let countSiteDays = 0;
    let countMumbaiDays = 0;
    let countAccountsDays = 0;
    let countPaymentDays = 0;

    const reportData = sorted.map((bill) => {
      const invoiceAmount = parseFloat(bill.taxInvAmt || 0);
      totalInvoiceAmount += isNaN(invoiceAmount) ? 0 : invoiceAmount;

      const delay_for_receiving_invoice = daysBetween(
        bill.taxInvDate,
        bill.taxInvRecdAtSite
      );
      const no_of_Days_Site = daysBetween(
        bill.taxInvRecdAtSite,
        bill.siteOfficeDispatch?.dateGiven
      );
      const no_of_Days_at_Mumbai = daysBetween(
        bill.pimoMumbai?.dateReceived,
        bill.accountsDept?.dateGiven
      );
      const no_of_Days_at_AC = daysBetween(
        bill.accountsDept?.dateReceived,
        bill.accountsDept?.paymentDate
      );
      const days_for_payment = daysBetween(
        bill.taxInvDate,
        bill.accountsDept?.paymentDate
      );

      if (no_of_Days_Site !== null) {
        totalSiteDays += no_of_Days_Site;
        countSiteDays++;
      }
      if (no_of_Days_at_Mumbai !== null) {
        totalMumbaiDays += no_of_Days_at_Mumbai;
        countMumbaiDays++;
      }
      if (no_of_Days_at_AC !== null) {
        totalAccountsDays += no_of_Days_at_AC;
        countAccountsDays++;
      }
      if (days_for_payment !== null) {
        totalPaymentDays += days_for_payment;
        countPaymentDays++;
      }

      return {
        srNo: bill.srNo || "",
        region: bill.region || "",
        projectDescription: bill.projectDescription || "",
        vendorName: bill.vendor?.vendorName || "",
        vendorNo: bill.vendor?.vendorNo || "",
        invoiceDate: fmt(bill.taxInvDate),
        invoiceAmount: !isNaN(invoiceAmount)
          ? Number(invoiceAmount.toFixed(2))
          : 0,
        taxInvNo: bill.taxInvNo || "",
        taxInvDate: bill.taxInvDate,
        taxInvAmt: bill.taxInvAmt || "",
        taxInvRecdAtSite: bill.taxInvRecdAtSite,
        currency: bill.currency?.currency || bill.currency || "",
        natureOfWork: bill.natureOfWork?.natureOfWork || bill.natureOfWork || "",
        typeOfInv: bill.typeOfInv || "",
        proformaInvNo: bill.proformaInvNo || "",
        proformaInvDate: bill.proformaInvDate,
        proformaInvAmt: bill.proformaInvAmt || "",
        poNo: bill.poNo || "",
        poDate: bill.poDate,
        poAmt: bill.poAmt || "",
        department: bill.department || "",
        /*
         * The journey rows, mapped column by column from the client's own
         * "Bill Journey report.xlsx" (attached 23 September). Every value
         * below names the Field-entry column it comes from.
         *
         * Several were wired to the wrong column, which is why "columns
         * filled are not fetched" (observation N-10): "Bill send to QS" read
         * the measurement-CHECK date instead of col 35, "Certified by QS"
         * read the date the bill was GIVEN to QS instead of the COP date,
         * "Received Back from I.T.Dept." read a field the workflow never
         * writes, and "Certified by Trustee" read the date the bill was sent
         * FOR approval rather than the date it came back. The name and amount
         * columns her layout calls for were absent altogether.
         */
        // Added at her request (29.09, item 28).
        siteApprovalDate: fmt(bill.siteOfficeDispatch?.dateGiven),            // 58
        migoDate: fmt(bill.migoDetails?.date),                                // 47
        sesDate: fmt(bill.sesDetails?.date),                                  // 74

        billReceivedAtSite: fmt(bill.taxInvRecdAtSite),                       // 24
        billReceivedAtSiteName: bill.taxInvRecdBy || "",                      // 25

        /*
         * The hand-signed rows were dropped from the report altogether
         * (29.09, item 28) - they never carried a value, and eleven empty
         * columns made the sheet hard to read.
         */

        billSendForQualityCertification: fmt(bill.qualityEngineer?.dateGiven), // 33
        billSendForQualityCertificationName: bill.qualityEngineer?.name || "", // 34

        // "Column 35 /Column 40" - measurement if present, else Prov COP.
        billSendToQS: fmt(bill.qsInspection?.dateGiven || bill.qsCOP?.dateGiven),
        billSendToQSName: bill.qsInspection?.dateGiven
          ? bill.qsInspection?.name || ""                                     // 36
          : bill.qsCOP?.name || "",                                           // 41

        certifiedByQS: fmt(bill.copDetails?.date),                            // 42
        certifiedByQSAmount: bill.copDetails?.amount ?? "",                   // 43

        certifiedByArch: fmt(bill.architect?.dateGiven),                      // 53
        certifiedByArchName: bill.architect?.name || "",                      // 54

        // "Column 51 /Column 55" - Site Engineer if present, else Site Incharge.
        billSendToSiteEngineer: fmt(bill.siteEngineer?.dateGiven || bill.siteIncharge?.dateGiven),
        billSendToSiteEngineerName: bill.siteEngineer?.dateGiven
          ? bill.siteEngineer?.name || ""                                     // 52
          : bill.siteIncharge?.name || "",                                    // 56


        migoDateNo: bill.migoDetails?.date                                    // 47 / 46
          ? `${fmt(bill.migoDetails.date)} / ${bill.migoDetails.no || ""}`
          : "",
        migoDoneBy: bill.migoDetails?.doneBy || "",                           // 49
        migoAmount: bill.migoDetails?.amount ?? "",                           // 48

        billSendToPIMOMumbai: fmt(bill.pimoMumbai?.dateGiven),                // 61

        billReceivedAtPIMOMumbai: fmt(bill.pimoMumbai?.dateReceived),         // 62
        billReceivedAtPIMOMumbaiName: bill.pimoMumbai?.receivedBy || "",      // 63

        billSendToQSCertification: fmt(bill.qsMumbai?.dateGiven),             // 64
        billSendToQSCertificationName: bill.qsMumbai?.name || "",             // 65

        receivedFromQSWithCOP: fmt(bill.pimoMumbai?.dateReturnedFromQs),      // 66
        receivedFromQSWithCOPName: bill.pimoMumbai?.nameReturnedFromQs || "", // 67
        receivedFromQSWithCOPAmount: bill.copDetails?.amount ?? "",           // 43

        givenToITDept: fmt(bill.itDept?.dateGiven),                           // 68
        givenToITDeptName: bill.itDept?.name || "",                           // 69

        receivedBackFromITDept: fmt(bill.pimoMumbai?.dateReceivedFromIT),     // 75
        receivedBackFromITDeptName: bill.pimoMumbai?.nameReceivedFromIT || "", // 75A

        sesDateNo: bill.sesDetails?.date                                      // 74 / 72
          ? `${fmt(bill.sesDetails.date)} / ${bill.sesDetails.no || ""}`
          : "",
        sesDoneBy: bill.sesDetails?.doneBy || "",                             // 74A
        sesAmount: bill.sesDetails?.amount ?? "",                             // 73

        certifiedByProjectDirector: fmt(bill.pimoMumbai?.dateReturnedFromDirector), // 78

        submittedToAccountsDepartment: fmt(bill.accountsDept?.dateGiven),     // 80
        // Column 81, confirmed by the client on 26 September. Her original
        // sheet named 82A for this row as well as the one below.
        submittedToAccountsDepartmentName: bill.accountsDept?.givenBy || "",  // 81

        receivedInAccountsDepartment: fmt(bill.accountsDept?.dateReceived),   // 82
        receivedInAccountsDepartmentName: bill.accountsDept?.receivedBy || "", // 82A

        // Header block values her layout calls for that were never projected.
        status: bill.accountsDept?.status || "",                              // 93
        copAmt: bill.copDetails?.amount ?? "",                                // 43
        paymentAmt: bill.accountsDept?.paymentAmt ?? "",                      // 91
        paymentDate: fmt(bill.accountsDept?.paymentDate),                     // 89
        delay_for_receiving_invoice,
        no_of_Days_Site,
        no_of_Days_at_Mumbai,
        no_of_Days_at_AC,
        days_for_payment,
      };
    });

    return res.status(200).json(
      buildReportResponse(
        "Bill Journey",
        {
          dateRange:
            startDate && endDate
              ? { from: fmt(startDate), to: fmt(endDate) }
              : "All dates",
        },
        reportData,
        {
          summary: {
            totalCount: reportData.length,
            totalInvoiceAmount: Number(totalInvoiceAmount.toFixed(2)),
            averageProcessingDays: {
              siteProcessing:
                countSiteDays > 0
                  ? Number((totalSiteDays / countSiteDays).toFixed(1))
                  : 0,
              mumbaiProcessing:
                countMumbaiDays > 0
                  ? Number((totalMumbaiDays / countMumbaiDays).toFixed(2))
                  : 0,
              accountingProcessing:
                countAccountsDays > 0
                  ? Number((totalAccountsDays / countAccountsDays).toFixed(1))
                  : 0,
              totalPaymentDays:
                countPaymentDays > 0
                  ? Number((totalPaymentDays / countPaymentDays).toFixed(1))
                  : 0,
            },
          },
        }
      )
    );
  } catch (error) {
    return handleReportError(res, error, "bill journey report");
  }
};

// Legacy pending bills
export const getPendingBillsReport = async (req, res) => {
  try {
    const region = normalizeQueryList(req.query.region);
    const filter = {
      ...dateFilled(FIELDS.taxInvRecdAtSite),
      ...dateBlank(FIELDS.paymentDate),
    };
    applyOptionalDateRange(filter, FIELDS.taxInvRecdAtSite, req.query);
    applyRegionFilter(filter, region, req.user);

    const pendingBills = await Bill.find(filter).populate("vendor");

    const vendorGroups = {};
    pendingBills.forEach((bill) => {
      const name = bill.vendor?.vendorName || "";
      if (!vendorGroups[name]) vendorGroups[name] = [];
      vendorGroups[name].push(bill);
    });

    const sortedVendorNames = Object.keys(vendorGroups).sort();
    let reportData = [];
    let totalInvoiceAmount = 0;
    let totalCount = 0;

    sortedVendorNames.forEach((name) => {
      const vendorBills = vendorGroups[name];
      vendorBills.sort((a, b) => {
        const aSr = parseInt(a.srNo) || 0;
        const bSr = parseInt(b.srNo) || 0;
        return aSr - bSr;
      });

      let vendorSubtotal = 0;

      vendorBills.forEach((bill) => {
        const invoiceAmount = parseFloat(bill.taxInvAmt || 0);
        vendorSubtotal += isNaN(invoiceAmount) ? 0 : invoiceAmount;
        totalInvoiceAmount += isNaN(invoiceAmount) ? 0 : invoiceAmount;
        totalCount++;

        reportData.push({
          srNo: bill.srNo || "",
          projectDescription: bill.projectDescription || "",
          vendorName: bill.vendor?.vendorName || "",
          invoiceNo: bill.taxInvNo || "",
          invoiceDate: fmt(bill.taxInvDate),
          invoiceAmount: !isNaN(invoiceAmount)
            ? Number(invoiceAmount.toFixed(2))
            : 0,
          dateInvoiceReceivedAtSite: fmt(bill.taxInvRecdAtSite),
          dateBillReceivedAtPimoRrrm: fmt(bill.pimoMumbai?.dateReceived),
          poNo: bill.poNo || "",
        });
      });

      reportData.push({
        isSubtotal: true,
        vendorName: name,
        subtotalLabel: `Subtotal for ${name}:`,
        subtotalAmount: Number(vendorSubtotal.toFixed(2)),
        count: vendorBills.length,
      });
    });

    reportData.push({
      isGrandTotal: true,
      grandTotalLabel: "Grand Total:",
      grandTotalAmount: Number(totalInvoiceAmount.toFixed(2)),
      totalCount,
    });

    const vendorSubtotals = sortedVendorNames.map((name) => {
      const vendorBills = vendorGroups[name];
      const totalAmount = vendorBills.reduce((sum, bill) => {
        const amount = parseFloat(bill.taxInvAmt || 0);
        return sum + (isNaN(amount) ? 0 : amount);
      }, 0);
      return {
        vendorName: name,
        totalAmount: Number(totalAmount.toFixed(2)),
        count: vendorBills.length,
      };
    });

    return res.status(200).json(
      buildReportResponse(
        "Reports of pending bills with PIMO/SVKM site office/QS Mumbai office/QS site office",
        {
          logic: "invoice received at site but not yet completed/paid",
          sorting: ["vendorName", "srNo"],
        },
        reportData,
        {
          summary: {
            vendorSubtotals,
            totalCount,
            totalInvoiceAmount: Number(totalInvoiceAmount.toFixed(2)),
          },
        }
      )
    );
  } catch (error) {
    return handleReportError(res, error, "pending bills report");
  }
};

/**
 * Vendor Details report (observation N-08).
 *
 * "Create new report-Vendor details in which all details of vendors created
 *  should be available. Report functionality for download and print should be
 *  available. This report should be available in all teams"
 *
 * Every other report is a view over bills; this one is a view over the vendor
 * master, so it takes none of the bill filters. It is deliberately open to all
 * teams, which is why its route carries no role list - the vendor master is
 * already readable by any signed-in user for the create-bill lookup.
 *
 * Email IDs and phone numbers are arrays on the vendor; they are joined here
 * for the same reason the master download joins them, so a cell does not read
 * ["a@b.com"].
 */
export const getVendorDetailsReport = async (req, res) => {
  try {
    const search = normalizeQueryValue(req.query.vendorName);

    const filter = {};
    if (search) {
      filter.$or = [
        { vendorName: { $regex: escapeRegex(String(search).trim()), $options: "i" } },
        { vendorNo: Number.isNaN(Number(search)) ? undefined : Number(search) },
      ].filter((c) => Object.values(c)[0] !== undefined);
    }

    const vendors = await VendorMaster.find(filter)
      .sort({ vendorNo: 1 }) // as the master download is specified
      .populate("PANStatus", "name")
      .populate("complianceStatus", "compliance206AB");

    const list = (v) => (Array.isArray(v) ? v.filter(Boolean).join(", ") : v || "");

    const reportData = vendors.map((vendor, index) => ({
      count: index + 1,
      vendorNo: vendor.vendorNo ?? "",
      vendorName: vendor.vendorName || "",
      PAN: vendor.PAN || "",
      GSTNumber: vendor.GSTNumber || "",
      complianceStatus:
        vendor.complianceStatus?.compliance206AB || vendor.complianceStatus || "",
      PANStatus: vendor.PANStatus?.name || vendor.PANStatus || "",
      emailIds: list(vendor.emailIds),
      phoneNumbers: list(vendor.phoneNumbers),
      addl1: vendor.addl1 || "",
      addl2: vendor.addl2 || "",
      createdAt: fmt(vendor.createdAt),
    }));

    return res.status(200).json(
      buildReportResponse(
        "Vendor Details",
        { vendorName: search || "All vendors" },
        reportData,
        { summary: { totalVendors: reportData.length } }
      )
    );
  } catch (error) {
    return handleReportError(res, error, "vendor details report");
  }
};

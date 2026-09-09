import Bill from "../models/bill-model.js";
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
  sortUnpaidFirstThenAmountDesc,
  daysBetween,
} from "../utils/report-utils.js";

const handleReportError = (res, error, label) => {
  console.error(`Error generating ${label}:`, error);
  return res.status(500).json({
    success: false,
    message: "Error generating report",
    error: error.message,
  });
};

const fetchBills = (filter, sort) =>
  Bill.find(filter).sort(sort).populate("vendor").populate("natureOfWork");

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

    applyOptionalDateRange(filter, FIELDS.taxInvDate, req.query);
    applyRegionFilter(filter, region);
    await applyVendorFilter(filter, vendor || vendorName);

    const outstandingBills = await Bill.find(filter)
      .populate("vendor");

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
          srNo: bill.srNo,
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

    applyOptionalDateRange(filter, FIELDS.taxInvDate, req.query);
    applyRegionFilter(filter, region);
    await applyVendorFilter(filter, vendor || vendorName);

    const outstandingBills = await Bill.find(filter).populate("vendor");

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
    applyRegionFilter(filter, region);

    const bills = await fetchBills(filter, { taxInvRecdAtSite: -1 });
    const reportData = appendGrandTotalTaxAmount(
      bills.map((invoice) => ({
        srNo: invoice.srNo,
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
    applyRegionFilter(filter, region);

    const bills = await fetchBills(filter, { "pimoMumbai.dateReceived": -1 });
    const reportData = appendGrandTotalTaxAmount(
      bills.map((invoice) => ({
        srNo: invoice.srNo,
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
    const filter = {
      ...dateFilled(FIELDS.qsMeasureGiven),
      ...dateBlank(FIELDS.qsMeasureReturn),
      siteStatus: "hold",
    };
    applyOptionalDateRange(filter, FIELDS.qsMeasureGiven, req.query);
    applyRegionFilter(filter, region);

    const bills = await fetchBills(filter, { "qsMeasurementCheck.dateGiven": -1 });
    const reportData = appendGrandTotalTaxAmount(
      bills.map((invoice) => ({
        srNo: invoice.srNo,
        region: invoice.region,
        projectDescription: invoice.projectDescription,
        vendorNo: invoice.vendor?.vendorNo || "",
        vendorName: invoice.vendor?.vendorName || "",
        taxInvNo: invoice.taxInvNo,
        taxInvDate: fmt(invoice.taxInvDate),
        taxInvAmt: invoice.taxInvAmt ?? 0,
        dateGivenToQSMeasurement: fmt(invoice.qsMeasurementCheck?.dateGiven),
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
    applyRegionFilter(filter, region);

    const bills = await fetchBills(filter, { "qsCOP.dateGiven": -1 });
    const reportData = appendGrandTotalTaxAmount(
      bills.map((invoice) => ({
        srNo: invoice.srNo,
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
    const filter = {
      ...dateFilled(FIELDS.qsMumbaiGiven),
      ...dateBlank(FIELDS.qsMumbaiReturn),
      siteStatus: "hold",
    };
    applyOptionalDateRange(filter, FIELDS.qsMumbaiGiven, req.query);
    applyRegionFilter(filter, region);

    const bills = await fetchBills(filter, { "qsMumbai.dateGiven": -1 });
    const reportData = appendGrandTotalTaxAmount(
      bills.map((invoice) => ({
        srNo: invoice.srNo,
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
    applyRegionFilter(filter, region);

    const bills = await fetchBills(filter, { "pimoMumbai.dateGiven": -1 });
    const reportData = appendGrandTotalCourierStyle(
      bills.map((invoice) => ({
        srNo: invoice.srNo,
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
    applyRegionFilter(filter, region);

    const bills = await fetchBills(filter, { "vendorFinalInv.dateGiven": -1 });
    const reportData = appendGrandTotalCourierStyle(
      bills.map((invoice) => ({
        srNo: invoice.srNo,
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
    applyRegionFilter(filter, region);

    const bills = await fetchBills(filter, { "copDetails.dateReturned": -1 });
    const reportData = appendGrandTotalCourierStyle(
      bills.map((invoice) => ({
        srNo: invoice.srNo,
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
    applyRegionFilter(filter, region);

    const bills = await fetchBills(filter, { "pimoMumbai.dateReturnedFromQs": -1 });
    const reportData = appendGrandTotalCourierStyle(
      bills.map((invoice) => ({
        srNo: invoice.srNo,
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
    applyRegionFilter(filter, region);

    const bills = await fetchBills(filter, { "accountsDept.dateGiven": -1 });
    const reportData = appendGrandTotalCourierStyle(
      bills.map((invoice) => ({
        srNo: invoice.srNo,
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
    applyRegionFilter(filter, region);

    if (f110Identification) {
      filter["accountsDept.f110Identification"] = f110Identification;
    }

    const bills = await Bill.find(filter)
      .sort({ "accountsDept.paymentDate": -1 })
      .populate("vendor");

    const reportData = bills.map((invoice) => ({
      srNo: invoice.srNo,
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
    applyRegionFilter(filter, region);
    applyPaymentStatusFilter(filter, paymentStatus);
    await applyVendorFilter(filter, vendorName);
    applyTaxInvNoFilter(filter, taxInvNo);

    const bills = await Bill.find(filter).populate("vendor");
    const sorted = sortUnpaidFirstThenAmountDesc(bills);

    const rows = sorted.map((bill) => ({
      srNo: bill.srNo || "",
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
          logic: "Dt recd at Site filled",
          sorting: ["Unpaid first", "Tax Inv Amt highest to lowest"],
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
    applyRegionFilter(filter, region);
    applySrNoFilter(filter, srNo);
    await applyVendorFilter(filter, vendorName);
    applyTaxInvNoFilter(filter, taxInvNo);

    const bills = await Bill.find(filter).populate("vendor").populate("natureOfWork").populate("currency");
    const sorted = sortUnpaidFirstThenAmountDesc(bills);

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
        billReceivedAtSite: fmt(bill.taxInvRecdAtSite),
        receiptByProjectTeam: "",
        receivedForPO: fmt(bill.poDate),
        receiptOfPO: "",
        billSendForQualityCertification: fmt(bill.qualityEngineer?.dateGiven),
        billSendToQS: fmt(bill.qsMeasurementCheck?.dateGiven),
        certifiedByQS: fmt(bill.qsCOP?.dateGiven),
        certifiedByArch: fmt(bill.architect?.dateGiven),
        billSendToSiteEngineer: fmt(bill.siteIncharge?.dateGiven),
        receiptBySiteProjectDirector: "",
        receiptAtMPTP: "",
        certifiedByLPC: "",
        migoDateNo: bill.migoDetails?.date ? `${fmt(bill.migoDetails.date)} / ${bill.migoDetails.no || ''}` : "",
        billSendToPIMOMumbai: fmt(bill.pimoMumbai?.dateGiven),
        billReceivedAtPIMOMumbai: fmt(bill.pimoMumbai?.dateReceived),
        billSendToQSCertification: fmt(bill.qsMumbai?.dateGiven),
        receivedFromQSWithCOP: fmt(bill.pimoMumbai?.dateReturnedFromQs),
        givenToITDept: fmt(bill.itDept?.dateGiven),
        receivedBackFromITDept: fmt(bill.itDept?.dateReceived),
        sesDateNo: bill.sesDetails?.date ? `${fmt(bill.sesDetails.date)} / ${bill.sesDetails.no || ''}` : "",
        certifiedByProjectDirector: fmt(bill.approvalDetails?.directorApproval?.dateGiven),
        certifiedByProjectAdvisor: "",
        certifiedByMCMembers: "",
        submittedToAccountsDepartment: fmt(bill.accountsDept?.dateGiven),
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
    applyRegionFilter(filter, region);

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

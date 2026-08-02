import Bill from "../models/bill-model.js";

const roleLevelMap = {
  site_officer: 1,
  site_pimo: 3,
  director: 4,
  accounts: 5,
  qs_site: 2
};

export const getBillsAboveLevel = async (req, res) => {
  try {
    const { role } = req.params;

    if (!roleLevelMap[role]) {
      return res.status(400).json({
        success: false,
        message: "Invalid role provided",
      });
    }

    const { team_name } = req.query;

    let query;

    if (team_name) {
      if (team_name === "qs_site") {
        // QS Team - Forwarded Tab Logic
        // Include bills where "Dt ret-PIMO by QS Mumbai" is filled.
        query = { "pimoMumbai.dateReturnedFromQs": { $ne: null } };
      } else if (team_name === "trustees") {
        // Trustees Team - Forwarded Tab Logic
        // Include bills where "Date of Payment" is filled.
        query = { "accountsDept.paymentDate": { $ne: null } };
      }
    }

    // specific role based filtering if team_name is not provided
    if (!query) {
      switch (role) {
        case "site_officer":
          query = { "pimoMumbai.dateReceived": { $ne: null } };
          break;
        case "site_pimo":
          query = { "accountsDept.dateReceived": { $ne: null } };
          break;
        case "accounts":
          query = { "accountsDept.paymentDate": { $ne: null } };
          break;
        case "director":
          query = {
            siteStatus: { $in: ["hold", "accept"] },
            "accountsDept.paymentDate": { $ne: null },
            "accountsDept.status": "Paid"
          };
          break;
        case "qs_site":
          query = { "pimoMumbai.dateReturnedFromQs": { $ne: null } };
          break;
      }
    }

    const bills = await Bill.find(query)
      .populate("region")
      .populate("currency")
      .populate("natureOfWork")
      .populate({
        path: "vendor",
        populate: [
          { path: "PANStatus", model: "PanStatusMaster" },
          { path: "complianceStatus", model: "ComplianceMaster" },
        ],
      });

    const mappedBills = bills.map((bill) => {
      const billObj = bill.toObject();
      billObj.region = Array.isArray(billObj.region)
        ? billObj.region.map((r) => r?.name || r)
        : billObj.region;
      billObj.currency = billObj.currency?.currency || billObj.currency || null;
      billObj.natureOfWork =
        billObj.natureOfWork?.natureOfWork || billObj.natureOfWork || null;

      if (billObj.vendor && typeof billObj.vendor === "object") {
        billObj.vendorNo = billObj.vendor.vendorNo;
        billObj.vendorName = billObj.vendor.vendorName;
        billObj.GSTNumber = billObj.vendor.GSTNumber;
        billObj.compliance206AB =
          billObj.vendor.complianceStatus.compliance206AB;
        billObj.panStatus = billObj.vendor.PANStatus.name;
      }

      delete billObj.vendor;
      return billObj;
    });

    // Custom sorting in JS to truncate time, ensuring srNo tiebreaker works correctly for bills on the same day.
    mappedBills.sort((a, b) => {
      let aDateVal, bDateVal;
      
      const effectiveRole = team_name || role;

      if (effectiveRole === "site_officer") {
        aDateVal = a.pimoMumbai?.dateGiven;
        bDateVal = b.pimoMumbai?.dateGiven;
      } else if (effectiveRole === "qs_site") {
        aDateVal = a.pimoMumbai?.dateReturnedFromQs;
        bDateVal = b.pimoMumbai?.dateReturnedFromQs;
      } else if (effectiveRole === "site_pimo") {
        aDateVal = a.accountsDept?.dateGiven;
        bDateVal = b.accountsDept?.dateGiven;
      } else if (effectiveRole === "director" || effectiveRole === "trustees" || effectiveRole === "accounts") {
        aDateVal = a.accountsDept?.paymentDate;
        bDateVal = b.accountsDept?.paymentDate;
      } else if(effectiveRole === "accounts") {
        aDateVal = a.accountsDept?.paymentDate;
        bDateVal = b.accountsDept?.paymentDate;
      }

      // Helper to format date strictly to IST 'YYYY-MM-DD' so it matches what the user sees
      const getISTDateString = (dateVal) => {
        if (!dateVal) return "";
        const d = new Date(dateVal);
        if (isNaN(d.getTime())) return "";
        const localD = new Date(d.getTime() + 330 * 60000); // Add IST offset
        return localD.toISOString().split('T')[0];
      };

      const dateA = getISTDateString(aDateVal);
      const dateB = getISTDateString(bDateVal);

      if (dateA !== dateB) {
        if (!dateA) return 1;
        if (!dateB) return -1;
        return dateB.localeCompare(dateA); // Descending date
      }

      // Tiebreaker: srNo descending
      const aSrNo = a.srNo || "";
      const bSrNo = b.srNo || "";
      
      const aNum = Number(aSrNo);
      const bNum = Number(bSrNo);

      console.log(": aNum", aNum)
      console.log("bNum: ", bNum)

      if (!isNaN(aNum) && !isNaN(bNum) && aSrNo !== "" && bSrNo !== "") {
        return bNum - aNum;
      }
      
      return String(bSrNo).localeCompare(String(aSrNo));
    });

    return res.status(200).json({
      success: true,
      data: mappedBills,
    });
  } catch (error) {
    console.error("Error fetching bills above level:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch bills above level",
      error: error.message,
    });
  }
};

import Bill from "../models/bill-model.js";
import {
  buildAmountRangeQuery,
  buildDateRangeQuery,
} from "../utils/bill-helper.js";
import { flattenBill } from "../utils/bill-response.js";
import {
  tabFilter,
  homeAndIncomingFilter,
  sortValueFor,
} from "../utils/tab-predicates.js";
import { isAdminRole, primaryRole, teamLabelFor } from "../utils/roles.js";
import {
  duplicateBillQuery,
  DUPLICATE_BILL_MESSAGE,
} from "../utils/duplicate-bill.js";
import VendorMaster from "../models/vendor-master-model.js";
import RegionMaster from "../models/region-master-model.js";
import PanStatusMaster from "../models/pan-status-master-model.js";
import ComplianceMaster from "../models/compliance-master-model.js";
import NatureOfWorkMaster from "../models/nature-of-work-master-model.js";
import CurrencyMaster from "../models/currency-master-model.js";
import User from "../models/user-model.js";
import { extractFileKeyFromUrl, s3Delete, s3Upload } from "../utils/s3.js";
import mongoose from "mongoose";
import { nextSrNo, SR_NO_PATTERN } from "../utils/serial-number.js";

// Validation function for amount only (vendor validation is now handled via vendor reference)
const validateAmount = (amount) => {
  // Validate amount - should be a valid number if provided
  if (amount !== null && amount !== undefined && amount !== "") {
    const numAmount = Number(amount);
    if (isNaN(numAmount)) {
      return {
        valid: false,
        message: "Amount must be a valid number",
      };
    }
  }

  return {
    valid: true,
    message: "Valid",
  };
};

const getFinancialYearPrefix = (date) => {
  const d = date || new Date();
  let currentYear = d.getFullYear().toString().substr(-2);
  if (d.getMonth() >= 3) {
    return `${currentYear}`;
  } else {
    let prevYear = (parseInt(currentYear) - 1).toString().padStart(2, "0");
    return `${prevYear}`;
  }
};

const findBillAttachment = (attachments, fileKeyInput) => {
  const list = Array.isArray(attachments) ? attachments : [];
  if (!fileKeyInput) return null;

  const normalizedInput = extractFileKeyFromUrl(fileKeyInput);

  return list.find((attachment) => {
    const storedKey = attachment?.fileKey || "";
    const normalizedStoredKey = extractFileKeyFromUrl(storedKey);
    const storedUrlKey = extractFileKeyFromUrl(attachment?.fileUrl || "");

    return (
      storedKey === fileKeyInput ||
      attachment?.fileUrl === fileKeyInput ||
      (normalizedInput &&
        (normalizedStoredKey === normalizedInput ||
          storedUrlKey === normalizedInput))
    );
  });
};

const deleteAttachment = async (req, res) => {
  try {
    const billId = req.body.billId || req.body.id || req.body._id;
    const fileKeyInput =
      req.body.fileKey || req.body.fileUrl || req.body.key || req.body.url;

    if (!fileKeyInput || !billId) {
      return res.status(400).json({
        success: false,
        message: "fileKey (or fileUrl) and billId are required",
      });
    }

    if (!mongoose.Types.ObjectId.isValid(billId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid Bill ID format",
      });
    }

    const existingBill = await Bill.findById(billId);
    if (!existingBill) {
      return res.status(404).json({
        success: false,
        message: "Bill not found",
      });
    }

    const attachment = findBillAttachment(existingBill.attachments, fileKeyInput);
    if (!attachment?.fileKey) {
      return res.status(404).json({
        success: false,
        message: "Attachment not found in this bill",
      });
    }

    const updatedBill = await Bill.findByIdAndUpdate(
      billId,
      {
        $pull: {
          attachments: { fileKey: attachment.fileKey },
        },
      },
      { new: true }
    )
      .populate("vendor")
      .populate("currency")
      .populate("natureOfWork");

    if (!updatedBill) {
      return res.status(404).json({
        success: false,
        message: "Bill not found",
      });
    }

    let s3Warning = null;
    try {
      await s3Delete(attachment.fileKey);
    } catch (s3Error) {
      console.error("S3 delete failed after DB update:", s3Error);
      s3Warning =
        "Attachment removed from bill, but the file could not be deleted from storage.";
    }

    return res.status(200).json({
      success: true,
      message: "Attachment deleted successfully",
      ...(s3Warning ? { warning: s3Warning } : {}),
      bill: updatedBill,
      updatedBill,
    });
  } catch (error) {
    console.error("Error while deleting the attachment", error);
    return res.status(500).json({
      success: false,
      message: "Failed to delete the attachment",
      error: error.message,
    });
  }
};

const createBill = async (req, res) => {
  try {
    // Get role from query params
    const { role } = req.query;

    const typeofinv = req.body.typeOfInv;
    // Accept vendorNo or vendorName from request
    let vendorQuery = {};
    if (req.body.vendorNo) {
      vendorQuery.vendorNo = req.body.vendorNo;
    } else if (req.body.vendorName) {
      vendorQuery.vendorName = req.body.vendorName;
    }
    const vendorDoc = await VendorMaster.findOne(vendorQuery);
    if (!vendorDoc) {
      return res.status(404).json({ message: "Vendor not found" });
    }

    const attachments = [];
    if (req.files && req.files.length > 0) {

      for (const file of req.files) {
        try {
          const uploadResult = await s3Upload(file);
          attachments.push({
            fileName: uploadResult.fileName,
            fileKey: uploadResult.fileKey,
            fileUrl: uploadResult.url,
          });
        } catch (uploadError) {
          console.error(
            `Error uploading file ${file.originalname}:`,
            uploadError
          );
          return res.status(404).json({
            success: false,
            message: "Files could not be uploaded , please try again",
          });
        }
      }
    }

    // Create a base object with all fields initialized to null or empty objects
    // 8 digits: financial year + six-digit sequence (29.09, reply Q1). The
    // old code read the sequence with substring(4) on a two-digit prefix,
    // which only worked while the sequence stayed under 1,000.
    const newSrNo = await nextSrNo(Bill, req.body.billDate);

    // Build a bill object with all schema fields, setting null/default for missing fields
    const schemaFields = Object.keys(Bill.schema.paths);
    const billData = {};
    for (const field of schemaFields) {
      if (["_id", "__v", "createdAt", "updatedAt"].includes(field)) continue;
      // Skip vendor-related fields as they're derived from vendor reference
      if (
        [
          "vendorNo",
          "vendorName",
          "gstNumber",
          "panStatus",
          "compliance206AB",
        ].includes(field)
      )
        continue;
      if (field === "srNo") {
        billData.srNo = newSrNo;
        continue;
      }
      if (field.startsWith("workflowState.")) continue;
      if (field === "vendor") {
        billData.vendor = vendorDoc._id;
        continue;
      }
      // All vendor-related fields are now derived from vendor reference, skip direct assignment
      if (field === "complianceMaster" && req.body.complianceMaster) {
        let complianceDoc = null;
        if (typeof req.body.complianceMaster === "string") {
          complianceDoc = await ComplianceMaster.findOne({
            complianceStatus: req.body.complianceMaster,
          });
        } else if (
          typeof req.body.complianceMaster === "object" &&
          req.body.complianceMaster._id
        ) {
          complianceDoc = await ComplianceMaster.findById(
            req.body.complianceMaster._id
          );
        }
        billData.complianceMaster = complianceDoc ? complianceDoc._id : null;
        continue;
      }
      if (field === "natureOfWork" && req.body.natureOfWork) {
        let natureOfWorkDoc = null;
        if (typeof req.body.natureOfWork === "string") {
          natureOfWorkDoc = await NatureOfWorkMaster.findOne({
            natureOfWork: req.body.natureOfWork,
          });
        } else if (
          typeof req.body.natureOfWork === "object" &&
          req.body.natureOfWork._id
        ) {
          natureOfWorkDoc = await NatureOfWorkMaster.findById(
            req.body.natureOfWork._id
          );
        }
        billData.natureOfWork = natureOfWorkDoc ? natureOfWorkDoc._id : null;
        continue;
      }
      if (field === "currency" && req.body.currency) {
        let currencyDoc = null;
        if (typeof req.body.currency === "string") {
          currencyDoc = await CurrencyMaster.findOne({
            currency: req.body.currency,
          });
        } else if (
          typeof req.body.currency === "object" &&
          req.body.currency._id
        ) {
          currencyDoc = await CurrencyMaster.findById(req.body.currency._id);
        }
        billData.currency = currencyDoc ? currencyDoc._id : null;
        continue;
      }
      // compliance206AB field removed - now derived from vendor

      /*
       * Leave defaulted fields alone when the client did not send them.
       *
       * This loop walked every schema path and wrote an explicit null for
       * anything absent from the body - which OVERRIDES the schema default.
       * accountsDept.status is declared `default: "Unpaid"`, so every bill
       * created through the API was born with a null payment status instead,
       * which is why the column reads blank on so many rows (observation
       * N-28). Any other defaulted field was being silently nulled too.
       */
      if (req.body[field] === undefined && Bill.schema.paths[field]?.defaultValue !== undefined) {
        continue;
      }

      billData[field] = req.body[field] !== undefined ? req.body[field] : null;
    }

    // Resolve the natureOfWork name for the uniqueness check
    // The frontend sends `natureOfWork` (not `typeOfInv`), so we need to check both.
    // If typeOfInv is not provided, look up the natureOfWork name from the DB.
    let resolvedNatureOfWork = typeofinv || null;
    if (!resolvedNatureOfWork && billData.natureOfWork) {
      const nowDoc = await NatureOfWorkMaster.findById(billData.natureOfWork);
      if (nowDoc) {
        resolvedNatureOfWork = nowDoc.natureOfWork;
      }
    }

    // Vendor + bill no + bill date + bill amount, with five exempt natures and
    // no check at all while the bill number is blank. See utils/duplicate-bill.js
    // for the rule as the client wrote it.
    const uniqueQuery = duplicateBillQuery(
      {
        vendor: vendorDoc._id,
        taxInvNo: req.body.taxInvNo,
        taxInvDate: req.body.taxInvDate,
        taxInvAmt: req.body.taxInvAmt,
      },
      resolvedNatureOfWork
    );

    if (uniqueQuery) {
      const duplicate = await Bill.findOne(uniqueQuery);
      if (duplicate) {
        return res.status(400).json({
          success: false,
          message: DUPLICATE_BILL_MESSAGE,
        });
      }
    }

    let createdByName = req.user?.name || "Unknown User";
    if (req.user && (req.user.userId || req.user.id || req.user._id)) {
      const userId = req.user.userId || req.user.id || req.user._id;
      const userDoc = await User.findById(userId);
      if (userDoc && userDoc.name) {
        createdByName = userDoc.name;
      }
    }
    console.log("=== DEBUG CREATE BILL ===");
    console.log("REQ.USER:", req.user);
    console.log("RESOLVED NAME:", createdByName);

    const newBillData = {
      ...billData,
      createdBy: createdByName,
      createdByTeam: teamLabelFor(req.user?.role), // printed on the checklist
      workflowState: {
        currentState: "Site_Officer",
        history: [],
        lastUpdated: new Date(),
      },
      attachments,
      currentCount: role === "3" ? 3 : 1,
      maxCount: role === "3" ? 3 : 1,
      siteStatus: role === "3" ? "accept" : "hold",
    };
    const bill = new Bill(newBillData);
    await bill.save();
    bill.pimoMumbai.markReceived = role === "3" ? true : false;
    if (role === "3" && !bill.pimoMumbai.dateReceived) {
      // A bill raised at PIMO Mumbai never passes through the Incoming tab, so
      // col 62 would stay blank and the bill would be missing from the
      // "Invoices at PIMO" report and the PIMO home tab. Stamp it at creation.
      // (observations General #7, Report logics R105)
      bill.pimoMumbai.dateReceived = bill.createdAt || new Date();
    }
    await bill.save();
    // populate the vendor details , fix billId population during bill return
    const populatedBill = await Bill.findById(bill._id)
      .populate("currency")
      .populate("natureOfWork")
      .populate({
        path: "vendor",
        populate: [
          { path: "PANStatus", model: "PanStatusMaster" },
          { path: "complianceStatus", model: "ComplianceMaster" },
        ],
      });
    // Flatten vendor onto the bill so a checklist printed immediately after
    // saving can read vendorNo/vendorName/gstNumber/panStatus/compliance206AB,
    // as it can from the dashboard list endpoints. The nested `vendor` is kept
    // for clients that already read through it. (observations C-01, C-02)
    res
      .status(201)
      .json({ success: true, bill: flattenBill(populatedBill, { keepVendor: true }) });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

/**
 * The legacy list endpoint, GET /bill.
 *
 * It carried its own hand-written copy of the Home-tab rules for four teams,
 * inline and drifted: Site keyed on col 62 being blank (which also matches
 * bills already rejected or dispatched), Trustee ORed paymentDate against
 * accountsDept.status, and PIMO's copy had already diverged from the version in
 * getFilteredBills. Two teams (QS via team_name only, Accounts not at all) were
 * handled inconsistently between the team_name branch and the role fallback.
 *
 * Tab membership now comes from utils/tab-predicates.js, the single register
 * used by Home, Incoming and Forwarded, so this endpoint cannot drift again.
 */
const getBills = async (req, res) => {
  try {
    const { team_name } = req.query;

    // team_name wins when supplied; otherwise fall back to the caller's own
    // team. primaryRole() prefers a non-admin role so a user who also holds
    // admin still sees their own team's tab.
    const role = team_name || primaryRole(req.user.role);

    const filter = isAdminRole(req.user.role)
      ? {}
      : { region: { $in: req.user.region } };

    // An admin with no team_name, or an unrecognised team, sees everything in
    // scope rather than an arbitrary team's tab.
    Object.assign(filter, tabFilter(role, "home") || {});

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

    res.status(200).json(bills.map((bill) => flattenBill(bill)));
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

const receiveBillByPimoAccounts = async (req, res) => {
  try {
    const { billId, role, accept } = req.body;
    if (!billId) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields",
      });
    }

    const user = await User.findById(req.user.id);

    const now = new Date();

    let updateFields = {};
    if (!user.role.includes(role)) {
      return res.status(403).json({
        success: false,
        message: `User does not have the '${role}' role`,
      });
    }

    if (role)
      switch (role) {
        case "site_pimo":
          updateFields["pimoMumbai.dateReceived"] = now;
          updateFields["pimoMumbai.receivedBy"] = user.name;
          updateFields["pimoMumbai.markReceived"] = true;
          updateFields["siteStatus"] = "accept";
          break;

        case "accounts":
          updateFields["accountsDept.dateReceived"] = now;
          updateFields["accountsDept.receivedBy"] = user.name;
          updateFields["accountsDept.markReceived"] = true;
          break;

        default:
          return res.status(400).json({
            success: false,
            message: "Invalid role for receiving bill",
          });
      }

    const updatedBill = await Bill.findByIdAndUpdate(billId, updateFields, {
      new: true,
    });

    return res.status(200).json({
      success: true,
      message: "Bill received successfully",
      bill: updatedBill,
    });
  } catch (error) {
    console.error("Error receiving bill:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to receive bill",
      error: error.message,
    });
  }
};

const getBill = async (req, res) => {
  try {
    // Check for srNo in body or query, and if it is exactly 7 digits
    const srNo = req.body.srNo || req.query.srNo;
    let bill;

    let nbill = await Bill.findById(req.params.id);


    bill = await Bill.findById(req.params.id)
      .populate("currency")
      .populate("natureOfWork")
      .populate({
        path: "vendor",
        populate: [
          { path: "PANStatus", model: "PanStatusMaster" },
          { path: "complianceStatus", model: "ComplianceMaster" },
        ],
      });

    if (!bill) {
      return res.status(404).json({ message: "Bill not found" });
    }
    const billObj = bill.toObject();
    billObj.region = Array.isArray(billObj.region)
      ? billObj.region.map((r) => r?.name || r)
      : billObj.region;
    billObj.currency = billObj.currency?.currency || billObj.currency || null;
    billObj.natureOfWork =
      billObj.natureOfWork?.natureOfWork || billObj.natureOfWork || null;

    // Overwrite vendor fields directly from populated vendor
    if (billObj.vendor && typeof billObj.vendor === "object") {
      billObj.vendorNo = billObj.vendor.vendorNo;
      billObj.vendorName = billObj.vendor.vendorName;
      billObj.PAN = billObj.vendor.PAN;
      billObj.GSTNumber = billObj.vendor.GSTNumber;

      // Get compliance and PAN status from populated vendor references
      billObj.compliance206AB =
        billObj.vendor.complianceStatus?.compliance206AB ||
        billObj.vendor.complianceStatus ||
        null;
      billObj.panStatus =
        billObj.vendor.PANStatus?.name || billObj.vendor.PANStatus || null;
    }
    // Remove the vendor object itself
    delete billObj.vendor;
    res.status(200).json(billObj);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

const updateBill = async (req, res) => {
  try {
    // Find the existing bill
    const existingBill = await Bill.findById(req.params.id);
    if (!existingBill) {
      return res.status(404).json({ message: "Bill not found" });
    }

    // Create a merged object that preserves existing values when not in request body
    const updatedData = {};

    // Check if bill date is being changed, which may require regenerating the srNo
    let regenerateSerialNumber = false;
    if (req.body.billDate && existingBill.billDate) {
      const oldDate = new Date(existingBill.billDate);
      const newDate = new Date(req.body.billDate);

      // Get financial year prefixes for old and new dates
      const oldPrefix = getFinancialYearPrefix(oldDate);
      const newPrefix = getFinancialYearPrefix(newDate);

      // If financial year has changed, we need to regenerate the serial number
      if (oldPrefix !== newPrefix) {

        regenerateSerialNumber = true;
        // Set flag for pre-save hook to regenerate srNo
        existingBill._forceSerialNumberGeneration = true;
      }
    }

    // Get all fields from the bill schema
    const schemaFields = Object.keys(Bill.schema.paths);

    // For each field in the schema
    for (const field of schemaFields) {
      if (["_id", "createdAt", "updatedAt", "__v"].includes(field)) continue;
      if (field === "srNo" && regenerateSerialNumber) continue;
      // Skip vendor-related fields as they're derived from vendor reference
      if (
        [
          "vendorNo",
          "vendorName",
          "gstNumber",
          "panStatus",
          "compliance206AB",
        ].includes(field)
      )
        continue;
      if (field in req.body) {
        updatedData[field] = req.body[field];
      } else if (existingBill[field] !== undefined) {
        updatedData[field] = existingBill[field];
      }
    }

    // Special handling for nested objects and arrays to avoid overwrites
    // Handle workflowState specially to preserve history
    if (req.body.workflowState) {
      updatedData.workflowState = {
        ...existingBill.workflowState.toObject(),
        ...req.body.workflowState,
        history: existingBill.workflowState.history || [],
      };

      // If history is provided in the request, append it rather than replace
      if (
        req.body.workflowState.history &&
        Array.isArray(req.body.workflowState.history)
      ) {
        updatedData.workflowState.history = [
          ...existingBill.workflowState.history,
          ...req.body.workflowState.history,
        ];
      }
    }

    // Validate vendorNo and amount
    const check = validateVendorNoAndAmount(
      req.body.vendorNo !== undefined
        ? req.body.vendorNo
        : existingBill.vendorNo,
      req.body.amount !== undefined ? req.body.amount : existingBill.amount
    );
    if (!check.valid) {
      return res.status(400).json({ message: check.message });
    }

    // Set import mode to avoid validation errors for non-required fields
    existingBill.setImportMode(true);

    // Update the bill with the merged data
    const bill = await Bill.findByIdAndUpdate(req.params.id, updatedData, {
      new: true,
      runValidators: true,
    });

    res.status(200).json(bill);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

const deleteBill = async (req, res) => {
  try {
    const bill = await Bill.findByIdAndDelete(req.params.id);
    if (!bill) {
      return res.status(404).json({ message: "Bill not found" });
    }
    res.status(200).json({ message: "Bill deleted successfully" });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

// PATCH method for bills that preserves existing non-null values
const patchBill = async (req, res) => {
  try {
    // Find by serial number if provided
    if (req.body.srNo && !req.params.id) {
      const billBySrNo = await Bill.findOne({ srNo: req.body.srNo });
      if (billBySrNo) {
        // Set the id param and call this function again
        req.params.id = billBySrNo._id;
      } else {
        return res.status(404).json({
          success: false,
          message: "Bill with provided Serial Number not found",
        });
      }
    }

    // Find the existing bill
    const existingBill = await Bill.findById(req.params.id);
    if (!existingBill) {
      return res.status(404).json({
        success: false,
        message: "Bill not found",
      });
    }

    // Handle file attachments if present
    let attachments = existingBill.attachments || [];
    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        try {
          const uploadResult = await s3Upload(file);
          attachments.push({
            fileName: uploadResult.fileName,
            fileKey: uploadResult.fileKey,
            fileUrl: uploadResult.url,
          });
        } catch (uploadError) {
          console.error(
            `Error uploading file ${file.originalname}:`,
            uploadError
          );
          return res.status(404).json({
            success: false,
            message: "Files could not be uploaded, please try again",
          });
        }
      }
    }

    // Process QS-related fields and organize them properly
    organizeQSFields(req.body);

    // Parse stringified objects from FormData (e.g. pimoMumbai, accountsDept)
    for (const key of Object.keys(req.body)) {
      if (typeof req.body[key] === "string" && (req.body[key].startsWith("{") || req.body[key].startsWith("["))) {
        try {
          const parsed = JSON.parse(req.body[key]);
          if (parsed && typeof parsed === "object") {
            req.body[key] = parsed;
          }
        } catch (e) {
          // Not a valid JSON string, leave it as is
        }
      }
    }

    // Check if bill date is being changed, which may require regenerating the srNo
    let regenerateSerialNumber = false;
    if (req.body.billDate && existingBill.billDate) {
      const oldDate = new Date(existingBill.billDate);
      const newDate = new Date(req.body.billDate);

      // Get financial year prefixes for old and new dates
      const oldPrefix = getFinancialYearPrefix(oldDate);
      const newPrefix = getFinancialYearPrefix(newDate);

      // If financial year has changed, we need to regenerate the serial number
      if (oldPrefix !== newPrefix) {

        regenerateSerialNumber = true;
        // Set flag for pre-save hook to regenerate srNo
        existingBill._forceSerialNumberGeneration = true;

        // Store old serial number in srNoOld
        existingBill.srNoOld = existingBill.srNo;
      }
    }

    // Create an object to hold the updates, only including fields that are in the request
    const updates = {};

    // Get all fields from the bill schema
    const schemaFields = Object.keys(Bill.schema.paths);

    // Track fields that we've processed to avoid duplicates
    const processedFields = new Set();

    // check if vendorNo, vendor objectId, or vendorName is provided, considered all three cases, find the vendor and update updates.vendor field
    // able to update vendor details after creating the bill
    if (req.body.vendorNo || req.body.vendorName || req.body.vendor) {
      if (req.body.vendor && mongoose.Types.ObjectId.isValid(req.body.vendor)) {
        const vendorDoc = await VendorMaster.findById(req.body.vendor);
        if (!vendorDoc) {
          return res.status(404).json({
            success: false,
            message: "Vendor not found"
          });
        }
        updates.vendor = vendorDoc._id;
      } else if (req.body.vendorNo || req.body.vendorName) {
        let vendorQuery = {};
        if (req.body.vendorNo) {
          vendorQuery.vendorNo = req.body.vendorNo;
        } else if (req.body.vendorName) {
          vendorQuery.vendorName = req.body.vendorName;
        }
        const vendorDoc = await VendorMaster.findOne(vendorQuery);
        if (!vendorDoc) {
          return res.status(404).json({
            success: false,
            message: "Vendor not found"
          });
        }
        updates.vendor = vendorDoc._id;
      }
      processedFields.add("vendor");
      processedFields.add("vendorNo");
      processedFields.add("vendorName");
    }

    // Process top-level fields
    for (const field of Object.keys(req.body)) {
      // Skip fields we'll handle specially
      if (processedFields.has(field)) continue;
      if (["_id", "createdAt", "updatedAt", "__v"].includes(field)) continue;
      if (field === "srNo" && regenerateSerialNumber) continue;
      if (schemaFields.includes(field)) {
        let newValue = req.body[field];
        if (field === "natureOfWork" && req.body.natureOfWork) {
          let natureOfWorkDoc = null;
          if (typeof req.body.natureOfWork === "string") {
            natureOfWorkDoc = await NatureOfWorkMaster.findOne({
              natureOfWork: req.body.natureOfWork,
            });
          } else if (
            typeof req.body.natureOfWork === "object" &&
            req.body.natureOfWork._id
          ) {
            natureOfWorkDoc = await NatureOfWorkMaster.findById(
              req.body.natureOfWork._id
            );
          }
          newValue = natureOfWorkDoc ? natureOfWorkDoc._id : null;
        }
        if (field === "currency" && req.body.currency) {
          let currencyDoc = null;
          if (typeof req.body.currency === "string") {
            currencyDoc = await CurrencyMaster.findOne({
              currency: req.body.currency,
            });
          } else if (
            typeof req.body.currency === "object" &&
            req.body.currency._id
          ) {
            currencyDoc = await CurrencyMaster.findById(req.body.currency._id);
          }
          newValue = currencyDoc ? currencyDoc._id : null;
        }
        const currentValue = existingBill[field];
        if (
          currentValue === null ||
          currentValue === undefined ||
          newValue !== null
        ) {
          updates[field] = newValue;
        }
        processedFields.add(field);
      }
    }

    // Handle nested objects using DOT NOTATION to prevent erasing sibling fields
    // Instead of setting { qsInspection: { dateGiven: value } } which replaces the whole object,
    // we use { "qsInspection.dateGiven": value } which only updates that specific field
    //
    // A body may carry BOTH shapes for the same field: the grid's pencil edit
    // sends each edited cell as "accountsDept.f110Identification" and, when a
    // payment date is among them, also sends a whole `accountsDept` object
    // built from the row as it was FETCHED. This loop used to run second and
    // win, so every other Accounts field the user had just typed - F110, Hard
    // Copy, Accts Identification, both Remarks - was written back at its old
    // value the moment a payment date was saved alongside it (observations,
    // Pencil Edit R8-R12). An explicit dot-notation key is the more specific
    // instruction, so it now takes precedence.
    schemaFields.forEach((path) => {
      const pathParts = path.split(".");
      if (pathParts.length > 1) {
        const topLevel = pathParts[0];

        // Already set explicitly as "parent.child" - do not overwrite it.
        if (Object.prototype.hasOwnProperty.call(updates, path)) {
          processedFields.add(topLevel);
          return;
        }

        // If the top-level field is in the request body and is an object
        if (req.body[topLevel] && typeof req.body[topLevel] === "object") {
          // Get the nested field name (e.g., "dateGiven" or "name")
          const nestedField = pathParts.slice(1).join(".");
          const nestedValue = req.body[topLevel][nestedField];

          // If the nested field exists in the request
          if (nestedValue !== undefined) {
            // Get the current value
            let currentNestedValue;
            try {
              currentNestedValue = existingBill.get(path);
            } catch (e) {
              currentNestedValue = null;
            }

            // Only update if current is null or new is not null
            if (
              currentNestedValue === null ||
              currentNestedValue === undefined ||
              nestedValue !== null
            ) {
              // Use DOT NOTATION for the update to avoid erasing sibling fields
              updates[path] = nestedValue;
            }
          }

          processedFields.add(topLevel);
        }
      }
    });



    // Add attachments if any new files were uploaded
    if (req.files && req.files.length > 0) {
      updates.attachments = attachments;
    }

    // Validate amount only if being updated (vendor validation is done via vendor reference)
    if (req.body.amount !== undefined) {
      const amount = req.body.amount;
      if (amount !== null && amount !== undefined && amount !== "") {
        const numAmount = Number(amount);
        if (isNaN(numAmount)) {
          return res
            .status(400)
            .json({ message: "Amount must be a valid number" });
        }
      }
    }

    // Set import mode to avoid validation errors
    existingBill.setImportMode(true);

    // Only check uniqueness for certain types of invoices
    // Resolve the nature of work name: check typeOfInv first, then look up from the bill's natureOfWork reference
    let resolvedNatureOfWork = req.body.typeOfInv !== undefined ? req.body.typeOfInv : existingBill.typeOfInv;
    if (!resolvedNatureOfWork && existingBill.natureOfWork) {
      const nowDoc = await NatureOfWorkMaster.findById(existingBill.natureOfWork);
      if (nowDoc) {
        resolvedNatureOfWork = nowDoc.natureOfWork;
      }
    }
    // The same rule as createBill, from the same module, ignoring this bill.
    //
    // The old copy here keyed on a bill number that is blank on every Advance,
    // Direct FI and Hold/Ret row, so two such bills for one vendor matched each
    // other on null === null and the pencil edit refused to save anything at
    // all (observations T-03, T-06).
    const pick = (field) =>
      req.body[field] !== undefined ? req.body[field] : existingBill[field];

    const uniqueQuery = duplicateBillQuery(
      {
        vendor: updates.vendor !== undefined ? updates.vendor : existingBill.vendor,
        taxInvNo: pick("taxInvNo"),
        taxInvDate: pick("taxInvDate"),
        taxInvAmt: pick("taxInvAmt"),
      },
      resolvedNatureOfWork,
      { excludeId: existingBill._id }
    );

    if (uniqueQuery) {
      const duplicate = await Bill.findOne(uniqueQuery);
      if (duplicate) {
        return res.status(400).json({
          success: false,
          message: DUPLICATE_BILL_MESSAGE,
        });
      }
    }

    // Only update the bill if there are changes
    if (Object.keys(updates).length === 0) {
      return res.status(200).json({
        success: true,
        message: "No changes to apply",
        data: existingBill,
      });
    }



    // Apply the updates
    const updatedBill = await Bill.findByIdAndUpdate(
      existingBill._id,
      { $set: updates },
      { new: true, runValidators: false }
    )
      .populate("currency")
      .populate("natureOfWork")
      .populate({
        path: "vendor",
        populate: [
          { path: "PANStatus", model: "PanStatusMaster" },
          { path: "complianceStatus", model: "ComplianceMaster" },
        ],
      });

    // Format the response similar to getBill
    const billObj = updatedBill.toObject();
    billObj.region = Array.isArray(billObj.region)
      ? billObj.region.map((r) => r?.name || r)
      : billObj.region;
    billObj.currency = billObj.currency?.currency || billObj.currency || null;
    billObj.natureOfWork =
      billObj.natureOfWork?.natureOfWork || billObj.natureOfWork || null;

    // Overwrite vendor fields directly from populated vendor
    if (billObj.vendor && typeof billObj.vendor === "object") {
      billObj.vendorNo = billObj.vendor.vendorNo;
      billObj.vendorName = billObj.vendor.vendorName;
      billObj.PAN = billObj.vendor.PAN;
      billObj.GSTNumber = billObj.vendor.GSTNumber;

      // Get compliance and PAN status from populated vendor references
      billObj.compliance206AB =
        billObj.vendor.complianceStatus?.compliance206AB ||
        billObj.vendor.complianceStatus ||
        null;
      billObj.panStatus =
        billObj.vendor.PANStatus?.name || billObj.vendor.PANStatus || null;
    }
    // Remove the vendor object itself
    delete billObj.vendor;


    return res.status(200).json({
      success: true,
      message: "Bill updated successfully",
      data: billObj,
    });
  } catch (error) {
    console.error("Error patching bill:", error);
    return res.status(400).json({
      success: false,
      message: "Error updating bill",
      error: error.message,
    });
  }
};

// Helper function to handle QS-related fields and organize them properly
const organizeQSFields = (data) => {
  // Check if we have QS-related fields that need to be organized
  const qsFieldMappings = {
    "Dt given to QS for Inspection": {
      target: "qsInspection",
      property: "dateGiven",
    },
    "Name of QS": { target: "qsInspection", property: "name" },
    "Checked  by QS with Dt of Measurment": {
      target: "qsMeasurementCheck",
      property: "dateGiven",
    },
    "Given to vendor-Query/Final Inv": {
      target: "vendorFinalInv",
      property: "dateGiven",
    },
    "Dt given to QS for COP": { target: "qsCOP", property: "dateGiven" },
    "Name - QS": { target: "qsCOP", property: "name" },
  };

  // Initialize the target objects if not already present
  data.qsInspection = data.qsInspection || {};
  data.qsMeasurementCheck = data.qsMeasurementCheck || {};
  data.vendorFinalInv = data.vendorFinalInv || {};
  data.qsCOP = data.qsCOP || {};

  // Process each mapping
  Object.entries(qsFieldMappings).forEach(([sourceField, mapping]) => {
    if (sourceField in data) {
      // If the source field exists, map it to the target field
      if (!data[mapping.target]) {
        data[mapping.target] = {};
      }

      // Only set if value is not empty
      if (
        data[sourceField] !== null &&
        data[sourceField] !== undefined &&
        data[sourceField] !== ""
      ) {
        data[mapping.target][mapping.property] = data[sourceField];
      }

      // Remove the original field to avoid duplication
      delete data[sourceField];
    }
  });

  return data;
};

const filterBills = async (req, res) => {
  try {
    const {
      vendorName,
      vendorNo,
      projectDescription,
      gstNumber,
      startDate,
      endDate,
      status,
      minAmount,
      maxAmount,
      natureOfWork,
      region,
      currency,
      poCreated,
      compliance206AB,
      panStatus,
    } = req.query;

    const query = {};

    // For vendor-based filters, we need to find vendors first and then filter bills
    if (vendorName || vendorNo || gstNumber) {
      const vendorQuery = {};
      if (vendorName)
        vendorQuery.vendorName = { $regex: vendorName, $options: "i" };
      if (vendorNo) vendorQuery.vendorNo = { $regex: vendorNo, $options: "i" };
      if (gstNumber)
        vendorQuery.GSTNumber = { $regex: gstNumber, $options: "i" };

      const vendors = await VendorMaster.find(vendorQuery).select("_id");
      if (vendors.length > 0) {
        query.vendor = { $in: vendors.map((v) => v._id) };
      } else {
        // If no vendors match, return empty result
        return res.status(200).json({
          success: true,
          data: [],
          pagination: {
            currentPage: 1,
            totalPages: 0,
            totalItems: 0,
            itemsPerPage: parseInt(req.query.limit) || 10,
          },
        });
      }
    }

    // Text-based filters with case-insensitive partial matching for bill fields
    if (projectDescription)
      query.projectDescription = { $regex: projectDescription, $options: "i" };

    // Exact match filters - with case-insensitive region
    if (status) query.status = status;
    if (natureOfWork) query.natureOfWork = natureOfWork;

    // Improved region filtering with dynamic RegionMaster support
    if (region) {
      // Try to find the region in RegionMaster (case-insensitive)
      const regionDoc = await RegionMaster.findOne({
        name: { $regex: `^${region}$`, $options: "i" },
      });
      if (regionDoc) {
        query.region = { $in: [regionDoc.name] };
      } else {
        // If not found, fallback to partial match (case-insensitive)
        query.region = { $regex: region, $options: "i" };
      }
    }

    if (currency) query.currency = currency;
    if (poCreated) query.poCreated = poCreated;

    // For compliance206AB and panStatus, filter by vendor's compliance/PAN status
    if (compliance206AB || panStatus) {
      const vendorFilterQuery = {};
      if (compliance206AB) vendorFilterQuery.complianceStatus = compliance206AB;
      if (panStatus) vendorFilterQuery.PANStatus = panStatus;

      const vendorsWithStatus = await VendorMaster.find(
        vendorFilterQuery
      ).select("_id");
      if (vendorsWithStatus.length > 0) {
        if (query.vendor) {
          // If vendor filter already exists, intersect the results
          const existingVendorIds = query.vendor.$in || [query.vendor];
          const statusVendorIds = vendorsWithStatus.map((v) => v._id);
          query.vendor = {
            $in: existingVendorIds.filter((id) =>
              statusVendorIds.some((statusId) => statusId.equals(id))
            ),
          };
        } else {
          query.vendor = { $in: vendorsWithStatus.map((v) => v._id) };
        }
      } else {
        // If no vendors match the compliance/PAN status, return empty result
        return res.status(200).json({
          success: true,
          data: [],
          pagination: {
            currentPage: 1,
            totalPages: 0,
            totalItems: 0,
            itemsPerPage: parseInt(req.query.limit) || 10,
          },
        });
      }
    }

    // Date range filter
    if (startDate || endDate) {
      query.billDate = buildDateRangeQuery(startDate, endDate);
    }

    // Amount range filter
    if (minAmount || maxAmount) {
      query.amount = buildAmountRangeQuery(minAmount, maxAmount);
    }

    // Execute query with pagination
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    const role = req.query.role;
    let sortOptions = [["billDate", -1], ["srNo", -1]];

    if (role === "site_officer" || role === "director") {
      sortOptions = [["taxInvRecdAtSite", -1], ["srNo", -1]];
    } else if (role === "qs_site") {
      sortOptions = [["qsInspection.dateGiven", -1], ["srNo", -1]];
    } else if (role === "site_pimo") {
      sortOptions = [["pimoMumbai.dateReceived", -1], ["srNo", -1]];
    } else if (role === "accounts") {
      sortOptions = [["accountsDept.dateReceived", -1], ["srNo", -1]];
    }

    const bills = await Bill.find(query)
      .sort(sortOptions)
      .skip(skip)
      .limit(limit);

    // Get total count for pagination
    const total = await Bill.countDocuments(query);

    res.status(200).json({
      success: true,
      data: bills,
      pagination: {
        currentPage: page,
        totalPages: Math.ceil(total / limit),
        totalItems: total,
        itemsPerPage: limit,
      },
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: "Error filtering bills",
      error: error.message,
    });
  }
};

const getBillsStats = async (req, res) => {
  try {
    const stats = await Bill.aggregate([
      {
        $group: {
          _id: null,
          totalBills: { $sum: 1 },
          totalAmount: { $sum: "$amount" },
          avgAmount: { $avg: "$amount" },
          minAmount: { $min: "$amount" },
          maxAmount: { $max: "$amount" },
          statusCounts: {
            $push: {
              k: "$status",
              v: 1,
            },
          },
        },
      },
      {
        $project: {
          _id: 0,
          totalBills: 1,
          totalAmount: 1,
          avgAmount: 1,
          minAmount: 1,
          maxAmount: 1,
          statusCounts: {
            $arrayToObject: "$statusCounts",
          },
        },
      },
    ]);

    res.status(200).json({
      success: true,
      data: stats[0] || {},
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: "Error getting bills statistics",
      error: error.message,
    });
  }
};

// Method to get workflow history for a bill
export const getWorkflowHistory = async (req, res) => {
  try {
    const { id } = req.params;

    const bill = await Bill.findById(id);
    if (!bill) {
      return res.status(404).json({
        success: false,
        message: "Bill not found",
      });
    }

    return res.status(200).json({
      success: true,
      currentState: bill.workflowState.currentState,
      history: bill.workflowState.history,
      lastUpdated: bill.workflowState.lastUpdated,
    });
  } catch (error) {
    console.error("Workflow history retrieval error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to retrieve workflow history",
      error: error.message,
    });
  }
};

// Method to get all bills in a specific workflow state
export const getBillsByWorkflowState = async (req, res) => {
  try {
    const { state } = req.params;

    // Validate state is a valid workflow state
    const validStates = [
      "Site_Officer",
      "Site_PIMO",
      "QS_Site",
      "PIMO_Mumbai",
      "Directors",
      "Accounts",
      "Completed",
      "Rejected",
    ];

    if (!validStates.includes(state)) {
      return res.status(400).json({
        success: false,
        message: "Invalid workflow state",
        validStates,
      });
    }

    const bills = await Bill.find({
      "workflowState.currentState": state,
    })
      .select("srNo amount status workflowState.lastUpdated vendor")
      .populate("vendor", "vendorName vendorNo")
      .sort({ "workflowState.lastUpdated": -1 });

    // Map the results to include vendor fields at top level
    const mappedBills = bills.map((bill) => {
      const billObj = bill.toObject();
      if (billObj.vendor) {
        billObj.vendorName = billObj.vendor.vendorName;
        billObj.vendorNo = billObj.vendor.vendorNo;
        delete billObj.vendor;
      }
      return billObj;
    });

    return res.status(200).json({
      success: true,
      count: mappedBills.length,
      data: mappedBills,
    });
  } catch (error) {
    console.error("Bills by state retrieval error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to retrieve bills by workflow state",
      error: error.message,
    });
  }
};

// Get bill by srNo (8 digits; legacy 7-digit serials still resolve)
export const getBillBySrNo = async (req, res) => {
  try {
    const { srNo } = req.params;
    if (!SR_NO_PATTERN.test(srNo)) {
      return res
        .status(400)
        .json({ message: "Invalid srNo format. Must be 8 digits." });
    }
    const bill = await Bill.findOne({ srNo })
      .populate("currency")
      .populate("natureOfWork")
      .populate({
        path: "vendor",
        populate: [
          { path: "PANStatus", model: "PanStatusMaster" },
          { path: "complianceStatus", model: "ComplianceMaster" },
        ],
      }); // Populate vendor with nested PAN status and compliance
    if (!bill) {
      return res.status(404).json({ message: "Bill not found" });
    }
    const billObj = bill.toObject();
    billObj.region = Array.isArray(billObj.region)
      ? billObj.region.map((r) => r?.name || r)
      : billObj.region;
    billObj.currency = billObj.currency?.currency || billObj.currency || null;
    billObj.natureOfWork =
      billObj.natureOfWork?.natureOfWork || billObj.natureOfWork || null;

    // Overwrite vendor fields directly from populated vendor
    if (billObj.vendor && typeof billObj.vendor === "object") {
      billObj.vendorNo = billObj.vendor.vendorNo;
      billObj.vendorName = billObj.vendor.vendorName;
      billObj.PAN = billObj.vendor.PAN;
      billObj.GSTNumber = billObj.vendor.GSTNumber;

      // Get compliance and PAN status from populated vendor references
      billObj.compliance206AB =
        billObj.vendor.complianceStatus?.compliance206AB ||
        billObj.vendor.complianceStatus ||
        null;
      billObj.panStatus =
        billObj.vendor.PANStatus?.name || billObj.vendor.PANStatus || null;
    }
    // Remove the vendor object itself
    delete billObj.vendor;
    res.status(200).json(billObj);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

//PATCH: Edit payment instructions for a bill (Accounts / Trustees / Admin)
const editPaymentInstructions = async (req, res) => {
  try {
    const { id } = req.params;

    const {
      paymentInstructions,
      remarksForPayInstructions,
      f110Identification,
      paymentDate,
      paymentAmt,
      status,
    } = req.body;

    const bill = await Bill.findById(id);

    if (!bill) {
      return res
        .status(404)
        .json({ success: false, message: "Bill not found" });
    }

    if (paymentInstructions !== undefined)
      bill.accountsDept.paymentInstructions = paymentInstructions
    if (remarksForPayInstructions !== undefined)
      bill.accountsDept.remarksForPayInstructions = remarksForPayInstructions
    if (f110Identification !== undefined)
      bill.accountsDept.f110Identification = f110Identification;
    if (paymentDate !== undefined)
      bill.accountsDept.paymentDate = paymentDate;
    if (paymentAmt !== undefined)
      bill.accountsDept.paymentAmt = paymentAmt;
    // Payment Status is not taken from the request: the pre-save hook
    // derives it from the payment date (29.09, item 15). `status` is still
    // accepted in the body so older callers do not fail.
    void status;

    // const updatedBill = await Bill.findByIdAndUpdate(
    //   id,
    //   { $set: updateObj },
    //   { new: true, runValidators: true }
    // );

    await bill.save();

    if (!bill) {
      return res
        .status(404)
        .json({ success: false, message: "Bill not found" });
    }

    return res.status(200).json({
      success: true,
      message: "Payment instructions updated successfully",
      bill,
    });
  } catch (error) {
    console.error("Edit payment instructions error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to update payment instructions",
      error: error.message,
    });
  }
};

const notReceivedPimo = async (req, res) => {
  try {
    const { billId } = req.body;

    if (!billId) {
      return res.status(400).json({
        success: false,
        message: "Bill ID is required",
      });
    }

    const updateFields = {
      currentCount: 1,
      maxCount: 1,
      siteStatus: "hold",
      "pimoMumbai.dateGiven": null,
      "pimoMumbai.namePIMO": null || "",
      "pimoMumbai.dateReceived": null,
      "pimoMumbai.receivedBy": null || "",
      "pimoMumbai.markReceived": null || false,
    };

    const billFound = await Bill.findById(billId);
    if (!billFound) {
      return res.status(404).json({
        success: false,
        message: "Bill not found",
      });
    }

    updateFields.maxCount = Math.max(billFound.maxCount, 1);

    const bill = await Bill.findByIdAndUpdate(
      billId,
      { $set: updateFields },
      { new: true }
    );

    return res.status(200).json({
      success: true,
      message: "Bill put on hold by PIMO Mumbai",
      bill,
    });
  } catch (error) {
    console.error("Failed to perform the operation:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to perform the operation",
      error: error.message,
    });
  }
};

const notReceivedAccounts = async (req, res) => {
  try {
    const { billId } = req.body;

    if (!billId) {
      return res.status(400).json({
        success: false,
        message: "Bill ID is required",
      });
    }

    const updateFields = {
      currentCount: 3,
      maxCount: 3,
      "accountsDept.dateGiven": null,
      "accountsDept.dateReceived": null,
      "accountsDept.receivedBy": null || "",
      "accountsDept.markReceived": null || false,
    };

    const billFound = await Bill.findById(billId);
    if (!billFound) {
      return res.status(404).json({
        success: false,
        message: "Bill not found",
      });
    }

    updateFields.maxCount = Math.max(billFound.maxCount, 3);

    const bill = await Bill.findByIdAndUpdate(
      billId,
      { $set: updateFields },
      { new: true }
    );

    return res.status(200).json({
      success: true,
      message: "Bill put on hold by Accounts Department",
      bill,
    });
  } catch (error) {
    console.error("Failed to perform the operation:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to perform the operation",
      error: error.message,
    });
  }
};

const accountsPaymentReject = async (req, res) => {
  try {
    const { billId } = req.body;

    if (!billId) {
      return res.status(400).json({
        success: false,
        message: "Bill ID is required",
      });
    }

    const billFound = await Bill.findById(billId);
    if (!billFound) {
      return res.status(404).json({
        success: false,
        message: "Bill not found",
      });
    }

    /*
     * Rejecting a payment clears the payment date and NOTHING else.
     *
     * This used to send the bill all the way back to Site - clearing columns
     * 61, 62, 80 and 82, setting Status at Site to Hold and the count to 1 -
     * which was built to the earlier instruction (observations, Teamwise
     * Accounts-4). The client has since replaced that rule outright:
     *
     *   "if reject payment, then only date of payment should be removed (so
     *    payment status will become unpaid from paid) and the bill should move
     *    from forwarded tab to Home tab of Accounts Team. No other data should
     *    be removed. It should not go back to PIMO/Site Team. Status at Site
     *    should remain 'accept' only."
     *
     * Clearing column 89 alone is sufficient to move the bill: the Accounts
     * Forwarded tab is "payment date filled" and Accounts Home is "column 82
     * filled and payment date blank", so the bill crosses between them on this
     * one field. The status follows the date via the model's pre-save hook.
     */
    if (billFound.accountsDept) {
      billFound.accountsDept.paymentDate = null; // col 89 - the only change
    }

    await billFound.save();

    return res.status(200).json({
      success: true,
      message: "Payment rejected by Accounts Department",
      bill: billFound,
    });
  } catch (error) {
    console.error("Failed to perform the operation:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to perform the operation",
      error: error.message,
    });
  }
};

const getFilteredBills = async (req, res) => {
  const { role, tab } = req.query;
  try {
    // Tab membership lives in utils/tab-predicates.js, transcribed from the
    // spec matrix, so home/incoming/forwarded are defined in one place rather
    // than inline in each controller.
    const scope = tab ? tabFilter(role, tab) : homeAndIncomingFilter(role);
    if (tab && !scope) {
      return res.status(400).json({
        message: `Role '${role}' has no '${tab}' tab`,
      });
    }

    const filter = {
      region: { $in: req.user.region },
      ...(scope || {}),
    };

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

    // Sorted here rather than in mongo so that same-day bills fall back to
    // Sr no, and so QS can use its 35 -> 40 -> 64 fallback.
    const sortTab = tab || "home";
    mappedBills.sort((a, b) => {
      const av = sortValueFor(a, role, sortTab);
      const bv = sortValueFor(b, role, sortTab);
      const da = av ? new Date(av).setHours(0, 0, 0, 0) : 0;
      const db = bv ? new Date(bv).setHours(0, 0, 0, 0) : 0;
      if (da !== db) return db - da; // latest first
      return String(b.srNo || "").localeCompare(String(a.srNo || ""));
    });

    res.status(200).json(mappedBills);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

const deleteDate = async (req, res) => {
  try {
    const { teamName, sendTo, billId } = req.body;

    // Validate required fields
    if (!teamName || !sendTo || !billId) {
      return res.status(400).json({
        success: false,
        message: "teamName, sendTo, and billId are required",
      });
    }

    // Convert single billId to array for uniform processing
    const billIds = Array.isArray(billId) ? billId : [billId];

    // Validate all bill IDs
    for (const id of billIds) {
      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({
          success: false,
          message: `Invalid Bill ID format: ${id}`,
        });
      }
    }

    // What each send-to wrote, so removing a date can undo exactly that.
    //
    // Every entry mirrors one branch of changeBatchWorkflowState. Column
    // numbers are from the Field entry register. The date and its paired NAME
    // column are cleared together: send-to writes both, so leaving the name
    // behind left a bill claiming it had been handed to someone on no date.
    //
    // Three entries were previously pointing at the wrong column, which is why
    // "remove date is not implemented for 44A / 66" (observations D-02, D-03)
    // and why undoing a return to PIMO wiped col 64 instead:
    //
    //   Site Team / QS Measure     cleared qsMeasurementCheck.dateGiven,
    //                              but the send writes qsInspection (col 35)
    //   QS Team  / QS for Prov COP cleared col 66, but that send writes col 44A
    //   QS Team  / QS Mumbai to PIMO cleared col 64, but that send writes col 66
    const dateFieldMappings = {
      // Site Team - the sends in the site_team branch
      "Site Team": {
        "Quality Engineer": { fields: ["qualityEngineer.dateGiven", "qualityEngineer.name"] }, // 33, 34
        "QS Measure": { fields: ["qsInspection.dateGiven", "qsInspection.name"] }, // 35, 36
        "QS for Prov COP": { fields: ["qsCOP.dateGiven", "qsCOP.name"] }, // 40, 41
        "Site Engineer": { fields: ["siteEngineer.dateGiven", "siteEngineer.name"] }, // 51, 52
        "Site Architect": { fields: ["architect.dateGiven", "architect.name"] }, // 53, 54
        "Site Incharge": { fields: ["siteIncharge.dateGiven", "siteIncharge.name"] }, // 55, 56
        "MIGO Team": { fields: ["migoDetails.dateGiven", "migoDetails.name"] }, // 45, 45A
        "Migo done by": { fields: ["migoDetails.doneBy"] }, // 49
        "Ret Site aft MIGO": { fields: ["invReturnedToSite", "invReturnedToSiteName"] }, // 50, 50A
        "Site Dispatch": { fields: ["siteOfficeDispatch.dateGiven", "siteOfficeDispatch.name"] }, // 58, 59
        "PIMO Team": { fields: ["pimoMumbai.dateGiven", "pimoMumbai.namePIMO"] }, // 61, 61A
      },
      // QS Team - the sends in the qs_team branch
      "QS Team": {
        // "send to Site Team aft COP" - col 44A, which nothing could clear
        "QS for Prov COP": { fields: ["copDetails.dateReturned", "copDetails.nameReturned"] }, // 44A, 44B
        // "send to QS for measure" return leg
        "QS Measure": { fields: ["vendorFinalInv.dateGiven", "vendorFinalInv.name"] }, // 40, 39
        // "send to Ret to PIMO Team aft COP" - col 66, likewise
        "QS Mumbai to PIMO": {
          fields: ["pimoMumbai.dateReturnedFromQs", "pimoMumbai.nameReturnedFromQs"], // 66, 67
        },
        /*
         * "Mark as not received" for QS (observation N-18).
         *
         *   "If added values in following columns should be removed if
         *    selected: 64 Dt given-QS Mumbai for COP, 65 Name-QS Mumbai for
         *    COP. If value in above columns is empty then value in following
         *    column should be removed: 40 Dt Given-QS for Prov COP,
         *    41 Name-QS Prov COP"
         *
         * A step back through whichever receipt actually happened, which is
         * why the second pair is conditional on the first being empty. The
         * `fallbackFields` key is honoured in the update loop below.
         */
        "Mark as not received": {
          fields: ["qsMumbai.dateGiven", "qsMumbai.name"], // 64, 65
          fallbackFields: ["qsCOP.dateGiven", "qsCOP.name"], // 40, 41
        },
      },
      // PIMO Team - the sends in the pimo_mumbai branch
      "PIMO Team": {
        "QS Mumbai": { fields: ["qsMumbai.dateGiven", "qsMumbai.name"] }, // 64, 65
        "IT Team": { fields: ["itDept.dateGiven", "itDept.name"] }, // 68, 69
        "SES Team": { fields: ["sesDetails.dateGiven", "sesDetails.name"] }, // 70, 71
        "Ret by IT Team": {
          fields: ["pimoMumbai.dateReceivedFromIT", "pimoMumbai.nameReceivedFromIT"], // 75, 75A
        },
        "Ret by SES Team": {
          fields: ["pimoMumbai.dateReturnedFromSES", "pimoMumbai.nameReturnedFromSES"], // 76, 76A
        },
        "Director/Advisor/Trustee": {
          fields: ["approvalDetails.directorApproval.dateGiven"], // 77
        },
        // The label as renamed on 1.10 (item 12); the old one is kept so a
        // browser still running the previous build keeps working.
        "Trustee, Advisor & Director": {
          fields: ["approvalDetails.directorApproval.dateGiven"], // 77
        },
        "Accounts Team": { fields: ["accountsDept.dateGiven", "accountsDept.givenBy"] }, // 80, 81
        "Mark as not received": {
          fields: ["pimoMumbai.dateGiven", "pimoMumbai.dateReceived", "pimoMumbai.receivedBy"], // 61, 62, 63
          extraUpdates: { "pimoMumbai.markReceived": false },
        },
      },
      /*
       * Trustee Team (29.09, item 11).
       *
       * The Trustee had no Unsend at all. Their one send - "Return to PIMO
       * Team" - stamps column 78, so that is what Unsend clears.
       */
      "Trustee Team": {
        "PIMO Team": { fields: ["pimoMumbai.dateReturnedFromDirector"] }, // 78
        "Returned to PIMO": { fields: ["pimoMumbai.dateReturnedFromDirector"] }, // 78
      },
      // Accounts Team
      "Accounts Team": {
        "Booking & Checking": { fields: ["accountsDept.invBookingChecking"] }, // 83
        "Mark as not received": {
          fields: ["accountsDept.dateGiven", "accountsDept.dateReceived", "accountsDept.receivedBy"], // 80, 82, 82A
          extraUpdates: { "accountsDept.markReceived": false },
        },
      },
    };

    // Check if the teamName exists in our mappings
    if (!dateFieldMappings[teamName]) {
      return res.status(400).json({
        success: false,
        message: `Invalid teamName: ${teamName}. Valid options are: ${Object.keys(dateFieldMappings).join(", ")}`,
      });
    }

    // Check if the sendTo exists for the given teamName
    if (!dateFieldMappings[teamName][sendTo]) {
      return res.status(400).json({
        success: false,
        message: `Invalid sendTo: ${sendTo} for team: ${teamName}. Valid options are: ${Object.keys(dateFieldMappings[teamName]).join(", ")}`,
      });
    }

    const mapping = dateFieldMappings[teamName][sendTo];

    const updateFields = {};
    for (const field of mapping.fields) updateFields[field] = null;

    // Boolean flags such as markReceived, which are cleared to false not null.
    if (mapping.extraUpdates) {
      Object.assign(updateFields, mapping.extraUpdates);
    }

    // Check if all bills exist
    const existingBills = await Bill.find({ _id: { $in: billIds } });
    if (existingBills.length !== billIds.length) {
      const foundIds = existingBills.map(b => b._id.toString());
      const missingIds = billIds.filter(id => !foundIds.includes(id));
      return res.status(404).json({
        success: false,
        message: `Some bills not found: ${missingIds.join(", ")}`,
      });
    }

    /*
     * Apply it.
     *
     * Most mappings clear the same fields on every bill, which is one
     * updateMany. A mapping with `fallbackFields` cannot be: it clears the
     * primary pair only when that pair holds something, and otherwise steps
     * back to the earlier pair (observation N-18). That decision is per bill,
     * so those are updated individually.
     */
    let result;
    if (mapping.fallbackFields) {
      const read = (bill, path) =>
        path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), bill);

      const primaryHasValue = (bill) => mapping.fields.some((f) => read(bill, f));

      let modified = 0;
      for (const bill of existingBills) {
        const fields = primaryHasValue(bill) ? mapping.fields : mapping.fallbackFields;
        const set = {};
        for (const field of fields) set[field] = null;
        if (mapping.extraUpdates) Object.assign(set, mapping.extraUpdates);

        const one = await Bill.updateOne({ _id: bill._id }, { $set: set });
        modified += one.modifiedCount;
      }
      result = { modifiedCount: modified };
    } else {
      result = await Bill.updateMany(
        { _id: { $in: billIds } },
        { $set: updateFields }
      );
    }

    return res.status(200).json({
      success: true,
      message: `Successfully cleared dates for ${result.modifiedCount} bill(s)`,
      modifiedCount: result.modifiedCount,
    });
  } catch (error) {
    console.error("Error in deleteDate:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to delete date",
      error: error.message,
    });
  }
};

export default {
  createBill,
  getBill,
  getBills,
  updateBill,
  deleteBill,
  filterBills,
  getBillsStats,
  // advanceWorkflow,
  // revertWorkflow,
  // rejectBill,
  getWorkflowHistory,
  getBillsByWorkflowState,
  // recoverRejectedBill,
  patchBill,
  // regenerateAllSerialNumbers,
  // changeWorkflowState,
  receiveBillByPimoAccounts,
  getBillBySrNo,
  editPaymentInstructions,
  deleteAttachment,
  notReceivedPimo,
  notReceivedAccounts,
  accountsPaymentReject,
  getFilteredBills,
  deleteDate,
};
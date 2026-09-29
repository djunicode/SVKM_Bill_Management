


import ExcelJS from 'exceljs';
import Bill from '../models/bill-model.js';
import CurrencyMaster from '../models/currency-master-model.js';
import PanStatusMaster from '../models/pan-status-master-model.js';
import ComplianceMaster from '../models/compliance-master-model.js';
import RegionMaster from '../models/region-master-model.js';
import { headerMapping } from './headerMap.js'; // Import centralized header mapping

/**
 * Header matching was an exact string lookup, so "Payment Instructions" missed
 * "Payment instructions" by one character and the column was discarded before
 * any validation ran. Normalising on case, whitespace and punctuation removes
 * that whole class of failure.
 */
const normaliseHeader = (h) =>
  String(h).toLowerCase().replace(/[\s._\-/]+/g, "").trim();

const NORMALISED_HEADERS = Object.entries(headerMapping).reduce((acc, [k, v]) => {
  acc[normaliseHeader(k)] = v;
  return acc;
}, {});

export const lookupHeader = (header) =>
  headerMapping[header] ||
  headerMapping[String(header).trim()] ||
  NORMALISED_HEADERS[normaliseHeader(header)] ||
  null;
import { Admin } from 'mongodb';

/**
 * Reads an Excel file and extracts each data row (for debugging purposes)
 * @param {string} filePath - Path to the Excel file
 * @returns {Promise<void>}
 * @throws {Error} If no worksheet is found
 */
export async function extractPatchRowsFromExcel(filePath) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const worksheet = workbook.getWorksheet(1);
  if (!worksheet) throw new Error('No worksheet found');

  let headerRowIdx = 1;
  let headers = [];
  worksheet.getRow(headerRowIdx).eachCell({ includeEmpty: false }, cell => {
    headers.push(cell.value?.toString().trim());
  });

  if (headers[0]?.toLowerCase().includes('report generated')) {
    headerRowIdx++;
    headers = [];
    worksheet.getRow(headerRowIdx).eachCell({ includeEmpty: false }, cell => {
      headers.push(cell.value?.toString().trim());
    });
  }

  for (let rowNumber = headerRowIdx + 1; rowNumber <= worksheet.rowCount; rowNumber++) {
    const row = worksheet.getRow(rowNumber);
    if (!row.hasValues) continue;
    const rowData = {};
    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      const header = headers[colNumber - 1];
      rowData[header] = cell.value;
    });
  }
}

// Use centralized header mapping from headerMap.js
const headerToDbField = headerMapping;

// Identify all Date fields from the Mongoose schema for robust parsing
const dateFieldsSet = new Set();
try {
  if (Bill && Bill.schema && Bill.schema.paths) {
    Object.keys(Bill.schema.paths).forEach(path => {
      if (Bill.schema.paths[path].instance === 'Date') {
        dateFieldsSet.add(path);
      }
    });
  }
} catch (err) {
  console.error('[Schema] Error loading date fields:', err);
}

/**
 * Checks if a value is filled (not undefined, null, or empty string)
 * @param {*} val - Value to check
 * @returns {boolean} True if value is filled
 */
function isFilled(val) {
  return val !== undefined && val !== null && val !== '';
}

/**
 * Parses a date string if the field is a date field
 * @param {string} field - Field name
 * @param {*} value - Value to parse
 * @returns {Date|*} Parsed date or original value
 */
function parseDateIfNeeded(field, value) {
  if (!value) return value;

  // If it's already a Date object, return it
  if (value instanceof Date) {
    return value;
  }

  if (typeof value !== 'string') return value;

  const trimmedValue = value.trim();

  // Regex for DD.MM.YYYY or DD-MM-YYYY (Full Date)
  const fullDateMatch = trimmedValue.match(/^(\d{1,2})[-./](\d{1,2})[-./](\d{2,4})$/);
  if (fullDateMatch) {
    let [_, day, month, year] = fullDateMatch;
    if (year.length === 2) {
      year = `20${year}`;
    }
    return new Date(`${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`);
  }

  // Regex for DD.MM or DD-MM (Short Date, assume current year)
  const shortDateMatch = trimmedValue.match(/^(\d{1,2})[-./](\d{1,2})$/);
  if (shortDateMatch) {
    let [_, day, month] = shortDateMatch;
    const currentYear = new Date().getFullYear();
    return new Date(`${currentYear}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`);
  }

  // Fallback to standard parsing
  if (!isNaN(Date.parse(trimmedValue))) {
    return new Date(trimmedValue);
  }

  return value;
}

/**
 * Validates and parses hardCopy field value
 * @param {*} value - Value to validate
 * @returns {string|null} 'YES' or 'NO' if valid, null otherwise
 */
function validateHardCopyField(value) {
  if (!value) return null;
  const hardCopyValue = String(value).trim().toUpperCase();
  if (hardCopyValue !== 'YES' && hardCopyValue !== 'NO') {
    return null;
  }
  return hardCopyValue;
}

/**
 * Parses a number string if the field is a number field
 * @param {string} field - Field name
 * @param {*} value - Value to parse
 * @returns {number|*} Parsed number or original value
 */
function parseNumberIfNeeded(field, value) {
  const numberFields = ['poAmt', 'taxInvAmt'];
  if (numberFields.includes(field) && typeof value === 'string') {
    const cleaned = value.replace(/,/g, '');
    const num = parseFloat(cleaned);
    return isNaN(num) ? value : num;
  }
  return value;
}

/**
 * Parses field value based on field type (date, number, or text)
 * @param {string} dbField - Database field name
 * @param {*} value - Value to parse
 * @returns {*} Parsed value
 */
function parseFieldValue(dbField, value) {
  let parsedValue = value;

  if (dbField === 'accountsDept.hardCopy') {
    return validateHardCopyField(value);
  }

  // Use Schema-based date detection
  if (dateFieldsSet.has(dbField)) {
    parsedValue = parseDateIfNeeded(dbField, value);
  }

  if (dbField.includes('.amount') || dbField.includes('Amt')) {
    parsedValue = parseNumberIfNeeded(dbField, value);
  }

  return parsedValue;
}

/**
 * Maps reference field values to their ObjectIds from master collections
 * @param {string} field - Field name
 * @param {*} value - Value to map
 * @returns {Promise<string|undefined>} ObjectId as string or undefined
 */
const referenceLookupCache = {
  currency: null,
  panStatus: null,
  compliance206AB: null,
  region: null
};

function buildLookupMap(collection, extractKey, extractValue) {
  const map = new Map();
  collection.forEach(doc => {
    const key = extractKey(doc);
    if (!key) return;
    map.set(key.toString().trim().toLowerCase(), extractValue(doc));
  });
  return map;
}

async function getReferenceLookup(field) {
  if (referenceLookupCache[field]) {
    return referenceLookupCache[field];
  }

  switch (field) {
    case 'currency': {
      const docs = await CurrencyMaster.find().lean();
      referenceLookupCache.currency = buildLookupMap(docs, doc => doc.currency, doc => doc._id.toString());
      break;
    }
    case 'panStatus': {
      const docs = await PanStatusMaster.find().lean();
      referenceLookupCache.panStatus = buildLookupMap(docs, doc => doc.panStatus || doc.name, doc => doc._id.toString());
      break;
    }
    case 'compliance206AB': {
      const docs = await ComplianceMaster.find().lean();
      referenceLookupCache.compliance206AB = buildLookupMap(docs, doc => doc.compliance206AB, doc => doc._id.toString());
      break;
    }
    case 'region': {
      const docs = await RegionMaster.find().lean();
      referenceLookupCache.region = buildLookupMap(docs, doc => doc.name, doc => doc.name);
      break;
    }
    default:
      referenceLookupCache[field] = new Map();
  }

  return referenceLookupCache[field] || new Map();
}

async function mapReferenceIfNeeded(field, value) {
  if (value === undefined || value === null) {
    return value;
  }

  const stringValue = value.toString().trim();
  if (!stringValue) {
    return undefined;
  }

  const lookup = await getReferenceLookup(field);
  if (!lookup.size) {
    return undefined;
  }

  const normalized = stringValue.toLowerCase();
  if (lookup.has(normalized)) {
    return lookup.get(normalized);
  }

  for (const [candidate, mappedValue] of lookup.entries()) {
    if (candidate.includes(normalized) || normalized.includes(candidate)) {
      return mappedValue;
    }
  }

  return undefined;
}

/**
 * Team field restrictions defining which fields each team can update
 */
const teamFieldRestrictions = {
  "QS Team": [
    "copDetails.date",
    "copDetails.amount"
  ],
  "Site Team": [
    "migoDetails.no",
    "migoDetails.date",
    "migoDetails.amount",
    "migoDetails.doneBy"
  ],
  "PIMO & MIGO/SES Team": [
    "migoDetails.no",
    "migoDetails.date",
    "migoDetails.amount",
    "migoDetails.doneBy",

    "sesDetails.no",
    "sesDetails.amount",
    "sesDetails.date",
    "sesDetails.doneBy",

    "pimoMumbai.dateReturnedFromDirector"
  ],
  "Accounts Team": [
    "accountsDept.f110Identification",
    "accountsDept.paymentDate",
    "accountsDept.hardCopy",
    "accountsDept.paymentInstructions",
    "accountsDept.remarksForPayInstructions",
    "accountsDept.accountsIdentification",
    "accountsDept.paymentAmt",
    "miroDetails.number",
    "miroDetails.date",
    "miroDetails.amount"
  ]
};

/**
 * All allowed nested fields for patch operations
 */
const allAllowedFields = [
  "copDetails.date",
  "copDetails.amount",
  "migoDetails.no",
  "migoDetails.date",
  "migoDetails.amount",
  "migoDetails.doneBy",
  "sesDetails.no",
  "sesDetails.amount",
  "sesDetails.date",
  "sesDetails.doneBy",
  "pimoMumbai.dateReturnedFromDirector",
  "accountsDept.f110Identification",
  "accountsDept.paymentDate",
  "accountsDept.hardCopy",
  "accountsDept.paymentInstructions",
  "accountsDept.remarksForPayInstructions",
  "accountsDept.accountsIdentification",
  "accountsDept.paymentAmt",
  "miroDetails.number",
  "miroDetails.date",
  "miroDetails.amount"
];

/**
 * Maps role names to team names
 */
const roleToTeam = {
  'qs_site': 'QS Team',
  'qs_team': 'QS Team',
  'qs_mumbai': 'QS Team',
  'site_officer': 'Site Team',
  'site_engineer': 'Site Team',
  'site_incharge': 'Site Team',
  'site_architect': 'Site Team',
  'pimo_mumbai': 'PIMO & MIGO/SES Team',
  'site_pimo': 'PIMO & MIGO/SES Team',
  'accounts': 'Accounts Team',
};

/**
 * Reads workbook and finds the headers row (skipping report header if present)
 * @param {Object} workbook - ExcelJS workbook object
 * @returns {Object} Object containing worksheet, headers, and headerRowIdx
 * @throws {Error} If no worksheet is found
 */
function readWorkbookAndHeaders(workbook) {
  const worksheet = workbook.getWorksheet(1);
  if (!worksheet) throw new Error('No worksheet found');

  let headerRowIdx = 1;
  let headers = [];
  worksheet.getRow(headerRowIdx).eachCell({ includeEmpty: false }, cell => {
    headers.push(cell.value?.toString().trim());
  });

  if (headers[0]?.toLowerCase().includes('report generated')) {
    headerRowIdx++;
    headers = [];
    worksheet.getRow(headerRowIdx).eachCell({ includeEmpty: false }, cell => {
      headers.push(cell.value?.toString().trim());
    });
  }

  return { worksheet, headers, headerRowIdx };
}

/**
 * Maps team name to actual team using roleToTeam mapping
 * @param {string} teamName - Original team or role name
 * @returns {string|null} Mapped team name or null
 */
function mapTeamName(teamName) {
  if (!teamName) return null;
  return roleToTeam[teamName] || teamName;
}

/**
 * Gets the list of allowed fields for a specific team
 * @param {string} teamName - Team or role name
 * @returns {Array<string>} Array of allowed field names
 */
function getAllowedFieldsForTeam(teamName) {
  const mappedTeam = mapTeamName(teamName);
  const allowedFields = mappedTeam && teamFieldRestrictions[mappedTeam]
    ? teamFieldRestrictions[mappedTeam]
    : [];

  return allowedFields;
}

/**
 * Extracts row data from an Excel row
 * @param {Object} row - ExcelJS row object
 * @param {Array<string>} headers - Array of header names
 * @returns {Object} Row data as key-value pairs
 */
function extractPatchRowData(row, headers) {
  const rowData = {};
  row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
    const header = headers[colNumber - 1];
    rowData[header] = cell.value;
  });
  return rowData;
}

/**
 * Checks if field update is allowed based on team restrictions
 * @param {string} dbField - Database field name
 * @param {Array<string>} allowedFields - Array of allowed field names for the team
 * @returns {boolean} True if field is allowed
 */
function isFieldAllowed(dbField, allowedFields) {
  return allAllowedFields.includes(dbField) && allowedFields.includes(dbField);
}

/**
 * Initializes update object with existing bill data
 * @param {Object} billData - Existing bill document
 * @returns {Object} Update object with nested structures initialized
 */
function initializeUpdateObject(billData) {
  return {
    accountsDept: billData.accountsDept,
    miroDetails: billData.miroDetails,
    migoDetails: billData.migoDetails,
    sesDetails: billData.sesDetails,
    copDetails: billData.copDetails,
    pimoMumbai: billData.pimoMumbai
  };
}

/**
 * Sets a nested field value in the update object
 * @param {Object} updateObj - Update object to modify
 * @param {string} dbField - Database field name (may contain dots for nesting)
 * @param {*} value - Value to set
 */
function setNestedField(updateObj, dbField, value) {
  const fieldParts = dbField.split('.');
  if (fieldParts.length === 2) {
    if (!updateObj[fieldParts[0]]) {
      updateObj[fieldParts[0]] = {};
    }
    updateObj[fieldParts[0]][fieldParts[1]] = value;
  } else {
    updateObj[dbField] = value;
  }
}

/**
 * Applies business rules to the update object (e.g., auto-set status when payment date is set)
 * @param {Object} updateObj - Update object to apply rules to
 */
function applyBusinessRules(updateObj) {
  if (updateObj.accountsDept && updateObj.accountsDept.paymentDate) {
    updateObj.accountsDept.status = 'Paid';
  }
}


// helper fuction to get bills for particular team
/**
 * The Accounts columns that may be written even once a bill has been paid and
 * has moved to the Forwarded tab (observation S-26).
 */
export const ACCOUNTS_FORWARDED_COLUMNS = [
  "accountsDept.paymentInstructions", // Payment Instructions
  "accountsDept.f110Identification",  // F110
  "accountsDept.paymentDate",         // Dt of Payment
  "accountsDept.hardCopy",            // Hard Copy
  "accountsDept.accountsIdentification", // Accts Identification
  "accountsDept.paymentAmt",          // Payment Amt
];

export function getPatchValidationFilter(role, user) {
  /*
   * Region is part of the gate, alongside team, tab and column.
   *
   * "At present team, home tab and columns are checked for allowing upload.
   *  Can the region alloted in user master be checked as well?"  (N-15)
   *
   * Without it, a user could mass-update a bill belonging to a region they
   * are not assigned to, as long as its Sr no put it on their team's tab.
   */
  let filter = {};

  const regions = Array.isArray(user?.region)
    ? user.region.filter(Boolean)
    : user?.region
    ? [user.region]
    : [];

  if (regions.length && !regions.includes("ALL")) {
    filter.region = { $in: regions };
  }

  switch (role) {
    case "site_officer":
      return {
        ...filter,
        "pimoMumbai.dateReceived": null,
        siteStatus: "hold",
        currentCount: 1
      };

    case "site_pimo":
      return {
        ...filter,
        currentCount: 3,
        $or: [
          {
            "pimoMumbai.dateGiven": { $ne: null },
            "accountsDept.dateReceived": null
          },
          {
            siteStatus: "accept",
            "accountsDept.dateReceived": null
          }
        ]
      };

    case "accounts":
      /*
       * Accounts is the one exception to "Home tab only".
       *
       * "In mass upload, upload is allowed only when bill exist in the Home Tab
       *  and not forwarded tab of the respective team. But in the case of
       *  following columns in the accounts team, we need exception and mass
       *  upload should be allowed even if bill is in forwarded tab"
       *  -- 29.09, item 26.
       *
       * The six columns are listed in ACCOUNTS_FORWARDED_COLUMNS below. A bill
       * on the Accounts FORWARDED tab is one that has been paid (column 89
       * filled), and the payment details often arrive after the payment date -
       * so requiring the bill still to be unpaid made those columns
       * unreachable. The tab test is therefore dropped here and applied per
       * column instead, in processPatchRow.
       */
      return {
        ...filter,
        "accountsDept.dateGiven": { $ne: null },
      };

    case "director":
      return {
        ...filter,
        "approvalDetails.directorApproval.dateGiven": { $ne: null },
        "pimoMumbai.dateReturnedFromDirector": null,
        siteStatus: { $in: ["accept", "hold"] },
        "accountsDept.paymentDate": null
      };

    case "qs_site":
      return {
        ...filter,
        $and: [
          { "pimoMumbai.dateReturnedFromQs": null },
          {
            $or: [
              { "qsInspection.dateGiven": { $ne: null } },
              { "qsCOP.dateGiven": { $ne: null } },
              { "qsMumbai.dateGiven": { $ne: null } }
            ]
          }
        ]
      };

    default:
      return filter;
  }
}

/**
 * Every tab filter above spreads `filter` first, so the region clause added
 * there survives into each branch. This is asserted by the mass-update tests
 * rather than left to inspection.
 */
/**
 * Processes a single row for patch updates
 * @param {Object} rowData - Extracted row data
 * @param {Object} columnMapping - Map of { header: dbField } for relevant columns in the file
 * @param {string} srNoHeader - The specific header key for the Sr No column
 * @param {Array<string>} allowedFields - Fields allowed for the team
 * @param {Object} updateSummary - Object tracking field update counts
 * @param {Object} ignoredFieldsCount - Object tracking ignored field counts
 * @returns {Promise<Object>} Result object with updated flag and optional srNo or reason
 */
async function processPatchRow(rowData, columnMapping, srNoHeader, allowedFields, updateSummary, ignoredFieldsCount, role, user) {
  // Use the identified Sr No header, or try fallback
  const srNo = srNoHeader && rowData[srNoHeader] ? String(rowData[srNoHeader]).trim() : null;

  if (!srNo) {
    return { updated: false, reason: 'missing_srno' };
  }
  const homeFilter = getPatchValidationFilter(role, user);
  const bill = await Bill.findOne({
    srNo,
    ...homeFilter
  });
  if (!bill) {
    /*
     * Say which of the two things went wrong.
     *
     * "No bill exists with this Sr no" was reported for a bill that exists
     * perfectly well but is not on the uploader's Home tab, or is in another
     * region. Those need completely different action from the uploader, and
     * conflating them is why the result file read as a mystery
     * (observation N-14).
     */
    const exists = await Bill.findOne({ srNo }).select('region').lean();
    if (!exists) return { updated: false, reason: 'bill_not_found', srNo };

    const regions = Array.isArray(user?.region) ? user.region : [];
    if (regions.length && !regions.includes('ALL') && !regions.includes(exists.region)) {
      return { updated: false, reason: 'wrong_region', srNo, detail: exists.region };
    }
    return { updated: false, reason: 'not_on_home_tab', srNo };
  }

  const billData = typeof bill.toObject === 'function' ? bill.toObject() : bill;
  const updateObj = initializeUpdateObject(billData);
  let hasUpdate = false;
  const refusedOnForwarded = [];

  // Iterate over the relevant columns found in the file
  for (const [header, dbField] of Object.entries(columnMapping)) {
    // Skip if permission denied, but track it
    if (!isFieldAllowed(dbField, allowedFields)) {
      // Only verify if the cell is actually filled to count as an "ignored update"
      if (isFilled(rowData[header])) {
        if (!ignoredFieldsCount[dbField]) {
          ignoredFieldsCount[dbField] = 0;
        }
        ignoredFieldsCount[dbField]++;
      }
      continue;
    }

    // Skip if cell is empty
    if (!isFilled(rowData[header])) {
      continue;
    }

    /*
     * A paid bill has left the Accounts Home tab. Only the six columns listed
     * in ACCOUNTS_FORWARDED_COLUMNS may still be written to it (S-26);
     * everything else stays Home-tab only, as before.
     */
    if (
      role === "accounts" &&
      bill.accountsDept?.paymentDate &&
      !ACCOUNTS_FORWARDED_COLUMNS.includes(dbField)
    ) {
      if (!refusedOnForwarded.includes(header)) refusedOnForwarded.push(String(header).trim());
      continue;
    }

    const parsedValue = parseFieldValue(dbField, rowData[header]);
    if (parsedValue === null) {
      continue;
    }

    setNestedField(updateObj, dbField, parsedValue);

    if (!updateSummary[dbField]) {
      updateSummary[dbField] = 0;
    }
    updateSummary[dbField]++;
    hasUpdate = true;
  }

  applyBusinessRules(updateObj);

  if (hasUpdate) {
    await Bill.updateOne({ _id: bill._id }, { $set: updateObj });
    return { updated: true, srNo };
  } else {
    // If we are here, it means we found the bill but had no valid updates to apply
    // Check if permission issues were the cause
    const refused = Object.entries(columnMapping)
      .filter(([h, dbField]) => isFilled(rowData[h]) && !isFieldAllowed(dbField, allowedFields))
      .map(([h]) => String(h).trim());

    if (!refused.length && refusedOnForwarded.length) {
      return { updated: false, reason: 'paid_bill_column', srNo, detail: refusedOnForwarded.join(', ') };
    }

    return {
      updated: false,
      reason: refused.length ? 'permission_denied' : 'no_updates',
      srNo,
      // The uploader needs to know WHICH column was refused, not merely that
      // one was (observation N-14).
      detail: refused.length ? refused.join(', ') : undefined,
    };
  }
}

/**
 * Formats patch results into a response object
 * @param {number} updated - Number of bills updated
 * @param {number} skipped - Number of bills skipped
 * @param {string} teamName - Team name
 * @param {Object} updateSummary - Field update summary
 * @param {Object} ignoredFieldsCount - Ignored field counts
 * @param {Array<string>} allowedFields - Allowed fields for the team
 * @param {Array<Object>} skippedDetails - Details about skipped rows
 * @returns {Object} Formatted result object
 */
/**
 * Reason codes carry no meaning for the person reading the results file, so
 * each is turned into a sentence that says what to do about it.
 */
const REASON_TEXT = {
  missing_srno: "Sr no is blank - every row must carry the Sr no shown on your Home tab",
  bill_not_found: "No bill exists with this Sr no - check it against your Home tab",
  not_on_home_tab:
    "This bill exists but is not on your team's Home tab, so it cannot be updated from here. " +
    "Only bills currently sitting with your team can be changed by mass update",
  wrong_region: "This bill belongs to a region you are not assigned to",
  permission_denied: "Your team is not permitted to update these columns",
  paid_bill_column:
    "This bill has been paid, so only the payment columns can still be changed " +
    "- Payment Instructions, F110, Dt of Payment, Hard Copy, Accts Identification and Payment Amt",
  no_updates: "No recognised column on this row had a value to update",
};

const explainReason = (code, teamName, detail) => {
  const text = REASON_TEXT[code] || `Row could not be updated (${code})`;
  if (code === "permission_denied") {
    const cols = detail ? `: ${detail}` : "";
    return teamName ? `${text}${cols} (your team: ${teamName})` : `${text}${cols}`;
  }
  if (code === "paid_bill_column" && detail) return `${text}. Refused: ${detail}`;
  if (code === "wrong_region" && detail) return `${text} (${detail})`;
  return text;
};

function formatPatchResults(updated, skipped, teamName, updateSummary, ignoredFieldsCount, allowedFields, skippedDetails, unknownHeaders = []) {
  const totalIgnoredUpdates = Object.values(ignoredFieldsCount).reduce((sum, count) => sum + count, 0);

  return {
    updated,
    skipped,
    teamName,
    // The results screen keys failures by Excel row number and reads `error`.
    // skippedDetails is kept below for anyone already using it.
    errors: skippedDetails.map((d) => ({
      row: d.row,
      srNo: d.srNo,
      error: explainReason(d.reason, teamName, d.detail),
    })),
    // Column headings in the uploaded file that the system does not recognise.
    // Previously these were dropped in silence, which is how two columns in the
    // client's own template went unnoticed for months.
    unknownHeaders,
    fieldUpdateSummary: updateSummary,
    ignoredFields: {
      count: Object.keys(ignoredFieldsCount).length,
      totalUpdatesIgnored: totalIgnoredUpdates,
      fields: ignoredFieldsCount
    },
    teamRestrictions: {
      active: !!teamName,
      allowedFields: allowedFields.length > 0 ? allowedFields : 'none'
    },
    skippedDetails // Include for debugging
  };
}

/**
 * Patches bills from an Excel file with team-based field restrictions
 * @param {string} filePath - Path to the Excel file
 * @param {string|null} teamName - Team or role name for field restrictions
 * @returns {Promise<Object>} Object containing patch statistics and results
 * @throws {Error} If Excel file cannot be read or no worksheet is found
 */
export async function patchBillsFromExcelFile(filePath, teamName = null, role = Admin, user = null) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);

  const { worksheet, headers, headerRowIdx } = readWorkbookAndHeaders(workbook);
  const allowedFields = getAllowedFieldsForTeam(teamName);

  // Identify 'Sr No' column and relevant patchable columns
  let srNoHeader = null;
  const columnMapping = {}; // { header: dbField }

  const unknownHeaders = [];
  headers.forEach(header => {
    if (!header || !String(header).trim()) return;
    const dbField = lookupHeader(header);

    if (dbField === 'srNo') {
      srNoHeader = header;
    } else if (dbField && allAllowedFields.includes(dbField)) {
      columnMapping[header] = dbField;
    } else if (!dbField) {
      unknownHeaders.push(String(header).trim());
    }
  });

  if (!srNoHeader) {
    // Try fuzzy match for Sr No if not found
    srNoHeader = headers.find(h => h.toLowerCase().replace(/[^a-z0-9]/g, '') === 'srno');
  }

  let updated = 0, skipped = 0;
  let updateSummary = {};
  let ignoredFieldsCount = {};
  let skippedDetails = [];

  for (let rowNumber = headerRowIdx + 1; rowNumber <= worksheet.rowCount; rowNumber++) {
    const row = worksheet.getRow(rowNumber);
    if (!row.hasValues) continue; // Skip completely empty rows

    const rowData = extractPatchRowData(row, headers);

    const result = await processPatchRow(rowData, columnMapping, srNoHeader, allowedFields, updateSummary, ignoredFieldsCount, role, user);

    if (result.updated) {
      updated++;
    } else {
      skipped++;
      skippedDetails.push({
        row: rowNumber,
        reason: result.reason,
        srNo: result.srNo || 'unknown',
        detail: result.detail,
      });
    }
  }

  return formatPatchResults(updated, skipped, teamName, updateSummary, ignoredFieldsCount, allowedFields, skippedDetails, unknownHeaders);
}

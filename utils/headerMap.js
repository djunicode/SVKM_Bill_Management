/**
 * Centralized Header Mapping for Bill Management System
 * Maps Excel column headers to MongoDB bill model field paths
 * Handles multiple variations and typos in Excel headers
 * Based on bill-model.js schema definition
 */

// Bill Model Header Mapping - Maps Excel headers to database field paths
export const headerMapping = {
  // Serial Number variations
  "Sr No.": "srNo",
  "Sr No": "srNo",
  "Sr no": "srNo",
  "Serial No": "srNo",
  "Sr no Old": "srNoOld",

  // Type of Invoice / Nature of Work
  "Type of inv": "natureOfWork",
  "Type of Inv": "natureOfWork",
  "Nature of Work": "natureOfWork",

  // Region
  "Region": "region",

  // Project Description
  "Project Description": "projectDescription",
  "Project": "projectDescription",

  // Vendor Information
  "Vendor no": "vendorNo",
  "Vendor No": "vendorNo",
  "Vendor No.": "vendorNo",
  "Vendor Number": "vendorNo",
  "Vendor Name": "vendorName",
  "Vendor": "vendorName",
  "Name": "vendorName",
  "GST Number": "gstNumber",
  "GSTIN": "gstNumber",
  "GST No": "gstNumber",
  "GST No.": "gstNumber",
  "206AB Compliance": "compliance206AB",
  "Compliance Status": "compliance206AB",
  "Compliance": "compliance206AB",
  "206AB": "compliance206AB",
  "PAN Status": "panStatus",
  "PAN": "PAN",
  "PAN No": "PAN",
  "PAN Number": "PAN",

  // Purchase Order
  "If PO created??": "poCreated",
  "PO Created": "poCreated",
  "PO no": "poNo",
  "PO No": "poNo",
  "PO Number": "poNo",
  "PO Dt": "poDate",
  "PO Date": "poDate",
  "PO Amt": "poAmt",
  "PO Amount": "poAmt",

  // Proforma Invoice
  "Proforma Inv No": "proformaInvNo",
  "Proforma Invoice No": "proformaInvNo",
  "Proforma Inv Dt": "proformaInvDate",
  "Proforma Invoice Date": "proformaInvDate",
  "Proforma Inv Amt": "proformaInvAmt",
  "Proforma Invoice Amount": "proformaInvAmt",
  "Proforma Inv Recd at site": "proformaInvRecdAtSite",
  "Proforma Invoice Received at Site": "proformaInvRecdAtSite",
  "Proforma Inv Recd by": "proformaInvRecdBy",
  "Proforma Invoice Received by": "proformaInvRecdBy",

  // Tax Invoice
  "Tax Inv no": "taxInvNo",
  "Tax Inv No": "taxInvNo",
  "Tax Invoice No": "taxInvNo",
  "Tax Invoice Number": "taxInvNo",
  "Tax Inv Dt": "taxInvDate",
  "Tax Invoice Date": "taxInvDate",
  "Tax Inv Date": "taxInvDate",
  "Currency": "currency",
  "Tax Inv Amt": "taxInvAmt",
  "Tax Inv Amt ": "taxInvAmt", // with trailing space
  "Tax Invoice Amount": "taxInvAmt",
  "Tax Inv Amount": "taxInvAmt",
  "Tax Inv Recd at site": "taxInvRecdAtSite",
  "Tax Invoice Received at Site": "taxInvRecdAtSite",
  "Tax Inv Recd by": "taxInvRecdBy",
  "Tax Invoice Received by": "taxInvRecdBy",

  // Department and Remarks
  "Department": "department",
  "Remarks by Site Team": "remarksBySiteTeam",
  "Remarks related to Inv": "remarksBySiteTeam",
  "Site Team Remarks": "remarksBySiteTeam",

  // Attachment
  "Attachment": "attachment",
  "Attachment Type": "attachmentType",

  // Advance Details
  "Advance Dt": "advanceDate",
  "Advance Date": "advanceDate",
  "Advance Amt": "advanceAmt",
  "Advance Amount": "advanceAmt",
  "Advance Percentage": "advancePercentage",
  "Advance Percentage ": "advancePercentage", // with trailing space
  "Adv request entered by": "advRequestEnteredBy",
  "Advance Request Entered By": "advRequestEnteredBy",

  // Quality Engineer
  "Dt given to Quality Engineer": "qualityEngineer.dateGiven",
  "Date Given to Quality Engineer": "qualityEngineer.dateGiven",
  "Name of Quality Engineer": "qualityEngineer.name",
  "Quality Engineer Name": "qualityEngineer.name",

  // QS Inspection
  "Dt given to QS for Inspection": "qsInspection.dateGiven",
  "Date Given to QS for Inspection": "qsInspection.dateGiven",
  "Name of QS": "qsInspection.name", // Will be handled contextually
  "QS Name": "qsInspection.name",

  // QS Measurement Check
  "Checked by QS with Dt of Measurment": "qsMeasurementCheck.dateGiven",
  "Checked  by QS with Dt of Measurment": "qsMeasurementCheck.dateGiven", // with extra space
  "Checked by QS with Date of Measurement": "qsMeasurementCheck.dateGiven",

  // Vendor Final Invoice
  "Given to vendor-Query/Final Inv": "vendorFinalInv.dateGiven",
  "Vendor Final Invoice Date": "vendorFinalInv.dateGiven",
  "Name of Vendor Final Inv": "vendorFinalInv.name",

  // QS COP
  "Dt given to QS for COP": "qsCOP.dateGiven",
  "Date Given to QS for COP": "qsCOP.dateGiven",
  "Name - QS": "qsCOP.name",
  "QS COP Name": "qsCOP.name",

  // COP Details
  "COP Dt": "copDetails.date",
  "COP Date": "copDetails.date",
  "COP Amt": "copDetails.amount",
  "COP Amount": "copDetails.amount",
  "COP Date Returned": "copDetails.dateReturned",
  "COP Remarks": "copDetails.remarks",

  // QS Team Remarks
  "Remarks by QS Team": "remarksByQSTeam",
  "QS Team Remarks": "remarksByQSTeam",

  // MIGO Details
  "Dt given for MIGO": "migoDetails.dateGiven",
  "Date Given for MIGO": "migoDetails.dateGiven",
  "MIGO no": "migoDetails.no",
  "MIGO No": "migoDetails.no",
  "MIGO Number": "migoDetails.no",
  "MIGO Dt": "migoDetails.date",
  "MIGO Date": "migoDetails.date",
  "MIGO Amt": "migoDetails.amount",
  "MIGO Amount": "migoDetails.amount",
  "Migo done by": "migoDetails.doneBy",
  "MIGO Done By": "migoDetails.doneBy",
  "MIGO done by": "migoDetails.doneBy",
  // Invoice Return to Site
  "Dt-Inv returned to Site office": "invReturnedToSite",
  "Date Invoice Returned to Site Office": "invReturnedToSite",
  "Invoice Returned to Site": "invReturnedToSite",

  // Site Engineer
  "Dt given to Site Engineer": "siteEngineer.dateGiven",
  "Date Given to Site Engineer": "siteEngineer.dateGiven",
  "Name of Site Engineer": "siteEngineer.name",
  "Site Engineer Name": "siteEngineer.name",

  // Architect
  "Dt given to Architect": "architect.dateGiven",
  "Date Given to Architect": "architect.dateGiven",
  "Name of Architect": "architect.name",
  "Architect Name": "architect.name",

  // Site Incharge
  "Dt given-Site Incharge": "siteIncharge.dateGiven",
  "Date Given to Site Incharge": "siteIncharge.dateGiven",
  "Name-Site Incharge": "siteIncharge.name",
  "Site Incharge Name": "siteIncharge.name",

  // General Remarks
  "Remarks": "remarks",
  "Remarks ": "remarks", // with trailing space

  // Site Office Dispatch
  "Dt given to Site Office for dispatch": "siteOfficeDispatch.dateGiven",
  "Date Given to Site Office for Dispatch": "siteOfficeDispatch.dateGiven",
  "Name-Site Office": "siteOfficeDispatch.name",
  "Site Office Name": "siteOfficeDispatch.name",

  // Site Status
  "Status": "siteStatus",
  "Site Status": "siteStatus",

  // PIMO Mumbai
  "Dt given to PIMO Mumbai": "pimoMumbai.dateGiven",
  "Date Given to PIMO Mumbai": "pimoMumbai.dateGiven",
  "Dt recd at PIMO Mumbai": "pimoMumbai.dateReceived",
  "Date Received at PIMO Mumbai": "pimoMumbai.dateReceived",
  "Name recd by PIMO Mumbai": "pimoMumbai.receivedBy",
  "Received By PIMO Mumbai": "pimoMumbai.receivedBy",
  "Dt given to PIMO Mumbai ": "pimoMumbai.dateGivenPIMO", // with trailing space
  "Name given-Site to PIMO": "pimoMumbai.namePIMO", // col 61A
  "Name -PIMO": "pimoMumbai.namePIMO",
  "PIMO Name": "pimoMumbai.namePIMO",
  "Dt given to PIMO Mumbai 2": "pimoMumbai.dateGivenPIMO2",
  "Name-given to PIMO": "pimoMumbai.namePIMO2",
  "PIMO Name 2": "pimoMumbai.namePIMO2",
  "Dt recd from IT Deptt": "pimoMumbai.dateReceivedFromIT",
  "Date Received from IT Department": "pimoMumbai.dateReceivedFromIT",
  "Dt recd from PIMO": "pimoMumbai.dateReceivedFromPIMO",
  "Date Received from PIMO": "pimoMumbai.dateReceivedFromPIMO",
  "Dt returned from QS": "pimoMumbai.dateReturnedFromQs",
  "Date Returned from QS": "pimoMumbai.dateReturnedFromQs",
  // col 78. The client's mass-update template uses this wording; without it
  // the column was discarded before validation (observations, Mass Update #2).
  "Dt ret-PIMO aft approval": "pimoMumbai.dateReturnedFromDirector",
  "Dt returned from Director": "pimoMumbai.dateReturnedFromDirector",
  "Date Returned from Director": "pimoMumbai.dateReturnedFromDirector",
  "Dt returned from SES": "pimoMumbai.dateReturnedFromSES",
  "Date Returned from SES": "pimoMumbai.dateReturnedFromSES",

  // QS Mumbai
  "Dt given to QS Mumbai": "qsMumbai.dateGiven",
  "Date Given to QS Mumbai": "qsMumbai.dateGiven",
  "Name of QS Mumbai": "qsMumbai.name",
  "QS Mumbai Name": "qsMumbai.name",

  // IT Department
  "Dt given to IT Dept": "itDept.dateGiven",
  "Date Given to IT Department": "itDept.dateGiven",
  "Name- given to IT Dept": "itDept.name",
  "IT Department Name": "itDept.name",
  "Dt recd from IT Dept": "itDept.dateReceived",
  "Date Received from IT Department": "itDept.dateReceived",

  // SES Details
  "SES no": "sesDetails.no",
  "SES No": "sesDetails.no",
  "SES Number": "sesDetails.no",
  "SES Amt": "sesDetails.amount",
  "SES Amount": "sesDetails.amount",
  "SES Dt": "sesDetails.date",
  "SES Date": "sesDetails.date",
  "SES done by": "sesDetails.doneBy",
  "SES Done By": "sesDetails.doneBy",
  "SES Name": "sesDetails.name",
  "Dt given for SES": "sesDetails.dateGiven",
  "Date Given for SES": "sesDetails.dateGiven",

  // Director Approval
  "Dt given to Director/Advisor/Trustee for approval": "approvalDetails.directorApproval.dateGiven",
  "Date Given to Director for Approval": "approvalDetails.directorApproval.dateGiven",
  "Dt recd back in PIMO after approval": "approvalDetails.directorApproval.dateReceived",
  "Date Received in PIMO After Approval": "approvalDetails.directorApproval.dateReceived",
  "Remarks PIMO Mumbai": "approvalDetails.remarksPimoMumbai",
  "PIMO Mumbai Remarks": "approvalDetails.remarksPimoMumbai",

  // Accounts Department
  "Dt given to Accts dept": "accountsDept.dateGiven",
  "Date Given to Accounts Department": "accountsDept.dateGiven",
  "Name -given by PIMO office": "accountsDept.givenBy",
  "Given By PIMO Office": "accountsDept.givenBy",
  "Dt recd in Accts dept": "accountsDept.dateReceived",
  "Date Received in Accounts Department": "accountsDept.dateReceived",
  "Name recd by Accts dept": "accountsDept.receivedBy",
  "Received By Accounts Department": "accountsDept.receivedBy",
  "Dt returned back to PIMO": "accountsDept.returnedToPimo",
  "Dt returned back to  PIMO": "accountsDept.returnedToPimo", // with extra space
  "Date Returned to PIMO": "accountsDept.returnedToPimo",
  "Dt recd back in Accts dept": "accountsDept.receivedBack",
  "Date Received Back in Accounts": "accountsDept.receivedBack",
  "Inv given for booking and checking": "accountsDept.invBookingChecking",
  "Invoice Booking and Checking": "accountsDept.invBookingChecking",
  "Payment instructions": "accountsDept.paymentInstructions",
  "Payment Instruction": "accountsDept.paymentInstructions",
  "Remarks for pay instructions": "accountsDept.remarksForPayInstructions",
  "Payment Instructions Remarks": "accountsDept.remarksForPayInstructions",
  "F110 Identification": "accountsDept.f110Identification",
  "F110": "accountsDept.f110Identification",
  "Dt of Payment": "accountsDept.paymentDate",
  "Payment Date": "accountsDept.paymentDate",
  "Hard Copy": "accountsDept.hardCopy",
  "Accts Identification": "accountsDept.accountsIdentification",
  "Accounts Identification": "accountsDept.accountsIdentification",
  "Payment Amt": "accountsDept.paymentAmt",
  "Payment Amount": "accountsDept.paymentAmt",
  "Remarks Accts dept": "accountsDept.remarksAcctsDept",
  "Accounts Department Remarks": "accountsDept.remarksAcctsDept",
  "Accts Status": "accountsDept.status",
  "Payment Status": "accountsDept.status",

  // MIRO Details (for Accounts Team)
  "MIRO no": "miroDetails.number",
  "MIRO No": "miroDetails.number",
  "MIRO Number": "miroDetails.number",
  "MIRO Dt": "miroDetails.date",
  "MIRO Date": "miroDetails.date",
  "MIRO Amt": "miroDetails.amount",
  "MIRO Amount": "miroDetails.amount",

  // Bill Date and Amount (Critical fields)
  "Bill Date": "billDate",
  "Amount": "amount",
  "Bill Amount": "amount",
  "Total Amount": "amount",

  // Vendor-specific additional fields (for vendor master imports)
  "Addl 1": "addl1",
  "Addl 2": "addl2",
  "Additional 1": "addl1",
  "Additional 2": "addl2",
  "Email": "emailIds",
  "Email ID": "emailIds",
  "Email IDs": "emailIds",
  "EmailId": "emailIds",
  "Email Address": "emailIds",
  "Phone": "phoneNumbers",
  "Phone No": "phoneNumbers",
  "Phone No.": "phoneNumbers",
  "Phone Number": "phoneNumbers",
  "Phone Numbers": "phoneNumbers",
  "Mobile": "phoneNumbers",
  "Mobile No": "phoneNumbers",
  "Mobile Number": "phoneNumbers"
};

/**
 * Generate an array of field names in the order they appear in Excel exports
 * This is used for generating Excel files and CSV exports
 */
export const fields = [
  "srNo",
  "srNoOld",
  "region",
  "projectDescription",
  "vendorNo",
  "vendorName",
  "gstNumber",
  "compliance206AB",
  "panStatus",
  "poCreated",
  "poNo",
  "poDate",
  "poAmt",
  "proformaInvNo",
  "proformaInvDate",
  "proformaInvAmt",
  "proformaInvRecdAtSite",
  "proformaInvRecdBy",
  "taxInvNo",
  "taxInvDate",
  "currency",
  "taxInvAmt",
  "taxInvRecdAtSite",
  "taxInvRecdBy",
  "department",
  "remarksBySiteTeam",
  "attachment",
  "attachmentType",
  "advanceDate",
  "advanceAmt",
  "advancePercentage",
  "advRequestEnteredBy",
  "qualityEngineer.dateGiven",
  "qualityEngineer.name",
  "qsInspection.dateGiven",
  "qsInspection.name",
  "qsMeasurementCheck.dateGiven",
  "vendorFinalInv.dateGiven",
  "vendorFinalInv.name",
  "qsCOP.dateGiven",
  "qsCOP.name",
  "copDetails.date",
  "copDetails.amount",
  "copDetails.dateReturned",
  "copDetails.remarks",
  "remarksByQSTeam",
  "migoDetails.dateGiven",
  "migoDetails.no",
  "migoDetails.date",
  "migoDetails.amount",
  "migoDetails.doneBy",
  "invReturnedToSite",
  "siteEngineer.dateGiven",
  "siteEngineer.name",
  "architect.dateGiven",
  "architect.name",
  "siteIncharge.dateGiven",
  "siteIncharge.name",
  "remarks",
  "siteOfficeDispatch.dateGiven",
  "siteOfficeDispatch.name",
  "siteStatus",
  "pimoMumbai.dateGiven",
  "pimoMumbai.dateReceived",
  "pimoMumbai.receivedBy",
  "qsMumbai.dateGiven",
  "qsMumbai.name",
  "pimoMumbai.dateGivenPIMO",
  "pimoMumbai.namePIMO",
  "itDept.dateGiven",
  "itDept.name",
  "pimoMumbai.dateGivenPIMO2",
  "pimoMumbai.namePIMO2",
  "sesDetails.no",
  "sesDetails.amount",
  "sesDetails.date",
  "sesDetails.doneBy",
  "pimoMumbai.dateReceivedFromIT",
  "itDept.dateReceived",
  "pimoMumbai.dateReceivedFromPIMO",
  "pimoMumbai.dateReturnedFromQs",
  "pimoMumbai.dateReturnedFromDirector",
  "pimoMumbai.dateReturnedFromSES",
  "approvalDetails.directorApproval.dateGiven",
  "approvalDetails.directorApproval.dateReceived",
  "approvalDetails.remarksPimoMumbai",
  "accountsDept.dateGiven",
  "accountsDept.givenBy",
  "accountsDept.dateReceived",
  "accountsDept.receivedBy",
  "accountsDept.returnedToPimo",
  "accountsDept.receivedBack",
  "accountsDept.invBookingChecking",
  "accountsDept.paymentInstructions",
  "accountsDept.remarksForPayInstructions",
  "accountsDept.f110Identification",
  "accountsDept.paymentDate",
  "accountsDept.hardCopy",
  "accountsDept.accountsIdentification",
  "accountsDept.paymentAmt",
  "accountsDept.remarksAcctsDept",
  "accountsDept.status",
  "miroDetails.number",
  "miroDetails.date",
  "miroDetails.amount"
];

/**
 * Reverse mapping - from database field to Excel header
 * Useful for generating Excel files
 */
export const fieldToHeaderMapping = {};
for (const [header, field] of Object.entries(headerMapping)) {
  // Only use the first (primary) header for each field
  if (!fieldToHeaderMapping[field]) {
    fieldToHeaderMapping[field] = header;
  }
}

/**
 * Vendor-specific header mapping
 * Used for vendor master CSV imports
 */
export const vendorHeaderMapping = {
  "Vendor no": "vendorNo",
  "Vendor No": "vendorNo",
  "Vendor No.": "vendorNo",
  "Vendor Number": "vendorNo",
  "Addl 1": "addl1",
  "Addl 2": "addl2",
  "Addl1": "addl1",
  "Addl2": "addl2",
  "Additional 1": "addl1",
  "Additional 2": "addl2",
  "Vendor Name": "vendorName",
  "Vendor": "vendorName",
  "Name": "vendorName",
  "Supplier Name": "vendorName",
  "PAN": "PAN",
  "PAN No": "PAN",
  "PAN No.": "PAN",
  "PAN Number": "PAN",
  "GST Number": "GSTNumber",
  "GST No": "GSTNumber",
  "GST No.": "GSTNumber",
  "GSTIN": "GSTNumber",
  "206AB Compliance": "complianceStatus",
  "Compliance Status": "complianceStatus",
  "206AB": "complianceStatus",
  "Compliance": "complianceStatus",
  "PAN Status": "PANStatus",
  "Status": "PANStatus",
  "Email": "emailIds",
  "Email ID": "emailIds",
  "Email IDs": "emailIds",
  "EmailId": "emailIds",
  "Email Address": "emailIds",
  "Email ids": "emailIds",
  "Phone": "phoneNumbers",
  "Phone No": "phoneNumbers",
  "Phone No.": "phoneNumbers",
  "Phone no": "phoneNumbers",
  "Phone Number": "phoneNumbers",
  "Phone Numbers": "phoneNumbers",
  "Mobile": "phoneNumbers",
  "Mobile No": "phoneNumbers",
  "Mobile Number": "phoneNumbers"
};

// Derived helper arrays for specific vendor fields
// These are useful for iteration when checks need to be fuzzy or prioritized
export const vendorPhoneHeaders = Object.entries(vendorHeaderMapping)
  .filter(([_, value]) => value === "phoneNumbers")
  .map(([key, _]) => key);

export const vendorEmailHeaders = Object.entries(vendorHeaderMapping)
  .filter(([_, value]) => value === "emailIds")
  .map(([key, _]) => key);

export const vendorAddl1Headers = Object.entries(vendorHeaderMapping)
  .filter(([_, value]) => value === "addl1")
  .map(([key, _]) => key);

export const vendorAddl2Headers = Object.entries(vendorHeaderMapping)
  .filter(([_, value]) => value === "addl2")
  .map(([key, _]) => key);

export const vendorNoHeaders = Object.entries(vendorHeaderMapping)
  .filter(([_, value]) => value === "vendorNo")
  .map(([key, _]) => key);

export const vendorGSTHeaders = Object.entries(vendorHeaderMapping)
  .filter(([_, value]) => value === "GSTNumber")
  .map(([key, _]) => key);

export const vendorComplianceHeaders = Object.entries(vendorHeaderMapping)
  .filter(([_, value]) => value === "complianceStatus")
  .map(([key, _]) => key);

export const vendorPANStatusHeaders = Object.entries(vendorHeaderMapping)
  .filter(([_, value]) => value === "PANStatus")
  .map(([key, _]) => key);
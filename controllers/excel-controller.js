import { generateExcelReport, generatePDFReport } from "../utils/report-generator-deprecated.js";
// Update imports to use the split CSV utility files
import { importBillsFromExcel } from "../utils/csv-import.js";
import { patchBillsFromExcelFile } from '../utils/csv-patch-extract.js';
import { insertVendorsFromExcel, updateVendorComplianceFromExcel } from '../utils/vendor-csv-utils.js';

import { primaryRole, isAdminRole, asRoles } from "../utils/roles.js";
import mongoose from "mongoose";
import multer from "multer";
import path from "path";
import fs from "fs";
import os from "os";
import ExcelJS from "exceljs";
import Bill from '../models/bill-model.js';
import VendorMaster from '../models/vendor-master-model.js';

const buildResponsePayload = ({ success, message, toastMessage, data, meta, errors }) => ({
  success,
  message,
  toastMessage: toastMessage ?? message,
  data: data ?? {},
  meta: meta ?? {},
  errors: Array.isArray(errors) ? errors : errors ? [errors] : []
});

const sendSuccess = (res, statusCode, payload) =>
  res.status(statusCode).json(buildResponsePayload({ success: true, ...payload }));

const sendError = (res, statusCode, payload) =>
  res.status(statusCode).json(buildResponsePayload({ success: false, ...payload }));

// Helper function to check if vendor validation should be skipped
const shouldSkipVendorValidation = async () => {
  try {
    if (!VendorMaster) return true;

    const count = await VendorMaster.countDocuments();


    // If empty vendor table, skip validation
    return count === 0;
  } catch (error) {
    console.error('Error checking vendor count:', error);
    return true; // Skip validation on error
  }
};

const resolveImportCount = (value) => {
  if (Array.isArray(value)) {
    return value.length;
  }

  if (value && typeof value === 'object') {
    if (typeof value.count === 'number' && Number.isFinite(value.count)) {
      return value.count;
    }

    if (typeof value.length === 'number' && Number.isFinite(value.length)) {
      return value.length;
    }
  }

  const numericValue = Number(value);
  if (Number.isFinite(numericValue)) {
    return Math.max(0, numericValue);
  }

  return 0;
};

const generateReport = async (req, res) => {
  try {
    const { billIds, format = 'excel' } = req.body;

    // Normalize billIds input
    const ids = Array.isArray(billIds) ? billIds : billIds.split(',').map(id => id.trim());

    // Validate IDs
    if (!ids.length) {
      return sendError(res, 400, {
        message: "Please select at least one bill to generate a report",
        toastMessage: "Please select at least one bill",
        errors: [{ code: 'NO_BILL_IDS' }]
      });
    }

    const invalidIds = ids.filter(id => !mongoose.Types.ObjectId.isValid(id));
    if (invalidIds.length) {
      return sendError(res, 400, {
        message: "Some bill IDs are invalid",
        toastMessage: "Invalid bill IDs selected. Please refresh and try again",
        errors: [{ code: 'INVALID_BILL_IDS', invalidIds }],
        meta: { invalidIds }
      });
    }

    // Generate report based on format
    let fileBuffer, fileName, contentType;
    const timestamp = new Date().toISOString().split('T')[0];

    switch (format.toLowerCase()) {
      case 'pdf':
        fileBuffer = await generatePDFReport(ids);
        fileName = `bills-report-${timestamp}.pdf`;
        contentType = "application/pdf";
        break;
      case 'csv':
        fileBuffer = await exportBillsToCSV(ids);
        fileName = `bills-report-${timestamp}.csv`;
        contentType = "text/csv";
        break;
      case 'excel':
      default:
        fileBuffer = await generateExcelReport(ids);
        fileName = `bills-report-${timestamp}.xlsx`;
        contentType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
        break;
    }

    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.setHeader("Content-Length", fileBuffer.length);
    return res.send(fileBuffer);
  } catch (error) {
    console.error('Report generation error:', error);
    return sendError(res, 500, {
      message: "Failed to generate report",
      toastMessage: "Failed to generate report. Please try again",
      errors: [{ message: error.message }]
    });
  }
};

const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    // Define allowed file types
    const validExcelMimeTypes = [
      'application/vnd.ms-excel',                                          // .xls
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
      'application/vnd.oasis.opendocument.spreadsheet',                    // .odsx
      'text/csv'                                                           // .csv
    ];

    const validExtensions = /xlsx|xls|csv|ods/i;
    const extname = validExtensions.test(path.extname(file.originalname).toLowerCase());
    const mimetype = validExcelMimeTypes.includes(file.mimetype);



    if (extname || mimetype) {
      return cb(null, true);
    }
    cb(new Error(`Invalid file type. Allowed types: xlsx, xls, csv. Received mimetype: ${file.mimetype}`));
  }
}).any();

const runUpload = (req, res) => new Promise((resolve, reject) => {
  upload(req, res, (err) => {
    if (!err) {
      return resolve();
    }

    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return reject(new Error('File size too large. Maximum size is 10MB'));
      }
      return reject(new Error(`File upload error: ${err.message}`));
    }

    return reject(err);
  });
});

const importBills = async (req, res) => {
  try {
    await runUpload(req, res);

    if (!req.files || !req.files.length) {
      return sendError(res, 400, {
        message: "No file uploaded",
        toastMessage: "Please select a file to upload",
        errors: [{ code: 'NO_FILE' }]
      });
    }

    // Check if we're in patch-only mode (don't create new bills)
    const patchOnly = req.query.patchOnly === 'true';


    const uploadedFile = req.files[0]; // Get the first uploaded file
    const tempDir = os.tmpdir();
    const tempFilePath = path.join(tempDir, uploadedFile.originalname);

    // Check if we should skip vendor validation
    const skipVendorValidation = await shouldSkipVendorValidation();


    // Extract vendor numbers from Excel/CSV before processing
    // This allows us to validate vendors first
    let vendorNos = [];

    // Write buffer to temporary file
    fs.writeFileSync(tempFilePath, uploadedFile.buffer);

    // Check if VendorMaster model is available and validate vendors
    let validVendors = [];
    let validVendorNames = []; // Added - use vendor names instead of numbers

    if (VendorMaster && !skipVendorValidation) {
      try {
        // Extract vendor information from the file first
        const fileExtension = path.extname(uploadedFile.originalname).toLowerCase();
        if (fileExtension === '.xlsx' || fileExtension === '.xls') {
          const workbook = new ExcelJS.Workbook();
          await workbook.xlsx.readFile(tempFilePath);
          const worksheet = workbook.getWorksheet(1);

          // Find both vendor number and vendor name columns
          const headers = [];
          let vendorNoColIdx = -1;
          let vendorNameColIdx = -1;

          worksheet.getRow(1).eachCell((cell, colNumber) => {
            const header = cell.value?.toString().trim();
            if (header === 'Vendor no') {
              vendorNoColIdx = colNumber;
            }
            if (header === 'Vendor Name') {
              vendorNameColIdx = colNumber;
            }
          });

          // If header row not found in first row, try second row (in case of column index row)
          if (vendorNoColIdx === -1 || vendorNameColIdx === -1) {
            worksheet.getRow(2).eachCell((cell, colNumber) => {
              const header = cell.value?.toString().trim();
              if (header === 'Vendor no') {
                vendorNoColIdx = colNumber;
              }
              if (header === 'Vendor Name') {
                vendorNameColIdx = colNumber;
              }
            });
          }

          // Extract vendor numbers and names for reference
          if (vendorNoColIdx > 0) {

            if (vendorNameColIdx > 0) {

            }

            worksheet.eachRow((row, rowNumber) => {
              if (rowNumber > 2) { // Skip potential header rows
                const vendorNo = row.getCell(vendorNoColIdx).value;
                if (vendorNo) {
                  vendorNos.push(String(vendorNo).trim());
                }
              }
            });
          } else {

          }
        }

        // Query vendor master for validation - use vendor names instead of numbers
        try {
          // Count total vendors in database first
          const totalVendorsInDB = await VendorMaster.countDocuments();


          if (totalVendorsInDB === 0) {

            skipVendorValidation = true;
          } else {
            // Get all vendors to validate by name
            const allVendors = await VendorMaster.find().lean();
            validVendors = allVendors;

            // Extract vendor names for validation
            validVendorNames = allVendors.map(v => v.vendorName || '');




            if (validVendorNames.length === 0) {
              // Try to get a sample of vendors to debug
              const sampleVendors = await VendorMaster.find().limit(5).lean();
            }
          }
        } catch (findError) {
          console.error('Error querying VendorMaster collection:', findError);
          skipVendorValidation = true;
        }
      } catch (error) {
        console.error('Error pre-validating vendors:', error);
        skipVendorValidation = true;
      }
    } else {
      skipVendorValidation = true;
    }

    // Determine file type and process accordingly
    const fileExtension = path.extname(uploadedFile.originalname).toLowerCase();
    let importResult;

    try {
      // Pass the valid vendor list to the import function only if validation is enabled
      // Now we pass vendor names instead of vendor numbers
      const validVendorList = skipVendorValidation ? [] : validVendorNames;


      if (fileExtension === '.csv') {
        // For CSV files, we don't support patch-only mode yet
        if (patchOnly) {
          return sendError(res, 400, {
            message: "CSV patching is not supported yet. Please use Excel format.",
            toastMessage: "CSV patching is not supported yet. Please use Excel format.",
            errors: [{ code: 'UNSUPPORTED_PATCH_MODE' }]
          });
        }
        importResult = await importBillsFromCSV(tempFilePath, validVendorList);
      } else if (fileExtension === '.xlsx' || fileExtension === '.xls') {
        // For Excel files, pass the patchOnly flag
        importResult = await importBillsFromExcel(tempFilePath, validVendorList, patchOnly);
      } else {
        throw new Error("Unsupported file format");
      }
    } finally {
      // Clean up temp file regardless of success or failure
      if (fs.existsSync(tempFilePath)) {
        fs.unlinkSync(tempFilePath);
      }
    }

    // Check for non-existent vendors if validation was not skipped
    if (!skipVendorValidation && importResult.nonExistentVendors && importResult.nonExistentVendors.length > 0) {
      const totalVendors = vendorNos.length;
      const invalidVendors = importResult.nonExistentVendors.map(v => v.vendorName || v.vendorNo);
      const uniqueInvalidVendors = [...new Set(invalidVendors)];

      return sendSuccess(res, 202, {
        message: "Import completed with warnings - some vendors not found in the vendor master",
        toastMessage: `Import completed but ${uniqueInvalidVendors.length} vendor(s) were skipped`,
        data: {
          summary: {
            inserted: resolveImportCount(importResult.inserted),
            updated: resolveImportCount(importResult.updated),
            skipped: importResult.nonExistentVendors.length,
            totalVendors,
            validVendors: validVendorNames.length,
            invalidVendors: uniqueInvalidVendors.length
          }
        },
        meta: {
          nonExistentVendors: uniqueInvalidVendors,
          skippedRows: importResult.nonExistentVendors.map(v => ({
            rowNumber: v.rowNumber,
            srNo: v.srNo,
            vendorName: v.vendorName || 'Unknown',
            vendorNo: v.vendorNo
          }))
        },
        errors: [{ code: 'VENDOR_NOT_FOUND', count: uniqueInvalidVendors.length }]
      });
    }

    // Check for already existing bills
    if (importResult.alreadyExistingBills && importResult.alreadyExistingBills.length > 0) {
      return sendSuccess(res, 202, {
        message: "Some bills already exist in the database. Please use the PATCH endpoint instead.",
        toastMessage: `${importResult.alreadyExistingBills.length} bill(s) already exist. Use update option instead`,
        data: {
          summary: {
            inserted: resolveImportCount(importResult.inserted),
            updated: resolveImportCount(importResult.updated),
            alreadyExisting: importResult.alreadyExistingBills.length,
            totalProcessed: importResult.totalProcessed
          }
        },
        meta: {
          existingBills: importResult.alreadyExistingBills.map(bill => ({
            srNo: bill.srNo,
            _id: bill._id,
            vendorName: bill.vendorName || 'Unknown',
            rowNumber: bill.rowNumber
          })),
          recommendation: "To update these bills, please use the PATCH endpoint: POST /billdownload/patch-bills",
          vendorValidation: skipVendorValidation ? 'skipped' : 'enabled',
          mode: patchOnly ? 'patch-only' : 'normal'
        },
        errors: [{ code: 'BILL_ALREADY_EXISTS', count: importResult.alreadyExistingBills.length }]
      });
    }

    // Return success response with clearer formatting info
    const insertedCount = resolveImportCount(importResult.inserted);
    const updatedCount = resolveImportCount(importResult.updated);
    const skippedCount = resolveImportCount(importResult.skipped);
    const errorCount = resolveImportCount(importResult.errors);

    return sendSuccess(res, 200, {
      message: importResult.message || `Successfully processed ${importResult.totalProcessed || 0} bills`,
      toastMessage: `Successfully imported ${insertedCount + updatedCount} bill(s)`,
      data: {
        summary: {
          inserted: insertedCount,
          updated: updatedCount,
          skipped: skippedCount,
          errors: errorCount,
          total: importResult.totalProcessed || insertedCount + updatedCount + skippedCount
        },
        records: {
          inserted: Array.isArray(importResult.inserted) ? importResult.inserted.map(bill => {
            const srNoStr = String(bill.srNo || '');
            return {
              _id: bill._id,
              srNo: srNoStr,
              excelSrNo: bill.excelSrNo || srNoStr,
              formattedCorrectly: srNoStr.startsWith('2425')
            };
          }) : [],
          updated: Array.isArray(importResult.updated) ? importResult.updated.map(bill => {
            const srNoStr = String(bill.srNo || '');
            return {
              _id: bill._id,
              srNo: srNoStr,
              excelSrNo: bill.excelSrNo || srNoStr,
              formattedCorrectly: srNoStr.startsWith('2425')
            };
          }) : []
        }
      },
      meta: {
        vendorValidation: skipVendorValidation ? 'skipped' : 'enabled',
        mode: patchOnly ? 'patch-only' : 'normal'
      }
    });
  } catch (error) {
    console.error('Import error:', error);
    return sendError(res, 400, {
      message: error.message || "Failed to import bills",
      toastMessage: "Failed to import bills. Please check the file format and try again",
      errors: [{ message: error.message }]
    });
  }
};
// Function to patch bills from Excel/CSV without creating new records
const patchBillsFromExcel = async (req, res) => {
  try {
    await runUpload(req, res);
    if (!req.files || !req.files.length) {
      return sendError(res, 400, {
        message: "No file uploaded",
        toastMessage: "Please select a file to upload",
        errors: [{ code: 'NO_FILE' }]
      });
    }

    /*
     * The team decides which columns may be written, and it arrived as a
     * query parameter the caller supplies - so anyone could pass
     * ?team=accounts and write the Accounts columns. The claim is now only
     * honoured when the caller actually holds a role that maps to it;
     * otherwise their own role decides, exactly as if they had claimed
     * nothing. Same defect class as the send-to guard.
     */
    const heldRoles = asRoles(req.user?.role);
    const claimed = req.query.team;
    let teamName =
      claimed && (heldRoles.includes(claimed) || isAdminRole(req.user?.role))
        ? claimed
        : null;

    // If no team is specified in the query, determine from user role if available
    if (!teamName && req.user && req.user.role) {
      // Map user roles to teams
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

      teamName = roleToTeam[primaryRole(req.user.role)];
    }

    // Admin users can bypass team restrictions
    const isAdmin = req.user && isAdminRole(req.user.role);
    if (isAdmin) {
      teamName = null; // Allow all fields
    }

    const uploadedFile = req.files[0];
    const tempDir = os.tmpdir();
    const tempFilePath = path.join(tempDir, uploadedFile.originalname);

    fs.writeFileSync(tempFilePath, uploadedFile.buffer);

    // Call the patch logic with team name
    // The role drives the Home-tab filter; the user drives region scoping and
    // the wording of the result messages.
    const patchRole = heldRoles.includes(claimed) ? claimed : primaryRole(req.user?.role);
    const patchResult = await patchBillsFromExcelFile(tempFilePath, teamName, patchRole, req.user);

    if (fs.existsSync(tempFilePath)) {
      fs.unlinkSync(tempFilePath);
    }

    // If any rows were skipped or errors occurred, return error
    if ((patchResult.skipped && patchResult.skipped > 0) || (patchResult.errors && patchResult.errors.length > 0)) {
      return sendError(res, 400, {
        message: teamName
          ? `Patch process complete with errors or skipped rows for ${teamName}`
          : 'Patch process complete with errors or skipped rows (unrestricted)',
        toastMessage: `Update failed. ${patchResult.skipped || 0} row(s) skipped due to errors`,
        data: patchResult,
        errors: [{ code: 'PATCH_INCOMPLETE', skipped: patchResult.skipped || 0 }]
      });
    }

    return sendSuccess(res, 200, {
      message: teamName
        ? `Patch process complete for ${teamName}`
        : 'Patch process complete (unrestricted)',
      toastMessage: `Successfully updated ${patchResult.updated} bill(s)`,
      data: patchResult
    });
  } catch (error) {
    console.error('Patch error:', error);
    return sendError(res, 400, {
      message: error.message || "Failed to patch bills",
      toastMessage: "Failed to update bills. Please check the file format and try again",
      errors: [{ message: error.message }]
    });
  }
};

// Function to import all vendor data from Excel/CSV
const importVendors = async (req, res) => {
  try {
    await runUpload(req, res);

    if (!req.files || !req.files.length) {
      return sendError(res, 400, {
        message: "No file uploaded",
        toastMessage: "Please select a file to upload",
        errors: [{ code: 'NO_FILE' }]
      });
    }

    const uploadedFile = req.files[0];
    const tempDir = os.tmpdir();
    const tempFilePath = path.join(tempDir, uploadedFile.originalname);

    // Check file extension
    const fileExtension = path.extname(uploadedFile.originalname).toLowerCase();
    if (fileExtension !== '.xlsx' && fileExtension !== '.xls') {
      return sendError(res, 400, {
        message: "Only Excel files (.xlsx, .xls) are allowed for vendor import",
        toastMessage: "Please upload an Excel file (.xlsx or .xls)",
        errors: [{ code: 'INVALID_FILE_TYPE', received: fileExtension }]
      });
    }

    fs.writeFileSync(tempFilePath, uploadedFile.buffer);

    // Validate required columns
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(tempFilePath);
    const worksheet = workbook.getWorksheet(1);
    const headerRow = worksheet.getRow(1);
    const headers = [];
    headerRow.eachCell((cell) => {
      headers.push((cell.value || '').toString().trim());
    });

    const requiredHeaders = ['Vendor No', 'Vendor Name', 'PAN Status', '206AB Compliance', "Email IDs", "Phone No"];
    const missingHeaders = requiredHeaders.filter(h => !headers.includes(h));
    if (missingHeaders.length > 0) {
      if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
      return sendError(res, 400, {
        message: `Missing required columns: ${missingHeaders.join(', ')}`,
        toastMessage: `Excel file is missing required columns: ${missingHeaders.join(', ')}`,
        data: {
          missingHeaders,
          foundHeaders: headers
        },
        errors: [{ code: 'MISSING_HEADERS', missingHeaders }]
      });
    }

    const importResult = await insertVendorsFromExcel(tempFilePath);

    if (fs.existsSync(tempFilePath)) {
      fs.unlinkSync(tempFilePath);
    }

    // If any rows were skipped or errors occurred, return error
    if ((importResult.skipped && importResult.skipped > 0) || (importResult.errors && importResult.errors.length > 0)) {
      return sendError(res, 400, {
        message: 'Vendor import completed with errors or skipped rows',
        toastMessage: `Vendor import completed with ${importResult.errors?.length || 0} error(s)`,
        data: importResult,
        errors: [{ code: 'IMPORT_INCOMPLETE', skipped: importResult.skipped || 0 }]
      });
    }

    return sendSuccess(res, 200, {
      message: 'Vendor import process complete',
      toastMessage: `Successfully imported ${importResult.inserted} vendor(s)`,
      data: importResult
    });
  } catch (error) {
    console.error('Vendor import error:', error);
    return sendError(res, 400, {
      message: 'Error importing vendors',
      toastMessage: 'Failed to import vendors. Please check the file format and try again',
      errors: [{ message: error.message }]
    });
  }
};

// Function to update only compliance and PAN status for vendors
const updateVendors = async (req, res) => {
  try {
    await runUpload(req, res);

    if (!req.files || !req.files.length) {
      return sendError(res, 400, {
        message: "No file uploaded",
        toastMessage: "Please select a file to upload",
        errors: [{ code: 'NO_FILE' }]
      });
    }

    const uploadedFile = req.files[0];
    const tempDir = os.tmpdir();
    const tempFilePath = path.join(tempDir, uploadedFile.originalname);

    // Check file extension
    const fileExtension = path.extname(uploadedFile.originalname).toLowerCase();
    if (fileExtension !== '.xlsx' && fileExtension !== '.xls') {
      return sendError(res, 400, {
        message: "Only Excel files (.xlsx, .xls) are allowed for vendor import",
        toastMessage: "Please upload an Excel file (.xlsx or .xls)",
        errors: [{ code: 'INVALID_FILE_TYPE', received: fileExtension }]
      });
    }

    fs.writeFileSync(tempFilePath, uploadedFile.buffer);

    // Validate required columns
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(tempFilePath);
    const worksheet = workbook.getWorksheet(1);
    const headerRow = worksheet.getRow(1);
    const headers = [];
    headerRow.eachCell((cell) => {
      headers.push((cell.value || '').toString().trim());
    });

    const requiredHeaders = ['Vendor No'];
    const missingHeaders = requiredHeaders.filter(h => !headers.includes(h));
    if (missingHeaders.length > 0) {
      if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
      return sendError(res, 400, {
        message: `Missing required columns: ${missingHeaders.join(', ')}`,
        toastMessage: `Excel file is missing required columns: ${missingHeaders.join(', ')}`,
        data: {
          missingHeaders,
          foundHeaders: headers
        },
        errors: [{ code: 'MISSING_HEADERS', missingHeaders }]
      });
    }

    const updateResult = await updateVendorComplianceFromExcel(tempFilePath);

    if (fs.existsSync(tempFilePath)) {
      fs.unlinkSync(tempFilePath);
    }

    // If any errors occurred, return with error details
    if (updateResult.errors && updateResult.errors.length > 0) {
      return sendError(res, 400, {
        message: updateResult.summaryMessage || 'Vendor compliance update completed with errors',
        toastMessage: `Vendor compliance update completed with ${updateResult.errors.length} error(s)`,
        data: {
          updated: updateResult.updated,
          skipped: updateResult.skipped,
          errors: updateResult.errors,
          referenceOptions: updateResult.referenceOptions
        },
        errors: [{ code: 'UPDATE_INCOMPLETE', count: updateResult.errors.length }]
      });
    }

    // If no vendors were updated (but no errors), return warning
    if (updateResult.updated === 0) {
      return sendError(res, 400, {
        message: updateResult.summaryMessage || 'No vendors were updated',
        toastMessage: 'No vendors were updated. Please check vendor numbers',
        data: {
          updated: updateResult.updated,
          skipped: updateResult.skipped,
          errors: updateResult.errors,
          referenceOptions: updateResult.referenceOptions
        },
        errors: [{ code: 'NO_UPDATES' }]
      });
    }

    // Success - vendors were updated with no errors
    return sendSuccess(res, 200, {
      message: updateResult.summaryMessage || 'Vendor compliance update process complete',
      toastMessage: `Successfully updated ${updateResult.updated} vendor(s)`,
      data: {
        updated: updateResult.updated,
        skipped: updateResult.skipped,
        referenceOptions: updateResult.referenceOptions
      }
    });
  } catch (error) {
    console.error('Vendor compliance update error:', error);
    return sendError(res, 400, {
      message: 'Error updating vendor compliance',
      toastMessage: 'Failed to update vendor compliance. Please check the file format and try again',
      errors: [{ message: error.message }]
    });
  }
};

export default {
  generateReport,
  importBills,
  patchBillsFromExcel,
  importVendors,
  updateVendors
  // fixBillSerialNumbers,
  // bulkFixSerialNumbers
};
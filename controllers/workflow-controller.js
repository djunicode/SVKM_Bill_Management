//test commit
import Bill from "../models/bill-model.js";
import mongoose from "mongoose";
import WorkFlowFinal from "../models/workflow-final-model.js";
import User from "../models/user-model.js";
/* 
@Krishna
Fields not covered currently:(Check Logic and update if needed)

Proforma Invoice Details:
proformaInvNo
proformaInvDate
proformaInvAmt
proformaInvRecdAtSite
proformaInvRecdBy

Tax Invoice Details:
taxInvNo
taxInvDate
taxInvAmt
taxInvRecdAtSite
taxInvRecdBy

PO Details:
poNo
poDate
poAmt

Advance Payment:
advanceDate
advanceAmt
advancePercentage
advRequestEnteredBy

MIGO Details:
migoDetails.date
migoDetails.no
migoDetails.amount
migoDetails.doneBy
migoDetails.dateGiven

COP/SES/IT/Approval:
qsMeasurementCheck.dateGiven
vendorFinalInv.name, vendorFinalInv.dateGiven
qsCOP.name, qsCOP.dateGiven
copDetails.date, copDetails.amount
sesDetails.no, sesDetails.amount, sesDetails.date, sesDetails.doneBy
itDept.name, itDept.dateGiven, itDept.dateReceived
approvalDetails.directorApproval.dateGiven, dateReceived
approvalDetails.remarksPimoMumbai

Accounts/Payment:
accountsDept.invBookingChecking
accountsDept.paymentInstructions
accountsDept.remarksForPayInstructions
accountsDept.f110Identification
accountsDept.paymentDate
accountsDept.hardCopy
accountsDept.accountsIdentification
accountsDept.paymentAmt
accountsDept.status (except for auto-Paid on paymentDate)

Returned/Received Dates:
invReturnedToSite
accountsDept.returnedToPimo
accountsDept.receivedBack
pimoMumbai.dateReceived
pimoMumbai.dateReceivedFromIT
pimoMumbai.dateReceivedFromPIMO
accountsDept.dateReceived
qsMumbai.dateGiven (partially covered)
siteOfficeDispatch.dateGiven (partially covered)

Other:
attachment, attachmentType
compliance206AB
panStatus
region
vendor, vendorNo, vendorName, gstNumber
department
remarksByQSTeam (partially covered)
remarks (partially covered)
*/

export const changeBatchWorkflowState = async (req, res) => {
  try {
    const { fromUser, toUser, billIds, action, remarks } = req.body;

    // Determine sender details: Prefer req.body, fallback to req.user (Access Token)
    let fromId = fromUser?.id;
    let fromName = fromUser?.name;
    let fromRoles = fromUser?.role;

    if (req.user) {
      if (!fromId) fromId = req.user.id;
      if (!fromName) fromName = req.user.name;
      if (!fromRoles) fromRoles = req.user.role;
    }

    const { id: toId, name: toName, role: toRoles } = toUser || {};

    const fromRoleArray = Array.isArray(fromRoles) ? fromRoles : (fromRoles ? [fromRoles] : []);
    const toRoleArray = Array.isArray(toRoles) ? toRoles : (toRoles ? [toRoles] : []);

    if (
      (!fromId || !fromName || fromRoleArray.length === 0) || // Ensure we have sender details
      !toUser ||
      !billIds ||
      !Array.isArray(billIds) ||
      billIds.length === 0 ||
      !action
    ) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields (fromUser/token, toUser) or billIds must be a non-empty array",
      });
    }

    // Results tracking
    const results = {
      success: [],
      failed: [],
    };

    for (const billId of billIds) {
      try {
        const billFound = await Bill.findById(billId)
          .populate("natureOfWork")
          .populate("region")
          .populate("currency")
          .populate({
            path: "vendor",
            populate: [
              { path: "PANStatus", model: "PanStatusMaster" },
              { path: "complianceStatus", model: "ComplianceMaster" },
            ],
          });

        if (!billFound) {
          results.failed.push({
            billId,
            message: "Bill not found",
          });
          continue;
        }

        if (billFound.siteStatus === "rejected") {
          results.failed.push({
            billId,
            message: "Bill is already rejected",
          });
          continue;
        }

        const lastWorkflow = await WorkFlowFinal.findOne({ billId }).sort({
          createdAt: -1,
        });

        // Create new workflow record
        let newWorkflow = await WorkFlowFinal.create({
          fromUser: {
            id: fromId,
            name: fromName,
            role: fromRoleArray[0],
          },
          toUser: {
            id: toId ? toId : null,
            name: toName,
            role: toRoleArray[0],
          },
          billId,
          action,
          remarks,
          duration: lastWorkflow ? new Date() - lastWorkflow.createdAt : 0,
        });

        newWorkflow = await newWorkflow.populate([
          { path: "fromUser.id", select: "name role department" },
          { path: "toUser.id", select: "name role department" },
        ]);

        const now = new Date();
        let billWorkflow = null;

        // Site team transitions
        if (
          fromRoleArray.includes("site_team") &&
          (toRoleArray.includes("quality_engineer") ||
            toRoleArray.includes("qs_measurement") ||
            toRoleArray.includes("qs_cop") ||
            toRoleArray.includes("site_dispatch_team") ||
            toRoleArray.includes("site_architect") ||
            toRoleArray.includes("site_incharge") ||
            toRoleArray.includes("site_engineer") ||
            toRoleArray.includes("migo_entry") ||
            toRoleArray.includes("migo_entry_return"))
        ) {
          let setObj = {
            maxCount: 1,
            currentCount: 1,
          };

          if (toRoleArray.includes("quality_engineer")) {
            // TODO - if check not needed then remove it
            if (billFound.natureOfWork?.natureOfWork == "Service") {
              results.failed.push({
                billId,
                message:
                  "Service bill cannot be forwarded to Quality Inspector",
              });
              continue;
            } else {

              setObj["qualityEngineer.dateGiven"] = now;
              setObj["qualityEngineer.name"] = toName;
            }
          } else if (toRoleArray.includes("qs_measurement")) {

            setObj["qsInspection.dateGiven"] = now;
            setObj["qsInspection.name"] = toName;
            setObj["maxCount"] = Math.max(billFound.maxCount, 1);
            setObj["currentCount"] = 1;
          } else if (toRoleArray.includes("qs_cop")) {

            setObj["qsCOP.dateGiven"] = now;
            setObj["qsCOP.name"] = toName;
            setObj["maxCount"] = Math.max(billFound.maxCount, 1);
            setObj["currentCount"] = 1;
          } else if (toRoleArray.includes("migo_entry")) {

            setObj["migoDetails.dateGiven"] = now;
            setObj["migoDetails.name"] = fromName;
          } else if (toRoleArray.includes("migo_entry_return")) {

            setObj["invReturnedToSite"] = now;
            setObj["invReturnedToSiteName"] = fromName;
          } else if (toRoleArray.includes("site_engineer")) {
            setObj["siteEngineer.dateGiven"] = now;
            setObj["siteEngineer.name"] = toName;
          } else if (toRoleArray.includes("site_architect")) {
            if (billFound.natureOfWork?.natureOfWork == "Material") {
              results.failed.push({
                billId,
                message: "Material bills cannot be forwarded to Site Architect",
              });
              continue;
            } else {
              setObj["architect.dateGiven"] = now;
              setObj["architect.name"] = toName;
            }
          } else if (toRoleArray.includes("site_incharge")) {

            setObj["siteIncharge.dateGiven"] = now;
            setObj["siteIncharge.name"] = toName;
          } else if (toRoleArray.includes("site_dispatch_team")) {
            setObj["siteOfficeDispatch.name"] = toName;
            setObj["siteOfficeDispatch.dateGiven"] = now;
          }

          billWorkflow = await Bill.findByIdAndUpdate(
            billId,
            { $set: setObj },
            { new: true }
          );
        }

        //site officer to pimo mumbai
        else if (
          fromRoleArray.includes("site_team") &&
          toRoleArray.includes("pimo_mumbai")
        ) {

          billWorkflow = await Bill.findByIdAndUpdate(
            billId,
            {
              $set: {
                currentCount: 3,
                maxCount: Math.max(billFound.maxCount, 3),
                "pimoMumbai.dateGiven": now,
                "pimoMumbai.namePIMO": toName ? toName : "",
                siteStatus: "hold",
              },
            },
            { new: true }
          );
        }

        // todo: milan bhai , -> for qsteam , please send site_cop , measure and pimo_cop
        else if (
          fromRoleArray.includes("qs_team") &&
          (toRoleArray.includes("site_cop") ||
            toRoleArray.includes("measure") ||
            toRoleArray.includes("pimo_cop"))
        ) {
          if (toRoleArray.includes("site_cop")) {
            billWorkflow = await Bill.findByIdAndUpdate(
              billId,
              {
                $set: {
                  currentCount: 1,
                  maxCount: Math.max(billFound.maxCount, 1),
                  // todo: ask milan amount ka kya scene , coz amount bhejna padega usko
                  "copDetails.dateReturned": new Date(),
                  "copDetails.nameReturned": fromName,
                },
              },
              { new: true }
            );
          } else if (toRoleArray.includes("measure")) {
            billWorkflow = await Bill.findByIdAndUpdate(
              billId,
              {
                $set: {
                  currentCount: 1,
                  maxCount: Math.max(billFound.maxCount, 1),
                  "vendorFinalInv.name": toName,
                  "vendorFinalInv.dateGiven": new Date(),
                  // "qsMeasurementCheck.dateGiven": new Date(),
                },
              },
              { new: true }
            );
          } else if (toRoleArray.includes("pimo_cop")) {
            billWorkflow = await Bill.findByIdAndUpdate(
              billId,
              {
                $set: {
                  currentCount: 3,
                  maxCount: Math.max(billFound.maxCount, 3),
                  "pimoMumbai.dateReturnedFromQs": new Date(),
                  "pimoMumbai.nameReturnedFromQs": fromName,
                },
              },
              { new: true }
            );
          }
        }

        // PIMO Mumbai to QS Mumbai
        else if (
          fromRoleArray.includes("pimo_mumbai") &&
          (toRoleArray.includes("qs_mumbai") ||
            toRoleArray.includes("it_team") ||
            toRoleArray.includes("ses_team") ||
            toRoleArray.includes("it_return_team") ||
            toRoleArray.includes("ses_return_team") ||
            toRoleArray.includes("trustee") ||
            toRoleArray.includes("accounts_department"))
        ) {
          if (toRoleArray.includes("qs_mumbai")) {
            // Keep currentCount at 3 so bill stays on PIMO home tab
            billWorkflow = await Bill.findByIdAndUpdate(
              billId,
              {
                $set: {
                  currentCount: 3,
                  maxCount: Math.max(billFound.maxCount, 3),
                  "qsMumbai.dateGiven": now,
                  "qsMumbai.name": toName,
                },
                $push: {
                  "workflowState.history": {
                    state: "QS_Mumbai",
                    timestamp: now,
                    actor: toName,
                    comments: remarks,
                    action: "forward",
                  },
                },
              },
              {
                new: true,
              }
            );
          } else if (toRoleArray.includes("it_team")) {
            billWorkflow = await Bill.findByIdAndUpdate(
              billId,
              {
                $set: {
                  currentCount: 3,
                  maxCount: Math.max(billFound.maxCount, 3),
                  "itDept.dateGiven": now,
                  "itDept.name": toName,
                },
                //   remove $ push
                $push: {
                  "workflowState.history": {
                    state: "QS_Mumbai",
                    timestamp: now,
                    actor: toName,
                    comments: remarks,
                    action: "forward",
                  },
                },
              },
              {
                new: true,
              }
            );
          } else if (toRoleArray.includes("ses_team")) {
            billWorkflow = await Bill.findByIdAndUpdate(
              billId,
              {
                $set: {
                  currentCount: 3,
                  maxCount: Math.max(billFound.maxCount, 3),
                  "sesDetails.dateGiven": now,
                  "sesDetails.name": fromName,
                },
              },
              {
                new: true,
              }
            );
          } else if (toRoleArray.includes("it_return_team")) {
            billWorkflow = await Bill.findByIdAndUpdate(
              billId,
              {
                $set: {
                  currentCount: 3,
                  maxCount: Math.max(billFound.maxCount, 3),
                  "pimoMumbai.dateReceivedFromIT": now,
                  "pimoMumbai.nameReceivedFromIT": fromName,
                },
              },
              {
                new: true,
              }
            );
          } else if (toRoleArray.includes("ses_return_team")) {
            billWorkflow = await Bill.findByIdAndUpdate(
              billId,
              {
                $set: {
                  currentCount: 3,
                  maxCount: Math.max(billFound.maxCount, 3),
                  "pimoMumbai.dateReturnedFromSES": now,
                  "pimoMumbai.nameReturnedFromSES": fromName,
                },
              },
              {
                new: true,
              }
            );
          } else if (toRoleArray.includes("trustee")) {
            // Keep currentCount at 3 so bill stays on PIMO home tab
            billWorkflow = await Bill.findByIdAndUpdate(
              billId,
              {
                $set: {
                  currentCount: 3,
                  maxCount: Math.max(billFound.maxCount, 3),
                  "approvalDetails.directorApproval.dateGiven": now,
                },
              },
              {
                new: true,
              }
            );
          } else if (toRoleArray.includes("accounts_department")) {
            billWorkflow = await Bill.findByIdAndUpdate(
              billId,
              {
                $set: {
                  currentCount: 5,
                  maxCount: Math.max(billFound.maxCount, 5),
                  "accountsDept.dateGiven": now,
                },
              },
              {
                new: true,
              }
            );
          }
        } else if (
          fromRoleArray.includes("trustee") &&
          toRoleArray.includes("pimo_mumbai")
        ) {
          billWorkflow = await Bill.findByIdAndUpdate(
            billId,
            {
              $set: {
                currentCount: 3,
                maxCount: Math.max(billFound.maxCount, 3),
                "pimoMumbai.dateReturnedFromDirector": now,
                "approvalDetails.remarksPimoMumbai": remarks,
              },
            },
            {
              new: true,
            }
          );
        } else if (
          fromRoleArray.includes("accounts") &&
          toRoleArray.includes("booking_checking")
        ) {
          billWorkflow = await Bill.findByIdAndUpdate(
            billId,
            {
              $set: {
                currentCount: 5,
                maxCount: Math.max(billFound.maxCount, 5),
                "accountsDept.invBookingChecking": now,
              },
            },
            {
              new: true,
            }
          );
        }

        /////////////////////////////////////
        else {
          // If no matching workflow condition was found
          results.failed.push({
            billId,
            message: "No matching workflow transition rule found",
          });
          continue;
        }

        if (billWorkflow) {
          results.success.push({
            billId,
            workflow: newWorkflow,
          });
        } else {
          results.failed.push({
            billId,
            message: "Failed to update bill workflow",
          });
        }
      } catch (error) {
        console.error(`Error processing bill ${billId}:`, error);
        results.failed.push({
          billId,
          message: error.message,
        });
      }
    }

    // Return final result
    return res.status(200).json({
      success: true,
      message: `Processed ${billIds.length} bills: ${results.success.length} successful, ${results.failed.length} failed`,
      data: {
        successful: results.success,
        failed: results.failed,
      },
    });
  } catch (error) {
    console.error("Batch workflow state change error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to process batch workflow state change",
      error: error.message,
    });
  }
};

export const getBillHistory = async (req, res) => {
  try {
    const { id } = req.params;

    const workflows = await WorkFlowFinal.find({
      billId: id,
    })
      .populate("fromUser", "name role department")
      .populate("toUser", "name role department")
      .sort({ createdAt: -1 });

    return res.status(200).json({
      success: true,
      message: "Workflow history fetched successfully",
      data: workflows,
    });
  } catch (error) {
    console.error("Error fetching workflow history:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch workflow history",
      error: error.message,
    });
  }
};

export const getWorkflowStats = async (req, res) => {
  try {
    // Get counts of bills in each state
    const stateCounts = await Bill.aggregate([
      {
        $group: {
          _id: "$workflowState.currentState",
          count: { $sum: 1 },
        },
      },
      {
        $sort: { _id: 1 },
      },
    ]);

    // Transform into a more usable format
    const stateCountsFormatted = {};
    stateCounts.forEach((item) => {
      stateCountsFormatted[item._id || "Unassigned"] = item.count;
    });

    // Get average time spent in each state
    const avgTimeInState = await WorkFlowFinal.aggregate([
      {
        $group: {
          _id: { billId: "$billId", state: "$newState" },
          enteredAt: { $min: "$timestamp" },
          exitedAt: { $max: "$timestamp" },
        },
      },
      {
        $match: {
          exitedAt: { $ne: null },
        },
      },
      {
        $project: {
          _id: 0,
          billId: "$_id.billId",
          state: "$_id.state",
          durationMs: { $subtract: ["$exitedAt", "$enteredAt"] },
        },
      },
      {
        $group: {
          _id: "$state",
          avgDurationMs: { $avg: "$durationMs" },
          maxDurationMs: { $max: "$durationMs" },
          minDurationMs: { $min: "$durationMs" },
          count: { $sum: 1 },
        },
      },
      {
        $project: {
          state: "$_id",
          avgDurationHours: { $divide: ["$avgDurationMs", 3600000] },
          maxDurationHours: { $divide: ["$maxDurationMs", 3600000] },
          minDurationHours: { $divide: ["$minDurationMs", 3600000] },
          count: 1,
          _id: 0,
        },
      },
      {
        $sort: { state: 1 },
      },
    ]);

    // Get recent activity
    const recentActivity = await WorkFlowFinal.find()
      .sort({ timestamp: -1 })
      .limit(10)
      .populate("billId", "srNo vendorName vendorNo amount currency")
      .populate("actor", "name role department");

    // Get rejection stats
    const rejectionStats = await WorkFlowFinal.aggregate([
      {
        $match: {
          actionType: "reject",
        },
      },
      {
        $group: {
          _id: "$previousState",
          count: { $sum: 1 },
        },
      },
      {
        $sort: { count: -1 },
      },
    ]);

    // Get bills stuck in a state for more than 7 days
    const oneWeekAgo = new Date();
    oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);

    const stuckBills = await Bill.aggregate([
      {
        $match: {
          "workflowState.lastUpdated": { $lt: oneWeekAgo },
          "workflowState.currentState": {
            $nin: ["Completed", "Rejected"],
          },
        },
      },
      {
        $group: {
          _id: "$workflowState.currentState",
          count: { $sum: 1 },
          bills: {
            $push: {
              id: "$_id",
              srNo: "$srNo",
              vendorName: "$vendorName",
              amount: "$amount",
              lastUpdated: "$workflowState.lastUpdated",
            },
          },
        },
      },
      {
        $project: {
          state: "$_id",
          count: 1,
          bills: { $slice: ["$bills", 5] }, // Limit to 5 examples per state
          _id: 0,
        },
      },
      {
        $sort: { count: -1 },
      },
    ]);

    return res.status(200).json({
      success: true,
      data: {
        stateCounts: stateCountsFormatted,
        averageTimeInState: avgTimeInState,
        rejectionStats,
        recentActivity,
        stuckBills,
      },
    });
  } catch (error) {
    console.error("Workflow stats error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to get workflow statistics",
      error: error.message,
    });
  }
};

// Get workflow transitions for a specific bill
export const getBillWorkflowHistory = async (req, res) => {
  try {
    const { billId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(billId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid bill ID format",
      });
    }

    const transitions = await WorkFlowFinal.find({ billId })
      .sort({ timestamp: 1 })
      .populate("actor", "name role department");

    // Get the bill details
    const bill = await Bill.findById(billId).select(
      "srNo vendorName vendorNo amount currency workflowState"
    );

    if (!bill) {
      return res.status(404).json({
        success: false,
        message: "Bill not found",
      });
    }

    // Calculate time spent in each state
    const stateTimeMap = {};
    let previousTransition = null;

    transitions.forEach((transition) => {
      if (previousTransition) {
        const state = previousTransition.newState;
        const startTime = previousTransition.timestamp;
        const endTime = transition.timestamp;
        const durationMs = endTime - startTime;

        if (!stateTimeMap[state]) {
          stateTimeMap[state] = 0;
        }

        stateTimeMap[state] += durationMs;
      }

      previousTransition = transition;
    });

    // If the bill is still in a state, calculate time from last transition to now
    if (previousTransition) {
      const state = previousTransition.newState;
      const startTime = previousTransition.timestamp;
      const endTime = new Date();
      const durationMs = endTime - startTime;

      if (!stateTimeMap[state]) {
        stateTimeMap[state] = 0;
      }

      stateTimeMap[state] += durationMs;
    }

    // Convert milliseconds to hours
    const stateTimeHours = {};
    Object.keys(stateTimeMap).forEach((state) => {
      stateTimeHours[state] = (stateTimeMap[state] / 3600000).toFixed(2);
    });

    return res.status(200).json({
      success: true,
      data: {
        bill,
        transitions,
        timeInStates: stateTimeHours,
        totalTransitions: transitions.length,
      },
    });
  } catch (error) {
    console.error("Bill workflow history error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to get bill workflow history",
      error: error.message,
    });
  }
};

// Get all transitions performed by a specific user
export const getUserWorkflowActivity = async (req, res) => {
  try {
    const { userId } = req.params;
    const { limit = 50 } = req.query;

    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid user ID format",
      });
    }

    const transitions = await WorkFlowFinal.find({ actor: userId })
      .sort({ timestamp: -1 })
      .limit(parseInt(limit))
      .populate("billId", "srNo vendorName vendorNo amount currency");

    // Group actions by type
    const actionSummary = {
      forward: 0,
      backward: 0,
      reject: 0,
      initial: 0,
    };

    transitions.forEach((transition) => {
      actionSummary[transition.actionType]++;
    });

    return res.status(200).json({
      success: true,
      data: {
        transitions,
        actionSummary,
        totalTransitions: transitions.length,
      },
    });
  } catch (error) {
    console.error("User workflow activity error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to get user workflow activity",
      error: error.message,
    });
  }
};

// Get performance metrics for all roles
export const getRolePerformanceMetrics = async (req, res) => {
  try {
    // Get average processing time by role
    const roleMetrics = await WorkFlowFinal.aggregate([
      {
        $match: {
          actionType: "forward", // Only look at forward movements
        },
      },
      {
        $group: {
          _id: {
            actor: "$actor",
            actorRole: "$actorRole",
            actorName: "$actorName",
            state: "$previousState",
          },
          count: { $sum: 1 },
          avgResponseTimeMs: {
            $avg: {
              $subtract: ["$timestamp", "$createdAt"],
            },
          },
        },
      },
      {
        $group: {
          _id: "$_id.actorRole",
          actors: {
            $push: {
              id: "$_id.actor",
              name: "$_id.actorName",
              state: "$_id.state",
              count: "$count",
              avgResponseTimeHours: {
                $divide: ["$avgResponseTimeMs", 3600000],
              },
            },
          },
          totalCount: { $sum: "$count" },
          avgOverallResponseTimeMs: { $avg: "$avgResponseTimeMs" },
        },
      },
      {
        $project: {
          role: "$_id",
          actors: 1,
          totalCount: 1,
          avgOverallResponseTimeHours: {
            $divide: ["$avgOverallResponseTimeMs", 3600000],
          },
          _id: 0,
        },
      },
      {
        $sort: { role: 1 },
      },
    ]);

    return res.status(200).json({
      success: true,
      data: roleMetrics,
    });
  } catch (error) {
    console.error("Role performance metrics error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to get role performance metrics",
      error: error.message,
    });
  }
};

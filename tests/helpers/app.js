/**
 * Test app.
 *
 * index.js calls connectDB() and app.listen() at import time, so it cannot be
 * imported into a test process. This mirrors its middleware and route wiring
 * without either. Keep in step with index.js when routes are added there.
 */
import express from "express";
import cookieParser from "cookie-parser";

import billRoute from "../../routes/bill-route.js";
import userRoute from "../../routes/user-route.js";
import vendorRoute from "../../routes/vendor-route.js";
import statRoute from "../../routes/stat-routes.js";
import excelRoute from "../../routes/excel-route.js";
import authRoute from "../../routes/auth-route.js";
import roleRoute from "../../routes/role-route.js";
import reportRoutes from "../../routes/report-route.js";
import workflowRoute from "../../routes/workflow-routes.js";
import masterRoute from "../../routes/master-routes.js";
import sentBillsRoute from "../../routes/sentBills-routes.js";
import kpiRoute from "../../routes/kpi-route.js";

export const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());

  app.use("/auth", authRoute);
  app.use("/bill", billRoute);
  app.use("/users", userRoute);
  app.use("/vendors", vendorRoute);
  app.use("/stats", statRoute);
  app.use("/excel", excelRoute);
  app.use("/role", roleRoute);
  app.use("/sentBills", sentBillsRoute);
  app.use("/master", masterRoute);
  app.use("/api/reports", reportRoutes);
  app.use("/workflow", workflowRoute);
  app.use("/kpi", kpiRoute);

  // Mirrors the error handler in index.js
  app.use((err, req, res, _next) => {
    if (err.name === "MulterError") {
      return res
        .status(400)
        .json({ success: false, message: `File upload error: ${err.message}` });
    }
    res.status(500).json({ success: false, message: err.message });
  });

  return app;
};

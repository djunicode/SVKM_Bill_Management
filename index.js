import cookieParser from "cookie-parser";
import "dotenv/config";
import express from "express";
import cors from "cors";
import { connectDB } from "./utils/db.js";
import swaggerUi from "swagger-ui-express";
import swaggerSpec from "./utils/swagger.js";

const app = express();
const port = process.env.PORT || 5000;

// Connect to database
connectDB();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(
    cors({
        credentials: true,
        origin: ['http://localhost:5173', 'https://svkm-bill-tracking-frontend-1.vercel.app'],
        methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
    })
);

import billRoute from "./routes/bill-route.js";
import userRoute from "./routes/user-route.js";
import vendorRoute from "./routes/vendor-route.js";
import statRoute from "./routes/stat-routes.js";
import excelRoute from "./routes/excel-route.js";
import authRoute from "./routes/auth-route.js";
import roleRoute from "./routes/role-route.js";
import reportRoutes from "./routes/report-route.js";
import worflowRoute from "./routes/workflow-routes.js";
import masterRoute from "./routes/master-routes.js";
import sentBillsRoute from "./routes/sentBills-routes.js";
import kpiRoute from "./routes/kpi-route.js";
import formRoute from "./routes/form-route.js";

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
app.use("/workflow", worflowRoute);
app.use("/kpi", kpiRoute);
app.use("/forms", formRoute); // forms repository (29.09, reply Q2)


// Swagger docs route
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));
app.use("/health", (req, res) => {
    res.status(200).json({
        success: true,
        message: "OK",
    });
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error(err.stack);

    if (err.name === "MulterError") {
        return res.status(400).json({
            success: false,
            message: `File upload error: ${err.message}`,
        });
    }

    res.status(500).json({
        success: false,
        message: err.message || "Internal server error",
        error: process.env.NODE_ENV === "production" ? undefined : err.stack,
    });
});

app.listen(port, () => {
    console.log(`Server is listening on port ${port}`);
});

export default app;

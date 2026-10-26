import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import rateLimit from "express-rate-limit";

import { connectToMongoDB, disconnectFromMongoDB } from "./config/db.js";

import usersRoutes from "./routes/users.routes.js";
import authRoutes from "./routes/auth.routes.js";

const app = express();

const PORT = Number(process.env.PORT) || 5000;

const allowedOrigins = (process.env.CLIENT_URL || "http://localhost:5173")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

// Security headers
app.use(helmet());

// CORS configuration
app.use(
  cors({
    origin(origin, callback) {
      // Allow requests without Origin, such as server-to-server requests.
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      return callback(new Error("Origin not allowed by CORS."));
    },
    credentials: true,
    methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);

// Request parsing
app.use(express.json({ limit: "20kb" }));
app.use(express.urlencoded({ extended: true, limit: "20kb" }));
app.use(cookieParser());

// General API rate limit
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 200,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many requests. Please try again later.",
  },
});

// Stricter limit for authentication-related requests
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many authentication requests. Try again later.",
  },
});

// Health check
app.get("/health", (req, res) => {
  res.status(200).json({
    success: true,
    message: "API is running.",
    timestamp: new Date().toISOString(),
  });
});

// API routes
app.use("/api/v1", apiLimiter);
app.use("/api/v1/auth", authLimiter, authRoutes);
app.use("/api/v1/users", usersRoutes);

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `Route not found: ${req.method} ${req.originalUrl}`,
  });
});

// Central error handler
app.use((error, req, res, next) => {
  if (res.headersSent) {
    return next(error);
  }

  if (error.message === "Origin not allowed by CORS.") {
    return res.status(403).json({
      success: false,
      message: "This origin is not allowed.",
    });
  }

  console.error("API error:", error);

  return res.status(error.status || 500).json({
    success: false,
    message:
      process.env.NODE_ENV === "production"
        ? "An unexpected server error occurred."
        : error.message || "Internal server error.",
  });
});

let server;
let isShuttingDown = false;

async function startServer() {
  try {
    await connectToMongoDB();

    server = app.listen(PORT, () => {
      console.log(`Server running at http://localhost:${PORT}`);
      console.log(`Health check: http://localhost:${PORT}/health`);
    });
  } catch (error) {
    console.error("Failed to start server:", error.message);
    process.exitCode = 1;
  }
}

async function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`${signal} received. Shutting down gracefully...`);

  if (server) {
    await new Promise((resolve) => {
      server.close(resolve);
    });
  }

  try {
    await disconnectFromMongoDB();
  } catch (error) {
    console.error("Error closing MongoDB:", error.message);
    process.exitCode = 1;
  }

  process.exit();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

startServer();

export default app;

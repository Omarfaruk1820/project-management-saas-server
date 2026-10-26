import { connectToMongoDB } from "../config/db.js";

const BLOCKED_STATUSES = new Set([
  "disabled",
  "suspended",
  "banned",
  "deleted",
]);

const verifyUser = async (req, res, next) => {
  try {
    // verifyToken must run before this middleware.
    const firebaseUid = req.auth?.uid;

    if (!firebaseUid) {
      return res.status(401).json({
        success: false,
        message: "Authentication is required.",
      });
    }

    const db = await connectToMongoDB();

    const user = await db.collection("users").findOne({
      firebaseUid,
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User profile not found. Please sync your profile.",
      });
    }

    const status = String(user.status ?? "active").toLowerCase();

    if (BLOCKED_STATUSES.has(status)) {
      return res.status(403).json({
        success: false,
        message: "Your account is not allowed to access this resource.",
      });
    }

    // Database-backed application profile.
    req.user = user;

    return next();
  } catch (error) {
    return next(error);
  }
};

export default verifyUser;

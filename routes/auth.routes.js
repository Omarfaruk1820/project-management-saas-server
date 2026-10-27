import { Router } from "express";
import verifyToken from "../middleware/verifyToken.js";
import { connectToMongoDB } from "../config/db.js";

const router = Router();

// POST /api/v1/auth/session/logout
router.post("/session/logout", verifyToken, async (req, res, next) => {
  try {
    const uid = req.auth?.uid;

    if (!uid) {
      return res.status(401).json({
        success: false,
        code: "AUTH_TOKEN_INVALID",
        message: "Authenticated user ID was not found.",
      });
    }

    const db = await connectToMongoDB();
    const now = new Date();

    const result = await db.collection("users").updateOne(
      {
        firebaseUid: uid,
        status: "active",
      },
      {
        $set: {
          lastLogoutAt: now,
          updatedAt: now,
        },
      },
    );

    if (result.matchedCount === 0) {
      // Firebase sign-out is still handled by the frontend.
      // There is no active MongoDB profile to update.
      return res.status(200).json({
        success: true,
        message: "No active profile found; no logout timestamp was recorded.",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Logout session recorded successfully.",
    });
  } catch (error) {
    return next(error);
  }
});

export default router;

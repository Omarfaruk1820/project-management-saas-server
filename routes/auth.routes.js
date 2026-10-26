import { Router } from "express";

import { connectToMongoDB } from "../config/db.js";
import verifyToken from "../middleware/verifyToken.js";
import verifyUser from "../middleware/verifyUser.js";

const router = Router();

const getUsersCollection = async () => {
  const db = await connectToMongoDB();
  return db.collection("users");
};

// POST /api/v1/auth/sync
// Create or update the authenticated user's profile.
router.post("/sync", verifyToken, async (req, res, next) => {
  try {
    const decodedUser = req.auth;

    const usersCollection = await getUsersCollection();
    const now = new Date();

    // Allow users to update only their own basic profile fields.
    const name =
      typeof req.body?.name === "string"
        ? req.body.name.trim().slice(0, 100)
        : decodedUser.name || "";

    const photoURL =
      typeof req.body?.photoURL === "string"
        ? req.body.photoURL.trim().slice(0, 2048)
        : decodedUser.picture || "";

    const userProfile = {
      firebaseUid: decodedUser.uid,
      name,
      email: decodedUser.email || "",
      photoURL,
      emailVerified: decodedUser.email_verified ?? false,
      provider: decodedUser.firebase?.sign_in_provider || "unknown",
      updatedAt: now,
    };

    await usersCollection.updateOne(
      { firebaseUid: decodedUser.uid },
      {
        $set: userProfile,
        $setOnInsert: {
          role: "user",
          status: "active",
          onboardingCompleted: false,
          preferences: {
            theme: "system",
            language: "en",
            notifications: true,
          },
          createdAt: now,
          lastLoginAt: now,
          lastLogoutAt: null,
          lastSeenAt: now,
        },
      },
      { upsert: true },
    );

    const savedUser = await usersCollection.findOne(
      { firebaseUid: decodedUser.uid },
      { projection: { _id: 0 } },
    );

    return res.status(200).json({
      success: true,
      message: "User profile synchronized successfully.",
      user: savedUser,
    });
  } catch (error) {
    return next(error);
  }
});

// GET /api/v1/auth/me
// Return the authenticated user's database profile.
router.get("/me", verifyToken, verifyUser, (req, res) => {
  return res.status(200).json({
    success: true,
    message: "User profile fetched successfully.",
    user: req.user,
  });
});

// POST /api/v1/auth/session/logout
// Call this endpoint BEFORE Firebase signOut().
router.post("/session/logout", verifyToken, async (req, res, next) => {
  try {
    const usersCollection = await getUsersCollection();
    const now = new Date();

    await usersCollection.updateOne(
      { firebaseUid: req.auth.uid },
      {
        $set: {
          lastLogoutAt: now,
          updatedAt: now,
        },
      },
    );

    return res.status(200).json({
      success: true,
      message: "Logout event recorded.",
    });
  } catch (error) {
    return next(error);
  }
});

export default router;

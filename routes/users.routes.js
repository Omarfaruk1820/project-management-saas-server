import { Router } from "express";
import { connectToMongoDB } from "../config/db.js";
import verifyToken from "../middleware/verifyToken.js";
import verifyUser from "../middleware/verifyUser.js";

const router = Router();

const getUsersCollection = async () => {
  const db = await connectToMongoDB();
  return db.collection("users");
};

const getProvider = (auth) => {
  const provider = auth?.firebase?.sign_in_provider;

  if (provider === "google.com") return "google.com";
  if (provider === "password") return "password";
  if (provider === "github.com") return "github.com";

  return provider || "unknown";
};

const getSafeUser = (user) => {
  if (!user) return null;

  return {
    firebaseUid: user.firebaseUid,
    name: user.name,
    email: user.email,
    photoURL: user.photoURL,
    emailVerified: user.emailVerified,
    provider: user.provider,
    role: user.role,
    status: user.status,
    onboardingCompleted: user.onboardingCompleted,
    preferences: user.preferences,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    lastLoginAt: user.lastLoginAt,
    lastSeenAt: user.lastSeenAt,
  };
};

// POST /api/v1/users/sync
// Create or update the MongoDB profile after Firebase signup/login.


router.post("/sync", verifyToken, async (req, res, next) => {
  try {
    const uid = req.auth?.uid;

    if (!uid) {
      return res.status(401).json({
        success: false,
        message: "A valid Firebase user ID is required.",
      });
    }

    const users = await getUsersCollection();
    const now = new Date();

    // Use verified Firebase token claims for identity.
    const email = req.auth.email || "";
    const emailVerified = Boolean(req.auth.email_verified);
    const provider =
      req.auth.firebase?.sign_in_provider || "unknown";

    const requestedName =
      typeof req.body?.name === "string"
        ? req.body.name.trim().slice(0, 100)
        : "";

    const requestedPhotoURL =
      typeof req.body?.photoURL === "string"
        ? req.body.photoURL.trim().slice(0, 2048)
        : "";

    const existingUser = await users.findOne(
      { firebaseUid: uid },
      {
        projection: {
          name: 1,
          photoURL: 1,
          status: 1,
        },
      },
    );

    // Existing accounts must be active.
    if (existingUser && existingUser.status !== "active") {
      return res.status(403).json({
        success: false,
        message: "This account is not active.",
      });
    }

    // Keep existing profile values when Firebase sends empty values.
    const name =
      requestedName ||
      existingUser?.name ||
      email.split("@")[0] ||
      "User";

    const photoURL =
      requestedPhotoURL || existingUser?.photoURL || "";

    const profile = {
      firebaseUid: uid,
      email,
      emailVerified,
      provider,
      name,
      photoURL,
      updatedAt: now,
      lastLoginAt: now,
      lastSeenAt: now,
    };

    const result = await users.updateOne(
      { firebaseUid: uid },
      {
        $set: profile,
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
          lastLogoutAt: null,
        },
      },
      { upsert: true },
    );

    const savedUser = await users.findOne(
      { firebaseUid: uid },
      {
        projection: {
          _id: 0,
          firebaseUid: 1,
          name: 1,
          email: 1,
          photoURL: 1,
          emailVerified: 1,
          provider: 1,
          role: 1,
          status: 1,
          onboardingCompleted: 1,
          preferences: 1,
          createdAt: 1,
          updatedAt: 1,
          lastLoginAt: 1,
          lastSeenAt: 1,
        },
      },
    );

    if (!savedUser) {
      throw new Error("User profile was not found after saving.");
    }

    const created = result.upsertedCount === 1;

    return res.status(created ? 201 : 200).json({
      success: true,
      message: created
        ? "User profile created successfully."
        : "User profile synced successfully.",
      user: savedUser,
    });
  } catch (error) {
    console.error("[users/sync] Profile sync failed:", error.message);
    return next(error);
  }
});


// GET /api/v1/users/me
router.get("/me", verifyToken, verifyUser, (req, res) => {
  if (!req.user) {
    return res.status(404).json({
      success: false,
      message: "User profile not found. Please sync your account first.",
    });
  }

  return res.status(200).json({
    success: true,
    user: getSafeUser(req.user),
  });
});

// PATCH /api/v1/users/me
// Only allow users to edit their own name and profile photo.
router.patch("/me", verifyToken, verifyUser, async (req, res, next) => {
  try {
    const updates = {};
    const { name, photoURL } = req.body || {};

    if (name !== undefined) {
      if (
        typeof name !== "string" ||
        !name.trim() ||
        name.trim().length > 100
      ) {
        return res.status(400).json({
          success: false,
          message: "Name must be a non-empty string of at most 100 characters.",
        });
      }

      updates.name = name.trim();
    }

    if (photoURL !== undefined) {
      if (
        typeof photoURL !== "string" ||
        photoURL.length > 2048 ||
        (photoURL !== "" && !/^https?:\/\//i.test(photoURL))
      ) {
        return res.status(400).json({
          success: false,
          message: "Photo URL must be a valid HTTP or HTTPS URL.",
        });
      }

      updates.photoURL = photoURL.trim();
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({
        success: false,
        message: "Provide name or photoURL to update.",
      });
    }

    updates.updatedAt = new Date();

    const users = await getUsersCollection();

    await users.updateOne({ firebaseUid: req.auth.uid }, { $set: updates });

    const user = await users.findOne(
      { firebaseUid: req.auth.uid },
      { projection: { _id: 0 } },
    );

    return res.status(200).json({
      success: true,
      message: "Profile updated successfully.",
      user: getSafeUser(user),
    });
  } catch (error) {
    return next(error);
  }
});

// PATCH /api/v1/users/me/preferences
router.patch(
  "/me/preferences",
  verifyToken,
  verifyUser,
  async (req, res, next) => {
    try {
      const { theme, language, notifications } = req.body || {};
      const updates = {};

      if (theme !== undefined) {
        if (!["light", "dark", "system"].includes(theme)) {
          return res.status(400).json({
            success: false,
            message: "Theme must be light, dark, or system.",
          });
        }

        updates["preferences.theme"] = theme;
      }

      if (language !== undefined) {
        if (
          typeof language !== "string" ||
          !/^[a-zA-Z]{2,3}(-[a-zA-Z]{2,8})?$/.test(language)
        ) {
          return res.status(400).json({
            success: false,
            message: "Please provide a valid language code.",
          });
        }

        updates["preferences.language"] = language;
      }

      if (notifications !== undefined) {
        if (typeof notifications !== "boolean") {
          return res.status(400).json({
            success: false,
            message: "Notifications must be true or false.",
          });
        }

        updates["preferences.notifications"] = notifications;
      }

      if (Object.keys(updates).length === 0) {
        return res.status(400).json({
          success: false,
          message: "Provide at least one preference to update.",
        });
      }

      updates.updatedAt = new Date();

      const users = await getUsersCollection();

      const result = await users.updateOne(
        { firebaseUid: req.auth.uid, status: "active" },
        { $set: updates },
      );

      if (!result.matchedCount) {
        return res.status(404).json({
          success: false,
          message: "User profile not found or inactive.",
        });
      }

      const user = await users.findOne(
        { firebaseUid: req.auth.uid },
        { projection: { _id: 0 } },
      );

      return res.status(200).json({
        success: true,
        message: "Preferences updated successfully.",
        user: getSafeUser(user),
      });
    } catch (error) {
      return next(error);
    }
  },
);

// PATCH /api/v1/users/me/onboarding
router.patch(
  "/me/onboarding",
  verifyToken,
  verifyUser,
  async (req, res, next) => {
    try {
      if (req.body?.completed !== true) {
        return res.status(400).json({
          success: false,
          message: "Send { completed: true } to finish onboarding.",
        });
      }

      const users = await getUsersCollection();

      const result = await users.updateOne(
        { firebaseUid: req.auth.uid, status: "active" },
        {
          $set: {
            onboardingCompleted: true,
            updatedAt: new Date(),
          },
        },
      );

      if (!result.matchedCount) {
        return res.status(404).json({
          success: false,
          message: "User profile not found or inactive.",
        });
      }

      const user = await users.findOne(
        { firebaseUid: req.auth.uid },
        { projection: { _id: 0 } },
      );

      return res.status(200).json({
        success: true,
        message: "Onboarding completed successfully.",
        user: getSafeUser(user),
      });
    } catch (error) {
      return next(error);
    }
  },
);

export default router;

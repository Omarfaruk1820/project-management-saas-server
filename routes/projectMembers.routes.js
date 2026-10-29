import { Router } from "express";
import { ObjectId } from "mongodb";

import { connectToMongoDB } from "../config/db.js";
import verifyToken from "../middleware/verifyToken.js";
import verifyUser from "../middleware/verifyUser.js";

const router = Router();

const MEMBER_ROLES = ["manager", "member"];

router.use(verifyToken, verifyUser);

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function uid(req) {
  if (typeof req.auth?.uid !== "string" || !req.auth.uid.trim()) {
    throw httpError(401, "Authentication required.");
  }
  return req.auth.uid;
}

function projectObjectId(value) {
  if (typeof value !== "string" || !/^[a-fA-F0-9]{24}$/.test(value)) {
    throw httpError(400, "Invalid project ID.");
  }
  return new ObjectId(value);
}

function roleValue(value) {
  if (typeof value !== "string" || !MEMBER_ROLES.includes(value)) {
    throw httpError(400, "Role must be manager or member.");
  }
  return value;
}

async function getProjectAccess(db, projectId, userId) {
  const project = await db.collection("projects").findOne({ _id: projectId });

  if (!project) throw httpError(404, "Project not found.");

  if (project.ownerId === userId) {
    return { project, role: "owner" };
  }

  const membership = await db.collection("projectMembers").findOne({
    projectId,
    userId,
    status: "active",
  });

  if (!membership) {
    throw httpError(403, "You do not have access to this project.");
  }

  if (!MEMBER_ROLES.includes(membership.role)) {
    throw httpError(403, "Invalid project membership role.");
  }

  return { project, role: membership.role };
}

function requireOwner(role) {
  if (role !== "owner") {
    throw httpError(403, "Only the project owner can manage members.");
  }
}

function normalizeEmail(value) {
  if (typeof value !== "string") return "";
  return value.trim().toLowerCase();
}

// GET /api/v1/project-members/:projectId
router.get("/:projectId", async (req, res, next) => {
  try {
    const userId = uid(req);
    const projectId = projectObjectId(req.params.projectId);
    const db = await connectToMongoDB();

    const { project } = await getProjectAccess(db, projectId, userId);

    const [ownerUser, members] = await Promise.all([
      db.collection("users").findOne(
        { firebaseUid: project.ownerId },
        {
          projection: {
            _id: 0,
            firebaseUid: 1,
            email: 1,
            name: 1,
            photoURL: 1,
          },
        },
      ),
      db
        .collection("projectMembers")
        .find(
          { projectId, status: "active" },
          {
            projection: {
              _id: 1,
              userId: 1,
              email: 1,
              name: 1,
              photoURL: 1,
              role: 1,
              status: 1,
              joinedAt: 1,
              createdAt: 1,
            },
          },
        )
        .sort({ joinedAt: 1 })
        .toArray(),
    ]);

    const owner = {
      userId: project.ownerId,
      email: ownerUser?.email ?? null,
      name: ownerUser?.name ?? null,
      photoURL: ownerUser?.photoURL ?? null,
      role: "owner",
      status: "active",
    };

    return res.status(200).json({
      success: true,
      data: {
        owner,
        members,
        totalMembers: members.length + 1,
      },
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/project-members/:projectId
// Body: { "email": "member@example.com", "role": "member" }
router.post("/:projectId", async (req, res, next) => {
  try {
    const userId = uid(req);
    const projectId = projectObjectId(req.params.projectId);
    const db = await connectToMongoDB();

    const { project, role: requesterRole } = await getProjectAccess(
      db,
      projectId,
      userId,
    );

    requireOwner(requesterRole);

    const email = normalizeEmail(req.body?.email);
    const role = roleValue(req.body?.role);

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw httpError(400, "A valid email address is required.");
    }

    const target = await db.collection("users").findOne({ email });

    if (!target?.firebaseUid) {
      throw httpError(404, "No registered user was found with this email.");
    }

    if (target.status && target.status !== "active") {
      throw httpError(403, "This user account is not active.");
    }

    if (target.firebaseUid === project.ownerId) {
      throw httpError(400, "The project owner cannot be added as a member.");
    }

    const now = new Date();

    // Requires a unique index on { projectId, userId }.
    const result = await db.collection("projectMembers").updateOne(
      {
        projectId,
        userId: target.firebaseUid,
      },
      {
        $set: {
          email: target.email,
          name: target.name ?? "",
          photoURL: target.photoURL ?? null,
          role,
          status: "active",
          addedBy: userId,
          joinedAt: now,
          updatedAt: now,
        },
        $setOnInsert: {
          projectId,
          userId: target.firebaseUid,
          createdAt: now,
        },
      },
      { upsert: true },
    );

    const member = await db.collection("projectMembers").findOne({
      projectId,
      userId: target.firebaseUid,
    });

    return res.status(result.upsertedCount ? 201 : 200).json({
      success: true,
      message: result.upsertedCount
        ? "Project member added successfully."
        : "Project membership activated or updated successfully.",
      data: { member },
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({
        success: false,
        message: "This user already has a membership record.",
      });
    }
    next(error);
  }
});

// PATCH /api/v1/project-members/:projectId/:userId
// Body: { "role": "manager" }
router.patch("/:projectId/:userId", async (req, res, next) => {
  try {
    const currentUserId = uid(req);
    const projectId = projectObjectId(req.params.projectId);
    const targetUserId = req.params.userId;

    if (typeof targetUserId !== "string" || !targetUserId.trim()) {
      throw httpError(400, "Invalid member user ID.");
    }

    const db = await connectToMongoDB();
    const { project, role: requesterRole } = await getProjectAccess(
      db,
      projectId,
      currentUserId,
    );

    requireOwner(requesterRole);

    if (targetUserId === project.ownerId) {
      throw httpError(400, "The project owner's role cannot be changed.");
    }

    const role = roleValue(req.body?.role);

    const result = await db.collection("projectMembers").updateOne(
      {
        projectId,
        userId: targetUserId,
        status: "active",
      },
      { $set: { role, updatedAt: new Date() } },
    );

    if (!result.matchedCount) {
      throw httpError(404, "Active project member not found.");
    }

    const member = await db.collection("projectMembers").findOne({
      projectId,
      userId: targetUserId,
      status: "active",
    });

    return res.status(200).json({
      success: true,
      message: "Member role updated successfully.",
      data: { member },
    });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/v1/project-members/:projectId/:userId
router.delete("/:projectId/:userId", async (req, res, next) => {
  try {
    const currentUserId = uid(req);
    const projectId = projectObjectId(req.params.projectId);
    const targetUserId = req.params.userId;

    if (typeof targetUserId !== "string" || !targetUserId.trim()) {
      throw httpError(400, "Invalid member user ID.");
    }

    const db = await connectToMongoDB();
    const { project, role: requesterRole } = await getProjectAccess(
      db,
      projectId,
      currentUserId,
    );

    requireOwner(requesterRole);

    if (targetUserId === project.ownerId) {
      throw httpError(400, "The project owner cannot be removed.");
    }

    const now = new Date();

    const result = await db.collection("projectMembers").updateOne(
      {
        projectId,
        userId: targetUserId,
        status: "active",
      },
      {
        $set: {
          status: "removed",
          removedAt: now,
          removedBy: currentUserId,
          updatedAt: now,
        },
      },
    );

    if (!result.matchedCount) {
      throw httpError(404, "Active project member not found.");
    }

    return res.status(200).json({
      success: true,
      message: "Project member removed successfully.",
    });
  } catch (error) {
    next(error);
  }
});

export default router;

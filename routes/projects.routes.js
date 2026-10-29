import { Router } from "express";
import { ObjectId } from "mongodb";

import { connectToMongoDB } from "../config/db.js";
import verifyToken from "../middleware/verifyToken.js";
import verifyUser from "../middleware/verifyUser.js";

const router = Router();

const PROJECT_STATUSES = ["active", "on-hold", "completed"];
const ALLOWED_FIELDS = ["title", "description", "status"];
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;

router.use(verifyToken, verifyUser);

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function getUserId(req) {
  const uid = req.auth?.uid;
  if (typeof uid !== "string" || !uid.trim()) {
    throw httpError(401, "Authentication required.");
  }
  return uid;
}

function parseId(value, field = "project ID") {
  if (typeof value !== "string" || !/^[a-fA-F0-9]{24}$/.test(value)) {
    throw httpError(400, `Invalid ${field}.`);
  }
  return new ObjectId(value);
}

function parsePagination(query) {
  function integer(value, fallback, name, max) {
    if (value === undefined) return fallback;
    if (
      typeof value !== "string" ||
      !/^[1-9]\d*$/.test(value) ||
      !Number.isSafeInteger(Number(value)) ||
      Number(value) > max
    ) {
      throw httpError(400, `Invalid ${name} parameter.`);
    }
    return Number(value);
  }

  const page = integer(query.page, 1, "page", Number.MAX_SAFE_INTEGER);
  const limit = integer(query.limit, DEFAULT_LIMIT, "limit", MAX_LIMIT);
  const skip = (page - 1) * limit;

  if (!Number.isSafeInteger(skip)) {
    throw httpError(400, "Pagination value is too large.");
  }

  return { page, limit, skip };
}

function validateInput(body, partial = false) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw httpError(400, "Request body must be a JSON object.");
  }

  const keys = Object.keys(body);
  if (!keys.length) throw httpError(400, "At least one field is required.");

  if (keys.some((key) => !ALLOWED_FIELDS.includes(key))) {
    throw httpError(400, "Request contains unsupported fields.");
  }

  if (!partial && !Object.hasOwn(body, "title")) {
    throw httpError(400, "Project title is required.");
  }

  const updates = {};

  if (Object.hasOwn(body, "title")) {
    if (typeof body.title !== "string") {
      throw httpError(400, "Title must be a string.");
    }
    const title = body.title.trim();
    if (title.length < 1 || title.length > 120) {
      throw httpError(400, "Title must contain 1-120 characters.");
    }
    updates.title = title;
  }

  if (Object.hasOwn(body, "description")) {
    if (typeof body.description !== "string") {
      throw httpError(400, "Description must be a string.");
    }
    const description = body.description.trim();
    if (description.length > 2000) {
      throw httpError(400, "Description cannot exceed 2000 characters.");
    }
    updates.description = description;
  }

  if (Object.hasOwn(body, "status")) {
    if (!PROJECT_STATUSES.includes(body.status)) {
      throw httpError(
        400,
        `Status must be one of: ${PROJECT_STATUSES.join(", ")}.`,
      );
    }
    updates.status = body.status;
  }

  return updates;
}

async function getProjectAccess(db, projectId, userId) {
  const project = await db.collection("projects").findOne({
    _id: projectId,
  });

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

  return { project, role: membership.role };
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// POST /api/v1/projects
router.post("/", async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const input = validateInput(req.body);
    const db = await connectToMongoDB();
    const now = new Date();

    const project = {
      ...input,
      ownerId: userId,
      status: input.status ?? "active",
      createdAt: now,
      updatedAt: now,
    };

    const result = await db.collection("projects").insertOne(project);

    return res.status(201).json({
      success: true,
      message: "Project created successfully.",
      data: { project: { ...project, _id: result.insertedId } },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/projects?page=1&limit=10&status=active&search=website
router.get("/", async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const { page, limit, skip } = parsePagination(req.query);
    const db = await connectToMongoDB();

    const filter = {};

    if (req.query.status !== undefined) {
      if (
        typeof req.query.status !== "string" ||
        !PROJECT_STATUSES.includes(req.query.status)
      ) {
        throw httpError(400, "Invalid status filter.");
      }
      filter.status = req.query.status;
    }

    if (req.query.search !== undefined) {
      if (
        typeof req.query.search !== "string" ||
        req.query.search.trim().length > 100
      ) {
        throw httpError(400, "Invalid search parameter.");
      }

      const search = req.query.search.trim();
      if (search) {
        filter.title = {
          $regex: escapeRegex(search),
          $options: "i",
        };
      }
    }

    const memberships = await db
      .collection("projectMembers")
      .find({ userId, status: "active" }, { projection: { projectId: 1 } })
      .toArray();

    const memberProjectIds = memberships
      .map((item) => item.projectId)
      .filter((id) => id instanceof ObjectId);

    filter.$or = [{ ownerId: userId }, { _id: { $in: memberProjectIds } }];

    const collection = db.collection("projects");

    const [projects, total] = await Promise.all([
      collection
        .find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip(skip)
        .limit(limit)
        .toArray(),
      collection.countDocuments(filter),
    ]);

    return res.status(200).json({
      success: true,
      data: { projects },
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/projects/:id
router.get("/:id", async (req, res, next) => {
  try {
    const db = await connectToMongoDB();
    const projectId = parseId(req.params.id);
    const userId = getUserId(req);

    const { project, role } = await getProjectAccess(db, projectId, userId);

    return res.status(200).json({
      success: true,
      data: { project, role },
    });
  } catch (error) {
    next(error);
  }
});

// PATCH /api/v1/projects/:id (owner or manager)
router.patch("/:id", async (req, res, next) => {
  try {
    const db = await connectToMongoDB();
    const projectId = parseId(req.params.id);
    const userId = getUserId(req);
    const updates = validateInput(req.body, true);

    const { role } = await getProjectAccess(db, projectId, userId);
    if (!["owner", "manager"].includes(role)) {
      throw httpError(403, "You cannot edit this project.");
    }

    await db
      .collection("projects")
      .updateOne(
        { _id: projectId },
        { $set: { ...updates, updatedAt: new Date() } },
      );

    const project = await db.collection("projects").findOne({
      _id: projectId,
    });

    return res.status(200).json({
      success: true,
      message: "Project updated successfully.",
      data: { project },
    });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/v1/projects/:id (owner only)
router.delete("/:id", async (req, res, next) => {
  try {
    const db = await connectToMongoDB();
    const projectId = parseId(req.params.id);
    const userId = getUserId(req);

    const { project, role } = await getProjectAccess(db, projectId, userId);
    if (role !== "owner") {
      throw httpError(403, "Only the project owner can delete this project.");
    }

    // Remove related records to avoid orphaned data.
    await db.collection("tasks").deleteMany({ projectId });
    await db.collection("projectMembers").deleteMany({ projectId });
    await db.collection("projects").deleteOne({
      _id: projectId,
      ownerId: userId,
    });

    return res.status(200).json({
      success: true,
      message: "Project and related records deleted successfully.",
      data: { deletedProjectId: project._id },
    });
  } catch (error) {
    next(error);
  }
});

export default router;

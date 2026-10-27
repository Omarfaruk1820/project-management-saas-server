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

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function getOwnerId(req) {
  const firebaseUid = req.auth?.uid;

  if (typeof firebaseUid !== "string" || !firebaseUid.trim()) {
    throw httpError(401, "Authentication required.");
  }

  return firebaseUid;
}

function parseProjectId(id) {
  if (typeof id !== "string" || !/^[a-fA-F0-9]{24}$/.test(id)) {
    throw httpError(400, "Invalid project ID.");
  }

  return new ObjectId(id);
}

function validateProjectInput(body, partial = false) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw httpError(400, "Request body must be a JSON object.");
  }

  const keys = Object.keys(body);

  if (keys.some((key) => !ALLOWED_FIELDS.includes(key))) {
    throw httpError(400, "Request contains unsupported fields.");
  }

  if (keys.length === 0) {
    throw httpError(400, "At least one project field is required.");
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
      throw httpError(400, "Title must be between 1 and 120 characters.");
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
    if (
      typeof body.status !== "string" ||
      !PROJECT_STATUSES.includes(body.status)
    ) {
      throw httpError(
        400,
        `Status must be one of: ${PROJECT_STATUSES.join(", ")}.`,
      );
    }

    updates.status = body.status;
  }

  return updates;
}

function parsePagination(query) {
  function parseInteger(value, fallback, name, max) {
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

  const page = parseInteger(query.page, 1, "page", Number.MAX_SAFE_INTEGER);

  const limit = parseInteger(query.limit, DEFAULT_LIMIT, "limit", MAX_LIMIT);

  const skip = (page - 1) * limit;

  if (!Number.isSafeInteger(skip)) {
    throw httpError(400, "Pagination value is too large.");
  }

  return { page, limit, skip };
}

// Verify Firebase token, then verify the MongoDB user profile.
router.use(verifyToken, verifyUser);

// POST /api/v1/projects
router.post("/", async (req, res, next) => {
  try {
    const ownerId = getOwnerId(req);
    const input = validateProjectInput(req.body);

    const db = await connectToMongoDB();
    const now = new Date();

    const project = {
      ...input,
      ownerId,
      status: input.status ?? "active",
      createdAt: now,
      updatedAt: now,
    };

    const result = await db.collection("projects").insertOne(project);

    return res.status(201).json({
      success: true,
      message: "Project created successfully.",
      data: {
        project: {
          ...project,
          _id: result.insertedId,
        },
      },
    });
  } catch (error) {
    return next(error);
  }
});

// GET /api/v1/projects?page=1&limit=10&status=active&search=website
router.get("/", async (req, res, next) => {
  try {
    const ownerId = getOwnerId(req);
    const { page, limit, skip } = parsePagination(req.query);

    const filter = { ownerId };

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
        const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

        filter.title = {
          $regex: escaped,
          $options: "i",
        };
      }
    }

    const db = await connectToMongoDB();
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
    return next(error);
  }
});

// GET /api/v1/projects/:id
router.get("/:id", async (req, res, next) => {
  try {
    const ownerId = getOwnerId(req);
    const _id = parseProjectId(req.params.id);

    const db = await connectToMongoDB();

    const project = await db.collection("projects").findOne({
      _id,
      ownerId,
    });

    if (!project) {
      throw httpError(404, "Project not found.");
    }

    return res.status(200).json({
      success: true,
      data: { project },
    });
  } catch (error) {
    return next(error);
  }
});

// PATCH /api/v1/projects/:id
router.patch("/:id", async (req, res, next) => {
  try {
    const ownerId = getOwnerId(req);
    const _id = parseProjectId(req.params.id);
    const updates = validateProjectInput(req.body, true);

    const db = await connectToMongoDB();
    const collection = db.collection("projects");

    const result = await collection.updateOne(
      { _id, ownerId },
      {
        $set: {
          ...updates,
          updatedAt: new Date(),
        },
      },
    );

    if (result.matchedCount === 0) {
      throw httpError(404, "Project not found.");
    }

    const project = await collection.findOne({ _id, ownerId });

    return res.status(200).json({
      success: true,
      message: "Project updated successfully.",
      data: { project },
    });
  } catch (error) {
    return next(error);
  }
});

// DELETE /api/v1/projects/:id
router.delete("/:id", async (req, res, next) => {
  try {
    const ownerId = getOwnerId(req);
    const _id = parseProjectId(req.params.id);

    const db = await connectToMongoDB();

    const result = await db.collection("projects").deleteOne({
      _id,
      ownerId,
    });

    if (result.deletedCount === 0) {
      throw httpError(404, "Project not found.");
    }

    return res.status(200).json({
      success: true,
      message: "Project deleted successfully.",
    });
  } catch (error) {
    return next(error);
  }
});

export default router;

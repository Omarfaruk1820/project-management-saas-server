import { Router } from "express";
import { ObjectId } from "mongodb";

import { connectToMongoDB } from "../config/db.js";
import verifyToken from "../middleware/verifyToken.js";
import verifyUser from "../middleware/verifyUser.js";

const router = Router();

const STATUSES = ["todo", "in-progress", "review", "done"];
const PRIORITIES = ["low", "medium", "high", "urgent"];
const CREATE_FIELDS = [
  "projectId",
  "title",
  "description",
  "status",
  "priority",
  "dueDate",
  "assigneeId",
  "labels",
];
const UPDATE_FIELDS = [
  "title",
  "description",
  "status",
  "priority",
  "dueDate",
  "assigneeId",
  "labels",
];
const MEMBER_EDIT_FIELDS = ["status", "description", "dueDate", "labels"];
const MAX_LIMIT = 100;

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

function objectId(value, name = "ID") {
  if (typeof value !== "string" || !/^[a-fA-F0-9]{24}$/.test(value)) {
    throw httpError(400, `Invalid ${name}.`);
  }
  return new ObjectId(value);
}

function bodyObject(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw httpError(400, "Request body must be a JSON object.");
  }
}

function allowed(body, fields) {
  const keys = Object.keys(body);
  if (!keys.length) throw httpError(400, "At least one field is required.");
  if (keys.some((key) => !fields.includes(key))) {
    throw httpError(400, "Request contains unsupported fields.");
  }
}

function titleValue(value) {
  if (typeof value !== "string")
    throw httpError(400, "Title must be a string.");
  const result = value.trim();
  if (!result || result.length > 160) {
    throw httpError(400, "Title must contain 1-160 characters.");
  }
  return result;
}

function descriptionValue(value) {
  if (typeof value !== "string") {
    throw httpError(400, "Description must be a string.");
  }
  const result = value.trim();
  if (result.length > 5000) {
    throw httpError(400, "Description cannot exceed 5000 characters.");
  }
  return result;
}

function enumValue(value, values, name) {
  if (typeof value !== "string" || !values.includes(value)) {
    throw httpError(400, `Invalid ${name}. Allowed: ${values.join(", ")}.`);
  }
  return value;
}

function dateValue(value) {
  if (value === null) return null;
  if (typeof value !== "string") throw httpError(400, "Invalid due date.");

  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const timestamp =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    );

  if (!dateOnly && !timestamp) {
    throw httpError(400, "Use YYYY-MM-DD or an ISO timestamp with timezone.");
  }

  const date = new Date(dateOnly ? `${value}T00:00:00.000Z` : value);
  if (Number.isNaN(date.getTime())) throw httpError(400, "Invalid due date.");

  if (dateOnly && date.toISOString().slice(0, 10) !== value) {
    throw httpError(400, "Invalid calendar date.");
  }
  return date;
}

function labelsValue(value) {
  if (!Array.isArray(value) || value.length > 10) {
    throw httpError(
      400,
      "Labels must be an array containing at most 10 labels.",
    );
  }

  const labels = value.map((label) => {
    if (typeof label !== "string")
      throw httpError(400, "Labels must be strings.");
    const item = label.trim();
    if (!item || item.length > 30) {
      throw httpError(400, "Each label must contain 1-30 characters.");
    }
    return item;
  });

  if (
    new Set(labels.map((label) => label.toLowerCase())).size !== labels.length
  ) {
    throw httpError(400, "Duplicate labels are not allowed.");
  }
  return labels;
}

function validateTaskBody(body, fields, creating = false) {
  bodyObject(body);
  allowed(body, fields);

  const result = {};

  if (creating && !Object.hasOwn(body, "title")) {
    throw httpError(400, "Task title is required.");
  }

  if (Object.hasOwn(body, "title")) result.title = titleValue(body.title);
  if (Object.hasOwn(body, "description")) {
    result.description = descriptionValue(body.description);
  }
  if (Object.hasOwn(body, "status")) {
    result.status = enumValue(body.status, STATUSES, "status");
  }
  if (Object.hasOwn(body, "priority")) {
    result.priority = enumValue(body.priority, PRIORITIES, "priority");
  }
  if (Object.hasOwn(body, "dueDate")) result.dueDate = dateValue(body.dueDate);
  if (Object.hasOwn(body, "labels")) result.labels = labelsValue(body.labels);

  if (Object.hasOwn(body, "assigneeId")) {
    if (body.assigneeId !== null && typeof body.assigneeId !== "string") {
      throw httpError(400, "assigneeId must be a user ID or null.");
    }
    if (typeof body.assigneeId === "string" && !body.assigneeId.trim()) {
      throw httpError(400, "assigneeId must be a user ID or null.");
    }
    result.assigneeId = body.assigneeId;
  }

  return result;
}

function pagination(query) {
  function number(value, fallback, name, max) {
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

  const page = number(query.page, 1, "page", Number.MAX_SAFE_INTEGER);
  const limit = number(query.limit, 10, "limit", MAX_LIMIT);
  const skip = (page - 1) * limit;
  if (!Number.isSafeInteger(skip))
    throw httpError(400, "Pagination is too large.");
  return { page, limit, skip };
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function getProjectAccess(db, projectId, userId) {
  const project = await db.collection("projects").findOne({ _id: projectId });
  if (!project) throw httpError(404, "Project not found.");

  if (project.ownerId === userId) return { project, role: "owner" };

  const member = await db.collection("projectMembers").findOne({
    projectId,
    userId,
    status: "active",
  });

  if (!member) throw httpError(403, "You do not have access to this project.");
  if (!["manager", "member"].includes(member.role)) {
    throw httpError(403, "Invalid project membership role.");
  }

  return { project, role: member.role };
}

async function validateAssignee(db, projectId, assigneeId) {
  if (assigneeId === null) return;

  const project = await db.collection("projects").findOne({ _id: projectId });
  if (!project) throw httpError(404, "Project not found.");

  if (assigneeId === project.ownerId) return;

  const member = await db.collection("projectMembers").findOne({
    projectId,
    userId: assigneeId,
    status: "active",
  });

  if (!member) {
    throw httpError(400, "Assignee must be an active member of this project.");
  }
}

function parseSearch(value) {
  if (value === undefined) return "";
  if (typeof value !== "string" || value.trim().length > 100) {
    throw httpError(400, "Invalid search parameter.");
  }
  return value.trim();
}

// POST /api/v1/tasks
router.post("/", async (req, res, next) => {
  try {
    const userId = uid(req);
    const input = validateTaskBody(req.body, CREATE_FIELDS, true);

    if (!Object.hasOwn(req.body, "projectId")) {
      throw httpError(400, "Project ID is required.");
    }

    const projectId = objectId(req.body.projectId, "project ID");
    const db = await connectToMongoDB();
    const { project } = await getProjectAccess(db, projectId, userId);

    if (input.assigneeId === undefined) input.assigneeId = null;
    await validateAssignee(db, projectId, input.assigneeId);

    const now = new Date();
    const task = {
      ...input,
      projectId,
      ownerId: project.ownerId,
      createdBy: userId,
      status: input.status ?? "todo",
      priority: input.priority ?? "medium",
      description: input.description ?? "",
      dueDate: input.dueDate ?? null,
      assigneeId: input.assigneeId,
      labels: input.labels ?? [],
      createdAt: now,
      updatedAt: now,
    };

    const result = await db.collection("tasks").insertOne(task);

    return res.status(201).json({
      success: true,
      message: "Task created successfully.",
      data: { task: { ...task, _id: result.insertedId } },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/tasks?projectId=...&page=1&limit=100&status=todo
router.get("/", async (req, res, next) => {
  try {
    const userId = uid(req);
    const projectId = objectId(req.query.projectId, "project ID");
    const { page, limit, skip } = pagination(req.query);
    const db = await connectToMongoDB();

    await getProjectAccess(db, projectId, userId);

    const filter = { projectId };

    if (req.query.status !== undefined) {
      filter.status = enumValue(req.query.status, STATUSES, "status");
    }
    if (req.query.priority !== undefined) {
      filter.priority = enumValue(req.query.priority, PRIORITIES, "priority");
    }
    if (req.query.assigneeId !== undefined) {
      if (typeof req.query.assigneeId !== "string") {
        throw httpError(400, "Invalid assignee filter.");
      }
      filter.assigneeId = req.query.assigneeId;
    }

    const search = parseSearch(req.query.search);
    if (search) {
      const regex = { $regex: escapeRegex(search), $options: "i" };
      filter.$or = [
        { title: regex },
        { description: regex },
        { labels: regex },
      ];
    }

    const collection = db.collection("tasks");
    const [tasks, total] = await Promise.all([
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
      data: { tasks },
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

// GET /api/v1/tasks/:id
router.get("/:id", async (req, res, next) => {
  try {
    const userId = uid(req);
    const taskId = objectId(req.params.id, "task ID");
    const db = await connectToMongoDB();
    const task = await db.collection("tasks").findOne({ _id: taskId });

    if (!task) throw httpError(404, "Task not found.");

    const { project } = await getProjectAccess(db, task.projectId, userId);

    // Preserve access to legacy tasks and return current project ownership.
    return res.status(200).json({
      success: true,
      data: {
        task: {
          ...task,
          ownerId: task.ownerId ?? project.ownerId,
        },
      },
    });
  } catch (error) {
    next(error);
  }
});

// PATCH /api/v1/tasks/:id
router.patch("/:id", async (req, res, next) => {
  try {
    const userId = uid(req);
    const taskId = objectId(req.params.id, "task ID");
    const db = await connectToMongoDB();
    const collection = db.collection("tasks");
    const task = await collection.findOne({ _id: taskId });

    if (!task) throw httpError(404, "Task not found.");

    const { project, role } = await getProjectAccess(
      db,
      task.projectId,
      userId,
    );

    let fields = UPDATE_FIELDS;
    if (role === "member") {
      if (task.assigneeId !== userId) {
        throw httpError(403, "Members can update only their assigned tasks.");
      }
      fields = MEMBER_EDIT_FIELDS;
    }

    const updates = validateTaskBody(req.body, fields);

    if (Object.hasOwn(updates, "assigneeId")) {
      await validateAssignee(db, task.projectId, updates.assigneeId);
    }

    // Ensure all new tasks retain the canonical project owner UID.
    updates.updatedAt = new Date();

    const result = await collection.updateOne(
      { _id: taskId, projectId: task.projectId },
      { $set: updates },
    );

    if (!result.matchedCount) throw httpError(404, "Task not found.");

    const updatedTask = await collection.findOne({ _id: taskId });

    return res.status(200).json({
      success: true,
      message: "Task updated successfully.",
      data: {
        task: {
          ...updatedTask,
          ownerId: updatedTask.ownerId ?? project.ownerId,
        },
      },
    });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/v1/tasks/:id (owner or manager)
router.delete("/:id", async (req, res, next) => {
  try {
    const userId = uid(req);
    const taskId = objectId(req.params.id, "task ID");
    const db = await connectToMongoDB();
    const collection = db.collection("tasks");
    const task = await collection.findOne({ _id: taskId });

    if (!task) throw httpError(404, "Task not found.");

    const { role } = await getProjectAccess(db, task.projectId, userId);
    if (!["owner", "manager"].includes(role)) {
      throw httpError(403, "You cannot delete this task.");
    }

    await collection.deleteOne({ _id: taskId, projectId: task.projectId });

    return res.status(200).json({
      success: true,
      message: "Task deleted successfully.",
      data: { deletedTaskId: taskId },
    });
  } catch (error) {
    next(error);
  }
});

export default router;

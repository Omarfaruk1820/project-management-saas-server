import "dotenv/config";
import { MongoClient } from "mongodb";

let client = null;
let database = null;
let connectionPromise = null;
let disconnectPromise = null;

function createMongoClient() {
  const { DB_USER, DB_PASS, DB_NAME } = process.env;

  if (!DB_USER || !DB_PASS || !DB_NAME) {
    throw new Error(
      "Missing DB_USER, DB_PASS, or DB_NAME environment variables.",
    );
  }

  const username = encodeURIComponent(DB_USER);
  const password = encodeURIComponent(DB_PASS);
  const databaseName = encodeURIComponent(DB_NAME);

  const uri =
    `mongodb+srv://${username}:${password}` +
    `@cluster0.g29mryf.mongodb.net/${databaseName}` +
    "?retryWrites=true&w=majority";

  return new MongoClient(uri, {
    maxPoolSize: 10,
    minPoolSize: 0,
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 10000,
    socketTimeoutMS: 45000,
  });
}

async function createDatabaseIndexes(db) {
  // Ensure each Firebase user has one MongoDB user document.
  await db.collection("users").createIndex(
    { firebaseUid: 1 },
    {
      unique: true,
      name: "unique_firebase_uid",
    },
  );

  // Efficiently list a user's projects in creation order.
  await db.collection("projects").createIndex(
    { ownerId: 1, createdAt: -1, _id: -1 },
    {
      name: "projects_owner_createdAt",
    },
  );
  await db
    .collection("tasks")
    .createIndex(
      { ownerId: 1, projectId: 1, createdAt: -1, _id: -1 },
      { name: "tasks_owner_project_createdAt" },
    );

  await db.collection("tasks").createIndex(
    {
      ownerId: 1,
      projectId: 1,
      status: 1,
      createdAt: -1,
      _id: -1,
    },
    { name: "tasks_owner_project_status_createdAt" },
  );

  await db.collection("tasks").createIndex(
    {
      ownerId: 1,
      projectId: 1,
      priority: 1,
      createdAt: -1,
      _id: -1,
    },
    { name: "tasks_owner_project_priority_createdAt" },
  );

  // Efficiently filter a user's projects by status and creation date.
  await db.collection("projects").createIndex(
    { ownerId: 1, status: 1, createdAt: -1, _id: -1 },
    {
      name: "projects_owner_status_createdAt",
    },
  );

  await db
    .collection("projectMembers")
    .createIndex({ projectId: 1, userId: 1 }, { unique: true });

  await db.collection("projectMembers").createIndex({ userId: 1, status: 1 });

  await db
    .collection("projectMembers")
    .createIndex({ projectId: 1, status: 1 });
}

export async function connectToMongoDB() {
  if (disconnectPromise) {
    await disconnectPromise;
  }

  if (database) {
    return database;
  }

  if (connectionPromise) {
    return connectionPromise;
  }

  connectionPromise = (async () => {
    let newClient = null;

    try {
      newClient = createMongoClient();

      await newClient.connect();

      const db = newClient.db(process.env.DB_NAME);

      await db.command({ ping: 1 });

      await createDatabaseIndexes(db);

      client = newClient;
      database = db;

      console.log(`MongoDB connected successfully: ${process.env.DB_NAME}`);

      return database;
    } catch (error) {
      if (newClient) {
        await newClient.close().catch(() => {});
      }

      console.error("MongoDB connection failed:", error.message);

      throw error;
    } finally {
      connectionPromise = null;
    }
  })();

  return connectionPromise;
}

export async function disconnectFromMongoDB() {
  if (disconnectPromise) {
    return disconnectPromise;
  }

  disconnectPromise = (async () => {
    try {
      if (connectionPromise) {
        await connectionPromise.catch(() => {});
      }

      const currentClient = client;

      client = null;
      database = null;

      if (currentClient) {
        await currentClient.close();
        console.log("MongoDB connection closed.");
      }
    } finally {
      connectionPromise = null;
      disconnectPromise = null;
    }
  })();

  return disconnectPromise;
}

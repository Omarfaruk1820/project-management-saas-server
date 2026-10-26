import { getApps, initializeApp, cert } from "firebase-admin/app";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const serviceAccountPath = path.resolve(
  __dirname,
  "../serviceAccountKey.json",
);

const serviceAccount = JSON.parse(readFileSync(serviceAccountPath, "utf8"));

const firebaseAdminApp =
  getApps().length > 0
    ? getApps()[0]
    : initializeApp({
        credential: cert(serviceAccount),
      });

export default firebaseAdminApp;

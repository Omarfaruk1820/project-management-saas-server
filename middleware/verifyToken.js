import "../config/firebaseAdmin.js";
import { getAuth } from "firebase-admin/auth";

const verifyToken = async (req, res, next) => {
  const authorization = req.headers.authorization || "";
  const [scheme, token] = authorization.split(" ");

  if (scheme !== "Bearer" || !token) {
    return res.status(401).json({
      success: false,
      code: "AUTH_TOKEN_MISSING",
      message: "A Firebase Bearer token is required.",
    });
  }

  try {
    const decodedToken = await getAuth().verifyIdToken(token);

    req.auth = decodedToken;

    return next();
  } catch (error) {
    console.error("[verifyToken] Token verification failed:", {
      code: error.code,
      message: error.message,
    });

    return res.status(401).json({
      success: false,
      code: "AUTH_TOKEN_INVALID",
      message: "Firebase ID token is invalid or expired.",
    });
  }
};

export default verifyToken;

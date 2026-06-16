import crypto from "node:crypto";
import http from "node:http";
import process from "node:process";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const SHOP = process.env.SHOPIFY_SHOP || "";
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID || "";
const CLIENT_SECRET =
  process.env.SHOPIFY_CLIENT_SECRET ||
  process.env.SHOPIFY_API_SECRET ||
  "REPLACE_WITH_YOUR_CLIENT_SECRET";
const SCOPES = ["read_products", "write_pixels", "read_customer_events"];
const REDIRECT_URI = "http://localhost:3000/auth/callback";
const API_VERSION = "2026-04";
const CALLBACK_PORT = 3000;
const OAUTH_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_PIXEL_MUTATION = `
mutation {
  webPixelCreate(webPixel: { settings: "{}" }) {
    userErrors {
      field
      message
    }
    webPixel {
      id
    }
  }
}
`;

function ensureClientSecret() {
  if (!SHOP) {
    throw new Error(
      "Set SHOPIFY_SHOP in your environment before running this script.",
    );
  }

  if (!CLIENT_ID) {
    throw new Error(
      "Set SHOPIFY_CLIENT_ID in your environment before running this script.",
    );
  }

  if (
    !CLIENT_SECRET ||
    CLIENT_SECRET === "REPLACE_WITH_YOUR_CLIENT_SECRET"
  ) {
    throw new Error(
      "Set SHOPIFY_CLIENT_SECRET or SHOPIFY_API_SECRET in your environment before running this script.",
    );
  }
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getAuthorizationCodeFromArgs() {
  const codeArgument = process.argv.find((arg) => arg.startsWith("--code="));
  return codeArgument ? codeArgument.slice("--code=".length) : null;
}

function createState() {
  return crypto.randomBytes(16).toString("hex");
}

function buildInstallUrl(state) {
  const installUrl = new URL(`https://${SHOP}/admin/oauth/authorize`);
  installUrl.searchParams.set("client_id", CLIENT_ID);
  installUrl.searchParams.set("scope", SCOPES.join(","));
  installUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  installUrl.searchParams.set("state", state);
  return installUrl.toString();
}

function respondWithHtml(response, statusCode, title, message) {
  const safeTitle = escapeHtml(title);
  const safeMessage = escapeHtml(message);

  response.writeHead(statusCode, { "Content-Type": "text/html; charset=utf-8" });
  response.end(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${safeTitle}</title>
  </head>
  <body style="font-family: sans-serif; padding: 2rem;">
    <h1>${safeTitle}</h1>
    <p>${safeMessage}</p>
  </body>
</html>`);
}

function verifyCallbackHmac(searchParams) {
  const receivedHmac = searchParams.get("hmac");
  if (!receivedHmac) {
    throw new Error("Missing hmac parameter in OAuth callback.");
  }

  const message = [...searchParams.entries()]
    .filter(([key]) => key !== "hmac" && key !== "signature")
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");

  const calculatedHmac = crypto
    .createHmac("sha256", CLIENT_SECRET)
    .update(message)
    .digest("hex");

  const receivedBuffer = Buffer.from(receivedHmac, "utf8");
  const calculatedBuffer = Buffer.from(calculatedHmac, "utf8");

  if (
    receivedBuffer.length !== calculatedBuffer.length ||
    !crypto.timingSafeEqual(receivedBuffer, calculatedBuffer)
  ) {
    throw new Error("Invalid HMAC signature in OAuth callback.");
  }
}

function waitForAuthorizationCode(expectedState) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((request, response) => {
      try {
        if (!request.url) {
          throw new Error("Received callback without a URL.");
        }

        const callbackUrl = new URL(request.url, REDIRECT_URI);
        if (callbackUrl.pathname !== "/auth/callback") {
          respondWithHtml(response, 404, "Not Found", "Unknown callback path.");
          return;
        }

        const { searchParams } = callbackUrl;
        const error = searchParams.get("error");
        if (error) {
          const description =
            searchParams.get("error_description") || "Shopify returned an OAuth error.";
          respondWithHtml(response, 400, "Authorization Failed", description);
          cleanup(new Error(`Shopify OAuth error: ${error} (${description})`));
          return;
        }

        const returnedState = searchParams.get("state");
        if (!returnedState || returnedState !== expectedState) {
          respondWithHtml(
            response,
            400,
            "Invalid State",
            "State validation failed. You can close this window and rerun the script.",
          );
          cleanup(new Error("State validation failed for OAuth callback."));
          return;
        }

        const returnedShop = searchParams.get("shop");
        if (returnedShop !== SHOP) {
          respondWithHtml(
            response,
            400,
            "Invalid Shop",
            "Unexpected shop in callback. You can close this window and rerun the script.",
          );
          cleanup(new Error(`Unexpected shop in callback: ${returnedShop || "missing"}`));
          return;
        }

        verifyCallbackHmac(searchParams);

        const code = searchParams.get("code");
        if (!code) {
          respondWithHtml(
            response,
            400,
            "Missing Code",
            "No authorization code was provided by Shopify.",
          );
          cleanup(new Error("Missing authorization code in OAuth callback."));
          return;
        }

        respondWithHtml(
          response,
          200,
          "Authorization Complete",
          "The access token exchange is running now. You can close this window.",
        );
        cleanup(null, code);
      } catch (error) {
        respondWithHtml(
          response,
          500,
          "OAuth Callback Error",
          "The script hit an error while processing the callback.",
        );
        cleanup(error);
      }
    });

    const timeout = setTimeout(() => {
      cleanup(
        new Error(
          `Timed out waiting for Shopify OAuth callback after ${OAUTH_TIMEOUT_MS / 1000} seconds.`,
        ),
      );
    }, OAUTH_TIMEOUT_MS);

    let settled = false;

    function cleanup(error, code) {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      server.close(() => {
        if (error) {
          reject(error);
          return;
        }

        resolve(code);
      });
    }

    server.on("error", (error) => {
      cleanup(error);
    });

    server.listen(CALLBACK_PORT, () => {
      console.log(`Listening for OAuth callback on ${REDIRECT_URI}`);
    });
  });
}

async function exchangeCodeForAccessToken(code) {
  const tokenUrl = `https://${SHOP}/admin/oauth/access_token`;
  const response = await axios.post(
    tokenUrl,
    {
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
    },
    {
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      timeout: 30_000,
    },
  );

  const accessToken = response.data?.access_token;
  if (!accessToken) {
    throw new Error("Shopify token exchange did not return an access_token.");
  }

  return accessToken;
}

async function createWebPixel(accessToken) {
  const graphqlUrl = `https://${SHOP}/admin/api/${API_VERSION}/graphql.json`;
  const response = await axios.post(
    graphqlUrl,
    { query: DEFAULT_PIXEL_MUTATION },
    {
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      timeout: 30_000,
    },
  );

  if (response.data?.errors?.length) {
    throw new Error(
      `GraphQL errors: ${JSON.stringify(response.data.errors, null, 2)}`,
    );
  }

  const payload = response.data?.data?.webPixelCreate;
  const userErrors = payload?.userErrors || [];
  if (userErrors.length > 0) {
    throw new Error(
      `webPixelCreate userErrors: ${JSON.stringify(userErrors, null, 2)}`,
    );
  }

  const pixelId = payload?.webPixel?.id;
  if (!pixelId) {
    throw new Error("Shopify did not return a Web Pixel ID.");
  }

  return pixelId;
}

async function getAuthorizationCode() {
  const directCode = getAuthorizationCodeFromArgs();
  if (directCode) {
    return directCode;
  }

  const state = createState();
  const installUrl = buildInstallUrl(state);

  console.log("");
  console.log("Open this install URL in your browser to grant scopes:");
  console.log(installUrl);
  console.log("");
  console.log("After you click \"Update app\", Shopify will redirect back to this script.");
  console.log("");

  return waitForAuthorizationCode(state);
}

async function main() {
  ensureClientSecret();

  const code = await getAuthorizationCode();
  console.log("Authorization code received. Exchanging for access token...");

  const accessToken = await exchangeCodeForAccessToken(code);
  console.log("Access token created. Creating Web Pixel...");

  const pixelId = await createWebPixel(accessToken);
  console.log(`Web Pixel created: ${pixelId}`);
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    const message = axios.isAxiosError(error)
      ? error.response?.data
        ? JSON.stringify(error.response.data, null, 2)
        : error.message
      : error instanceof Error
        ? error.message
        : String(error);

    console.error("Script failed:", message);
    process.exit(1);
  });

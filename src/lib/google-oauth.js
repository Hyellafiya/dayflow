
import { createClient } from "@supabase/supabase-js";
import {
  createHash,
  createHmac,
  randomBytes,
  createCipheriv,
  createDecipheriv
} from "node:crypto";

const GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/drive.file"
];

function getConfig() {
  const {
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY,
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_TOKEN_ENCRYPTION_KEY,
    GOOGLE_OAUTH_STATE_SECRET,
    APP_URL
  } = process.env;

  const required = {
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY,
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_TOKEN_ENCRYPTION_KEY,
    GOOGLE_OAUTH_STATE_SECRET,
    APP_URL
  };

  for (const [name, value] of Object.entries(required)) {
    if (!value) throw new Error(`Missing environment variable: ${name}`);
  }

  const encryptionKey = Buffer.from(GOOGLE_TOKEN_ENCRYPTION_KEY, "hex");
  if (encryptionKey.length !== 32) {
    throw new Error("GOOGLE_TOKEN_ENCRYPTION_KEY must be 64 hexadecimal characters.");
  }

  if (!/^[0-9a-f]{64}$/i.test(GOOGLE_OAUTH_STATE_SECRET)) {
    throw new Error("GOOGLE_OAUTH_STATE_SECRET must be 64 hexadecimal characters.");
  }

  const appUrl = new URL(APP_URL);
  if (appUrl.protocol !== "https:") {
    throw new Error("APP_URL must use HTTPS.");
  }

  return {
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY,
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_TOKEN_ENCRYPTION_KEY,
    GOOGLE_OAUTH_STATE_SECRET,
    APP_URL: appUrl.origin
  };
}

function adminClient(config) {
  return createClient(
    config.SUPABASE_URL,
    config.SUPABASE_SERVICE_ROLE_KEY,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false
      }
    }
  );
}

function hashState(state, secret) {
  return createHmac("sha256", Buffer.from(secret, "hex"))
    .update(state)
    .digest("hex");
}

function encryptToken(token, keyHex) {
  const key = Buffer.from(keyHex, "hex");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);

  const encrypted = Buffer.concat([
    cipher.update(token, "utf8"),
    cipher.final()
  ]);

  const tag = cipher.getAuthTag();

  return [
    "v1",
    iv.toString("base64url"),
    tag.toString("base64url"),
    encrypted.toString("base64url")
  ].join(".");
}

export function decryptGoogleRefreshToken(value) {
  const config = getConfig();
  const parts = value.split(".");

  if (parts.length !== 4 || parts[0] !== "v1") {
    throw new Error("Invalid encrypted Google token format.");
  }

  const [, ivPart, tagPart, encryptedPart] = parts;
  const decipher = createDecipheriv(
    "aes-256-gcm",
    Buffer.from(config.GOOGLE_TOKEN_ENCRYPTION_KEY, "hex"),
    Buffer.from(ivPart, "base64url")
  );

  decipher.setAuthTag(Buffer.from(tagPart, "base64url"));

  return Buffer.concat([
    decipher.update(Buffer.from(encryptedPart, "base64url")),
    decipher.final()
  ]).toString("utf8");
}

export async function createGoogleAuthorization(userId) {
  const config = getConfig();
  const db = adminClient(config);

  const state = randomBytes(32).toString("base64url");
  const stateHash = hashState(state, config.GOOGLE_OAUTH_STATE_SECRET);
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  const { error } = await db.from("google_oauth_states").insert({
    state_hash: stateHash,
    user_id: userId,
    expires_at: expiresAt
  });

  if (error) throw new Error("Could not create Google authorization state.");

  const redirectUri = `${config.APP_URL}/api/connectors/google/callback`;

  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: config.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GOOGLE_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state
  }).toString();

  return url.toString();
}

export async function completeGoogleAuthorization(code, state) {
  if (!code || !state || typeof state !== "string" || state.length > 500) {
    throw new Error("Invalid Google authorization response.");
  }

  const config = getConfig();
  const db = adminClient(config);
  const stateHash = hashState(state, config.GOOGLE_OAUTH_STATE_SECRET);
  const now = new Date().toISOString();

  const { data: stateRows, error: stateError } = await db
    .from("google_oauth_states")
    .select("id,user_id")
    .eq("state_hash", stateHash)
    .is("consumed_at", null)
    .gt("expires_at", now)
    .limit(1);

  if (stateError || !stateRows?.length) {
    throw new Error("Google authorization state is invalid or expired.");
  }

  const savedState = stateRows[0];

  const { data: consumedRows, error: consumeError } = await db
    .from("google_oauth_states")
    .update({ consumed_at: now })
    .eq("id", savedState.id)
    .is("consumed_at", null)
    .gt("expires_at", now)
    .select("id");

  if (consumeError || !consumedRows?.length) {
    throw new Error("Google authorization state has already been used.");
  }

  const redirectUri = `${config.APP_URL}/api/connectors/google/callback`;

  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: config.GOOGLE_CLIENT_ID,
      client_secret: config.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: "authorization_code"
    })
  });

  const tokens = await tokenResponse.json();

  if (!tokenResponse.ok || !tokens.refresh_token) {
    throw new Error("Google did not return a refresh token. Please reconnect and approve access.");
  }

  const profileResponse = await fetch(
    "https://openidconnect.googleapis.com/v1/userinfo",
    { headers: { Authorization: `Bearer ${tokens.access_token}` } }
  );

  const profile = await profileResponse.json();

  if (!profileResponse.ok || !profile.email) {
    throw new Error("Could not verify the connected Google account.");
  }

  const { error: saveError } = await db.from("google_connections").upsert({
    user_id: savedState.user_id,
    google_email: profile.email,
    encrypted_refresh_token: encryptToken(
      tokens.refresh_token,
      config.GOOGLE_TOKEN_ENCRYPTION_KEY
    ),
    scopes: GOOGLE_SCOPES,
    updated_at: now
  });

  if (saveError) {
    throw new Error("Could not save the Google connection.");
  }

  return {
    userId: savedState.user_id,
    email: profile.email
  };
}

export async function getGoogleConnection(userId) {
  const config = getConfig();
  const db = adminClient(config);

  const { data, error } = await db
    .from("google_connections")
    .select("google_email,scopes,connected_at")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw new Error("Could not check Google connection.");

  return data
    ? {
        connected: true,
        email: data.google_email,
        scopes: data.scopes,
        connectedAt: data.connected_at
      }
    : {
        connected: false,
        email: null,
        scopes: [],
        connectedAt: null
      };
}

export async function disconnectGoogle(userId) {
  const config = getConfig();
  const db = adminClient(config);

  const { error } = await db
    .from("google_connections")
    .delete()
    .eq("user_id", userId);

  if (error) throw new Error("Could not disconnect Google.");

  return { disconnected: true };
}

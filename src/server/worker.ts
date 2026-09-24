import {
  AuthorizationError,
  OAuthProvider,
  type AuthRequest,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Database } from "../lib/db.js";
import { embedText } from "../lib/embeddings.js";
import { MemoryGraph } from "../lib/graph.js";
import { jevRelevance } from "../lib/jev.js";
import { logger } from "../lib/logger.js";
import { registerTools } from "../lib/tools.js";

interface OAuthKV {
  get<T = unknown>(key: string, type: "json"): Promise<T | null>;
  put(
    key: string,
    value: string,
    options?: { expirationTtl?: number },
  ): Promise<void>;
  delete(key: string): Promise<void>;
}

interface Env {
  OAUTH_KV: OAuthKV;
  OAUTH_PROVIDER: OAuthHelpers;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  NEO4J_URI: string;
  NEO4J_PASSWORD: string;
  NEO4J_DATABASE?: string;
  OPENROUTER_API_KEY: string;
}

interface ConsentState {
  authorizationRequest: AuthRequest;
  csrf: string;
}

interface GoogleState {
  authorizationRequest: AuthRequest;
  nonce: string;
  origin: string;
}

const STATE_TTL_SECONDS = 600;
const GOOGLE_CALLBACK_PATH = "/oauth/google/callback";
const GOOGLE_AUTHORIZATION_ENDPOINT =
  "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GOOGLE_JWKS_ENDPOINT = "https://www.googleapis.com/oauth2/v3/certs";

const mcpHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST") {
      return new Response(null, { status: 405, headers: { Allow: "POST" } });
    }

    let database: Database | undefined;
    let server: McpServer | undefined;
    try {
      if (!env.NEO4J_URI || !env.NEO4J_PASSWORD) {
        return new Response("Mentis database is not configured", {
          status: 503,
        });
      }

      database = new Database({
        uri: env.NEO4J_URI,
        password: env.NEO4J_PASSWORD,
        database: env.NEO4J_DATABASE ?? "neo4j",
      });

      const graph = new MemoryGraph(
        database,
        (text, inputType, requestId) =>
          embedText(text, inputType, requestId, env.OPENROUTER_API_KEY),
        (query, attempt, requestId) =>
          jevRelevance(query, attempt, requestId, env.OPENROUTER_API_KEY),
      );
      server = new McpServer({ name: "mentis-4j", version: "0.1.0" });
      registerTools(server, graph);

      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await server.connect(transport);
      return await transport.handleRequest(request);
    } catch (error) {
      logger.error(`MCP HTTP request failed: ${errorMessage(error)}`);
      return new Response("Mentis MCP request failed", { status: 503 });
    } finally {
      await server?.close().catch((error: unknown) => {
        logger.error(`Failed to close MCP server: ${errorMessage(error)}`);
      });
      await database?.close().catch((error: unknown) => {
        logger.error(`Failed to close database: ${errorMessage(error)}`);
      });
    }
  },
};

const defaultHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/authorize" && request.method === "GET") {
      return beginAuthorization(request, env);
    }
    if (url.pathname === "/authorize/consent" && request.method === "POST") {
      return submitConsent(request, env);
    }
    if (url.pathname === GOOGLE_CALLBACK_PATH && request.method === "GET") {
      return googleCallback(request, env);
    }
    return new Response("Not found", { status: 404 });
  },
};

export default {
  fetch(
    request: Request,
    env: Env,
    ctx: Parameters<OAuthProvider<Env>["fetch"]>[2],
  ): Promise<Response> {
    const origin = new URL(request.url).origin;
    const resource = `${origin}/mcp`;
    const provider = new OAuthProvider<Env>({
      apiRoute: "/mcp",
      apiHandler: mcpHandler,
      defaultHandler,
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/oauth/token",
      clientRegistrationEndpoint: "/oauth/register",
      clientIdMetadataDocumentEnabled: true,
      refreshTokenTTL: 7 * 24 * 60 * 60,
      resourceMetadata: {
        resource,
        authorization_servers: [origin],
        resource_name: "Mentis",
      },
    });
    return provider.fetch(request, env, ctx);
  },
};

async function beginAuthorization(
  request: Request,
  env: Env,
): Promise<Response> {
  let authorizationRequest: AuthRequest;
  try {
    authorizationRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return authorizationErrorResponse(error);
    }
    logger.error(
      `Failed to parse OAuth authorization request: ${errorMessage(error)}`,
    );
    return new Response("Invalid authorization request", { status: 400 });
  }

  const client = await env.OAUTH_PROVIDER.lookupClient(
    authorizationRequest.clientId,
  );
  if (!client) return new Response("Unknown OAuth client", { status: 400 });

  const state = crypto.randomUUID();
  const csrf = crypto.randomUUID();
  await env.OAUTH_KV.put(
    `consent:${state}`,
    JSON.stringify({ authorizationRequest, csrf } satisfies ConsentState),
    { expirationTtl: STATE_TTL_SECONDS },
  );

  const clientName = escapeHtml(client.clientName ?? "An MCP client");
  return htmlResponse(`<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Authorize Mentis</title><h1>Connect ${clientName} to Mentis?</h1>
<p>Mentis stores and retrieves coding-attempt memories for this client.</p>
<form method="post" action="/authorize/consent">
<input type="hidden" name="state" value="${state}">
<input type="hidden" name="csrf" value="${csrf}">
<button name="decision" value="allow">Continue with Google</button>
<button name="decision" value="deny">Cancel</button>
</form></html>`);
}

async function submitConsent(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (request.headers.get("Origin") !== url.origin) {
    return new Response("Invalid consent origin", { status: 403 });
  }

  const form = await request.formData();
  const state = form.get("state");
  const csrf = form.get("csrf");
  const decision = form.get("decision");
  if (
    typeof state !== "string" ||
    typeof csrf !== "string" ||
    (decision !== "allow" && decision !== "deny")
  ) {
    return new Response("Invalid consent request", { status: 400 });
  }

  const consent = await env.OAUTH_KV.get<ConsentState>(
    `consent:${state}`,
    "json",
  );
  if (
    !consent ||
    !isAuthRequest(consent.authorizationRequest) ||
    consent.csrf !== csrf
  ) {
    return new Response("Expired or invalid consent request", { status: 400 });
  }
  await env.OAUTH_KV.delete(`consent:${state}`);

  if (decision === "deny") {
    return oauthErrorRedirect(
      consent.authorizationRequest,
      "access_denied",
      "The user denied Mentis access.",
    );
  }

  const googleState = crypto.randomUUID();
  const nonce = crypto.randomUUID();
  const origin = url.origin;
  await env.OAUTH_KV.put(
    `google:${googleState}`,
    JSON.stringify({
      authorizationRequest: consent.authorizationRequest,
      nonce,
      origin,
    } satisfies GoogleState),
    { expirationTtl: STATE_TTL_SECONDS },
  );

  const googleUrl = new URL(GOOGLE_AUTHORIZATION_ENDPOINT);
  googleUrl.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: `${origin}${GOOGLE_CALLBACK_PATH}`,
    response_type: "code",
    scope: "openid",
    state: googleState,
    nonce,
  }).toString();
  return Response.redirect(googleUrl, 302);
}

async function googleCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const state = url.searchParams.get("state");
  if (!state) return new Response("Invalid Google callback", { status: 400 });

  const googleState = await consumeGoogleState(env, state, url.origin);
  if (!googleState) {
    return new Response("Expired or invalid Google sign-in", { status: 400 });
  }

  if (url.searchParams.has("error")) {
    return oauthErrorRedirect(
      googleState.authorizationRequest,
      "access_denied",
      "Google sign-in was not completed.",
    );
  }
  const code = url.searchParams.get("code");
  if (!code || code.length > 4096) {
    return oauthErrorRedirect(
      googleState.authorizationRequest,
      "access_denied",
      "Google sign-in was not completed.",
    );
  }

  let googleSub: string;
  try {
    googleSub = await exchangeGoogleCode(
      code,
      `${url.origin}${GOOGLE_CALLBACK_PATH}`,
      googleState.nonce,
      env,
    );
  } catch (error) {
    logger.error(`Google identity verification failed: ${errorMessage(error)}`);
    return oauthErrorRedirect(
      googleState.authorizationRequest,
      "access_denied",
      "Google identity could not be verified.",
    );
  }

  try {
    const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
      request: googleState.authorizationRequest,
      userId: `google_${googleSub}`,
      metadata: { identityProvider: "google" },
      scope: googleState.authorizationRequest.scope,
      props: { googleSub },
    });
    return Response.redirect(redirectTo, 302);
  } catch (error) {
    logger.error(
      `Failed to complete Mentis authorization: ${errorMessage(error)}`,
    );
    return new Response("Mentis authorization failed", { status: 500 });
  }
}

async function exchangeGoogleCode(
  code: string,
  redirectUri: string,
  nonce: string,
  env: Env,
): Promise<string> {
  const tokenResponse = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!tokenResponse.ok) throw new Error("Google token exchange failed");

  const tokenBody: unknown = await tokenResponse.json();
  if (!isRecord(tokenBody) || typeof tokenBody.id_token !== "string") {
    throw new Error("Google did not return an ID token");
  }
  return verifyGoogleIdToken(tokenBody.id_token, nonce, env.GOOGLE_CLIENT_ID);
}

async function verifyGoogleIdToken(
  token: string,
  expectedNonce: string,
  clientId: string,
): Promise<string> {
  if (token.length > 16_384) throw new Error("Google ID token is too large");
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Malformed Google ID token");

  const header = decodeJwtPart(parts[0]);
  const claims = decodeJwtPart(parts[1]);
  if (!isGoogleTokenHeader(header)) {
    throw new Error("Invalid Google ID token header or claims");
  }

  const jwksResponse = await fetch(GOOGLE_JWKS_ENDPOINT);
  if (!jwksResponse.ok) throw new Error("Failed to load Google signing keys");
  const jwks: unknown = await jwksResponse.json();
  if (!isRecord(jwks) || !Array.isArray(jwks.keys)) {
    throw new Error("Invalid Google signing keys");
  }
  const key = jwks.keys.find(
    (candidate): candidate is JsonWebKey & { kid: string } =>
      isRecord(candidate) &&
      candidate.kid === header.kid &&
      candidate.kty === "RSA" &&
      typeof candidate.n === "string" &&
      typeof candidate.e === "string",
  );
  if (!key) throw new Error("Unknown Google signing key");

  const cryptoKey = await crypto.subtle.importKey(
    "jwk",
    key,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const validSignature = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    decodeBase64Url(parts[2]).buffer as ArrayBuffer,
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  if (!validSignature || !isGoogleIdentity(claims, clientId, expectedNonce)) {
    throw new Error("Google ID token validation failed");
  }
  return claims.sub;
}

async function consumeGoogleState(
  env: Env,
  state: string,
  origin: string,
): Promise<GoogleState | null> {
  const value = await env.OAUTH_KV.get<GoogleState>(`google:${state}`, "json");
  await env.OAUTH_KV.delete(`google:${state}`);
  return isGoogleState(value, origin) ? value : null;
}

function isGoogleState(value: unknown, origin: string): value is GoogleState {
  return (
    isRecord(value) &&
    isAuthRequest(value.authorizationRequest) &&
    typeof value.nonce === "string" &&
    value.origin === origin
  );
}

function isGoogleTokenHeader(value: unknown): value is Record<string, string> {
  return (
    isRecord(value) && value.alg === "RS256" && typeof value.kid === "string"
  );
}

function isGoogleIdentity(
  value: unknown,
  clientId: string,
  nonce: string,
): value is Record<string, string | number> & { sub: string } {
  if (!isRecord(value)) return false;
  return (
    isGoogleIssuer(value.iss) &&
    value.aud === clientId &&
    hasValidGoogleTimes(value.exp, value.iat) &&
    value.nonce === nonce &&
    isGoogleSubject(value.sub)
  );
}

function isGoogleIssuer(value: unknown): boolean {
  return (
    value === "https://accounts.google.com" || value === "accounts.google.com"
  );
}

function hasValidGoogleTimes(exp: unknown, iat: unknown): boolean {
  const now = Math.floor(Date.now() / 1000);
  return (
    typeof exp === "number" &&
    exp > now &&
    typeof iat === "number" &&
    iat <= now + 60
  );
}

function isGoogleSubject(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 255;
}

function decodeJwtPart(part: string): unknown {
  return JSON.parse(new TextDecoder().decode(decodeBase64Url(part)));
}

function decodeBase64Url(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function authorizationErrorResponse(error: AuthorizationError): Response {
  if (!error.redirectUri)
    return new Response(error.description, { status: 400 });
  const target = new URL(error.redirectUri);
  target.searchParams.set("error", error.code);
  target.searchParams.set("error_description", error.description);
  if (error.state) target.searchParams.set("state", error.state);
  if (error.issuer) target.searchParams.set("iss", error.issuer);
  return Response.redirect(target, 302);
}

function oauthErrorRedirect(
  request: AuthRequest,
  code: string,
  description: string,
): Response {
  const target = new URL(request.redirectUri);
  target.searchParams.set("error", code);
  target.searchParams.set("error_description", description);
  if (request.state) target.searchParams.set("state", request.state);
  if (request.issuer) target.searchParams.set("iss", request.issuer);
  return Response.redirect(target, 302);
}

function htmlResponse(body: string): Response {
  return new Response(body, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy":
        "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character];
  });
}

function isAuthRequest(value: unknown): value is AuthRequest {
  return (
    isRecord(value) &&
    value.responseType === "code" &&
    typeof value.clientId === "string" &&
    typeof value.redirectUri === "string" &&
    Array.isArray(value.scope) &&
    value.scope.every((scope) => typeof scope === "string") &&
    typeof value.state === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

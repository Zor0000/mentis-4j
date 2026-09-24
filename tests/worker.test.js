import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const wrangler = fileURLToPath(
  new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url),
);

test(
  "Worker serves protected-resource discovery and CSRF-protected Google consent",
  { timeout: 30_000 },
  async () => {
    const port = await freePort();
    const server = spawn(
      process.execPath,
      [wrangler, "dev", "--ip", "127.0.0.1", "--port", String(port)],
      { stdio: "ignore" },
    );
    const origin = `http://127.0.0.1:${port}`;

    try {
      const challenge = await waitForWorker(server, origin);
      assert.equal(challenge.status, 401);
      const metadataUrl = challenge.headers
        .get("www-authenticate")
        .match(/resource_metadata="([^"]+)"/)[1];
      const resourceMetadata = await fetch(metadataUrl).then((r) => r.json());
      assert.equal(resourceMetadata.resource, `${origin}/mcp`);

      const registration = await fetch(`${origin}/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "Worker test",
          redirect_uris: [`${origin}/callback`],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        }),
      });
      assert.equal(registration.status, 201);
      const { client_id: clientId } = await registration.json();

      const authorization = new URL(`${origin}/authorize`);
      authorization.search = new URLSearchParams({
        client_id: clientId,
        response_type: "code",
        redirect_uri: `${origin}/callback`,
        code_challenge: "A".repeat(43),
        code_challenge_method: "S256",
        state: "client-state",
        resource: `${origin}/mcp`,
      });
      const consent = await fetch(authorization);
      assert.equal(consent.status, 200);
      const page = await consent.text();
      const formState = page.match(/name="state" value="([^"]+)"/)[1];
      const csrf = page.match(/name="csrf" value="([^"]+)"/)[1];
      const body = new URLSearchParams({
        state: formState,
        csrf,
        decision: "allow",
      });

      const rejected = await fetch(`${origin}/authorize/consent`, {
        method: "POST",
        headers: {
          origin: "https://attacker.invalid",
          "content-type": "application/x-www-form-urlencoded",
        },
        body,
        redirect: "manual",
      });
      assert.equal(rejected.status, 403);

      const accepted = await fetch(`${origin}/authorize/consent`, {
        method: "POST",
        headers: {
          origin,
          "content-type": "application/x-www-form-urlencoded",
        },
        body,
        redirect: "manual",
      });
      assert.equal(accepted.status, 302);
      const googleUrl = new URL(accepted.headers.get("location"));
      assert.equal(googleUrl.origin, "https://accounts.google.com");
      assert.equal(googleUrl.searchParams.get("scope"), "openid");
      assert.ok(googleUrl.searchParams.get("state"));
      assert.ok(googleUrl.searchParams.get("nonce"));
    } finally {
      if (server.exitCode === null) {
        server.kill("SIGTERM");
        await new Promise((resolve) => server.once("exit", resolve));
      }
    }
  },
);

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function waitForWorker(server, origin) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null)
      throw new Error("Wrangler exited before ready");
    try {
      return await fetch(`${origin}/mcp`);
    } catch {
      await delay(200);
    }
  }
  throw new Error("Wrangler did not start in time");
}

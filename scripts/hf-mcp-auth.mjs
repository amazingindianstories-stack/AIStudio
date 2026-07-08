/**
 * One-time Higgsfield MCP login (OAuth 2.0 auth-code + PKCE).
 * Opens your browser, you log into Higgsfield, and the token is saved to
 * .higgsfield-mcp-token.json for the app/introspection to use.
 *
 * Run:  node scripts/hf-mcp-auth.mjs
 */
import http from "node:http";
import crypto from "node:crypto";
import { exec } from "node:child_process";
import fs from "node:fs";

const AUTHZ = "https://mcp.higgsfield.ai/oauth2/authorize";
const TOKEN = "https://mcp.higgsfield.ai/oauth2/token";
const REGISTER = "https://mcp.higgsfield.ai/oauth2/register";
const PORT = 8765;
const REDIRECT = `http://localhost:${PORT}/callback`;
const SCOPE = "openid email offline_access";
const OUT = ".higgsfield-mcp-token.json";

const b64url = (buf) =>
  buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function main() {
  // 1) Dynamic client registration
  const reg = await (
    await fetch(REGISTER, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Lumina Studio",
        redirect_uris: [REDIRECT],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        scope: SCOPE,
      }),
    })
  ).json();
  const clientId = reg.client_id;
  if (!clientId) throw new Error("registration failed: " + JSON.stringify(reg));

  // 2) PKCE
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));
  const url =
    `${AUTHZ}?response_type=code&client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT)}&scope=${encodeURIComponent(SCOPE)}` +
    `&state=${state}&code_challenge=${challenge}&code_challenge_method=S256`;

  // 3) Catch the redirect
  const code = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, REDIRECT);
      if (u.pathname !== "/callback") {
        res.writeHead(404);
        res.end();
        return;
      }
      const c = u.searchParams.get("code");
      const err = u.searchParams.get("error");
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        `<body style="font-family:sans-serif;background:#0b0b0b;color:#eee;text-align:center;padding-top:80px">` +
          `<h2>${c ? "✅ Higgsfield connected" : "❌ Auth failed"}</h2>` +
          `<p>You can close this tab and return to the terminal.</p></body>`
      );
      server.close();
      if (c) resolve(c);
      else reject(new Error("no code; error=" + (err || u.search)));
    });
    server.listen(PORT, () => {
      console.log("\n→ Opening your browser to log in to Higgsfield…");
      console.log("  If it doesn't open, paste this URL:\n  " + url + "\n");
      exec(`open "${url}"`);
    });
  });

  // 4) Exchange code for tokens
  const tok = await (
    await fetch(TOKEN, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT,
        client_id: clientId,
        code_verifier: verifier,
      }),
    })
  ).json();

  if (!tok.access_token) throw new Error("token exchange failed: " + JSON.stringify(tok));
  fs.writeFileSync(OUT, JSON.stringify({ ...tok, client_id: clientId }, null, 2));
  console.log(
    `\n✅ Saved ${OUT}. access_token: yes, refresh_token: ${tok.refresh_token ? "yes" : "no"}, scope: ${tok.scope || "?"}`
  );
  process.exit(0);
}

main().catch((e) => {
  console.error("\n❌ " + (e?.message || e));
  process.exit(1);
});

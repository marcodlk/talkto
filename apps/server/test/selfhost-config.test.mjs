import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const tool = fileURLToPath(new URL("../tools/selfhost-config.mjs", import.meta.url));

const configure = (origin) => {
  const dir = mkdtempSync(join(tmpdir(), "selfhost-config-"));
  const out = join(dir, "wrangler.selfhost.jsonc");
  const result = spawnSync(process.execPath, [tool, "--out", out], {
    encoding: "utf8",
    env: {
      ...process.env,
      CLOUDFLARE_ACCOUNT_ID: "0".repeat(32),
      TALKTO_D1_DATABASE_ID: "00000000-0000-4000-8000-000000000000",
      TALKTO_AUTH_PROVIDER: "better-auth",
      TALKTO_OWNER_EMAILS: "owner@example.com",
      TALKTO_SERVICE_ORIGIN: origin,
    },
  });
  const written = result.status === 0 ? readFileSync(out, "utf8") : null;
  rmSync(dir, { recursive: true, force: true });
  return { status: result.status, stderr: result.stderr, written };
};

test("an https origin or a localhost tunnel origin is accepted", () => {
  for (const origin of ["https://talkto.example.com", "http://localhost:7700"]) {
    const { status, stderr, written } = configure(origin);
    assert.equal(status, 0, stderr);
    assert.match(written, new RegExp(`"TALKTO_SERVICE_ORIGIN": "${origin}"`));
  }
});

test("plain http on another host, or localhost without a port, is refused", () => {
  for (const origin of [
    "http://talkto.example.com",
    "http://localhost",
    "https://talkto.example.com/",
  ]) {
    const { status, stderr } = configure(origin);
    assert.notEqual(status, 0, origin);
    assert.match(stderr, /TALKTO_SERVICE_ORIGIN looks wrong/);
  }
});

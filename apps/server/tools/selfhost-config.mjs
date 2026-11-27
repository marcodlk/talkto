// Write apps/server/wrangler.selfhost.jsonc from the template and your settings (docs/self-host.md).
// Run from the repository root: `pnpm selfhost:config`. It reads only environment variables, prints
// no secrets (it needs none) and refuses to write a config with a placeholder left in it. Better
// Auth's secret is a Worker secret (`wrangler secret put BETTER_AUTH_SECRET`), never in this file.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { experimental_readRawConfig } from "wrangler";

const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const template = here("../wrangler.selfhost.example.jsonc");
// `--out <file>` writes somewhere else; `pnpm celld` uses it to leave your own config alone.
const { values: args } = parseArgs({ options: { out: { type: "string" } } });
const output = args.out ?? here("../wrangler.selfhost.jsonc");

const problems = [];
const setting = (name, pattern, hint, fallback) => {
  const value = process.env[name]?.trim() || fallback;
  if (value === undefined) problems.push(`${name} is not set. ${hint}`);
  else if (!pattern.test(value)) problems.push(`${name} looks wrong. ${hint}`);
  return value ?? "";
};

const accountId = setting(
  "CLOUDFLARE_ACCOUNT_ID",
  /^[a-f0-9]{32}$/,
  "Use the 32-character account ID from `wrangler whoami`.",
);
const name = setting(
  "TALKTO_NAME",
  /^[a-z][a-z0-9-]{0,40}[a-z0-9]$/,
  "Lowercase letters, digits and hyphens, for example talkto.",
  "talkto",
);
const origin = setting(
  "TALKTO_SERVICE_ORIGIN",
  /^(https:\/\/[a-z0-9.-]+|http:\/\/localhost:[0-9]{2,5})$/,
  "Your TalkTo's https address with no path or trailing slash, for example https://talkto.example.com, or http://localhost:<port> when people reach it through a tunnel.",
);
const databaseId = setting(
  "TALKTO_D1_DATABASE_ID",
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  "Use the database_id that `wrangler d1 create` printed.",
);
// Sign-in: Better Auth when TALKTO_AUTH_PROVIDER=better-auth (docs/self-host-better-auth.md),
// Cloudflare Access when its team domain is set (docs/self-host-cloudflare-access.md), otherwise
// WorkOS. Only one may be chosen.
const provider = process.env.TALKTO_AUTH_PROVIDER?.trim();
const betterAuth = provider === "better-auth";
if (provider !== undefined && provider !== "" && !betterAuth)
  problems.push("TALKTO_AUTH_PROVIDER looks wrong. Set it to better-auth, or leave it unset.");
const access = Boolean(process.env.TALKTO_ACCESS_TEAM_DOMAIN?.trim());
if (access && betterAuth)
  problems.push(
    "Choose one sign-in: unset TALKTO_ACCESS_TEAM_DOMAIN for Better Auth, or TALKTO_AUTH_PROVIDER for Cloudflare Access.",
  );
const owners = betterAuth
  ? setting(
      "TALKTO_OWNER_EMAILS",
      /^[^\s@,"\\]+@[^\s@,"\\]+(,[^\s@,"\\]+@[^\s@,"\\]+){0,9}$/,
      "The owners' addresses, whose invitations can create accounts: comma-separated with no spaces, at most 10.",
    )
  : "";
const workos = !access && !betterAuth;
const accessTeam = access
  ? setting(
      "TALKTO_ACCESS_TEAM_DOMAIN",
      /^https:\/\/[a-z0-9][a-z0-9-]{0,62}\.cloudflareaccess\.com$/,
      "Your Zero Trust team domain, for example https://your-team.cloudflareaccess.com.",
    )
  : "";
const accessAud = access
  ? setting(
      "TALKTO_ACCESS_AUD",
      /^[A-Za-z0-9]{16,128}$/,
      "Copy the Application Audience (AUD) Tag from your Access application's settings.",
    )
  : "";
const clientId = !workos
  ? ""
  : setting(
      "WORKOS_CLIENT_ID",
      /^client_[A-Za-z0-9]+$/,
      "Copy the Client ID from your WorkOS environment's API keys page.",
    );
const mcpIssuer = !workos
  ? ""
  : setting(
      "WORKOS_MCP_ISSUER",
      /^https:\/\/[a-z0-9.-]+$/,
      "Your AuthKit domain, for example https://your-name.authkit.app, with no trailing slash.",
    );
if (access && /\.workers\.dev$/.test(origin))
  problems.push(
    "TALKTO_SERVICE_ORIGIN must be a hostname in your own Cloudflare zone: Access cannot protect a workers.dev address.",
  );
const namespace = setting(
  "TALKTO_RATELIMIT_NAMESPACE",
  /^[1-9][0-9]{0,8}$/,
  "A positive whole number that no other rate limit in this Cloudflare account uses.",
  "1001",
);
const signalNamespace = setting(
  "TALKTO_SIGNAL_RATELIMIT_NAMESPACE",
  /^[1-9][0-9]{0,8}$/,
  "A positive whole number that no other rate limit in this Cloudflare account uses.",
  "1002",
);
if (signalNamespace === namespace)
  problems.push("TALKTO_SIGNAL_RATELIMIT_NAMESPACE must differ from TALKTO_RATELIMIT_NAMESPACE.");
if (problems.length > 0) {
  console.error(["Cannot write wrangler.selfhost.jsonc:", ...problems].join("\n  "));
  process.exit(1);
}

const values = {
  __NAME__: name,
  __CLOUDFLARE_ACCOUNT_ID__: accountId,
  __TALKTO_SERVICE_ORIGIN__: origin,
  __D1_DATABASE_ID__: databaseId,
  __WORKOS_CLIENT_ID__: clientId,
  __WORKOS_MCP_ISSUER__: mcpIssuer,
  __RATELIMIT_NAMESPACE__: namespace,
  __SIGNAL_RATELIMIT_NAMESPACE__: signalNamespace,
};
const raw = experimental_readRawConfig({ config: template }).rawConfig;
// On Access, WorkOS's settings are left out and Access's take their place.
if (access) {
  for (const key of Object.keys(raw.vars)) if (key.startsWith("WORKOS_")) delete raw.vars[key];
  raw.vars.TALKTO_ACCESS_TEAM_DOMAIN = accessTeam;
  raw.vars.TALKTO_ACCESS_AUD = accessAud;
}
// On Better Auth, WorkOS's settings are left out too. Its secret is set with wrangler, not here.
if (betterAuth) {
  for (const key of Object.keys(raw.vars)) if (key.startsWith("WORKOS_")) delete raw.vars[key];
  raw.vars.TALKTO_AUTH_PROVIDER = "better-auth";
  raw.vars.TALKTO_OWNER_EMAILS = owners;
}
// Every value above matched a pattern without quotes or backslashes, so it fills JSON text safely.
// The owner addresses are set as values, not substituted into the text.
const config = JSON.parse(
  JSON.stringify(raw).replace(/__[A-Z0-9_]+__/g, (token) => values[token] ?? token),
);
// A workers.dev address needs workers.dev; any other host is attached as a Custom Domain, which
// creates its DNS record and certificate in your Cloudflare zone.
const host = new URL(origin).hostname;
config.workers_dev = host.endsWith(".workers.dev");
config.routes = config.workers_dev ? [] : [{ pattern: host, custom_domain: true }];

const text = JSON.stringify(config, null, 2);
const left = text.match(/__[A-Z0-9_]+__/g);
if (left) {
  console.error(`Placeholders left in the template: ${[...new Set(left)].join(", ")}`);
  process.exit(1);
}
writeFileSync(
  output,
  `// Written by pnpm selfhost:config from wrangler.selfhost.example.jsonc. Holds no secrets.\n${text}\n`,
);
console.log(`Wrote ${args.out ?? "apps/server/wrangler.selfhost.jsonc"} for ${origin}:`);
console.log(`  Worker ${name}, D1 ${name}-platform, R2 ${name}-transfers`);
console.log(`  ${config.workers_dev ? "workers.dev address" : `Custom Domain ${host}`}`);
console.log(
  `  Sign-in: ${access ? `Cloudflare Access (${accessTeam})` : betterAuth ? "Better Auth" : "WorkOS"}`,
);
if (betterAuth)
  console.log(
    "  After deploying, set Better Auth's secret from apps/server (docs/self-host.md, step 8), and\n" +
      "  keep a copy: pnpm selfhost:link needs it to make the owners' account links.\n" +
      "    npx wrangler secret put BETTER_AUTH_SECRET --config wrangler.selfhost.jsonc",
  );

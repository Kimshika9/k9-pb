import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { experimental_readRawConfig } from "wrangler";

const root = fileURLToPath(new URL("../", import.meta.url));
const { rawConfig } = experimental_readRawConfig(
  { config: fileURLToPath(new URL("../wrangler.jsonc", import.meta.url)) },
  { useRedirectIfAvailable: false },
);
const database = rawConfig.d1_databases?.find(
  (binding) => binding.binding === "DB",
);
if (
  rawConfig.name !== "k9-pb" ||
  database?.database_name !== "k9-post-studio" ||
  !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
    database.database_id ?? "",
  ) ||
  database.database_id === "00000000-0000-0000-0000-000000000000"
) {
  console.error(
    "Deployment stopped: verify the existing k9-pb Worker and pin the existing k9-post-studio D1 database UUID in wrangler.jsonc. No resource was created or changed.",
  );
  process.exit(1);
}
if (process.argv.includes("--check")) {
  console.log(
    "Deployment configuration is pinned. Account, migration state and approval still require verification.",
  );
  process.exit(0);
}
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? rawConfig.account_id;
if (!/^[a-f0-9]{32}$/i.test(accountId ?? "")) {
  console.error(
    "Deployment stopped: set the verified production CLOUDFLARE_ACCOUNT_ID. No resource was created or changed.",
  );
  process.exit(1);
}
const result = spawnSync(
  process.execPath,
  [
    fileURLToPath(
      new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url),
    ),
    "deploy",
    "--x-provision=false",
  ],
  { cwd: root, stdio: "inherit" },
);
process.exit(result.status ?? 1);

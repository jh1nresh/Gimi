import { spawnSync } from "node:child_process";

const allowedAdvisories = new Set([
  "https://github.com/advisories/GHSA-3gc7-fjrx-p6mg",
  "https://github.com/advisories/GHSA-58qx-3vcg-4xpx",
  "https://github.com/advisories/GHSA-96hv-2xvq-fx4p",
  "https://github.com/advisories/GHSA-w5hq-g745-h8pq",
]);

const result = spawnSync("npm", ["audit", "--omit=dev", "--json"], {
  encoding: "utf8",
  shell: process.platform === "win32",
});

if (result.error) {
  console.error(`Unable to run npm audit: ${result.error.message}`);
  process.exit(1);
}

let report;
try {
  report = JSON.parse(result.stdout);
} catch {
  console.error(result.stderr || "npm audit did not return valid JSON");
  process.exit(1);
}

if (
  report.error ||
  !report.vulnerabilities ||
  typeof report.vulnerabilities !== "object" ||
  !report.metadata?.vulnerabilities ||
  typeof report.metadata.vulnerabilities !== "object"
) {
  console.error(JSON.stringify({
    message: "npm audit did not return a complete vulnerability report",
    status: result.status,
    error: report.error ?? null,
  }, null, 2));
  process.exit(1);
}

const vulnerabilities = Object.entries(report.vulnerabilities ?? {});
const critical = Number(report.metadata?.vulnerabilities?.critical ?? 0);
const advisoryUrls = new Set(vulnerabilities.flatMap(([, value]) =>
  (value.via ?? [])
    .filter((entry) => typeof entry === "object" && entry.url)
    .map((entry) => entry.url)
));
const unexpectedAdvisories = [...advisoryUrls]
  .filter((url) => !allowedAdvisories.has(url));
const missingAdvisorySources = vulnerabilities.length > 0 && advisoryUrls.size === 0;

if (unexpectedAdvisories.length || missingAdvisorySources || critical) {
  console.error(JSON.stringify({
    message: "Unexpected runtime dependency advisory",
    unexpectedAdvisories,
    missingAdvisorySources,
    totals: report.metadata?.vulnerabilities,
  }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true,
  residualAdvisories: [...advisoryUrls].sort(),
  affectedPackages: vulnerabilities.map(([name]) => name).sort(),
  totals: report.metadata?.vulnerabilities,
}, null, 2));

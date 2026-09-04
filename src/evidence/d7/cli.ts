import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  type ApprovedEvidenceInput,
  type LoadedApprovedEvidenceInput,
  loadApprovedEvidenceInput,
  publishApprovedOutput,
} from "../common/approved-input.js";
import { EvidenceBoundaryError } from "../common/boundary.js";
import { canonicalJson } from "../common/canonical.js";
import { assertD7AsOf, measureD7ForwardCoverage } from "./measure.js";

const FLAGS = [
  "approval-manifest",
  "approval-sha256",
  "scratch-preparation-manifest",
  "scratch-preparation-sha256",
  "scratch-db",
  "approved-scratch-db-sha256",
  "repo-map",
  "repo-map-sha256",
  "scratch-state",
  "scratch-verification",
  "live-db",
  "repository-root",
  "source-commit",
  "as-of",
  "window-days",
  "out",
] as const;
function fail(code: string): never {
  throw new Error(code);
}
function parse(argv: readonly string[]): Map<string, string> {
  if (argv.length !== FLAGS.length * 2) fail("d7_cli_argument_missing");
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === undefined || value === undefined || !flag.startsWith("--") || value.length === 0)
      fail("d7_cli_argument_invalid");
    const key = flag.slice(2);
    if (!FLAGS.includes(key as (typeof FLAGS)[number]) || values.has(key))
      fail("d7_cli_argument_unknown_or_duplicate");
    values.set(key, value);
  }
  if (values.size !== FLAGS.length) fail("d7_cli_argument_missing");
  return values;
}
function required(values: Map<string, string>, key: string): string {
  return values.get(key) ?? fail("d7_cli_argument_missing");
}
function approved(values: Map<string, string>): ApprovedEvidenceInput {
  return {
    approvalManifestPath: required(values, "approval-manifest"),
    approvalManifestSha256: required(values, "approval-sha256"),
    preparationManifestPath: required(values, "scratch-preparation-manifest"),
    preparationManifestSha256: required(values, "scratch-preparation-sha256"),
    scratchDbPath: required(values, "scratch-db"),
    scratchDbSha256: required(values, "approved-scratch-db-sha256"),
    repoMapPath: required(values, "repo-map"),
    repoMapSha256: required(values, "repo-map-sha256"),
    scratchStatePath: required(values, "scratch-state"),
    scratchVerificationPath: required(values, "scratch-verification"),
    liveDbPath: required(values, "live-db"),
    repositoryRoot: required(values, "repository-root"),
  };
}
export interface D7CliDependencies {
  loadApproved?: (input: ApprovedEvidenceInput) => Promise<LoadedApprovedEvidenceInput>;
  publish?: typeof publishApprovedOutput;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}
export async function runD7CoverageCli(
  argv: readonly string[],
  dependencies: D7CliDependencies = {},
): Promise<number> {
  const stdout = dependencies.stdout ?? ((line) => process.stdout.write(`${line}\n`));
  const stderr = dependencies.stderr ?? ((line) => process.stderr.write(`${line}\n`));
  try {
    const values = parse(argv);
    if (required(values, "window-days") !== "30") fail("d7_window_days_invalid");
    const sourceCommit = required(values, "source-commit");
    if (!/^[0-9a-f]{40}$/u.test(sourceCommit)) fail("d7_source_commit_invalid");
    assertD7AsOf(required(values, "as-of"));
    const loaded = await (dependencies.loadApproved ?? loadApprovedEvidenceInput)(approved(values));
    const db = loaded.openVerifiedScratchDb();
    try {
      const report = measureD7ForwardCoverage({
        db,
        repositories: loaded.repositories,
        scratchDbSha256: loaded.scratchDbSha256,
        repoMapSha256: loaded.repoMapSha256,
        sourceCommit,
        asOf: required(values, "as-of"),
        windowDays: 30,
      });
      const publication = (dependencies.publish ?? publishApprovedOutput)(
        loaded,
        required(values, "out"),
        `${canonicalJson(report)}\n`,
      );
      stdout(canonicalJson({ status: report.status, reportSha256: publication.sha256 }));
    } finally {
      db.close();
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : "unexpected_failure";
    stderr(
      canonicalJson({
        status: "REFUSED",
        failure:
          error instanceof EvidenceBoundaryError || /^[a-z0-9_]+$/u.test(message)
            ? message
            : "unexpected_failure",
      }),
    );
    return 1;
  }
}
const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  pathToFileURL(path.resolve(invokedPath)).href ===
    pathToFileURL(fileURLToPath(import.meta.url)).href
)
  void runD7CoverageCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });

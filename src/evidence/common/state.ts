import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { EvidenceBoundaryError } from "./boundary.js";
import { canonicalJson, sha256Bytes } from "./canonical.js";

export interface AtomicJsonWriteResult {
  path: string;
  sha256: string;
}

/** Create one private canonical JSON artifact through write-fsync-rename in its approved state dir. */
export function writeApprovedStateJson(
  stateDirectory: string,
  fileName: string,
  value: unknown,
): AtomicJsonWriteResult {
  if (path.basename(fileName) !== fileName || fileName.length === 0) {
    throw new EvidenceBoundaryError("invalid_state_file_name");
  }
  const stateStat = fs.statSync(stateDirectory);
  if (!stateStat.isDirectory()) throw new EvidenceBoundaryError("scratch_state_not_directory");

  const destination = path.join(stateDirectory, fileName);
  if (fs.existsSync(destination)) throw new EvidenceBoundaryError("state_file_already_exists");
  const bytes = `${canonicalJson(value)}\n`;
  const temporary = path.join(stateDirectory, `.${fileName}.${process.pid}.${randomUUID()}.tmp`);
  const descriptor = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(descriptor, bytes, { encoding: "utf8" });
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, destination);
  return { path: destination, sha256: sha256Bytes(bytes) };
}

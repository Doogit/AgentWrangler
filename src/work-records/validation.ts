import { createHash } from "node:crypto";
import { WorkRecordError } from "./types.js";

export function objectWithKeys(
  value: unknown,
  allowed: readonly string[],
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    invalid("object required");
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) invalid(`unknown field: ${unknown[0]}`);
  return record;
}

export function stringField(record: Record<string, unknown>, key: string, max = 128): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0 || value.length > max)
    invalid(`${key} is invalid`);
  return value;
}

export function opaqueIdField(record: Record<string, unknown>, key: string): string {
  const value = stringField(record, key, 36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
    invalid(`${key} must be a daemon-issued UUID`);
  }
  return value;
}

export function integerField(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid(`${key} is invalid`);
  return value as number;
}

export function enumField<T extends string>(
  record: Record<string, unknown>,
  key: string,
  values: readonly T[],
): T {
  const value = stringField(record, key);
  if (!values.includes(value as T)) invalid(`${key} is invalid`);
  return value as T;
}

export function optionalEnumField<T extends string>(
  record: Record<string, unknown>,
  key: string,
  values: readonly T[],
): T | null {
  if (record[key] === undefined || record[key] === null) return null;
  return enumField(record, key, values);
}

export function booleanTrueField(record: Record<string, unknown>, key: string): true {
  if (record[key] !== true) invalid(`${key} must be true`);
  return true;
}

export function isoField(record: Record<string, unknown>, key: string): string {
  const value = stringField(record, key, 40);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) ||
    Number.isNaN(Date.parse(value))
  ) {
    invalid(`${key} must be a UTC ISO-8601 timestamp`);
  }
  return value;
}

export function hashRequest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
}

export function invalid(message: string): never {
  throw new WorkRecordError(400, "INVALID_REQUEST", message);
}

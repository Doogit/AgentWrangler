/** Contract-only freeze test: no comparator, scoring, provider, or operator data. */
import { describe, expect, it } from "vitest";
import {
  EVIDENCE_PACKET_VERSION,
  type EvidencePacket,
  buildEvidencePacket,
} from "../../src/query/api/evidence-packet.js";
import { RIQ6_ANSWER_KEYS } from "./riq6/answer-keys.js";
import {
  RIQ6_CASES,
  RIQ6_COVERAGE_TAGS,
  RIQ6_MALICIOUS_RAW_STRINGS,
  createRiq6Db,
} from "./riq6/cases.js";

function fact(packet: EvidencePacket, key: keyof EvidencePacket["facts"]) {
  return packet.facts[key];
}

describe("RIQ6 frozen synthetic decision cases", () => {
  it("has complete frozen coverage", () => {
    // Exact counts are frozen-fixture semantics: adding a case is a deliberate
    // registry change, not a drive-by. Floors from the spec: >=12 seen, >=2 holdout.
    expect(RIQ6_CASES.filter((caseDefinition) => !caseDefinition.holdout)).toHaveLength(13);
    expect(RIQ6_CASES.filter((caseDefinition) => caseDefinition.holdout)).toHaveLength(2);
    const tags = new Set(RIQ6_CASES.flatMap((caseDefinition) => caseDefinition.coverage_tags));
    for (const tag of RIQ6_COVERAGE_TAGS) expect(tags).toContain(tag);
  });

  it("is deterministic and every key resolves against its packet", () => {
    for (const caseDefinition of RIQ6_CASES) {
      const firstDb = createRiq6Db(caseDefinition);
      const secondDb = createRiq6Db(caseDefinition);
      try {
        const first = buildEvidencePacket(firstDb, caseDefinition.scope);
        const second = buildEvidencePacket(secondDb, caseDefinition.scope);
        expect(first.packet_version).toBe(EVIDENCE_PACKET_VERSION);
        expect(first.packet_identity_hash).toBe(second.packet_identity_hash);
        const key = RIQ6_ANSWER_KEYS[caseDefinition.case_id];
        expect(key).toBeDefined();
        if (key === undefined) throw new Error(`missing RIQ6 key: ${caseDefinition.case_id}`);
        expect(first.freshness.status).toBe(key.expected_freshness);
        for (const reference of key.authoritative_facts) {
          const value = fact(first, reference.fact_key);
          expect(value).toBeDefined();
          expect("state" in value ? value.state : "MEASURED").toBe(reference.expected);
          if (reference.expected_value !== undefined) {
            expect("state" in value).toBe(false);
            if (!("state" in value)) expect(value.value).toBe(reference.expected_value);
          }
        }
        for (const reference of key.required_evidence_links) {
          const value = fact(first, reference);
          expect("state" in value).toBe(false);
          if ("state" in value) continue;
          for (const evidenceId of value.evidence_ids) {
            expect(first.overlap_groups.some((group) => group.evidence_id === evidenceId)).toBe(
              true,
            );
          }
        }
      } finally {
        firstDb.close();
        secondDb.close();
      }
    }
  });

  it("seeds the structural signal each coverage tag claims", () => {
    for (const caseDefinition of RIQ6_CASES) {
      const db = createRiq6Db(caseDefinition);
      try {
        if (caseDefinition.coverage_tags.includes("TOOL_RETRY")) {
          const failed = db
            .prepare(
              "SELECT COUNT(*) AS n FROM tool_events WHERE exit_class IN ('TEST_FAIL','ERROR')",
            )
            .get() as { n: number };
          expect(failed.n).toBeGreaterThan(0);
        }
        if (caseDefinition.coverage_tags.includes("MIX_DRIFT")) {
          const packet = buildEvidencePacket(db, caseDefinition.scope);
          const mix = packet.facts.model_mix;
          if ("state" in mix) throw new Error("expected measured model mix");
          expect(mix.value.length).toBeGreaterThanOrEqual(2);
        }
        if (caseDefinition.coverage_tags.includes("LOWER_COST_WORSE_OUTCOME")) {
          const errors = db
            .prepare("SELECT COUNT(*) AS n FROM tool_events WHERE exit_class = 'ERROR'")
            .get() as { n: number };
          expect(errors.n).toBeGreaterThan(0);
        }
      } finally {
        db.close();
      }
    }
  });

  it("never exports the malicious synthetic raw strings", () => {
    const malicious = RIQ6_CASES.find(
      (caseDefinition) => caseDefinition.case_id === "malicious-evidence",
    );
    expect(malicious).toBeDefined();
    if (malicious === undefined) throw new Error("missing malicious RIQ6 case");
    const db = createRiq6Db(malicious);
    try {
      for (const raw of RIQ6_MALICIOUS_RAW_STRINGS) {
        const seeded = db
          .prepare("SELECT COUNT(*) AS n FROM tool_events WHERE tool_name = ?")
          .get(raw) as { n: number };
        expect(seeded.n).toBeGreaterThan(0);
      }
      const serialized = JSON.stringify(buildEvidencePacket(db, malicious.scope));
      for (const raw of RIQ6_MALICIOUS_RAW_STRINGS) {
        expect(serialized).not.toContain(raw);
        // JSON escaping rewrites backslashes; check the escaped spelling too.
        expect(serialized).not.toContain(JSON.stringify(raw).slice(1, -1));
      }
    } finally {
      db.close();
    }
  });
});

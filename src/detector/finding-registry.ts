import { a1FindingDescriptor } from "./detectors/a1_tool_result_bloat.js";
import { a2FindingDescriptor } from "./detectors/a2_task_output_bloat.js";
import { b1FindingDescriptor } from "./detectors/b1_cache_read_collapse.js";
import { b2FindingDescriptor } from "./detectors/b2_cache_ttl_gap.js";
import { b3FindingDescriptor } from "./detectors/b3_resume_cache_miss.js";
import { b4FindingDescriptor } from "./detectors/b4_mid_session_prefix_break.js";
import { c1FindingDescriptor } from "./detectors/c1_tool_error_rate.js";
import { c2FindingDescriptor } from "./detectors/c2_content_not_found.js";
import { c3FindingDescriptor } from "./detectors/c3_edit_before_read.js";
import { c4FindingDescriptor } from "./detectors/c4_failed_edit_recovery.js";
import { c5FindingDescriptor } from "./detectors/c5_same_error_loop.js";
import { c6FindingDescriptor } from "./detectors/c6_edit_flip_flop.js";
import { c7FindingDescriptor } from "./detectors/c7_bash_failure_cluster.js";
import { c9FindingDescriptor } from "./detectors/c9_denial_friction.js";
import { c11FindingDescriptor } from "./detectors/c11_mcp_output_cap.js";
import { d14FindingDescriptor } from "./detectors/d14_interrupt_cancel.js";
import { e1FindingDescriptor } from "./detectors/e1_orientation_before_first_edit.js";
import { e2FindingDescriptor } from "./detectors/e2_main_thread_mechanical_runs.js";
import { g11FindingDescriptor } from "./detectors/g11_high_spend_failure.js";
import { h1FindingDescriptor } from "./detectors/h1_destructive_operations.js";
import { type FindingDescriptorV2, assertFindingDescriptorV2 } from "./privacy-contract.js";

/**
 * V2 descriptors are owned beside their detectors and collected here. Adding a
 * rule extends this registry, never the shared privacy contract's vocabulary.
 */
const FINDING_DESCRIPTORS: readonly FindingDescriptorV2[] = [
  a1FindingDescriptor,
  a2FindingDescriptor,
  b1FindingDescriptor,
  b2FindingDescriptor,
  b3FindingDescriptor,
  b4FindingDescriptor,
  c1FindingDescriptor,
  c2FindingDescriptor,
  c3FindingDescriptor,
  c4FindingDescriptor,
  c5FindingDescriptor,
  c6FindingDescriptor,
  c7FindingDescriptor,
  c9FindingDescriptor,
  c11FindingDescriptor,
  d14FindingDescriptor,
  e1FindingDescriptor,
  e2FindingDescriptor,
  g11FindingDescriptor,
  h1FindingDescriptor,
];

const descriptorsByRuleId = new Map<string, FindingDescriptorV2>();
for (const descriptor of FINDING_DESCRIPTORS) {
  assertFindingDescriptorV2(descriptor);
  if (descriptorsByRuleId.has(descriptor.rule_id)) {
    throw new TypeError(`duplicate finding descriptor: ${descriptor.rule_id}`);
  }
  descriptorsByRuleId.set(descriptor.rule_id, descriptor);
}

export function findingDescriptor(ruleId: string): FindingDescriptorV2 | null {
  return descriptorsByRuleId.get(ruleId) ?? null;
}

export function registeredFindingDescriptors(): readonly FindingDescriptorV2[] {
  return [...descriptorsByRuleId.values()];
}

import type {
  LifecycleProjectionInput,
  RecommendationLifecycle,
  SafeCode,
} from "../../../src/recommendations/types.js";
import { decideAdmission } from "../../../src/recommendations/types.js";
import { primaryAdmission } from "./decision-fixtures.js";

export const lifecycleFixtures: readonly {
  input: LifecycleProjectionInput;
  expected: RecommendationLifecycle;
}[] = [
  {
    input: {
      dismissed: false,
      snoozed: false,
      stale: false,
      admission: {
        lifecycle: "INVESTIGATE",
        reasonCodes: ["FIXTURE" as SafeCode],
      },
      requiredApplicationCount: 1,
      appliedApplicationCount: 0,
      measurementStarted: false,
      effectVerdict: null,
    },
    expected: "INVESTIGATE",
  },
  {
    input: {
      dismissed: false,
      snoozed: false,
      stale: false,
      admission: decideAdmission(primaryAdmission),
      requiredApplicationCount: 1,
      appliedApplicationCount: 0,
      measurementStarted: false,
      effectVerdict: null,
    },
    expected: "ACTIONABLE",
  },
  {
    input: {
      dismissed: false,
      snoozed: false,
      stale: false,
      admission: decideAdmission(primaryAdmission),
      requiredApplicationCount: 2,
      appliedApplicationCount: 1,
      measurementStarted: false,
      effectVerdict: null,
    },
    expected: "PARTIALLY_ACTIONED",
  },
  {
    input: {
      dismissed: false,
      snoozed: false,
      stale: false,
      admission: decideAdmission(primaryAdmission),
      requiredApplicationCount: 1,
      appliedApplicationCount: 1,
      measurementStarted: false,
      effectVerdict: null,
    },
    expected: "ACTIONED",
  },
  {
    input: {
      dismissed: false,
      snoozed: false,
      stale: false,
      admission: decideAdmission(primaryAdmission),
      requiredApplicationCount: 1,
      appliedApplicationCount: 1,
      measurementStarted: true,
      effectVerdict: null,
    },
    expected: "MEASURING",
  },
  {
    input: {
      dismissed: false,
      snoozed: false,
      stale: false,
      admission: decideAdmission(primaryAdmission),
      requiredApplicationCount: 1,
      appliedApplicationCount: 1,
      measurementStarted: true,
      effectVerdict: "INCONCLUSIVE",
    },
    expected: "MEASURED_INCONCLUSIVE",
  },
  {
    input: {
      dismissed: false,
      snoozed: false,
      stale: false,
      admission: decideAdmission(primaryAdmission),
      requiredApplicationCount: 1,
      appliedApplicationCount: 1,
      measurementStarted: true,
      effectVerdict: "UNSUPPORTED",
    },
    expected: "MEASUREMENT_UNSUPPORTED",
  },
  {
    input: {
      dismissed: false,
      snoozed: false,
      stale: false,
      admission: decideAdmission(primaryAdmission),
      requiredApplicationCount: 1,
      appliedApplicationCount: 1,
      measurementStarted: true,
      effectVerdict: "IMPROVED",
    },
    expected: "MEASURED_IMPROVED",
  },
  {
    input: {
      dismissed: false,
      snoozed: false,
      stale: false,
      admission: decideAdmission(primaryAdmission),
      requiredApplicationCount: 1,
      appliedApplicationCount: 1,
      measurementStarted: true,
      effectVerdict: "NO_EFFECT",
    },
    expected: "MEASURED_NO_EFFECT",
  },
  {
    input: {
      dismissed: false,
      snoozed: false,
      stale: false,
      admission: decideAdmission(primaryAdmission),
      requiredApplicationCount: 1,
      appliedApplicationCount: 1,
      measurementStarted: true,
      effectVerdict: "WORSE",
    },
    expected: "MEASURED_WORSE",
  },
  {
    input: {
      dismissed: true,
      snoozed: true,
      stale: true,
      admission: decideAdmission(primaryAdmission),
      requiredApplicationCount: 1,
      appliedApplicationCount: 1,
      measurementStarted: true,
      effectVerdict: "IMPROVED",
    },
    expected: "DISMISSED",
  },
  {
    input: {
      dismissed: false,
      snoozed: true,
      stale: true,
      admission: decideAdmission(primaryAdmission),
      requiredApplicationCount: 1,
      appliedApplicationCount: 1,
      measurementStarted: true,
      effectVerdict: "IMPROVED",
    },
    expected: "SNOOZED",
  },
  {
    input: {
      dismissed: false,
      snoozed: false,
      stale: true,
      admission: decideAdmission(primaryAdmission),
      requiredApplicationCount: 1,
      appliedApplicationCount: 1,
      measurementStarted: true,
      effectVerdict: "IMPROVED",
    },
    expected: "STALE",
  },
];

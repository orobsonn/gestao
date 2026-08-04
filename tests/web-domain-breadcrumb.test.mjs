/**
 * Locked domain breadcrumb contracts — hierarchical trail, root label, clear-on-unmount names.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveDomainBreadcrumbSegments } from "../src/react-app/lib/domain-routes.ts";

/**
 * @description Nested campanha pathname without custom names yields >= 2 segments and never 'Gestão'.
 */
test("lt-breadcrumb-not-gestao-on-nested", () => {
  const segments = resolveDomainBreadcrumbSegments({
    pathname: "/experts/e1/campanhas/c1",
  });

  assert.ok(Array.isArray(segments), "segments must be an array");
  const labels = segments.map((s) =>
    typeof s === "string" ? s : s.label,
  );
  assert.ok(
    labels.length >= 2,
    `nested path must yield >= 2 segments, got ${labels.length}`,
  );
  assert.equal(
    labels.some((label) => label === "Gestão"),
    false,
    "no segment may equal exactly 'Gestão'",
  );
});

/**
 * @description Pathname /experts resolves to a single segment labeled Experts.
 */
test("lt-breadcrumb-experts-root", () => {
  const segments = resolveDomainBreadcrumbSegments({
    pathname: "/experts",
  });

  assert.ok(Array.isArray(segments), "segments must be an array");
  const labels = segments.map((s) =>
    typeof s === "string" ? s : s.label,
  );
  assert.deepEqual(labels, ["Experts"]);
});

/**
 * @description After nested names are set then cleared, /experts resolves only to Experts (no Ana/Lançamento).
 */
test("lt-breadcrumb-names-clear-on-unmount", () => {
  const nestedWithNames = resolveDomainBreadcrumbSegments({
    pathname: "/experts/e1/campanhas/c1",
    names: { expert: "Ana", campanha: "Lançamento" },
  });
  const nestedLabels = nestedWithNames.map((s) =>
    typeof s === "string" ? s : s.label,
  );
  assert.deepEqual(nestedLabels, ["Experts", "Ana", "Lançamento"]);

  // names cleared on unmount (undefined) — resolve for /experts must not retain prior labels
  const rootAfterClear = resolveDomainBreadcrumbSegments({
    pathname: "/experts",
    names: undefined,
  });
  const rootLabels = rootAfterClear.map((s) =>
    typeof s === "string" ? s : s.label,
  );
  assert.deepEqual(rootLabels, ["Experts"]);
  assert.equal(rootLabels.includes("Ana"), false);
  assert.equal(rootLabels.includes("Lançamento"), false);
});

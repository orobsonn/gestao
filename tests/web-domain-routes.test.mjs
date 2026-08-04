/**
 * Locked domain-routes contract — path builders and hierarchical breadcrumb segments.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildCampanhaPath,
  buildExpertPath,
  buildTarefaPath,
  resolveDomainBreadcrumbSegments,
} from "../src/react-app/lib/domain-routes.ts";

/**
 * @description Path builders for e1/c1/t1 yield exact domain URLs.
 */
test("lt-domain-path-builders", () => {
  assert.equal(buildExpertPath("e1"), "/experts/e1");
  assert.equal(buildCampanhaPath("e1", "c1"), "/experts/e1/campanhas/c1");
  assert.equal(buildTarefaPath("t1"), "/tarefas/t1");
});

/**
 * @description Nested campanha pathname with names yields hierarchical Experts / Ana / Lançamento labels.
 */
test("lt-breadcrumb-segments-hierarchy", () => {
  const segments = resolveDomainBreadcrumbSegments({
    pathname: "/experts/e1/campanhas/c1",
    names: { expert: "Ana", campanha: "Lançamento" },
  });

  assert.ok(Array.isArray(segments), "segments must be an array");
  const labels = segments.map((s) =>
    typeof s === "string" ? s : s.label,
  );
  assert.deepEqual(labels, ["Experts", "Ana", "Lançamento"]);
  assert.equal(
    labels.includes("Gestão"),
    false,
    "nested domain breadcrumb must not collapse to single Gestão title",
  );
});

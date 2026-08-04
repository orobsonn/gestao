/**
 * Locked Campanha tarefas UI contracts — nested route integrity redirect,
 * filter control ids (status+dono only), create-tarefa defaults, task row href.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildCreateTarefaBody,
  CAMPANHA_TASK_FILTER_CONTROL_IDS,
} from "../src/react-app/lib/domain-api.ts";
import {
  buildTarefaPath,
  resolveCampanhaRouteIntegrity,
} from "../src/react-app/lib/domain-routes.ts";

/**
 * @description Nested campanha route integrity redirects when expert_id mismatches route; ok when matched.
 */
test("lt-nested-campanha-canonical-redirect", () => {
  const mismatch = resolveCampanhaRouteIntegrity("e-a", {
    id: "c1",
    expert_id: "e-b",
  });
  assert.deepEqual(mismatch, {
    action: "redirect",
    to: "/experts/e-b/campanhas/c1",
  });

  const match = resolveCampanhaRouteIntegrity("e-b", {
    id: "c1",
    expert_id: "e-b",
  });
  assert.deepEqual(match, { action: "ok" });
});

/**
 * @description Campaign task filter controls are exactly status and dono (no campanha filter control).
 */
test("lt-campaign-filter-controls-only-status-dono", () => {
  assert.ok(
    Array.isArray(CAMPANHA_TASK_FILTER_CONTROL_IDS),
    "CAMPANHA_TASK_FILTER_CONTROL_IDS must be an array",
  );
  assert.deepEqual(
    [...CAMPANHA_TASK_FILTER_CONTROL_IDS].sort(),
    ["dono", "status"].sort(),
  );
  assert.equal(
    CAMPANHA_TASK_FILTER_CONTROL_IDS.includes("campanha"),
    false,
    "no campanha filter control id present",
  );
  assert.equal(
    CAMPANHA_TASK_FILTER_CONTROL_IDS.includes("campanhaId"),
    false,
    "no campanhaId filter control id present",
  );
});

/**
 * @description buildCreateTarefaBody binds campanha_id and titulo; status defaults to a_fazer when omitted.
 */
test("lt-create-tarefa-defaults", () => {
  const body = buildCreateTarefaBody("c1", { titulo: "Escrever copy" });

  assert.equal(body.campanha_id, "c1");
  assert.equal(body.titulo, "Escrever copy");
  assert.equal(body.status, "a_fazer");
  assert.equal(
    body.dono_id === undefined || body.dono_id === null,
    true,
    "optional dono_id omitted or undefined when empty",
  );
  assert.equal(
    body.prazo === undefined || body.prazo === null,
    true,
    "optional prazo omitted or undefined when empty",
  );
  assert.equal(
    body.notas === undefined || body.notas === null || body.notas === "",
    true,
    "optional notas omitted or undefined when empty",
  );
});

/**
 * @description Task list row href via buildTarefaPath is exactly /tarefas/t-9.
 */
test("lt-task-row-href-tarefa-detail", () => {
  assert.equal(buildTarefaPath("t-9"), "/tarefas/t-9");
});

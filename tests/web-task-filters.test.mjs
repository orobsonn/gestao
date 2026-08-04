/**
 * Locked task-filters contract — status + donoId only (no campanha dimension).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FILTER_OPTION_KEYS,
  filterTarefas,
} from "../src/react-app/lib/task-filters.ts";

/**
 * @description Minimal tarefa row for filter assertions.
 * @param {{ id: string, status: string, dono_id: string | null, campanha_id?: string }} row
 */
function tarefa(row) {
  return {
    id: row.id,
    status: row.status,
    dono_id: row.dono_id,
    campanha_id: row.campanha_id ?? "c-default",
    titulo: row.id,
  };
}

/**
 * @description filterTarefas with status a_fazer and donoId null keeps only a_fazer rows.
 */
test("lt-filter-status-only", () => {
  const list = [
    tarefa({ id: "t1", status: "a_fazer", dono_id: "u1" }),
    tarefa({ id: "t2", status: "fazendo", dono_id: "u1" }),
    tarefa({ id: "t3", status: "a_fazer", dono_id: "u2" }),
  ];

  const result = filterTarefas(list, { status: "a_fazer", donoId: null });

  assert.equal(result.length, 2);
  assert.deepEqual(
    result.map((t) => t.id),
    ["t1", "t3"],
  );
  for (const row of result) {
    assert.equal(row.status, "a_fazer");
  }
});

/**
 * @description filterTarefas with donoId u1 and status null keeps only dono_id === u1 rows.
 */
test("lt-filter-dono-only", () => {
  const list = [
    tarefa({ id: "t1", status: "a_fazer", dono_id: "u1" }),
    tarefa({ id: "t2", status: "fazendo", dono_id: "u2" }),
    tarefa({ id: "t3", status: "feito", dono_id: "u1" }),
    tarefa({ id: "t4", status: "a_fazer", dono_id: "u2" }),
  ];

  const result = filterTarefas(list, { status: null, donoId: "u1" });

  assert.equal(result.length, 2);
  assert.deepEqual(
    result.map((t) => t.id),
    ["t1", "t3"],
  );
  for (const row of result) {
    assert.equal(row.dono_id, "u1");
  }
});

/**
 * @description Both filters apply as intersection; both null leaves original order and length.
 */
test("lt-filter-both-and-all", () => {
  const list = [
    tarefa({ id: "t1", status: "a_fazer", dono_id: "u1" }),
    tarefa({ id: "t2", status: "a_fazer", dono_id: "u2" }),
    tarefa({ id: "t3", status: "fazendo", dono_id: "u1" }),
    tarefa({ id: "t4", status: "feito", dono_id: "u2" }),
  ];

  const intersection = filterTarefas(list, {
    status: "a_fazer",
    donoId: "u1",
  });
  assert.equal(intersection.length, 1);
  assert.equal(intersection[0].id, "t1");
  assert.equal(intersection[0].status, "a_fazer");
  assert.equal(intersection[0].dono_id, "u1");

  const allNull = filterTarefas(list, { status: null, donoId: null });
  assert.equal(allNull.length, list.length);
  assert.deepEqual(
    allNull.map((t) => t.id),
    list.map((t) => t.id),
  );
  assert.notEqual(allNull, list, "filter returns a new array even when unfiltered");
});

/**
 * @description Accepted filter option keys are only status and donoId — no campanha dimension.
 */
test("lt-filter-no-campanha-dimension", () => {
  assert.ok(Array.isArray(FILTER_OPTION_KEYS), "FILTER_OPTION_KEYS must be an array");
  assert.deepEqual([...FILTER_OPTION_KEYS].sort(), ["donoId", "status"].sort());
  assert.equal(FILTER_OPTION_KEYS.includes("campanhaId"), false);
  assert.equal(FILTER_OPTION_KEYS.includes("campanha_id"), false);
  assert.equal(FILTER_OPTION_KEYS.includes("campanha"), false);

  const list = [
    tarefa({ id: "t1", status: "a_fazer", dono_id: "u1", campanha_id: "c-a" }),
    tarefa({ id: "t2", status: "a_fazer", dono_id: "u1", campanha_id: "c-b" }),
  ];
  // Extra campanhaId on options must not shrink the list (dimension is ignored / not accepted).
  const withSmuggled = filterTarefas(list, {
    status: null,
    donoId: null,
    campanhaId: "c-a",
  });
  assert.equal(withSmuggled.length, 2);
  assert.deepEqual(
    withSmuggled.map((t) => t.id),
    ["t1", "t2"],
  );
});

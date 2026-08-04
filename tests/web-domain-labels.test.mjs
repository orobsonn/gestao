/**
 * Locked domain-labels contract — pt-br strings for every shared enum value.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CAMPANHA_STATUS,
  CAMPANHA_TIPOS,
  TAREFA_STATUS,
} from "../src/shared/domain/enums.ts";
import {
  labelCampanhaStatus,
  labelCampanhaTipo,
  labelTarefaStatus,
} from "../src/react-app/lib/domain-labels.ts";

/**
 * @description Assert label is a non-empty pt-br string distinct from the raw enum key.
 * @param {string} key
 * @param {string} label
 * @param {string} kind
 */
function assertPtBrLabel(key, label, kind) {
  assert.equal(typeof label, "string", `${kind}(${key}) must return a string`);
  assert.ok(label.length > 0, `${kind}(${key}) must be non-empty`);
  assert.notEqual(
    label,
    key,
    `${kind}(${key}) must differ from the raw snake_case key`,
  );
  // pt-br labels are human copy, not the enum token itself.
  assert.match(
    label,
    /\S/,
    `${kind}(${key}) must contain non-whitespace content`,
  );
}

/**
 * @description Every CAMPANHA_TIPOS, CAMPANHA_STATUS, and TAREFA_STATUS value maps to a non-empty pt-br label ≠ raw key.
 */
test("lt-labels-cover-all-enums", () => {
  for (const tipo of CAMPANHA_TIPOS) {
    assertPtBrLabel(tipo, labelCampanhaTipo(tipo), "labelCampanhaTipo");
  }
  for (const status of CAMPANHA_STATUS) {
    assertPtBrLabel(status, labelCampanhaStatus(status), "labelCampanhaStatus");
  }
  for (const status of TAREFA_STATUS) {
    assertPtBrLabel(status, labelTarefaStatus(status), "labelTarefaStatus");
  }

  assert.equal(CAMPANHA_TIPOS.length, 4);
  assert.equal(CAMPANHA_STATUS.length, 3);
  assert.equal(TAREFA_STATUS.length, 3);
});

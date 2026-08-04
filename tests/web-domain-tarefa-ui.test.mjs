/**
 * Locked Tarefa detail UI contracts — direct delete (no confirm),
 * PATCH body allowlist, and back path to campaign list.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildTarefaPatchBody,
  TAREFA_DELETE_REQUIRES_CONFIRMATION,
} from "../src/react-app/lib/domain-api.ts";
import { buildTarefaBackPath } from "../src/react-app/lib/domain-routes.ts";

const PATCH_ALLOWLIST = ["titulo", "dono_id", "prazo", "status", "notas"];

/**
 * @description TAREFA_DELETE_REQUIRES_CONFIRMATION is false — direct delete, no confirmation modal.
 */
test("lt-tarefa-delete-no-confirm", () => {
  assert.equal(TAREFA_DELETE_REQUIRES_CONFIRMATION, false);
});

/**
 * @description buildTarefaPatchBody emits only allowlisted keys; null clears dono_id/prazo when none chosen; no campanha_id or expert_id.
 */
test("lt-tarefa-patch-body-allowlist", () => {
  const body = buildTarefaPatchBody({
    titulo: "Novo título",
    dono_id: "u1",
    prazo: "2026-08-10",
    status: "em_progresso",
    notas: "https://example.com/brief",
  });

  assert.deepEqual(Object.keys(body).sort(), [...PATCH_ALLOWLIST].sort());
  assert.equal(body.titulo, "Novo título");
  assert.equal(body.dono_id, "u1");
  assert.equal(body.prazo, "2026-08-10");
  assert.equal(body.status, "em_progresso");
  assert.equal(body.notas, "https://example.com/brief");
  assert.equal(
    Object.hasOwn(body, "campanha_id"),
    false,
    "body must not include campanha_id",
  );
  assert.equal(
    Object.hasOwn(body, "expert_id"),
    false,
    "body must not include expert_id",
  );

  const cleared = buildTarefaPatchBody({
    titulo: "Sem dono",
    dono_id: null,
    prazo: null,
    status: "a_fazer",
    notas: "",
  });

  assert.deepEqual(Object.keys(cleared).sort(), [...PATCH_ALLOWLIST].sort());
  assert.equal(cleared.dono_id, null);
  assert.equal(cleared.prazo, null);
  assert.equal(
    Object.hasOwn(cleared, "campanha_id"),
    false,
    "cleared body must not include campanha_id",
  );
  assert.equal(
    Object.hasOwn(cleared, "expert_id"),
    false,
    "cleared body must not include expert_id",
  );
});

/**
 * @description buildTarefaBackPath(campanha) resolves to /experts/{expert_id}/campanhas/{id}.
 */
test("lt-tarefa-back-path", () => {
  assert.equal(
    buildTarefaBackPath({ id: "c1", expert_id: "e1" }),
    "/experts/e1/campanhas/c1",
  );
});

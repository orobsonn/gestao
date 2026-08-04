/**
 * Locked domain enum vocabulary contract — mirrors migration CHECK values.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  USER_ROLES,
  MEMBERSHIP_PAPEIS,
  CAMPANHA_TIPOS,
  CAMPANHA_STATUS,
  TAREFA_STATUS,
} from "../src/shared/domain/enums.ts";

/**
 * @description Named enum arrays match migration CHECK vocabularies in listed order.
 */
test("lt-domain-enums-match-checks", () => {
  assert.deepStrictEqual(USER_ROLES, ["super_admin", "user"]);
  assert.deepStrictEqual(MEMBERSHIP_PAPEIS, ["admin", "membro"]);
  assert.deepStrictEqual(CAMPANHA_TIPOS, [
    "lancamento_pago",
    "gratuito",
    "perpetuo",
    "webinario",
  ]);
  assert.deepStrictEqual(CAMPANHA_STATUS, ["aberta", "encerrada", "arquivada"]);
  assert.deepStrictEqual(TAREFA_STATUS, ["a_fazer", "fazendo", "feito"]);
});

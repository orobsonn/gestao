/**
 * Locked Experts / Expert-campanhas UI contracts — heading, admin create gate,
 * route-bound create-campanha body, list row href.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { CAMPANHA_TIPOS } from "../src/shared/domain/enums.ts";
import {
  buildCreateCampanhaBody,
  EXPERTS_PAGE_HEADING,
  shouldShowDomainCreateActions,
} from "../src/react-app/lib/domain-api.ts";
import { buildExpertPath } from "../src/react-app/lib/domain-routes.ts";

/**
 * @description Experts page heading constant is exactly 'Experts'.
 */
test("lt-experts-heading-constant", () => {
  assert.equal(EXPERTS_PAGE_HEADING, "Experts");
});

/**
 * @description Domain create actions (+ Expert / + Campanha) show only for admin papel.
 */
test("lt-create-actions-admin-only", () => {
  assert.equal(shouldShowDomainCreateActions("admin"), true);
  assert.equal(shouldShowDomainCreateActions("membro"), false);
  assert.equal(shouldShowDomainCreateActions(null), false);
});

/**
 * @description buildCreateCampanhaBody binds expert_id from route only; tipo is a CAMPANHA_TIPOS value; status defaults to aberta when omitted.
 */
test("lt-create-campanha-body-expert-from-route", () => {
  const body = buildCreateCampanhaBody("exp-9", {
    nome: "Lançamento Q1",
    tipo: "lancamento_pago",
  });

  assert.equal(body.expert_id, "exp-9");
  assert.equal(
    Object.hasOwn(body, "expertId"),
    false,
    "body must not carry an alternate expert picker field",
  );
  assert.ok(
    (CAMPANHA_TIPOS).includes(body.tipo),
    `tipo must be one of CAMPANHA_TIPOS, got ${body.tipo}`,
  );
  assert.equal(body.status, "aberta");
});

/**
 * @description Expert list row href via buildExpertPath is exactly /experts/exp-1.
 */
test("lt-experts-row-href", () => {
  assert.equal(buildExpertPath("exp-1"), "/experts/exp-1");
});

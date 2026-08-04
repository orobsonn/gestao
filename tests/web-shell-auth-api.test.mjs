/**
 * Locked web-shell auth-api contracts (credentials, paths, active-empresa body).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AUTH_FETCH_DEFAULTS,
  AUTH_LOGIN_PATH,
  AUTH_ME_PATH,
  buildActiveEmpresaBody,
} from "../src/react-app/lib/auth-api.ts";

/**
 * @description buildActiveEmpresaBody('emp-1') returns object with exactly key empresa_id = 'emp-1'.
 */
test("lt-ac-18-1-active-empresa-body", () => {
  const body = buildActiveEmpresaBody("emp-1");
  assert.equal(typeof body, "object");
  assert.notEqual(body, null);
  assert.equal(Object.keys(body).length, 1);
  assert.equal(Object.keys(body)[0], "empresa_id");
  assert.equal(body.empresa_id, "emp-1");
  assert.equal("empresaId" in body, false);
  assert.equal("id" in body, false);
});

/**
 * @description AUTH_FETCH_DEFAULTS.credentials is 'include'.
 */
test("lt-ld-9-credentials", () => {
  assert.equal(AUTH_FETCH_DEFAULTS.credentials, "include");
});

/**
 * @description AUTH_ME_PATH is '/api/auth/me' and AUTH_LOGIN_PATH is '/api/auth/login'.
 */
test("lt-ac-18-3-auth-me-path", () => {
  assert.equal(AUTH_ME_PATH, "/api/auth/me");
  assert.equal(AUTH_LOGIN_PATH, "/api/auth/login");
});

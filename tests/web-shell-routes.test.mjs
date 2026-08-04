/**
 * Locked web-shell route table, picker branch, platform exemption, and ModeToggle theme contracts.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { isPlatformRouteExempt } from "../src/react-app/lib/session-gate.ts";
import {
  LOGIN_PATH,
  PLATFORM_PATH,
  SHELL_AUTH_PATHS,
  UNKNOWN_PATH_REDIRECT,
  isShellAuthPath,
  resolveShellBranch,
} from "../src/react-app/lib/shell-routes.ts";
import { DEFAULT_THEME, THEME_MODES } from "../src/react-app/lib/theme.ts";

/**
 * @description Minimal me fixture for resolveShellBranch.
 * @param {{ active_empresa_id?: string | null, memberships?: Array<{ empresa_id: string, nome: string, papel: string }> }} overrides
 */
function makeMe(overrides = {}) {
  return {
    id: "u1",
    email: "u1@example.com",
    name: "User One",
    role: "user",
    active_empresa_id:
      overrides.active_empresa_id === undefined
        ? null
        : overrides.active_empresa_id,
    memberships: overrides.memberships ?? [],
  };
}

/**
 * @description SHELL_AUTH_PATHS includes core shell paths; LOGIN_PATH is '/login'; UNKNOWN_PATH_REDIRECT is '/'.
 */
test("lt-ac-18-3-shell-route-table", () => {
  assert.ok(Array.isArray(SHELL_AUTH_PATHS), "SHELL_AUTH_PATHS must be an array");
  for (const path of ["/", "/experts", "/meu-trabalho", "/admin"]) {
    assert.ok(
      SHELL_AUTH_PATHS.includes(path),
      `SHELL_AUTH_PATHS must include ${path}`,
    );
  }
  assert.equal(LOGIN_PATH, "/login");
  assert.equal(UNKNOWN_PATH_REDIRECT, "/");
});

/**
 * @description /platform is not shell-auth-protected; isShellAuthPath false; isPlatformRouteExempt true.
 */
test("lt-ac-18-4-platform-not-in-shell-auth-paths", () => {
  assert.equal(PLATFORM_PATH, "/platform");
  assert.equal(
    SHELL_AUTH_PATHS.includes(PLATFORM_PATH),
    false,
    "PLATFORM_PATH must not be in SHELL_AUTH_PATHS",
  );
  assert.equal(isShellAuthPath("/platform"), false);
  assert.equal(isPlatformRouteExempt("/platform"), true);
});

/**
 * @description resolveShellBranch: multi+null active → empresa-picker; active set or zero memberships → shell; PLATFORM_PATH outside SHELL_AUTH_PATHS.
 */
test("lt-ac-18-5-picker-shell-branch", () => {
  const multi = [
    { empresa_id: "e1", nome: "A", papel: "admin" },
    { empresa_id: "e2", nome: "B", papel: "membro" },
  ];

  assert.equal(
    resolveShellBranch(
      makeMe({ active_empresa_id: null, memberships: multi }),
    ),
    "empresa-picker",
  );
  assert.equal(
    resolveShellBranch(
      makeMe({ active_empresa_id: "e1", memberships: multi }),
    ),
    "shell",
  );
  assert.equal(
    resolveShellBranch(
      makeMe({ active_empresa_id: null, memberships: [] }),
    ),
    "shell",
  );

  assert.equal(PLATFORM_PATH, "/platform");
  assert.equal(
    SHELL_AUTH_PATHS.includes(PLATFORM_PATH),
    false,
    "PLATFORM_PATH must stay outside SHELL_AUTH_PATHS so picker does not wrap /platform",
  );
});

/**
 * @description DEFAULT_THEME is 'system' and THEME_MODES is exactly light, dark, system (ModeToggle contract).
 */
test("lt-ac-19-2-mode-toggle-uses-system-default", () => {
  assert.equal(DEFAULT_THEME, "system");
  assert.ok(Array.isArray(THEME_MODES), "THEME_MODES must be an array");
  assert.deepEqual([...THEME_MODES].sort(), ["dark", "light", "system"].sort());
  assert.equal(THEME_MODES.length, 3);
});

/**
 * @description Nested expert and campanha paths are shell-auth; trailing-empty and /platform are not.
 */
test("lt-shell-auth-nested-expert-campanha", () => {
  assert.equal(isShellAuthPath("/experts/exp-1"), true);
  assert.equal(isShellAuthPath("/experts/exp-1/campanhas/cam-1"), true);
  assert.equal(isShellAuthPath("/experts/"), false);
  assert.equal(isShellAuthPath("/experts/exp-1/campanhas/"), false);
  assert.equal(isShellAuthPath("/platform"), false);
});

/**
 * @description Baseline shell paths stay shell-auth; LOGIN and PLATFORM remain non-shell-auth.
 */
test("lt-shell-auth-keeps-baseline", () => {
  for (const path of ["/", "/experts", "/meu-trabalho", "/admin", "/tarefas/abc"]) {
    assert.equal(
      isShellAuthPath(path),
      true,
      `${path} must be shell-auth`,
    );
  }
  assert.equal(isShellAuthPath(LOGIN_PATH), false);
  assert.equal(isShellAuthPath(PLATFORM_PATH), false);
});

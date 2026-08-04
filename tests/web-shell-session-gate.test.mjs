/**
 * Locked web-shell session-gate + nav + active-papel contracts (pure helpers).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveActivePapel } from "../src/react-app/lib/active-papel.ts";
import { buildSidebarNavItems } from "../src/react-app/lib/nav.ts";
import {
  canAccessAdmin,
  isPlatformRouteExempt,
  needsEmpresaPick,
  needsSingleMembershipHeal,
  shellRedirectPath,
} from "../src/react-app/lib/session-gate.ts";

/**
 * @description Collect path strings from sidebar nav items.
 * @param {Array<{ path?: string }>} items
 * @returns {string[]}
 */
function navPaths(items) {
  return items.map((item) => item.path);
}

/**
 * @description Minimal me fixture for session-gate helpers.
 * @param {{ active_empresa_id?: string | null, memberships?: Array<{ empresa_id: string, nome: string, papel: string }>, role?: string }} overrides
 */
function makeMe(overrides = {}) {
  return {
    id: "u1",
    email: "u1@example.com",
    name: "User One",
    role: overrides.role ?? "user",
    active_empresa_id:
      overrides.active_empresa_id === undefined
        ? null
        : overrides.active_empresa_id,
    memberships: overrides.memberships ?? [],
  };
}

/**
 * @description buildSidebarNavItems with activePapel membro omits path '/admin'.
 */
test("lt-ac-18-2-admin-nav-hidden-membro", () => {
  const items = buildSidebarNavItems({ activePapel: "membro" });
  assert.ok(Array.isArray(items));
  assert.equal(
    navPaths(items).includes("/admin"),
    false,
    "membro must not see /admin nav",
  );
});

/**
 * @description buildSidebarNavItems with activePapel admin includes path '/admin'.
 */
test("lt-ac-18-2-admin-nav-shown-admin", () => {
  const items = buildSidebarNavItems({ activePapel: "admin" });
  assert.ok(Array.isArray(items));
  assert.ok(
    navPaths(items).includes("/admin"),
    "admin must see /admin nav",
  );
});

/**
 * @description buildSidebarNavItems with activePapel null omits path '/admin'.
 */
test("lt-ac-18-2-admin-nav-hidden-null", () => {
  const items = buildSidebarNavItems({ activePapel: null });
  assert.ok(Array.isArray(items));
  assert.equal(
    navPaths(items).includes("/admin"),
    false,
    "null activePapel must not see /admin nav",
  );
});

/**
 * @description Dual-axis: canAccessAdmin and Admin nav use activePapel only — users.role is never passed; super_admin role with membro/null papel stays denied.
 */
test("lt-ac-18-2-admin-ignores-users-role", () => {
  // Dual-axis fixture: platform role super_admin must not elevate empresa Admin UI.
  // buildSidebarNavItems accepts only { activePapel } — call with that sole arg
  // (if the API required users.role, these calls would fail).
  assert.equal(canAccessAdmin("membro"), false);
  assert.equal(canAccessAdmin(null), false);

  const membroItems = buildSidebarNavItems({ activePapel: "membro" });
  const nullItems = buildSidebarNavItems({ activePapel: null });
  assert.equal(navPaths(membroItems).includes("/admin"), false);
  assert.equal(navPaths(nullItems).includes("/admin"), false);

  // Signature contract: single options bag — no users.role parameter.
  assert.equal(
    buildSidebarNavItems.length,
    1,
    "buildSidebarNavItems takes one argument ({ activePapel }) only",
  );
});

/**
 * @description For any activePapel (null, membro, admin), nav always includes core paths '/', '/experts', '/meu-trabalho'.
 */
test("lt-ac-18-3-nav-core-routes", () => {
  const core = ["/", "/experts", "/meu-trabalho"];
  for (const activePapel of [null, "membro", "admin"]) {
    const paths = navPaths(buildSidebarNavItems({ activePapel }));
    for (const p of core) {
      assert.ok(
        paths.includes(p),
        `activePapel=${String(activePapel)} must include ${p}`,
      );
    }
  }
});

/**
 * @description resolveActivePapel maps active empresa to membership papel; null/stale id → null.
 */
test("lt-ac-18-1-active-papel", () => {
  const memberships = [
    { empresa_id: "e1", papel: "admin", nome: "A" },
    { empresa_id: "e2", papel: "membro", nome: "B" },
  ];

  assert.equal(
    resolveActivePapel({ activeEmpresaId: "e1", memberships }),
    "admin",
  );
  assert.equal(
    resolveActivePapel({ activeEmpresaId: "e2", memberships }),
    "membro",
  );
  assert.equal(
    resolveActivePapel({ activeEmpresaId: null, memberships }),
    null,
  );
  assert.equal(
    resolveActivePapel({ activeEmpresaId: "e999", memberships }),
    null,
  );
});

/**
 * @description needsEmpresaPick is true when multi-membership and active null; false when active is set.
 */
test("lt-ac-18-5-needs-empresa-pick", () => {
  const multi = [
    { empresa_id: "e1", nome: "A", papel: "admin" },
    { empresa_id: "e2", nome: "B", papel: "membro" },
  ];

  const meNoActive = makeMe({
    active_empresa_id: null,
    memberships: multi,
  });
  assert.equal(needsEmpresaPick(meNoActive), true);

  const meWithActive = makeMe({
    active_empresa_id: "e1",
    memberships: multi,
  });
  assert.equal(needsEmpresaPick(meWithActive), false);
});

/**
 * @description Single membership + null active → heal true and pick false; zero memberships → both false.
 */
test("lt-ac-18-5-single-heal", () => {
  const single = makeMe({
    active_empresa_id: null,
    memberships: [{ empresa_id: "e1", nome: "A", papel: "admin" }],
  });
  assert.equal(needsSingleMembershipHeal(single), true);
  assert.equal(needsEmpresaPick(single), false);

  const zero = makeMe({
    active_empresa_id: null,
    memberships: [],
  });
  assert.equal(needsEmpresaPick(zero), false);
  assert.equal(needsSingleMembershipHeal(zero), false);
});

/**
 * @description shellRedirectPath: unauth shell → /login; authed on /login → /; authed on shell path → null.
 */
test("lt-ac-18-3-shell-redirect", () => {
  assert.equal(
    shellRedirectPath({ authed: false, path: "/experts" }),
    "/login",
  );
  assert.equal(
    shellRedirectPath({ authed: true, path: "/login" }),
    "/",
  );
  assert.equal(
    shellRedirectPath({ authed: true, path: "/experts" }),
    null,
  );
});

/**
 * @description /platform is platform-route-exempt; unauth shellRedirectPath on /platform returns null (no force login).
 */
test("lt-ac-18-4-platform-exempt", () => {
  assert.equal(isPlatformRouteExempt("/platform"), true);
  assert.equal(
    shellRedirectPath({ authed: false, path: "/platform" }),
    null,
  );
});

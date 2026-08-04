/**
 * Locked platform UI access helper — create form gate by users.role.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { canShowPlatformCreate } from "../src/react-app/lib/platform-access.ts";

/**
 * @description canShowPlatformCreate returns false for role user (create form must not render).
 */
test("lt-ac-22-ui-denied-non-sa", () => {
  assert.equal(canShowPlatformCreate("user"), false);
});

/**
 * @description canShowPlatformCreate returns true for role super_admin (create form may render).
 */
test("lt-ac-22-ui-allow-sa", () => {
  assert.equal(canShowPlatformCreate("super_admin"), true);
});

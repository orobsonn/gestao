/**
 * @description Locked web-shell shadcn kit inventory and theme foundation contracts.
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const UI_DIR = resolve(ROOT, "src/react-app/components/ui");
const UTILS_TS = resolve(ROOT, "src/react-app/lib/utils.ts");
const COMPONENTS_JSON = resolve(ROOT, "components.json");
const PACKAGE_JSON = resolve(ROOT, "package.json");

/** Kit component basenames required under components/ui (sonner must be sonner.tsx). */
const KIT_COMPONENTS = [
  "sidebar",
  "breadcrumb",
  "button",
  "dropdown-menu",
  "avatar",
  "separator",
  "card",
  "badge",
  "table",
  "input",
  "label",
  "textarea",
  "select",
  "dialog",
  "sheet",
  "tabs",
  "toggle-group",
  "calendar",
  "popover",
  "alert",
  "sonner",
  "skeleton",
  "spinner",
  "scroll-area",
  "tooltip",
  "empty",
  "chart",
];

/**
 * @description Returns true when a kit component file exists as exact name or name.tsx.
 * @param {string[]} entries
 * @param {string} base
 */
function hasComponentFile(entries, base) {
  if (base === "sonner") {
    return entries.includes("sonner.tsx");
  }
  return entries.includes(base) || entries.includes(`${base}.tsx`);
}

/**
 * @description Every kit component file exists under ui/; utils.ts is absent; components.json aliases.utils is @/lib/cn; package.json has shadcn-required deps.
 */
test("lt-ac-19-1-kit-inventory", () => {
  assert.ok(existsSync(UI_DIR), "src/react-app/components/ui must exist");

  const entries = readdirSync(UI_DIR);
  const missing = KIT_COMPONENTS.filter((name) => !hasComponentFile(entries, name));
  assert.deepEqual(
    missing,
    [],
    `missing kit component files: ${missing.join(", ")}`,
  );

  assert.equal(
    existsSync(UTILS_TS),
    false,
    "src/react-app/lib/utils.ts must not exist",
  );

  assert.ok(existsSync(COMPONENTS_JSON), "components.json must exist");
  const componentsJson = JSON.parse(readFileSync(COMPONENTS_JSON, "utf8"));
  const utilsAlias =
    componentsJson?.aliases?.utils ?? componentsJson?.aliases?.["utils"];
  assert.equal(
    utilsAlias,
    "@/lib/cn",
    "components.json aliases.utils must point to @/lib/cn",
  );

  const pkg = JSON.parse(readFileSync(PACKAGE_JSON, "utf8"));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };

  const hasCvaOrClsx =
    Object.hasOwn(deps, "class-variance-authority") || Object.hasOwn(deps, "clsx");
  assert.ok(
    hasCvaOrClsx,
    "package.json must include class-variance-authority or clsx",
  );
  assert.ok(Object.hasOwn(deps, "tailwind-merge"), "package.json must include tailwind-merge");
  assert.ok(Object.hasOwn(deps, "lucide-react"), "package.json must include lucide-react");
  assert.ok(Object.hasOwn(deps, "sonner"), "package.json must include sonner");
  assert.ok(Object.hasOwn(deps, "next-themes"), "package.json must include next-themes");
});

/**
 * @description DEFAULT_THEME is the string 'system' and THEME_MODES is exactly light, dark, system.
 */
test("lt-ac-19-2-theme-default-system", async () => {
  const theme = await import("../src/react-app/lib/theme.ts");
  assert.equal(theme.DEFAULT_THEME, "system");
  assert.ok(Array.isArray(theme.THEME_MODES), "THEME_MODES must be an array");
  assert.deepEqual([...theme.THEME_MODES].sort(), ["dark", "light", "system"].sort());
  assert.equal(theme.THEME_MODES.length, 3);
});

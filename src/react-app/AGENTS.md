# src/react-app/ — folder law

SPA shell (Vite + React + shadcn/ui) for auth session UI and tenant navigation.

## Conventions

- **cn helper:** `lib/cn.ts` only — never `lib/utils.ts`. `components.json` aliases.utils → `@/lib/cn`.
- **Theme:** `lib/theme.ts` `DEFAULT_THEME='system'`; `ThemeProvider` attribute=class + enableSystem; ModeToggle uses `THEME_MODES`.
- **Auth fetches:** always `credentials: 'include'`; never store password client-side.
- **After login / setActiveEmpresa:** always `GET /api/auth/me` before exposing `me`.
- **active-empresa body:** exactly `{ empresa_id }` (not camelCase).
- **Dual-axis:** Admin nav/route = active membership `papel` only; platform create = `users.role === 'super_admin'` only.
- **/platform:** outside shell `RequireAuth` and outside blocking empresa picker; page self-gates.
- **Empresa gate:** multi + null active → blocking picker under shell only; single + null → heal POST; zero memberships → shell OK.
- **AuthProvider:** session state only — never render EmpresaPicker or unmount the router.
- **Tenant page fetch:** key load effects on `me.active_empresa_id`; cancel stale in-flight responses before `setState` (Home pattern).
- **Home lens:** pure `resolveHomeLens` in `lib/home-lens.ts` (admin Tudo|Só meu|Só empresa; membro personal-only).
- **Hermetic locks:** `tests/web-shell-*.test.mjs` / `tests/web-home-*.test.mjs` via `node --experimental-strip-types --test`. Relative imports in pure libs use `.ts` suffix for Node ESM.

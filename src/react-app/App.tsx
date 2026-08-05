/** @description SPA root routes — login, platform (exempt), shell under RequireAuth. */

import { Navigate, Outlet, Route, Routes } from "react-router-dom";
import { AppShell } from "./components/app-shell";
import { EmpresaPicker } from "./components/empresa-picker";
import { RequireAuth } from "./components/require-auth";
import { RequireEmpresaAdmin } from "./components/require-empresa-admin";
import {
  PLATFORM_PATH,
  UNKNOWN_PATH_REDIRECT,
  resolveShellBranch,
} from "./lib/shell-routes";
import { AdminPage } from "./pages/AdminPage";
import { CampanhaTarefasPage } from "./pages/CampanhaTarefasPage";
import { ExpertCampanhasPage } from "./pages/ExpertCampanhasPage";
import { ExpertsPage } from "./pages/ExpertsPage";
import { HomePage } from "./pages/HomePage";
import { LoginPage } from "./pages/LoginPage";
import { MeuTrabalhoPlaceholder } from "./pages/MeuTrabalhoPlaceholder";
import { PlatformPage } from "./pages/PlatformPage";
import { TarefaDetailPage } from "./pages/TarefaDetailPage";
import { useAuth } from "./providers/auth-provider";

/**
 * @description Under RequireAuth: blocking EmpresaPicker when needs pick; else AppShell + Outlet.
 */
function ShellGate() {
  const { me } = useAuth();
  // RequireAuth guarantees me is non-null before this renders
  if (!me) {
    return null;
  }
  if (resolveShellBranch(me) === "empresa-picker") {
    return <EmpresaPicker memberships={me.memberships} />;
  }
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}

/**
 * @description React Router shell: /login, /platform (no RequireAuth), shell tree under auth.
 */
export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path={PLATFORM_PATH} element={<PlatformPage />} />
      <Route
        element={
          <RequireAuth>
            <ShellGate />
          </RequireAuth>
        }
      >
        <Route path="/" element={<HomePage />} />
        <Route path="/experts" element={<ExpertsPage />} />
        <Route path="/experts/:expertId" element={<ExpertCampanhasPage />} />
        <Route
          path="/experts/:expertId/campanhas/:campanhaId"
          element={<CampanhaTarefasPage />}
        />
        <Route path="/meu-trabalho" element={<MeuTrabalhoPlaceholder />} />
        <Route path="/tarefas/:id" element={<TarefaDetailPage />} />
        <Route
          path="/admin"
          element={
            <RequireEmpresaAdmin>
              <AdminPage />
            </RequireEmpresaAdmin>
          }
        />
        <Route
          path="*"
          element={<Navigate to={UNKNOWN_PATH_REDIRECT} replace />}
        />
      </Route>
    </Routes>
  );
}

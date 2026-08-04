/** @description SPA root routes — minimal shell with /platform. */

import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { PlatformPage } from "./pages/PlatformPage";

/**
 * @description React Router shell; /platform is the platform create UI.
 */
export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/platform" element={<PlatformPage />} />
        <Route path="*" element={<Navigate to="/platform" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

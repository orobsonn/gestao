/** @description Full-page empresa picker UI — lists memberships; selection via onSelect or useAuth. */

import { useState } from "react";
import { Building2 } from "lucide-react";
import { useNavigate } from "react-router-dom";
import type { MeMembership } from "@/lib/session-gate";
import { useAuth } from "@/providers/auth-provider";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export type EmpresaPickerProps = {
  memberships: MeMembership[];
  onSelect?: (empresaId: string) => void | Promise<void>;
  busy?: boolean;
  error?: string | null;
};

/**
 * @description Full-page card list of empresas; click selects via onSelect or setActiveEmpresa.
 */
export function EmpresaPicker({
  memberships,
  onSelect,
  busy: busyProp = false,
  error = null,
}: EmpresaPickerProps) {
  const { setActiveEmpresa, logout } = useAuth();
  const navigate = useNavigate();
  const [selecting, setSelecting] = useState(false);
  const busy = busyProp || selecting;

  async function handleSelect(empresaId: string) {
    if (busy) return;
    setSelecting(true);
    try {
      if (onSelect) {
        await onSelect(empresaId);
        return;
      }
      await setActiveEmpresa(empresaId);
    } finally {
      setSelecting(false);
    }
  }

  async function handleSair() {
    await logout();
    navigate("/login", { replace: true });
  }

  return (
    <div className="flex min-h-svh items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Escolha a empresa</CardTitle>
          <CardDescription>
            Selecione a empresa com a qual deseja trabalhar.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {error ? (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          {memberships.map((m) => (
            <Button
              key={m.empresa_id}
              type="button"
              variant="outline"
              className="h-auto justify-start gap-3 px-4 py-3"
              disabled={busy}
              onClick={() => void handleSelect(m.empresa_id)}
            >
              <Building2 className="size-4 shrink-0 text-muted-foreground" />
              <span className="text-left font-medium">{m.nome}</span>
            </Button>
          ))}
        </CardContent>
        <CardFooter>
          <Button
            type="button"
            variant="ghost"
            className="w-full"
            onClick={() => void handleSair()}
          >
            Sair
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}

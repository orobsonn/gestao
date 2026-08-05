/** @description Minha conta page — Telegram link status, mint deep-link, refresh on focus while pending. */

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { mintTelegramLink } from "@/lib/auth-api";
import {
  mapTelegramLinkBadge,
  shouldRefetchTelegramStatusOnFocus,
} from "@/lib/minha-conta-ui";
import { useAuth } from "@/providers/auth-provider";

/**
 * @description Account surface: Telegram card with vinculado|pendente badge, Vincular + Atualizar.
 */
export function MinhaContaPage() {
  const { me, refreshMe } = useAuth();
  const [minting, setMinting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const linked = me?.telegram?.linked === true;
  const badgeLabel = mapTelegramLinkBadge(linked);

  useEffect(() => {
    if (!shouldRefetchTelegramStatusOnFocus(linked)) {
      return;
    }

    function onFocusOrVisible() {
      if (document.visibilityState === "hidden") {
        return;
      }
      void refreshMe();
    }

    window.addEventListener("focus", onFocusOrVisible);
    document.addEventListener("visibilitychange", onFocusOrVisible);
    return () => {
      window.removeEventListener("focus", onFocusOrVisible);
      document.removeEventListener("visibilitychange", onFocusOrVisible);
    };
  }, [linked, refreshMe]);

  async function handleVincular() {
    setMinting(true);
    try {
      const { deep_link } = await mintTelegramLink();
      window.open(deep_link, "_blank");
    } catch {
      toast.error("Não foi possível gerar o link do Telegram. Tente de novo.");
    } finally {
      setMinting(false);
    }
  }

  async function handleAtualizar() {
    setRefreshing(true);
    try {
      await refreshMe();
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Minha conta</h1>
        <p className="text-sm text-muted-foreground">
          Dados da sessão e vínculos externos.
        </p>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
          <div className="space-y-1.5">
            <CardTitle>Telegram</CardTitle>
            <CardDescription>
              Vincule seu Telegram para receber avisos por mensagem direta.
            </CardDescription>
          </div>
          <Badge variant={linked ? "default" : "secondary"}>{badgeLabel}</Badge>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {!linked ? (
            <Alert>
              <AlertTitle>Pendente</AlertTitle>
              <AlertDescription>
                Gere o link, abra no Telegram e toque em Iniciar. Depois use
                Atualizar status (ou volte a esta aba) para confirmar.
              </AlertDescription>
            </Alert>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              disabled={minting}
              onClick={() => void handleVincular()}
            >
              Vincular Telegram
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={refreshing}
              onClick={() => void handleAtualizar()}
            >
              Atualizar status
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

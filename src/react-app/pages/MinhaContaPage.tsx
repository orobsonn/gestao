/** @description Minha conta page — Telegram link status, mint deep-link, unlink, refresh on focus while pending. */

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
import { mintTelegramLink, unlinkTelegram } from "@/lib/auth-api";
import {
  DESVINCULAR_BUTTON_LABEL,
  mapTelegramLinkBadge,
  resolveTelegramAccountActions,
  resolveUnlinkFeedback,
  shouldRefetchTelegramStatusOnFocus,
  UNLINK_REQUIRES_CONFIRMATION,
} from "@/lib/minha-conta-ui";
import { useAuth } from "@/providers/auth-provider";

/**
 * @description Account page: Telegram card with vinculado|pendente badge; Desvincular when linked, Vincular + Atualizar when pending.
 */
export function MinhaContaPage() {
  const { me, refreshMe } = useAuth();
  const [minting, setMinting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [unlinking, setUnlinking] = useState(false);

  const linked = me?.telegram?.linked === true;
  const badgeLabel = mapTelegramLinkBadge(linked);
  const actions = resolveTelegramAccountActions(linked);

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

  async function handleDesvincular() {
    if (UNLINK_REQUIRES_CONFIRMATION) return;

    setUnlinking(true);
    try {
      await unlinkTelegram();
      const next = await refreshMe();
      if (
        resolveUnlinkFeedback({ unlinkSucceeded: true, nextMe: next }) ===
        "error"
      ) {
        toast.error(
          "Não foi possível confirmar o desvínculo. Tente de novo.",
        );
        return;
      }
      toast.success("Telegram desvinculado.");
    } catch {
      toast.error(
        "Não foi possível desvincular o Telegram. Tente de novo.",
      );
    } finally {
      setUnlinking(false);
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
            {actions.includes("desvincular") ? (
              <Button
                type="button"
                variant="outline"
                disabled={unlinking}
                onClick={() => void handleDesvincular()}
              >
                {DESVINCULAR_BUTTON_LABEL}
              </Button>
            ) : null}
            {actions.includes("vincular") ? (
              <Button
                type="button"
                disabled={minting}
                onClick={() => void handleVincular()}
              >
                Vincular Telegram
              </Button>
            ) : null}
            {actions.includes("atualizar") ? (
              <Button
                type="button"
                variant="outline"
                disabled={refreshing}
                onClick={() => void handleAtualizar()}
              >
                Atualizar status
              </Button>
            ) : null}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

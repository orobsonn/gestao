/** @description Admin Telegram tab panel — empresa bind status + mint, experts list + per-expert mint. Uses authFetch (credentials include). Never sends chat/thread ids. */

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { displayTelegramMintCommand } from "@/lib/admin-ui";
import {
  fetchBindings,
  mintEmpresaCommand,
  mintExpertCommand,
  type TelegramBindingsStatus,
  type TelegramMintResponse,
} from "@/lib/domain-api";

type MintState = {
  command: string | null;
  expiresAt: string | null;
  loading: boolean;
};

export function AdminTelegramPanel({
  activeEmpresaId,
}: {
  activeEmpresaId: string | null;
}) {
  const [status, setStatus] = useState<TelegramBindingsStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [empresaMint, setEmpresaMint] = useState<MintState>({
    command: null,
    expiresAt: null,
    loading: false,
  });
  const [expertMints, setExpertMints] = useState<
    Record<string, MintState>
  >({});

  const loadBindings = useCallback(
    async (cancelled: { current: boolean }) => {
      if (!activeEmpresaId) {
        setStatus(null);
        setLoading(false);
        return;
      }
      setLoading(true);
      setLoadError(null);
      try {
        const data = await fetchBindings();
        if (!cancelled.current) {
          setStatus(data);
        }
      } catch {
        if (!cancelled.current) {
          const message =
            "Não foi possível carregar o status do Telegram. Tente novamente.";
          setLoadError(message);
          setStatus(null);
          toast.error(message);
        }
      } finally {
        if (!cancelled.current) {
          setLoading(false);
        }
      }
    },
    [activeEmpresaId],
  );

  useEffect(() => {
    const cancelled = { current: false };
    setStatus(null);
    setEmpresaMint({ command: null, expiresAt: null, loading: false });
    setExpertMints({});
    void loadBindings(cancelled);
    return () => {
      cancelled.current = true;
    };
  }, [activeEmpresaId, loadBindings]);

  async function handleMintEmpresa() {
    setEmpresaMint((s) => ({ ...s, loading: true }));
    try {
      const res = await mintEmpresaCommand();
      const displayed = displayTelegramMintCommand(res.command);
      setEmpresaMint({
        command: displayed,
        expiresAt: res.expires_at,
        loading: false,
      });
      toast.success("Comando gerado. Copie e envie no grupo.");
      // refresh status after mint (prior unused invalidated)
      const cancelled = { current: false };
      await loadBindings(cancelled);
    } catch {
      toast.error("Não foi possível gerar o comando.");
      setEmpresaMint((s) => ({ ...s, loading: false }));
    }
  }

  async function handleMintExpert(expertId: string) {
    setExpertMints((prev) => ({
      ...prev,
      [expertId]: { command: null, expiresAt: null, loading: true },
    }));
    try {
      const res = await mintExpertCommand(expertId);
      const displayed = displayTelegramMintCommand(res.command);
      setExpertMints((prev) => ({
        ...prev,
        [expertId]: {
          command: displayed,
          expiresAt: res.expires_at,
          loading: false,
        },
      }));
      toast.success("Comando gerado. Copie e envie no tópico.");
      const cancelled = { current: false };
      await loadBindings(cancelled);
    } catch {
      toast.error("Não foi possível gerar o comando para o expert.");
      setExpertMints((prev) => ({
        ...prev,
        [expertId]: { command: null, expiresAt: null, loading: false },
      }));
    }
  }

  function handleCopy(text: string) {
    void navigator.clipboard.writeText(text).then(() => {
      toast.success("Comando copiado para a área de transferência.");
    });
  }

  const empresaLinked = status?.empresa.linked ?? false;
  const empresaBadge = empresaLinked ? "Mapeado" : "Pendente";

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
          <div className="space-y-1.5">
            <CardTitle>Empresa — Grupo do Telegram</CardTitle>
            <CardDescription>
              Vincule o grupo da empresa para receber notificações.
            </CardDescription>
          </div>
          {!loading && status ? (
            <Badge variant={empresaLinked ? "default" : "outline"}>
              {empresaBadge}
            </Badge>
          ) : null}
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {loadError ? (
            <p className="text-sm text-destructive">{loadError}</p>
          ) : null}

          {loading ? (
            <div className="flex flex-col gap-2" aria-busy="true">
              <Skeleton className="h-10 w-full rounded-md" />
              <Skeleton className="h-9 w-32 rounded-md" />
            </div>
          ) : null}

          {!loading && !loadError ? (
            <>
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  type="button"
                  onClick={() => void handleMintEmpresa()}
                  disabled={empresaMint.loading}
                >
                  {empresaMint.loading ? "Gerando…" : "Gerar comando"}
                </Button>
                {empresaMint.command ? (
                  <div className="flex flex-1 items-center gap-2 rounded-md border bg-muted/50 px-3 py-2 font-mono text-sm">
                    <span className="truncate">{empresaMint.command}</span>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() => handleCopy(empresaMint.command!)}
                    >
                      Copiar
                    </Button>
                  </div>
                ) : null}
              </div>
              {empresaMint.expiresAt ? (
                <p className="text-xs text-muted-foreground">
                  Expira em {new Date(empresaMint.expiresAt).toLocaleString()}
                </p>
              ) : null}
            </>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Experts — Tópicos</CardTitle>
          <CardDescription>
            Gere comandos individuais por expert para vincular tópicos.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {loading ? (
            <div className="flex flex-col gap-2" aria-busy="true">
              <Skeleton className="h-12 w-full rounded-md" />
              <Skeleton className="h-12 w-full rounded-md" />
            </div>
          ) : null}

          {!loading && status?.experts.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nenhum expert cadastrado.
            </p>
          ) : null}

          {!loading &&
            status?.experts.map((exp) => {
              const mint = expertMints[exp.expert_id] ?? {
                command: null,
                expiresAt: null,
                loading: false,
              };
              const badgeLabel = exp.linked ? "Mapeado" : "Pendente";
              return (
                <div
                  key={exp.expert_id}
                  className="flex flex-col gap-2 rounded-md border p-4"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <span className="font-medium">{exp.nome}</span>
                      <Badge variant={exp.linked ? "default" : "outline"}>
                        {badgeLabel}
                      </Badge>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => void handleMintExpert(exp.expert_id)}
                      disabled={mint.loading}
                    >
                      {mint.loading ? "Gerando…" : "Gerar comando"}
                    </Button>
                  </div>
                  {mint.command ? (
                    <div className="flex items-center gap-2 rounded-md border bg-muted/50 px-3 py-2 font-mono text-sm">
                      <span className="truncate">{mint.command}</span>
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={() => handleCopy(mint.command!)}
                      >
                        Copiar
                      </Button>
                    </div>
                  ) : null}
                  {mint.expiresAt ? (
                    <p className="text-xs text-muted-foreground">
                      Expira em {new Date(mint.expiresAt).toLocaleString()}
                    </p>
                  ) : null}
                </div>
              );
            })}
        </CardContent>
      </Card>
    </div>
  );
}

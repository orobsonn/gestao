/** @description Admin page — Pessoas (membros) and IA (LLM settings) tabs. */

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Plus } from "lucide-react";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  ADMIN_TAB_IDS,
  buildCreateMembroBody,
  mapLlmHealthReasonCopy,
  mapLlmStatusBadge,
  type AdminTabId,
} from "@/lib/admin-ui";
import { AdminTelegramPanel } from "@/components/admin-telegram-panel";
import {
  createMembro,
  fetchLlmHealth,
  fetchLlmSettings,
  fetchMembros,
  putLlmSettings,
  validateLlmSettings,
  type LlmHealthResponse,
  type LlmProvider,
  type LlmSettingsMetadata,
  type MembroListRow,
} from "@/lib/domain-api";
import {
  MEMBERSHIP_PAPEIS,
  type MembershipPapel,
} from "../../shared/domain/enums.ts";
import { useAuth } from "@/providers/auth-provider";
import { useDomainBreadcrumbNames } from "@/providers/breadcrumb-provider";

const PAPEL_LABELS: Record<MembershipPapel, string> = {
  admin: "Admin",
  membro: "Membro",
};

const PROVIDER_LABELS: Record<LlmProvider, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
};

/**
 * @description Loading skeleton for the membros table body.
 */
function MembrosLoadingSkeleton() {
  return (
    <div className="flex flex-col gap-2" aria-busy="true" aria-live="polite">
      <Skeleton className="h-10 w-full rounded-md" />
      <Skeleton className="h-12 w-full rounded-md" />
      <Skeleton className="h-12 w-full rounded-md" />
      <Skeleton className="h-12 w-full rounded-md" />
    </div>
  );
}

/**
 * @description Badge variant for LLM Metadata status.
 */
function llmStatusBadgeVariant(
  status: LlmSettingsMetadata["status"],
): "default" | "secondary" | "destructive" | "outline" {
  if (status === "valid") return "default";
  if (status === "invalid") return "destructive";
  if (status === "unvalidated") return "secondary";
  return "outline";
}

/**
 * @description Admin surface: tabs Pessoas | IA under RequireEmpresaAdmin.
 */
export function AdminPage() {
  const { me } = useAuth();
  const activeEmpresaId = me?.active_empresa_id ?? null;

  useDomainBreadcrumbNames({});

  const [tab, setTab] = useState<AdminTabId>("pessoas");

  // ── Pessoas ──────────────────────────────────────────────────────────────
  const [membros, setMembros] = useState<MembroListRow[]>([]);
  const [membrosLoading, setMembrosLoading] = useState(true);
  const [membrosError, setMembrosError] = useState<string | null>(null);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createEmail, setCreateEmail] = useState("");
  const [createPassword, setCreatePassword] = useState("");
  const [createPapel, setCreatePapel] = useState<MembershipPapel>("membro");
  const [creating, setCreating] = useState(false);

  const resetCreateForm = useCallback(() => {
    setCreateName("");
    setCreateEmail("");
    setCreatePassword("");
    setCreatePapel("membro");
  }, []);

  const loadMembros = useCallback(async (cancelled: { current: boolean }) => {
    setMembrosLoading(true);
    setMembrosError(null);
    try {
      const rows = await fetchMembros();
      if (!cancelled.current) {
        setMembros(rows);
      }
    } catch {
      if (!cancelled.current) {
        const message =
          "Não foi possível carregar as pessoas. Tente novamente.";
        setMembrosError(message);
        setMembros([]);
        toast.error(message);
      }
    } finally {
      if (!cancelled.current) {
        setMembrosLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    const cancelled = { current: false };
    setMembros([]);
    void loadMembros(cancelled);
    return () => {
      cancelled.current = true;
    };
  }, [activeEmpresaId, loadMembros]);

  async function onCreateMembro(e: FormEvent) {
    e.preventDefault();
    const name = createName.trim();
    const email = createEmail.trim();
    const password = createPassword;
    if (!name || !email || !password) return;

    setCreating(true);
    try {
      const body = buildCreateMembroBody({
        name,
        email,
        password,
        papel: createPapel,
      });
      await createMembro(body);
      toast.success("Pessoa adicionada.");
      setDialogOpen(false);
      resetCreateForm();
      const cancelled = { current: false };
      await loadMembros(cancelled);
    } catch {
      toast.error("Não foi possível adicionar a pessoa.");
    } finally {
      setCreating(false);
      // Never keep password beyond the form submit attempt
      setCreatePassword("");
    }
  }

  // ── IA ───────────────────────────────────────────────────────────────────
  const [llmMeta, setLlmMeta] = useState<LlmSettingsMetadata | null>(null);
  const [llmHealth, setLlmHealth] = useState<LlmHealthResponse | null>(null);
  const [llmLoading, setLlmLoading] = useState(true);
  const [llmLoadError, setLlmLoadError] = useState<string | null>(null);

  const [provider, setProvider] = useState<LlmProvider>("openai");
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [validating, setValidating] = useState(false);
  const [iaActionError, setIaActionError] = useState<string | null>(null);

  const loadLlm = useCallback(async (cancelled: { current: boolean }) => {
    setLlmLoading(true);
    setLlmLoadError(null);
    try {
      const [meta, health] = await Promise.all([
        fetchLlmSettings(),
        fetchLlmHealth(),
      ]);
      if (!cancelled.current) {
        setLlmMeta(meta);
        setLlmHealth(health);
        if (meta.provider === "openai" || meta.provider === "anthropic") {
          setProvider(meta.provider);
        }
        // Never hydrate the key field from the server
        setApiKey("");
      }
    } catch {
      if (!cancelled.current) {
        const message =
          "Não foi possível carregar as configurações de IA. Tente novamente.";
        setLlmLoadError(message);
        setLlmMeta(null);
        setLlmHealth(null);
        toast.error(message);
      }
    } finally {
      if (!cancelled.current) {
        setLlmLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    const cancelled = { current: false };
    setLlmMeta(null);
    setLlmHealth(null);
    setApiKey("");
    setIaActionError(null);
    void loadLlm(cancelled);
    return () => {
      cancelled.current = true;
    };
  }, [activeEmpresaId, loadLlm]);

  async function onSaveLlm(e: FormEvent) {
    e.preventDefault();
    const key = apiKey.trim();
    if (!key) {
      setIaActionError("Informe a chave de API para salvar.");
      return;
    }
    setSaving(true);
    setIaActionError(null);
    try {
      const meta = await putLlmSettings({ provider, api_key: key });
      setLlmMeta(meta);
      // Clear key from form state after successful save — never keep it
      setApiKey("");
      toast.success("Configuração de IA salva.");
      try {
        const health = await fetchLlmHealth();
        setLlmHealth(health);
      } catch {
        // Metadata save succeeded; health refresh is best-effort
      }
    } catch {
      const message = "Não foi possível salvar a configuração de IA.";
      setIaActionError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  }

  async function onValidateLlm() {
    setValidating(true);
    setIaActionError(null);
    try {
      const meta = await validateLlmSettings();
      setLlmMeta(meta);
      if (meta.status === "valid") {
        toast.success("Chave validada com sucesso.");
      } else if (meta.status === "invalid") {
        const detail =
          meta.last_error?.trim() ||
          "A chave foi rejeitada pelo provedor.";
        setIaActionError(detail);
        toast.error("Validação falhou.");
      }
      try {
        const health = await fetchLlmHealth();
        setLlmHealth(health);
      } catch {
        // ignore health refresh failure
      }
    } catch {
      const message =
        "Não foi possível validar a chave. Tente novamente em instantes.";
      setIaActionError(message);
      toast.error(message);
    } finally {
      setValidating(false);
    }
  }

  const statusForBadge = llmMeta?.status ?? "none";
  const healthAlertCopy =
    llmHealth && llmHealth.ok === false
      ? mapLlmHealthReasonCopy(llmHealth.reason)
      : null;

  return (
    <div className="flex flex-col gap-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Admin</h1>
        <p className="text-sm text-muted-foreground">
          Pessoas da empresa e configuração de IA
        </p>
      </div>

      <Tabs
        value={tab}
        onValueChange={(v) => {
          if ((ADMIN_TAB_IDS as readonly string[]).includes(v)) {
            setTab(v as AdminTabId);
          }
        }}
      >
        <TabsList>
          <TabsTrigger value="pessoas">Pessoas</TabsTrigger>
          <TabsTrigger value="ia">IA</TabsTrigger>
          <TabsTrigger value="telegram">Telegram</TabsTrigger>
        </TabsList>

        <TabsContent value="pessoas" className="mt-4 flex flex-col gap-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="space-y-1">
              <h2 className="text-lg font-medium tracking-tight">Pessoas</h2>
              <p className="text-sm text-muted-foreground">
                Membros com acesso a esta empresa
              </p>
            </div>
            <Dialog
              open={dialogOpen}
              onOpenChange={(open) => {
                setDialogOpen(open);
                if (!open) resetCreateForm();
              }}
            >
              <DialogTrigger asChild>
                <Button type="button">
                  <Plus />
                  Pessoa
                </Button>
              </DialogTrigger>
              <DialogContent>
                <form onSubmit={onCreateMembro}>
                  <DialogHeader>
                    <DialogTitle>Nova pessoa</DialogTitle>
                    <DialogDescription>
                      Crie um usuário e adicione-o a esta empresa.
                    </DialogDescription>
                  </DialogHeader>
                  <div className="grid gap-4 py-4">
                    <div className="grid gap-2">
                      <Label htmlFor="membro-nome">Nome</Label>
                      <Input
                        id="membro-nome"
                        name="name"
                        value={createName}
                        onChange={(ev) => setCreateName(ev.target.value)}
                        required
                        autoComplete="off"
                        autoFocus
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="membro-email">E-mail</Label>
                      <Input
                        id="membro-email"
                        name="email"
                        type="email"
                        value={createEmail}
                        onChange={(ev) => setCreateEmail(ev.target.value)}
                        required
                        autoComplete="off"
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="membro-senha">Senha</Label>
                      <Input
                        id="membro-senha"
                        name="password"
                        type="password"
                        value={createPassword}
                        onChange={(ev) => setCreatePassword(ev.target.value)}
                        required
                        minLength={8}
                        autoComplete="new-password"
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="membro-papel">Papel</Label>
                      <Select
                        value={createPapel}
                        onValueChange={(v) => {
                          if (v === "admin" || v === "membro") {
                            setCreatePapel(v);
                          }
                        }}
                      >
                        <SelectTrigger id="membro-papel">
                          <SelectValue placeholder="Papel" />
                        </SelectTrigger>
                        <SelectContent>
                          {MEMBERSHIP_PAPEIS.map((p) => (
                            <SelectItem key={p} value={p}>
                              {PAPEL_LABELS[p]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <DialogFooter>
                    <Button
                      type="submit"
                      disabled={
                        creating ||
                        !createName.trim() ||
                        !createEmail.trim() ||
                        !createPassword
                      }
                    >
                      {creating ? "Criando…" : "Criar"}
                    </Button>
                  </DialogFooter>
                </form>
              </DialogContent>
            </Dialog>
          </div>

          {membrosError ? (
            <Alert variant="destructive">
              <AlertTitle>Erro</AlertTitle>
              <AlertDescription>{membrosError}</AlertDescription>
            </Alert>
          ) : null}

          {membrosLoading ? <MembrosLoadingSkeleton /> : null}

          {!membrosLoading && !membrosError && membros.length === 0 ? (
            <Empty className="border border-dashed border-border py-12">
              <EmptyHeader>
                <EmptyTitle>Nenhuma pessoa</EmptyTitle>
                <EmptyDescription>
                  Adicione a primeira pessoa desta empresa.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : null}

          {!membrosLoading && membros.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Nome</TableHead>
                  <TableHead>E-mail</TableHead>
                  <TableHead className="w-[120px]">Papel</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {membros.map((m) => (
                  <TableRow key={m.user_id}>
                    <TableCell className="font-medium">{m.name}</TableCell>
                    <TableCell>{m.email}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className="border-border">
                        {m.papel === "admin" || m.papel === "membro"
                          ? PAPEL_LABELS[m.papel]
                          : m.papel}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : null}
        </TabsContent>

        <TabsContent value="ia" className="mt-4 flex flex-col gap-4">
          <Card>
            <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
              <div className="space-y-1.5">
                <CardTitle>Configuração de IA</CardTitle>
                <CardDescription>
                  Provedor e chave de API da empresa. A chave nunca é exibida
                  após salvar.
                </CardDescription>
              </div>
              {!llmLoading && llmMeta ? (
                <Badge variant={llmStatusBadgeVariant(statusForBadge)}>
                  {mapLlmStatusBadge(statusForBadge)}
                </Badge>
              ) : null}
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              {llmLoadError ? (
                <Alert variant="destructive">
                  <AlertTitle>Erro</AlertTitle>
                  <AlertDescription>{llmLoadError}</AlertDescription>
                </Alert>
              ) : null}

              {llmLoading ? (
                <div
                  className="flex flex-col gap-2"
                  aria-busy="true"
                  aria-live="polite"
                >
                  <Skeleton className="h-10 w-full rounded-md" />
                  <Skeleton className="h-10 w-full rounded-md" />
                  <Skeleton className="h-9 w-40 rounded-md" />
                </div>
              ) : null}

              {!llmLoading && !llmLoadError ? (
                <>
                  {healthAlertCopy &&
                  llmHealth &&
                  llmHealth.ok === false &&
                  llmMeta?.status !== "valid" ? (
                    <Alert
                      variant={
                        llmHealth.reason === "llm_key_invalid"
                          ? "destructive"
                          : "default"
                      }
                    >
                      <AlertTitle>Status da IA</AlertTitle>
                      <AlertDescription>{healthAlertCopy}</AlertDescription>
                    </Alert>
                  ) : null}

                  {iaActionError ? (
                    <Alert variant="destructive">
                      <AlertTitle>Erro</AlertTitle>
                      <AlertDescription>{iaActionError}</AlertDescription>
                    </Alert>
                  ) : null}

                  {llmMeta?.has_key ? (
                    <p className="text-sm text-muted-foreground">
                      Há uma chave salva
                      {llmMeta.provider
                        ? ` (${PROVIDER_LABELS[llmMeta.provider]})`
                        : ""}
                      . Informe uma nova chave apenas se quiser substituí-la.
                    </p>
                  ) : null}

                  <form
                    onSubmit={onSaveLlm}
                    className="flex flex-col gap-4"
                  >
                    <div className="grid gap-2">
                      <Label htmlFor="llm-provider">Provedor</Label>
                      <Select
                        value={provider}
                        onValueChange={(v) => {
                          if (v === "openai" || v === "anthropic") {
                            setProvider(v);
                          }
                        }}
                      >
                        <SelectTrigger id="llm-provider">
                          <SelectValue placeholder="Provedor" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="openai">
                            {PROVIDER_LABELS.openai}
                          </SelectItem>
                          <SelectItem value="anthropic">
                            {PROVIDER_LABELS.anthropic}
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="llm-api-key">Chave de API</Label>
                      <Input
                        id="llm-api-key"
                        name="api_key"
                        type="password"
                        value={apiKey}
                        onChange={(ev) => setApiKey(ev.target.value)}
                        autoComplete="off"
                        placeholder={
                          llmMeta?.has_key
                            ? "••••••••••••••••"
                            : "Cole a chave de API"
                        }
                      />
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="submit"
                        disabled={saving || validating || !apiKey.trim()}
                      >
                        {saving ? (
                          <>
                            <Spinner />
                            Salvando…
                          </>
                        ) : (
                          "Salvar"
                        )}
                      </Button>
                      <Button
                        type="button"
                        variant="secondary"
                        disabled={
                          saving ||
                          validating ||
                          !llmMeta?.has_key ||
                          llmMeta.status === "none"
                        }
                        onClick={() => {
                          void onValidateLlm();
                        }}
                      >
                        {validating ? (
                          <>
                            <Spinner />
                            Validando…
                          </>
                        ) : (
                          "Validar"
                        )}
                      </Button>
                    </div>
                  </form>
                </>
              ) : null}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="telegram" className="mt-4 flex flex-col gap-4">
          <AdminTelegramPanel activeEmpresaId={activeEmpresaId} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

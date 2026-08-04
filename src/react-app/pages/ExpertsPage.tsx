/** @description Experts list — table with open/late badges, admin create dialog. */

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Plus } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { resolveActivePapel } from "@/lib/active-papel";
import {
  createExpert,
  EXPERTS_PAGE_HEADING,
  fetchExperts,
  shouldShowDomainCreateActions,
  type ExpertListRow,
} from "@/lib/domain-api";
import { buildExpertPath } from "@/lib/domain-routes";
import { useAuth } from "@/providers/auth-provider";
import { useDomainBreadcrumbNames } from "@/providers/breadcrumb-provider";

/**
 * @description Loading skeleton for the Experts table body.
 */
function ExpertsLoadingSkeleton() {
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
 * @description Experts list page: nome + atrasadas/abertas badges; admin + Expert.
 */
export function ExpertsPage() {
  const navigate = useNavigate();
  const { me } = useAuth();
  const activeEmpresaId = me?.active_empresa_id ?? null;

  useDomainBreadcrumbNames({});

  const activePapel = useMemo(
    () =>
      resolveActivePapel({
        activeEmpresaId: me?.active_empresa_id ?? null,
        memberships: me?.memberships ?? [],
      }),
    [me?.active_empresa_id, me?.memberships],
  );
  const canCreate = shouldShowDomainCreateActions(activePapel);

  const [experts, setExperts] = useState<ExpertListRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [nome, setNome] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const loadExperts = useCallback(async (cancelled: { current: boolean }) => {
    setLoading(true);
    setError(null);
    try {
      const rows = await fetchExperts();
      if (!cancelled.current) {
        setExperts(rows);
      }
    } catch {
      if (!cancelled.current) {
        const message =
          "Não foi possível carregar os experts. Tente novamente.";
        setError(message);
        setExperts([]);
        toast.error(message);
      }
    } finally {
      if (!cancelled.current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    const cancelled = { current: false };
    setExperts([]);
    void loadExperts(cancelled);
    return () => {
      cancelled.current = true;
    };
  }, [activeEmpresaId, loadExperts]);

  const onRowClick = useCallback(
    (id: string) => {
      navigate(buildExpertPath(id));
    },
    [navigate],
  );

  async function onCreateExpert(e: FormEvent) {
    e.preventDefault();
    const trimmed = nome.trim();
    if (!trimmed) return;
    setSubmitting(true);
    try {
      await createExpert({ nome: trimmed });
      toast.success("Expert criado.");
      setDialogOpen(false);
      setNome("");
      const cancelled = { current: false };
      await loadExperts(cancelled);
    } catch {
      toast.error("Não foi possível criar o expert.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            {EXPERTS_PAGE_HEADING}
          </h1>
          <p className="text-sm text-muted-foreground">
            Experts da empresa e contagem de tarefas
          </p>
        </div>
        {canCreate ? (
          <Dialog
            open={dialogOpen}
            onOpenChange={(open) => {
              setDialogOpen(open);
              if (!open) setNome("");
            }}
          >
            <DialogTrigger asChild>
              <Button type="button">
                <Plus />
                Expert
              </Button>
            </DialogTrigger>
            <DialogContent>
              <form onSubmit={onCreateExpert}>
                <DialogHeader>
                  <DialogTitle>Novo expert</DialogTitle>
                  <DialogDescription>
                    Informe o nome do expert da empresa.
                  </DialogDescription>
                </DialogHeader>
                <div className="grid gap-2 py-4">
                  <Label htmlFor="expert-nome">Nome</Label>
                  <Input
                    id="expert-nome"
                    name="nome"
                    value={nome}
                    onChange={(ev) => setNome(ev.target.value)}
                    required
                    autoComplete="off"
                    autoFocus
                  />
                </div>
                <DialogFooter>
                  <Button type="submit" disabled={submitting || !nome.trim()}>
                    {submitting ? "Criando…" : "Criar"}
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
        ) : null}
      </div>

      {error ? (
        <Alert variant="destructive">
          <AlertTitle>Erro</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {loading ? <ExpertsLoadingSkeleton /> : null}

      {!loading && !error && experts.length === 0 ? (
        <Empty className="border border-dashed border-border py-12">
          <EmptyHeader>
            <EmptyTitle>Nenhum expert</EmptyTitle>
            <EmptyDescription>
              {canCreate
                ? "Crie o primeiro expert da empresa."
                : "Ainda não há experts nesta empresa."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}

      {!loading && experts.length > 0 ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Nome</TableHead>
              <TableHead className="w-[120px]">Atrasadas</TableHead>
              <TableHead className="w-[120px]">Abertas</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {experts.map((expert) => (
              <TableRow
                key={expert.id}
                className="cursor-pointer"
                onClick={() => onRowClick(expert.id)}
                onKeyDown={(ev) => {
                  if (ev.key === "Enter" || ev.key === " ") {
                    ev.preventDefault();
                    onRowClick(expert.id);
                  }
                }}
                tabIndex={0}
                role="link"
              >
                <TableCell className="font-medium">{expert.nome}</TableCell>
                <TableCell>
                  <Badge
                    variant="outline"
                    className={
                      expert.atrasadas > 0
                        ? "border-border text-destructive"
                        : "border-border text-muted-foreground"
                    }
                  >
                    {expert.atrasadas}
                  </Badge>
                </TableCell>
                <TableCell>
                  <Badge
                    variant="outline"
                    className="border-border text-muted-foreground"
                  >
                    {expert.abertas}
                  </Badge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : null}
    </div>
  );
}

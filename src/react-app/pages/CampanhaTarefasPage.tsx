/** @description Campanha tarefas list — status/dono filters, create dialog, nesting guard. */

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Plus } from "lucide-react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import {
  createTarefa,
  fetchCampanha,
  fetchExpert,
  fetchMembros,
  fetchTarefasByCampanha,
  type CampanhaRow,
  type ExpertRow,
  type MembroListRow,
  type TarefaRow,
} from "@/lib/domain-api";
import { labelTarefaStatus } from "@/lib/domain-labels";
import {
  buildCreateTarefaBody,
  buildTarefaPath,
  CAMPANHA_TASK_FILTER_CONTROL_IDS,
  resolveCampanhaRouteIntegrity,
} from "@/lib/domain-routes";
import { filterTarefas } from "@/lib/task-filters";
import {
  TAREFA_STATUS,
  type TarefaStatus,
} from "../../shared/domain/enums.ts";
import { useAuth } from "@/providers/auth-provider";
import { useDomainBreadcrumbNames } from "@/providers/breadcrumb-provider";

const FILTER_ALL = "__all__";
const DONO_NONE = "__none__";
const DEFAULT_TAREFA_STATUS: TarefaStatus = "a_fazer";

/**
 * @description Loading skeleton for the tarefas table body.
 */
function TarefasLoadingSkeleton() {
  return (
    <div className="flex flex-col gap-2" aria-busy="true" aria-live="polite">
      <Skeleton className="h-10 w-full rounded-md" />
      <Skeleton className="h-12 w-full rounded-md" />
      <Skeleton className="h-12 w-full rounded-md" />
    </div>
  );
}

/**
 * @description Format prazo ISO date for table display, or em dash when null.
 */
function formatPrazo(prazo: string | null): string {
  if (!prazo) return "—";
  return prazo.slice(0, 10);
}

/**
 * @description Tarefas list under /experts/:expertId/campanhas/:campanhaId with filters + create.
 */
export function CampanhaTarefasPage() {
  const navigate = useNavigate();
  const { expertId: routeExpertId = "", campanhaId: routeCampanhaId = "" } =
    useParams<{ expertId: string; campanhaId: string }>();
  const { me } = useAuth();
  const activeEmpresaId = me?.active_empresa_id ?? null;

  const [expert, setExpert] = useState<ExpertRow | null>(null);
  const [campanha, setCampanha] = useState<CampanhaRow | null>(null);
  const [tarefas, setTarefas] = useState<TarefaRow[]>([]);
  const [membros, setMembros] = useState<MembroListRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  const [filterStatus, setFilterStatus] = useState<string | null>(null);
  const [filterDonoId, setFilterDonoId] = useState<string | null>(null);

  useDomainBreadcrumbNames({
    expert: expert?.nome,
    campanha: campanha?.nome,
  });

  const [dialogOpen, setDialogOpen] = useState(false);
  const [titulo, setTitulo] = useState("");
  const [donoId, setDonoId] = useState<string | null>(null);
  const [prazo, setPrazo] = useState("");
  const [status, setStatus] = useState<TarefaStatus>(DEFAULT_TAREFA_STATUS);
  const [notas, setNotas] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const resetDialog = useCallback(() => {
    setTitulo("");
    setDonoId(null);
    setPrazo("");
    setStatus(DEFAULT_TAREFA_STATUS);
    setNotas("");
  }, []);

  const membroNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of membros) {
      map.set(m.user_id, m.name);
    }
    return map;
  }, [membros]);

  const filteredTarefas = useMemo(
    () =>
      filterTarefas(tarefas, {
        status: filterStatus,
        donoId: filterDonoId,
      }),
    [tarefas, filterStatus, filterDonoId],
  );

  const load = useCallback(
    async (cancelled: { current: boolean }) => {
      if (!routeExpertId || !routeCampanhaId) {
        if (!cancelled.current) {
          setNotFound(true);
          setLoading(false);
        }
        return;
      }
      setLoading(true);
      setError(null);
      setNotFound(false);
      try {
        const [campanhaRow, tarefaRows, membroRows] = await Promise.all([
          fetchCampanha(routeCampanhaId),
          fetchTarefasByCampanha(routeCampanhaId),
          fetchMembros(),
        ]);
        if (cancelled.current) return;

        const integrity = resolveCampanhaRouteIntegrity(
          routeExpertId,
          campanhaRow,
        );
        if (integrity.action === "redirect") {
          setCampanha(campanhaRow);
          setTarefas(tarefaRows);
          setMembros(membroRows);
          return;
        }

        let expertRow: ExpertRow | null = null;
        try {
          expertRow = await fetchExpert(campanhaRow.expert_id);
        } catch {
          expertRow = null;
        }
        if (cancelled.current) return;

        setCampanha(campanhaRow);
        setTarefas(tarefaRows);
        setMembros(membroRows);
        setExpert(expertRow);
      } catch {
        if (!cancelled.current) {
          setExpert(null);
          setCampanha(null);
          setTarefas([]);
          setMembros([]);
          setNotFound(true);
          const message = "Não foi possível carregar a campanha.";
          setError(message);
          toast.error(message);
        }
      } finally {
        if (!cancelled.current) {
          setLoading(false);
        }
      }
    },
    [routeExpertId, routeCampanhaId],
  );

  useEffect(() => {
    const cancelled = { current: false };
    setExpert(null);
    setCampanha(null);
    setTarefas([]);
    setMembros([]);
    void load(cancelled);
    return () => {
      cancelled.current = true;
    };
  }, [activeEmpresaId, load]);

  const redirectTo = useMemo(() => {
    if (!campanha) return null;
    const integrity = resolveCampanhaRouteIntegrity(routeExpertId, campanha);
    return integrity.action === "redirect" ? integrity.to : null;
  }, [campanha, routeExpertId]);

  const onRowClick = useCallback(
    (tarefaId: string) => {
      navigate(buildTarefaPath(tarefaId));
    },
    [navigate],
  );

  async function onCreateTarefa(e: FormEvent) {
    e.preventDefault();
    const trimmed = titulo.trim();
    if (!trimmed || !routeCampanhaId) return;
    setSubmitting(true);
    try {
      const body = buildCreateTarefaBody(routeCampanhaId, {
        titulo: trimmed,
        status,
        ...(donoId ? { dono_id: donoId } : {}),
        ...(prazo ? { prazo } : {}),
        ...(notas.trim() ? { notas: notas.trim() } : {}),
      });
      await createTarefa(body);
      toast.success("Tarefa criada.");
      setDialogOpen(false);
      resetDialog();
      const cancelled = { current: false };
      await load(cancelled);
    } catch {
      toast.error("Não foi possível criar a tarefa.");
    } finally {
      setSubmitting(false);
    }
  }

  if (redirectTo) {
    return <Navigate to={redirectTo} replace />;
  }

  const [statusFilterId, donoFilterId] = CAMPANHA_TASK_FILTER_CONTROL_IDS;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            {campanha?.nome ?? "Tarefas"}
          </h1>
          <p className="text-sm text-muted-foreground">
            Tarefas desta campanha
          </p>
        </div>
        {campanha ? (
          <Dialog
            open={dialogOpen}
            onOpenChange={(open) => {
              setDialogOpen(open);
              if (!open) resetDialog();
            }}
          >
            <DialogTrigger asChild>
              <Button type="button">
                <Plus />
                Tarefa
              </Button>
            </DialogTrigger>
            <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md">
              <form onSubmit={onCreateTarefa}>
                <DialogHeader>
                  <DialogTitle>Nova tarefa</DialogTitle>
                  <DialogDescription>
                    Tarefa vinculada a {campanha.nome}. Status inicial: a fazer.
                  </DialogDescription>
                </DialogHeader>
                <div className="grid gap-4 py-4">
                  <div className="grid gap-2">
                    <Label htmlFor="tarefa-titulo">Título</Label>
                    <Input
                      id="tarefa-titulo"
                      name="titulo"
                      value={titulo}
                      onChange={(ev) => setTitulo(ev.target.value)}
                      required
                      autoComplete="off"
                      autoFocus
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="tarefa-dono">Dono (opcional)</Label>
                    <Select
                      value={donoId ?? DONO_NONE}
                      onValueChange={(value) => {
                        setDonoId(value === DONO_NONE ? null : value);
                      }}
                    >
                      <SelectTrigger id="tarefa-dono">
                        <SelectValue placeholder="Sem dono" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={DONO_NONE}>Sem dono</SelectItem>
                        {membros.map((m) => (
                          <SelectItem key={m.user_id} value={m.user_id}>
                            {m.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="tarefa-prazo">Prazo (opcional)</Label>
                    <Input
                      id="tarefa-prazo"
                      name="prazo"
                      type="date"
                      value={prazo}
                      onChange={(ev) => setPrazo(ev.target.value)}
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="tarefa-status">Status</Label>
                    <Select
                      value={status}
                      onValueChange={(value) => {
                        if (
                          (TAREFA_STATUS as readonly string[]).includes(value)
                        ) {
                          setStatus(value as TarefaStatus);
                        }
                      }}
                    >
                      <SelectTrigger id="tarefa-status">
                        <SelectValue placeholder="Status" />
                      </SelectTrigger>
                      <SelectContent>
                        {TAREFA_STATUS.map((s) => (
                          <SelectItem key={s} value={s}>
                            {labelTarefaStatus(s)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="tarefa-notas">Notas (opcional)</Label>
                    <Textarea
                      id="tarefa-notas"
                      name="notas"
                      value={notas}
                      onChange={(ev) => setNotas(ev.target.value)}
                      rows={3}
                    />
                  </div>
                </div>
                <DialogFooter>
                  <Button type="submit" disabled={submitting || !titulo.trim()}>
                    {submitting ? "Criando…" : "Criar"}
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
        ) : null}
      </div>

      {error && notFound ? (
        <Alert variant="destructive">
          <AlertTitle>Não encontrado</AlertTitle>
          <AlertDescription>
            Campanha não encontrada ou sem permissão.
          </AlertDescription>
        </Alert>
      ) : null}

      {error && !notFound ? (
        <Alert variant="destructive">
          <AlertTitle>Erro</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {loading ? <TarefasLoadingSkeleton /> : null}

      {!loading && campanha ? (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="grid gap-2 sm:w-[200px]">
            <Label htmlFor={statusFilterId}>Status</Label>
            <Select
              value={filterStatus ?? FILTER_ALL}
              onValueChange={(value) => {
                setFilterStatus(value === FILTER_ALL ? null : value);
              }}
            >
              <SelectTrigger
                id={statusFilterId}
                data-testid={statusFilterId}
              >
                <SelectValue placeholder="Todos" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={FILTER_ALL}>Todos</SelectItem>
                {TAREFA_STATUS.map((s) => (
                  <SelectItem key={s} value={s}>
                    {labelTarefaStatus(s)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2 sm:w-[220px]">
            <Label htmlFor={donoFilterId}>Dono</Label>
            <Select
              value={filterDonoId ?? FILTER_ALL}
              onValueChange={(value) => {
                setFilterDonoId(value === FILTER_ALL ? null : value);
              }}
            >
              <SelectTrigger id={donoFilterId} data-testid={donoFilterId}>
                <SelectValue placeholder="Todos" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={FILTER_ALL}>Todos</SelectItem>
                {membros.map((m) => (
                  <SelectItem key={m.user_id} value={m.user_id}>
                    {m.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      ) : null}

      {!loading && campanha && filteredTarefas.length === 0 ? (
        <Empty className="border border-dashed border-border py-12">
          <EmptyHeader>
            <EmptyTitle>Nenhuma tarefa</EmptyTitle>
            <EmptyDescription>
              {tarefas.length === 0
                ? "Crie a primeira tarefa desta campanha."
                : "Nenhuma tarefa corresponde aos filtros."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}

      {!loading && campanha && filteredTarefas.length > 0 ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Título</TableHead>
              <TableHead className="w-[160px]">Dono</TableHead>
              <TableHead className="w-[120px]">Prazo</TableHead>
              <TableHead className="w-[120px]">Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredTarefas.map((tarefa) => (
              <TableRow
                key={tarefa.id}
                className="cursor-pointer"
                onClick={() => onRowClick(tarefa.id)}
                onKeyDown={(ev) => {
                  if (ev.key === "Enter" || ev.key === " ") {
                    ev.preventDefault();
                    onRowClick(tarefa.id);
                  }
                }}
                tabIndex={0}
                role="link"
              >
                <TableCell className="font-medium">{tarefa.titulo}</TableCell>
                <TableCell className="text-muted-foreground">
                  {tarefa.dono_id
                    ? (membroNameById.get(tarefa.dono_id) ?? "—")
                    : "—"}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {formatPrazo(tarefa.prazo)}
                </TableCell>
                <TableCell>
                  <Badge
                    variant="outline"
                    className="border-border text-muted-foreground"
                  >
                    {labelTarefaStatus(tarefa.status)}
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

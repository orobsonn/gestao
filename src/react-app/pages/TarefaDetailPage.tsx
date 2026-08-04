/** @description Tarefa detail — edit form, save PATCH, direct delete, back to campaign. */

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import { Textarea } from "@/components/ui/textarea";
import {
  buildTarefaPatchBody,
  deleteTarefa,
  fetchCampanha,
  fetchMembros,
  fetchTarefa,
  patchTarefa,
  TAREFA_DELETE_REQUIRES_CONFIRMATION,
  type CampanhaRow,
  type MembroListRow,
  type TarefaRow,
} from "@/lib/domain-api";
import { labelTarefaStatus } from "@/lib/domain-labels";
import { buildTarefaBackPath } from "@/lib/domain-routes";
import {
  TAREFA_STATUS,
  type TarefaStatus,
} from "../../shared/domain/enums.ts";
import { useAuth } from "@/providers/auth-provider";
import { useDomainBreadcrumbNames } from "@/providers/breadcrumb-provider";

const DONO_NONE = "__none__";
const BREADCRUMB_TAREFA_FALLBACK = "Tarefa";

/**
 * @description Loading skeleton for the tarefa detail form.
 */
function TarefaDetailSkeleton() {
  return (
    <div className="flex flex-col gap-3" aria-busy="true" aria-live="polite">
      <Skeleton className="h-8 w-48 rounded-md" />
      <Skeleton className="h-10 w-full rounded-md" />
      <Skeleton className="h-10 w-full rounded-md" />
      <Skeleton className="h-24 w-full rounded-md" />
    </div>
  );
}

/**
 * @description Full tarefa detail at /tarefas/:id — form, save, direct delete, campaign back.
 */
export function TarefaDetailPage() {
  const navigate = useNavigate();
  const { id: routeId = "" } = useParams<{ id: string }>();
  const { me } = useAuth();
  const activeEmpresaId = me?.active_empresa_id ?? null;

  const [tarefa, setTarefa] = useState<TarefaRow | null>(null);
  const [campanha, setCampanha] = useState<CampanhaRow | null>(null);
  const [membros, setMembros] = useState<MembroListRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  const [titulo, setTitulo] = useState("");
  const [donoId, setDonoId] = useState<string | null>(null);
  const [prazo, setPrazo] = useState("");
  const [status, setStatus] = useState<TarefaStatus>("a_fazer");
  const [notas, setNotas] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [backing, setBacking] = useState(false);

  useDomainBreadcrumbNames({
    tarefa: tarefa?.titulo || BREADCRUMB_TAREFA_FALLBACK,
  });

  const applyTarefaToForm = useCallback((row: TarefaRow) => {
    setTitulo(row.titulo);
    setDonoId(row.dono_id);
    setPrazo(row.prazo ? row.prazo.slice(0, 10) : "");
    if ((TAREFA_STATUS as readonly string[]).includes(row.status)) {
      setStatus(row.status as TarefaStatus);
    } else {
      setStatus("a_fazer");
    }
    setNotas(row.notas ?? "");
  }, []);

  const load = useCallback(
    async (cancelled: { current: boolean }) => {
      if (!routeId) {
        if (!cancelled.current) {
          setNotFound(true);
          setLoading(false);
        }
        return;
      }
      setLoading(true);
      setNotFound(false);
      try {
        const [tarefaRow, membroRows] = await Promise.all([
          fetchTarefa(routeId),
          fetchMembros(),
        ]);
        if (cancelled.current) return;

        let campanhaRow: CampanhaRow | null = null;
        try {
          campanhaRow = await fetchCampanha(tarefaRow.campanha_id);
        } catch {
          campanhaRow = null;
        }
        if (cancelled.current) return;

        setTarefa(tarefaRow);
        setCampanha(campanhaRow);
        setMembros(membroRows);
        applyTarefaToForm(tarefaRow);
      } catch {
        if (!cancelled.current) {
          setTarefa(null);
          setCampanha(null);
          setMembros([]);
          setNotFound(true);
        }
      } finally {
        if (!cancelled.current) {
          setLoading(false);
        }
      }
    },
    [routeId, applyTarefaToForm],
  );

  useEffect(() => {
    const cancelled = { current: false };
    setTarefa(null);
    setCampanha(null);
    setMembros([]);
    void load(cancelled);
    return () => {
      cancelled.current = true;
    };
  }, [activeEmpresaId, load]);

  async function onSave(e: FormEvent) {
    e.preventDefault();
    if (!routeId || !titulo.trim()) return;
    setSaving(true);
    try {
      const body = buildTarefaPatchBody({
        titulo: titulo.trim(),
        dono_id: donoId,
        prazo: prazo ? prazo : null,
        status,
        notas: notas,
      });
      const updated = await patchTarefa(routeId, {
        titulo: body.titulo,
        dono_id: body.dono_id,
        prazo: body.prazo,
        status: body.status as TarefaStatus,
        notas: body.notas,
      });
      setTarefa(updated);
      applyTarefaToForm(updated);
      toast.success("Tarefa salva.");
    } catch {
      toast.error("Não foi possível salvar a tarefa.");
    } finally {
      setSaving(false);
    }
  }

  /**
   * @description Voltar: GET tarefa → GET campanha → campaign list path (not Home).
   */
  async function onVoltar() {
    if (!routeId) {
      navigate("/");
      return;
    }
    setBacking(true);
    try {
      const tarefaRow = await fetchTarefa(routeId);
      const campanhaRow = await fetchCampanha(tarefaRow.campanha_id);
      navigate(buildTarefaBackPath(campanhaRow));
    } catch {
      if (campanha) {
        navigate(buildTarefaBackPath(campanha));
      } else {
        toast.error("Não foi possível voltar à campanha.");
      }
    } finally {
      setBacking(false);
    }
  }

  /**
   * @description Excluir immediately — no confirm dialog when TAREFA_DELETE_REQUIRES_CONFIRMATION is false.
   */
  async function onExcluir() {
    if (!routeId) return;
    if (TAREFA_DELETE_REQUIRES_CONFIRMATION) {
      return;
    }
    setDeleting(true);
    try {
      let backPath: string | null = campanha
        ? buildTarefaBackPath(campanha)
        : null;
      if (!backPath) {
        try {
          const tarefaRow = await fetchTarefa(routeId);
          const campanhaRow = await fetchCampanha(tarefaRow.campanha_id);
          backPath = buildTarefaBackPath(campanhaRow);
        } catch {
          backPath = null;
        }
      }
      await deleteTarefa(routeId);
      toast.success("Tarefa excluída.");
      if (backPath) {
        navigate(backPath);
      } else {
        navigate("/");
      }
    } catch {
      toast.error("Não foi possível excluir a tarefa.");
    } finally {
      setDeleting(false);
    }
  }

  if (loading) {
    return <TarefaDetailSkeleton />;
  }

  if (notFound || !tarefa) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Não encontrado</AlertTitle>
        <AlertDescription>
          Tarefa não encontrada ou sem permissão.
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl">Tarefa</CardTitle>
        <CardDescription>{tarefa.titulo}</CardDescription>
      </CardHeader>
      <form onSubmit={onSave}>
        <CardContent className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="tarefa-detail-titulo">Título</Label>
            <Input
              id="tarefa-detail-titulo"
              name="titulo"
              value={titulo}
              onChange={(ev) => setTitulo(ev.target.value)}
              required
              autoComplete="off"
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="tarefa-detail-dono">Dono</Label>
            <Select
              value={donoId ?? DONO_NONE}
              onValueChange={(value) => {
                setDonoId(value === DONO_NONE ? null : value);
              }}
            >
              <SelectTrigger id="tarefa-detail-dono">
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
            <Label htmlFor="tarefa-detail-prazo">Prazo (opcional)</Label>
            <Input
              id="tarefa-detail-prazo"
              name="prazo"
              type="date"
              value={prazo}
              onChange={(ev) => setPrazo(ev.target.value)}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="tarefa-detail-status">Status</Label>
            <Select
              value={status}
              onValueChange={(value) => {
                if ((TAREFA_STATUS as readonly string[]).includes(value)) {
                  setStatus(value as TarefaStatus);
                }
              }}
            >
              <SelectTrigger id="tarefa-detail-status">
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
            <Label htmlFor="tarefa-detail-notas">Notas</Label>
            <Textarea
              id="tarefa-detail-notas"
              name="notas"
              value={notas}
              onChange={(ev) => setNotas(ev.target.value)}
              rows={4}
              placeholder="Links externos e observações"
            />
          </div>
        </CardContent>
        <CardFooter className="flex flex-wrap gap-2">
          <Button type="submit" disabled={saving || !titulo.trim()}>
            {saving ? "Salvando…" : "Salvar"}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={backing || deleting}
            onClick={() => {
              void onVoltar();
            }}
          >
            {backing ? "Voltando…" : "Voltar"}
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={deleting || saving}
            onClick={() => {
              void onExcluir();
            }}
          >
            {deleting ? "Excluindo…" : "Excluir"}
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}

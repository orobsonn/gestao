/** @description Expert campanhas list — table with tipo/status badges, admin create dialog. */

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Plus } from "lucide-react";
import { useNavigate, useParams } from "react-router-dom";
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
import { resolveActivePapel } from "@/lib/active-papel";
import {
  buildCreateCampanhaBody,
  createCampanha,
  fetchCampanhasByExpert,
  fetchExpert,
  shouldShowDomainCreateActions,
  type CampanhaRow,
  type ExpertRow,
} from "@/lib/domain-api";
import {
  labelCampanhaStatus,
  labelCampanhaTipo,
} from "@/lib/domain-labels";
import { buildCampanhaPath } from "@/lib/domain-routes";
import {
  CAMPANHA_TIPOS,
  type CampanhaTipo,
} from "../../shared/domain/enums.ts";
import { useAuth } from "@/providers/auth-provider";
import { useDomainBreadcrumbNames } from "@/providers/breadcrumb-provider";

const DEFAULT_TIPO: CampanhaTipo = CAMPANHA_TIPOS[0];

/**
 * @description Loading skeleton for the campanhas table body.
 */
function CampanhasLoadingSkeleton() {
  return (
    <div className="flex flex-col gap-2" aria-busy="true" aria-live="polite">
      <Skeleton className="h-10 w-full rounded-md" />
      <Skeleton className="h-12 w-full rounded-md" />
      <Skeleton className="h-12 w-full rounded-md" />
    </div>
  );
}

/**
 * @description Campanhas list under /experts/:expertId; admin + Campanha (route-bound expert_id).
 */
export function ExpertCampanhasPage() {
  const navigate = useNavigate();
  const { expertId: routeExpertId = "" } = useParams<{ expertId: string }>();
  const { me } = useAuth();
  const activeEmpresaId = me?.active_empresa_id ?? null;

  const activePapel = useMemo(
    () =>
      resolveActivePapel({
        activeEmpresaId: me?.active_empresa_id ?? null,
        memberships: me?.memberships ?? [],
      }),
    [me?.active_empresa_id, me?.memberships],
  );
  const canCreate = shouldShowDomainCreateActions(activePapel);

  const [expert, setExpert] = useState<ExpertRow | null>(null);
  const [campanhas, setCampanhas] = useState<CampanhaRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  useDomainBreadcrumbNames({ expert: expert?.nome });

  const [dialogOpen, setDialogOpen] = useState(false);
  const [nome, setNome] = useState("");
  const [tipo, setTipo] = useState<CampanhaTipo>(DEFAULT_TIPO);
  const [dataInicio, setDataInicio] = useState("");
  const [dataFim, setDataFim] = useState("");
  const [notas, setNotas] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const resetDialog = useCallback(() => {
    setNome("");
    setTipo(DEFAULT_TIPO);
    setDataInicio("");
    setDataFim("");
    setNotas("");
  }, []);

  const load = useCallback(
    async (cancelled: { current: boolean }) => {
      if (!routeExpertId) {
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
        const [expertRow, campanhaRows] = await Promise.all([
          fetchExpert(routeExpertId),
          fetchCampanhasByExpert(routeExpertId),
        ]);
        if (!cancelled.current) {
          setExpert(expertRow);
          setCampanhas(campanhaRows);
        }
      } catch {
        if (!cancelled.current) {
          setExpert(null);
          setCampanhas([]);
          setNotFound(true);
          const message = "Não foi possível carregar o expert.";
          setError(message);
          toast.error(message);
        }
      } finally {
        if (!cancelled.current) {
          setLoading(false);
        }
      }
    },
    [routeExpertId],
  );

  useEffect(() => {
    const cancelled = { current: false };
    setExpert(null);
    setCampanhas([]);
    void load(cancelled);
    return () => {
      cancelled.current = true;
    };
  }, [activeEmpresaId, load]);

  const onRowClick = useCallback(
    (campanhaId: string) => {
      navigate(buildCampanhaPath(routeExpertId, campanhaId));
    },
    [navigate, routeExpertId],
  );

  async function onCreateCampanha(e: FormEvent) {
    e.preventDefault();
    const trimmed = nome.trim();
    if (!trimmed || !routeExpertId) return;
    setSubmitting(true);
    try {
      const body = buildCreateCampanhaBody(routeExpertId, {
        nome: trimmed,
        tipo,
        ...(dataInicio ? { data_inicio: dataInicio } : {}),
        ...(dataFim ? { data_fim: dataFim } : {}),
        ...(notas.trim() ? { notas: notas.trim() } : {}),
      });
      await createCampanha(body);
      toast.success("Campanha criada.");
      setDialogOpen(false);
      resetDialog();
      const cancelled = { current: false };
      await load(cancelled);
    } catch {
      toast.error("Não foi possível criar a campanha.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            {expert?.nome ?? "Campanhas"}
          </h1>
          <p className="text-sm text-muted-foreground">
            Campanhas deste expert
          </p>
        </div>
        {canCreate && expert ? (
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
                Campanha
              </Button>
            </DialogTrigger>
            <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md">
              <form onSubmit={onCreateCampanha}>
                <DialogHeader>
                  <DialogTitle>Nova campanha</DialogTitle>
                  <DialogDescription>
                    Campanha vinculada a {expert.nome}. Status inicial: aberta.
                  </DialogDescription>
                </DialogHeader>
                <div className="grid gap-4 py-4">
                  <div className="grid gap-2">
                    <Label htmlFor="campanha-nome">Nome</Label>
                    <Input
                      id="campanha-nome"
                      name="nome"
                      value={nome}
                      onChange={(ev) => setNome(ev.target.value)}
                      required
                      autoComplete="off"
                      autoFocus
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="campanha-tipo">Tipo</Label>
                    <Select
                      value={tipo}
                      onValueChange={(value) => {
                        if (
                          (CAMPANHA_TIPOS as readonly string[]).includes(value)
                        ) {
                          setTipo(value as CampanhaTipo);
                        }
                      }}
                    >
                      <SelectTrigger id="campanha-tipo">
                        <SelectValue placeholder="Tipo" />
                      </SelectTrigger>
                      <SelectContent>
                        {CAMPANHA_TIPOS.map((t) => (
                          <SelectItem key={t} value={t}>
                            {labelCampanhaTipo(t)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2 sm:gap-3">
                    <div className="grid gap-2">
                      <Label htmlFor="campanha-data-inicio">
                        Data início (opcional)
                      </Label>
                      <Input
                        id="campanha-data-inicio"
                        name="data_inicio"
                        type="date"
                        value={dataInicio}
                        onChange={(ev) => setDataInicio(ev.target.value)}
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="campanha-data-fim">
                        Data fim (opcional)
                      </Label>
                      <Input
                        id="campanha-data-fim"
                        name="data_fim"
                        type="date"
                        value={dataFim}
                        onChange={(ev) => setDataFim(ev.target.value)}
                      />
                    </div>
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="campanha-notas">Notas (opcional)</Label>
                    <Textarea
                      id="campanha-notas"
                      name="notas"
                      value={notas}
                      onChange={(ev) => setNotas(ev.target.value)}
                      rows={3}
                    />
                  </div>
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

      {error && notFound ? (
        <Alert variant="destructive">
          <AlertTitle>Não encontrado</AlertTitle>
          <AlertDescription>
            Expert não encontrado ou sem permissão.
          </AlertDescription>
        </Alert>
      ) : null}

      {error && !notFound ? (
        <Alert variant="destructive">
          <AlertTitle>Erro</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {loading ? <CampanhasLoadingSkeleton /> : null}

      {!loading && expert && campanhas.length === 0 ? (
        <Empty className="border border-dashed border-border py-12">
          <EmptyHeader>
            <EmptyTitle>Nenhuma campanha</EmptyTitle>
            <EmptyDescription>
              {canCreate
                ? "Crie a primeira campanha deste expert."
                : "Ainda não há campanhas para este expert."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}

      {!loading && expert && campanhas.length > 0 ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Nome</TableHead>
              <TableHead className="w-[160px]">Tipo</TableHead>
              <TableHead className="w-[120px]">Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {campanhas.map((campanha) => (
              <TableRow
                key={campanha.id}
                className="cursor-pointer"
                onClick={() => onRowClick(campanha.id)}
                onKeyDown={(ev) => {
                  if (ev.key === "Enter" || ev.key === " ") {
                    ev.preventDefault();
                    onRowClick(campanha.id);
                  }
                }}
                tabIndex={0}
                role="link"
              >
                <TableCell className="font-medium">{campanha.nome}</TableCell>
                <TableCell>
                  <Badge
                    variant="outline"
                    className="border-border text-muted-foreground"
                  >
                    {labelCampanhaTipo(campanha.tipo)}
                  </Badge>
                </TableCell>
                <TableCell>
                  <Badge
                    variant="outline"
                    className="border-border text-muted-foreground"
                  >
                    {labelCampanhaStatus(campanha.status)}
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

/** @description Home dashboard — role-based KPIs, lists, charts, and admin lens toggle. */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  fetchHome,
  HOME_KPI_THEME_CLASSES,
  HOME_PAGE_HEADING,
  HOME_PAGE_LEAD,
  type HomeKpis,
  type HomePayload,
  type HomeTarefa,
} from "@/lib/home-api";
import {
  DEFAULT_ADMIN_LENS,
  HOME_LENS_IDS,
  HOME_LENS_LABELS,
  resolveHomeLens,
  type HomeLensId,
} from "@/lib/home-lens";
import { buildTarefaDetailPath } from "@/lib/shell-routes";
import { cn } from "@/lib/cn";
import { useAuth } from "@/providers/auth-provider";

const STATUS_LABELS: Record<string, string> = {
  a_fazer: "A fazer",
  fazendo: "Fazendo",
  feito: "Feito",
  atrasada: "Atrasada",
};

const URGENCIA_LABELS: Record<string, string> = {
  atrasadas: "Atrasadas",
  hoje: "Hoje",
  semana: "Semana",
  depois: "Depois",
};

const chartConfig = {
  count: {
    label: "Quantidade",
    color: "var(--chart-1)",
  },
} satisfies ChartConfig;

/**
 * @description Read a KPI numeric field from the payload by binding key.
 */
function kpiValue(kpis: HomeKpis, field: string): number {
  const value = kpis[field as keyof HomeKpis];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * @description Format prazo for display (YYYY-MM-DD or em dash).
 */
function formatPrazo(prazo: string | null): string {
  return prazo ?? "—";
}

/**
 * @description Status badge for a home task row.
 */
function TaskStatusBadge({ task }: { task: HomeTarefa }) {
  if (task.atrasada) {
    return (
      <Badge
        variant="outline"
        className={cn(HOME_KPI_THEME_CLASSES.badgeAtrasada)}
      >
        Atrasada
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      className={cn(HOME_KPI_THEME_CLASSES.badgeDefault)}
    >
      {STATUS_LABELS[task.status] ?? task.status}
    </Badge>
  );
}

/**
 * @description Clickable task table for meu_trabalho / empresa_abertas.
 */
function TaskTable({
  tasks,
  showDono,
  onRowClick,
}: {
  tasks: HomeTarefa[];
  showDono: boolean;
  onRowClick: (id: string) => void;
}) {
  if (tasks.length === 0) {
    return (
      <Empty className="border border-dashed border-border py-8">
        <EmptyHeader>
          <EmptyTitle>Nenhuma tarefa</EmptyTitle>
          <EmptyDescription>
            Não há tarefas abertas nesta lista.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Título</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Prazo</TableHead>
          <TableHead>Expert</TableHead>
          {showDono ? <TableHead>Dono</TableHead> : null}
        </TableRow>
      </TableHeader>
      <TableBody>
        {tasks.map((task) => (
          <TableRow
            key={task.id}
            className="cursor-pointer"
            onClick={() => onRowClick(task.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onRowClick(task.id);
              }
            }}
            tabIndex={0}
            role="link"
          >
            <TableCell className="font-medium">{task.titulo}</TableCell>
            <TableCell>
              <TaskStatusBadge task={task} />
            </TableCell>
            <TableCell
              className={cn(
                "text-sm",
                task.atrasada
                  ? "text-destructive"
                  : HOME_KPI_THEME_CLASSES.muted,
              )}
            >
              {formatPrazo(task.prazo)}
            </TableCell>
            <TableCell className="text-sm text-muted-foreground">
              {task.expert_nome}
            </TableCell>
            {showDono ? (
              <TableCell className="text-sm text-muted-foreground">
                {task.dono_nome ?? "—"}
              </TableCell>
            ) : null}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/**
 * @description Simple bar chart card for a labeled series.
 */
function HomeBarChart({
  title,
  data,
  labelKey,
  labelMap,
}: {
  title: string;
  data: Array<Record<string, string | number>>;
  labelKey: string;
  labelMap?: Record<string, string>;
}) {
  const rows = data.map((row) => ({
    ...row,
    label:
      labelMap && typeof row[labelKey] === "string"
        ? (labelMap[row[labelKey] as string] ?? String(row[labelKey]))
        : String(row[labelKey] ?? ""),
  }));

  return (
    <Card className={cn(HOME_KPI_THEME_CLASSES.card)}>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <ChartContainer config={chartConfig} className="w-full">
          <BarChart data={rows} accessibilityLayer>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="label"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
            />
            <YAxis allowDecimals={false} tickLine={false} axisLine={false} />
            <ChartTooltip content={<ChartTooltipContent />} />
            <Bar dataKey="count" fill="var(--color-count)" radius={4} />
          </BarChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}

/**
 * @description Loading skeleton for the Home dashboard body.
 */
function HomeLoadingSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true" aria-live="polite">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-24 w-full rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-48 w-full rounded-xl" />
      <Skeleton className="h-48 w-full rounded-xl" />
    </div>
  );
}

/**
 * @description Role-based Home dashboard: KPIs, lens toggle, lists, charts.
 */
export function HomePage() {
  const navigate = useNavigate();
  const { me } = useAuth();
  const activeEmpresaId = me?.active_empresa_id ?? null;
  const [data, setData] = useState<HomePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lens, setLens] = useState<HomeLensId>(DEFAULT_ADMIN_LENS);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    setLens(DEFAULT_ADMIN_LENS);
    setLoading(true);

    (async () => {
      try {
        const payload = await fetchHome();
        if (!cancelled) {
          setData(payload);
        }
      } catch {
        if (!cancelled) {
          const message = "Não foi possível carregar a Home. Tente novamente.";
          setError(message);
          setData(null);
          toast.error(message);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activeEmpresaId]);

  const papel = data?.papel ?? "membro";
  const visibility = useMemo(
    () => resolveHomeLens({ papel, lens }),
    [papel, lens],
  );

  const onRowClick = useCallback(
    (id: string) => {
      navigate(buildTarefaDetailPath(id));
    },
    [navigate],
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            {HOME_PAGE_HEADING}
          </h1>
          <p className={cn("text-sm", HOME_KPI_THEME_CLASSES.muted)}>
            {HOME_PAGE_LEAD}
          </p>
        </div>
        {visibility.showToggle ? (
          <ToggleGroup
            type="single"
            value={visibility.lens}
            onValueChange={(value) => {
              if (
                value === "tudo" ||
                value === "so_meu" ||
                value === "so_empresa"
              ) {
                setLens(value);
              }
            }}
            variant="outline"
            size="sm"
            className="justify-start"
            aria-label="Filtro da Home"
          >
            {HOME_LENS_IDS.map((id) => (
              <ToggleGroupItem key={id} value={id} aria-label={HOME_LENS_LABELS[id]}>
                {HOME_LENS_LABELS[id]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        ) : null}
      </div>

      {error ? (
        <Alert variant="destructive">
          <AlertTitle>Erro</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {loading ? <HomeLoadingSkeleton /> : null}

      {!loading && data ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {visibility.kpis.map((binding) => {
              const value = kpiValue(data.kpis, binding.field);
              const isAtrasadas = binding.label === "Atrasadas" && value > 0;
              return (
                <Card
                  key={binding.field}
                  className={cn(HOME_KPI_THEME_CLASSES.card)}
                >
                  <CardHeader className="pb-2">
                    <CardDescription
                      className={cn(HOME_KPI_THEME_CLASSES.label)}
                    >
                      {binding.label}
                    </CardDescription>
                    <CardTitle
                      className={cn(
                        isAtrasadas
                          ? HOME_KPI_THEME_CLASSES.valueDestructive
                          : HOME_KPI_THEME_CLASSES.value,
                      )}
                    >
                      {value}
                    </CardTitle>
                  </CardHeader>
                </Card>
              );
            })}
          </div>

          {visibility.showCharts ? (
            <div className="grid gap-4 lg:grid-cols-2">
              <HomeBarChart
                title="Urgência"
                data={data.charts.urgencia.map((u) => ({
                  bucket: u.bucket,
                  count: u.count,
                }))}
                labelKey="bucket"
                labelMap={URGENCIA_LABELS}
              />
              <HomeBarChart
                title="Status"
                data={data.charts.status.map((s) => ({
                  key: s.key,
                  count: s.count,
                }))}
                labelKey="key"
                labelMap={STATUS_LABELS}
              />
              {visibility.showAtrasadasPorExpert &&
              data.charts.atrasadas_por_expert.length > 0 ? (
                <HomeBarChart
                  title="Atrasadas por expert"
                  data={data.charts.atrasadas_por_expert.map((e) => ({
                    expert_nome: e.expert_nome,
                    count: e.count,
                  }))}
                  labelKey="expert_nome"
                />
              ) : null}
            </div>
          ) : null}

          {visibility.showMeuTrabalho ? (
            <Card className={cn(HOME_KPI_THEME_CLASSES.card)}>
              <CardHeader>
                <CardTitle className={cn(HOME_KPI_THEME_CLASSES.sectionTitle)}>
                  Meu trabalho
                </CardTitle>
                <CardDescription>
                  Tarefas abertas atribuídas a você
                </CardDescription>
              </CardHeader>
              <CardContent>
                <TaskTable
                  tasks={data.meu_trabalho}
                  showDono={false}
                  onRowClick={onRowClick}
                />
              </CardContent>
            </Card>
          ) : null}

          {visibility.showEmpresaAbertas ? (
            <Card className={cn(HOME_KPI_THEME_CLASSES.card)}>
              <CardHeader>
                <CardTitle className={cn(HOME_KPI_THEME_CLASSES.sectionTitle)}>
                  Empresa
                </CardTitle>
                <CardDescription>Tarefas abertas da empresa</CardDescription>
              </CardHeader>
              <CardContent>
                <TaskTable
                  tasks={data.empresa_abertas}
                  showDono
                  onRowClick={onRowClick}
                />
              </CardContent>
            </Card>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/** @description Temporary tarefa detail page until full CRUD UI lands. */

import { Link, useParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  TAREFA_DETAIL_BACK_HREF,
  TAREFA_DETAIL_STUB_MESSAGE,
} from "@/lib/shell-routes";

/**
 * @description Shows tarefa id + stub message and a link back to Home.
 */
export function TarefaDetailStub() {
  const { id } = useParams<{ id: string }>();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl">Tarefa</CardTitle>
        <CardDescription className="font-mono text-sm">
          {id ?? "—"}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col items-start gap-4">
        <p className="text-sm text-muted-foreground">
          {TAREFA_DETAIL_STUB_MESSAGE}
        </p>
        <Button asChild variant="outline" size="sm">
          <Link to={TAREFA_DETAIL_BACK_HREF}>Voltar para Home</Link>
        </Button>
      </CardContent>
    </Card>
  );
}

/** @description Placeholder Admin page until empresa admin screens land. */

import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

/**
 * @description Temporary Admin surface with pt-br title.
 */
export function AdminPlaceholder() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Admin</CardTitle>
        <CardDescription>
          Configurações da empresa — em breve.
        </CardDescription>
      </CardHeader>
    </Card>
  );
}

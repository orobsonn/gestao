/** @description Placeholder Home page until domain dashboard lands. */

import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

/**
 * @description Temporary Home surface with pt-br title.
 */
export function HomePlaceholder() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Home</CardTitle>
        <CardDescription>
          Dashboard da operação — em breve.
        </CardDescription>
      </CardHeader>
    </Card>
  );
}

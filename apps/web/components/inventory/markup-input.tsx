"use client";
import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { priceWithMarkup } from "@/lib/inventory/markup";

export function MarkupInput({
  cost,
  onApply,
}: {
  cost: string;
  onApply: (price: string) => void;
}) {
  const [markup, setMarkup] = useState("");
  const price = priceWithMarkup(cost, markup);
  return (
    <div className="mt-2 space-y-1">
      <label className="block text-xs text-muted-foreground">
        Markup on cost (%)
        <Input
          type="number"
          min="0"
          step="0.01"
          value={markup}
          onChange={(event) => setMarkup(event.target.value)}
          className="mt-1 h-8"
        />
      </label>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={price === null}
        onClick={() => {
          if (price !== null) onApply(price);
        }}
      >
        Apply markup
      </Button>
      <p className="text-xs text-muted-foreground">
        {price === null
          ? "Enter cost per unit and a markup percentage."
          : `Selling price per unit: ${price}. Save the product to keep this price.`}
      </p>
    </div>
  );
}

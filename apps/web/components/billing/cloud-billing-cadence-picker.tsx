"use client";

import { CalendarDays, Check, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  CLOUD_BILLING_OPTIONS,
  type BillingCadence,
} from "@/lib/billing/catalog";
import { cn } from "@/lib/utils";

interface CloudBillingCadencePickerProps {
  value: BillingCadence;
  onValueChange: (cadence: BillingCadence) => void;
  locationCount?: number;
  availableCadences?: BillingCadence[];
  disabled?: boolean;
}

function dollars(value: number) {
  return `$${value.toLocaleString("en-US")}`;
}

export function CloudBillingCadencePicker({
  value,
  onValueChange,
  locationCount = 1,
  availableCadences = ["month", "year"],
  disabled = false,
}: CloudBillingCadencePickerProps) {
  const normalizedLocationCount = Math.max(1, locationCount);

  return (
    <fieldset disabled={disabled} className="min-w-0 w-full max-w-full">
      <legend className="font-heading text-base font-semibold">
        Choose a billing schedule
      </legend>
      <p className="mt-1 text-sm text-muted-foreground">
        One Cloud plan with unlimited staff. Annual billing includes two months
        free.
      </p>

      <div className="mt-4 grid min-w-0 w-full max-w-full gap-3 sm:grid-cols-2">
        {CLOUD_BILLING_OPTIONS.map((option) => {
          const selected = option.cadence === value;
          const available = availableCadences.includes(option.cadence);
          const total = option.priceUsd * normalizedLocationCount;
          const savings = option.savingsUsd * normalizedLocationCount;
          const Icon = option.cadence === "year" ? CalendarDays : RefreshCw;

          return (
            <label
              key={option.cadence}
              className={cn(
                "block min-w-0 max-w-full rounded-lg outline-none transition-opacity focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2",
                available && !disabled
                  ? "cursor-pointer"
                  : "cursor-not-allowed opacity-55",
              )}
            >
              <input
                type="radio"
                name="billing-cadence"
                value={option.cadence}
                checked={selected}
                disabled={disabled || !available}
                onChange={() => onValueChange(option.cadence)}
                className="sr-only"
              />
              <Card
                className={cn(
                  "min-w-0 max-w-full h-full shadow-none transition-colors",
                  selected
                    ? "border-primary bg-primary/5 ring-1 ring-primary"
                    : "hover:border-primary/40",
                )}
              >
                <CardHeader className="gap-3 p-4 pb-3">
                  <div className="flex items-start justify-between gap-3">
                    <span className="flex size-9 items-center justify-center rounded-md bg-primary/10 text-primary">
                      <Icon className="size-4" aria-hidden="true" />
                    </span>
                    {savings > 0 ? (
                      <Badge variant="success">Save {dollars(savings)}</Badge>
                    ) : null}
                  </div>
                  <div>
                    <CardTitle className="text-base">{option.name}</CardTitle>
                    <CardDescription className="mt-1">
                      {option.supportingText}
                    </CardDescription>
                  </div>
                </CardHeader>
                <CardContent className="flex flex-col gap-3 p-4 pt-0">
                  <div>
                    <span className="font-heading text-2xl font-bold">
                      {dollars(total)}
                    </span>
                    <span className="ml-1 text-sm text-muted-foreground">
                      {option.shortIntervalLabel}
                    </span>
                    {normalizedLocationCount > 1 ? (
                      <p className="mt-1 text-xs text-muted-foreground">
                        {dollars(option.priceUsd)} per active location
                      </p>
                    ) : null}
                  </div>

                  <div className="flex flex-col gap-1.5 text-xs text-muted-foreground">
                    <span className="flex items-center gap-2">
                      <Check
                        className="size-3.5 text-primary"
                        aria-hidden="true"
                      />
                      Unlimited staff included
                    </span>
                    <span className="flex items-center gap-2">
                      <Check
                        className="size-3.5 text-primary"
                        aria-hidden="true"
                      />
                      Secure checkout powered by Stripe
                    </span>
                  </div>

                  {!available ? (
                    <p className="text-xs font-medium text-destructive">
                      Temporarily unavailable
                    </p>
                  ) : null}
                </CardContent>
              </Card>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

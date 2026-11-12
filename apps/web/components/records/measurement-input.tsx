"use client";

import { useId } from "react";
import { Input } from "@/components/ui/input";
import {
  WEIGHT_UNITS,
  TEMPERATURE_UNITS,
  type WeightUnit,
  type TemperatureUnit,
} from "@/lib/clinical-units";

type CommonProps = {
  value: string;
  onChange: (value: string) => void;
  valid: boolean;
  disabled?: boolean;
};
type Props = CommonProps &
  (
    | {
        kind: "weight";
        unit: WeightUnit;
        onUnitChange: (unit: WeightUnit) => void;
      }
    | {
        kind: "temperature";
        unit: TemperatureUnit;
        onUnitChange: (unit: TemperatureUnit) => void;
      }
  );

export function MeasurementInput(props: Props) {
  const id = useId();
  const label = props.kind === "weight" ? "Weight" : "Temperature";
  const units = props.kind === "weight" ? WEIGHT_UNITS : TEMPERATURE_UNITS;
  return (
    <div className="space-y-1">
      <label
        htmlFor={id}
        className="block text-xs font-medium text-muted-foreground"
      >
        {label} ({props.kind === "temperature" ? "°" : ""}
        {props.unit})
      </label>
      <div className="flex gap-1">
        <Input
          id={id}
          type="text"
          inputMode="decimal"
          maxLength={20}
          aria-describedby={!props.valid ? `${id}-error` : undefined}
          className="min-w-0"
          value={props.value}
          aria-invalid={!props.valid}
          disabled={props.disabled}
          onChange={(event) => props.onChange(event.currentTarget.value)}
        />
        <select
          aria-label={`${label} unit`}
          className="h-10 rounded-md border border-input bg-background px-2 text-sm"
          value={props.unit}
          disabled={props.disabled}
          onChange={(event) => {
            if (props.kind === "weight")
              props.onUnitChange(event.currentTarget.value as WeightUnit);
            else
              props.onUnitChange(event.currentTarget.value as TemperatureUnit);
          }}
        >
          {units.map((unit) => (
            <option key={unit} value={unit}>
              {props.kind === "temperature" ? "°" : ""}
              {unit}
            </option>
          ))}
        </select>
      </div>
      {!props.valid && props.value.trim() ? (
        <p id={`${id}-error`} role="status" className="text-xs text-destructive">
          Check the measurement and selected unit.
        </p>
      ) : null}
    </div>
  );
}

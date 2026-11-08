import { inBuilderArm } from "./build/catalog";

export function usesClinicBuilder(input: {
  cardRequired: boolean;
  builderPercent: number;
  funnelId?: string | null;
}): boolean {
  return (
    input.cardRequired && inBuilderArm(input.funnelId, input.builderPercent)
  );
}

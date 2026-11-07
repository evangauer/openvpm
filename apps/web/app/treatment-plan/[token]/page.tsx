import { TreatmentPlanDecisionClient } from "./treatment-plan-decision-client";

export const dynamic = "force-dynamic";

export default async function TreatmentPlanPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return <TreatmentPlanDecisionClient token={token} />;
}

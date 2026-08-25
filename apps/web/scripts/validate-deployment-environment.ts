import { assertDeploymentEnvironment } from "../lib/deployment-environment";

try {
  const check = assertDeploymentEnvironment();
  console.log(
    `Deployment environment contract passed for ${check.environment} (${check.businessTier}).`,
  );
} catch (error) {
  console.error(
    "Deployment environment contract failed:",
    error instanceof Error ? error.message : "invalid configuration",
  );
  process.exitCode = 1;
}

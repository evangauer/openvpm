import { fileURLToPath } from "node:url";
import { resetDatabase } from "./reset";
import { assertStagingResetPolicy } from "./reset-policy";

async function main(): Promise<number> {
  try {
    const target = assertStagingResetPolicy(process.env);
    const count = await resetDatabase();
    console.log(
      JSON.stringify({
        status: "passed",
        resetEnvironment: "staging",
        projectRefFingerprint: target.projectRefFingerprint,
        tablesReset: count,
      }),
    );
    return 0;
  } catch (error) {
    console.error(
      "Staging reset refused:",
      error instanceof Error ? error.message : "invalid reset request",
    );
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(await main());
}

/** Explicit test opt-in only. Callers retain their loopback and exact URL checks. */
export function isApprovedRehearsalDatabase(
  name: string,
  approvedName = process.env.OPENVPM_TEST_REHEARSAL_DATABASE,
): boolean {
  return typeof name === "string" && typeof approvedName === "string" &&
    name === approvedName &&
    /^openvpm_release_rehearsal_[0-9]{8}_[a-f0-9]{4,16}$/.test(name);
}

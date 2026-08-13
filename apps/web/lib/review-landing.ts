type ReviewLandingInput = {
  recoveryHold: boolean;
};

/**
 * Clinics under a recovery hold always enter through the imported-history
 * workspace. The decision is made on the server from the authenticated
 * tenant, so a caller cannot choose another clinic or forge review mode.
 */
export function reviewLandingPath({ recoveryHold }: ReviewLandingInput): string {
  return recoveryHold ? "/migration-archive" : "/";
}

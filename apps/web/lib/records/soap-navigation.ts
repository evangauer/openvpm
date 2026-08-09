export interface SoapNavigationClick {
  href: string;
  currentHref: string;
  button: number;
  defaultPrevented: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  target: string | null;
  download: boolean;
}

export interface SoapLeaveState {
  finalizedElsewhere: boolean;
  needsGuard: boolean;
  localTextCopied: boolean;
  hasLocalText: boolean;
}

export function soapEditorNeedsLeaveGuard(input: {
  draftInitialized: boolean;
  finalizedElsewhere: boolean;
  localTextCopied: boolean;
  hasLocalText: boolean;
  conflict: boolean;
  savePending: boolean;
  dirty: boolean;
}): boolean {
  if (input.finalizedElsewhere) {
    return input.hasLocalText && !input.localTextCopied;
  }
  if (!input.draftInitialized) return false;
  return input.conflict || input.savePending || input.dirty;
}

export async function runSoapSafeLeave(input: {
  readState: () => SoapLeaveState;
  persistDraft: () => Promise<unknown>;
  confirmFinalizedLocalTextLeave: () => boolean;
  confirmUnsavedLeave: () => boolean;
  navigate: () => void;
}): Promise<boolean> {
  let state = input.readState();
  if (!state.finalizedElsewhere && state.needsGuard) {
    await input.persistDraft();
    // Persist can discover that another session finalized the note. Re-read
    // before navigation so preserved local text cannot be stranded by a race.
    state = input.readState();
  }

  if (
    state.finalizedElsewhere &&
    state.hasLocalText &&
    !state.localTextCopied &&
    !input.confirmFinalizedLocalTextLeave()
  ) {
    return false;
  }
  if (
    !state.finalizedElsewhere &&
    state.needsGuard &&
    !input.confirmUnsavedLeave()
  ) {
    return false;
  }

  input.navigate();
  return true;
}

/**
 * Returns an in-app destination only when an ordinary primary anchor click
 * should be routed through the SOAP editor's save-before-leave guard.
 */
export function guardedSoapNavigationDestination(
  click: SoapNavigationClick,
): string | null {
  if (
    click.defaultPrevented ||
    click.button !== 0 ||
    click.metaKey ||
    click.ctrlKey ||
    click.shiftKey ||
    click.altKey ||
    click.download
  ) {
    return null;
  }

  const target = click.target?.trim().toLowerCase();
  if (target && target !== "_self") return null;

  let current: URL;
  let destination: URL;
  try {
    current = new URL(click.currentHref);
    destination = new URL(click.href, current);
  } catch {
    return null;
  }

  if (destination.origin !== current.origin) return null;

  // Let the browser handle hash-only links and no-op links locally. There is
  // no page teardown for the draft guard to protect in either case.
  if (
    destination.pathname === current.pathname &&
    destination.search === current.search
  ) {
    return null;
  }

  return `${destination.pathname}${destination.search}${destination.hash}`;
}

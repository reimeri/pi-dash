export interface DesktopSenderIdentity {
  sender: unknown;
  senderFrame: { readonly url: string } | null;
  expectedSender: unknown;
  expectedMainFrame: unknown;
  expectedOrigin: string | undefined;
  windowAvailable: boolean;
}

export function validateDesktopSenderIdentity(
  identity: DesktopSenderIdentity,
): void {
  let trustedOrigin = false;
  try {
    trustedOrigin =
      !!identity.expectedOrigin &&
      new URL(identity.senderFrame?.url ?? "").origin ===
        identity.expectedOrigin;
  } catch {
    // Reject malformed sender URLs below.
  }
  if (
    !identity.windowAvailable ||
    identity.sender !== identity.expectedSender ||
    identity.senderFrame !== identity.expectedMainFrame ||
    !trustedOrigin
  ) {
    throw new Error("Desktop integration is unavailable to this sender");
  }
}

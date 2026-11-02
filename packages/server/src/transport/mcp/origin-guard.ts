// Origin and Host validation for the MCP endpoint. Revision 2026-07-28 requires
// validating Origin and the SDK handler does not, so the HTTP edge does it before
// anything else. Defense in depth against DNS rebinding on a loopback bind.

export interface OriginGuardConfig {
  /** Empty means no Origin is allowed, so only non-browser clients get through. */
  allowedOrigins: readonly string[];
  /** Empty means Host is not validated. */
  allowedHosts: readonly string[];
}

export function isAllowedByOriginGuard(
  config: OriginGuardConfig,
  headers: { origin: string | undefined; host: string | undefined },
): boolean {
  if (headers.origin !== undefined && !config.allowedOrigins.includes(headers.origin)) {
    return false;
  }
  if (config.allowedHosts.length === 0) return true;
  const host = headers.host?.toLowerCase();
  return host !== undefined && config.allowedHosts.includes(host);
}

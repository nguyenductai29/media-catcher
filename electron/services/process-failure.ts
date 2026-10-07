import type { ErrorCode } from "../../shared/models";

/** No diagnostics/cause/arguments survive the process boundary. */
export class ProcessFailure extends Error {
  constructor(
    code: ErrorCode,
    readonly authenticationRequired = false,
  ) {
    super(code);
  }
}
export function classifyProcessFailure(diagnostic: string, fallback: ErrorCode): ProcessFailure {
  if (/\bENOSPC\b|no space left on device|not enough space on (?:the )?disk/i.test(diagnostic))
    return new ProcessFailure("insufficientSpace");
  if (/\bDRM\b|digital rights management/i.test(diagnostic))
    return new ProcessFailure("drmProtected");
  if (
    /\b(?:ENETUNREACH|ENETDOWN|EHOSTUNREACH|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND)\b|network is unreachable|no route to host|temporary failure in name resolution|name or service not known|getaddrinfo failed|failed to resolve|connection (?:reset|refused|aborted)|remote end closed|unable to (?:connect|resolve)|(?:connection|socket|read operation) timed out/i.test(
      diagnostic,
    )
  )
    return new ProcessFailure("networkUnavailable");
  const authenticationRequired =
    /\bHTTP Error (?:401|403)\b|\b(?:sign[ -]?in|log[ -]?in|authentication) (?:is )?required\b|\bplease (?:sign[ -]?in|log[ -]?in)\b|\byou (?:must|need to) (?:sign[ -]?in|log[ -]?in)\b/i.test(
      diagnostic,
    );
  return new ProcessFailure(fallback, authenticationRequired);
}

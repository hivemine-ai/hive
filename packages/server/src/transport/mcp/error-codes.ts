// Named constants for the JSON-RPC error codes emitted by the MCP transport.
// Source of truth: tech spec § "Mapping de errores". Keep this module dependency-
// free so it can be imported anywhere (handlers, tests, docs).
//
// Revision 2026-07-28 leaves -32000 to -32019 implementation-defined and reserves
// -32020 to -32099. Inside the free range, -32002 is unusable: the SDK rewrites it to
// -32602 at the wire because it is the retired "resource not found" code.

export const MCP_ERR_UNAUTHORIZED = -32001;
export const MCP_ERR_RECIPIENT_UNREACHABLE = -32004;
export const MCP_ERR_SENDER_QUOTA_EXCEEDED = -32005;
export const MCP_ERR_FORBIDDEN = -32006;
// ADR-026: register_session. Each registration error has its own code so the client can
// act on it; -32011 is answered by the edge with HTTP 429 and Retry-After.
export const MCP_ERR_NAME_IN_USE = -32007;
export const MCP_ERR_NAME_TAKEN = -32008;
export const MCP_ERR_AGENT_SUSPENDED = -32009;
export const MCP_ERR_ENROLLMENT_QUOTA_EXCEEDED = -32010;
export const MCP_ERR_ENROLLMENT_RATE_LIMITED = -32011;
export const MCP_ERR_INVALID_PARAMS = -32602; // JSON-RPC standard
export const MCP_ERR_INTERNAL = -32603; // JSON-RPC standard

export type McpErrorCode =
  | typeof MCP_ERR_UNAUTHORIZED
  | typeof MCP_ERR_FORBIDDEN
  | typeof MCP_ERR_RECIPIENT_UNREACHABLE
  | typeof MCP_ERR_SENDER_QUOTA_EXCEEDED
  | typeof MCP_ERR_NAME_IN_USE
  | typeof MCP_ERR_NAME_TAKEN
  | typeof MCP_ERR_AGENT_SUSPENDED
  | typeof MCP_ERR_ENROLLMENT_QUOTA_EXCEEDED
  | typeof MCP_ERR_ENROLLMENT_RATE_LIMITED
  | typeof MCP_ERR_INVALID_PARAMS
  | typeof MCP_ERR_INTERNAL;

// Named constants for the JSON-RPC error codes emitted by the MCP transport.
// Source of truth: tech spec § "Mapping de errores". Keep this module dependency-
// free so it can be imported anywhere (handlers, tests, docs).

export const MCP_ERR_UNAUTHORIZED = -32001;
export const MCP_ERR_FORBIDDEN = -32002;
export const MCP_ERR_RECIPIENT_UNREACHABLE = -32004;
export const MCP_ERR_INVALID_PARAMS = -32602; // JSON-RPC standard
export const MCP_ERR_INTERNAL = -32603; // JSON-RPC standard

export type McpErrorCode =
  | typeof MCP_ERR_UNAUTHORIZED
  | typeof MCP_ERR_FORBIDDEN
  | typeof MCP_ERR_RECIPIENT_UNREACHABLE
  | typeof MCP_ERR_INVALID_PARAMS
  | typeof MCP_ERR_INTERNAL;

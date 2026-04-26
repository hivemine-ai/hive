// Per-command table schemas. Centralized so program.ts can pick the right
// renderer per subcommand without duplicating column definitions.

import type { TableSchema } from './tables.js';

export const initSchema: TableSchema<{
  hiveId: string;
  hiveName: string;
  adminEmail: string;
  adminId: string;
  signingKeyKid: string;
  credentialJti: string;
  credentialExpiresAt: Date;
  credentialPath: string | null;
}> = [
  { header: 'hiveId', accessor: (r) => r.hiveId },
  { header: 'hiveName', accessor: (r) => r.hiveName },
  { header: 'adminEmail', accessor: (r) => r.adminEmail },
  { header: 'adminId', accessor: (r) => r.adminId },
  { header: 'kid', accessor: (r) => r.signingKeyKid, maxWidth: 32 },
  { header: 'credentialJti', accessor: (r) => r.credentialJti },
  { header: 'expiresAt', accessor: (r) => r.credentialExpiresAt },
  {
    header: 'credentialPath',
    accessor: (r) => r.credentialPath ?? '<stdout>',
  },
];

export const migrateSchema: TableSchema<{
  action: string;
  applied: { name: string; status: string }[];
}> = [
  { header: 'action', accessor: (r) => r.action },
  {
    header: 'applied',
    accessor: (r) => (r.applied.length === 0 ? '0 migrations' : `${r.applied.length} migrations`),
  },
];

export const listKeepersSchema: TableSchema<{
  id: string;
  email: string;
  displayName: string | null;
  isAdmin: boolean;
  state: string;
  createdAt: Date;
}> = [
  { header: 'id', accessor: (r) => r.id },
  { header: 'email', accessor: (r) => r.email },
  { header: 'displayName', accessor: (r) => r.displayName ?? '' },
  { header: 'isAdmin', accessor: (r) => r.isAdmin },
  { header: 'state', accessor: (r) => r.state },
  { header: 'createdAt', accessor: (r) => r.createdAt },
];

export const createHivekeeperSchema: TableSchema<{
  hivekeeperId: string;
  email: string;
  isAdmin: boolean;
  displayName: string | null;
  credentialJti: string | null;
  credentialExpiresAt: Date | null;
  credentialPath: string | null;
}> = [
  { header: 'hivekeeperId', accessor: (r) => r.hivekeeperId },
  { header: 'email', accessor: (r) => r.email },
  { header: 'isAdmin', accessor: (r) => r.isAdmin },
  { header: 'displayName', accessor: (r) => r.displayName ?? '' },
  { header: 'credentialJti', accessor: (r) => r.credentialJti ?? '<none>' },
  { header: 'expiresAt', accessor: (r) => r.credentialExpiresAt ?? '' },
  { header: 'credentialPath', accessor: (r) => r.credentialPath ?? '<stdout>' },
];

export const createAgentSchema: TableSchema<{
  agentId: string;
  name: string;
  type: string;
  ownerId: string;
  credentialJti: string | null;
  credentialExpiresAt: Date | null;
  credentialPath: string | null;
}> = [
  { header: 'agentId', accessor: (r) => r.agentId },
  { header: 'name', accessor: (r) => r.name },
  { header: 'type', accessor: (r) => r.type },
  { header: 'ownerId', accessor: (r) => r.ownerId },
  { header: 'credentialJti', accessor: (r) => r.credentialJti ?? '<none>' },
  { header: 'expiresAt', accessor: (r) => r.credentialExpiresAt ?? '' },
  { header: 'credentialPath', accessor: (r) => r.credentialPath ?? '<stdout>' },
];

export const listAgentsSchema: TableSchema<{
  id: string;
  name: string;
  type: string;
  ownerId: string;
  state: string;
  capabilities: string[];
  createdAt: Date;
}> = [
  { header: 'id', accessor: (r) => r.id },
  { header: 'name', accessor: (r) => r.name },
  { header: 'type', accessor: (r) => r.type },
  { header: 'ownerId', accessor: (r) => r.ownerId },
  { header: 'state', accessor: (r) => r.state },
  { header: 'capabilities', accessor: (r) => r.capabilities, maxWidth: 32 },
  { header: 'createdAt', accessor: (r) => r.createdAt },
];

export const issueCredentialSchema: TableSchema<{
  jti: string;
  participantId: string;
  expiresAt: Date;
  kid: string;
  credentialPath: string | null;
}> = [
  { header: 'jti', accessor: (r) => r.jti },
  { header: 'participantId', accessor: (r) => r.participantId },
  { header: 'expiresAt', accessor: (r) => r.expiresAt },
  { header: 'kid', accessor: (r) => r.kid, maxWidth: 32 },
  { header: 'credentialPath', accessor: (r) => r.credentialPath ?? '<stdout>' },
];

export const rotateCredentialSchema: TableSchema<{
  newJti: string;
  oldJti: string;
  expiresAt: Date;
  kid: string;
  credentialPath: string | null;
}> = [
  { header: 'newJti', accessor: (r) => r.newJti },
  { header: 'oldJti', accessor: (r) => r.oldJti },
  { header: 'expiresAt', accessor: (r) => r.expiresAt },
  { header: 'kid', accessor: (r) => r.kid, maxWidth: 32 },
  { header: 'credentialPath', accessor: (r) => r.credentialPath ?? '<stdout>' },
];

export const revokeCredentialSchema: TableSchema<{ revokedJti: string }> = [
  { header: 'revokedJti', accessor: (r) => r.revokedJti },
];

export const revokeAgentSchema: TableSchema<{ revokedAgentId: string }> = [
  { header: 'revokedAgentId', accessor: (r) => r.revokedAgentId },
];

export const listCredentialsSchema: TableSchema<{
  jti: string;
  participantId: string;
  kid: string;
  notBefore: Date;
  expiresAt: Date;
  issuedAt: Date;
  isRevoked: boolean;
}> = [
  { header: 'jti', accessor: (r) => r.jti },
  { header: 'kid', accessor: (r) => r.kid, maxWidth: 32 },
  { header: 'issuedAt', accessor: (r) => r.issuedAt },
  { header: 'notBefore', accessor: (r) => r.notBefore },
  { header: 'expiresAt', accessor: (r) => r.expiresAt },
  { header: 'isRevoked', accessor: (r) => r.isRevoked },
];

export const auditEntrySchema: TableSchema<{
  id: string;
  category: string;
  decision: string;
  actorId: string | null;
  actorKind: string | null;
  subjectId: string | null;
  subjectKind: string | null;
  occurredAt: Date;
}> = [
  { header: 'occurredAt', accessor: (r) => r.occurredAt },
  { header: 'category', accessor: (r) => r.category },
  { header: 'decision', accessor: (r) => r.decision },
  { header: 'actorKind', accessor: (r) => r.actorKind ?? '' },
  { header: 'actorId', accessor: (r) => r.actorId ?? '' },
  { header: 'subjectKind', accessor: (r) => r.subjectKind ?? '' },
  { header: 'subjectId', accessor: (r) => r.subjectId ?? '' },
  { header: 'id', accessor: (r) => r.id },
];

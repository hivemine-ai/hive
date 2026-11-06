// Registration state of one proxy (ADR-026 decision 3.a): at most one name at a
// time, its Worker token, and the exclusive lock on the persisted token of that
// name, held for as long as the name is ours.
//
// Lock of the persisted token (tech spec, amendment 2026-11-05):
//   (a) lock taken and a usable file: renew with that token as Bearer; a -32001
//       deletes the file and falls back to the enrollment credential, keeping the lock;
//   (b) lock taken and no file: register with the enrollment credential;
//   (c) lock not taken (another live session of this folder uses the name): never
//       read the file, register with the enrollment credential (the server answers
//       name_in_use while the other one lives).
// Operations are serialized: a renewal timer and a model call never interleave.

import { isUsableToken } from './token-store.js';
import type { PersistedToken, TokenSlot } from './token-store.js';
import type {
  RegisterArgs,
  RegisterResponse,
  SessionErrorCode,
  SessionFailure,
} from './upstream.js';

export interface Registered {
  name: string;
  description: string;
  capabilities?: string[];
  agentRef: string;
  agentId: string;
  token: string;
  expiresAt: Date;
}

export type RegistrationOutcome =
  | { ok: true; registered: Registered; via: 'renewed' | 'enrolled'; identityChanged: boolean }
  | ({ ok: false } & SessionFailure);

export interface RegistrationDeps {
  serverUrl: string;
  now(): number;
  /** Read on every registration, so a refreshed `claude install` takes effect. */
  enrollmentCredential(): string | undefined;
  callRegister(bearer: string, args: RegisterArgs): Promise<RegisterResponse>;
  /** Takes the lock of the name, or undefined when another holder has it. */
  openSlot(name: string): TokenSlot | undefined;
  /** Called before the current identity goes away (its stream must close first). */
  leave(current: Registered): Promise<void>;
}

/** Input of a registration; without a description, the one saved with the token is used. */
export interface RegisterRequest {
  name: string;
  description?: string;
  capabilities?: string[];
}

/** Failures that a later retry of the same registration can fix. */
const RETRYABLE: ReadonlySet<SessionErrorCode> = new Set<SessionErrorCode>([
  'transport',
  'rate_limited',
  'upstream_error',
  'enrollment_rejected',
]);

export function isRetryableFailure(code: SessionErrorCode): boolean {
  return RETRYABLE.has(code);
}

function fail(code: SessionErrorCode, message: string): { ok: false } & SessionFailure {
  return { ok: false, code, message };
}

export class SessionRegistration {
  private state: Registered | undefined;
  private slot: TokenSlot | undefined;
  /** Arguments of an identity being recovered after its token was rejected. */
  private pending: RegisterArgs | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: RegistrationDeps) {}

  get current(): Registered | undefined {
    return this.state;
  }

  private serial<T>(step: () => Promise<T>): Promise<T> {
    const run = this.queue.then(step, step);
    this.queue = run.catch(() => undefined);
    return run;
  }

  register(request: RegisterRequest): Promise<RegistrationOutcome> {
    return this.serial(async () => {
      const previous = this.state;
      if (previous !== undefined && previous.name !== request.name) {
        await this.deps.leave(previous);
        this.state = undefined;
        this.releaseSlot();
      }
      this.pending = undefined;

      if (this.state !== undefined) {
        const args = this.argsOf(request, this.state.description);
        const renewed = await this.renewWith(this.state.token, args);
        if (renewed.ok || renewed.code !== 'auth_rejected') return renewed;
        this.slot?.remove();
        return this.enroll(args);
      }

      const identityChanged = previous !== undefined;
      const outcome = await this.registerNew(request);
      if (!outcome.ok) {
        this.releaseSlot();
        return outcome;
      }
      return { ...outcome, identityChanged };
    });
  }

  /** Renews the current identity with its last token. Never falls back by itself. */
  renew(): Promise<RegistrationOutcome> {
    return this.serial(async () => {
      const current = this.state;
      if (current === undefined) return fail('not_registered', 'the session is not registered');
      return this.renewWith(current.token, this.argsOf(current, current.description));
    });
  }

  /**
   * After a rejected token: leaves the identity, deletes its file and registers
   * again with the enrollment credential under the same lock. A retryable failure
   * keeps the lock and the arguments for the next attempt; any other releases both.
   */
  reenroll(): Promise<RegistrationOutcome> {
    return this.serial(async () => {
      const args = this.state ? this.argsOf(this.state, this.state.description) : this.pending;
      if (args === undefined) return fail('not_registered', 'the session is not registered');
      this.slot?.remove();
      const outcome = await this.enroll(args);
      if (outcome.ok) {
        this.pending = undefined;
        return outcome;
      }
      if (isRetryableFailure(outcome.code)) {
        this.pending = args;
      } else {
        this.pending = undefined;
        this.releaseSlot();
      }
      return outcome;
    });
  }

  /** Forgets the identity and releases the lock; the token file stays for the next process. */
  drop(): void {
    this.state = undefined;
    this.pending = undefined;
    this.releaseSlot();
  }

  private argsOf(request: RegisterRequest, fallbackDescription: string): RegisterArgs {
    return {
      name: request.name,
      description: request.description ?? fallbackDescription,
      ...(request.capabilities !== undefined && { capabilities: request.capabilities }),
    };
  }

  private async registerNew(request: RegisterRequest): Promise<RegistrationOutcome> {
    let slot: TokenSlot | undefined;
    let saved: PersistedToken | undefined;
    try {
      slot = this.deps.openSlot(request.name);
      saved = slot?.read();
    } catch (err) {
      slot?.release();
      const code = (err as { code?: unknown }).code;
      return code === 'SESSION_STATE_INSECURE_PERMS'
        ? fail('session_state_insecure_perms', (err as Error).message)
        : fail('session_state_invalid', (err as Error).message);
    }
    this.slot = slot;

    const description = request.description ?? saved?.description;
    if (description === undefined) {
      return fail('description_unknown', `no description is known for '${request.name}'`);
    }
    const capabilities = request.capabilities ?? saved?.capabilities;
    const args: RegisterArgs = {
      name: request.name,
      description,
      ...(capabilities !== undefined && { capabilities }),
    };

    if (saved !== undefined) {
      if (isUsableToken(saved, this.deps.serverUrl, this.deps.now())) {
        const renewed = await this.renewWith(saved.token, args);
        if (renewed.ok || renewed.code !== 'auth_rejected') return renewed;
      }
      slot?.remove();
    }
    return this.enroll(args);
  }

  private async renewWith(bearer: string, args: RegisterArgs): Promise<RegistrationOutcome> {
    const response = await this.deps.callRegister(bearer, args);
    if (!response.ok) return response;
    return this.adopt(response, args, 'renewed');
  }

  private async enroll(args: RegisterArgs): Promise<RegistrationOutcome> {
    const credential = this.deps.enrollmentCredential();
    if (credential === undefined) {
      return fail(
        'not_installed',
        'this folder has no Hive enrollment; run `hivectl claude install`',
      );
    }
    if (this.state !== undefined) {
      await this.deps.leave(this.state);
      this.state = undefined;
    }
    const response = await this.deps.callRegister(credential, args);
    if (!response.ok) {
      return response.code === 'auth_rejected'
        ? {
            ok: false,
            code: 'enrollment_rejected',
            message:
              'the server rejected the enrollment credential (revoked or rotated); run `hivectl claude install` with a valid one',
            ...(response.rpcCode !== undefined && { rpcCode: response.rpcCode }),
          }
        : response;
    }
    return this.adopt(response, args, 'enrolled');
  }

  private adopt(
    response: Extract<RegisterResponse, { ok: true }>,
    args: RegisterArgs,
    via: 'renewed' | 'enrolled',
  ): RegistrationOutcome {
    const registered: Registered = {
      name: args.name,
      description: args.description,
      ...(args.capabilities !== undefined && { capabilities: args.capabilities }),
      agentRef: response.agentRef,
      agentId: response.agentId,
      token: response.token,
      expiresAt: new Date(response.expiresAt),
    };
    this.state = registered;
    this.slot?.write({
      version: 1,
      serverUrl: this.deps.serverUrl,
      agentRef: registered.agentRef,
      agentId: registered.agentId,
      token: registered.token,
      expiresAt: response.expiresAt,
      updatedAt: new Date(this.deps.now()).toISOString(),
      description: registered.description,
      ...(registered.capabilities !== undefined && { capabilities: registered.capabilities }),
    });
    return { ok: true, registered, via, identityChanged: false };
  }

  private releaseSlot(): void {
    this.slot?.release();
    this.slot = undefined;
  }
}

/**
 * Token lifecycle for the user grant: authorize, persist, refresh.
 *
 * The grant is stored through DSH's `credentials` service rather than in our
 * own settings document, for two reasons: the app secret and the tokens are
 * secrets and must not travel to the browser in a settings snapshot, and
 * `modifyRecord` is a serialized read-modify-write, which is what makes a
 * refresh safe when a poll and a manual action overlap.
 *
 * @module dsh-lark-session-monitor-plugin/auth
 */

import {
  MONITOR_SCOPES,
  beginDeviceAuthorization,
  credentialKeyFor,
  pollDeviceToken,
  refreshUserToken,
} from './oauth.mjs';

/** Refresh slightly before expiry so a poll never uses a stale token. */
const REFRESH_MARGIN_MS = 5 * 60_000;

export class Authorizer {
  #credentials;
  #store;
  #fetchImpl;
  #now;
  #attempts = new Map();
  #refreshing = null;

  constructor({ credentials, store, fetchImpl = fetch, now = Date.now }) {
    this.#credentials = credentials;
    this.#store = store;
    this.#fetchImpl = fetchImpl;
    this.#now = now;
  }

  #key() {
    const appId = this.#store.snapshot().app.appId;
    if (!appId) throw new Error('尚未配置飞书 App ID。');
    return credentialKeyFor(appId);
  }

  async readGrant() {
    if (!this.#credentials) return undefined;
    const appId = this.#store.snapshot().app.appId;
    if (!appId) return undefined;
    const record = await this.#credentials.readRecord(credentialKeyFor(appId));
    const payload = record?.kind === 'grant' ? record.payload : undefined;
    return payload && typeof payload === 'object' ? payload : undefined;
  }

  /** Whether a stored grant exists, without exposing it. */
  async authorizationState() {
    const grant = await this.readGrant();
    if (!grant?.accessToken) {
      return { authorized: false, scope: '', expiresAt: null, needsRefresh: false };
    }
    const expiresAt = Number.isFinite(grant.expiresAt) ? grant.expiresAt : null;
    return {
      authorized: true,
      scope: typeof grant.scope === 'string' ? grant.scope : '',
      expiresAt,
      needsRefresh: expiresAt !== null && expiresAt - REFRESH_MARGIN_MS <= this.#now(),
    };
  }

  async #writeGrant(grant) {
    const key = this.#key();
    await this.#credentials.modifyRecord(key, async () => ({ kind: 'grant', payload: grant }));
    return grant;
  }

  /** Start a device authorization and return the user-facing instructions. */
  async begin() {
    const app = this.#store.snapshot().app;
    const attempt = await beginDeviceAuthorization({
      appId: app.appId,
      appSecret: app.appSecret,
      domain: app.domain,
      scopes: MONITOR_SCOPES,
      fetchImpl: this.#fetchImpl,
    });
    this.#attempts.set(attempt.deviceCode, { ...attempt, startedAt: this.#now() });
    return attempt;
  }

  /**
   * Complete one authorization attempt.
   *
   * `pending` is returned rather than thrown: the settings page polls this
   * while the user is still on the approval page.
   */
  async complete(deviceCode) {
    const app = this.#store.snapshot().app;
    const outcome = await pollDeviceToken({
      appId: app.appId,
      appSecret: app.appSecret,
      deviceCode,
      domain: app.domain,
      fetchImpl: this.#fetchImpl,
      now: this.#now,
    });
    if (outcome.status !== 'authorized') {
      return { status: outcome.status };
    }
    const grant = await this.#writeGrant(outcome.token);
    this.#attempts.delete(deviceCode);
    return {
      status: 'authorized',
      scope: grant.scope ?? '',
      expiresAt: grant.expiresAt ?? null,
    };
  }

  async signOut() {
    if (!this.#credentials) return;
    try {
      await this.#credentials.deleteRecord(this.#key());
    } catch {
      // An absent record is already the desired state.
    }
    this.#attempts.clear();
  }

  /**
   * Resolve a usable access token, refreshing when it is close to expiry.
   *
   * Refreshes are single-flight: concurrent polls share one rotation so the
   * refresh token is never rotated twice in parallel.
   */
  async accessToken({ force = false } = {}) {
    const grant = await this.readGrant();
    if (!grant?.accessToken) return undefined;
    const expiresAt = Number.isFinite(grant.expiresAt) ? grant.expiresAt : 0;
    const fresh = !force && expiresAt - REFRESH_MARGIN_MS > this.#now();
    if (fresh) return grant.accessToken;
    if (!grant.refreshToken) {
      // No way to renew: surface the token and let a 401 force re-auth.
      return expiresAt > this.#now() ? grant.accessToken : undefined;
    }
    if (!this.#refreshing) {
      this.#refreshing = this.#refresh(grant).finally(() => { this.#refreshing = null; });
    }
    const refreshed = await this.#refreshing;
    return refreshed?.accessToken;
  }

  async #refresh(grant) {
    const app = this.#store.snapshot().app;
    try {
      const token = await refreshUserToken({
        appId: app.appId,
        appSecret: app.appSecret,
        refreshToken: grant.refreshToken,
        domain: app.domain,
        fetchImpl: this.#fetchImpl,
        now: this.#now,
      });
      return await this.#writeGrant(token);
    } catch (error) {
      // A dead refresh token means the user must authorize again; keep the
      // record so the settings page can say so instead of silently vanishing.
      return undefined;
    }
  }
}

export { REFRESH_MARGIN_MS };

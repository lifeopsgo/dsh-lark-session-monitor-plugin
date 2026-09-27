// src/oauth.mjs
var ACCOUNTS_HOSTS = Object.freeze({
  feishu: "https://accounts.feishu.cn",
  lark: "https://accounts.larksuite.com"
});
var API_HOSTS = Object.freeze({
  feishu: "https://open.feishu.cn",
  lark: "https://open.larksuite.com"
});
var MONITOR_SCOPES = Object.freeze([
  "im:message.p2p_msg:get_as_user",
  "im:message.group_msg:get_as_user",
  "im:chat:read",
  "offline_access"
]);
var DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
function accountsHost(domain) {
  return ACCOUNTS_HOSTS[domain] ?? ACCOUNTS_HOSTS.feishu;
}
function apiHost(domain) {
  return API_HOSTS[domain] ?? API_HOSTS.feishu;
}
function formBody(fields) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== void 0 && value !== null) body.set(key, String(value));
  }
  return body;
}
function errorFromBody(body, fallback) {
  const code = typeof body?.error === "string" ? body.error : void 0;
  const description = typeof body?.error_description === "string" ? body.error_description : void 0;
  const error = new Error(description || code || fallback);
  error.code = code ?? fallback;
  return error;
}
async function postForm(url, fields, { fetchImpl = fetch, signal } = {}) {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json"
    },
    body: formBody(fields),
    signal
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Feishu OAuth returned a non-JSON response (HTTP ${response.status})`);
  }
  if (!response.ok) throw errorFromBody(body, `feishu-oauth-http-${response.status}`);
  return body;
}
async function beginDeviceAuthorization(options) {
  const {
    appId,
    appSecret,
    domain = "feishu",
    scopes = MONITOR_SCOPES,
    fetchImpl = fetch,
    signal
  } = options;
  if (!appId || !appSecret) throw new TypeError("appId and appSecret are required");
  const body = await postForm(`${accountsHost(domain)}/oauth/v1/device_authorization`, {
    client_id: appId,
    client_secret: appSecret,
    scope: scopes.join(" ")
  }, { fetchImpl, signal });
  const deviceCode = body.device_code;
  const verificationUri = body.verification_uri ?? body.verification_uri_complete;
  if (typeof deviceCode !== "string" || !deviceCode) {
    throw errorFromBody(body, "feishu-oauth-missing-device-code");
  }
  if (typeof verificationUri !== "string" || !verificationUri) {
    throw errorFromBody(body, "feishu-oauth-missing-verification-uri");
  }
  const userCode = typeof body.user_code === "string" ? body.user_code : void 0;
  const complete = typeof body.verification_uri_complete === "string" ? body.verification_uri_complete : `${verificationUri}?user_code=${encodeURIComponent(userCode ?? "")}`;
  return {
    deviceCode,
    userCode,
    verificationUrl: verificationUri,
    verificationUrlComplete: complete,
    expiresInSeconds: Number.isFinite(body.expires_in) ? body.expires_in : 300,
    intervalSeconds: Number.isFinite(body.interval) ? body.interval : 5
  };
}
function tokenRecordFrom(body, now) {
  const accessToken = body.access_token;
  if (typeof accessToken !== "string" || !accessToken) {
    throw errorFromBody(body, "feishu-oauth-missing-access-token");
  }
  const expiresIn = Number.isFinite(body.expires_in) ? body.expires_in : 7200;
  return {
    accessToken,
    refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : void 0,
    // Refresh a minute early so a poll never races an expiring token.
    expiresAt: now() + Math.max(0, expiresIn - 60) * 1e3,
    scope: typeof body.scope === "string" ? body.scope : MONITOR_SCOPES.join(" "),
    tokenType: typeof body.token_type === "string" ? body.token_type : "Bearer"
  };
}
async function pollDeviceToken(options) {
  const {
    appId,
    appSecret,
    deviceCode,
    domain = "feishu",
    fetchImpl = fetch,
    signal,
    now = Date.now
  } = options;
  const body = await postForm(`${apiHost(domain)}/open-apis/authen/v2/oauth/token`, {
    // RFC 8628 exchange: the device code is redeemed with its own grant type
    // and its own parameter name. Sending `authorization_code`/`code` gets
    // "The authorization code is not found", because the endpoint then looks
    // for a browser redirect code that this flow never produces.
    grant_type: DEVICE_CODE_GRANT_TYPE,
    client_id: appId,
    client_secret: appSecret,
    device_code: deviceCode
  }, { fetchImpl, signal });
  const error = typeof body?.error === "string" ? body.error : void 0;
  if (error === "authorization_pending") return { status: "pending" };
  if (error === "slow_down") return { status: "slow-down" };
  if (error) throw errorFromBody(body, "feishu-oauth-failed");
  return { status: "authorized", token: tokenRecordFrom(body, now) };
}
async function refreshUserToken(options) {
  const {
    appId,
    appSecret,
    refreshToken,
    domain = "feishu",
    fetchImpl = fetch,
    signal,
    now = Date.now
  } = options;
  if (!refreshToken) {
    const error = new Error("No Feishu refresh token is stored; authorize again.");
    error.code = "feishu-oauth-missing-refresh-token";
    throw error;
  }
  const body = await postForm(`${apiHost(domain)}/open-apis/authen/v2/oauth/token`, {
    grant_type: "refresh_token",
    client_id: appId,
    client_secret: appSecret,
    refresh_token: refreshToken
  }, { fetchImpl, signal });
  const token = tokenRecordFrom(body, now);
  if (!token.refreshToken) token.refreshToken = refreshToken;
  return token;
}
var CREDENTIAL_SCOPE = "dsh-lark-session-monitor-plugin";
function credentialIdSegment(appId) {
  const normalized = String(appId ?? "").toLowerCase().replace(/[^a-z0-9-]/g, "-");
  return /^[a-z][a-z0-9-]*$/.test(normalized) ? normalized : "unknown-app";
}
function credentialKeyFor(appId) {
  return `${CREDENTIAL_SCOPE}/${credentialIdSegment(appId)}`;
}

// src/auth.mjs
var REFRESH_MARGIN_MS = 5 * 6e4;
var Authorizer = class {
  #credentials;
  #store;
  #fetchImpl;
  #now;
  #attempts = /* @__PURE__ */ new Map();
  #refreshing = null;
  constructor({ credentials, store, fetchImpl = fetch, now = Date.now }) {
    this.#credentials = credentials;
    this.#store = store;
    this.#fetchImpl = fetchImpl;
    this.#now = now;
  }
  #key() {
    const appId = this.#store.snapshot().app.appId;
    if (!appId) throw new Error("\u5C1A\u672A\u914D\u7F6E\u98DE\u4E66 App ID\u3002");
    return credentialKeyFor(appId);
  }
  async readGrant() {
    if (!this.#credentials) return void 0;
    const appId = this.#store.snapshot().app.appId;
    if (!appId) return void 0;
    const record = await this.#credentials.readRecord(credentialKeyFor(appId));
    const payload = record?.kind === "grant" ? record.payload : void 0;
    return payload && typeof payload === "object" ? payload : void 0;
  }
  /** Whether a stored grant exists, without exposing it. */
  async authorizationState() {
    const grant = await this.readGrant();
    if (!grant?.accessToken) {
      return { authorized: false, scope: "", expiresAt: null, needsRefresh: false };
    }
    const expiresAt = Number.isFinite(grant.expiresAt) ? grant.expiresAt : null;
    return {
      authorized: true,
      scope: typeof grant.scope === "string" ? grant.scope : "",
      expiresAt,
      needsRefresh: expiresAt !== null && expiresAt - REFRESH_MARGIN_MS <= this.#now()
    };
  }
  async #writeGrant(grant) {
    const key = this.#key();
    await this.#credentials.modifyRecord(key, async () => ({ kind: "grant", payload: grant }));
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
      fetchImpl: this.#fetchImpl
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
      now: this.#now
    });
    if (outcome.status !== "authorized") {
      return { status: outcome.status };
    }
    const grant = await this.#writeGrant(outcome.token);
    this.#attempts.delete(deviceCode);
    return {
      status: "authorized",
      scope: grant.scope ?? "",
      expiresAt: grant.expiresAt ?? null
    };
  }
  async signOut() {
    if (!this.#credentials) return;
    try {
      await this.#credentials.deleteRecord(this.#key());
    } catch {
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
    if (!grant?.accessToken) return void 0;
    const expiresAt = Number.isFinite(grant.expiresAt) ? grant.expiresAt : 0;
    const fresh = !force && expiresAt - REFRESH_MARGIN_MS > this.#now();
    if (fresh) return grant.accessToken;
    if (!grant.refreshToken) {
      return expiresAt > this.#now() ? grant.accessToken : void 0;
    }
    if (!this.#refreshing) {
      this.#refreshing = this.#refresh(grant).finally(() => {
        this.#refreshing = null;
      });
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
        now: this.#now
      });
      return await this.#writeGrant(token);
    } catch (error) {
      return void 0;
    }
  }
};

// src/bot-identity.mjs
async function readJson(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Feishu returned a non-JSON response (HTTP ${response.status})`);
  }
}
function failFor(body, fallback) {
  const error = new Error(typeof body?.msg === "string" && body.msg ? body.msg : fallback);
  error.code = body?.code ?? fallback;
  return error;
}
async function fetchAppBotOpenId({
  appId,
  appSecret,
  domain = "feishu",
  fetchImpl = fetch,
  signal
} = {}) {
  if (!appId || !appSecret) return void 0;
  const host = apiHost(domain);
  const tokenResponse = await fetchImpl(
    new URL(`${host}/open-apis/auth/v3/tenant_access_token/internal`),
    {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8", accept: "application/json" },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      signal
    }
  );
  const tokenBody = await readJson(tokenResponse);
  if (tokenBody?.code !== 0) throw failFor(tokenBody, "feishu-tenant-token-failed");
  const token = tokenBody?.tenant_access_token;
  if (typeof token !== "string" || !token) throw failFor(tokenBody, "feishu-tenant-token-missing");
  const infoResponse = await fetchImpl(new URL(`${host}/open-apis/bot/v3/info`), {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    signal
  });
  const infoBody = await readJson(infoResponse);
  if (infoBody?.code !== 0) throw failFor(infoBody, "feishu-bot-info-failed");
  const openId = infoBody?.bot?.open_id;
  return typeof openId === "string" && openId ? openId : void 0;
}

// src/normalize.mjs
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function parseContent(raw) {
  if (isRecord(raw)) return raw;
  if (typeof raw !== "string" || !raw.trim()) return void 0;
  try {
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? parsed : void 0;
  } catch {
    return void 0;
  }
}
function flattenPostElements(elements) {
  const lines = [];
  for (const line of Array.isArray(elements) ? elements : []) {
    if (!Array.isArray(line)) continue;
    let buffer = "";
    for (const node of line) {
      if (!isRecord(node)) continue;
      if (node.tag === "text" && typeof node.text === "string") {
        buffer += node.text;
      } else if (node.tag === "a" && typeof node.text === "string") {
        const href = typeof node.href === "string" ? node.href : "";
        buffer += href ? `${node.text} (${href})` : node.text;
      } else if (node.tag === "at" && typeof node.user_id === "string") {
        buffer += `@${node.user_name ?? node.user_id}`;
      } else if (node.tag === "img") {
        buffer += "[\u56FE\u7247]";
      } else if (node.tag === "media") {
        buffer += "[\u97F3\u89C6\u9891]";
      } else if (node.tag === "emotion" && typeof node.emoji_type === "string") {
        buffer += `[\u8868\u60C5:${node.emoji_type}]`;
      } else if (node.tag === "code_block" && typeof node.text === "string") {
        buffer += `
\`\`\`
${node.text}
\`\`\``;
      }
    }
    if (buffer.trim()) lines.push(buffer);
  }
  return lines.join("\n");
}
var UNRENDERABLE_LABELS = Object.freeze({
  image: "\u56FE\u7247",
  file: "\u6587\u4EF6",
  audio: "\u8BED\u97F3",
  media: "\u89C6\u9891",
  sticker: "\u8868\u60C5\u5305",
  folder: "\u6587\u4EF6\u5939"
});
function renderMessage(message) {
  const msgType = typeof message?.msg_type === "string" ? message.msg_type : "";
  const content = parseContent(message?.body?.content);
  if (msgType === "text") {
    const text = typeof content?.text === "string" ? content.text.trim() : "";
    return text ? { text, kind: "text" } : null;
  }
  if (msgType === "post") {
    const title = typeof content?.title === "string" ? content.title.trim() : "";
    const body = flattenPostElements(
      content?.content ?? content?.elements ?? (Array.isArray(content) ? content : [])
    ).trim();
    const text = [title, body].filter(Boolean).join("\n");
    return text ? { text, kind: "post" } : null;
  }
  if (msgType === "interactive") {
    const title = typeof content?.header?.title?.content === "string" ? content.header.title.content.trim() : "";
    const summary = typeof content?.summary?.content === "string" ? content.summary.content.trim() : "";
    const text = [title, summary].filter(Boolean).join("\n");
    return text ? { text, kind: "interactive" } : { text: "[\u5361\u7247\u6D88\u606F]", kind: "interactive" };
  }
  if (msgType === "share_chat") {
    const name2 = typeof content?.chat_name === "string" ? content.chat_name.trim() : "";
    return { text: name2 ? `[\u5206\u4EAB\u7FA4\u540D\u7247] ${name2}` : "[\u5206\u4EAB\u7FA4\u540D\u7247]", kind: "share_chat" };
  }
  if (msgType === "share_user") {
    const name2 = typeof content?.user_name === "string" ? content.user_name.trim() : "";
    return { text: name2 ? `[\u5206\u4EAB\u4E2A\u4EBA\u540D\u7247] ${name2}` : "[\u5206\u4EAB\u4E2A\u4EBA\u540D\u7247]", kind: "share_user" };
  }
  if (msgType === "location") {
    const name2 = typeof content?.name === "string" ? content.name.trim() : "";
    return { text: name2 ? `[\u4F4D\u7F6E] ${name2}` : "[\u4F4D\u7F6E]", kind: "location" };
  }
  if (msgType === "system") {
    return null;
  }
  const label = UNRENDERABLE_LABELS[msgType];
  if (label) return { text: `[${label}]`, kind: msgType };
  return { text: `[${msgType || "\u672A\u77E5\u7C7B\u578B"}\u6D88\u606F]`, kind: msgType || "unknown" };
}
function isAppSender(message) {
  const senderType = message?.sender?.sender_type;
  return senderType === "app" || senderType === "bot";
}
function isOwnMessage(message, identity) {
  if (!identity) return false;
  const sender = message?.sender;
  const sent = [
    sender?.id,
    sender?.sender_id?.open_id,
    sender?.sender_id?.union_id,
    sender?.sender_id?.user_id
  ];
  const own = [identity.openId, identity.unionId, identity.userId];
  return sent.some((value) => typeof value === "string" && value && own.includes(value));
}
function senderIdsOf(message) {
  const sender = message?.sender;
  return [
    sender?.id,
    sender?.sender_id?.open_id,
    sender?.sender_id?.union_id,
    sender?.sender_id?.user_id
  ].filter((value) => typeof value === "string" && value);
}
function isFromSenders(message, senderIdList) {
  if (!Array.isArray(senderIdList) || senderIdList.length === 0) return true;
  const wanted = new Set(senderIdList.filter((value) => typeof value === "string" && value));
  return senderIdsOf(message).some((id) => wanted.has(id));
}
function mentionsId(message, id) {
  if (typeof id !== "string" || !id) return false;
  const mentions = Array.isArray(message?.mentions) ? message.mentions : [];
  for (const mention of mentions) {
    if (isRecord(mention) && mention.id === id) return true;
  }
  const content = parseContent(message?.body?.content);
  const elements = content?.content ?? content?.elements ?? (Array.isArray(content) ? content : []);
  for (const line of Array.isArray(elements) ? elements : []) {
    if (!Array.isArray(line)) continue;
    for (const node of line) {
      if (isRecord(node) && node.tag === "at" && node.user_id === id) return true;
    }
  }
  return false;
}
function distinctSenders(messages) {
  const byId = /* @__PURE__ */ new Map();
  for (const message of Array.isArray(messages) ? messages : []) {
    const sender = isRecord(message?.sender) ? message.sender : void 0;
    const id = typeof sender?.id === "string" && sender.id ? sender.id : typeof sender?.sender_id?.open_id === "string" ? sender.sender_id.open_id : "";
    if (!id) continue;
    const name2 = typeof sender?.name === "string" ? sender.name.trim() : "";
    const type = sender?.sender_type === "app" || sender?.sender_type === "bot" ? "bot" : "user";
    const existing = byId.get(id);
    if (!existing) {
      byId.set(id, { id, name: name2, type });
    } else if (name2 && !existing.name) {
      existing.name = name2;
    }
  }
  return [...byId.values()];
}
function senderLabel(message) {
  const sender = message?.sender;
  const name2 = typeof sender?.name === "string" ? sender.name.trim() : "";
  if (name2) return name2;
  const id = sender?.id ?? sender?.sender_id?.open_id ?? "";
  return typeof id === "string" && id ? id : "\u672A\u77E5\u53D1\u9001\u8005";
}
function composePrompt(prompt, rendered) {
  const instruction = typeof prompt === "string" ? prompt.trim() : "";
  const body = typeof rendered === "string" ? rendered.trim() : "";
  if (!instruction) return body;
  if (!body) return instruction;
  return `${instruction}

${body}`;
}

// src/inventory.mjs
function isRecord2(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function stringOr(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}
function workspaceFromEntity(entity) {
  if (!isRecord2(entity)) return void 0;
  const record = isRecord2(entity.record) ? entity.record : {};
  const id = entity.id;
  if (typeof id !== "string" || !id) return void 0;
  const sessionIds = Array.isArray(record.sessionIds) ? record.sessionIds.filter((value) => typeof value === "string" && value) : [];
  return {
    workspaceId: id,
    path: stringOr(record.path),
    title: stringOr(record.title),
    sessionIds
  };
}
function listInventory(ctx) {
  const registry = ctx?.get?.("workspaceRegistry");
  if (!registry || typeof registry.list !== "function") {
    return { workspaces: [], archivedSessionIds: [] };
  }
  let entities;
  let archived;
  try {
    entities = registry.list();
    archived = registry.archivedSessionIds;
  } catch {
    return { workspaces: [], archivedSessionIds: [] };
  }
  const workspaces = Array.isArray(entities) ? entities.map(workspaceFromEntity).filter(Boolean) : [];
  const archivedSessionIds = archived && typeof archived[Symbol.iterator] === "function" ? [...archived].filter((value) => typeof value === "string" && value) : [];
  return { workspaces, archivedSessionIds };
}
function listWorkspaces(ctx) {
  return listInventory(ctx).workspaces;
}
function isArchivedSession(inventory, sessionId) {
  return inventory.archivedSessionIds.includes(sessionId);
}
function sessionTitleFor(ctx, session) {
  if (!session) return "";
  const title = ctx?.get?.("sessionTitle");
  if (!title || typeof title.get !== "function") return "";
  try {
    const snapshot = title.get(session);
    return stringOr(snapshot?.title);
  } catch {
    return "";
  }
}
function titleFromSnapshot(result) {
  if (!result || result.status !== "fulfilled") return "";
  const title = result.value?.title;
  if (typeof title === "string") return title;
  if (title && typeof title === "object" && typeof title.title === "string") return title.title;
  return "";
}
async function listWorkspaceTargets(ctx, signal) {
  const workspaces = listWorkspaces(ctx);
  const ids = [...new Set(workspaces.flatMap((workspace) => workspace.sessionIds))];
  const titles = /* @__PURE__ */ new Map();
  const query = ctx?.get?.("sessionQuery");
  if (ids.length > 0 && query && typeof query.readTitleSnapshots === "function") {
    try {
      const results = await query.readTitleSnapshots(ids, signal);
      if (Array.isArray(results)) {
        results.forEach((result, index) => {
          const id = ids[index];
          const title = titleFromSnapshot(result);
          if (id && title) titles.set(id, title);
        });
      }
    } catch {
    }
  }
  const live = ctx?.get?.("sessions");
  if (live && typeof live.list === "function") {
    try {
      for (const session of live.list()) {
        const id = session?.id;
        if (typeof id === "string" && id && !titles.has(id)) {
          const title = sessionTitleFor(ctx, session);
          if (title) titles.set(id, title);
        }
      }
    } catch {
    }
  }
  return workspaces.map((workspace) => ({
    workspaceId: workspace.workspaceId,
    path: workspace.path,
    title: workspace.title,
    sessions: workspace.sessionIds.map((sessionId) => ({
      sessionId,
      title: titles.get(sessionId) ?? ""
    }))
  }));
}
function isKnownSession(workspaces, sessionId) {
  return workspaces.filter((workspace) => workspace.sessionIds.includes(sessionId));
}

// src/deliver.mjs
var ADOPT_TTL_MS = 5 * 6e4;
function isRecord3(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function unwrapRemote(value) {
  const result = value?.result ?? value;
  if (isRecord3(result) && result.ok === false) {
    const error = new Error(result.error?.message ?? "Harness \u8FDC\u7A0B\u8C03\u7528\u5931\u8D25");
    error.code = result.error?.code;
    throw error;
  }
  if (isRecord3(result) && "value" in result) return result.value;
  return result;
}
var HarnessGateway = class {
  #gateway;
  #requestIdPrefix;
  constructor({ gateway, requestIdPrefix = "lark-monitor" }) {
    if (!gateway || typeof gateway.invoke !== "function") {
      throw new TypeError("Host Typert gateway is required");
    }
    this.#gateway = gateway;
    this.#requestIdPrefix = requestIdPrefix;
  }
  async #invoke(namespace, method, args, signal) {
    const value = await this.#gateway.invoke({
      namespace,
      method,
      args,
      ...signal === void 0 ? {} : { signal }
    });
    return unwrapRemote(value);
  }
  /** Read the first frame of a stream method, then close the iterator. */
  async #streamFirst(namespace, method, args, signal) {
    if (typeof this.#gateway.stream !== "function") {
      throw new TypeError("Host Typert gateway does not support streaming");
    }
    const controller = new AbortController();
    const streamSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let iterator;
    try {
      const source = await this.#gateway.stream({
        namespace,
        method,
        args,
        signal: streamSignal
      });
      iterator = source[Symbol.asyncIterator]();
      const first = await iterator.next();
      if (first.done) {
        throw new Error(`Harness ${namespace}.${method} stream ended before its baseline`);
      }
      return first.value;
    } finally {
      controller.abort(new DOMException("Baseline received", "AbortError"));
      await Promise.resolve(iterator?.return?.()).catch(() => void 0);
    }
  }
  async listWorkspaces(signal) {
    const frame = await this.#streamFirst("workspace", "follow", {}, signal);
    if (frame?.type !== "baseline" || !isRecord3(frame.value)) {
      throw new Error("Harness workspace.follow returned no baseline");
    }
    return Array.isArray(frame.value.items) ? frame.value.items : [];
  }
  async listSessions(signal) {
    const value = await this.#invoke("session", "list", { _request: {} }, signal);
    const items = Array.isArray(value) ? value : value?.items;
    return Array.isArray(items) ? items : [];
  }
  async createSession({ workspaceId, sessionId, agentPreset }, signal) {
    const request = { workspaceId };
    if (sessionId) request.sessionId = sessionId;
    if (agentPreset) request.agentPreset = agentPreset;
    return this.#invoke("session", "create", { request }, signal);
  }
  async prompt({ sessionId, text, rpcId }, signal) {
    return this.#invoke("session", "prompt", {
      request: {
        requestId: rpcId ?? `${this.#requestIdPrefix}-${Date.now()}`,
        sessionId,
        mode: "queue",
        content: [{ type: "text", text }]
      }
    }, signal);
  }
};
function workspaceForSession(sessionId, workspaces) {
  const owners = isKnownSession(workspaces, sessionId);
  if (owners.length === 0) {
    const error = new Error("\u76EE\u6807\u4F1A\u8BDD\u4E0D\u5C5E\u4E8E\u4EFB\u4F55 Harness \u5DE5\u4F5C\u533A\uFF0C\u8BF7\u786E\u8BA4 Session ID\u3002");
    error.code = "session-not-registered";
    throw error;
  }
  if (owners.length > 1) {
    const error = new Error("\u76EE\u6807\u4F1A\u8BDD\u5F52\u5C5E\u591A\u4E2A\u5DE5\u4F5C\u533A\uFF0C\u6682\u65F6\u65E0\u6CD5\u7ED1\u5B9A\u3002");
    error.code = "session-workspace-ambiguous";
    throw error;
  }
  return owners[0];
}
var SessionDeliverer = class {
  #harness;
  #store;
  #logger;
  #adoptions = /* @__PURE__ */ new Map();
  #autoCreatedAt = /* @__PURE__ */ new Map();
  #now;
  #autoCreateCooldownMs;
  #readInventory;
  constructor({
    harness,
    store,
    logger = console,
    now = Date.now,
    autoCreateCooldownMs = 5 * 6e4,
    /**
     * Workspace inventory reader.
     *
     * Defaults to the Remote gateway, but the Host injects a direct registry
     * read: on the live Host the `workspace.follow` stream answered empty
     * while the registry held twenty workspaces, and delivery needs the same
     * answer the picker shows.
     */
    readInventory = async (signal) => ({
      workspaces: await harness.listWorkspaces(signal),
      archivedSessionIds: []
    })
  }) {
    this.#harness = harness;
    this.#store = store;
    this.#logger = logger;
    this.#now = now;
    this.#autoCreateCooldownMs = autoCreateCooldownMs;
    this.#readInventory = readInventory;
  }
  #cachedAdoption(monitorId) {
    const entry = this.#adoptions.get(monitorId);
    if (!entry) return void 0;
    if (this.#now() - entry.at > ADOPT_TTL_MS) {
      this.#adoptions.delete(monitorId);
      return void 0;
    }
    return entry.sessionId;
  }
  /**
   * Ensure the monitor's session is registered before prompting it.
   *
   * Existence is checked first. Without that check a deleted session would be
   * "adopted" by handing its id back to `session.create`, which either
   * recreates a session under an id the user never chose or fails opaquely —
   * so the missing case is raised here as `session-summary-unavailable`, the
   * one condition the caller is allowed to recover from.
   */
  async #adopt(monitor, signal) {
    const cached = this.#cachedAdoption(monitor.monitorId);
    if (cached && cached === monitor.sessionId) return cached;
    const inventory = await this.#readInventory(signal);
    const workspaces = inventory.workspaces;
    const owners = isKnownSession(workspaces, monitor.sessionId);
    if (owners.length === 0) {
      if (isArchivedSession(inventory, monitor.sessionId)) {
        const error2 = new Error("\u76EE\u6807\u4F1A\u8BDD\u5DF2\u4E0D\u5B58\u5728\u3002");
        error2.code = "session-summary-unavailable";
        throw error2;
      }
      const error = new Error("\u76EE\u6807\u4F1A\u8BDD\u4E0D\u5C5E\u4E8E\u4EFB\u4F55 Harness \u5DE5\u4F5C\u533A\uFF0C\u8BF7\u786E\u8BA4 Session ID\u3002");
      error.code = "session-not-registered";
      throw error;
    }
    const workspace = workspaceForSession(monitor.sessionId, workspaces);
    const adopted = await this.#harness.createSession({
      workspaceId: workspace.workspaceId ?? workspace.id,
      sessionId: monitor.sessionId
    }, signal);
    const sessionId = adopted?.sessionId ?? monitor.sessionId;
    this.#adoptions.set(monitor.monitorId, { sessionId, at: this.#now() });
    return sessionId;
  }
  /** Replace a session the Host reports as gone, at most once per cooldown. */
  async #recreate(monitor, signal) {
    const last = this.#autoCreatedAt.get(monitor.monitorId) ?? 0;
    if (this.#now() - last < this.#autoCreateCooldownMs) {
      const error = new Error("\u76EE\u6807\u4F1A\u8BDD\u5DF2\u4E0D\u5B58\u5728\uFF0C\u4E14\u521A\u521A\u81EA\u52A8\u65B0\u5EFA\u8FC7\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002");
      error.code = "session-recreate-throttled";
      throw error;
    }
    if (!monitor.workspace) {
      const error = new Error("\u76EE\u6807\u4F1A\u8BDD\u5DF2\u4E0D\u5B58\u5728\uFF0C\u4E14\u76D1\u542C\u672A\u914D\u7F6E\u5DE5\u4F5C\u533A\uFF0C\u65E0\u6CD5\u81EA\u52A8\u65B0\u5EFA\u3002");
      error.code = "session-recreate-no-workspace";
      throw error;
    }
    const workspaces = (await this.#readInventory(signal)).workspaces;
    const workspace = workspaces.find((item) => (item.path ?? item.workspace?.path) === monitor.workspace);
    if (!workspace) {
      const error = new Error(`\u5DE5\u4F5C\u533A\u4E0D\u5B58\u5728\uFF1A${monitor.workspace}`);
      error.code = "workspace-not-found";
      throw error;
    }
    this.#autoCreatedAt.set(monitor.monitorId, this.#now());
    const created = await this.#harness.createSession({
      workspaceId: workspace.workspaceId ?? workspace.id
    }, signal);
    const sessionId = created?.sessionId;
    if (!sessionId) {
      const error = new Error("\u81EA\u52A8\u65B0\u5EFA\u4F1A\u8BDD\u5931\u8D25\uFF1AHarness \u672A\u8FD4\u56DE sessionId\u3002");
      error.code = "session-create-failed";
      throw error;
    }
    this.#adoptions.set(monitor.monitorId, { sessionId, at: this.#now() });
    await this.#store.setMonitorSession(monitor.monitorId, { sessionId, sessionTitle: "" });
    this.#logger.warn?.(
      `[lark-session-monitor] monitor ${monitor.monitorId} auto-created session ${sessionId}`
    );
    return sessionId;
  }
  /**
   * Whether a failed adoption means "the session is gone" rather than "the
   * configuration is wrong".
   *
   * Only a deleted session is recoverable by creating a new one. A session
   * that no workspace declares, or that two workspaces claim, is a
   * misconfiguration: auto-creating would appear to fix it while silently
   * delivering into a session the user never chose.
   */
  #isMissingSession(error) {
    return error?.code === "session-not-found" || error?.code === "session-summary-unavailable";
  }
  /**
   * Deliver one batch.
   *
   * `bodies` are already-rendered message texts; they are joined under the
   * monitor's prompt in arrival order.
   *
   * An empty `sessionId` selects one of two auto modes, decided by
   * `autoCreateAndPin`:
   *
   * - `false`: each delivery creates a fresh session and does not write it
   *   back, so every batch gets its own session ("one document per message").
   * - `true`: the first delivery creates a session and pins it to the monitor,
   *   so later messages accumulate in the same conversation. Writing the id
   *   back is exactly what distinguishes it from the per-message mode.
   */
  async deliver(monitor, bodies, signal) {
    if (bodies.length === 0) return { delivered: 0 };
    if (!monitor.sessionId && !monitor.workspace) {
      const error = new Error("\u76D1\u542C\u672A\u7ED1\u5B9A\u76EE\u6807\u4F1A\u8BDD\uFF0C\u4E14\u672A\u914D\u7F6E\u5DE5\u4F5C\u533A\uFF0C\u65E0\u6CD5\u65B0\u5EFA\u4F1A\u8BDD\u3002");
      error.code = "monitor-target-missing";
      throw error;
    }
    const text = composePrompt(monitor.prompt, bodies.join("\n\n"));
    let sessionId;
    if (!monitor.sessionId) {
      sessionId = await this.#createInWorkspace(monitor, signal);
      if (monitor.autoCreateAndPin === true) {
        await this.#store.setMonitorSession(monitor.monitorId, { sessionId, sessionTitle: "" });
        this.#logger.info?.(
          `[lark-session-monitor] monitor ${monitor.monitorId} pinned a new session ${sessionId}`
        );
      }
    } else {
      try {
        sessionId = await this.#adopt(monitor, signal);
      } catch (error) {
        if (!this.#isMissingSession(error)) throw error;
        sessionId = await this.#recreate(monitor, signal);
      }
    }
    await this.#harness.prompt({ sessionId, text }, signal);
    return { delivered: bodies.length, sessionId };
  }
  /**
   * Create a session in the monitor's workspace without persisting its id.
   *
   * Used by the per-message mode. Writing the id back would silently collapse
   * that mode into the single-target mode after the first delivery.
   */
  async #createInWorkspace(monitor, signal) {
    const workspaces = (await this.#readInventory(signal)).workspaces;
    const workspace = workspaces.find((item) => (item.path ?? item.workspace?.path) === monitor.workspace);
    if (!workspace) {
      const error = new Error(`\u5DE5\u4F5C\u533A\u4E0D\u5B58\u5728\uFF1A${monitor.workspace}`);
      error.code = "workspace-not-found";
      throw error;
    }
    const created = await this.#harness.createSession({
      workspaceId: workspace.workspaceId ?? workspace.id
    }, signal);
    const sessionId = created?.sessionId;
    if (!sessionId) {
      const error = new Error("\u65B0\u5EFA\u4F1A\u8BDD\u5931\u8D25\uFF1AHarness \u672A\u8FD4\u56DE sessionId\u3002");
      error.code = "session-create-failed";
      throw error;
    }
    return sessionId;
  }
  /** Drop cached adoption so the next delivery re-resolves ownership. */
  forget(monitorId) {
    this.#adoptions.delete(monitorId);
  }
  clear() {
    this.#adoptions.clear();
    this.#autoCreatedAt.clear();
  }
};

// src/lark-api.mjs
var MESSAGE_PAGE_SIZE = 50;
var LarkApiError = class extends Error {
  constructor(message, { code, status } = {}) {
    super(message);
    this.name = "LarkApiError";
    this.code = code;
    this.status = status;
  }
  /** A rejected or expired token: the caller must re-authorize. */
  get isAuthFailure() {
    return this.status === 401 || this.code === 99991663 || this.code === 99991661 || this.code === 20005;
  }
};
function isRecord4(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
var LarkUserClient = class {
  #domain;
  #getToken;
  #fetchImpl;
  #onAuthFailure;
  /**
   * @param options.getToken - resolves the live access token, refreshing it when stale.
   * @param options.onAuthFailure - invoked when the host rejects the token.
   */
  constructor({ domain = "feishu", getToken, fetchImpl = fetch, onAuthFailure }) {
    this.#domain = domain;
    this.#getToken = getToken;
    this.#fetchImpl = fetchImpl;
    this.#onAuthFailure = onAuthFailure;
  }
  get domain() {
    return this.#domain;
  }
  async #request(path, { method = "GET", query, body, signal } = {}) {
    const token = await this.#getToken({ signal });
    if (!token) {
      throw new LarkApiError("\u5C1A\u672A\u5B8C\u6210\u98DE\u4E66\u6388\u6743\uFF0C\u8BF7\u5148\u5728\u63D2\u4EF6\u8BBE\u7F6E\u9875\u6388\u6743\u3002", { code: "not-authorized" });
    }
    const url = new URL(`${apiHost(this.#domain)}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== void 0 && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }
    const response = await this.#fetchImpl(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        ...body === void 0 ? {} : { "content-type": "application/json; charset=utf-8" }
      },
      ...body === void 0 ? {} : { body: JSON.stringify(body) },
      signal
    });
    const text = await response.text();
    let payload;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      throw new LarkApiError(`\u98DE\u4E66\u63A5\u53E3\u8FD4\u56DE\u4E86\u975E JSON \u54CD\u5E94\uFF08HTTP ${response.status}\uFF09`, {
        status: response.status
      });
    }
    if (!response.ok) {
      const error = new LarkApiError(
        `\u98DE\u4E66\u63A5\u53E3\u8BF7\u6C42\u5931\u8D25\uFF08HTTP ${response.status}\uFF09`,
        { status: response.status, code: payload?.code }
      );
      if (error.isAuthFailure) this.#onAuthFailure?.();
      throw error;
    }
    if (isRecord4(payload) && payload.code !== void 0 && payload.code !== 0) {
      const error = new LarkApiError(
        payload.msg || `\u98DE\u4E66\u63A5\u53E3\u8FD4\u56DE\u9519\u8BEF\u7801 ${payload.code}`,
        { code: payload.code, status: response.status }
      );
      if (error.isAuthFailure) this.#onAuthFailure?.();
      throw error;
    }
    return payload?.data ?? payload;
  }
  /**
   * List the conversations the user is in.
   *
   * The `types` parameter is what makes p2p conversations appear: without it
   * this endpoint returns only groups, which is why a monitor picker that
   * omitted it looked like it had no private chats to offer. `types` takes a
   * comma-separated list, and both are requested together because the monitor
   * is not specific to one kind.
   *
   * @param options.types - `'p2p'`, `'group'`, or both; defaults to both.
   */
  async listChats({ pageSize = 100, types = "p2p,group", signal } = {}) {
    const chats = [];
    let pageToken;
    for (let page = 0; page < 50; page += 1) {
      const data = await this.#request("/open-apis/im/v1/chats", {
        query: {
          page_size: pageSize,
          page_token: pageToken,
          sort_type: "ByCreateTimeAsc",
          types
        },
        signal
      });
      for (const item of data?.items ?? []) {
        const chatId = item?.chat_id;
        if (typeof chatId !== "string" || !chatId) continue;
        chats.push({
          chatId,
          name: typeof item?.name === "string" && item.name.trim() ? item.name.trim() : "",
          chatMode: item?.chat_mode ?? "",
          chatType: item?.chat_mode === "p2p" ? "p2p" : "group",
          external: item?.external === true
        });
      }
      if (!data?.has_more || !data?.page_token) break;
      pageToken = data.page_token;
    }
    return chats;
  }
  /**
   * Read one conversation's messages inside a time window.
   *
   * `start_time` is exclusive on Feishu's side and mandatory here: without it
   * the first poll would page through the conversation's entire history.
   * `maxMessages` bounds the read for callers that only need a sample —
   * the sender picker stops paging once it has enough.
   */
  async listMessages({ chatId, startTimeSeconds, endTimeSeconds, maxMessages, signal }) {
    const messages = [];
    let pageToken;
    for (let page = 0; page < 20; page += 1) {
      const data = await this.#request("/open-apis/im/v1/messages", {
        query: {
          container_id_type: "chat",
          container_id: chatId,
          start_time: startTimeSeconds,
          end_time: endTimeSeconds,
          sort_type: "ByCreateTimeAsc",
          page_size: MESSAGE_PAGE_SIZE,
          page_token: pageToken
        },
        signal
      });
      const items = data?.items ?? [];
      messages.push(...items);
      if (maxMessages !== void 0 && messages.length >= maxMessages) break;
      if (!data?.has_more || !data?.page_token) break;
      pageToken = data.page_token;
    }
    return messages;
  }
  /**
   * The signed-in user's own identity, used to recognize self-sent messages.
   *
   * The endpoint needs no scope beyond a valid user token. `user_id` is a
   * sensitive field and may come back empty, which is fine: open_id is what
   * the message reads carry.
   */
  async userInfo({ signal } = {}) {
    const data = await this.#request("/open-apis/authen/v1/user_info", { signal });
    return {
      openId: typeof data?.open_id === "string" ? data.open_id : "",
      unionId: typeof data?.union_id === "string" ? data.union_id : "",
      userId: typeof data?.user_id === "string" ? data.user_id : "",
      name: typeof data?.name === "string" ? data.name.trim() : ""
    };
  }
  /** Resolve display names for chat ids; failures degrade to the raw id. */
  async chatNames(chatIds, { signal } = {}) {
    const names = /* @__PURE__ */ new Map();
    for (const chatId of chatIds) {
      try {
        const data = await this.#request(`/open-apis/im/v1/chats/${encodeURIComponent(chatId)}`, { signal });
        const name2 = typeof data?.name === "string" ? data.name.trim() : "";
        if (name2) names.set(chatId, name2);
      } catch {
      }
    }
    return names;
  }
};

// src/store.mjs
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
var STORE_VERSION = 1;
var MIN_POLL_INTERVAL_MS = 2e3;
var MONITOR_ID_PATTERN = /^mon_[0-9a-f]{16}$/;
function isRecord5(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : void 0;
}
function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}
function newMonitorId() {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return `mon_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}
function isValidMonitorId(value) {
  return typeof value === "string" && MONITOR_ID_PATTERN.test(value);
}
function normalizeMonitor(input, { existing } = {}) {
  if (!isRecord5(input)) return void 0;
  const chatId = nonEmptyString(input.chatId);
  const prompt = nonEmptyString(input.prompt);
  const workspace = nonEmptyString(input.workspace);
  if (!chatId || !prompt) return void 0;
  const onlySenderIds = [];
  if (Array.isArray(input.onlySenderIds)) {
    for (const value of input.onlySenderIds) {
      const id = nonEmptyString(value);
      if (id && !onlySenderIds.includes(id)) onlySenderIds.push(id);
    }
  }
  const monitor = {
    monitorId: isValidMonitorId(input.monitorId) ? input.monitorId : newMonitorId(),
    name: nonEmptyString(input.name) ?? "",
    chatId,
    chatName: nonEmptyString(input.chatName) ?? "",
    prompt,
    workspace: workspace ?? "",
    sessionId: nonEmptyString(input.sessionId) ?? "",
    sessionTitle: nonEmptyString(input.sessionTitle) ?? "",
    /**
     * Only meaningful while `sessionId` is empty.
     *
     * `false` (default): every delivery creates a new session.
     * `true`: the first delivery creates one and pins it, so later messages
     * accumulate in that session — the choice between "one document per
     * message" and "one running conversation".
     */
    autoCreateAndPin: input.autoCreateAndPin === true,
    /**
     * `false` (default): messages you sent yourself are delivered like
     * anyone else's. `true`: they are skipped, so the session receives what
     * other people say without your own echoes.
     */
    skipOwnMessages: input.skipOwnMessages === true,
    /**
     * Restrict this monitor to specific senders; an empty list means
     * everyone. Ids round-trip with the picker built from observed
     * messages.
     */
    onlySenderIds,
    /**
     * `false` (default): the sender list alone decides. `true`: messages
     * that @-mention this app's own bot are also accepted, even from a
     * sender outside the list — being addressed is the signal, not who
     * typed it. An empty list plus this switch means only @bot messages.
     */
    alsoBotMention: input.alsoBotMention === true,
    enabled: input.enabled !== false,
    createdAt: existing?.createdAt ?? Date.now()
  };
  const cursor = existing?.cursor ?? cursorFrom(input.cursor);
  monitor.cursor = cursor;
  return monitor;
}
function cursorFrom(input) {
  if (!isRecord5(input)) return {};
  const lastMessageId = nonEmptyString(input.lastMessageId);
  const lastCreateTimeMs = Number.isFinite(input.lastCreateTimeMs) ? Math.trunc(input.lastCreateTimeMs) : void 0;
  const cursor = {};
  if (lastMessageId) cursor.lastMessageId = lastMessageId;
  if (lastCreateTimeMs !== void 0) cursor.lastCreateTimeMs = lastCreateTimeMs;
  return cursor;
}
function normalizeMonitors(input) {
  if (!Array.isArray(input)) return [];
  const seen = /* @__PURE__ */ new Set();
  const monitors = [];
  for (const entry of input) {
    const monitor = normalizeMonitor(entry);
    if (!monitor || seen.has(monitor.monitorId)) continue;
    seen.add(monitor.monitorId);
    monitors.push(monitor);
  }
  return monitors;
}
function normalizeSettings(input) {
  const source = isRecord5(input) ? input : {};
  const app = isRecord5(source.app) ? source.app : {};
  return {
    version: STORE_VERSION,
    app: {
      appId: nonEmptyString(app.appId) ?? "",
      appSecret: nonEmptyString(app.appSecret) ?? "",
      domain: app.domain === "lark" ? "lark" : "feishu"
    },
    pollIntervalMs: Number.isFinite(source.pollIntervalMs) ? Math.max(MIN_POLL_INTERVAL_MS, Math.trunc(source.pollIntervalMs)) : 3e4,
    monitors: normalizeMonitors(source.monitors)
  };
}
var SETTINGS_FILE_NAME = "settings.json";
function settingsPath(env = process.env) {
  const root = env.DSH_HOME || join(homedir(), ".dsh");
  return join(root, "plugin-data", "dsh-lark-session-monitor-plugin", SETTINGS_FILE_NAME);
}
var MonitorStore = class {
  #file;
  #loaded = false;
  #settings = normalizeSettings({});
  #writeChain = Promise.resolve();
  constructor({ file = settingsPath() } = {}) {
    this.#file = file;
  }
  /** Whether this store can persist; the file path is always available. */
  get persistent() {
    return Boolean(this.#file);
  }
  /** Read the document. A missing or unreadable file starts from defaults. */
  async open() {
    if (!this.#file) {
      this.#settings = normalizeSettings({});
      return this.snapshot();
    }
    try {
      const text = await readFile(this.#file, "utf8");
      this.#settings = normalizeSettings(JSON.parse(text));
    } catch (error) {
      if (error?.code !== "ENOENT") {
        console.warn(
          `[lark-session-monitor] settings at ${this.#file} could not be read; starting from defaults`,
          error?.message ?? error
        );
      }
      this.#settings = normalizeSettings({});
    }
    this.#loaded = true;
    return this.snapshot();
  }
  /** The current settings, deep-copied so callers cannot mutate stored state. */
  snapshot() {
    return cloneJson(this.#settings);
  }
  monitors() {
    return this.#settings.monitors.map((monitor) => cloneJson(monitor));
  }
  monitor(monitorId) {
    const found = this.#settings.monitors.find((m) => m.monitorId === monitorId);
    return found ? cloneJson(found) : void 0;
  }
  /**
   * Serialize one mutation and persist the result.
   *
   * The write is atomic (temp file + rename) so a crash mid-write cannot leave
   * a half-written document that the next boot would read as corrupt.
   */
  #write(mutate) {
    const run = this.#writeChain.then(async () => {
      const draft = cloneJson(this.#settings);
      const result = mutate(draft);
      this.#settings = normalizeSettings(draft);
      await this.#persist();
      return result;
    });
    this.#writeChain = run.then(() => void 0, () => void 0);
    return run;
  }
  async #persist() {
    if (!this.#file) return;
    const body = `${JSON.stringify(this.#settings, null, 2)}
`;
    const temp = `${this.#file}.tmp`;
    await mkdir(dirname(this.#file), { recursive: true });
    await writeFile(temp, body, { encoding: "utf8", mode: 384 });
    await rename(temp, this.#file);
  }
  saveApp({ appId, appSecret, domain, pollIntervalMs }) {
    return this.#write((draft) => {
      if (appId !== void 0) draft.app.appId = nonEmptyString(appId) ?? "";
      if (appSecret !== void 0) {
        const next = nonEmptyString(appSecret);
        if (next !== void 0) draft.app.appSecret = next;
      }
      if (domain !== void 0) draft.app.domain = domain === "lark" ? "lark" : "feishu";
      if (pollIntervalMs !== void 0 && Number.isFinite(pollIntervalMs)) {
        draft.pollIntervalMs = Math.max(MIN_POLL_INTERVAL_MS, Math.trunc(pollIntervalMs));
      }
      return cloneJson(draft.app);
    });
  }
  /**
   * Create or update one monitor.
   *
   * The existing record is merged in (rather than replaced) so a settings save
   * that omits `cursor` keeps the polling position.
   */
  upsertMonitor(input) {
    return this.#write((draft) => {
      const requestedId = isValidMonitorId(input?.monitorId) ? input.monitorId : void 0;
      const index = requestedId ? draft.monitors.findIndex((m) => m.monitorId === requestedId) : -1;
      const existing = index >= 0 ? draft.monitors[index] : void 0;
      const monitor = normalizeMonitor({ ...existing, ...input }, { existing });
      if (!monitor) throw new Error("\u76D1\u542C\u914D\u7F6E\u4E0D\u5B8C\u6574\uFF1A\u4F1A\u8BDD\u4E0E Prompt \u4E3A\u5FC5\u586B\u9879\u3002");
      if (existing) draft.monitors[index] = monitor;
      else draft.monitors.push(monitor);
      return cloneJson(monitor);
    });
  }
  removeMonitor(monitorId) {
    return this.#write((draft) => {
      const before = draft.monitors.length;
      draft.monitors = draft.monitors.filter((m) => m.monitorId !== monitorId);
      if (draft.monitors.length === before) throw new Error("\u76D1\u542C\u4E0D\u5B58\u5728\u6216\u5DF2\u88AB\u5220\u9664\u3002");
      return { deleted: true };
    });
  }
  /** Advance one monitor's polling cursor; ignored if the monitor is gone. */
  advanceCursor(monitorId, cursor) {
    return this.#write((draft) => {
      const index = draft.monitors.findIndex((m) => m.monitorId === monitorId);
      if (index < 0) return void 0;
      const current = draft.monitors[index].cursor ?? {};
      const next = cursorFrom(cursor);
      draft.monitors[index].cursor = {
        ...current,
        ...next,
        // Never move the high-water mark backwards.
        lastCreateTimeMs: Math.max(
          current.lastCreateTimeMs ?? 0,
          next.lastCreateTimeMs ?? 0
        ) || void 0
      };
      return cloneJson(draft.monitors[index].cursor);
    });
  }
  /** Record the session a monitor delivers into, after an auto-create. */
  setMonitorSession(monitorId, { sessionId, sessionTitle }) {
    return this.#write((draft) => {
      const index = draft.monitors.findIndex((m) => m.monitorId === monitorId);
      if (index < 0) return void 0;
      if (sessionId !== void 0) draft.monitors[index].sessionId = nonEmptyString(sessionId) ?? "";
      if (sessionTitle !== void 0) {
        draft.monitors[index].sessionTitle = nonEmptyString(sessionTitle) ?? "";
      }
      return cloneJson(draft.monitors[index]);
    });
  }
};
function publicSettings(settings) {
  return {
    version: settings.version,
    app: {
      appId: settings.app.appId,
      domain: settings.app.domain,
      hasSecret: Boolean(settings.app.appSecret)
    },
    pollIntervalMs: settings.pollIntervalMs,
    monitors: settings.monitors.map(publicMonitor)
  };
}
function publicMonitor(monitor) {
  return {
    monitorId: monitor.monitorId,
    name: monitor.name,
    chatId: monitor.chatId,
    chatName: monitor.chatName,
    prompt: monitor.prompt,
    workspace: monitor.workspace,
    sessionId: monitor.sessionId,
    sessionTitle: monitor.sessionTitle,
    autoCreateAndPin: monitor.autoCreateAndPin === true,
    skipOwnMessages: monitor.skipOwnMessages === true,
    onlySenderIds: [...monitor.onlySenderIds ?? []],
    alsoBotMention: monitor.alsoBotMention === true,
    enabled: monitor.enabled !== false
  };
}

// src/runtime.mjs
var MAX_BATCH_SIZE = 10;
var INITIAL_LOOKBACK_MS = 10 * 6e4;
function messageTimeMs(message) {
  const raw = message?.create_time;
  if (typeof raw === "string" && raw.trim()) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  return null;
}
var MonitorRuntime = class {
  #store;
  #deliverer;
  #logger;
  #getClient;
  #getIntervalMs;
  #now;
  #timer = null;
  #polling = false;
  #closed = false;
  #inFlight = /* @__PURE__ */ new Map();
  #pending = /* @__PURE__ */ new Map();
  #state = /* @__PURE__ */ new Map();
  #controller = new AbortController();
  /** The signed-in user's identity, fetched once for own-message filtering. */
  #identityCache;
  /** The app bot's open_id, fetched once for the @机器人 filter. */
  #botIdCache;
  #getBotOpenId;
  constructor({ store, deliverer, getClient, getIntervalMs, logger = console, now = Date.now, getBotOpenId }) {
    this.#store = store;
    this.#deliverer = deliverer;
    this.#getClient = getClient;
    this.#getIntervalMs = getIntervalMs ?? (() => 3e4);
    this.#logger = logger;
    this.#now = now;
    this.#getBotOpenId = getBotOpenId;
  }
  /** Per-monitor status for the settings page. */
  status() {
    const settings = this.#store.snapshot();
    return settings.monitors.map((monitor) => {
      const state = this.#state.get(monitor.monitorId) ?? {};
      return {
        monitorId: monitor.monitorId,
        lastPollAt: state.lastPollAt ?? null,
        lastMessageAt: monitor.cursor?.lastCreateTimeMs ?? null,
        delivered: state.delivered ?? 0,
        pending: (this.#pending.get(monitor.monitorId) ?? []).length,
        lastError: state.lastError ?? null
      };
    });
  }
  start() {
    if (this.#closed) throw new Error("Monitor runtime is closed");
    if (this.#timer) return;
    const interval = Math.max(MIN_POLL_INTERVAL_MS, Number(this.#getIntervalMs()) || 3e4);
    this.#timer = setInterval(() => {
      void this.poll();
    }, interval);
    this.#timer.unref?.();
    void this.poll();
  }
  stop() {
    this.#closed = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.#controller.abort(new Error("Monitor runtime stopped"));
  }
  /** Restart the timer after the configured interval changed. */
  reschedule() {
    if (this.#closed) return;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.start();
  }
  #setState(monitorId, patch) {
    this.#state.set(monitorId, { ...this.#state.get(monitorId) ?? {}, ...patch });
  }
  /** Best-effort client construction; a missing token surfaces as poll error. */
  async #client(signal) {
    return this.#getClient({ signal });
  }
  /**
   * Resolve the signed-in user's identity once, for own-message filtering.
   *
   * A failure is cached as "no identity" and logged once: re-fetching every
   * poll would hammer a dying endpoint, and surfacing it as a monitor error
   * would turn a decoration fetch into a delivery outage. The safe reading
   * of "cannot tell who sent this" is to deliver it as before.
   */
  async #identity(client, signal) {
    if (this.#identityCache) return this.#identityCache.identity;
    try {
      const identity = await client.userInfo({ signal });
      this.#identityCache = { identity };
    } catch (error) {
      if (error?.name === "AbortError") return void 0;
      this.#identityCache = { identity: void 0 };
      this.#logger.warn?.(
        `[lark-session-monitor] could not load your Feishu identity; own messages cannot be filtered: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    return this.#identityCache.identity;
  }
  /**
   * The app bot's open_id, for the @机器人 filter.
   *
   * Success is cached for the process. A failure is not cached: this filter
   * cannot fail open (that would turn a narrow filter into a firehose), so
   * the round is held and retried until the identity resolves — the
   * monitor's lastError carries the platform's own message.
   */
  async #botId(signal) {
    if (this.#botIdCache) return this.#botIdCache;
    if (typeof this.#getBotOpenId !== "function") return void 0;
    try {
      const openId = await this.#getBotOpenId({ signal });
      if (typeof openId === "string" && openId) this.#botIdCache = openId;
      return this.#botIdCache;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`\u65E0\u6CD5\u8BC6\u522B\u672C\u5E94\u7528\u7684\u673A\u5668\u4EBA\u8EAB\u4EFD\uFF08${reason}\uFF09\uFF1A\u8BF7\u786E\u8BA4\u5E94\u7528\u5DF2\u542F\u7528\u673A\u5668\u4EBA\u80FD\u529B\uFF0C\u4E14 App ID \u4E0E App Secret \u6709\u6548\u3002`);
    }
  }
  /**
   * One polling round across every enabled monitor.
   *
   * Rounds are single-flight: a round that outlives its interval is skipped
   * rather than overlapped.
   */
  async poll() {
    if (this.#closed || this.#polling) return;
    this.#polling = true;
    try {
      const monitors = this.#store.monitors().filter((m) => m.enabled !== false && m.chatId);
      if (monitors.length === 0) return;
      await Promise.allSettled(
        monitors.map((monitor) => this.pollMonitor(monitor, this.#controller.signal))
      );
    } finally {
      this.#polling = false;
    }
  }
  /** Poll and deliver for one monitor. Never throws. */
  async pollMonitor(monitor, signal) {
    if (this.#inFlight.has(monitor.monitorId)) return;
    const task = this.#runMonitor(monitor, signal).finally(() => {
      this.#inFlight.delete(monitor.monitorId);
    });
    this.#inFlight.set(monitor.monitorId, task);
    return task;
  }
  async #runMonitor(monitor, signal) {
    const latest = this.#store.monitor(monitor.monitorId);
    if (!latest || latest.enabled === false) return;
    try {
      const client = await this.#client(signal);
      const cursorMs = latest.cursor?.lastCreateTimeMs;
      const startTimeMs = cursorMs ?? this.#now() - INITIAL_LOOKBACK_MS;
      const messages = await client.listMessages({
        chatId: latest.chatId,
        // Feishu's start_time is exclusive and second-granular: step back one
        // second so a message sharing the cursor's second is not skipped.
        startTimeSeconds: Math.max(0, Math.floor(startTimeMs / 1e3) - 1),
        endTimeSeconds: Math.floor(this.#now() / 1e3) + 1,
        signal
      });
      this.#setState(latest.monitorId, { lastPollAt: this.#now(), lastError: null });
      const fresh = this.#selectFresh(latest, messages);
      if (fresh.length === 0) return;
      let deliverable = fresh;
      if (latest.skipOwnMessages === true) {
        const identity = await this.#identity(client, signal);
        if (identity) deliverable = fresh.filter((m) => !isOwnMessage(m, identity));
      }
      const senderIds = Array.isArray(latest.onlySenderIds) ? latest.onlySenderIds : [];
      const wantSenders = senderIds.length > 0;
      const wantMention = latest.alsoBotMention === true;
      let botOpenId;
      if (wantMention) {
        botOpenId = await this.#botId(signal);
        if (!botOpenId) {
          throw new Error("\u65E0\u6CD5\u8BC6\u522B\u672C\u5E94\u7528\u7684\u673A\u5668\u4EBA\u8EAB\u4EFD\uFF1A\u8BF7\u786E\u8BA4\u5E94\u7528\u5DF2\u542F\u7528\u673A\u5668\u4EBA\u80FD\u529B\uFF0C\u4E14 App ID \u4E0E App Secret \u6709\u6548\u3002");
        }
      }
      if (wantSenders || wantMention) {
        deliverable = deliverable.filter((message) => wantSenders && isFromSenders(message, senderIds) || wantMention && mentionsId(message, botOpenId));
      }
      const bodies = deliverable.map((message) => this.#format(latest, message)).filter((body) => typeof body === "string" && body);
      if (bodies.length === 0) {
        await this.#advance(latest, fresh[fresh.length - 1]);
        return;
      }
      await this.#enqueue(latest, bodies, fresh);
    } catch (error) {
      if (this.#closed) return;
      const message = error instanceof Error ? error.message : String(error);
      this.#setState(monitor.monitorId, { lastError: message, lastPollAt: this.#now() });
      this.#logger.warn?.(
        `[lark-session-monitor] poll failed for ${monitor.monitorId}: ${message}`
      );
    }
  }
  /**
   * Drop messages at or before the cursor.
   *
   * The cursor is `(createTimeMs, messageId)`: Feishu's time window is
   * second-granular and exclusive, so both halves are needed to avoid
   * re-delivering the cursor message or skipping a sibling.
   */
  #selectFresh(monitor, messages) {
    const cursorMs = monitor.cursor?.lastCreateTimeMs;
    const cursorId = monitor.cursor?.lastMessageId;
    const usable = messages.filter((message) => {
      const id = message?.message_id;
      if (typeof id !== "string" || !id) return false;
      const time = messageTimeMs(message);
      if (time === null) return false;
      if (message?.deleted === true) return false;
      return true;
    });
    if (cursorMs === void 0) return usable;
    return usable.filter((message) => {
      const time = messageTimeMs(message);
      if (time > cursorMs) return true;
      if (time < cursorMs) return false;
      return message.message_id !== cursorId;
    });
  }
  /** Render one message, prefixing the sender so the prompt has provenance. */
  #format(monitor, message) {
    const rendered = renderMessage(message);
    if (!rendered) return void 0;
    const who = isAppSender(message) ? `${senderLabel(message)}\uFF08\u673A\u5668\u4EBA\uFF09` : senderLabel(message);
    return `[${who}] ${rendered.text}`;
  }
  /**
   * Queue bodies and deliver them in batches of {@link MAX_BATCH_SIZE}.
   *
   * The whole page is delivered before the cursor moves. Delivering only the
   * first batch and advancing anyway would drop the remainder permanently,
   * because the next poll starts after the cursor.
   *
   * Each batch re-reads the monitor: an auto-created session is written back
   * during the first delivery, and reusing the caller's snapshot would make
   * the next batch create a second session — silently defeating the "pin the
   * auto-created session" choice.
   */
  async #enqueue(monitor, bodies, fresh) {
    const queue = this.#pending.get(monitor.monitorId) ?? [];
    queue.push(...bodies);
    this.#pending.set(monitor.monitorId, queue);
    let delivered = 0;
    while (queue.length > 0) {
      const batch = queue.slice(0, MAX_BATCH_SIZE);
      const latest = this.#store.monitor(monitor.monitorId) ?? monitor;
      await this.#deliverer.deliver(latest, batch, this.#controller.signal);
      queue.splice(0, batch.length);
      delivered += batch.length;
    }
    await this.#advance(monitor, fresh[fresh.length - 1]);
    this.#setState(monitor.monitorId, {
      delivered: (this.#state.get(monitor.monitorId)?.delivered ?? 0) + delivered,
      lastError: null
    });
  }
  async #advance(monitor, message) {
    const time = messageTimeMs(message);
    if (time === null) return;
    const cursor = { lastCreateTimeMs: time };
    if (typeof message.message_id === "string" && message.message_id) {
      cursor.lastMessageId = message.message_id;
    }
    await this.#store.advanceCursor(monitor.monitorId, cursor);
  }
  /** Drop a monitor's queue when it is disabled or deleted. */
  forget(monitorId) {
    this.#pending.delete(monitorId);
    this.#state.delete(monitorId);
    this.#deliverer.forget(monitorId);
  }
};

// src/rpc.mjs
var RPC_CHANNEL = "/lark-session-monitor";
function rpcEndpoint(channel) {
  if (!/^\/[A-Za-z0-9._~-]+$/.test(channel)) throw new TypeError("Invalid RPC channel");
  return `dsh-plugin${channel}`;
}
function isRecord6(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isLoopbackAuthority(authority) {
  if (!authority) return false;
  try {
    const url = new URL(`http://${authority}`);
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return false;
    const hostname = url.hostname.replace(/\.$/, "");
    return hostname === "localhost" || hostname === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(hostname);
  } catch {
    return false;
  }
}
function isLoopbackRequest(request) {
  if (!isLoopbackAuthority(request.headers.get("host"))) return false;
  const origin = request.headers.get("origin");
  if (origin === null) return true;
  try {
    const url = new URL(origin);
    return ["http:", "https:"].includes(url.protocol) && isLoopbackAuthority(url.host);
  } catch {
    return false;
  }
}
function failureOf(error) {
  const code = typeof error?.code === "string" ? error.code : "internal";
  return {
    code,
    message: error instanceof Error ? error.message : String(error),
    details: {}
  };
}
function reply(rpcId, result) {
  const value = result.ok === false ? { ...result, error: { ...result.error, details: result.error.details ?? {} } } : result;
  return Response.json({ type: "server-response", rpcId, result: value });
}
function registerSettingsRpc(ctx, handler, { authority = "trusted-host" } = {}) {
  const endpoint = rpcEndpoint(RPC_CHANNEL);
  if (typeof ctx?.connection?.fetch?.register !== "function") {
    throw new TypeError("DSH Host Connection Fetch registry is required");
  }
  const loopbackOnly = authority === "loopback";
  return ctx.connection.fetch.register({
    path: `/api/${endpoint}`,
    methods: ["POST"],
    requestBody: "buffered",
    async fetch(request) {
      if (loopbackOnly && !isLoopbackRequest(request)) {
        return new Response("forbidden", { status: 403 });
      }
      if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
      if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
        return new Response("content type must be application/json", { status: 415 });
      }
      let message;
      try {
        message = await request.json();
      } catch {
        return new Response("body is not JSON", { status: 400 });
      }
      const rpcId = typeof message?.rpcId === "string" ? message.rpcId : "invalid-request";
      const call = message?.payload;
      if (!isRecord6(message) || message.type !== "client-request" || typeof message.rpcId !== "string" || message.method !== endpoint || !isRecord6(call) || typeof call.method !== "string" || !Object.hasOwn(call, "payload")) {
        return reply(rpcId, {
          ok: false,
          error: { code: "bad-request", message: "Invalid settings request.", details: {} }
        });
      }
      try {
        return reply(rpcId, { ok: true, value: await handler(call.method, call.payload, request.signal) });
      } catch (error) {
        return reply(rpcId, { ok: false, error: failureOf(error) });
      }
    }
  });
}

// src/index.mjs
var name = "dsh-lark-session-monitor-plugin";
var inject = ["connection"];
var DEFAULT_CONFIG = Object.freeze({
  rpcAuthority: "trusted-host",
  autoStart: true,
  maxChats: 500
});
function resolveConfig(input) {
  const config = input && typeof input === "object" ? input : {};
  return {
    rpcAuthority: config.rpcAuthority === "loopback" ? "loopback" : DEFAULT_CONFIG.rpcAuthority,
    autoStart: config.autoStart === false ? false : DEFAULT_CONFIG.autoStart,
    maxChats: Number.isFinite(config.maxChats) && config.maxChats > 0 ? Math.trunc(config.maxChats) : DEFAULT_CONFIG.maxChats
  };
}
function optional(ctx, key) {
  if (typeof ctx.get === "function") return ctx.get(key);
  return ctx[key];
}
function intervalReader(store) {
  return () => store.snapshot().pollIntervalMs;
}
function apply(ctx, config) {
  const settings = resolveConfig(config);
  const logger = typeof ctx.logger === "function" ? ctx.logger(name) : console;
  const credentials = optional(ctx, "credentials");
  if (!credentials) {
    logger.warn?.("[lark-session-monitor] credentials service unavailable; authorization cannot persist");
  }
  const store = new MonitorStore();
  const authorizer = new Authorizer({ credentials, store });
  const runtime = { current: null };
  const chats = { cache: /* @__PURE__ */ new Map(), at: 0 };
  const harnessGateway = () => {
    const gateway = optional(ctx, "typertGateway");
    if (!gateway) throw new Error("Host Typert gateway is unavailable.");
    return new HarnessGateway({ gateway });
  };
  let delivererInstance = null;
  const deliverer = {
    deliver: (monitor, bodies, signal) => {
      if (!delivererInstance) {
        delivererInstance = new SessionDeliverer({
          harness: harnessGateway(),
          store,
          logger,
          // Delivery resolves workspaces from the registry, the same source
          // the picker reads, plus the archived ids that distinguish a deleted
          // target from a misconfigured one.
          readInventory: async () => listInventory(ctx)
        });
      }
      return delivererInstance.deliver(monitor, bodies, signal);
    },
    forget: (monitorId) => delivererInstance?.forget(monitorId)
  };
  const clientFor = () => {
    const app = store.snapshot().app;
    return new LarkUserClient({
      domain: app.domain,
      getToken: async () => authorizer.accessToken(),
      onAuthFailure: () => {
        logger.warn?.("[lark-session-monitor] Feishu rejected the user token; re-authorize in settings");
      }
    });
  };
  const start = () => {
    if (runtime.current) return;
    const instance = new MonitorRuntime({
      store,
      deliverer,
      getClient: async () => clientFor(),
      getIntervalMs: intervalReader(store),
      logger,
      // The @机器人 acceptance path needs the app bot's own open_id; the
      // stored appId/appSecret pair is the only bridge to it. Fetched
      // lazily, at most once per process, and only when a monitor uses the
      // switch.
      getBotOpenId: ({ signal }) => {
        const app = store.snapshot().app;
        return fetchAppBotOpenId({
          appId: app.appId,
          appSecret: app.appSecret,
          domain: app.domain,
          signal
        });
      }
    });
    instance.start();
    runtime.current = instance;
  };
  const stop = () => {
    runtime.current?.stop();
    runtime.current = null;
  };
  const requireAuthorized = async () => {
    const state = await authorizer.authorizationState();
    if (!state.authorized) {
      const error = new Error("\u5C1A\u672A\u5B8C\u6210\u98DE\u4E66\u6388\u6743\uFF0C\u8BF7\u5148\u6388\u6743\u3002");
      error.code = "not-authorized";
      throw error;
    }
  };
  const cachedChats = async (force = false) => {
    const now = Date.now();
    if (!force && chats.cache.size > 0 && now - chats.at < 6e4) return [...chats.cache.values()];
    await requireAuthorized();
    const list = await clientFor().listChats();
    chats.cache = new Map(list.map((chat) => [chat.chatId, chat]));
    chats.at = now;
    return list;
  };
  const endpoint = {
    async "settings.get"() {
      const settings2 = publicSettings(store.snapshot());
      const auth = await authorizer.authorizationState();
      return { settings: settings2, authorization: auth, runtime: runtime.current ? runtime.current.status() : [] };
    },
    async "settings.save"(payload) {
      const patch = payload ?? {};
      await store.saveApp({
        appId: patch.appId,
        appSecret: patch.appSecret,
        domain: patch.domain,
        pollIntervalMs: patch.pollIntervalMs
      });
      runtime.current?.reschedule();
      if (store.snapshot().app.appId) {
        if (settings.autoStart) start();
      } else {
        stop();
      }
      return publicSettings(store.snapshot());
    },
    async "auth.begin"() {
      const app = store.snapshot().app;
      if (!app.appId || !app.appSecret) {
        const error = new Error("\u8BF7\u5148\u586B\u5199\u5E76\u4FDD\u5B58\u98DE\u4E66 App ID \u4E0E App Secret\u3002");
        error.code = "invalid-argument";
        throw error;
      }
      return authorizer.begin();
    },
    async "auth.complete"(payload) {
      const deviceCode = typeof payload?.deviceCode === "string" ? payload.deviceCode : "";
      if (!deviceCode) {
        const error = new Error("\u7F3A\u5C11 deviceCode\u3002");
        error.code = "invalid-argument";
        throw error;
      }
      const outcome = await authorizer.complete(deviceCode);
      if (outcome.status === "authorized" && settings.autoStart) start();
      return outcome;
    },
    async "auth.signOut"() {
      await authorizer.signOut();
      chats.cache = /* @__PURE__ */ new Map();
      stop();
      return { signedOut: true };
    },
    async "chat.list"(payload) {
      const force = payload?.force === true;
      const list = await cachedChats(force);
      const limit = settings.maxChats;
      return { chats: list.slice(0, limit), truncated: list.length > limit };
    },
    /**
     * Senders observed in a conversation, for the source picker.
     *
     * Candidates come from the last week of messages through the same
     * user-token read the poller uses — no extra scope, and a member who
     * has never spoken simply is not offered as a choice.
     */
    async "chat.senders"(payload, signal) {
      const chatId = typeof payload?.chatId === "string" ? payload.chatId : "";
      if (!chatId) {
        const error = new Error("\u7F3A\u5C11 chatId\u3002");
        error.code = "invalid-argument";
        throw error;
      }
      await requireAuthorized();
      const now = Date.now();
      const messages = await clientFor().listMessages({
        chatId,
        startTimeSeconds: Math.floor((now - 7 * 24 * 60 * 60 * 1e3) / 1e3),
        endTimeSeconds: Math.floor(now / 1e3) + 1,
        maxMessages: 200,
        signal
      });
      return { senders: distinctSenders(messages) };
    },
    async "monitor.save"(payload) {
      const monitor = await store.upsertMonitor(payload ?? {});
      if (monitor.enabled !== false && settings.autoStart) start();
      runtime.current?.reschedule();
      return monitor;
    },
    async "monitor.delete"(payload) {
      const monitorId = typeof payload?.monitorId === "string" ? payload.monitorId : "";
      if (!monitorId) {
        const error = new Error("\u7F3A\u5C11 monitorId\u3002");
        error.code = "invalid-argument";
        throw error;
      }
      const result = await store.removeMonitor(monitorId);
      runtime.current?.forget(monitorId);
      return result;
    },
    /** Reset a monitor's cursor so the next poll re-reads recent history. */
    async "monitor.reset"(payload) {
      const monitorId = typeof payload?.monitorId === "string" ? payload.monitorId : "";
      const monitor = store.monitor(monitorId);
      if (!monitor) {
        const error = new Error("\u76D1\u542C\u4E0D\u5B58\u5728\u3002");
        error.code = "unknown-monitor";
        throw error;
      }
      await store.advanceCursor(monitorId, {
        lastCreateTimeMs: payload?.sinceMs ?? Date.now() - 10 * 6e4,
        lastMessageId: ""
      });
      runtime.current?.forget(monitorId);
      return store.monitor(monitorId);
    },
    /** Poll once, on demand, for a monitor or every enabled monitor. */
    async "monitor.pollNow"(payload) {
      if (!runtime.current) start();
      if (!runtime.current) {
        const error = new Error("\u8F6E\u8BE2\u672A\u542F\u52A8\uFF0C\u8BF7\u5148\u5B8C\u6210\u6388\u6743\u3002");
        error.code = "not-authorized";
        throw error;
      }
      const monitorId = typeof payload?.monitorId === "string" ? payload.monitorId : void 0;
      if (monitorId) {
        const monitor = store.monitor(monitorId);
        if (!monitor) {
          const error = new Error("\u76D1\u542C\u4E0D\u5B58\u5728\u3002");
          error.code = "unknown-monitor";
          throw error;
        }
        await runtime.current.pollMonitor(monitor, new AbortController().signal);
      } else {
        await runtime.current.poll();
      }
      return runtime.current.status();
    },
    /** Workspaces and their sessions, for the delivery-target picker. */
    async "target.list"(payload, signal) {
      void payload;
      return { workspaces: await listWorkspaceTargets(ctx, signal) };
    }
  };
  ctx.effect(() => {
    const dispose = registerSettingsRpc(ctx, async (method, payload, signal) => {
      void signal;
      if (!Object.hasOwn(endpoint, method)) {
        const error = new Error(`\u672A\u77E5\u7684\u63A5\u53E3\uFF1A${method}`);
        error.code = "bad-request";
        throw error;
      }
      return endpoint[method](payload, signal);
    }, { authority: settings.rpcAuthority });
    return () => dispose?.();
  }, "dsh-lark-session-monitor-plugin: settings endpoint");
  const reportWorkspaceRead = () => {
    try {
      const inventory = listInventory(ctx);
      logger.info?.(
        `[lark-session-monitor] workspace read: workspaces=${inventory.workspaces.length} archived=${inventory.archivedSessionIds.length} first=${inventory.workspaces[0] ? inventory.workspaces[0].path : "none"}`
      );
      if (inventory.workspaces.length === 0) {
        logger.warn("[lark-session-monitor] no workspaces resolved; the target picker will be empty");
      }
    } catch (error) {
      logger.error?.("[lark-session-monitor] workspace read unavailable", error);
    }
  };
  ctx.effect(() => {
    let disposed = false;
    store.open().then(() => {
      if (disposed) return;
      const app = store.snapshot().app;
      logger.info?.(
        `[lark-session-monitor] settings loaded: monitors=${store.monitors().length} appId=${app.appId ? "set" : "unset"} secret=${app.appSecret ? "set" : "unset"}`
      );
      if (settings.autoStart && app.appId && app.appSecret) start();
    }).catch((error) => {
      logger.error?.("[lark-session-monitor] failed to load settings", error);
    });
    void reportWorkspaceRead();
    return () => {
      disposed = true;
      stop();
    };
  }, "dsh-lark-session-monitor-plugin: runtime lifecycle");
}
export {
  MonitorStore,
  apply,
  inject,
  name,
  publicSettings
};

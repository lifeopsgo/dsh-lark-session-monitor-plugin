# Contributing

Thanks for helping improve `dsh-lark-session-monitor-plugin`.

## Development setup

Requirements:

- Node.js 22.6 or newer
- npm (the build is plain `node`, so pnpm and yarn work too)

```bash
npm install
npm run check    # builds both halves, then runs the test suite
```

## Layout

```text
src/
  index.mjs        Host half: wires the store, authorizer, poller and RPC
  oauth.mjs        Feishu OAuth device flow and token refresh
  auth.mjs         Token lifecycle over DSH's credentials service
  store.mjs        Settings: atomic JSON file under $DSH_HOME/plugin-data
  inventory.mjs    Workspace/session inventory read from the Host registry
  lark-api.mjs     Feishu Open API reads with the user token
  normalize.mjs    Feishu message -> readable text (never raw JSON)
  deliver.mjs      Adopt the target session, then submit the prompt
  runtime.mjs      The poll loop and its cursors
  rpc.mjs          Settings endpoint (Host side of the wire)
  client/
    index.js       Settings page, registered into settings.plugins.tab
    snapshot.mjs   Snapshot merge helpers for the page
    rpc-client.mjs Browser side of the wire
scripts/           esbuild bundling for both halves
test/              Node's built-in test runner
```

## Build output is committed

`lib/` is checked in on purpose. A `github:` install runs no build script
unless the package declares `prepare` and the user allowlists it by hash, so
shipping the built output is what keeps installation to one command.

**That means: after changing `src/`, run `npm run build` and commit `lib/`
together with the source.** CI fails when the two disagree.

## Tests

```bash
npm test                 # everything
node --test test/store.test.mjs   # one file
```

Two conventions worth keeping:

- **Test the shipped behavior, not a re-implementation.** The store tests write
  real temporary files instead of a storage double, because a double once
  implemented an API the Host does not have and hid a total persistence
  failure behind passing tests.
- **A regression test must fail against the bug.** When you add one for a fixed
  defect, revert the fix locally and confirm the test goes red before you
  commit it.

## Changing the DSH surface

The plugin consumes Host services (`workspaceRegistry`, `sessions`,
`sessionQuery`, `sessionTitle`, `credentials`, `typertGateway`) and one browser
slot (`settings.plugins.tab`). These are read through `ctx.get(...)` and are
typed structurally rather than imported, so a rename on the Host side surfaces
as a runtime failure rather than a build error.

If you touch one of them, verify against a real running Host, not only unit
tests. The `README` records which DSH version was actually verified, and that
line should move with the change.

## Reporting bugs

Include the DSH version (`dsh --version`), what you did, what you expected, and
any Host log lines beginning with `[lark-session-monitor]`. Never paste your App
Secret or a user token.

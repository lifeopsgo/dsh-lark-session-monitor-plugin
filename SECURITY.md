# Security Policy

## Reporting a vulnerability

Please report security issues **privately**, through GitHub's
[Security Advisories](https://github.com/lifeopsgo/dsh-lark-session-monitor-plugin/security/advisories/new)
rather than a public issue.

Include what you can: the DSH version, the plugin version, a description of the
impact, and steps to reproduce. Never include your Feishu App Secret or a user
token — a report does not need them.

## Handling of credentials

This plugin holds two secrets, and both stay on the Host:

| Secret | Where it lives | Notes |
| --- | --- | --- |
| Feishu **App Secret** | `$DSH_HOME/plugin-data/dsh-lark-session-monitor-plugin/settings.json` | Written atomically with `0600`. Never returned over RPC — the settings response carries only a `hasSecret` boolean. |
| Feishu **user access token** and its refresh token | DSH's `credentials` service | Read and rotated through `modifyRecord`, which serializes the read-modify-write so concurrent refreshes cannot lose a rotation. |

The browser half never receives either value. If you find a path where one
crosses to the client, that is a security bug — report it.

## What the plugin can reach

- **Reads:** the Feishu conversations you configure, via the user token you
  authorized, plus the Host's own workspace and session inventory.
- **Writes:** the settings file above, the credentials record above, and
  prompts into the DSH session you selected.
- **Network:** only `open.feishu.cn` / `open.larksuite.com` and the accounts
  hosts used for authorization. There is no telemetry and no other egress.

## Endpoint exposure

The settings endpoint is registered on DSH's `/api` carrier, so DSH's browser
authentication and Host/Origin trust checks run before any handler. Set
`rpcAuthority: loopback` in the plugin config to additionally require a loopback
`Host` and `Origin`.

## Trusting a git install

Installing from git executes code from the repository at install time **only if**
the package declares a `prepare` script the user allowlists. This package ships
its built `lib/` and declares no `prepare`, so a `github:` install runs no
package code during installation beyond normal dependency resolution. Pin a
commit or tag (`#v1.4.0`) so a later push cannot change what you install.

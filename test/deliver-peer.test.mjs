/**
 * Regression tests for the delivery Peer.
 *
 * The Host gateway reads `peer.signal` before it touches the method, so a
 * gateway call that omits the Peer dies with "Cannot read properties of
 * undefined (reading 'signal')". That is exactly what every delivery used to
 * do: reads worked (they take a different path), and the first message of each
 * batch failed to deliver — the failure surfaced only as the monitor's
 * lastError, so the poll path looked healthy while nothing arrived.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { HarnessGateway } from '../src/deliver.mjs';

/** A gateway double that records calls and can enforce the Host's Peer check. */
function fakeGateway({ requirePeer = true } = {}) {
  const calls = [];
  const enforce = (request) => {
    if (!requirePeer) return;
    // Reproduce the Host's own check: it dereferences `peer.signal` first.
    if (request.peer === undefined) {
      throw new TypeError("Cannot read properties of undefined (reading 'signal')");
    }
  };
  return {
    calls,
    async invoke(request) {
      calls.push({ kind: 'invoke', ...request });
      enforce(request);
      return { ok: true, value: { sessionId: 'session-1' } };
    },
    async stream(request) {
      calls.push({ kind: 'stream', ...request });
      enforce(request);
      // `#streamFirst` reads one frame and closes the iterator, so the double
      // answers with the baseline frame a real `workspace.follow` opens with.
      return (async function* baseline() {
        yield { type: 'baseline', value: { items: [{ workspaceId: 'ws-1', path: '/tmp/ws' }] } };
      })();
    },
  };
}

const peer = { id: 'peer-1', signal: new AbortController().signal };

test('every gateway call carries the Peer the call speaks for', async () => {
  const gateway = fakeGateway();
  const harness = new HarnessGateway({ gateway, peer });

  await harness.createSession({ workspaceId: 'ws-1' });
  await harness.prompt({ sessionId: 'session-1', text: 'hello' });

  assert.equal(gateway.calls.length, 2);
  for (const call of gateway.calls) assert.equal(call.peer, peer);
});

test('a batch delivery no longer dies on the Host Peer check', async () => {
  const gateway = fakeGateway({ requirePeer: true });
  const harness = new HarnessGateway({ gateway, peer });

  // This is the call that used to throw: the Host reads peer.signal first.
  await assert.doesNotReject(() => harness.prompt({ sessionId: 'session-1', text: 'hello' }));
});

test('without a Peer the Host check fails, which is why the Peer is required', async () => {
  const gateway = fakeGateway({ requirePeer: true });
  const harness = new HarnessGateway({ gateway });

  // Documents the failure this class produced before the Peer was threaded
  // through. A gateway that demands a Peer cannot be called without one.
  await assert.rejects(
    () => harness.prompt({ sessionId: 'session-1', text: 'hello' }),
    /reading 'signal'/,
  );
});

test('the streaming read also carries the Peer', async () => {
  const gateway = fakeGateway({ requirePeer: true });
  const harness = new HarnessGateway({ gateway, peer });

  await assert.doesNotReject(() => harness.listWorkspaces());
  const call = gateway.calls.find((entry) => entry.kind === 'stream');
  assert.equal(call.peer, peer);
});

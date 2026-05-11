/**
 * ADR-095 G2 — ByzantineConsensus + ConsensusTransport wiring.
 *
 * Verifies that when a transport is injected:
 *   - outbound PBFT messages actually go over the transport (not just emitted)
 *   - inbound transport messages are routed into the PBFT handlers
 *   - the legacy emit-only behavior is preserved when no transport is given
 */
import { describe, it, expect } from 'vitest';
import { ByzantineConsensus } from '../src/consensus/byzantine.js';
import {
  LocalTransport,
  LocalTransportRegistry,
  type ConsensusMessage,
} from '../src/consensus/transport.js';

describe('ADR-095 G2 — ByzantineConsensus transport wiring', () => {
  it('without a transport, broadcasts are emit-only (legacy path unchanged)', async () => {
    const bft = new ByzantineConsensus('n1');
    bft.addNode('n2', false);
    bft.addNode('n3', false);
    const broadcasts: unknown[] = [];
    bft.on('message.broadcast', (e) => broadcasts.push(e));
    bft.electPrimary(); // makes n1 primary at view 0 (n1 is index 0)
    // proposing as primary triggers a pre-prepare broadcast
    await bft.propose({ value: 42 });
    expect(broadcasts.length).toBeGreaterThan(0);
    await bft.shutdown();
  });

  it('with a transport, broadcasts go over the transport AND emit', async () => {
    const reg = new LocalTransportRegistry();
    const t1 = new LocalTransport('n1', { registry: reg });
    // A peer that records what it receives.
    const t2 = new LocalTransport('n2', { registry: reg });
    const received: ConsensusMessage[] = [];
    t2.onMessage((m) => { received.push(m); });

    const bft = new ByzantineConsensus('n1', { transport: t1 });
    bft.addNode('n2', false);
    const emitted: unknown[] = [];
    bft.on('message.broadcast', (e) => emitted.push(e));
    bft.electPrimary();
    await bft.propose({ value: 7 });

    // Emit still happened (observability)…
    expect(emitted.length).toBeGreaterThan(0);
    // …and the message actually reached the peer over the transport.
    expect(received.length).toBeGreaterThan(0);
    const pre = received.find(m => m.type === 'pre-prepare');
    expect(pre).toBeDefined();
    expect(pre!.from).toBe('n1');
    const payload = pre!.payload as Record<string, unknown>;
    expect(typeof payload.digest).toBe('string');
    expect((payload.digest as string).length).toBe(64); // sha256 hex

    await bft.shutdown(); await t1.close(); await t2.close();
  });

  it('inbound transport messages are routed into PBFT handlers', async () => {
    const reg = new LocalTransportRegistry();
    const tPrimary = new LocalTransport('primary', { registry: reg });
    const tReplica = new LocalTransport('replica', { registry: reg });

    const replica = new ByzantineConsensus('replica', { transport: tReplica });
    replica.addNode('primary', true);
    replica.electPrimary(); // view 0, nodeIds=[replica, primary] → primary index 0 is 'replica'...
    // electPrimary picks index = viewNumber % nodeIds.length where nodeIds = [self, ...others].
    // For 'replica' self, nodeIds = ['replica', 'primary'], index 0 → 'replica' is primary.
    // That's not what we want for this test; manually mark primary correctly:
    // (the protocol's primary election is order-dependent; for the inbound-routing
    //  assertion we only care that handlePrePrepare gets invoked, not who's primary.)

    // Track that handlePrePrepare ran by observing the resulting prepare broadcast.
    const prepareBroadcasts: ConsensusMessage[] = [];
    // Use a third transport node to capture what the replica broadcasts.
    const tWatcher = new LocalTransport('watcher', { registry: reg });
    tWatcher.onMessage((m) => { if (m.type === 'prepare') prepareBroadcasts.push(m); });
    // The replica needs a node to broadcast to:
    replica.addNode('watcher', false);

    // Simulate the primary sending a pre-prepare to the replica.
    await tPrimary.send('replica', {
      type: 'pre-prepare',
      payload: {
        type: 'pre-prepare',
        viewNumber: 0,
        sequenceNumber: 1,
        digest: 'a'.repeat(64),
        timestamp: new Date().toISOString(),
        payload: { value: 'x' },
      },
      viewNumber: 0,
    });

    // handlePrePrepare → broadcastMessage(prepareMsg) over the transport.
    expect(prepareBroadcasts.length).toBeGreaterThan(0);
    expect(prepareBroadcasts[0].type).toBe('prepare');

    await replica.shutdown();
    await tPrimary.close(); await tReplica.close(); await tWatcher.close();
  });
});

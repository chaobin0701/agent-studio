import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryMessageBus } from '../dist/message-bus/in-memory-message-bus.js';

const event = (type = 'run.started') => ({
  eventId: 'event-1', channel: 'browser', conversationId: 'conversation-1', messageId: 'message-1',
  runId: 'run-1', occurredAt: new Date().toISOString(), visibility: 'public', type,
});

test('message bus preserves order and supports unsubscribe', async () => {
  const bus = new InMemoryMessageBus();
  const seen = [];
  const remove = bus.subscribe('run.started', async (value) => { seen.push(`first:${value.runId}`); });
  bus.subscribe('run.started', (value) => { seen.push(`second:${value.runId}`); });
  await bus.publish(event());
  assert.deepEqual(seen, ['first:run-1', 'second:run-1']);
  remove();
  await bus.publish({ ...event(), eventId: 'event-2' });
  assert.deepEqual(seen, ['first:run-1', 'second:run-1', 'second:run-1']);
});

test('message bus isolates subscriber failures', async () => {
  const bus = new InMemoryMessageBus();
  let called = false;
  bus.subscribe('run.started', () => { throw new Error('subscriber failure'); });
  bus.subscribe('run.started', () => { called = true; });
  await bus.publish(event());
  assert.equal(called, true);
});

test('publishEvent does not reject when a subscriber fails', async () => {
  const bus = new InMemoryMessageBus();
  bus.subscribe('run.started', async () => { throw new Error('subscriber failure'); });
  bus.publishEvent(event());
  await new Promise((resolve) => setImmediate(resolve));
});

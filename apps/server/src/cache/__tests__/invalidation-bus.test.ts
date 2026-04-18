/**
 * Unit tests for the InvalidationBus.
 *
 * Exercises the publish → stream → recent() fan-out plus the hour-window
 * ring buffer.
 */

import { describe, test, expect } from 'bun:test';
import { Effect, Fiber, Stream } from 'effect';
import { InvalidationBus, InvalidationBusLive } from '../InvalidationBus';

describe('InvalidationBus', () => {
	test('publish delivers to stream subscriber', async () => {
		const program = Effect.gen(function* () {
			const bus = yield* InvalidationBus;
			// Fork the subscriber; give it a moment to actually register with the
			// underlying PubSub before we publish. Without a small sleep the
			// publish races the subscription and subscribers miss the event.
			const collectFiber = yield* Effect.fork(
				bus.stream().pipe(Stream.take(1), Stream.runCollect),
			);
			yield* Effect.sleep('50 millis');
			yield* bus.publish({ kind: 'repos:updated' });
			const chunk = yield* Fiber.join(collectFiber);
			return [...chunk];
		});

		const events = await Effect.runPromise(
			Effect.scoped(Effect.provide(program, InvalidationBusLive)),
		);
		expect(events).toHaveLength(1);
		expect(events[0]!.kind).toBe('repos:updated');
	});

	test('recent() returns published events', async () => {
		const program = Effect.gen(function* () {
			const bus = yield* InvalidationBus;
			yield* bus.publish({ kind: 'pr:closed', prId: 'pr-1' });
			yield* bus.publish({ kind: 'repo:added', repoId: 'repo-1' });
			return yield* bus.recent();
		});

		const recent = await Effect.runPromise(
			Effect.scoped(Effect.provide(program, InvalidationBusLive)),
		);
		expect(recent.map((e) => e.kind)).toEqual(['pr:closed', 'repo:added']);
		// Every entry carries an ISO-8601 timestamp.
		for (const entry of recent) {
			expect(Number.isNaN(Date.parse(entry.at))).toBe(false);
		}
	});

	test('multiple consumers each see every event', async () => {
		const program = Effect.gen(function* () {
			const bus = yield* InvalidationBus;
			const a = yield* Effect.fork(
				bus.stream().pipe(Stream.take(2), Stream.runCollect),
			);
			const b = yield* Effect.fork(
				bus.stream().pipe(Stream.take(2), Stream.runCollect),
			);
			yield* Effect.sleep('50 millis');
			yield* bus.publish({ kind: 'repos:updated' });
			yield* bus.publish({ kind: 'pr:closed', prId: 'x' });
			const aOut = yield* Fiber.join(a);
			const bOut = yield* Fiber.join(b);
			return { a: [...aOut], b: [...bOut] };
		});

		const result = await Effect.runPromise(
			Effect.scoped(Effect.provide(program, InvalidationBusLive)),
		);
		expect(result.a.map((e) => e.kind)).toEqual(['repos:updated', 'pr:closed']);
		expect(result.b.map((e) => e.kind)).toEqual(['repos:updated', 'pr:closed']);
	});
});

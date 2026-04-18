/**
 * Unit tests for freshness policies.
 *
 * Each policy is deterministic given (row, now, write-meta), so these tests
 * exercise the decision tables directly — no DB, no Effect runtime.
 */

import { describe, test, expect } from 'bun:test';
import {
	EtagPolicy,
	HighWaterMarkPolicy,
	ImmutablePolicy,
	QueryHashPolicy,
	ShaKeyedPolicy,
	TtlPolicy,
} from '../policies/index';
import type { CacheRow } from '../types';

const baseRow = (overrides: Partial<CacheRow> = {}): CacheRow => ({
	ns: 'test',
	key: 'k',
	valueJson: '{}',
	etag: null,
	lastModified: null,
	tagJson: null,
	fetchedAt: new Date(1_000).toISOString(),
	expiresAt: null,
	approxBytes: 2,
	...overrides,
});

describe('TtlPolicy', () => {
	test('fresh before expiry', () => {
		const p = new TtlPolicy(5_000);
		const row = baseRow({ expiresAt: new Date(10_000).toISOString() });
		expect(p.decideRead(row, 7_000)).toBe('fresh');
	});

	test('stale after expiry by default', () => {
		const p = new TtlPolicy(5_000);
		const row = baseRow({ expiresAt: new Date(10_000).toISOString() });
		expect(p.decideRead(row, 20_000)).toBe('stale');
	});

	test('drop on expiry when opt-in', () => {
		const p = new TtlPolicy(5_000, { dropOnExpiry: true });
		const row = baseRow({ expiresAt: new Date(10_000).toISOString() });
		expect(p.decideRead(row, 20_000)).toBe('drop');
	});

	test('write persists with expiry', () => {
		const p = new TtlPolicy(5_000);
		const decision = p.decideWrite({ kind: 'fresh', value: { x: 1 } }, null, 1_000);
		expect(decision.kind).toBe('persist');
		if (decision.kind !== 'persist') throw new Error('expected persist');
		expect(decision.expiresAt).toBe(new Date(6_000).toISOString());
		expect(JSON.parse(decision.valueJson)).toEqual({ x: 1 });
	});

	test('touch on unchanged refreshes expiry', () => {
		const p = new TtlPolicy(5_000);
		const decision = p.decideWrite({ kind: 'unchanged' }, baseRow(), 10_000);
		expect(decision.kind).toBe('touch');
		if (decision.kind !== 'touch') throw new Error('expected touch');
		expect(decision.expiresAt).toBe(new Date(15_000).toISOString());
	});

	test('drop on invalid upstream', () => {
		const p = new TtlPolicy(5_000);
		const decision = p.decideWrite({ kind: 'invalid' }, baseRow(), 10_000);
		expect(decision.kind).toBe('drop');
	});
});

describe('ImmutablePolicy', () => {
	test('always fresh on read', () => {
		const p = new ImmutablePolicy();
		expect(p.decideRead(baseRow(), 10_000_000)).toBe('fresh');
	});

	test('persists with no expiry', () => {
		const p = new ImmutablePolicy();
		const decision = p.decideWrite({ kind: 'fresh', value: 'contents' }, null, 1_000);
		expect(decision.kind).toBe('persist');
		if (decision.kind !== 'persist') throw new Error('expected persist');
		expect(decision.expiresAt).toBeNull();
	});
});

describe('ShaKeyedPolicy', () => {
	test('drop when no tag on row', () => {
		const p = new ShaKeyedPolicy(() => ({ headSha: 'abc' }));
		expect(p.decideRead(baseRow(), 1_000)).toBe('drop');
	});

	test('fresh when SHA matches', () => {
		const p = new ShaKeyedPolicy(() => ({ headSha: 'abc' }));
		const row = baseRow({ tagJson: JSON.stringify({ headSha: 'abc' }) });
		expect(p.decideRead(row, 1_000)).toBe('fresh');
	});

	test('drop when SHA differs', () => {
		const p = new ShaKeyedPolicy(() => ({ headSha: 'new' }));
		const row = baseRow({ tagJson: JSON.stringify({ headSha: 'old' }) });
		expect(p.decideRead(row, 1_000)).toBe('drop');
	});

	test('stores SHA tag on persist', () => {
		const p = new ShaKeyedPolicy();
		const decision = p.decideWrite(
			{
				kind: 'fresh',
				value: [{ path: 'a' }],
				meta: { tag: { headSha: 'abc', baseSha: 'def' } },
			},
			null,
			1_000,
		);
		expect(decision.kind).toBe('persist');
		if (decision.kind !== 'persist') throw new Error('expected persist');
		expect(JSON.parse(decision.tagJson!)).toEqual({ headSha: 'abc', baseSha: 'def' });
	});
});

describe('EtagPolicy', () => {
	test('fresh within revalidation window', () => {
		const p = new EtagPolicy(60_000);
		const row = baseRow({
			fetchedAt: new Date(10_000).toISOString(),
			etag: '"abc"',
		});
		expect(p.decideRead(row, 30_000)).toBe('fresh');
	});

	test('stale after revalidation window', () => {
		const p = new EtagPolicy(60_000);
		const row = baseRow({
			fetchedAt: new Date(10_000).toISOString(),
			etag: '"abc"',
		});
		expect(p.decideRead(row, 200_000)).toBe('stale');
	});

	test('always stale when revalidateEveryMs=0', () => {
		const p = new EtagPolicy(0);
		expect(p.decideRead(baseRow(), 0)).toBe('stale');
	});

	test('persists etag metadata', () => {
		const p = new EtagPolicy(60_000);
		const decision = p.decideWrite(
			{ kind: 'fresh', value: { a: 1 }, meta: { etag: '"x"', lastModified: 'now' } },
			null,
			1_000,
		);
		expect(decision.kind).toBe('persist');
		if (decision.kind !== 'persist') throw new Error('expected persist');
		expect(decision.etag).toBe('"x"');
		expect(decision.lastModified).toBe('now');
	});
});

describe('HighWaterMarkPolicy', () => {
	test('fresh when watermark tag exists', () => {
		const p = new HighWaterMarkPolicy();
		const row = baseRow({ tagJson: JSON.stringify({ watermark: '2024-01-01' }) });
		expect(p.decideRead(row, 0)).toBe('fresh');
	});

	test('drop when no tag', () => {
		const p = new HighWaterMarkPolicy();
		expect(p.decideRead(baseRow(), 0)).toBe('drop');
	});
});

describe('QueryHashPolicy', () => {
	test('drop on hash mismatch', () => {
		const p = new QueryHashPolicy(30_000, () => 'expected');
		const row = baseRow({
			tagJson: JSON.stringify({ queryHash: 'actual' }),
			fetchedAt: new Date(1_000).toISOString(),
		});
		expect(p.decideRead(row, 2_000)).toBe('drop');
	});

	test('stale after TTL even with matching hash', () => {
		const p = new QueryHashPolicy(5_000, () => 'same');
		const row = baseRow({
			tagJson: JSON.stringify({ queryHash: 'same' }),
			fetchedAt: new Date(1_000).toISOString(),
		});
		expect(p.decideRead(row, 20_000)).toBe('stale');
	});
});

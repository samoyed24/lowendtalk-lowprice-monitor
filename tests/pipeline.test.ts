import { describe, expect, it, vi } from "vitest";
import {
	dueSinceLastRun,
	merge,
	normalizePrices,
	parsePosts,
	runPipeline,
	type FeedData,
	type MonitorConfig,
	type PipelineState,
	type RunHandlers,
} from "../src/monitor";

function cfg(over: Partial<MonitorConfig> = {}): MonitorConfig {
	return {
		feedUrl: "https://example.invalid/feed",
		feedProxy: "{url}",
		lookbackDays: 7,
		maxPosts: 60,
		classifyBatchSize: 10,
		requireServerTag: true,
		intervalMinutes: 240,
		aiModel: "m",
		pcUrl: "https://notify.portcloud.online",
		pcKey: "k",
		pcTo: "to@example.com",
		pcTimeout: 60,
		...over,
	};
}

const quiet = { log: () => {} };

describe("dueSinceLastRun", () => {
	it("force/dry-run/无 lastRun/坏时间都放行", () => {
		const c = cfg();
		expect(dueSinceLastRun({ sent: [] }, c, { force: true }).due).toBe(true);
		expect(dueSinceLastRun({ sent: [] }, c, { dryRun: true }).due).toBe(true);
		expect(dueSinceLastRun({ sent: [] }, c).due).toBe(true);
		expect(dueSinceLastRun({ sent: [], lastRun: "not-a-date" }, c).due).toBe(true);
	});

	it("间隔内跳过，间隔到放行", () => {
		const c = cfg({ intervalMinutes: 240 });
		const now = Date.now();
		const recent: PipelineState = { sent: [], lastRun: new Date(now - 60 * 60 * 1000).toISOString() };
		expect(dueSinceLastRun(recent, c, { nowMs: now }).due).toBe(false);
		const old: PipelineState = { sent: [], lastRun: new Date(now - 5 * 3600 * 1000).toISOString() };
		expect(dueSinceLastRun(old, c, { nowMs: now }).due).toBe(true);
	});
});

describe("parsePosts", () => {
	const feed: FeedData = {
		items: [
			{
				url: "https://example.invalid/1",
				title: "Cheap VPS $5/mo",
				content_text: "Cheap VPS $5/mo hello world this is a longer body text here",
				author: { name: "alice" },
				date_published: new Date().toISOString(),
			},
			{ url: "https://example.invalid/2", title: "old", content_text: "x", date_published: "2000-01-01T00:00:00Z" },
			{ title: "no url", content_text: "x" },
		],
	};

	it("过滤过期与无 URL，按日期倒序", () => {
		const posts = parsePosts(feed, cfg(), Date.now());
		expect(posts.map((p) => p.postUrl)).toEqual(["https://example.invalid/1"]);
		expect(posts[0]?.author).toBe("alice");
	});
	it("解码实体并剥离标题重复开头", () => {
		const got = parsePosts(
			{ items: [{ url: "u", title: "[Foo] Bar Baz Qux Quux", content_text: "Foo - Bar Baz Qux Quux and then R&amp;D deals with a longer tail here indeed" }] },
			cfg(),
		);
		expect(got[0]?.body.startsWith("Foo")).toBe(false);
		expect(got[0]?.body).toContain("R&D");
	});
});

describe("normalizePrices + merge", () => {
	it("丢弃非法金额、按金额排序、最多 5 条", () => {
		expect(
			normalizePrices([
				{ amount: 0, currency: "USD", period: "month" },
				{ amount: -1, currency: "USD", period: "month" },
				{ amount: "x", currency: "USD", period: "month" },
				{ amount: 5, currency: "usd", period: "MONTH" },
				{ amount: 3, currency: null, period: null },
			]).map((p) => p.amount),
		).toEqual([3, 5]);
	});

	it("无服务器类型标签时过滤，按最低月均价排序", () => {
		const posts = [
			{ title: "a", postUrl: "a", author: "", date: "", body: "" },
			{ title: "b", postUrl: "b", author: "", date: "", body: "" },
		];
		const items = merge(
			[
				{ i: 0, tags: ["vps"], prices: [{ amount: 12, currency: "USD", period: "year" }], zh: "a" },
				{ i: 1, tags: ["vps"], prices: [{ amount: 5, currency: "USD", period: "month" }], zh: "b" },
				{ i: 0, tags: ["高防"], prices: [], zh: "no-type" },
				{ i: 9, tags: ["vps"], prices: [], zh: "bad-idx" },
			],
			posts,
			true,
		);
		expect(items.map((x) => x.zh)).toEqual(["a", "b"]);
	});
});

describe("runPipeline 状态守卫", () => {
	function handlers(over: Partial<RunHandlers> = {}): RunHandlers & { saved: PipelineState[]; sent: number } {
		const saved: PipelineState[] = [];
		let sent = 0;
		return {
			saved,
			get sent() {
				return sent;
			},
			loadState: async () => ({ sent: [] }),
			saveState: async (s) => {
				saved.push(s);
			},
			aiChat: async () => '[{"i":0,"tags":["vps"],"prices":[],"zh":"z"}]',
			send: async () => {
				sent++;
			},
			...over,
		};
	}

	const feedFetch = (posts: { postUrl: string }[]) => ({
		fetchImpl: (async () =>
			new Response(
				JSON.stringify({
					items: posts.map((p) => ({ url: p.postUrl, title: "t", content_text: "body body body" })),
				}),
				{ status: 200 },
			)) as typeof fetch,
		...quiet,
	});

	it("投递成功才保存状态", async () => {
		const h = handlers();
		const r = await runPipeline(cfg({ intervalMinutes: 0 }), {}, h, feedFetch([{ postUrl: "u1" }]));
		expect(r.emailed).toBe(true);
		expect(h.saved).toHaveLength(1);
		expect(h.saved[0]?.sent).toContain("u1");
		expect(h.saved[0]?.lastRun).toBeTruthy();
	});

	it("投递失败不保存状态", async () => {
		const h = handlers({ send: async () => { throw new Error("Portcloud 投递failed"); } });
		await expect(runPipeline(cfg({ intervalMinutes: 0 }), {}, h, feedFetch([{ postUrl: "u1" }]))).rejects.toThrow(
			/投递failed/,
		);
		expect(h.saved).toHaveLength(0);
	});

	it("无新增不发信不保存", async () => {
		const h = handlers({ loadState: async () => ({ sent: ["u1"] }) });
		const r = await runPipeline(cfg({ intervalMinutes: 0 }), {}, h, feedFetch([{ postUrl: "u1" }]));
		expect(r.emailed).toBe(false);
		expect(h.sent).toBe(0);
		expect(h.saved).toHaveLength(0);
	});

	it("dry-run 不发信不保存", async () => {
		const h = handlers();
		const r = await runPipeline(cfg({ intervalMinutes: 0 }), { dryRun: true }, h, feedFetch([{ postUrl: "u1" }]));
		expect(r.emailed).toBe(false);
		expect(h.sent).toBe(0);
		expect(h.saved).toHaveLength(0);
	});

	it("缺 PC_KEY 直接报错", async () => {
		const h = handlers();
		await expect(runPipeline(cfg({ pcKey: "" }), {}, h, quiet)).rejects.toThrow(/PC_KEY/);
	});
});

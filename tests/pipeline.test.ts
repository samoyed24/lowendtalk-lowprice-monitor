import { describe, expect, it, vi } from "vitest";
import {
	dueSinceLastRun,
	merge,
	normalizePrices,
	parsePosts,
	parseRssItems,
	runPipeline,
	type FeedData,
	type MonitorConfig,
	type PipelineState,
	type RunHandlers,
} from "../src/monitor";

function cfg(over: Partial<MonitorConfig> = {}): MonitorConfig {
	return {
		feedUrl: "https://example.invalid/feed",
		lookbackDays: 7,
		maxPosts: 60,
		classifyBatchSize: 10,
		requireServerTag: true,
		intervalMinutes: 240,
		aiModel: "m",
		notifyUrl: "https://notify.portcloud.online",
		notifyKey: "k",
		notifyTo: "to@example.com",
		notifyTimeout: 60,
		smtpHost: "",
		smtpPort: 465,
		smtpUser: "",
		smtpPass: "",
		smtpTo: "",
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

	it("整点 cron + 60 分钟间隔：每次触发都应放行（不被上一次耗时挤掉）", () => {
		const c = cfg({ intervalMinutes: 60 });
		const base = Date.parse("2026-10-10T00:00:00Z");
		// lastRun 记的是「定时触发时刻」，因此每个整点都恰好满 60 分钟。
		for (let hour = 0; hour < 6; hour++) {
			const state: PipelineState = { sent: [], lastRun: new Date(base + hour * 3600_000).toISOString() };
			const due = dueSinceLastRun(state, c, { nowMs: base + (hour + 1) * 3600_000 });
			expect(due.due).toBe(true);
		}
	});

	it("cron 派发抖动（实测 scheduledTime 偏离整点几十秒）不应导致隔次运行", () => {
		const c = cfg({ intervalMinutes: 60 });
		const base = Date.parse("2026-10-10T00:00:00Z");
		// 实测：17:17 的 cron 实际在 17:17:55 派发，即比整点晚 55 秒。
		// 这种抖动下两次触发的间隔会在 3600s 上下摆动，必须每次都放行。
		const offsets = [55_000, 0, 12_000, 48_000, 3_000, 30_000];
		let prev = null;
		for (let i = 0; i < offsets.length; i++) {
			const fire = base + i * 3600_000 + (offsets[i] ?? 0);
			const state: PipelineState = prev === null ? { sent: [] } : { sent: [], lastRun: prev };
			const due = dueSinceLastRun(state, c, { nowMs: fire });
			expect(due.due).toBe(true);
			prev = new Date(fire).toISOString();
		}
	});

	it("容差不影响「未到间隔」的判断", () => {
		const c = cfg({ intervalMinutes: 30 });
		const now = Date.parse("2026-10-10T12:00:00Z");
		// 30 分钟间隔 + 5 分钟容差 → 实际阈值 25 分钟。
		// 24 分钟仍跳过
		const tooSoon: PipelineState = { sent: [], lastRun: new Date(now - 24 * 60_000).toISOString() };
		expect(dueSinceLastRun(tooSoon, c, { nowMs: now }).due).toBe(false);
		// 26 分钟已过阈值，放行
		const atTolerance: PipelineState = { sent: [], lastRun: new Date(now - 26 * 60_000).toISOString() };
		expect(dueSinceLastRun(atTolerance, c, { nowMs: now }).due).toBe(true);
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

describe("parseRssItems（直连 RSS）", () => {
	const xml = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>Offers — LowEndTalk</title>
    <item>
      <title>[UK] Intel &amp; AMD &lt;deal&gt;</title>
      <link>https://lowendtalk.com/discussion/1/uk-intel</link>
      <pubDate>Fri, 09 Oct 2026 14:24:18 +0000</pubDate>
      <dc:creator>alice</dc:creator>
      <guid isPermaLink="false">1@/discussions</guid>
      <description><![CDATA[<h1>[UK] Intel</h1>
<p>2 vCore - $6.03 per month</p>
<p>Order: <a href="https://x.invalid/a?b=1&amp;c=2">link</a></p>]]></description>
    </item>
    <item>
      <title>No link item</title>
      <description>skipped</description>
    </item>
    <item>
      <title>Second</title>
      <link>https://lowendtalk.com/discussion/2/second</link>
      <pubDate>Sat, 10 Oct 2026 15:43:53 +0000</pubDate>
      <content:encoded><![CDATA[<p>encoded wins</p>]]></content:encoded>
      <description><![CDATA[<p>plain description</p>]]></description>
    </item>
  </channel>
</rss>`;

	it("解析标题/链接/作者/时间/正文，跳过无 link 的 item", () => {
		const items = parseRssItems(xml);
		expect(items).toHaveLength(2);
		const first = items[0];
		expect(first?.url).toBe("https://lowendtalk.com/discussion/1/uk-intel");
		expect(first?.title).toBe("[UK] Intel & AMD <deal>");
		expect(first?.author?.name).toBe("alice");
		expect(first?.date_published).toBe("2026-10-09T14:24:18.000Z");
		expect(first?.content_html).toContain("$6.03 per month");
		// CDATA 内层实体在交给 parsePosts 前不解码，避免二次解码；由 decodeEntities 统一处理。
		expect(first?.content_html).toContain("b=1&amp;c=2");
	});

	it("content:encoded 优先于 description", () => {
		expect(parseRssItems(xml)[1]?.content_html).toContain("encoded wins");
	});

	it("解析结果能直接喂给 parsePosts，保留价格与正文", () => {
		const now = Date.parse("2026-10-10T16:00:00Z");
		const posts = parsePosts({ items: parseRssItems(xml) }, cfg(), now);
		expect(posts.map((p) => p.postUrl)).toEqual([
			"https://lowendtalk.com/discussion/2/second",
			"https://lowendtalk.com/discussion/1/uk-intel",
		]);
		expect(posts[1]?.author).toBe("alice");
		expect(posts[1]?.body).toContain("$6.03 per month");
		expect(posts[1]?.body).not.toContain("<p>");
	});

	it("没有 item 时返回空数组", () => {
		expect(parseRssItems("<rss><channel></channel></rss>")).toEqual([]);
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
				`<?xml version="1.0" encoding="utf-8"?><rss version="2.0"><channel>` +
					posts
						.map(
							(p) =>
								`<item><title>t</title><link>${p.postUrl}</link>` +
								`<pubDate>${new Date().toUTCString()}</pubDate>` +
								`<description><![CDATA[<p>body body body</p>]]></description></item>`,
						)
						.join("") +
					`</channel></rss>`,
				{ status: 200, headers: { "Content-Type": "application/rss+xml" } },
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

	it("lastRun 记定时触发时刻，而不是完成时刻", async () => {
		const h = handlers();
		const scheduledAt = Date.parse("2026-10-10T00:00:00Z");
		// nowMs 比触发时刻晚 40 秒，模拟一次运行的实际耗时。
		await runPipeline(
			cfg({ intervalMinutes: 60 }),
			{ scheduledAt },
			h,
			{ ...feedFetch([{ postUrl: "u1" }]), nowMs: () => scheduledAt + 40_000 },
		);
		expect(h.saved[0]?.lastRun).toBe(new Date(scheduledAt).toISOString());
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

	it("无任何通道直接报错", async () => {
		const h = handlers();
		await expect(
			runPipeline(cfg({ notifyKey: "", smtpUser: "" }), {}, h, quiet),
		).rejects.toThrow(/发信通道/);
	});
});

describe("sendMail 双通道", () => {
	function notifyFetch(order: string[]) {
		return (async (url: string) => {
			if (String(url).endsWith("/api/v1/send")) {
				order.push("notify");
				return new Response(JSON.stringify({ log_id: 1 }), { status: 201 });
			}
			return new Response(
				JSON.stringify({ log_id: 1, status: "success", failure_reason: null }),
				{ status: 200 },
			);
		}) as typeof fetch;
	}

	function tickClock() {
		let t = 0;
		return () => (t += 2000);
	}

	it("只配 AgentNotify 则只走 AgentNotify", async () => {
		const { sendMail } = await import("../src/monitor");
		const order: string[] = [];
		await sendMail("s", "h", "t", cfg(), {
			fetchImpl: notifyFetch(order),
			sleep: async () => {},
			nowMs: tickClock(),
			log: () => {},
		});
		expect(order).toEqual(["notify"]);
	});

	it("两个都配则同时发送", async () => {
		const { sendMail } = await import("../src/monitor");
		const order: string[] = [];
		const c = cfg({
			smtpHost: "smtp.example.com",
			smtpUser: "me@example.com",
			smtpPass: "p",
			smtpTo: "to@example.com",
		});
		await sendMail("s", "h", "t", c, {
			fetchImpl: notifyFetch(order),
			sleep: async () => {},
			nowMs: tickClock(),
			log: () => {},
			smtpDialer: {
				dial: async () => {
					order.push("smtp");
					const script = [
						{ code: 220, text: "ready" },
						{ code: 250, text: "hello\nAUTH LOGIN" },
						{ code: 334, text: "Username:" },
						{ code: 334, text: "Password:" },
						{ code: 235, text: "ok" },
						{ code: 250, text: "ok" },
						{ code: 250, text: "ok" },
						{ code: 354, text: "go" },
						{ code: 250, text: "queued" },
						{ code: 221, text: "bye" },
					];
					return {
						readResponse: async () => {
							const next = script.shift();
							if (!next) throw new Error("smtp script exhausted");
							return next;
						},
						writeLine: async () => {},
						writeData: async () => {},
						upgradeTls: async () => {},
						close: async () => {},
					};
				},
			},
		});
		expect(order).toEqual(["notify", "smtp"]);
	});
});

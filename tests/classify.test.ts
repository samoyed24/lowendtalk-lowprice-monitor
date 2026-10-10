import { describe, expect, it, vi } from "vitest";
import {
	classify,
	firstJsonArray,
	type FeedPost,
	type MonitorConfig,
} from "../src/monitor";

const ARRAY =
	'[{"i":0,"tags":["vps"],"prices":[{"amount":3,"currency":"USD","period":"month"}],"zh":"x"}]';
const PARSED = [{ i: 0, tags: ["vps"], prices: [{ amount: 3, currency: "USD", period: "month" }], zh: "x" }];

function cfg(): MonitorConfig {
	return {
		feedUrl: "https://example.invalid/feed",
		lookbackDays: 7,
		maxPosts: 60,
		classifyBatchSize: 10,
		requireServerTag: true,
		intervalMinutes: 240,
		aiModel: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
		notifyUrl: "https://notify.portcloud.online",
		notifyKey: "k",
		notifyTo: "to@example.com",
		notifyTimeout: 60,
		smtpHost: "",
		smtpPort: 465,
		smtpUser: "",
		smtpPass: "",
		smtpTo: "",
	};
}

function posts(n: number): FeedPost[] {
	return Array.from({ length: n }, (_, i) => ({
		title: `t${i}`,
		postUrl: `https://example.invalid/${i}`,
		author: "",
		date: "",
		body: `b${i}`,
	}));
}

describe("firstJsonArray", () => {
	it("bare array", () => {
		expect(firstJsonArray(ARRAY)).toEqual(PARSED);
	});

	it("extra array after: 只取第一个数组", () => {
		expect(firstJsonArray(ARRAY + "\n" + ARRAY)).toEqual(PARSED);
	});

	it("trailing note with bracket", () => {
		expect(firstJsonArray(ARRAY + "\n\n（价格档见上[]）")).toEqual(PARSED);
	});

	it("trailing empty array", () => {
		expect(firstJsonArray(ARRAY + "\n[]")).toEqual(PARSED);
	});

	it("markdown fence", () => {
		expect(firstJsonArray("```json\n" + ARRAY + "\n```")).toEqual(PARSED);
	});

	it("prose before array", () => {
		expect(firstJsonArray("好的，结果如下：\n" + ARRAY)).toEqual(PARSED);
	});

	it("bracket inside string", () => {
		const text = '[{"i":0,"tags":["a]b\\"c"],"prices":[],"zh":"x"}]';
		const got = firstJsonArray(text);
		expect(Array.isArray(got) && (got[0] as { tags: string[] }).tags).toEqual(['a]b"c']);
	});

	it("escaped backslash before quote", () => {
		const text = '[{"i":0,"tags":["a\\\\"],"prices":[],"zh":"x"}]';
		const got = firstJsonArray(text);
		expect(Array.isArray(got) && (got[0] as { tags: string[] }).tags).toEqual(["a\\"]);
	});

	it("leading brace object ignored", () => {
		expect(firstJsonArray('{"note":"x"}\n' + ARRAY)).toEqual(PARSED);
	});

	it("no array returns null", () => {
		expect(firstJsonArray("没有数组")).toBeNull();
	});

	it("unclosed array returns null", () => {
		expect(firstJsonArray('[{"i":0,')).toBeNull();
	});

	it("broken json raises", () => {
		expect(() => firstJsonArray('[{"i":0,]')).toThrow(/JSON 数组解析失败/);
	});
});

describe("classify", () => {
	it("uses llm output and batches globally indexed", async () => {
		const aiChat = vi.fn(async (_system: string, user: string) => {
			const payload = JSON.parse(user.replace(/^分析以下帖子：\n/, "")) as { i: number }[];
			return JSON.stringify(payload.map((p) => ({ i: p.i, tags: ["vps"], prices: [], zh: "z" })));
		});
		const seen: number[][] = [];
		const wrapped = async (system: string, user: string) => {
			const payload = JSON.parse(user.replace(/^分析以下帖子：\n/, "")) as { i: number }[];
			seen.push(payload.map((p) => p.i));
			return aiChat(system, user);
		};
		const c = cfg();
		c.classifyBatchSize = 10;
		const verdicts = await classify(posts(25), c, wrapped, { log: () => {} });
		expect(verdicts).toHaveLength(25);
		expect(verdicts.map((v) => v.i)).toEqual(Array.from({ length: 25 }, (_, i) => i));
		expect(seen.map((b) => b.length)).toEqual([10, 10, 5]);
	});

	it("skips malformed entries, raises when no array", async () => {
		const c = cfg();
		await expect(
			classify(posts(1), c, async () => "没有数组", { log: () => {} }),
		).rejects.toThrow(/没有 JSON 数组/);
		const verdicts = await classify(
			posts(2),
			c,
			async () => '[{"i":0,"tags":["vps"],"prices":[],"zh":"z"},{"nope":true}]',
			{ log: () => {} },
		);
		expect(verdicts.map((v) => v.i)).toEqual([0]);
	});
});

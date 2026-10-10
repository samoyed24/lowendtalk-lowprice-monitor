import { describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import {
	PortcloudUnconfirmed,
	sendViaPortcloud,
} from "../src/monitor";
import type { Deps, MonitorConfig } from "../src/monitor";
function cfg(timeout = 60): MonitorConfig {
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
		notifyTimeout: timeout,
		smtpHost: "",
		smtpPort: 465,
		smtpUser: "",
		smtpPass: "",
		smtpTo: "",
	};
}

function jsonResponse(status: number, payload: unknown): Response {
	return new Response(JSON.stringify(payload), { status });
}

function statusPayload(logId: unknown, status: string, failureReason: unknown = null): Record<string, unknown> {
	return {
		log_id: logId,
		status,
		failure_reason: failureReason,
		message_id: null,
		smtp_response: null,
		duration_ms: 1,
		created_at: "2026-10-02T00:00:00+08:00",
	};
}

interface FetchMock {
	(url: string, init?: RequestInit): Promise<Response>;
	mock: Mock;
}

interface Harness {
	fetchImpl: FetchMock;
	sleeps: number[];
	now: number;
	deps: () => Deps;
	postCalls: () => { url: string; init: RequestInit }[];
	getCalls: () => { url: string; init: RequestInit }[];
}

function harness(responses: { post?: Response | Error; gets?: (Response | Error)[] }, timeout = 60): Harness {
	const sleeps: number[] = [];
	let now = 1_000_000;
	const calls: { url: string; init: RequestInit }[] = [];
	const gets = [...(responses.gets ?? [])];
	const inner = vi.fn(async (url: string, init?: RequestInit) => {
		calls.push({ url, init: init ?? {} });
		if (String(url).endsWith("/api/v1/send")) {
			if (responses.post instanceof Error) throw responses.post;
			if (responses.post !== undefined) return responses.post;
			return jsonResponse(201, { log_id: 7, status: "queued" });
		}
		const next = gets.shift();
		if (next instanceof Error) throw next;
		if (next !== undefined) return next;
		return jsonResponse(200, statusPayload(7, "success"));
	});
	const fetchMock: FetchMock = Object.assign(
		(url: string, init?: RequestInit) => inner(url, init),
		{ mock: inner },
	);
	return {
		fetchImpl: fetchMock,
		sleeps,
		now,
		deps: () => ({
			fetchImpl: fetchMock as unknown as typeof fetch,
			sleep: async (ms: number) => {
				sleeps.push(ms / 1000);
				now += ms;
			},
			nowMs: () => now,
			log: () => {},
		}),
		postCalls: () => calls.filter((c) => String(c.url).endsWith("/api/v1/send")),
		getCalls: () => calls.filter((c) => !String(c.url).endsWith("/api/v1/send")),
	};
}

const send = (h: Harness, c?: MonitorConfig) =>
	sendViaPortcloud("s", "<p>h</p>", "t", c ?? cfg(), h.deps());

describe("success", () => {
	it("首次轮询在受理 1 秒后，且只 sleep 一次", async () => {
		const h = harness({ post: jsonResponse(201, { log_id: 7 }), gets: [jsonResponse(200, statusPayload(7, "success"))] });
		await send(h);
		expect(h.postCalls()).toHaveLength(1);
		expect(h.getCalls()).toHaveLength(1);
		expect(h.sleeps).toEqual([1]);
		expect(h.getCalls()[0]?.url.endsWith("/api/v1/send/7")).toBe(true);
	});

	it("queued/sending 后成功，每 1 秒轮询", async () => {
		const h = harness({
			post: jsonResponse(201, { log_id: 11 }),
			gets: [
				jsonResponse(200, statusPayload(11, "queued")),
				jsonResponse(200, statusPayload(11, "sending")),
				jsonResponse(200, statusPayload(11, "success")),
			],
		});
		await send(h);
		expect(h.getCalls()).toHaveLength(3);
		expect(h.sleeps).toEqual([1, 1, 1]);
	});

	it("受理只 POST 一次，payload 带 to/html/text", async () => {
		const h = harness({
			post: jsonResponse(201, { log_id: 3 }),
			gets: [jsonResponse(200, statusPayload(3, "queued")), jsonResponse(200, statusPayload(3, "success"))],
		});
		await send(h);
		expect(h.postCalls()).toHaveLength(1);
		const payload = JSON.parse(String(h.postCalls()[0]?.init.body)) as Record<string, unknown>;
		expect(payload.to).toBe("to@example.com");
		expect(payload).toHaveProperty("html");
		expect(payload).toHaveProperty("text");
	});
});

describe("terminal failures", () => {
	it("failed 带原因抛出（非 Unconfirmed）", async () => {
		const h = harness({
			post: jsonResponse(201, { log_id: 42 }),
			gets: [jsonResponse(200, statusPayload(42, "failed", "smtp_timeout"))],
		});
		const err = await send(h).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(Error);
		expect(err).not.toBeInstanceOf(PortcloudUnconfirmed);
		expect(String((err as Error).message)).toContain("failed");
		expect(String((err as Error).message)).toContain("smtp_timeout");
		expect(String((err as Error).message)).toContain("42");
	});

	it("rejected 带原因抛出（非 Unconfirmed）", async () => {
		const h = harness({
			post: jsonResponse(201, { log_id: 43 }),
			gets: [jsonResponse(200, statusPayload(43, "rejected", "recipient_not_verified"))],
		});
		const err = await send(h).catch((e: unknown) => e);
		expect(err).not.toBeInstanceOf(PortcloudUnconfirmed);
		expect(String((err as Error).message)).toContain("rejected");
	});
});

describe("budget and transient retry", () => {
	it("预算耗尽判结果未知", async () => {
		const queued = () => jsonResponse(200, statusPayload(5, "queued"));
		const h = harness({ post: jsonResponse(201, { log_id: 5 }), gets: [queued(), queued(), queued()] }, 3);
		const err = await send(h, cfg(3)).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(PortcloudUnconfirmed);
		expect(String((err as Error).message)).toContain("5");
		expect(h.getCalls()).toHaveLength(2);
		expect(h.sleeps).toEqual([1, 1, 1]);
	});

	for (const [name, err] of [
		["连接错误后成功", new TypeError("boom")],
		["429 后成功", null],
		["500 后成功", null],
	] as const) {
		it(name, async () => {
			const first: Response | Error =
				err ?? (name.includes("429") ? new Response("rate limited", { status: 429 }) : new Response("oops", { status: 500 }));
			const h = harness({
				post: jsonResponse(201, { log_id: 9 }),
				gets: [first, jsonResponse(200, statusPayload(9, "success"))],
			});
			await send(h);
			expect(h.getCalls()).toHaveLength(2);
		});
	}

	it("4xx 查询判结果未知且只查一次", async () => {
		for (const status of [401, 404]) {
			const h = harness({
				post: jsonResponse(201, { log_id: 21 }),
				gets: [new Response("no", { status })],
			});
			const err = await send(h).catch((e: unknown) => e);
			expect(err).toBeInstanceOf(PortcloudUnconfirmed);
			expect(h.getCalls()).toHaveLength(1);
		}
	});
});

describe("malformed responses", () => {
	it("受理非 JSON / 缺 log_id / 非法 log_id 均判结果未知且不轮询", async () => {
		const badPosts = [
			new Response("<html>oops</html>", { status: 201 }),
			jsonResponse(201, { status: "queued" }),
			jsonResponse(201, { log_id: true }),
			jsonResponse(201, { log_id: 0 }),
			jsonResponse(201, { log_id: 1.5 }),
		];
		for (const post of badPosts) {
			const h = harness({ post });
			const err = await send(h).catch((e: unknown) => e);
			expect(err).toBeInstanceOf(PortcloudUnconfirmed);
			expect(h.getCalls()).toHaveLength(0);
		}
	});

	it("查询非 JSON / log_id 不匹配 / 未知状态均判结果未知", async () => {
		const badGets = [
			new Response("not json", { status: 200 }),
			jsonResponse(200, statusPayload(999, "success")),
			jsonResponse(200, statusPayload(1.5, "success")),
			jsonResponse(200, statusPayload(32, "banana")),
		];
		for (const get of badGets) {
			const h = harness({ post: jsonResponse(201, { log_id: 31 }), gets: [get] });
			const err = await send(h).catch((e: unknown) => e);
			expect(err).toBeInstanceOf(PortcloudUnconfirmed);
		}
	});
});

describe("no post retry", () => {
	it("受理 HTTP 错误不重试（非 Unconfirmed）", async () => {
		for (const status of [403, 500]) {
			const h = harness({ post: new Response("err", { status }) });
			const err = await send(h).catch((e: unknown) => e);
			expect(err).not.toBeInstanceOf(PortcloudUnconfirmed);
			expect(h.postCalls()).toHaveLength(1);
			expect(h.getCalls()).toHaveLength(0);
		}
	});

	it("受理连接错误判结果未知且只请求一次", async () => {
		const h = harness({ post: new TypeError("refused") });
		const err = await send(h).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(PortcloudUnconfirmed);
		expect(h.postCalls()).toHaveLength(1);
		expect(h.getCalls()).toHaveLength(0);
	});
});

// LowEndTalk 低价监控 Worker 入口：Cron 定时 → pipeline → KV 状态 → Portcloud 发信。
//
// 定时：wrangler.jsonc 的 triggers.crons（默认 17 */4 * * *，UTC）。
// 状态：STATE KV（sent 已推送 URL + lastRun），替代原来 Actions cache 的状态文件。
// AI：Workers AI 绑定（env.AI），不再接外部 LLM 接口。
// 发信：只留 Portcloud（Worker 无原生 SMTP）。

import { PortcloudUnconfirmed, buildAlert, runPipeline, sendViaPortcloud } from "./monitor";
import type { Deps, MonitorConfig, PipelineState, RunHandlers } from "./monitor";
// ---- 定时入口 ----

export default {
	async scheduled(controller: ScheduledController, env: Env): Promise<void> {
		await handleCron(env, controller.cron, {
			log: (msg) => console.log(JSON.stringify({ scope: "cron", cron: controller.cron, msg })),
		});
	},

	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === "/__scheduled" && request.method === "POST") {
			return handleManualTrigger(request, env);
		}
		if (url.pathname === "/healthz") {
			return Response.json({ ok: true });
		}
	return new Response("Not found", { status: 404 });
	},
} satisfies ExportedHandler<Env>;

const STATE_KEY = "let-monitor-state-v1";

interface CronDeps extends Deps {
	loadState?: () => Promise<PipelineState>;
	saveState?: (state: PipelineState) => Promise<void>;
	aiChat?: (system: string, user: string) => Promise<string>;
	sendMail?: (subject: string, html: string, text: string) => Promise<void>;
}

function readInt(raw: string | undefined, fallback: number): number {
	const n = parseInt(raw ?? "", 10);
	return Number.isFinite(n) ? n : fallback;
}

type AppEnv = Env & { PC_KEY?: string; PC_TO?: string; CRON_SECRET?: string };

function buildConfig(env: AppEnv): MonitorConfig {
	const requireTag = String(env.REQUIRE_SERVER_TAG);
	const pcTimeoutRaw = readInt(String(env.PC_TIMEOUT), 60);
	return {
		feedUrl: String(env.FEED_URL),
		feedProxy: String(env.FEED_PROXY),
		lookbackDays: readInt(String(env.LOOKBACK_DAYS), 7),
		maxPosts: readInt(String(env.MAX_POSTS), 60),
		classifyBatchSize: readInt(String(env.CLASSIFY_BATCH_SIZE), 10),
		requireServerTag: requireTag !== "false" && requireTag !== "0",
		intervalMinutes: readInt(String(env.INTERVAL_MINUTES), 240),
		aiModel: String(env.AI_MODEL),
		pcUrl: String(env.PC_URL || "https://notify.portcloud.online").replace(/\/+$/, ""),
		pcKey: env.PC_KEY ?? "",
		pcTo: env.PC_TO ?? "",
		pcTimeout: pcTimeoutRaw > 0 ? pcTimeoutRaw : 60,
	};
}

async function loadStateFromKv(env: Env): Promise<PipelineState> {
	try {
		const raw = await env.STATE.get(STATE_KEY);
		if (!raw) return { sent: [] };
		const data: unknown = JSON.parse(raw);
		if (typeof data === "object" && data !== null && "sent" in data && Array.isArray(data.sent)) {
			const sent = data.sent.filter((u): u is string => typeof u === "string");
			const lastRun = "lastRun" in data && typeof data.lastRun === "string" ? data.lastRun : undefined;
			return lastRun === undefined ? { sent } : { sent, lastRun };
		}
		console.log(JSON.stringify({ scope: "state", msg: "状态损坏，按空状态处理" }));
		return { sent: [] };
	} catch {
		console.log(JSON.stringify({ scope: "state", msg: "状态损坏，按空状态处理" }));
		return { sent: [] };
	}
}

// Workers AI 的 chat 输出：{ response } 或 OpenAI 兼容的 { choices[0].message.content }。
function extractAiText(out: unknown): string {
	if (typeof out !== "object" || out === null) return "";
	if ("response" in out && typeof out.response === "string" && out.response) return out.response;
	if ("choices" in out && Array.isArray(out.choices)) {
		const first: unknown = out.choices[0];
		if (typeof first === "object" && first !== null && "message" in first) {
			const msg: unknown = first.message;
			if (typeof msg === "object" && msg !== null && "content" in msg && typeof msg.content === "string") {
				return msg.content;
			}
		}
		if (typeof first === "object" && first !== null && "text" in first && typeof first.text === "string") {
			return first.text;
		}
	}
	return "";
}

async function aiChatViaBinding(env: Env, model: string, system: string, user: string): Promise<string> {
	let last: unknown = null;
	for (let attempt = 1; attempt <= 3; attempt++) {
		try {
			const out: unknown = await env.AI.run(
				model as Parameters<Ai["run"]>[0],
				{
					messages: [
						{ role: "system", content: system },
						{ role: "user", content: user },
					],
					temperature: 0,
					max_tokens: 8000,
				} as Record<string, unknown>,
			);
			const text = extractAiText(out);
			if (!text) throw new Error(`AI 响应里没有文本: ${JSON.stringify(out)?.slice(0, 300)}`);
			return text;
		} catch (exc) {
			last = exc;
			if (exc instanceof Error && /没有文本/.test(exc.message)) throw exc;
			console.log(
				JSON.stringify({
					scope: "ai",
					msg: `AI 调用失败 (${attempt}/3): ${exc instanceof Error ? exc.message.slice(0, 200) : String(exc).slice(0, 200)}`,
				}),
			);
			if (attempt < 3) {
				const { promise, resolve } = Promise.withResolvers<void>();
				setTimeout(resolve, 5000 * attempt);
				await promise;
			}
		}
	}
	throw new Error(`AI 调用失败: ${last instanceof Error ? last.message : String(last)}`);
}

async function handleCron(env: Env, cron: string, d: CronDeps): Promise<void> {
	const log = d.log ?? ((msg: string) => console.log(msg));
	const cfg = buildConfig(env);
	const handlers: RunHandlers = {
		loadState: d.loadState ?? (() => loadStateFromKv(env)),
		saveState: d.saveState ?? ((state) => env.STATE.put(STATE_KEY, JSON.stringify(state))),
		aiChat: d.aiChat ?? ((system, user) => aiChatViaBinding(env, cfg.aiModel, system, user)),
		send: d.sendMail ?? ((subject, html, text) => sendViaPortcloud(subject, html, text, cfg, d)),
	};
	try {
		const result = await runPipeline(cfg, {}, handlers, d);
		log(`完成（cron=${cron}）：${result.emailed ? `已推送 ${result.items ?? 0} 条` : "无新增"}`);
	} catch (exc) {
		const err = `${exc instanceof Error ? exc.constructor.name : typeof exc}: ${exc instanceof Error ? exc.message : String(exc)}`;
		log(`运行失败: ${err}`);
		try {
			const alert = buildAlert(err);
			await handlers.send(alert.subject, alert.html, alert.text);
		} catch (alertExc) {
			log(`告警邮件也发不出去: ${alertExc instanceof Error ? alertExc.message : String(alertExc)}`);
		}
		throw exc;
	}
}

// ---- 手动触发：POST /__scheduled（需 Authorization: Bearer <CRON_SECRET>）----

interface ManualBody {
	dry_run?: boolean;
	force?: boolean;
	limit?: number;
}

async function verifySecret(request: Request, env: AppEnv): Promise<boolean> {
	const expected = env.CRON_SECRET;
	if (!expected) return false;
	const header = request.headers.get("Authorization") ?? "";
	if (!header.startsWith("Bearer ")) return false;
	const provided = header.slice("Bearer ".length);
	const enc = new TextEncoder();
	const [a, b] = await Promise.all([
		crypto.subtle.digest("SHA-256", enc.encode(provided)),
		crypto.subtle.digest("SHA-256", enc.encode(expected)),
	]);
	return crypto.subtle.timingSafeEqual(a, b);
}

async function handleManualTrigger(request: Request, env: Env): Promise<Response> {
	if (!(await verifySecret(request, env))) {
		return Response.json({ error: "unauthorized" }, { status: 401 });
	}
	let body: ManualBody = {};
	try {
		body = (await request.json()) as ManualBody;
	} catch {
		body = {};
	}
	const cfg = buildConfig(env);
	const deps: Deps = {
		log: (msg) => console.log(JSON.stringify({ scope: "manual", msg })),
	};
	const handlers: RunHandlers = {
		loadState: () => loadStateFromKv(env),
		saveState: (state) => env.STATE.put(STATE_KEY, JSON.stringify(state)),
		aiChat: (system, user) => aiChatViaBinding(env, cfg.aiModel, system, user),
		send: (subject, html, text) => sendViaPortcloud(subject, html, text, cfg, deps),
	};
	try {
		const result = await runPipeline(
			cfg,
			{ dryRun: body.dry_run === true, force: body.force !== false, limit: body.limit },
			handlers,
			deps,
		);
		if (body.dry_run === true) {
			return Response.json({
				emailed: false,
				dry_run: true,
				subject: result.subject,
				items: result.items ?? 0,
				html: result.html,
			});
		}
		return Response.json(result);
	} catch (exc) {
		const err = `${exc instanceof Error ? exc.constructor.name : typeof exc}: ${exc instanceof Error ? exc.message : String(exc)}`;
		console.error(JSON.stringify({ scope: "manual", msg: `运行失败: ${err}` }));
		if (exc instanceof PortcloudUnconfirmed) {
			return Response.json({ error: "投递结果未知", detail: err }, { status: 502 });
		}
		return Response.json({ error: err }, { status: 500 });
	}
}

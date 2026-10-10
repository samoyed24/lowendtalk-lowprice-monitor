// LowEndTalk 低价监控 Worker 入口：Cron 定时 → pipeline → KV 状态 → 发信。
//
// 定时：wrangler.jsonc 的 triggers.crons（默认 */30 * * * *，UTC）。
// 状态：STATE KV（sent 已推送 URL + lastRun），替代原来 Actions cache 的状态文件。
// AI：Workers AI 绑定（env.AI），不再接外部 LLM 接口。
// 发信：AgentNotify（推荐）与自定义 SMTP 双通道，至少配一个，都配则同时发送。

import { buildAlert, runPipeline, sendMail } from "./monitor";
import type { Deps, MonitorConfig, PipelineState, RunHandlers } from "./monitor";
// ---- 定时入口 ----

export default {
	async scheduled(controller: ScheduledController, env: Env): Promise<void> {
		await handleCron(env, controller.cron, {
			log: (msg) => console.log(JSON.stringify({ scope: "cron", cron: controller.cron, msg })),
		});
	},

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
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

type AppEnv = Env & {
	NOTIFY_URL?: string;
	NOTIFY_TIMEOUT?: string;
	NOTIFY_KEY?: string;
	NOTIFY_TO?: string;
	PC_URL?: string;
	PC_TIMEOUT?: string;
	PC_KEY?: string;
	PC_TO?: string;
	SMTP_HOST?: string;
	SMTP_PORT?: string;
	SMTP_USER?: string;
	SMTP_PASS?: string;
	MAIL_TO?: string;
};

function envStr(env: AppEnv, key: "NOTIFY_KEY" | "NOTIFY_TO" | "PC_KEY" | "PC_TO" | "SMTP_USER" | "SMTP_PASS" | "MAIL_TO"): string {
	const v = env[key];
	return typeof v === "string" ? v : "";
}

function buildConfig(env: AppEnv): MonitorConfig {
	const requireTag = String(env.REQUIRE_SERVER_TAG);
	const notifyTimeoutRaw = readInt(String(env.NOTIFY_TIMEOUT ?? env.PC_TIMEOUT), 60);
	const smtpPortRaw = readInt(String(env.SMTP_PORT ?? "465"), 465);
	return {
		feedUrl: String(env.FEED_URL),
		feedProxy: String(env.FEED_PROXY),
		lookbackDays: readInt(String(env.LOOKBACK_DAYS), 7),
		maxPosts: readInt(String(env.MAX_POSTS), 60),
		classifyBatchSize: readInt(String(env.CLASSIFY_BATCH_SIZE), 1),
		requireServerTag: requireTag !== "false" && requireTag !== "0",
		intervalMinutes: readInt(String(env.INTERVAL_MINUTES), 240),
		aiModel: String(env.AI_MODEL),
		notifyUrl: String(env.NOTIFY_URL ?? env.PC_URL ?? "https://notify.portcloud.online").replace(/\/+$/, ""),
		notifyKey: envStr(env, "NOTIFY_KEY") || envStr(env, "PC_KEY"),
		notifyTo: envStr(env, "NOTIFY_TO") || envStr(env, "PC_TO"),
		notifyTimeout: notifyTimeoutRaw > 0 ? notifyTimeoutRaw : 60,
		smtpHost: String(env.SMTP_HOST ?? "smtp.qq.com"),
		smtpPort: smtpPortRaw > 0 ? smtpPortRaw : 465,
		smtpUser: envStr(env, "SMTP_USER"),
		smtpPass: envStr(env, "SMTP_PASS"),
		smtpTo: envStr(env, "MAIL_TO"),
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
		send: d.sendMail ?? ((subject, html, text) => sendMail(subject, html, text, cfg, d)),
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


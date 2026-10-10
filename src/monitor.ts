// LowEndTalk 低价监控 —— 纯流水线逻辑（无 Worker API，可单元测试）。
//
// 抓取 → 解析 → AI 打标 → 整理 → 去重 → 发信 → 存状态。
// Worker 绑定（KV / Workers AI）的接线在 index.ts。

import { sendSmtpMail } from "./smtp";
import type { SmtpDialer } from "./smtp";
export interface MonitorConfig {
	feedUrl: string;
	lookbackDays: number;
	maxPosts: number;
	classifyBatchSize: number;
	requireServerTag: boolean;
	intervalMinutes: number;
	aiModel: string;
	// AgentNotify（托管发信）：notify* 为主，pc* 兼容保留。
	notifyUrl: string;
	notifyKey: string;
	notifyTo: string;
	notifyTimeout: number;
	// 自定义 SMTP（二选一配一个即可；都配则同时发送）。
	smtpHost: string;
	smtpPort: number;
	smtpUser: string;
	smtpPass: string;
	smtpTo: string;
}

export interface FeedPost {
	title: string;
	postUrl: string;
	author: string;
	date: string;
	body: string;
}

export interface Price {
	amount: number;
	currency: string;
	period: string;
}

export interface Verdict {
	i: number;
	tags: string[];
	prices: Price[];
	zh: string;
}

export type Item = FeedPost & { tags: string[]; prices: Price[]; zh: string };

export interface PipelineState {
	sent: string[];
	lastRun?: string;
}

export interface Deps {
	fetchImpl?: typeof fetch;
	sleep?: (ms: number) => Promise<void>;
	nowMs?: () => number;
	log?: (msg: string) => void;
	smtpDialer?: SmtpDialer;
}

export interface FeedData {
	items: unknown[];
}

const UA = "lowendtalk-lowprice-monitor/1.0 (+https://github.com/samoyed24)";
const STATE_MAX = 5000;
// 「距上次运行是否满 INTERVAL_MINUTES」允许的提前量：cron 派发本身有抖动，
// 取 5 分钟远小于最小 cron 周期（30 分钟），不会让两个相邻周期都放行。
const DUE_TOLERANCE_MS = 5 * 60_000;
const NOTIFY_REQUEST_TIMEOUT_MS = 60_000;
const NOTIFY_POLL_INTERVAL_MS = 1000;

export const SYSTEM_PROMPT = [
	"你是 VPS / 服务器优惠分析师。对每一条帖子打标签并写中文摘要。",
	"",
	"tags：从下列取值中选出所有适用的，可以多选，也可以为空数组。",
	"  类型（最多选一个）：vps、vds、独服、存储服",
	"  网络（可多选）：ipv4、ipv6、家宽、回国优化、CN2、GIA、BGP、Anycast、大带宽、不限流量",
	"  其他（可多选）：高防、KVM、OpenVZ、LXC、Windows、GPU、独立IP、免费试用、抽奖",
	"",
	"  · vps = 虚拟服务器；vds = 独享资源的虚拟服务器",
	"  · 独服 = 独立服务器 / 裸金属 / 整机租用",
	"  · 存储服 = 主打大容量存储的机型",
	"  · 家宽 = 住宅宽带 IP；回国优化 = 面向中国大陆优化的线路",
	'  · 注意 "1 Dedicated IPv4"、"dedicated port"、"dedicated resources" 说的是 VPS 的配置，',
	"    不是独立服务器。只有整机租用才算「独服」。",
	"",
	"prices：列出帖子里出现的所有价格档，按从低到高排序，最多 5 条。",
	"  · amount 只填数字；currency 填 USD / EUR / CNY 等，不确定填 null",
	"  · period 只能是 month | year | quarter | half-year | one-time | unknown",
	"",
	"zh：中文详细摘要，写成 3–5 个完整短句，正文信息充足时必须写 150–300 字，不要只写一句概述。",
	"  · 按「商家与机房 → 具体套餐配置和价格 → 网络与 IP → 优惠和限制」的顺序组织，缺失的部分略过，信息少时允许更短，不凑字数。",
	"  · 写清 CPU 型号 / 核数、内存、存储容量与类型、带宽 / 流量、IP 和线路中原帖明确提供的参数。",
	"  · 有多个套餐时，挑 1–3 个主要档位，逐个写出「配置 + 价格 + 币种 + 计费周期」，不要混用不同套餐的参数。",
	"  · 即使 prices 字段已列价格，zh 仍须把价格与配置配对；不能用「不同配置」「多种套餐」「内存、存储等」代替原帖中的具体数值。",
	"  · 说明优惠码、首期价与续费价、优惠是否循环、购买限制、活动期限等关键条件（仅在原帖明确写出时）。",
	"  · 只依据标题和正文，不推测未说明的配置、线路或续费政策；保留影响购买判断的限制，省略宣传套话。",
	"  · 用连贯中文短句，纯文本，不要 markdown。",
	"",
	"每条输入帖子都必须返回一条结果，i 与输入序号一致，不遗漏、不重复；逐帖独立分析，不得借用其他帖子的配置或价格。",
	"只输出 JSON 数组，不要解释文字，不要 markdown 代码块。",
	'格式：[{"i":序号,"tags":["..."],"prices":[{"amount":数字,"currency":"USD","period":"month"}],"zh":"..."}]',
].join("\n");

const TYPE_TAG_SET: Record<string, true> = { vps: true, vds: true, "独服": true, "存储服": true };
const TYPE_COLOR: Record<string, string> = {
	vps: "#1a56db",
	vds: "#7c3aed",
	"独服": "#9a3412",
	"存储服": "#0f766e",
};
const TAG_COLOR = "#6b7280";

const PERIOD_ZH: Record<string, string> = {
	month: "/月",
	year: "/年",
	quarter: "/季",
	"half-year": "/半年",
	"one-time": " 一次性",
	unknown: "",
};
// 折算到月，用于排序；周期未知的不参与排序
const TO_MONTH: Record<string, number> = {
	month: 1,
	quarter: 1 / 3,
	"half-year": 1 / 6,
	year: 1 / 12,
};

// ---------------------------------------------------------------- 抓取与解析

async function fetchWithRetry(
	url: string,
	options: RequestInit,
	timeoutMs: number,
	tries: number,
	d: Deps,
): Promise<Response> {
	const log = d.log ?? ((msg: string) => console.log(msg));
	const sleep =
		d.sleep ??
		((ms: number) => {
			const { promise, resolve } = Promise.withResolvers<void>();
			setTimeout(resolve, ms);
			return promise;
		});
	const fetchImpl = d.fetchImpl ?? fetch;
	let last: unknown = null;
	for (let attempt = 1; attempt <= tries; attempt++) {
		try {
			const r = await fetchImpl(url, {
				...options,
				headers: { "User-Agent": UA, ...options.headers },
				signal: AbortSignal.timeout(timeoutMs),
			});
			if (!r.ok) {
				const body = await r.text().catch(() => "");
				throw new Error(`HTTP ${r.status}: ${body.slice(0, 300)}`);
			}
			return r;
		} catch (exc) {
			last = exc;
			const name = exc instanceof Error ? exc.constructor.name : typeof exc;
			const msg = exc instanceof Error ? exc.message : String(exc);
			log(`  请求失败 (${attempt}/${tries}): ${name}: ${msg.slice(0, 120)}`);
			if (attempt < tries) await sleep(2 ** attempt * 1000);
		}
	}
	throw new Error(`GET ${url} 重试 ${tries} 次仍失败: ${String(last)}`);
}

export async function fetchFeed(cfg: MonitorConfig, d: Deps = {}): Promise<FeedData> {
	const log = d.log ?? ((msg: string) => console.log(msg));
	const r = await fetchWithRetry(cfg.feedUrl, { headers: { Accept: "application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8" } }, 90_000, 3, d);
	const xml = await r.text();
	const items = parseRssItems(xml);
	if (items.length === 0) {
		throw new Error(`RSS 里没有解析出任何 <item>（响应前 200 字：${xml.slice(0, 200)}）`);
	}
	log(`抓到 ${items.length} 条`);
	return { items };
}

// ---------------------------------------------------------------- RSS 解析
//
// Workers 运行时没有 DOMParser，也不引入 XML 库：RSS 结构固定，用扫描器按标签取值即可。
// 只处理 RSS 2.0（LET 用的是它）；取不到 <item> 就报错，不静默返回空。

/** 取成对标签的内容，返回首个匹配。用于 item/title 这类不含同名嵌套的标签。 */
function tagContent(xml: string, tag: string): string {
	// 单次正则，避免为每个标签都复制一份小写副本。
	const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}\\s*>`, "i").exec(xml);
	return m === null ? "" : (m[1] ?? "");
}

/** 取 CDATA 内容，没有 CDATA 时去掉最外层标签。 */
function unwrapCdata(raw: string): string {
	const m = /<!\[CDATA\[([\s\S]*?)\]\]>/.exec(raw);
	return m !== null ? (m[1] ?? "") : raw;
}

function xmlUnescape(s: string): string {
	return s
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&#(\d+);/g, (_m, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
		.replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
		.replace(/&amp;/g, "&"); // 最后解码 &，避免二次解码
}

/** RSS <item> 归一化后的形状（JSON Feed 子集），parsePosts 直接消费。 */
export interface RssItem {
	url: string;
	title: string;
	date_published: string;
	content_html: string;
	author?: { name: string };
}

/** 把 RSS 转成现有的 JSON Feed 形状，parsePosts 不用改。 */
export function parseRssItems(xml: string): RssItem[] {
	const items: RssItem[] = [];
	const re = /<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi;
	for (const m of xml.matchAll(re)) {
		const block = m[1] ?? "";
		const title = xmlUnescape(tagContent(block, "title")).trim();
		const url = xmlUnescape(tagContent(block, "link")).trim();
		if (!url) continue;
		const rawDate = xmlUnescape(tagContent(block, "pubDate") || tagContent(block, "dc:date")).trim();
		const parsed = rawDate ? Date.parse(rawDate) : Number.NaN;
		const author = xmlUnescape(tagContent(block, "dc:creator")).trim();
		// LET 的正文在 <description>（CDATA 包裹的 HTML）；<content:encoded> 若有则优先。
		const encoded = tagContent(block, "content:encoded");
		const description = tagContent(block, "description");
		const html = unwrapCdata(encoded !== "" ? encoded : description);
		items.push({
			url,
			title,
			date_published: Number.isNaN(parsed) ? "" : new Date(parsed).toISOString(),
			content_html: html,
			...(author ? { author: { name: author } } : {}),
		});
	}
	return items;
}

const ENTITY_TABLE: Record<string, string> = {
	"&nbsp;": " ",
	"&lt;": "<",
	"&gt;": ">",
	"&quot;": '"',
	"&apos;": "'",
	"&hellip;": "…",
	"&mdash;": "—",
	"&ndash;": "–",
	"&rsquo;": "’",
	"&lsquo;": "‘",
	"&ldquo;": "“",
	"&rdquo;": "”",
};

export function decodeEntities(s: string): string {
	let out = String(s ?? "");
	out = out.replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => String.fromCodePoint(parseInt(hex, 16)));
	out = out.replace(/&#(\d+);/g, (_m, dec: string) => String.fromCodePoint(parseInt(dec, 10)));
	for (const ent of Object.keys(ENTITY_TABLE)) out = out.split(ent).join(ENTITY_TABLE[ent] ?? ent);
	return out.split("&amp;").join("&"); // 最后解码 &，避免二次解码
}

export function stripTitleLead(title: string, text: string): string {
	const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
	const nt = norm(title);
	const tt = norm(text);
	if (nt.length < 15 || tt.length < nt.length) return text;
	if (!tt.startsWith(nt)) {
		const probe = nt.slice(0, Math.max(15, Math.floor(nt.length * 0.7)));
		if (!tt.startsWith(probe)) return text;
	}
	let count = 0;
	let i = 0;
	while (i < text.length && count < nt.length) {
		if (/[a-z0-9]/i.test(text[i] ?? "")) count++;
		i++;
	}
	const rest = text.slice(i).replace(/^[\s\-–—|:·•,.]+/, "").trim();
	return rest.length > 40 ? rest : text;
}

function readStringField(item: unknown, key: string): string {
	if (typeof item === "object" && item !== null && key in item) {
		const v: unknown = item[key as keyof typeof item];
		if (typeof v === "string") return v;
	}
	return "";
}

export function parsePosts(feed: FeedData, cfg: MonitorConfig, nowMs = Date.now()): FeedPost[] {
	const cutoff = nowMs - cfg.lookbackDays * 24 * 3600 * 1000;
	const posts: FeedPost[] = [];
	for (const item of feed.items) {
		const url = readStringField(item, "url") || readStringField(item, "external_url") || readStringField(item, "id");
		if (!url) continue;
		const rawDate = readStringField(item, "date_published") || readStringField(item, "date_modified");
		if (rawDate) {
			const ts = Date.parse(rawDate);
			if (!Number.isNaN(ts) && ts < cutoff) continue;
		}
		const title = decodeEntities(readStringField(item, "title").trim());
		const html = readStringField(item, "content_html").replace(/<[^>]+>/g, " ");
		const bodyRaw = readStringField(item, "content_text") || html;
		const body = stripTitleLead(title, decodeEntities(bodyRaw).replace(/\s+/g, " ").trim());
		let author = "";
		if (typeof item === "object" && item !== null && "author" in item) {
			const a: unknown = item.author;
			if (typeof a === "object" && a !== null && "name" in a) author = String(a.name ?? "");
		}
		posts.push({ title, postUrl: url, author, date: rawDate, body });
	}
	posts.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
	return posts.slice(0, cfg.maxPosts);
}

// ---------------------------------------------------------------- AI

/** 取 text 里第一个完整的 JSON 数组，忽略其后的任何内容。括号配平扫描，跳过字符串内的引号转义与括号。 */
export function firstJsonArray(text: string): unknown[] | null {
	const start = text.indexOf("[");
	if (start < 0) return null;
	let depth = 0;
	let inStr = false;
	let esc = false;
	for (let i = start; i < text.length; i++) {
		const c = text[i] ?? "";
		if (inStr) {
			if (esc) esc = false;
			else if (c === "\\") esc = true;
			else if (c === '"') inStr = false;
			continue;
		}
		if (c === '"') inStr = true;
		else if (c === "[") depth++;
		else if (c === "]") {
			depth--;
			if (depth === 0) {
				try {
					return JSON.parse(text.slice(start, i + 1)) as unknown[];
				} catch (exc) {
					const msg = exc instanceof Error ? exc.message : String(exc);
					throw new Error(`JSON 数组解析失败: ${msg}；原文: ${text.slice(start, i + 1).slice(0, 300)}`);
				}
			}
		}
	}
	return null;
}

function toVerdict(raw: unknown): Verdict | null {
	if (typeof raw !== "object" || raw === null) return null;
	if (!("i" in raw) || typeof raw.i !== "number" || !Number.isInteger(raw.i)) return null;
	const tags = "tags" in raw && Array.isArray(raw.tags)
		? raw.tags.map((t) => String(t).trim()).filter((t) => t.length > 0)
		: [];
	const prices = "prices" in raw ? normalizePrices(raw.prices) : [];
	const zh = "zh" in raw ? String(raw.zh ?? "") : "";
	return { i: raw.i, tags, prices, zh };
}

export async function classify(
	posts: FeedPost[],
	cfg: MonitorConfig,
	aiChat: (system: string, user: string) => Promise<string>,
	d: Deps = {},
): Promise<Verdict[]> {
	const log = d.log ?? ((msg: string) => console.log(msg));
	// 多帖子时一次返回的 JSON 数组过长会被截断，拆成多批调用，每批的序号仍是全局序号。
	const batch = Math.max(1, cfg.classifyBatchSize);
	const out: Verdict[] = [];
	for (let start = 0; start < posts.length; start += batch) {
		const chunk = posts.slice(start, start + batch);
		const payload = chunk.map((p, j) => ({
			i: start + j,
			title: p.title.slice(0, 200),
			body: p.body,
		}));
		const text = await aiChat(SYSTEM_PROMPT, "分析以下帖子：\n" + JSON.stringify(payload));
		const verdicts = firstJsonArray(text);
		if (!Array.isArray(verdicts)) {
			if (text.includes("[")) throw new Error(`响应 JSON 数组不完整（可能输出被截断）: ${text.slice(0, 300)}`);
			throw new Error(`响应里没有 JSON 数组: ${text.slice(0, 300)}`);
		}
		for (const raw of verdicts) {
			const v = toVerdict(raw);
			if (v !== null) out.push(v);
		}
		log(`AI 打了第 ${start + 1}-${start + chunk.length} 条的标签`);
	}
	log(`AI 打了 ${out.length} 条的标签`);
	return out;
}

// ---------------------------------------------------------------- 整理

export function normalizePrices(raw: unknown): Price[] {
	const out: Price[] = [];
	if (!Array.isArray(raw)) return out;
	for (const p of raw) {
		if (typeof p !== "object" || p === null || !("amount" in p)) continue;
		const amount = Number(p.amount);
		if (!Number.isFinite(amount) || amount <= 0) continue;
		const period = "period" in p ? String(p.period ?? "unknown").toLowerCase() : "unknown";
		const currency = "currency" in p && p.currency != null ? String(p.currency).toUpperCase() : "";
		out.push({ amount, currency, period });
	}
	out.sort((a, b) => a.amount - b.amount);
	return out.slice(0, 5);
}

export function merge(verdicts: Verdict[], posts: FeedPost[], requireServerTag: boolean): Item[] {
	const items: Item[] = [];
	for (const v of verdicts) {
		if (!Number.isInteger(v.i) || v.i < 0 || v.i >= posts.length) continue;
		if (requireServerTag && !v.tags.some((t) => TYPE_TAG_SET[t] === true)) continue;
		const post = posts[v.i];
		if (post === undefined) continue;
		items.push({ ...post, tags: v.tags, prices: v.prices, zh: v.zh });
	}
	// 按最低月均价排序，价格未知的排后面
	items.sort((a, b) => {
		const monthlyA = a.prices.filter((p) => TO_MONTH[p.period] !== undefined).map((p) => p.amount * (TO_MONTH[p.period] ?? 0));
		const monthlyB = b.prices.filter((p) => TO_MONTH[p.period] !== undefined).map((p) => p.amount * (TO_MONTH[p.period] ?? 0));
		if (monthlyA.length === 0 && monthlyB.length === 0) return 0;
		if (monthlyA.length === 0) return 1;
		if (monthlyB.length === 0) return -1;
		return Math.min(...monthlyA) - Math.min(...monthlyB);
	});
	return items;
}

// ---------------------------------------------------------------- 输出

/** 北京时间 "YYYY-MM-DD HH:MM"。 */
export function fmtCst(ms: number): string {
	const t = new Date(ms + 8 * 3600 * 1000);
	const p = (n: number) => String(n).padStart(2, "0");
	return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())} ${p(t.getUTCHours())}:${p(t.getUTCMinutes())}`;
}

export function fmtDate(raw: string): string {
	if (!raw) return "";
	const ts = Date.parse(raw);
	if (Number.isNaN(ts)) return raw.slice(0, 16);
	return fmtCst(ts);
}

const CURRENCY_SYMBOL: Record<string, string> = { USD: "$", EUR: "€", CNY: "¥" };

export function priceText(p: Price): string {
	const cur = CURRENCY_SYMBOL[p.currency] ?? (p.currency ? p.currency + " " : "$");
	return `${cur}${p.amount}${PERIOD_ZH[p.period] ?? ""}`;
}

function escHtml(s: unknown): string {
	return String(s ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

export function buildDigest(items: Item[], nowMs = Date.now()): { subject: string; html: string } {
	const rows = items.map((x) => {
		const typeTag = x.tags.find((t) => TYPE_TAG_SET[t] === true);
		const others = x.tags.filter((t) => TYPE_TAG_SET[t] !== true);
		const badges: string[] = [];
		if (typeTag !== undefined) {
			badges.push(
				`<span style="display:inline-block;font-size:11px;font-weight:700;color:#fff;` +
					`background:${TYPE_COLOR[typeTag] ?? TAG_COLOR};border-radius:3px;padding:1px 6px;` +
					`margin-right:6px;vertical-align:1px">${escHtml(typeTag)}</span>`,
			);
		}
		for (const t of others) {
			badges.push(
				`<span style="display:inline-block;font-size:11px;color:${TAG_COLOR};` +
					`border:1px solid #d1d5db;border-radius:3px;padding:0 5px;` +
					`margin-right:4px;vertical-align:1px">${escHtml(t)}</span>`,
			);
		}
		const priceHtml = x.prices.length > 0
			? '<span style="color:#0a7d32;font-weight:700">' + escHtml(x.prices.map(priceText).join(" / ")) + "</span>"
			: '<span style="color:#9ca3af">未列价格</span>';
		return `
  <div style="padding:13px 0;border-bottom:1px solid #ececec">
    <div style="margin-bottom:5px">${badges.join("")}
      <a href="${escHtml(x.postUrl)}" style="font-size:15px;font-weight:600;color:#1a56db;
         text-decoration:none">${escHtml(x.title)}</a>
    </div>
    <div style="font-size:12px;color:#8a8a8a;margin-bottom:6px">
      ${escHtml(x.author)}${x.author ? " · " : ""}${escHtml(fmtDate(x.date))} · ${priceHtml}
    </div>
    <div style="font-size:13px;color:#333;line-height:1.55">${escHtml(x.zh)}</div>
  </div>`;
	});

	const counts: Record<string, number> = {};
	for (const x of items) {
		for (const t of x.tags) {
			if (TYPE_TAG_SET[t] === true) counts[t] = (counts[t] ?? 0) + 1;
		}
	}
	const summary = Object.keys(counts)
		.map((k) => `${k} ${counts[k] ?? 0}`)
		.join(" · ");
	const now = fmtCst(nowMs);
	const doc =
		`<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,sans-serif;max-width:720px">\n` +
		`  <h2 style="margin:0 0 5px;font-size:19px">LowEndTalk 低价 VPS 汇总</h2>\n` +
		`  <div style="color:#8a8a8a;font-size:12px;margin-bottom:16px">\n` +
		`    新增 <b>${items.length}</b> 条${summary ? `（${summary}）` : ""} · 抓取时间 ${now}\n` +
		`  </div>\n` +
		`${rows.join("\n")}\n` +
		`  <div style="margin-top:18px;font-size:11px;color:#b0b0b0">\n` +
		`    来源 LowEndTalk › Offers 板块\n` +
		`  </div>\n` +
		`</div>`;
	return { subject: `[LET] 低价VPS ${items.length} 条 · ${now.slice(0, 10)}`, html: doc };
}

export function buildText(items: Item[]): string {
	const lines = [`LowEndTalk 低价 VPS 汇总 — 新增 ${items.length} 条`, ""];
	for (const x of items) {
		const head = x.tags.map((t) => `[${t}]`).join(" ");
		const prices = x.prices.map(priceText).join(" / ") || "未列价格";
		lines.push(`${head} ${x.title}`.trim());
		lines.push(`  ${prices}  |  ${x.zh}`);
		lines.push(`  ${x.postUrl}`);
		lines.push("");
	}
	return lines.join("\n").trim();
}

// ---------------------------------------------------------------- AgentNotify 投递

const NOTIFY_KNOWN_STATUS: Record<string, true> = {
	queued: true,
	sending: true,
	success: true,
	failed: true,
	rejected: true,
};

export class NotifyUnconfirmed extends Error {}
/** 兼容旧名。 */
export const PortcloudUnconfirmed = NotifyUnconfirmed;

function errName(exc: unknown): string {
	return exc instanceof Error ? exc.constructor.name : typeof exc;
}

function errMsg(exc: unknown): string {
	return exc instanceof Error ? exc.message : String(exc);
}

async function notifyPollOnce(
	logId: number,
	cfg: MonitorConfig,
	deadlineMs: number,
	d: Deps,
): Promise<{ status: string; reason: string | null }> {
	const sleep =
		d.sleep ??
		((ms: number) => {
			const { promise, resolve } = Promise.withResolvers<void>();
			setTimeout(resolve, ms);
			return promise;
		});
	const nowMs = d.nowMs ?? Date.now;
	const fetchImpl = d.fetchImpl ?? fetch;
	let last = "";
	for (;;) {
		const remaining = deadlineMs - nowMs();
		if (remaining <= 0) {
			throw new NotifyUnconfirmed(
				`AgentNotify 状态轮询超出预算（log_id=${logId}，投递结果未知）：${last || "预算耗尽"}`,
			);
		}
		try {
			const r = await fetchImpl(`${cfg.notifyUrl}/api/v1/send/${logId}`, {
				headers: { Authorization: `Bearer ${cfg.notifyKey}`, "User-Agent": UA },
				signal: AbortSignal.timeout(Math.min(NOTIFY_REQUEST_TIMEOUT_MS, remaining)),
			});
			if (r.status === 200) {
				const data: unknown = await r.json().catch((exc: unknown) => {
					throw new NotifyUnconfirmed(
						`AgentNotify 状态响应非 JSON（HTTP 200，log_id=${logId}，投递结果未知）`,
						{ cause: exc },
					);
				});
				if (typeof data !== "object" || data === null || !("log_id" in data) || !("status" in data)) {
					throw new NotifyUnconfirmed(
						`AgentNotify 状态响应异常（log_id=${logId}，返回 ${JSON.stringify(data)?.slice(0, 200)}，投递结果未知）`,
					);
				}
				const gotId: unknown = data.log_id;
				const status: unknown = data.status;
				if (
					typeof gotId !== "number" ||
					!Number.isInteger(gotId) ||
					gotId !== logId ||
					typeof status !== "string" ||
					NOTIFY_KNOWN_STATUS[status] !== true
				) {
					throw new NotifyUnconfirmed(
						`AgentNotify 状态响应异常（log_id=${logId}，返回 ${JSON.stringify(data)?.slice(0, 200)}，投递结果未知）`,
					);
				}
				const reason: unknown = "failure_reason" in data ? data.failure_reason : null;
				return { status, reason: reason == null ? null : String(reason) };
			}
			if (r.status !== 429 && r.status < 500) {
				throw new NotifyUnconfirmed(
					`AgentNotify 状态查询被拒: HTTP ${r.status}（log_id=${logId}，投递结果未知）`,
				);
			}
			last = `HTTP ${r.status}`;
		} catch (exc) {
			if (exc instanceof NotifyUnconfirmed) throw exc;
			const name = errName(exc);
			if (name === "TimeoutError" || name === "AbortError" || name === "TypeError") {
				// 连接错误 / 超时：预算内继续轮询
				last = `${name}: ${errMsg(exc).slice(0, 120)}`;
			} else {
				throw new NotifyUnconfirmed(
					`AgentNotify 状态查询异常（log_id=${logId}，投递结果未知）：${name}: ${errMsg(exc).slice(0, 120)}`,
					{ cause: exc },
				);
			}
		}
		const remaining2 = deadlineMs - nowMs();
		if (remaining2 <= 0) {
			throw new NotifyUnconfirmed(
				`AgentNotify 状态轮询超出预算（log_id=${logId}，投递结果未知）：${last || "预算耗尽"}`,
			);
		}
		await sleep(Math.min(NOTIFY_POLL_INTERVAL_MS, remaining2));
	}
}

export async function sendViaAgentNotify(
	subject: string,
	htmlBody: string,
	textBody: string,
	cfg: MonitorConfig,
	d: Deps = {},
): Promise<void> {
	const log = d.log ?? ((msg: string) => console.log(msg));
	const nowMs = d.nowMs ?? Date.now;
	const sleep =
		d.sleep ??
		((ms: number) => {
			const { promise, resolve } = Promise.withResolvers<void>();
			setTimeout(resolve, ms);
			return promise;
		});
	const fetchImpl = d.fetchImpl ?? fetch;
	if (!cfg.notifyKey || !cfg.notifyTo) {
		throw new Error("未配置 AgentNotify 通道。请设置 NOTIFY_KEY + NOTIFY_TO secrets");
	}
	const payload = { to: cfg.notifyTo, subject, text: textBody, html: htmlBody };
	let r: Response;
	try {
		r = await fetchImpl(`${cfg.notifyUrl}/api/v1/send`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${cfg.notifyKey}`,
				"Content-Type": "application/json",
				"User-Agent": UA,
			},
			body: JSON.stringify(payload),
			signal: AbortSignal.timeout(NOTIFY_REQUEST_TIMEOUT_MS),
		});
	} catch (exc) {
		throw new NotifyUnconfirmed(
			`AgentNotify 受理请求失败（投递结果未知）：${errName(exc)}: ${errMsg(exc).slice(0, 120)}`,
			{ cause: exc },
		);
	}
	if (r.status !== 201) {
		const body = await r.text().catch(() => "");
		throw new Error(`AgentNotify 受理失败: HTTP ${r.status} — ${body.slice(0, 200)}`);
	}
	const data: unknown = await r.json().catch(async () => {
		const body = await r.text().catch(() => "");
		throw new NotifyUnconfirmed(
			`AgentNotify 受理响应非 JSON（HTTP 201，投递结果未知）: ${body.slice(0, 200)}`,
		);
	});
	if (typeof data !== "object" || data === null || !("log_id" in data)) {
		throw new NotifyUnconfirmed(
			`AgentNotify 受理响应缺少合法 log_id（HTTP 201，投递结果未知）: ${JSON.stringify(data)?.slice(0, 200)}`,
		);
	}
	const logId: unknown = data.log_id;
	if (typeof logId !== "number" || !Number.isInteger(logId) || logId <= 0) {
		throw new NotifyUnconfirmed(
			`AgentNotify 受理响应缺少合法 log_id（HTTP 201，投递结果未知）: ${JSON.stringify(data)?.slice(0, 200)}`,
		);
	}
	// ---- 轮询：预算自受理成功起计，首次 1 秒后，之后每 1 秒一次 ----
	const deadlineMs = nowMs() + cfg.notifyTimeout * 1000;
	log(`AgentNotify 已受理（log_id=${logId}），轮询投递结果，预算 ${cfg.notifyTimeout}s`);
	for (;;) {
		const remaining = deadlineMs - nowMs();
		if (remaining <= 0) {
			throw new NotifyUnconfirmed(
				`AgentNotify 轮询超时（${cfg.notifyTimeout}s，log_id=${logId}，投递结果未知）`,
			);
		}
		await sleep(Math.min(NOTIFY_POLL_INTERVAL_MS, remaining));
		const { status, reason } = await notifyPollOnce(logId, cfg, deadlineMs, d);
		if (status === "success") {
			log(`邮件已发送（AgentNotify）→ ${cfg.notifyTo}（log_id=${logId}）`);
			return;
		}
		if (status === "failed" || status === "rejected") {
			throw new Error(`AgentNotify 投递${status}（log_id=${logId}）：${reason || "服务端未提供原因"}`);
		}
		// queued / sending：继续等下一次轮询。
	}
}

/** 兼容旧名。 */
export const sendViaPortcloud = sendViaAgentNotify;

export function hasNotifyChannel(cfg: MonitorConfig): boolean {
	return cfg.notifyKey !== "" && cfg.notifyTo !== "";
}

export function hasSmtpChannel(cfg: MonitorConfig): boolean {
	return cfg.smtpUser !== "" && cfg.smtpPass !== "" && cfg.smtpTo !== "" && cfg.smtpHost !== "";
}

export async function sendViaSmtp(
	subject: string,
	htmlBody: string,
	textBody: string,
	cfg: MonitorConfig,
	d: Deps = {},
): Promise<void> {
	const log = d.log ?? ((msg: string) => console.log(msg));
	// smtp_socket 依赖 cloudflare:sockets，仅存在于 Workers 运行时，Node 单测下不存在，
	// 因此不能静态导入；运行时按需动态加载（平台特定模块例外）。
	const loaded = d.smtpDialer ?? (await import("./smtp_socket").then((m) => new m.SocketDialer()));
	if (loaded === undefined) throw new Error("SMTP 拨号器不可用");
	const dial: SmtpDialer = loaded;
	await sendSmtpMail(
		subject,
		htmlBody,
		textBody || "此邮件为 HTML 格式，请用支持 HTML 的客户端查看。",
		{
			host: cfg.smtpHost,
			port: cfg.smtpPort,
			user: cfg.smtpUser,
			pass: cfg.smtpPass,
			mailTo: cfg.smtpTo,
		},
		dial,
		log,
	);
}
export async function sendMail(
	subject: string,
	htmlBody: string,
	textBody: string,
	cfg: MonitorConfig,
	d: Deps = {},
): Promise<void> {
	const channels: (() => Promise<void>)[] = [];
	if (hasNotifyChannel(cfg)) {
		channels.push(() => sendViaAgentNotify(subject, htmlBody, textBody, cfg, d));
	}
	if (hasSmtpChannel(cfg)) {
		channels.push(() => sendViaSmtp(subject, htmlBody, textBody, cfg, d));
	}
	if (channels.length === 0) {
		throw new Error(
			"未配置任何发送通道。请设置 NOTIFY_KEY + NOTIFY_TO（推荐 AgentNotify），" +
				"或 SMTP_USER + SMTP_PASS + MAIL_TO（自定义 SMTP）",
		);
	}
	for (const send of channels) {
		await send();
	}
}

export function buildAlert(error: string, nowMs = Date.now()): { subject: string; html: string; text: string } {
	const when = fmtCst(nowMs);
	const text = `LowEndTalk 监控本次运行失败\n\n${error.slice(0, 2000)}\n\n时间：${when} (CST)`;
	const html =
		`<div style="font-family:monospace;font-size:13px">\n` +
		`  <p><b>LowEndTalk 监控本次运行失败</b></p>\n` +
		`  <p style="color:#b91c1c;white-space:pre-wrap">${escHtml(error.slice(0, 2000))}</p>\n` +
		`  <p style="color:#6b7280">时间：${when} (CST)</p>\n` +
		`</div>`;
	return { subject: "🚨 LET 监控运行失败", html, text };
}

// ---------------------------------------------------------------- 状态与主流程

export function dueSinceLastRun(
	state: PipelineState,
	cfg: MonitorConfig,
	opts: { force?: boolean | undefined; dryRun?: boolean | undefined; nowMs?: number | undefined } = {},
): { due: boolean; reason: string } {
	const now = opts.nowMs ?? Date.now();
	if (opts.force === true || opts.dryRun === true || cfg.intervalMinutes <= 0) {
		return { due: true, reason: "force/dry-run" };
	}
	if (state.lastRun === undefined) return { due: true, reason: "no-lastRun" };
	const prev = Date.parse(state.lastRun);
	if (Number.isNaN(prev)) return { due: true, reason: "bad-lastRun" };
	// cron 派发有抖动（实测 scheduledTime 会偏离整点几十秒），若严格比较「必须满 N 分钟」，
	// 相邻两次触发的间隔会在 N 分钟附近来回摆，出现本该运行却跳过、实际变成隔次运行。
	// 因此给一个远小于最小 cron 周期（30 分钟）的容差，让「按周期触发」稳定放行。
	const elapsedMs = now - prev;
	if (elapsedMs < cfg.intervalMinutes * 60_000 - DUE_TOLERANCE_MS) {
		return {
			due: false,
			reason: `距上次运行仅 ${(elapsedMs / 60000).toFixed(0)} 分钟，未达 ${cfg.intervalMinutes} 分钟间隔，跳过`,
		};
	}
	return { due: true, reason: "interval-reached" };
}

export interface RunHandlers {
	loadState: () => Promise<PipelineState>;
	saveState: (state: PipelineState) => Promise<void>;
	aiChat: (system: string, user: string) => Promise<string>;
	send: (subject: string, html: string, text: string) => Promise<void>;
}

export interface RunResult {
	emailed: boolean;
	subject?: string | undefined;
	items?: number | undefined;
	html?: string | undefined;
}

export async function runPipeline(
	cfg: MonitorConfig,
	opts: { dryRun?: boolean | undefined; force?: boolean | undefined; limit?: number | undefined; scheduledAt?: number | undefined },
	h: RunHandlers,
	d: Deps = {},
): Promise<RunResult> {
	const log = d.log ?? ((msg: string) => console.log(msg));
	const nowMs = d.nowMs ?? Date.now;
	if (!hasNotifyChannel(cfg) && !hasSmtpChannel(cfg)) {
		throw new Error("缺少发信通道。请设置 NOTIFY_KEY + NOTIFY_TO，或 SMTP_USER + SMTP_PASS + MAIL_TO");
	}

	const state = await h.loadState();
	const due = dueSinceLastRun(state, cfg, { force: opts.force, dryRun: opts.dryRun, nowMs: nowMs() });
	if (!due.due) {
		log(due.reason);
		return { emailed: false };
	}
	const seen = new Set(state.sent);

	const feed = await fetchFeed(cfg, d);
	const posts = parsePosts(feed, cfg, nowMs());
	let fresh = posts.filter((p) => !seen.has(p.postUrl));
	const limit = opts.limit;
	if (limit !== undefined && Number.isFinite(limit) && limit > 0) {
		fresh = fresh.slice(0, Math.floor(limit));
	}
	log(`${posts.length} 条在窗口内，其中 ${fresh.length} 条是新增`);
	if (fresh.length === 0) return { emailed: false };

	const items = merge(await classify(fresh, cfg, h.aiChat, d), fresh, cfg.requireServerTag);

	if (opts.dryRun === true) {
		const digest = items.length > 0 ? buildDigest(items, nowMs()) : { subject: "(无内容)", html: "<p>无内容</p>" };
		log(`[dry-run] 主题: ${digest.subject}；不改状态、不发信`);
		return { emailed: false, subject: digest.subject, items: items.length, html: digest.html };
	}

	let subject = "";
	let html: string | undefined;
	if (items.length > 0) {
		const digest = buildDigest(items, nowMs());
		subject = digest.subject;
		html = digest.html;
		await h.send(subject, digest.html, buildText(items));
	}

	// 投递成功后才记状态 —— 失败时这些帖子下次还会被处理，不会丢
	// lastRun 记「本次定时触发时刻」而非完成时刻：cron 每小时整点触发，若记完成时刻
	// （含抓取/AI/发信耗时），下一小时的触发会差几十秒不满 INTERVAL_MINUTES 而被跳过，实际变成每两小时一次。
	const next: PipelineState = {
		sent: [...state.sent, ...fresh.map((p) => p.postUrl)].slice(-STATE_MAX),
		lastRun: new Date(opts.scheduledAt ?? nowMs()).toISOString(),
	};
	await h.saveState(next);
	log(`状态已保存（累计 ${next.sent.length} 条已推送）`);
	return { emailed: items.length > 0, subject: subject || undefined, items: items.length, html };
}

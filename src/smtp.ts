// 自定义 SMTP 发信：跑在 Cloudflare Worker 的 TCP sockets 上。
//
// 端口说明：25 被 Worker 禁止出站；465 走隐式 TLS；587 走 STARTTLS。
// 协议逻辑是纯函数 + 可注入的连接接口，可单元测试；真正的 socket 接线在 index.ts。

export type SmtpMode = "implicit-tls" | "starttls" | "plain";

export interface SmtpResponse {
	code: number;
	text: string;
}

export interface SmtpConnection {
	readResponse(): Promise<SmtpResponse>;
	writeLine(line: string): Promise<void>;
	writeData(data: string): Promise<void>;
	upgradeTls(): Promise<void>;
	close(): Promise<void>;
}

export interface SmtpDialer {
	dial(host: string, port: number, mode: SmtpMode): Promise<SmtpConnection>;
}

export interface SmtpAccount {
	host: string;
	port: number;
	user: string;
	pass: string;
	mailTo: string;
}

export function smtpModeForPort(port: number): SmtpMode {
	if (port === 465) return "implicit-tls";
	if (port === 587) return "starttls";
	return "plain";
}

function base64Utf8(s: string): string {
	const bytes = new TextEncoder().encode(s);
	let bin = "";
	for (let i = 0; i < bytes.length; i += 0x8000) {
		bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	}
	return btoa(bin);
}

function wrap76(s: string): string {
	const out: string[] = [];
	for (let i = 0; i < s.length; i += 76) out.push(s.slice(i, i + 76));
	return out.join("\r\n");
}

function dotStuff(data: string): string {
	return data
		.split("\r\n")
		.map((line) => (line.startsWith(".") ? "." + line : line))
		.join("\r\n");
}

export function buildSmtpMessage(from: string, to: string, subject: string, text: string, html: string): string {
	const boundary = `LET-${crypto.randomUUID().replace(/-/g, "")}`;
	return [
		`From: ${from}`,
		`To: ${to}`,
		`Subject: =?UTF-8?B?${base64Utf8(subject)}?=`,
		`Date: ${new Date().toUTCString()}`,
		"MIME-Version: 1.0",
		`Content-Type: multipart/alternative; boundary="${boundary}"`,
		"",
		`--${boundary}`,
		"Content-Type: text/plain; charset=utf-8",
		"Content-Transfer-Encoding: base64",
		"",
		wrap76(base64Utf8(text)),
		`--${boundary}`,
		"Content-Type: text/html; charset=utf-8",
		"Content-Transfer-Encoding: base64",
		"",
		wrap76(base64Utf8(html)),
		`--${boundary}--`,
		"",
	].join("\r\n");
}

function check(resp: SmtpResponse, codes: number[], stage: string, failHint?: string): void {
	if (!codes.includes(resp.code)) {
		throw new Error(`SMTP ${stage}失败: ${resp.code} ${resp.text.slice(0, 200)}${failHint ?? ""}`);
	}
}

async function command(conn: SmtpConnection, line: string, codes: number[], stage: string, failHint?: string): Promise<SmtpResponse> {
	await conn.writeLine(line);
	const resp = await conn.readResponse();
	check(resp, codes, stage, failHint);
	return resp;
}

async function sendEhlo(conn: SmtpConnection): Promise<Record<string, true>> {
	const resp = await command(conn, "EHLO let-monitor", [250], "问候");
	const exts: Record<string, true> = {};
	for (const raw of resp.text.split("\n")) {
		// readResponse 已剥掉 "250-"/"250 " 前缀，这里是纯扩展名（如 "STARTTLS"、"AUTH LOGIN PLAIN"）。
		const name = raw.trim().split(/[\s=]/)[0]?.toUpperCase();
		if (name) exts[name] = true;
	}
	return exts;
}

export async function sendSmtpMail(
	subject: string,
	htmlBody: string,
	textBody: string,
	acct: SmtpAccount,
	dial: SmtpDialer,
	log: (msg: string) => void = () => {},
): Promise<void> {
	if (acct.port === 25) {
		throw new Error("SMTP 25 端口被 Cloudflare Worker 禁止出站，请用 465（隐式 TLS）或 587（STARTTLS）");
	}
	if (!acct.host || !acct.user || !acct.pass || !acct.mailTo) {
		throw new Error("SMTP 配置不完整，需要 host / user / pass / mailTo");
	}
	const mode = smtpModeForPort(acct.port);
	const conn = await dial.dial(acct.host, acct.port, mode);
	try {
		check(await conn.readResponse(), [220], "连接问候");
		let exts = await sendEhlo(conn);
		if (mode === "starttls" || (mode === "plain" && exts["STARTTLS"] === true)) {
			if (exts["STARTTLS"] !== true) {
				throw new Error("SMTP 服务器不支持 STARTTLS，587 端口要求加密连接");
			}
			await command(conn, "STARTTLS", [220], "STARTTLS");
			await conn.upgradeTls();
			exts = await sendEhlo(conn);
		}
		await command(conn, "AUTH LOGIN", [334], "认证");
		await command(conn, base64Utf8(acct.user), [334], "用户名");
		await command(
			conn,
			base64Utf8(acct.pass),
			[235],
			"密码",
			"（用户名或授权码错误；QQ 邮箱请用授权码而非登录密码）",
		);
		await command(conn, `MAIL FROM:<${acct.user}>`, [250], "发件人");
		await command(conn, `RCPT TO:<${acct.mailTo}>`, [250, 251], "收件人");
		await command(conn, "DATA", [354], "DATA");
		const message = buildSmtpMessage(acct.user, acct.mailTo, subject, textBody, htmlBody);
		await conn.writeData(dotStuff(message) + "\r\n.\r\n");
		check(await conn.readResponse(), [250], "正文投递");
		try {
			await command(conn, "QUIT", [221, 250], "退出");
		} catch {
			// 退出失败不影响投递结果。
		}
		log(`邮件已发送（SMTP）→ ${acct.mailTo}`);
	} finally {
		try {
			await conn.close();
		} catch {
			// 关闭失败可忽略。
		}
	}
}

import { describe, expect, it } from "vitest";
import {
	buildSmtpMessage,
	sendSmtpMail,
	smtpModeForPort,
	type SmtpConnection,
	type SmtpResponse,
} from "../src/smtp";

function resp(code: number, text = ""): SmtpResponse {
	return { code, text };
}

class FakeConn implements SmtpConnection {
	written: string[] = [];
	data: string[] = [];
	upgraded = false;
	closed = false;
	constructor(private script: SmtpResponse[]) {}

	async readResponse(): Promise<SmtpResponse> {
		const next = this.script.shift();
		if (!next) throw new Error("script exhausted");
		return next;
	}

	async writeLine(line: string): Promise<void> {
		this.written.push(line);
	}

	async writeData(data: string): Promise<void> {
		this.data.push(data);
	}

	async upgradeTls(): Promise<void> {
		this.upgraded = true;
	}

	async close(): Promise<void> {
		this.closed = true;
	}
}

function ehloCaps(...caps: string[]): string {
	return [`smtp.example.com greets you`, ...caps].join("\n");
}

const acct = { host: "smtp.qq.com", port: 465, user: "me@qq.com", pass: "authcode", mailTo: "to@example.com" };
const quiet = () => {};

describe("smtpModeForPort", () => {
	it("465 隐式 TLS，587 STARTTLS，其余明文", () => {
		expect(smtpModeForPort(465)).toBe("implicit-tls");
		expect(smtpModeForPort(587)).toBe("starttls");
		expect(smtpModeForPort(25)).toBe("plain");
	});
});

describe("buildSmtpMessage", () => {
	it("multipart/alternative，主题与正文 base64", () => {
		const msg = buildSmtpMessage("me@qq.com", "to@example.com", "主题", "纯文本", "<p>h</p>");
		expect(msg).toContain("Content-Type: multipart/alternative");
		expect(msg).toContain("Content-Type: text/plain; charset=utf-8");
		expect(msg).toContain("Content-Type: text/html; charset=utf-8");
		expect(msg).not.toContain("主题");
	});
});

describe("sendSmtpMail 465", () => {
	it("完整 AUTH LOGIN 流程并投递", async () => {
		const conn = new FakeConn([
			resp(220, "ready"),
			resp(250, ehloCaps("PIPELINING", "AUTH LOGIN PLAIN")),
			resp(334, "Username:"),
			resp(334, "Password:"),
			resp(235, "ok"),
			resp(250, "ok"),
			resp(250, "ok"),
			resp(354, "go ahead"),
			resp(250, "queued"),
			resp(221, "bye"),
		]);
		let seen: { host: string; port: number; mode: string } | null = null;
		await sendSmtpMail(
			"s",
			"<p>h</p>",
			"t",
			acct,
			{
				dial: async (host, port, mode) => {
					seen = { host, port, mode };
					return conn;
				},
			},
			quiet,
		);
		expect(seen).toEqual({ host: "smtp.qq.com", port: 465, mode: "implicit-tls" });
		expect(conn.written[0]).toBe("EHLO let-monitor");
		expect(conn.written).toContain("AUTH LOGIN");
		expect(conn.written).toContain("MAIL FROM:<me@qq.com>");
		expect(conn.written).toContain("RCPT TO:<to@example.com>");
		expect(conn.written).toContain("DATA");
		expect(conn.written).toContain("QUIT");
		expect(conn.data).toHaveLength(1);
		expect(conn.closed).toBe(true);
		expect(conn.upgraded).toBe(false);
	});

	it("25 端口直接拒绝", async () => {
		const conn = new FakeConn([]);
		await expect(
			sendSmtpMail("s", "h", "t", { ...acct, port: 25 }, { dial: async () => conn }, quiet),
		).rejects.toThrow(/25/);
	});

	it("密码错误时提示授权码", async () => {
		const conn = new FakeConn([
			resp(220, "ready"),
			resp(250, ehloCaps("AUTH LOGIN")),
			resp(334, "Username:"),
			resp(334, "Password:"),
			resp(535, "auth failed"),
		]);
		await expect(sendSmtpMail("s", "h", "t", acct, { dial: async () => conn }, quiet)).rejects.toThrow(
			/授权码/,
		);
	});
});

describe("sendSmtpMail 587 STARTTLS", () => {
	it("先明文问候再升级", async () => {
		const conn = new FakeConn([
			resp(220, "ready"),
			resp(250, ehloCaps("STARTTLS")),
			resp(220, "ready for tls"),
			resp(250, ehloCaps("AUTH LOGIN")),
			resp(334, "Username:"),
			resp(334, "Password:"),
			resp(235, "ok"),
			resp(250, "ok"),
			resp(250, "ok"),
			resp(354, "go ahead"),
			resp(250, "queued"),
			resp(221, "bye"),
		]);
		let mode = "";
		await sendSmtpMail(
			"s",
			"h",
			"t",
			{ ...acct, port: 587 },
			{
				dial: async (_h, _p, m) => {
					mode = m;
					return conn;
				},
			},
			quiet,
		);
		expect(mode).toBe("starttls");
		expect(conn.upgraded).toBe(true);
		expect(conn.written).toContain("STARTTLS");
	});

	it("不支持 STARTTLS 时报错", async () => {
		const conn = new FakeConn([resp(220, "ready"), resp(250, ehloCaps("PIPELINING"))]);
		await expect(
			sendSmtpMail("s", "h", "t", { ...acct, port: 587 }, { dial: async () => conn }, quiet),
		).rejects.toThrow(/STARTTLS/);
	});
});

describe("sendSmtpMail 多行响应", () => {
	it("EHLO 多行能解析出扩展", async () => {
		const conn = new FakeConn([
			resp(220, "ready"),
			resp(250, ["hello", "PIPELINING", "AUTH LOGIN PLAIN"].join("\n")),
			resp(334, "Username:"),
			resp(334, "Password:"),
			resp(235, "ok"),
			resp(250, "ok"),
			resp(250, "ok"),
			resp(354, "go ahead"),
			resp(250, "queued"),
			resp(221, "bye"),
		]);
		await sendSmtpMail("s", "h", "t", acct, { dial: async () => conn }, quiet);
		expect(conn.written).toContain("AUTH LOGIN");
	});
});

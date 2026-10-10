// cloudflare:sockets 的真实拨号实现。协议逻辑在 ./smtp.ts，这里只负责字节流接线。

import { connect } from "cloudflare:sockets";
import type { SmtpConnection, SmtpDialer, SmtpMode, SmtpResponse } from "./smtp";

const SMTP_IO_TIMEOUT_MS = 60_000;

async function withTimeout<T>(task: Promise<T>, ms: number, label: string): Promise<T> {
	const { promise, reject } = Promise.withResolvers<T>();
	const timer = setTimeout(() => reject(new Error(`${label}超时`)), ms);
	try {
		return await Promise.race([task, promise]);
	} finally {
		clearTimeout(timer);
	}
}

class LiveConnection implements SmtpConnection {
	private reader: ReadableStreamDefaultReader<Uint8Array>;
	private writer: WritableStreamDefaultWriter<Uint8Array>;
	private pending = "";
	private decoder = new TextDecoder();

	constructor(private socket: Socket) {
		this.reader = socket.readable.getReader() as ReadableStreamDefaultReader<Uint8Array>;
		this.writer = socket.writable.getWriter() as WritableStreamDefaultWriter<Uint8Array>;
	}

	private async nextLine(): Promise<string | null> {
		for (;;) {
			const nl = this.pending.indexOf("\r\n");
			if (nl >= 0) {
				const line = this.pending.slice(0, nl);
				this.pending = this.pending.slice(nl + 2);
				return line;
			}
			let chunk: { value?: Uint8Array; done: boolean };
			try {
				chunk = (await withTimeout(
					this.reader.read() as Promise<{ value?: Uint8Array; done: boolean }>,
					SMTP_IO_TIMEOUT_MS,
					"SMTP 读取",
				)) as { value?: Uint8Array; done: boolean };
			} catch (exc) {
				throw new Error(`SMTP 读取失败: ${exc instanceof Error ? exc.message : String(exc)}`);
			}
			if (chunk.done) {
				if (this.pending.length === 0) return null;
				const rest = this.pending;
				this.pending = "";
				return rest;
			}
			this.pending += this.decoder.decode(chunk.value ?? new Uint8Array(0), { stream: true });
		}
	}

	async readResponse(): Promise<SmtpResponse> {
		const lines: string[] = [];
		for (;;) {
			const line = await this.nextLine();
			if (line === null) throw new Error("SMTP 连接被服务端关闭");
			lines.push(line);
			// 多行响应：只有 "250<空格>" 才是最后一行，"250-" 表示还有后续。
			if (/^\d{3} /.test(line)) break;
			if (lines.length > 64) throw new Error("SMTP 响应行数过多");
		}
		const code = parseInt(lines[0]?.slice(0, 3) ?? "", 10);
		if (!Number.isInteger(code)) throw new Error(`SMTP 响应码非法: ${lines[0]?.slice(0, 80)}`);
		return { code, text: lines.map((l) => l.slice(4)).join("\n") };
	}

	async writeLine(line: string): Promise<void> {
		try {
			await withTimeout(
				this.writer.write(new TextEncoder().encode(line + "\r\n")),
				SMTP_IO_TIMEOUT_MS,
				"SMTP 写入",
			);
		} catch (exc) {
			throw new Error(`SMTP 写入失败: ${exc instanceof Error ? exc.message : String(exc)}`);
		}
	}

	async writeData(data: string): Promise<void> {
		// DATA 正文可能较大，分块写入避免单次过大。
		for (let i = 0; i < data.length; i += 65536) {
			try {
				await withTimeout(
					this.writer.write(new TextEncoder().encode(data.slice(i, i + 65536))),
					SMTP_IO_TIMEOUT_MS,
					"SMTP 写入",
				);
			} catch (exc) {
				throw new Error(`SMTP 写入失败: ${exc instanceof Error ? exc.message : String(exc)}`);
			}
		}
	}

	async upgradeTls(): Promise<void> {
		try {
			this.reader.releaseLock();
		} catch {
			// 未持有锁时忽略。
		}
		try {
			this.writer.releaseLock();
		} catch {
			// 未持有锁时忽略。
		}
		const tls = this.socket.startTls();
		await tls.opened;
		this.socket = tls;
		this.reader = tls.readable.getReader() as ReadableStreamDefaultReader<Uint8Array>;
		this.writer = tls.writable.getWriter() as WritableStreamDefaultWriter<Uint8Array>;
	}

	async close(): Promise<void> {
		try {
			this.reader.releaseLock();
		} catch {
			// 已关闭时忽略。
		}
		try {
			this.writer.releaseLock();
		} catch {
			// 已关闭时忽略。
		}
		await this.socket.close();
	}
}

export class SocketDialer implements SmtpDialer {
	async dial(host: string, port: number, mode: SmtpMode): Promise<SmtpConnection> {
		const secureTransport = mode === "implicit-tls" ? "on" : mode === "starttls" ? "starttls" : "off";
		const socket = connect({ hostname: host, port }, { secureTransport, allowHalfOpen: false });
		try {
			await socket.opened;
		} catch (exc) {
			throw new Error(`SMTP 连接 ${host}:${port} 失败: ${exc instanceof Error ? exc.message : String(exc)}`);
		}
		return new LiveConnection(socket);
	}
}

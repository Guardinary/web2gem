export type ByteChunk = Uint8Array<ArrayBufferLike>;

export type SocketConnectOptions = {
	secureTransport: "on" | "off";
	allowHalfOpen: false;
};

export type SocketAddress = { hostname: string; port: number };

export type SocketLike = {
	readable: ReadableStream<ByteChunk>;
	writable: WritableStream<ByteChunk>;
	close?: () => void;
};

export type SocketConnect = (
	address: SocketAddress,
	options: SocketConnectOptions,
) => SocketLike;

export type SocketPool = {
	idle: Map<string, IdleSocket[]>;
};

export type IdleSocket = {
	socket: SocketLike;
	expiresAt: number;
};

export type SocketHttpOptions = {
	method?: string;
	headers?: Record<string, string>;
	body?: unknown;
	bodyLength?: number | null | undefined;
	timeoutMs?: number;
	signal?: AbortSignal | null | undefined;
	keepAlive?: boolean;
	pool?: SocketPool | null | undefined;
	acceptCompressed?: boolean;
};

export type SocketHttpResponse = {
	status: number;
	ok: boolean;
	headers: Headers;
	body: ReadableStream<Uint8Array>;
	text: () => Promise<string>;
};

export type ByteQueue = {
	readonly length: number;
	push(chunk: ByteChunk | null | undefined): void;
	read(n: unknown): ByteChunk;
	readLine(): ByteChunk | null;
	readLineIfAvailable(): ByteChunk | null;
	readHttpChunkSizeLineIfAvailable(): {
		size: number;
		errorLine: string;
	} | null;
	skipCRLF(): boolean;
	drain(controller: ReadableStreamDefaultController<ByteChunk>): void;
};

export type SocketTimeoutScope = {
	wait<T>(promise: PromiseLike<T> | T, stage?: unknown): Promise<T>;
	clear(): void;
};

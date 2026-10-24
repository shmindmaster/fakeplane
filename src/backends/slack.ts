import { ApiError, type JsonObject } from "../types.js";
import type { Backend, HttpRoute, Operation, OpContext, TurnInjection, World } from "../world.js";
import { IDEMPOTENCY_KEY, int, obj, required, str } from "./common.js";

export interface SlackMessage {
  type: "message";
  channel: string;
  user?: string;
  bot_id?: string;
  text: string;
  ts: string;
  thread_ts?: string;
  blocks?: unknown;
  reactions?: { name: string; users: string[]; count: number }[];
  edited?: { user: string; ts: string };
}

export interface SlackSeed {
  bot_user_id?: string;
  users?: { id: string; name: string; real_name?: string; email?: string; is_bot?: boolean }[];
  channels?: { id: string; name: string; is_private?: boolean }[];
  messages?: (Partial<SlackMessage> & { channel: string; text: string })[];
}

export class SlackBackend implements Backend {
  readonly name = "slack";
  readonly mounts = [
    { prefix: "/slack", strip: true },
    { prefix: "/api", strip: false },
  ];
  private channels = new Map<string, { id: string; name: string; is_private: boolean; messages: SlackMessage[] }>();
  private users = new Map<string, { id: string; name: string; real_name?: string; email?: string; is_bot?: boolean }>();
  private botUserId: string;

  constructor(
    private readonly world: World,
    seed: SlackSeed = {},
  ) {
    this.botUserId = seed.bot_user_id ?? "UBOT";
    this.users.set(this.botUserId, { id: this.botUserId, name: "agent-bot", is_bot: true });
    for (const u of seed.users ?? []) this.users.set(u.id, { ...u });
    for (const c of seed.channels ?? []) this.channels.set(c.id, { id: c.id, name: c.name.replace(/^#/, ""), is_private: c.is_private ?? false, messages: [] });
    for (const m of seed.messages ?? []) {
      const ch = this.channel(m.channel);
      ch.messages.push({ ...m, type: "message", channel: ch.id, text: m.text, ts: m.ts ?? this.nextTs() });
    }
  }

  private nextTs(): string {
    const seconds = Math.floor(this.world.nowMs() / 1000);
    return `${seconds}.${String(this.world.next("slack.ts")).padStart(6, "0")}`;
  }

  private channel(idOrName: unknown) {
    const key = String(idOrName ?? "").replace(/^#/, "");
    const ch = this.channels.get(key) ?? [...this.channels.values()].find((c) => c.name === key);
    if (!ch) throw new ApiError(404, "channel_not_found", `Channel ${String(idOrName)} not found`);
    return ch;
  }

  private findMessage(channel: unknown, ts: unknown) {
    const ch = this.channel(channel);
    const msg = ch.messages.find((m) => m.ts === String(ts));
    if (!msg) throw new ApiError(404, "message_not_found", `Message ${String(ts)} not found`);
    return { ch, msg };
  }

  private post(ctx: OpContext, input: JsonObject) {
    const ch = this.channel(required(input, "channel"));
    const text = input.text === undefined ? "" : String(input.text);
    const blocks = typeof input.blocks === "string" ? safeJson(input.blocks) : input.blocks;
    if (!text && !blocks) throw new ApiError(400, "no_text", "text or blocks is required");
    const threadTs = input.thread_ts ? String(input.thread_ts) : undefined;
    if (threadTs && !ch.messages.some((m) => m.ts === threadTs)) throw new ApiError(404, "thread_not_found", `Thread ${threadTs} not found`);
    const msg: SlackMessage = { type: "message", channel: ch.id, user: this.botUserId, bot_id: "BAGENT", text, ts: this.nextTs(), ...(threadTs ? { thread_ts: threadTs } : {}), ...(blocks ? { blocks } : {}) };
    ch.messages.push(msg);
    ctx.effect("slack.message.post", { channel: ch.id, channel_name: ch.name, text, thread_ts: threadTs, blocks, ts: msg.ts }, `channel:${ch.id}`);
    return { ok: true, channel: ch.id, ts: msg.ts, message: { ...msg } };
  }

  operations(): Operation[] {
    const b = "slack";
    return [
      {
        id: "slack.chat.postMessage",
        backend: b,
        write: true,
        tool: {
          name: "slack_post_message",
          description: "Post a message to a Slack channel, or reply in a thread with thread_ts.",
          inputSchema: obj(
            { channel: str("Channel id or name"), text: str("Message text"), thread_ts: str("Parent message ts to reply in thread"), idempotency_key: IDEMPOTENCY_KEY },
            ["channel", "text"],
          ),
        },
        run: (input: JsonObject, ctx) => this.post(ctx, input),
      },
      {
        id: "slack.chat.update",
        backend: b,
        write: true,
        tool: {
          name: "slack_update_message",
          description: "Edit a message the bot posted.",
          inputSchema: obj({ channel: str("Channel id"), ts: str("Message ts"), text: str("New text"), idempotency_key: IDEMPOTENCY_KEY }, ["channel", "ts", "text"]),
        },
        run: (input: JsonObject, ctx) => {
          const { ch, msg } = this.findMessage(required(input, "channel"), required(input, "ts"));
          if (msg.user !== this.botUserId) throw new ApiError(403, "cant_update_message", "Only messages posted by the bot can be edited");
          const before = msg.text;
          msg.text = String(required(input, "text"));
          msg.edited = { user: this.botUserId, ts: this.nextTs() };
          ctx.effect("slack.message.update", { channel: ch.id, ts: msg.ts, text: msg.text, previous_text: before }, `channel:${ch.id}`);
          return { ok: true, channel: ch.id, ts: msg.ts, text: msg.text };
        },
      },
      {
        id: "slack.conversations.history",
        backend: b,
        write: false,
        tool: {
          name: "slack_get_history",
          description: "Read recent top-level messages in a channel, newest first.",
          inputSchema: obj({ channel: str("Channel id or name"), limit: int("Max messages (default 100)") }, ["channel"]),
        },
        run: (input: JsonObject) => {
          const ch = this.channel(required(input, "channel"));
          const limit = Number(input.limit ?? 100);
          const top = ch.messages.filter((m) => !m.thread_ts || m.thread_ts === m.ts);
          return { ok: true, messages: [...top].reverse().slice(0, limit).map((m) => ({ ...m, reply_count: ch.messages.filter((r) => r.thread_ts === m.ts && r.ts !== m.ts).length })), has_more: top.length > limit };
        },
      },
      {
        id: "slack.conversations.replies",
        backend: b,
        write: false,
        tool: {
          name: "slack_get_thread",
          description: "Read a thread: the parent message and its replies, oldest first.",
          inputSchema: obj({ channel: str("Channel id or name"), ts: str("Parent message ts") }, ["channel", "ts"]),
        },
        run: (input: JsonObject) => {
          const { ch, msg } = this.findMessage(required(input, "channel"), required(input, "ts"));
          return { ok: true, messages: [msg, ...ch.messages.filter((m) => m.thread_ts === msg.ts && m.ts !== msg.ts)].map((m) => ({ ...m })), has_more: false };
        },
      },
      {
        id: "slack.conversations.list",
        backend: b,
        write: false,
        tool: { name: "slack_list_channels", description: "List channels.", inputSchema: obj({}) },
        run: () => ({ ok: true, channels: [...this.channels.values()].map((c) => ({ id: c.id, name: c.name, is_private: c.is_private })) }),
      },
      {
        id: "slack.reactions.add",
        backend: b,
        write: true,
        tool: {
          name: "slack_add_reaction",
          description: "Add an emoji reaction to a message.",
          inputSchema: obj({ channel: str("Channel id"), timestamp: str("Message ts"), name: str("Emoji name without colons"), idempotency_key: IDEMPOTENCY_KEY }, ["channel", "timestamp", "name"]),
        },
        run: (input: JsonObject, ctx) => {
          const { ch, msg } = this.findMessage(required(input, "channel"), required(input, "timestamp", "ts"));
          const name = String(required(input, "name")).replace(/:/g, "");
          msg.reactions ??= [];
          const existing = msg.reactions.find((r) => r.name === name);
          if (existing?.users.includes(this.botUserId)) throw new ApiError(400, "already_reacted", "Already reacted with this emoji");
          if (existing) {
            existing.users.push(this.botUserId);
            existing.count += 1;
          } else msg.reactions.push({ name, users: [this.botUserId], count: 1 });
          ctx.effect("slack.reaction.add", { channel: ch.id, ts: msg.ts, name }, `channel:${ch.id}`);
          return { ok: true };
        },
      },
      {
        id: "slack.users.info",
        backend: b,
        write: false,
        tool: { name: "slack_get_user", description: "Get a Slack user's profile.", inputSchema: obj({ user: str("User id") }, ["user"]) },
        run: (input: JsonObject) => {
          const u = this.users.get(String(required(input, "user")));
          if (!u) throw new ApiError(404, "user_not_found", `User ${String(input.user)} not found`);
          return { ok: true, user: { ...u, profile: { real_name: u.real_name ?? u.name, email: u.email } } };
        },
      },
    ];
  }

  routes(): HttpRoute[] {
    const methods: [string, string][] = [
      ["chat.postMessage", "slack.chat.postMessage"],
      ["chat.update", "slack.chat.update"],
      ["conversations.history", "slack.conversations.history"],
      ["conversations.replies", "slack.conversations.replies"],
      ["conversations.list", "slack.conversations.list"],
      ["reactions.add", "slack.reactions.add"],
      ["users.info", "slack.users.info"],
    ];
    return methods.flatMap(([method, op]) =>
      ["GET", "POST"].map((verb) => ({
        method: verb,
        path: `/api/${method}`,
        op,
        toInput: (r: { query: Record<string, string>; body: unknown }) => ({ ...r.query, ...((r.body as JsonObject) ?? {}) }),
      })),
    );
  }

  errorResponse(err: ApiError) {
    if (err.status === 429) return { status: 429, body: { ok: false, error: "ratelimited" }, headers: { "Retry-After": String(err.retryAfter ?? 1) } };
    if (err.status >= 500) return { status: err.status, body: { ok: false, error: err.code } };
    // Slack reports API errors with HTTP 200 and ok:false.
    return { status: 200, body: { ok: false, error: err.code } };
  }

  injectTurn(turn: TurnInjection, { deliveryId }: { world: World; deliveryId: string }): JsonObject {
    const ch = this.channel(turn.channel ?? [...this.channels.keys()][0]);
    const user = String(turn.user ?? "UCUSTOMER");
    if (!this.users.has(user)) this.users.set(user, { id: user, name: user.toLowerCase() });
    const msg: SlackMessage = { type: "message", channel: ch.id, user, text: String(turn.text ?? ""), ts: this.nextTs(), ...(turn.thread_ts ? { thread_ts: String(turn.thread_ts) } : {}) };
    ch.messages.push(msg);
    return { type: "event_callback", event_id: deliveryId, event: { ...msg, type: turn.mention ? "app_mention" : "message" } };
  }

  seededSensitiveValues(): string[] {
    return [...this.users.values()].flatMap((u) => (u.email ? [u.email] : []));
  }

  snapshot() {
    const channels: Record<string, unknown> = {};
    for (const [id, c] of this.channels) channels[id] = { ...c, messages: c.messages.map((m) => ({ ...m })) };
    return { channels, users: Object.fromEntries([...this.users].map(([id, u]) => [id, { ...u }])) };
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

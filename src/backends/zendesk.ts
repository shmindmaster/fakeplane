import { ApiError, type JsonObject } from "../types.js";
import type { Backend, HttpRoute, Operation, OpContext, TurnInjection, World } from "../world.js";
import { IDEMPOTENCY_KEY, bool, idSchema, obj, optionalString, required, str, strList, stringList } from "./common.js";

export interface ZendeskUser {
  id: number;
  name: string;
  email?: string;
  phone?: string;
  role?: "end-user" | "agent" | "admin";
  [key: string]: unknown;
}

export interface ZendeskComment {
  id: number;
  type: "Comment";
  author_id: number;
  body: string;
  public: boolean;
  created_at: string;
}

export interface ZendeskTicket {
  id: number;
  subject: string;
  description: string;
  status: string;
  priority: string | null;
  type: string | null;
  tags: string[];
  requester_id: number | null;
  assignee_id: number | null;
  group_id: number | null;
  custom_fields: { id: number | string; value: unknown }[];
  created_at: string;
  updated_at: string;
  comments: ZendeskComment[];
  [key: string]: unknown;
}

export interface ZendeskSeed {
  /** User id the agent writes as. Default 1. */
  agent_user_id?: number;
  users?: Partial<ZendeskUser>[];
  groups?: { id: number; name: string }[];
  /** Ticket fields as in the Zendesk API, plus optional inline `requester` and `comments`. */
  tickets?: Record<string, any>[];
}

const STATUSES = ["new", "open", "pending", "hold", "solved", "closed"];
const PRIORITIES = ["low", "normal", "high", "urgent"];

export class ZendeskBackend implements Backend {
  readonly name = "zendesk";
  readonly mounts = [
    { prefix: "/zendesk", strip: true },
    { prefix: "/api/v2", strip: false },
  ];
  private tickets = new Map<number, ZendeskTicket>();
  private users = new Map<number, ZendeskUser>();
  private groups = new Map<number, { id: number; name: string }>();
  private agentUserId: number;

  constructor(
    private readonly world: World,
    seed: ZendeskSeed = {},
  ) {
    this.agentUserId = seed.agent_user_id ?? 1;
    this.users.set(this.agentUserId, { id: this.agentUserId, name: "Support Agent", role: "agent", email: "agent@support.example" });
    for (const u of seed.users ?? []) this.upsertUser(u);
    for (const g of seed.groups ?? []) this.groups.set(g.id, g);
    for (const t of seed.tickets ?? []) {
      const requesterId = t.requester ? this.upsertUser(t.requester).id : (t.requester_id ?? null);
      const id = Number(t.id ?? this.world.next("zendesk.ticket"));
      this.world.bumpCounter("zendesk.ticket", id);
      const now = world.now();
      const seedComments: Record<string, any>[] = t.comments ?? (t.description ? [{ body: String(t.description) }] : []);
      const comments = seedComments.map((c) => ({
        id: Number(c.id ?? this.world.next("zendesk.comment", 1000)),
        type: "Comment" as const,
        author_id: Number(c.author_id ?? requesterId ?? this.agentUserId),
        body: String(c.body),
        public: c.public ?? true,
        created_at: c.created_at ?? now,
      }));
      const { requester: _r, comments: _c, ...rest } = t;
      this.tickets.set(id, {
        ...rest,
        id,
        subject: t.subject ?? "",
        description: t.description ?? comments[0]?.body ?? "",
        status: t.status ?? "open",
        priority: t.priority ?? null,
        type: t.type ?? null,
        tags: t.tags ?? [],
        requester_id: requesterId,
        assignee_id: t.assignee_id ?? null,
        group_id: t.group_id ?? null,
        custom_fields: t.custom_fields ?? [],
        created_at: t.created_at ?? now,
        updated_at: t.updated_at ?? now,
        comments,
      });
    }
  }

  private upsertUser(u: Partial<ZendeskUser>): ZendeskUser {
    const existing = u.email ? [...this.users.values()].find((x) => x.email === u.email) : undefined;
    const id = Number(u.id ?? existing?.id ?? this.world.next("zendesk.user", 100));
    this.world.bumpCounter("zendesk.user", id);
    const user: ZendeskUser = { role: "end-user", ...existing, ...u, id, name: u.name ?? existing?.name ?? u.email ?? `User ${id}` };
    this.users.set(id, user);
    return user;
  }

  private ticket(idValue: unknown): ZendeskTicket {
    const id = Number(idValue);
    const t = this.tickets.get(id);
    if (!t) throw new ApiError(404, "RecordNotFound", `Ticket ${String(idValue)} not found`);
    return t;
  }

  private view(t: ZendeskTicket): JsonObject {
    const { comments: _c, ...rest } = t;
    return { ...rest, tags: [...t.tags] };
  }

  private addComment(ctx: OpContext, t: ZendeskTicket, body: string, isPublic: boolean): ZendeskComment {
    if (t.status === "closed") throw new ApiError(422, "RecordInvalid", "Status: closed prevents ticket update");
    const comment: ZendeskComment = {
      id: this.world.next("zendesk.comment", 1000),
      type: "Comment",
      author_id: this.agentUserId,
      body,
      public: isPublic,
      created_at: ctx.now(),
    };
    t.comments.push(comment);
    t.updated_at = ctx.now();
    ctx.effect(isPublic ? "zendesk.ticket.reply" : "zendesk.ticket.note", { ticket_id: t.id, body, public: isPublic, comment_id: comment.id }, `ticket:${t.id}`);
    return comment;
  }

  private applyUpdate(ctx: OpContext, t: ZendeskTicket, input: JsonObject): JsonObject {
    if (t.status === "closed") throw new ApiError(422, "RecordInvalid", "Status: closed prevents ticket update");
    const changes: JsonObject = {};
    const set = (field: keyof ZendeskTicket, value: unknown) => {
      const before = t[field];
      if (JSON.stringify(before) !== JSON.stringify(value)) {
        changes[field as string] = { from: before, to: value };
        (t as any)[field] = value;
      }
    };
    if (input.status !== undefined) {
      const status = String(input.status);
      if (!STATUSES.includes(status)) throw new ApiError(422, "RecordInvalid", `Status: ${status} is not valid`, { details: { allowed: STATUSES } });
      set("status", status);
    }
    if (input.priority !== undefined) {
      const priority = input.priority === null ? null : String(input.priority);
      if (priority !== null && !PRIORITIES.includes(priority)) throw new ApiError(422, "RecordInvalid", `Priority: ${priority} is not valid`);
      set("priority", priority);
    }
    if (input.type !== undefined) set("type", input.type);
    if (input.subject !== undefined) set("subject", String(input.subject));
    if (input.assignee_id !== undefined) set("assignee_id", input.assignee_id === null ? null : Number(input.assignee_id));
    if (input.group_id !== undefined) {
      const gid = input.group_id === null ? null : Number(input.group_id);
      if (gid !== null && this.groups.size > 0 && !this.groups.has(gid)) throw new ApiError(422, "RecordInvalid", `Group ${gid} does not exist`);
      set("group_id", gid);
    }
    if (input.tags !== undefined) set("tags", [...new Set(stringList(input.tags))]);
    if (input.additional_tags !== undefined || input.add_tags !== undefined) {
      set("tags", [...new Set([...t.tags, ...stringList(input.additional_tags ?? input.add_tags)])]);
    }
    if (input.remove_tags !== undefined) {
      const remove = new Set(stringList(input.remove_tags));
      set("tags", t.tags.filter((x) => !remove.has(x)));
    }
    if (input.custom_fields !== undefined) set("custom_fields", input.custom_fields);
    if (Object.keys(changes).length > 0) {
      t.updated_at = ctx.now();
      ctx.effect("zendesk.ticket.update", { ticket_id: t.id, changes, status: t.status, tags: [...t.tags] }, `ticket:${t.id}`);
    }
    return changes;
  }

  operations(): Operation[] {
    const b = "zendesk";
    return [
      {
        id: "zendesk.ticket.list",
        backend: b,
        write: false,
        tool: {
          name: "zendesk_list_tickets",
          description: "List support tickets, optionally filtered by status.",
          inputSchema: obj({ status: str("Filter by status", { enum: STATUSES }) }),
        },
        run: (input: JsonObject = {}) =>
          [...this.tickets.values()].filter((t) => !input.status || t.status === input.status).map((t) => this.view(t)),
      },
      {
        id: "zendesk.ticket.get",
        backend: b,
        write: false,
        tool: {
          name: "zendesk_get_ticket",
          description: "Get a support ticket by id.",
          inputSchema: obj({ ticket_id: idSchema("Ticket id") }, ["ticket_id"]),
        },
        run: (input: JsonObject) => this.view(this.ticket(required(input, "ticket_id", "id"))),
      },
      {
        id: "zendesk.ticket.comments",
        backend: b,
        write: false,
        tool: {
          name: "zendesk_get_comments",
          description: "List the comments (public replies and internal notes) on a ticket, oldest first.",
          inputSchema: obj({ ticket_id: idSchema("Ticket id") }, ["ticket_id"]),
        },
        run: (input: JsonObject) => this.ticket(required(input, "ticket_id", "id")).comments.map((c) => ({ ...c })),
      },
      {
        id: "zendesk.ticket.create",
        backend: b,
        write: true,
        tool: {
          name: "zendesk_create_ticket",
          description: "Create a support ticket.",
          inputSchema: obj(
            {
              subject: str("Subject"),
              body: str("First comment / description"),
              requester_email: str("Requester email"),
              priority: str("Priority", { enum: PRIORITIES }),
              tags: strList("Tags"),
              idempotency_key: IDEMPOTENCY_KEY,
            },
            ["subject", "body"],
          ),
        },
        run: (input: JsonObject, ctx) => {
          const subject = String(required(input, "subject"));
          const body = String(required(input, "body", "description"));
          const requester = input.requester_email ? this.upsertUser({ email: String(input.requester_email) }) : undefined;
          const id = this.world.next("zendesk.ticket");
          const t: ZendeskTicket = {
            id,
            subject,
            description: body,
            status: input.status ? String(input.status) : "new",
            priority: optionalString(input.priority) ?? null,
            type: null,
            tags: stringList(input.tags),
            requester_id: requester?.id ?? (input.requester_id ? Number(input.requester_id) : null),
            assignee_id: null,
            group_id: null,
            custom_fields: [],
            created_at: ctx.now(),
            updated_at: ctx.now(),
            comments: [{ id: this.world.next("zendesk.comment", 1000), type: "Comment", author_id: this.agentUserId, body, public: true, created_at: ctx.now() }],
          };
          this.tickets.set(id, t);
          ctx.effect("zendesk.ticket.create", { ticket_id: id, subject, body, requester_email: input.requester_email, tags: t.tags, priority: t.priority }, "tickets");
          return this.view(t);
        },
      },
      {
        id: "zendesk.ticket.update",
        backend: b,
        write: true,
        tool: {
          name: "zendesk_update_ticket",
          description:
            "Update ticket fields (status, priority, assignee, group, tags) and optionally add a comment. Setting tags replaces the full tag list.",
          inputSchema: obj(
            {
              ticket_id: idSchema("Ticket id"),
              status: str("New status", { enum: STATUSES }),
              priority: str("Priority", { enum: PRIORITIES }),
              assignee_id: idSchema("Assignee user id"),
              group_id: idSchema("Group id"),
              tags: strList("Replace all tags"),
              add_tags: strList("Tags to add"),
              remove_tags: strList("Tags to remove"),
              comment: obj({ body: str("Comment text"), public: bool("Public reply (true) or internal note (false). Default true.") }, ["body"]),
              idempotency_key: IDEMPOTENCY_KEY,
            },
            ["ticket_id"],
          ),
        },
        run: (input: JsonObject, ctx) => {
          const t = this.ticket(required(input, "ticket_id", "id"));
          const comment = input.comment as JsonObject | undefined;
          if (comment && !comment.body && !comment.html_body) throw new ApiError(422, "RecordInvalid", "Comment: body is required");
          if (t.status === "closed") throw new ApiError(422, "RecordInvalid", "Status: closed prevents ticket update");
          if (input.status !== undefined && !STATUSES.includes(String(input.status))) {
            throw new ApiError(422, "RecordInvalid", `Status: ${String(input.status)} is not valid`, { details: { allowed: STATUSES } });
          }
          if (input.priority != null && !PRIORITIES.includes(String(input.priority))) {
            throw new ApiError(422, "RecordInvalid", `Priority: ${String(input.priority)} is not valid`);
          }
          let added: ZendeskComment | undefined;
          if (comment) added = this.addComment(ctx, t, String(comment.body ?? comment.html_body), comment.public !== false);
          const changes = this.applyUpdate(ctx, t, input);
          return { ticket: this.view(t), changes, comment: added };
        },
      },
      {
        id: "zendesk.ticket.add_comment",
        backend: b,
        write: true,
        tool: {
          name: "zendesk_add_comment",
          description: "Add a comment to a ticket. public=true sends a reply to the customer; public=false is an internal note.",
          inputSchema: obj(
            { ticket_id: idSchema("Ticket id"), body: str("Comment text"), public: bool("Default true"), idempotency_key: IDEMPOTENCY_KEY },
            ["ticket_id", "body"],
          ),
        },
        run: (input: JsonObject, ctx) => {
          const t = this.ticket(required(input, "ticket_id", "id"));
          return this.addComment(ctx, t, String(required(input, "body", "message", "comment")), input.public !== false && input.is_public !== false);
        },
      },
      {
        id: "zendesk.ticket.add_tags",
        backend: b,
        write: true,
        tool: {
          name: "zendesk_add_tags",
          description: "Add tags to a ticket, keeping existing tags.",
          inputSchema: obj({ ticket_id: idSchema("Ticket id"), tags: strList("Tags to add"), idempotency_key: IDEMPOTENCY_KEY }, ["ticket_id", "tags"]),
        },
        run: (input: JsonObject, ctx) => {
          const t = this.ticket(required(input, "ticket_id", "id"));
          this.applyUpdate(ctx, t, { add_tags: required(input, "tags", "tag") });
          return { tags: [...t.tags] };
        },
      },
      {
        id: "zendesk.ticket.remove_tags",
        backend: b,
        write: true,
        tool: {
          name: "zendesk_remove_tags",
          description: "Remove tags from a ticket.",
          inputSchema: obj({ ticket_id: idSchema("Ticket id"), tags: strList("Tags to remove"), idempotency_key: IDEMPOTENCY_KEY }, ["ticket_id", "tags"]),
        },
        run: (input: JsonObject, ctx) => {
          const t = this.ticket(required(input, "ticket_id", "id"));
          this.applyUpdate(ctx, t, { remove_tags: required(input, "tags", "tag") });
          return { tags: [...t.tags] };
        },
      },
      {
        id: "zendesk.search",
        backend: b,
        write: false,
        tool: {
          name: "zendesk_search",
          description: 'Search tickets. Supports `status:open`, `tags:refund`, `requester:email` and free text, e.g. "status:open refund".',
          inputSchema: obj({ query: str("Search query") }, ["query"]),
        },
        run: (input: JsonObject) => this.search(String(required(input, "query"))),
      },
      {
        id: "zendesk.user.get",
        backend: b,
        write: false,
        tool: {
          name: "zendesk_get_user",
          description: "Get a user (customer or agent) by id.",
          inputSchema: obj({ user_id: idSchema("User id") }, ["user_id"]),
        },
        run: (input: JsonObject) => {
          const u = this.users.get(Number(required(input, "user_id", "id")));
          if (!u) throw new ApiError(404, "RecordNotFound", `User ${String(input.user_id)} not found`);
          return { ...u };
        },
      },
    ];
  }

  private search(query: string): JsonObject[] {
    const terms = query.split(/\s+/).filter(Boolean);
    return [...this.tickets.values()]
      .filter((t) =>
        terms.every((term) => {
          const [k, v] = term.includes(":") ? (term.split(/:(.*)/s) as [string, string]) : ["", term];
          switch (k) {
            case "type":
              return v === "ticket";
            case "status":
              return t.status === v;
            case "tags":
            case "tag":
              return t.tags.includes(v);
            case "requester": {
              const u = t.requester_id ? this.users.get(t.requester_id) : undefined;
              return u?.email === v || String(u?.id) === v;
            }
            default: {
              const hay = [t.subject, t.description, ...t.comments.map((c) => c.body)].join(" ").toLowerCase();
              return hay.includes(v.toLowerCase());
            }
          }
        }),
      )
      .map((t) => ({ ...this.view(t), result_type: "ticket" }));
  }

  routes(): HttpRoute[] {
    const body = (req: { body: any }) => (req.body?.ticket ?? req.body ?? {}) as JsonObject;
    return [
      { method: "GET", path: "/api/v2/tickets", op: "zendesk.ticket.list", toInput: (r) => ({ status: r.query.status }), toResponse: (res: any) => ({ body: { tickets: res, count: res.length, next_page: null, previous_page: null } }) },
      { method: "GET", path: "/api/v2/tickets/:id", op: "zendesk.ticket.get", toInput: (r) => ({ ticket_id: r.params.id }), toResponse: (res) => ({ body: { ticket: res } }) },
      { method: "GET", path: "/api/v2/tickets/:id/comments", op: "zendesk.ticket.comments", toInput: (r) => ({ ticket_id: r.params.id }), toResponse: (res: any) => ({ body: { comments: res, count: res.length, next_page: null, previous_page: null } }) },
      {
        method: "POST",
        path: "/api/v2/tickets",
        op: "zendesk.ticket.create",
        toInput: (r) => {
          const t = body(r);
          const comment = t.comment as JsonObject | undefined;
          const requester = t.requester as JsonObject | undefined;
          return { subject: t.subject, body: comment?.body ?? comment?.html_body ?? t.description, requester_email: requester?.email, requester_id: t.requester_id, priority: t.priority, tags: t.tags, status: t.status };
        },
        toResponse: (res) => ({ status: 201, body: { ticket: res } }),
      },
      {
        method: "PUT",
        path: "/api/v2/tickets/:id",
        op: "zendesk.ticket.update",
        toInput: (r) => ({ ...body(r), ticket_id: r.params.id }),
        toResponse: (res: any) => ({ body: { ticket: res.ticket, audit: { events: Object.keys(res.changes).map((field) => ({ type: "Change", field_name: field, value: res.changes[field].to, previous_value: res.changes[field].from })) } } }),
      },
      { method: "PUT", path: "/api/v2/tickets/:id/tags", op: "zendesk.ticket.add_tags", toInput: (r) => ({ ticket_id: r.params.id, tags: r.body?.tags }) },
      { method: "DELETE", path: "/api/v2/tickets/:id/tags", op: "zendesk.ticket.remove_tags", toInput: (r) => ({ ticket_id: r.params.id, tags: r.body?.tags ?? r.query.tags }) },
      { method: "GET", path: "/api/v2/search", op: "zendesk.search", toInput: (r) => ({ query: r.query.query }), toResponse: (res: any) => ({ body: { results: res, count: res.length, next_page: null, previous_page: null } }) },
      { method: "GET", path: "/api/v2/users/:id", op: "zendesk.user.get", toInput: (r) => ({ user_id: r.params.id }), toResponse: (res) => ({ body: { user: res } }) },
    ];
  }

  errorResponse(err: ApiError) {
    const code = err.status === 404 ? "RecordNotFound" : err.status === 422 ? "RecordInvalid" : err.status === 429 ? "APIRateLimitExceeded" : err.code;
    const headers: Record<string, string> = err.retryAfter !== undefined ? { "Retry-After": String(err.retryAfter) } : {};
    return { status: err.status, body: { error: code, description: err.message, ...(err.details ? { details: err.details } : {}) }, headers };
  }

  injectTurn(turn: TurnInjection, { deliveryId }: { world: World; deliveryId: string }): JsonObject {
    const text = String(turn.text ?? "");
    let t = turn.ticket !== undefined ? this.tickets.get(Number(turn.ticket)) : undefined;
    if (!t) {
      const requester = turn.from ? this.upsertUser(typeof turn.from === "string" ? { email: turn.from } : (turn.from as Partial<ZendeskUser>)) : undefined;
      const id = turn.ticket !== undefined ? Number(turn.ticket) : this.world.next("zendesk.ticket");
      this.world.bumpCounter("zendesk.ticket", id);
      t = {
        id,
        subject: String(turn.subject ?? text.slice(0, 60)),
        description: text,
        status: "new",
        priority: null,
        type: null,
        tags: stringList(turn.tags),
        requester_id: requester?.id ?? null,
        assignee_id: null,
        group_id: null,
        custom_fields: [],
        created_at: this.world.now(),
        updated_at: this.world.now(),
        comments: [],
      };
      this.tickets.set(id, t);
    }
    const comment: ZendeskComment = {
      id: this.world.next("zendesk.comment", 1000),
      type: "Comment",
      author_id: t.requester_id ?? 0,
      body: text,
      public: true,
      created_at: this.world.now(),
    };
    t.comments.push(comment);
    if (t.status === "pending" || t.status === "solved") t.status = "open";
    t.updated_at = this.world.now();
    return {
      type: t.comments.length === 1 ? "zendesk.ticket.created" : "zendesk.ticket.comment_added",
      id: deliveryId,
      ticket_id: t.id,
      comment: { ...comment },
      ticket: this.view(t),
    };
  }

  seededSensitiveValues(): string[] {
    return [...this.users.values()].filter((u) => u.role !== "agent").flatMap((u) => [u.email, u.phone].filter((v): v is string => !!v));
  }

  snapshot() {
    const tickets: Record<string, unknown> = {};
    for (const [id, t] of this.tickets) tickets[id] = { ...t, tags: [...t.tags], comments: t.comments.map((c) => ({ ...c })) };
    const users: Record<string, unknown> = {};
    for (const [id, u] of this.users) users[id] = { ...u };
    return { tickets, users, groups: Object.fromEntries([...this.groups].map(([id, g]) => [id, { ...g }])) };
  }
}
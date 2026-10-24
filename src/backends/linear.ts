import { ApiError, type JsonObject } from "../types.js";
import type { Backend, DispatchResult, HttpReply, HttpRequestInfo, HttpRoute, Operation, OpContext, TurnInjection, World } from "../world.js";
import { IDEMPOTENCY_KEY, int, obj, required, str, strList, stringList } from "./common.js";
import { GraphQLSyntaxError, parseOperation, project } from "./graphql.js";

interface Team {
  id: string;
  key: string;
  name: string;
}
interface State {
  id: string;
  name: string;
  type: "backlog" | "unstarted" | "started" | "completed" | "canceled" | "triage";
  teamId: string;
}
interface User {
  id: string;
  name: string;
  email?: string;
}
interface Label {
  id: string;
  name: string;
}
interface Comment {
  id: string;
  body: string;
  userId: string;
  createdAt: string;
}
interface Issue {
  id: string;
  identifier: string;
  number: number;
  title: string;
  description: string;
  priority: number;
  teamId: string;
  stateId: string;
  assigneeId: string | null;
  labelIds: string[];
  comments: Comment[];
  createdAt: string;
  updatedAt: string;
}

export interface LinearSeed {
  teams?: Partial<Team>[];
  users?: User[];
  states?: (Partial<State> & { name: string; team?: string })[];
  labels?: (Partial<Label> & { name: string })[];
  issues?: {
    id?: string;
    identifier?: string;
    team?: string;
    title: string;
    description?: string;
    priority?: number;
    state?: string;
    assignee?: string;
    labels?: string[];
    comments?: { body: string; user?: string }[];
  }[];
}

const PRIORITY_LABELS = ["No priority", "Urgent", "High", "Medium", "Low"];
const DEFAULT_STATES: [string, State["type"]][] = [
  ["Backlog", "backlog"],
  ["Todo", "unstarted"],
  ["In Progress", "started"],
  ["Done", "completed"],
  ["Canceled", "canceled"],
];

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_");

export class LinearBackend implements Backend {
  readonly name = "linear";
  readonly mounts = [
    { prefix: "/linear", strip: true },
    { prefix: "/graphql", strip: false },
  ];
  private teams = new Map<string, Team>();
  private states = new Map<string, State>();
  private users = new Map<string, User>();
  private labels = new Map<string, Label>();
  private issues = new Map<string, Issue>();
  private readonly botId = "user_agent";

  constructor(
    private readonly world: World,
    seed: LinearSeed = {},
  ) {
    this.users.set(this.botId, { id: this.botId, name: "Agent", email: "agent@support.example" });
    for (const u of seed.users ?? []) this.users.set(u.id, { ...u });
    const teams = seed.teams?.length ? seed.teams : [{ key: "ENG", name: "Engineering" }];
    for (const t of teams) {
      const key = String(t.key ?? "ENG").toUpperCase();
      const team: Team = { id: t.id ?? `team_${key.toLowerCase()}`, key, name: t.name ?? key };
      this.teams.set(team.id, team);
    }
    for (const team of this.teams.values()) {
      const custom = (seed.states ?? []).filter((s) => !s.team || this.findTeam(s.team)?.id === team.id);
      const list = custom.length ? custom.map((s) => [s.name, s.type ?? "unstarted"] as [string, State["type"]]) : DEFAULT_STATES;
      for (const [name, type] of list) {
        const id = `state_${team.key.toLowerCase()}_${slug(name)}`;
        this.states.set(id, { id, name, type, teamId: team.id });
      }
    }
    for (const l of seed.labels ?? []) {
      const id = l.id ?? `label_${slug(l.name)}`;
      this.labels.set(id, { id, name: l.name });
    }
    for (const i of seed.issues ?? []) {
      const team = i.team ? this.team(i.team) : [...this.teams.values()][0];
      const number = i.identifier ? Number(i.identifier.split("-")[1]) : this.world.next(`linear.${team.key}`);
      this.world.bumpCounter(`linear.${team.key}`, number);
      const identifier = `${team.key}-${number}`;
      const now = world.now();
      this.issues.set(identifier, {
        id: i.id ?? `issue_${identifier.toLowerCase().replace("-", "_")}`,
        identifier,
        number,
        title: i.title,
        description: i.description ?? "",
        priority: i.priority ?? 0,
        teamId: team.id,
        stateId: this.state(team, i.state ?? "Todo").id,
        assigneeId: i.assignee ? this.user(i.assignee).id : null,
        labelIds: (i.labels ?? []).map((n) => this.label(n).id),
        comments: (i.comments ?? []).map((c) => ({
          id: `comment_${this.world.next("linear.comment")}`,
          body: c.body,
          userId: c.user ? this.user(c.user).id : this.botId,
          createdAt: now,
        })),
        createdAt: now,
        updatedAt: now,
      });
    }
  }

  private findTeam(ref: string): Team | undefined {
    return this.teams.get(ref) ?? [...this.teams.values()].find((t) => t.key.toLowerCase() === ref.toLowerCase() || t.name.toLowerCase() === ref.toLowerCase());
  }
  private team(ref: unknown): Team {
    const t = this.findTeam(String(ref));
    if (!t) throw new ApiError(400, "InvalidInput", `Team ${String(ref)} not found`);
    return t;
  }
  private state(team: Team, ref: unknown): State {
    const key = String(ref).toLowerCase();
    const s =
      this.states.get(String(ref)) ??
      [...this.states.values()].find((x) => x.teamId === team.id && (x.name.toLowerCase() === key || x.type === key));
    if (!s || s.teamId !== team.id) throw new ApiError(400, "InvalidInput", `Workflow state ${String(ref)} not found in team ${team.key}`);
    return s;
  }
  private user(ref: unknown): User {
    const key = String(ref).toLowerCase();
    const u = this.users.get(String(ref)) ?? [...this.users.values()].find((x) => x.email?.toLowerCase() === key || x.name.toLowerCase() === key);
    if (!u) throw new ApiError(400, "InvalidInput", `User ${String(ref)} not found`);
    return u;
  }
  private label(ref: string): Label {
    const existing = this.labels.get(ref) ?? [...this.labels.values()].find((l) => l.name.toLowerCase() === ref.toLowerCase());
    if (existing) return existing;
    const l = { id: `label_${slug(ref)}`, name: ref };
    this.labels.set(l.id, l);
    return l;
  }
  private issue(ref: unknown): Issue {
    const key = String(ref);
    const i = this.issues.get(key.toUpperCase()) ?? [...this.issues.values()].find((x) => x.id === key);
    if (!i) throw new ApiError(404, "EntityNotFound", `Issue ${key} not found`);
    return i;
  }

  private view(i: Issue): JsonObject {
    const team = this.teams.get(i.teamId)!;
    const state = this.states.get(i.stateId)!;
    const assignee = i.assigneeId ? this.users.get(i.assigneeId) : undefined;
    return {
      __typename: "Issue",
      id: i.id,
      identifier: i.identifier,
      number: i.number,
      title: i.title,
      description: i.description,
      priority: i.priority,
      priorityLabel: PRIORITY_LABELS[i.priority] ?? "No priority",
      url: `https://linear.example/issue/${i.identifier}`,
      createdAt: i.createdAt,
      updatedAt: i.updatedAt,
      team: { __typename: "Team", ...team },
      state: { __typename: "WorkflowState", id: state.id, name: state.name, type: state.type },
      assignee: assignee ? { __typename: "User", ...assignee } : null,
      labels: { nodes: i.labelIds.map((id) => ({ __typename: "IssueLabel", ...this.labels.get(id)! })) },
      comments: { nodes: i.comments.map((c) => this.commentView(c)) },
    };
  }

  private commentView(c: Comment): JsonObject {
    const u = this.users.get(c.userId);
    return { __typename: "Comment", id: c.id, body: c.body, createdAt: c.createdAt, user: u ? { __typename: "User", ...u } : null };
  }

  private applyFields(i: Issue, team: Team, input: JsonObject): JsonObject {
    const changes: JsonObject = {};
    const set = <K extends keyof Issue>(k: K, v: Issue[K]) => {
      if (JSON.stringify(i[k]) !== JSON.stringify(v)) {
        changes[k] = { from: i[k], to: v };
        i[k] = v;
      }
    };
    if (input.title !== undefined) set("title", String(input.title));
    if (input.description !== undefined) set("description", String(input.description));
    if (input.priority !== undefined) {
      const p = Number(input.priority);
      if (!Number.isInteger(p) || p < 0 || p > 4) throw new ApiError(400, "InvalidInput", "priority must be an integer 0-4");
      set("priority", p);
    }
    if (input.state !== undefined) set("stateId", this.state(team, input.state).id);
    if (input.assignee !== undefined) set("assigneeId", input.assignee === null ? null : this.user(input.assignee).id);
    if (input.labels !== undefined) set("labelIds", stringList(input.labels).map((n) => this.label(n).id));
    if (input.add_labels !== undefined) set("labelIds", [...new Set([...i.labelIds, ...stringList(input.add_labels).map((n) => this.label(n).id)])]);
    return changes;
  }

  operations(): Operation[] {
    const b = "linear";
    return [
      {
        id: "linear.issue.create",
        backend: b,
        write: true,
        tool: {
          name: "linear_create_issue",
          description: "Create an issue in a Linear team.",
          inputSchema: obj(
            {
              team: str("Team key, name or id"),
              title: str("Title"),
              description: str("Markdown description"),
              priority: int("0 none, 1 urgent, 2 high, 3 medium, 4 low"),
              state: str("Workflow state name or id"),
              assignee: str("User id, email or name"),
              labels: strList("Label names"),
              idempotency_key: IDEMPOTENCY_KEY,
            },
            ["team", "title"],
          ),
        },
        run: (input: JsonObject, ctx: OpContext) => {
          const team = this.team(required(input, "team", "teamId"));
          const number = this.world.next(`linear.${team.key}`);
          const identifier = `${team.key}-${number}`;
          const issue: Issue = {
            id: `issue_${team.key.toLowerCase()}_${number}`,
            identifier,
            number,
            title: String(required(input, "title")),
            description: "",
            priority: 0,
            teamId: team.id,
            stateId: this.state(team, input.state ?? "Todo").id,
            assigneeId: null,
            labelIds: [],
            comments: [],
            createdAt: ctx.now(),
            updatedAt: ctx.now(),
          };
          this.applyFields(issue, team, { ...input, title: undefined, state: undefined });
          this.issues.set(identifier, issue);
          const view = this.view(issue);
          ctx.effect("linear.issue.create", { identifier, team: team.key, title: issue.title, description: issue.description, priority: issue.priority, state: (view.state as JsonObject).name, labels: stringList(input.labels) }, `team:${team.key}`);
          return view;
        },
      },
      {
        id: "linear.issue.update",
        backend: b,
        write: true,
        tool: {
          name: "linear_update_issue",
          description: "Update an issue's title, description, priority, state, assignee or labels.",
          inputSchema: obj(
            {
              issue: str("Issue identifier (ENG-12) or id"),
              title: str("Title"),
              description: str("Description"),
              priority: int("0-4"),
              state: str("Workflow state name or id"),
              assignee: str("User id, email or name"),
              labels: strList("Replace labels"),
              add_labels: strList("Labels to add"),
              idempotency_key: IDEMPOTENCY_KEY,
            },
            ["issue"],
          ),
        },
        run: (input: JsonObject, ctx: OpContext) => {
          const issue = this.issue(required(input, "issue", "id"));
          const changes = this.applyFields(issue, this.teams.get(issue.teamId)!, input);
          if (Object.keys(changes).length) {
            issue.updatedAt = ctx.now();
            const view = this.view(issue);
            ctx.effect("linear.issue.update", { identifier: issue.identifier, changes, state: (view.state as JsonObject).name }, `issue:${issue.identifier}`);
          }
          return this.view(issue);
        },
      },
      {
        id: "linear.comment.create",
        backend: b,
        write: true,
        tool: {
          name: "linear_add_comment",
          description: "Comment on an issue.",
          inputSchema: obj({ issue: str("Issue identifier or id"), body: str("Markdown body"), idempotency_key: IDEMPOTENCY_KEY }, ["issue", "body"]),
        },
        run: (input: JsonObject, ctx: OpContext) => {
          const issue = this.issue(required(input, "issue", "issueId"));
          const c: Comment = { id: `comment_${this.world.next("linear.comment")}`, body: String(required(input, "body")), userId: this.botId, createdAt: ctx.now() };
          issue.comments.push(c);
          issue.updatedAt = ctx.now();
          ctx.effect("linear.comment.create", { identifier: issue.identifier, body: c.body }, `issue:${issue.identifier}`);
          return { ...this.commentView(c), issue: { id: issue.id, identifier: issue.identifier } };
        },
      },
      {
        id: "linear.issue.get",
        backend: b,
        write: false,
        tool: { name: "linear_get_issue", description: "Get an issue with its comments.", inputSchema: obj({ issue: str("Issue identifier or id") }, ["issue"]) },
        run: (input: JsonObject) => this.view(this.issue(required(input, "issue", "id"))),
      },
      {
        id: "linear.issue.list",
        backend: b,
        write: false,
        tool: {
          name: "linear_list_issues",
          description: "List issues, optionally filtered by team, state, assignee or text query.",
          inputSchema: obj({ team: str("Team key"), state: str("State name or type"), assignee: str("User id, email or name"), query: str("Text in title or description"), limit: int("Max results (default 50)") }),
        },
        run: (input: JsonObject = {}) => {
          let list = [...this.issues.values()];
          if (input.team) list = list.filter((i) => i.teamId === this.team(input.team).id);
          if (input.state) {
            const k = String(input.state).toLowerCase();
            list = list.filter((i) => {
              const s = this.states.get(i.stateId)!;
              return s.name.toLowerCase() === k || s.type === k || s.id === input.state;
            });
          }
          if (input.assignee) list = list.filter((i) => i.assigneeId === this.user(input.assignee).id);
          if (input.query) {
            const q = String(input.query).toLowerCase();
            list = list.filter((i) => `${i.title} ${i.description}`.toLowerCase().includes(q));
          }
          return list.slice(0, Number(input.limit ?? 50)).map((i) => this.view(i));
        },
      },
      {
        id: "linear.team.list",
        backend: b,
        write: false,
        tool: { name: "linear_list_teams", description: "List teams and their workflow states.", inputSchema: obj({}) },
        run: () =>
          [...this.teams.values()].map((t) => ({
            __typename: "Team",
            ...t,
            states: { nodes: [...this.states.values()].filter((s) => s.teamId === t.id).map(({ teamId: _t, ...s }) => ({ __typename: "WorkflowState", ...s })) },
          })),
      },
    ];
  }

  routes(): HttpRoute[] {
    return [];
  }

  async handleHttp(req: HttpRequestInfo, dispatch: (op: string, input: unknown) => Promise<DispatchResult>): Promise<HttpReply | undefined> {
    if (req.method !== "POST" || !/^\/graphql\/?$/.test(req.path)) return undefined;
    const { query, variables, operationName } = (req.body ?? {}) as { query?: string; variables?: Record<string, unknown>; operationName?: string };
    if (typeof query !== "string") return { status: 400, body: { errors: [{ message: "Must provide query string", extensions: { code: "GRAPHQL_PARSE_FAILED" } }] } };
    let op;
    try {
      op = parseOperation(query, variables ?? {}, operationName);
    } catch (err) {
      if (err instanceof GraphQLSyntaxError) return { status: 400, body: { errors: [{ message: `Syntax Error: ${err.message}`, extensions: { code: "GRAPHQL_PARSE_FAILED" } }] } };
      throw err;
    }
    const data: Record<string, unknown> = {};
    const errors: unknown[] = [];
    for (const field of op.fields) {
      const key = field.alias ?? field.name;
      const mapped = this.mapField(op.type, field.name, field.args);
      if (!mapped) {
        if (field.name === "__typename") {
          data[key] = op.type === "mutation" ? "Mutation" : "Query";
          continue;
        }
        return { status: 400, body: { errors: [{ message: `Cannot query field "${field.name}" on type "${op.type === "mutation" ? "Mutation" : "Query"}". fakeplane supports: ${SUPPORTED.join(", ")}`, extensions: { code: "GRAPHQL_VALIDATION_FAILED" } }] } };
      }
      const res = await dispatch(mapped.op, mapped.input);
      if (res.drop) return { status: 0, body: null, drop: true };
      if (res.error && (res.status === 429 || res.status >= 500)) {
        return res.status === 429
          ? { status: 400, body: { errors: [{ message: res.error.message, extensions: { code: "RATELIMITED", type: "Ratelimited" } }] }, headers: { "Retry-After": String(res.error.retryAfter ?? 1) } }
          : { status: res.status, body: { errors: [{ message: res.error.message, extensions: { code: "INTERNAL_SERVER_ERROR" } }] } };
      }
      if (res.error) {
        data[key] = null;
        errors.push({ message: res.error.message, path: [key], extensions: { code: res.error.code === "EntityNotFound" ? "ENTITY_NOT_FOUND" : "INVALID_INPUT", type: res.error.code } });
        continue;
      }
      data[key] = project(mapped.wrap(res.output), field.selection);
    }
    return { status: 200, body: errors.length ? { data, errors } : { data } };
  }

  private mapField(type: string, name: string, args: Record<string, any>): { op: string; input: JsonObject; wrap: (o: unknown) => unknown } | undefined {
    const conn = (o: unknown) => ({ nodes: o, pageInfo: { hasNextPage: false, endCursor: null } });
    const success = (field: string) => (o: unknown) => ({ success: true, lastSyncId: this.world.calls.length, [field]: o });
    const fromInput = (inp: Record<string, any> = {}) => ({
      team: inp.teamId,
      title: inp.title,
      description: inp.description,
      priority: inp.priority,
      state: inp.stateId,
      assignee: inp.assigneeId,
      labels: inp.labelIds,
    });
    if (type === "mutation") {
      if (name === "issueCreate") return { op: "linear.issue.create", input: fromInput(args.input), wrap: success("issue") };
      if (name === "issueUpdate") return { op: "linear.issue.update", input: { issue: args.id, ...fromInput(args.input) }, wrap: success("issue") };
      if (name === "commentCreate") return { op: "linear.comment.create", input: { issue: args.input?.issueId, body: args.input?.body }, wrap: success("comment") };
      return undefined;
    }
    if (name === "issue") return { op: "linear.issue.get", input: { issue: args.id }, wrap: (o) => o };
    if (name === "issues" || name === "searchIssues" || name === "issueSearch") {
      const f = args.filter ?? {};
      return {
        op: "linear.issue.list",
        input: {
          team: f.team?.key?.eq ?? f.team?.id?.eq,
          state: f.state?.name?.eq ?? f.state?.type?.eq ?? f.state?.id?.eq,
          assignee: f.assignee?.id?.eq ?? f.assignee?.email?.eq,
          query: args.term ?? args.query,
          limit: args.first,
        },
        wrap: conn,
      };
    }
    if (name === "teams") return { op: "linear.team.list", input: {}, wrap: conn };
    if (name === "viewer") return { op: "linear.team.list", input: {}, wrap: () => ({ __typename: "User", ...this.users.get(this.botId) }) };
    return undefined;
  }

  errorResponse(err: ApiError) {
    if (err.status === 429) return { status: 400, body: { errors: [{ message: err.message, extensions: { code: "RATELIMITED" } }] }, headers: { "Retry-After": String(err.retryAfter ?? 1) } };
    return { status: err.status, body: { errors: [{ message: err.message, extensions: { code: err.code } }] } };
  }

  injectTurn(turn: TurnInjection, { deliveryId }: { world: World; deliveryId: string }): JsonObject {
    if (turn.issue) {
      const issue = this.issue(turn.issue);
      const user = turn.user ? this.user(turn.user) : [...this.users.values()].find((u) => u.id !== this.botId) ?? this.users.get(this.botId)!;
      const c: Comment = { id: `comment_${this.world.next("linear.comment")}`, body: String(turn.text ?? ""), userId: user.id, createdAt: this.world.now() };
      issue.comments.push(c);
      return { type: "Comment", action: "create", webhookId: deliveryId, data: { ...this.commentView(c), issue: { id: issue.id, identifier: issue.identifier } } };
    }
    const team = turn.team ? this.team(turn.team) : [...this.teams.values()][0];
    const number = this.world.next(`linear.${team.key}`);
    const identifier = `${team.key}-${number}`;
    const issue: Issue = {
      id: `issue_${team.key.toLowerCase()}_${number}`,
      identifier,
      number,
      title: String(turn.title ?? String(turn.text ?? "").slice(0, 60)),
      description: String(turn.text ?? ""),
      priority: 0,
      teamId: team.id,
      stateId: this.state(team, "Todo").id,
      assigneeId: null,
      labelIds: [],
      comments: [],
      createdAt: this.world.now(),
      updatedAt: this.world.now(),
    };
    this.issues.set(identifier, issue);
    return { type: "Issue", action: "create", webhookId: deliveryId, data: this.view(issue) };
  }

  snapshot() {
    const issues: Record<string, unknown> = {};
    for (const [id, i] of this.issues) issues[id] = this.view(i);
    return {
      issues,
      teams: Object.fromEntries([...this.teams].map(([id, t]) => [id, { ...t }])),
      users: Object.fromEntries([...this.users].map(([id, u]) => [id, { ...u }])),
    };
  }
}

const SUPPORTED = ["issue", "issues", "searchIssues", "teams", "viewer", "issueCreate", "issueUpdate", "commentCreate"];

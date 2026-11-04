/**
 * Group "automations": the shared graph module (src/lib/workflow-graph.ts, plan A1) and, as the tasks land, the store,
 * the engine, the sender and the scheduler. No network, no model, a fixed clock.
 */
import { formatUsd } from "../../src/lib/format";
import {
  CONFIG_SCHEMAS,
  GRAPH_MAX_EDGES,
  GRAPH_MAX_NODES,
  NODE_SPECS,
  NODE_TYPES,
  evaluateCondition,
  nextNodeId,
  renderTemplate,
  summarizeStep,
  templateVars,
  topoOrder,
  validateGraph,
  type Condition,
  type Graph,
  type GraphEdge,
  type GraphNode,
  type NodeType,
  type Vars,
} from "../../src/lib/workflow-graph";
import type { Check } from "./harness";

/* ---- builders ---- */

const node = (id: string, type: NodeType, name: string, x: number, y: number, config?: unknown): GraphNode => ({
  id,
  type,
  name,
  position: { x, y },
  config: (config ?? NODE_SPECS[type].defaultConfig()) as Record<string, unknown>,
});
const edge = (source: string, sourceHandle: string, target: string): GraphEdge => ({ id: `${source}-${sourceHandle}-${target}`, source, sourceHandle, target });
const graphOf = (nodes: GraphNode[], edges: GraphEdge[]): Graph => ({ nodes, edges });
const messages = (g: unknown, opts?: Parameters<typeof validateGraph>[1]): string[] => validateGraph(g, opts).problems.map((p) => p.message);

/** The three seed automations of plan 7.3 (the store's seed-workflows.ts holds the same graphs). */
export function inlineSeeds(): { route: Graph; chat: Graph; daily: Graph } {
  const route = graphOf(
    [
      node("start", "trigger.run_finished", "When an invoice is decided", 0, 0, { decisions: ["HOLD"], include_errors: false }),
      node("if-security", "logic.if", "Security flag?", 280, 0, { combine: "all", conditions: [{ field: "run.security_flag", op: "is_true", value: null }] }),
      node("assign-security", "action.assign", "Assign to Finance security", 560, -80, { assignee: "Finance security" }),
      node("note-security", "action.note", "Note the reason", 840, -80, { text: "Security review needed before any payment: {{run.first_reason}}" }),
      node("if-large", "logic.if", "Over $5,000?", 560, 80, { combine: "all", conditions: [{ field: "run.total", op: "gt", value: 5000 }] }),
      node("assign-lead", "action.assign", "Assign to AP lead", 840, 40, { assignee: "AP lead" }),
      node("assign-clerk", "action.assign", "Assign to AP clerk", 840, 140, { assignee: "AP clerk" }),
    ],
    [
      edge("start", "out", "if-security"),
      edge("if-security", "true", "assign-security"),
      edge("assign-security", "out", "note-security"),
      edge("if-security", "false", "if-large"),
      edge("if-large", "true", "assign-lead"),
      edge("if-large", "false", "assign-clerk"),
    ],
  );
  const chat = graphOf(
    [
      node("start", "trigger.run_finished", "When an invoice is decided", 0, 0, { decisions: ["REJECT"], include_errors: false }),
      node("chat", "action.chat", "Post to the team chat", 280, 0, { text: "Rejected: {{run.vendor_name}} {{run.invoice_number}} ({{run.total}}). {{run.first_reason}} {{run.url}}" }),
    ],
    [edge("start", "out", "chat")],
  );
  const daily = graphOf(
    [
      node("start", "trigger.schedule", "On a schedule", 0, 0, { every: "day", hour: 8, minute: 0 }),
      node("summarize", "data.summarize", "Summarize holds", 280, 0, { window_hours: 24, decisions: ["HOLD"], max_items: 10 }),
      node("if-any", "logic.if", "Any holds?", 560, 0, { combine: "all", conditions: [{ field: "summary.count", op: "gt", value: 0 }] }),
      node("chat", "action.chat", "Post the summary", 840, 0, { text: "{{summary.count}} invoices on hold in the last {{summary.window_hours}} hours ({{summary.total_value}}):\n{{summary.list}}" }),
    ],
    [edge("start", "out", "summarize"), edge("summarize", "out", "if-any"), edge("if-any", "true", "chat")],
  );
  return { route, chat, daily };
}

/** trigger -> note, to be varied by the tests below. */
const withNote = (text: string, trigger: GraphNode = node("start", "trigger.run_finished", "Start", 0, 0)): Graph =>
  graphOf([trigger, node("note", "action.note", "Note", 280, 0, { text })], [edge(trigger.id, "out", "note")]);

export async function run(t: Check): Promise<void> {
  await t.test("A1: the three seed graphs validate with no problems", () => {
    const seeds = inlineSeeds();
    for (const [name, g] of Object.entries(seeds)) t.eq(messages(g), [], name);
    // with URLs known the webhook-bearing seeds are still valid; without a URL the editor shows the missing one
    t.eq(messages(seeds.chat, { secrets: { chat: { has_url: true } } }), []);
    t.eq(messages(seeds.chat, { secrets: {} }), ["Add the webhook URL."]);
  });

  await t.test("A1: every catalogue entry has a settings schema, a default config that passes it, and labelled outputs", () => {
    for (const type of NODE_TYPES) {
      const spec = NODE_SPECS[type];
      t.eq(spec.type, type);
      t.ok(CONFIG_SCHEMAS[type].safeParse(spec.defaultConfig()).success, `${type}: the default config is valid`);
      t.ok(spec.outputs.length >= 1 && spec.outputs.every((o) => o.id !== "" && o.label !== ""), `${type}: outputs`);
    }
    t.eq(NODE_SPECS["logic.if"].outputs.map((o) => o.id), ["true", "false"]);
    t.eq(NODE_SPECS["logic.switch_decision"].outputs.map((o) => o.id), ["APPROVE", "HOLD", "REJECT", "ERROR"]);
  });

  await t.test("A1: an empty graph has no starting step; two triggers give one problem on the second", () => {
    t.eq(messages({ nodes: [], edges: [] }), ["Add a step that starts the automation."]);
    const two = graphOf([node("start", "trigger.run_finished", "A", 0, 0), node("other", "trigger.schedule", "B", 0, 100)], []);
    const problems = validateGraph(two).problems;
    t.eq(problems.map((p) => [p.node_id, p.message]), [["other", "An automation has exactly one starting step."]]);
  });

  await t.test("A1: a self-loop, a duplicate connection, a bad output and a connection into the trigger each give their message", () => {
    const base = withNote("hello");
    t.includes(messages({ ...base, edges: [...base.edges, edge("note", "out", "note")] }), "A step cannot connect to itself.");
    t.eq(messages({ ...base, edges: [...base.edges, { ...edge("start", "out", "note"), id: "again" }] }), ["These two steps are connected twice."]);
    t.eq(messages({ ...base, edges: [{ ...edge("start", "yes", "note") }] }).includes("This connection leaves from an output the step does not have."), true);
    t.includes(messages({ ...base, edges: [...base.edges, edge("note", "out", "start")] }), "Nothing can lead into the starting step.");
    t.includes(messages({ ...base, edges: [...base.edges, edge("start", "out", "ghost")] }), "A connection points to a step that does not exist.");
  });

  await t.test("A1: a cycle of three logic steps gives the cycle message and topoOrder is null", () => {
    const if1 = (id: string, y: number) => node(id, "logic.if", id, 280, y);
    const g = graphOf(
      [node("start", "trigger.run_finished", "Start", 0, 0), if1("a", 0), if1("b", 100), if1("c", 200)],
      [edge("start", "out", "a"), edge("a", "true", "b"), edge("b", "true", "c"), edge("c", "true", "a")],
    );
    t.eq(topoOrder(g), null);
    t.includes(messages(g), "The steps go round in a circle; remove one connection.");
    t.ok(!messages(withNote("x")).includes("The steps go round in a circle; remove one connection."), "no cycle in a plain graph");
  });

  await t.test("A1: a step the trigger does not reach is reported with its id", () => {
    const g = withNote("hello");
    g.nodes.push(node("lonely", "action.note", "Lonely", 560, 300, { text: "x" }));
    const problems = validateGraph(g).problems;
    t.eq(problems.map((p) => [p.node_id, p.message]), [["lonely", "This step is not connected to the start."]]);
  });

  await t.test("A1: a step that needs an invoice cannot follow a schedule trigger", () => {
    const g = withNote("Done", node("start", "trigger.schedule", "Daily", 0, 0));
    t.eq(messages(g), ["This step needs an invoice, but this automation runs on a schedule."]);
    t.eq(messages(graphOf([node("start", "trigger.schedule", "Daily", 0, 0), node("chat", "action.chat", "Chat", 280, 0, { text: "Hi" })], [edge("start", "out", "chat")])), [], "a chat message needs no invoice");
  });

  await t.test("A1: a value from a lookup is available only when EVERY path to the step went through it", () => {
    const note = (text: string) => node("note", "action.note", "Note", 840, 0, { text });
    t.eq(messages(withNote("Left {{po.remaining}}")), ['{{po.remaining}} is not available here: add "Look up the PO balance" before this step.']);
    const lookup = node("po", "data.po_balance", "PO", 280, 0);
    const straight = graphOf([node("start", "trigger.run_finished", "Start", 0, 0), lookup, note("Left {{po.remaining}}")], [edge("start", "out", "po"), edge("po", "out", "note")]);
    t.eq(messages(straight), [], "after the lookup it is available");
    // two branches merge into the note; only one of them did the lookup
    const branches = graphOf(
      [node("start", "trigger.run_finished", "Start", 0, 0), node("if", "logic.if", "If", 280, 0), lookup, node("skip", "action.assign", "Skip", 560, 140, { assignee: "x" }), note("Left {{po.remaining}}")],
      [edge("start", "out", "if"), edge("if", "true", "po"), edge("if", "false", "skip"), edge("po", "out", "note"), edge("skip", "out", "note")],
    );
    t.eq(messages(branches), ['{{po.remaining}} is not available here: add "Look up the PO balance" before this step.'], "intersection over the paths");
    t.includes(messages(withNote("{{summary.count}}")), 'add "Summarize recent invoices" before this step');
    t.includes(messages(withNote("{{run.total}}", node("start", "trigger.schedule", "Daily", 0, 0))), "it needs an automation that starts from an invoice");
    t.eq(messages(withNote("Reviewed: {{review.comment}}")), ["{{review.comment}} is not available here: it needs an automation that starts from an invoice."], "a review value needs the review trigger");
    t.eq(messages(withNote("Reviewed: {{review.comment}}", node("start", "trigger.review_saved", "Start", 0, 0))), []);
  });

  await t.test("A1: templates render values by type: money, yes/no, nothing for null, text without control characters", () => {
    const vars: Vars = { "run.total": 9900, "run.security_flag": true, "run.bank_change": false, "run.vendor_name": null, "run.reasons": "a\u0000b\u0007c\td\ne\rf\u0085g", "summary.count": 3 };
    t.eq(renderTemplate("Total {{run.total}}", vars, "none").text, `Total ${formatUsd(9900)}`);
    t.eq(renderTemplate("Total {{ run.total }}", vars, "none").text, "Total $9,900.00", "spaces inside the braces are fine");
    t.eq(renderTemplate("{{run.security_flag}}/{{run.bank_change}}", vars, "none").text, "yes/no");
    const none = renderTemplate("[{{run.vendor_name}}]", vars, "none");
    t.eq([none.text, none.missing], ["[]", []], "null is empty and not 'missing'");
    t.eq(renderTemplate("{{run.reasons}}", vars, "none").text, "abc\td\nefg", "control characters go; \\n and \\t stay");
    t.eq(renderTemplate("{{summary.count}} items", vars, "none").text, "3 items");
    const absent = renderTemplate("{{run.nope}} and {{run.id}} and {{run.nope}}", vars, "none");
    t.eq([absent.text, absent.missing], [" and  and ", ["run.nope", "run.id"]], "absent keys are replaced with nothing and listed once each");
    t.eq(templateVars("{{run.total}} {{ run.id }} {{run.total}} {not.a.var} {{Bad.Name}}"), ["run.total", "run.id"]);
  });

  await t.test("A1: escaping for chat changes the substituted value only, never the author's own text", () => {
    const vars: Vars = { "run.vendor_name": "<https://evil.example|Click> & co" };
    const out = renderTemplate("Vendor: {{run.vendor_name}} <https://ok.example|ok>", vars, "slack").text;
    t.eq(out, "Vendor: &lt;https://evil.example|Click&gt; &amp; co <https://ok.example|ok>");
    t.eq(renderTemplate("{{run.vendor_name}}", vars, "none").text, "<https://evil.example|Click> & co", "no escaping for a webhook's JSON");
  });

  await t.test("A1: an unknown value in a template is reported by validateGraph and listed as missing when rendered", () => {
    t.eq(messages(withNote("Hello {{run.nope}}")), ["Unknown value {{run.nope}}."]);
    t.eq(renderTemplate("Hello {{run.nope}}", {}, "none").missing, ["run.nope"]);
  });

  await t.test("A1: evaluateCondition, every operator against an absent value, null, a match and a non-match", () => {
    const c = (field: string, op: Condition["op"], value: Condition["value"]): Condition => ({ field, op, value });
    const cases: [string, Condition, Vars, boolean][] = [
      ["is, match (case and spaces ignored)", c("run.vendor_name", "is", "acme corp"), { "run.vendor_name": " Acme Corp " }, true],
      ["is, no match", c("run.vendor_name", "is", "acme"), { "run.vendor_name": "Acme Corp" }, false],
      ["is, absent", c("run.vendor_name", "is", "acme"), {}, false],
      ["is, null", c("run.vendor_name", "is", "acme"), { "run.vendor_name": null }, false],
      ["is_not, match", c("run.vendor_name", "is_not", "acme"), { "run.vendor_name": "Acme Corp" }, true],
      ["is_not, same", c("run.vendor_name", "is_not", "acme corp"), { "run.vendor_name": "Acme Corp" }, false],
      ["is_not, absent", c("run.vendor_name", "is_not", "acme"), {}, true],
      ["is_not, null", c("run.vendor_name", "is_not", "acme"), { "run.vendor_name": null }, true],
      ["contains, match", c("run.first_reason", "contains", "PO balance"), { "run.first_reason": "Exceeds remaining po balance by $3,000.00." }, true],
      ["contains, no match", c("run.first_reason", "contains", "duplicate"), { "run.first_reason": "Exceeds the PO balance" }, false],
      ["contains, absent", c("run.first_reason", "contains", "x"), {}, false],
      ["contains, null", c("run.first_reason", "contains", "x"), { "run.first_reason": null }, false],
      ["not_contains, no match", c("run.first_reason", "not_contains", "duplicate"), { "run.first_reason": "Exceeds the PO balance" }, true],
      ["not_contains, match", c("run.first_reason", "not_contains", "po balance"), { "run.first_reason": "Exceeds the PO balance" }, false],
      ["not_contains, absent", c("run.first_reason", "not_contains", "x"), {}, true],
      ["not_contains, null", c("run.first_reason", "not_contains", "x"), { "run.first_reason": null }, true],
      ["starts_with, match", c("run.invoice_number", "starts_with", "glx-"), { "run.invoice_number": "GLX-303" }, true],
      ["starts_with, no match", c("run.invoice_number", "starts_with", "inv"), { "run.invoice_number": "GLX-303" }, false],
      ["starts_with, absent", c("run.invoice_number", "starts_with", "g"), {}, false],
      ["starts_with, null", c("run.invoice_number", "starts_with", "g"), { "run.invoice_number": null }, false],
      ["gt, match", c("run.total", "gt", 5000), { "run.total": 5000.01 }, true],
      ["gt, equal", c("run.total", "gt", 5000), { "run.total": 5000 }, false],
      ["gt, null (no total printed)", c("run.total", "gt", 5000), { "run.total": null }, false],
      ["gt, absent", c("run.total", "gt", 5000), {}, false],
      ["gte, equal", c("run.total", "gte", 5000), { "run.total": 5000 }, true],
      ["gte, below", c("run.total", "gte", 5000), { "run.total": 4999.99 }, false],
      ["lt, below", c("run.total", "lt", 100), { "run.total": 99.99 }, true],
      ["lt, equal", c("run.total", "lt", 100), { "run.total": 100 }, false],
      ["lte, equal", c("run.total", "lte", 100), { "run.total": 100 }, true],
      ["lte, above", c("run.total", "lte", 100), { "run.total": 100.01 }, false],
      ["eq, match", c("summary.count", "eq", 3), { "summary.count": 3 }, true],
      ["eq, no match", c("summary.count", "eq", 3), { "summary.count": 2 }, false],
      ["eq, null", c("summary.count", "eq", 0), { "summary.count": null }, false],
      ["is_true, yes", c("run.security_flag", "is_true", null), { "run.security_flag": true }, true],
      ["is_true, no", c("run.security_flag", "is_true", null), { "run.security_flag": false }, false],
      ["is_true, null", c("run.security_flag", "is_true", null), { "run.security_flag": null }, false],
      ["is_true, absent", c("run.security_flag", "is_true", null), {}, false],
      ["is_false, no", c("run.security_flag", "is_false", null), { "run.security_flag": false }, true],
      ["is_false, yes", c("run.security_flag", "is_false", null), { "run.security_flag": true }, false],
      ["is_false, null", c("run.security_flag", "is_false", null), { "run.security_flag": null }, true],
      ["is_false, absent", c("run.security_flag", "is_false", null), {}, true],
      ["decision is, exact match", c("run.decision", "is", "HOLD"), { "run.decision": "HOLD" }, true],
      ["decision is, other case is not the token", c("run.decision", "is", "hold"), { "run.decision": "HOLD" }, false],
      ["decision is_not, other", c("run.decision", "is_not", "REJECT"), { "run.decision": "HOLD" }, true],
      ["decision is, null (a system error)", c("run.decision", "is", "HOLD"), { "run.decision": null }, false],
      ["an unknown field is never true", c("run.nope", "is", "x"), { "run.vendor_name": "x" }, false],
      ["a number operator on text is never true", c("run.vendor_name", "gt", 1), { "run.vendor_name": "x" }, false],
    ];
    t.ok(cases.length >= 24);
    for (const [what, cond, vars, expected] of cases) t.eq(evaluateCondition(cond, vars), expected, what);
  });

  await t.test("A1: an operator that does not suit the value, and a value of the wrong kind, are reported", () => {
    const withCondition = (condition: Condition): Graph => graphOf([node("start", "trigger.run_finished", "Start", 0, 0), node("if", "logic.if", "If", 280, 0, { combine: "all", conditions: [condition] })], [edge("start", "out", "if")]);
    t.eq(messages(withCondition({ field: "run.vendor_name", op: "gt", value: 5 })), ['"is more than" cannot be used with Vendor name.']);
    t.eq(messages(withCondition({ field: "run.finished_at", op: "is", value: "x" })), ['"is" cannot be used with Finished at.']);
    t.eq(messages(withCondition({ field: "run.total", op: "gt", value: "lots" })), ["Total needs a number."]);
    t.eq(messages(withCondition({ field: "run.decision", op: "is", value: "MAYBE" })), ["Decision needs one of: Approved, On hold, Rejected."]);
    t.eq(messages(withCondition({ field: "run.nope", op: "is", value: "x" })), ['Unknown value "run.nope" in a condition.']);
    t.eq(messages(withCondition({ field: "run.security_flag", op: "is_true", value: null })), []);
    t.eq(messages(withCondition({ field: "po.remaining", op: "lt", value: 100 })), ['{{po.remaining}} is not available here: add "Look up the PO balance" before this step.']);
  });

  await t.test("A1: topoOrder is stable: the same graph with its nodes shuffled gives the same order", () => {
    const g = inlineSeeds().route;
    const order = topoOrder(g);
    t.ok(order !== null);
    t.eq(order, ["start", "if-security", "assign-security", "note-security", "if-large", "assign-lead", "assign-clerk"].sort((a, b) => (order as string[]).indexOf(a) - (order as string[]).indexOf(b)));
    for (const shuffled of [[...g.nodes].reverse(), [g.nodes[3], g.nodes[0], g.nodes[6], g.nodes[1], g.nodes[5], g.nodes[2], g.nodes[4]]]) {
      t.eq(topoOrder({ nodes: shuffled, edges: [...g.edges].reverse() }), order, "order does not depend on the list order");
    }
    t.eq(order?.[0], "start", "the trigger is first");
  });

  await t.test("A1: more nodes or connections than the limits is not a graph at all", () => {
    const many: GraphNode[] = Array.from({ length: GRAPH_MAX_NODES + 1 }, (_, i) => node(`n-${i}`, "action.note", "N", i, 0, { text: "x" }));
    const out = validateGraph({ nodes: many, edges: [] });
    t.eq([out.graph, out.problems], [null, [{ node_id: null, message: "This automation could not be read." }]]);
    const edges = Array.from({ length: GRAPH_MAX_EDGES + 1 }, (_, i) => edge("a", "out", `b${i}`));
    t.eq(validateGraph({ nodes: [], edges }).graph, null);
    t.eq(validateGraph("nope").graph, null);
    t.eq(validateGraph({ nodes: [{ id: "A B" }], edges: [] }).graph, null, "a bad id is not a graph");
  });

  await t.test("A1: a step's settings that fail their schema are named, and the rest of the graph is still checked", () => {
    const g = withNote("ok");
    g.nodes.push(node("assign", "action.assign", "Assign", 560, 0, { assignee: 5 }), node("sched", "trigger.schedule", "Other", 0, 200, { every: "week", hour: 8, minute: 0 }));
    const problems = validateGraph(g).problems;
    t.ok(problems.some((p) => p.node_id === "assign" && p.message.startsWith("This step's settings are not valid: assignee ") && p.message.length <= 160), "assign");
    t.ok(problems.some((p) => p.node_id === "sched" && p.message.startsWith("This step's settings are not valid:")), "schedule");
    t.ok(problems.some((p) => p.node_id === "sched" && p.message === "An automation has exactly one starting step."), "and the second trigger is still reported");
  });

  await t.test("A1: trigger, step content and webhook rules", () => {
    const start = node("start", "trigger.run_finished", "Start", 0, 0, { decisions: [], include_errors: false });
    t.eq(messages(graphOf([start], [])), ["Choose at least one outcome to start on."]);
    t.eq(messages(graphOf([node("start", "trigger.run_finished", "Start", 0, 0, { decisions: [], include_errors: true })], [])), []);
    t.eq(messages(withNote("   ")), ["Write the note's text."]);
    const one = (n: GraphNode): Graph => graphOf([node("start", "trigger.run_finished", "Start", 0, 0), n], [edge("start", "out", n.id)]);
    t.eq(messages(one(node("a", "action.assign", "A", 280, 0, { assignee: " " }))), ["Write who to assign to."]);
    t.eq(messages(one(node("c", "action.chat", "C", 280, 0, { text: "" }))), ["Write the message."]);
    t.eq(messages(one(node("w", "action.webhook", "W", 280, 0, { fields: [] }))), ["Add at least one field to send."]);
    t.eq(messages(one(node("w", "action.webhook", "W", 280, 0, { fields: [{ key: "a", value: "1" }, { key: "a", value: "2" }] }))), ['Two fields are both called "a".']);
    t.eq(messages(one(node("w", "action.webhook", "W", 280, 0, { fields: [{ key: "Bad Key", value: "1" }] }))).length, 1, "a field key is lower-case letters, digits and _");
    const review = node("start", "trigger.review_saved", "Start", 0, 0);
    t.eq(messages(graphOf([review], []), { reviewTrigger: false }), ["Resolving holds is not available on this server."]);
    t.eq(messages(graphOf([review], [])), [], "the editor assumes it is available");
    t.eq(messages(one(node("w", "action.webhook", "W", 280, 0)), { secrets: { w: { has_url: false } } }), ["Add the webhook URL."]);
  });

  await t.test("A1: nextNodeId returns if-1, then if-2, and fills gaps", () => {
    const g = withNote("x");
    t.eq(nextNodeId(g, "logic.if"), "if-1");
    g.nodes.push(node("if-1", "logic.if", "If", 0, 0));
    t.eq(nextNodeId(g, "logic.if"), "if-2");
    g.nodes.push(node("if-2", "logic.if", "If", 0, 0), node("if-3", "logic.if", "If", 0, 0));
    g.nodes.splice(g.nodes.findIndex((n) => n.id === "if-2"), 1);
    t.eq(nextNodeId(g, "logic.if"), "if-2", "the lowest free number");
    t.eq(nextNodeId(withNote("x"), "action.note"), "note-1");
    t.eq(nextNodeId({ nodes: [], edges: [] }, "action.chat"), "chat-1");
  });

  await t.test("A1: summarizeStep writes one sentence for each step type", () => {
    const n = (type: NodeType, config?: unknown): GraphNode => node("x", type, "X", 0, 0, config);
    t.eq(summarizeStep(n("trigger.run_finished", { decisions: ["HOLD"], include_errors: false })), "Only invoices that are on hold");
    t.eq(summarizeStep(n("trigger.run_finished", { decisions: ["REJECT"], include_errors: false })), "Only invoices that are rejected");
    t.eq(summarizeStep(n("trigger.run_finished", { decisions: ["REJECT", "APPROVE"], include_errors: true })), "Only invoices that are approved or rejected, or end in a system error");
    t.eq(summarizeStep(n("trigger.run_finished", { decisions: ["APPROVE", "HOLD", "REJECT"], include_errors: false })), "Every decided invoice");
    t.eq(summarizeStep(n("trigger.review_saved", { actions: ["APPROVE", "REJECT"] })), "When a hold is approved or rejected");
    t.eq(summarizeStep(n("trigger.review_saved", { actions: ["REJECT"] })), "When a hold is rejected");
    t.eq(summarizeStep(n("trigger.schedule", { every: "day", hour: 8, minute: 0 })), "Every day at 08:00 UTC");
    t.eq(summarizeStep(n("trigger.schedule", { every: "hour", hour: 0, minute: 15 })), "Every hour at :15");
    t.eq(summarizeStep(n("logic.if", { combine: "all", conditions: [{ field: "run.security_flag", op: "is_true", value: null }] })), "If Security flag is yes");
    t.eq(summarizeStep(n("logic.if", { combine: "all", conditions: [{ field: "run.total", op: "gt", value: 5000 }, { field: "run.decision", op: "is", value: "HOLD" }, { field: "run.vendor_name", op: "contains", value: "Acme" }] })), "If Total is more than $5,000 and 2 more");
    t.eq(summarizeStep(n("logic.if", { combine: "any", conditions: [{ field: "run.decision", op: "is", value: "HOLD" }, { field: "run.vendor_name", op: "contains", value: "Acme" }] })), "If Decision is On hold or 1 more");
    t.eq(summarizeStep(n("logic.switch_decision", {})), "One way per decision");
    t.eq(summarizeStep(n("data.vendor", {})), "Look up the vendor");
    t.eq(summarizeStep(n("data.po_balance", {})), "Look up the PO balance");
    t.eq(summarizeStep(n("data.summarize", { window_hours: 24, decisions: ["HOLD"], max_items: 10 })), "Invoices on hold in the last 24 hours");
    t.eq(summarizeStep(n("data.summarize", { window_hours: 1, decisions: ["APPROVE", "HOLD"], max_items: 5 })), "Invoices approved or on hold in the last hour");
    t.eq(summarizeStep(n("action.note", { text: "" })), "No text yet");
    t.eq(summarizeStep(n("action.note", { text: "Security review needed before any payment: {{run.first_reason}}" })), "Security review needed before any payment: {{run.first_reas…"); // longer than 60 characters: cut
    t.eq(summarizeStep(n("action.note", { text: "x".repeat(60) })), "x".repeat(60), "exactly 60 characters is not cut");
    t.eq(summarizeStep(n("action.note", { text: "x".repeat(70) })), `${"x".repeat(59)}…`);
    t.eq(summarizeStep(n("action.assign", { assignee: "" })), "No one chosen yet");
    t.eq(summarizeStep(n("action.assign", { assignee: "AP lead" })), "Assign to AP lead");
    t.eq(summarizeStep(n("action.webhook", { fields: [{ key: "a", value: "1" }, { key: "b", value: "2" }] })), "Sends 2 fields");
    t.eq(summarizeStep(n("action.webhook", { fields: [{ key: "a", value: "1" }] })), "Sends 1 field");
    t.eq(summarizeStep(n("action.chat", { text: "" })), "No message yet");
    t.eq(summarizeStep(n("action.chat", { text: "Hello team" })), "Hello team");
    t.eq(summarizeStep(n("action.chat", { text: 5 })), "Settings are not valid", "a step with broken settings still gets a sentence");
  });
}

var __defProp = Object.defineProperty;
var __export = (target, all2) => {
  for (var name in all2)
    __defProp(target, name, { get: all2[name], enumerable: true });
};

// src/desktop/workbench/collaboration-ui.ts
var ACTIONABLE_TASK_STATES = [
  "queued",
  "running",
  "waiting",
  "delivered",
  "failed"
];
function isActionableTaskState(state2) {
  return ACTIONABLE_TASK_STATES.includes(state2);
}
function pickDefaultCoordinationType(types) {
  const names = listCoordinationTypeNames(types);
  if (names.includes("goal")) return "goal";
  return names[0] ?? null;
}
function listCoordinationTypeNames(types) {
  return types.filter((t) => {
    const tier = "tier" in t ? t.tier : "base";
    if (tier !== void 0 && tier !== "base") return false;
    if ("coordination" in t && typeof t.coordination === "boolean") {
      return t.coordination === true;
    }
    return true;
  }).map((t) => t.name).sort((a, b) => a.localeCompare(b));
}
function listCoordinationTypeOptions(types) {
  return listCoordinationTypeNames(types).map((name) => ({ name }));
}
function listRoleOptions(roles2) {
  return roles2.map((r) => ({ roleId: r.roleId, name: r.name, description: r.description })).sort((a, b) => a.name.localeCompare(b.name));
}
function listConnectionOptions(connections2) {
  return connections2.map((connection) => {
    const parts = [connection.displayName || connection.connectionId, connection.adapterId, connection.model].filter(Boolean);
    return {
      connectionId: connection.connectionId,
      adapterId: connection.adapterId,
      displayName: connection.displayName || connection.connectionId,
      model: connection.model,
      label: parts.join(" \xB7 ")
    };
  }).sort((a, b) => a.connectionId.localeCompare(b.connectionId));
}
function pickDefaultConnectionId(connections2) {
  return connections2[0]?.connectionId ?? null;
}
function buildStartSessionPayload(taskPath) {
  const path = taskPath.trim();
  if (!path) {
    return { ok: false, reason: "\u7F3A\u5C11\u4EFB\u52A1\u8DEF\u5F84\u3002" };
  }
  return {
    ok: true,
    payload: {
      taskPath: path,
      callerKind: "user"
    }
  };
}
function validateDispatchForm(form) {
  if (!form.nodeId) {
    return { ok: false, reason: "\u8BF7\u5148\u9009\u4E2D\u4E00\u4E2A\u8282\u70B9\u3002", payload: null };
  }
  if (!form.coordination) {
    return {
      ok: false,
      reason: "\u5F53\u524D\u6982\u5FF5\u4E0D\u53EF\u7528\uFF08\u65E0\u6548\u6216\u5DF2\u5C01\u5B58\uFF09\uFF0C\u65E0\u6CD5\u6D3E\u6D3B\u3002",
      payload: null
    };
  }
  if (!form.roles.length) {
    return {
      ok: false,
      reason: "\u5E10\u5185\u5C1A\u65E0 role\uFF0C\u8BF7\u5148\u5728 roles \u6CE8\u518C\u8868\u6DFB\u52A0\u76EE\u6807\u89D2\u8272\u3002",
      payload: null
    };
  }
  const role = form.role.trim();
  if (!role) {
    return { ok: false, reason: "\u8BF7\u9009\u62E9\u76EE\u6807 role\u3002", payload: null };
  }
  const selectedRole = form.roles.find((r) => r.roleId === role || r.name === role);
  if (!selectedRole) {
    return { ok: false, reason: `\u76EE\u6807 role\u300C${role}\u300D\u4E0D\u5728\u6CE8\u518C\u8868\u4E2D\u3002`, payload: null };
  }
  const prompt = form.prompt.trim();
  if (!prompt) {
    return { ok: false, reason: "\u8BF7\u586B\u5199 user prompt\u3002", payload: null };
  }
  return {
    ok: true,
    reason: null,
    payload: {
      workNodeIds: [form.nodeId],
      contextNodeIds: [],
      roleId: selectedRole.roleId,
      prompt,
      // Desktop form is user-direct; Role-dispatched child uses CLI/Service explicit actors.
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" }
    }
  };
}
function buildAcceptPayload(taskPath, deliveryId, actor = "user") {
  return { taskPath, deliveryId, actor };
}
function buildRejectPayload(taskPath, deliveryId, reason, actor = "user") {
  const note = reason.trim();
  if (!note) {
    return { ok: false, reason: "\u9A73\u56DE\u9700\u8981\u586B\u5199\u7B80\u77ED\u539F\u56E0\u3002" };
  }
  return {
    ok: true,
    payload: {
      taskPath,
      deliveryId,
      actor,
      note,
      resume: true
    }
  };
}
function taskStateLabel(state2) {
  const s = state2;
  switch (s) {
    case "queued":
      return "\u6392\u961F\u4E2D";
    case "running":
      return "\u6267\u884C\u4E2D";
    case "waiting":
      return "\u7B49\u5F85\u4E2D";
    case "delivered":
      return "\u5F85\u786E\u8BA4\u4EA4\u4ED8";
    case "accepted":
      return "\u5DF2\u63A5\u53D7";
    case "rejected":
      return "\u5DF2\u9A73\u56DE";
    case "interrupted":
      return "\u5DF2\u4E2D\u65AD";
    case "failed":
      return "\u5931\u8D25";
    default:
      return s || "\u672A\u77E5";
  }
}
function sessionStateLabel(state2) {
  if (!state2) return "";
  switch (state2) {
    case "starting":
      return "\u542F\u52A8\u4E2D";
    case "live":
    case "running":
      return "\u8FD0\u884C\u4E2D";
    case "waiting-user":
    case "waiting_user":
      return "\u7B49\u5F85\u7528\u6237";
    case "stopped":
      return "\u5DF2\u505C\u6B62";
    case "failed":
      return "\u4F1A\u8BDD\u5931\u8D25";
    case "external":
      return "\u5916\u90E8\u4F1A\u8BDD";
    default:
      return state2;
  }
}
function canStartAgentOnTask(taskState, session, opts) {
  const s = taskState || "";
  if (s === "delivered" || s === "accepted" || s === "rejected" || s === "interrupted") {
    return false;
  }
  if (session && session.alive && (session.state === "live" || session.state === "starting" || session.state === "waiting-user")) {
    return false;
  }
  if (!opts?.hasSessionId) return false;
  return s === "queued" || s === "pending" || s === "running" || s === "taken" || s === "waiting" || s === "failed";
}
function canInterruptTask(taskState, session, opts) {
  if (session) {
    return !!session.alive && (session.state === "live" || session.state === "starting" || session.state === "waiting-user");
  }
  if (!opts?.hasSessionId) return false;
  const s = taskState || "";
  return s === "running" || s === "waiting" || s === "taken";
}
function canCancelTask(taskState, session) {
  const s = taskState || "";
  if (s === "delivered" || s === "accepted" || s === "rejected" || s === "interrupted" || s === "cancelled" || s === "canceled") {
    return false;
  }
  if (session && session.alive) return false;
  return s === "queued" || s === "pending" || s === "running" || s === "taken" || s === "waiting" || s === "failed";
}
function buildTaskReviewItems(tasks, deliveries2 = [], sessions2 = []) {
  const byId = /* @__PURE__ */ new Map();
  const byTaskId = /* @__PURE__ */ new Map();
  for (const d of deliveries2) {
    byId.set(d.id, d);
    const list2 = byTaskId.get(d.taskId) ?? [];
    list2.push(d);
    byTaskId.set(d.taskId, list2);
  }
  const sessionById = /* @__PURE__ */ new Map();
  const sessionByTaskId = /* @__PURE__ */ new Map();
  for (const s of sessions2) {
    sessionById.set(s.sessionId, s);
    if (s.lastTaskId) sessionByTaskId.set(s.lastTaskId, s);
  }
  return tasks.map((task) => {
    const state2 = task.state;
    let delivery;
    if (task.activeDeliveryId) {
      delivery = byId.get(task.activeDeliveryId);
    }
    if (!delivery && task.id) {
      const list2 = byTaskId.get(task.id) ?? [];
      delivery = list2.slice().sort((a, b) => (b.updatedAt || b.createdAt || "").localeCompare(a.updatedAt || a.createdAt || ""))[0];
    }
    let session;
    if (task.sessionId) {
      session = sessionById.get(task.sessionId);
    }
    if (!session && task.id) {
      session = sessionByTaskId.get(task.id);
    }
    const commits = delivery?.commits ?? [];
    const deliverySummary = delivery?.summary;
    const label = taskStateLabel(state2);
    const sessLabel = sessionStateLabel(session?.state);
    const promptBit = task.prompt ? truncate(task.prompt, 48) : "";
    const summaryLine = [
      label,
      sessLabel ? `\u4F1A\u8BDD${sessLabel}` : null,
      task.roleId ? `role:${task.roleId}` : task.sessionId ? `session:${task.sessionId}` : null,
      deliverySummary ? truncate(deliverySummary, 64) : promptBit || null
    ].filter(Boolean).join(" \xB7 ");
    return {
      path: task.path,
      id: task.id,
      roleId: task.roleId,
      state: state2,
      workNodeIds: task.workNodeIds ?? [],
      contextNodeIds: task.contextNodeIds ?? [],
      prompt: task.prompt,
      activeDeliveryId: task.activeDeliveryId,
      sessionId: task.sessionId ?? session?.sessionId,
      sessionState: session?.state,
      sessionAlive: session?.alive,
      sessionConnectionId: session?.connectionId,
      deliverySummary,
      commits,
      canAcceptOrReject: state2 === "delivered",
      canStartAgent: canStartAgentOnTask(state2, session, {
        hasSessionId: !!(task.sessionId || session?.sessionId)
      }),
      canInterrupt: canInterruptTask(state2, session, {
        hasSessionId: !!(task.sessionId || session?.sessionId)
      }),
      canCancel: canCancelTask(state2, session),
      summaryLine
    };
  });
}
function truncate(text3, max) {
  const t = text3.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return t.slice(0, max - 1) + "\u2026";
}
function suggestNodeName(typeName, now = Date.now()) {
  const safe = typeName.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "node";
  return `${safe}-${now.toString(36).slice(-4)}`;
}

// node_modules/mdast-util-to-string/lib/index.js
var emptyOptions = {};
function toString(value, options) {
  const settings = options || emptyOptions;
  const includeImageAlt = typeof settings.includeImageAlt === "boolean" ? settings.includeImageAlt : true;
  const includeHtml = typeof settings.includeHtml === "boolean" ? settings.includeHtml : true;
  return one(value, includeImageAlt, includeHtml);
}
function one(value, includeImageAlt, includeHtml) {
  if (node(value)) {
    if ("value" in value) {
      return value.type === "html" && !includeHtml ? "" : value.value;
    }
    if (includeImageAlt && "alt" in value && value.alt) {
      return value.alt;
    }
    if ("children" in value) {
      return all(value.children, includeImageAlt, includeHtml);
    }
  }
  if (Array.isArray(value)) {
    return all(value, includeImageAlt, includeHtml);
  }
  return "";
}
function all(values, includeImageAlt, includeHtml) {
  const result = [];
  let index2 = -1;
  while (++index2 < values.length) {
    result[index2] = one(values[index2], includeImageAlt, includeHtml);
  }
  return result.join("");
}
function node(value) {
  return Boolean(value && typeof value === "object");
}

// node_modules/decode-named-character-reference/index.dom.js
var element = document.createElement("i");
function decodeNamedCharacterReference(value) {
  const characterReference2 = "&" + value + ";";
  element.innerHTML = characterReference2;
  const character = element.textContent;
  if (character.charCodeAt(character.length - 1) === 59 && value !== "semi") {
    return false;
  }
  return character === characterReference2 ? false : character;
}

// node_modules/micromark-util-chunked/index.js
function splice(list2, start, remove, items) {
  const end = list2.length;
  let chunkStart = 0;
  let parameters;
  if (start < 0) {
    start = -start > end ? 0 : end + start;
  } else {
    start = start > end ? end : start;
  }
  remove = remove > 0 ? remove : 0;
  if (items.length < 1e4) {
    parameters = Array.from(items);
    parameters.unshift(start, remove);
    list2.splice(...parameters);
  } else {
    if (remove) list2.splice(start, remove);
    while (chunkStart < items.length) {
      parameters = items.slice(chunkStart, chunkStart + 1e4);
      parameters.unshift(start, 0);
      list2.splice(...parameters);
      chunkStart += 1e4;
      start += 1e4;
    }
  }
}
function push(list2, items) {
  if (list2.length > 0) {
    splice(list2, list2.length, 0, items);
    return list2;
  }
  return items;
}

// node_modules/micromark-util-combine-extensions/index.js
var hasOwnProperty = {}.hasOwnProperty;
function combineExtensions(extensions) {
  const all2 = {};
  let index2 = -1;
  while (++index2 < extensions.length) {
    syntaxExtension(all2, extensions[index2]);
  }
  return all2;
}
function syntaxExtension(all2, extension2) {
  let hook;
  for (hook in extension2) {
    const maybe = hasOwnProperty.call(all2, hook) ? all2[hook] : void 0;
    const left = maybe || (all2[hook] = {});
    const right = extension2[hook];
    let code;
    if (right) {
      for (code in right) {
        if (!hasOwnProperty.call(left, code)) left[code] = [];
        const value = right[code];
        constructs(
          // @ts-expect-error Looks like a list.
          left[code],
          Array.isArray(value) ? value : value ? [value] : []
        );
      }
    }
  }
}
function constructs(existing, list2) {
  let index2 = -1;
  const before = [];
  while (++index2 < list2.length) {
    ;
    (list2[index2].add === "after" ? existing : before).push(list2[index2]);
  }
  splice(existing, 0, 0, before);
}

// node_modules/micromark-util-decode-numeric-character-reference/index.js
function decodeNumericCharacterReference(value, base) {
  const code = Number.parseInt(value, base);
  if (
    // C0 except for HT, LF, FF, CR, space.
    code < 9 || code === 11 || code > 13 && code < 32 || // Control character (DEL) of C0, and C1 controls.
    code > 126 && code < 160 || // Lone high surrogates and low surrogates.
    code > 55295 && code < 57344 || // Noncharacters.
    code > 64975 && code < 65008 || /* eslint-disable no-bitwise */
    (code & 65535) === 65535 || (code & 65535) === 65534 || /* eslint-enable no-bitwise */
    // Out of range
    code > 1114111
  ) {
    return "\uFFFD";
  }
  return String.fromCodePoint(code);
}

// node_modules/micromark-util-normalize-identifier/index.js
function normalizeIdentifier(value) {
  return value.replace(/[\t\n\r ]+/g, " ").replace(/^ | $/g, "").toLowerCase().toUpperCase();
}

// node_modules/micromark-util-character/index.js
var asciiAlpha = regexCheck(/[A-Za-z]/);
var asciiAlphanumeric = regexCheck(/[\dA-Za-z]/);
var asciiAtext = regexCheck(/[#-'*+\--9=?A-Z^-~]/);
function asciiControl(code) {
  return (
    // Special whitespace codes (which have negative values), C0 and Control
    // character DEL
    code !== null && (code < 32 || code === 127)
  );
}
var asciiDigit = regexCheck(/\d/);
var asciiHexDigit = regexCheck(/[\dA-Fa-f]/);
var asciiPunctuation = regexCheck(/[!-/:-@[-`{-~]/);
function markdownLineEnding(code) {
  return code !== null && code < -2;
}
function markdownLineEndingOrSpace(code) {
  return code !== null && (code < 0 || code === 32);
}
function markdownSpace(code) {
  return code === -2 || code === -1 || code === 32;
}
var unicodePunctuation = regexCheck(/\p{P}|\p{S}/u);
var unicodeWhitespace = regexCheck(/\s/);
function regexCheck(regex) {
  return check;
  function check(code) {
    return code !== null && code > -1 && regex.test(String.fromCharCode(code));
  }
}

// node_modules/micromark-factory-space/index.js
function factorySpace(effects, ok, type, max) {
  const limit = max ? max - 1 : Number.POSITIVE_INFINITY;
  let size = 0;
  return start;
  function start(code) {
    if (markdownSpace(code)) {
      effects.enter(type);
      return prefix(code);
    }
    return ok(code);
  }
  function prefix(code) {
    if (markdownSpace(code) && size++ < limit) {
      effects.consume(code);
      return prefix;
    }
    effects.exit(type);
    return ok(code);
  }
}

// node_modules/micromark/lib/initialize/content.js
var content = {
  tokenize: initializeContent
};
function initializeContent(effects) {
  const contentStart = effects.attempt(this.parser.constructs.contentInitial, afterContentStartConstruct, paragraphInitial);
  let previous2;
  return contentStart;
  function afterContentStartConstruct(code) {
    if (code === null) {
      effects.consume(code);
      return;
    }
    effects.enter("lineEnding");
    effects.consume(code);
    effects.exit("lineEnding");
    return factorySpace(effects, contentStart, "linePrefix");
  }
  function paragraphInitial(code) {
    effects.enter("paragraph");
    return lineStart(code);
  }
  function lineStart(code) {
    const token = effects.enter("chunkText", {
      contentType: "text",
      previous: previous2
    });
    if (previous2) {
      previous2.next = token;
    }
    previous2 = token;
    return data(code);
  }
  function data(code) {
    if (code === null) {
      effects.exit("chunkText");
      effects.exit("paragraph");
      effects.consume(code);
      return;
    }
    if (markdownLineEnding(code)) {
      effects.consume(code);
      effects.exit("chunkText");
      return lineStart;
    }
    effects.consume(code);
    return data;
  }
}

// node_modules/micromark/lib/initialize/document.js
var document2 = {
  tokenize: initializeDocument
};
var containerConstruct = {
  tokenize: tokenizeContainer
};
function initializeDocument(effects) {
  const self = this;
  const stack = [];
  let continued = 0;
  let childFlow;
  let childToken;
  let lineStartOffset;
  return start;
  function start(code) {
    if (continued < stack.length) {
      const item = stack[continued];
      self.containerState = item[1];
      return effects.attempt(item[0].continuation, documentContinue, checkNewContainers)(code);
    }
    return checkNewContainers(code);
  }
  function documentContinue(code) {
    continued++;
    if (self.containerState._closeFlow) {
      self.containerState._closeFlow = void 0;
      if (childFlow) {
        closeFlow();
      }
      const indexBeforeExits = self.events.length;
      let indexBeforeFlow = indexBeforeExits;
      let point3;
      while (indexBeforeFlow--) {
        if (self.events[indexBeforeFlow][0] === "exit" && self.events[indexBeforeFlow][1].type === "chunkFlow") {
          point3 = self.events[indexBeforeFlow][1].end;
          break;
        }
      }
      exitContainers(continued);
      let index2 = indexBeforeExits;
      while (index2 < self.events.length) {
        self.events[index2][1].end = {
          ...point3
        };
        index2++;
      }
      splice(self.events, indexBeforeFlow + 1, 0, self.events.slice(indexBeforeExits));
      self.events.length = index2;
      return checkNewContainers(code);
    }
    return start(code);
  }
  function checkNewContainers(code) {
    if (continued === stack.length) {
      if (!childFlow) {
        return documentContinued(code);
      }
      if (childFlow.currentConstruct && childFlow.currentConstruct.concrete) {
        return flowStart(code);
      }
      self.interrupt = Boolean(childFlow.currentConstruct && !childFlow._gfmTableDynamicInterruptHack);
    }
    self.containerState = {};
    return effects.check(containerConstruct, thereIsANewContainer, thereIsNoNewContainer)(code);
  }
  function thereIsANewContainer(code) {
    if (childFlow) closeFlow();
    exitContainers(continued);
    return documentContinued(code);
  }
  function thereIsNoNewContainer(code) {
    self.parser.lazy[self.now().line] = continued !== stack.length;
    lineStartOffset = self.now().offset;
    return flowStart(code);
  }
  function documentContinued(code) {
    self.containerState = {};
    return effects.attempt(containerConstruct, containerContinue, flowStart)(code);
  }
  function containerContinue(code) {
    continued++;
    stack.push([self.currentConstruct, self.containerState]);
    return documentContinued(code);
  }
  function flowStart(code) {
    if (code === null) {
      if (childFlow) closeFlow();
      exitContainers(0);
      effects.consume(code);
      return;
    }
    childFlow = childFlow || self.parser.flow(self.now());
    effects.enter("chunkFlow", {
      _tokenizer: childFlow,
      contentType: "flow",
      previous: childToken
    });
    return flowContinue(code);
  }
  function flowContinue(code) {
    if (code === null) {
      writeToChild(effects.exit("chunkFlow"), true);
      exitContainers(0);
      effects.consume(code);
      return;
    }
    if (markdownLineEnding(code)) {
      effects.consume(code);
      writeToChild(effects.exit("chunkFlow"));
      continued = 0;
      self.interrupt = void 0;
      return start;
    }
    effects.consume(code);
    return flowContinue;
  }
  function writeToChild(token, endOfFile) {
    const stream = self.sliceStream(token);
    if (endOfFile) stream.push(null);
    token.previous = childToken;
    if (childToken) childToken.next = token;
    childToken = token;
    childFlow.defineSkip(token.start);
    childFlow.write(stream);
    if (self.parser.lazy[token.start.line]) {
      let index2 = childFlow.events.length;
      while (index2--) {
        if (
          // The token starts before the line ending…
          childFlow.events[index2][1].start.offset < lineStartOffset && // …and either is not ended yet…
          (!childFlow.events[index2][1].end || // …or ends after it.
          childFlow.events[index2][1].end.offset > lineStartOffset)
        ) {
          return;
        }
      }
      const indexBeforeExits = self.events.length;
      let indexBeforeFlow = indexBeforeExits;
      let seen;
      let point3;
      while (indexBeforeFlow--) {
        if (self.events[indexBeforeFlow][0] === "exit" && self.events[indexBeforeFlow][1].type === "chunkFlow") {
          if (seen) {
            point3 = self.events[indexBeforeFlow][1].end;
            break;
          }
          seen = true;
        }
      }
      exitContainers(continued);
      index2 = indexBeforeExits;
      while (index2 < self.events.length) {
        self.events[index2][1].end = {
          ...point3
        };
        index2++;
      }
      splice(self.events, indexBeforeFlow + 1, 0, self.events.slice(indexBeforeExits));
      self.events.length = index2;
    }
  }
  function exitContainers(size) {
    let index2 = stack.length;
    while (index2-- > size) {
      const entry = stack[index2];
      self.containerState = entry[1];
      entry[0].exit.call(self, effects);
    }
    stack.length = size;
  }
  function closeFlow() {
    childFlow.write([null]);
    childToken = void 0;
    childFlow = void 0;
    self.containerState._closeFlow = void 0;
  }
}
function tokenizeContainer(effects, ok, nok) {
  return factorySpace(effects, effects.attempt(this.parser.constructs.document, ok, nok), "linePrefix", this.parser.constructs.disable.null.includes("codeIndented") ? void 0 : 4);
}

// node_modules/micromark-util-classify-character/index.js
function classifyCharacter(code) {
  if (code === null || markdownLineEndingOrSpace(code) || unicodeWhitespace(code)) {
    return 1;
  }
  if (unicodePunctuation(code)) {
    return 2;
  }
}

// node_modules/micromark-util-resolve-all/index.js
function resolveAll(constructs2, events, context) {
  const called = [];
  let index2 = -1;
  while (++index2 < constructs2.length) {
    const resolve = constructs2[index2].resolveAll;
    if (resolve && !called.includes(resolve)) {
      events = resolve(events, context);
      called.push(resolve);
    }
  }
  return events;
}

// node_modules/micromark-core-commonmark/lib/attention.js
var attention = {
  name: "attention",
  resolveAll: resolveAllAttention,
  tokenize: tokenizeAttention
};
function resolveAllAttention(events, context) {
  let index2 = -1;
  let open;
  let group;
  let text3;
  let openingSequence;
  let closingSequence;
  let use;
  let nextEvents;
  let offset;
  while (++index2 < events.length) {
    if (events[index2][0] === "enter" && events[index2][1].type === "attentionSequence" && events[index2][1]._close) {
      open = index2;
      while (open--) {
        if (events[open][0] === "exit" && events[open][1].type === "attentionSequence" && events[open][1]._open && // If the markers are the same:
        context.sliceSerialize(events[open][1]).charCodeAt(0) === context.sliceSerialize(events[index2][1]).charCodeAt(0)) {
          if ((events[open][1]._close || events[index2][1]._open) && (events[index2][1].end.offset - events[index2][1].start.offset) % 3 && !((events[open][1].end.offset - events[open][1].start.offset + events[index2][1].end.offset - events[index2][1].start.offset) % 3)) {
            continue;
          }
          use = events[open][1].end.offset - events[open][1].start.offset > 1 && events[index2][1].end.offset - events[index2][1].start.offset > 1 ? 2 : 1;
          const start = {
            ...events[open][1].end
          };
          const end = {
            ...events[index2][1].start
          };
          movePoint(start, -use);
          movePoint(end, use);
          openingSequence = {
            type: use > 1 ? "strongSequence" : "emphasisSequence",
            start,
            end: {
              ...events[open][1].end
            }
          };
          closingSequence = {
            type: use > 1 ? "strongSequence" : "emphasisSequence",
            start: {
              ...events[index2][1].start
            },
            end
          };
          text3 = {
            type: use > 1 ? "strongText" : "emphasisText",
            start: {
              ...events[open][1].end
            },
            end: {
              ...events[index2][1].start
            }
          };
          group = {
            type: use > 1 ? "strong" : "emphasis",
            start: {
              ...openingSequence.start
            },
            end: {
              ...closingSequence.end
            }
          };
          events[open][1].end = {
            ...openingSequence.start
          };
          events[index2][1].start = {
            ...closingSequence.end
          };
          nextEvents = [];
          if (events[open][1].end.offset - events[open][1].start.offset) {
            nextEvents = push(nextEvents, [["enter", events[open][1], context], ["exit", events[open][1], context]]);
          }
          nextEvents = push(nextEvents, [["enter", group, context], ["enter", openingSequence, context], ["exit", openingSequence, context], ["enter", text3, context]]);
          nextEvents = push(nextEvents, resolveAll(context.parser.constructs.insideSpan.null, events.slice(open + 1, index2), context));
          nextEvents = push(nextEvents, [["exit", text3, context], ["enter", closingSequence, context], ["exit", closingSequence, context], ["exit", group, context]]);
          if (events[index2][1].end.offset - events[index2][1].start.offset) {
            offset = 2;
            nextEvents = push(nextEvents, [["enter", events[index2][1], context], ["exit", events[index2][1], context]]);
          } else {
            offset = 0;
          }
          splice(events, open - 1, index2 - open + 3, nextEvents);
          index2 = open + nextEvents.length - offset - 2;
          break;
        }
      }
    }
  }
  index2 = -1;
  while (++index2 < events.length) {
    if (events[index2][1].type === "attentionSequence") {
      events[index2][1].type = "data";
    }
  }
  return events;
}
function tokenizeAttention(effects, ok) {
  const attentionMarkers2 = this.parser.constructs.attentionMarkers.null;
  const previous2 = this.previous;
  const before = classifyCharacter(previous2);
  let marker;
  return start;
  function start(code) {
    marker = code;
    effects.enter("attentionSequence");
    return inside(code);
  }
  function inside(code) {
    if (code === marker) {
      effects.consume(code);
      return inside;
    }
    const token = effects.exit("attentionSequence");
    const after = classifyCharacter(code);
    const open = !after || after === 2 && before || attentionMarkers2.includes(code);
    const close = !before || before === 2 && after || attentionMarkers2.includes(previous2);
    token._open = Boolean(marker === 42 ? open : open && (before || !close));
    token._close = Boolean(marker === 42 ? close : close && (after || !open));
    return ok(code);
  }
}
function movePoint(point3, offset) {
  point3.column += offset;
  point3.offset += offset;
  point3._bufferIndex += offset;
}

// node_modules/micromark-core-commonmark/lib/autolink.js
var autolink = {
  name: "autolink",
  tokenize: tokenizeAutolink
};
function tokenizeAutolink(effects, ok, nok) {
  let size = 0;
  return start;
  function start(code) {
    effects.enter("autolink");
    effects.enter("autolinkMarker");
    effects.consume(code);
    effects.exit("autolinkMarker");
    effects.enter("autolinkProtocol");
    return open;
  }
  function open(code) {
    if (asciiAlpha(code)) {
      effects.consume(code);
      return schemeOrEmailAtext;
    }
    if (code === 64) {
      return nok(code);
    }
    return emailAtext(code);
  }
  function schemeOrEmailAtext(code) {
    if (code === 43 || code === 45 || code === 46 || asciiAlphanumeric(code)) {
      size = 1;
      return schemeInsideOrEmailAtext(code);
    }
    return emailAtext(code);
  }
  function schemeInsideOrEmailAtext(code) {
    if (code === 58) {
      effects.consume(code);
      size = 0;
      return urlInside;
    }
    if ((code === 43 || code === 45 || code === 46 || asciiAlphanumeric(code)) && size++ < 32) {
      effects.consume(code);
      return schemeInsideOrEmailAtext;
    }
    size = 0;
    return emailAtext(code);
  }
  function urlInside(code) {
    if (code === 62) {
      effects.exit("autolinkProtocol");
      effects.enter("autolinkMarker");
      effects.consume(code);
      effects.exit("autolinkMarker");
      effects.exit("autolink");
      return ok;
    }
    if (code === null || code === 32 || code === 60 || asciiControl(code)) {
      return nok(code);
    }
    effects.consume(code);
    return urlInside;
  }
  function emailAtext(code) {
    if (code === 64) {
      effects.consume(code);
      return emailAtSignOrDot;
    }
    if (asciiAtext(code)) {
      effects.consume(code);
      return emailAtext;
    }
    return nok(code);
  }
  function emailAtSignOrDot(code) {
    return asciiAlphanumeric(code) ? emailLabel(code) : nok(code);
  }
  function emailLabel(code) {
    if (code === 46) {
      effects.consume(code);
      size = 0;
      return emailAtSignOrDot;
    }
    if (code === 62) {
      effects.exit("autolinkProtocol").type = "autolinkEmail";
      effects.enter("autolinkMarker");
      effects.consume(code);
      effects.exit("autolinkMarker");
      effects.exit("autolink");
      return ok;
    }
    return emailValue(code);
  }
  function emailValue(code) {
    if ((code === 45 || asciiAlphanumeric(code)) && size++ < 63) {
      const next = code === 45 ? emailValue : emailLabel;
      effects.consume(code);
      return next;
    }
    return nok(code);
  }
}

// node_modules/micromark-core-commonmark/lib/blank-line.js
var blankLine = {
  partial: true,
  tokenize: tokenizeBlankLine
};
function tokenizeBlankLine(effects, ok, nok) {
  return start;
  function start(code) {
    return markdownSpace(code) ? factorySpace(effects, after, "linePrefix")(code) : after(code);
  }
  function after(code) {
    return code === null || markdownLineEnding(code) ? ok(code) : nok(code);
  }
}

// node_modules/micromark-core-commonmark/lib/block-quote.js
var blockQuote = {
  continuation: {
    tokenize: tokenizeBlockQuoteContinuation
  },
  exit,
  name: "blockQuote",
  tokenize: tokenizeBlockQuoteStart
};
function tokenizeBlockQuoteStart(effects, ok, nok) {
  const self = this;
  return start;
  function start(code) {
    if (code === 62) {
      const state2 = self.containerState;
      if (!state2.open) {
        effects.enter("blockQuote", {
          _container: true
        });
        state2.open = true;
      }
      effects.enter("blockQuotePrefix");
      effects.enter("blockQuoteMarker");
      effects.consume(code);
      effects.exit("blockQuoteMarker");
      return after;
    }
    return nok(code);
  }
  function after(code) {
    if (markdownSpace(code)) {
      effects.enter("blockQuotePrefixWhitespace");
      effects.consume(code);
      effects.exit("blockQuotePrefixWhitespace");
      effects.exit("blockQuotePrefix");
      return ok;
    }
    effects.exit("blockQuotePrefix");
    return ok(code);
  }
}
function tokenizeBlockQuoteContinuation(effects, ok, nok) {
  const self = this;
  return contStart;
  function contStart(code) {
    if (markdownSpace(code)) {
      return factorySpace(effects, contBefore, "linePrefix", self.parser.constructs.disable.null.includes("codeIndented") ? void 0 : 4)(code);
    }
    return contBefore(code);
  }
  function contBefore(code) {
    return effects.attempt(blockQuote, ok, nok)(code);
  }
}
function exit(effects) {
  effects.exit("blockQuote");
}

// node_modules/micromark-core-commonmark/lib/character-escape.js
var characterEscape = {
  name: "characterEscape",
  tokenize: tokenizeCharacterEscape
};
function tokenizeCharacterEscape(effects, ok, nok) {
  return start;
  function start(code) {
    effects.enter("characterEscape");
    effects.enter("escapeMarker");
    effects.consume(code);
    effects.exit("escapeMarker");
    return inside;
  }
  function inside(code) {
    if (asciiPunctuation(code)) {
      effects.enter("characterEscapeValue");
      effects.consume(code);
      effects.exit("characterEscapeValue");
      effects.exit("characterEscape");
      return ok;
    }
    return nok(code);
  }
}

// node_modules/micromark-core-commonmark/lib/character-reference.js
var characterReference = {
  name: "characterReference",
  tokenize: tokenizeCharacterReference
};
function tokenizeCharacterReference(effects, ok, nok) {
  const self = this;
  let size = 0;
  let max;
  let test;
  return start;
  function start(code) {
    effects.enter("characterReference");
    effects.enter("characterReferenceMarker");
    effects.consume(code);
    effects.exit("characterReferenceMarker");
    return open;
  }
  function open(code) {
    if (code === 35) {
      effects.enter("characterReferenceMarkerNumeric");
      effects.consume(code);
      effects.exit("characterReferenceMarkerNumeric");
      return numeric;
    }
    effects.enter("characterReferenceValue");
    max = 31;
    test = asciiAlphanumeric;
    return value(code);
  }
  function numeric(code) {
    if (code === 88 || code === 120) {
      effects.enter("characterReferenceMarkerHexadecimal");
      effects.consume(code);
      effects.exit("characterReferenceMarkerHexadecimal");
      effects.enter("characterReferenceValue");
      max = 6;
      test = asciiHexDigit;
      return value;
    }
    effects.enter("characterReferenceValue");
    max = 7;
    test = asciiDigit;
    return value(code);
  }
  function value(code) {
    if (code === 59 && size) {
      const token = effects.exit("characterReferenceValue");
      if (test === asciiAlphanumeric && !decodeNamedCharacterReference(self.sliceSerialize(token))) {
        return nok(code);
      }
      effects.enter("characterReferenceMarker");
      effects.consume(code);
      effects.exit("characterReferenceMarker");
      effects.exit("characterReference");
      return ok;
    }
    if (test(code) && size++ < max) {
      effects.consume(code);
      return value;
    }
    return nok(code);
  }
}

// node_modules/micromark-core-commonmark/lib/code-fenced.js
var nonLazyContinuation = {
  partial: true,
  tokenize: tokenizeNonLazyContinuation
};
var codeFenced = {
  concrete: true,
  name: "codeFenced",
  tokenize: tokenizeCodeFenced
};
function tokenizeCodeFenced(effects, ok, nok) {
  const self = this;
  const closeStart = {
    partial: true,
    tokenize: tokenizeCloseStart
  };
  let initialPrefix = 0;
  let sizeOpen = 0;
  let marker;
  return start;
  function start(code) {
    return beforeSequenceOpen(code);
  }
  function beforeSequenceOpen(code) {
    const tail = self.events[self.events.length - 1];
    initialPrefix = tail && tail[1].type === "linePrefix" ? tail[2].sliceSerialize(tail[1], true).length : 0;
    marker = code;
    effects.enter("codeFenced");
    effects.enter("codeFencedFence");
    effects.enter("codeFencedFenceSequence");
    return sequenceOpen(code);
  }
  function sequenceOpen(code) {
    if (code === marker) {
      sizeOpen++;
      effects.consume(code);
      return sequenceOpen;
    }
    if (sizeOpen < 3) {
      return nok(code);
    }
    effects.exit("codeFencedFenceSequence");
    return markdownSpace(code) ? factorySpace(effects, infoBefore, "whitespace")(code) : infoBefore(code);
  }
  function infoBefore(code) {
    if (code === null || markdownLineEnding(code)) {
      effects.exit("codeFencedFence");
      return self.interrupt ? ok(code) : effects.check(nonLazyContinuation, atNonLazyBreak, after)(code);
    }
    effects.enter("codeFencedFenceInfo");
    effects.enter("chunkString", {
      contentType: "string"
    });
    return info(code);
  }
  function info(code) {
    if (code === null || markdownLineEnding(code)) {
      effects.exit("chunkString");
      effects.exit("codeFencedFenceInfo");
      return infoBefore(code);
    }
    if (markdownSpace(code)) {
      effects.exit("chunkString");
      effects.exit("codeFencedFenceInfo");
      return factorySpace(effects, metaBefore, "whitespace")(code);
    }
    if (code === 96 && code === marker) {
      return nok(code);
    }
    effects.consume(code);
    return info;
  }
  function metaBefore(code) {
    if (code === null || markdownLineEnding(code)) {
      return infoBefore(code);
    }
    effects.enter("codeFencedFenceMeta");
    effects.enter("chunkString", {
      contentType: "string"
    });
    return meta(code);
  }
  function meta(code) {
    if (code === null || markdownLineEnding(code)) {
      effects.exit("chunkString");
      effects.exit("codeFencedFenceMeta");
      return infoBefore(code);
    }
    if (code === 96 && code === marker) {
      return nok(code);
    }
    effects.consume(code);
    return meta;
  }
  function atNonLazyBreak(code) {
    return effects.attempt(closeStart, after, contentBefore)(code);
  }
  function contentBefore(code) {
    effects.enter("lineEnding");
    effects.consume(code);
    effects.exit("lineEnding");
    return contentStart;
  }
  function contentStart(code) {
    return initialPrefix > 0 && markdownSpace(code) ? factorySpace(effects, beforeContentChunk, "linePrefix", initialPrefix + 1)(code) : beforeContentChunk(code);
  }
  function beforeContentChunk(code) {
    if (code === null || markdownLineEnding(code)) {
      return effects.check(nonLazyContinuation, atNonLazyBreak, after)(code);
    }
    effects.enter("codeFlowValue");
    return contentChunk(code);
  }
  function contentChunk(code) {
    if (code === null || markdownLineEnding(code)) {
      effects.exit("codeFlowValue");
      return beforeContentChunk(code);
    }
    effects.consume(code);
    return contentChunk;
  }
  function after(code) {
    effects.exit("codeFenced");
    return ok(code);
  }
  function tokenizeCloseStart(effects2, ok2, nok2) {
    let size = 0;
    return startBefore;
    function startBefore(code) {
      effects2.enter("lineEnding");
      effects2.consume(code);
      effects2.exit("lineEnding");
      return start2;
    }
    function start2(code) {
      effects2.enter("codeFencedFence");
      return markdownSpace(code) ? factorySpace(effects2, beforeSequenceClose, "linePrefix", self.parser.constructs.disable.null.includes("codeIndented") ? void 0 : 4)(code) : beforeSequenceClose(code);
    }
    function beforeSequenceClose(code) {
      if (code === marker) {
        effects2.enter("codeFencedFenceSequence");
        return sequenceClose(code);
      }
      return nok2(code);
    }
    function sequenceClose(code) {
      if (code === marker) {
        size++;
        effects2.consume(code);
        return sequenceClose;
      }
      if (size >= sizeOpen) {
        effects2.exit("codeFencedFenceSequence");
        return markdownSpace(code) ? factorySpace(effects2, sequenceCloseAfter, "whitespace")(code) : sequenceCloseAfter(code);
      }
      return nok2(code);
    }
    function sequenceCloseAfter(code) {
      if (code === null || markdownLineEnding(code)) {
        effects2.exit("codeFencedFence");
        return ok2(code);
      }
      return nok2(code);
    }
  }
}
function tokenizeNonLazyContinuation(effects, ok, nok) {
  const self = this;
  return start;
  function start(code) {
    if (code === null) {
      return nok(code);
    }
    effects.enter("lineEnding");
    effects.consume(code);
    effects.exit("lineEnding");
    return lineStart;
  }
  function lineStart(code) {
    return self.parser.lazy[self.now().line] ? nok(code) : ok(code);
  }
}

// node_modules/micromark-core-commonmark/lib/code-indented.js
var codeIndented = {
  name: "codeIndented",
  tokenize: tokenizeCodeIndented
};
var furtherStart = {
  partial: true,
  tokenize: tokenizeFurtherStart
};
function tokenizeCodeIndented(effects, ok, nok) {
  const self = this;
  return start;
  function start(code) {
    effects.enter("codeIndented");
    return factorySpace(effects, afterPrefix, "linePrefix", 4 + 1)(code);
  }
  function afterPrefix(code) {
    const tail = self.events[self.events.length - 1];
    return tail && tail[1].type === "linePrefix" && tail[2].sliceSerialize(tail[1], true).length >= 4 ? atBreak(code) : nok(code);
  }
  function atBreak(code) {
    if (code === null) {
      return after(code);
    }
    if (markdownLineEnding(code)) {
      return effects.attempt(furtherStart, atBreak, after)(code);
    }
    effects.enter("codeFlowValue");
    return inside(code);
  }
  function inside(code) {
    if (code === null || markdownLineEnding(code)) {
      effects.exit("codeFlowValue");
      return atBreak(code);
    }
    effects.consume(code);
    return inside;
  }
  function after(code) {
    effects.exit("codeIndented");
    return ok(code);
  }
}
function tokenizeFurtherStart(effects, ok, nok) {
  const self = this;
  return furtherStart2;
  function furtherStart2(code) {
    if (self.parser.lazy[self.now().line]) {
      return nok(code);
    }
    if (markdownLineEnding(code)) {
      effects.enter("lineEnding");
      effects.consume(code);
      effects.exit("lineEnding");
      return furtherStart2;
    }
    return factorySpace(effects, afterPrefix, "linePrefix", 4 + 1)(code);
  }
  function afterPrefix(code) {
    const tail = self.events[self.events.length - 1];
    return tail && tail[1].type === "linePrefix" && tail[2].sliceSerialize(tail[1], true).length >= 4 ? ok(code) : markdownLineEnding(code) ? furtherStart2(code) : nok(code);
  }
}

// node_modules/micromark-core-commonmark/lib/code-text.js
var codeText = {
  name: "codeText",
  previous,
  resolve: resolveCodeText,
  tokenize: tokenizeCodeText
};
function resolveCodeText(events) {
  let tailExitIndex = events.length - 4;
  let headEnterIndex = 3;
  let index2;
  let enter;
  if ((events[headEnterIndex][1].type === "lineEnding" || events[headEnterIndex][1].type === "space") && (events[tailExitIndex][1].type === "lineEnding" || events[tailExitIndex][1].type === "space")) {
    index2 = headEnterIndex;
    while (++index2 < tailExitIndex) {
      if (events[index2][1].type === "codeTextData") {
        events[headEnterIndex][1].type = "codeTextPadding";
        events[tailExitIndex][1].type = "codeTextPadding";
        headEnterIndex += 2;
        tailExitIndex -= 2;
        break;
      }
    }
  }
  index2 = headEnterIndex - 1;
  tailExitIndex++;
  while (++index2 <= tailExitIndex) {
    if (enter === void 0) {
      if (index2 !== tailExitIndex && events[index2][1].type !== "lineEnding") {
        enter = index2;
      }
    } else if (index2 === tailExitIndex || events[index2][1].type === "lineEnding") {
      events[enter][1].type = "codeTextData";
      if (index2 !== enter + 2) {
        events[enter][1].end = events[index2 - 1][1].end;
        events.splice(enter + 2, index2 - enter - 2);
        tailExitIndex -= index2 - enter - 2;
        index2 = enter + 2;
      }
      enter = void 0;
    }
  }
  return events;
}
function previous(code) {
  return code !== 96 || this.events[this.events.length - 1][1].type === "characterEscape";
}
function tokenizeCodeText(effects, ok, nok) {
  const self = this;
  let sizeOpen = 0;
  let size;
  let token;
  return start;
  function start(code) {
    effects.enter("codeText");
    effects.enter("codeTextSequence");
    return sequenceOpen(code);
  }
  function sequenceOpen(code) {
    if (code === 96) {
      effects.consume(code);
      sizeOpen++;
      return sequenceOpen;
    }
    effects.exit("codeTextSequence");
    return between(code);
  }
  function between(code) {
    if (code === null) {
      return nok(code);
    }
    if (code === 32) {
      effects.enter("space");
      effects.consume(code);
      effects.exit("space");
      return between;
    }
    if (code === 96) {
      token = effects.enter("codeTextSequence");
      size = 0;
      return sequenceClose(code);
    }
    if (markdownLineEnding(code)) {
      effects.enter("lineEnding");
      effects.consume(code);
      effects.exit("lineEnding");
      return between;
    }
    effects.enter("codeTextData");
    return data(code);
  }
  function data(code) {
    if (code === null || code === 32 || code === 96 || markdownLineEnding(code)) {
      effects.exit("codeTextData");
      return between(code);
    }
    effects.consume(code);
    return data;
  }
  function sequenceClose(code) {
    if (code === 96) {
      effects.consume(code);
      size++;
      return sequenceClose;
    }
    if (size === sizeOpen) {
      effects.exit("codeTextSequence");
      effects.exit("codeText");
      return ok(code);
    }
    token.type = "codeTextData";
    return data(code);
  }
}

// node_modules/micromark-util-subtokenize/lib/splice-buffer.js
var SpliceBuffer = class {
  /**
   * @param {ReadonlyArray<T> | null | undefined} [initial]
   *   Initial items (optional).
   * @returns
   *   Splice buffer.
   */
  constructor(initial) {
    this.left = initial ? [...initial] : [];
    this.right = [];
  }
  /**
   * Array access;
   * does not move the cursor.
   *
   * @param {number} index
   *   Index.
   * @return {T}
   *   Item.
   */
  get(index2) {
    if (index2 < 0 || index2 >= this.left.length + this.right.length) {
      throw new RangeError("Cannot access index `" + index2 + "` in a splice buffer of size `" + (this.left.length + this.right.length) + "`");
    }
    if (index2 < this.left.length) return this.left[index2];
    return this.right[this.right.length - index2 + this.left.length - 1];
  }
  /**
   * The length of the splice buffer, one greater than the largest index in the
   * array.
   */
  get length() {
    return this.left.length + this.right.length;
  }
  /**
   * Remove and return `list[0]`;
   * moves the cursor to `0`.
   *
   * @returns {T | undefined}
   *   Item, optional.
   */
  shift() {
    this.setCursor(0);
    return this.right.pop();
  }
  /**
   * Slice the buffer to get an array;
   * does not move the cursor.
   *
   * @param {number} start
   *   Start.
   * @param {number | null | undefined} [end]
   *   End (optional).
   * @returns {Array<T>}
   *   Array of items.
   */
  slice(start, end) {
    const stop = end === null || end === void 0 ? Number.POSITIVE_INFINITY : end;
    if (stop < this.left.length) {
      return this.left.slice(start, stop);
    }
    if (start > this.left.length) {
      return this.right.slice(this.right.length - stop + this.left.length, this.right.length - start + this.left.length).reverse();
    }
    return this.left.slice(start).concat(this.right.slice(this.right.length - stop + this.left.length).reverse());
  }
  /**
   * Mimics the behavior of Array.prototype.splice() except for the change of
   * interface necessary to avoid segfaults when patching in very large arrays.
   *
   * This operation moves cursor is moved to `start` and results in the cursor
   * placed after any inserted items.
   *
   * @param {number} start
   *   Start;
   *   zero-based index at which to start changing the array;
   *   negative numbers count backwards from the end of the array and values
   *   that are out-of bounds are clamped to the appropriate end of the array.
   * @param {number | null | undefined} [deleteCount=0]
   *   Delete count (default: `0`);
   *   maximum number of elements to delete, starting from start.
   * @param {Array<T> | null | undefined} [items=[]]
   *   Items to include in place of the deleted items (default: `[]`).
   * @return {Array<T>}
   *   Any removed items.
   */
  splice(start, deleteCount, items) {
    const count = deleteCount || 0;
    this.setCursor(Math.trunc(start));
    const removed = this.right.splice(this.right.length - count, Number.POSITIVE_INFINITY);
    if (items) chunkedPush(this.left, items);
    return removed.reverse();
  }
  /**
   * Remove and return the highest-numbered item in the array, so
   * `list[list.length - 1]`;
   * Moves the cursor to `length`.
   *
   * @returns {T | undefined}
   *   Item, optional.
   */
  pop() {
    this.setCursor(Number.POSITIVE_INFINITY);
    return this.left.pop();
  }
  /**
   * Inserts a single item to the high-numbered side of the array;
   * moves the cursor to `length`.
   *
   * @param {T} item
   *   Item.
   * @returns {undefined}
   *   Nothing.
   */
  push(item) {
    this.setCursor(Number.POSITIVE_INFINITY);
    this.left.push(item);
  }
  /**
   * Inserts many items to the high-numbered side of the array.
   * Moves the cursor to `length`.
   *
   * @param {Array<T>} items
   *   Items.
   * @returns {undefined}
   *   Nothing.
   */
  pushMany(items) {
    this.setCursor(Number.POSITIVE_INFINITY);
    chunkedPush(this.left, items);
  }
  /**
   * Inserts a single item to the low-numbered side of the array;
   * Moves the cursor to `0`.
   *
   * @param {T} item
   *   Item.
   * @returns {undefined}
   *   Nothing.
   */
  unshift(item) {
    this.setCursor(0);
    this.right.push(item);
  }
  /**
   * Inserts many items to the low-numbered side of the array;
   * moves the cursor to `0`.
   *
   * @param {Array<T>} items
   *   Items.
   * @returns {undefined}
   *   Nothing.
   */
  unshiftMany(items) {
    this.setCursor(0);
    chunkedPush(this.right, items.reverse());
  }
  /**
   * Move the cursor to a specific position in the array. Requires
   * time proportional to the distance moved.
   *
   * If `n < 0`, the cursor will end up at the beginning.
   * If `n > length`, the cursor will end up at the end.
   *
   * @param {number} n
   *   Position.
   * @return {undefined}
   *   Nothing.
   */
  setCursor(n) {
    if (n === this.left.length || n > this.left.length && this.right.length === 0 || n < 0 && this.left.length === 0) return;
    if (n < this.left.length) {
      const removed = this.left.splice(n, Number.POSITIVE_INFINITY);
      chunkedPush(this.right, removed.reverse());
    } else {
      const removed = this.right.splice(this.left.length + this.right.length - n, Number.POSITIVE_INFINITY);
      chunkedPush(this.left, removed.reverse());
    }
  }
};
function chunkedPush(list2, right) {
  let chunkStart = 0;
  if (right.length < 1e4) {
    list2.push(...right);
  } else {
    while (chunkStart < right.length) {
      list2.push(...right.slice(chunkStart, chunkStart + 1e4));
      chunkStart += 1e4;
    }
  }
}

// node_modules/micromark-util-subtokenize/index.js
function subtokenize(eventsArray) {
  const jumps = {};
  let index2 = -1;
  let event;
  let lineIndex;
  let otherIndex;
  let otherEvent;
  let parameters;
  let subevents;
  let more;
  const events = new SpliceBuffer(eventsArray);
  while (++index2 < events.length) {
    while (index2 in jumps) {
      index2 = jumps[index2];
    }
    event = events.get(index2);
    if (index2 && event[1].type === "chunkFlow" && events.get(index2 - 1)[1].type === "listItemPrefix") {
      subevents = event[1]._tokenizer.events;
      otherIndex = 0;
      if (otherIndex < subevents.length && subevents[otherIndex][1].type === "lineEndingBlank") {
        otherIndex += 2;
      }
      if (otherIndex < subevents.length && subevents[otherIndex][1].type === "content") {
        while (++otherIndex < subevents.length) {
          if (subevents[otherIndex][1].type === "content") {
            break;
          }
          if (subevents[otherIndex][1].type === "chunkText") {
            subevents[otherIndex][1]._isInFirstContentOfListItem = true;
            otherIndex++;
          }
        }
      }
    }
    if (event[0] === "enter") {
      if (event[1].contentType) {
        Object.assign(jumps, subcontent(events, index2));
        index2 = jumps[index2];
        more = true;
      }
    } else if (event[1]._container) {
      otherIndex = index2;
      lineIndex = void 0;
      while (otherIndex--) {
        otherEvent = events.get(otherIndex);
        if (otherEvent[1].type === "lineEnding" || otherEvent[1].type === "lineEndingBlank") {
          if (otherEvent[0] === "enter") {
            if (lineIndex) {
              events.get(lineIndex)[1].type = "lineEndingBlank";
            }
            otherEvent[1].type = "lineEnding";
            lineIndex = otherIndex;
          }
        } else if (otherEvent[1].type === "linePrefix" || otherEvent[1].type === "listItemIndent") {
        } else {
          break;
        }
      }
      if (lineIndex) {
        event[1].end = {
          ...events.get(lineIndex)[1].start
        };
        parameters = events.slice(lineIndex, index2);
        parameters.unshift(event);
        events.splice(lineIndex, index2 - lineIndex + 1, parameters);
      }
    }
  }
  splice(eventsArray, 0, Number.POSITIVE_INFINITY, events.slice(0));
  return !more;
}
function subcontent(events, eventIndex) {
  const token = events.get(eventIndex)[1];
  const context = events.get(eventIndex)[2];
  let startPosition = eventIndex - 1;
  const startPositions = [];
  let tokenizer = token._tokenizer;
  if (!tokenizer) {
    tokenizer = context.parser[token.contentType](token.start);
    if (token._contentTypeTextTrailing) {
      tokenizer._contentTypeTextTrailing = true;
    }
  }
  const childEvents = tokenizer.events;
  const jumps = [];
  const gaps = {};
  let stream;
  let previous2;
  let index2 = -1;
  let current2 = token;
  let adjust = 0;
  let start = 0;
  const breaks = [start];
  while (current2) {
    while (events.get(++startPosition)[1] !== current2) {
    }
    startPositions.push(startPosition);
    if (!current2._tokenizer) {
      stream = context.sliceStream(current2);
      if (!current2.next) {
        stream.push(null);
      }
      if (previous2) {
        tokenizer.defineSkip(current2.start);
      }
      if (current2._isInFirstContentOfListItem) {
        tokenizer._gfmTasklistFirstContentOfListItem = true;
      }
      tokenizer.write(stream);
      if (current2._isInFirstContentOfListItem) {
        tokenizer._gfmTasklistFirstContentOfListItem = void 0;
      }
    }
    previous2 = current2;
    current2 = current2.next;
  }
  current2 = token;
  while (++index2 < childEvents.length) {
    if (
      // Find a void token that includes a break.
      childEvents[index2][0] === "exit" && childEvents[index2 - 1][0] === "enter" && childEvents[index2][1].type === childEvents[index2 - 1][1].type && childEvents[index2][1].start.line !== childEvents[index2][1].end.line
    ) {
      start = index2 + 1;
      breaks.push(start);
      current2._tokenizer = void 0;
      current2.previous = void 0;
      current2 = current2.next;
    }
  }
  tokenizer.events = [];
  if (current2) {
    current2._tokenizer = void 0;
    current2.previous = void 0;
  } else {
    breaks.pop();
  }
  index2 = breaks.length;
  while (index2--) {
    const slice = childEvents.slice(breaks[index2], breaks[index2 + 1]);
    const start2 = startPositions.pop();
    jumps.push([start2, start2 + slice.length - 1]);
    events.splice(start2, 2, slice);
  }
  jumps.reverse();
  index2 = -1;
  while (++index2 < jumps.length) {
    gaps[adjust + jumps[index2][0]] = adjust + jumps[index2][1];
    adjust += jumps[index2][1] - jumps[index2][0] - 1;
  }
  return gaps;
}

// node_modules/micromark-core-commonmark/lib/content.js
var content2 = {
  resolve: resolveContent,
  tokenize: tokenizeContent
};
var continuationConstruct = {
  partial: true,
  tokenize: tokenizeContinuation
};
function resolveContent(events) {
  subtokenize(events);
  return events;
}
function tokenizeContent(effects, ok) {
  let previous2;
  return chunkStart;
  function chunkStart(code) {
    effects.enter("content");
    previous2 = effects.enter("chunkContent", {
      contentType: "content"
    });
    return chunkInside(code);
  }
  function chunkInside(code) {
    if (code === null) {
      return contentEnd(code);
    }
    if (markdownLineEnding(code)) {
      return effects.check(continuationConstruct, contentContinue, contentEnd)(code);
    }
    effects.consume(code);
    return chunkInside;
  }
  function contentEnd(code) {
    effects.exit("chunkContent");
    effects.exit("content");
    return ok(code);
  }
  function contentContinue(code) {
    effects.consume(code);
    effects.exit("chunkContent");
    previous2.next = effects.enter("chunkContent", {
      contentType: "content",
      previous: previous2
    });
    previous2 = previous2.next;
    return chunkInside;
  }
}
function tokenizeContinuation(effects, ok, nok) {
  const self = this;
  return startLookahead;
  function startLookahead(code) {
    effects.exit("chunkContent");
    effects.enter("lineEnding");
    effects.consume(code);
    effects.exit("lineEnding");
    return factorySpace(effects, prefixed, "linePrefix");
  }
  function prefixed(code) {
    if (code === null || markdownLineEnding(code)) {
      return nok(code);
    }
    const tail = self.events[self.events.length - 1];
    if (!self.parser.constructs.disable.null.includes("codeIndented") && tail && tail[1].type === "linePrefix" && tail[2].sliceSerialize(tail[1], true).length >= 4) {
      return ok(code);
    }
    return effects.interrupt(self.parser.constructs.flow, nok, ok)(code);
  }
}

// node_modules/micromark-factory-destination/index.js
function factoryDestination(effects, ok, nok, type, literalType, literalMarkerType, rawType, stringType, max) {
  const limit = max || Number.POSITIVE_INFINITY;
  let balance = 0;
  return start;
  function start(code) {
    if (code === 60) {
      effects.enter(type);
      effects.enter(literalType);
      effects.enter(literalMarkerType);
      effects.consume(code);
      effects.exit(literalMarkerType);
      return enclosedBefore;
    }
    if (code === null || code === 32 || code === 41 || asciiControl(code)) {
      return nok(code);
    }
    effects.enter(type);
    effects.enter(rawType);
    effects.enter(stringType);
    effects.enter("chunkString", {
      contentType: "string"
    });
    return raw(code);
  }
  function enclosedBefore(code) {
    if (code === 62) {
      effects.enter(literalMarkerType);
      effects.consume(code);
      effects.exit(literalMarkerType);
      effects.exit(literalType);
      effects.exit(type);
      return ok;
    }
    effects.enter(stringType);
    effects.enter("chunkString", {
      contentType: "string"
    });
    return enclosed(code);
  }
  function enclosed(code) {
    if (code === 62) {
      effects.exit("chunkString");
      effects.exit(stringType);
      return enclosedBefore(code);
    }
    if (code === null || code === 60 || markdownLineEnding(code)) {
      return nok(code);
    }
    effects.consume(code);
    return code === 92 ? enclosedEscape : enclosed;
  }
  function enclosedEscape(code) {
    if (code === 60 || code === 62 || code === 92) {
      effects.consume(code);
      return enclosed;
    }
    return enclosed(code);
  }
  function raw(code) {
    if (!balance && (code === null || code === 41 || markdownLineEndingOrSpace(code))) {
      effects.exit("chunkString");
      effects.exit(stringType);
      effects.exit(rawType);
      effects.exit(type);
      return ok(code);
    }
    if (balance < limit && code === 40) {
      effects.consume(code);
      balance++;
      return raw;
    }
    if (code === 41) {
      effects.consume(code);
      balance--;
      return raw;
    }
    if (code === null || code === 32 || code === 40 || asciiControl(code)) {
      return nok(code);
    }
    effects.consume(code);
    return code === 92 ? rawEscape : raw;
  }
  function rawEscape(code) {
    if (code === 40 || code === 41 || code === 92) {
      effects.consume(code);
      return raw;
    }
    return raw(code);
  }
}

// node_modules/micromark-factory-label/index.js
function factoryLabel(effects, ok, nok, type, markerType, stringType) {
  const self = this;
  let size = 0;
  let seen;
  return start;
  function start(code) {
    effects.enter(type);
    effects.enter(markerType);
    effects.consume(code);
    effects.exit(markerType);
    effects.enter(stringType);
    return atBreak;
  }
  function atBreak(code) {
    if (size > 999 || code === null || code === 91 || code === 93 && !seen || // To do: remove in the future once we’ve switched from
    // `micromark-extension-footnote` to `micromark-extension-gfm-footnote`,
    // which doesn’t need this.
    // Hidden footnotes hook.
    /* c8 ignore next 3 */
    code === 94 && !size && "_hiddenFootnoteSupport" in self.parser.constructs) {
      return nok(code);
    }
    if (code === 93) {
      effects.exit(stringType);
      effects.enter(markerType);
      effects.consume(code);
      effects.exit(markerType);
      effects.exit(type);
      return ok;
    }
    if (markdownLineEnding(code)) {
      effects.enter("lineEnding");
      effects.consume(code);
      effects.exit("lineEnding");
      return atBreak;
    }
    effects.enter("chunkString", {
      contentType: "string"
    });
    return labelInside(code);
  }
  function labelInside(code) {
    if (code === null || code === 91 || code === 93 || markdownLineEnding(code) || size++ > 999) {
      effects.exit("chunkString");
      return atBreak(code);
    }
    effects.consume(code);
    if (!seen) seen = !markdownSpace(code);
    return code === 92 ? labelEscape : labelInside;
  }
  function labelEscape(code) {
    if (code === 91 || code === 92 || code === 93) {
      effects.consume(code);
      size++;
      return labelInside;
    }
    return labelInside(code);
  }
}

// node_modules/micromark-factory-title/index.js
function factoryTitle(effects, ok, nok, type, markerType, stringType) {
  let marker;
  return start;
  function start(code) {
    if (code === 34 || code === 39 || code === 40) {
      effects.enter(type);
      effects.enter(markerType);
      effects.consume(code);
      effects.exit(markerType);
      marker = code === 40 ? 41 : code;
      return begin;
    }
    return nok(code);
  }
  function begin(code) {
    if (code === marker) {
      effects.enter(markerType);
      effects.consume(code);
      effects.exit(markerType);
      effects.exit(type);
      return ok;
    }
    effects.enter(stringType);
    return atBreak(code);
  }
  function atBreak(code) {
    if (code === marker) {
      effects.exit(stringType);
      return begin(marker);
    }
    if (code === null) {
      return nok(code);
    }
    if (markdownLineEnding(code)) {
      effects.enter("lineEnding");
      effects.consume(code);
      effects.exit("lineEnding");
      return factorySpace(effects, atBreak, "linePrefix");
    }
    effects.enter("chunkString", {
      contentType: "string"
    });
    return inside(code);
  }
  function inside(code) {
    if (code === marker || code === null || markdownLineEnding(code)) {
      effects.exit("chunkString");
      return atBreak(code);
    }
    effects.consume(code);
    return code === 92 ? escape : inside;
  }
  function escape(code) {
    if (code === marker || code === 92) {
      effects.consume(code);
      return inside;
    }
    return inside(code);
  }
}

// node_modules/micromark-factory-whitespace/index.js
function factoryWhitespace(effects, ok) {
  let seen;
  return start;
  function start(code) {
    if (markdownLineEnding(code)) {
      effects.enter("lineEnding");
      effects.consume(code);
      effects.exit("lineEnding");
      seen = true;
      return start;
    }
    if (markdownSpace(code)) {
      return factorySpace(effects, start, seen ? "linePrefix" : "lineSuffix")(code);
    }
    return ok(code);
  }
}

// node_modules/micromark-core-commonmark/lib/definition.js
var definition = {
  name: "definition",
  tokenize: tokenizeDefinition
};
var titleBefore = {
  partial: true,
  tokenize: tokenizeTitleBefore
};
function tokenizeDefinition(effects, ok, nok) {
  const self = this;
  let identifier;
  return start;
  function start(code) {
    effects.enter("definition");
    return before(code);
  }
  function before(code) {
    return factoryLabel.call(
      self,
      effects,
      labelAfter,
      // Note: we don’t need to reset the way `markdown-rs` does.
      nok,
      "definitionLabel",
      "definitionLabelMarker",
      "definitionLabelString"
    )(code);
  }
  function labelAfter(code) {
    identifier = normalizeIdentifier(self.sliceSerialize(self.events[self.events.length - 1][1]).slice(1, -1));
    if (code === 58) {
      effects.enter("definitionMarker");
      effects.consume(code);
      effects.exit("definitionMarker");
      return markerAfter;
    }
    return nok(code);
  }
  function markerAfter(code) {
    return markdownLineEndingOrSpace(code) ? factoryWhitespace(effects, destinationBefore)(code) : destinationBefore(code);
  }
  function destinationBefore(code) {
    return factoryDestination(
      effects,
      destinationAfter,
      // Note: we don’t need to reset the way `markdown-rs` does.
      nok,
      "definitionDestination",
      "definitionDestinationLiteral",
      "definitionDestinationLiteralMarker",
      "definitionDestinationRaw",
      "definitionDestinationString"
    )(code);
  }
  function destinationAfter(code) {
    return effects.attempt(titleBefore, after, after)(code);
  }
  function after(code) {
    return markdownSpace(code) ? factorySpace(effects, afterWhitespace, "whitespace")(code) : afterWhitespace(code);
  }
  function afterWhitespace(code) {
    if (code === null || markdownLineEnding(code)) {
      effects.exit("definition");
      self.parser.defined.push(identifier);
      return ok(code);
    }
    return nok(code);
  }
}
function tokenizeTitleBefore(effects, ok, nok) {
  return titleBefore2;
  function titleBefore2(code) {
    return markdownLineEndingOrSpace(code) ? factoryWhitespace(effects, beforeMarker)(code) : nok(code);
  }
  function beforeMarker(code) {
    return factoryTitle(effects, titleAfter, nok, "definitionTitle", "definitionTitleMarker", "definitionTitleString")(code);
  }
  function titleAfter(code) {
    return markdownSpace(code) ? factorySpace(effects, titleAfterOptionalWhitespace, "whitespace")(code) : titleAfterOptionalWhitespace(code);
  }
  function titleAfterOptionalWhitespace(code) {
    return code === null || markdownLineEnding(code) ? ok(code) : nok(code);
  }
}

// node_modules/micromark-core-commonmark/lib/hard-break-escape.js
var hardBreakEscape = {
  name: "hardBreakEscape",
  tokenize: tokenizeHardBreakEscape
};
function tokenizeHardBreakEscape(effects, ok, nok) {
  return start;
  function start(code) {
    effects.enter("hardBreakEscape");
    effects.consume(code);
    return after;
  }
  function after(code) {
    if (markdownLineEnding(code)) {
      effects.exit("hardBreakEscape");
      return ok(code);
    }
    return nok(code);
  }
}

// node_modules/micromark-core-commonmark/lib/heading-atx.js
var headingAtx = {
  name: "headingAtx",
  resolve: resolveHeadingAtx,
  tokenize: tokenizeHeadingAtx
};
function resolveHeadingAtx(events, context) {
  let contentEnd = events.length - 2;
  let contentStart = 3;
  let content3;
  let text3;
  if (events[contentStart][1].type === "whitespace") {
    contentStart += 2;
  }
  if (contentEnd - 2 > contentStart && events[contentEnd][1].type === "whitespace") {
    contentEnd -= 2;
  }
  if (events[contentEnd][1].type === "atxHeadingSequence" && (contentStart === contentEnd - 1 || contentEnd - 4 > contentStart && events[contentEnd - 2][1].type === "whitespace")) {
    contentEnd -= contentStart + 1 === contentEnd ? 2 : 4;
  }
  if (contentEnd > contentStart) {
    content3 = {
      type: "atxHeadingText",
      start: events[contentStart][1].start,
      end: events[contentEnd][1].end
    };
    text3 = {
      type: "chunkText",
      start: events[contentStart][1].start,
      end: events[contentEnd][1].end,
      contentType: "text"
    };
    splice(events, contentStart, contentEnd - contentStart + 1, [["enter", content3, context], ["enter", text3, context], ["exit", text3, context], ["exit", content3, context]]);
  }
  return events;
}
function tokenizeHeadingAtx(effects, ok, nok) {
  let size = 0;
  return start;
  function start(code) {
    effects.enter("atxHeading");
    return before(code);
  }
  function before(code) {
    effects.enter("atxHeadingSequence");
    return sequenceOpen(code);
  }
  function sequenceOpen(code) {
    if (code === 35 && size++ < 6) {
      effects.consume(code);
      return sequenceOpen;
    }
    if (code === null || markdownLineEndingOrSpace(code)) {
      effects.exit("atxHeadingSequence");
      return atBreak(code);
    }
    return nok(code);
  }
  function atBreak(code) {
    if (code === 35) {
      effects.enter("atxHeadingSequence");
      return sequenceFurther(code);
    }
    if (code === null || markdownLineEnding(code)) {
      effects.exit("atxHeading");
      return ok(code);
    }
    if (markdownSpace(code)) {
      return factorySpace(effects, atBreak, "whitespace")(code);
    }
    effects.enter("atxHeadingText");
    return data(code);
  }
  function sequenceFurther(code) {
    if (code === 35) {
      effects.consume(code);
      return sequenceFurther;
    }
    effects.exit("atxHeadingSequence");
    return atBreak(code);
  }
  function data(code) {
    if (code === null || code === 35 || markdownLineEndingOrSpace(code)) {
      effects.exit("atxHeadingText");
      return atBreak(code);
    }
    effects.consume(code);
    return data;
  }
}

// node_modules/micromark-util-html-tag-name/index.js
var htmlBlockNames = [
  "address",
  "article",
  "aside",
  "base",
  "basefont",
  "blockquote",
  "body",
  "caption",
  "center",
  "col",
  "colgroup",
  "dd",
  "details",
  "dialog",
  "dir",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "frame",
  "frameset",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "head",
  "header",
  "hr",
  "html",
  "iframe",
  "legend",
  "li",
  "link",
  "main",
  "menu",
  "menuitem",
  "nav",
  "noframes",
  "ol",
  "optgroup",
  "option",
  "p",
  "param",
  "search",
  "section",
  "summary",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "title",
  "tr",
  "track",
  "ul"
];
var htmlRawNames = ["pre", "script", "style", "textarea"];

// node_modules/micromark-core-commonmark/lib/html-flow.js
var htmlFlow = {
  concrete: true,
  name: "htmlFlow",
  resolveTo: resolveToHtmlFlow,
  tokenize: tokenizeHtmlFlow
};
var blankLineBefore = {
  partial: true,
  tokenize: tokenizeBlankLineBefore
};
var nonLazyContinuationStart = {
  partial: true,
  tokenize: tokenizeNonLazyContinuationStart
};
function resolveToHtmlFlow(events) {
  let index2 = events.length;
  while (index2--) {
    if (events[index2][0] === "enter" && events[index2][1].type === "htmlFlow") {
      break;
    }
  }
  if (index2 > 1 && events[index2 - 2][1].type === "linePrefix") {
    events[index2][1].start = events[index2 - 2][1].start;
    events[index2 + 1][1].start = events[index2 - 2][1].start;
    events.splice(index2 - 2, 2);
  }
  return events;
}
function tokenizeHtmlFlow(effects, ok, nok) {
  const self = this;
  let marker;
  let closingTag;
  let buffer;
  let index2;
  let markerB;
  return start;
  function start(code) {
    return before(code);
  }
  function before(code) {
    effects.enter("htmlFlow");
    effects.enter("htmlFlowData");
    effects.consume(code);
    return open;
  }
  function open(code) {
    if (code === 33) {
      effects.consume(code);
      return declarationOpen;
    }
    if (code === 47) {
      effects.consume(code);
      closingTag = true;
      return tagCloseStart;
    }
    if (code === 63) {
      effects.consume(code);
      marker = 3;
      return self.interrupt ? ok : continuationDeclarationInside;
    }
    if (asciiAlpha(code)) {
      effects.consume(code);
      buffer = String.fromCharCode(code);
      return tagName;
    }
    return nok(code);
  }
  function declarationOpen(code) {
    if (code === 45) {
      effects.consume(code);
      marker = 2;
      return commentOpenInside;
    }
    if (code === 91) {
      effects.consume(code);
      marker = 5;
      index2 = 0;
      return cdataOpenInside;
    }
    if (asciiAlpha(code)) {
      effects.consume(code);
      marker = 4;
      return self.interrupt ? ok : continuationDeclarationInside;
    }
    return nok(code);
  }
  function commentOpenInside(code) {
    if (code === 45) {
      effects.consume(code);
      return self.interrupt ? ok : continuationDeclarationInside;
    }
    return nok(code);
  }
  function cdataOpenInside(code) {
    const value = "CDATA[";
    if (code === value.charCodeAt(index2++)) {
      effects.consume(code);
      if (index2 === value.length) {
        return self.interrupt ? ok : continuation;
      }
      return cdataOpenInside;
    }
    return nok(code);
  }
  function tagCloseStart(code) {
    if (asciiAlpha(code)) {
      effects.consume(code);
      buffer = String.fromCharCode(code);
      return tagName;
    }
    return nok(code);
  }
  function tagName(code) {
    if (code === null || code === 47 || code === 62 || markdownLineEndingOrSpace(code)) {
      const slash = code === 47;
      const name = buffer.toLowerCase();
      if (!slash && !closingTag && htmlRawNames.includes(name)) {
        marker = 1;
        return self.interrupt ? ok(code) : continuation(code);
      }
      if (htmlBlockNames.includes(buffer.toLowerCase())) {
        marker = 6;
        if (slash) {
          effects.consume(code);
          return basicSelfClosing;
        }
        return self.interrupt ? ok(code) : continuation(code);
      }
      marker = 7;
      return self.interrupt && !self.parser.lazy[self.now().line] ? nok(code) : closingTag ? completeClosingTagAfter(code) : completeAttributeNameBefore(code);
    }
    if (code === 45 || asciiAlphanumeric(code)) {
      effects.consume(code);
      buffer += String.fromCharCode(code);
      return tagName;
    }
    return nok(code);
  }
  function basicSelfClosing(code) {
    if (code === 62) {
      effects.consume(code);
      return self.interrupt ? ok : continuation;
    }
    return nok(code);
  }
  function completeClosingTagAfter(code) {
    if (markdownSpace(code)) {
      effects.consume(code);
      return completeClosingTagAfter;
    }
    return completeEnd(code);
  }
  function completeAttributeNameBefore(code) {
    if (code === 47) {
      effects.consume(code);
      return completeEnd;
    }
    if (code === 58 || code === 95 || asciiAlpha(code)) {
      effects.consume(code);
      return completeAttributeName;
    }
    if (markdownSpace(code)) {
      effects.consume(code);
      return completeAttributeNameBefore;
    }
    return completeEnd(code);
  }
  function completeAttributeName(code) {
    if (code === 45 || code === 46 || code === 58 || code === 95 || asciiAlphanumeric(code)) {
      effects.consume(code);
      return completeAttributeName;
    }
    return completeAttributeNameAfter(code);
  }
  function completeAttributeNameAfter(code) {
    if (code === 61) {
      effects.consume(code);
      return completeAttributeValueBefore;
    }
    if (markdownSpace(code)) {
      effects.consume(code);
      return completeAttributeNameAfter;
    }
    return completeAttributeNameBefore(code);
  }
  function completeAttributeValueBefore(code) {
    if (code === null || code === 60 || code === 61 || code === 62 || code === 96) {
      return nok(code);
    }
    if (code === 34 || code === 39) {
      effects.consume(code);
      markerB = code;
      return completeAttributeValueQuoted;
    }
    if (markdownSpace(code)) {
      effects.consume(code);
      return completeAttributeValueBefore;
    }
    return completeAttributeValueUnquoted(code);
  }
  function completeAttributeValueQuoted(code) {
    if (code === markerB) {
      effects.consume(code);
      markerB = null;
      return completeAttributeValueQuotedAfter;
    }
    if (code === null || markdownLineEnding(code)) {
      return nok(code);
    }
    effects.consume(code);
    return completeAttributeValueQuoted;
  }
  function completeAttributeValueUnquoted(code) {
    if (code === null || code === 34 || code === 39 || code === 47 || code === 60 || code === 61 || code === 62 || code === 96 || markdownLineEndingOrSpace(code)) {
      return completeAttributeNameAfter(code);
    }
    effects.consume(code);
    return completeAttributeValueUnquoted;
  }
  function completeAttributeValueQuotedAfter(code) {
    if (code === 47 || code === 62 || markdownSpace(code)) {
      return completeAttributeNameBefore(code);
    }
    return nok(code);
  }
  function completeEnd(code) {
    if (code === 62) {
      effects.consume(code);
      return completeAfter;
    }
    return nok(code);
  }
  function completeAfter(code) {
    if (code === null || markdownLineEnding(code)) {
      return continuation(code);
    }
    if (markdownSpace(code)) {
      effects.consume(code);
      return completeAfter;
    }
    return nok(code);
  }
  function continuation(code) {
    if (code === 45 && marker === 2) {
      effects.consume(code);
      return continuationCommentInside;
    }
    if (code === 60 && marker === 1) {
      effects.consume(code);
      return continuationRawTagOpen;
    }
    if (code === 62 && marker === 4) {
      effects.consume(code);
      return continuationClose;
    }
    if (code === 63 && marker === 3) {
      effects.consume(code);
      return continuationDeclarationInside;
    }
    if (code === 93 && marker === 5) {
      effects.consume(code);
      return continuationCdataInside;
    }
    if (markdownLineEnding(code) && (marker === 6 || marker === 7)) {
      effects.exit("htmlFlowData");
      return effects.check(blankLineBefore, continuationAfter, continuationStart)(code);
    }
    if (code === null || markdownLineEnding(code)) {
      effects.exit("htmlFlowData");
      return continuationStart(code);
    }
    effects.consume(code);
    return continuation;
  }
  function continuationStart(code) {
    return effects.check(nonLazyContinuationStart, continuationStartNonLazy, continuationAfter)(code);
  }
  function continuationStartNonLazy(code) {
    effects.enter("lineEnding");
    effects.consume(code);
    effects.exit("lineEnding");
    return continuationBefore;
  }
  function continuationBefore(code) {
    if (code === null || markdownLineEnding(code)) {
      return continuationStart(code);
    }
    effects.enter("htmlFlowData");
    return continuation(code);
  }
  function continuationCommentInside(code) {
    if (code === 45) {
      effects.consume(code);
      return continuationDeclarationInside;
    }
    return continuation(code);
  }
  function continuationRawTagOpen(code) {
    if (code === 47) {
      effects.consume(code);
      buffer = "";
      return continuationRawEndTag;
    }
    return continuation(code);
  }
  function continuationRawEndTag(code) {
    if (code === 62) {
      const name = buffer.toLowerCase();
      if (htmlRawNames.includes(name)) {
        effects.consume(code);
        return continuationClose;
      }
      return continuation(code);
    }
    if (asciiAlpha(code) && buffer.length < 8) {
      effects.consume(code);
      buffer += String.fromCharCode(code);
      return continuationRawEndTag;
    }
    return continuation(code);
  }
  function continuationCdataInside(code) {
    if (code === 93) {
      effects.consume(code);
      return continuationDeclarationInside;
    }
    return continuation(code);
  }
  function continuationDeclarationInside(code) {
    if (code === 62) {
      effects.consume(code);
      return continuationClose;
    }
    if (code === 45 && marker === 2) {
      effects.consume(code);
      return continuationDeclarationInside;
    }
    return continuation(code);
  }
  function continuationClose(code) {
    if (code === null || markdownLineEnding(code)) {
      effects.exit("htmlFlowData");
      return continuationAfter(code);
    }
    effects.consume(code);
    return continuationClose;
  }
  function continuationAfter(code) {
    effects.exit("htmlFlow");
    return ok(code);
  }
}
function tokenizeNonLazyContinuationStart(effects, ok, nok) {
  const self = this;
  return start;
  function start(code) {
    if (markdownLineEnding(code)) {
      effects.enter("lineEnding");
      effects.consume(code);
      effects.exit("lineEnding");
      return after;
    }
    return nok(code);
  }
  function after(code) {
    return self.parser.lazy[self.now().line] ? nok(code) : ok(code);
  }
}
function tokenizeBlankLineBefore(effects, ok, nok) {
  return start;
  function start(code) {
    effects.enter("lineEnding");
    effects.consume(code);
    effects.exit("lineEnding");
    return effects.attempt(blankLine, ok, nok);
  }
}

// node_modules/micromark-core-commonmark/lib/html-text.js
var htmlText = {
  name: "htmlText",
  tokenize: tokenizeHtmlText
};
function tokenizeHtmlText(effects, ok, nok) {
  const self = this;
  let marker;
  let index2;
  let returnState;
  return start;
  function start(code) {
    effects.enter("htmlText");
    effects.enter("htmlTextData");
    effects.consume(code);
    return open;
  }
  function open(code) {
    if (code === 33) {
      effects.consume(code);
      return declarationOpen;
    }
    if (code === 47) {
      effects.consume(code);
      return tagCloseStart;
    }
    if (code === 63) {
      effects.consume(code);
      return instruction;
    }
    if (asciiAlpha(code)) {
      effects.consume(code);
      return tagOpen;
    }
    return nok(code);
  }
  function declarationOpen(code) {
    if (code === 45) {
      effects.consume(code);
      return commentOpenInside;
    }
    if (code === 91) {
      effects.consume(code);
      index2 = 0;
      return cdataOpenInside;
    }
    if (asciiAlpha(code)) {
      effects.consume(code);
      return declaration;
    }
    return nok(code);
  }
  function commentOpenInside(code) {
    if (code === 45) {
      effects.consume(code);
      return commentEnd;
    }
    return nok(code);
  }
  function comment(code) {
    if (code === null) {
      return nok(code);
    }
    if (code === 45) {
      effects.consume(code);
      return commentClose;
    }
    if (markdownLineEnding(code)) {
      returnState = comment;
      return lineEndingBefore(code);
    }
    effects.consume(code);
    return comment;
  }
  function commentClose(code) {
    if (code === 45) {
      effects.consume(code);
      return commentEnd;
    }
    return comment(code);
  }
  function commentEnd(code) {
    return code === 62 ? end(code) : code === 45 ? commentClose(code) : comment(code);
  }
  function cdataOpenInside(code) {
    const value = "CDATA[";
    if (code === value.charCodeAt(index2++)) {
      effects.consume(code);
      return index2 === value.length ? cdata : cdataOpenInside;
    }
    return nok(code);
  }
  function cdata(code) {
    if (code === null) {
      return nok(code);
    }
    if (code === 93) {
      effects.consume(code);
      return cdataClose;
    }
    if (markdownLineEnding(code)) {
      returnState = cdata;
      return lineEndingBefore(code);
    }
    effects.consume(code);
    return cdata;
  }
  function cdataClose(code) {
    if (code === 93) {
      effects.consume(code);
      return cdataEnd;
    }
    return cdata(code);
  }
  function cdataEnd(code) {
    if (code === 62) {
      return end(code);
    }
    if (code === 93) {
      effects.consume(code);
      return cdataEnd;
    }
    return cdata(code);
  }
  function declaration(code) {
    if (code === null || code === 62) {
      return end(code);
    }
    if (markdownLineEnding(code)) {
      returnState = declaration;
      return lineEndingBefore(code);
    }
    effects.consume(code);
    return declaration;
  }
  function instruction(code) {
    if (code === null) {
      return nok(code);
    }
    if (code === 63) {
      effects.consume(code);
      return instructionClose;
    }
    if (markdownLineEnding(code)) {
      returnState = instruction;
      return lineEndingBefore(code);
    }
    effects.consume(code);
    return instruction;
  }
  function instructionClose(code) {
    return code === 62 ? end(code) : instruction(code);
  }
  function tagCloseStart(code) {
    if (asciiAlpha(code)) {
      effects.consume(code);
      return tagClose;
    }
    return nok(code);
  }
  function tagClose(code) {
    if (code === 45 || asciiAlphanumeric(code)) {
      effects.consume(code);
      return tagClose;
    }
    return tagCloseBetween(code);
  }
  function tagCloseBetween(code) {
    if (markdownLineEnding(code)) {
      returnState = tagCloseBetween;
      return lineEndingBefore(code);
    }
    if (markdownSpace(code)) {
      effects.consume(code);
      return tagCloseBetween;
    }
    return end(code);
  }
  function tagOpen(code) {
    if (code === 45 || asciiAlphanumeric(code)) {
      effects.consume(code);
      return tagOpen;
    }
    if (code === 47 || code === 62 || markdownLineEndingOrSpace(code)) {
      return tagOpenBetween(code);
    }
    return nok(code);
  }
  function tagOpenBetween(code) {
    if (code === 47) {
      effects.consume(code);
      return end;
    }
    if (code === 58 || code === 95 || asciiAlpha(code)) {
      effects.consume(code);
      return tagOpenAttributeName;
    }
    if (markdownLineEnding(code)) {
      returnState = tagOpenBetween;
      return lineEndingBefore(code);
    }
    if (markdownSpace(code)) {
      effects.consume(code);
      return tagOpenBetween;
    }
    return end(code);
  }
  function tagOpenAttributeName(code) {
    if (code === 45 || code === 46 || code === 58 || code === 95 || asciiAlphanumeric(code)) {
      effects.consume(code);
      return tagOpenAttributeName;
    }
    return tagOpenAttributeNameAfter(code);
  }
  function tagOpenAttributeNameAfter(code) {
    if (code === 61) {
      effects.consume(code);
      return tagOpenAttributeValueBefore;
    }
    if (markdownLineEnding(code)) {
      returnState = tagOpenAttributeNameAfter;
      return lineEndingBefore(code);
    }
    if (markdownSpace(code)) {
      effects.consume(code);
      return tagOpenAttributeNameAfter;
    }
    return tagOpenBetween(code);
  }
  function tagOpenAttributeValueBefore(code) {
    if (code === null || code === 60 || code === 61 || code === 62 || code === 96) {
      return nok(code);
    }
    if (code === 34 || code === 39) {
      effects.consume(code);
      marker = code;
      return tagOpenAttributeValueQuoted;
    }
    if (markdownLineEnding(code)) {
      returnState = tagOpenAttributeValueBefore;
      return lineEndingBefore(code);
    }
    if (markdownSpace(code)) {
      effects.consume(code);
      return tagOpenAttributeValueBefore;
    }
    effects.consume(code);
    return tagOpenAttributeValueUnquoted;
  }
  function tagOpenAttributeValueQuoted(code) {
    if (code === marker) {
      effects.consume(code);
      marker = void 0;
      return tagOpenAttributeValueQuotedAfter;
    }
    if (code === null) {
      return nok(code);
    }
    if (markdownLineEnding(code)) {
      returnState = tagOpenAttributeValueQuoted;
      return lineEndingBefore(code);
    }
    effects.consume(code);
    return tagOpenAttributeValueQuoted;
  }
  function tagOpenAttributeValueUnquoted(code) {
    if (code === null || code === 34 || code === 39 || code === 60 || code === 61 || code === 96) {
      return nok(code);
    }
    if (code === 47 || code === 62 || markdownLineEndingOrSpace(code)) {
      return tagOpenBetween(code);
    }
    effects.consume(code);
    return tagOpenAttributeValueUnquoted;
  }
  function tagOpenAttributeValueQuotedAfter(code) {
    if (code === 47 || code === 62 || markdownLineEndingOrSpace(code)) {
      return tagOpenBetween(code);
    }
    return nok(code);
  }
  function end(code) {
    if (code === 62) {
      effects.consume(code);
      effects.exit("htmlTextData");
      effects.exit("htmlText");
      return ok;
    }
    return nok(code);
  }
  function lineEndingBefore(code) {
    effects.exit("htmlTextData");
    effects.enter("lineEnding");
    effects.consume(code);
    effects.exit("lineEnding");
    return lineEndingAfter;
  }
  function lineEndingAfter(code) {
    return markdownSpace(code) ? factorySpace(effects, lineEndingAfterPrefix, "linePrefix", self.parser.constructs.disable.null.includes("codeIndented") ? void 0 : 4)(code) : lineEndingAfterPrefix(code);
  }
  function lineEndingAfterPrefix(code) {
    effects.enter("htmlTextData");
    return returnState(code);
  }
}

// node_modules/micromark-core-commonmark/lib/label-end.js
var labelEnd = {
  name: "labelEnd",
  resolveAll: resolveAllLabelEnd,
  resolveTo: resolveToLabelEnd,
  tokenize: tokenizeLabelEnd
};
var resourceConstruct = {
  tokenize: tokenizeResource
};
var referenceFullConstruct = {
  tokenize: tokenizeReferenceFull
};
var referenceCollapsedConstruct = {
  tokenize: tokenizeReferenceCollapsed
};
function resolveAllLabelEnd(events) {
  let index2 = -1;
  const newEvents = [];
  while (++index2 < events.length) {
    const token = events[index2][1];
    newEvents.push(events[index2]);
    if (token.type === "labelImage" || token.type === "labelLink" || token.type === "labelEnd") {
      const offset = token.type === "labelImage" ? 4 : 2;
      token.type = "data";
      index2 += offset;
    }
  }
  if (events.length !== newEvents.length) {
    splice(events, 0, events.length, newEvents);
  }
  return events;
}
function resolveToLabelEnd(events, context) {
  let index2 = events.length;
  let offset = 0;
  let token;
  let open;
  let close;
  let media;
  while (index2--) {
    token = events[index2][1];
    if (open) {
      if (token.type === "link" || token.type === "labelLink" && token._inactive) {
        break;
      }
      if (events[index2][0] === "enter" && token.type === "labelLink") {
        token._inactive = true;
      }
    } else if (close) {
      if (events[index2][0] === "enter" && (token.type === "labelImage" || token.type === "labelLink") && !token._balanced) {
        open = index2;
        if (token.type !== "labelLink") {
          offset = 2;
          break;
        }
      }
    } else if (token.type === "labelEnd") {
      close = index2;
    }
  }
  const group = {
    type: events[open][1].type === "labelLink" ? "link" : "image",
    start: {
      ...events[open][1].start
    },
    end: {
      ...events[events.length - 1][1].end
    }
  };
  const label = {
    type: "label",
    start: {
      ...events[open][1].start
    },
    end: {
      ...events[close][1].end
    }
  };
  const text3 = {
    type: "labelText",
    start: {
      ...events[open + offset + 2][1].end
    },
    end: {
      ...events[close - 2][1].start
    }
  };
  media = [["enter", group, context], ["enter", label, context]];
  media = push(media, events.slice(open + 1, open + offset + 3));
  media = push(media, [["enter", text3, context]]);
  media = push(media, resolveAll(context.parser.constructs.insideSpan.null, events.slice(open + offset + 4, close - 3), context));
  media = push(media, [["exit", text3, context], events[close - 2], events[close - 1], ["exit", label, context]]);
  media = push(media, events.slice(close + 1));
  media = push(media, [["exit", group, context]]);
  splice(events, open, events.length, media);
  return events;
}
function tokenizeLabelEnd(effects, ok, nok) {
  const self = this;
  let index2 = self.events.length;
  let labelStart;
  let defined;
  while (index2--) {
    if ((self.events[index2][1].type === "labelImage" || self.events[index2][1].type === "labelLink") && !self.events[index2][1]._balanced) {
      labelStart = self.events[index2][1];
      break;
    }
  }
  return start;
  function start(code) {
    if (!labelStart) {
      return nok(code);
    }
    if (labelStart._inactive) {
      return labelEndNok(code);
    }
    defined = self.parser.defined.includes(normalizeIdentifier(self.sliceSerialize({
      start: labelStart.end,
      end: self.now()
    })));
    effects.enter("labelEnd");
    effects.enter("labelMarker");
    effects.consume(code);
    effects.exit("labelMarker");
    effects.exit("labelEnd");
    return after;
  }
  function after(code) {
    if (code === 40) {
      return effects.attempt(resourceConstruct, labelEndOk, defined ? labelEndOk : labelEndNok)(code);
    }
    if (code === 91) {
      return effects.attempt(referenceFullConstruct, labelEndOk, defined ? referenceNotFull : labelEndNok)(code);
    }
    return defined ? labelEndOk(code) : labelEndNok(code);
  }
  function referenceNotFull(code) {
    return effects.attempt(referenceCollapsedConstruct, labelEndOk, labelEndNok)(code);
  }
  function labelEndOk(code) {
    return ok(code);
  }
  function labelEndNok(code) {
    labelStart._balanced = true;
    return nok(code);
  }
}
function tokenizeResource(effects, ok, nok) {
  return resourceStart;
  function resourceStart(code) {
    effects.enter("resource");
    effects.enter("resourceMarker");
    effects.consume(code);
    effects.exit("resourceMarker");
    return resourceBefore;
  }
  function resourceBefore(code) {
    return markdownLineEndingOrSpace(code) ? factoryWhitespace(effects, resourceOpen)(code) : resourceOpen(code);
  }
  function resourceOpen(code) {
    if (code === 41) {
      return resourceEnd(code);
    }
    return factoryDestination(effects, resourceDestinationAfter, resourceDestinationMissing, "resourceDestination", "resourceDestinationLiteral", "resourceDestinationLiteralMarker", "resourceDestinationRaw", "resourceDestinationString", 32)(code);
  }
  function resourceDestinationAfter(code) {
    return markdownLineEndingOrSpace(code) ? factoryWhitespace(effects, resourceBetween)(code) : resourceEnd(code);
  }
  function resourceDestinationMissing(code) {
    return nok(code);
  }
  function resourceBetween(code) {
    if (code === 34 || code === 39 || code === 40) {
      return factoryTitle(effects, resourceTitleAfter, nok, "resourceTitle", "resourceTitleMarker", "resourceTitleString")(code);
    }
    return resourceEnd(code);
  }
  function resourceTitleAfter(code) {
    return markdownLineEndingOrSpace(code) ? factoryWhitespace(effects, resourceEnd)(code) : resourceEnd(code);
  }
  function resourceEnd(code) {
    if (code === 41) {
      effects.enter("resourceMarker");
      effects.consume(code);
      effects.exit("resourceMarker");
      effects.exit("resource");
      return ok;
    }
    return nok(code);
  }
}
function tokenizeReferenceFull(effects, ok, nok) {
  const self = this;
  return referenceFull;
  function referenceFull(code) {
    return factoryLabel.call(self, effects, referenceFullAfter, referenceFullMissing, "reference", "referenceMarker", "referenceString")(code);
  }
  function referenceFullAfter(code) {
    return self.parser.defined.includes(normalizeIdentifier(self.sliceSerialize(self.events[self.events.length - 1][1]).slice(1, -1))) ? ok(code) : nok(code);
  }
  function referenceFullMissing(code) {
    return nok(code);
  }
}
function tokenizeReferenceCollapsed(effects, ok, nok) {
  return referenceCollapsedStart;
  function referenceCollapsedStart(code) {
    effects.enter("reference");
    effects.enter("referenceMarker");
    effects.consume(code);
    effects.exit("referenceMarker");
    return referenceCollapsedOpen;
  }
  function referenceCollapsedOpen(code) {
    if (code === 93) {
      effects.enter("referenceMarker");
      effects.consume(code);
      effects.exit("referenceMarker");
      effects.exit("reference");
      return ok;
    }
    return nok(code);
  }
}

// node_modules/micromark-core-commonmark/lib/label-start-image.js
var labelStartImage = {
  name: "labelStartImage",
  resolveAll: labelEnd.resolveAll,
  tokenize: tokenizeLabelStartImage
};
function tokenizeLabelStartImage(effects, ok, nok) {
  const self = this;
  return start;
  function start(code) {
    effects.enter("labelImage");
    effects.enter("labelImageMarker");
    effects.consume(code);
    effects.exit("labelImageMarker");
    return open;
  }
  function open(code) {
    if (code === 91) {
      effects.enter("labelMarker");
      effects.consume(code);
      effects.exit("labelMarker");
      effects.exit("labelImage");
      return after;
    }
    return nok(code);
  }
  function after(code) {
    return code === 94 && "_hiddenFootnoteSupport" in self.parser.constructs ? nok(code) : ok(code);
  }
}

// node_modules/micromark-core-commonmark/lib/label-start-link.js
var labelStartLink = {
  name: "labelStartLink",
  resolveAll: labelEnd.resolveAll,
  tokenize: tokenizeLabelStartLink
};
function tokenizeLabelStartLink(effects, ok, nok) {
  const self = this;
  return start;
  function start(code) {
    effects.enter("labelLink");
    effects.enter("labelMarker");
    effects.consume(code);
    effects.exit("labelMarker");
    effects.exit("labelLink");
    return after;
  }
  function after(code) {
    return code === 94 && "_hiddenFootnoteSupport" in self.parser.constructs ? nok(code) : ok(code);
  }
}

// node_modules/micromark-core-commonmark/lib/line-ending.js
var lineEnding = {
  name: "lineEnding",
  tokenize: tokenizeLineEnding
};
function tokenizeLineEnding(effects, ok) {
  return start;
  function start(code) {
    effects.enter("lineEnding");
    effects.consume(code);
    effects.exit("lineEnding");
    return factorySpace(effects, ok, "linePrefix");
  }
}

// node_modules/micromark-core-commonmark/lib/thematic-break.js
var thematicBreak = {
  name: "thematicBreak",
  tokenize: tokenizeThematicBreak
};
function tokenizeThematicBreak(effects, ok, nok) {
  let size = 0;
  let marker;
  return start;
  function start(code) {
    effects.enter("thematicBreak");
    return before(code);
  }
  function before(code) {
    marker = code;
    return atBreak(code);
  }
  function atBreak(code) {
    if (code === marker) {
      effects.enter("thematicBreakSequence");
      return sequence(code);
    }
    if (size >= 3 && (code === null || markdownLineEnding(code))) {
      effects.exit("thematicBreak");
      return ok(code);
    }
    return nok(code);
  }
  function sequence(code) {
    if (code === marker) {
      effects.consume(code);
      size++;
      return sequence;
    }
    effects.exit("thematicBreakSequence");
    return markdownSpace(code) ? factorySpace(effects, atBreak, "whitespace")(code) : atBreak(code);
  }
}

// node_modules/micromark-core-commonmark/lib/list.js
var list = {
  continuation: {
    tokenize: tokenizeListContinuation
  },
  exit: tokenizeListEnd,
  name: "list",
  tokenize: tokenizeListStart
};
var listItemPrefixWhitespaceConstruct = {
  partial: true,
  tokenize: tokenizeListItemPrefixWhitespace
};
var indentConstruct = {
  partial: true,
  tokenize: tokenizeIndent
};
function tokenizeListStart(effects, ok, nok) {
  const self = this;
  const tail = self.events[self.events.length - 1];
  let initialSize = tail && tail[1].type === "linePrefix" ? tail[2].sliceSerialize(tail[1], true).length : 0;
  let size = 0;
  return start;
  function start(code) {
    const kind = self.containerState.type || (code === 42 || code === 43 || code === 45 ? "listUnordered" : "listOrdered");
    if (kind === "listUnordered" ? !self.containerState.marker || code === self.containerState.marker : asciiDigit(code)) {
      if (!self.containerState.type) {
        self.containerState.type = kind;
        effects.enter(kind, {
          _container: true
        });
      }
      if (kind === "listUnordered") {
        effects.enter("listItemPrefix");
        return code === 42 || code === 45 ? effects.check(thematicBreak, nok, atMarker)(code) : atMarker(code);
      }
      if (!self.interrupt || code === 49) {
        effects.enter("listItemPrefix");
        effects.enter("listItemValue");
        return inside(code);
      }
    }
    return nok(code);
  }
  function inside(code) {
    if (asciiDigit(code) && ++size < 10) {
      effects.consume(code);
      return inside;
    }
    if ((!self.interrupt || size < 2) && (self.containerState.marker ? code === self.containerState.marker : code === 41 || code === 46)) {
      effects.exit("listItemValue");
      return atMarker(code);
    }
    return nok(code);
  }
  function atMarker(code) {
    effects.enter("listItemMarker");
    effects.consume(code);
    effects.exit("listItemMarker");
    self.containerState.marker = self.containerState.marker || code;
    return effects.check(
      blankLine,
      // Can’t be empty when interrupting.
      self.interrupt ? nok : onBlank,
      effects.attempt(listItemPrefixWhitespaceConstruct, endOfPrefix, otherPrefix)
    );
  }
  function onBlank(code) {
    self.containerState.initialBlankLine = true;
    initialSize++;
    return endOfPrefix(code);
  }
  function otherPrefix(code) {
    if (markdownSpace(code)) {
      effects.enter("listItemPrefixWhitespace");
      effects.consume(code);
      effects.exit("listItemPrefixWhitespace");
      return endOfPrefix;
    }
    return nok(code);
  }
  function endOfPrefix(code) {
    self.containerState.size = initialSize + self.sliceSerialize(effects.exit("listItemPrefix"), true).length;
    return ok(code);
  }
}
function tokenizeListContinuation(effects, ok, nok) {
  const self = this;
  self.containerState._closeFlow = void 0;
  return effects.check(blankLine, onBlank, notBlank);
  function onBlank(code) {
    self.containerState.furtherBlankLines = self.containerState.furtherBlankLines || self.containerState.initialBlankLine;
    return factorySpace(effects, ok, "listItemIndent", self.containerState.size + 1)(code);
  }
  function notBlank(code) {
    if (self.containerState.furtherBlankLines || !markdownSpace(code)) {
      self.containerState.furtherBlankLines = void 0;
      self.containerState.initialBlankLine = void 0;
      return notInCurrentItem(code);
    }
    self.containerState.furtherBlankLines = void 0;
    self.containerState.initialBlankLine = void 0;
    return effects.attempt(indentConstruct, ok, notInCurrentItem)(code);
  }
  function notInCurrentItem(code) {
    self.containerState._closeFlow = true;
    self.interrupt = void 0;
    return factorySpace(effects, effects.attempt(list, ok, nok), "linePrefix", self.parser.constructs.disable.null.includes("codeIndented") ? void 0 : 4)(code);
  }
}
function tokenizeIndent(effects, ok, nok) {
  const self = this;
  return factorySpace(effects, afterPrefix, "listItemIndent", self.containerState.size + 1);
  function afterPrefix(code) {
    const tail = self.events[self.events.length - 1];
    return tail && tail[1].type === "listItemIndent" && tail[2].sliceSerialize(tail[1], true).length === self.containerState.size ? ok(code) : nok(code);
  }
}
function tokenizeListEnd(effects) {
  effects.exit(this.containerState.type);
}
function tokenizeListItemPrefixWhitespace(effects, ok, nok) {
  const self = this;
  return factorySpace(effects, afterPrefix, "listItemPrefixWhitespace", self.parser.constructs.disable.null.includes("codeIndented") ? void 0 : 4 + 1);
  function afterPrefix(code) {
    const tail = self.events[self.events.length - 1];
    return !markdownSpace(code) && tail && tail[1].type === "listItemPrefixWhitespace" ? ok(code) : nok(code);
  }
}

// node_modules/micromark-core-commonmark/lib/setext-underline.js
var setextUnderline = {
  name: "setextUnderline",
  resolveTo: resolveToSetextUnderline,
  tokenize: tokenizeSetextUnderline
};
function resolveToSetextUnderline(events, context) {
  let index2 = events.length;
  let content3;
  let text3;
  let definition2;
  while (index2--) {
    if (events[index2][0] === "enter") {
      if (events[index2][1].type === "content") {
        content3 = index2;
        break;
      }
      if (events[index2][1].type === "paragraph") {
        text3 = index2;
      }
    } else {
      if (events[index2][1].type === "content") {
        events.splice(index2, 1);
      }
      if (!definition2 && events[index2][1].type === "definition") {
        definition2 = index2;
      }
    }
  }
  const heading = {
    type: "setextHeading",
    start: {
      ...events[content3][1].start
    },
    end: {
      ...events[events.length - 1][1].end
    }
  };
  events[text3][1].type = "setextHeadingText";
  if (definition2) {
    events.splice(text3, 0, ["enter", heading, context]);
    events.splice(definition2 + 1, 0, ["exit", events[content3][1], context]);
    events[content3][1].end = {
      ...events[definition2][1].end
    };
  } else {
    events[content3][1] = heading;
  }
  events.push(["exit", heading, context]);
  return events;
}
function tokenizeSetextUnderline(effects, ok, nok) {
  const self = this;
  let marker;
  return start;
  function start(code) {
    let index2 = self.events.length;
    let paragraph;
    while (index2--) {
      if (self.events[index2][1].type !== "lineEnding" && self.events[index2][1].type !== "linePrefix" && self.events[index2][1].type !== "content") {
        paragraph = self.events[index2][1].type === "paragraph";
        break;
      }
    }
    if (!self.parser.lazy[self.now().line] && (self.interrupt || paragraph)) {
      effects.enter("setextHeadingLine");
      marker = code;
      return before(code);
    }
    return nok(code);
  }
  function before(code) {
    effects.enter("setextHeadingLineSequence");
    return inside(code);
  }
  function inside(code) {
    if (code === marker) {
      effects.consume(code);
      return inside;
    }
    effects.exit("setextHeadingLineSequence");
    return markdownSpace(code) ? factorySpace(effects, after, "lineSuffix")(code) : after(code);
  }
  function after(code) {
    if (code === null || markdownLineEnding(code)) {
      effects.exit("setextHeadingLine");
      return ok(code);
    }
    return nok(code);
  }
}

// node_modules/micromark/lib/initialize/flow.js
var flow = {
  tokenize: initializeFlow
};
function initializeFlow(effects) {
  const self = this;
  const initial = effects.attempt(
    // Try to parse a blank line.
    blankLine,
    atBlankEnding,
    // Try to parse initial flow (essentially, only code).
    effects.attempt(this.parser.constructs.flowInitial, afterConstruct, factorySpace(effects, effects.attempt(this.parser.constructs.flow, afterConstruct, effects.attempt(content2, afterConstruct)), "linePrefix"))
  );
  return initial;
  function atBlankEnding(code) {
    if (code === null) {
      effects.consume(code);
      return;
    }
    effects.enter("lineEndingBlank");
    effects.consume(code);
    effects.exit("lineEndingBlank");
    self.currentConstruct = void 0;
    return initial;
  }
  function afterConstruct(code) {
    if (code === null) {
      effects.consume(code);
      return;
    }
    effects.enter("lineEnding");
    effects.consume(code);
    effects.exit("lineEnding");
    self.currentConstruct = void 0;
    return initial;
  }
}

// node_modules/micromark/lib/initialize/text.js
var resolver = {
  resolveAll: createResolver()
};
var string = initializeFactory("string");
var text = initializeFactory("text");
function initializeFactory(field) {
  return {
    resolveAll: createResolver(field === "text" ? resolveAllLineSuffixes : void 0),
    tokenize: initializeText
  };
  function initializeText(effects) {
    const self = this;
    const constructs2 = this.parser.constructs[field];
    const text3 = effects.attempt(constructs2, start, notText);
    return start;
    function start(code) {
      return atBreak(code) ? text3(code) : notText(code);
    }
    function notText(code) {
      if (code === null) {
        effects.consume(code);
        return;
      }
      effects.enter("data");
      effects.consume(code);
      return data;
    }
    function data(code) {
      if (atBreak(code)) {
        effects.exit("data");
        return text3(code);
      }
      effects.consume(code);
      return data;
    }
    function atBreak(code) {
      if (code === null) {
        return true;
      }
      const list2 = constructs2[code];
      let index2 = -1;
      if (list2) {
        while (++index2 < list2.length) {
          const item = list2[index2];
          if (!item.previous || item.previous.call(self, self.previous)) {
            return true;
          }
        }
      }
      return false;
    }
  }
}
function createResolver(extraResolver) {
  return resolveAllText;
  function resolveAllText(events, context) {
    let index2 = -1;
    let enter;
    while (++index2 <= events.length) {
      if (enter === void 0) {
        if (events[index2] && events[index2][1].type === "data") {
          enter = index2;
          index2++;
        }
      } else if (!events[index2] || events[index2][1].type !== "data") {
        if (index2 !== enter + 2) {
          events[enter][1].end = events[index2 - 1][1].end;
          events.splice(enter + 2, index2 - enter - 2);
          index2 = enter + 2;
        }
        enter = void 0;
      }
    }
    return extraResolver ? extraResolver(events, context) : events;
  }
}
function resolveAllLineSuffixes(events, context) {
  let eventIndex = 0;
  while (++eventIndex <= events.length) {
    if ((eventIndex === events.length || events[eventIndex][1].type === "lineEnding") && events[eventIndex - 1][1].type === "data") {
      const data = events[eventIndex - 1][1];
      const chunks = context.sliceStream(data);
      let index2 = chunks.length;
      let bufferIndex = -1;
      let size = 0;
      let tabs;
      while (index2--) {
        const chunk = chunks[index2];
        if (typeof chunk === "string") {
          bufferIndex = chunk.length;
          while (chunk.charCodeAt(bufferIndex - 1) === 32) {
            size++;
            bufferIndex--;
          }
          if (bufferIndex) break;
          bufferIndex = -1;
        } else if (chunk === -2) {
          tabs = true;
          size++;
        } else if (chunk === -1) {
        } else {
          index2++;
          break;
        }
      }
      if (context._contentTypeTextTrailing && eventIndex === events.length) {
        size = 0;
      }
      if (size) {
        const token = {
          type: eventIndex === events.length || tabs || size < 2 ? "lineSuffix" : "hardBreakTrailing",
          start: {
            _bufferIndex: index2 ? bufferIndex : data.start._bufferIndex + bufferIndex,
            _index: data.start._index + index2,
            line: data.end.line,
            column: data.end.column - size,
            offset: data.end.offset - size
          },
          end: {
            ...data.end
          }
        };
        data.end = {
          ...token.start
        };
        if (data.start.offset === data.end.offset) {
          Object.assign(data, token);
        } else {
          events.splice(eventIndex, 0, ["enter", token, context], ["exit", token, context]);
          eventIndex += 2;
        }
      }
      eventIndex++;
    }
  }
  return events;
}

// node_modules/micromark/lib/constructs.js
var constructs_exports = {};
__export(constructs_exports, {
  attentionMarkers: () => attentionMarkers,
  contentInitial: () => contentInitial,
  disable: () => disable,
  document: () => document3,
  flow: () => flow2,
  flowInitial: () => flowInitial,
  insideSpan: () => insideSpan,
  string: () => string2,
  text: () => text2
});
var document3 = {
  [42]: list,
  [43]: list,
  [45]: list,
  [48]: list,
  [49]: list,
  [50]: list,
  [51]: list,
  [52]: list,
  [53]: list,
  [54]: list,
  [55]: list,
  [56]: list,
  [57]: list,
  [62]: blockQuote
};
var contentInitial = {
  [91]: definition
};
var flowInitial = {
  [-2]: codeIndented,
  [-1]: codeIndented,
  [32]: codeIndented
};
var flow2 = {
  [35]: headingAtx,
  [42]: thematicBreak,
  [45]: [setextUnderline, thematicBreak],
  [60]: htmlFlow,
  [61]: setextUnderline,
  [95]: thematicBreak,
  [96]: codeFenced,
  [126]: codeFenced
};
var string2 = {
  [38]: characterReference,
  [92]: characterEscape
};
var text2 = {
  [-5]: lineEnding,
  [-4]: lineEnding,
  [-3]: lineEnding,
  [33]: labelStartImage,
  [38]: characterReference,
  [42]: attention,
  [60]: [autolink, htmlText],
  [91]: labelStartLink,
  [92]: [hardBreakEscape, characterEscape],
  [93]: labelEnd,
  [95]: attention,
  [96]: codeText
};
var insideSpan = {
  null: [attention, resolver]
};
var attentionMarkers = {
  null: [42, 95]
};
var disable = {
  null: []
};

// node_modules/micromark/lib/create-tokenizer.js
function createTokenizer(parser, initialize, from) {
  let point3 = {
    _bufferIndex: -1,
    _index: 0,
    line: from && from.line || 1,
    column: from && from.column || 1,
    offset: from && from.offset || 0
  };
  const columnStart = {};
  const resolveAllConstructs = [];
  let chunks = [];
  let stack = [];
  let consumed = true;
  const effects = {
    attempt: constructFactory(onsuccessfulconstruct),
    check: constructFactory(onsuccessfulcheck),
    consume,
    enter,
    exit: exit2,
    interrupt: constructFactory(onsuccessfulcheck, {
      interrupt: true
    })
  };
  const context = {
    code: null,
    containerState: {},
    defineSkip,
    events: [],
    now,
    parser,
    previous: null,
    sliceSerialize,
    sliceStream,
    write
  };
  let state2 = initialize.tokenize.call(context, effects);
  let expectedCode;
  if (initialize.resolveAll) {
    resolveAllConstructs.push(initialize);
  }
  return context;
  function write(slice) {
    chunks = push(chunks, slice);
    main();
    if (chunks[chunks.length - 1] !== null) {
      return [];
    }
    addResult(initialize, 0);
    context.events = resolveAll(resolveAllConstructs, context.events, context);
    return context.events;
  }
  function sliceSerialize(token, expandTabs) {
    return serializeChunks(sliceStream(token), expandTabs);
  }
  function sliceStream(token) {
    return sliceChunks(chunks, token);
  }
  function now() {
    const {
      _bufferIndex,
      _index,
      line,
      column,
      offset
    } = point3;
    return {
      _bufferIndex,
      _index,
      line,
      column,
      offset
    };
  }
  function defineSkip(value) {
    columnStart[value.line] = value.column;
    accountForPotentialSkip();
  }
  function main() {
    let chunkIndex;
    while (point3._index < chunks.length) {
      const chunk = chunks[point3._index];
      if (typeof chunk === "string") {
        chunkIndex = point3._index;
        if (point3._bufferIndex < 0) {
          point3._bufferIndex = 0;
        }
        while (point3._index === chunkIndex && point3._bufferIndex < chunk.length) {
          go(chunk.charCodeAt(point3._bufferIndex));
        }
      } else {
        go(chunk);
      }
    }
  }
  function go(code) {
    consumed = void 0;
    expectedCode = code;
    state2 = state2(code);
  }
  function consume(code) {
    if (markdownLineEnding(code)) {
      point3.line++;
      point3.column = 1;
      point3.offset += code === -3 ? 2 : 1;
      accountForPotentialSkip();
    } else if (code !== -1) {
      point3.column++;
      point3.offset++;
    }
    if (point3._bufferIndex < 0) {
      point3._index++;
    } else {
      point3._bufferIndex++;
      if (point3._bufferIndex === // Points w/ non-negative `_bufferIndex` reference
      // strings.
      /** @type {string} */
      chunks[point3._index].length) {
        point3._bufferIndex = -1;
        point3._index++;
      }
    }
    context.previous = code;
    consumed = true;
  }
  function enter(type, fields) {
    const token = fields || {};
    token.type = type;
    token.start = now();
    context.events.push(["enter", token, context]);
    stack.push(token);
    return token;
  }
  function exit2(type) {
    const token = stack.pop();
    token.end = now();
    context.events.push(["exit", token, context]);
    return token;
  }
  function onsuccessfulconstruct(construct, info) {
    addResult(construct, info.from);
  }
  function onsuccessfulcheck(_, info) {
    info.restore();
  }
  function constructFactory(onreturn, fields) {
    return hook;
    function hook(constructs2, returnState, bogusState) {
      let listOfConstructs;
      let constructIndex;
      let currentConstruct;
      let info;
      return Array.isArray(constructs2) ? (
        /* c8 ignore next 1 */
        handleListOfConstructs(constructs2)
      ) : "tokenize" in constructs2 ? (
        // Looks like a construct.
        handleListOfConstructs([
          /** @type {Construct} */
          constructs2
        ])
      ) : handleMapOfConstructs(constructs2);
      function handleMapOfConstructs(map) {
        return start;
        function start(code) {
          const left = code !== null && map[code];
          const all2 = code !== null && map.null;
          const list2 = [
            // To do: add more extension tests.
            /* c8 ignore next 2 */
            ...Array.isArray(left) ? left : left ? [left] : [],
            ...Array.isArray(all2) ? all2 : all2 ? [all2] : []
          ];
          return handleListOfConstructs(list2)(code);
        }
      }
      function handleListOfConstructs(list2) {
        listOfConstructs = list2;
        constructIndex = 0;
        if (list2.length === 0) {
          return bogusState;
        }
        return handleConstruct(list2[constructIndex]);
      }
      function handleConstruct(construct) {
        return start;
        function start(code) {
          info = store();
          currentConstruct = construct;
          if (!construct.partial) {
            context.currentConstruct = construct;
          }
          if (construct.name && context.parser.constructs.disable.null.includes(construct.name)) {
            return nok(code);
          }
          return construct.tokenize.call(
            // If we do have fields, create an object w/ `context` as its
            // prototype.
            // This allows a “live binding”, which is needed for `interrupt`.
            fields ? Object.assign(Object.create(context), fields) : context,
            effects,
            ok,
            nok
          )(code);
        }
      }
      function ok(code) {
        consumed = true;
        onreturn(currentConstruct, info);
        return returnState;
      }
      function nok(code) {
        consumed = true;
        info.restore();
        if (++constructIndex < listOfConstructs.length) {
          return handleConstruct(listOfConstructs[constructIndex]);
        }
        return bogusState;
      }
    }
  }
  function addResult(construct, from2) {
    if (construct.resolveAll && !resolveAllConstructs.includes(construct)) {
      resolveAllConstructs.push(construct);
    }
    if (construct.resolve) {
      splice(context.events, from2, context.events.length - from2, construct.resolve(context.events.slice(from2), context));
    }
    if (construct.resolveTo) {
      context.events = construct.resolveTo(context.events, context);
    }
  }
  function store() {
    const startPoint = now();
    const startPrevious = context.previous;
    const startCurrentConstruct = context.currentConstruct;
    const startEventsIndex = context.events.length;
    const startStack = Array.from(stack);
    return {
      from: startEventsIndex,
      restore
    };
    function restore() {
      point3 = startPoint;
      context.previous = startPrevious;
      context.currentConstruct = startCurrentConstruct;
      context.events.length = startEventsIndex;
      stack = startStack;
      accountForPotentialSkip();
    }
  }
  function accountForPotentialSkip() {
    if (point3.line in columnStart && point3.column < 2) {
      point3.column = columnStart[point3.line];
      point3.offset += columnStart[point3.line] - 1;
    }
  }
}
function sliceChunks(chunks, token) {
  const startIndex = token.start._index;
  const startBufferIndex = token.start._bufferIndex;
  const endIndex = token.end._index;
  const endBufferIndex = token.end._bufferIndex;
  let view;
  if (startIndex === endIndex) {
    view = [chunks[startIndex].slice(startBufferIndex, endBufferIndex)];
  } else {
    view = chunks.slice(startIndex, endIndex);
    if (startBufferIndex > -1) {
      const head = view[0];
      if (typeof head === "string") {
        view[0] = head.slice(startBufferIndex);
      } else {
        view.shift();
      }
    }
    if (endBufferIndex > 0) {
      view.push(chunks[endIndex].slice(0, endBufferIndex));
    }
  }
  return view;
}
function serializeChunks(chunks, expandTabs) {
  let index2 = -1;
  const result = [];
  let atTab;
  while (++index2 < chunks.length) {
    const chunk = chunks[index2];
    let value;
    if (typeof chunk === "string") {
      value = chunk;
    } else switch (chunk) {
      case -5: {
        value = "\r";
        break;
      }
      case -4: {
        value = "\n";
        break;
      }
      case -3: {
        value = "\r\n";
        break;
      }
      case -2: {
        value = expandTabs ? " " : "	";
        break;
      }
      case -1: {
        if (!expandTabs && atTab) continue;
        value = " ";
        break;
      }
      default: {
        value = String.fromCharCode(chunk);
      }
    }
    atTab = chunk === -2;
    result.push(value);
  }
  return result.join("");
}

// node_modules/micromark/lib/parse.js
function parse(options) {
  const settings = options || {};
  const constructs2 = (
    /** @type {FullNormalizedExtension} */
    combineExtensions([constructs_exports, ...settings.extensions || []])
  );
  const parser = {
    constructs: constructs2,
    content: create(content),
    defined: [],
    document: create(document2),
    flow: create(flow),
    lazy: {},
    string: create(string),
    text: create(text)
  };
  return parser;
  function create(initial) {
    return creator;
    function creator(from) {
      return createTokenizer(parser, initial, from);
    }
  }
}

// node_modules/micromark/lib/postprocess.js
function postprocess(events) {
  while (!subtokenize(events)) {
  }
  return events;
}

// node_modules/micromark/lib/preprocess.js
var search = /[\0\t\n\r]/g;
function preprocess() {
  let column = 1;
  let buffer = "";
  let start = true;
  let atCarriageReturn;
  return preprocessor;
  function preprocessor(value, encoding, end) {
    const chunks = [];
    let match;
    let next;
    let startPosition;
    let endPosition;
    let code;
    value = buffer + (typeof value === "string" ? value.toString() : new TextDecoder(encoding || void 0).decode(value));
    startPosition = 0;
    buffer = "";
    if (start) {
      if (value.charCodeAt(0) === 65279) {
        startPosition++;
      }
      start = void 0;
    }
    while (startPosition < value.length) {
      search.lastIndex = startPosition;
      match = search.exec(value);
      endPosition = match && match.index !== void 0 ? match.index : value.length;
      code = value.charCodeAt(endPosition);
      if (!match) {
        buffer = value.slice(startPosition);
        break;
      }
      if (code === 10 && startPosition === endPosition && atCarriageReturn) {
        chunks.push(-3);
        atCarriageReturn = void 0;
      } else {
        if (atCarriageReturn) {
          chunks.push(-5);
          atCarriageReturn = void 0;
        }
        if (startPosition < endPosition) {
          chunks.push(value.slice(startPosition, endPosition));
          column += endPosition - startPosition;
        }
        switch (code) {
          case 0: {
            chunks.push(65533);
            column++;
            break;
          }
          case 9: {
            next = Math.ceil(column / 4) * 4;
            chunks.push(-2);
            while (column++ < next) chunks.push(-1);
            break;
          }
          case 10: {
            chunks.push(-4);
            column = 1;
            break;
          }
          default: {
            atCarriageReturn = true;
            column = 1;
          }
        }
      }
      startPosition = endPosition + 1;
    }
    if (end) {
      if (atCarriageReturn) chunks.push(-5);
      if (buffer) chunks.push(buffer);
      chunks.push(null);
    }
    return chunks;
  }
}

// node_modules/micromark-util-decode-string/index.js
var characterEscapeOrReference = /\\([!-/:-@[-`{-~])|&(#(?:\d{1,7}|x[\da-f]{1,6})|[\da-z]{1,31});/gi;
function decodeString(value) {
  return value.replace(characterEscapeOrReference, decode);
}
function decode($0, $1, $2) {
  if ($1) {
    return $1;
  }
  const head = $2.charCodeAt(0);
  if (head === 35) {
    const head2 = $2.charCodeAt(1);
    const hex = head2 === 120 || head2 === 88;
    return decodeNumericCharacterReference($2.slice(hex ? 2 : 1), hex ? 16 : 10);
  }
  return decodeNamedCharacterReference($2) || $0;
}

// node_modules/unist-util-stringify-position/lib/index.js
function stringifyPosition(value) {
  if (!value || typeof value !== "object") {
    return "";
  }
  if ("position" in value || "type" in value) {
    return position(value.position);
  }
  if ("start" in value || "end" in value) {
    return position(value);
  }
  if ("line" in value || "column" in value) {
    return point(value);
  }
  return "";
}
function point(point3) {
  return index(point3 && point3.line) + ":" + index(point3 && point3.column);
}
function position(pos) {
  return point(pos && pos.start) + "-" + point(pos && pos.end);
}
function index(value) {
  return value && typeof value === "number" ? value : 1;
}

// node_modules/mdast-util-from-markdown/lib/index.js
var own = {}.hasOwnProperty;
function fromMarkdown(value, encoding, options) {
  if (encoding && typeof encoding === "object") {
    options = encoding;
    encoding = void 0;
  }
  return compiler(options)(postprocess(parse(options).document().write(preprocess()(value, encoding, true))));
}
function compiler(options) {
  const config = {
    transforms: [],
    canContainEols: ["emphasis", "fragment", "heading", "paragraph", "strong"],
    enter: {
      autolink: opener(link),
      autolinkProtocol: onenterdata,
      autolinkEmail: onenterdata,
      atxHeading: opener(heading),
      blockQuote: opener(blockQuote2),
      characterEscape: onenterdata,
      characterReference: onenterdata,
      codeFenced: opener(codeFlow),
      codeFencedFenceInfo: buffer,
      codeFencedFenceMeta: buffer,
      codeIndented: opener(codeFlow, buffer),
      codeText: opener(codeText2, buffer),
      codeTextData: onenterdata,
      data: onenterdata,
      codeFlowValue: onenterdata,
      definition: opener(definition2),
      definitionDestinationString: buffer,
      definitionLabelString: buffer,
      definitionTitleString: buffer,
      emphasis: opener(emphasis),
      hardBreakEscape: opener(hardBreak),
      hardBreakTrailing: opener(hardBreak),
      htmlFlow: opener(html, buffer),
      htmlFlowData: onenterdata,
      htmlText: opener(html, buffer),
      htmlTextData: onenterdata,
      image: opener(image),
      label: buffer,
      link: opener(link),
      listItem: opener(listItem),
      listItemValue: onenterlistitemvalue,
      listOrdered: opener(list2, onenterlistordered),
      listUnordered: opener(list2),
      paragraph: opener(paragraph),
      reference: onenterreference,
      referenceString: buffer,
      resourceDestinationString: buffer,
      resourceTitleString: buffer,
      setextHeading: opener(heading),
      strong: opener(strong),
      thematicBreak: opener(thematicBreak2)
    },
    exit: {
      atxHeading: closer(),
      atxHeadingSequence: onexitatxheadingsequence,
      autolink: closer(),
      autolinkEmail: onexitautolinkemail,
      autolinkProtocol: onexitautolinkprotocol,
      blockQuote: closer(),
      characterEscapeValue: onexitdata,
      characterReferenceMarkerHexadecimal: onexitcharacterreferencemarker,
      characterReferenceMarkerNumeric: onexitcharacterreferencemarker,
      characterReferenceValue: onexitcharacterreferencevalue,
      characterReference: onexitcharacterreference,
      codeFenced: closer(onexitcodefenced),
      codeFencedFence: onexitcodefencedfence,
      codeFencedFenceInfo: onexitcodefencedfenceinfo,
      codeFencedFenceMeta: onexitcodefencedfencemeta,
      codeFlowValue: onexitdata,
      codeIndented: closer(onexitcodeindented),
      codeText: closer(onexitcodetext),
      codeTextData: onexitdata,
      data: onexitdata,
      definition: closer(),
      definitionDestinationString: onexitdefinitiondestinationstring,
      definitionLabelString: onexitdefinitionlabelstring,
      definitionTitleString: onexitdefinitiontitlestring,
      emphasis: closer(),
      hardBreakEscape: closer(onexithardbreak),
      hardBreakTrailing: closer(onexithardbreak),
      htmlFlow: closer(onexithtmlflow),
      htmlFlowData: onexitdata,
      htmlText: closer(onexithtmltext),
      htmlTextData: onexitdata,
      image: closer(onexitimage),
      label: onexitlabel,
      labelText: onexitlabeltext,
      lineEnding: onexitlineending,
      link: closer(onexitlink),
      listItem: closer(),
      listOrdered: closer(),
      listUnordered: closer(),
      paragraph: closer(),
      referenceString: onexitreferencestring,
      resourceDestinationString: onexitresourcedestinationstring,
      resourceTitleString: onexitresourcetitlestring,
      resource: onexitresource,
      setextHeading: closer(onexitsetextheading),
      setextHeadingLineSequence: onexitsetextheadinglinesequence,
      setextHeadingText: onexitsetextheadingtext,
      strong: closer(),
      thematicBreak: closer()
    }
  };
  configure(config, (options || {}).mdastExtensions || []);
  const data = {};
  return compile;
  function compile(events) {
    let tree2 = {
      type: "root",
      children: []
    };
    const context = {
      stack: [tree2],
      tokenStack: [],
      config,
      enter,
      exit: exit2,
      buffer,
      resume,
      data
    };
    const listStack = [];
    let index2 = -1;
    while (++index2 < events.length) {
      if (events[index2][1].type === "listOrdered" || events[index2][1].type === "listUnordered") {
        if (events[index2][0] === "enter") {
          listStack.push(index2);
        } else {
          const tail = listStack.pop();
          index2 = prepareList(events, tail, index2);
        }
      }
    }
    index2 = -1;
    while (++index2 < events.length) {
      const handler = config[events[index2][0]];
      if (own.call(handler, events[index2][1].type)) {
        handler[events[index2][1].type].call(Object.assign({
          sliceSerialize: events[index2][2].sliceSerialize
        }, context), events[index2][1]);
      }
    }
    if (context.tokenStack.length > 0) {
      const tail = context.tokenStack[context.tokenStack.length - 1];
      const handler = tail[1] || defaultOnError;
      handler.call(context, void 0, tail[0]);
    }
    tree2.position = {
      start: point2(events.length > 0 ? events[0][1].start : {
        line: 1,
        column: 1,
        offset: 0
      }),
      end: point2(events.length > 0 ? events[events.length - 2][1].end : {
        line: 1,
        column: 1,
        offset: 0
      })
    };
    index2 = -1;
    while (++index2 < config.transforms.length) {
      tree2 = config.transforms[index2](tree2) || tree2;
    }
    return tree2;
  }
  function prepareList(events, start, length) {
    let index2 = start - 1;
    let containerBalance = -1;
    let listSpread = false;
    let listItem2;
    let lineIndex;
    let firstBlankLineIndex;
    let atMarker;
    while (++index2 <= length) {
      const event = events[index2];
      switch (event[1].type) {
        case "listUnordered":
        case "listOrdered":
        case "blockQuote": {
          if (event[0] === "enter") {
            containerBalance++;
          } else {
            containerBalance--;
          }
          atMarker = void 0;
          break;
        }
        case "lineEndingBlank": {
          if (event[0] === "enter") {
            if (listItem2 && !atMarker && !containerBalance && !firstBlankLineIndex) {
              firstBlankLineIndex = index2;
            }
            atMarker = void 0;
          }
          break;
        }
        case "linePrefix":
        case "listItemValue":
        case "listItemMarker":
        case "listItemPrefix":
        case "listItemPrefixWhitespace": {
          break;
        }
        default: {
          atMarker = void 0;
        }
      }
      if (!containerBalance && event[0] === "enter" && event[1].type === "listItemPrefix" || containerBalance === -1 && event[0] === "exit" && (event[1].type === "listUnordered" || event[1].type === "listOrdered")) {
        if (listItem2) {
          let tailIndex = index2;
          lineIndex = void 0;
          while (tailIndex--) {
            const tailEvent = events[tailIndex];
            if (tailEvent[1].type === "lineEnding" || tailEvent[1].type === "lineEndingBlank") {
              if (tailEvent[0] === "exit") continue;
              if (lineIndex) {
                events[lineIndex][1].type = "lineEndingBlank";
                listSpread = true;
              }
              tailEvent[1].type = "lineEnding";
              lineIndex = tailIndex;
            } else if (tailEvent[1].type === "linePrefix" || tailEvent[1].type === "blockQuotePrefix" || tailEvent[1].type === "blockQuotePrefixWhitespace" || tailEvent[1].type === "blockQuoteMarker" || tailEvent[1].type === "listItemIndent") {
            } else {
              break;
            }
          }
          if (firstBlankLineIndex && (!lineIndex || firstBlankLineIndex < lineIndex)) {
            listItem2._spread = true;
          }
          listItem2.end = Object.assign({}, lineIndex ? events[lineIndex][1].start : event[1].end);
          events.splice(lineIndex || index2, 0, ["exit", listItem2, event[2]]);
          index2++;
          length++;
        }
        if (event[1].type === "listItemPrefix") {
          const item = {
            type: "listItem",
            _spread: false,
            start: Object.assign({}, event[1].start),
            // @ts-expect-error: we’ll add `end` in a second.
            end: void 0
          };
          listItem2 = item;
          events.splice(index2, 0, ["enter", item, event[2]]);
          index2++;
          length++;
          firstBlankLineIndex = void 0;
          atMarker = true;
        }
      }
    }
    events[start][1]._spread = listSpread;
    return length;
  }
  function opener(create, and) {
    return open;
    function open(token) {
      enter.call(this, create(token), token);
      if (and) and.call(this, token);
    }
  }
  function buffer() {
    this.stack.push({
      type: "fragment",
      children: []
    });
  }
  function enter(node2, token, errorHandler) {
    const parent = this.stack[this.stack.length - 1];
    const siblings = parent.children;
    siblings.push(node2);
    this.stack.push(node2);
    this.tokenStack.push([token, errorHandler || void 0]);
    node2.position = {
      start: point2(token.start),
      // @ts-expect-error: `end` will be patched later.
      end: void 0
    };
  }
  function closer(and) {
    return close;
    function close(token) {
      if (and) and.call(this, token);
      exit2.call(this, token);
    }
  }
  function exit2(token, onExitError) {
    const node2 = this.stack.pop();
    const open = this.tokenStack.pop();
    if (!open) {
      throw new Error("Cannot close `" + token.type + "` (" + stringifyPosition({
        start: token.start,
        end: token.end
      }) + "): it\u2019s not open");
    } else if (open[0].type !== token.type) {
      if (onExitError) {
        onExitError.call(this, token, open[0]);
      } else {
        const handler = open[1] || defaultOnError;
        handler.call(this, token, open[0]);
      }
    }
    node2.position.end = point2(token.end);
  }
  function resume() {
    return toString(this.stack.pop());
  }
  function onenterlistordered() {
    this.data.expectingFirstListItemValue = true;
  }
  function onenterlistitemvalue(token) {
    if (this.data.expectingFirstListItemValue) {
      const ancestor = this.stack[this.stack.length - 2];
      ancestor.start = Number.parseInt(this.sliceSerialize(token), 10);
      this.data.expectingFirstListItemValue = void 0;
    }
  }
  function onexitcodefencedfenceinfo() {
    const data2 = this.resume();
    const node2 = this.stack[this.stack.length - 1];
    node2.lang = data2;
  }
  function onexitcodefencedfencemeta() {
    const data2 = this.resume();
    const node2 = this.stack[this.stack.length - 1];
    node2.meta = data2;
  }
  function onexitcodefencedfence() {
    if (this.data.flowCodeInside) return;
    this.buffer();
    this.data.flowCodeInside = true;
  }
  function onexitcodefenced() {
    const data2 = this.resume();
    const node2 = this.stack[this.stack.length - 1];
    node2.value = data2.replace(/^(\r?\n|\r)|(\r?\n|\r)$/g, "");
    this.data.flowCodeInside = void 0;
  }
  function onexitcodeindented() {
    const data2 = this.resume();
    const node2 = this.stack[this.stack.length - 1];
    node2.value = data2.replace(/(\r?\n|\r)$/g, "");
  }
  function onexitdefinitionlabelstring(token) {
    const label = this.resume();
    const node2 = this.stack[this.stack.length - 1];
    node2.label = label;
    node2.identifier = normalizeIdentifier(this.sliceSerialize(token)).toLowerCase();
  }
  function onexitdefinitiontitlestring() {
    const data2 = this.resume();
    const node2 = this.stack[this.stack.length - 1];
    node2.title = data2;
  }
  function onexitdefinitiondestinationstring() {
    const data2 = this.resume();
    const node2 = this.stack[this.stack.length - 1];
    node2.url = data2;
  }
  function onexitatxheadingsequence(token) {
    const node2 = this.stack[this.stack.length - 1];
    if (!node2.depth) {
      const depth = this.sliceSerialize(token).length;
      node2.depth = depth;
    }
  }
  function onexitsetextheadingtext() {
    this.data.setextHeadingSlurpLineEnding = true;
  }
  function onexitsetextheadinglinesequence(token) {
    const node2 = this.stack[this.stack.length - 1];
    node2.depth = this.sliceSerialize(token).codePointAt(0) === 61 ? 1 : 2;
  }
  function onexitsetextheading() {
    this.data.setextHeadingSlurpLineEnding = void 0;
  }
  function onenterdata(token) {
    const node2 = this.stack[this.stack.length - 1];
    const siblings = node2.children;
    let tail = siblings[siblings.length - 1];
    if (!tail || tail.type !== "text") {
      tail = text3();
      tail.position = {
        start: point2(token.start),
        // @ts-expect-error: we’ll add `end` later.
        end: void 0
      };
      siblings.push(tail);
    }
    this.stack.push(tail);
  }
  function onexitdata(token) {
    const tail = this.stack.pop();
    tail.value += this.sliceSerialize(token);
    tail.position.end = point2(token.end);
  }
  function onexitlineending(token) {
    const context = this.stack[this.stack.length - 1];
    if (this.data.atHardBreak) {
      const tail = context.children[context.children.length - 1];
      tail.position.end = point2(token.end);
      this.data.atHardBreak = void 0;
      return;
    }
    if (!this.data.setextHeadingSlurpLineEnding && config.canContainEols.includes(context.type)) {
      onenterdata.call(this, token);
      onexitdata.call(this, token);
    }
  }
  function onexithardbreak() {
    this.data.atHardBreak = true;
  }
  function onexithtmlflow() {
    const data2 = this.resume();
    const node2 = this.stack[this.stack.length - 1];
    node2.value = data2;
  }
  function onexithtmltext() {
    const data2 = this.resume();
    const node2 = this.stack[this.stack.length - 1];
    node2.value = data2;
  }
  function onexitcodetext() {
    const data2 = this.resume();
    const node2 = this.stack[this.stack.length - 1];
    node2.value = data2;
  }
  function onexitlink() {
    const node2 = this.stack[this.stack.length - 1];
    if (this.data.inReference) {
      const referenceType = this.data.referenceType || "shortcut";
      node2.type += "Reference";
      node2.referenceType = referenceType;
      delete node2.url;
      delete node2.title;
    } else {
      delete node2.identifier;
      delete node2.label;
    }
    this.data.referenceType = void 0;
  }
  function onexitimage() {
    const node2 = this.stack[this.stack.length - 1];
    if (this.data.inReference) {
      const referenceType = this.data.referenceType || "shortcut";
      node2.type += "Reference";
      node2.referenceType = referenceType;
      delete node2.url;
      delete node2.title;
    } else {
      delete node2.identifier;
      delete node2.label;
    }
    this.data.referenceType = void 0;
  }
  function onexitlabeltext(token) {
    const string3 = this.sliceSerialize(token);
    const ancestor = this.stack[this.stack.length - 2];
    ancestor.label = decodeString(string3);
    ancestor.identifier = normalizeIdentifier(string3).toLowerCase();
  }
  function onexitlabel() {
    const fragment = this.stack[this.stack.length - 1];
    const value = this.resume();
    const node2 = this.stack[this.stack.length - 1];
    this.data.inReference = true;
    if (node2.type === "link") {
      const children = fragment.children;
      node2.children = children;
    } else {
      node2.alt = value;
    }
  }
  function onexitresourcedestinationstring() {
    const data2 = this.resume();
    const node2 = this.stack[this.stack.length - 1];
    node2.url = data2;
  }
  function onexitresourcetitlestring() {
    const data2 = this.resume();
    const node2 = this.stack[this.stack.length - 1];
    node2.title = data2;
  }
  function onexitresource() {
    this.data.inReference = void 0;
  }
  function onenterreference() {
    this.data.referenceType = "collapsed";
  }
  function onexitreferencestring(token) {
    const label = this.resume();
    const node2 = this.stack[this.stack.length - 1];
    node2.label = label;
    node2.identifier = normalizeIdentifier(this.sliceSerialize(token)).toLowerCase();
    this.data.referenceType = "full";
  }
  function onexitcharacterreferencemarker(token) {
    this.data.characterReferenceType = token.type;
  }
  function onexitcharacterreferencevalue(token) {
    const data2 = this.sliceSerialize(token);
    const type = this.data.characterReferenceType;
    let value;
    if (type) {
      value = decodeNumericCharacterReference(data2, type === "characterReferenceMarkerNumeric" ? 10 : 16);
      this.data.characterReferenceType = void 0;
    } else {
      const result = decodeNamedCharacterReference(data2);
      value = result;
    }
    const tail = this.stack[this.stack.length - 1];
    tail.value += value;
  }
  function onexitcharacterreference(token) {
    const tail = this.stack.pop();
    tail.position.end = point2(token.end);
  }
  function onexitautolinkprotocol(token) {
    onexitdata.call(this, token);
    const node2 = this.stack[this.stack.length - 1];
    node2.url = this.sliceSerialize(token);
  }
  function onexitautolinkemail(token) {
    onexitdata.call(this, token);
    const node2 = this.stack[this.stack.length - 1];
    node2.url = "mailto:" + this.sliceSerialize(token);
  }
  function blockQuote2() {
    return {
      type: "blockquote",
      children: []
    };
  }
  function codeFlow() {
    return {
      type: "code",
      lang: null,
      meta: null,
      value: ""
    };
  }
  function codeText2() {
    return {
      type: "inlineCode",
      value: ""
    };
  }
  function definition2() {
    return {
      type: "definition",
      identifier: "",
      label: null,
      title: null,
      url: ""
    };
  }
  function emphasis() {
    return {
      type: "emphasis",
      children: []
    };
  }
  function heading() {
    return {
      type: "heading",
      // @ts-expect-error `depth` will be set later.
      depth: 0,
      children: []
    };
  }
  function hardBreak() {
    return {
      type: "break"
    };
  }
  function html() {
    return {
      type: "html",
      value: ""
    };
  }
  function image() {
    return {
      type: "image",
      title: null,
      url: "",
      alt: null
    };
  }
  function link() {
    return {
      type: "link",
      title: null,
      url: "",
      children: []
    };
  }
  function list2(token) {
    return {
      type: "list",
      ordered: token.type === "listOrdered",
      start: null,
      spread: token._spread,
      children: []
    };
  }
  function listItem(token) {
    return {
      type: "listItem",
      spread: token._spread,
      checked: null,
      children: []
    };
  }
  function paragraph() {
    return {
      type: "paragraph",
      children: []
    };
  }
  function strong() {
    return {
      type: "strong",
      children: []
    };
  }
  function text3() {
    return {
      type: "text",
      value: ""
    };
  }
  function thematicBreak2() {
    return {
      type: "thematicBreak"
    };
  }
}
function point2(d) {
  return {
    line: d.line,
    column: d.column,
    offset: d.offset
  };
}
function configure(combined, extensions) {
  let index2 = -1;
  while (++index2 < extensions.length) {
    const value = extensions[index2];
    if (Array.isArray(value)) {
      configure(combined, value);
    } else {
      extension(combined, value);
    }
  }
}
function extension(combined, extension2) {
  let key;
  for (key in extension2) {
    if (own.call(extension2, key)) {
      switch (key) {
        case "canContainEols": {
          const right = extension2[key];
          if (right) {
            combined[key].push(...right);
          }
          break;
        }
        case "transforms": {
          const right = extension2[key];
          if (right) {
            combined[key].push(...right);
          }
          break;
        }
        case "enter":
        case "exit": {
          const right = extension2[key];
          if (right) {
            Object.assign(combined[key], right);
          }
          break;
        }
      }
    }
  }
}
function defaultOnError(left, right) {
  if (left) {
    throw new Error("Cannot close `" + left.type + "` (" + stringifyPosition({
      start: left.start,
      end: left.end
    }) + "): a different token (`" + right.type + "`, " + stringifyPosition({
      start: right.start,
      end: right.end
    }) + ") is open");
  } else {
    throw new Error("Cannot close document, a token (`" + right.type + "`, " + stringifyPosition({
      start: right.start,
      end: right.end
    }) + ") is still open");
  }
}

// src/core/paths.ts
var ATTACHMENTS_DIR = "attachments";

// src/markdown/links.ts
var EXTERNAL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
var ARTIFACT_SCHEME_RE = /^(https?:|mailto:|tent-artifact:)/i;
function extractOutLinks(body) {
  return extractOutLinksDetailed(body).map(toPublicOutLink);
}
function extractOutLinksDetailed(body) {
  const tree2 = fromMarkdown(body);
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  const definitions = collectDefinitions(tree2);
  walk(tree2, (node2) => {
    if (node2.type === "link") {
      const link = outLinkFromMdast(node2);
      if (link) pushLink(out, seen, link);
      return "skip";
    }
    if (node2.type === "linkReference") {
      const definition2 = definitions.get(normalizeIdentifier2(node2.identifier));
      const link = definition2 ? outLinkFromReference(node2, definition2) : null;
      if (link) pushLink(out, seen, link);
      return "skip";
    }
    if (node2.type === "image") return "skip";
    if (node2.type === "text") {
      const start = node2.position?.start?.offset;
      const end = node2.position?.end?.offset;
      const text3 = start != null && end != null ? body.slice(start, end) : node2.value;
      scanWikiInProse(text3, out, seen);
    }
  });
  return out;
}
function walk(node2, visit) {
  if (visit(node2) === "skip") return;
  if ("children" in node2 && Array.isArray(node2.children)) {
    for (const child of node2.children) walk(child, visit);
  }
}
function outLinkFromMdast(node2) {
  return outLinkFromHref(node2.url, collectText(node2));
}
function outLinkFromReference(node2, definition2) {
  return outLinkFromHref(definition2.url, collectText(node2));
}
function outLinkFromHref(url, rawLabel) {
  const href = (url ?? "").trim();
  if (!href) return null;
  const label = rawLabel.replace(/\s+/g, " ").trim() || void 0;
  if (ARTIFACT_SCHEME_RE.test(href) || isExternalHref(href)) {
    return { raw: href, kind: "artifact", label, targetPath: href };
  }
  if (isPureAnchor(href)) return null;
  const { pathPart, fragment } = splitHref(href);
  if (!pathPart || isAttachmentPath(pathPart)) return null;
  return { raw: href, kind: "md", label, fragment, targetPath: pathPart };
}
function collectDefinitions(tree2) {
  const definitions = /* @__PURE__ */ new Map();
  walk(tree2, (node2) => {
    if (node2.type === "definition") {
      const key = normalizeIdentifier2(node2.identifier);
      if (!definitions.has(key)) definitions.set(key, node2);
    }
  });
  return definitions;
}
function normalizeIdentifier2(identifier) {
  return identifier.trim().replace(/\s+/g, " ").toLowerCase();
}
function collectText(node2) {
  if ("value" in node2 && typeof node2.value === "string") return node2.value;
  if ("children" in node2 && Array.isArray(node2.children)) {
    return node2.children.map(collectText).join("");
  }
  return "";
}
function scanWikiInProse(text3, out, seen) {
  let i = 0;
  while (i < text3.length) {
    if (text3[i] === "\\" && i + 1 < text3.length) {
      i += 2;
      continue;
    }
    if (text3[i] === "!" && text3[i + 1] === "[" && text3[i + 2] === "[") {
      const embedEnd = findWikiEnd(text3, i + 2);
      i = embedEnd === -1 ? i + 3 : embedEnd + 1;
      continue;
    }
    if (text3[i] === "[" && text3[i + 1] === "[") {
      const parsed = tryParseWikiLink(text3, i);
      if (parsed) {
        if (parsed.link) pushLink(out, seen, parsed.link);
        i = parsed.next;
        continue;
      }
    }
    i += 1;
  }
}
function tryParseWikiLink(text3, start) {
  if (text3[start] !== "[" || text3[start + 1] !== "[" || isEscaped(text3, start)) return null;
  const end = findWikiEnd(text3, start + 2);
  if (end === -1) return null;
  const next = end + 1;
  const inner = text3.slice(start + 2, end);
  if (!inner) return { link: null, next };
  let targetPart = inner;
  let label;
  const pipe = findUnescapedChar(inner, "|");
  if (pipe !== -1) {
    targetPart = inner.slice(0, pipe);
    label = inner.slice(pipe + 1).trim() || void 0;
  }
  const rawTarget = targetPart.trim();
  if (!rawTarget) return { link: null, next };
  const { target, fragment, blockRef } = stripWikiSuffix(rawTarget);
  if (!target || isAttachmentPath(target) || isPureAnchor(target) || isExternalHref(target)) {
    return { link: null, next };
  }
  return {
    link: { raw: rawTarget, kind: "wiki", label, fragment, blockRef, targetPath: target },
    next
  };
}
function findWikiEnd(text3, from) {
  for (let i = from; i < text3.length - 1; i++) {
    if (text3[i] === "]" && text3[i + 1] === "]" && !isEscaped(text3, i)) return i;
    if (text3[i] === "[" && text3[i + 1] === "[" && !isEscaped(text3, i)) return -1;
  }
  return -1;
}
function toPublicOutLink(link) {
  return {
    raw: link.raw,
    kind: link.kind,
    label: link.label,
    targetNodeId: link.targetNodeId,
    targetPath: link.targetPath
  };
}
function pushLink(out, seen, link) {
  const key = `${link.kind}:${link.raw}|${link.label ?? ""}`;
  if (seen.has(key)) return;
  seen.add(key);
  out.push(link);
}
function stripWikiSuffix(raw) {
  const t = raw.trim();
  const caret = t.lastIndexOf("^");
  if (caret > 0) {
    const blockRef = t.slice(caret + 1).trim() || void 0;
    const before = t.slice(0, caret);
    const hash2 = before.indexOf("#");
    if (hash2 >= 0) {
      return {
        target: before.slice(0, hash2).trim(),
        fragment: before.slice(hash2 + 1).trim() || void 0,
        blockRef
      };
    }
    return { target: before.trim(), blockRef };
  }
  const hash = t.indexOf("#");
  if (hash >= 0) {
    return { target: t.slice(0, hash).trim(), fragment: t.slice(hash + 1).trim() || void 0 };
  }
  return { target: t };
}
function splitHref(href) {
  const t = href.trim();
  const q = t.indexOf("?");
  const h = t.indexOf("#");
  let pathEnd = t.length;
  if (q >= 0) pathEnd = Math.min(pathEnd, q);
  if (h >= 0) pathEnd = Math.min(pathEnd, h);
  return {
    pathPart: t.slice(0, pathEnd),
    fragment: h >= 0 ? t.slice(h + 1).split("?")[0] || void 0 : void 0
  };
}
function isPureAnchor(href) {
  const t = href.trim();
  return t.startsWith("#") || t === "";
}
function isExternalHref(href) {
  const t = href.trim();
  return t.startsWith("//") || ARTIFACT_SCHEME_RE.test(t) || EXTERNAL_SCHEME_RE.test(t);
}
function isAttachmentPath(href) {
  const t = href.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!t) return false;
  if (t === ATTACHMENTS_DIR || t.startsWith(`${ATTACHMENTS_DIR}/`)) return true;
  if (t.includes(`/${ATTACHMENTS_DIR}/`)) return true;
  const stack = [];
  for (const p of t.split("/")) {
    if (p === "." || p === "") continue;
    if (p === "..") stack.pop();
    else stack.push(p);
  }
  return stack[0] === ATTACHMENTS_DIR;
}
function isEscaped(text3, index2) {
  let bs = 0;
  for (let i = index2 - 1; i >= 0 && text3[i] === "\\"; i--) bs += 1;
  return bs % 2 === 1;
}
function findUnescapedChar(text3, ch) {
  for (let i = 0; i < text3.length; i++) {
    if (text3[i] === ch && !isEscaped(text3, i)) return i;
  }
  return -1;
}

// src/markdown/render.ts
function escapeHtml(text3) {
  return text3.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function renderMarkdownToHtml(body, options) {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const html = [];
  let i = 0;
  let inCode = false;
  let codeLang = "";
  let codeBuf = [];
  let listType = null;
  const closeList = () => {
    if (listType) {
      html.push(`</${listType}>`);
      listType = null;
    }
  };
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("```")) {
      if (!inCode) {
        closeList();
        inCode = true;
        codeLang = line.slice(3).trim();
        codeBuf = [];
      } else {
        html.push(
          `<pre class="md-code"${codeLang ? ` data-lang="${escapeHtml(codeLang)}"` : ""}><code>${escapeHtml(codeBuf.join("\n"))}</code></pre>`
        );
        inCode = false;
        codeLang = "";
        codeBuf = [];
      }
      i++;
      continue;
    }
    if (inCode) {
      codeBuf.push(line);
      i++;
      continue;
    }
    if (!line.trim()) {
      closeList();
      i++;
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      closeList();
      const level = heading[1].length;
      html.push(`<h${level}>${inline(heading[2], options)}</h${level}>`);
      i++;
      continue;
    }
    const ul = /^[-*+]\s+(.*)$/.exec(line);
    if (ul) {
      if (listType !== "ul") {
        closeList();
        listType = "ul";
        html.push("<ul>");
      }
      html.push(`<li>${inline(ul[1], options)}</li>`);
      i++;
      continue;
    }
    const ol = /^(\d+)\.\s+(.*)$/.exec(line);
    if (ol) {
      if (listType !== "ol") {
        closeList();
        listType = "ol";
        html.push("<ol>");
      }
      html.push(`<li>${inline(ol[2], options)}</li>`);
      i++;
      continue;
    }
    closeList();
    html.push(`<p>${inline(line, options)}</p>`);
    i++;
  }
  closeList();
  if (inCode) {
    html.push(`<pre class="md-code"><code>${escapeHtml(codeBuf.join("\n"))}</code></pre>`);
  }
  if (options?.artifactRefs?.length) {
    html.push(`<aside class="artifact-chips" aria-label="Artifact references">`);
    for (const ref of options.artifactRefs) {
      const label = escapeHtml(ref.label || ref.target);
      html.push(
        `<span class="artifact-chip" data-kind="${escapeHtml(ref.kind)}" data-target="${escapeHtml(ref.target)}" title="Open externally">${label}</span>`
      );
    }
    html.push(`</aside>`);
  }
  return html.join("\n");
}
function inline(text3, options) {
  let s = escapeHtml(text3);
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt, src) => {
    return `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" />`;
  });
  s = applyLinksFromOriginal(text3, options);
  return s;
}
function applyLinksFromOriginal(text3, options) {
  const parts = [];
  let cursor = 0;
  const re = /(!?\[\[([^\]|]+)(?:\|([^\]]+))?\]\])|(!?\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\))/g;
  let m;
  while (m = re.exec(text3)) {
    if (m.index > cursor) {
      parts.push({ kind: "text", value: text3.slice(cursor, m.index) });
    }
    const full = m[0];
    if (full.startsWith("![[") || full.startsWith("![") && !full.startsWith("![[")) {
      if (full.startsWith("![")) {
        const alt = m[5] ?? "";
        const src = m[6] ?? "";
        parts.push({
          kind: "html",
          value: `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" />`
        });
      } else {
        parts.push({ kind: "text", value: full });
      }
    } else if (full.startsWith("[[")) {
      const raw = (m[2] ?? "").trim();
      const label = (m[3] ?? raw).trim();
      const href = options?.resolveWikiHref?.(raw) ?? `#cx:${encodeURIComponent(raw)}`;
      parts.push({
        kind: "html",
        value: `<a class="wiki-link" href="${escapeHtml(href)}" data-wiki="${escapeHtml(raw)}">${escapeHtml(label)}</a>`
      });
    } else {
      const label = m[5] ?? "";
      const href = m[6] ?? "";
      parts.push({
        kind: "html",
        value: `<a href="${escapeHtml(href)}">${escapeHtml(label || href)}</a>`
      });
    }
    cursor = m.index + full.length;
  }
  if (cursor < text3.length) parts.push({ kind: "text", value: text3.slice(cursor) });
  return parts.map((p) => {
    if (p.kind === "html") return p.value;
    let t = escapeHtml(p.value);
    t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    t = t.replace(/\*([^*]+)\*/g, "<em>$1</em>");
    t = t.replace(/`([^`]+)`/g, "<code>$1</code>");
    return t;
  }).join("");
}

// src/desktop/workbench/pending-interactions.ts
var PENDING_INTERACTION_EVENT_TYPES = [
  "toolApproval.pending",
  "toolApproval.resolved",
  "decisionRequest.pending",
  "decisionRequest.resolved",
  "taskInput.pending",
  "taskInput.delivered",
  "taskInput.consumed",
  "taskInput.cancelled",
  "delivery.updated",
  "task.state",
  "proposal.updated"
];
function isPendingInteractionEventType(type) {
  return PENDING_INTERACTION_EVENT_TYPES.includes(type);
}
var TASK_PROJECTION_EVENT_TYPES = [
  "task.state",
  "delivery.updated",
  "decisionRequest.pending",
  "decisionRequest.resolved",
  "toolApproval.pending",
  "toolApproval.resolved",
  "taskInput.pending",
  "taskInput.delivered",
  "taskInput.consumed",
  "taskInput.cancelled"
];
function isTaskProjectionEventType(type) {
  return TASK_PROJECTION_EVENT_TYPES.includes(type);
}
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function str(value) {
  return typeof value === "string" && value.length > 0 ? value : void 0;
}
function strOrEmpty(value) {
  return typeof value === "string" ? value : "";
}
function summarizeToolApprovalOptions(options) {
  if (!options?.length) return "";
  return options.map((o) => o.name || o.kind || o.optionId || "").filter(Boolean).join(" \xB7 ");
}
function normalizeDecisionRequest(raw) {
  if (!isRecord(raw)) return null;
  const id = str(raw.id);
  const taskPath = str(raw.taskPath);
  const taskId = str(raw.taskId);
  const question = str(raw.question);
  const requester = isRecord(raw.requester) ? raw.requester : null;
  const target = isRecord(raw.target) ? raw.target : null;
  if (!id || !taskPath || !taskId || !question || requester?.kind !== "session" || !str(requester.id) || target?.kind !== "user" && target?.kind !== "role" || !str(target.id)) return null;
  const optionsRaw = Array.isArray(raw.options) ? raw.options : [];
  const options = [];
  for (const c of optionsRaw) {
    if (!isRecord(c)) continue;
    const cid = str(c.id);
    const label = str(c.label);
    if (cid && label) options.push({ id: cid, label });
  }
  return {
    kind: "decisionRequest",
    id,
    taskPath,
    taskId,
    requester: { kind: "session", id: str(requester.id) },
    target: { kind: target.kind, id: str(target.id) },
    question,
    options,
    createdAt: strOrEmpty(raw.createdAt)
  };
}
function normalizeToolApproval(raw) {
  if (!isRecord(raw)) return null;
  const id = str(raw.id);
  const sessionId = str(raw.sessionId);
  const toolTitle = str(raw.toolTitle);
  if (!id || !sessionId || !toolTitle) return null;
  const optionsRaw = Array.isArray(raw.options) ? raw.options : [];
  const options = [];
  for (const o of optionsRaw) {
    if (!isRecord(o)) continue;
    const optionId = str(o.optionId);
    if (!optionId) continue;
    options.push({
      optionId,
      kind: str(o.kind),
      name: str(o.name)
    });
  }
  return {
    kind: "toolApproval",
    id,
    sessionId,
    taskPath: str(raw.taskPath),
    taskId: str(raw.taskId),
    role: str(raw.role),
    toolTitle,
    paramsSummary: summarizeToolApprovalOptions(options),
    options,
    createdAt: strOrEmpty(raw.createdAt),
    expiresAt: strOrEmpty(raw.expiresAt)
  };
}
function normalizeTaskInput(raw) {
  if (!isRecord(raw)) return null;
  const id = str(raw.id);
  const taskPath = str(raw.taskPath);
  if (!id || !taskPath) return null;
  const status = str(raw.status) || "pending";
  if (status !== "pending") return null;
  const kindRaw = str(raw.kind) || "user-input";
  const refs = Array.isArray(raw.contextRefs) ? raw.contextRefs.filter((r) => typeof r === "string" && r.length > 0) : [];
  return {
    kind: "taskInput",
    id,
    taskPath,
    taskId: str(raw.taskId),
    sessionId: str(raw.sessionId),
    role: str(raw.role),
    inputKind: kindRaw,
    text: str(raw.text),
    contextRefs: refs,
    status,
    createdAt: strOrEmpty(raw.createdAt)
  };
}
function normalizeProposal(raw) {
  if (!isRecord(raw)) return null;
  const path = str(raw.path);
  if (!path) return null;
  const status = str(raw.status) || "pending";
  if (status !== "pending") return null;
  return {
    kind: "proposal",
    path,
    nodeId: strOrEmpty(raw.nodeId),
    role: strOrEmpty(raw.role),
    status,
    body: strOrEmpty(raw.body),
    createdAt: str(raw.createdAt)
  };
}
function normalizeDecisionRequestList(result) {
  const list2 = isRecord(result) && Array.isArray(result.requests) ? result.requests : [];
  return list2.map(normalizeDecisionRequest).filter((x) => !!x);
}
function normalizeToolApprovalList(result) {
  const list2 = isRecord(result) && Array.isArray(result.approvals) ? result.approvals : [];
  return list2.map(normalizeToolApproval).filter((x) => !!x);
}
function normalizeTaskInputList(result) {
  const list2 = isRecord(result) && Array.isArray(result.inputs) ? result.inputs : [];
  return list2.map(normalizeTaskInput).filter((x) => !!x);
}
function normalizeProposalList(result) {
  const list2 = isRecord(result) && Array.isArray(result.proposals) ? result.proposals : [];
  return list2.map(normalizeProposal).filter((x) => !!x);
}
function pendingInteractionCount(parts) {
  return (parts.decisionRequests?.length ?? 0) + (parts.toolApprovals?.length ?? 0) + (parts.taskInputs?.length ?? 0) + (parts.proposals?.length ?? 0);
}
function buildDecisionResponsePayload(workspaceId2, taskPath, requestId, args) {
  const id = requestId.trim();
  if (!workspaceId2) return { ok: false, reason: "\u7F3A\u5C11\u5DE5\u4F5C\u533A\u3002" };
  if (!taskPath.trim()) return { ok: false, reason: "\u7F3A\u5C11\u4EFB\u52A1\u8DEF\u5F84\u3002" };
  if (!id) return { ok: false, reason: "\u7F3A\u5C11 Decision Request id\u3002" };
  const text3 = args.text?.trim() || "";
  const optionId = args.optionId?.trim() || "";
  if (Boolean(text3) === Boolean(optionId)) {
    return { ok: false, reason: "\u8BF7\u9009\u62E9\u4E00\u4E2A\u9009\u9879\u6216\u586B\u5199\u56DE\u590D\u3002" };
  }
  return {
    ok: true,
    payload: {
      workspaceId: workspaceId2,
      taskPath: taskPath.trim(),
      requestId: id,
      response: optionId ? { kind: "option", optionId } : { kind: "custom", text: text3 }
    }
  };
}
function buildDecisionDenyPayload(workspaceId2, taskPath, requestId) {
  return {
    workspaceId: workspaceId2,
    taskPath,
    requestId,
    response: { kind: "deny" }
  };
}
function buildToolApprovalResolvePayload(approvalId, allow, actor = "user") {
  return {
    method: allow ? "toolApproval.approveOnce" : "toolApproval.deny",
    params: { approvalId, actor }
  };
}
function buildTaskSendInputPayload(workspaceId2, taskPath, text3, actor = "user") {
  const t = text3.trim();
  if (!workspaceId2) return { ok: false, reason: "\u7F3A\u5C11\u5DE5\u4F5C\u533A\u3002" };
  if (!taskPath.trim()) return { ok: false, reason: "\u7F3A\u5C11\u4EFB\u52A1\u8DEF\u5F84\u3002" };
  if (!t) return { ok: false, reason: "\u8BF7\u586B\u5199\u8865\u5145\u6307\u4EE4\u3002" };
  return {
    ok: true,
    payload: { workspaceId: workspaceId2, taskPath: taskPath.trim(), text: t, actor }
  };
}
function taskInputKindLabel(inputKind) {
  if (inputKind === "review-feedback") return "REVIEW FEEDBACK";
  return "TASK INPUT";
}

// src/desktop/renderer/context-card-drag.ts
function applyContextCardDragStart(dataTransfer, text3) {
  if (!dataTransfer) return;
  dataTransfer.clearData();
  dataTransfer.setData("text/plain", text3);
  dataTransfer.effectAllowed = "copy";
}
function bindContextCardDrag(node2, text3, options = {}) {
  node2.draggable = true;
  node2.setAttribute("title", "\u62D6\u5230\u5916\u90E8\u8F93\u5165\u6846 \xB7 \u5355\u51FB\u590D\u5236");
  node2.addEventListener("dragstart", (ev) => {
    applyContextCardDragStart(ev.dataTransfer, text3);
    node2.classList.add("is-dragging");
  });
  node2.addEventListener("dragend", () => {
    node2.classList.remove("is-dragging");
  });
  node2.addEventListener("click", () => {
    void copyContextCardText(text3, options);
  });
}
async function copyContextCardText(text3, options = {}) {
  const write = options.writeClipboard ?? (async (value) => {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return;
    }
    throw new Error("Clipboard API unavailable");
  });
  try {
    await write(text3);
    options.onCopied?.(text3);
  } catch (err) {
    options.onCopyError?.(err);
  }
}

// src/desktop/renderer/main/elements.ts
var statusLine = document.getElementById("status-line");
function ensureToastHost() {
  let host8 = document.getElementById("app-toast");
  if (host8) return host8;
  host8 = document.createElement("div");
  host8.id = "app-toast";
  host8.className = "app-toast";
  host8.setAttribute("role", "status");
  host8.setAttribute("aria-live", "polite");
  host8.hidden = true;
  (document.getElementById("app-root") || document.body).appendChild(host8);
  return host8;
}
var toastTimer = null;
var suppressStatusToast = false;
function showToast(message, kind = "info") {
  const host8 = ensureToastHost();
  host8.textContent = message;
  host8.hidden = !message;
  host8.dataset.kind = kind;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = null;
  if (!message) return;
  toastTimer = setTimeout(
    () => {
      host8.hidden = true;
      host8.textContent = "";
      toastTimer = null;
    },
    kind === "error" ? 8e3 : 4e3
  );
}
function clearToast() {
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = null;
  const host8 = document.getElementById("app-toast");
  if (host8) {
    host8.hidden = true;
    host8.textContent = "";
  }
}
function secondarySurfaceVisible() {
  const root = document.getElementById("app-root");
  const surface = root?.dataset.surface;
  return !!surface && surface !== "workbench";
}
var statusProxy = new Proxy(statusLine, {
  set(target, prop, value, receiver) {
    const ok = Reflect.set(target, prop, value, receiver);
    if (prop === "textContent" && !suppressStatusToast) {
      const text3 = typeof value === "string" ? value : String(value ?? "");
      if (text3 && secondarySurfaceVisible()) showToast(text3, "info");
      else if (!text3) clearToast();
    }
    return ok;
  }
});
var el = {
  health: document.getElementById("health-pill"),
  wsSelect: document.getElementById("workspace-select"),
  status: statusProxy,
  appRoot: document.getElementById("app-root"),
  layout: document.getElementById("main-layout"),
  secondaryHost: document.getElementById("secondary-host"),
  graphHost: document.getElementById("graph-host"),
  activityHost: document.getElementById("activity-host"),
  settingsHost: document.getElementById("settings-host"),
  activityBadge: document.getElementById("activity-badge"),
  treePanel: document.getElementById("tree-panel"),
  sidePanel: document.getElementById("side-panel"),
  splitterLeft: document.getElementById("splitter-left"),
  splitterRight: document.getElementById("splitter-right"),
  btnCollapseLeft: document.getElementById("btn-collapse-left"),
  btnCollapseRight: document.getElementById("btn-collapse-right"),
  btnExpandLeft: document.getElementById("btn-expand-left"),
  btnExpandRight: document.getElementById("btn-expand-right"),
  taskCount: document.getElementById("task-count"),
  tree: document.getElementById("tree"),
  tabs: document.getElementById("tabs"),
  toolbar: document.getElementById("toolbar"),
  editor: document.getElementById("editor-host"),
  meta: document.getElementById("meta"),
  dispatch: document.getElementById("dispatch-panel"),
  tasks: document.getElementById("tasks"),
  cards: document.getElementById("cards"),
  a2u: document.getElementById("a2u-host"),
  u2a: document.getElementById("u2a-host"),
  session: document.getElementById("session-host"),
  searchInput: document.getElementById("search-input"),
  searchHits: document.getElementById("search-hits"),
  createType: document.getElementById("create-type"),
  btnNewBox: document.getElementById("btn-new-box"),
  searchDrawer: document.getElementById("search-drawer"),
  createDrawer: document.getElementById("create-drawer"),
  railOverflow: document.getElementById("rail-overflow"),
  btnToggleSearch: document.getElementById("btn-toggle-search"),
  btnToggleCreate: document.getElementById("btn-toggle-create"),
  btnRailMore: document.getElementById("btn-rail-more"),
  secPending: document.getElementById("sec-pending"),
  secDispatch: document.getElementById("sec-dispatch"),
  secCards: document.getElementById("sec-cards"),
  secBacklinks: document.getElementById("sec-backlinks"),
  backlinks: document.getElementById("backlinks-host")
};
function syncActivityBadge(count) {
  if (!el.activityBadge) return;
  el.activityBadge.hidden = count === 0;
  el.activityBadge.textContent = String(count);
}
function setError(err) {
  const msg = err instanceof Error ? err.message : String(err);
  suppressStatusToast = true;
  try {
    statusLine.textContent = msg;
    statusLine.title = msg;
  } finally {
    suppressStatusToast = false;
  }
  showToast(msg, "error");
}

// src/desktop/workbench/node-collaboration.ts
function isUsableTreeNode(node2) {
  return !node2.invalid && !node2.archived && node2.mode !== "archived";
}
function normalizeActiveTask(raw) {
  if (!raw || typeof raw !== "object") throw new Error("Invalid node.collaboration activeTask.");
  const record = raw;
  const task = record.task;
  if (!task || typeof task !== "object" || Array.isArray(task)) {
    throw new Error("Invalid node.collaboration activeTask.task.");
  }
  const taskRecord = task;
  if (typeof taskRecord.id !== "string" || typeof taskRecord.state !== "string") {
    throw new Error("Invalid node.collaboration active Task identity/state.");
  }
  return raw;
}
function normalizeNodeCollaboration(raw) {
  if (!raw || typeof raw !== "object") throw new Error("Invalid node.collaboration projection.");
  const record = raw;
  if (typeof record.workspaceId !== "string" || !record.workspaceId || typeof record.nodeId !== "string" || !record.nodeId || !(record.activeTask === null || record.activeTask && typeof record.activeTask === "object")) {
    throw new Error("Invalid node.collaboration projection.");
  }
  const activeTask = record.activeTask === null ? null : normalizeActiveTask(record.activeTask);
  return {
    workspaceId: record.workspaceId,
    nodeId: record.nodeId,
    activeTask
  };
}
function collectUsableNodeIds(nodes) {
  const ids = [];
  const walk2 = (list2) => {
    for (const node2 of list2) {
      if (isUsableTreeNode(node2) && node2.nodeId) ids.push(node2.nodeId);
      if (node2.children?.length) walk2(node2.children);
    }
  };
  walk2(nodes);
  return ids;
}
function applyNodeCollaborationsToTree(nodes, byNodeId) {
  return nodes.map((node2) => applyOne(node2, byNodeId));
}
function applyOne(node2, byNodeId) {
  const children = node2.children?.length ? node2.children.map((child) => applyOne(child, byNodeId)) : node2.children;
  const next = { ...node2, children };
  delete next.status;
  delete next.assignee;
  if (!isUsableTreeNode(node2)) return next;
  const active = byNodeId.get(node2.nodeId)?.activeTask?.task;
  if (!active) return next;
  next.status = "doing";
  const executor = active.roleId ?? active.sessionId;
  if (executor) next.assignee = executor;
  return next;
}
function nodeCollaborationSummaryLine(projection) {
  if (!projection) return null;
  if (!projection.activeTask) return "\u65E0\u6D3B\u52A8\u4EFB\u52A1";
  const first = projection.activeTask.task;
  const executor = first?.roleId ?? first?.sessionId;
  return `\u6D3B\u52A8\u4EFB\u52A1${executor ? ` \xB7 ${executor}` : ""}`;
}

// src/desktop/workbench/open-tabs.ts
function resolveActiveAfterClose(tabOrder, closingCx, activeCx2) {
  const remaining = tabOrder.filter((id) => id !== closingCx);
  if (remaining.length === 0) return null;
  if (activeCx2 && activeCx2 !== closingCx && remaining.includes(activeCx2)) {
    return activeCx2;
  }
  const idx = tabOrder.indexOf(closingCx);
  if (idx === -1) {
    return remaining[remaining.length - 1] ?? null;
  }
  if (idx > 0) {
    const left = tabOrder[idx - 1];
    if (remaining.includes(left)) return left;
  }
  return remaining[Math.min(idx, remaining.length - 1)] ?? null;
}
function closeOpenTab(tabOrder, closingCx, activeCx2) {
  if (!tabOrder.includes(closingCx)) {
    return { order: [...tabOrder], activeCx: activeCx2, closed: false };
  }
  const nextActive = resolveActiveAfterClose(tabOrder, closingCx, activeCx2);
  return {
    order: tabOrder.filter((id) => id !== closingCx),
    activeCx: nextActive,
    closed: true
  };
}
function documentEmptyCopy(hasWorkspace) {
  if (!hasWorkspace) {
    return {
      title: "\u6253\u5F00\u5DE5\u4F5C\u533A",
      hint: "\u9009\u62E9\u672C\u673A\u6587\u4EF6\u5939\u6302\u8F7D\u4E3A\u5DE5\u4F5C\u533A\uFF08\u4E0D\u76F4\u63A5\u8BFB\u53D6 .tent\uFF09",
      action: "open-workspace"
    };
  }
  return {
    title: "\u672A\u6253\u5F00\u6587\u6863",
    hint: "\u4ECE\u5DE6\u4FA7 Nodes \u9009\u62E9\u4E00\u6761\u7B14\u8BB0",
    action: null
  };
}
function isCloseTabShortcut(ev) {
  if (ev.altKey || ev.shiftKey) return false;
  if (!(ev.ctrlKey || ev.metaKey)) return false;
  return ev.key === "w" || ev.key === "W";
}

// src/desktop/renderer/main/state.ts
var localTabs = /* @__PURE__ */ new Map();
var activeCx = null;
var tree = [];
var state = null;
var workspaceId = null;
var nodeCollaborations = /* @__PURE__ */ new Map();
var activeBacklinks = [];
var activeBacklinksError = null;
var coordinationTypes = [];
var roles = [];
var taskReview = [];
var deliveries = [];
var sessions = [];
var decisionRequests = [];
var toolApprovals = [];
var taskInputs = [];
var proposals = [];
var connections = [];
var selectedConnectionId = null;
var createTypePick = "";
var dispatchRole = "";
var dispatchPrompt = "";
var rejectDrafts = /* @__PURE__ */ new Map();
function setActiveCx(cx) {
  activeCx = cx;
}
function setTree(nodes) {
  tree = nodes;
}
function setState(s) {
  state = s;
}
function setCoordinationTypes(list2) {
  coordinationTypes = list2;
}
function setRoles(list2) {
  roles = list2;
}
function setTaskReview(list2) {
  taskReview = list2;
}
function setConnections(list2) {
  connections = list2;
}
function setSelectedConnectionId(id) {
  selectedConnectionId = id;
}
function setCreateTypePick(value) {
  createTypePick = value;
}
function setDispatchRole(value) {
  dispatchRole = value;
}
function setDispatchPrompt(value) {
  dispatchPrompt = value;
}
function findNode(nodes, nodeId) {
  for (const node2 of nodes) {
    if (node2.nodeId === nodeId) return node2;
    const child = findNode(node2.children || [], nodeId);
    if (child) return child;
  }
  return void 0;
}
function actionableTasks() {
  return taskReview.filter(
    (task) => isActionableTaskState(task.state)
  );
}
function pendingInteractionCount2() {
  return pendingInteractionCount({
    decisionRequests,
    toolApprovals,
    taskInputs,
    proposals
  });
}
function tasksForActiveNode(states) {
  if (!activeCx) return [];
  return actionableTasks().filter((task) => {
    const st = task.state;
    return task.workNodeIds.includes(activeCx) && (!states || states.includes(st));
  });
}
function reconstruct(fm, body) {
  const lines = ["---"];
  for (const [k, v] of Object.entries(fm || {})) {
    lines.push(`${k}: ${JSON.stringify(v)}`);
  }
  lines.push("---");
  lines.push(body.endsWith("\n") || body === "" ? body : body + "\n");
  return lines.join("\n");
}
function splitBody(raw) {
  const text3 = raw.replace(/\r\n/g, "\n");
  if (!text3.startsWith("---\n")) return raw;
  const end = text3.indexOf("\n---", 4);
  if (end === -1) return raw;
  const after = text3.indexOf("\n", end + 1);
  return after === -1 ? "" : text3.slice(after + 1);
}
var host = null;
function bindStateHost(h) {
  host = h;
}
function clearLocalDocumentSession() {
  localTabs.clear();
  activeCx = null;
  tree = [];
  nodeCollaborations.clear();
  activeBacklinks = [];
  activeBacklinksError = null;
}
function setWorkspaceId(id) {
  if (workspaceId === id) return;
  clearLocalDocumentSession();
  workspaceId = id;
}
async function reloadTree() {
  if (!workspaceId) return;
  const result = await window.tentDesktop.rpc("docs.list", { workspaceId });
  const raw = (result.nodes || []).map(stripListCollabFields);
  tree = raw;
  for (const [id, tab] of localTabs) {
    const node2 = findNode(tree, id);
    if (node2?.mode) tab.nodeMode = node2.mode;
    if (node2?.name) tab.name = node2.name;
    if (node2?.path) tab.path = node2.path;
  }
  await reloadNodeCollaborations();
  host?.renderTree();
}
function stripListCollabFields(node2) {
  const { status: _s, assignee: _a, children, ...rest } = node2;
  const archived = !!rest.archived || rest.mode === "archived";
  const invalid = !!rest.invalid;
  const usable = !invalid && !archived;
  return {
    ...rest,
    archived,
    invalid,
    // Local UI alias only — Service no longer projects coordination.
    coordination: usable,
    children: children?.map(stripListCollabFields)
  };
}
async function reloadNodeCollaborations() {
  if (!workspaceId) {
    nodeCollaborations.clear();
    return;
  }
  const ids = collectUsableNodeIds(tree);
  if (ids.length === 0) {
    nodeCollaborations.clear();
    tree = applyNodeCollaborationsToTree(tree, nodeCollaborations);
    return;
  }
  const batch = await window.tentDesktop.rpc("node.collaborations", {
    workspaceId,
    nodeIds: ids
  });
  const results = batch.items.map((item) => normalizeNodeCollaboration(item));
  nodeCollaborations.clear();
  for (const p of results) {
    nodeCollaborations.set(p.nodeId, p);
  }
  tree = applyNodeCollaborationsToTree(tree, nodeCollaborations);
  host?.renderMeta?.();
}
function nodeCollaborationFor(cx) {
  if (!cx) return null;
  return nodeCollaborations.get(cx) ?? null;
}
async function reloadActiveBacklinks() {
  if (!workspaceId || !activeCx) {
    activeBacklinks = [];
    activeBacklinksError = null;
    host?.renderBacklinks?.();
    return;
  }
  try {
    const result = await window.tentDesktop.rpc("docs.backlinks", {
      workspaceId,
      nodeId: activeCx
    });
    const hits = [];
    for (const h of result.backlinks || []) {
      const cx = h.fromNodeId || "";
      if (!cx) continue;
      const row = {
        nodeId: cx,
        name: h.fromName || cx,
        path: h.fromPath || ""
      };
      if (typeof h.raw === "string" && h.raw) row.context = h.raw;
      hits.push(row);
    }
    activeBacklinks = hits;
    activeBacklinksError = null;
  } catch (err) {
    activeBacklinks = [];
    activeBacklinksError = err instanceof Error ? err.message : String(err);
  }
  host?.renderBacklinks?.();
}
async function reloadRegistry() {
  if (!workspaceId) return;
  try {
    const [typesResult, rolesResult] = await Promise.all([
      window.tentDesktop.rpc("registry.types", { workspaceId }),
      window.tentDesktop.rpc("registry.roles", { workspaceId })
    ]);
    coordinationTypes = listCoordinationTypeOptions(typesResult.types || []);
    roles = listRoleOptions(rolesResult.roles || []);
    if (!createTypePick || !coordinationTypes.some((t) => t.name === createTypePick)) {
      createTypePick = pickDefaultCoordinationType(coordinationTypes) || "";
    }
    if (!dispatchRole || !roles.some((r) => r.name === dispatchRole)) {
      dispatchRole = roles[0]?.name || "";
    }
    host?.renderCreateTypeSelect();
    host?.renderDispatchPanel();
  } catch (err) {
    setError(err);
  }
}
async function reloadTasks() {
  if (!workspaceId) return;
  try {
    const [taskResult, deliveryResult, sessionResult] = await Promise.all([
      window.tentDesktop.rpc("task.list", { workspaceId }),
      window.tentDesktop.rpc("delivery.list", { workspaceId }),
      window.tentDesktop.rpc("session.list", { workspaceId })
    ]);
    deliveries = deliveryResult.deliveries || [];
    sessions = sessionResult.sessions || [];
    taskReview = buildTaskReviewItems(taskResult.tasks || [], deliveries, sessions);
    host?.renderTasks();
    host?.renderTaskInput();
    host?.renderSessions();
  } catch (err) {
    setError(err);
  }
}
async function reloadPendingInteractions() {
  if (!workspaceId) return;
  try {
    const [decisionResult, toolResult, proposalResult] = await Promise.all([
      window.tentDesktop.rpc("decisionRequest.listPending", { workspaceId }),
      window.tentDesktop.rpc("toolApproval.listPending", { workspaceId }),
      window.tentDesktop.rpc("proposal.list", {
        workspaceId,
        status: "pending"
      })
    ]);
    decisionRequests = normalizeDecisionRequestList(decisionResult);
    toolApprovals = normalizeToolApprovalList(toolResult);
    proposals = normalizeProposalList(proposalResult);
    const paths = collectTaskPathsForInputPoll();
    if (paths.length === 0) {
      taskInputs = [];
    } else {
      const inputLists = await Promise.all(
        paths.map(
          (taskPath) => window.tentDesktop.rpc("taskInput.listPending", { workspaceId, taskPath }).then((r) => normalizeTaskInputList(r)).catch(() => [])
        )
      );
      const byId = /* @__PURE__ */ new Map();
      for (const list2 of inputLists) {
        for (const item of list2) byId.set(item.id, item);
      }
      taskInputs = [...byId.values()].sort(
        (a, b) => (b.createdAt || "").localeCompare(a.createdAt || "")
      );
    }
    host?.renderPendingInteractions();
  } catch (err) {
    setError(err);
  }
}
function collectTaskPathsForInputPoll() {
  const paths = /* @__PURE__ */ new Set();
  for (const t of taskReview) {
    if (t.path) paths.add(t.path);
  }
  for (const request of decisionRequests) {
    if (request.taskPath) paths.add(request.taskPath);
  }
  for (const t of toolApprovals) {
    if (t.taskPath) paths.add(t.taskPath);
  }
  return [...paths];
}
async function onServiceEvent(type) {
  if (!workspaceId) return;
  const reloadNodeNeeded = type === "node.changed";
  const reloadTasksNeeded = isTaskProjectionEventType(type);
  const reloadPendingNeeded = isPendingInteractionEventType(type);
  if (!reloadNodeNeeded && !reloadTasksNeeded && !reloadPendingNeeded) return;
  try {
    if (reloadNodeNeeded) {
      await reloadTree();
      if (activeCx && host?.openNode) await host.openNode(activeCx);
      await reloadActiveBacklinks();
    }
    if (reloadTasksNeeded) {
      await reloadTasks();
      await reloadNodeCollaborations();
      host?.renderTree();
    }
    if (reloadPendingNeeded) await reloadPendingInteractions();
  } catch (err) {
    setError(err);
  }
}
async function reloadConnections() {
  try {
    const result = await window.tentDesktop.rpc("connection.list", {});
    connections = listConnectionOptions(result.connections || []);
    if (!selectedConnectionId || !connections.some((connection) => connection.connectionId === selectedConnectionId)) {
      selectedConnectionId = pickDefaultConnectionId(connections);
    }
    host?.renderTasks();
  } catch (err) {
    connections = [];
    selectedConnectionId = null;
    setError(err);
  }
}

// src/desktop/renderer/main/ui.ts
var UI = {
  btn: "btn",
  btnPrimary: "btn btn-primary",
  btnSecondary: "btn btn-secondary",
  btnGhost: "btn btn-ghost",
  btnDanger: "btn btn-danger",
  iconBtn: "icon-btn",
  field: "field",
  fieldCompact: "field field-compact",
  tab: "tab",
  tabLabel: "tab-label",
  tabClose: "tab-close",
  treeNode: "tree-node",
  treeName: "tree-name",
  treeMeta: "tree-meta",
  inspSection: "insp-section",
  inspSummary: "insp-summary",
  inspBody: "insp-body",
  collapseEdge: "icon-btn collapse-edge",
  railToggle: "icon-btn rail-toggle"
};
function btnClass(variant = "secondary", extra) {
  const base = variant === "primary" ? UI.btnPrimary : variant === "ghost" ? UI.btnGhost : variant === "danger" ? UI.btnDanger : UI.btnSecondary;
  return extra ? `${base} ${extra}` : base;
}
function btnHtml(opts) {
  const cls = btnClass(opts.variant ?? "secondary", opts.extraClass);
  const id = opts.id ? ` id="${escapeHtml(opts.id)}"` : "";
  const title = opts.title ? ` title="${escapeHtml(opts.title)}"` : "";
  const disabled = opts.disabled ? " disabled" : "";
  const attrs = opts.attrs ? ` ${opts.attrs}` : "";
  return `<button type="button" class="${cls}"${id}${title}${disabled}${attrs}>${escapeHtml(opts.label)}</button>`;
}
function iconBtnHtml(opts) {
  const cls = opts.extraClass ? `${UI.iconBtn} ${opts.extraClass}` : UI.iconBtn;
  const id = opts.id ? ` id="${escapeHtml(opts.id)}"` : "";
  const label = opts.ariaLabel ?? opts.title;
  const title = ` title="${escapeHtml(opts.title)}"`;
  const aria = ` aria-label="${escapeHtml(label)}"`;
  const expanded = opts.expanded === void 0 || opts.expanded === null ? "" : ` aria-expanded="${opts.expanded ? "true" : "false"}"`;
  const disabled = opts.disabled ? " disabled" : "";
  const attrs = opts.attrs ? ` ${opts.attrs}` : "";
  return `<button type="button" class="${cls}"${id}${title}${aria}${expanded}${disabled}${attrs}>${opts.icon}</button>`;
}
function documentTabHtml(opts) {
  const cx = escapeHtml(opts.nodeId);
  const name = escapeHtml(opts.name);
  const dirtyMark = opts.dirty ? " \xB7" : "";
  const closeLabel = `\u5173\u95ED ${opts.name}`;
  const title = `${opts.name}${opts.dirty ? "\uFF08\u672A\u4FDD\u5B58\uFF09" : ""}`;
  return `<div class="${UI.tab}${opts.active ? " active" : ""}" role="presentation" data-tab-wrap="${cx}">
        <button type="button" class="${UI.tabLabel}" role="tab" data-tab="${cx}" aria-selected="${opts.active ? "true" : "false"}" title="${escapeHtml(title)}">${name}${dirtyMark}</button>
        <button type="button" class="${UI.tabClose}" data-close-tab="${cx}" title="${escapeHtml(closeLabel)}" aria-label="${escapeHtml(closeLabel)}">${opts.closeIcon}</button>
      </div>`;
}
function treeRowClass(opts) {
  let cls = UI.treeNode;
  if (opts.active) cls += " active";
  if (opts.archived) cls += " is-archived";
  return cls;
}

// src/desktop/renderer/main/inspector.ts
var host2 = null;
function bindInspectorHost(h) {
  host2 = h;
}
function syncInspectorSections() {
  const hasTasks = actionableTasks().length > 0 || pendingInteractionCount2() > 0;
  const tab = activeCx ? localTabs.get(activeCx) : null;
  const canDispatch = !!(tab && tab.coordination);
  if (!el.secPending || !el.secDispatch || !el.secCards) return;
  const anyOpen = el.secPending.open || el.secDispatch.open || el.secCards.open || !!(el.secBacklinks && el.secBacklinks.open);
  if (anyOpen) return;
  if (hasTasks) el.secPending.open = true;
  else if (canDispatch) el.secDispatch.open = true;
}
function renderMeta() {
  const tab = activeCx ? localTabs.get(activeCx) : null;
  if (!tab) {
    el.meta.innerHTML = `<span class="muted">\u672A\u9009\u62E9</span>`;
    el.meta.classList.add("muted");
    return;
  }
  el.meta.classList.remove("muted");
  const proj = tab.coordination ? nodeCollaborationFor(tab.nodeId) : null;
  const modeLabel = tab.nodeMode === "archived" ? "\u5C01\u5B58" : "\u5F00\u653E";
  const collabLine = nodeCollaborationSummaryLine(proj);
  const oneLine = tab.coordination ? collabLine ? `${escapeHtml(tab.type)} \xB7 ${escapeHtml(collabLine)} \xB7 ${modeLabel}` : `${escapeHtml(tab.type)} \xB7 ${modeLabel}` : `${escapeHtml(tab.type)} \xB7 ${modeLabel}`;
  const renameDisabled = tab.nodeMode === "archived";
  const projDl = tab.coordination && proj ? `<dt>\u6D3B\u52A8\u4EFB\u52A1</dt><dd>${proj.activeTask ? "1" : "0"}</dd>
        <dt>\u7ECF\u529E</dt><dd>${proj.activeTask?.task.roleId ?? proj.activeTask?.task.sessionId ?? "\u2014"}</dd>
        <dt>\u4EFB\u52A1</dt><dd>${proj.activeTask?.task.id ? `<code title="${escapeHtml(proj.activeTask.task.id)}">${escapeHtml(proj.activeTask.task.id)}</code>` : "\u2014"}</dd>` : tab.coordination ? `<dt>\u72B6\u6001</dt><dd class="muted">\u6295\u5F71\u672A\u52A0\u8F7D</dd>` : "";
  el.meta.innerHTML = `
    <div class="meta-name">${escapeHtml(tab.name)}</div>
    <div class="meta-line muted">${oneLine}</div>
    <div class="meta-controls">
      <label class="sr-only" for="node-display-name">\u540D\u79F0</label>
      <input id="node-display-name" class="${UI.field}" value="${escapeHtml(tab.name)}"${renameDisabled ? " disabled" : ""} />
      ${btnHtml({
    label: "\u91CD\u547D\u540D",
    variant: "secondary",
    id: "btn-rename-node",
    title: renameDisabled ? "\u5C01\u5B58\u8282\u70B9\u4E0D\u53EF\u91CD\u547D\u540D" : "\u4EC5\u6539\u663E\u793A\u540D\uFF08docs.rename\uFF1Bid \u4E0D\u53EF\u6539\uFF09",
    disabled: renameDisabled
  })}
    </div>
    <div class="meta-controls">
      <label for="node-mode">\u8BBF\u95EE</label>
      <select id="node-mode" class="${UI.fieldCompact}">
        <option value="editable"${tab.nodeMode === "editable" ? " selected" : ""}>\u5F00\u653E</option>
        <option value="archived"${tab.nodeMode === "archived" ? " selected" : ""}>\u5C01\u5B58</option>
      </select>
      ${btnHtml({ label: "\u5E94\u7528", variant: "secondary", id: "btn-apply-node-mode" })}
    </div>
    <details class="meta-details">
      <summary>\u8BE6\u60C5</summary>
      <dl>
        <dt>\u7C7B\u578B</dt><dd>${escapeHtml(tab.type)}</dd>
        <dt>\u8DEF\u5F84</dt><dd title="${escapeHtml(tab.path)}">${escapeHtml(tab.path)}</dd>
        <dt>\u6807\u8BC6</dt><dd><code title="\u4E0D\u53EF\u53D8 id">${escapeHtml(tab.nodeId)}</code></dd>
        ${projDl}
      </dl>
    </details>`;
  document.getElementById("btn-rename-node")?.addEventListener("click", () => void onRenameNode());
  document.getElementById("btn-apply-node-mode")?.addEventListener("click", () => void onSetNodeMode());
}
function renderBacklinks() {
  const hostEl = el.backlinks;
  if (!hostEl) return;
  const tab = activeCx ? localTabs.get(activeCx) : null;
  if (!tab) {
    hostEl.innerHTML = `<div class="muted">\u672A\u9009\u62E9</div>`;
    return;
  }
  if (activeBacklinksError) {
    hostEl.innerHTML = `<div class="muted">\u53CD\u5411\u94FE\u63A5\u52A0\u8F7D\u5931\u8D25\uFF1A${escapeHtml(activeBacklinksError)}</div>`;
    return;
  }
  if (!activeBacklinks.length) {
    hostEl.innerHTML = `<div class="muted">\u6682\u65E0\u53CD\u5411\u94FE\u63A5</div>`;
    return;
  }
  hostEl.innerHTML = `<ul class="card-list backlink-list" aria-label="\u53CD\u5411\u94FE\u63A5">${activeBacklinks.map(
    (h) => `<li class="card-item" data-open="${escapeHtml(h.nodeId)}" role="button" tabindex="0">
          <strong>${escapeHtml(h.name)}</strong>
          ${h.context ? `<div class="muted">${escapeHtml(h.context)}</div>` : h.path ? `<div class="muted">${escapeHtml(h.path)}</div>` : ""}
        </li>`
  ).join("")}</ul>`;
  hostEl.querySelectorAll("[data-open]").forEach((node2) => {
    const open = () => void host2?.openNode?.(node2.getAttribute("data-open"));
    node2.addEventListener("click", open);
    node2.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        open();
      }
    });
  });
}
async function onRenameNode() {
  const tab = activeCx ? localTabs.get(activeCx) : null;
  const input = document.getElementById("node-display-name");
  const newName = input?.value.trim() || "";
  if (!tab || !workspaceId || !newName || newName === tab.name) return;
  try {
    const result = await window.tentDesktop.rpc("docs.rename", {
      workspaceId,
      nodeId: tab.nodeId,
      newName,
      actor: "user"
    });
    tab.name = result.name;
    tab.path = result.path;
    el.status.textContent = `\u5DF2\u91CD\u547D\u540D\u4E3A\u300C${result.name}\u300D`;
    await reloadTree();
    host2?.renderAll();
  } catch (err) {
    setError(err);
  }
}
async function onSetNodeMode() {
  const tab = activeCx ? localTabs.get(activeCx) : null;
  const select = document.getElementById("node-mode");
  const mode = select?.value;
  if (!tab || !workspaceId || !mode || mode === tab.nodeMode) return;
  if (tab.dirty) {
    el.status.textContent = "\u8BF7\u5148\u4FDD\u5B58\u6216\u64A4\u9500\u5F53\u524D\u4FEE\u6539\uFF0C\u518D\u5207\u6362 Node \u8BBF\u95EE\u6A21\u5F0F\u3002";
    return;
  }
  if (mode === "archived" && !window.confirm(`\u5C01\u5B58\u300C${tab.name}\u300D\u53CA\u5176\u5B50\u6811\uFF1F`)) return;
  try {
    await window.tentDesktop.rpc("docs.setMode", { workspaceId, nodeId: tab.nodeId, mode });
    tab.nodeMode = mode;
    el.status.textContent = mode === "archived" ? `\u5DF2\u5C01\u5B58\u300C${tab.name}\u300D` : "\u8BBF\u95EE\u6A21\u5F0F\u5DF2\u66F4\u65B0";
    if (mode === "archived") {
      const order = [...localTabs.keys()];
      const result = closeOpenTab(order, tab.nodeId, activeCx);
      localTabs.delete(tab.nodeId);
      setActiveCx(result.activeCx);
    }
    await reloadTree();
    host2?.renderAll();
  } catch (err) {
    setError(err);
  }
}

// src/desktop/renderer/main/collaboration.ts
function renderPendingInteractions() {
  const hasPending = pendingInteractionCount2() > 0;
  el.a2u.hidden = !hasPending;
  if (!hasPending) {
    el.a2u.innerHTML = "";
    renderTasks();
    return;
  }
  const requests = decisionRequests.map((request) => {
    const options = request.options.map(
      (option) => `<label class="choice-row">
      <input type="radio" name="decision-option-${escapeHtml(request.id)}" value="${escapeHtml(option.id)}" />
      <span>${escapeHtml(option.label)}</span></label>`
    ).join("");
    return `<article class="interaction-item" data-decision-item="${escapeHtml(request.id)}" data-task-path="${escapeHtml(request.taskPath)}" data-pending-kind="decisionRequest">
      <div class="interaction-kicker">DECISION REQUEST</div>
      <div class="interaction-title">${escapeHtml(request.question)}</div>
      <div class="muted interaction-note">${escapeHtml(request.taskPath)}</div>
      ${options ? `<div class="choice-list">${options}</div>` : ""}
      <textarea class="line-input" data-decision-answer="${escapeHtml(request.id)}" rows="2" placeholder="\u81EA\u5B9A\u4E49\u56DE\u7B54\uFF08\u53EF\u9009\uFF09"></textarea>
      <div class="interaction-actions"><button type="button" class="btn btn-primary" data-decision-respond="${escapeHtml(request.id)}">\u56DE\u590D</button>
      <button type="button" class="btn btn-ghost" data-decision-deny="${escapeHtml(request.id)}">\u62D2\u7EDD</button>
      <button type="button" class="btn btn-ghost" data-task-stop="${escapeHtml(request.taskPath)}">\u4E2D\u65AD\u4EFB\u52A1</button></div>
    </article>`;
  }).join("");
  const tools = toolApprovals.map((item) => {
    const summary = item.paramsSummary || "";
    return `<article class="interaction-item" data-pending-kind="toolApproval">
      <div class="interaction-kicker">TOOL \xB7 ${escapeHtml(item.toolTitle)}</div>
      <div class="interaction-title">${escapeHtml(item.toolTitle)}</div>
      <div class="muted interaction-note">${escapeHtml(item.role || "Agent")} \xB7 session ${escapeHtml(item.sessionId)}</div>
      ${summary ? `<div class="muted interaction-note">${escapeHtml(summary)}</div>` : ""}
      <div class="interaction-actions"><button type="button" class="btn btn-primary" data-tool-allow="${escapeHtml(item.id)}">\u5141\u8BB8\u4E00\u6B21</button>
      <button type="button" class="btn btn-ghost" data-tool-deny="${escapeHtml(item.id)}">\u62D2\u7EDD</button></div>
    </article>`;
  }).join("");
  const inputs = taskInputs.map((item) => {
    const text3 = (item.text || "").trim();
    const preview = text3.length > 160 ? text3.slice(0, 157) + "\u2026" : text3;
    const refs = item.contextRefs.length > 0 ? `<div class="muted interaction-note">refs \xB7 ${escapeHtml(item.contextRefs.join(" \xB7 "))}</div>` : "";
    return `<article class="interaction-item" data-pending-kind="taskInput" data-task-input="${escapeHtml(item.id)}">
      <div class="interaction-kicker">${escapeHtml(taskInputKindLabel(item.inputKind))} \xB7 ${escapeHtml(item.role || "\u2014")}</div>
      <div class="interaction-title">${escapeHtml(preview || "\uFF08\u65E0\u6B63\u6587\uFF09")}</div>
      <div class="muted interaction-note">${escapeHtml(item.taskPath)}${item.sessionId ? ` \xB7 ${escapeHtml(item.sessionId)}` : ""}</div>
      ${refs}
      <div class="muted interaction-note">\u5F85 agent \u6D88\u8D39\uFF08taskInput.ack\uFF09</div>
    </article>`;
  }).join("");
  const proposalItems = proposals.map((p) => {
    const body = (p.body || "").trim();
    const preview = body.length > 160 ? body.slice(0, 157) + "\u2026" : body;
    return `<article class="interaction-item" data-proposal-path="${escapeHtml(p.path)}" data-pending-kind="proposal">
      <div class="interaction-kicker">PROPOSAL \xB7 ${escapeHtml(p.role || "Agent")}</div>
      <div class="interaction-title">${escapeHtml(preview || p.path)}</div>
      <div class="muted interaction-note">${escapeHtml(p.nodeId || "")} \xB7 ${escapeHtml(p.path)}</div>
      <div class="interaction-actions">
        <button type="button" class="btn btn-primary" data-proposal-accept="${escapeHtml(p.path)}">\u91C7\u7EB3</button>
        <button type="button" class="btn btn-ghost" data-proposal-reject="${escapeHtml(p.path)}">\u9A73\u56DE</button>
      </div>
    </article>`;
  }).join("");
  el.a2u.innerHTML = requests + tools + inputs + proposalItems;
  el.a2u.querySelectorAll("[data-decision-respond]").forEach(
    (button) => button.addEventListener("click", () => void onRespondDecision(button.getAttribute("data-decision-respond")))
  );
  el.a2u.querySelectorAll("[data-decision-deny]").forEach(
    (button) => button.addEventListener("click", () => void onDenyDecision(button.getAttribute("data-decision-deny")))
  );
  el.a2u.querySelectorAll("[data-task-stop]").forEach(
    (button) => button.addEventListener("click", () => void onInterrupt(button.getAttribute("data-task-stop")))
  );
  el.a2u.querySelectorAll("[data-proposal-accept]").forEach(
    (button) => button.addEventListener(
      "click",
      () => void onResolveProposal(button.getAttribute("data-proposal-accept"), "accept")
    )
  );
  el.a2u.querySelectorAll("[data-proposal-reject]").forEach(
    (button) => button.addEventListener(
      "click",
      () => void onResolveProposal(button.getAttribute("data-proposal-reject"), "reject")
    )
  );
  el.a2u.querySelectorAll("[data-tool-allow]").forEach(
    (button) => button.addEventListener("click", () => void onResolveTool(button.getAttribute("data-tool-allow"), true))
  );
  el.a2u.querySelectorAll("[data-tool-deny]").forEach(
    (button) => button.addEventListener("click", () => void onResolveTool(button.getAttribute("data-tool-deny"), false))
  );
  renderTasks();
  syncInspectorSections();
}
async function onRespondDecision(requestId) {
  if (!workspaceId) return;
  const item = el.a2u.querySelector(`[data-decision-item="${CSS.escape(requestId)}"]`);
  const taskPath = item?.getAttribute("data-task-path") || "";
  const answer = item?.querySelector("[data-decision-answer]")?.value.trim() || "";
  const optionId = item?.querySelector("input[type=radio]:checked")?.value || "";
  const built = buildDecisionResponsePayload(workspaceId, taskPath, requestId, {
    text: answer,
    optionId
  });
  if (!built.ok) {
    el.status.textContent = built.reason;
    return;
  }
  try {
    await window.tentDesktop.rpc("decisionRequest.respond", built.payload);
    el.status.textContent = "\u5DF2\u63D0\u4EA4\u51B3\u5B9A\u3002";
    await Promise.all([reloadPendingInteractions(), reloadTasks(), reloadTree()]);
  } catch (err) {
    setError(err);
  }
}
async function onDenyDecision(requestId) {
  if (!workspaceId) return;
  const item = el.a2u.querySelector(`[data-decision-item="${CSS.escape(requestId)}"]`);
  const taskPath = item?.getAttribute("data-task-path") || "";
  try {
    await window.tentDesktop.rpc(
      "decisionRequest.respond",
      buildDecisionDenyPayload(workspaceId, taskPath, requestId)
    );
    el.status.textContent = "\u5DF2\u62D2\u7EDD\u8BE5\u8BF7\u6C42\u3002";
    await Promise.all([reloadPendingInteractions(), reloadTasks(), reloadTree()]);
  } catch (err) {
    setError(err);
  }
}
async function onResolveProposal(path, decision) {
  if (!workspaceId) return;
  try {
    await window.tentDesktop.rpc("proposal.resolve", {
      workspaceId,
      path,
      decision,
      actor: "user"
    });
    el.status.textContent = decision === "accept" ? "\u5DF2\u91C7\u7EB3\u63D0\u6848\u3002" : "\u5DF2\u9A73\u56DE\u63D0\u6848\u3002";
    await Promise.all([reloadPendingInteractions(), reloadTasks(), reloadTree()]);
  } catch (err) {
    setError(err);
  }
}
async function onResolveTool(approvalId, allow) {
  try {
    const built = buildToolApprovalResolvePayload(approvalId, allow, "user");
    await window.tentDesktop.rpc(built.method, built.params);
    el.status.textContent = allow ? "\u5DF2\u5141\u8BB8\u672C\u6B21\u5DE5\u5177\u8C03\u7528\u3002" : "\u5DF2\u62D2\u7EDD\u5DE5\u5177\u8C03\u7528\u3002";
    await Promise.all([reloadPendingInteractions(), reloadTasks(), reloadTree()]);
  } catch (err) {
    setError(err);
  }
}
function renderTaskInput() {
  const candidates = tasksForActiveNode(["running", "taken", "waiting"]);
  el.u2a.hidden = candidates.length === 0;
  if (!candidates.length) {
    el.u2a.innerHTML = "";
    return;
  }
  const options = candidates.map(
    (task) => `<option value="${escapeHtml(task.path)}">${escapeHtml(taskExecutionLabel(task))} \xB7 ${escapeHtml(taskStateLabel(task.state))}</option>`
  ).join("");
  el.u2a.innerHTML = `<article class="interaction-item u2a-item" data-pending-kind="taskSendInput"><div class="interaction-kicker">U2A \xB7 \u8FFD\u52A0\u4EFB\u52A1\u8F93\u5165</div>
    ${candidates.length > 1 ? `<select id="u2a-task" class="field">${options}</select>` : ""}
    <textarea id="u2a-text" class="line-input" rows="2" placeholder="\u53D1\u9001\u4E00\u6B21\u6027\u8865\u5145\u6307\u4EE4\uFF08task.sendInput\uFF09"></textarea>
    <div class="interaction-actions"><button type="button" id="btn-send-task-input" class="btn btn-secondary">\u53D1\u9001</button></div></article>`;
  document.getElementById("btn-send-task-input")?.addEventListener("click", async () => {
    const text3 = document.getElementById("u2a-text")?.value.trim() || "";
    const taskPath = document.getElementById("u2a-task")?.value || candidates[0].path;
    if (!workspaceId) return;
    const built = buildTaskSendInputPayload(workspaceId, taskPath, text3, "user");
    if (!built.ok) {
      el.status.textContent = built.reason;
      return;
    }
    try {
      await window.tentDesktop.rpc("task.sendInput", built.payload);
      el.status.textContent = "\u8865\u5145\u6307\u4EE4\u5DF2\u53D1\u9001\u3002";
      await Promise.all([reloadTasks(), reloadPendingInteractions()]);
    } catch (err) {
      setError(err);
    }
  });
}
function renderSessions() {
  const relatedTasks = tasksForActiveNode();
  const taskIds = new Set(relatedTasks.map((task) => task.id).filter(Boolean));
  const sessionIds = new Set(relatedTasks.map((task) => task.sessionId).filter(Boolean));
  const related = sessions.filter(
    (session) => sessionIds.has(session.sessionId) || !!session.lastTaskId && taskIds.has(session.lastTaskId)
  );
  el.session.hidden = related.length === 0;
  el.session.innerHTML = related.map(
    (session) => `<div class="session-row"><span class="session-dot ${session.alive ? "is-live" : ""}" aria-hidden="true"></span>
    <span>${escapeHtml(session.roleId || session.connectionId || session.sessionId)}</span><span class="muted">${escapeHtml(sessionStateLabel(session.state) || session.state)}</span></div>`
  ).join("");
}
function renderTasks() {
  const visibleTasks = actionableTasks();
  if (el.taskCount) {
    const n = visibleTasks.length + pendingInteractionCount2();
    el.taskCount.hidden = n === 0;
    el.taskCount.textContent = String(n);
  }
  if (el.secPending) {
    if (visibleTasks.length > 0 || pendingInteractionCount2() > 0) {
      el.secPending.open = true;
      if (el.secDispatch) el.secDispatch.open = false;
      if (el.secCards) el.secCards.open = false;
    } else if (!el.secDispatch?.open && !el.secCards?.open) {
      el.secPending.open = false;
    }
  }
  if (!visibleTasks.length) {
    el.tasks.innerHTML = "";
    return;
  }
  el.tasks.innerHTML = visibleTasks.map((t) => {
    const who = escapeHtml(taskExecutionLabel(t));
    const nodeIds = [...t.workNodeIds || [], ...t.contextNodeIds || []].filter(
      (c) => c !== "root" && !/^(cx|rl|tk|ss|dl|ti)-/i.test(c)
    );
    const claimBit = nodeIds.length ? `<span class="task-claims muted">${nodeIds.map((c) => escapeHtml(c)).join(" \xB7 ")}</span>` : "";
    const blurbRaw = t.deliverySummary || t.prompt || "";
    const blurb = blurbRaw ? `<div class="task-summary">${escapeHtml(blurbRaw.length > 120 ? blurbRaw.slice(0, 117) + "\u2026" : blurbRaw)}</div>` : "";
    const stateLabel = taskStateLabel(t.state);
    const sessLabel = t.sessionState ? sessionStateLabel(t.sessionState) : "";
    const rejectDraft = rejectDrafts.get(t.path) || "";
    const startBtn = t.canStartAgent ? `<button type="button" class="btn btn-primary" data-start="${escapeHtml(t.path)}" title="\u542F\u52A8 agent">\u542F\u52A8</button>` : "";
    const interruptBtn = t.canInterrupt ? `<button type="button" class="btn btn-ghost" data-interrupt="${escapeHtml(t.path)}" title="\u4E2D\u65AD">\u4E2D\u65AD</button>` : "";
    const cancelBtn = t.canCancel ? `<button type="button" class="btn btn-ghost" data-cancel="${escapeHtml(t.path)}" title="\u53D6\u6D88\u4EFB\u52A1">\u53D6\u6D88</button>` : "";
    const reviewActions = t.canAcceptOrReject ? `<div class="task-primary-row">
              <button type="button" class="btn btn-primary" data-accept="${escapeHtml(t.path)}" data-delivery="${escapeHtml(t.activeDeliveryId || "")}">\u786E\u8BA4</button>
              <button type="button" class="btn btn-ghost" data-reject-toggle="${escapeHtml(t.path)}" aria-expanded="false">\u9A73\u56DE</button>
            </div>
            <div class="reject-panel" data-reject-panel="${escapeHtml(t.path)}" hidden>
              <input type="text" class="field" data-reject-reason="${escapeHtml(t.path)}" placeholder="\u9A73\u56DE\u539F\u56E0" value="${escapeHtml(rejectDraft)}" />
              <button type="button" class="${btnClass("danger")}" data-reject="${escapeHtml(t.path)}" data-delivery="${escapeHtml(t.activeDeliveryId || "")}">\u786E\u8BA4\u9A73\u56DE</button>
            </div>` : "";
    const actions = startBtn || interruptBtn || cancelBtn || reviewActions ? `<div class="task-actions">${startBtn}${interruptBtn}${cancelBtn}${reviewActions}</div>` : "";
    return `<li class="task-item" data-task="${escapeHtml(t.path)}">
        <div class="task-head">
          <strong>${who}</strong>
          ${claimBit}
        </div>
        ${blurb}
        ${actions}
        <details class="task-details">
          <summary>\u8BE6\u60C5</summary>
          <div class="task-detail-body muted">
            <div>${escapeHtml(stateLabel)}${sessLabel ? ` \xB7 ${escapeHtml(sessLabel)}` : ""}</div>
            <div class="faint" title="${escapeHtml(t.path)}">${escapeHtml(t.path)}</div>
            ${t.commits.length > 0 ? `<div>${escapeHtml(t.commits.map((c) => c.slice(0, 8)).join(", "))}</div>` : ""}
          </div>
        </details>
      </li>`;
  }).join("");
  el.tasks.querySelectorAll("[data-start]").forEach((btn) => {
    btn.addEventListener("click", () => void onStartAgent(btn.getAttribute("data-start")));
  });
  el.tasks.querySelectorAll("[data-interrupt]").forEach((btn) => {
    btn.addEventListener("click", () => void onInterrupt(btn.getAttribute("data-interrupt")));
  });
  el.tasks.querySelectorAll("[data-cancel]").forEach((btn) => {
    btn.addEventListener("click", () => void onCancelTask(btn.getAttribute("data-cancel")));
  });
  el.tasks.querySelectorAll("[data-accept]").forEach((btn) => {
    btn.addEventListener(
      "click",
      () => void onAccept(btn.getAttribute("data-accept"), btn.getAttribute("data-delivery"))
    );
  });
  el.tasks.querySelectorAll("[data-reject-toggle]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const path = btn.getAttribute("data-reject-toggle");
      const item = btn.closest(".task-item");
      const panel = item?.querySelector("[data-reject-panel]");
      if (!(panel instanceof HTMLElement)) return;
      const open = panel.hasAttribute("hidden");
      if (open) panel.removeAttribute("hidden");
      else panel.setAttribute("hidden", "");
      btn.setAttribute("aria-expanded", open ? "true" : "false");
      if (open) {
        const reason = panel.querySelector("[data-reject-reason]");
        if (reason instanceof HTMLInputElement) reason.focus();
      }
    });
  });
  el.tasks.querySelectorAll("[data-reject-reason]").forEach((input) => {
    input.addEventListener("input", () => {
      rejectDrafts.set(input.getAttribute("data-reject-reason"), input.value);
    });
  });
  el.tasks.querySelectorAll("[data-reject]").forEach((btn) => {
    btn.addEventListener(
      "click",
      () => void onReject(btn.getAttribute("data-reject"), btn.getAttribute("data-delivery"))
    );
  });
}
function taskExecutionLabel(task) {
  return task.roleId || task.sessionConnectionId || task.sessionId || "Session";
}
async function onStartAgent(taskPath) {
  if (!workspaceId) return;
  const built = buildStartSessionPayload(taskPath);
  if (!built.ok) {
    el.status.textContent = built.reason;
    return;
  }
  try {
    const result = await window.tentDesktop.rpc("task.startSession", {
      workspaceId,
      taskPath: built.payload.taskPath,
      callerKind: built.payload.callerKind
    });
    const sid = result.session?.sessionId;
    const st = result.session?.state || result.task?.state || "";
    el.status.textContent = sid ? `\u5DF2\u542F\u52A8 agent \xB7 ${sid}${st ? `\uFF08${sessionStateLabel(st) || st}\uFF09` : ""}` : `\u5DF2\u542F\u52A8 agent \xB7 ${taskPath}`;
    await Promise.all([reloadTasks(), reloadTree(), reloadPendingInteractions()]);
  } catch (err) {
    setError(err);
    await reloadTasks().catch(() => void 0);
  }
}
async function onInterrupt(taskPath) {
  if (!workspaceId) return;
  try {
    await window.tentDesktop.rpc("task.interrupt", {
      workspaceId,
      taskPath
    });
    el.status.textContent = `\u5DF2\u4E2D\u65AD\uFF1A${taskPath}`;
    await Promise.all([reloadTasks(), reloadTree(), reloadPendingInteractions()]);
  } catch (err) {
    setError(err);
  }
}
async function onCancelTask(taskPath) {
  if (!workspaceId) return;
  if (!window.confirm("\u53D6\u6D88\u8BE5\u4EFB\u52A1\uFF1F\u672A\u4EA4\u4ED8\u7684\u8FDB\u5EA6\u5C06\u7EC8\u6B62\u3002")) return;
  try {
    await window.tentDesktop.rpc("task.cancel", {
      workspaceId,
      taskPath
    });
    el.status.textContent = `\u5DF2\u53D6\u6D88\uFF1A${taskPath}`;
    await Promise.all([reloadTasks(), reloadTree(), reloadPendingInteractions()]);
  } catch (err) {
    setError(err);
  }
}
async function onAccept(taskPath, deliveryId) {
  if (!workspaceId) return;
  const payload = buildAcceptPayload(taskPath, deliveryId, "user");
  try {
    await window.tentDesktop.rpc("task.accept", {
      workspaceId,
      taskPath: payload.taskPath,
      deliveryId: payload.deliveryId,
      actor: payload.actor
    });
    el.status.textContent = `\u5DF2\u786E\u8BA4\u4EA4\u4ED8\uFF1A${taskPath}`;
    await Promise.all([reloadTasks(), reloadTree(), reloadPendingInteractions()]);
  } catch (err) {
    setError(err);
  }
}
async function onReject(taskPath, deliveryId) {
  if (!workspaceId) return;
  const reason = rejectDrafts.get(taskPath) || "";
  const built = buildRejectPayload(taskPath, deliveryId, reason, "user");
  if (!built.ok) {
    el.status.textContent = built.reason;
    return;
  }
  try {
    await window.tentDesktop.rpc("task.reject", {
      workspaceId,
      taskPath: built.payload.taskPath,
      deliveryId: built.payload.deliveryId,
      actor: built.payload.actor,
      note: built.payload.note,
      resume: built.payload.resume
    });
    el.status.textContent = `\u5DF2\u9A73\u56DE\uFF1A${taskPath}`;
    rejectDrafts.delete(taskPath);
    await Promise.all([reloadTasks(), reloadTree(), reloadPendingInteractions()]);
  } catch (err) {
    setError(err);
  }
}
async function loadCards() {
  const snap = await window.tentDesktop.getFloatingStatus();
  const cards = snap.recentCards || [];
  if (!cards.length) {
    el.cards.innerHTML = "";
    return;
  }
  el.cards.innerHTML = cards.map(
    (c, i) => `<li class="card-item" draggable="true" data-card-idx="${i}" title="${escapeHtml(c.kind)}/${escapeHtml(c.refId)}">
        <div><strong>${escapeHtml(c.label)}</strong></div>
      </li>`
  ).join("");
  el.cards.querySelectorAll("[data-card-idx]").forEach((node2) => {
    const idx = Number(node2.getAttribute("data-card-idx"));
    const card = cards[idx];
    if (!card?.text) return;
    bindContextCardDrag(node2, card.text, {
      onCopied: () => {
        el.status.textContent = "\u5DF2\u590D\u5236";
      },
      onCopyError: (err) => setError(err)
    });
  });
}
async function onEmitCard() {
  const tab = activeCx ? localTabs.get(activeCx) : null;
  if (!tab) {
    el.status.textContent = "\u8BF7\u5148\u6253\u5F00\u4E00\u4E2A\u6982\u5FF5\u3002";
    return;
  }
  await window.tentDesktop.pushContextCard({
    kind: "node",
    id: tab.nodeId,
    path: tab.path,
    label: tab.name
  });
  await loadCards();
  el.status.textContent = "\u4E0A\u4E0B\u6587\u5361\u5DF2\u5C31\u7EEA \u2014 \u5DE6\u952E\u62D6\u5230\u5916\u90E8\u8F93\u5165\u6846\uFF08text/plain\uFF09\u3002";
}

// src/desktop/renderer/main/icons.ts
var ICO = {
  search: '<svg class="ico" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.25" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M10.2 10.2 13.5 13.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  plus: '<svg class="ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.25v9.5M3.25 8h9.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  more: '<svg class="ico" viewBox="0 0 16 16" aria-hidden="true"><circle cx="4" cy="8" r="1.15" fill="currentColor"/><circle cx="8" cy="8" r="1.15" fill="currentColor"/><circle cx="12" cy="8" r="1.15" fill="currentColor"/></svg>',
  chevronLeft: '<svg class="ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M9.75 3.75 5.5 8l4.25 4.25" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  chevronRight: '<svg class="ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M6.25 3.75 10.5 8l-4.25 4.25" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  modeSource: '<svg class="ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M5.25 4.5 2.75 8l2.5 3.5M10.75 4.5 13.25 8l-2.5 3.5M9.1 3.5 6.9 12.5" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  modePreview: '<svg class="ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.75 4.25h10.5M2.75 8h7.5M2.75 11.75h10.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  close: '<svg class="ico ico-close" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5 11.5 11.5M11.5 4.5 4.5 11.5" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"/></svg>'
};

// src/desktop/renderer/main/document.ts
var host3 = null;
var documentChromeBound = false;
function bindDocumentHost(h) {
  host3 = h;
  bindDocumentChrome();
}
function bindDocumentChrome() {
  if (documentChromeBound) return;
  documentChromeBound = true;
  el.tabs.addEventListener("click", (ev) => {
    const t = ev.target;
    const closeBtn = t?.closest("[data-close-tab]");
    if (closeBtn) {
      ev.preventDefault();
      ev.stopPropagation();
      void closeTab(closeBtn.getAttribute("data-close-tab"));
      return;
    }
    const tabBtn = t?.closest("[data-tab]");
    if (tabBtn && el.tabs.contains(tabBtn)) {
      const cx = tabBtn.getAttribute("data-tab");
      setActiveCx(cx);
      host3?.renderAll();
      if (cx) void host3?.onConceptOpened?.(cx);
      focusActiveTab();
    }
  });
  el.tabs.addEventListener("auxclick", (ev) => {
    if (ev.button !== 1) return;
    const t = ev.target;
    const tabEl = t?.closest("[data-tab], [data-tab-wrap], [data-close-tab]");
    if (!tabEl || !el.tabs.contains(tabEl)) return;
    const cx = tabEl.getAttribute("data-close-tab") || tabEl.getAttribute("data-tab") || tabEl.getAttribute("data-tab-wrap");
    if (!cx) return;
    ev.preventDefault();
    void closeTab(cx);
  });
  el.tabs.addEventListener("mousedown", (ev) => {
    if (ev.button === 1 && ev.target?.closest("[data-tab], [data-tab-wrap], [data-close-tab]")) {
      ev.preventDefault();
    }
  });
  document.addEventListener("keydown", (ev) => {
    if (!isCloseTabShortcut(ev)) return;
    if (!activeCx || !localTabs.has(activeCx)) return;
    const surface = document.getElementById("app-root")?.dataset.surface;
    if (surface && surface !== "workbench") return;
    ev.preventDefault();
    void closeTab(activeCx);
  });
  document.addEventListener("click", (ev) => {
    const t = ev.target;
    if (!t) return;
    const wrap = el.toolbar.querySelector(".menu-wrap");
    if (wrap?.contains(t)) return;
    closeDocMoreMenu();
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") closeDocMoreMenu();
  });
}
function closeDocMoreMenu() {
  const moreMenu = el.toolbar.querySelector("[data-doc-menu]");
  const moreBtn = el.toolbar.querySelector("[data-doc-more]");
  if (moreMenu && !moreMenu.hidden) {
    moreMenu.hidden = true;
    moreBtn?.setAttribute("aria-expanded", "false");
  }
}
async function closeTab(cx) {
  const tab = localTabs.get(cx);
  if (!tab) return false;
  if (tab.dirty) {
    const ok = window.confirm(`\u300C${tab.name}\u300D\u6709\u672A\u4FDD\u5B58\u66F4\u6539\uFF0C\u5173\u95ED\u5C06\u4E22\u5F03\u4FEE\u6539\u3002\u4ECD\u8981\u5173\u95ED\uFF1F`);
    if (!ok) return false;
  }
  const order = [...localTabs.keys()];
  const result = closeOpenTab(order, cx, activeCx);
  if (!result.closed) return false;
  localTabs.delete(cx);
  setActiveCx(result.activeCx);
  host3?.renderAll();
  if (result.activeCx) void host3?.onConceptOpened?.(result.activeCx);
  queueMicrotask(() => {
    if (result.activeCx) focusActiveTab();
    else {
      const stage = document.getElementById("main-panel");
      stage?.focus({ preventScroll: true });
    }
  });
  return true;
}
function focusActiveTab() {
  if (!activeCx) return;
  const safe = typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(activeCx) : activeCx.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const btn = el.tabs.querySelector(`[data-tab="${safe}"]`);
  btn?.focus({ preventScroll: true });
}
async function openNode(cx) {
  if (!workspaceId) return;
  const edit = await window.tentDesktop.rpc("docs.readForEdit", {
    workspaceId,
    nodeId: cx
  });
  const existing = localTabs.get(edit.nodeId);
  if (existing?.dirty) {
    setActiveCx(edit.nodeId);
    host3?.renderAll();
    el.status.textContent = "\u5F53\u524D\u6807\u7B7E\u6709\u672A\u4FDD\u5B58\u66F4\u6539\u3002";
    return;
  }
  const node2 = findNode(tree, edit.nodeId);
  if (edit.mode !== "editable" && edit.mode !== "archived") {
    throw new Error(`Invalid Node mode: ${String(edit.mode)}`);
  }
  const nodeMode = edit.mode;
  const usable = node2?.coordination ?? (!node2?.invalid && nodeMode !== "archived");
  const tab = {
    nodeId: edit.nodeId,
    path: edit.path,
    name: edit.name || edit.path.split("/").pop() || edit.path,
    type: edit.type || String(edit.frontmatter?.type || "prompt"),
    coordination: usable,
    etag: edit.etag,
    buffer: edit.raw ?? reconstruct(edit.frontmatter, edit.body),
    dirty: false,
    mode: existing?.mode ?? "source",
    nodeMode,
    frontmatter: edit.frontmatter || {},
    artifactRefs: edit.artifactRefs
  };
  localTabs.set(tab.nodeId, tab);
  setActiveCx(tab.nodeId);
  host3?.renderAll();
  void host3?.onConceptOpened?.(tab.nodeId);
}
function renderTabs() {
  const tabs = [...localTabs.values()];
  el.tabs.setAttribute("role", "tablist");
  el.tabs.setAttribute("aria-label", "\u6253\u5F00\u7684\u6587\u6863");
  el.tabs.innerHTML = tabs.map(
    (t) => documentTabHtml({
      nodeId: t.nodeId,
      name: t.name,
      active: t.nodeId === activeCx,
      dirty: t.dirty,
      closeIcon: ICO.close
    })
  ).join("");
}
function renderToolbar() {
  const tab = activeCx ? localTabs.get(activeCx) : null;
  if (!tab) {
    el.toolbar.innerHTML = "";
    return;
  }
  const modeLabel = tab.mode === "preview" ? "\u9884\u89C8" : "\u6E90\u7801";
  const modeTitle = tab.mode === "preview" ? "\u5207\u6362\u5230\u6E90\u7801" : "\u5207\u6362\u5230\u9884\u89C8";
  const modeIco = tab.mode === "preview" ? ICO.modePreview : ICO.modeSource;
  const saveBtn = tab.dirty && tab.nodeMode === "editable" ? btnHtml({
    label: "\u4FDD\u5B58",
    variant: "primary",
    title: "\u4FDD\u5B58",
    attrs: 'data-act="save"',
    extraClass: "btn-quiet-save"
  }) : "";
  el.toolbar.innerHTML = `
    ${iconBtnHtml({
    icon: modeIco,
    title: modeTitle,
    ariaLabel: `${modeTitle}\uFF08${modeLabel}\uFF09`,
    extraClass: "mode-toggle",
    attrs: 'data-act="toggle-mode"'
  })}
    ${saveBtn}
    <div class="menu-wrap">
      ${iconBtnHtml({
    icon: ICO.more,
    title: "\u66F4\u591A",
    ariaLabel: "\u6587\u6863\u66F4\u591A\u64CD\u4F5C",
    attrs: 'data-doc-more aria-haspopup="menu"'
  })}
      <div class="menu" data-doc-menu role="menu" hidden>
        <button type="button" class="menu-item" role="menuitem" data-act="source"${tab.mode === "source" ? ' aria-current="true"' : ""}>\u6E90\u7801</button>
        <button type="button" class="menu-item" role="menuitem" data-act="preview"${tab.mode === "preview" ? ' aria-current="true"' : ""}>\u9884\u89C8</button>
        <div class="menu-sep" role="separator"></div>
        <button type="button" class="menu-item" role="menuitem" data-act="card">\u53D1\u51FA\u4E0A\u4E0B\u6587\u5361</button>
        <button type="button" class="menu-item" role="menuitem" data-act="fork" title="\u590D\u5236\u5B50\u6811\u5E76\u91CD\u53D1 id">\u6D3E\u751F\u526F\u672C</button>
        ${tab.nodeMode === "editable" ? `<button type="button" class="menu-item" role="menuitem" data-act="attach">\u5BFC\u5165\u9644\u4EF6\u2026</button>` : ""}
      </div>
    </div>
  `;
  const moreBtn = el.toolbar.querySelector("[data-doc-more]");
  const moreMenu = el.toolbar.querySelector("[data-doc-menu]");
  moreBtn?.addEventListener("click", (ev) => {
    ev.stopPropagation();
    if (!moreMenu) return;
    moreMenu.hidden = !moreMenu.hidden;
    moreBtn.setAttribute("aria-expanded", moreMenu.hidden ? "false" : "true");
  });
  el.toolbar.querySelectorAll("[data-act]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (moreMenu) moreMenu.hidden = true;
      void onToolbar(btn.getAttribute("data-act"));
    });
  });
}
async function onToolbar(act) {
  const tab = activeCx ? localTabs.get(activeCx) : null;
  if (!tab) return;
  if (act === "toggle-mode") {
    tab.mode = tab.mode === "source" ? "preview" : "source";
    host3?.renderAll();
    return;
  }
  if (act === "source" || act === "preview") {
    tab.mode = act;
    host3?.renderAll();
    return;
  }
  if (act === "save") {
    await saveTab(tab);
    return;
  }
  if (act === "fork") {
    if (tab.dirty) {
      el.status.textContent = "\u8BF7\u5148\u4FDD\u5B58\u6216\u64A4\u9500\u5F53\u524D\u4FEE\u6539\uFF0C\u518D\u6D3E\u751F\u526F\u672C\u3002";
      return;
    }
    try {
      const result = await window.tentDesktop.rpc("docs.fork", {
        workspaceId,
        nodeId: tab.nodeId
      });
      const newId = result.nodeId;
      el.status.textContent = newId ? `\u5DF2\u6D3E\u751F\u526F\u672C` : "\u5DF2\u6D3E\u751F\u526F\u672C";
      await reloadTree();
      if (newId) await openNode(newId);
    } catch (err) {
      setError(err);
    }
    return;
  }
  if (act === "attach") {
    await onImportAttachment(tab);
    return;
  }
  if (act === "card") {
    await window.tentDesktop.pushContextCard({
      kind: "node",
      id: tab.nodeId,
      path: tab.path,
      label: tab.name
    });
    await host3?.loadCards();
  }
}
async function onImportAttachment(tab) {
  if (!workspaceId) return;
  if (tab.nodeMode !== "editable") {
    el.status.textContent = "\u5F53\u524D Node \u4E0D\u662F\u5F00\u653E\u6A21\u5F0F\uFF0C\u4E0D\u80FD\u5BFC\u5165\u9644\u4EF6\u3002";
    return;
  }
  const input = document.createElement("input");
  input.type = "file";
  input.hidden = true;
  document.body.appendChild(input);
  const file = await new Promise((resolve) => {
    input.addEventListener(
      "change",
      () => {
        resolve(input.files?.[0] ?? null);
        input.remove();
      },
      { once: true }
    );
    input.addEventListener(
      "cancel",
      () => {
        resolve(null);
        input.remove();
      },
      { once: true }
    );
    input.click();
  });
  if (!file) return;
  try {
    const bytesBase64 = await fileToBase64(file);
    const result = await window.tentDesktop.rpc("docs.importAttachment", {
      workspaceId,
      nodeId: tab.nodeId,
      fileName: file.name,
      bytesBase64
    });
    if (result.markdown) {
      const sep = tab.buffer.endsWith("\n") || tab.buffer.length === 0 ? "" : "\n";
      tab.buffer = `${tab.buffer}${sep}
${result.markdown}
`;
      tab.dirty = true;
      host3?.renderAll();
    }
    el.status.textContent = result.relativePath ? `\u5DF2\u5BFC\u5165\u9644\u4EF6 ${result.relativePath}\uFF08\u8BF7\u4FDD\u5B58\u6B63\u6587\uFF09` : "\u9644\u4EF6\u5DF2\u5BFC\u5165";
  } catch (err) {
    setError(err);
  }
}
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error("read failed"));
    reader.onload = () => {
      const dataUrl = String(reader.result || "");
      const comma = dataUrl.indexOf(",");
      resolve(comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl);
    };
    reader.readAsDataURL(file);
  });
}
async function saveTab(tab) {
  if (tab.nodeMode !== "editable") {
    el.status.textContent = "\u5F53\u524D Node \u4E0D\u662F\u5F00\u653E\u6A21\u5F0F\uFF0C\u4E0D\u80FD\u4FDD\u5B58\u6B63\u6587\u3002";
    return;
  }
  try {
    const result = await window.tentDesktop.rpc("docs.write", {
      workspaceId,
      nodeId: tab.nodeId,
      baseEtag: tab.etag,
      raw: tab.buffer
    });
    tab.etag = result.etag;
    tab.dirty = false;
    el.status.textContent = "";
    await reloadTree();
    host3?.renderAll();
  } catch (err) {
    setError(err);
  }
}
function renderEditor() {
  const tab = activeCx ? localTabs.get(activeCx) : null;
  if (!tab) {
    const copy = documentEmptyCopy(!!workspaceId);
    const hint = copy.hint ? `<p class="empty-hint">${escapeHtml(copy.hint)}</p>` : "";
    const action = copy.action === "open-workspace" ? `<p class="empty-action">${btnHtml({
      label: "\u6253\u5F00\u5DE5\u4F5C\u533A\u2026",
      variant: "primary",
      attrs: 'data-empty-act="open-ws"'
    })}</p>` : "";
    el.editor.innerHTML = `<div class="empty empty-cta" tabindex="-1"><p class="empty-title">${escapeHtml(copy.title)}</p>${hint}${action}</div>`;
    el.editor.querySelector('[data-empty-act="open-ws"]')?.addEventListener(
      "click",
      () => void host3?.openWorkspace?.()
    );
    return;
  }
  if (tab.mode === "preview") {
    const body = splitBody(tab.buffer);
    el.editor.innerHTML = `<div class="preview">${renderMarkdownToHtml(body, {
      resolveWikiHref: (raw) => `#open=${encodeURIComponent(raw)}`,
      artifactRefs: tab.artifactRefs
    })}</div>`;
    return;
  }
  el.editor.innerHTML = `<textarea class="editor" id="buffer" spellcheck="false"></textarea>`;
  const ta = document.getElementById("buffer");
  ta.value = tab.buffer;
  ta.readOnly = tab.nodeMode !== "editable";
  ta.setAttribute("aria-readonly", ta.readOnly ? "true" : "false");
  ta.addEventListener("input", () => {
    tab.buffer = ta.value;
    tab.dirty = true;
    host3?.renderTabs();
    host3?.renderToolbar();
  });
}

// src/desktop/renderer/main/dispatch.ts
var host4 = null;
function bindDispatchHost(h) {
  host4 = h;
}
function renderDispatchPanel() {
  const tab = activeCx ? localTabs.get(activeCx) : null;
  if (!tab) {
    el.dispatch.innerHTML = `<div class="muted dispatch-empty">\u9009\u4E2D\u8282\u70B9\u540E\u53EF\u6D3E\u6D3B</div>`;
    return;
  }
  if (!tab.coordination) {
    el.dispatch.innerHTML = `<div class="muted dispatch-empty">\u300C${escapeHtml(tab.name)}\u300D\u4E0D\u53EF\u7528\uFF08\u65E0\u6548\u6216\u5DF2\u5C01\u5B58\uFF09\uFF0C\u65E0\u6CD5\u6D3E\u6D3B\u3002</div>`;
    return;
  }
  const roleOpts = roles.length > 0 ? roles.map(
    (r) => `<option value="${escapeHtml(r.name)}"${r.name === dispatchRole ? " selected" : ""}>${escapeHtml(r.name)}</option>`
  ).join("") : `<option value="">\uFF08\u65E0 role\uFF09</option>`;
  const validation = validateDispatchForm({
    nodeId: tab.nodeId,
    coordination: tab.coordination,
    role: dispatchRole,
    prompt: dispatchPrompt,
    roles
  });
  el.dispatch.innerHTML = `
    <div class="dispatch-form">
      <div class="field-row">
        <label for="dispatch-role">\u76EE\u6807 role</label>
        <select id="dispatch-role"${roles.length ? "" : " disabled"}>${roleOpts}</select>
      </div>
      <div class="field-row">
        <label for="dispatch-prompt">user prompt</label>
        <textarea id="dispatch-prompt" rows="3" placeholder="\u5199\u7ED9\u76EE\u6807 role \u7684\u4EFB\u52A1\u8BF4\u660E\u2026">${escapeHtml(dispatchPrompt)}</textarea>
      </div>
      <div class="row dispatch-actions">
        ${btnHtml({
    label: "\u6D3E\u6D3B",
    variant: "primary",
    id: "btn-dispatch",
    disabled: !validation.ok
  })}
        ${validation.ok ? "" : `<span class="faint">${escapeHtml(validation.reason || "")}</span>`}
      </div>
    </div>
  `;
  const roleSel = document.getElementById("dispatch-role");
  const promptTa = document.getElementById("dispatch-prompt");
  const btn = document.getElementById("btn-dispatch");
  roleSel?.addEventListener("change", () => {
    setDispatchRole(roleSel.value);
    host4?.renderDispatchPanel();
  });
  promptTa?.addEventListener("input", () => {
    const nextPrompt = promptTa.value;
    setDispatchPrompt(nextPrompt);
    if (btn) {
      const v = validateDispatchForm({
        nodeId: tab.nodeId,
        coordination: tab.coordination,
        role: roleSel?.value || dispatchRole,
        prompt: nextPrompt,
        roles
      });
      btn.disabled = !v.ok;
      const hint = el.dispatch.querySelector(".dispatch-actions .faint");
      if (hint) hint.textContent = v.ok ? "" : v.reason || "";
      else if (!v.ok) {
        const span = document.createElement("span");
        span.className = "faint";
        span.textContent = v.reason || "";
        el.dispatch.querySelector(".dispatch-actions")?.appendChild(span);
      }
    }
  });
  btn?.addEventListener("click", () => void onDispatch());
}
async function onDispatch() {
  const tab = activeCx ? localTabs.get(activeCx) : null;
  if (!tab || !workspaceId) return;
  const validation = validateDispatchForm({
    nodeId: tab.nodeId,
    coordination: tab.coordination,
    role: dispatchRole,
    prompt: dispatchPrompt,
    roles
  });
  if (!validation.ok || !validation.payload) {
    el.status.textContent = validation.reason || "\u65E0\u6CD5\u6D3E\u6D3B";
    return;
  }
  try {
    const result = await window.tentDesktop.rpc("task.dispatch", {
      workspaceId,
      workNodeIds: validation.payload.workNodeIds,
      contextNodeIds: validation.payload.contextNodeIds,
      roleId: validation.payload.roleId,
      prompt: validation.payload.prompt,
      parentActor: validation.payload.parentActor,
      reviewer: validation.payload.reviewer,
      acceptMode: "review-required"
    });
    el.status.textContent = `\u5DF2\u6D3E\u6D3B \u2192 ${result.taskPath}\uFF08${result.state}\uFF09`;
    setDispatchPrompt("");
    await Promise.all([reloadTasks(), reloadTree(), reloadPendingInteractions()]);
    host4?.renderDispatchPanel();
  } catch (err) {
    setError(err);
  }
}

// src/desktop/workbench/layout-prefs.ts
var LAYOUT_STORAGE_KEY = "tent.desktop.mainLayout.v1";
var LAYOUT_BOUNDS = {
  leftMin: 220,
  leftMax: 420,
  leftDefault: 256,
  rightMin: 280,
  rightMax: 520,
  rightDefault: 312,
  centerMin: 480,
  /** Visual + hit area for each splitter */
  splitterWidth: 8,
  /** Horizontal chrome around the three columns (layout padding) */
  layoutPadX: 20,
  resizeStep: 12
};
function defaultLayoutPrefs() {
  return {
    leftWidth: LAYOUT_BOUNDS.leftDefault,
    rightWidth: LAYOUT_BOUNDS.rightDefault,
    leftCollapsed: false,
    rightCollapsed: false
  };
}
function clampWidth(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}
function normalizeLayoutPrefs(input) {
  const base = defaultLayoutPrefs();
  if (!input || typeof input !== "object") return base;
  return {
    leftWidth: clampWidth(
      typeof input.leftWidth === "number" ? input.leftWidth : base.leftWidth,
      LAYOUT_BOUNDS.leftMin,
      LAYOUT_BOUNDS.leftMax
    ),
    rightWidth: clampWidth(
      typeof input.rightWidth === "number" ? input.rightWidth : base.rightWidth,
      LAYOUT_BOUNDS.rightMin,
      LAYOUT_BOUNDS.rightMax
    ),
    leftCollapsed: input.leftCollapsed === true,
    rightCollapsed: input.rightCollapsed === true
  };
}
function loadLayoutPrefs(storage) {
  if (!storage) return defaultLayoutPrefs();
  try {
    const raw = storage.getItem(LAYOUT_STORAGE_KEY);
    if (!raw) return defaultLayoutPrefs();
    return normalizeLayoutPrefs(JSON.parse(raw));
  } catch {
    return defaultLayoutPrefs();
  }
}
function saveLayoutPrefs(storage, prefs) {
  if (!storage) return;
  try {
    const normalized = normalizeLayoutPrefs(prefs);
    storage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(normalized));
  } catch {
  }
}
function fixedChromeWidth(leftCollapsed, rightCollapsed) {
  let w = LAYOUT_BOUNDS.layoutPadX;
  if (!leftCollapsed) w += LAYOUT_BOUNDS.splitterWidth;
  if (!rightCollapsed) w += LAYOUT_BOUNDS.splitterWidth;
  return w;
}
function centerWidthFor(available, leftCollapsed, rightCollapsed, leftWidth, rightWidth) {
  const chrome = fixedChromeWidth(leftCollapsed, rightCollapsed);
  const sides = (leftCollapsed ? 0 : leftWidth) + (rightCollapsed ? 0 : rightWidth);
  return available - chrome - sides;
}
function computeEffectiveLayout(prefs, viewportWidth) {
  const normalized = normalizeLayoutPrefs(prefs);
  let leftCollapsed = normalized.leftCollapsed;
  let rightCollapsed = normalized.rightCollapsed;
  let leftWidth = normalized.leftWidth;
  let rightWidth = normalized.rightWidth;
  let autoCollapsedRight = false;
  const available = Math.max(0, Math.round(viewportWidth));
  if (!leftCollapsed && !rightCollapsed && centerWidthFor(available, false, false, leftWidth, rightWidth) < LAYOUT_BOUNDS.centerMin) {
    rightCollapsed = true;
    autoCollapsedRight = true;
  }
  if (!leftCollapsed && rightCollapsed) {
    const roomForLeft = available - fixedChromeWidth(false, true) - LAYOUT_BOUNDS.centerMin;
    if (roomForLeft < leftWidth) {
      leftWidth = clampWidth(roomForLeft, LAYOUT_BOUNDS.leftMin, LAYOUT_BOUNDS.leftMax);
    }
  } else if (leftCollapsed && !rightCollapsed) {
    const roomForRight = available - fixedChromeWidth(true, false) - LAYOUT_BOUNDS.centerMin;
    if (roomForRight < rightWidth) {
      if (roomForRight < LAYOUT_BOUNDS.rightMin) {
        rightCollapsed = true;
        autoCollapsedRight = true;
      } else {
        rightWidth = clampWidth(roomForRight, LAYOUT_BOUNDS.rightMin, LAYOUT_BOUNDS.rightMax);
      }
    }
  } else if (!leftCollapsed && !rightCollapsed) {
    const roomForLeft = available - fixedChromeWidth(false, false) - rightWidth - LAYOUT_BOUNDS.centerMin;
    if (roomForLeft < leftWidth) {
      leftWidth = clampWidth(roomForLeft, LAYOUT_BOUNDS.leftMin, LAYOUT_BOUNDS.leftMax);
      if (centerWidthFor(available, false, false, leftWidth, rightWidth) < LAYOUT_BOUNDS.centerMin) {
        rightCollapsed = true;
        autoCollapsedRight = true;
        const roomLeftOnly = available - fixedChromeWidth(false, true) - LAYOUT_BOUNDS.centerMin;
        leftWidth = clampWidth(
          Math.min(normalized.leftWidth, roomLeftOnly),
          LAYOUT_BOUNDS.leftMin,
          LAYOUT_BOUNDS.leftMax
        );
      }
    }
  }
  const centerWidth = Math.max(
    0,
    centerWidthFor(available, leftCollapsed, rightCollapsed, leftWidth, rightWidth)
  );
  return {
    leftWidth,
    rightWidth,
    leftCollapsed,
    rightCollapsed,
    centerWidth,
    autoCollapsedRight
  };
}
function capSideForCenter(sideWidth, sideMin, sideMax, maxForCenter) {
  if (!Number.isFinite(maxForCenter)) {
    return clampWidth(sideWidth, sideMin, sideMax);
  }
  if (maxForCenter < sideMin) {
    return sideMin;
  }
  return clampWidth(Math.min(sideWidth, maxForCenter), sideMin, sideMax);
}
function resizeSide(prefs, side, nextWidth, viewportWidth) {
  const normalized = normalizeLayoutPrefs(prefs);
  if (side === "left") {
    let leftWidth = clampWidth(nextWidth, LAYOUT_BOUNDS.leftMin, LAYOUT_BOUNDS.leftMax);
    if (!normalized.rightCollapsed) {
      const maxLeft = viewportWidth - fixedChromeWidth(false, false) - normalized.rightWidth - LAYOUT_BOUNDS.centerMin;
      leftWidth = capSideForCenter(
        leftWidth,
        LAYOUT_BOUNDS.leftMin,
        LAYOUT_BOUNDS.leftMax,
        maxLeft
      );
    } else {
      const maxLeft = viewportWidth - fixedChromeWidth(false, true) - LAYOUT_BOUNDS.centerMin;
      leftWidth = capSideForCenter(
        leftWidth,
        LAYOUT_BOUNDS.leftMin,
        LAYOUT_BOUNDS.leftMax,
        maxLeft
      );
    }
    return { ...normalized, leftWidth, leftCollapsed: false };
  }
  let rightWidth = clampWidth(nextWidth, LAYOUT_BOUNDS.rightMin, LAYOUT_BOUNDS.rightMax);
  if (!normalized.leftCollapsed) {
    const maxRight = viewportWidth - fixedChromeWidth(false, false) - normalized.leftWidth - LAYOUT_BOUNDS.centerMin;
    rightWidth = capSideForCenter(
      rightWidth,
      LAYOUT_BOUNDS.rightMin,
      LAYOUT_BOUNDS.rightMax,
      maxRight
    );
  } else {
    const maxRight = viewportWidth - fixedChromeWidth(true, false) - LAYOUT_BOUNDS.centerMin;
    rightWidth = capSideForCenter(
      rightWidth,
      LAYOUT_BOUNDS.rightMin,
      LAYOUT_BOUNDS.rightMax,
      maxRight
    );
  }
  return { ...normalized, rightWidth, rightCollapsed: false };
}
function toggleCollapsed(prefs, side) {
  const normalized = normalizeLayoutPrefs(prefs);
  if (side === "left") {
    return { ...normalized, leftCollapsed: !normalized.leftCollapsed };
  }
  return { ...normalized, rightCollapsed: !normalized.rightCollapsed };
}
function stepResize(prefs, side, direction, viewportWidth, step = LAYOUT_BOUNDS.resizeStep) {
  const normalized = normalizeLayoutPrefs(prefs);
  const current2 = side === "left" ? normalized.leftWidth : normalized.rightWidth;
  return resizeSide(prefs, side, current2 + direction * step, viewportWidth);
}

// src/desktop/renderer/main/layout.ts
var layoutPrefs = loadLayoutPrefs(
  typeof localStorage !== "undefined" ? localStorage : null
);
var resizeSession = null;
function layoutViewportWidth() {
  return el.layout?.clientWidth || window.innerWidth || 1200;
}
function persistLayout() {
  saveLayoutPrefs(typeof localStorage !== "undefined" ? localStorage : null, layoutPrefs);
}
function applyLayoutChrome() {
  if (!el.layout) return;
  const effective = computeEffectiveLayout(layoutPrefs, layoutViewportWidth());
  el.layout.style.setProperty("--layout-left-width", `${effective.leftWidth}px`);
  el.layout.style.setProperty("--layout-right-width", `${effective.rightWidth}px`);
  el.layout.classList.toggle("is-left-collapsed", effective.leftCollapsed);
  el.layout.classList.toggle("is-right-collapsed", effective.rightCollapsed);
  if (el.btnExpandLeft) {
    el.btnExpandLeft.hidden = !layoutPrefs.leftCollapsed;
    el.btnExpandLeft.setAttribute("aria-expanded", layoutPrefs.leftCollapsed ? "false" : "true");
    el.btnExpandLeft.title = "\u5C55\u5F00\u5DE6\u4FA7\u680F";
    el.btnExpandLeft.setAttribute("aria-label", "\u5C55\u5F00\u5DE6\u4FA7\u680F");
  }
  if (el.btnExpandRight) {
    el.btnExpandRight.hidden = !layoutPrefs.rightCollapsed;
    el.btnExpandRight.setAttribute("aria-expanded", layoutPrefs.rightCollapsed ? "false" : "true");
    el.btnExpandRight.title = "\u5C55\u5F00\u53F3\u4FA7\u680F";
    el.btnExpandRight.setAttribute("aria-label", "\u5C55\u5F00\u53F3\u4FA7\u680F");
  }
  if (el.btnCollapseLeft) {
    el.btnCollapseLeft.hidden = layoutPrefs.leftCollapsed;
    el.btnCollapseLeft.setAttribute("aria-expanded", layoutPrefs.leftCollapsed ? "false" : "true");
    el.btnCollapseLeft.title = "\u6536\u8D77\u5DE6\u4FA7\u680F";
    el.btnCollapseLeft.setAttribute("aria-label", "\u6536\u8D77\u5DE6\u4FA7\u680F");
  }
  if (el.btnCollapseRight) {
    el.btnCollapseRight.hidden = layoutPrefs.rightCollapsed;
    el.btnCollapseRight.setAttribute("aria-expanded", layoutPrefs.rightCollapsed ? "false" : "true");
    el.btnCollapseRight.title = "\u6536\u8D77\u53F3\u4FA7\u680F";
    el.btnCollapseRight.setAttribute("aria-label", "\u6536\u8D77\u53F3\u4FA7\u680F");
  }
  if (el.splitterLeft) {
    el.splitterLeft.setAttribute("aria-valuemin", String(LAYOUT_BOUNDS.leftMin));
    el.splitterLeft.setAttribute("aria-valuemax", String(LAYOUT_BOUNDS.leftMax));
    el.splitterLeft.setAttribute("aria-valuenow", String(effective.leftWidth));
    el.splitterLeft.tabIndex = effective.leftCollapsed ? -1 : 0;
  }
  if (el.splitterRight) {
    el.splitterRight.setAttribute("aria-valuemin", String(LAYOUT_BOUNDS.rightMin));
    el.splitterRight.setAttribute("aria-valuemax", String(LAYOUT_BOUNDS.rightMax));
    el.splitterRight.setAttribute("aria-valuenow", String(effective.rightWidth));
    el.splitterRight.tabIndex = effective.rightCollapsed ? -1 : 0;
  }
}
function setLayoutPrefs(next, persist = true) {
  layoutPrefs = next;
  applyLayoutChrome();
  if (persist) persistLayout();
}
function onToggleSide(side) {
  setLayoutPrefs(toggleCollapsed(layoutPrefs, side));
}
function beginResize(side, clientX) {
  const width = side === "left" ? layoutPrefs.leftWidth : layoutPrefs.rightWidth;
  resizeSession = { side, startX: clientX, startWidth: width };
  document.body.classList.add("is-resizing");
  const splitter = side === "left" ? el.splitterLeft : el.splitterRight;
  splitter?.classList.add("is-active");
}
function onResizePointerMove(clientX) {
  if (!resizeSession) return;
  const delta = clientX - resizeSession.startX;
  const nextWidth = resizeSession.side === "left" ? resizeSession.startWidth + delta : resizeSession.startWidth - delta;
  setLayoutPrefs(resizeSide(layoutPrefs, resizeSession.side, nextWidth, layoutViewportWidth()), false);
}
function endResize() {
  if (!resizeSession) return;
  resizeSession = null;
  document.body.classList.remove("is-resizing");
  el.splitterLeft?.classList.remove("is-active");
  el.splitterRight?.classList.remove("is-active");
  persistLayout();
  applyLayoutChrome();
}
function bindSplitter(side, node2) {
  if (!node2) return;
  node2.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    node2.setPointerCapture?.(ev.pointerId);
    beginResize(side, ev.clientX);
  });
  node2.addEventListener("pointermove", (ev) => {
    if (!resizeSession || resizeSession.side !== side) return;
    onResizePointerMove(ev.clientX);
  });
  node2.addEventListener("pointerup", () => endResize());
  node2.addEventListener("pointercancel", () => endResize());
  node2.addEventListener("lostpointercapture", () => endResize());
  node2.addEventListener("keydown", (ev) => {
    if (ev.key === "ArrowLeft" || ev.key === "ArrowRight") {
      ev.preventDefault();
      const dir = side === "left" ? ev.key === "ArrowRight" ? 1 : -1 : ev.key === "ArrowLeft" ? 1 : -1;
      setLayoutPrefs(stepResize(layoutPrefs, side, dir, layoutViewportWidth()));
    } else if (ev.key === "Home") {
      ev.preventDefault();
      const min = side === "left" ? LAYOUT_BOUNDS.leftMin : LAYOUT_BOUNDS.rightMin;
      setLayoutPrefs(resizeSide(layoutPrefs, side, min, layoutViewportWidth()));
    } else if (ev.key === "End") {
      ev.preventDefault();
      const max = side === "left" ? LAYOUT_BOUNDS.leftMax : LAYOUT_BOUNDS.rightMax;
      setLayoutPrefs(resizeSide(layoutPrefs, side, max, layoutViewportWidth()));
    } else if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      onToggleSide(side);
    }
  });
  node2.addEventListener("dblclick", () => onToggleSide(side));
}
function setDrawerOpen(drawer, toggle, open) {
  if (!drawer) return;
  drawer.hidden = !open;
  if (toggle) toggle.setAttribute("aria-expanded", open ? "true" : "false");
}
function setMenuOpen(open) {
  if (!el.railOverflow) return;
  el.railOverflow.hidden = !open;
  el.btnRailMore?.setAttribute("aria-expanded", open ? "true" : "false");
}
function closeChromePopovers() {
  setDrawerOpen(el.searchDrawer, el.btnToggleSearch, false);
  setDrawerOpen(el.createDrawer, el.btnToggleCreate, false);
  setMenuOpen(false);
}
function isChromePopoverOpen() {
  return !!el.searchDrawer && !el.searchDrawer.hidden || !!el.createDrawer && !el.createDrawer.hidden || !!el.railOverflow && !el.railOverflow.hidden;
}
function bindChromeMenus() {
  el.btnToggleSearch?.addEventListener("click", (ev) => {
    ev.stopPropagation();
    const open = !!el.searchDrawer?.hidden;
    setDrawerOpen(el.createDrawer, el.btnToggleCreate, false);
    setMenuOpen(false);
    setDrawerOpen(el.searchDrawer, el.btnToggleSearch, open);
    if (open) el.searchInput?.focus();
  });
  el.btnToggleCreate?.addEventListener("click", (ev) => {
    ev.stopPropagation();
    const open = !!el.createDrawer?.hidden;
    setDrawerOpen(el.searchDrawer, el.btnToggleSearch, false);
    setMenuOpen(false);
    setDrawerOpen(el.createDrawer, el.btnToggleCreate, open);
    if (open) el.createType?.focus();
  });
  el.btnRailMore?.addEventListener("click", (ev) => {
    ev.stopPropagation();
    const open = !!el.railOverflow?.hidden;
    setDrawerOpen(el.searchDrawer, el.btnToggleSearch, false);
    setDrawerOpen(el.createDrawer, el.btnToggleCreate, false);
    setMenuOpen(open);
    if (open) {
      const first = el.railOverflow?.querySelector(".menu-item");
      first?.focus();
    }
  });
  el.railOverflow?.addEventListener("click", (ev) => {
    const t = ev.target;
    if (t?.closest(".menu-item")) setMenuOpen(false);
  });
  document.addEventListener("click", (ev) => {
    const t = ev.target;
    if (!t) return;
    if (el.railOverflow?.contains(t) || el.btnRailMore?.contains(t)) return;
    if (el.searchDrawer?.contains(t) || el.btnToggleSearch?.contains(t)) return;
    if (el.createDrawer?.contains(t) || el.btnToggleCreate?.contains(t)) return;
    closeChromePopovers();
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape") return;
    if (!isChromePopoverOpen()) return;
    const wasSearch = !!el.searchDrawer && !el.searchDrawer.hidden;
    const wasCreate = !!el.createDrawer && !el.createDrawer.hidden;
    const wasMenu = !!el.railOverflow && !el.railOverflow.hidden;
    ev.preventDefault();
    closeChromePopovers();
    if (wasMenu) el.btnRailMore?.focus();
    else if (wasSearch) el.btnToggleSearch?.focus();
    else if (wasCreate) el.btnToggleCreate?.focus();
  });
}
function bindLayoutChrome() {
  el.btnCollapseLeft?.addEventListener("click", () => onToggleSide("left"));
  el.btnCollapseRight?.addEventListener("click", () => onToggleSide("right"));
  el.btnExpandLeft?.addEventListener("click", () => {
    if (layoutPrefs.leftCollapsed) onToggleSide("left");
  });
  el.btnExpandRight?.addEventListener("click", () => {
    if (layoutPrefs.rightCollapsed) onToggleSide("right");
  });
  bindSplitter("left", el.splitterLeft);
  bindSplitter("right", el.splitterRight);
  window.addEventListener("resize", () => applyLayoutChrome());
  window.addEventListener("pointerup", () => endResize());
  applyLayoutChrome();
}

// src/desktop/renderer/main/tree.ts
var host5 = null;
function bindTreeHost(h) {
  host5 = h;
}
function renderCreateTypeSelect() {
  const selected = createTypePick || pickDefaultCoordinationType(coordinationTypes) || "";
  setCreateTypePick(selected);
  if (!coordinationTypes.length) {
    el.createType.innerHTML = `<option value="">\u65E0\u53EF\u534F\u8C03\u7C7B\u578B</option>`;
    el.createType.disabled = true;
    el.btnNewBox.disabled = true;
    el.btnNewBox.title = "\u5F53\u524D types \u6CE8\u518C\u8868\u6CA1\u6709\u4E00\u7EA7\uFF08base\uFF09\u7C7B\u578B";
    return;
  }
  el.createType.disabled = false;
  el.btnNewBox.disabled = false;
  el.btnNewBox.title = "\u4F7F\u7528\u6240\u9009\u7C7B\u578B\u65B0\u5EFA\u8282\u70B9";
  el.createType.innerHTML = coordinationTypes.map(
    (t) => `<option value="${escapeHtml(t.name)}"${t.name === selected ? " selected" : ""}>${escapeHtml(t.name)}</option>`
  ).join("");
}
function renderTree() {
  el.tree.setAttribute("role", "tree");
  el.tree.innerHTML = tree.length ? renderNodes(tree) : `<li class="muted">\u6682\u65E0\u6982\u5FF5</li>`;
  el.tree.querySelectorAll("[data-open]").forEach((node2) => {
    const open = () => void host5?.openNode(node2.getAttribute("data-open"));
    node2.addEventListener("click", open);
    node2.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        open();
      }
    });
  });
}
function nodeStatusMark(status, assignee) {
  if (status === "doing") {
    const title = assignee ? `\u6D3B\u52A8\u4EFB\u52A1 \xB7 ${assignee}` : "\u6D3B\u52A8\u4EFB\u52A1";
    return `<span class="status-mark is-doing" title="${escapeHtml(title)}" aria-hidden="true"></span>`;
  }
  return "";
}
function renderNodes(nodes) {
  return nodes.map((n) => {
    const mark = n.coordination ? nodeStatusMark(n.status, n.assignee) : "";
    const rowClass = treeRowClass({
      active: n.nodeId === activeCx,
      archived: n.mode === "archived"
    });
    const kids = n.children?.length ? `<ul>${renderNodes(n.children)}</ul>` : "";
    const titleParts = [
      n.name,
      n.type,
      n.mode || "editable",
      n.coordination && n.status === "doing" ? "doing" : "",
      n.assignee || "",
      n.nodeId
    ].filter(Boolean);
    return `<li>
        <div class="${rowClass}" role="treeitem" tabindex="0" data-open="${escapeHtml(n.nodeId)}" title="${escapeHtml(titleParts.join(" \xB7 "))}">
          <span class="${UI.treeName}">${escapeHtml(n.name)}</span>
          <span class="${UI.treeMeta}">${mark}</span>
        </div>
        ${kids}
      </li>`;
  }).join("");
}
async function onCreateNote() {
  if (!workspaceId) {
    el.status.textContent = "\u8BF7\u5148\u6302\u8F7D\u5DE5\u4F5C\u533A\u3002";
    return;
  }
  const name = `note-${Date.now().toString(36).slice(-4)}`;
  try {
    const created = await window.tentDesktop.rpc("docs.createNote", {
      workspaceId,
      name,
      type: "prompt"
    });
    await reloadTree();
    await host5?.openNode(created.nodeId);
  } catch (err) {
    setError(err);
  }
}
async function onCreateNode() {
  if (!workspaceId) {
    el.status.textContent = "\u8BF7\u5148\u6302\u8F7D\u5DE5\u4F5C\u533A\u3002";
    return;
  }
  const typeName = createTypePick || pickDefaultCoordinationType(coordinationTypes);
  if (!typeName) {
    el.status.textContent = "\u5F53\u524D types \u6CE8\u518C\u8868\u6CA1\u6709\u53EF\u534F\u8C03\u7684\u4E00\u7EA7\u7C7B\u578B\u3002";
    return;
  }
  const name = suggestNodeName(typeName);
  try {
    const created = await window.tentDesktop.rpc("docs.createNote", {
      workspaceId,
      name,
      type: typeName
    });
    el.status.textContent = `\u5DF2\u65B0\u5EFA\u8282\u70B9\u300C${name}\u300D\uFF08${created.type || typeName}\uFF09`;
    await reloadTree();
    await host5?.openNode(created.nodeId);
  } catch (err) {
    setError(err);
  }
}
async function onSearch() {
  if (!workspaceId) return;
  const q = el.searchInput.value.trim();
  if (!q) {
    el.searchHits.innerHTML = "";
    return;
  }
  try {
    const result = await window.tentDesktop.rpc("docs.search", {
      workspaceId,
      query: q
    });
    const hits = result.hits || [];
    el.searchHits.innerHTML = hits.map(
      (h) => `<li class="card-item" data-open="${escapeHtml(h.nodeId)}"><strong>${escapeHtml(h.name)}</strong>
           <div class="muted">${escapeHtml(h.match)} \xB7 ${escapeHtml(h.snippet)}</div></li>`
    ).join("");
    el.searchHits.querySelectorAll("[data-open]").forEach((n) => {
      n.addEventListener("click", () => void host5?.openNode(n.getAttribute("data-open")));
    });
  } catch (err) {
    setError(err);
  }
}

// src/desktop/renderer/main/shell.ts
var SURFACES = ["workbench", "graph", "activity", "settings"];
var current = "workbench";
var host6 = null;
function getSurface() {
  return current;
}
function bindShellHost(h) {
  host6 = h;
}
function setSurface(next, notify = true) {
  if (!SURFACES.includes(next)) return;
  if (current === next) return;
  current = next;
  applySurfaceDom(current);
  if (notify) host6?.onSurfaceChange(current);
}
function applySurfaceDom(surface = current) {
  const app = document.getElementById("app-root");
  if (app) app.dataset.surface = surface;
  document.querySelectorAll("[data-surface-nav]").forEach((btn) => {
    const id = btn.getAttribute("data-surface-nav");
    const active = id === surface;
    btn.classList.toggle("is-active", active);
    btn.setAttribute("aria-current", active ? "page" : "false");
  });
  const workbench = document.getElementById("main-layout");
  const secondary = document.getElementById("secondary-host");
  if (workbench) {
    workbench.hidden = surface !== "workbench";
    workbench.setAttribute("aria-hidden", surface === "workbench" ? "false" : "true");
  }
  if (secondary) {
    secondary.hidden = surface === "workbench";
    secondary.setAttribute("aria-hidden", surface === "workbench" ? "true" : "false");
  }
  for (const s of SURFACES) {
    if (s === "workbench") continue;
    const pane = document.getElementById(`surface-${s}`);
    if (pane) {
      const show = surface === s;
      pane.hidden = !show;
      pane.setAttribute("aria-hidden", show ? "false" : "true");
    }
  }
}
function bindSurfaceNav() {
  document.querySelectorAll("[data-surface-nav]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-surface-nav");
      if (id) setSurface(id);
    });
  });
  document.addEventListener("keydown", (ev) => {
    if (!(ev.ctrlKey || ev.metaKey) || ev.altKey || ev.shiftKey) return;
    const map = {
      "1": "workbench",
      "2": "graph",
      "3": "activity",
      "4": "settings"
    };
    const next = map[ev.key];
    if (!next) return;
    const t = ev.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) {
    }
    ev.preventDefault();
    setSurface(next);
  });
  applySurfaceDom(current);
}

// src/desktop/workbench/graph-model.ts
function graphNodeUsable(n) {
  if (n.invalid) return false;
  if (n.archived) return false;
  if (typeof n.coordination === "boolean") return n.coordination;
  return true;
}
function flattenGraphNodes(roots, depth = 0) {
  const out = [];
  for (const n of roots) {
    const usable = graphNodeUsable(n);
    out.push({
      nodeId: n.nodeId,
      path: n.path,
      name: n.name,
      type: n.type,
      usable,
      coordination: usable,
      depth
    });
    if (n.children?.length) {
      out.push(...flattenGraphNodes(n.children, depth + 1));
    }
  }
  return out;
}
function findGraphNode(nodes, nodeId) {
  for (const n of nodes) {
    if (n.nodeId === nodeId) return n;
    const child = findGraphNode(n.children || [], nodeId);
    if (child) return child;
  }
  return void 0;
}
function buildGraphSelectionView(args) {
  return {
    node: args.node,
    backlinks: args.backlinks ?? [],
    outLinks: args.outLinks ?? [],
    backlinksError: args.backlinksError ?? null,
    outLinksError: args.outLinksError ?? null
  };
}
function verificationLevelLabel(level) {
  switch (level) {
    case "live-verified":
      return "live verified (this machine)";
    case "opt-in-live-probe":
      return "opt-in live probe";
    case "live-e2e":
      return "opt-in live probe (legacy live-e2e)";
    case "mock-tested":
      return "mock-tested";
    case "adapter-implemented":
      return "adapter only";
    default:
      return level || "unknown";
  }
}

// src/desktop/renderer/main/graph.ts
var host7 = null;
var selectedId = null;
var loadGen = 0;
var selectionView = buildGraphSelectionView({ node: null });
var loadState = "idle";
var loadError = null;
function bindGraphHost(h) {
  host7 = h;
}
async function reloadGraph() {
  const hostEl = el.graphHost;
  if (!hostEl) return;
  if (!workspaceId) {
    loadState = "idle";
    loadError = null;
    selectedId = null;
    selectionView = buildGraphSelectionView({ node: null });
    renderGraph();
    return;
  }
  loadState = "loading";
  loadError = null;
  renderGraph();
  if (activeCx) selectedId = activeCx;
  else if (selectedId && !findGraphNode(tree, selectedId)) {
    selectedId = null;
  }
  if (!selectedId) {
    const flat = flattenGraphNodes(tree);
    selectedId = flat[0]?.nodeId ?? null;
  }
  await loadSelection(selectedId);
}
async function loadSelection(cx) {
  const gen = ++loadGen;
  if (!workspaceId || !cx) {
    selectionView = buildGraphSelectionView({ node: null });
    loadState = "ready";
    renderGraph();
    return;
  }
  const node2 = findGraphNode(tree, cx) || null;
  let backlinks = [];
  let outLinks = [];
  let backlinksError = null;
  let outLinksError = null;
  try {
    const bl = await window.tentDesktop.rpc("docs.backlinks", {
      workspaceId,
      nodeId: cx
    });
    if (gen !== loadGen) return;
    backlinks = bl.backlinks || [];
  } catch (err) {
    if (gen !== loadGen) return;
    backlinksError = err instanceof Error ? err.message : String(err);
  }
  try {
    const edit = await window.tentDesktop.rpc("docs.readForEdit", {
      workspaceId,
      nodeId: cx
    });
    if (gen !== loadGen) return;
    const body = edit.body ?? "";
    if (body) {
      outLinks = extractOutLinks(body).map((l) => ({
        raw: l.raw,
        kind: l.kind,
        targetNodeId: l.targetNodeId,
        targetPath: l.targetPath,
        label: l.label
      }));
    }
  } catch (err) {
    if (gen !== loadGen) return;
    outLinksError = err instanceof Error ? err.message : String(err);
  }
  selectionView = buildGraphSelectionView({
    node: node2,
    backlinks,
    outLinks,
    backlinksError,
    outLinksError
  });
  loadState = "ready";
  renderGraph();
}
function renderGraph() {
  const hostEl = el.graphHost;
  if (!hostEl) return;
  if (!workspaceId) {
    hostEl.innerHTML = `<div class="empty empty-cta"><p class="empty-title">\u6253\u5F00\u5DE5\u4F5C\u533A</p></div>`;
    return;
  }
  if (loadState === "loading" && !selectionView.node && !tree.length) {
    hostEl.innerHTML = `<div class="empty"><p class="muted">\u52A0\u8F7D\u4E2D\u2026</p></div>`;
    return;
  }
  if (loadState === "error" && loadError) {
    hostEl.innerHTML = `<div class="empty"><p class="empty-title">\u56FE\u8C31\u4E0D\u53EF\u7528</p><p class="muted">${escapeHtml(loadError)}</p></div>`;
    return;
  }
  const flat = flattenGraphNodes(tree);
  if (!flat.length) {
    hostEl.innerHTML = `<div class="empty"><p class="empty-title">\u65E0\u8282\u70B9</p></div>`;
    return;
  }
  const nodesHtml = flat.map((n) => {
    const active = n.nodeId === selectedId ? " is-active" : "";
    const pad = 8 + n.depth * 14;
    const kind = n.type;
    return `<button type="button" class="graph-node${active}" data-graph-node="${escapeHtml(n.nodeId)}" style="padding-left:${pad}px" title="${escapeHtml(n.path)}">
        <span class="graph-node-name">${escapeHtml(n.name)}</span>
        <span class="muted graph-node-kind">${escapeHtml(kind)}</span>
      </button>`;
  }).join("");
  const sel = selectionView;
  const title = sel.node ? escapeHtml(sel.node.name) : selectedId ? escapeHtml(selectedId) : "\u672A\u9009\u62E9";
  let edgesHtml = "";
  if (sel.backlinksError) {
    edgesHtml += `<p class="muted graph-err">\u53CD\u5411\u94FE\u63A5\uFF1A${escapeHtml(sel.backlinksError)}</p>`;
  } else if (!sel.backlinks.length) {
    edgesHtml += `<p class="muted">\u65E0\u53CD\u5411\u94FE\u63A5</p>`;
  } else {
    edgesHtml += `<ul class="graph-edge-list" aria-label="\u53CD\u5411\u94FE\u63A5">${sel.backlinks.map(
      (b) => `<li><button type="button" class="linkish" data-graph-jump="${escapeHtml(b.fromNodeId)}">${escapeHtml(b.fromName || b.fromPath)}</button>
          <span class="faint">${escapeHtml(b.raw)}</span></li>`
    ).join("")}</ul>`;
  }
  let outHtml = "";
  if (sel.outLinksError) {
    outHtml = `<p class="muted graph-err">\u51FA\u94FE\uFF1A${escapeHtml(sel.outLinksError)}</p>`;
  } else if (!sel.outLinks.length) {
    outHtml = `<p class="muted">\u65E0\u51FA\u94FE</p>`;
  } else {
    outHtml = `<ul class="graph-edge-list" aria-label="\u51FA\u94FE">${sel.outLinks.map((l) => {
      const label = l.label || l.targetPath || l.raw;
      const jump = l.targetNodeId ? ` data-graph-jump="${escapeHtml(l.targetNodeId)}"` : "";
      const tag = l.targetNodeId ? "button" : "span";
      const cls = l.targetNodeId ? ' class="linkish"' : ' class="muted"';
      return `<li><${tag} type="button"${cls}${jump}>${escapeHtml(label)}</${tag}>
          <span class="faint">${escapeHtml(l.kind)} \xB7 ${escapeHtml(l.raw)}</span></li>`;
    }).join("")}</ul>`;
  }
  const openBtn = sel.node ? `<button type="button" class="btn btn-secondary" id="btn-graph-open">\u5728\u5DE5\u4F5C\u53F0\u6253\u5F00</button>` : "";
  hostEl.innerHTML = `
    <div class="graph-layout">
      <aside class="graph-list-pane" aria-label="\u8282\u70B9">
        <div class="surface-section-head">\u8282\u70B9</div>
        <div class="graph-node-list">${nodesHtml}</div>
      </aside>
      <section class="graph-detail-pane" aria-label="\u5173\u7CFB">
        <div class="surface-section-head graph-detail-head">
          <span>${title}</span>
          ${openBtn}
        </div>
        <div class="graph-detail-body">
          <div class="graph-block">
            <div class="graph-block-title">\u53CD\u5411\u94FE\u63A5</div>
            ${edgesHtml}
          </div>
          <div class="graph-block">
            <div class="graph-block-title">\u51FA\u94FE</div>
            ${outHtml}
          </div>
          <p class="faint graph-footnote">\u5C40\u90E8\u6295\u5F71 \xB7 \u65E0\u5168\u5C40\u56FE\u8C31 RPC</p>
        </div>
      </section>
    </div>`;
  hostEl.querySelectorAll("[data-graph-node]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-graph-node");
      if (!id || id === selectedId) return;
      selectedId = id;
      setActiveCx(id);
      void loadSelection(id);
    });
  });
  hostEl.querySelectorAll("[data-graph-jump]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-graph-jump");
      if (!id) return;
      selectedId = id;
      setActiveCx(id);
      void loadSelection(id);
    });
  });
  document.getElementById("btn-graph-open")?.addEventListener("click", () => {
    if (!selectedId) return;
    void host7?.openNode(selectedId).then(() => host7?.goWorkbench());
  });
}
function onGraphTreeChanged() {
  if (!el.graphHost || el.graphHost.closest("[hidden]")) {
    if (selectedId && !findGraphNode(tree, selectedId)) {
      selectedId = null;
    }
    return;
  }
  void reloadGraph().catch((err) => {
    setError(err);
    loadState = "error";
    loadError = err instanceof Error ? err.message : String(err);
    renderGraph();
  });
}

// src/desktop/renderer/main/activity.ts
function bindActivityHost(_h) {
}
function renderActivity() {
  const hostEl = el.activityHost;
  if (!hostEl) return;
  if (!workspaceId) {
    hostEl.innerHTML = `<div class="empty empty-cta"><p class="empty-title">\u6253\u5F00\u5DE5\u4F5C\u533A</p></div>`;
    return;
  }
  const pendingN = pendingInteractionCount2();
  const tasks = actionableTasks();
  const liveSessions = sessions.filter((s) => s.alive || s.state === "running" || s.state === "waiting");
  const requestsHtml = decisionRequests.map((request) => {
    const options = request.options.map(
      (option) => `<label class="choice-row">
        <input type="radio" name="act-decision-${escapeHtml(request.id)}" value="${escapeHtml(option.id)}" />
        <span>${escapeHtml(option.label)}</span></label>`
    ).join("");
    return `<article class="interaction-item" data-act-decision="${escapeHtml(request.id)}" data-task-path="${escapeHtml(request.taskPath)}" data-pending-kind="decisionRequest">
        <div class="interaction-kicker">DECISION REQUEST</div>
        <div class="interaction-title">${escapeHtml(request.question)}</div>
        <div class="muted interaction-note">${escapeHtml(request.taskPath)}</div>
        ${options ? `<div class="choice-list">${options}</div>` : ""}
        <textarea class="line-input" data-act-answer="${escapeHtml(request.id)}" rows="2" placeholder="\u81EA\u5B9A\u4E49\u56DE\u7B54\uFF08\u53EF\u9009\uFF09"></textarea>
        <div class="interaction-actions">
          <button type="button" class="btn btn-primary" data-act-respond="${escapeHtml(request.id)}">\u56DE\u590D</button>
          <button type="button" class="btn btn-ghost" data-act-decision-deny="${escapeHtml(request.id)}">\u62D2\u7EDD</button>
          <button type="button" class="btn btn-ghost" data-act-interrupt="${escapeHtml(request.taskPath)}">\u4E2D\u65AD</button>
        </div>
      </article>`;
  }).join("");
  const toolsHtml = toolApprovals.map((item) => {
    const summary = item.paramsSummary || "";
    return `<article class="interaction-item" data-pending-kind="toolApproval">
        <div class="interaction-kicker">TOOL \xB7 ${escapeHtml(item.toolTitle)}</div>
        <div class="interaction-title">${escapeHtml(item.toolTitle)}</div>
        <div class="muted interaction-note">${escapeHtml(item.role || "Agent")} \xB7 session ${escapeHtml(item.sessionId)}</div>
        ${summary ? `<div class="muted interaction-note">${escapeHtml(summary)}</div>` : ""}
        <div class="interaction-actions">
          <button type="button" class="btn btn-primary" data-act-tool-allow="${escapeHtml(item.id)}">\u5141\u8BB8\u4E00\u6B21</button>
          <button type="button" class="btn btn-ghost" data-act-tool-deny="${escapeHtml(item.id)}">\u62D2\u7EDD</button>
        </div>
      </article>`;
  }).join("");
  const inputsHtml = taskInputs.map((item) => {
    const text3 = (item.text || "").trim();
    const preview = text3.length > 160 ? text3.slice(0, 157) + "\u2026" : text3;
    return `<article class="interaction-item" data-pending-kind="taskInput">
        <div class="interaction-kicker">${escapeHtml(taskInputKindLabel(item.inputKind))} \xB7 ${escapeHtml(item.role || "\u2014")}</div>
        <div class="interaction-title">${escapeHtml(preview || "\uFF08\u65E0\u6B63\u6587\uFF09")}</div>
        <div class="muted interaction-note">${escapeHtml(item.taskPath)}</div>
        <div class="muted interaction-note">\u5F85 agent \u6D88\u8D39\uFF08taskInput.ack\uFF09</div>
      </article>`;
  }).join("");
  const reviewTasks = tasks.filter((t) => t.canAcceptOrReject);
  const reviewHtml = reviewTasks.map((t) => {
    const draft = rejectDrafts.get(t.path) || "";
    return `<article class="interaction-item" data-pending-kind="deliveryReview">
        <div class="interaction-kicker">DELIVERY REVIEW</div>
        <div class="interaction-title">${escapeHtml(t.roleId || t.sessionConnectionId || t.sessionId || "Session")}</div>
        <div class="muted interaction-note">${escapeHtml(t.deliverySummary || t.prompt || t.path)}</div>
        <div class="interaction-actions">
          <button type="button" class="btn btn-primary" data-act-accept="${escapeHtml(t.path)}" data-act-delivery="${escapeHtml(t.activeDeliveryId || "")}">\u786E\u8BA4</button>
          <button type="button" class="btn btn-ghost" data-act-reject-toggle="${escapeHtml(t.path)}">\u9A73\u56DE</button>
          ${t.canInterrupt ? `<button type="button" class="btn btn-ghost" data-act-interrupt="${escapeHtml(t.path)}">\u4E2D\u65AD</button>` : ""}
        </div>
        <div class="reject-panel" data-act-reject-panel="${escapeHtml(t.path)}" hidden>
          <input type="text" class="field" data-act-reject-reason="${escapeHtml(t.path)}" placeholder="\u9A73\u56DE\u539F\u56E0" value="${escapeHtml(draft)}" />
          <button type="button" class="btn btn-danger" data-act-reject="${escapeHtml(t.path)}" data-act-delivery="${escapeHtml(t.activeDeliveryId || "")}">\u786E\u8BA4\u9A73\u56DE</button>
        </div>
      </article>`;
  }).join("");
  const proposalHtml = proposals.map((p) => {
    const body = (p.body || "").trim();
    const preview = body.length > 160 ? body.slice(0, 157) + "\u2026" : body;
    return `<article class="interaction-item" data-pending-kind="proposal">
        <div class="interaction-kicker">PROPOSAL \xB7 ${escapeHtml(p.role || "Agent")}</div>
        <div class="interaction-title">${escapeHtml(preview || p.path)}</div>
        <div class="muted interaction-note">${escapeHtml(p.nodeId || "")}</div>
        <div class="interaction-actions">
          <button type="button" class="btn btn-primary" data-act-proposal-accept="${escapeHtml(p.path)}">\u91C7\u7EB3</button>
          <button type="button" class="btn btn-ghost" data-act-proposal-reject="${escapeHtml(p.path)}">\u9A73\u56DE</button>
        </div>
      </article>`;
  }).join("");
  const pendingTotal = pendingN + reviewTasks.length;
  const pendingBlock = pendingTotal === 0 ? `<p class="muted">\u6682\u65E0\u5F85\u5904\u7406</p>` : requestsHtml + toolsHtml + inputsHtml + proposalHtml + reviewHtml;
  const taskRows = tasks.map((t) => {
    const startBtn = t.canStartAgent ? `<button type="button" class="btn btn-primary" data-act-start="${escapeHtml(t.path)}">\u542F\u52A8</button>` : "";
    const interruptBtn = t.canInterrupt ? `<button type="button" class="btn btn-ghost" data-act-interrupt="${escapeHtml(t.path)}">\u4E2D\u65AD</button>` : "";
    const cancelBtn = t.canCancel ? `<button type="button" class="btn btn-ghost" data-act-cancel="${escapeHtml(t.path)}">\u53D6\u6D88</button>` : "";
    return `<li class="task-item">
        <div class="task-head"><strong>${escapeHtml(t.roleId || t.sessionConnectionId || t.sessionId || "Session")}</strong>
          <span class="muted">${escapeHtml(taskStateLabel(t.state))}</span></div>
        ${t.prompt ? `<div class="task-summary">${escapeHtml(t.prompt.length > 100 ? t.prompt.slice(0, 97) + "\u2026" : t.prompt)}</div>` : ""}
        <div class="task-actions">${startBtn}${interruptBtn}${cancelBtn}</div>
        <div class="faint" title="${escapeHtml(t.path)}">${escapeHtml(t.path)}</div>
      </li>`;
  }).join("");
  const sessionRows = liveSessions.length ? liveSessions.map(
    (s) => `<li class="session-row">
          <span class="session-dot ${s.alive ? "is-live" : ""}" aria-hidden="true"></span>
          <span>${escapeHtml(s.roleId || s.connectionId || s.sessionId)}</span>
          <span class="muted">${escapeHtml(sessionStateLabel(s.state) || s.state)}</span>
        </li>`
  ).join("") : `<li class="muted">\u65E0\u6D3B\u8DC3\u4F1A\u8BDD</li>`;
  hostEl.innerHTML = `
    <div class="activity-layout">
      <section class="activity-col">
        <div class="surface-section-head">\u5F85\u6211\u5904\u7406 <span class="count-badge"${pendingTotal ? "" : " hidden"}>${pendingTotal}</span></div>
        <div class="activity-stack">${pendingBlock}</div>
      </section>
      <section class="activity-col">
        <div class="surface-section-head">\u4EFB\u52A1</div>
        <ul class="task-list activity-task-list">${taskRows || `<li class="muted">\u65E0\u8FDB\u884C\u4E2D\u4EFB\u52A1</li>`}</ul>
        <div class="surface-section-head">\u4F1A\u8BDD</div>
        <ul class="activity-session-list">${sessionRows}</ul>
      </section>
    </div>`;
  wireActivity(hostEl);
}
function wireActivity(root) {
  root.querySelectorAll("[data-act-respond]").forEach((btn) => {
    btn.addEventListener("click", () => void onRespond(btn.getAttribute("data-act-respond")));
  });
  root.querySelectorAll("[data-act-decision-deny]").forEach((btn) => {
    btn.addEventListener("click", () => void onDenyDecision2(btn.getAttribute("data-act-decision-deny")));
  });
  root.querySelectorAll("[data-act-tool-allow]").forEach((btn) => {
    btn.addEventListener("click", () => void onTool(btn.getAttribute("data-act-tool-allow"), true));
  });
  root.querySelectorAll("[data-act-tool-deny]").forEach((btn) => {
    btn.addEventListener("click", () => void onTool(btn.getAttribute("data-act-tool-deny"), false));
  });
  root.querySelectorAll("[data-act-proposal-accept]").forEach((btn) => {
    btn.addEventListener(
      "click",
      () => void onProposal(btn.getAttribute("data-act-proposal-accept"), "accept")
    );
  });
  root.querySelectorAll("[data-act-proposal-reject]").forEach((btn) => {
    btn.addEventListener(
      "click",
      () => void onProposal(btn.getAttribute("data-act-proposal-reject"), "reject")
    );
  });
  root.querySelectorAll("[data-act-accept]").forEach((btn) => {
    btn.addEventListener(
      "click",
      () => void onAccept2(
        btn.getAttribute("data-act-accept"),
        btn.getAttribute("data-act-delivery")
      )
    );
  });
  root.querySelectorAll("[data-act-reject-toggle]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const path = btn.getAttribute("data-act-reject-toggle");
      const panel = root.querySelector(`[data-act-reject-panel="${CSS.escape(path)}"]`);
      if (!(panel instanceof HTMLElement)) return;
      const open = panel.hasAttribute("hidden");
      if (open) panel.removeAttribute("hidden");
      else panel.setAttribute("hidden", "");
    });
  });
  root.querySelectorAll("[data-act-reject-reason]").forEach((input) => {
    input.addEventListener("input", () => {
      rejectDrafts.set(input.getAttribute("data-act-reject-reason"), input.value);
    });
  });
  root.querySelectorAll("[data-act-reject]").forEach((btn) => {
    btn.addEventListener(
      "click",
      () => void onReject2(
        btn.getAttribute("data-act-reject"),
        btn.getAttribute("data-act-delivery")
      )
    );
  });
  root.querySelectorAll("[data-act-start]").forEach((btn) => {
    btn.addEventListener("click", () => void onStart(btn.getAttribute("data-act-start")));
  });
  root.querySelectorAll("[data-act-interrupt]").forEach((btn) => {
    btn.addEventListener("click", () => void onInterrupt2(btn.getAttribute("data-act-interrupt")));
  });
  root.querySelectorAll("[data-act-cancel]").forEach((btn) => {
    btn.addEventListener("click", () => void onCancel(btn.getAttribute("data-act-cancel")));
  });
}
async function refreshAfter() {
  await Promise.all([reloadPendingInteractions(), reloadTasks(), reloadTree()]);
  renderActivity();
}
async function onRespond(requestId) {
  if (!workspaceId) return;
  const item = el.activityHost?.querySelector(`[data-act-decision="${CSS.escape(requestId)}"]`);
  const taskPath = item?.getAttribute("data-task-path") || "";
  const answer = item?.querySelector("[data-act-answer]")?.value.trim() || "";
  const optionId = item?.querySelector("input[type=radio]:checked")?.value || "";
  const built = buildDecisionResponsePayload(workspaceId, taskPath, requestId, {
    text: answer,
    optionId
  });
  if (!built.ok) {
    el.status.textContent = built.reason;
    return;
  }
  try {
    await window.tentDesktop.rpc("decisionRequest.respond", built.payload);
    el.status.textContent = "\u5DF2\u63D0\u4EA4\u51B3\u5B9A\u3002";
    await refreshAfter();
  } catch (err) {
    setError(err);
  }
}
async function onDenyDecision2(requestId) {
  if (!workspaceId) return;
  const item = el.activityHost?.querySelector(`[data-act-decision="${CSS.escape(requestId)}"]`);
  const taskPath = item?.getAttribute("data-task-path") || "";
  try {
    await window.tentDesktop.rpc(
      "decisionRequest.respond",
      buildDecisionDenyPayload(workspaceId, taskPath, requestId)
    );
    el.status.textContent = "\u5DF2\u62D2\u7EDD\u8BE5\u8BF7\u6C42\u3002";
    await refreshAfter();
  } catch (err) {
    setError(err);
  }
}
async function onProposal(path, decision) {
  if (!workspaceId) return;
  try {
    await window.tentDesktop.rpc("proposal.resolve", {
      workspaceId,
      path,
      decision,
      actor: "user"
    });
    el.status.textContent = decision === "accept" ? "\u5DF2\u91C7\u7EB3\u63D0\u6848\u3002" : "\u5DF2\u9A73\u56DE\u63D0\u6848\u3002";
    await refreshAfter();
  } catch (err) {
    setError(err);
  }
}
async function onTool(id, allow) {
  try {
    const built = buildToolApprovalResolvePayload(id, allow, "user");
    await window.tentDesktop.rpc(built.method, built.params);
    el.status.textContent = allow ? "\u5DF2\u5141\u8BB8\u672C\u6B21\u5DE5\u5177\u8C03\u7528\u3002" : "\u5DF2\u62D2\u7EDD\u5DE5\u5177\u8C03\u7528\u3002";
    await refreshAfter();
  } catch (err) {
    setError(err);
  }
}
async function onAccept2(taskPath, deliveryId) {
  if (!workspaceId) return;
  const payload = buildAcceptPayload(taskPath, deliveryId, "user");
  try {
    await window.tentDesktop.rpc("task.accept", {
      workspaceId,
      taskPath: payload.taskPath,
      deliveryId: payload.deliveryId,
      actor: payload.actor
    });
    el.status.textContent = `\u5DF2\u786E\u8BA4\u4EA4\u4ED8\uFF1A${taskPath}`;
    await refreshAfter();
  } catch (err) {
    setError(err);
  }
}
async function onReject2(taskPath, deliveryId) {
  if (!workspaceId) return;
  const reason = rejectDrafts.get(taskPath) || "";
  const built = buildRejectPayload(taskPath, deliveryId, reason, "user");
  if (!built.ok) {
    el.status.textContent = built.reason;
    return;
  }
  try {
    await window.tentDesktop.rpc("task.reject", {
      workspaceId,
      taskPath: built.payload.taskPath,
      deliveryId: built.payload.deliveryId,
      actor: built.payload.actor,
      note: built.payload.note,
      resume: built.payload.resume
    });
    rejectDrafts.delete(taskPath);
    el.status.textContent = `\u5DF2\u9A73\u56DE\uFF1A${taskPath}`;
    await refreshAfter();
  } catch (err) {
    setError(err);
  }
}
async function onStart(taskPath) {
  if (!workspaceId) return;
  const built = buildStartSessionPayload(taskPath);
  if (!built.ok) {
    el.status.textContent = built.reason;
    return;
  }
  try {
    await window.tentDesktop.rpc("task.startSession", {
      workspaceId,
      taskPath: built.payload.taskPath,
      callerKind: built.payload.callerKind
    });
    el.status.textContent = `\u5DF2\u542F\u52A8 agent \xB7 ${taskPath}`;
    await refreshAfter();
  } catch (err) {
    setError(err);
  }
}
async function onInterrupt2(taskPath) {
  if (!workspaceId) return;
  try {
    await window.tentDesktop.rpc("task.interrupt", { workspaceId, taskPath });
    el.status.textContent = `\u5DF2\u4E2D\u65AD\uFF1A${taskPath}`;
    await refreshAfter();
  } catch (err) {
    setError(err);
  }
}
async function onCancel(taskPath) {
  if (!workspaceId) return;
  if (!window.confirm("\u53D6\u6D88\u8BE5\u4EFB\u52A1\uFF1F\u672A\u4EA4\u4ED8\u7684\u8FDB\u5EA6\u5C06\u7EC8\u6B62\u3002")) return;
  try {
    await window.tentDesktop.rpc("task.cancel", { workspaceId, taskPath });
    el.status.textContent = `\u5DF2\u53D6\u6D88\uFF1A${taskPath}`;
    await refreshAfter();
  } catch (err) {
    setError(err);
  }
}

// src/desktop/workbench/settings-model.ts
var ACCEPT_MODE_OPTIONS = [
  { value: "review-required", label: "Review required" },
  { value: "auto-accept", label: "Auto accept" },
  { value: "agent-decide", label: "Agent Decide" }
];
function mapProviderCatalogRows(providers2) {
  return (providers2 || []).map((p) => ({
    adapterId: p.adapterId,
    verificationLevel: p.verificationLevel,
    levelLabel: verificationLevelLabel(p.verificationLevel),
    canResume: p.canResume,
    notes: p.notes
  }));
}
function validateRoleCreate(draft) {
  const name = (draft.name || "").trim();
  if (!name) return { ok: false, reason: "\u89D2\u8272\u540D\u4E0D\u80FD\u4E3A\u7A7A" };
  if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(name)) {
    return { ok: false, reason: "\u89D2\u8272\u540D\u9700\u4EE5\u5B57\u6BCD\u5F00\u5934\uFF0C\u4EC5\u542B\u5B57\u6BCD\u6570\u5B57 _ -" };
  }
  const payload = {
    name,
    actor: "user"
  };
  if (draft.displayName?.trim()) payload.displayName = draft.displayName.trim();
  if (draft.prompt?.trim()) payload.prompt = draft.prompt.trim();
  if (draft.description?.trim()) payload.description = draft.description.trim();
  if (draft.color?.trim()) payload.color = draft.color.trim();
  return { ok: true, payload };
}
function validateRoleUpdate(draft) {
  const name = (draft.name || "").trim();
  if (!name) return { ok: false, reason: "\u89D2\u8272\u8FD0\u8425\u952E\u4E0D\u80FD\u4E3A\u7A7A" };
  if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(name)) {
    return { ok: false, reason: "\u89D2\u8272\u8FD0\u8425\u952E\u65E0\u6548" };
  }
  const payload = {
    name,
    actor: "user"
  };
  if (draft.roleId?.trim()) payload.roleId = draft.roleId.trim();
  const dn = (draft.displayName ?? "").trim();
  payload.displayName = dn || null;
  const prompt = (draft.prompt ?? "").trim();
  payload.prompt = prompt || null;
  const description = (draft.description ?? "").trim();
  payload.description = description || null;
  const color = (draft.color ?? "").trim();
  payload.color = color || null;
  return { ok: true, payload };
}
function validateConnectionCreate(draft) {
  const connectionId = (draft.connectionId || "").trim();
  const provider = (draft.provider || "").trim();
  const adapterId = (draft.adapterId || "").trim();
  if (!connectionId) return { ok: false, reason: "connectionId \u4E0D\u80FD\u4E3A\u7A7A" };
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(connectionId)) {
    return { ok: false, reason: "connectionId \u987B\u5339\u914D a-z \u5F00\u5934\u7684\u5C0F\u5199 id" };
  }
  if (!provider) return { ok: false, reason: "provider \u4E0D\u80FD\u4E3A\u7A7A" };
  if (!adapterId) return { ok: false, reason: "adapterId \u4E0D\u80FD\u4E3A\u7A7A" };
  const payload = { connectionId, provider, adapterId };
  if (draft.displayName?.trim()) payload.displayName = draft.displayName.trim();
  if (draft.model?.trim()) payload.model = draft.model.trim();
  if (draft.executable?.trim()) payload.executable = draft.executable.trim();
  if (draft.envKey?.trim()) payload.envKey = draft.envKey.trim();
  if (draft.launchSecretRef?.trim()) payload.launchSecretRef = draft.launchSecretRef.trim();
  if (draft.baseUrlEnvKey?.trim()) payload.baseUrlEnvKey = draft.baseUrlEnvKey.trim();
  if (draft.baseUrl?.trim()) payload.baseUrl = draft.baseUrl.trim();
  if (draft.permissionPolicy) payload.permissionPolicy = draft.permissionPolicy;
  return { ok: true, payload };
}
function validateConnectionUpdate(draft) {
  const connectionId = (draft.connectionId || "").trim();
  if (!connectionId) return { ok: false, reason: "connectionId \u4E0D\u80FD\u4E3A\u7A7A" };
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(connectionId)) {
    return { ok: false, reason: "connectionId \u987B\u5339\u914D a-z \u5F00\u5934\u7684\u5C0F\u5199 id" };
  }
  const payload = { connectionId };
  const dn = (draft.displayName ?? "").trim();
  payload.displayName = dn || null;
  if (draft.model !== void 0) {
    payload.model = (draft.model ?? "").trim() || null;
  }
  if (draft.executable !== void 0) {
    payload.executable = (draft.executable ?? "").trim() || null;
  }
  if (draft.envKey !== void 0) {
    payload.envKey = (draft.envKey ?? "").trim() || null;
  }
  if (draft.launchSecretRef !== void 0) {
    payload.launchSecretRef = (draft.launchSecretRef ?? "").trim() || null;
  }
  if (draft.baseUrlEnvKey !== void 0) {
    payload.baseUrlEnvKey = (draft.baseUrlEnvKey ?? "").trim() || null;
  }
  if (draft.baseUrl !== void 0) {
    payload.baseUrl = (draft.baseUrl ?? "").trim() || null;
  }
  if (draft.permissionPolicy) {
    payload.permissionPolicy = draft.permissionPolicy;
  }
  return { ok: true, payload };
}
function connectionDisplayLabel(connection) {
  const dn = (connection.displayName || "").trim();
  return dn || connection.connectionId;
}
var CONNECTION_NEXT_SESSION_TIP = "\u672C\u673A\u542F\u52A8\u914D\u7F6E \xB7 Session \u4F7F\u7528\u5FEB\u7167 \xB7 \u6539\u52A8\u4E0B\u6B21\u4F1A\u8BDD\u751F\u6548";
var CONNECTION_SKILLS_METADATA_TIP = "Skill \u4EC5 name/path \u5143\u6570\u636E\uFF08_meta.tent.skills\uFF09\xB7 \u662F\u5426\u751F\u6548\u53D6\u51B3\u4E8E provider \xB7 \u4E0D\u5BA3\u79F0\u5DF2\u6FC0\u6D3B";
var LAUNCH_SECRET_STORE_TYPE = "secret";
function validateLaunchSecretSet(draft) {
  const id = (draft.id || "").trim();
  if (!id) return { ok: false, reason: "\u542F\u52A8 Secret id \u4E0D\u80FD\u4E3A\u7A7A" };
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(id)) {
    return { ok: false, reason: "\u542F\u52A8 Secret id \u987B\u5339\u914D a-z \u5F00\u5934\u7684\u5C0F\u5199 id" };
  }
  if (!draft.secret || draft.secret.length === 0) {
    return { ok: false, reason: "secret \u4E0D\u80FD\u4E3A\u7A7A" };
  }
  const payload = {
    id,
    secret: draft.secret
  };
  if (draft.label?.trim()) payload.label = draft.label.trim();
  return { ok: true, payload };
}
function launchSecretListRow(c) {
  const label = (c.label || c.metadata?.label || "").trim() || void 0;
  return {
    id: c.id,
    type: LAUNCH_SECRET_STORE_TYPE,
    status: "\u5DF2\u914D\u7F6E",
    ...label ? { label } : {},
    ...c.updatedAt ? { updatedAt: c.updatedAt } : {}
  };
}
function skillDraftsFromProjection(skills2) {
  if (!skills2?.length) return [];
  return skills2.map((s) => ({
    name: s.name,
    ...s.path ? { path: s.path } : {},
    enabled: s.enabled !== false
  }));
}
function mcpDraftsFromProjection(servers) {
  if (!servers?.length) return [];
  return servers.map((s) => ({
    name: s.name,
    transport: s.transport,
    enabled: s.enabled !== false,
    ...s.command !== void 0 ? { command: s.command } : {},
    ...s.args !== void 0 ? { args: [...s.args] } : {},
    ...s.envKeys !== void 0 ? { envKeys: { ...s.envKeys } } : {},
    ...s.envSecretRefs !== void 0 ? { envSecretRefs: { ...s.envSecretRefs } } : {},
    ...s.url !== void 0 ? { url: s.url } : {},
    ...s.headerEnvKeys !== void 0 ? { headerEnvKeys: { ...s.headerEnvKeys } } : {},
    ...s.headerSecretRefs !== void 0 ? { headerSecretRefs: { ...s.headerSecretRefs } } : {}
  }));
}
function setSkillEnabled(drafts, name, enabled) {
  return drafts.map((d) => d.name === name ? { ...d, enabled } : d);
}
function setMcpEnabled(drafts, name, enabled) {
  return drafts.map((d) => d.name === name ? { ...d, enabled } : d);
}
function removeSkillDraft(drafts, name) {
  return drafts.filter((d) => d.name !== name);
}
function removeMcpDraft(drafts, name) {
  return drafts.filter((d) => d.name !== name);
}
function buildSkillsPayload(drafts) {
  return drafts.map((d) => {
    const row = {
      name: d.name
    };
    if (d.path?.trim()) row.path = d.path.trim();
    if (d.enabled === false) row.enabled = false;
    else if (d.enabled === true) row.enabled = true;
    return row;
  });
}
function buildMcpServersPayload(drafts) {
  return drafts.map((d) => {
    const row = {
      name: d.name,
      transport: d.transport,
      enabled: d.enabled !== false
    };
    if (d.transport === "stdio") {
      if (d.command?.trim()) row.command = d.command.trim();
      if (d.args?.length) row.args = [...d.args];
      if (d.envKeys && Object.keys(d.envKeys).length) row.envKeys = { ...d.envKeys };
      if (d.envSecretRefs && Object.keys(d.envSecretRefs).length) {
        row.envSecretRefs = { ...d.envSecretRefs };
      }
    } else {
      if (d.url?.trim()) row.url = d.url.trim();
      if (d.headerEnvKeys && Object.keys(d.headerEnvKeys).length) {
        row.headerEnvKeys = { ...d.headerEnvKeys };
      }
      if (d.headerSecretRefs && Object.keys(d.headerSecretRefs).length) {
        row.headerSecretRefs = { ...d.headerSecretRefs };
      }
    }
    delete row.env;
    delete row.headers;
    delete row.secret;
    delete row.token;
    delete row.apiKey;
    delete row.displayName;
    return row;
  });
}
function skillSourceLine(s) {
  const p = (s.path || "").trim();
  return p ? p : "name-only\uFF08\u65E0 path\uFF09";
}
function mcpSourceLine(s) {
  if (s.transport === "http") {
    const url = (s.url || "").trim();
    return url ? `http \xB7 ${url}` : "http";
  }
  const cmd = (s.command || "").trim();
  const args = (s.args || []).join(" ").trim();
  if (cmd && args) return `stdio \xB7 ${cmd} ${args}`;
  if (cmd) return `stdio \xB7 ${cmd}`;
  return "stdio";
}
function mcpLaunchSecretStatusParts(s, configuredIds) {
  const set = configuredIds instanceof Set ? configuredIds : new Set(
    Array.from(configuredIds).filter(
      (x) => typeof x === "string" && x.length > 0
    )
  );
  const out = [];
  const pushMap = (map) => {
    if (!map) return;
    for (const [envName, refId] of Object.entries(map)) {
      const id = (refId || "").trim();
      if (!id) continue;
      out.push({ envName, refId: id, configured: set.has(id) });
    }
  };
  pushMap(s.envSecretRefs);
  pushMap(s.headerSecretRefs);
  return out;
}
function mcpLaunchSecretStatusLine(s, configuredIds) {
  const parts = mcpLaunchSecretStatusParts(s, configuredIds);
  if (!parts.length) return "";
  return parts.map((p) => `${p.refId}${p.configured ? "\xB7\u5DF2\u914D\u7F6E" : "\xB7\u7F3A\u5931"}`).join(" ");
}
function validateSkillAddDraft(draft) {
  const name = (draft.name || "").trim();
  if (!name) return { ok: false, reason: "skill name \u4E0D\u80FD\u4E3A\u7A7A" };
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name) || name.includes("..")) {
    return { ok: false, reason: "skill name \u65E0\u6548" };
  }
  const path = (draft.path || "").trim();
  const entry = {
    name,
    enabled: draft.enabled !== false,
    ...path ? { path } : {}
  };
  return { ok: true, entry };
}
function validateMcpAddDraft(draft) {
  const name = (draft.name || "").trim();
  if (!name) return { ok: false, reason: "MCP name \u4E0D\u80FD\u4E3A\u7A7A" };
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)) {
    return { ok: false, reason: "MCP name \u65E0\u6548" };
  }
  if (draft.transport !== "stdio" && draft.transport !== "http") {
    return { ok: false, reason: "transport \u987B\u4E3A stdio \u6216 http" };
  }
  const entry = {
    name,
    transport: draft.transport,
    enabled: draft.enabled !== false
  };
  if (draft.transport === "stdio") {
    const command = (draft.command || "").trim();
    if (!command) return { ok: false, reason: "stdio \u9700\u8981 command" };
    entry.command = command;
  } else {
    const url = (draft.url || "").trim();
    if (!url) return { ok: false, reason: "http \u9700\u8981 url" };
    entry.url = url;
  }
  const envName = (draft.envSecretName || "").trim();
  const envRef = (draft.envLaunchSecretRef || "").trim();
  if (envName || envRef) {
    if (!envName || !envRef) {
      return { ok: false, reason: "\u542F\u52A8 Secret \u9700\u540C\u65F6\u586B env/header \u540D\u4E0E ref id" };
    }
    if (!/^[a-z][a-z0-9-]{0,62}$/.test(envRef)) {
      return { ok: false, reason: "launchSecretRef \u987B\u4E3A\u6709\u6548\u542F\u52A8 Secret id" };
    }
    if (draft.transport === "stdio") {
      entry.envSecretRefs = { [envName]: envRef };
    } else {
      entry.headerSecretRefs = { [envName]: envRef };
    }
  }
  return { ok: true, entry };
}
function retentionSummaryLine(preview) {
  const tasks = preview.candidateTaskCount ?? 0;
  const deliveries2 = preview.candidateDeliveryCount ?? 0;
  const days = preview.keepTerminalTasksDays ?? 30;
  const warn = preview.warnings?.length ? ` \xB7 ${preview.warnings.length} \u8B66\u544A` : "";
  return `\u4FDD\u7559 ${days} \u5929 \xB7 \u53EF\u6E05\u7406 ${tasks} \u4EFB\u52A1 / ${deliveries2} \u4EA4\u4ED8${warn}`;
}

// src/desktop/renderer/main/contract-gaps.ts
var DESKTOP_CONTRACT_GAPS = [
  {
    id: "node.permanent-delete",
    methods: ["docs.delete", "docs.purge"],
    need: "Permanent delete of a Node (beyond archive mode).",
    fallback: "docs.setMode archived only; no permanent delete control."
  },
  {
    id: "graph.bulk",
    methods: ["graph.snapshot", "docs.graph"],
    need: "Workspace-wide node/edge projection for a full graph canvas.",
    fallback: "Local projection: docs.list tree + docs.backlinks + docs.readForEdit body out-links for the selected node only."
  },
  {
    id: "mcp.global-config",
    methods: ["mcp.list", "mcp.install"],
    need: "Machine-global MCP server catalog independent of Agent Connections.",
    fallback: "MCP is edited only as route.mcpServers (next session); skill.list/install covers bundled skills only."
  },
  {
    id: "session.logs-reload",
    methods: ["session.logs", "session.transcript"],
    need: "Reloadable session log / transcript for past agent turns.",
    fallback: "session.list / session.get show state + alive only; no transcript surface."
  },
  {
    id: "taskInput.global-list",
    methods: ["taskInput.listPendingWorkspace"],
    need: "Workspace-scoped pending TaskInput list without per-taskPath fan-out.",
    fallback: "Desktop fans out taskInput.listPending over known task paths from task.list / other pending rows."
  },
  {
    id: "toolApproval.params",
    methods: ["toolApproval.paramsProjection"],
    need: "Tool call argument / params summary on toolApproval projection (beyond options[]).",
    fallback: "UI shows toolTitle + options name/kind summary only; never invents args."
  }
  // type-tag-mutation closed: Service now exposes registry.type.create/delete,
  // registry.tags / registry.tag.create/delete, docs.setType / docs.tags.set /
  // docs.tag.add / docs.tag.remove. Desktop UI wiring is out of this batch.
];

// src/desktop/renderer/main/settings.ts
var SECTIONS = [
  { id: "workspace", label: "\u5DE5\u4F5C\u533A" },
  { id: "roles", label: "\u89D2\u8272" },
  { id: "routes", label: "Connections" },
  { id: "skills", label: "Skills / MCP" },
  { id: "maintenance", label: "\u7EF4\u62A4" }
];
var section = "workspace";
var providers = [];
var launchSecrets = [];
var skills = [];
var fullRoles = [];
var fullRoutes = [];
var settingsAcceptMode = "review-required";
var agentsContent = "";
var agentsEtag = "";
var agentsExists = false;
var retentionPreview = null;
var loadError2 = null;
var loading = false;
var routeEditId = null;
var skillDrafts = [];
var mcpDrafts = [];
var routeFieldDraft = null;
var roleEditName = null;
function openRouteEditor(id) {
  routeEditId = id;
  routeFieldDraft = null;
  if (!id) {
    skillDrafts = [];
    mcpDrafts = [];
    return;
  }
  const route = fullRoutes.find((item) => item.connectionId === id);
  skillDrafts = skillDraftsFromProjection(route?.skills);
  mcpDrafts = mcpDraftsFromProjection(route?.mcpServers);
}
function captureRouteFieldDraft() {
  if (!routeEditId) return;
  routeFieldDraft = {
    displayName: document.getElementById("route-edit-name")?.value ?? "",
    model: document.getElementById("route-edit-model")?.value ?? "",
    executable: document.getElementById("route-edit-exe")?.value ?? "",
    envKey: document.getElementById("route-edit-env")?.value ?? "",
    launchSecretRef: document.getElementById("route-edit-launch-secret")?.value ?? "",
    baseUrl: document.getElementById("route-edit-base")?.value ?? ""
  };
}
function configuredLaunchSecretIds() {
  return new Set(launchSecrets.map((c) => c.id));
}
function setSettingsSection(next) {
  section = next;
  renderSettings();
  void loadSectionData(next);
}
async function reloadSettings() {
  loading = true;
  loadError2 = null;
  renderSettings();
  try {
    await Promise.all([
      loadProviders(),
      loadLaunchSecrets(),
      loadSkills(),
      workspaceId ? loadWorkspaceSettings() : Promise.resolve(),
      workspaceId ? loadRolesFull() : Promise.resolve(),
      loadRoutesFull()
    ]);
    loading = false;
    renderSettings();
    await loadSectionData(section);
  } catch (err) {
    loading = false;
    loadError2 = err instanceof Error ? err.message : String(err);
    renderSettings();
  }
}
async function loadSectionData(s) {
  try {
    if (s === "workspace" && workspaceId) {
      await Promise.all([loadWorkspaceSettings(), loadAgents()]);
    } else if (s === "roles" && workspaceId) {
      await loadRolesFull();
    } else if (s === "routes") {
      await Promise.all([loadRoutesFull(), loadProviders(), loadLaunchSecrets()]);
    } else if (s === "skills") {
      await Promise.all([loadSkills(), loadRoutesFull(), loadLaunchSecrets()]);
    } else if (s === "maintenance" && workspaceId) {
      await loadRetentionPreview();
    }
    renderSettings();
  } catch (err) {
    setError(err);
  }
}
async function loadProviders() {
  const result = await window.tentDesktop.rpc("provider.catalog", {});
  providers = mapProviderCatalogRows(result.providers || []);
}
async function loadLaunchSecrets() {
  const result = await window.tentDesktop.rpc("settings.launchSecret.list", {});
  launchSecrets = result.launchSecrets || [];
}
async function loadSkills() {
  const result = await window.tentDesktop.rpc("skill.list", {});
  skills = result.skills || [];
}
async function loadWorkspaceSettings() {
  if (!workspaceId) return;
  const result = await window.tentDesktop.rpc("workspace.settings", {
    workspaceId
  });
  settingsAcceptMode = result.settings?.defaultAcceptMode || "review-required";
}
async function loadAgents() {
  if (!workspaceId) return;
  const result = await window.tentDesktop.rpc("workspace.agents", {
    workspaceId
  });
  agentsContent = result.content ?? "";
  agentsEtag = result.etag ?? "";
  agentsExists = result.exists === true;
}
async function loadRolesFull() {
  if (!workspaceId) return;
  const result = await window.tentDesktop.rpc("registry.roles", {
    workspaceId
  });
  fullRoles = result.roles || [];
  setRoles(
    fullRoles.map((r) => ({
      roleId: r.roleId,
      name: r.name,
      description: r.displayName || r.description
    }))
  );
}
async function loadRoutesFull() {
  const result = await window.tentDesktop.rpc("connection.list", {});
  fullRoutes = result.connections || [];
  await reloadConnections();
}
async function loadRetentionPreview() {
  if (!workspaceId) return;
  retentionPreview = await window.tentDesktop.rpc("operationalRetention.preview", {
    workspaceId,
    actor: "user"
  });
}
function renderSettings() {
  const hostEl = el.settingsHost;
  if (!hostEl) return;
  const nav = SECTIONS.map((s) => {
    const active = s.id === section ? " is-active" : "";
    return `<button type="button" class="settings-nav-item${active}" data-settings-nav="${s.id}">${escapeHtml(s.label)}</button>`;
  }).join("");
  let body = "";
  if (loading && !providers.length && !fullRoutes.length) {
    body = `<p class="muted">\u52A0\u8F7D\u4E2D\u2026</p>`;
  } else if (loadError2) {
    body = `<p class="muted">${escapeHtml(loadError2)}</p>`;
  } else {
    body = renderSectionBody(section);
  }
  hostEl.innerHTML = `
    <div class="settings-layout">
      <nav class="settings-nav" aria-label="\u8BBE\u7F6E\u5206\u533A">${nav}</nav>
      <div class="settings-body" id="settings-body">${body}</div>
    </div>`;
  hostEl.querySelectorAll("[data-settings-nav]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-settings-nav");
      if (id) setSettingsSection(id);
    });
  });
  wireSection(section, hostEl);
}
function renderSectionBody(s) {
  switch (s) {
    case "workspace":
      return renderWorkspace();
    case "roles":
      return renderRoles();
    case "routes":
      return renderRoutes();
    case "skills":
      return renderSkills();
    case "maintenance":
      return renderMaintenance();
    default:
      return "";
  }
}
function renderWorkspace() {
  if (!workspaceId) {
    return `<div class="empty"><p class="empty-title">\u6253\u5F00\u5DE5\u4F5C\u533A</p></div>`;
  }
  const opts = ACCEPT_MODE_OPTIONS.map(
    (o) => `<option value="${o.value}"${o.value === settingsAcceptMode ? " selected" : ""}>${escapeHtml(o.label)}</option>`
  ).join("");
  return `
    <div class="settings-block">
      <div class="surface-section-head">\u4EA4\u4ED8\u7B56\u7565</div>
      <div class="settings-row">
        <select id="set-accept-mode" class="field">${opts}</select>
        <button type="button" id="btn-save-policy" class="btn btn-secondary">\u4FDD\u5B58</button>
      </div>
    </div>
    <div class="settings-block">
      <div class="surface-section-head">AGENTS.md ${agentsExists ? "" : `<span class="faint">\uFF08\u5C1A\u672A\u521B\u5EFA\uFF09</span>`}</div>
      <textarea id="set-agents" class="line-input settings-agents" rows="12" spellcheck="false">${escapeHtml(agentsContent)}</textarea>
      <div class="settings-row">
        <button type="button" id="btn-save-agents" class="btn btn-primary">\u4FDD\u5B58 AGENTS.md</button>
      </div>
    </div>`;
}
function renderRoles() {
  if (!workspaceId) {
    return `<div class="empty"><p class="empty-title">\u6253\u5F00\u5DE5\u4F5C\u533A</p></div>`;
  }
  const list2 = fullRoles.length === 0 ? `<p class="muted">\u6682\u65E0\u89D2\u8272</p>` : `<ul class="settings-list">${fullRoles.map((r) => {
    const label = r.displayName && r.displayName !== r.name ? `${r.displayName} \xB7 ${r.name}` : r.name;
    const editing2 = roleEditName === r.name;
    return `<li class="settings-list-item${editing2 ? " is-editing" : ""}">
              <div class="settings-list-main">
                <strong>${escapeHtml(label)}</strong>
                ${r.roleId ? `<span class="faint"><code>${escapeHtml(r.roleId)}</code></span>` : ""}
                ${r.description ? `<span class="muted">${escapeHtml(r.description)}</span>` : ""}
              </div>
              <div class="settings-list-actions">
                <button type="button" class="btn btn-ghost" data-role-edit="${escapeHtml(r.name)}" title="\u7F16\u8F91">\u7F16\u8F91</button>
                <button type="button" class="btn btn-ghost" data-role-delete="${escapeHtml(r.name)}" title="\u5220\u9664">\u5220\u9664</button>
              </div>
            </li>`;
  }).join("")}</ul>`;
  const editing = roleEditName ? fullRoles.find((r) => r.name === roleEditName) : null;
  const editor = editing ? renderRoleEditor(editing) : `<div class="settings-block">
      <div class="surface-section-head">\u65B0\u5EFA</div>
      <div class="settings-form">
        <input id="role-name" class="field" placeholder="name\uFF08\u8FD0\u8425\u952E\uFF0C\u521B\u5EFA\u540E\u4E0D\u53EF\u6539\uFF09" autocomplete="off" />
        <input id="role-display" class="field" placeholder="\u663E\u793A\u540D\uFF08\u53EF\u9009\uFF09" />
        <input id="role-description" class="field" placeholder="\u63CF\u8FF0\uFF08\u53EF\u9009\uFF09" />
        <textarea id="role-prompt" class="field settings-role-prompt" rows="3" placeholder="prompt\uFF08\u53EF\u9009\uFF09"></textarea>
        <input id="role-color" class="field" placeholder="\u989C\u8272 token\uFF08\u53EF\u9009\uFF0C\u5982 gray\uFF09" />
        <button type="button" id="btn-role-create" class="btn btn-primary">\u521B\u5EFA</button>
      </div>
    </div>`;
  return `
    <div class="settings-block">
      <div class="surface-section-head">\u89D2\u8272</div>
      <p class="muted">\u8FD0\u8425\u952E name \u4E0D\u53EF\u6539\uFF1B\u663E\u793A\u540D\u548C prompt \u7ECF registry.role.update\u3002</p>
      ${list2}
    </div>
    ${editor}`;
}
function renderRoleEditor(role) {
  return `
    <div class="settings-block">
      <div class="surface-section-head">\u7F16\u8F91\u89D2\u8272 \xB7 ${escapeHtml(role.name)}
        <button type="button" id="btn-role-edit-close" class="btn btn-ghost">\u5173\u95ED</button>
      </div>
      <p class="muted">id <code>${escapeHtml(role.roleId || "\u2014")}</code> \xB7 \u8FD0\u8425\u952E <code>${escapeHtml(role.name)}</code>\uFF08\u4E0D\u53EF\u6539\u540D\uFF09</p>
      <div class="settings-form">
        <label class="settings-label" for="role-edit-display">\u663E\u793A\u540D</label>
        <input id="role-edit-display" class="field" value="${escapeHtml(role.displayName || "")}" placeholder="\u7559\u7A7A\u5219\u56DE\u9000\u5230\u8FD0\u8425\u952E" />
        <label class="settings-label" for="role-edit-description">\u63CF\u8FF0</label>
        <input id="role-edit-description" class="field" value="${escapeHtml(role.description || "")}" />
        <label class="settings-label" for="role-edit-prompt">prompt</label>
        <textarea id="role-edit-prompt" class="field settings-role-prompt" rows="5">${escapeHtml(role.prompt || "")}</textarea>
        <label class="settings-label" for="role-edit-color">\u989C\u8272</label>
        <input id="role-edit-color" class="field" value="${escapeHtml(role.color || "")}" placeholder="gray / blue \u2026" />
        <div class="settings-row">
          <button type="button" id="btn-role-save" class="btn btn-primary">\u4FDD\u5B58</button>
        </div>
      </div>
    </div>`;
}
function renderRoutes() {
  const providerNote = providers.length === 0 ? `<p class="muted">provider.catalog \u4E0D\u53EF\u7528</p>` : `<ul class="settings-provider-list">${providers.map(
    (p) => `<li><code>${escapeHtml(p.adapterId)}</code>
              <span class="badge-level" data-level="${escapeHtml(String(p.verificationLevel))}">${escapeHtml(p.levelLabel)}</span>
              ${p.canResume ? `<span class="faint">resume</span>` : ""}
              ${p.notes ? `<span class="muted">${escapeHtml(p.notes)}</span>` : ""}</li>`
  ).join("")}</ul>`;
  const list2 = fullRoutes.length === 0 ? `<p class="muted">\u6682\u65E0 Connection</p>` : `<ul class="settings-list">${fullRoutes.map((route) => {
    const level = providers.find((x) => x.adapterId === route.adapterId);
    const levelBit = level ? `<span class="badge-level" data-level="${escapeHtml(String(level.verificationLevel))}">${escapeHtml(level.levelLabel)}</span>` : `<span class="faint">\u672A\u6536\u5F55 catalog</span>`;
    const secretStatus = route.launchSecretRef != null ? route.launchSecretExists ? `\u542F\u52A8 Secret \u5DF2\u914D\u7F6E` : `\u542F\u52A8 Secret \u7F3A\u5931` : "";
    const label = connectionDisplayLabel(route);
    return `<li class="settings-list-item">
              <div class="settings-list-main">
                <strong>${escapeHtml(label)}</strong>
                <span class="faint"><code>${escapeHtml(route.connectionId)}</code> \xB7 <code>${escapeHtml(route.adapterId)}</code></span>
                <span class="muted">${route.model ? escapeHtml(route.model) : ""}</span>
                ${levelBit}
                ${secretStatus ? `<span class="faint">${escapeHtml(secretStatus)}</span>` : ""}
              </div>
              <div class="settings-list-actions">
                <button type="button" class="btn btn-ghost" data-route-edit="${escapeHtml(route.connectionId)}">\u7F16\u8F91</button>
                <button type="button" class="btn btn-ghost" data-route-delete="${escapeHtml(route.connectionId)}">\u5220\u9664</button>
              </div>
            </li>`;
  }).join("")}</ul>`;
  const editing = routeEditId ? fullRoutes.find((route) => route.connectionId === routeEditId) : null;
  const editor = editing ? renderRouteEditor(editing) : `<div class="settings-block">
        <div class="surface-section-head">\u65B0\u5EFA Connection</div>
        <p class="muted">${escapeHtml(CONNECTION_NEXT_SESSION_TIP)}</p>
        <div class="settings-form">
          <label class="settings-label" for="route-id">connectionId\uFF08\u521B\u5EFA\u540E\u4E0D\u53EF\u6539\uFF09</label>
          <input id="route-id" class="field" placeholder="connectionId" autocomplete="off" />
          <label class="settings-label" for="route-provider">provider</label>
          <input id="route-provider" class="field" placeholder="provider" autocomplete="off" />
          <label class="settings-label" for="route-adapter">adapterId</label>
          <input id="route-adapter" class="field" placeholder="adapterId" list="adapter-list" autocomplete="off" />
          <datalist id="adapter-list">${providers.map((p) => `<option value="${escapeHtml(p.adapterId)}">`).join("")}</datalist>
          <label class="settings-label" for="route-name">\u663E\u793A\u540D</label>
          <input id="route-name" class="field" placeholder="displayName" />
          <input id="route-model" class="field" placeholder="model" />
          <input id="route-env" class="field" placeholder="envKey\uFF08\u73AF\u5883\u53D8\u91CF\u540D\uFF0C\u975E secret\uFF09" />
          <input id="route-launch-secret" class="field" placeholder="launchSecretRef\uFF08\u542F\u52A8 Secret id\uFF0C\u53EF\u9009\uFF09" />
          <button type="button" id="btn-route-create" class="btn btn-primary">\u521B\u5EFA</button>
        </div>
      </div>`;
  return `
    <div class="settings-block">
      <div class="surface-section-head">Provider \u9A8C\u8BC1\u7EA7\u522B</div>
      <p class="faint">\u6743\u5A01\u6765\u6E90 provider.catalog \xB7 \u5FE0\u5B9E\u533A\u5206 mock-tested / opt-in-live-probe / live-verified \xB7 \u300C\u6709\u811A\u672C\u300D\u2260 \u5168\u9762\u8BA4\u8BC1 \xB7 live-verified \u4EC5\u6307\u672C\u673A\u5DF2\u8BC1</p>
      ${providerNote}
    </div>
    <div class="settings-block">
      <div class="surface-section-head">Agent Connections</div>
      <p class="muted">${escapeHtml(CONNECTION_NEXT_SESSION_TIP)}</p>
      ${list2}
    </div>
    ${editor}
    ${renderLaunchSecretAdvanced()}`;
}
function renderRouteEditor(route) {
  const label = connectionDisplayLabel(route);
  const fields = routeFieldDraft ?? {
    displayName: route.displayName || "",
    model: route.model || "",
    executable: route.executable || "",
    envKey: route.envKey || "",
    launchSecretRef: route.launchSecretRef || "",
    baseUrl: route.baseUrl || ""
  };
  const launchSecretIds = configuredLaunchSecretIds();
  const skillList = skillDrafts.length === 0 ? `<p class="muted">\u65E0 skill \u5F15\u7528</p>` : `<ul class="settings-list">${skillDrafts.map((s) => {
    const src = skillSourceLine(s);
    return `<li class="settings-list-item">
              <div class="settings-list-main">
                <label class="settings-check">
                  <input type="checkbox" data-skill-toggle="${escapeHtml(s.name)}"${s.enabled ? " checked" : ""} />
                  <strong><code>${escapeHtml(s.name)}</code></strong>
                </label>
                <span class="muted">${escapeHtml(src)}</span>
              </div>
              <div class="settings-list-actions">
                <button type="button" class="btn btn-ghost" data-skill-remove="${escapeHtml(s.name)}" title="\u79FB\u9664\u5F15\u7528">\u79FB\u9664</button>
              </div>
            </li>`;
  }).join("")}</ul>`;
  const mcpList = mcpDrafts.length === 0 ? `<p class="muted">\u65E0 MCP \u670D\u52A1\u5668</p>` : `<ul class="settings-list">${mcpDrafts.map((m) => {
    const src = mcpSourceLine(m);
    const secretLine = mcpLaunchSecretStatusLine(m, launchSecretIds);
    return `<li class="settings-list-item">
              <div class="settings-list-main">
                <label class="settings-check">
                  <input type="checkbox" data-mcp-toggle="${escapeHtml(m.name)}"${m.enabled ? " checked" : ""} />
                  <strong><code>${escapeHtml(m.name)}</code></strong>
                </label>
                <span class="muted">${escapeHtml(src)}</span>
                ${secretLine ? `<span class="faint">\u542F\u52A8 Secret ${escapeHtml(secretLine)}</span>` : ""}
              </div>
              <div class="settings-list-actions">
                <button type="button" class="btn btn-ghost" data-mcp-remove="${escapeHtml(m.name)}" title="\u79FB\u9664">\u79FB\u9664</button>
              </div>
            </li>`;
  }).join("")}</ul>`;
  const launchSecretOptions = launchSecrets.map((c) => `<option value="${escapeHtml(c.id)}">`).join("");
  return `
    <div class="settings-block">
      <div class="surface-section-head">\u7F16\u8F91 \xB7 ${escapeHtml(label)}
        <button type="button" class="btn btn-ghost" id="btn-route-edit-close">\u5173\u95ED</button>
      </div>
      <p class="muted">connectionId <code>${escapeHtml(route.connectionId)}</code> \xB7 adapterId <code>${escapeHtml(route.adapterId)}</code></p>
      <p class="faint">${escapeHtml(CONNECTION_NEXT_SESSION_TIP)} \xB7 \u8FD0\u884C\u4E2D session \u4E0D\u70ED\u66F4\u65B0 \xB7 \u52FF\u5199 secret</p>
      <div class="settings-form">
        <label class="settings-label" for="route-edit-name">\u663E\u793A\u540D</label>
        <input id="route-edit-name" class="field" value="${escapeHtml(fields.displayName)}" placeholder="\u7559\u7A7A\u5219\u56DE\u9000\u5230 connectionId" />
        <label class="settings-label" for="route-edit-model">model</label>
        <input id="route-edit-model" class="field" value="${escapeHtml(fields.model)}" placeholder="model" />
        <label class="settings-label" for="route-edit-exe">executable</label>
        <input id="route-edit-exe" class="field" value="${escapeHtml(fields.executable)}" placeholder="executable" />
        <label class="settings-label" for="route-edit-env">envKey\uFF08\u73AF\u5883\u53D8\u91CF\u540D\uFF09</label>
        <input id="route-edit-env" class="field" value="${escapeHtml(fields.envKey)}" placeholder="envKey" />
        <label class="settings-label" for="route-edit-launch-secret">launchSecretRef\uFF08\u542F\u52A8 Secret id\uFF09</label>
        <input id="route-edit-launch-secret" class="field" value="${escapeHtml(fields.launchSecretRef)}" placeholder="launchSecretRef" list="launch-secret-ref-list" />
        <datalist id="launch-secret-ref-list">${launchSecretOptions}</datalist>
        <label class="settings-label" for="route-edit-base">baseUrl</label>
        <input id="route-edit-base" class="field" value="${escapeHtml(fields.baseUrl)}" placeholder="baseUrl" />
      </div>
    </div>
    <div class="settings-block">
      <div class="surface-section-head">Skills</div>
      <p class="faint">\u53EA\u4FDD\u5B58 name/path/enabled \xB7 \u4E0D\u5B58 displayName \xB7 ${escapeHtml(CONNECTION_SKILLS_METADATA_TIP)} \xB7 ${escapeHtml(CONNECTION_NEXT_SESSION_TIP)}</p>
      ${skillList}
      <div class="settings-form settings-form-inline">
        <input id="skill-add-name" class="field" placeholder="skill name\uFF08id\uFF09" autocomplete="off" list="bundled-skill-list" />
        <datalist id="bundled-skill-list">${skills.map((s) => `<option value="${escapeHtml(s.name)}">`).join("")}</datalist>
        <input id="skill-add-path" class="field" placeholder="\u7EDD\u5BF9 path\uFF08\u53EF\u9009\uFF09" autocomplete="off" />
        <button type="button" id="btn-skill-add" class="btn btn-secondary">\u6DFB\u52A0\u5F15\u7528</button>
      </div>
    </div>
    <div class="settings-block">
      <div class="surface-section-head">MCP Servers</div>
      <p class="faint">\u53EA\u4FDD\u5B58 id/ref \xB7 launchSecret \u4EC5\u663E\u793A\u5DF2\u914D\u7F6E \xB7 ${escapeHtml(CONNECTION_NEXT_SESSION_TIP)}</p>
      ${mcpList}
      <div class="settings-form">
        <div class="settings-form-inline">
          <input id="mcp-add-name" class="field" placeholder="name" autocomplete="off" />
          <select id="mcp-add-transport" class="field field-compact">
            <option value="stdio">stdio</option>
            <option value="http">http</option>
          </select>
        </div>
        <input id="mcp-add-command" class="field" placeholder="command\uFF08stdio\uFF09" autocomplete="off" />
        <input id="mcp-add-url" class="field" placeholder="url\uFF08http\uFF09" autocomplete="off" />
        <div class="settings-form-inline">
          <input id="mcp-add-env-name" class="field" placeholder="env/header \u540D\uFF08\u53EF\u9009\uFF09" autocomplete="off" />
          <input id="mcp-add-secret-ref" class="field" placeholder="\u542F\u52A8 Secret id\uFF08\u53EF\u9009\uFF09" list="launch-secret-ref-list" autocomplete="off" />
        </div>
        <button type="button" id="btn-mcp-add" class="btn btn-secondary">\u6DFB\u52A0 MCP</button>
      </div>
    </div>
    <div class="settings-block">
      <div class="settings-row">
        <button type="button" id="btn-route-save" class="btn btn-primary">\u4FDD\u5B58\uFF08\u4E0B\u6B21\u4F1A\u8BDD\u751F\u6548\uFF09</button>
      </div>
    </div>`;
}
function renderLaunchSecretAdvanced() {
  const list2 = launchSecrets.length === 0 ? `<p class="muted">\u65E0\u5DF2\u914D\u7F6E\u542F\u52A8 Secret</p>` : `<ul class="settings-list">${launchSecrets.map((c) => {
    const row = launchSecretListRow(c);
    return `<li class="settings-list-item">
              <div class="settings-list-main">
                <strong><code>${escapeHtml(row.id)}</code></strong>
                <span class="muted">${escapeHtml(row.type)} \xB7 ${escapeHtml(row.status)}</span>
                ${row.label ? `<span class="faint">${escapeHtml(row.label)}</span>` : ""}
                ${row.updatedAt ? `<span class="faint">${escapeHtml(row.updatedAt)}</span>` : ""}
              </div>
              <div class="settings-list-actions">
                <button type="button" class="btn btn-ghost" data-launch-secret-delete="${escapeHtml(row.id)}" title="\u5220\u9664\u542F\u52A8 Secret">\u5220\u9664</button>
              </div>
            </li>`;
  }).join("")}</ul>`;
  return `
    <div class="settings-block">
      <div class="surface-section-head">Advanced \xB7 \u542F\u52A8 Secret</div>
      <p class="faint">\u4EC5\u7528\u4E8E\u660E\u786E\u7684 Connection \u8FDB\u7A0B\u6CE8\u5165\u6216 MCP env/header\u3002Agent OAuth\u3001\u672C\u5730\u767B\u5F55\u548C\u8D26\u53F7\u751F\u547D\u5468\u671F\u4ECD\u7531 Agent \u81EA\u8EAB\u7BA1\u7406\uFF1BTent \u7EDD\u4E0D\u8BFB\u56DE\u660E\u6587\u3002</p>
      <p class="faint">ref id \xB7 ${escapeHtml(LAUNCH_SECRET_STORE_TYPE)} \xB7 \u5DF2\u914D\u7F6E</p>
      ${list2}
    </div>
    <div class="settings-block">
      <div class="surface-section-head">\u8BBE\u7F6E / \u66F4\u65B0\u542F\u52A8 Secret</div>
      <div class="settings-form">
        <input id="launch-secret-id" class="field" placeholder="\u542F\u52A8 Secret id" autocomplete="off" />
        <input id="launch-secret-label" class="field" placeholder="label\uFF08\u53EF\u9009\uFF0C\u975E secret\uFF09" autocomplete="off" />
        <input id="launch-secret-value" class="field" type="password" placeholder="\u542F\u52A8 Secret\uFF08\u63D0\u4EA4\u540E\u7ACB\u5373\u6E05\u7A7A\uFF09" autocomplete="new-password" />
        <button type="button" id="btn-launch-secret-set" class="btn btn-primary">\u4FDD\u5B58</button>
      </div>
    </div>`;
}
function renderSkills() {
  const skillList = skills.length === 0 ? `<p class="muted">\u65E0 bundled skills</p>` : `<ul class="settings-list">${skills.map((s) => {
    const targets = (s.targets || []).map((t) => `${t.target}${t.installed ? "\u2713" : "\xB7"}`).join(" ");
    return `<li class="settings-list-item">
              <div class="settings-list-main">
                <strong>${escapeHtml(s.name)}</strong>
                <span class="muted">${escapeHtml(targets)}</span>
              </div>
              <div class="settings-list-actions">
                <button type="button" class="btn btn-secondary" data-skill-install="${escapeHtml(s.name)}">\u5B89\u88C5</button>
              </div>
            </li>`;
  }).join("")}</ul>`;
  const credIds = configuredLaunchSecretIds();
  const mcpNote = `
    <p class="muted">MCP / Connection Skills \u5728 Connection \u7F16\u8F91\u5668\u4E2D\u7528\u5217\u8868 + \u542F\u7528\u5F00\u5173\u7BA1\u7406\u3002${escapeHtml(CONNECTION_NEXT_SESSION_TIP)}\u3002\u8FD0\u884C\u4E2D session \u4E0D\u70ED\u66F4\u65B0\u3002</p>
    <p class="faint">\u65E0\u5168\u5C40 mcp.* RPC \xB7 \u89C1\u5951\u7EA6\u7F3A\u53E3 mcp.global-config \xB7 \u4E0D\u4F2A\u9020\u5168\u5C40\u76EE\u5F55</p>
    <ul class="settings-list">${fullRoutes.map((route) => {
    const skillBits = (route.skills || []).map((s) => `${s.name}${s.enabled === false ? "\xB7\u5173" : "\xB7\u5F00"}`).join(" ");
    const mcpBits = (route.mcpServers || []).map((m) => {
      const cred = mcpLaunchSecretStatusLine(m, credIds);
      return `${m.name}${m.enabled === false ? "\xB7\u5173" : "\xB7\u5F00"}${cred ? `(${cred})` : ""}`;
    }).join(" ");
    return `<li class="settings-list-item">
          <div class="settings-list-main">
            <strong>${escapeHtml(connectionDisplayLabel(route))}</strong>
            <span class="faint"><code>${escapeHtml(route.connectionId)}</code></span>
            <span class="muted">skills ${escapeHtml(skillBits || "\u2014")}</span>
            <span class="muted">mcp ${escapeHtml(mcpBits || "\u2014")}</span>
          </div>
          <div class="settings-list-actions">
            <button type="button" class="btn btn-ghost" data-route-edit="${escapeHtml(route.connectionId)}">\u7F16\u8F91 Skills/MCP</button>
          </div>
        </li>`;
  }).join("") || `<li class="muted">\u65E0 Connection</li>`}</ul>`;
  return `
    <div class="settings-block">
      <div class="surface-section-head">Bundled Skills\uFF08skill.list / skill.install\uFF09</div>
      <p class="faint">\u4EC5\u5B89\u88C5 package bundled skills \u5230 ~/.agents \u4E0E ~/.claude \xB7 \u65E0 Skill \u7F16\u8F91\u5668 / \u8FDC\u7A0B\u5E02\u573A / uninstall</p>
      ${skillList}
      <div class="settings-row">
        <button type="button" id="btn-skill-install-all" class="btn btn-secondary">\u5B89\u88C5\u5168\u90E8</button>
      </div>
    </div>
    <div class="settings-block">
      <div class="surface-section-head">Connection Skills / MCP</div>
      ${mcpNote}
    </div>`;
}
function renderMaintenance() {
  if (!workspaceId) {
    return `<div class="empty"><p class="empty-title">\u6253\u5F00\u5DE5\u4F5C\u533A</p></div>`;
  }
  const summary = retentionPreview ? retentionSummaryLine(retentionPreview) : "\u5C1A\u672A\u9884\u89C8";
  const gaps = DESKTOP_CONTRACT_GAPS.map(
    (g) => `<li class="settings-gap-item">
        <code>${escapeHtml(g.id)}</code>
        <span class="muted">${escapeHtml(g.need)}</span>
      </li>`
  ).join("");
  return `
    <div class="settings-block">
      <div class="surface-section-head">\u8FD0\u8425\u4FDD\u7559</div>
      <p class="muted" id="retention-summary">${escapeHtml(summary)}</p>
      <div class="settings-row">
        <label class="settings-label" for="retention-days">\u4FDD\u7559\u5929\u6570</label>
        <input id="retention-days" class="field field-compact" type="number" min="0" max="3650" value="${retentionPreview?.keepTerminalTasksDays ?? 30}" />
        <button type="button" id="btn-retention-preview" class="btn btn-secondary">\u9884\u89C8</button>
        <button type="button" id="btn-retention-purge" class="btn btn-primary">\u6E05\u7406</button>
      </div>
    </div>
    <div class="settings-block">
      <div class="surface-section-head">\u5951\u7EA6\u7F3A\u53E3</div>
      <ul class="settings-gap-list">${gaps}</ul>
    </div>`;
}
function wireSection(s, root) {
  if (s === "workspace") {
    document.getElementById("btn-save-policy")?.addEventListener("click", () => void onSavePolicy());
    document.getElementById("btn-save-agents")?.addEventListener("click", () => void onSaveAgents());
  }
  if (s === "roles") {
    document.getElementById("btn-role-create")?.addEventListener("click", () => void onRoleCreate());
    document.getElementById("btn-role-save")?.addEventListener("click", () => void onRoleSave());
    document.getElementById("btn-role-edit-close")?.addEventListener("click", () => {
      roleEditName = null;
      renderSettings();
    });
    root.querySelectorAll("[data-role-edit]").forEach((btn) => {
      btn.addEventListener("click", () => {
        roleEditName = btn.getAttribute("data-role-edit");
        renderSettings();
      });
    });
    root.querySelectorAll("[data-role-delete]").forEach((btn) => {
      btn.addEventListener("click", () => void onRoleDelete(btn.getAttribute("data-role-delete")));
    });
  }
  if (s === "routes" || s === "skills") {
    document.getElementById("btn-route-create")?.addEventListener("click", () => void onRouteCreate());
    document.getElementById("btn-route-save")?.addEventListener("click", () => void onRouteSave());
    document.getElementById("btn-route-edit-close")?.addEventListener("click", () => {
      openRouteEditor(null);
      renderSettings();
    });
    root.querySelectorAll("[data-route-edit]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("data-route-edit");
        section = "routes";
        openRouteEditor(id);
        void loadLaunchSecrets().then(() => renderSettings());
        renderSettings();
      });
    });
    root.querySelectorAll("[data-route-delete]").forEach((btn) => {
      btn.addEventListener("click", () => void onRouteDelete(btn.getAttribute("data-route-delete")));
    });
    root.querySelectorAll("[data-skill-toggle]").forEach((box) => {
      box.addEventListener("change", () => {
        const name = box.getAttribute("data-skill-toggle");
        if (!name) return;
        skillDrafts = setSkillEnabled(skillDrafts, name, box.checked);
      });
    });
    root.querySelectorAll("[data-skill-remove]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const name = btn.getAttribute("data-skill-remove");
        if (!name) return;
        captureRouteFieldDraft();
        skillDrafts = removeSkillDraft(skillDrafts, name);
        renderSettings();
      });
    });
    document.getElementById("btn-skill-add")?.addEventListener("click", () => onSkillAdd());
    root.querySelectorAll("[data-mcp-toggle]").forEach((box) => {
      box.addEventListener("change", () => {
        const name = box.getAttribute("data-mcp-toggle");
        if (!name) return;
        mcpDrafts = setMcpEnabled(mcpDrafts, name, box.checked);
      });
    });
    root.querySelectorAll("[data-mcp-remove]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const name = btn.getAttribute("data-mcp-remove");
        if (!name) return;
        captureRouteFieldDraft();
        mcpDrafts = removeMcpDraft(mcpDrafts, name);
        renderSettings();
      });
    });
    document.getElementById("btn-mcp-add")?.addEventListener("click", () => onMcpAdd());
  }
  if (s === "routes") {
    document.getElementById("btn-launch-secret-set")?.addEventListener("click", () => void onLaunchSecretSet());
    root.querySelectorAll("[data-launch-secret-delete]").forEach((btn) => {
      btn.addEventListener(
        "click",
        () => void onLaunchSecretDelete(btn.getAttribute("data-launch-secret-delete"))
      );
    });
  }
  if (s === "skills") {
    document.getElementById("btn-skill-install-all")?.addEventListener("click", () => void onSkillInstall());
    root.querySelectorAll("[data-skill-install]").forEach((btn) => {
      btn.addEventListener(
        "click",
        () => void onSkillInstall([btn.getAttribute("data-skill-install")])
      );
    });
  }
  if (s === "maintenance") {
    document.getElementById("btn-retention-preview")?.addEventListener("click", () => void onRetentionPreview());
    document.getElementById("btn-retention-purge")?.addEventListener("click", () => void onRetentionPurge());
  }
}
async function onSavePolicy() {
  if (!workspaceId) return;
  const sel = document.getElementById("set-accept-mode");
  const value = sel?.value || "review-required";
  try {
    await window.tentDesktop.rpc("workspace.settings.update", {
      workspaceId,
      defaultAcceptMode: value,
      actor: "user"
    });
    settingsAcceptMode = value;
    el.status.textContent = "\u5DE5\u4F5C\u533A\u8BBE\u7F6E\u5DF2\u4FDD\u5B58";
  } catch (err) {
    setError(err);
  }
}
async function onSaveAgents() {
  if (!workspaceId) return;
  const ta = document.getElementById("set-agents");
  const content3 = ta?.value ?? "";
  try {
    const result = await window.tentDesktop.rpc("workspace.agents.write", {
      workspaceId,
      content: content3,
      baseEtag: agentsEtag || void 0,
      actor: "user"
    });
    agentsContent = result.content ?? content3;
    agentsEtag = result.etag ?? agentsEtag;
    agentsExists = result.exists !== false;
    el.status.textContent = "AGENTS.md \u5DF2\u4FDD\u5B58";
  } catch (err) {
    setError(err);
  }
}
async function onRoleCreate() {
  if (!workspaceId) return;
  const name = document.getElementById("role-name")?.value || "";
  const displayName = document.getElementById("role-display")?.value || "";
  const description = document.getElementById("role-description")?.value || "";
  const prompt = document.getElementById("role-prompt")?.value || "";
  const color = document.getElementById("role-color")?.value || "";
  const built = validateRoleCreate({ name, displayName, description, prompt, color });
  if (!built.ok) {
    el.status.textContent = built.reason;
    return;
  }
  const createBtn = document.getElementById("btn-role-create");
  if (createBtn) createBtn.disabled = true;
  try {
    await window.tentDesktop.rpc("registry.role.create", {
      workspaceId,
      ...built.payload
    });
    el.status.textContent = `\u5DF2\u521B\u5EFA\u89D2\u8272 ${name.trim()}`;
    roleEditName = name.trim();
    await loadRolesFull();
    await reloadRegistry();
    renderSettings();
  } catch (err) {
    setError(err);
    if (createBtn) createBtn.disabled = false;
  }
}
async function onRoleSave() {
  if (!workspaceId || !roleEditName) return;
  const role = fullRoles.find((r) => r.name === roleEditName);
  const displayName = document.getElementById("role-edit-display")?.value || "";
  const description = document.getElementById("role-edit-description")?.value || "";
  const prompt = document.getElementById("role-edit-prompt")?.value || "";
  const color = document.getElementById("role-edit-color")?.value || "";
  const built = validateRoleUpdate({
    name: roleEditName,
    roleId: role?.roleId,
    displayName,
    description,
    prompt,
    color
  });
  if (!built.ok) {
    el.status.textContent = built.reason;
    return;
  }
  const saveBtn = document.getElementById("btn-role-save");
  if (saveBtn) saveBtn.disabled = true;
  try {
    await window.tentDesktop.rpc("registry.role.update", {
      workspaceId,
      ...built.payload
    });
    el.status.textContent = `\u5DF2\u66F4\u65B0\u89D2\u8272 ${roleEditName}`;
    await loadRolesFull();
    await reloadRegistry();
    renderSettings();
  } catch (err) {
    setError(err);
    if (saveBtn) saveBtn.disabled = false;
  }
}
async function onRoleDelete(name) {
  if (!workspaceId) return;
  if (!window.confirm(`\u5220\u9664\u89D2\u8272\u300C${name}\u300D\uFF1F\u786E\u8BA4\u987B\u7B49\u4E8E\u8FD0\u8425\u952E\u3002`)) return;
  try {
    await window.tentDesktop.rpc("registry.role.delete", {
      workspaceId,
      name,
      confirmation: name,
      actor: "user"
    });
    if (roleEditName === name) roleEditName = null;
    el.status.textContent = `\u5DF2\u5220\u9664\u89D2\u8272 ${name}`;
    await loadRolesFull();
    await reloadRegistry();
    renderSettings();
  } catch (err) {
    setError(err);
  }
}
async function onRouteCreate() {
  const draft = {
    connectionId: document.getElementById("route-id")?.value || "",
    provider: document.getElementById("route-provider")?.value || "",
    adapterId: document.getElementById("route-adapter")?.value || "",
    displayName: document.getElementById("route-name")?.value || "",
    model: document.getElementById("route-model")?.value || "",
    envKey: document.getElementById("route-env")?.value || "",
    launchSecretRef: document.getElementById("route-launch-secret")?.value || ""
  };
  const built = validateConnectionCreate(draft);
  if (!built.ok) {
    el.status.textContent = built.reason;
    return;
  }
  const createBtn = document.getElementById("btn-route-create");
  if (createBtn) createBtn.disabled = true;
  try {
    await window.tentDesktop.rpc("connection.create", built.payload);
    el.status.textContent = `\u5DF2\u521B\u5EFA Connection ${draft.connectionId.trim()}`;
    await loadRoutesFull();
    renderSettings();
  } catch (err) {
    setError(err);
    if (createBtn) createBtn.disabled = false;
  }
}
function onSkillAdd() {
  const name = document.getElementById("skill-add-name")?.value || "";
  const path = document.getElementById("skill-add-path")?.value || "";
  const built = validateSkillAddDraft({ name, path });
  if (!built.ok) {
    el.status.textContent = built.reason;
    return;
  }
  if (skillDrafts.some((s) => s.name.toLowerCase() === built.entry.name.toLowerCase())) {
    el.status.textContent = `skill ${built.entry.name} \u5DF2\u5728\u5217\u8868\u4E2D`;
    return;
  }
  captureRouteFieldDraft();
  skillDrafts = [...skillDrafts, built.entry];
  renderSettings();
}
function onMcpAdd() {
  const name = document.getElementById("mcp-add-name")?.value || "";
  const transport = document.getElementById("mcp-add-transport")?.value || "stdio";
  const command = document.getElementById("mcp-add-command")?.value || "";
  const url = document.getElementById("mcp-add-url")?.value || "";
  const envSecretName = document.getElementById("mcp-add-env-name")?.value || "";
  const envLaunchSecretRef = document.getElementById("mcp-add-secret-ref")?.value || "";
  const built = validateMcpAddDraft({
    name,
    transport,
    command,
    url,
    envSecretName,
    envLaunchSecretRef
  });
  if (!built.ok) {
    el.status.textContent = built.reason;
    return;
  }
  if (mcpDrafts.some((m) => m.name.toLowerCase() === built.entry.name.toLowerCase())) {
    el.status.textContent = `MCP ${built.entry.name} \u5DF2\u5728\u5217\u8868\u4E2D`;
    return;
  }
  captureRouteFieldDraft();
  mcpDrafts = [...mcpDrafts, built.entry];
  renderSettings();
}
async function onRouteSave() {
  if (!routeEditId) return;
  const built = validateConnectionUpdate({
    connectionId: routeEditId,
    displayName: document.getElementById("route-edit-name")?.value || "",
    model: document.getElementById("route-edit-model")?.value || "",
    executable: document.getElementById("route-edit-exe")?.value || "",
    envKey: document.getElementById("route-edit-env")?.value || "",
    launchSecretRef: document.getElementById("route-edit-launch-secret")?.value || "",
    baseUrl: document.getElementById("route-edit-base")?.value || ""
  });
  if (!built.ok) {
    el.status.textContent = built.reason;
    return;
  }
  const skillsPayload = buildSkillsPayload(skillDrafts);
  const mcpPayload = buildMcpServersPayload(mcpDrafts);
  const patch = {
    ...built.payload,
    // Empty array clears on server via parse path; use null only when intentionally empty? Backend accepts [].
    skills: skillsPayload.length ? skillsPayload : null,
    mcpServers: mcpPayload.length ? mcpPayload : null
  };
  const saveBtn = document.getElementById("btn-route-save");
  if (saveBtn) saveBtn.disabled = true;
  try {
    await window.tentDesktop.rpc("connection.update", patch);
    el.status.textContent = `Connection \u5DF2\u4FDD\u5B58 \xB7 \u4E0B\u6B21\u4F1A\u8BDD\u751F\u6548\uFF08\u8FD0\u884C\u4E2D session \u4E0D\u70ED\u66F4\u65B0\uFF09`;
    await loadRoutesFull();
    openRouteEditor(routeEditId);
    renderSettings();
  } catch (err) {
    setError(err);
    if (saveBtn) saveBtn.disabled = false;
  }
}
async function onRouteDelete(connectionId) {
  if (!window.confirm(`\u5220\u9664 Connection\u300C${connectionId}\u300D\uFF1F`)) return;
  try {
    await window.tentDesktop.rpc("connection.delete", { connectionId });
    if (routeEditId === connectionId) openRouteEditor(null);
    el.status.textContent = `\u5DF2\u5220\u9664 Connection ${connectionId}`;
    await loadRoutesFull();
    renderSettings();
  } catch (err) {
    setError(err);
  }
}
async function onLaunchSecretSet() {
  const idEl = document.getElementById("launch-secret-id");
  const labelEl = document.getElementById("launch-secret-label");
  const secretEl = document.getElementById("launch-secret-value");
  const id = idEl?.value || "";
  const label = labelEl?.value || "";
  const secret = secretEl?.value || "";
  const built = validateLaunchSecretSet({ id, secret, label });
  if (!built.ok) {
    el.status.textContent = built.reason;
    return;
  }
  if (secretEl) secretEl.value = "";
  const setBtn = document.getElementById("btn-launch-secret-set");
  if (setBtn) setBtn.disabled = true;
  try {
    await window.tentDesktop.rpc("settings.launchSecret.set", {
      id: built.payload.id,
      secret: built.payload.secret,
      ...built.payload.label !== void 0 ? { label: built.payload.label } : {}
    });
    built.payload.secret = "";
    el.status.textContent = `\u542F\u52A8 Secret ${built.payload.id} \u5DF2\u914D\u7F6E`;
    if (idEl) idEl.value = built.payload.id;
    await loadLaunchSecrets();
    renderSettings();
  } catch (err) {
    built.payload.secret = "";
    setError(err);
    if (setBtn) setBtn.disabled = false;
  }
}
async function onLaunchSecretDelete(id) {
  if (!window.confirm(`\u5220\u9664\u542F\u52A8 Secret\u300C${id}\u300D\uFF1F\u6B64\u64CD\u4F5C\u4E0D\u53EF\u64A4\u9500\u3002`)) return;
  try {
    await window.tentDesktop.rpc("settings.launchSecret.delete", { id });
    el.status.textContent = `\u5DF2\u5220\u9664\u542F\u52A8 Secret ${id}`;
    await loadLaunchSecrets();
    renderSettings();
  } catch (err) {
    setError(err);
  }
}
async function onSkillInstall(names) {
  try {
    await window.tentDesktop.rpc("skill.install", names?.length ? { skills: names } : {});
    el.status.textContent = names?.length ? `\u5DF2\u5B89\u88C5 skill ${names.join(", ")}` : "\u5DF2\u5B89\u88C5\u5168\u90E8 bundled skills";
    await loadSkills();
    renderSettings();
  } catch (err) {
    setError(err);
  }
}
async function onRetentionPreview() {
  if (!workspaceId) return;
  const daysRaw = document.getElementById("retention-days")?.value;
  const days = daysRaw !== void 0 && daysRaw !== "" ? Number(daysRaw) : 30;
  try {
    retentionPreview = await window.tentDesktop.rpc("operationalRetention.preview", {
      workspaceId,
      keepTerminalTasksDays: days,
      actor: "user"
    });
    el.status.textContent = "\u4FDD\u7559\u9884\u89C8\u5DF2\u66F4\u65B0";
    renderSettings();
  } catch (err) {
    setError(err);
  }
}
async function onRetentionPurge() {
  if (!workspaceId) return;
  const daysRaw = document.getElementById("retention-days")?.value;
  const days = daysRaw !== void 0 && daysRaw !== "" ? Number(daysRaw) : 30;
  if (!window.confirm(`\u6E05\u7406\u8D85\u8FC7 ${days} \u5929\u7684\u7EC8\u7AEF\u4EFB\u52A1/\u4EA4\u4ED8\uFF1F\u6B64\u64CD\u4F5C\u4E0D\u53EF\u64A4\u9500\u3002`)) return;
  const purgeBtn = document.getElementById("btn-retention-purge");
  if (purgeBtn) purgeBtn.disabled = true;
  try {
    const result = await window.tentDesktop.rpc("operationalRetention.purge", {
      workspaceId,
      keepTerminalTasksDays: days,
      actor: "user"
    });
    el.status.textContent = `\u5DF2\u6E05\u7406 ${result.deletedCount ?? 0} \u9879`;
    await loadRetentionPreview();
    renderSettings();
  } catch (err) {
    setError(err);
    if (purgeBtn) purgeBtn.disabled = false;
  }
}

// src/desktop/renderer/main-ui.ts
function updateActivityChrome() {
  const n = pendingInteractionCount2() + actionableTasks().filter((t) => t.canAcceptOrReject).length;
  syncActivityBadge(n);
}
function renderAll() {
  renderTabs();
  renderToolbar();
  renderEditor();
  renderMeta();
  renderBacklinks();
  renderDispatchPanel();
  renderPendingInteractions();
  renderTaskInput();
  renderSessions();
  renderTree();
  syncInspectorSections();
  updateActivityChrome();
  const surface = getSurface();
  if (surface === "activity") renderActivity();
  if (surface === "graph") renderGraph();
}
bindStateHost({
  renderTree,
  renderCreateTypeSelect,
  renderDispatchPanel,
  renderTasks: () => {
    renderTasks();
    updateActivityChrome();
    if (getSurface() === "activity") renderActivity();
  },
  renderTaskInput,
  renderSessions,
  renderPendingInteractions: () => {
    renderPendingInteractions();
    updateActivityChrome();
    if (getSurface() === "activity") renderActivity();
  },
  renderMeta,
  renderBacklinks,
  openNode
});
bindTreeHost({ openNode });
bindDocumentHost({
  renderAll,
  renderTabs,
  renderToolbar,
  loadCards,
  openWorkspace: () => void onOpenWorkspace(),
  onConceptOpened: async () => {
    await Promise.all([reloadNodeCollaborations(), reloadActiveBacklinks()]);
    renderTree();
    renderMeta();
    renderBacklinks();
  }
});
bindInspectorHost({ renderAll, openNode });
bindDispatchHost({ renderDispatchPanel });
bindShellHost({
  onSurfaceChange: (surface) => {
    void onSurfaceEnter(surface);
  }
});
bindGraphHost({
  openNode,
  goWorkbench: () => setSurface("workbench")
});
bindActivityHost({
  goWorkbench: () => setSurface("workbench")
});
async function onSurfaceEnter(surface) {
  if (surface === "graph") {
    await reloadGraph().catch((err) => setError(err));
  } else if (surface === "activity") {
    renderActivity();
  } else if (surface === "settings") {
    await reloadSettings().catch((err) => setError(err));
  }
}
async function boot() {
  bindLayoutChrome();
  bindChromeMenus();
  bindSurfaceNav();
  document.getElementById("btn-open-ws").addEventListener("click", onOpenWorkspace);
  document.getElementById("btn-refresh").addEventListener("click", () => void refresh());
  document.getElementById("btn-new-note").addEventListener("click", () => void onCreateNote());
  el.btnNewBox.addEventListener("click", () => void onCreateNode());
  el.createType.addEventListener("change", () => {
    setCreateTypePick(el.createType.value);
  });
  document.getElementById("btn-search").addEventListener("click", () => void onSearch());
  document.getElementById("btn-card").addEventListener("click", () => void onEmitCard());
  document.getElementById("btn-float").addEventListener("click", () => void window.tentDesktop.showFloat());
  el.wsSelect.addEventListener("change", () => {
    const id = el.wsSelect.value;
    if (id) {
      void window.tentDesktop.setForeground(id).then(async (s) => {
        applyShell(s);
        await refresh();
      }).catch((err) => setError(err));
    }
  });
  el.searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void onSearch();
  });
  window.tentDesktop.onStateChanged((s) => {
    applyShell(s);
    if (workspaceId) void Promise.all([reloadPendingInteractions(), reloadTasks()]);
  });
  window.tentDesktop.onServiceEvent((ev) => {
    if (ev.workspaceId && workspaceId && ev.workspaceId !== workspaceId) return;
    void onServiceEvent(ev.type);
  });
  await refresh();
}
async function refresh() {
  const s = await window.tentDesktop.getState();
  applyShell(s);
  if (workspaceId) {
    await Promise.all([
      reloadTree(),
      reloadRegistry(),
      reloadTasks(),
      reloadConnections(),
      reloadPendingInteractions()
    ]);
    onGraphTreeChanged();
  } else {
    await reloadConnections();
  }
  updateActivityChrome();
  const surface = getSurface();
  if (surface !== "workbench") await onSurfaceEnter(surface);
}
function applyShell(s) {
  setState(s);
  const ok = s.health.status === "ok";
  el.health.className = `status-dot ${ok ? "ok" : "off"}`;
  el.health.textContent = "";
  el.health.setAttribute("aria-label", ok ? "\u670D\u52A1\u5728\u7EBF" : "\u670D\u52A1\u79BB\u7EBF");
  el.health.title = ok ? `Local Service \u6B63\u5E38 \xB7 pid ${s.health.pid ?? "?"} \xB7 ${s.health.version ?? ""}` : "Local Service \u79BB\u7EBF";
  el.wsSelect.innerHTML = "";
  for (const w of s.workspaces) {
    const opt = document.createElement("option");
    opt.value = w.workspaceId;
    const label = (w.tentName || "").trim() || "\u5DE5\u4F5C\u533A";
    opt.textContent = label;
    opt.title = w.workspaceRoot || w.workspaceId;
    if (w.foreground || w.workspaceId === s.foregroundWorkspaceId) opt.selected = true;
    el.wsSelect.appendChild(opt);
  }
  setWorkspaceId(s.foregroundWorkspaceId);
  const live = s.statusMessage || s.workspace?.statusMessage || "";
  if (live) el.status.textContent = live;
  if (s.workspace?.tree?.length) {
    setTree(s.workspace.tree);
    renderTree();
  } else if (!s.foregroundWorkspaceId) {
    setTree([]);
    renderTree();
    renderAll();
  }
  if (s.coordinationTypes?.length) {
    setCoordinationTypes(s.coordinationTypes);
    renderCreateTypeSelect();
  }
  if (s.roles) {
    setRoles(s.roles);
  }
  if (s.connections?.length) {
    setConnections(s.connections);
  }
  if (s.selectedConnectionId !== void 0) {
    setSelectedConnectionId(s.selectedConnectionId);
  }
  if (s.taskReview?.length) {
    setTaskReview(s.taskReview);
  } else if (s.tasks?.length) {
    setTaskReview(
      buildTaskReviewItems(
        s.tasks.map((t) => ({
          path: t.path,
          id: t.id,
          roleId: t.roleId,
          workNodeIds: t.workNodeIds,
          contextNodeIds: t.contextNodeIds,
          state: t.state,
          prompt: t.prompt,
          activeDeliveryId: t.activeDeliveryId,
          sessionId: t.sessionId,
          manifest: "",
          acceptMode: t.acceptMode,
          contextCard: t.contextCard
        })),
        deliveries,
        sessions
      )
    );
  } else {
    setTaskReview([]);
  }
  renderTasks();
  renderDispatchPanel();
  updateActivityChrome();
  void loadCards();
}
async function onOpenWorkspace() {
  const folder = await window.tentDesktop.pickWorkspaceFolder();
  if (!folder) return;
  try {
    await window.tentDesktop.mountWorkspace(folder);
    await refresh();
  } catch (err) {
    setError(err);
  }
}
void boot();
//# sourceMappingURL=main-ui.js.map

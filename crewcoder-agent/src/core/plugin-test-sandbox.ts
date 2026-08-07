/**
 * Source for the worker that hosts plugin code during `crewcoder plugin test`.
 *
 * Shipped as a string and run with `new Worker(code, { eval: true })` so there is
 * no build-layout coupling: resolving a sibling `.js` next to `import.meta.url`
 * breaks between `src/` under vitest and `dist/` after a build, and this harness
 * has to work in both.
 *
 * ## What this is, and what it is not
 *
 * It is a **protocol and contract harness with a stub DOM**. It executes the
 * plugin's real scripts, so it catches load-time throws, missing handler wiring,
 * malformed requests, and permission mismatches.
 *
 * It is NOT a browser. The DOM stub implements only the handful of operations
 * panel code actually uses (lookup by id, create/append, text/HTML assignment,
 * listeners, class/style bags). There is no layout, no CSS, no real event
 * bubbling, and no network. A plugin can pass here and still render wrong, and
 * the report says so rather than implying visual correctness.
 */
export const PLUGIN_TEST_SANDBOX_SOURCE = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const vm = require("node:vm");

const post = (message) => parentPort.postMessage(message);

// ---------------------------------------------------------------------------
// Minimal DOM stub. Deliberately small: it covers what CrewCode panel templates
// actually do, and anything beyond that surfaces as a runtime error the report
// attributes to a missing DOM feature rather than to the plugin being broken.
// ---------------------------------------------------------------------------
const usedDomFeatures = new Set();

function note(feature) {
  usedDomFeatures.add(feature);
}

class StubClassList {
  constructor() { this.tokens = new Set(); }
  add(...names) { for (const name of names) this.tokens.add(name); }
  remove(...names) { for (const name of names) this.tokens.delete(name); }
  toggle(name, force) { const on = force === undefined ? !this.tokens.has(name) : Boolean(force); if (on) this.tokens.add(name); else this.tokens.delete(name); return on; }
  contains(name) { return this.tokens.has(name); }
}

class StubElement {
  constructor(tagName, id) {
    this.tagName = String(tagName || "div").toUpperCase();
    this.id = id || "";
    this.children = [];
    this.parent = null;
    this.listeners = new Map();
    this.attributes = new Map();
    this.classList = new StubClassList();
    this.style = {};
    this.dataset = {};
    this.disabled = false;
    this.value = "";
    this._text = "";
    this._html = "";
  }
  get className() { return [...this.classList.tokens].join(" "); }
  set className(value) { this.classList.tokens = new Set(String(value ?? "").split(/\s+/).filter(Boolean)); }
  get textContent() { return this._text || this.children.map((child) => child.textContent).join(""); }
  set textContent(value) { note("textContent"); this._text = String(value ?? ""); this.children = []; }
  get innerHTML() { return this._html; }
  set innerHTML(value) { note("innerHTML"); this._html = String(value ?? ""); this.children = []; this._text = ""; }
  get innerText() { return this.textContent; }
  set innerText(value) { this.textContent = value; }
  appendChild(child) { note("appendChild"); child.parent = this; this.children.push(child); return child; }
  append(...nodes) { for (const node of nodes) this.appendChild(node); }
  removeChild(child) { this.children = this.children.filter((entry) => entry !== child); return child; }
  remove() { if (this.parent) this.parent.removeChild(this); }
  setAttribute(name, value) { this.attributes.set(String(name), String(value)); }
  getAttribute(name) { return this.attributes.has(String(name)) ? this.attributes.get(String(name)) : null; }
  removeAttribute(name) { this.attributes.delete(String(name)); }
  hasAttribute(name) { return this.attributes.has(String(name)); }
  addEventListener(type, handler) { note("addEventListener:" + type); if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(handler); }
  removeEventListener(type, handler) { this.listeners.get(type)?.delete(handler); }
  dispatchEvent(event) {
    const handlers = this.listeners.get(event.type);
    if (!handlers || !handlers.size) return false;
    for (const handler of [...handlers]) handler.call(this, event);
    return true;
  }
  click() { this.dispatchEvent({ type: "click", target: this, preventDefault() {}, stopPropagation() {} }); }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  closest() { return null; }
  focus() {}
  blur() {}
}

const elementsById = new Map();
const createdElements = [];

const documentStub = {
  documentElement: new StubElement("html"),
  body: new StubElement("body"),
  head: new StubElement("head"),
  getElementById(id) {
    note("getElementById");
    const key = String(id);
    // Panel HTML is not parsed, so ids are materialized on first lookup. That
    // keeps document.getElementById('x').textContent = ... from throwing for
    // an id the markup really does define.
    if (!elementsById.has(key)) elementsById.set(key, new StubElement("div", key));
    return elementsById.get(key);
  },
  createElement(tagName) { note("createElement"); const element = new StubElement(tagName); createdElements.push(element); return element; },
  createTextNode(text) { const element = new StubElement("span"); element.textContent = text; return element; },
  querySelector() { return null; },
  querySelectorAll() { return []; },
  addEventListener(type, handler) { documentListeners.set(type, [...(documentListeners.get(type) ?? []), handler]); },
  removeEventListener() {},
  get readyState() { return "complete"; }
};
const documentListeners = new Map();

// ---------------------------------------------------------------------------
// Window + the crewcode postMessage protocol.
// window.parent.postMessage is the plugin -> host channel, exactly as in the
// real sandboxed iframe.
// ---------------------------------------------------------------------------
const windowListeners = new Map();

// Browser globals panel code reaches for that have nothing to do with the plugin
// contract. Stubbing them keeps a healthy plugin from failing on scaffolding.
class StubObserver {
  constructor(callback) { this.callback = callback; }
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() { return []; }
}

const storageStub = () => {
  const map = new Map();
  return {
    getItem: (key) => (map.has(String(key)) ? map.get(String(key)) : null),
    setItem: (key, value) => { map.set(String(key), String(value)); },
    removeItem: (key) => { map.delete(String(key)); },
    clear: () => map.clear(),
    key: (index) => [...map.keys()][index] ?? null,
    get length() { return map.size; }
  };
};

const navigatorStub = {
  userAgent: "CrewCoderPluginTest/0.1",
  language: "en-US",
  languages: ["en-US"],
  platform: "crewcoder-plugin-test",
  clipboard: {
    writeText: async () => { note("clipboard.writeText"); },
    readText: async () => { note("clipboard.readText"); return ""; }
  }
};

const windowStub = {
  document: documentStub,
  location: { href: "crewcode-plugin://" + String(workerData.pluginId) + "/" + String(workerData.entry), origin: "crewcode-plugin://" + String(workerData.pluginId) },
  navigator: navigatorStub,
  localStorage: storageStub(),
  sessionStorage: storageStub(),
  MutationObserver: StubObserver,
  ResizeObserver: StubObserver,
  IntersectionObserver: StubObserver,
  PerformanceObserver: StubObserver,
  matchMedia: (query) => ({ matches: false, media: String(query), addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
  getComputedStyle: () => ({ getPropertyValue: () => "" }),
  requestIdleCallback: (fn) => setTimeout(() => fn({ didTimeout: false, timeRemaining: () => 0 }), 0),
  cancelIdleCallback: (handle) => clearTimeout(handle),
  alert: () => {},
  confirm: () => false,
  prompt: () => null,
  parent: {
    postMessage(data) { post({ kind: "plugin-message", data: safeClone(data) }); }
  },
  addEventListener(type, handler) {
    if (!windowListeners.has(type)) windowListeners.set(type, new Set());
    windowListeners.get(type).add(handler);
  },
  removeEventListener(type, handler) { windowListeners.get(type)?.delete(handler); },
  postMessage(data) { deliverWindowMessage(data); },
  setTimeout: (fn, ms, ...args) => setTimeout(fn, ms, ...args),
  clearTimeout: (handle) => clearTimeout(handle),
  setInterval: (fn, ms, ...args) => setInterval(fn, ms, ...args),
  clearInterval: (handle) => clearInterval(handle),
  requestAnimationFrame: (fn) => setTimeout(() => fn(Date.now()), 0),
  cancelAnimationFrame: (handle) => clearTimeout(handle),
  console
};
windowStub.window = windowStub;
windowStub.self = windowStub;
windowStub.top = windowStub.parent;

function deliverWindowMessage(data) {
  const handlers = windowListeners.get("message");
  if (!handlers) return;
  const event = { type: "message", data, source: windowStub.parent, origin: "*" };
  for (const handler of [...handlers]) handler(event);
}

function safeClone(value) {
  try {
    return structuredClone(value);
  } catch {
    try { return JSON.parse(JSON.stringify(value)); } catch { return String(value); }
  }
}

function reportRuntimeError(error, phase) {
  const normalized = error instanceof Error ? error : new Error(String(error));
  post({ kind: "runtime-error", phase, message: normalized.message, stack: normalized.stack ?? "" });
}

process.on("uncaughtException", (error) => reportRuntimeError(error, "async"));
process.on("unhandledRejection", (reason) => reportRuntimeError(reason, "async"));

// ---------------------------------------------------------------------------
// Execute the plugin's scripts in order, in one shared context, the way a browser
// would execute sibling <script> tags in a document.
// ---------------------------------------------------------------------------
const sandbox = {
  window: windowStub,
  self: windowStub,
  document: documentStub,
  location: windowStub.location,
  navigator: windowStub.navigator,
  localStorage: windowStub.localStorage,
  sessionStorage: windowStub.sessionStorage,
  MutationObserver: StubObserver,
  ResizeObserver: StubObserver,
  IntersectionObserver: StubObserver,
  PerformanceObserver: StubObserver,
  matchMedia: windowStub.matchMedia,
  getComputedStyle: windowStub.getComputedStyle,
  requestIdleCallback: windowStub.requestIdleCallback,
  cancelIdleCallback: windowStub.cancelIdleCallback,
  HTMLElement: StubElement,
  Element: StubElement,
  Node: StubElement,
  CustomEvent: class CustomEvent { constructor(type, init) { this.type = String(type); this.detail = init?.detail; } preventDefault() {} stopPropagation() {} },
  Event: class Event { constructor(type) { this.type = String(type); } preventDefault() {} stopPropagation() {} },
  console,
  setTimeout: windowStub.setTimeout,
  clearTimeout: windowStub.clearTimeout,
  setInterval: windowStub.setInterval,
  clearInterval: windowStub.clearInterval,
  requestAnimationFrame: windowStub.requestAnimationFrame,
  cancelAnimationFrame: windowStub.cancelAnimationFrame,
  structuredClone,
  URL,
  TextEncoder,
  TextDecoder,
  JSON,
  Math,
  Date,
  Promise,
  parent: windowStub.parent,
  addEventListener: (type, handler) => windowStub.addEventListener(type, handler),
  removeEventListener: (type, handler) => windowStub.removeEventListener(type, handler),
  postMessage: (data) => windowStub.parent.postMessage(data)
};
sandbox.globalThis = sandbox;
const context = vm.createContext(sandbox);

for (const script of workerData.scripts ?? []) {
  try {
    new vm.Script(script.code, { filename: script.name }).runInContext(context, { timeout: workerData.scriptTimeoutMs ?? 5000 });
    post({ kind: "script-loaded", name: script.name });
  } catch (error) {
    reportRuntimeError(error, "load:" + script.name);
  }
}

post({ kind: "ready", domFeatures: [...usedDomFeatures] });

parentPort.on("message", (message) => {
  try {
    if (message.kind === "frame-message") { deliverWindowMessage(message.data); return; }
    if (message.kind === "click") {
      const element = elementsById.get(String(message.target));
      const dispatched = element ? element.dispatchEvent({ type: "click", target: element, preventDefault() {}, stopPropagation() {} }) : false;
      post({ kind: "click-result", target: message.target, dispatched, known: Boolean(element) });
      return;
    }
    if (message.kind === "snapshot") {
      post({
        kind: "snapshot-result",
        requestId: message.requestId,
        domFeatures: [...usedDomFeatures],
        elements: [...elementsById.entries()].map(([id, element]) => ({ id, text: element.textContent, html: element.innerHTML, listeners: [...element.listeners.keys()] }))
      });
      return;
    }
  } catch (error) {
    reportRuntimeError(error, "message:" + String(message && message.kind));
  }
});
`;

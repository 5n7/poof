/**
 * Just enough of the DOM to run the owner bundle in the Workers test pool, which
 * has no document.
 */
export class FakeElement {
  children: FakeElement[] = [];
  parentElement: FakeElement | null = null;
  dataset: Record<string, string> = {};
  style: Record<string, unknown> = {};
  className = "";
  textContent = "";
  id = "";
  disabled = false;
  private listeners = new Map<string, ((event: unknown) => unknown)[]>();

  constructor(
    readonly page: FakePage,
    readonly tagName: string,
  ) {}

  get classList() {
    return { contains: (name: string) => this.className.split(/\s+/).includes(name) };
  }

  setAttribute() {}

  append(...nodes: FakeElement[]) {
    for (const node of nodes) this.insert(node, this.children.length);
  }
  after(node: FakeElement) {
    const parent = this.parentElement!;
    parent.insert(node, parent.children.indexOf(this) + 1);
  }
  private insert(node: FakeElement, at: number) {
    node.remove();
    node.parentElement = this;
    this.children.splice(at, 0, node);
  }
  /** Like a browser, removing the focused element sends focus to the body. */
  remove() {
    if (!this.parentElement) return;
    if (this.contains(this.page.activeElement)) this.page.activeElement = this.page.body;
    this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1);
    this.parentElement = null;
  }

  contains(other: FakeElement | null): boolean {
    for (let node = other; node; node = node.parentElement) if (node === this) return true;
    return false;
  }

  matches(selector: string): boolean {
    return selector.split(",").some((part) => matchesCompound(this, part.trim()));
  }
  querySelectorAll(selector: string): FakeElement[] {
    return this.children.flatMap((child) => [
      ...(child.matches(selector) ? [child] : []),
      ...child.querySelectorAll(selector),
    ]);
  }
  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  addEventListener(type: string, listener: (event: unknown) => unknown) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  click() {
    for (const listener of this.listeners.get("click") ?? []) listener({ target: this });
  }
  focus() {
    this.page.activeElement = this;
  }
}

function matchesCompound(node: FakeElement, selector: string): boolean {
  const parts = /^([a-z]+)?((?:\.[\w-]+|\[[^\]]+\]|:not\(\[[^\]]+\]\))*)$/.exec(selector);
  if (!parts) throw new Error(`fake DOM: unsupported selector ${selector}`);
  if (parts[1] && node.tagName !== parts[1]) return false;
  for (const [, cls, attr, notAttr] of parts[2]!.matchAll(
    /\.([\w-]+)|\[([^\]]+)\]|:not\(\[([^\]]+)\]\)/g,
  )) {
    if (cls && !node.classList.contains(cls)) return false;
    if (attr && !hasAttribute(node, attr)) return false;
    if (notAttr && hasAttribute(node, notAttr)) return false;
  }
  return true;
}

function hasAttribute(node: FakeElement, expression: string): boolean {
  const [, name, expected] = /^([\w-]+)(?:=["']?([^"']*)["']?)?$/.exec(expression)!;
  if (name === "disabled") return node.disabled;
  if (!name!.startsWith("data-")) throw new Error(`fake DOM: unsupported attribute ${name}`);
  const actual = node.dataset[name!.slice(5).replace(/-(\w)/g, (_, c: string) => c.toUpperCase())];
  return expected === undefined ? actual !== undefined : actual === expected;
}

export class FakePage {
  readonly body: FakeElement = new FakeElement(this, "body");
  activeElement: FakeElement = this.body;

  createElement(tag: string): FakeElement {
    return new FakeElement(this, tag);
  }
  createTextNode(text: string): FakeElement {
    const node = new FakeElement(this, "#text");
    node.textContent = text;
    return node;
  }
  getElementById(id: string): FakeElement | null {
    return everything(this.body).find((node) => node.id === id) ?? null;
  }
  querySelectorAll(selector: string): FakeElement[] {
    return this.body.querySelectorAll(selector);
  }
  addEventListener() {}
}

function everything(node: FakeElement): FakeElement[] {
  return node.children.flatMap((child) => [child, ...everything(child)]);
}

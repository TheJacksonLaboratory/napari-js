/**
 * A minimal DOM for the overlay tests (vitest runs in `node`, with no jsdom): elements with a
 * plain-object `style`, children, text, listeners (honouring `{ signal }`), a client rect and a
 * recording 2D context. Overlays build their DOM through `host.ownerDocument`, so a fake host is
 * all they need.
 */

type Listener = (e: unknown) => void;

export class FakeElement {
  style: Record<string, string> = {};
  children: FakeElement[] = [];
  parentNode: FakeElement | null = null;
  textContent: string | null = null;
  className = '';
  clientWidth = 0;
  clientHeight = 0;
  width = 0;
  height = 0;
  rect = { left: 0, top: 0, width: 0, height: 0 };
  readonly draws: unknown[][] = [];
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(
    readonly tagName: string,
    readonly ownerDocument: FakeDocument,
  ) {}

  appendChild(child: FakeElement): FakeElement {
    child.remove();
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  append(...children: FakeElement[]): void {
    for (const c of children) this.appendChild(c);
  }

  remove(): void {
    const p = this.parentNode;
    if (!p) return;
    p.children = p.children.filter((c) => c !== this);
    this.parentNode = null;
  }

  addEventListener(type: string, fn: Listener, opts?: { signal?: AbortSignal }): void {
    if (opts?.signal?.aborted) return;
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(fn);
    opts?.signal?.addEventListener('abort', () => set!.delete(fn), { once: true });
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }

  dispatch(
    type: string,
    init: Record<string, unknown> = {},
  ): {
    stopped: boolean;
    prevented: boolean;
  } {
    const ev = {
      type,
      cancelable: true,
      button: 0,
      pointerId: 1,
      clientX: 0,
      clientY: 0,
      stopped: false,
      prevented: false,
      stopPropagation() {
        this.stopped = true;
      },
      preventDefault() {
        this.prevented = true;
      },
      ...init,
    };
    for (const fn of this.listeners.get(type) ?? []) fn(ev);
    return ev;
  }

  getBoundingClientRect() {
    return this.rect;
  }

  setPointerCapture(): void {}
  releasePointerCapture(): void {}

  getContext() {
    return {
      clearRect: (...a: unknown[]) => this.draws.push(['clearRect', ...a]),
      drawImage: (...a: unknown[]) => this.draws.push(['drawImage', ...a]),
      imageSmoothingEnabled: false,
    };
  }

  /** Every descendant, depth-first. */
  all(): FakeElement[] {
    return this.children.flatMap((c) => [c, ...c.all()]);
  }
}

export class FakeDocument {
  readonly defaultView = {
    devicePixelRatio: 1,
    getComputedStyle: (el: FakeElement) => ({ position: el.style.position || 'static' }),
  };

  createElement(tag: string): FakeElement {
    return new FakeElement(tag, this);
  }
}

/** A fake host element of the given client size, typed as the `HTMLElement` overlays take. */
export function fakeHost(width = 800, height = 600): { host: HTMLElement; el: FakeElement } {
  const el = new FakeDocument().createElement('div');
  el.clientWidth = width;
  el.clientHeight = height;
  el.rect = { left: 0, top: 0, width, height };
  return { host: el as unknown as HTMLElement, el };
}

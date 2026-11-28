export type IntersectionStepFlush = (work: () => void) => void;
export type IntersectionCommit = (
  root: Element | Document | null,
  update: (flush?: IntersectionStepFlush) => void,
) => void;
export type IntersectionSubscriber = (entry: IntersectionObserverEntry) => unknown;

export const DEFAULT_OBSERVER_WORK_BUDGET_MS = 8;
let observerWorkBudgetMs = DEFAULT_OBSERVER_WORK_BUDGET_MS;

export function getObserverWorkBudgetMs(): number {
  return observerWorkBudgetMs;
}

export function setObserverWorkBudgetMs(budgetMs: number): void {
  observerWorkBudgetMs = Number.isFinite(budgetMs) && budgetMs > 0 ? budgetMs : DEFAULT_OBSERVER_WORK_BUDGET_MS;
}

type SharedRecord = {
  observer: IntersectionObserver;
  callbacks: Map<Element, IntersectionSubscriber>;
  pending: Map<Element, IntersectionObserverEntry>;
  frame: number;
  lastRafDrainEnd: number;
  lastRafDrainMs: number;
};
const commits=new WeakMap<IntersectionCommit,number>();let nextCommit=0;

// Share observers across windowed blocks and retire an observer when its last
// target disconnects.
const observers = new Map<string, Map<Element | Document | null, SharedRecord>>();

function optionsKey(options: IntersectionObserverInit): string {
  return JSON.stringify(Object.entries(options).filter(([name]) => name !== "root").sort(([left], [right]) => left.localeCompare(right)));
}

function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function parseVerticalMarginPx(rootMargin: string | undefined, viewportHeight: number): number {
  if (!rootMargin) return 0;
  const first = rootMargin.trim().split(/\s+/)[0] ?? "0px";
  const value = Number.parseFloat(first);
  if (!Number.isFinite(value)) return 0;
  return first.endsWith("%") ? (Math.abs(value) / 100) * viewportHeight : Math.abs(value);
}

function viewportDistancePx(rect: DOMRectReadOnly | null | undefined, viewport: DOMRectReadOnly | null): number {
  if (!viewport || viewport.height <= 0) return 0;
  if (!rect || (rect.height === 0 && rect.top === 0 && rect.bottom === 0)) return 0;
  if (rect.bottom < viewport.top) return viewport.top - rect.bottom;
  if (rect.top > viewport.bottom) return rect.top - viewport.bottom;
  return 0;
}

export function observeSharedIntersection(
  target: Element,
  callback: IntersectionSubscriber,
  options: IntersectionObserverInit = {},
  commit?: IntersectionCommit,
): () => void {
  if(commit&&!commits.has(commit))commits.set(commit,++nextCommit);
  const key = optionsKey(options)+':'+(commit?commits.get(commit):0);
  const root = options.root ?? null;
  let roots = observers.get(key);
  if (!roots) observers.set(key, roots = new Map());

  let record = roots.get(root);
  if (!record) {
    const callbacks = new Map<Element, IntersectionSubscriber>();
    const pending = new Map<Element, IntersectionObserverEntry>();
    let created!: SharedRecord;
    const scheduleDrain = () => {
      if (created.frame || pending.size === 0) return;
      created.frame = requestAnimationFrame(() => {
        created.frame = 0;
        const start = nowMs();
        drainPending();
        const end = nowMs();
        created.lastRafDrainMs = Math.max(0, end - start);
        created.lastRafDrainEnd = end;
      });
    };
    const drainPending = (freshEntries?: ReadonlySet<IntersectionObserverEntry>) => {
      if (!commit || pending.size === 0) return;
      let viewport: DOMRectReadOnly | null = null;
      if (freshEntries) {
        for (const entry of freshEntries) {
          if (entry.rootBounds && entry.rootBounds.height > 0) {
            viewport = entry.rootBounds;
            break;
          }
        }
      }
      if (!viewport && root instanceof Element) viewport = root.getBoundingClientRect();
      const hasViewport = Boolean(viewport && viewport.height > 0);
      const verticalMargin = hasViewport && viewport ? parseVerticalMarginPx(options.rootMargin, viewport.height) : 0;
      const visibleMounts: IntersectionObserverEntry[] = [];
      const actionableReleases: IntersectionObserverEntry[] = [];
      const noopReleases: IntersectionObserverEntry[] = [];
      const aboveCandidates: Array<{ entry: IntersectionObserverEntry; distance: number }> = [];
      const belowCandidates: Array<{ entry: IntersectionObserverEntry; distance: number }> = [];
      for (const [element, entry] of pending) {
        if (!callbacks.has(element)) {
          pending.delete(element);
          continue;
        }
        if (!entry.isIntersecting) {
          if (element instanceof HTMLElement && element.dataset.windowedMounted === "false") {
            noopReleases.push(entry);
          } else {
            actionableReleases.push(entry);
          }
          continue;
        }
        const isFresh = Boolean(freshEntries?.has(entry));
        const rect = isFresh && entry.boundingClientRect ? entry.boundingClientRect : element.getBoundingClientRect();
        if (!isFresh && viewport && viewport.height > 0 && (rect.height > 0 || rect.top !== 0 || rect.bottom !== 0)) {
          if (rect.bottom < viewport.top - verticalMargin || rect.top > viewport.bottom + verticalMargin) {
            pending.delete(element);
            continue;
          }
        }
        const distance = viewportDistancePx(rect, viewport);
        if (distance <= 0) {
          visibleMounts.push(entry);
        } else if (viewport && rect.bottom < viewport.top) {
          aboveCandidates.push({ entry, distance });
        } else {
          belowCandidates.push({ entry, distance });
        }
      }

      for (const item of noopReleases) {
        if (pending.get(item.target) !== item) continue;
        pending.delete(item.target);
        callbacks.get(item.target)?.(item);
      }

      if (!visibleMounts.length && !actionableReleases.length && !aboveCandidates.length && !belowCandidates.length) {
        return;
      }

      if (!hasViewport) {
        commit(root, () => {
          for (const item of visibleMounts) {
            if (pending.get(item.target) !== item) continue;
            pending.delete(item.target);
            callbacks.get(item.target)?.(item);
          }
          for (const item of actionableReleases) {
            if (pending.get(item.target) !== item) continue;
            pending.delete(item.target);
            callbacks.get(item.target)?.(item);
          }
        });
        return;
      }

      if (aboveCandidates.length > 1) {
        aboveCandidates.sort((left, right) =>
          left.distance - right.distance ||
          (left.entry.target.compareDocumentPosition(right.entry.target) & Node.DOCUMENT_POSITION_FOLLOWING ? 1 : -1),
        );
      }
      if (belowCandidates.length > 1) {
        belowCandidates.sort((left, right) =>
          left.distance - right.distance ||
          (left.entry.target.compareDocumentPosition(right.entry.target) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1),
        );
      }

      const releasingTargets = new Set<Element>(actionableReleases.map((item) => item.target));
      const isStayingMounted = (el: Element | null): boolean =>
        el instanceof HTMLElement && el.dataset.windowedMounted === "true" && !releasingTargets.has(el);

      let bridgeAboveEnd = -1;
      for (let i = 0; i < aboveCandidates.length; i++) {
        if (isStayingMounted(aboveCandidates[i].entry.target.previousElementSibling)) {
          bridgeAboveEnd = i;
        }
      }
      const bridgedAbove = bridgeAboveEnd >= 0 ? aboveCandidates.splice(0, bridgeAboveEnd + 1).map((c) => c.entry) : [];

      let bridgeBelowEnd = -1;
      for (let i = 0; i < belowCandidates.length; i++) {
        if (isStayingMounted(belowCandidates[i].entry.target.nextElementSibling)) {
          bridgeBelowEnd = i;
        }
      }
      const bridgedBelow = bridgeBelowEnd >= 0 ? belowCandidates.splice(0, bridgeBelowEnd + 1).map((c) => c.entry) : [];

      const mandatoryEntries = [...visibleMounts, ...bridgedAbove, ...bridgedBelow, ...actionableReleases];
      const mandatoryTargetSet = new Set<Element>(mandatoryEntries.map((item) => item.target));

      const eligibleAbove: Array<{ entry: IntersectionObserverEntry; distance: number }> = [];
      for (let i = 0; i < aboveCandidates.length; i++) {
        const inward = aboveCandidates[i].entry.target.nextElementSibling;
        const previousTarget = i > 0 ? aboveCandidates[i - 1].entry.target : null;
        if (
          inward instanceof HTMLElement &&
          inward.dataset.windowedMounted === "false" &&
          !mandatoryTargetSet.has(inward) &&
          inward !== previousTarget
        ) {
          break;
        }
        eligibleAbove.push(aboveCandidates[i]);
      }

      const eligibleBelow: Array<{ entry: IntersectionObserverEntry; distance: number }> = [];
      for (let i = 0; i < belowCandidates.length; i++) {
        const inward = belowCandidates[i].entry.target.previousElementSibling;
        const previousTarget = i > 0 ? belowCandidates[i - 1].entry.target : null;
        if (
          inward instanceof HTMLElement &&
          inward.dataset.windowedMounted === "false" &&
          !mandatoryTargetSet.has(inward) &&
          inward !== previousTarget
        ) {
          break;
        }
        eligibleBelow.push(belowCandidates[i]);
      }

      const marginMounts: IntersectionObserverEntry[] = [];
      for (let ia = 0, ib = 0; ia < eligibleAbove.length || ib < eligibleBelow.length; ) {
        if (ib >= eligibleBelow.length || (ia < eligibleAbove.length && eligibleAbove[ia].distance <= eligibleBelow[ib].distance)) {
          marginMounts.push(eligibleAbove[ia++].entry);
        } else {
          marginMounts.push(eligibleBelow[ib++].entry);
        }
      }

      if (!mandatoryEntries.length && !marginMounts.length) {
        if (pending.size > 0) scheduleDrain();
        return;
      }

      commit(root, (flush) => {
        const sliceStart = nowMs();
        const budget = observerWorkBudgetMs;
        const isDirect = Boolean(freshEntries);
        const sameFrameRafSpent = isDirect && sliceStart - created.lastRafDrainEnd < 12 ? created.lastRafDrainMs : 0;
        const marginBudget = Math.max(0, budget - sameFrameRafSpent);
        let statefulCount = 0;
        let stepSize = 1;
        const runStep = (batch: IntersectionObserverEntry[]): number => {
          const stepStart = nowMs();
          let changedInStep = 0;
          const invoke = () => {
            for (const item of batch) {
              if (pending.get(item.target) !== item) continue;
              pending.delete(item.target);
              const subscriber = callbacks.get(item.target);
              if (subscriber && subscriber(item) !== false) {
                statefulCount++;
                changedInStep++;
              }
            }
          };
          if (flush) flush(invoke);
          else invoke();
          return changedInStep > 0 ? (nowMs() - stepStart) / changedInStep : 0;
        };

        if (mandatoryEntries.length > 0) {
          const perItemMs = runStep(mandatoryEntries);
          if (perItemMs > 0) {
            stepSize = perItemMs < 1 ? 4 : perItemMs < 2 ? 2 : 1;
          }
        }

        for (let index = 0; index < marginMounts.length; ) {
          const elapsed = nowMs() - sliceStart;
          if (elapsed >= marginBudget && (statefulCount > 0 || sameFrameRafSpent > 0)) break;
          const batch = marginMounts.slice(index, index + stepSize);
          index += batch.length;
          const perItemMs = runStep(batch);
          if (perItemMs > 0) {
            stepSize = perItemMs < 1 ? 4 : perItemMs < 2 ? 2 : 1;
          }
        }
      });

      if (pending.size > 0) scheduleDrain();
    };
    const observer = new IntersectionObserver(entries => {
      if (!commit) {
        for (const entry of entries) callbacks.get(entry.target)?.(entry);
        return;
      }
      const fresh = new Set<IntersectionObserverEntry>();
      for (const entry of entries) {
        if (callbacks.has(entry.target)) {
          pending.set(entry.target, entry);
          fresh.add(entry);
        }
      }
      drainPending(fresh);
    }, options);
    created = { observer, callbacks, pending, frame: 0, lastRafDrainEnd: -Infinity, lastRafDrainMs: 0 };
    record = created;
    roots.set(root, record);
  }

  record.callbacks.set(target, callback);
  record.observer.observe(target);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    const currentRoots = observers.get(key);
    const current = currentRoots?.get(root);
    if (!current) return;
    current.callbacks.delete(target);
    current.pending.delete(target);
    if (current.pending.size === 0 && current.frame) {
      cancelAnimationFrame(current.frame);
      current.frame = 0;
    }
    current.observer.unobserve(target);
    if (current.callbacks.size === 0) {
      if (current.frame) {
        cancelAnimationFrame(current.frame);
        current.frame = 0;
      }
      current.pending.clear();
      current.observer.disconnect();
      currentRoots?.delete(root);
      if (currentRoots?.size === 0) observers.delete(key);
    }
  };
}

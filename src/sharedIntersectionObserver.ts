type SharedRecord = {
  observer: IntersectionObserver;
  callbacks: Map<Element, (entry: IntersectionObserverEntry) => void>;
};
export type IntersectionCommit = (root:Element|Document|null, update:()=>void)=>void;
const commits=new WeakMap<IntersectionCommit,number>();let nextCommit=0;

// Share observers across windowed blocks and retire an observer when its last
// target disconnects.
const observers = new Map<string, Map<Element | Document | null, SharedRecord>>();

function optionsKey(options: IntersectionObserverInit): string {
  return JSON.stringify(Object.entries(options).filter(([name]) => name !== "root").sort(([left], [right]) => left.localeCompare(right)));
}

export function observeSharedIntersection(
  target: Element,
  callback: (entry: IntersectionObserverEntry) => void,
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
    const callbacks = new Map<Element, (entry: IntersectionObserverEntry) => void>();
    const observer = new IntersectionObserver(entries => {
      const update=()=>{for (const entry of entries) callbacks.get(entry.target)?.(entry);};
      if(commit)commit(root,update);else update();
    }, options);
    record = { observer, callbacks };
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
    current.observer.unobserve(target);
    if (current.callbacks.size === 0) {
      current.observer.disconnect();
      currentRoots?.delete(root);
      if (currentRoots?.size === 0) observers.delete(key);
    }
  };
}

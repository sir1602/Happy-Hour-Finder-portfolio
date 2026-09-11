
import { performance } from 'perf_hooks';

const ITEMS_COUNT = 10000;

// Simulate a component render that takes some CPU time
function renderComponent(props: { id: number; onSelect: (id: number) => void }) {
  // Simulate work (e.g. constructing VDOM)
  let sum = 0;
  for (let i = 0; i < 500; i++) {
    sum += i;
  }
  return sum;
}

// Simulate React.memo behavior
// In React, each component element in a list has its own memoized state
function createMemoizedComponent(Component: Function) {
  let prevProps: any = null;
  let prevResult: any = null;

  return (props: any) => {
    if (prevProps && shallowEqual(prevProps, props)) {
      return prevResult;
    }
    prevProps = props;
    prevResult = Component(props);
    return prevResult;
  };
}

function shallowEqual(objA: any, objB: any) {
  if (Object.is(objA, objB)) return true;
  if (typeof objA !== 'object' || objA === null || typeof objB !== 'object' || objB === null) return false;
  const keysA = Object.keys(objA);
  const keysB = Object.keys(objB);
  if (keysA.length !== keysB.length) return false;
  for (let i = 0; i < keysA.length; i++) {
    if (!Object.prototype.hasOwnProperty.call(objB, keysA[i]) || !Object.is(objA[keysA[i]], objB[keysA[i]])) {
      return false;
    }
  }
  return true;
}

console.log(`Running benchmark with ${ITEMS_COUNT} items...`);

// --- Scenario 1: Stable Callback (Optimized) ---
const stableInstances = Array.from({ length: ITEMS_COUNT }, () => createMemoizedComponent(renderComponent));
const stableCallback = (id: number) => {};

// Initial Render
stableInstances.forEach((comp, i) => comp({ id: i, onSelect: stableCallback }));

// Re-render (Measure this)
const startStable = performance.now();
stableInstances.forEach((comp, i) => comp({ id: i, onSelect: stableCallback }));
const endStable = performance.now();
const timeStable = endStable - startStable;
console.log(`Stable Callbacks (Memoized): ${timeStable.toFixed(2)}ms`);


// --- Scenario 2: Unstable Callback (Unoptimized) ---
const unstableInstances = Array.from({ length: ITEMS_COUNT }, () => createMemoizedComponent(renderComponent));

// Initial Render
unstableInstances.forEach((comp, i) => comp({ id: i, onSelect: (id: number) => {} }));

// Re-render (Measure this)
const startUnstable = performance.now();
unstableInstances.forEach((comp, i) => comp({ id: i, onSelect: (id: number) => {} }));
const endUnstable = performance.now();
const timeUnstable = endUnstable - startUnstable;
console.log(`Unstable Callbacks (Re-renders): ${timeUnstable.toFixed(2)}ms`);


// --- Scenario 3: No Memoization (Baseline) ---
// Just calling the render function every time
const startNoMemo = performance.now();
for (let i = 0; i < ITEMS_COUNT; i++) {
    renderComponent({ id: i, onSelect: (id: number) => {} });
}
const endNoMemo = performance.now();
const timeNoMemo = endNoMemo - startNoMemo;
console.log(`No Memoization: ${timeNoMemo.toFixed(2)}ms`);


console.log(`\nImpact: Stable callbacks are ${(timeUnstable / timeStable).toFixed(1)}x faster than unstable callbacks in this simulation.`);

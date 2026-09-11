
const DEALS_COUNT = 1000;
const SAVED_COUNT = 100;
const ITERATIONS = 1000;

const savedIdsArray = Array.from({ length: SAVED_COUNT }, (_, i) => i * 2);
const savedIdsSet = new Set(savedIdsArray);

const deals = Array.from({ length: DEALS_COUNT }, (_, i) => ({ id: i }));

console.log(`Benchmarking filter loop for ${DEALS_COUNT} items with ${SAVED_COUNT} saved items.`);

// Benchmark Array.includes
const startArray = performance.now();
for (let i = 0; i < ITERATIONS; i++) {
    deals.filter(d => savedIdsArray.includes(d.id));
}
const endArray = performance.now();
console.log(`Array.includes: ${(endArray - startArray).toFixed(2)}ms for ${ITERATIONS} iterations`);

// Benchmark Set.has
const startSet = performance.now();
for (let i = 0; i < ITERATIONS; i++) {
    deals.filter(d => savedIdsSet.has(d.id));
}
const endSet = performance.now();
console.log(`Set.has: ${(endSet - startSet).toFixed(2)}ms for ${ITERATIONS} iterations`);

console.log(`Speedup: ${(endArray - startArray) / (endSet - startSet)}x`);

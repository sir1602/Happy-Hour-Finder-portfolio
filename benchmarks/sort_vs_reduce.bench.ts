
import { calculateDistance } from '../utils/location.ts';
import type { Deal } from '../types.ts';

const LARGE_DEALS_COUNT = 1000;
const userLocation = { latitude: 41.8781, longitude: -87.6298 }; // Chicago

// Generate a large number of random deals
const generateDeals = (count: number): Deal[] => {
  const deals: Deal[] = [];
  for (let i = 0; i < count; i++) {
    deals.push({
      id: i.toString(), venueId: 'v' + i,
      name: `Deal ${i}`,
      deal: `$${i % 10} Special`,
      image: '',
      neighborhood: 'Neighborhood',
      distance: '0.1 mi',
      price: 1,
      rating: 4.5,
      reviewCount: 10,
      tags: [],
      address: '',
      website: '',
      phone: '',
      type: 'regular',
      time: '4 PM - 6 PM',
      latitude: 41.8 + Math.random() * 0.2,
      longitude: -87.7 + Math.random() * 0.2,
      daysActive: [0, 1, 2, 3, 4, 5, 6],
    });
  }
  return deals;
};

const deals = generateDeals(LARGE_DEALS_COUNT);

function originalSort(deals: Deal[], location: { latitude: number, longitude: number }) {
  return [...deals].sort((a, b) => {
    const distA = calculateDistance(location.latitude, location.longitude, a.latitude, a.longitude);
    const distB = calculateDistance(location.latitude, location.longitude, b.latitude, b.longitude);
    return distA - distB;
  })[0];
}

function optimizedReduce(deals: Deal[], location: { latitude: number, longitude: number }) {
  if (deals.length === 0) return undefined;

  let closestDeal = deals[0];
  let minDistance = calculateDistance(location.latitude, location.longitude, closestDeal.latitude, closestDeal.longitude);

  for (let i = 1; i < deals.length; i++) {
    const currentDeal = deals[i];
    const currentDistance = calculateDistance(location.latitude, location.longitude, currentDeal.latitude, currentDeal.longitude);
    if (currentDistance < minDistance) {
      minDistance = currentDistance;
      closestDeal = currentDeal;
    }
  }
  return closestDeal;
}

const iterations = 100;

console.log(`Benchmarking with ${LARGE_DEALS_COUNT} deals, ${iterations} iterations...`);

let start = performance.now();
for (let i = 0; i < iterations; i++) {
  originalSort(deals, userLocation);
}
let end = performance.now();
console.log(`Original Sort average time: ${(end - start) / iterations}ms`);

start = performance.now();
for (let i = 0; i < iterations; i++) {
  optimizedReduce(deals, userLocation);
}
end = performance.now();
console.log(`Optimized Reduce/Loop average time: ${(end - start) / iterations}ms`);

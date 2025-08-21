import { getStableViewBoxUpdate, shouldApplyCompensatingTransform } from './src/utils.js';

// Simple test runner
function test(name, fn) {
  try {
    fn();
    console.log(`✅ ${name}`);
  } catch (error) {
    console.log(`❌ ${name}: ${error.message}`);
  }
}

function assertEqual(actual, expected, message = '') {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}${message ? ` - ${message}` : ''}`);
  }
}

// Test data
const smallData = [
  { id: 1, x: 10, y: 20 },
  { id: 2, x: 30, y: 40 }
];

const expandedData = [
  { id: 1, x: 10, y: 20 },
  { id: 2, x: 30, y: 40 },
  { id: 3, x: 100, y: 150 }  // This extends beyond original bounds
];

const newData = [
  { id: 4, x: 5, y: 5 },
  { id: 5, x: 15, y: 15 }
];

// Test 1: Initial load (no current viewBox)
test('Initial load returns correct viewBox with identity transform', () => {
  const result = getStableViewBoxUpdate(smallData, null, 0.1);
  
  // Should return a viewBox and identity compensating factors
  assertEqual(result.compensatingFactors, { translateX: 0, translateY: 0, scaleX: 1, scaleY: 1 });
  
  // ViewBox should encompass the data with margin
  const [x, y, width, height] = result.newViewBox;
  console.log('Initial viewBox:', result.newViewBox);
});

// Test 2: No expansion needed
test('No expansion needed returns null', () => {
  const initialResult = getStableViewBoxUpdate(smallData, null, 0.1);
  const currentViewBox = initialResult.newViewBox;
  
  // Same data should not need expansion
  const result = getStableViewBoxUpdate(smallData, currentViewBox, 0.1);
  assertEqual(result, null);
});

// Test 3: Expansion needed
test('Expansion needed returns new viewBox and compensating factors', () => {
  const initialResult = getStableViewBoxUpdate(smallData, null, 0.1);
  const currentViewBox = initialResult.newViewBox;
  console.log('Current viewBox before expansion:', currentViewBox);
  
  // Expanded data should trigger expansion
  const result = getStableViewBoxUpdate(expandedData, currentViewBox, 0.1);
  
  if (!result) {
    throw new Error('Expected expansion but got null');
  }
  
  console.log('Expanded viewBox:', result.newViewBox);
  console.log('Compensating factors:', result.compensatingFactors);
  
  // New viewBox should be larger
  const [newX, newY, newWidth, newHeight] = result.newViewBox;
  const [oldX, oldY, oldWidth, oldHeight] = currentViewBox;
  
  if (newWidth <= oldWidth || newHeight <= oldHeight) {
    throw new Error('Expected expanded viewBox to be larger');
  }
});

// Test 4: Completely new data (simulating the bug scenario)
test('Completely new data with existing viewBox', () => {
  const initialResult = getStableViewBoxUpdate(smallData, null, 0.1);
  const currentViewBox = initialResult.newViewBox;
  console.log('Current viewBox:', currentViewBox);
  
  // Completely different data
  const result = getStableViewBoxUpdate(newData, currentViewBox, 0.1);
  
  if (result) {
    console.log('New data viewBox:', result.newViewBox);
    console.log('New data compensating factors:', result.compensatingFactors);
  } else {
    console.log('No expansion needed for new data');
  }
});

// Test shouldApplyCompensatingTransform
console.log('\nRunning tests for shouldApplyCompensatingTransform...\n');

test('No previous data returns false', () => {
  const result = shouldApplyCompensatingTransform(smallData, [], true);
  assertEqual(result, false);
});

test('No previous data (null) returns false', () => {
  const result = shouldApplyCompensatingTransform(smallData, null, true);
  assertEqual(result, false);
});

test('Same data (no position changes) returns true', () => {
  const result = shouldApplyCompensatingTransform(smallData, smallData, false);
  assertEqual(result, true);
});

test('Data expansion (appending dots) returns true', () => {
  const previousData = [
    { id: 1, x: 10, y: 20 },
    { id: 2, x: 30, y: 40 }
  ];
  const appendedData = [
    { id: 1, x: 10, y: 20 },   // Same IDs in same positions
    { id: 2, x: 30, y: 40 },
    { id: 3, x: 100, y: 150 }  // New dot appended
  ];
  
  const result = shouldApplyCompensatingTransform(appendedData, previousData, true);
  assertEqual(result, true, 'Should compensate when appending to dataset');
});

test('Data replacement (completely new dataset) returns false', () => {
  const previousData = [
    { id: 1, x: 10, y: 20 },
    { id: 2, x: 30, y: 40 }
  ];
  const newData = [
    { id: 4, x: 5, y: 5 },     // Different IDs at same positions
    { id: 5, x: 15, y: 15 }
  ];
  
  const result = shouldApplyCompensatingTransform(newData, previousData, true);
  assertEqual(result, false, 'Should NOT compensate when replacing dataset');
});

test('Data with different ID at first position returns false', () => {
  const previousData = [
    { id: 1, x: 10, y: 20 },
    { id: 2, x: 30, y: 40 }
  ];
  const reorderedData = [
    { id: 2, x: 30, y: 40 },   // Different ID at position 0
    { id: 1, x: 10, y: 20 },
    { id: 3, x: 50, y: 60 }
  ];
  
  const result = shouldApplyCompensatingTransform(reorderedData, previousData, true);
  assertEqual(result, false, 'Should NOT compensate when IDs change position');
});

test('Data shrinking (fewer items) returns false', () => {
  const previousData = [
    { id: 1, x: 10, y: 20 },
    { id: 2, x: 30, y: 40 },
    { id: 3, x: 50, y: 60 }
  ];
  const shortenedData = [
    { id: 1, x: 10, y: 20 },
    { id: 2, x: 30, y: 40 }     // One item removed
  ];
  
  const result = shouldApplyCompensatingTransform(shortenedData, previousData, true);
  assertEqual(result, false, 'Should NOT compensate when data gets shorter');
});

console.log('\nRunning tests for getStableViewBoxUpdate...\n');
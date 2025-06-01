# React Dot Visualization

An interactive React component for visualizing data as positioned dots with zoom, pan, and hover interactions. Extracted from the cybird visualization project.

## Features

- **Interactive Dots**: Display data points as SVG circles with customizable size, color, and stroke
- **Zoom & Pan**: Smooth zoom with mouse wheel + ctrl/cmd or trackpad pinch, pan with mouse wheel or trackpad
- **Hover Interactions**: Customizable hover callbacks with automatic debouncing during zoom operations
- **Click Interactions**: Handle dot clicks with custom callbacks
- **Collision Detection**: Optional D3 force simulation to prevent dot overlap
- **Automatic Layout**: Calculates optimal viewBox from data bounds with configurable margins
- **Performance Optimized**: Efficient rendering and interaction handling for large datasets

## Installation

```bash
npm install react-dot-visualization
```

## Basic Usage

```jsx
import React, { useState } from 'react';
import { DotVisualization } from 'react-dot-visualization';

const MyComponent = () => {
  // Just x, y coordinates - that's it!
  const data = [
    { x: 100, y: 150 },
    { x: 200, y: 100 },
    { x: 150, y: 200 }
  ];

  const [hovered, setHovered] = useState(null);

  return (
    <div style={{ width: '100%', height: '400px' }}>
      <DotVisualization 
        data={data} 
        onHover={setHovered} 
      />
      {hovered && <div>Hovering: {hovered.name}</div>}
    </div>
  );
};
```

**That's literally all the code you need!** 

The component automatically provides:
- ✅ **Zoom**: Ctrl/Cmd + mouse wheel or trackpad pinch
- ✅ **Pan**: Mouse wheel or trackpad scroll  
- ✅ **Hover callbacks**: Work during pan/zoom
- ✅ **Collision detection**: Prevents dot overlap
- ✅ **Auto-generated IDs**: No manual ID management
- ✅ **Optimal layout**: Calculates viewBox from data bounds
- ✅ **Beautiful colors**: Generated automatically

## Local Development

### Development Workflow

```bash
# Clone and install dependencies
git clone <your-repo>
cd react-dot-visualization
npm install

# Start development server for testing
npm run dev
# Opens http://localhost:3011 with demo

# Build library for distribution
npm run build:lib

# Link for local development in other projects
npm run link:local
```

### Using in Other Projects

After running `npm run link:local`, you can use the library in other React projects:

```bash
# In your other project
cd ../my-other-project
npm link react-dot-visualization
```

Then import and use normally:
```jsx
import { DotVisualization } from 'react-dot-visualization';
```

### Making Changes

1. **Edit source files** in `src/`
2. **Test changes** with `npm run dev`
3. **Rebuild library** with `npm run build:lib`
4. **Linked projects** automatically get updates

### Testing the Package

To test the built package:

```bash
# Navigate to the package directory
cd react-dot-visualization

# Start development server
npm run dev

# Open in browser  
open http://localhost:3011
```

Test the interactions:
- **Hover**: Move mouse over dots to see hover callbacks
- **Zoom**: Ctrl/Cmd + mouse wheel or trackpad pinch
- **Pan**: Mouse wheel or trackpad scroll
- **Click**: Click dots to test click callbacks

## Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `data` | `Array` | `[]` | Array of data points with `{x, y}` required, optional `{id, size, color, ...customData}` |
| `onHover` | `Function` | - | Callback when hovering over a dot: `(item, event) => {}` |
| `onLeave` | `Function` | - | Callback when leaving a dot: `(item, event) => {}` |
| `onClick` | `Function` | - | Callback when clicking a dot: `(item, event) => {}` |
| `onZoomStart` | `Function` | - | Callback when zoom starts: `(event) => {}` |
| `onZoomEnd` | `Function` | - | Callback when zoom ends: `(event) => {}` |
| `enableCollisionDetection` | `Boolean` | `true` | Enable D3 force simulation to prevent dot overlap |
| `zoomExtent` | `Array` | `[0.7, 10]` | Min/max zoom levels `[min, max]` |
| `margin` | `Number` | `0.1` | Margin around data bounds as fraction (0.1 = 10% margin) |
| `dotStroke` | `String` | `"#111"` | Default stroke color for dots |
| `dotStrokeWidth` | `Number` | `0.2` | Default stroke width for dots |
| `defaultColor` | `String` | `null` | Default color for dots without color property |
| `defaultSize` | `Number` | `2` | Default size for dots without size property |
| `className` | `String` | `""` | CSS class name for the SVG element |
| `style` | `Object` | `{}` | Inline styles for the SVG element |

## Data Format

Each data point should be an object with these properties:

```javascript
{
  id: string | number,    // Required: Unique identifier
  x: number,              // Required: X coordinate
  y: number,              // Required: Y coordinate
  size?: number,          // Optional: Dot radius
  color?: string,         // Optional: Fill color (CSS color value)
  ...customData           // Optional: Any additional properties for your callbacks
}
```

## Advanced Usage

```jsx
import { DotVisualization } from 'react-dot-visualization';

const AdvancedExample = () => {
  const [selectedItem, setSelectedItem] = useState(null);
  
  // Generate data with custom properties
  const data = Array.from({ length: 200 }, (_, i) => ({
    id: i,
    x: Math.random() * 1000,
    y: Math.random() * 1000,
    size: Math.random() * 8 + 2,
    color: `hsl(${i * 137.508}deg, 70%, 50%)`, // Golden angle color distribution
    category: ['A', 'B', 'C'][Math.floor(Math.random() * 3)],
    value: Math.random() * 100
  }));

  return (
    <DotVisualization
      data={data}
      onHover={(item) => console.log(`Hovering: ${item.category} - ${item.value}`)}
      onClick={(item) => setSelectedItem(item)}
      onZoomStart={() => setSelectedItem(null)} // Clear selection on zoom
      enableCollisionDetection={true}
      zoomExtent={[0.5, 20]}
      margin={0.2}
      dotStroke="#333"
      dotStrokeWidth={1}
      style={{ 
        border: '2px solid #ddd',
        borderRadius: '8px'
      }}
    />
  );
};
```

## Browser Support

- Modern browsers with SVG and ES6+ support
- Tested with React 18+

## Dependencies

- `react` (peer dependency)
- `react-dom` (peer dependency)  
- `d3` - For zoom/pan behavior and force simulation
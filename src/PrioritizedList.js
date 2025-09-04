/**
 * Component for rendering children with one prioritized child rendered last (on top)
 * @param {Array} data - Array of data items 
 * @param {*} prioritizedId - ID of the item that should be rendered last (on top)
 * @param {function} getItemId - Function to extract ID from data item (defaults to item => item.id)
 * @param {function} children - Function that takes (item, index) and returns a React element
 */
export const PrioritizedList = ({ data, prioritizedId, getItemId = (item) => item.id, children }) => {
  let prioritizedElement = null;
  
  const elements = data.map((item, index) => {
    const element = children(item, index);
    
    // If this is the prioritized item, store it for later rendering
    if (prioritizedId !== null && getItemId(item) === prioritizedId) {
      prioritizedElement = element;
      return null; // Skip rendering now
    }
    
    return element;
  });
  
  // Add the prioritized element at the end if it exists
  if (prioritizedElement) {
    elements.push(prioritizedElement);
  }
  
  return elements;
};
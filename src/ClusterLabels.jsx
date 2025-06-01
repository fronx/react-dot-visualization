import React, { useMemo } from 'react';

const ClusterLabels = ({
  data = [],
  clusters = [],
  clusterKey = (item) => item.cluster_level_0,
  renderCluster,
  hoveredCluster,
  onClusterHover,
  onClusterLeave,
  className = ''
}) => {
  // Calculate cluster positions based on data point centroids
  const positionedClusters = useMemo(() => {
    if (!data.length || !clusters.length) return [];

    // Group data points by cluster
    const clusterGroups = {};
    data.forEach(item => {
      const clusterId = clusterKey(item);
      if (clusterId === null || clusterId === undefined || clusterId === -1) return;
      
      if (!clusterGroups[clusterId]) {
        clusterGroups[clusterId] = { x: 0, y: 0, count: 0 };
      }
      clusterGroups[clusterId].x += item.x;
      clusterGroups[clusterId].y += item.y;
      clusterGroups[clusterId].count++;
    });

    // Calculate centroid positions for each cluster
    return clusters.map(cluster => {
      const group = clusterGroups[cluster.cluster_number];
      if (!group || group.count === 0) {
        return { ...cluster, x: 0, y: 0, visible: false };
      }

      return {
        ...cluster,
        x: group.x / group.count,
        y: group.y / group.count,
        visible: true
      };
    }).filter(cluster => cluster.visible);
  }, [data, clusters, clusterKey]);

  // Default cluster renderer
  const defaultRenderCluster = (cluster) => (
    <foreignObject
      x={cluster.x}
      y={cluster.y}
      width={1}
      height={1}
      key={`cluster-${cluster.cluster_level}-${cluster.cluster_number}`}
    >
      <div
        xmlns="http://www.w3.org/1999/xhtml"
        className={`cluster-level-${cluster.cluster_level} ${className}`}
        onMouseEnter={() => onClusterHover && onClusterHover(cluster)}
        onMouseLeave={() => onClusterLeave && onClusterLeave()}
      >
        <div
          className={`cluster ${hoveredCluster === cluster.cluster_number ? 'hovered' : ''}`}
        >
          {cluster.caption}
        </div>
      </div>
    </foreignObject>
  );

  const renderer = renderCluster || defaultRenderCluster;

  return (
    <g className="cluster-labels">
      {positionedClusters.map(renderer)}
    </g>
  );
};

export default ClusterLabels;
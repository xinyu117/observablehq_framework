/**
 * 模拟API服务
 * 提供节点和路径的详细数据
 */

// 模拟节点数据
const mockNodeData = {
  'A': {
    id: 'A',
    name: '处理器A',
    type: 'processor',
    status: 'active',
    description: '主处理器单元，负责核心计算任务。具有高性能计算能力，支持多线程处理。',
    connections: [
      { type: '数据总线', target: 'B', id: 'bus-a-b' },
      { type: '控制信号', target: 'C', id: 'ctrl-a-c' },
      { type: '电源线', target: 'PWR', id: 'pwr-a' }
    ],
    specifications: {
      frequency: '3.2 GHz',
      cores: 8,
      cache: '16MB L3',
      power: '95W'
    }
  },
  'B': {
    id: 'B',
    name: '内存控制器B',
    type: 'memory_controller',
    status: 'active',
    description: '内存控制器，管理系统内存访问和数据缓存。优化内存带宽利用率。',
    connections: [
      { type: '内存总线', target: 'RAM1', id: 'mem-b-ram1' },
      { type: '内存总线', target: 'RAM2', id: 'mem-b-ram2' },
      { type: '数据总线', target: 'A', id: 'bus-b-a' }
    ],
    specifications: {
      channels: 4,
      maxMemory: '128GB',
      bandwidth: '76.8 GB/s',
      latency: '60ns'
    }
  },
  'C': {
    id: 'C',
    name: '输入输出控制器C',
    type: 'io_controller',
    status: 'active',
    description: 'I/O控制器，处理外部设备通信和数据传输。支持多种接口协议。',
    connections: [
      { type: 'PCIe', target: 'GPU', id: 'pcie-c-gpu' },
      { type: 'SATA', target: 'SSD', id: 'sata-c-ssd' },
      { type: 'USB', target: 'HUB', id: 'usb-c-hub' }
    ],
    specifications: {
      pcieSlots: 16,
      sataPort: 6,
      usbPorts: 12,
      bandwidth: '32 GB/s'
    }
  }
};

// 模拟路径数据
const mockPathData = {
  'A-X-B': {
    id: 'A-X-B',
    name: '处理器到内存数据通道',
    type: 'data_bus',
    status: 'active',
    description: '高速数据总线，连接处理器和内存控制器。采用DDR4协议，支持双向数据传输。',
    bandwidth: '25.6 GB/s',
    protocol: 'DDR4-3200',
    metrics: {
      latency: '45ns',
      throughput: '23.2 GB/s',
      errorRate: '0.001%'
    },
    routes: [
      { from: 'A', to: 'B', weight: 1, distance: '5cm' },
      { from: 'B', to: 'A', weight: 1, distance: '5cm' }
    ]
  },
  'B-X-C': {
    id: 'B-X-C',
    name: '内存到I/O控制通道',
    type: 'control_bus',
    status: 'active',
    description: '控制总线，用于内存控制器和I/O控制器之间的命令传输和状态同步。',
    bandwidth: '8.0 GB/s',
    protocol: 'PCIe 4.0',
    metrics: {
      latency: '120ns',
      throughput: '7.8 GB/s',
      errorRate: '0.002%'
    },
    routes: [
      { from: 'B', to: 'C', weight: 2, distance: '8cm' },
      { from: 'C', to: 'B', weight: 2, distance: '8cm' }
    ]
  },
  'A-X-C': {
    id: 'A-X-C',
    name: '处理器到I/O直连通道',
    type: 'direct_link',
    status: 'standby',
    description: '处理器到I/O控制器的直连通道，用于紧急情况下的直接通信。通常处于待机状态。',
    bandwidth: '16.0 GB/s',
    protocol: 'PCIe 5.0',
    metrics: {
      latency: '80ns',
      throughput: '0.1 GB/s',
      errorRate: '0.000%'
    },
    routes: [
      { from: 'A', to: 'C', weight: 3, distance: '12cm' }
    ]
  }
};

// 添加更多模拟数据
const additionalNodes = ['D', 'E', 'F', 'G', 'H'];
additionalNodes.forEach((id, index) => {
  mockNodeData[id] = {
    id: id,
    name: `节点 ${id}`,
    type: ['sensor', 'actuator', 'controller', 'interface', 'power'][index % 5],
    status: Math.random() > 0.2 ? 'active' : 'inactive',
    description: `这是节点 ${id} 的详细描述。它在系统中扮演重要角色，负责特定的功能模块。`,
    connections: [
      { type: '数据线', target: additionalNodes[(index + 1) % additionalNodes.length] },
      { type: '电源线', target: 'PWR' }
    ]
  };
});

/**
 * 模拟API延迟
 */
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * 获取节点详细信息
 * @param {string} nodeId 节点ID
 * @returns {Promise<Object>} 节点数据
 */
export async function fetchNodeData(nodeId) {
  // 模拟网络延迟
  await delay(Math.random() * 800 + 200);
  
  const data = mockNodeData[nodeId];
  if (!data) {
    throw new Error(`Node ${nodeId} not found`);
  }
  
  return {
    ...data,
    lastUpdated: new Date().toISOString(),
    responseTime: Math.random() * 500 + 100
  };
}

/**
 * 获取路径详细信息
 * @param {string} pathId 路径ID
 * @returns {Promise<Object>} 路径数据
 */
export async function fetchPathData(pathId) {
  // 模拟网络延迟
  await delay(Math.random() * 600 + 300);
  
  const data = mockPathData[pathId];
  if (!data) {
    throw new Error(`Path ${pathId} not found`);
  }
  
  return {
    ...data,
    lastUpdated: new Date().toISOString(),
    responseTime: Math.random() * 400 + 150
  };
}

/**
 * 批量获取节点数据
 * @param {string[]} nodeIds 节点ID数组
 * @returns {Promise<Object[]>} 节点数据数组
 */
export async function fetchMultipleNodes(nodeIds) {
  await delay(Math.random() * 1000 + 500);
  
  return Promise.all(nodeIds.map(async (id) => {
    try {
      return await fetchNodeData(id);
    } catch (error) {
      return {
        id,
        error: error.message,
        status: 'error'
      };
    }
  }));
}

/**
 * 批量获取路径数据
 * @param {string[]} pathIds 路径ID数组
 * @returns {Promise<Object[]>} 路径数据数组
 */
export async function fetchMultiplePaths(pathIds) {
  await delay(Math.random() * 1000 + 500);
  
  return Promise.all(pathIds.map(async (id) => {
    try {
      return await fetchPathData(id);
    } catch (error) {
      return {
        id,
        error: error.message,
        status: 'error'
      };
    }
  }));
}

/**
 * 搜索节点
 * @param {string} query 搜索关键词
 * @returns {Promise<Object[]>} 搜索结果
 */
export async function searchNodes(query) {
  await delay(300);
  
  const results = Object.values(mockNodeData).filter(node => 
    node.name.toLowerCase().includes(query.toLowerCase()) ||
    node.type.toLowerCase().includes(query.toLowerCase()) ||
    node.description.toLowerCase().includes(query.toLowerCase())
  );
  
  return results.slice(0, 10); // 限制返回结果数量
}

/**
 * 获取系统状态概览
 * @returns {Promise<Object>} 系统状态
 */
export async function getSystemStatus() {
  await delay(200);
  
  const totalNodes = Object.keys(mockNodeData).length;
  const activeNodes = Object.values(mockNodeData).filter(n => n.status === 'active').length;
  const totalPaths = Object.keys(mockPathData).length;
  const activePaths = Object.values(mockPathData).filter(p => p.status === 'active').length;
  
  return {
    timestamp: new Date().toISOString(),
    nodes: {
      total: totalNodes,
      active: activeNodes,
      inactive: totalNodes - activeNodes
    },
    paths: {
      total: totalPaths,
      active: activePaths,
      standby: totalPaths - activePaths
    },
    systemHealth: 'good'
  };
} 
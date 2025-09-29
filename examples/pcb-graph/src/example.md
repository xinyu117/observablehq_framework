# PCB Graph 对话框示例

这个示例展示了如何使用重构后的对话框系统，支持通过API获取详细数据。

## 功能特性

### 🎯 **独立组件架构**
- **NodeDialog.jsx**: 节点信息对话框组件
- **PathDialog.jsx**: 路径信息对话框组件  
- **DialogManager.js**: 对话框管理器
- **mockApi.js**: 模拟API服务

### 📡 **API数据获取**
- 点击节点/路径时通过ID从API获取详细数据
- 支持加载状态、错误处理和数据缓存
- 模拟真实的网络延迟和响应

### 🎨 **用户体验优化**
- 加载动画和进度指示
- 优雅的错误处理
- 键盘快捷键支持 (ESC关闭)
- 点击遮罩层关闭
- 防止页面滚动

## 使用方法

```javascript
import { renderChart, renderInteractiveChart } from "./components/chart_svgjs.js";
import { dialogManager } from "./components/DialogManager.js";

// 基础版本（带点击弹窗）
const chart = renderChart(data, options);

// 交互增强版本（带悬停效果 + 点击弹窗）
const interactiveChart = renderInteractiveChart(data, options);

// 程序化控制对话框
dialogManager.showNodeDialog('A');      // 显示节点A的详情
dialogManager.showPathDialog('A-X-B');  // 显示路径详情
dialogManager.close();                  // 关闭对话框
```

## 图表演示

```js
import { renderInteractiveChart } from "./components/chart_svgjs.js";

// 示例数据
const data = [
  [
    { id: "A", parents: [] }
  ],
  [
    { id: "B", parents: [{ id: "A" }] },
    { id: "C", parents: [{ id: "A" }] }
  ],
  [
    { id: "D", parents: [{ id: "B" }, { id: "C" }] }
  ]
];

// 渲染交互式图表
const chart = renderInteractiveChart(data, {
  color: (d, i) => ["#1f77b4", "#ff7f0e", "#2ca02c", "#d62728"][i % 4]
});

display(chart);
```

## API 数据结构

### 节点数据示例
```json
{
  "id": "A",
  "name": "处理器A", 
  "type": "processor",
  "status": "active",
  "description": "主处理器单元，负责核心计算任务...",
  "connections": [
    { "type": "数据总线", "target": "B", "id": "bus-a-b" }
  ],
  "specifications": {
    "frequency": "3.2 GHz",
    "cores": 8,
    "cache": "16MB L3",
    "power": "95W"
  }
}
```

### 路径数据示例
```json
{
  "id": "A-X-B",
  "name": "处理器到内存数据通道",
  "type": "data_bus", 
  "status": "active",
  "description": "高速数据总线，连接处理器和内存控制器...",
  "bandwidth": "25.6 GB/s",
  "protocol": "DDR4-3200",
  "metrics": {
    "latency": "45ns",
    "throughput": "23.2 GB/s", 
    "errorRate": "0.001%"
  },
  "routes": [
    { "from": "A", "to": "B", "weight": 1, "distance": "5cm" }
  ]
}
```

## 对话框功能

### 节点对话框 🔵
- **基本信息**: ID, 名称, 类型, 状态
- **详细描述**: 功能说明和技术规格
- **连接信息**: 显示所有相关连接
- **实时状态**: 从API获取最新状态

### 路径对话框 🔶  
- **基本信息**: ID, 名称, 类型, 状态, 带宽, 协议
- **性能指标**: 延迟, 吞吐量, 错误率 (可视化显示)
- **路由信息**: 详细的路由路径和权重
- **实时监控**: 动态更新性能数据

## 交互操作

- **点击节点**: 弹出节点详情对话框
- **点击路径**: 弹出路径详情对话框  
- **ESC键**: 关闭当前对话框
- **点击遮罩**: 关闭当前对话框
- **鼠标悬停**: 高亮显示 (交互版本)

## 技术实现

### 组件设计
```
DialogManager
├── NodeDialog (React组件)
│   ├── 加载状态管理
│   ├── API数据获取
│   └── 错误处理
├── PathDialog (React组件) 
│   ├── 性能指标可视化
│   ├── 路由信息展示
│   └── 状态颜色编码
└── 全局事件管理
    ├── 键盘事件
    ├── 遮罩点击
    └── 页面滚动控制
```

### API集成
- 异步数据获取
- 加载状态指示
- 错误边界处理
- 数据缓存优化

这个重构后的系统提供了更好的代码组织、更丰富的功能和更好的用户体验！ 
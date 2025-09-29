# 可折叠树形图演示

```js
import { CollapsibleTree, generateTestData, createCollapsibleTree } from "./components/collapsible_tree.js";
```

## 🌳 交互式可折叠树形图（纵向布局）

### 功能特性：
- **可折叠交互**：点击节点下方的蓝色+/-按钮展开/收缩子节点
- **详细信息对话框**：点击节点线条查看节点详情，点击连接线查看路径详情  
- **拖拽重组**：按住节点不放可以拖拽节点到其他节点下，重新组织树结构
- **专业样式**：采用chart_svgjs.js的双重描边和配色方案
- **居中布局**：整个树形图在容器中水平居中显示

### 拖拽使用说明：
1. 按住任意节点不放开始拖拽
2. 拖拽时会显示半透明的节点预览（包括其子节点）
3. 可放置的目标节点会高亮显示红色边框
4. 将节点拖拽到目标节点上松开鼠标完成移动
5. 拖拽完成后，新的树结构会输出到浏览器控制台

<div id="collapsible-tree" style="border: 1px solid #ddd; border-radius: 8px; overflow: auto; background: white;"></div>

```js
// 生成测试数据
const treeData = generateTestData();

// 创建可折叠树形图（纵向布局）
const tree = new CollapsibleTree(
  document.getElementById("collapsible-tree"),
  treeData,
  {
    width: 1000,
    height: 800,
    nodeRadius: 22,
    nodeSpacing: 80,   // 纵向：同级节点水平间距
    levelSpacing: 100  // 纵向：层级垂直间距
  }
);

// 添加控制按钮
const controlsDiv = document.createElement('div');
controlsDiv.style.cssText = `
  margin: 20px 0;
  padding: 15px;
  background: #f8f9fa;
  border-radius: 8px;
  text-align: center;
`;

const expandAllBtn = document.createElement('button');
expandAllBtn.textContent = '🌳 展开所有';
expandAllBtn.style.cssText = `
  margin: 0 10px;
  padding: 8px 16px;
  background: #4CAF50;
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 14px;
`;
expandAllBtn.onclick = () => tree.expandAll();

const collapseAllBtn = document.createElement('button');
collapseAllBtn.textContent = '📁 收缩所有';
collapseAllBtn.style.cssText = `
  margin: 0 10px;
  padding: 8px 16px;
  background: #FF9800;
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 14px;
`;
collapseAllBtn.onclick = () => tree.collapseAll();

controlsDiv.appendChild(expandAllBtn);
controlsDiv.appendChild(collapseAllBtn);

// 将控制按钮插入到树形图前面
document.getElementById("collapsible-tree").parentNode.insertBefore(
  controlsDiv, 
  document.getElementById("collapsible-tree")
);
```

```js
// 显示测试数据结构
display({
  title: "测试数据结构",
  totalNodes: countNodes(treeData),
  maxDepth: getMaxDepth(treeData),
  dataPreview: treeData
});

function countNodes(node) {
  let count = 1;
  if (node.children) {
    node.children.forEach(child => {
      count += countNodes(child);
    });
  }
  return count;
}

function getMaxDepth(node, depth = 0) {
  if (!node.children || node.children.length === 0) {
    return depth;
  }
  return Math.max(...node.children.map(child => getMaxDepth(child, depth + 1)));
}
```

## 📖 功能说明

### 🎯 **主要功能**
- **可折叠节点**：点击节点下方的 ➕/➖ 按钮展开或收缩子节点
- **节点对话框**：点击节点线条查看详细信息（坐标、层级、子节点等）
- **连线对话框**：点击连接线查看路径信息（长度、坐标等）
- **全局控制**：展开所有/收缩所有按钮

### 🎨 **视觉设计**
- **节点样式**：黑白双重线条节点，参照原始图表样式
- **展开按钮**：蓝色圆形按钮，位于节点下方，显示 ➕ 或 ➖ 符号
- **连接线**：彩色双重描边线条，白色背景+彩色前景
- **纵向布局**：从上到下的树形结构，支持滚动查看

### 🔧 **交互操作**
1. **展开/收缩**：点击节点下方的蓝色按钮
2. **查看节点详情**：点击节点线条区域
3. **查看连线详情**：点击任意连接线
4. **全局操作**：使用顶部的展开/收缩所有按钮

### 📊 **数据结构**
- **根节点**：系统起点，包含3个主分支
- **分支节点**：包含多个叶子节点
- **叶子节点**：可能包含子叶节点
- **多层嵌套**：支持任意深度的层级结构

### 🚀 **技术特点**
- 使用 **SVG.js** 进行图形渲染
- 动态布局计算，自适应节点数量
- 状态管理，记录展开/收缩状态
- 集成现有的 **NodeDialog** 和 **PathDialog** 组件
- 平滑的交互体验和视觉反馈 
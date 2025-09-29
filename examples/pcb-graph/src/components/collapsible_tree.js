import * as d3 from "npm:d3";
import SVG from "npm:svg.js";
import { dialogManager } from "./DialogManager.js";

/**
 * 可折叠树形图表
 */
export class CollapsibleTree {
  constructor(container, data, options = {}) {
    this.container = container;
    this.originalData = data;
    this.options = {
      width: 800,
      height: 600,
      nodeRadius: 15,
      nodeSpacing: 60,  // 纵向节点间距
      levelSpacing: 80, // 纵向层级间距
      draggable: true,  // 是否启用拖拽功能
      ...options
    };
    
    // 参照 chart_svgjs.js 的颜色方案
    this.colorScale = d3.scaleOrdinal(d3.schemeDark2);
    this.backgroundColor = 'white';
    this.strokeWidth = 5;
    
    // 拖拽相关状态
    this.dragState = {
      isDragging: false,
      dragNode: null,
      dragNodeGroup: null,
      dragOffset: { x: 0, y: 0 },
      originalPosition: { x: 0, y: 0 },
      ghostGroup: null,
      dropTarget: null
    };
    
    // 初始化SVG
    this.svg = SVG(container).size(this.options.width, this.options.height);
    this.svg.rect(this.options.width, this.options.height).fill(this.backgroundColor);
    
    // 添加样式
    this.addStyles();
    
    // 处理数据并初始化状态
    this.processData();
    
    // 渲染树形图
    this.render();
  }

  addStyles() {
    const style = this.svg.defs().element('style');
    style.node.textContent = `
      text {
        font-family: sans-serif;
        font-size: 10px;
      }
      .tree-node {
        cursor: pointer;
        stroke-linecap: round;
      }
      .tree-node:hover .node-circle {
        fill: #e3f2fd !important;
        stroke-width: 3;
      }
      .tree-link {
        cursor: pointer;
        fill: none;
        stroke-linecap: round;
      }
      .tree-link:hover {
        stroke-width: 4 !important;
      }
      .expand-button {
        cursor: pointer;
        user-select: none;
      }
      .expand-button:hover {
        fill: #2196F3;
      }
      .node-text {
        font-family: sans-serif;
        font-size: 10px;
        font-weight: normal;
        pointer-events: none;
        user-select: none;
      }
      .expand-text {
        font-family: monospace;
        font-size: 12px;
        font-weight: bold;
        text-anchor: middle;
        dominant-baseline: middle;
        pointer-events: auto;
        user-select: none;
        cursor: pointer;
      }
      .dragging {
        opacity: 0.5;
        pointer-events: none;
      }
      .drop-target {
        stroke: #ff6b6b !important;
        stroke-width: 3 !important;
        filter: drop-shadow(0 0 8px rgba(255, 107, 107, 0.6));
      }
      .drag-ghost {
        opacity: 0.7;
        pointer-events: none;
      }
    `;
  }

  processData() {
    // 为每个节点添加状态信息
    const addState = (node, parent = null, level = 0) => {
      // 根节点展开，其他节点默认收缩
      node._expanded = (level === 0) ? true : false;
      node._level = level;
      node._parent = parent;
      node._id = node.id || `node_${Math.random().toString(36).substr(2, 9)}`;
      
      if (node.children && node.children.length > 0) {
        node._hasChildren = true;
        node.children.forEach(child => addState(child, node, level + 1));
      } else {
        node._hasChildren = false;
      }
      
      return node;
    };

    this.data = addState(JSON.parse(JSON.stringify(this.originalData)));
  }

  calculateLayout() {
    const nodes = [];
    const links = [];
    
    // 第一步：计算每个节点需要的子树宽度
    const calculateSubtreeWidth = (node) => {
      if (!node._expanded || !node.children || node.children.length === 0) {
        return this.options.nodeSpacing; // 叶子节点的宽度
      }
      
      let totalChildrenWidth = 0;
      node.children.forEach(child => {
        totalChildrenWidth += calculateSubtreeWidth(child);
      });
      
      // 节点的宽度是其所有子节点宽度的总和，但至少是一个节点间距
      return Math.max(totalChildrenWidth, this.options.nodeSpacing);
    };
    
    // 第二步：为每个节点分配X坐标，确保不同父节点的子树不重叠
    const assignPositions = (node, startX, y, parentPos = null) => {
      // 计算当前节点的子树总宽度
      const subtreeWidth = calculateSubtreeWidth(node);
      
      // 当前节点位于其子树的中心
      const nodeX = startX + subtreeWidth / 2;
      const nodePos = { x: nodeX, y };
      
      // 为节点设置位置
      node.x = nodeX;
      node.y = y;
      nodes.push(node);
      
      // 如果有父节点，添加连线
      if (parentPos) {
        links.push({
          id: `link_${node._parent._id}_${node._id}`,
          source: parentPos,
          target: nodePos,
          sourceNode: node._parent,
          targetNode: node
        });
      }
      
      // 处理子节点
      if (node._expanded && node.children && node.children.length > 0) {
        let currentX = startX;
        const childY = y + this.options.levelSpacing;
        
        node.children.forEach(child => {
          const childSubtreeWidth = calculateSubtreeWidth(child);
          assignPositions(child, currentX, childY, nodePos);
          currentX += childSubtreeWidth; // 下一个子节点从当前位置后开始
        });
      }
    };
    
    // 第三步：计算根节点的起始位置，使整个树居中
    const totalTreeWidth = calculateSubtreeWidth(this.data);
    const centerX = this.options.width / 2;
    const startX = centerX - totalTreeWidth / 2;
    
    // 开始布局
    assignPositions(this.data, startX, 80);
    
    return { nodes, links };
  }

  render() {
    // 清除之前的内容
    this.svg.clear();
    this.svg.rect(this.options.width, this.options.height).fill(this.backgroundColor);
    this.addStyles();
    
    console.log('Rendering tree, root expanded:', this.data._expanded);
    const { nodes, links } = this.calculateLayout();
    
    // 绘制连线 - 参照 chart_svgjs.js 的样式
    const linkGroup = this.svg.group().addClass('links');
    links.forEach((link, i) => {
      // 纵向连线路径：从父节点底部到子节点顶部
      const pathData = `M${link.source.x} ${link.source.y + this.options.nodeRadius}
                        L${link.target.x} ${link.target.y - this.options.nodeRadius}`;
      
      // 背景路径（白色描边）
      linkGroup.path(pathData)
        .addClass('tree-link')
        .fill('none')
        .stroke(this.backgroundColor)
        .attr('stroke-width', this.strokeWidth);
      
      // 前景路径（彩色描边）
      linkGroup.path(pathData)
        .addClass('tree-link')
        .fill('none')
        .stroke(this.colorScale(i))
        .attr('stroke-width', 2)
        .click((e) => {
          e.stopPropagation();
          // 创建路径数据对象
          const pathData = {
            id: link.id,
            source: link.sourceNode,
            target: link.targetNode,
            coordinates: {
              x1: link.source.x,
              y1: link.source.y,
              x2: link.target.x,
              y2: link.target.y
            },
            length: Math.sqrt(
              Math.pow(link.target.x - link.source.x, 2) + 
              Math.pow(link.target.y - link.source.y, 2)
            )
          };
          dialogManager.showPathDialog(pathData);
        });
    });
    
    // 绘制节点 - 参照 chart_svgjs.js 的样式
    const nodeGroup = this.svg.group().addClass('nodes');
    this.nodeGroups = []; // 存储节点组引用用于拖拽功能
    
    nodes.forEach(node => {
      const singleNodeGroup = nodeGroup.group().addClass('tree-node');
      singleNodeGroup.nodeId = node._id; // 存储节点ID用于匹配
      this.nodeGroups.push(singleNodeGroup); // 存储引用
      
      // 节点的黑色描边
      singleNodeGroup.line(node.x, node.y - this.options.nodeRadius, node.x, node.y + this.options.nodeRadius)
          .addClass('selectable node')
          .attr('data-id', node._id)
          .stroke('black')
          .attr('stroke-width', 8);

      // 节点的白色描边
      singleNodeGroup.line(node.x, node.y - this.options.nodeRadius, node.x, node.y + this.options.nodeRadius)
          .addClass('node')
          .stroke('white')
          .attr('stroke-width', 4);

      // 节点标签的背景描边
      const textBg = singleNodeGroup.text(node.name || node._id)
          .addClass('selectable')
          .attr('data-id', node._id)
          .move(node.x + 4, node.y - this.options.nodeRadius - 16)
          .stroke(this.backgroundColor)
          .attr('stroke-width', 2);

      // 节点标签的前景文本
      const textFg = singleNodeGroup.text(node.name || node._id)
          .move(node.x + 4, node.y - this.options.nodeRadius - 16)
          .attr('style', 'pointer-events: none');
      
      // 为节点线条添加点击事件
      const blackLine = singleNodeGroup.children().find(child => 
        child.hasClass && child.hasClass('selectable') && child.hasClass('node')
      );
      const whiteLine = singleNodeGroup.children().find(child => 
        child.hasClass && child.hasClass('node') && !child.hasClass('selectable')
      );
      
      [blackLine, whiteLine].forEach(line => {
        if (line) {
          line.click((e) => {
            e.stopPropagation();
            // 创建节点数据对象，包含坐标信息
            const nodeData = {
              ...node,
              coordinates: {
                x: node.x,
                y: node.y
              },
              geometry: {
                level: node._level,
                hasChildren: node._hasChildren,
                expanded: node._expanded
              },
              children: node.children || [],
              parent: node._parent
            };
            dialogManager.showNodeDialog(nodeData);
          });
        }
      });
      
      // 添加拖拽功能（如果启用）
      if (this.options.draggable) {
        this.addDragBehavior(singleNodeGroup, node);
      }
      
      // 如果有子节点，添加展开/收缩按钮（纵向布局：放在节点下方）
      if (node._hasChildren) {
        const buttonX = node.x;
        const buttonY = node.y + this.options.nodeRadius + 20;
        
        // 按钮背景圆形
        const buttonBg = singleNodeGroup.circle(16)
          .center(buttonX, buttonY)
          .fill('#2196F3')
          .stroke('#1976D2')
          .attr('stroke-width', 1)
          .addClass('expand-button');
        
        // 按钮文本 (+/-)
        const buttonText = singleNodeGroup.text(node._expanded ? '−' : '+')
          .center(buttonX, buttonY)
          .addClass('expand-text')
          .fill('white')
          .attr('style', 'pointer-events: auto; cursor: pointer;');
        
        // 按钮点击事件 - 分别为背景和文本添加点击事件
        buttonBg.click((e) => {
          e.stopPropagation();
          console.log('Button background clicked for node:', node._id || node.name);
          this.toggleNode(node);
        });
        
        buttonText.click((e) => {
          e.stopPropagation();
          console.log('Button text clicked for node:', node._id || node.name);
          this.toggleNode(node);
        });
      }
    });
  }

  toggleNode(node) {
    console.log(`Toggling node ${node._id || node.name}: ${node._expanded} -> ${!node._expanded}`);
    node._expanded = !node._expanded;
    
    // 验证状态是否真的改变了
    console.log(`After toggle, node ${node._id || node.name} expanded:`, node._expanded);
    console.log('Root node expanded:', this.data._expanded);
    
    this.render(); // 重新渲染
  }

  // 展开所有节点
  expandAll() {
    const expandRecursive = (node) => {
      node._expanded = true;
      if (node.children) {
        node.children.forEach(expandRecursive);
      }
    };
    expandRecursive(this.data);
    this.render();
  }

  // 收缩所有节点
  collapseAll() {
    const collapseRecursive = (node) => {
      node._expanded = false;
      if (node.children) {
        node.children.forEach(collapseRecursive);
      }
    };
    collapseRecursive(this.data);
    this.render();
  }

  // 获取SVG元素
  getElement() {
    return this.svg.node;
  }
  
  // 拖拽功能相关方法
  addDragBehavior(nodeGroup, node) {
    console.log('添加拖拽行为到节点:', node._id);
    let startPos = { x: 0, y: 0 };
    let isDragStarted = false;
    
    nodeGroup
      .style('cursor', 'grab')
      .on('mousedown', (e) => {
        console.log('mousedown 事件触发，节点:', node._id, 'isDragging:', this.dragState.isDragging);
        e.preventDefault();
        e.stopPropagation();
        
        // 如果已经在拖拽中，忽略新的拖拽请求
        if (this.dragState.isDragging) {
          console.log('已经在拖拽中，忽略新的拖拽请求');
          return;
        }
        
        startPos = { x: e.clientX, y: e.clientY };
        isDragStarted = false;
        
        const onMouseMove = (e) => {
          const dx = e.clientX - startPos.x;
          const dy = e.clientY - startPos.y;
          
          // 开始拖拽的阈值（避免误触发）
          if (!isDragStarted && (Math.abs(dx) > 5 || Math.abs(dy) > 5)) {
            isDragStarted = true;
            this.startDrag(node, nodeGroup, startPos);
          }
          
          if (isDragStarted) {
            this.updateDrag(e.clientX, e.clientY);
          }
        };
        
        const onMouseUp = () => {
          console.log('onMouseUp 被调用, isDragStarted:', isDragStarted, 'this.dragState.isDragging:', this.dragState.isDragging);
          if (isDragStarted) {
            this.endDrag();
          }
          document.removeEventListener('mousemove', onMouseMove);
          document.removeEventListener('mouseup', onMouseUp);
          nodeGroup.style('cursor', 'grab');
          console.log('事件监听器已移除，光标已重置');
        };
        
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
        nodeGroup.style('cursor', 'grabbing');
      });
  }
  
  startDrag(node, nodeGroup, startPos) {
    console.log('开始拖拽节点:', node.name || node._id);
    
    this.dragState.isDragging = true;
    this.dragState.dragNode = node;
    this.dragState.dragNodeGroup = nodeGroup; // 保存被拖拽的节点组引用
    this.dragState.originalPosition = { x: node.x, y: node.y };
    
    // 获取SVG容器的边界矩形，用于坐标转换
    const svgRect = this.svg.node.getBoundingClientRect();
    this.dragState.dragOffset = {
      x: startPos.x - svgRect.left - node.x,
      y: startPos.y - svgRect.top - node.y
    };
    
    // 创建拖拽中的视觉效果
    nodeGroup.addClass('dragging');
    
    // 创建拖拽幽灵元素
    this.createDragGhost(node);
    
    // 高亮可能的放置目标
    this.highlightDropTargets(node);
  }
  
  updateDrag(clientX, clientY) {
    if (!this.dragState.isDragging || !this.dragState.ghostGroup) return;
    
    // 获取SVG容器的边界矩形
    const svgRect = this.svg.node.getBoundingClientRect();
    const svgX = clientX - svgRect.left - this.dragState.dragOffset.x;
    const svgY = clientY - svgRect.top - this.dragState.dragOffset.y;
    
    // 移动幽灵元素
    this.dragState.ghostGroup.transform({ translateX: svgX - this.dragState.originalPosition.x, translateY: svgY - this.dragState.originalPosition.y });
    
    // 检测放置目标
    this.detectDropTarget(svgX, svgY);
  }
  
  endDrag() {
    console.log('结束拖拽, 当前状态:', {
      isDragging: this.dragState.isDragging,
      dragNode: this.dragState.dragNode ? this.dragState.dragNode._id : null,
      dropTarget: this.dragState.dropTarget ? this.dragState.dropTarget._id : null
    });
    
    if (this.dragState.dropTarget) {
      this.performDrop();
    } else {
      // 拖拽失败，恢复节点到原始位置
      console.log('拖拽失败，恢复节点位置');
      this.restoreNodePosition();
    }
    
    this.cleanupDrag();
  }
  
  createDragGhost(node) {
    this.dragState.ghostGroup = this.svg.group().addClass('drag-ghost');
    
    // 递归创建被拖拽节点及其子树的幽灵元素
    const createGhostNode = (n, offsetX = 0, offsetY = 0) => {
      // 节点线条
      this.dragState.ghostGroup.line(
        n.x + offsetX, n.y - this.options.nodeRadius + offsetY, 
        n.x + offsetX, n.y + this.options.nodeRadius + offsetY
      ).stroke('rgba(0,0,0,0.3)').attr('stroke-width', 6);
      
      // 节点标签
      this.dragState.ghostGroup.text(n.name || n._id)
        .move(n.x + 4 + offsetX, n.y - this.options.nodeRadius - 16 + offsetY)
        .fill('rgba(0,0,0,0.5)');
      
      // 递归处理展开的子节点
      if (n._expanded && n.children) {
        n.children.forEach(child => {
          // 绘制连接线
          this.dragState.ghostGroup.line(
            n.x + offsetX, n.y + this.options.nodeRadius + offsetY,
            child.x + offsetX, child.y - this.options.nodeRadius + offsetY
          ).stroke('rgba(0,0,0,0.2)').attr('stroke-width', 2);
          
          createGhostNode(child, offsetX, offsetY);
        });
      }
    };
    
    createGhostNode(node);
  }
  
  highlightDropTargets(dragNode) {
    // 遍历所有节点，高亮可以作为放置目标的节点
    const highlightNode = (n) => {
      if (n !== dragNode && !this.isDescendantOf(n, dragNode)) {
        // 找到对应的SVG元素并高亮
        if (this.nodeGroups) {
          this.nodeGroups.forEach(group => {
            if (group.nodeId === n._id) {
              group.addClass('drop-target-candidate');
            }
          });
        }
      }
      
      if (n.children) {
        n.children.forEach(highlightNode);
      }
    };
    
    highlightNode(this.data);
  }
  
  detectDropTarget(x, y) {
    // 清除之前的放置目标高亮 - 使用存储的节点组引用
    if (this.nodeGroups) {
      this.nodeGroups.forEach(group => {
        group.removeClass('drop-target');
      });
    }
    
    this.dragState.dropTarget = null;
    
    // 检测鼠标位置下的节点
    const nodes = this.getAllVisibleNodes();
    for (let node of nodes) {
      if (node === this.dragState.dragNode) continue;
      if (this.isDescendantOf(node, this.dragState.dragNode)) continue;
      
      const distance = Math.sqrt((x - node.x) ** 2 + (y - node.y) ** 2);
      if (distance < this.options.nodeRadius + 20) { // 20px 的放置区域
        this.dragState.dropTarget = node;
        
        // 高亮放置目标 - 通过节点ID匹配
        if (this.nodeGroups) {
          this.nodeGroups.forEach(group => {
            if (group.nodeId === node._id) {
              group.addClass('drop-target');
            }
          });
        }
        break;
      }
    }
  }
  
  performDrop() {
    const dragNode = this.dragState.dragNode;
    const dropTarget = this.dragState.dropTarget;
    
    console.log(`将节点 ${dragNode.name || dragNode._id} 移动到 ${dropTarget.name || dropTarget._id} 下`);
    
    // 记录原父节点
    const originalParent = dragNode._parent;
    
    // 从原父节点中移除
    if (dragNode._parent) {
      const parentChildren = dragNode._parent.children || [];
      const index = parentChildren.indexOf(dragNode);
      if (index > -1) {
        parentChildren.splice(index, 1);
      }
    } else {
      // 如果是根节点，需要特殊处理（这里暂时不允许移动根节点）
      console.warn('不能移动根节点');
      return;
    }
    
    // 检查原父节点是否还有子节点，如果没有则更新其状态
    if (originalParent) {
      const remainingChildren = originalParent.children || [];
      if (remainingChildren.length === 0) {
        // 没有子节点了，更新 _hasChildren 状态
        originalParent._hasChildren = false;
        // 将 _expanded 设为 false，因为没有子节点可展开
        originalParent._expanded = false;
        console.log(`原父节点 ${originalParent.name || originalParent._id} 已无子节点，移除展开按钮`);
      }
    }
    
    // 添加到新父节点
    if (!dropTarget.children) {
      dropTarget.children = [];
    }
    dropTarget.children.push(dragNode);
    dragNode._parent = dropTarget;
    
    // 确保新父节点展开以显示新添加的子节点
    dropTarget._expanded = true;
    dropTarget._hasChildren = true;
    
    // 重新计算布局并渲染
    this.render();
    
    // 输出新的树结构到控制台
    console.log('更新后的树结构:', JSON.stringify(this.data, (key, value) => {
      // 避免循环引用，不输出 _parent 属性
      if (key === '_parent') return undefined;
      return value;
    }, 2));
  }
  
  restoreNodePosition() {
    // 拖拽失败时，需要重新绑定事件监听器，因为原来的监听器在onMouseUp中被移除了
    console.log('拖拽失败，重新绑定事件监听器');
    
    // 重新为所有节点绑定拖拽行为
    if (this.options.draggable && this.nodeGroups) {
      const nodes = this.getAllVisibleNodes();
      this.nodeGroups.forEach((group, index) => {
        if (nodes[index]) {
          // 先移除旧的事件监听器，避免重复绑定
          group.off('mousedown');
          this.addDragBehavior(group, nodes[index]);
        }
      });
    }
  }
  
  cleanupDrag() {
    console.log('cleanupDrag 被调用，当前拖拽状态:', this.dragState.isDragging);
    
    // 清理被拖拽节点的样式
    if (this.dragState.dragNodeGroup) {
      this.dragState.dragNodeGroup.removeClass('dragging');
      console.log('已移除被拖拽节点的 dragging 样式');
    }
    
    // 清理所有节点的放置目标样式
    if (this.nodeGroups) {
      this.nodeGroups.forEach(group => {
        group.removeClass('drop-target drop-target-candidate');
      });
    }
    
    if (this.dragState.ghostGroup) {
      this.dragState.ghostGroup.remove();
    }
    
    this.dragState = {
      isDragging: false,
      dragNode: null,
      dragNodeGroup: null,
      dragOffset: { x: 0, y: 0 },
      originalPosition: { x: 0, y: 0 },
      ghostGroup: null,
      dropTarget: null
    };
    console.log('拖拽状态已重置:', this.dragState.isDragging);
  }
  
  // 辅助方法：检查节点A是否是节点B的后代
  isDescendantOf(nodeA, nodeB) {
    if (!nodeB.children) return false;
    
    for (let child of nodeB.children) {
      if (child === nodeA) return true;
      if (this.isDescendantOf(nodeA, child)) return true;
    }
    return false;
  }
  
  // 辅助方法：获取所有可见节点
  getAllVisibleNodes() {
    const nodes = [];
    
    const traverse = (node) => {
      nodes.push(node);
      if (node._expanded && node.children) {
        node.children.forEach(traverse);
      }
    };
    
    traverse(this.data);
    return nodes;
  }
}

/**
 * 生成测试数据
 */
export function generateTestData() {
  return {
    id: "root",
    name: "根节点",
    description: "这是根节点，整个系统的起点",
    type: "root",
    children: [
      {
        id: "branch1",
        name: "分支1",
        description: "第一个主要分支",
        type: "branch",
        children: [
          {
            id: "leaf1_1",
            name: "叶子1.1",
            description: "分支1下的第一个叶子节点",
            type: "leaf"
          },
          {
            id: "leaf1_2",
            name: "叶子1.2",
            description: "分支1下的第二个叶子节点",
            type: "leaf",
            children: [
              {
                id: "subleaf1_2_1",
                name: "子叶1.2.1",
                description: "叶子1.2下的子节点",
                type: "subleaf"
              },
              {
                id: "subleaf1_2_2",
                name: "子叶1.2.2",
                description: "叶子1.2下的另一个子节点",
                type: "subleaf"
              }
            ]
          },
          {
            id: "leaf1_3",
            name: "叶子1.3",
            description: "分支1下的第三个叶子节点",
            type: "leaf"
          }
        ]
      },
      {
        id: "branch2",
        name: "分支2",
        description: "第二个主要分支",
        type: "branch",
        children: [
          {
            id: "leaf2_1",
            name: "叶子2.1",
            description: "分支2下的第一个叶子节点",
            type: "leaf",
            children: [
              {
                id: "subleaf2_1_1",
                name: "子叶2.1.1",
                description: "叶子2.1下的子节点",
                type: "subleaf"
              }
            ]
          },
          {
            id: "leaf2_2",
            name: "叶子2.2",
            description: "分支2下的第二个叶子节点",
            type: "leaf"
          }
        ]
      },
      {
        id: "branch3",
        name: "分支3",
        description: "第三个主要分支，没有子节点",
        type: "branch"
      }
    ]
  };
}

/**
 * 创建可折叠树形图
 */
export function createCollapsibleTree(containerId, data = null) {
  const container = document.getElementById(containerId) || document.createElement('div');
  const testData = data || generateTestData();
  
  const tree = new CollapsibleTree(container, testData, {
    width: 1000,
    height: 600,
    nodeRadius: 18,
    nodeSpacing: 50,
    levelSpacing: 150
  });
  
  return tree;
} 
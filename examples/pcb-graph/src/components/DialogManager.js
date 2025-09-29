import React from "npm:react";
import ReactDOM from "npm:react-dom/client";
import { NodeDialog } from "./NodeDialog.js";
import { PathDialog } from "./PathDialog.js";

/**
 * 对话框管理器类
 * 负责管理和显示各种类型的对话框
 */
class DialogManager {
  constructor() {
    this.container = null;
    this.root = null;
    this.overlay = null;
    this.currentDialog = null;
  }

  /**
   * 创建对话框容器和遮罩层
   */
  createContainer() {
    if (!this.container) {
      // 创建遮罩层
      this.overlay = document.createElement('div');
      this.overlay.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background-color: rgba(0, 0, 0, 0.6);
        z-index: 999;
        opacity: 0;
        transition: opacity 0.3s ease;
      `;
      
      // 创建对话框容器
      this.container = document.createElement('div');
      this.overlay.appendChild(this.container);
      document.body.appendChild(this.overlay);
      
      // 创建 React 根节点
      this.root = ReactDOM.createRoot(this.container);
      
      // 添加动画效果
      requestAnimationFrame(() => {
        this.overlay.style.opacity = '1';
      });
      
      // 点击遮罩层关闭对话框
      this.overlay.addEventListener('click', (e) => {
        if (e.target === this.overlay) {
          this.close();
        }
      });

      // 阻止页面滚动
      document.body.style.overflow = 'hidden';
    }
  }

  /**
   * 显示节点信息对话框
   * @param {string|Object} nodeIdOrData - 节点ID或节点数据对象
   */
  showNodeDialog(nodeIdOrData) {
    this.createContainer();
    
    // 如果传入的是对象，提取ID；如果是字符串，直接使用
    const nodeId = typeof nodeIdOrData === 'object' ? nodeIdOrData.id : nodeIdOrData;
    
    this.currentDialog = {
      type: 'node',
      id: nodeId,
      data: typeof nodeIdOrData === 'object' ? nodeIdOrData : null
    };

    this.root.render(React.createElement(NodeDialog, {
      nodeId: nodeId,
      nodeData: typeof nodeIdOrData === 'object' ? nodeIdOrData : null,
      onClose: () => this.close()
    }));
  }

  /**
   * 显示路径信息对话框
   * @param {string|Object} pathIdOrData - 路径ID或路径数据对象
   */
  showPathDialog(pathIdOrData) {
    this.createContainer();
    
    // 如果传入的是对象，提取ID；如果是字符串，直接使用
    const pathId = typeof pathIdOrData === 'object' ? pathIdOrData.id : pathIdOrData;
    
    this.currentDialog = {
      type: 'path',
      id: pathId,
      data: typeof pathIdOrData === 'object' ? pathIdOrData : null
    };

    this.root.render(React.createElement(PathDialog, {
      pathId: pathId,
      pathData: typeof pathIdOrData === 'object' ? pathIdOrData : null,
      onClose: () => this.close()
    }));
  }

  /**
   * 关闭当前对话框
   */
  close() {
    if (this.overlay) {
      // 添加关闭动画
      this.overlay.style.opacity = '0';
      
      setTimeout(() => {
        if (this.overlay && this.overlay.parentNode) {
          document.body.removeChild(this.overlay);
        }
        
        // 重置状态
        this.container = null;
        this.root = null;
        this.overlay = null;
        this.currentDialog = null;
        
        // 恢复页面滚动
        document.body.style.overflow = '';
      }, 300);
    }
  }

  /**
   * 检查是否有对话框打开
   * @returns {boolean}
   */
  isOpen() {
    return this.container !== null;
  }

  /**
   * 获取当前对话框信息
   * @returns {Object|null}
   */
  getCurrentDialog() {
    return this.currentDialog;
  }

  /**
   * 切换到节点对话框（如果当前是路径对话框）
   * @param {string|Object} nodeIdOrData
   */
  switchToNodeDialog(nodeIdOrData) {
    if (this.isOpen()) {
      this.showNodeDialog(nodeIdOrData);
    }
  }

  /**
   * 切换到路径对话框（如果当前是节点对话框）
   * @param {string|Object} pathIdOrData
   */
  switchToPathDialog(pathIdOrData) {
    if (this.isOpen()) {
      this.showPathDialog(pathIdOrData);
    }
  }
}

// 创建全局对话框管理器实例
const dialogManager = new DialogManager();

// 添加全局键盘事件监听
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && dialogManager.isOpen()) {
    dialogManager.close();
  }
});

// 导出对话框管理器实例和类
export { dialogManager, DialogManager }; 
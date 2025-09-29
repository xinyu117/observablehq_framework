import React, { useState, useEffect } from "npm:react";
import { fetchNodeData } from "../api/mockApi.js";

/**
 * 节点信息对话框组件
 * @param {Object} props
 * @param {string} props.nodeId - 节点ID
 * @param {Object} props.nodeData - 节点完整数据对象（包含坐标等信息）
 * @param {Function} props.onClose - 关闭回调函数
 */
export const NodeDialog = ({ nodeId, nodeData: initialNodeData, onClose }) => {
  const [apiNodeData, setApiNodeData] = useState(null);
  const [loading, setLoading] = useState(!initialNodeData);
  const [error, setError] = useState(null);

  // 从API获取节点详细数据（仅在没有初始数据时）
  useEffect(() => {
    const fetchNodeDataFromApi = async () => {
      try {
        setLoading(true);
        setError(null);
        
        // 使用模拟API获取数据
        const data = await fetchNodeData(nodeId);
        setApiNodeData(data);
      } catch (err) {
        console.error('Failed to fetch node data:', err);
        setError(err.message);
        
        // 如果API失败，使用基础数据作为后备
        setApiNodeData({
          id: nodeId,
          name: `节点 ${nodeId}`,
          type: 'unknown',
          status: 'unknown',
          description: '无法获取详细信息'
        });
      } finally {
        setLoading(false);
      }
    };

    // 只有在没有初始数据时才从API获取
    if (nodeId && !initialNodeData) {
      fetchNodeDataFromApi();
    }
  }, [nodeId, initialNodeData]);

  // 合并数据：优先使用初始数据，然后补充API数据
  const displayNodeData = initialNodeData ? {
    ...apiNodeData,
    ...initialNodeData,
    // 添加坐标和几何信息
    coordinates: {
      x: initialNodeData.x,
      y: initialNodeData.y
    },
    geometry: {
      height: initialNodeData.height,
      level: initialNodeData.level
    },
    // 如果有父节点信息，也显示
    parents: initialNodeData.parents || [],
    bundles: initialNodeData.bundles || []
  } : apiNodeData;

  // 关闭对话框
  const handleClose = () => {
    onClose();
  };

  // 键盘事件处理
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        handleClose();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  return React.createElement('div', {
    style: {
      position: 'fixed',
      top: '50%',
      left: '50%',
      transform: 'translate(-50%, -50%)',
      backgroundColor: 'white',
      border: '2px solid #2196F3',
      borderRadius: '12px',
      padding: '24px',
      minWidth: '400px',
      maxWidth: '600px',
      boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
      zIndex: 1000,
      fontFamily: 'system-ui, -apple-system, sans-serif'
    }
  }, [
    // 头部
    React.createElement('div', {
      key: 'header',
      style: {
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: '20px',
        borderBottom: '2px solid #E3F2FD',
        paddingBottom: '12px'
      }
    }, [
      React.createElement('h2', {
        key: 'title',
        style: { 
          margin: 0, 
          color: '#1976D2',
          fontSize: '20px',
          fontWeight: '600'
        }
      }, `🔵 节点详情: ${nodeId}`),
      React.createElement('button', {
        key: 'close',
        onClick: handleClose,
        style: {
          background: 'none',
          border: 'none',
          fontSize: '24px',
          cursor: 'pointer',
          color: '#666',
          width: '32px',
          height: '32px',
          borderRadius: '50%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          transition: 'all 0.2s'
        },
        onMouseOver: (e) => {
          e.target.style.backgroundColor = '#f5f5f5';
        },
        onMouseOut: (e) => {
          e.target.style.backgroundColor = 'transparent';
        }
      }, '✕')
    ]),

    // 内容区域
    React.createElement('div', {
      key: 'content',
      style: { 
        lineHeight: '1.6',
        minHeight: '200px'
      }
    }, [
      // 加载状态
      loading && React.createElement('div', {
        key: 'loading',
        style: {
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '40px',
          color: '#666'
        }
      }, [
        React.createElement('div', {
          key: 'spinner',
          style: {
            width: '24px',
            height: '24px',
            border: '3px solid #f3f3f3',
            borderTop: '3px solid #2196F3',
            borderRadius: '50%',
            animation: 'spin 1s linear infinite',
            marginRight: '12px'
          }
        }),
        React.createElement('span', { key: 'text' }, '正在加载节点数据...')
      ]),

      // 错误状态
      error && !loading && React.createElement('div', {
        key: 'error',
        style: {
          padding: '20px',
          backgroundColor: '#ffebee',
          border: '1px solid #f44336',
          borderRadius: '8px',
          color: '#c62828'
        }
      }, [
        React.createElement('h4', { 
          key: 'error-title',
          style: { margin: '0 0 8px 0' }
        }, '⚠️ 加载失败'),
        React.createElement('p', { 
          key: 'error-message',
          style: { margin: 0 }
        }, `错误信息: ${error}`)
      ]),

      // 数据展示
      displayNodeData && !loading && React.createElement('div', {
        key: 'data',
        style: { padding: '0' }
      }, [
        // 基本信息卡片
        React.createElement('div', {
          key: 'basic-info',
          style: {
            backgroundColor: '#f8f9fa',
            padding: '16px',
            borderRadius: '8px',
            marginBottom: '16px'
          }
        }, [
          React.createElement('h3', {
            key: 'basic-title',
            style: { 
              margin: '0 0 12px 0',
              color: '#333',
              fontSize: '16px'
            }
          }, '📋 基本信息'),
          React.createElement('div', {
            key: 'basic-grid',
            style: {
              display: 'grid',
              gridTemplateColumns: '120px 1fr',
              gap: '8px',
              fontSize: '14px'
            }
          }, [
            React.createElement('span', { key: 'id-label', style: { fontWeight: '600', color: '#555' } }, 'ID:'),
            React.createElement('span', { key: 'id-value' }, displayNodeData.id || nodeId),
            
            React.createElement('span', { key: 'name-label', style: { fontWeight: '600', color: '#555' } }, '名称:'),
            React.createElement('span', { key: 'name-value' }, displayNodeData.name || '未知'),
            
            React.createElement('span', { key: 'type-label', style: { fontWeight: '600', color: '#555' } }, '类型:'),
            React.createElement('span', { key: 'type-value' }, displayNodeData.type || '未知'),
            
            React.createElement('span', { key: 'status-label', style: { fontWeight: '600', color: '#555' } }, '状态:'),
            React.createElement('span', { 
              key: 'status-value',
              style: {
                padding: '2px 8px',
                borderRadius: '12px',
                fontSize: '12px',
                backgroundColor: displayNodeData.status === 'active' ? '#e8f5e8' : '#fff3e0',
                color: displayNodeData.status === 'active' ? '#2e7d32' : '#f57c00'
              }
            }, displayNodeData.status || '未知'),
            
            // 添加坐标信息
            displayNodeData.coordinates && [
              React.createElement('span', { key: 'x-label', style: { fontWeight: '600', color: '#555' } }, 'X坐标:'),
              React.createElement('span', { key: 'x-value' }, `${displayNodeData.coordinates.x}px`),
              
              React.createElement('span', { key: 'y-label', style: { fontWeight: '600', color: '#555' } }, 'Y坐标:'),
              React.createElement('span', { key: 'y-value' }, `${displayNodeData.coordinates.y}px`)
            ],
            
            // 添加几何信息
            displayNodeData.geometry && [
              React.createElement('span', { key: 'height-label', style: { fontWeight: '600', color: '#555' } }, '高度:'),
              React.createElement('span', { key: 'height-value' }, `${displayNodeData.geometry.height}px`),
              
              React.createElement('span', { key: 'level-label', style: { fontWeight: '600', color: '#555' } }, '层级:'),
              React.createElement('span', { key: 'level-value' }, `${displayNodeData.geometry.level}`)
            ]
          ])
        ]),

        // 详细信息卡片
        displayNodeData.description && React.createElement('div', {
          key: 'detail-info',
          style: {
            backgroundColor: '#f8f9fa',
            padding: '16px',
            borderRadius: '8px',
            marginBottom: '16px'
          }
        }, [
          React.createElement('h3', {
            key: 'detail-title',
            style: { 
              margin: '0 0 12px 0',
              color: '#333',
              fontSize: '16px'
            }
          }, '📝 详细描述'),
          React.createElement('p', {
            key: 'description',
            style: { 
              margin: 0,
              fontSize: '14px',
              lineHeight: '1.5'
            }
          }, displayNodeData.description)
        ]),

        // 连接信息卡片
        displayNodeData.connections && displayNodeData.connections.length > 0 && React.createElement('div', {
          key: 'connections-info',
          style: {
            backgroundColor: '#f8f9fa',
            padding: '16px',
            borderRadius: '8px'
          }
        }, [
          React.createElement('h3', {
            key: 'connections-title',
            style: { 
              margin: '0 0 12px 0',
              color: '#333',
              fontSize: '16px'
            }
          }, `🔗 连接信息 (${displayNodeData.connections.length})`),
          React.createElement('ul', {
            key: 'connections-list',
            style: { 
              margin: 0,
              paddingLeft: '20px',
              fontSize: '14px'
            }
          }, displayNodeData.connections.slice(0, 8).map((conn, i) => 
            React.createElement('li', { 
              key: i,
              style: { marginBottom: '4px' }
            }, `${conn.type || '连接'}: ${conn.target || conn.id || `连接${i+1}`}`)
          )),
          displayNodeData.connections.length > 8 && React.createElement('p', {
            key: 'more-connections',
            style: { 
              margin: '8px 0 0 0',
              fontStyle: 'italic',
              color: '#666',
              fontSize: '13px'
            }
          }, `...还有 ${displayNodeData.connections.length - 8} 个连接`)
        ]),

        // 父节点信息卡片
        displayNodeData.parents && displayNodeData.parents.length > 0 && React.createElement('div', {
          key: 'parents-info',
          style: {
            backgroundColor: '#f8f9fa',
            padding: '16px',
            borderRadius: '8px',
            marginBottom: '16px'
          }
        }, [
          React.createElement('h3', {
            key: 'parents-title',
            style: { 
              margin: '0 0 12px 0',
              color: '#333',
              fontSize: '16px'
            }
          }, `👆 父节点信息 (${displayNodeData.parents.length})`),
          React.createElement('ul', {
            key: 'parents-list',
            style: { 
              margin: 0,
              paddingLeft: '20px',
              fontSize: '14px'
            }
          }, displayNodeData.parents.map((parent, i) => 
            React.createElement('li', { 
              key: i,
              style: { marginBottom: '4px' }
            }, `${parent.id} (层级: ${parent.level || '未知'})`)
          ))
        ]),

        // 线束信息卡片
        displayNodeData.bundles && displayNodeData.bundles.length > 0 && React.createElement('div', {
          key: 'bundles-info',
          style: {
            backgroundColor: '#f8f9fa',
            padding: '16px',
            borderRadius: '8px'
          }
        }, [
          React.createElement('h3', {
            key: 'bundles-title',
            style: { 
              margin: '0 0 12px 0',
              color: '#333',
              fontSize: '16px'
            }
          }, `📦 线束信息 (${displayNodeData.bundles.length})`),
          React.createElement('ul', {
            key: 'bundles-list',
            style: { 
              margin: 0,
              paddingLeft: '20px',
              fontSize: '14px'
            }
          }, displayNodeData.bundles.slice(0, 5).map((bundle, i) => 
            React.createElement('li', { 
              key: i,
              style: { marginBottom: '4px' }
            }, `${bundle.id} (层级: ${bundle.level}, 跨度: ${bundle.span})`)
          )),
          displayNodeData.bundles.length > 5 && React.createElement('p', {
            key: 'more-bundles',
            style: { 
              margin: '8px 0 0 0',
              fontStyle: 'italic',
              color: '#666',
              fontSize: '13px'
            }
          }, `...还有 ${displayNodeData.bundles.length - 5} 个线束`)
        ])
      ])
    ])
  ]);
};

// CSS 动画样式（通过style标签注入）
if (typeof document !== 'undefined') {
  const style = document.createElement('style');
  style.textContent = `
    @keyframes spin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }
  `;
  if (!document.head.querySelector('style[data-component="NodeDialog"]')) {
    style.setAttribute('data-component', 'NodeDialog');
    document.head.appendChild(style);
  }
} 
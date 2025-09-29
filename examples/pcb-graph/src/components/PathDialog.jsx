import React, { useState, useEffect } from "npm:react";
import { fetchPathData } from "../api/mockApi.js";

/**
 * 路径信息对话框组件
 * @param {Object} props
 * @param {string} props.pathId - 路径ID
 * @param {Object} props.pathData - 路径完整数据对象（包含坐标等信息）
 * @param {Function} props.onClose - 关闭回调函数
 */
export const PathDialog = ({ pathId, pathData: initialPathData, onClose }) => {
  const [apiPathData, setApiPathData] = useState(null);
  const [loading, setLoading] = useState(!initialPathData);
  const [error, setError] = useState(null);

  // 从API获取路径详细数据（仅在没有初始数据时）
  useEffect(() => {
    const fetchPathDataFromApi = async () => {
      try {
        setLoading(true);
        setError(null);
        
        // 使用模拟API获取数据
        const data = await fetchPathData(pathId);
        setApiPathData(data);
      } catch (err) {
        console.error('Failed to fetch path data:', err);
        setError(err.message);
        
        // 如果API失败，使用基础数据作为后备
        setApiPathData({
          id: pathId,
          name: `路径 ${pathId}`,
          type: 'bundle',
          status: 'unknown',
          description: '无法获取详细信息',
          bandwidth: 'unknown',
          protocol: 'unknown'
        });
      } finally {
        setLoading(false);
      }
    };

    // 只有在没有初始数据时才从API获取
    if (pathId && !initialPathData) {
      fetchPathDataFromApi();
    }
  }, [pathId, initialPathData]);

  // 合并数据：优先使用初始数据，然后补充API数据
  const displayPathData = initialPathData ? {
    ...apiPathData,
    ...initialPathData,
    // 添加几何信息
    geometry: {
      level: initialPathData.level,
      span: initialPathData.span,
      i: initialPathData.i
    },
    // 添加连接信息
    links: initialPathData.links || [],
    toword_parents: initialPathData.toword_parents ? Array.from(initialPathData.toword_parents) : []
  } : apiPathData;

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
      border: '2px solid #FF9800',
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
        borderBottom: '2px solid #FFF3E0',
        paddingBottom: '12px'
      }
    }, [
      React.createElement('h2', {
        key: 'title',
        style: { 
          margin: 0, 
          color: '#F57C00',
          fontSize: '20px',
          fontWeight: '600'
        }
      }, `🔶 路径详情: ${pathId}`),
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
            borderTop: '3px solid #FF9800',
            borderRadius: '50%',
            animation: 'spin 1s linear infinite',
            marginRight: '12px'
          }
        }),
        React.createElement('span', { key: 'text' }, '正在加载路径数据...')
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
      displayPathData && !loading && React.createElement('div', {
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
            React.createElement('span', { key: 'id-value' }, displayPathData.id || pathId),
            
            React.createElement('span', { key: 'name-label', style: { fontWeight: '600', color: '#555' } }, '名称:'),
            React.createElement('span', { key: 'name-value' }, displayPathData.name || '未知'),
            
            React.createElement('span', { key: 'type-label', style: { fontWeight: '600', color: '#555' } }, '类型:'),
            React.createElement('span', { key: 'type-value' }, displayPathData.type || '未知'),
            
            React.createElement('span', { key: 'status-label', style: { fontWeight: '600', color: '#555' } }, '状态:'),
            React.createElement('span', { 
              key: 'status-value',
              style: {
                padding: '2px 8px',
                borderRadius: '12px',
                fontSize: '12px',
                backgroundColor: displayPathData.status === 'active' ? '#e8f5e8' : '#fff3e0',
                color: displayPathData.status === 'active' ? '#2e7d32' : '#f57c00'
              }
            }, displayPathData.status || '未知'),

            React.createElement('span', { key: 'bandwidth-label', style: { fontWeight: '600', color: '#555' } }, '带宽:'),
            React.createElement('span', { key: 'bandwidth-value' }, displayPathData.bandwidth || '未知'),
            
            React.createElement('span', { key: 'protocol-label', style: { fontWeight: '600', color: '#555' } }, '协议:'),
            React.createElement('span', { key: 'protocol-value' }, displayPathData.protocol || '未知'),
            
            // 添加几何信息
            displayPathData.geometry && [
              React.createElement('span', { key: 'level-label', style: { fontWeight: '600', color: '#555' } }, '层级:'),
              React.createElement('span', { key: 'level-value' }, `${displayPathData.geometry.level}`),
              
              React.createElement('span', { key: 'span-label', style: { fontWeight: '600', color: '#555' } }, '跨度:'),
              React.createElement('span', { key: 'span-value' }, `${displayPathData.geometry.span} 层`),
              
              React.createElement('span', { key: 'index-label', style: { fontWeight: '600', color: '#555' } }, '索引:'),
              React.createElement('span', { key: 'index-value' }, `${displayPathData.geometry.i}`)
            ]
          ])
        ]),

        // 性能指标卡片
        displayPathData.metrics && React.createElement('div', {
          key: 'metrics-info',
          style: {
            backgroundColor: '#f8f9fa',
            padding: '16px',
            borderRadius: '8px',
            marginBottom: '16px'
          }
        }, [
          React.createElement('h3', {
            key: 'metrics-title',
            style: { 
              margin: '0 0 12px 0',
              color: '#333',
              fontSize: '16px'
            }
          }, '📊 性能指标'),
          React.createElement('div', {
            key: 'metrics-grid',
            style: {
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
              gap: '12px'
            }
          }, [
            displayPathData.metrics.latency && React.createElement('div', {
              key: 'latency',
              style: {
                padding: '12px',
                backgroundColor: 'white',
                borderRadius: '6px',
                textAlign: 'center',
                border: '1px solid #e0e0e0'
              }
            }, [
              React.createElement('div', {
                key: 'latency-label',
                style: { fontSize: '12px', color: '#666', marginBottom: '4px' }
              }, '延迟'),
              React.createElement('div', {
                key: 'latency-value',
                style: { fontSize: '18px', fontWeight: '600', color: '#333' }
              }, displayPathData.metrics.latency)
            ]),

            displayPathData.metrics.throughput && React.createElement('div', {
              key: 'throughput',
              style: {
                padding: '12px',
                backgroundColor: 'white',
                borderRadius: '6px',
                textAlign: 'center',
                border: '1px solid #e0e0e0'
              }
            }, [
              React.createElement('div', {
                key: 'throughput-label',
                style: { fontSize: '12px', color: '#666', marginBottom: '4px' }
              }, '吞吐量'),
              React.createElement('div', {
                key: 'throughput-value',
                style: { fontSize: '18px', fontWeight: '600', color: '#333' }
              }, displayPathData.metrics.throughput)
            ]),

            displayPathData.metrics.errorRate && React.createElement('div', {
              key: 'errorRate',
              style: {
                padding: '12px',
                backgroundColor: 'white',
                borderRadius: '6px',
                textAlign: 'center',
                border: '1px solid #e0e0e0'
              }
            }, [
              React.createElement('div', {
                key: 'errorRate-label',
                style: { fontSize: '12px', color: '#666', marginBottom: '4px' }
              }, '错误率'),
              React.createElement('div', {
                key: 'errorRate-value',
                style: { 
                  fontSize: '18px', 
                  fontWeight: '600', 
                                  color: parseFloat(displayPathData.metrics.errorRate) > 5 ? '#f44336' : '#4caf50'
              }
            }, displayPathData.metrics.errorRate)
            ])
          ])
        ]),

        // 详细描述卡片
        displayPathData.description && React.createElement('div', {
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
          }, displayPathData.description)
        ]),

        // 路由信息卡片
        displayPathData.routes && displayPathData.routes.length > 0 && React.createElement('div', {
          key: 'routes-info',
          style: {
            backgroundColor: '#f8f9fa',
            padding: '16px',
            borderRadius: '8px'
          }
        }, [
          React.createElement('h3', {
            key: 'routes-title',
            style: { 
              margin: '0 0 12px 0',
              color: '#333',
              fontSize: '16px'
            }
          }, `🛤️ 路由信息 (${displayPathData.routes.length})`),
          React.createElement('ul', {
            key: 'routes-list',
            style: { 
              margin: 0,
              paddingLeft: '20px',
              fontSize: '14px'
            }
          }, displayPathData.routes.slice(0, 6).map((route, i) => 
            React.createElement('li', { 
              key: i,
              style: { 
                marginBottom: '6px',
                padding: '4px 0',
                borderBottom: i < Math.min(displayPathData.routes.length - 1, 5) ? '1px solid #eee' : 'none'
              }
            }, [
              React.createElement('strong', { key: 'from' }, route.from || `节点${i}`),
              React.createElement('span', { key: 'arrow', style: { margin: '0 8px', color: '#666' } }, '→'),
              React.createElement('strong', { key: 'to' }, route.to || `节点${i+1}`),
              route.weight && React.createElement('span', { 
                key: 'weight',
                style: { 
                  marginLeft: '8px', 
                  fontSize: '12px', 
                  color: '#666',
                  backgroundColor: '#e3f2fd',
                  padding: '2px 6px',
                  borderRadius: '10px'
                }
              }, `权重: ${route.weight}`)
            ])
          )),
          displayPathData.routes.length > 6 && React.createElement('p', {
            key: 'more-routes',
            style: { 
              margin: '8px 0 0 0',
              fontStyle: 'italic',
              color: '#666',
              fontSize: '13px'
            }
          }, `...还有 ${displayPathData.routes.length - 6} 条路由`)
        ]),

        // 连接信息卡片
        displayPathData.links && displayPathData.links.length > 0 && React.createElement('div', {
          key: 'links-info',
          style: {
            backgroundColor: '#f8f9fa',
            padding: '16px',
            borderRadius: '8px',
            marginBottom: '16px'
          }
        }, [
          React.createElement('h3', {
            key: 'links-title',
            style: { 
              margin: '0 0 12px 0',
              color: '#333',
              fontSize: '16px'
            }
          }, `🔗 连接信息 (${displayPathData.links.length})`),
          React.createElement('ul', {
            key: 'links-list',
            style: { 
              margin: 0,
              paddingLeft: '20px',
              fontSize: '14px'
            }
          }, displayPathData.links.slice(0, 8).map((link, i) => 
            React.createElement('li', { 
              key: i,
              style: { marginBottom: '4px' }
            }, `${link.source?.id || '源节点'} → ${link.target?.id || '目标节点'}`)
          )),
          displayPathData.links.length > 8 && React.createElement('p', {
            key: 'more-links',
            style: { 
              margin: '8px 0 0 0',
              fontStyle: 'italic',
              color: '#666',
              fontSize: '13px'
            }
          }, `...还有 ${displayPathData.links.length - 8} 个连接`)
        ]),

        // 目标父节点信息卡片
        displayPathData.toword_parents && displayPathData.toword_parents.length > 0 && React.createElement('div', {
          key: 'parents-info',
          style: {
            backgroundColor: '#f8f9fa',
            padding: '16px',
            borderRadius: '8px'
          }
        }, [
          React.createElement('h3', {
            key: 'parents-title',
            style: { 
              margin: '0 0 12px 0',
              color: '#333',
              fontSize: '16px'
            }
          }, `👆 目标父节点 (${displayPathData.toword_parents.length})`),
          React.createElement('ul', {
            key: 'parents-list',
            style: { 
              margin: 0,
              paddingLeft: '20px',
              fontSize: '14px'
            }
          }, displayPathData.toword_parents.map((parent, i) => 
            React.createElement('li', { 
              key: i,
              style: { marginBottom: '4px' }
            }, `${parent.id} (层级: ${parent.level || '未知'})`)
          ))
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
  if (!document.head.querySelector('style[data-component="PathDialog"]')) {
    style.setAttribute('data-component', 'PathDialog');
    document.head.appendChild(style);
  }
} 
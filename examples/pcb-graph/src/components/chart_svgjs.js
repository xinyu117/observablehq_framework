import _ from "npm:lodash";
import * as d3 from "npm:d3";
import { svg, html } from "npm:htl";
import {SVG} from "npm:@svgdotjs/svg.js";
import { dialogManager } from "./DialogManager.js";



export function constructTangleLayout(levels, options = {}) {
  // 为节点添加level属性
  levels.forEach((l, i) => l.forEach(n => { n.level = i; n.bundles = [] })); // 1.forEach不返回新数组；2.箭头函数可以访问父级变量；3.遍历二维数组中的全部元素/节点

  // 取得全部节点数组
  var nodes = levels.reduce((a, x) => a.concat(x), []);  // 1.降维,二维转一维；2.把全部节点放入nodes中，方便以后使用；
  // 全部节点的MAP 1.数组转map；2.也可用这个方法：https://www.30secondsofcode.org/js/s/objectify/
  var nodes_index = {};
  nodes.forEach(d => (nodes_index[d.id] = d));

  const links = []; //全部连接
  levels.forEach((l, i) => {
    const bundles_index = {};
    l.filter(n => n.parents.length > 0)
      // .map(n => ({ id: n.parents.map(d => d.id).sort().join('-X-'), toword_parents: new Set(n.parents.slice()), level: i, span: i - d3.min(n.parents, p => p.level) }) )
      .forEach(n => {
        const id = n.parents.map(d => d.id).sort().join('-X-');

        if (!bundles_index[id]) {
          bundles_index[id] = { id: id, links: [], toword_parents: new Set(n.parents.slice()), level: i, span: i - d3.min(n.parents, p => p.level) }; // span:节点的level和父节点中level最小的差
        }

        n.bundle = bundles_index[id]; //节点对应的线束
        const linksOfNode = n.parents.map(p => ({ source: n, bundle: n.bundle, target: p })); //节点与父节点的连接
        bundles_index[id].links.push(...linksOfNode); //一个线束拥有的连接。
        links.push(...linksOfNode);
      });
    l.bundles = Object.keys(bundles_index).map(k => bundles_index[k]); //一个level有多少个线束; 把对象转换成数组
    l.bundles.forEach((b, i) => (b.i = i)); //给level内线束编号
  })
  // 全部线束
  var bundles = levels.reduce((a, x) => a.concat(x.bundles), []);

  // 一个父节点有那些线束
  bundles.forEach(b =>
    b.toword_parents.forEach(p => {
      if (p.bundles === undefined) {
        p.bundles = [];
      }
      p.bundles.push({ ...b }); //同一线束可能属于不同的父节点，以下对线束排序时会出现覆盖的情况，所以要拷贝一份
    })
  );

  nodes.forEach(n => {
    n.bundles.sort((a, b) => d3.descending(a.span, b.span)); //按跨越的level的个数排序
    n.bundles.forEach((b, index) => (b.jj = index));
  });



  // layout
  const padding = 8;
  const node_height = 22;
  const node_width = 70;
  const bundle_width = 14;
  const level_y_padding = 16;
  const metro_d = 4;
  const min_family_height = 22;

  options.c ||= 16;
  const c = options.c;
  options.bigc ||= node_width + c;

  nodes.forEach(
    n => (n.height = (Math.max(1, n.bundles.length) - 1) * metro_d) //节点的高度：根据线束的个数
  );

  // 节点XY的值算出
  var x_offset = padding;
  var y_offset = padding;
  levels.forEach(l => {
    x_offset += l.bundles.length * bundle_width; //线束之间是错开的
    y_offset += level_y_padding;
    l.forEach((n, i) => {
      n.x = n.level * node_width + x_offset;
      n.y = node_height + y_offset + n.height / 2;
      y_offset += node_height + n.height;
    });
  });


  var i = 0;
  levels.forEach(l => {
    l.bundles.forEach(b => {
      b.x = d3.max(b.toword_parents, d => d.x) + node_width + (l.bundles.length - 1 - b.i) * bundle_width;   // 线束上段终点的X值：根据以上父节点X的值算出；这个X比Target的x少一个bundle_width
      b.y = i * node_height;
    });
    i += l.length;
  });

  links.forEach(l => {
    l.xt = l.target.x; //线束上段起点的X值：target节点的X值
    l.yt =
      l.target.y +
      l.target.bundles.find((obj) => obj.id === l.bundle.id).jj * metro_d -
      (l.target.bundles.length * metro_d) / 2 +
      metro_d / 2;
    l.xb = l.bundle.x; //线束上段终点的X值，以上的b.x
    l.yb = l.bundle.y;
    l.xs = l.source.x; //线束下段终点的X值：source节点的X值
    l.ys = l.source.y;
  });

  // compress vertical space 压缩垂直方向空间，如果不压缩level间的Y是依次递增的，压缩后level间有重合的部分；以下计算可以保证：source节点不会高于target节点
  var y_negative_offset = 0;
  levels.forEach(l => {
    y_negative_offset += -min_family_height +
      d3.min(l.bundles, b =>
        d3.min(b.links, link => link.ys - 2 * c - (link.yt + c))
      ) || 0;
    l.forEach(n => (n.y -= y_negative_offset));
  });

  // very ugly, I know
  links.forEach(l => {
    l.yt =
      l.target.y +
      l.target.bundles.find((obj) => obj.id === l.bundle.id).jj * metro_d -
      (l.target.bundles.length * metro_d) / 2 +
      metro_d / 2;
    l.ys = l.source.y;
    l.c1 = l.source.level - l.target.level > 1 ? Math.min(options.bigc, l.xb - l.xt, l.yb - l.yt) - c : c;
    l.c2 = c;
  });

  var layout = {
    width: d3.max(nodes, n => n.x) + node_width + 2 * padding,
    height: d3.max(nodes, n => n.y) + node_height / 2 + 2 * padding,
    node_height,
    node_width,
    bundle_width,
    level_y_padding,
    metro_d
  };

  return { levels, nodes, nodes_index, links, bundles, layout };
}

export function renderChart(data, options = {}) {
  const color = d3.scaleOrdinal(d3.schemeDark2);
  options.color ||= (d, i) => color(i);
  const background_color = 'white';
  const stroke_width = 5;

  const tangleLayout = constructTangleLayout(_.cloneDeep(data), options);

  // 创建一个临时的 div 容器用于 SVG.js
  const container = document.createElement('div');
  
  // 使用 SVG.js 创建 SVG 画布
  const draw = SVG(container).size(tangleLayout.layout.width, tangleLayout.layout.height);
  
  // 设置背景色
  draw.rect(tangleLayout.layout.width, tangleLayout.layout.height).fill(background_color);
  
  // 添加样式
  const style = draw.defs().element('style');
  style.node.textContent = `
    text {
      font-family: sans-serif;
      font-size: 10px;
    }
    .node {
      stroke-linecap: round;
    }
    .link {
      fill: none;
    }
  `;

  // 绘制线束（bundles）
  tangleLayout.bundles.forEach((b, i) => {
    // 构建路径数据
    const pathData = b.links.map(l => 
      `M${l.xt} ${l.yt}
       L${l.xb - l.c1} ${l.yt}
       A${l.c1} ${l.c1} 90 0 1 ${l.xb} ${l.yt + l.c1}
       L${l.xb} ${l.ys - l.c2}
       A${l.c2} ${l.c2} 90 0 0 ${l.xb + l.c2} ${l.ys}
       L${l.xs} ${l.ys}`
    ).join("");

    // 绘制背景路径（白色描边）
    draw.path(pathData)
        .addClass('link')
        .fill('none')
        .stroke(background_color)
        .attr('stroke-width', stroke_width);

         // 绘制前景路径（彩色描边）
     draw.path(pathData)
         .addClass('link')
         .fill('none')
         .stroke(options.color(b, i))
         .attr('stroke-width', 2)
         .click(function(e) {
           e.stopPropagation();
           dialogManager.showPathDialog(b);
         })
         .attr('style', 'cursor: pointer');
  });

  // 绘制节点
  tangleLayout.nodes.forEach(n => {
         // 节点的黑色描边
     draw.line(n.x, n.y - n.height / 2, n.x, n.y + n.height / 2)
         .addClass('selectable node')
         .attr('data-id', n.id)
         .stroke('black')
         .attr('stroke-width', 8)
         .click(function(e) {
           e.stopPropagation();
           dialogManager.showNodeDialog(n);
         })
         .attr('style', 'cursor: pointer');

    // 节点的白色描边
    draw.line(n.x, n.y - n.height / 2, n.x, n.y + n.height / 2)
        .addClass('node')
        .stroke('white')
        .attr('stroke-width', 4);

    // 节点标签的背景描边
    const textBg = draw.text(n.id)
        .addClass('selectable')
        .attr('data-id', n.id)
        .move(n.x + 4, n.y - n.height / 2 - 16)
        .stroke(background_color)
        .attr('stroke-width', 2);

         // 节点标签的前景文本
     const textFg = draw.text(n.id)
         .move(n.x + 4, n.y - n.height / 2 - 16)
         .attr('style', 'pointer-events: none');
  });

  // 返回生成的 SVG 元素
  return draw.node;
}



/**
 * 使用 SVG.js 创建可交互的图表版本
 * @param {Array} data - 图表数据
 * @param {Object} options - 配置选项
 * @returns {HTMLElement} SVG 元素
 */
export function renderInteractiveChart(data, options = {}) {
  const color = d3.scaleOrdinal(d3.schemeDark2);
  options.color ||= (d, i) => color(i);
  const background_color = 'white';
  const stroke_width = 5;

  const tangleLayout = constructTangleLayout(_.cloneDeep(data), options);

     // 使用 SVG.js 创建 SVG 画布
   const draw = SVG().addTo("#svgjs").size(tangleLayout.layout.width, tangleLayout.layout.height);
  
  // 设置背景色
  draw.rect(tangleLayout.layout.width, tangleLayout.layout.height).fill(background_color);
    // 添加样式
    const style = draw.defs().element('style');
    style.node.textContent = `
      text {
        font-family: sans-serif;
        font-size: 10px;
      }
      .node {
        stroke-linecap: round;
      }
      .link {
        fill: none;
      }
    `;

  // 绘制线束（bundles）- 添加交互功能
  const bundleGroup = draw.group().addClass('bundles');
  tangleLayout.bundles.forEach((b, i) => {
    const pathData = b.links.map(l => 
      `M${l.xt} ${l.yt}
       L${l.xb - l.c1} ${l.yt}
       A${l.c1} ${l.c1} 90 0 1 ${l.xb} ${l.yt + l.c1}
       L${l.xb} ${l.ys - l.c2}
       A${l.c2} ${l.c2} 90 0 0 ${l.xb + l.c2} ${l.ys}
       L${l.xs} ${l.ys}`
    ).join("");

    const bundleGroup = draw.group().addClass('bundle');
    
    // 背景路径
    const bgPath = bundleGroup.path(pathData)
        .fill('none')
        .stroke(background_color)
        .attr('stroke-width', stroke_width);

    // 前景路径
    const fgPath = bundleGroup.path(pathData)
        .fill('none')
        .stroke(options.color(b, i))
        .attr('stroke-width', 2);

         // 添加交互效果
     bundleGroup
         .mouseover(function() {
           fgPath.attr('stroke-width', 4);
         })
         .mouseout(function() {
           fgPath.attr('stroke-width', 2);
         })
         .click(function(e) {
           e.stopPropagation();
           dialogManager.showPathDialog(b);
         })
         .attr('style', 'cursor: pointer');
  });

  // 绘制节点 - 添加交互功能
  const nodeGroup = draw.group().addClass('nodes');
  tangleLayout.nodes.forEach(n => {
    const singleNodeGroup = nodeGroup.group().addClass('node');
    
    // 节点线条
    const nodeLine = singleNodeGroup.group();
    nodeLine.line(n.x, n.y - n.height / 2, n.x, n.y + n.height / 2)
        .stroke('black')
        .attr('stroke-width', 8);
    nodeLine.line(n.x, n.y - n.height / 2, n.x, n.y + n.height / 2)
        .stroke('white')
        .attr('stroke-width', 4);

    // 节点标签
    const nodeText = singleNodeGroup.group();
    nodeText.text(n.id)
        .move(n.x + 4, n.y - n.height / 2 - 16)
        .stroke(background_color)
        .attr('stroke-width', 2);
    nodeText.text(n.id)
        .move(n.x + 4, n.y - n.height / 2 - 16)
        .fill('black');

         // 添加交互事件
     singleNodeGroup
         .click(function(e) {
           e.stopPropagation();
           dialogManager.showNodeDialog(n);
         })
         .mouseover(function() {
           nodeText.attr('font-weight', 'bold');
         })
         .mouseout(function() {
           nodeText.attr('font-weight', 'normal');
         })
         .attr('style', 'cursor: pointer');
  });

  return draw.node;
}
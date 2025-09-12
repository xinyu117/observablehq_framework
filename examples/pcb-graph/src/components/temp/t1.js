const csvData = `
主体,谓词,客体
grandfather_1,child,father_1
grandfather_1,child,father_2
grandfather_1,child,father_3
father_4,father,grandfather_1
father_5,father,grandfather_1
father_6,father,grandfather_1
father_4,father,grandfather_2
father_5,father,grandfather_2
father_6,father,grandfather_2
father_1,child,child_1
father_1,child,child_2
father_1,child,child_3
child_4,father,father_1
child_5,father,father_1
child_6,father,father_1
child_4,father,father_2
child_5,father,father_2
child_6,father,father_2
`.trim();

// 解析 CSV
const lines = csvData.split("\n").slice(1); // 去掉表头
const nodes = new Map();

function ensureNode(id) {
  if (!nodes.has(id)) {
    nodes.set(id, { id, child: new Set(), father: new Set(), level: null });
  }
  return nodes.get(id);
}

// 建立关系
for (const line of lines) {
  const [subject, predicate, object] = line.split(",");
  const subjNode = ensureNode(subject);
  const objNode = ensureNode(object);

  if (predicate === "child") {
    subjNode.child.add(object);
    objNode.father.add(subject);
  } else if (predicate === "father") {
    subjNode.father.add(object);
    objNode.child.add(subject);
  }
}

// 计算 level：从没有父节点的根开始 BFS
function assignLevels() {
  const queue = [];

  // 找根节点（没有 father 的节点）
  for (const node of nodes.values()) {
    if (node.father.size === 0) {
      node.level = 1;
      queue.push(node);
    }
  }

  // BFS 层级传播
  while (queue.length > 0) {
    const current = queue.shift();
    for (const childId of current.child) {
      const childNode = nodes.get(childId);
      const newLevel = (current.level || 0) + 1;
      if (childNode.level === null || newLevel < childNode.level) {
        childNode.level = newLevel;
        queue.push(childNode);
      }
    }
  }
}

assignLevels();

// 转换成最终数组
const result = Array.from(nodes.values()).map(node => ({
  id: node.id,
  child: Array.from(node.child),
  father: Array.from(node.father),
  level: node.level
}));

console.log(result);

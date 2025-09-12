export function _dataLevel() {
  return (
 [
  [{ id: 'Chaos' }],
  [{ id: 'Gaea', parents: ['Chaos'] }, { id: 'Uranus' }, { id: 'suchao' }],
  [
    { id: 'Oceanus', parents: ['Gaea', 'Uranus', 'suchao'] },
    { id: 'Thethys', parents: ['Gaea', 'Uranus'] },
    { id: 'Pontus' },
    { id: 'Rhea', parents: ['Gaea', 'Uranus'] },
    { id: 'Cronus', parents: ['Gaea', 'Uranus'] },
    { id: 'Coeus', parents: ['Gaea', 'Uranus'] },
    { id: 'Phoebe', parents: ['Gaea', 'Uranus'] },
    { id: 'Crius', parents: ['Gaea', 'Uranus'] },
    { id: 'Hyperion', parents: ['Gaea', 'Uranus'] },
    { id: 'Iapetus', parents: ['Gaea', 'Uranus'] },
    { id: 'Thea', parents: ['Gaea', 'Uranus'] },
    { id: 'Themis', parents: ['Gaea', 'Uranus'] },
    { id: 'Mnemosyne', parents: ['Gaea', 'Uranus'] }
  ],
  [
    { id: 'Doris', parents: ['Oceanus', 'Thethys'] },
    { id: 'Neures', parents: ['Pontus', 'Gaea'] },
    { id: 'Dionne' },
    { id: 'Demeter', parents: ['Rhea', 'Cronus'] },
    { id: 'Hades', parents: ['Rhea', 'Cronus'] },
    { id: 'Hera', parents: ['Rhea', 'Cronus'] },
    { id: 'Alcmene' },
    { id: 'Zeus', parents: ['Rhea', 'Cronus'] },
    { id: 'Eris' },
    { id: 'Leto', parents: ['Coeus', 'Phoebe'] },
    { id: 'Amphitrite' },
    { id: 'Medusa' },
    { id: 'Poseidon', parents: ['Rhea', 'Cronus'] },
    { id: 'Hestia', parents: ['Rhea', 'Cronus'] }
  ],
  [
    { id: 'Thetis', parents: ['Doris', 'Neures'] },
    { id: 'Peleus' },
    { id: 'Anchises' },
    { id: 'Adonis' },
    { id: 'Aphrodite', parents: ['Zeus', 'Dionne'] },
    { id: 'Persephone', parents: ['Zeus', 'Demeter'] },
    { id: 'Ares', parents: ['Zeus', 'Hera'] },
    { id: 'Hephaestus', parents: ['Zeus', 'Hera'] },
    { id: 'Hebe', parents: ['Zeus', 'Hera'] },
    { id: 'Hercules', parents: ['Zeus', 'Alcmene'] },
    { id: 'Megara' },
    { id: 'Deianira' },
    { id: 'Eileithya', parents: ['Zeus', 'Hera'] },
    { id: 'Ate', parents: ['Zeus', 'Eris'] },
    { id: 'Leda' },
    { id: 'Athena', parents: ['Zeus'] },
    { id: 'Apollo', parents: ['Zeus', 'Leto'] },
    { id: 'Artemis', parents: ['Zeus', 'Leto'] },
    { id: 'Triton', parents: ['Poseidon', 'Amphitrite'] },
    { id: 'Pegasus', parents: ['Poseidon', 'Medusa'] },
    { id: 'Orion', parents: ['Poseidon'] },
    { id: 'Polyphemus', parents: ['Poseidon'] }
  ],
  [
    { id: 'Deidamia' },
    { id: 'Achilles', parents: ['Peleus', 'Thetis'] },
    { id: 'Creusa' },
    { id: 'Aeneas', parents: ['Anchises', 'Aphrodite'] },
    { id: 'Lavinia' },
    { id: 'Eros', parents: ['Hephaestus', 'Aphrodite'] },
    { id: 'Helen', parents: ['Leda', 'Zeus'] },
    { id: 'Menelaus' },
    { id: 'Polydueces', parents: ['Leda', 'Zeus'] }
  ],
  [
    { id: 'Andromache' },
    { id: 'Neoptolemus', parents: ['Deidamia', 'Achilles'] },
    { id: 'Aeneas(2)', parents: ['Creusa', 'Aeneas'] },
    { id: 'Pompilius', parents: ['Creusa', 'Aeneas'] },
    { id: 'Iulus', parents: ['Lavinia', 'Aeneas'] },
    { id: 'Hermione', parents: ['Helen', 'Menelaus'] }
  ]
 ])
}

/**
 * 把二维格式的数据转换成graph格式数据。
 * @param {*} input_levels 
 * @returns 
 */
export function generateGraphData(input_levels) {
  input_levels.forEach((l, i) => l.forEach(n => n.level = i)); // 1.forEach不返回新数组；2.箭头函数可以访问父级变量；3.遍历二维数组中的全部元素/节点
  // 取得全部节点数组
  const nodesIndex = input_levels.reduce((a, x) => a.concat(x), []);  // 1.降维,二维转一维；2.把全部节点放入nodes中，方便以后使用；

  const flattenParents = (item) => {
    if (!item.parents) return [item];
    return item.parents.map(parent => ({ ...item, parent: parent }));
  }

  const graphdata = nodesIndex.flatMap(flattenParents);
  console.log(JSONtoCSV(graphdata,['id','parent','level']));
  return graphdata;
}

/**
 * 把多对多数据转换为一对多数据
 * @param {*} graphData 多对多数据,每一个数据项是子：父关系
 * @returns 
 */
export function createNodeIndex(graphData) {
  // 全部节点的Map,key:node.id,value:node
  const nodeIndex = new Map();
  graphData.forEach(node => {
    if (!nodeIndex.has(node.id)) {
        nodeIndex.set(node.id, { ...node, parents: [], childs: [] });
    }
  });

  // 根据节点间关系，建立一个节点对应多个父节点。
  graphData.forEach(node => {
    const targetId = node.parent;
    if (targetId) {
      const sourceNode = nodeIndex.get(node.id);
      const targetNode = nodeIndex.get(targetId);
      if (sourceNode && targetNode) {
        sourceNode.parents.push(targetNode);
        targetNode.childs.push(sourceNode);
      }
    }
  });
  return nodeIndex;
}
/**
 * 以数据项的level字段分组
 * @param {*} inputMap 
 * @returns 
 */
export function groupByLevel(inputMap) {
    const inputArray = Array.from(inputMap.values());
    const groupedArray = inputArray.reduce((result, currentObj) => {
        const level = currentObj.level;
        if (!result[level]) {
            result[level] = [];
        }
        result[level].push(currentObj);
        return result;
    }, {});
    
    return Object.values(groupedArray);
}


export function JSONtoCSV(arr, columns, delimiter = ',') {
  return [
    columns.join(delimiter),
    ...arr.map(obj =>
      columns.reduce(
        (acc, key) =>
          `${acc}${!acc.length ? '' : delimiter}${!obj[key] ? '' : obj[key]}`,
        ''
      )
    ),
  ].join('\n');
}

export function CSVToJSON(data, delimiter = ',') {
  const titles = data.slice(0, data.indexOf('\n')).replace(/\r/,'').split(delimiter);
  return data
    .slice(data.indexOf('\n') + 1)
    .split(/\r?\n/)
    .map(v => {
      const values = v.split(delimiter);
      return titles.reduce(
        (obj, title, index) => ((obj[title] = values[index]), obj),
        {}
      );
    });
};

export function createObjByProperty(data, propertiesToCopy) {
  const newArray = data.map((obj) => {
    const newObj = {};
    propertiesToCopy.forEach(function(prop) {
        newObj[prop] = obj[prop];
    });
    return newObj;
  })
  return newArray;
};

// 临时测试 START
const input = `predicate,category,same,reverse,level
parent,tree,belong | branch,child,L0
child,tree,include | leaf,parent,L1
parent2,tree2,belong2 | branch2,,L0`;

const csvinput = `subject,predicate,object,title
y,,,i am root
y1,parent,y,first
y,child,y2,second
y,child,y3,three`;

export function getPredicateReverse(data) {
  const rows = CSVToJSON(data);
  const result = {};
  rows.forEach(row => {
    const { predicate, category, reverse, level } = row;

    // 初始化结果对象中的分类树结构
    if (!result[category]) {
      result[category] = {};
    }

    // 在对应的层级添加反向和谓词字段
    result[category][level] = {
      reverse: reverse.trim(),
      predicate: predicate.trim()
    };
  });
  return result;
};

export function normalizePredicate(data, category, predicateMap, level='L0') {
  const rows = CSVToJSON(data);
  const result = {};
  const predicateObj = predicateMap[category];
  rows.forEach(row => {
    const { subject, predicate, object } = row;

    if (predicate && predicateObj[level].predicate !== predicate ) {
        row.subject = object;
        row.predicate = predicateObj[level].predicate;
        row.object = subject;
    }
  });
  return rows;
}

const obj = getPredicateReverse(input);
const csvobj = normalizePredicate(csvinput,'tree',obj);
console.log(JSON.stringify(csvobj, null, 2));

// 临时测试 END

export function generateLevel(nodeIndex) {
  const nodeIndexList = Array.from(nodeIndex.values());
 
  // 递归构建层级关系
  const buildHierarchy = (node, level) => {
    const maxLevel = node.level ? Math.max(node.level, level) : level;
    node.level = maxLevel;
    node.childs.forEach((node, i) => {
      buildHierarchy(node, level + 1);
    });
  };
  
  const topNodes = nodeIndexList.filter((n) => n.parents.length == 0);

  topNodes.forEach((node, i) => {
    buildHierarchy(node, 0);
  });

  return nodeIndex;
}

export function test(event, d) {
alert(event);
}


/**
 * JavaScript 源码字符串字面量处理模块
 * 
 * 这个模块是 Observable Framework 中用于处理 JavaScript AST 节点中字符串字面量的核心工具。
 * 在包依赖解析过程中，需要从 import 语句、FileAttachment 调用等地方提取字符串值，
 * 而这些字符串可能以多种形式出现：普通字符串、模板字符串、字符串拼接等。
 * 
 * 主要功能：
 * 1. **字符串类型识别**: 判断 AST 节点是否为字符串字面量
 * 2. **字符串值提取**: 从各种形式的字符串字面量中提取实际的字符串值
 * 3. **复杂字符串处理**: 支持模板字符串、二元表达式拼接等复杂情况
 * 
 * 使用场景：
 * - 解析 import 语句中的模块路径：import foo from "npm:d3"
 * - 解析 FileAttachment 调用中的文件路径：FileAttachment("./data.csv")
 * - 处理动态导入：import(`./modules/${name}.js`)
 * - 处理字符串拼接：import("npm:" + packageName)
 */

import type {BinaryExpression, Literal, MemberExpression, Node, TemplateLiteral} from "acorn";

/**
 * 字符串字面量类型定义
 * 
 * 支持的字符串字面量类型：
 * - Literal: 普通字符串字面量，如 "hello" 或 'world'
 * - TemplateLiteral: 模板字符串，如 `hello ${name}`
 * - BinaryExpression: 字符串拼接表达式，如 "hello" + "world"
 */
export type StringLiteral = (Literal & {value: string}) | TemplateLiteral | BinaryExpression;

/**
 * 判断节点是否为字面量
 * 
 * @param node AST 节点
 * @returns 是否为 Literal 类型节点
 * 
 * 示例：
 * - isLiteral({type: "Literal", value: "hello"}) → true
 * - isLiteral({type: "Identifier", name: "foo"}) → false
 */
export function isLiteral(node: Node): node is Literal {
  return node.type === "Literal";
}

/**
 * 判断节点是否为模板字符串
 * 
 * @param node AST 节点
 * @returns 是否为 TemplateLiteral 类型节点
 * 
 * 示例：
 * - isTemplateLiteral({type: "TemplateLiteral", quasis: [...]}) → true
 * - isTemplateLiteral({type: "Literal", value: "hello"}) → false
 */
export function isTemplateLiteral(node: Node): node is TemplateLiteral {
  return node.type === "TemplateLiteral";
}

/**
 * 判断节点是否为字符串字面量（支持多种形式）
 * 
 * 这是核心的类型检查函数，能够识别各种形式的字符串字面量：
 * 1. 普通字符串字面量（单引号或双引号）
 * 2. 模板字符串（反引号，且所有插值都是字符串）
 * 3. 字符串拼接表达式（+ 操作符连接的字符串）
 * 4. 成员表达式（参数引用）
 * 
 * @param node AST 节点
 * @returns 是否为字符串字面量
 * 
 * 示例：
 * - isStringLiteral({type: "Literal", value: "hello", raw: '"hello"'}) → true
 * - isStringLiteral({type: "Literal", value: 42, raw: '42'}) → false
 * - isStringLiteral(模板字符串节点 `hello ${name}`) → true（如果 name 也是字符串）
 * - isStringLiteral(二元表达式 "hello" + "world") → true
 * - isStringLiteral({type: "Identifier", name: "foo"}) → false
 */
export function isStringLiteral(node: Node): node is StringLiteral {
  return isLiteral(node)
    ? /^['"]/.test(node.raw!)                                    // 普通字符串：检查是否以引号开头
    : isTemplateLiteral(node)
    ? node.expressions.every(isStringLiteral)                   // 模板字符串：所有插值都必须是字符串
    : isBinaryExpression(node)
    ? node.operator === "+" && isStringLiteral(node.left) && isStringLiteral(node.right)  // 字符串拼接
    : isMemberExpression(node)
    ? "value" in node                                           // 参数引用：如路由参数
    : false;
}

/**
 * 从字符串字面量节点中提取实际的字符串值
 * 
 * 这是核心的值提取函数，能够处理各种复杂的字符串字面量形式，
 * 并返回最终的字符串值。这在依赖解析过程中至关重要。
 * 
 * @param node 字符串字面量节点
 * @returns 提取出的字符串值
 * 
 * 示例：
 * - getStringLiteralValue({type: "Literal", value: "hello"}) → "hello"
 * - getStringLiteralValue(模板字符串 `npm:${pkg}`) → "npm:d3" (假设 pkg = "d3")
 * - getStringLiteralValue(二元表达式 "npm:" + "d3") → "npm:d3"
 * - getStringLiteralValue(参数引用节点) → 参数的实际值
 * 
 * 在依赖解析中的应用：
 * - import("npm:d3") → 提取 "npm:d3"
 * - FileAttachment("./data.csv") → 提取 "./data.csv"
 * - import(`./modules/${name}.js`) → 提取 "./modules/chart.js" (假设 name = "chart")
 */
export function getStringLiteralValue(node: StringLiteral): string {
  return node.type === "TemplateLiteral"
    ? getTemplateLiteralValue(node)      // 处理模板字符串
    : node.type === "BinaryExpression"
    ? getBinaryExpressionValue(node)     // 处理字符串拼接
    : node.value;                        // 普通字面量或参数引用
}

/**
 * 处理模板字符串，将模板和插值组合成最终字符串
 * 
 * 模板字符串由静态文本部分（quasis）和动态插值部分（expressions）组成。
 * 这个函数将它们按正确顺序组合成最终的字符串值。
 * 
 * @param node 模板字符串 AST 节点
 * @returns 组合后的字符串值
 * 
 * 示例：
 * 输入模板字符串: `hello ${name} world`
 * - node.quasis = [{value: {cooked: "hello "}}, {value: {cooked: " world"}}]
 * - node.expressions = [name节点]
 * - 假设 name = "Alice"
 * 输出: "hello Alice world"
 * 
 * 实际应用示例：
 * - `npm:${packageName}` + packageName="d3" → "npm:d3"
 * - `./data/${filename}.csv` + filename="sales" → "./data/sales.csv"
 * - `/api/${version}/users` + version="v1" → "/api/v1/users"
 */
function getTemplateLiteralValue(node: TemplateLiteral): string {
  // 从第一个静态文本开始
  let value = node.quasis[0].value.cooked!;
  
  // 交替添加插值和静态文本
  for (let i = 0; i < node.expressions.length; ++i) {
    value += getStringLiteralValue(node.expressions[i] as StringLiteral);  // 添加插值值
    value += node.quasis[i + 1].value.cooked!;                           // 添加下一个静态文本
  }
  
  return value;
}

/**
 * 处理二元表达式（字符串拼接），将左右操作数拼接成最终字符串
 * 
 * @param node 二元表达式 AST 节点
 * @returns 拼接后的字符串值
 * 
 * 示例：
 * 输入表达式: "npm:" + packageName
 * - node.left = {type: "Literal", value: "npm:"}
 * - node.right = {type: "Identifier", name: "packageName"} (假设值为 "d3")
 * 输出: "npm:d3"
 * 
 * 实际应用示例：
 * - "npm:" + "d3" → "npm:d3"
 * - "./data/" + filename + ".csv" → "./data/sales.csv" (假设 filename="sales")
 * - baseUrl + "/api/users" → "https://api.example.com/api/users"
 */
function getBinaryExpressionValue(node: BinaryExpression): string {
  return getStringLiteralValue(node.left as StringLiteral) + getStringLiteralValue(node.right as StringLiteral);
}

/**
 * 判断节点是否为成员表达式
 * 
 * @param node AST 节点
 * @returns 是否为 MemberExpression 类型节点
 * 
 * 示例：
 * - isMemberExpression({type: "MemberExpression", object: ..., property: ...}) → true
 * - isMemberExpression({type: "Literal", value: "hello"}) → false
 */
function isMemberExpression(node: Node): node is MemberExpression {
  return node.type === "MemberExpression";
}

/**
 * 判断节点是否为二元表达式
 * 
 * @param node AST 节点
 * @returns 是否为 BinaryExpression 类型节点
 * 
 * 示例：
 * - isBinaryExpression({type: "BinaryExpression", operator: "+", left: ..., right: ...}) → true
 * - isBinaryExpression({type: "Literal", value: "hello"}) → false
 */
function isBinaryExpression(node: Node): node is BinaryExpression {
  return node.type === "BinaryExpression";
}

/**
 * JavaScript 文件依赖分析模块
 * 
 * 本模块用于分析 JavaScript 代码中的 FileAttachment 调用，是 Observable Framework 
 * 构建系统的重要组成部分。主要功能包括：
 * 
 * 1. 解析 JavaScript AST，查找所有 FileAttachment 调用
 * 2. 验证 FileAttachment 调用的合法性（参数必须是字符串字面量）
 * 3. 推断文件的处理方法（基于文件扩展名或显式方法调用）
 * 4. 支持不同的导入方式（observablehq:stdlib 和 npm:@observablehq/stdlib）
 * 5. 确保引用的文件路径是本地的（不允许引用外部文件）
 * 
 * 这个模块是构建过程中依赖收集的关键部分，帮助系统了解哪些文件需要被包含在最终构建中。
 */

import {extname} from "node:path/posix";
import type {CallExpression, MemberExpression, Node} from "acorn";
import {ancestor, simple} from "acorn-walk";
import {relativePath, resolveLocalPath} from "../path.js";
import {defaultGlobals} from "./globals.js";
import {findReferences} from "./references.js";
import {getStringLiteralValue, isStringLiteral} from "./source.js";
import {syntaxError} from "./syntaxError.js";

/**
 * FileAttachment 表达式描述接口
 * 
 * 描述在 JavaScript 代码中发现的 FileAttachment 调用的详细信息
 */
export type FileExpression = {
  /** FileAttachment(name) 调用表达式的 AST 节点 */
  node: CallExpression;
  /** 从引用源文件到目标文件的相对路径 */
  name: string;
  /** 文件处理方法（如果已知），例如 FileAttachment("foo").arrow 中的 "arrow" */
  method?: string;
};

/**
 * 已知文件扩展名与其默认处理方法的映射
 * 
 * 当 FileAttachment 调用没有显式指定方法时，根据文件扩展名自动推断处理方法。
 * 这些方法对应 FileAttachment 对象上的不同数据解析方法。
 */
const KNOWN_FILE_EXTENSIONS = {
  ".arrow": "arrow",        // Apache Arrow 格式
  ".csv": "csv",           // 逗号分隔值
  ".db": "sqlite",         // SQLite 数据库
  ".html": "html",         // HTML 文档
  ".json": "json",         // JSON 数据
  ".parquet": "parquet",   // Apache Parquet 格式
  ".sqlite": "sqlite",     // SQLite 数据库
  ".tsv": "tsv",          // 制表符分隔值
  ".txt": "text",         // 纯文本
  ".xlsx": "xlsx",        // Excel 工作簿
  ".xml": "xml",          // XML 文档
  ".zip": "zip"           // ZIP 压缩包
};

/**
 * 在指定的 JavaScript 代码体中查找所有 FileAttachment 调用
 * 
 * 此函数解析 JavaScript AST，查找所有对 FileAttachment 的调用，并验证其合法性。
 * 如果发现任何无效调用（例如传递动态参数或引用根目录外的文件），将抛出 SyntaxError。
 * 
 * @param body - 要分析的 JavaScript AST 节点
 * @param path - 当前源文件路径（用于解析相对路径）
 * @param input - 原始源代码字符串（用于错误报告）
 * @param aliases - FileAttachment 的别名集合（例如隐式导入时的 ["FileAttachment"]）
 * @returns FileExpression 数组，包含所有找到的 FileAttachment 调用信息
 * 
 * @throws SyntaxError 当发现无效的 FileAttachment 调用时
 * 
 * @example
 * ```javascript
 * // 有效的调用
 * FileAttachment("data.csv")
 * FileAttachment("data.csv").csv()
 * 
 * // 无效的调用（会抛出错误）
 * FileAttachment(dynamicPath)  // 动态参数
 * FileAttachment("../outside.csv")  // 外部文件
 * ```
 */
export function findFiles(
  body: Node,
  path: string,
  input: string,
  aliases?: Iterable<string> // ["FileAttachment"] for implicit import
): FileExpression[] {
  const declarations = new Set<{name: string}>();
  const alias = new Set<string>(aliases);
  let globals: Set<string> | undefined;

  // 查找 FileAttachment 的声明局部名称
  // 目前只支持命名导入，且 stdlib 必须不带版本号导入
  // TODO: 支持命名空间导入？如果 stdlib 带版本号则报错？
  simple(body, {
    ImportDeclaration(node) {
      // 支持两种导入方式：observablehq:stdlib 和 npm:@observablehq/stdlib
      if (node.source.value === "observablehq:stdlib" || node.source.value === "npm:@observablehq/stdlib") {
        for (const specifier of node.specifiers) {
          // 查找 FileAttachment 的命名导入
          if (
            specifier.type === "ImportSpecifier" &&
            specifier.imported.type === "Identifier" &&
            specifier.imported.name === "FileAttachment"
          ) {
            declarations.add(specifier.local);
            alias.add(specifier.local.name);
          }
        }
      }
    }
  });

  // 如果导入遮蔽了全局变量，不将其视为全局变量
  // （因为我们会忽略下面的导入声明）
  for (const name of alias.keys()) {
    if (defaultGlobals.has(name)) {
      (globals ??= new Set(defaultGlobals)).delete(name);
    }
  }

  // 收集所有对 FileAttachment 的引用
  const references = new Set(
    findReferences(body, {
      globals,
      filterDeclaration: (identifier) => !declarations.has(identifier) // 将导入的声明视为未绑定
    })
  );

  const files: FileExpression[] = [];

  // 查找所有对 FileAttachment 的调用
  // 如果调用是成员表达式的一部分（如 FileAttachment("foo.txt").csv），
  // 使用此信息确定文件方法（"csv"）；否则回退到文件扩展名来确定方法。
  // 同时强制要求 FileAttachment 传递单个静态字符串字面量。
  //
  // 注意：虽然动态导入要求路径以 ./、../ 或 / 开头，
  // 但文件附件没有相同的要求。与导入不同，你不能将全局文件引用为文件附件。
  ancestor(body, {
    CallExpression(node, state, stack) {
      const {callee} = node;
      
      // 检查是否为 FileAttachment 调用
      if (callee.type !== "Identifier" || !alias.has(callee.name) || !references.has(callee)) return;
      
      const args = node.arguments;
      
      // 验证参数数量
      if (args.length !== 1) throw syntaxError("FileAttachment requires a single literal string argument", node, input);
      
      const [arg] = args;
      
      // 验证参数类型（必须是字符串字面量）
      if (!isStringLiteral(arg)) throw syntaxError("FileAttachment requires a single literal string argument", node, input); // prettier-ignore
      
      const fileName = getStringLiteralValue(arg);
      const filePath = resolveLocalPath(path, fileName);
      
      // 验证文件路径是本地的
      if (!filePath) throw syntaxError(`non-local file path: ${fileName}`, node, input);
      
      const parent = stack[stack.length - 2];
      const name = relativePath(path, filePath);
      
      // 确定文件处理方法
      const method =
        parent && isMemberExpression(parent) && parent.property.type === "Identifier"
          ? parent.property.name === "arquero" && /\.parquet$/i.test(fileName)
            ? "arquero-parquet" // FileAttachment("foo.parquet").arquero - 特殊处理
            : parent.property.name // FileAttachment("foo.csv").csv - 显式方法调用
          : KNOWN_FILE_EXTENSIONS[extname(fileName).toLowerCase()]; // 纯 FileAttachment("foo.csv") - 基于扩展名推断
      
      files.push({node, name, method});
    }
  });

  return files;
}

/**
 * 类型守卫：检查节点是否为成员表达式
 * 
 * @param node - 要检查的 AST 节点
 * @returns 如果节点是成员表达式则返回 true
 */
function isMemberExpression(node: Node): node is MemberExpression {
  return node.type === "MemberExpression";
}

/**
 * 标签转换模块
 * 这个文件是 Observable Framework 中一个非常重要的模块，负责将各种特殊标签内容转换为可执行的 JavaScript 代码。
 * 1. 文件概述
 * 模块功能: 标签转换模块，将特殊标签内容转换为 JavaScript 模板字符串函数调用
 * 核心机制: Observable Framework 支持多种内容类型的基础
 * 主要功能: 4个核心功能点
 * 转换示例: 具体的输入输出示例
 * 工作原理: 使用 Acorn 解析器和 Sourcemap 的技术实现
 * 
 * 本模块负责将特殊标签内容（如 HTML、SVG、SQL、Mermaid 等）转换为 JavaScript 模板字符串函数调用。
 * 这是 Observable Framework 支持多种内容类型的核心机制。
 * 
 * 主要功能：
 * 1. 解析模板字符串语法（支持 ${expression} 插值）
 * 2. 转义特殊字符（反引号、反斜杠等）
 * 3. 将原始内容包装为函数调用形式
 * 4. 处理嵌套的模板字符串和表达式
 * 
 * 转换示例：
 * 输入: `<div>${name}</div>` (HTML 标签内容)
 * 输出: `html.fragment`<div>${name}</div>``
 * 
 * 工作原理：
 * 使用自定义的 Acorn 解析器解析模板字符串，然后通过 Sourcemap 进行字符串操作，
 * 最终生成可在客户端执行的 JavaScript 代码。
 */

import type {Options, TemplateElement, TemplateLiteral} from "acorn";
// @ts-expect-error TokContext is private
import {Parser, TokContext, tokTypes as tt} from "acorn";
import {Sourcemap} from "./sourcemap.js";

// 字符编码常量定义
const CODE_DOLLAR = 36;      // $ 字符，用于模板字符串插值 ${...}
const CODE_BACKSLASH = 92;   // \ 字符，用于转义
const CODE_BACKTICK = 96;    // ` 字符，模板字符串分隔符
const CODE_BRACEL = 123;     // { 字符，用于插值表达式开始

/**
 * 转换标签内容为 JavaScript 模板字符串函数调用
 * 
 * 这是模块的主要入口函数，将任意文本内容转换为可执行的 JavaScript 代码。
 * 支持模板字符串语法，允许在内容中使用 ${expression} 进行动态插值。
 * 
 * @param input 原始输入内容（可能包含模板字符串语法）
 * @param tag 要调用的函数名（如 "html.fragment", "svg.fragment", "await mermaid" 等）
 * @param raw 是否为原始模式（true: 保持反引号不转义，false: 转义反引号）
 * @returns 转换后的 JavaScript 代码字符串
 * 
 * 示例：
 * transpileTag('<div>${name}</div>', 'html.fragment', false)
 * 返回: 'html.fragment`<div>${name}</div>`'
 * 
 * transpileTag('graph TD\n  A-->B', 'await mermaid', false)  
 * 返回: 'await mermaid`graph TD\n  A-->B`'
 */
export function transpileTag(input: string, tag = "", raw = false): string {
  // 使用自定义解析器解析输入为模板字符串 AST suchao:使用acorn不是解析JS的源码是模板字符串
  const template = TemplateParser.parse(input, {ecmaVersion: 13, sourceType: "module"}) as unknown as TemplateLiteral;
  
  // 创建源码映射对象，用于字符串操作
  const output = new Sourcemap(input);
  output.trim();  // 去除首尾空白
  
  // 转义模板元素中的特殊字符
  escapeTemplateElements(output, template, raw);
  
  // 在开头插入函数名和开始的反引号
  output.insertLeft(template.start, tag + "`");
  
  // 在结尾插入结束的反引号
  output.insertRight(template.end, "`");
  
  return String(output);
}

/**
 * 自定义模板解析器类
 * 继承自 Acorn Parser，专门用于解析模板字符串内容
 * 
 * 特点：
 * 1. 初始化时设置为模板字符串解析模式
 * 2. 使用自定义的 token 上下文处理反引号
 * 3. 支持在模板中使用反引号（通常情况下会冲突）
 */
class TemplateParser extends (Parser as any) {
  /**
   * 构造函数
   * 初始化解析器状态，设置为模板字符串解析模式
   * 
   * @param options Acorn 解析选项
   * @param input 输入字符串
   * @param startPos 开始位置（可选）
   */
  constructor(options: Options, input: string, startPos?: number) {
    super(options, input, startPos);
    // 初始化 token 类型为反引号，表示我们在模板字符串内部
    this.type = tt.backQuote;
    this.exprAllowed = false;  // 不允许表达式（在模板字符串内部）
  }
  
  /**
   * 初始化解析上下文
   * 返回自定义的模板上下文，启用特殊的模板 token 处理
   * 
   * @returns 包含自定义模板上下文的数组
   */
  initialContext() {
    // 提供我们的自定义 TokContext
    return [o_tmpl];
  }
  
  /**
   * 解析顶级模板字符串
   * 基于 acorn.Parser.parseTemplate 的实现
   * 解析模板字符串的各个部分：静态文本和插值表达式
   * 
   * @param body AST 节点主体
   * @returns 解析后的模板字符串 AST
   */
  parseTopLevel(body) {
    // 修复 nextToken 调用 finishToken(tt.eof) 的问题
    if (this.type === tt.eof) this.value = "";
    
    // 基于 acorn.Parser.parseTemplate 的实现
    const isTagged = true;  // 标记为标签模板字符串
    body.expressions = [];  // 存储插值表达式
    
    // 解析第一个模板元素（静态文本部分）
    let curElt = this.parseTemplateElement({isTagged});
    body.quasis = [curElt];  // 存储模板的静态部分
    
    // 循环解析插值表达式和后续的静态文本
    while (this.type !== tt.eof) {
      this.expect(tt.dollarBraceL);  // 期望 ${
      body.expressions.push(this.parseExpression());  // 解析插值表达式
      this.expect(tt.braceR);  // 期望 }
      body.quasis.push((curElt = this.parseTemplateElement({isTagged})));  // 解析下一个静态部分
    }
    
    curElt.tail = true;  // 标记最后一个元素
    this.next();
    this.finishNode(body, "TemplateLiteral");
    this.expect(tt.eof);
    return body;
  }
}

// 基于 acorn 的 q_tmpl 上下文
// 我们使用这个来初始化解析器上下文，以便调用我们的 `readTemplateToken` 重写函数
// `readTemplateToken` 基于 acorn 的 `readTmplToken`，用于模板字符串内部
// 我们的版本允许使用反引号
const o_tmpl = new TokContext(
  "`",                // token 字符
  true,              // isExpr - 是否为表达式上下文
  true,              // preserveSpace - 是否保留空白
  readTemplateToken  // override - 自定义 token 读取函数
);

/**
 * 自定义模板 token 读取函数
 * 这是我们用于解析允许反引号的模板的自定义重写函数
 * 基于 acorn 的 readInvalidTemplateToken 实现
 * 
 * @param parser 解析器实例
 * @returns 解析的 token
 */
function readTemplateToken(parser: any) {
  out: for (; parser.pos < parser.input.length; parser.pos++) {
    switch (parser.input.charCodeAt(parser.pos)) {
      case CODE_BACKSLASH: {
        // 处理反斜杠转义
        if (parser.pos < parser.input.length - 1) ++parser.pos; // 不是末尾的反斜杠
        break;
      }
      case CODE_DOLLAR: {
        // 检查是否为插值表达式开始 ${
        if (parser.input.charCodeAt(parser.pos + 1) === CODE_BRACEL) {
          if (parser.pos === parser.start && parser.type === tt.invalidTemplate) {
            parser.pos += 2;
            return parser.finishToken(tt.dollarBraceL);
          }
          break out;  // 跳出循环，处理插值表达式
        }
        break;
      }
    }
  }
  // 返回无效模板 token，包含当前解析的文本内容
  return parser.finishToken(tt.invalidTemplate, parser.input.slice(parser.start, parser.pos));
}

/**
 * 转义模板元素中的特殊字符
 * 根据 raw 模式决定如何处理反引号和反斜杠
 * 
 * @param source 源码映射对象
 * @param template 模板字符串 AST 节点，包含 quasis（静态部分）数组
 * @param raw 是否为原始模式
 * 
 * 处理逻辑：
 * - raw=false: 转义反引号和反斜杠，防止与外层模板字符串冲突
 * - raw=true: 插值反引号（转换为表达式），保持原始内容的语义
 */
function escapeTemplateElements(source: Sourcemap, {quasis}: TemplateLiteral, raw: boolean): void {
  for (const quasi of quasis) {
    if (raw) {
      // 原始模式：将反引号转换为插值表达式
      interpolateBacktick(source, quasi);
    } else {
      // 标准模式：转义反引号和反斜杠
      escapeBacktick(source, quasi);
      escapeBackslash(source, quasi);
    }
  }
  // 原始模式下处理末尾的反斜杠
  if (raw) interpolateTerminalBackslash(source);
}

/**
 * 转义反引号字符
 * 在模板元素中的每个反引号前添加反斜杠进行转义
 * 防止与外层模板字符串的反引号冲突
 * 
 * @param source 源码映射对象
 * @param element 模板元素（包含 start 和 end 位置）
 */
function escapeBacktick(source: Sourcemap, {start, end}: TemplateElement): void {
  const input = source.input;
  for (let i = start; i < end; ++i) {
    if (input.charCodeAt(i) === CODE_BACKTICK) {
      // 在反引号前插入反斜杠
      source.insertRight(i, "\\");
    }
  }
}

/**
 * 插值反引号字符（原始模式）
 * 将连续的反引号转换为插值表达式 ${'```'}
 * 这样可以在原始模式下保持反引号的原始语义
 * 
 * @param source 源码映射对象
 * @param element 模板元素（包含 start 和 end 位置）
 */
function interpolateBacktick(source: Sourcemap, {start, end}: TemplateElement): void {
  const input = source.input;
  let oddBackslashes = false;  // 跟踪奇数个反斜杠（影响转义）
  
  for (let i = start; i < end; ++i) {
    switch (input.charCodeAt(i)) {
      case CODE_BACKSLASH: {
        // 切换反斜杠奇偶状态
        oddBackslashes = !oddBackslashes;
        break;
      }
      case CODE_BACKTICK: {
        // 如果不是被转义的反引号
        if (!oddBackslashes) {
          // 找到连续反引号的结束位置
          let j = i + 1;
          while (j < end && input.charCodeAt(j) === CODE_BACKTICK) ++j;
          
          // 将连续反引号替换为插值表达式
          // 例如：``` 变成 ${'```'}
          source.replaceRight(i, j, `\${'${"`".repeat(j - i)}'}`);
          i = j - 1;
        }
        // fall through - 继续执行下面的 default 分支
      }
      default: {
        // 重置反斜杠状态
        oddBackslashes = false;
        break;
      }
    }
  }
}

/**
 * 转义反斜杠字符
 * 处理模板中的反斜杠转义，特别注意插值表达式附近的情况
 * 
 * @param source 源码映射对象
 * @param element 模板元素（包含 start 和 end 位置）
 * 
 * 转义规则：
 * 1. 一般情况下，反斜杠前添加反斜杠进行转义
 * 2. ${ 前的反斜杠不转义（保持插值语法）
 * 3. \${ 中的反斜杠不转义（已经是转义序列）
 */
function escapeBackslash(source: Sourcemap, {start, end}: TemplateElement): void {
  const input = source.input;
  let afterDollar = false;     // 是否在 $ 字符之后
  let oddBackslashes = false;  // 奇数个反斜杠状态
  
  for (let i = start; i < end; ++i) {
    switch (input.charCodeAt(i)) {
      case CODE_DOLLAR: {
        afterDollar = true;
        oddBackslashes = false;
        break;
      }
      case CODE_BACKSLASH: {
        oddBackslashes = !oddBackslashes;
        
        // 如果在 ${ 前的反斜杠，跳过不转义
        if (afterDollar && input.charCodeAt(i + 1) === CODE_BRACEL) continue;
        
        // 如果是 \${ 模式中的反斜杠，跳过不转义
        if (oddBackslashes && input.charCodeAt(i + 1) === CODE_DOLLAR && input.charCodeAt(i + 2) === CODE_BRACEL)
          continue;
        
        // 其他情况下转义反斜杠
        source.insertRight(i, "\\");
        break;
      }
      default: {
        afterDollar = false;
        oddBackslashes = false;
        break;
      }
    }
  }
}

/**
 * 处理末尾反斜杠的插值（原始模式）
 * 如果输入以奇数个反斜杠结尾，将最后一个反斜杠转换为插值表达式
 * 这样可以避免反斜杠影响外层模板字符串的结束反引号
 * 
 * @param source 源码映射对象
 */
function interpolateTerminalBackslash(source: Sourcemap): void {
  const input = source.input;
  let oddBackslashes = false;
  
  // 从末尾开始计算连续反斜杠的数量
  for (let i = input.length - 1; i >= 0; i--) {
    if (input.charCodeAt(i) === CODE_BACKSLASH) oddBackslashes = !oddBackslashes;
    else break;
  }
  
  // 如果末尾有奇数个反斜杠，将最后一个转换为插值
  if (oddBackslashes) source.replaceRight(input.length - 1, input.length, "${'\\\\'}");
}

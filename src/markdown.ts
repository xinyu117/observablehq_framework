/**
 * Markdown 解析和处理模块
 * 
 * 本模块是 Observable Framework 的核心组件，负责将 Markdown 内容转换为可执行的 HTML 页面。
 * 主要功能包括：
 * 
 * 1. Markdown 到 HTML 的转换（使用 MarkdownIt）
 * 2. JavaScript 代码块的识别和转译（支持 js, ts, jsx, tsx 等）
 * 3. 占位符表达式的解析和处理（${expression} 语法）
 * 4. 特殊标签的处理（SQL, HTML, SVG, Mermaid, TeX 等）
 * 5. 前置元数据（Front Matter）的解析
 * 6. 页面标题、头部、底部等结构的生成
 * 
 * 工作流程：
 * Markdown 源码 → Front Matter 解析 → Token 解析 → HTML 渲染 → 页面组装
 */

/* eslint-disable import/no-named-as-default-member */
import {createHash} from "node:crypto";
import slugify from "@sindresorhus/slugify";
import he from "he";
import MarkdownIt from "markdown-it";
import type {RuleCore} from "markdown-it/lib/parser_core.mjs";
import type {RuleInline} from "markdown-it/lib/parser_inline.mjs";
import type {RenderRule} from "markdown-it/lib/renderer.mjs";
import type Token from "markdown-it/lib/token.mjs";
import MarkdownItAnchor from "markdown-it-anchor";
import type {Config} from "./config.js";
import {mergeStyle} from "./config.js";
import type {FrontMatter} from "./frontMatter.js";
import {readFrontMatter} from "./frontMatter.js";
import {html, rewriteHtmlPaths} from "./html.js";
import {parseInfo} from "./info.js";
import {transformJavaScriptSync} from "./javascript/module.js";
import type {JavaScriptNode} from "./javascript/parse.js";
import {parseJavaScript} from "./javascript/parse.js";
import {isAssetPath, relativePath} from "./path.js";
import {parsePlaceholder} from "./placeholder.js";
import type {Params} from "./route.js";
import {transpileSql} from "./sql.js";
import {transpileTag} from "./tag.js";
import {InvalidThemeError} from "./theme.js";
import {red} from "./tty.js";

/**
 * Markdown 代码块信息接口
 * 描述从 Markdown 中提取的可执行 JavaScript 代码块
 */
export interface MarkdownCode {
  /** 代码块的唯一标识符，用于客户端执行时的引用 */
  id: string;
  /** 解析后的 JavaScript AST 节点 */
  node: JavaScriptNode;
  /** 代码块的执行模式：内联、块级或 JSX 组件 */
  mode: "inline" | "block" | "jsx";
}

/**
 * Markdown 页面对象接口
 * 表示完整的页面结构，包含所有必要的 HTML 部分和元数据
 */
export interface MarkdownPage {
  /** 页面标题（从 Front Matter 或第一个 H1 标题提取） */
  title: string | null;
  /** HTML head 部分内容 */
  head: string | null;
  /** 页面头部内容 */
  header: string | null;
  /** 页面主体 HTML 内容 */
  body: string;
  /** 页面底部内容 */
  footer: string | null;
  /** Front Matter 解析出的数据 */
  data: FrontMatter;
  /** 页面样式配置 */
  style: string | null;
  /** 页面中提取的所有 JavaScript 代码块 */
  code: MarkdownCode[];
  /** 源文件路径 */
  path: string;
  /** 路由参数（用于参数化页面） */
  params?: Params;
}

/**
 * Markdown 解析上下文接口
 * 在解析过程中传递状态信息
 */
interface ParseContext {
  /** 收集到的代码块数组 */
  code: MarkdownCode[];
  /** 起始行号 */
  startLine: number;
  /** 当前行号 */
  currentLine: number;
  /** 当前文件路径 */
  path: string;
  /** 路由参数 */
  params?: Params;
}

/**
 * 生成唯一的代码块标识符
 * 基于代码内容的哈希值，如果重复则添加数字后缀
 * 
 * @param context 解析上下文
 * @param content 代码内容
 * @returns 唯一的代码块 ID
 */
function uniqueCodeId(context: ParseContext, content: string): string {
  const hash = createHash("sha256").update(content).digest("hex").slice(0, 8);
  let id = hash;
  let count = 1;
  // 确保 ID 在当前页面中唯一
  while (context.code.some((code) => code.id === id)) id = `${hash}-${count++}`;
  return id;
}

/**
 * 检查属性值是否为 "false"
 * 用于处理代码块属性，如 run="false"
 * 
 * @param attribute 属性值
 * @returns 是否为 false
 */
function isFalse(attribute: string | undefined): boolean {
  return attribute?.toLowerCase() === "false";
}

/**
 * 转译 JavaScript 代码
 * 支持 TypeScript、JSX 等语法的转换
 * 
 * @param content 源代码内容
 * @param tag 代码类型标签
 * @returns 转译后的 JavaScript 代码
 * @throws SyntaxError 转译失败时抛出语法错误
 */
function transpileJavaScript(content: string, tag: "ts" | "jsx" | "tsx"): string {
  try {
    return transformJavaScriptSync(content, tag);
  } catch (error: any) {
    throw new SyntaxError(error.message);
  }
}

/**
 * 获取可执行代码的源码
 * 根据代码块标签类型进行相应的转译处理 suchao:把字符窜变成字符串模版函数，解析这个函数就可以加载第三方包了
 * 
 * @param content 原始代码内容
 * @param tag 代码块标签（js, ts, jsx, tsx, sql, html, svg, mermaid, tex, dot）
 * @param attributes 代码块属性
 * @returns 转译后的可执行代码，如果不支持则返回 undefined
 */
function getLiveSource(content: string, tag: string, attributes: Record<string, string>): string | undefined {
  return tag === "js"
    ? content  // JavaScript 代码直接使用
    : tag === "ts" || tag === "jsx" || tag === "tsx"
    ? transpileJavaScript(content, tag)  // TypeScript/JSX 需要转译
    : tag === "tex"
    ? transpileTag(content, "tex.block", true)  // TeX 数学公式
    : tag === "html"
    ? transpileTag(content, "html.fragment", true)  // HTML 片段
    : tag === "sql"
    ? transpileSql(content, attributes)  // SQL 查询
    : tag === "svg"
    ? transpileTag(content, "svg.fragment", true)  // SVG 图形
    : tag === "dot"
    ? transpileTag(content, "dot", false)  // Graphviz DOT 图
    : tag === "mermaid"
    ? transpileTag(content, "await mermaid", false)  // Mermaid 图表  // suchao: 这里需要修改，因为mermaid的图表是异步加载的，所以需要使用await来等待图表加载完成
    : undefined;  // 不支持的标签类型
}

// TODO: 改进错误处理
// 计划添加源码行号映射和语法错误位置重映射功能
// 考虑在错误信息中显示代码片段和文件名
//
// const message = error.message;
// if (verbose) {
//   let warning = error.message;
//   const match = /^(.+)\s\((\d+):(\d+)\)$/.exec(message);
//   if (match) {
//     const line = +match[2] + (options?.sourceLine ?? 0);
//     const column = +match[3] + 1;
//     warning = `${match[1]} at line ${line}, column ${column}`;
//   } else if (options?.sourceLine) {
//     warning = `${message} at line ${options.sourceLine + 1}`;
//   }
//   console.error(red(`${error.name}: ${warning}`));
// }

/**
 * MarkdownIt 的围栏代码块渲染器工厂函数
 * 处理代码块(```js, ```python等)的渲染，支持可执行代码和静态显示
 * 
 * @param baseRenderer 原始的 fence 渲染器
 * @returns 增强的 fence 渲染器，支持代码执行和错误处理
 * 
 * 功能：
 * 1. 解析代码块信息（语言、属性）
 * 2. 判断是否应该执行代码（run=false 时不执行）
 * 3. 生成可执行代码的容器和标记
 * 4. 处理语法错误并显示友好的错误信息
 * 5. 根据 echo 属性控制源码显示
 */
function makeFenceRenderer(baseRenderer: RenderRule): RenderRule {
  return (tokens, idx, options, context: ParseContext, self) => {
    const {path, params} = context;
    const token = tokens[idx];
    const {tag, attributes} = parseInfo(token.info);  // 解析代码块信息，如js、python等
    token.info = tag;
    let html = "";
    let source: string | undefined;
    
    try {
      // 检查是否应该执行代码（run=false时不执行）
      source = isFalse(attributes.run) ? undefined : getLiveSource(token.content, tag, attributes);
      if (source != null) {
        // 为可执行代码生成唯一ID
        const id = uniqueCodeId(context, source);
        // TODO: 添加源码行号支持
        // const sourceLine = context.startLine + context.currentLine;
        
        // 解析JavaScript AST
        const node = parseJavaScript(source, {path, params});
        
        // 添加到页面的代码集合中，用于后续客户端执行
        context.code.push({id, node, mode: tag === "jsx" || tag === "tsx" ? "jsx" : "block"});
        
        // 生成HTML容器，包含加载指示器和标记注释
        // 如果是表达式，显示加载指示器；否则只显示标记注释
        html += `<div class="observablehq observablehq--block">${
          node.expression ? "<observablehq-loading></observablehq-loading>" : ""
        }<!--:${id}:--></div>\n`;
      }
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      // 语法错误时显示错误信息，使用友好的样式
      html += `<div class="observablehq observablehq--block">
  <div class="observablehq--inspect observablehq--error">SyntaxError: ${he.escape(error.message)}</div>
</div>\n`;
    }
    
    // 根据echo属性决定是否显示源码
    // - 如果没有可执行源码，默认显示原始代码
    // - 如果有可执行源码，echo=null时不显示，echo=true时显示
    // - echo=false时强制不显示源码
    if (attributes.echo == null ? source == null : !isFalse(attributes.echo)) {
      html += baseRenderer(tokens, idx, options, context, self);
    }
    return html;
  };
}

// 占位符语法相关的字符码
const CODE_DOLLAR = 36;   // $ 字符
const CODE_BRACEL = 123;  // { 字符

/**
 * 内联占位符转换规则
 * 处理 Markdown 文本中的内联表达式，如：${expression}
 * 这些表达式会在客户端动态计算并显示结果
 * 
 * @param state MarkdownIt 解析状态
 * @param silent 是否为静默模式（仅检查而不生成 token）
 * @returns 是否成功解析占位符
 * 
 * 工作原理：
 * 1. 检查当前位置是否为 ${ 开始的占位符
 * 2. 使用专门的占位符解析器解析完整表达式
 * 3. 生成占位符 token 供后续渲染使用
 */
const transformPlaceholderInline: RuleInline = (state, silent) => {
  // 检查是否有足够的字符来形成占位符
  if (silent || state.pos + 2 > state.posMax) return false;
  
  const marker1 = state.src.charCodeAt(state.pos);      // $ 字符码
  const marker2 = state.src.charCodeAt(state.pos + 1);  // { 字符码
  if (marker1 !== CODE_DOLLAR || marker2 !== CODE_BRACEL) return false;
  
  // 使用专门的占位符解析器解析表达式
  for (const {type, content, pos} of parsePlaceholder(state.src, state.pos, state.posMax)) {
    if (type !== "placeholder") break;
    const token = state.push(type, "", 0);
    token.content = content;
    state.pos = pos;
    return true;
  }
  return false;
};

/**
 * 核心占位符转换规则
 * 处理 HTML 块中的占位符表达式
 * 如果 HTML 块包含占位符，将其转换为内联 token 以便后续处理
 * 
 * @param state MarkdownIt 核心解析状态
 * 
 * 工作原理：
 * 1. 遍历所有 HTML 块 token
 * 2. 解析每个 HTML 块中的占位符
 * 3. 如果包含占位符，将 HTML 块转换为内联 token
 * 4. 这样可以让占位符和 HTML 内容混合渲染
 */
const transformPlaceholderCore: RuleCore = (state) => {
  const {tokens} = state;
  for (let i = 0, n = tokens.length; i < n; ++i) {
    const token = tokens[i];
    if (token.type === "html_block") {
      const children: Token[] = [];
      
      // 解析HTML块中的所有占位符
      for (const {type, content} of parsePlaceholder(token.content)) {
        const child = new state.Token(type, "", 0);
        child.content = content;
        children.push(child);
      }
      
      // 如果只有一个HTML块且无占位符，保持原样
      if (children.length === 1 && children[0].type === "html_block") {
        tokens[i].content = children[0].content;
      } else {
        // 否则创建内联token来包含混合内容
        const inline = new state.Token("inline", "", 0);
        inline.children = children;
        tokens[i] = inline;
      }
    }
  }
};

/**
 * 占位符渲染器工厂函数
 * 生成用于渲染占位符的 HTML，包含加载指示器和唯一标识
 * 
 * @returns 占位符渲染函数
 * 
 * 功能：
 * 1. 为每个占位符生成唯一 ID
 * 2. 解析占位符中的 JavaScript 表达式
 * 3. 生成包含加载指示器的 HTML
 * 4. 处理语法错误并显示错误信息
 */
function makePlaceholderRenderer(): RenderRule {
  return (tokens, idx, options, context: ParseContext) => {
    const {path, params} = context;
    const token = tokens[idx];
    const id = uniqueCodeId(context, token.content);
    
    try {
      // TODO: 添加源码行号支持
      // sourceLine: context.startLine + context.currentLine
      // TODO: 考虑允许 TypeScript 语法？
      
      // 解析JavaScript表达式
      const node = parseJavaScript(token.content, {path, params, inline: true});
      
      // 添加到页面代码集合中
      context.code.push({id, node, mode: "inline"});
      
      // 返回包含加载指示器和标记注释的HTML
      return `<observablehq-loading></observablehq-loading><!--:${id}:-->`;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      // 语法错误时显示错误信息
      return `<span class="observablehq--inspect observablehq--error" style="display: block;">SyntaxError: ${he.escape(
        error.message
      )}</span>`;
    }
  };
}

/**
 * 软换行渲染器工厂函数
 * 增强基础软换行渲染器，追踪当前行号
 * 
 * @param baseRenderer 原始软换行渲染器
 * @returns 增强的软换行渲染器
 * 
 * 功能：
 * 追踪解析过程中的行号变化，用于错误报告和调试
 */
function makeSoftbreakRenderer(baseRenderer: RenderRule): RenderRule {
  return (tokens, idx, options, context: ParseContext, self) => {
    context.currentLine++;  // 更新行号计数
    return baseRenderer(tokens, idx, options, context, self);
  };
}

/**
 * Markdown 解析选项接口
 * 定义解析 Markdown 时需要的各种配置选项
 */
export interface ParseOptions {
  /** 配置好的 MarkdownIt 实例 */
  md: MarkdownIt;
  /** 当前文件路径 */
  path: string;
  /** 样式配置 */
  style?: Config["style"];
  /** 脚本配置（已废弃） */
  scripts?: Config["scripts"];
  /** 头部配置 */
  head?: Config["head"];
  /** 页面头部配置 */
  header?: Config["header"];
  /** 页面底部配置 */
  footer?: Config["footer"];
  /** 源文件路径（可能与 path 不同） */
  source?: string;
  /** 路由参数 */
  params?: Params;
}

/**
 * 创建配置好的 MarkdownIt 实例
 * 设置各种渲染规则和插件，支持 Observable 特有的功能
 * 
 * @param options 配置选项
 * @param options.markdownIt 自定义 MarkdownIt 配置函数
 * @param options.linkify 是否启用链接自动识别
 * @param options.quotes 引号样式
 * @param options.typographer 是否启用排版优化
 * @returns 配置好的 MarkdownIt 实例
 * 
 * 配置内容：
 * 1. 基础 MarkdownIt 配置（HTML 支持、链接识别等）
 * 2. 锚点插件（自动为标题生成锚点）
 * 3. Observable 特有的解析规则（占位符处理）
 * 4. 自定义渲染器（代码块、占位符、软换行）
 * 5. 用户自定义配置应用
 */
export function createMarkdownIt({
  markdownIt,
  linkify = true,
  quotes = "“”‘’",
  typographer = false
}: {
  markdownIt?: (md: MarkdownIt) => MarkdownIt;
  linkify?: boolean;
  quotes?: string | string[];
  typographer?: boolean;
} = {}): MarkdownIt {
  // 创建基础MarkdownIt实例，启用HTML支持
  const md = MarkdownIt({html: true, linkify, typographer, quotes});
  
  // 配置链接识别规则，禁用模糊匹配以提高准确性
  if (linkify) md.linkify.set({fuzzyLink: false, fuzzyEmail: false});
  
  // 添加锚点插件，用于标题的自动锚点生成
  md.use(MarkdownItAnchor, {slugify: (s) => slugify(s)});
  
  // 注册 Observable 特有的解析规则
  md.inline.ruler.push("placeholder", transformPlaceholderInline);          // 内联占位符
  md.core.ruler.after("inline", "placeholder", transformPlaceholderCore);   // 核心占位符处理
  
  // 注册自定义渲染器
  md.renderer.rules.placeholder = makePlaceholderRenderer();  // 占位符渲染
  md.renderer.rules.fence = makeFenceRenderer(md.renderer.rules.fence!);  // 代码块渲染
  md.renderer.rules.softbreak = makeSoftbreakRenderer(md.renderer.rules.softbreak!);  // 软换行
  
  // 应用用户自定义配置
  return markdownIt === undefined ? md : markdownIt(md);
}

/**
 * 解析 Markdown 文档为 MarkdownPage 对象
 * 这是 Markdown 转换的主要入口点，完成从原始 Markdown 到结构化页面对象的转换
 * 
 * @param input 原始 Markdown 文本
 * @param options 解析选项，包含 MarkdownIt 实例、路径信息等
 * @returns 包含 HTML 内容、元数据和代码的 MarkdownPage 对象
 * 
 * 工作流程：
 * 1. 解析 Front Matter（前置元数据）
 * 2. 初始化解析上下文
 * 3. 使用 MarkdownIt 解析为 token 树
 * 4. 渲染 token 为 HTML（同时提取代码块）
 * 5. 提取或查找页面标题
 * 6. 构建完整的页面对象
 */
export function parseMarkdown(input: string, options: ParseOptions): MarkdownPage {
  const {md, path, source = path, params} = options;
  
  // 1. 解析Front Matter（前置元数据）
  const {content, data} = readFrontMatter(input);
  
  // 2. 初始化解析上下文
  const code: MarkdownCode[] = [];
  const context: ParseContext = {code, startLine: 0, currentLine: 0, path, params};
  const tokens = md.parse(content, context);
  
  // 4. 渲染tokens为HTML（注意：这会修改code数组！）
  const body = md.renderer.render(tokens, md.options, context);
  
  // 5. 提取或查找页面标题
  const title = data.title !== undefined ? data.title : findTitle(tokens);
  
  // 6. 构建完整的页面对象
  return {
    head: getHead(title, data, options),        // HTML head内容
    header: getHeader(title, data, options),    // 页面头部
    body,                                       // 主要HTML内容
    footer: getFooter(title, data, options),    // 页面底部
    data,                                       // Front Matter数据
    title,                                      // 页面标题
    style: getStyle(data, options),             // 样式信息
    code,                                       // 提取的JavaScript代码
    path: source,                               // 源文件路径
    params                                      // 路由参数
  };
}

/**
 * 解析 Markdown 元数据的优化版本
 * 只提取标题和 Front Matter 数据，不进行完整的 HTML 渲染
 * 用于快速获取页面元信息，例如在构建索引或导航时使用
 * 
 * @param input 原始 Markdown 文本
 * @param options 解析选项
 * @returns 包含数据和标题的部分页面对象
 */
export function parseMarkdownMetadata(input: string, options: ParseOptions): Pick<MarkdownPage, "data" | "title"> {
  const {md, path} = options;
  const {content, data} = readFrontMatter(input);
  return {
    data,
    title:
      data.title !== undefined
        ? data.title
        : findTitle(md.parse(content, {code: [], startLine: 0, currentLine: 0, path}))
  };
}

/**
 * 获取页面 head 部分内容
 * 包括前置元数据中的 head 配置和脚本引用
 * 
 * @param title 页面标题
 * @param data Front Matter 数据
 * @param options 解析选项
 * @returns HTML head 内容字符串
 */
function getHead(title: string | null, data: FrontMatter, options: ParseOptions): string | null {
  const {scripts, path} = options;
  let head = getHtml("head", title, data, options);
  
  // 添加脚本引用（已废弃的功能）
  if (scripts?.length) {
    head ??= "";
    for (const {type, async, src} of scripts) {
      head += html`${head ? "\n" : ""}<script${type ? html` type="${type}"` : null}${
        async ? html` async` : null
      } src="${isAssetPath(src) ? relativePath(path, src) : src}"></script>`;
    }
  }
  return head;
}

/**
 * 获取页面头部内容
 * 
 * @param title 页面标题
 * @param data Front Matter 数据
 * @param options 解析选项
 * @returns 页面头部 HTML 内容
 */
function getHeader(title: string | null, data: FrontMatter, options: ParseOptions): string | null {
  return getHtml("header", title, data, options);
}

/**
 * 获取页面底部内容
 * 
 * @param title 页面标题
 * @param data Front Matter 数据
 * @param options 解析选项
 * @returns 页面底部 HTML 内容
 */
function getFooter(title: string | null, data: FrontMatter, options: ParseOptions): string | null {
  return getHtml("footer", title, data, options);
}

/**
 * 获取 HTML 片段的通用函数
 * 支持从 Front Matter 或配置中获取内容，并进行路径重写
 * 
 * @param key HTML 片段的键名（head、header、footer）
 * @param title 页面标题
 * @param data Front Matter 数据
 * @param options 解析选项，包含默认值配置
 * @returns HTML 内容字符串
 */
function getHtml(
  key: "head" | "header" | "footer",
  title: string | null,
  data: FrontMatter,
  {path, [key]: defaultValue}: ParseOptions
): string | null {
  // 优先使用 Front Matter 中的配置
  if (data[key] !== undefined) return data[key] != null ? String(data[key]) : null;
  
  // 使用默认配置，支持函数和字符串两种形式
  const value = typeof defaultValue === "function" ? defaultValue({title, data, path}) : defaultValue;
  
  // 重写路径以确保资源引用正确
  return value != null ? rewriteHtmlPaths(value, path) : null;
}

/**
 * 获取页面样式配置
 * 合并 Front Matter 中的样式和主题配置
 * 
 * @param data Front Matter 数据
 * @param options 解析选项
 * @returns 样式配置字符串
 */
function getStyle(data: FrontMatter, {path, style = null}: ParseOptions): string | null {
  try {
    // 合并样式配置：Front Matter 样式/主题 + 默认样式
    style = mergeStyle(path, data.style, data.theme, style);
  } catch (error) {
    if (!(error instanceof InvalidThemeError)) throw error;
    // 主题错误时显示警告并使用空主题
    console.error(red(String(error))); // TODO: 在构建过程中处理错误
    style = {theme: []};
  }
  
  return !style
    ? null
    : "path" in style
    ? relativePath(path, style.path)  // 自定义样式文件路径
    : `observablehq:theme-${style.theme.join(",")}.css`;  // 内置主题
}

/**
 * 查找页面标题
 * 在 token 树中寻找第一个 H1 标题作为页面标题
 * 
 * @param tokens MarkdownIt 解析的 token 数组
 * @returns 页面标题字符串，如果没有找到则返回 null
 * 
 * TODO: 改进标题提取算法
 * - 支持更复杂的标题结构
 * - 处理包含链接、代码等的标题
 * - 考虑多语言支持
 */
function findTitle(tokens: ReturnType<MarkdownIt["parse"]>): string | null {
  for (const [i, token] of tokens.entries()) {
    if (token.type === "heading_open" && token.tag === "h1") {
      const next = tokens[i + 1];
      if (next?.type === "inline") {
        // 提取标题中的纯文本内容
        const text = next.children
          ?.filter((t) => t.type === "text")
          .map((t) => t.content)
          .join("");
        if (text) {
          return text;
        }
      }
    }
  }
  return null;
}

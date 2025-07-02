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

export interface MarkdownCode {
  id: string;
  node: JavaScriptNode;
  mode: "inline" | "block" | "jsx";
}

export interface MarkdownPage {
  title: string | null;
  head: string | null;
  header: string | null;
  body: string;
  footer: string | null;
  data: FrontMatter;
  style: string | null;
  code: MarkdownCode[];
  path: string;
  params?: Params;
}

interface ParseContext {
  code: MarkdownCode[];
  startLine: number;
  currentLine: number;
  path: string;
  params?: Params;
}

function uniqueCodeId(context: ParseContext, content: string): string {
  const hash = createHash("sha256").update(content).digest("hex").slice(0, 8);
  let id = hash;
  let count = 1;
  while (context.code.some((code) => code.id === id)) id = `${hash}-${count++}`;
  return id;
}

function isFalse(attribute: string | undefined): boolean {
  return attribute?.toLowerCase() === "false";
}

function transpileJavaScript(content: string, tag: "ts" | "jsx" | "tsx"): string {
  try {
    return transformJavaScriptSync(content, tag);
  } catch (error: any) {
    throw new SyntaxError(error.message);
  }
}

function getLiveSource(content: string, tag: string, attributes: Record<string, string>): string | undefined {
  return tag === "js"
    ? content
    : tag === "ts" || tag === "jsx" || tag === "tsx"
    ? transpileJavaScript(content, tag)
    : tag === "tex"
    ? transpileTag(content, "tex.block", true)
    : tag === "html"
    ? transpileTag(content, "html.fragment", true)
    : tag === "sql"
    ? transpileSql(content, attributes)
    : tag === "svg"
    ? transpileTag(content, "svg.fragment", true)
    : tag === "dot"
    ? transpileTag(content, "dot", false)
    : tag === "mermaid"
    ? transpileTag(content, "await mermaid", false)
    : undefined;
}

// TODO sourceLine and remap syntax error position; consider showing a code
// snippet along with the error. Also, consider whether we want to show the
// file name here.
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
 * MarkdownIt的围栏代码块渲染器工厂函数
 * 处理代码块(```js, ```python等)的渲染，支持可执行代码和静态显示
 * @param baseRenderer 原始的fence渲染器
 * @returns 增强的fence渲染器
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
        // TODO const sourceLine = context.startLine + context.currentLine;
        
        // 解析JavaScript AST
        const node = parseJavaScript(source, {path, params});
        
        // 添加到页面的代码集合中，用于后续客户端执行
        context.code.push({id, node, mode: tag === "jsx" || tag === "tsx" ? "jsx" : "block"});
        
        // 生成HTML容器，包含加载指示器和标记注释
        html += `<div class="observablehq observablehq--block">${
          node.expression ? "<observablehq-loading></observablehq-loading>" : ""
        }<!--:${id}:--></div>\n`;
      }
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      // 语法错误时显示错误信息
      html += `<div class="observablehq observablehq--block">
  <div class="observablehq--inspect observablehq--error">SyntaxError: ${he.escape(error.message)}</div>
</div>\n`;
    }
    
    // 根据echo属性决定是否显示源码
    if (attributes.echo == null ? source == null : !isFalse(attributes.echo)) {
      html += baseRenderer(tokens, idx, options, context, self);
    }
    return html;
  };
}

const CODE_DOLLAR = 36;
const CODE_BRACEL = 123;

/**
 * 内联占位符转换规则
 * 处理Markdown文本中的内联表达式，如：${expression}
 * 这些表达式会在客户端动态计算并显示结果
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
 * 处理HTML块中的占位符表达式
 * 如果HTML块包含占位符，将其转换为内联token以便后续处理
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
 * 生成用于渲染占位符的HTML，包含加载指示器和唯一标识
 * @returns 占位符渲染函数
 */
function makePlaceholderRenderer(): RenderRule {
  return (tokens, idx, options, context: ParseContext) => {
    const {path, params} = context;
    const token = tokens[idx];
    const id = uniqueCodeId(context, token.content);
    
    try {
      // TODO sourceLine: context.startLine + context.currentLine
      // TODO allow TypeScript?
      
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
 */
function makeSoftbreakRenderer(baseRenderer: RenderRule): RenderRule {
  return (tokens, idx, options, context: ParseContext, self) => {
    context.currentLine++;  // 更新行号计数
    return baseRenderer(tokens, idx, options, context, self);
  };
}

export interface ParseOptions {
  md: MarkdownIt;
  path: string;
  style?: Config["style"];
  scripts?: Config["scripts"];
  head?: Config["head"];
  header?: Config["header"];
  footer?: Config["footer"];
  source?: string;
  params?: Params;
}

/**
 * 创建配置好的MarkdownIt实例
 * 设置各种渲染规则和插件，支持Observable特有的功能
 * 
 * @param options 配置选项
 * @param options.markdownIt 自定义MarkdownIt配置函数
 * @param options.linkify 是否启用链接自动识别
 * @param options.quotes 引号样式
 * @param options.typographer 是否启用排版优化
 * @returns 配置好的MarkdownIt实例
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
  
  // 配置链接识别规则
  if (linkify) md.linkify.set({fuzzyLink: false, fuzzyEmail: false});
  
  // 添加锚点插件，用于标题的自动锚点生成
  md.use(MarkdownItAnchor, {slugify: (s) => slugify(s)});
  
  // 注册Observable特有的解析规则
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
 * 解析Markdown文档为MarkdownPage对象
 * 这是Markdown转换的主要入口点，完成从原始Markdown到结构化页面对象的转换
 * 
 * @param input 原始Markdown文本
 * @param options 解析选项，包含MarkdownIt实例、路径信息等
 * @returns 包含HTML内容、元数据和代码的MarkdownPage对象
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
 * 解析Markdown元数据的优化版本
 * 只提取标题和Front Matter数据，不进行完整的HTML渲染
 * 用于快速获取页面元信息
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

function getHead(title: string | null, data: FrontMatter, options: ParseOptions): string | null {
  const {scripts, path} = options;
  let head = getHtml("head", title, data, options);
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

function getHeader(title: string | null, data: FrontMatter, options: ParseOptions): string | null {
  return getHtml("header", title, data, options);
}

function getFooter(title: string | null, data: FrontMatter, options: ParseOptions): string | null {
  return getHtml("footer", title, data, options);
}

function getHtml(
  key: "head" | "header" | "footer",
  title: string | null,
  data: FrontMatter,
  {path, [key]: defaultValue}: ParseOptions
): string | null {
  if (data[key] !== undefined) return data[key] != null ? String(data[key]) : null;
  const value = typeof defaultValue === "function" ? defaultValue({title, data, path}) : defaultValue;
  return value != null ? rewriteHtmlPaths(value, path) : null;
}

function getStyle(data: FrontMatter, {path, style = null}: ParseOptions): string | null {
  try {
    style = mergeStyle(path, data.style, data.theme, style);
  } catch (error) {
    if (!(error instanceof InvalidThemeError)) throw error;
    console.error(red(String(error))); // TODO error during build
    style = {theme: []};
  }
  return !style
    ? null
    : "path" in style
    ? relativePath(path, style.path)
    : `observablehq:theme-${style.theme.join(",")}.css`;
}

// TODO Make this smarter.
function findTitle(tokens: ReturnType<MarkdownIt["parse"]>): string | null {
  for (const [i, token] of tokens.entries()) {
    if (token.type === "heading_open" && token.tag === "h1") {
      const next = tokens[i + 1];
      if (next?.type === "inline") {
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

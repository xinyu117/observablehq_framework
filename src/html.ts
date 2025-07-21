/**
 * HTML 解析和处理模块
 * 
 * 本模块提供 HTML 内容的解析、资源发现、路径重写和语法高亮等功能。
 * 主要用于 Observable Framework 构建过程中处理 HTML 内容，包括：
 * 1. 发现并收集 HTML 中引用的资源文件（图片、音频、视频等）
 * 2. 重写资源路径以适应构建输出结构
 * 3. 处理 JavaScript 模块导入和链接
 * 4. 为代码块提供语法高亮
 * 5. 提供安全的 HTML 模板字符串功能
 */

/* eslint-disable import/no-named-as-default-member */
import he from "he";
import hljs from "highlight.js";
import type {DOMWindow} from "jsdom";
import {JSDOM, VirtualConsole} from "jsdom";
import {isAssetPath, parseRelativeUrl, relativePath, resolveLocalPath, resolvePath} from "./path.js";

/**
 * 需要处理资源路径的 HTML 属性配置
 * 用于识别和提取 HTML 中的资源文件引用
 * 
 * 格式：[CSS选择器, 属性名]
 * - 仅包含具有 download 属性的链接，表示这些是下载资源
 * - 包含各种媒体元素的源属性
 */
const ASSET_ATTRIBUTES: readonly [selector: string, src: string][] = [
  ["a[href][download]", "href"],        // 带下载属性的链接
  ["audio source[src]", "src"],         // 音频源元素
  ["audio[src]", "src"],                // 音频元素
  ["img[src]", "src"],                  // 图片元素
  ["img[srcset]", "srcset"],            // 图片响应式源集
  ["link[href]", "href"],               // 链接元素（CSS、图标等）
  ["picture source[srcset]", "srcset"], // 图片源元素的响应式源集
  ["video source[src]", "src"],         // 视频源元素
  ["video[src]", "src"]                 // 视频元素
];

/**
 * 需要重写路径的所有 HTML 属性配置
 * 包含更广泛的路径属性，用于路径重写操作
 * 
 * 与 ASSET_ATTRIBUTES 的区别：
 * - 包含所有链接，不仅仅是下载链接
 * - 用于全面的路径重写，而不仅仅是资源收集
 */
const PATH_ATTRIBUTES: readonly [selector: string, src: string][] = [
  ["a[href]", "href"],                  // 所有链接
  ["audio source[src]", "src"],         // 音频源
  ["audio[src]", "src"],                // 音频元素
  ["img[src]", "src"],                  // 图片元素
  ["img[srcset]", "srcset"],            // 图片响应式源集
  ["link[href]", "href"],               // 链接元素
  ["picture source[srcset]", "srcset"], // 图片源响应式源集
  ["video source[src]", "src"],         // 视频源
  ["video[src]", "src"]                 // 视频元素
];

/**
 * 判断 script 元素是否为 JavaScript 类型
 * 
 * @param type - script 元素的 type 属性
 * @returns 是否为 JavaScript 脚本
 * 
 * 规则：
 * - 没有 type 属性时默认为 JavaScript
 * - 支持的 JavaScript MIME 类型：text/javascript, application/javascript, module
 */
export function isJavaScript({type}: HTMLScriptElement): boolean {
  if (!type) return true; // 没有 type 属性时默认为 JavaScript
  type = type.toLowerCase();
  return type === "text/javascript" || type === "application/javascript" || type === "module";
}

/**
 * 使用 JSDOM 解析 HTML 字符串
 * 
 * @param html - 要解析的 HTML 字符串
 * @returns JSDOM 窗口对象，提供 DOM API 访问
 * 
 * 特点：
 * - 使用虚拟控制台避免不必要的日志输出
 * - 自动添加 DOCTYPE 和 body 包装器
 * - 返回的 window 对象包含完整的 DOM API
 */
export function parseHtml(html: string): DOMWindow {
  return new JSDOM(`<!DOCTYPE html><body>${html}`, {virtualConsole: new VirtualConsole()}).window;
}

/**
 * HTML 资源分析结果接口
 * 
 * 用于分类和管理从 HTML 中发现的各种资源和引用：
 * - files: 本地资源文件（图片、音频、视频等）
 * - anchors: 页面内锚点（id 和 name 属性）
 * - localLinks: 本地页面链接
 * - localImports: 本地 JavaScript 模块导入
 * - globalImports: 全局/外部模块导入（npm 包等）
 * - staticImports: 静态导入（需要 modulepreload 的模块）
 */
interface Assets {
  files: Set<string>;           // 本地资源文件路径
  anchors: Set<string>;         // 页面锚点 ID
  localLinks: Set<string>;      // 本地页面链接
  localImports: Set<string>;    // 本地 JS 模块导入
  globalImports: Set<string>;   // 全局模块导入
  staticImports: Set<string>;   // 静态模块导入
}

/**
 * 从 HTML 内容中发现和分类所有资源引用
 * 
 * @param html - HTML 内容字符串
 * @param path - 当前 HTML 文件的路径（用于解析相对路径）
 * @returns Assets 对象，包含分类后的所有资源引用
 * 
 * 功能：
 * 1. 扫描所有资源属性，识别本地文件和外部资源
 * 2. 处理 JavaScript 脚本，区分本地模块和全局导入
 * 3. 识别静态导入（用于 modulepreload 优化）
 * 4. 收集页面锚点用于导航
 * 5. 处理本地页面链接，标准化路径格式
 */
export function findAssets(html: string, path: string): Assets {
  const {document} = parseHtml(html);
  const files = new Set<string>();
  const anchors = new Set<string>();
  const localLinks = new Set<string>();
  const localImports = new Set<string>();
  const globalImports = new Set<string>();
  const staticImports = new Set<string>();

  /**
   * 处理可能的文件路径，区分本地资源和全局导入
   * 
   * @param specifier - 文件路径或模块标识符
   */
  const maybeFile = (specifier: string): void => {
    if (isAssetPath(specifier)) {
      // 本地资源路径
      const localPath = resolveLocalPath(path, specifier);
      if (!localPath) return console.warn(`non-local asset path: ${specifier}`);
      files.add(relativePath(path, localPath));
    } else {
      // 全局导入（npm 包等）
      globalImports.add(specifier);
    }
  };

  // 处理资源属性（图片、音频、视频等）
  for (const [selector, src] of ASSET_ATTRIBUTES) {
    for (const element of document.querySelectorAll(selector)) {
      if (isExternal(element)) continue; // 跳过标记为外部的元素
      const source = decodeURI(element.getAttribute(src)!);
      if (src === "srcset") {
        // 处理响应式图片源集，可能包含多个 URL
        for (const s of parseSrcset(source)) {
          maybeFile(s);
        }
      } else {
        maybeFile(source);
      }
    }
  }

  // 处理 script 标签，特别关注 JavaScript 模块
  for (const script of document.querySelectorAll<HTMLScriptElement>("script[src]")) {
    if (isExternal(script)) continue;
    let src = script.getAttribute("src")!;
    if (isJavaScript(script)) {
      // JavaScript 脚本处理
      if (isAssetPath(src)) {
        // 本地 JavaScript 模块
        const localPath = resolveLocalPath(path, src);
        if (!localPath) {
          console.warn(`non-local asset path: ${src}`);
          continue;
        }
        localImports.add((src = relativePath(path, localPath)));
      } else {
        // 全局 JavaScript 模块
        globalImports.add(src);
      }
      // 检查是否为静态导入（ES 模块且非异步）
      if (script.getAttribute("type")?.toLowerCase() === "module" && !script.hasAttribute("async")) {
        staticImports.add(src); // 需要 modulepreload 优化
      }
    } else {
      // 非 JavaScript 脚本作为普通文件处理
      maybeFile(src);
    }
  }

  // 收集页面锚点（用于页面内导航）
  for (const element of document.querySelectorAll<HTMLElement>("[id],[name]")) {
    if (isExternal(element)) continue;
    anchors.add(element.getAttribute("id") ?? element.getAttribute("name")!);
  }

  // 处理本地页面链接
  for (const a of document.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    if (isExternal(a) || a.hasAttribute("download")) continue; // 跳过外部链接和下载链接
    const href = a.getAttribute("href")!;
    if (/^\w+:/.test(href)) continue; // 跳过绝对 URL（如 http:, mailto: 等）
    
    // 解析相对 URL 的各个部分
    const {pathname, search, hash} = parseRelativeUrl(href);
    // 标准化链接路径：移除 .html 后缀，将目录链接转换为 index
    localLinks.add(resolvePath(path, pathname).replace(/\.html$/i, "").replace(/\/$/, "/index") + search + hash); // prettier-ignore
  }

  return {files, localImports, globalImports, staticImports, localLinks, anchors};
}

/**
 * 重写 HTML 中的路径引用（简化版本）
 * 
 * @param html - HTML 内容
 * @param path - 当前文件路径
 * @returns 重写路径后的 HTML 内容
 * 
 * 功能：
 * - 将绝对路径转换为相对路径
 * - 处理 srcset 中的多个 URL
 * - 保持外部链接不变
 */
export function rewriteHtmlPaths(html: string, path: string): string {
  const {document} = parseHtml(html);

  /**
   * 路径解析函数
   * 区分资源路径和普通路径，应用不同的解析逻辑
   */
  const resolvePath = (specifier: string): string => {
    return isAssetPath(specifier) ? relativePath(path, specifier) : specifier;
  };

  // 遍历所有需要重写路径的属性
  for (const [selector, src] of PATH_ATTRIBUTES) {
    for (const element of document.querySelectorAll(selector)) {
      if (isExternal(element)) continue; // 跳过外部元素
      const source = decodeURI(element.getAttribute(src)!);
      // 根据属性类型选择不同的处理方式
      element.setAttribute(src, src === "srcset" ? resolveSrcset(source, resolvePath) : encodeURI(resolvePath(source)));
    }
  }

  return document.body.innerHTML;
}

/**
 * HTML 重写器配置接口
 * 
 * 定义了各种路径解析函数，用于自定义不同类型资源的路径重写逻辑：
 * - resolveFile: 普通文件路径解析
 * - resolveImport: 模块导入路径解析
 * - resolveScript: 脚本文件路径解析
 * - resolveLink: 链接路径解析
 */
export interface HtmlResolvers {
  resolveFile: (specifier: string) => string;    // 文件路径解析器
  resolveImport: (specifier: string) => string;  // 导入路径解析器
  resolveScript: (specifier: string) => string;  // 脚本路径解析器
  resolveLink: (href: string) => string;         // 链接路径解析器
}

/**
 * 全功能 HTML 重写函数
 * 
 * @param html - 原始 HTML 内容
 * @param resolvers - 路径解析器配置，支持部分配置
 * @returns 重写后的 HTML 内容
 * 
 * 功能：
 * 1. 使用自定义解析器重写各种路径
 * 2. 为代码块添加语法高亮
 * 3. 为标题添加锚点链接
 * 4. 处理 Observable 特定的元素（loading、root）
 * 5. 为外部链接添加安全属性
 */
export function rewriteHtml(
  html: string,
  {resolveFile = String, resolveImport = String, resolveScript = String, resolveLink = String}: Partial<HtmlResolvers>
): string {
  const {document} = parseHtml(html);

  /**
   * 通用路径解析函数
   * 根据路径类型选择合适的解析器
   */
  const resolvePath = (specifier: string): string => {
    return isAssetPath(specifier) ? resolveFile(specifier) : resolveImport(specifier);
  };

  // 重写资源属性路径
  for (const [selector, src] of ASSET_ATTRIBUTES) {
    for (const element of document.querySelectorAll(selector)) {
      if (isExternal(element)) continue;
      const source = decodeURI(element.getAttribute(src)!);
      element.setAttribute(src, src === "srcset" ? resolveSrcset(source, resolvePath) : encodeURI(resolvePath(source)));
    }
  }

  // 重写脚本路径，区分 JavaScript 和其他脚本
  for (const script of document.querySelectorAll<HTMLScriptElement>("script[src]")) {
    if (isExternal(script)) continue;
    const src = decodeURI(script.getAttribute("src")!);
    // JavaScript 脚本使用专用解析器，其他脚本使用文件解析器
    script.setAttribute("src", encodeURI((isJavaScript(script) ? resolveScript : resolveFile)(src)));
  }

  // 重写链接并为外部链接添加安全属性
  for (const a of document.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    if (isExternal(a)) continue;
    const href = decodeURI(a.getAttribute("href")!);
    a.setAttribute("href", encodeURI(resolveLink(href)));
    // 为外部链接（协议链接）添加安全属性
    if (!/^(\w+:)/.test(href)) continue;
    if (!a.hasAttribute("target")) a.setAttribute("target", "_blank");        // 新窗口打开
    if (!a.hasAttribute("rel")) a.setAttribute("rel", "noopener noreferrer"); // 安全属性
  }

  // 为代码块添加语法高亮
  // 只处理包含语言类名的 code 元素，且只高亮直接文本子节点
  for (const code of document.querySelectorAll("code[class*='language-']")) {
    // 提取语言标识符
    const language = [...code.classList].find((c) => c.startsWith("language-"))?.slice("language-".length);
    if (!language) continue;
    
    // 为父级 pre 元素添加语言属性（用于样式）
    if (code.parentElement?.tagName === "PRE") code.parentElement.setAttribute("data-language", language);
    
    // 检查 highlight.js 是否支持该语言
    if (!hljs.getLanguage(language)) continue;
    
    let html = "";
    code.normalize(); // 合并相邻的文本节点
    
    // 遍历所有子节点，只对文本节点进行语法高亮
    for (const child of code.childNodes) {
      html += isText(child)
        ? hljs.highlight(child.textContent!, {language}).value  // 高亮文本节点
        : isElement(child)
        ? child.outerHTML                                       // 保持元素节点不变
        : isComment(child)
        ? `<!--${he.escape(child.data)}-->`                     // 转义注释节点
        : "";
    }
    code.innerHTML = html;
  }

  // 为标题元素添加锚点链接（用于页面内导航）
  for (const h of document.querySelectorAll<HTMLHeadingElement>("h1[id], h2[id], h3[id], h4[id]")) {
    const a = document.createElement("a");
    a.className = "observablehq-header-anchor";
    a.href = `#${h.id}`;
    a.append(...h.childNodes); // 将标题内容移到链接中
    h.append(a);
  }

  // 处理 Observable 特定的根元素包装
  // 为了支持预览时的增量更新，需要将顶级单元格包装在 span 中
  // 避免动态内容污染 body 的直接子元素
  for (let child = document.body.firstChild; child; child = child.nextSibling) {
    if (isRoot(child)) {
      const parent = document.createElement("span");
      const loading = findLoading(child); // 查找关联的加载元素
      child.replaceWith(parent);
      if (loading) parent.appendChild(loading); // 保持加载元素的关联
      parent.appendChild(child);
      child = parent;
    }
  }

  // 清理无效的 observablehq-loading 元素
  // 这些元素必须紧邻其根元素，且只能在 HTML 上下文中工作
  for (const l of document.querySelectorAll("observablehq-loading")) {
    if (!l.nextSibling || !isRoot(l.nextSibling) || l.namespaceURI !== "http://www.w3.org/1999/xhtml") {
      l.remove();
    }
  }

  return document.body.innerHTML;
}

/**
 * 解析 srcset 属性值，提取其中的 URL 列表
 * 
 * @param srcset - srcset 属性值（格式：URL描述符, URL描述符, ...）
 * @returns URL 数组
 * 
 * srcset 格式示例：
 * "image1.jpg 1x, image2.jpg 2x"
 * "small.jpg 480w, medium.jpg 800w, large.jpg 1200w"
 */
function parseSrcset(srcset: string): string[] {
  return srcset
    .trim()
    .split(/\s*,\s*/)           // 按逗号分割不同的源
    .filter((src) => src)       // 过滤空值
    .map((src) => src.split(/\s+/)[0]); // 提取 URL 部分（忽略描述符）
}

/**
 * 重写 srcset 属性中的 URL 路径
 * 
 * @param srcset - 原始 srcset 值
 * @param resolve - URL 解析函数
 * @returns 重写后的 srcset 值
 * 
 * 保持 srcset 的格式，只替换其中的 URL 部分
 */
function resolveSrcset(srcset: string, resolve: (specifier: string) => string): string {
  return srcset
    .trim()
    .split(/\s*,\s*/)
    .filter((src) => src)
    .map((src) => {
      const parts = src.split(/\s+/);
      const path = resolve(parts[0]); // 解析 URL 部分
      if (path) parts[0] = encodeURI(path); // 更新 URL 并编码
      return parts.join(" "); // 重新组合 URL 和描述符
    })
    .join(", ");
}

// DOM 节点类型检查工具函数

/**
 * 检查节点是否为文本节点
 */
export function isText(node: Node): node is Text {
  return node.nodeType === 3;
}

/**
 * 检查节点是否为注释节点
 */
export function isComment(node: Node): node is Comment {
  return node.nodeType === 8;
}

/**
 * 检查节点是否为元素节点
 */
export function isElement(node: Node): node is Element {
  return node.nodeType === 1;
}

/**
 * 检查注释节点是否为 Observable 根元素标记
 * 
 * Observable 使用特殊格式的注释来标记可执行代码块：
 * `:12345678:` 或 `:12345678-1:`（带序号）
 */
function isRoot(node: Node): node is Comment {
  return isComment(node) && /^:[0-9a-f]{8}(?:-\d+)?:$/.test(node.data);
}

/**
 * 检查元素是否为 Observable 加载指示器
 */
function isLoading(node: Node): node is Element {
  return isElement(node) && node.tagName === "OBSERVABLEHQ-LOADING";
}

/**
 * 检查元素是否标记为外部资源
 * 
 * 通过 rel="external" 属性标记的元素会被跳过处理
 */
function isExternal(a: Element): boolean {
  return /(?:^|\s)external(?:\s|$)/i.test(a.getAttribute("rel") ?? ""); // e.g., <a href rel="external">
}

/**
 * 查找与根元素关联的加载指示器
 * 
 * 加载指示器应该紧邻在根元素之前
 */
function findLoading(node: Node): Element | null {
  const sibling = node.previousSibling;
  return sibling && isLoading(sibling) ? sibling : null;
}

/**
 * HTML 安全字符串类
 * 
 * 用于标记已知安全的 HTML 字符串，在模板插值时不会被转义。
 * 这是一个安全机制，防止意外的 HTML 注入。
 */
export class Html {
  private constructor(readonly html: string) {}
  
  /**
   * 创建一个标记为安全的 HTML 字符串
   * 
   * @param html - HTML 内容字符串
   * @returns Html 实例
   * 
   * 注意：只有在确认内容安全时才使用此方法
   */
  static unsafe(html: string): Html {
    return new Html(html);
  }
  
  toString() {
    return this.html;
  }
}

/**
 * HTML 模板标签函数
 * 
 * @param strings - 模板字符串数组
 * @param values - 插值变量数组
 * @returns Html 实例，包含安全的 HTML 内容
 * 
 * 功能：
 * 1. 自动转义普通字符串，防止 XSS 攻击
 * 2. 保持 Html 实例不被转义（已标记为安全）
 * 3. 支持数组和可迭代对象的展开
 * 4. 过滤 null 和 undefined 值
 * 
 * 使用示例：
 * ```javascript
 * const name = "<script>alert('xss')</script>";
 * const safeHtml = Html.unsafe("<em>safe content</em>");
 * const result = html`<div>Hello ${name}, ${safeHtml}</div>`;
 * // 结果：<div>Hello &lt;script&gt;alert('xss')&lt;/script&gt;, <em>safe content</em></div>
 * ```
 */
export function html(strings: TemplateStringsArray, ...values: unknown[]): Html {
  const parts: string[] = [];
  for (let i = 0; i < strings.length; ++i) {
    parts.push(strings[i]);
    if (i < values.length) {
      const value = values[i];
      if (value == null) continue; // 跳过 null 和 undefined
      
      // 处理可迭代对象（数组等）
      if (typeof value[Symbol.iterator] === "function") {
        for (const v of value as Iterable<unknown>) {
          if (v == null) continue;
          // Html 实例直接使用，其他值进行转义
          parts.push(v instanceof Html ? v.html : he.escape(String(v)));
        }
      } else {
        // 单个值处理：Html 实例直接使用，其他值进行转义
        parts.push(value instanceof Html ? value.html : he.escape(String(value)));
      }
    }
  }
  return Html.unsafe(parts.join(""));
}

// 为 html 函数添加 unsafe 方法，提供便捷访问
html.unsafe = Html.unsafe;

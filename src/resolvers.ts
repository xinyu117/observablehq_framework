/**
 * Observable Framework 依赖解析系统
 * 
 * 这个模块负责解析和管理页面及模块的所有依赖关系，包括：
 * 1. JavaScript 模块导入（本地、npm、jsr、node等）
 * 2. 静态资源文件（图片、数据文件等）
 * 3. CSS 样式表
 * 4. 内部链接和锚点
 * 5. 传递性依赖的解析
 * 
 * 依赖解析的核心作用：
 * - 确保所有必需的资源都被包含在构建输出中
 * - 为模块打包和缓存破坏提供正确的路径解析
 * - 支持多种包管理器和导入协议
 * - 处理静态导入和动态导入的区别
 */

import {createHash} from "node:crypto";
import {extname, join} from "node:path/posix";
import type {DuckDBConfig} from "./config.js";
import {cacheDuckDBExtension} from "./duckdb.js";
import {findAssets} from "./html.js";
import {defaultGlobals} from "./javascript/globals.js";
import {isJavaScript} from "./javascript/imports.js";
import {getFileHash, getModuleHash, getModuleInfo} from "./javascript/module.js";
import {extractJsrSpecifier, resolveJsrImport, resolveJsrImports} from "./jsr.js";
import {getImplicitDependencies, getImplicitDownloads} from "./libraries.js";
import {getImplicitFileImports, getImplicitInputImports} from "./libraries.js";
import {getImplicitStylesheets} from "./libraries.js";
import type {LoaderResolver} from "./loader.js";
import type {MarkdownPage} from "./markdown.js";
import {extractNodeSpecifier, resolveNodeImport, resolveNodeImports} from "./node.js";
import {extractNpmSpecifier, populateNpmCache, resolveNpmImport, resolveNpmImports} from "./npm.js";
import {isAssetPath, isPathImport, parseRelativeUrl} from "./path.js";
import {relativePath, resolveLocalPath, resolvePath, resolveRelativePath} from "./path.js";

/**
 * 解析器接口 - 包含页面或模块的所有依赖信息和解析函数
 */
export interface Resolvers {
  /** 当前页面或模块的路径 */
  path: string;
  /** 内容哈希，用于缓存破坏 */
  hash: string;
  /** 静态资源集合（如图片），不通过 FileAttachment 注册 */
  assets: Set<string>;
  /** 文件集合，通过 FileAttachment 或静态 HTML 引用 */
  files: Set<string>;
  /** 页面内锚点集合，用于内部链接验证 */
  anchors: Set<string>;
  /** 本地链接集合，指向其他页面的链接 */
  localLinks: Set<string>;
  /** 本地导入集合，指向源代码目录内的模块 */
  localImports: Set<string>;
  /** 全局导入集合，包括 npm、jsr、内置模块等 */
  globalImports: Set<string>;
  /** 静态导入集合，需要预加载的导入 */
  staticImports: Set<string>;
  /** 样式表集合，需要在渲染时添加 */
  stylesheets: Set<string>;
  
  /** 解析文件路径的函数 */
  resolveFile(specifier: string): string;
  /** 解析导入路径的函数 */
  resolveImport(specifier: string): string;
  /** 解析样式表路径的函数 */
  resolveStylesheet(specifier: string): string;
  /** 解析脚本路径的函数 */
  resolveScript(specifier: string): string;
  /** 解析链接路径的函数 */
  resolveLink(href: string): string;
}

/**
 * 解析器配置接口
 */
export interface ResolversConfig {
  /** 项目根目录 */
  root: string;
  /** 当前页面或模块的路径 */
  path: string;
  /** 路径标准化函数 */
  normalizePath: (path: string) => string;
  /** 全局样式表列表 */
  globalStylesheets?: string[];
  /** 加载器解析器 */
  loaders: LoaderResolver;
  /** DuckDB 配置 */
  duckdb: DuckDBConfig;
}

/**
 * 默认导入列表 - 每个页面都会自动包含的基础导入
 */
const defaultImports = [
  "observablehq:client",  // Framework 客户端
  "observablehq:runtime", // Observable 运行时
  "observablehq:stdlib"   // 标准库
];

/**
 * 内置模块映射表
 * 将包名或协议映射到实际的服务路径
 */
export const builtins = new Map<string, string>([
  ["@observablehq/runtime", "/_observablehq/runtime.js"],
  ["@observablehq/stdlib", "/_observablehq/stdlib.js"],
  ["npm:@observablehq/runtime", "/_observablehq/runtime.js"],
  ["npm:@observablehq/stdlib", "/_observablehq/stdlib.js"],
  ["npm:@observablehq/dot", "/_observablehq/stdlib/dot.js"],         // TODO: 发布到 npm
  ["npm:@observablehq/duckdb", "/_observablehq/stdlib/duckdb.js"],   // TODO: 发布到 npm
  ["npm:@observablehq/inputs", "/_observablehq/stdlib/inputs.js"],   // TODO: 发布到 npm
  ["npm:@observablehq/mermaid", "/_observablehq/stdlib/mermaid.js"], // TODO: 发布到 npm
  ["npm:@observablehq/tex", "/_observablehq/stdlib/tex.js"],         // TODO: 发布到 npm
  ["npm:@observablehq/sqlite", "/_observablehq/stdlib/sqlite.js"]    // TODO: 发布到 npm
]);

/**
 * 解析页面依赖关系的主函数
 * 
 * 这个函数负责分析一个 Markdown 页面的所有依赖关系，包括：
 * 
 * ## 依赖类型分类：
 * 
 * ### 导入（Imports）
 * - **本地导入（Local Imports）**: 指向源代码目录内的 JavaScript 模块
 * - **全局导入（Global Imports）**: npm、jsr、node 包或 Framework 提供的模块
 * - **静态导入 vs 动态导入**: 
 *   - 静态导入：在页面加载时预加载
 *   - 动态导入：按需加载，但仍需包含在构建输出中
 * 
 * ### 样式表（Stylesheets）
 * - 配置中指定的全局样式或页面级样式
 * - 通过 `_import` 服务的本地样式文件包
 * - 库推荐的隐式样式表（如 Leaflet）
 * 
 * ### 文件（Files）
 * - 通过 `FileAttachment` 调用的数据文件
 * - 静态 HTML 中引用的资源文件
 * 
 * ## 传递性依赖处理：
 * 动态导入模块的传递性静态导入被视为动态，因为它们不应该被预加载。
 * 例如：Mermaid 将十几种图表类型作为动态导入实现，我们只加载使用中的类型。
 * 
 * @param page 要分析的 Markdown 页面对象
 * @param config 解析器配置，包含路径、加载器等信息
 * @returns Promise<Resolvers> 包含所有依赖信息和解析函数的解析器对象
 */
export async function getResolvers(page: MarkdownPage, config: ResolversConfig): Promise<Resolvers> {
  const {path, globalStylesheets: defaultStylesheets, loaders} = config;
  // 创建内容哈希，基于页面主体和元数据
  const hash = createHash("sha256").update(page.body).update(JSON.stringify(page.data));
  
  // 初始化各种依赖集合
  const assets = new Set<string>();                    // 静态资源（不通过 FileAttachment）
  const files = new Set<string>();                     // 文件（通过 FileAttachment 或静态引用）
  const fileMethods = new Set<string>();               // 文件方法调用（如 .parquet(), .csv()）
  const anchors = new Set<string>();                   // 页面内锚点
  const localLinks = new Set<string>();               // 本地页面链接
  const localImports = new Set<string>();             // 本地模块导入
  const globalImports = new Set<string>(defaultImports); // 全局导入（包含默认导入）
  const staticImports = new Set<string>(defaultImports); // 静态导入（包含默认导入）
  const stylesheets = new Set<string>(defaultStylesheets); // 样式表

  // 第一步：从页面的各个 HTML 部分提取资源引用
  // 分析 head、header、body、footer 中的所有资源引用
  for (const html of [page.head, page.header, page.body, page.footer]) {
    if (!html) continue;
    const info = findAssets(html, path);
    for (const f of info.files) assets.add(f);
    for (const a of info.anchors) anchors.add(a);
    for (const l of info.localLinks) localLinks.add(l);
    for (const i of info.localImports) localImports.add(i);
    for (const i of info.globalImports) globalImports.add(i);
    for (const i of info.staticImports) staticImports.add(i);
  }

  // 第二步：添加页面级样式表
  if (page.style) stylesheets.add(page.style);

  // 第三步：收集代码块中直接附加的文件、本地导入和静态导入
  for (const {node} of page.code) {
    // 处理 FileAttachment 调用和文件方法
    for (const f of node.files) {
      files.add(f.name);
      if (f.method) fileMethods.add(f.method);
    }
    // 处理导入语句 suchao:在md文件中的JS代码块中的导入语句是在此被加入到localImports的
    for (const i of node.imports) {
      (i.type === "local" ? localImports : globalImports).add(i.name);
      if (i.method === "static") staticImports.add(i.name);
      // 特殊处理：本地 resolve 导入的非 JS 文件视为文件依赖
      if (i.type === "local" && i.method === "resolve" && !isJavaScript(i.name)) files.add(i.name);
    }
  }

  // 第四步：添加 SQL 数据源
  if (page.data.sql) {
    for (const value of Object.values(page.data.sql)) {
      const source = String(value);
      if (isAssetPath(source)) {
        files.add(resolveRelativePath(path, source));
      }
    }
  }

  // 第五步：计算内容哈希，包含所有依赖文件的哈希
  for (const f of assets) hash.update(loaders.getSourceFileHash(resolvePath(path, f)));
  for (const f of files) hash.update(loaders.getSourceFileHash(resolvePath(path, f)));
  for (const i of localImports) hash.update(loaders.getModuleHash(resolvePath(path, i)));
  if (page.style && isPathImport(page.style)) hash.update(loaders.getSourceFileHash(resolvePath(path, page.style)));

  // 第六步：添加标准库内置模块的隐式导入（如 d3 和 Plot）
  for (const i of getImplicitInputImports(findFreeInputs(page))) {
    staticImports.add(i);
    globalImports.add(i);
  }

  // 第七步：为 JSX 代码块添加 React
  if (page.code.some((c) => c.mode === "jsx")) {
    staticImports.add("npm:react-dom");
    globalImports.add("npm:react-dom");
  }

  return {
    path,
    hash: hash.digest("hex"),
    assets,
    anchors,
    localLinks,
    ...(await resolveResolvers(
      {
        files,
        fileMethods,
        localImports,
        globalImports,
        staticImports,
        stylesheets
      },
      config
    ))
  };
}

/**
 * 为 JavaScript 模块获取解析器（简化版本）
 * 
 * 与 getResolvers 类似，但专门用于 JavaScript 模块而非 Markdown 页面。
 * 这是一个简化版本，因为模块不包含 HTML 内容、样式表或复杂的页面结构。
 * 
 * @param path 模块路径
 * @param config 解析器配置（不包含路径，因为已作为参数传入）
 * @returns Promise<Resolvers> 模块的解析器对象
 */
export async function getModuleResolvers(path: string, config: Omit<ResolversConfig, "path">): Promise<Resolvers> {
  const {root} = config;
  return {
    path,
    hash: getModuleHash(root, path),
    assets: new Set(),      // 模块通常不包含静态资源
    anchors: new Set(),     // 模块不包含锚点
    localLinks: new Set(),  // 模块不包含页面链接
    ...(await resolveResolvers({localImports: [path], staticImports: [path]}, {path, ...config}))
  };
}

/**
 * 核心依赖解析函数
 * 
 * 这是依赖解析的核心逻辑，负责：
 * 1. 递归解析本地模块的传递性依赖
 * 2. 解析和缓存外部包（npm、jsr、node）
 * 3. 处理隐式依赖和样式表
 * 4. 创建各种路径解析函数
 * 
 * ## 处理流程：
 * 1. **传递性本地导入**: 递归分析本地模块的所有导入
 * 2. **静态导入收集**: 确定哪些导入需要预加载
 * 3. **外部包解析**: 解析 npm、jsr、node 包并处理其传递依赖
 * 4. **隐式依赖**: 添加基于使用情况的隐式导入（如文件方法对应的库）
 * 5. **路径解析器**: 创建用于运行时路径解析的函数
 * 
 * @param initialDeps 初始依赖集合（文件、导入、样式表等）
 * @param config 解析器配置
 * @returns 完整的解析器对象（不包含路径、哈希等基础信息）
 */
async function resolveResolvers(
  {
    files: initialFiles,
    fileMethods: initialFileMethods,
    localImports: initialLocalImports,
    globalImports: initialGlobalImports,
    staticImports: intialStaticImports,
    stylesheets: initialStylesheets
  }: {
    files?: Iterable<string> | null;
    fileMethods?: Iterable<string> | null;
    localImports?: Iterable<string> | null;
    globalImports?: Iterable<string> | null;
    staticImports?: Iterable<string> | null;
    stylesheets?: Iterable<string> | null;
  },
  {root, path, normalizePath, loaders, duckdb}: ResolversConfig
): Promise<Omit<Resolvers, "path" | "hash" | "assets" | "anchors" | "localLinks">> {
  // 将初始依赖复制到可变集合中进行进一步处理
  const files = new Set<string>(initialFiles);
  const fileMethods = new Set<string>(initialFileMethods);
  const localImports = new Set<string>(initialLocalImports);
  const globalImports = new Set<string>(initialGlobalImports);
  const staticImports = new Set<string>(intialStaticImports);
  const stylesheets = new Set<string>(initialStylesheets);
  const resolutions = new Map<string, string>(); // 外部包的路径解析缓存

  // 第一阶段：收集传递性附加文件和本地导入
  // 递归分析每个本地导入模块的依赖
  for (const i of localImports) {
    const p = resolvePath(path, i);
    const info = getModuleInfo(root, p);
    if (!info) continue;
    // 将模块的所有依赖添加到当前页面的依赖中
    for (const f of info.files) files.add(relativePath(path, resolvePath(p, f)));
    for (const m of info.fileMethods) fileMethods.add(m);
    for (const o of info.localStaticImports) localImports.add(relativePath(path, resolvePath(p, o)));
    for (const o of info.localDynamicImports) localImports.add(relativePath(path, resolvePath(p, o)));
    for (const o of info.globalStaticImports) globalImports.add(o);
    for (const o of info.globalDynamicImports) globalImports.add(o);
  }

  // 第二阶段：从传递性本地导入中收集静态导入
  // 确定哪些导入需要在页面加载时预加载
  for (const i of staticImports) {
    if (!localImports.has(i)) continue;
    const p = resolvePath(path, i);
    const info = getModuleInfo(root, p);
    if (!info) continue;
    for (const o of info.localStaticImports) staticImports.add(relativePath(path, resolvePath(p, o)));
    for (const o of info.globalStaticImports) staticImports.add(o);
  }

  // 第三阶段：添加文件方法的隐式导入
  // 这些技术上是动态导入，但我们假设引用的文件会立即加载，因此将其视为静态导入用于预加载
  for (const i of getImplicitFileImports(fileMethods)) {
    staticImports.add(i);
    globalImports.add(i);
  }

  // 第四阶段：添加内置库的传递性导入
  for (const i of getImplicitDependencies(staticImports)) {
    staticImports.add(i);
  }
  for (const i of getImplicitDependencies(globalImports)) {
    globalImports.add(i);
  }

  // 第五阶段：解析外部包导入（npm、jsr、bare imports）
  // 这会产生填充 npm 导入缓存直接依赖，以及 node 和 jsr 导入缓存所有传递依赖的副作用
  for (const i of globalImports) {
    if (builtins.has(i)) continue; // 跳过内置模块
    if (i.startsWith("npm:")) {
      resolutions.set(i, await resolveNpmImport(root, i.slice("npm:".length)));
    } else if (i.startsWith("jsr:")) {
      resolutions.set(i, await resolveJsrImport(root, i.slice("jsr:".length)));
    } else if (!/^\w+:/.test(i)) {
      // 处理 bare imports（无协议的导入，如 "lodash"）
      try {
        resolutions.set(i, await resolveNodeImport(root, i));
      } catch {
        // 忽略错误；允许导入在运行时解析
      }
    }
  }

  // 第六阶段：跟踪外部包的传递性导入
  // 这会填充导入缓存的其余部分
  for (const [key, value] of resolutions) {
    if (key.startsWith("npm:")) {
      // 处理 npm 包的传递依赖
      for (const i of await resolveNpmImports(root, value)) {
        if (i.type === "local") {
          const path = resolvePath(value, i.name);
          const specifier = `npm:${extractNpmSpecifier(path)}`;
          globalImports.add(specifier);
          resolutions.set(specifier, path);
        }
      }
    } else if (key.startsWith("jsr:")) {
      // 处理 jsr 包的传递依赖
      for (const i of await resolveJsrImports(root, value)) {
        if (i.type === "local") {
          const path = resolvePath(value, i.name);
          let specifier: string;
          if (path.startsWith("/_npm/")) specifier = `npm:${extractNpmSpecifier(path)}`;
          else if (path.startsWith("/_jsr/")) specifier = `jsr:${extractJsrSpecifier(path)}`;
          else continue;
          globalImports.add(specifier);
          resolutions.set(specifier, path);
        }
      }
    } else if (!/^\w+:/.test(key)) {
      // 处理 bare imports 的传递依赖
      for (const i of await resolveNodeImports(root, value)) {
        if (i.type === "local") {
          const path = resolvePath(value, i.name);
          const specifier = extractNodeSpecifier(path);
          globalImports.add(specifier);
          resolutions.set(specifier, path);
        }
      }
    }
  }

  // 第七阶段：解析传递性静态外部导入
  // 专门处理静态导入的传递依赖，因为它们需要预加载
  const staticResolutions = new Map<string, string>();
  for (const i of staticImports) {
    if (i.startsWith("npm:") || i.startsWith("jsr:") || !/^\w+:/.test(i)) {
      const r = resolutions.get(i);
      if (r) staticResolutions.set(i, r);
    }
  }
  for (const [key, value] of staticResolutions) {
    if (key.startsWith("npm:")) {
      for (const i of await resolveNpmImports(root, value)) {
        if (i.type === "local" && i.method === "static") {
          const path = resolvePath(value, i.name);
          const specifier = `npm:${extractNpmSpecifier(path)}`;
          staticImports.add(specifier);
          staticResolutions.set(specifier, path);
        }
      }
    } else if (key.startsWith("jsr:")) {
      for (const i of await resolveJsrImports(root, value)) {
        if (i.type === "local" && i.method === "static") {
          const path = resolvePath(value, i.name);
          let specifier: string;
          if (path.startsWith("/_npm/")) specifier = `npm:${extractNpmSpecifier(path)}`;
          else if (path.startsWith("/_jsr/")) specifier = `jsr:${extractJsrSpecifier(path)}`;
          else continue;
          staticImports.add(specifier);
          staticResolutions.set(specifier, path);
        }
      }
    } else if (!/^\w+:/.test(key)) {
      for (const i of await resolveNodeImports(root, value)) {
        if (i.type === "local" && i.method === "static") {
          const path = resolvePath(value, i.name);
          const specifier = extractNodeSpecifier(path);
          staticImports.add(specifier);
          staticResolutions.set(specifier, path);
        }
      }
    }
  }

  // 第八阶段：添加隐式样式表
  for (const specifier of getImplicitStylesheets(staticImports)) {
    stylesheets.add(specifier);
    if (specifier.startsWith("npm:")) {
      const path = await resolveNpmImport(root, specifier.slice("npm:".length));
      resolutions.set(specifier, path);
      await populateNpmCache(root, path);
    } else if (!specifier.startsWith("observablehq:")) {
      throw new Error(`unhandled implicit stylesheet: ${specifier}`);
    }
  }

  // 第九阶段：添加隐式下载
  // （这也许应该单独存储而不是添加到全局导入中，但目前这样做是有效的）
  for (const specifier of getImplicitDownloads(globalImports, duckdb)) {
    globalImports.add(specifier);
    if (specifier.startsWith("npm:")) {
      const path = await resolveNpmImport(root, specifier.slice("npm:".length));
      resolutions.set(specifier, path);
      await populateNpmCache(root, path);
    } else if (specifier.startsWith("duckdb:")) {
      const path = await cacheDuckDBExtension(root, specifier.slice("duckdb:".length));
      resolutions.set(specifier, path);
    } else if (!specifier.startsWith("observablehq:")) {
      throw new Error(`unhandled implicit download: ${specifier}`);
    }
  }

  /**
   * 导入路径解析函数
   * 
   * 将导入说明符解析为实际的服务路径。处理：
   * - 本地路径导入（相对路径）
   * - 内置模块（builtins 映射）
   * - observablehq: 协议导入
   * - 已解析的外部包导入
   * - 未解析的导入（原样返回）
   * 
   * @param specifier 导入说明符
   * @returns 解析后的相对路径
   */
  function resolveImport(specifier: string): string {
    return isPathImport(specifier)
      ? relativePath(path, loaders.resolveImportPath(resolvePath(path, specifier)))
      : builtins.has(specifier)
      ? relativePath(path, builtins.get(specifier)!)
      : specifier.startsWith("observablehq:")
      ? relativePath(path, `/_observablehq/${specifier.slice("observablehq:".length)}${extname(specifier) ? "" : ".js"}`)
      : resolutions.has(specifier)
      ? relativePath(path, resolutions.get(specifier)!)
      : specifier;
  }

  /**
   * 文件路径解析函数
   * 
   * 将文件说明符解析为实际的文件路径，通过加载器处理文件路径解析。
   * 
   * @param specifier 文件说明符
   * @returns 解析后的相对文件路径
   */
  function resolveFile(specifier: string): string {
    return relativePath(path, loaders.resolveFilePath(resolvePath(path, specifier)));
  }

  /**
   * 样式表路径解析函数
   * 
   * 解析样式表说明符，处理：
   * - 本地样式文件（通过 _import 服务）
   * - observablehq: 协议样式表
   * - 已解析的外部样式表
   * 
   * @param specifier 样式表说明符
   * @returns 解析后的相对样式表路径
   */
  function resolveStylesheet(specifier: string): string {
    return isPathImport(specifier)
      ? relativePath(path, resolveStylesheetPath(root, resolvePath(path, specifier)))
      : specifier.startsWith("observablehq:")
      ? relativePath(path, `/_observablehq/${specifier.slice("observablehq:".length)}`)
      : resolutions.has(specifier)
      ? relativePath(path, resolutions.get(specifier)!)
      : specifier;
  }

  /**
   * 脚本路径解析函数
   * 
   * 解析 script 标签的 src 属性，支持资源路径和导入说明符。
   * 
   * @param src 脚本源路径
   * @returns 解析后的脚本路径
   */
  function resolveScript(src: string): string {
    if (isAssetPath(src)) {
      const localPath = resolveLocalPath(path, src);
      return localPath ? resolveImport(relativePath(path, localPath)) : src;
    } else {
      return resolveImport(src);
    }
  }

  /**
   * 链接路径解析函数
   * 
   * 解析 a 标签的 href 属性，处理本地页面链接并保留查询参数和锚点。
   * 
   * @param href 链接地址
   * @returns 解析后的链接路径
   */
  function resolveLink(href: string): string {
    if (isAssetPath(href)) {
      const u = parseRelativeUrl(href);
      const localPath = resolveLocalPath(path, u.pathname);
      if (localPath) return relativePath(path, normalizePath(localPath)) + u.search + u.hash;
    }
    return href;
  }

  return {
    files,
    localImports,
    globalImports,
    staticImports,
    stylesheets,
    resolveFile,
    resolveImport,
    resolveScript,
    resolveStylesheet,
    resolveLink
  };
}

/**
 * 获取指定模块的传递性静态导入集合
 * 
 * 这个函数专门用于分析单个模块的所有静态导入依赖，包括传递性依赖。
 * 与 getResolvers 不同，这里只关注静态导入，不处理动态导入或其他类型的依赖。
 * 
 * ## 处理步骤：
 * 1. 收集本地和全局静态导入
 * 2. 添加文件方法对应的隐式导入
 * 3. 解析外部包的传递性依赖
 * 
 * @param root 项目根目录
 * @param path 模块路径
 * @returns Promise<string[]> 所有静态导入的路径列表（相对于该模块）
 */
export async function getModuleStaticImports(root: string, path: string): Promise<string[]> {
  const localImports = new Set<string>([path]);
  const globalImports = new Set<string>();
  const fileMethods = new Set<string>();

  // 从传递性本地导入中收集本地和全局导入
  for (const i of localImports) {
    const info = getModuleInfo(root, i);
    if (!info) continue;
    for (const o of info.localStaticImports) localImports.add(resolvePath(i, o));
    for (const o of info.globalStaticImports) globalImports.add(o);
    for (const m of info.fileMethods) fileMethods.add(m);
  }

  // 从文件方法收集隐式导入
  for (const i of getImplicitFileImports(fileMethods)) {
    globalImports.add(i);
  }

  // 收集传递性全局导入
  for (const i of globalImports) {
    if (builtins.has(i)) continue;
    if (i.startsWith("npm:")) {
      const p = await resolveNpmImport(root, i.slice("npm:".length));
      for (const o of await resolveNpmImports(root, p)) {
        if (o.type === "local") globalImports.add(`npm:${extractNpmSpecifier(resolvePath(p, o.name))}`);
      }
    } else if (i.startsWith("jsr:")) {
      const p = await resolveJsrImport(root, i.slice("jsr:".length));
      for (const o of await resolveJsrImports(root, p)) {
        if (o.type === "local") globalImports.add(`jsr:${extractJsrSpecifier(resolvePath(p, o.name))}`);
      }
    } else if (!/^\w+:/.test(i)) {
      const p = await resolveNodeImport(root, i);
      for (const o of await resolveNodeImports(root, p)) {
        if (o.type === "local") globalImports.add(extractNodeSpecifier(resolvePath(p, o.name)));
      }
    }
  }

  return [...localImports, ...globalImports].filter((i) => i !== path).map((i) => relativePath(path, i));
}

/**
 * 获取模块导入解析器
 * 
 * 返回用于转译本地模块的导入解析器。与 getResolvers 不同，这个解析器：
 * - 独立于任何特定页面
 * - 在不预先知道传递性导入的情况下工作
 * - 但应该与 getResolvers 返回的 resolveImport 保持一致（假设有缓存）
 * 
 * 这个函数主要用于模块转译过程中的实时导入解析。
 * 
 * @param root 项目根目录
 * @param path 模块路径
 * @param servePath 服务路径（默认为 /_import/${path}）
 * @param getHash 可选的哈希获取函数
 * @returns 异步导入解析器函数
 */
export function getModuleResolver(
  root: string,
  path: string,
  servePath = `/${join("_import", path)}`,
  getHash?: (path: string) => string
): (specifier: string) => Promise<string> {
  return async (specifier) => {
    return isPathImport(specifier)
      ? relativePath(servePath, resolveImportPath(root, resolvePath(path, specifier), getHash))
      : builtins.has(specifier) || specifier.startsWith("observablehq:")
      ? relativePath(servePath, resolveBuiltin(specifier))
      : specifier.startsWith("npm:")
      ? relativePath(servePath, await resolveNpmImport(root, specifier.slice("npm:".length)))
      : specifier.startsWith("jsr:")
      ? relativePath(servePath, await resolveJsrImport(root, specifier.slice("jsr:".length)))
      : !/^\w+:/.test(specifier)
      ? relativePath(servePath, await resolveNodeImport(root, specifier))
      : specifier;
  };
}

/**
 * 解析内置模块说明符
 * 
 * 将内置模块说明符解析为实际的服务路径。处理：
 * - builtins 映射表中的模块
 * - observablehq: 协议的模块
 * 
 * @param specifier 模块说明符
 * @returns 解析后的服务路径
 * @throws Error 如果说明符不是内置模块
 */
export function resolveBuiltin(specifier: string): string {
  if (builtins.has(specifier)) return builtins.get(specifier)!;
  if (!specifier.startsWith("observablehq:")) throw new Error(`not built-in: ${specifier}`);
  return `/_observablehq/${specifier.slice("observablehq:".length)}${extname(specifier) ? "" : ".js"}`;
}

/**
 * 解析样式表路径
 * 
 * 为本地样式表文件生成带有内容哈希的服务路径，用于缓存破坏。
 * 
 * @param root 项目根目录
 * @param path 样式表文件路径
 * @returns 带有哈希查询参数的样式表路径
 */
export function resolveStylesheetPath(root: string, path: string): string {
  return `/${join("_import", path)}?sha=${getFileHash(root, path)}`;
}

/**
 * 解析导入路径
 * 
 * 为本地模块生成带有模块哈希的服务路径，用于缓存破坏。
 * 
 * @param root 项目根目录
 * @param path 模块路径
 * @param getHash 可选的哈希获取函数
 * @returns 带有哈希查询参数的模块路径
 */
export function resolveImportPath(root: string, path: string, getHash?: (name: string) => string): string {
  return `/${join("_import", path)}?sha=${getModuleHash(root, path, getHash)}`;
}

/**
 * 查找页面中的自由输入变量
 * 
 * 返回任何未在输出中声明的输入变量。这些通常引用标准库提供的符号，
 * 如 d3 和 Inputs，用于确定需要隐式导入哪些库。
 * 
 * ## 处理逻辑：
 * 1. 收集所有声明的变量（outputs）
 * 2. 收集所有未绑定的引用（inputs）
 * 3. 返回在 inputs 中但不在 outputs 中的变量
 * 
 * @param page Markdown 页面对象
 * @returns Set<string> 自由输入变量的集合
 */
function findFreeInputs(page: MarkdownPage): Set<string> {
  // 默认全局变量 + 特殊变量
  const outputs = new Set<string>(defaultGlobals).add("display").add("view").add("visibility").add("invalidation");
  const inputs = new Set<string>();

  // 计算所有声明的变量
  for (const {node} of page.code) {
    if (node.declarations) {
      for (const {name} of node.declarations) {
        outputs.add(name);
      }
    }
  }

  // 计算所有未绑定的引用
  for (const {node} of page.code) {
    for (const {name} of node.references) {
      if (!outputs.has(name)) {
        inputs.add(name);
      }
    }
  }

  return inputs;
}

/**
 * Observable Framework 配置管理模块
 * 
 * 这个模块是 Observable Framework 的核心配置系统，负责：
 * 1. **配置文件解析**: 读取和解析 observablehq.config.js/ts 配置文件
 * 2. **配置标准化**: 将用户配置转换为内部标准格式，设置默认值
 * 3. **配置验证**: 验证配置参数的有效性和类型安全
 * 4. **页面发现**: 自动发现和组织项目中的页面文件
 * 5. **主题样式**: 管理主题、样式表和全局样式配置
 * 6. **路径处理**: 处理各种路径规范化和URL重写规则
 * 
 * 配置系统支持：
 * - 静态页面配置（pages）
 * - 动态路径生成（dynamicPaths）
 * - 自定义样式和主题（style, theme）
 * - 搜索功能配置（search）
 * - 数据库扩展配置（duckdb）
 * - 页面片段自定义（head, header, footer）
 * 
 * 使用场景：
 * - 项目初始化时读取配置
 * - 开发服务器启动配置
 * - 构建过程中的参数控制
 * - 页面路由和导航生成
 */

import {createHash} from "node:crypto";
import {existsSync, readFileSync} from "node:fs";
import {stat} from "node:fs/promises";
import op from "node:path";
import {basename, dirname, extname, join} from "node:path/posix";
import {cwd} from "node:process";
import {pathToFileURL} from "node:url";
import he from "he";
import type MarkdownIt from "markdown-it";
import wrapAnsi from "wrap-ansi";
import {DUCKDB_CORE_ALIASES, DUCKDB_CORE_EXTENSIONS} from "./duckdb.js";
import {visitFiles} from "./files.js";
import {formatIsoDate, formatLocaleDate} from "./format.js";
import type {FrontMatter} from "./frontMatter.js";
import {findModule} from "./javascript/module.js";
import {LoaderResolver} from "./loader.js";
import {createMarkdownIt, parseMarkdownMetadata} from "./markdown.js";
import {getPagePaths} from "./pager.js";
import {isAssetPath, parseRelativeUrl, resolvePath} from "./path.js";
import {isParameterized} from "./route.js";
import {resolveTheme} from "./theme.js";
import {bold, yellow} from "./tty.js";

/**
 * 目录配置接口
 * 
 * 控制页面右侧目录（Table of Contents）的显示行为
 */
export interface TableOfContents {
  /** 是否显示目录 */
  show: boolean;
  /** 目录标题文本，默认为 "Contents" */
  label: string;
}

/**
 * 页面配置接口
 * 
 * 定义单个页面的基本信息，用于侧边栏导航和页面路由
 */
export interface Page {
  /** 页面显示名称，用于侧边栏和导航 */
  name: string;
  /** 页面路径，相对于站点根目录，如 "/getting-started" */
  path: string;
  /** 页面分组标识，用于分页导航，null 表示不参与分页 */
  pager: string | null;
}

/**
 * 页面分组配置接口
 * 
 * 将多个页面组织成可折叠的分组，用于侧边栏的层级导航
 */
export interface Section<T = Page> {
  /** 分组显示名称 */
  name: string;
  /** 是否可折叠，默认为 false */
  collapsible: boolean;
  /** 是否默认展开，默认为 true；如果 collapsible 为 false 则始终为 true */
  open: boolean;
  /** 分组链接路径，null 表示分组标题不可点击 */
  path: string | null;
  /** 分组的分页标识 */
  pager: string | null;
  /** 分组包含的页面列表 */
  pages: T[];
}

/**
 * 样式配置类型
 * 
 * 支持两种样式配置方式：
 * - 自定义样式表文件路径
 * - 预定义主题名称数组
 */
export type Style =
  | {path: string}     // 自定义样式表：{path: "./custom.css"}
  | {theme: string[]}; // 主题配置：{theme: ["light", "dark"]}

/**
 * 脚本配置接口
 * 
 * 定义要在页面中加载的外部脚本（已废弃，建议使用 head 配置）
 */
export interface Script {
  /** 脚本文件的 URL 或路径 */
  src: string;
  /** 是否异步加载脚本 */
  async: boolean;
  /** 脚本的 MIME 类型，null 表示使用默认类型 */
  type: string | null;
}

/**
 * 页面片段函数类型
 * 
 * 用于生成页面的 head、header 或 footer 部分的函数
 * 可以根据页面的标题、前置数据和路径动态生成内容
 */
export type PageFragmentFunction = ({
  title,
  data,
  path
}: {
  /** 页面标题，可能为 null */
  title: string | null;
  /** 页面的前置数据（Front Matter） */
  data: FrontMatter;
  /** 页面路径 */
  path: string;
}) => string | null;

/**
 * 搜索结果接口
 * 
 * 定义搜索功能返回的单个结果项的结构
 */
export interface SearchResult {
  /** 结果页面的路径 */
  path: string;
  /** 页面标题，可能为 null */
  title: string | null;
  /** 页面文本内容 */
  text: string;
  /** 可选的关键词，用于搜索匹配 */
  keywords?: string;
}

/**
 * 搜索配置接口
 * 
 * 配置站点的搜索功能
 */
export interface SearchConfig {
  /** 搜索索引生成函数，返回异步可迭代的搜索结果，null 表示禁用搜索 */
  index: (() => AsyncIterable<SearchResult>) | null;
}

/**
 * 搜索配置规范接口
 * 
 * 用户配置文件中搜索相关选项的类型定义
 */
export interface SearchConfigSpec {
  index?: unknown;
}

/**
 * DuckDB 数据库配置接口
 * 
 * 配置 DuckDB 数据库的平台支持和扩展
 */
export interface DuckDBConfig {
  /** 支持的平台配置，键为平台名，值为 true 表示启用 */
  platforms: {[name: string]: true};
  /** 数据库扩展配置，键为扩展名 */
  extensions: {[name: string]: DuckDBExtensionConfig};
}

/**
 * DuckDB 扩展配置接口
 * 
 * 定义单个 DuckDB 扩展的配置选项
 */
export interface DuckDBExtensionConfig {
  /** 扩展的来源 URL 或类型（"core" | "community" | 自定义URL） */
  source: string;
  /** 是否安装此扩展 */
  install: boolean;
  /** 是否加载此扩展 */
  load: boolean;
}

/**
 * DuckDB 扩展配置规范接口（内部使用）
 */
interface DuckDBExtensionConfigSpec {
  source: unknown;
  install: unknown;
  load: unknown;
}

/**
 * 主配置接口
 * 
 * Observable Framework 的完整配置对象，包含所有构建和运行时参数
 */
export interface Config {
  /** 源代码根目录，默认为 "src" */
  root: string;
  /** 构建输出目录，默认为 "dist" */
  output: string;
  /** 站点的基础路径，默认为 "/"，用于部署在子路径的场景 */
  base: string;
  /** 首页链接文本，默认为站点标题或 "Home" */
  home: string;
  /** 站点标题，可选，用于页面标题和首页链接 */
  title?: string;
  /** 是否显示侧边栏，默认根据 pages 是否为空自动确定 */
  sidebar: boolean;
  /** 页面和分组配置数组，用于生成侧边栏导航 */
  pages: (Page | Section<Page>)[];
  /** 是否启用分页导航（上一页/下一页），默认为 true */
  pager: boolean;
  /** 页面路径生成器，返回所有需要构建的页面路径 */
  paths: () => AsyncIterable<string>;
  /** 脚本配置数组（已废弃，建议使用 head） */
  scripts: Script[];
  /** 页面 head 部分的自定义内容或生成函数 */
  head: PageFragmentFunction | string | null;
  /** 页面 header 部分的自定义内容或生成函数 */
  header: PageFragmentFunction | string | null;
  /** 页面 footer 部分的自定义内容或生成函数，默认显示构建信息 */
  footer: PageFragmentFunction | string | null;
  /** 目录配置 */
  toc: TableOfContents;
  /** 样式配置，null 表示禁用默认样式 */
  style: null | Style;
  /** 全局样式表 URL 数组，默认包含 Google Fonts */
  globalStylesheets: string[];
  /** 搜索功能配置，null 表示禁用搜索 */
  search: SearchConfig | null;
  /** Markdown 解析器实例，配置了项目特定的解析选项 */
  md: MarkdownIt;
  /** 路径标准化函数，处理 URL 重写和清理 */
  normalizePath: (path: string) => string;
  /** 数据加载器解析器，处理各种数据文件的加载 */
  loaders: LoaderResolver;
  /** 监控的配置文件路径，用于热重载 */
  watchPath?: string;
  /** DuckDB 数据库配置 */
  duckdb: DuckDBConfig;
}

/**
 * 配置规范接口
 * 
 * 用户配置文件中可以设置的所有选项，使用 unknown 类型以支持运行时验证
 */
export interface ConfigSpec {
  /** 源代码根目录路径 */
  root?: unknown;
  /** 构建输出目录路径 */
  output?: unknown;
  /** 站点基础路径 */
  base?: unknown;
  /** 是否显示侧边栏 */
  sidebar?: unknown;
  /** 样式配置 */
  style?: unknown;
  /** 全局样式表配置 */
  globalStylesheets?: unknown;
  /** 主题配置（已合并到 style 中） */
  theme?: unknown;
  /** 搜索功能配置 */
  search?: unknown;
  /** 脚本配置（已废弃） */
  scripts?: unknown;
  /** 页面 head 自定义内容 */
  head?: unknown;
  /** 页面 header 自定义内容 */
  header?: unknown;
  /** 页面 footer 自定义内容 */
  footer?: unknown;
  /** 数据加载器解释器配置 */
  interpreters?: unknown;
  /** 首页链接文本 */
  home?: unknown;
  /** 站点标题 */
  title?: unknown;
  /** 页面配置 */
  pages?: unknown;
  /** 分页导航配置 */
  pager?: unknown;
  /** 动态路径配置 */
  dynamicPaths?: unknown;
  /** 目录配置 */
  toc?: unknown;
  /** Markdown 链接化配置 */
  linkify?: unknown;
  /** Markdown 排版优化配置 */
  typographer?: unknown;
  /** Markdown 引号样式配置 */
  quotes?: unknown;
  /** 清洁 URL 配置（已废弃） */
  cleanUrls?: unknown;
  /** 是否保留 index 文件名 */
  preserveIndex?: unknown;
  /** 是否保留文件扩展名 */
  preserveExtension?: unknown;
  /** Markdown-it 自定义配置函数 */
  markdownIt?: unknown;
  /** DuckDB 数据库配置 */
  duckdb?: unknown;
}

/**
 * 脚本配置规范接口（内部使用）
 */
interface ScriptSpec {
  src?: unknown;
  async?: unknown;
  type?: unknown;
}

/**
 * 分组配置规范接口（内部使用）
 */
interface SectionSpec {
  name?: unknown;
  open?: unknown;
  collapsible?: unknown;
  path?: unknown;
  pages?: unknown;
  pager?: unknown;
}

/**
 * 页面配置规范接口（内部使用）
 */
interface PageSpec {
  name?: unknown;
  path?: unknown;
  pager?: unknown;
}

/**
 * 目录配置规范接口（内部使用）
 */
interface TableOfContentsSpec {
  label?: unknown;
  show?: unknown;
}

/**
 * 解析配置文件的绝对路径
 * 
 * 将相对于给定根目录的配置文件路径转换为绝对路径
 * 
 * @param configPath 配置文件相对路径
 * @param root 根目录，默认为当前目录
 * @returns 配置文件的绝对路径
 */
function resolveConfig(configPath: string, root = "."): string {
  return op.join(cwd(), root, configPath);
}

/**
 * 动态导入配置文件
 * 
 * 🔄 **核心机制：模块缓存绕过**
 * 
 * JavaScript 的 import() 函数有一个重要特性：**模块缓存**
 * - 相同路径的模块只会被加载一次，后续导入会直接返回缓存的结果
 * - 这在正常情况下是性能优化，但在开发环境中会阻止配置文件的热重载
 * 
 * 🎯 **问题场景**：
 * ```javascript
 * // 第一次导入
 * const config1 = await import('./observablehq.config.js'); // 实际加载文件
 * 
 * // 用户修改了配置文件内容...
 * 
 * // 第二次导入（问题出现）
 * const config2 = await import('./observablehq.config.js'); // 返回缓存！不是新内容
 * 
 * console.log(config1 === config2); // true - 这不是我们想要的
 * ```
 * 
 * 💡 **解决方案：查询参数破坏缓存**
 * 
 * 通过在模块路径后添加查询参数，我们可以"欺骗"模块系统，
 * 让它认为这是不同的模块，从而绕过缓存机制：
 * 
 * ```javascript
 * // 文件修改时间：1703123456789
 * await import('./config.js?1703123456789'); // 第一次加载
 * 
 * // 文件被修改，修改时间变为：1703123999999
 * await import('./config.js?1703123999999'); // 被视为新模块，重新加载
 * ```
 * 
 * 🔍 **文件修改时间的优势**：
 * 1. **精确性**: 只有文件真正被修改时，时间戳才会改变
 * 2. **自动性**: 无需手动管理版本号或随机数
 * 3. **可靠性**: 文件系统保证修改时间的唯一性和递增性
 * 4. **调试友好**: 可以通过时间戳判断配置加载的时间点
 * 
 * 🚀 **实际应用场景**：
 * - **开发服务器**: 用户修改 observablehq.config.js 后立即生效
 * - **构建工具**: 检测配置变更并重新构建
 * - **热重载**: 配置更改时自动刷新页面
 * 
 * 📝 **技术细节**：
 * - `stat(path)` 返回文件统计信息，包含 `mtimeMs`（修改时间的毫秒时间戳）
 * - `pathToFileURL(path)` 将文件路径转换为 file:// URL 格式
 * - 查询参数不影响实际的文件加载，只影响模块缓存键
 * 
 * @param path 配置文件的绝对路径
 * @returns 配置对象的 Promise
 * 
 * @example
 * ```typescript
 * // 假设配置文件在 1703123456789 时被修改
 * const config = await importConfig('/path/to/config.js');
 * // 实际导入: import('file:///path/to/config.js?1703123456789')
 * 
 * // 用户修改配置文件...文件修改时间变为 1703123999999
 * const newConfig = await importConfig('/path/to/config.js');
 * // 实际导入: import('file:///path/to/config.js?1703123999999')
 * // 这被视为完全不同的模块，会重新加载文件内容
 * ```
 */
async function importConfig(path: string): Promise<ConfigSpec> {
  const {mtimeMs} = await stat(path);//suchao:在 node_modules/@types/node/fs/promises.d.ts 里，不是 Promise 自身的东西。它是 fs.promises 模块的类型声明，功能是异步获取文件状态信息，返回一个 Promise<fs.Stats>。
  return (await import(`${pathToFileURL(path).href}?${mtimeMs}`)).default;
}

/**
 * 读取并解析配置文件
 * 
 * 这是配置系统的主入口函数，负责：
 * 1. 解析配置文件路径（支持自动发现）
 * 2. 动态导入配置文件
 * 3. 标准化配置对象
 * 
 * @param configPath 配置文件路径，undefined 时自动查找默认配置
 * @param root 项目根目录
 * @returns 标准化后的配置对象
 */
export async function readConfig(configPath?: string, root?: string): Promise<Config> {
  if (configPath === undefined) configPath = await resolveDefaultConfig(root);
  if (configPath === undefined) return normalizeConfig(undefined, root);
  return normalizeConfig(await importConfig(configPath), root, configPath);
}

/**
 * 查找默认配置文件
 * 
 * 按优先级查找项目根目录下的配置文件：
 * 1. observablehq.config.js
 * 2. observablehq.config.ts（需要 tsx 支持）
 * 
 * @param root 项目根目录
 * @returns 找到的配置文件路径，或 undefined
 */
async function resolveDefaultConfig(root?: string): Promise<string | undefined> {
  const jsPath = resolveConfig("observablehq.config.js", root);
  if (existsSync(jsPath)) return jsPath;
  const tsPath = resolveConfig("observablehq.config.ts", root);
  if (existsSync(tsPath)) return await import("tsx/esm"), tsPath; // 懒加载 tsx 支持
}

/**
 * 页面缓存对象
 * 
 * 缓存已解析的页面列表，避免重复扫描文件系统
 * 使用内容哈希作为缓存键，确保文件变更时缓存失效
 */
let cachedPages: {key: string; pages: Page[]} | null = null;

/**
 * 读取并解析项目中的页面文件
 * 
 * 扫描源代码目录，自动发现所有 Markdown 页面文件，并解析其元数据
 * 生成页面配置数组，用于侧边栏导航和路由
 * 
 * 处理逻辑：
 * 1. 扫描所有 .md 文件（排除 index.md 和 404.md）
 * 2. 跳过已有对应 .js 模块的页面
 * 3. 解析页面的 Front Matter 元数据
 * 4. 跳过标记为草稿的页面
 * 5. 生成页面配置对象
 * 
 * @param root 源代码根目录
 * @param md Markdown 解析器实例
 * @returns 页面配置数组
 */
function readPages(root: string, md: MarkdownIt): Page[] {
  const files: {file: string; source: string}[] = [];
  const hash = createHash("sha256");
  
  // 扫描所有非参数化的文件
  for (const file of visitFiles(root, (name) => !isParameterized(name))) {
    // 只处理 .md 文件，排除特殊页面
    if (extname(file) !== ".md" || file === "index.md" || file === "404.md") continue;
    
    const path = file.slice(0, -".md".length);
    // 如果存在对应的 .js 模块文件，跳过此页面
    if (path.endsWith(".js") && findModule(root, path)) continue;
    
    const source = readFileSync(join(root, file), "utf8");
    files.push({file, source});
    hash.update(file).update(source);
  }
  
  // 检查缓存是否有效
  const key = hash.digest("hex");
  if (cachedPages?.key === key) return cachedPages.pages;
  
  // 解析页面元数据
  const pages: Page[] = [];
  for (const {file, source} of files) {
    const {data, title} = parseMarkdownMetadata(source, {path: file, md});
    if (data.draft) continue; // 跳过草稿页面
    
    const name = basename(file, ".md");
    const {pager = "main"} = data;
    const page = {path: join("/", dirname(file), name), name: title ?? "Untitled", pager};
    
    // index 页面放在最前面
    if (name === "index") pages.unshift(page);
    else pages.push(page);
  }
  
  // 更新缓存
  cachedPages = {key, pages};
  return pages;
}

/**
 * 当前日期（用于测试）
 * 
 * 允许在测试环境中覆盖当前日期，确保构建结果的一致性
 */
export let currentDate: Date | null = null;

/**
 * 设置当前日期（仅用于测试）
 * 
 * @param date 要设置的日期，null 表示使用系统当前时间
 */
export function setCurrentDate(date: Date | null): void {
  currentDate = date;
}

/**
 * 配置缓存
 * 
 * 使用 WeakMap 缓存标准化后的配置对象，避免重复处理相同的配置规范
 * 当配置规范对象被垃圾回收时，对应的缓存也会自动清理
 */
const configCache = new WeakMap<ConfigSpec, Config>();

/**
 * 标准化配置对象
 * 
 * 这是配置系统的核心函数，负责：
 * 1. 验证和转换用户配置
 * 2. 设置默认值
 * 3. 创建派生配置（如路径生成器）
 * 4. 初始化各个子系统（Markdown、加载器等）
 * 
 * @param spec 用户配置规范
 * @param defaultRoot 默认根目录
 * @param watchPath 监控的配置文件路径
 * @returns 标准化后的配置对象
 */
export function normalizeConfig(spec: ConfigSpec = {}, defaultRoot?: string, watchPath?: string): Config {
  // 检查缓存
  const cachedConfig = configCache.get(spec);
  if (cachedConfig) return cachedConfig;
  
  // 基础路径配置
  const root = spec.root === undefined ? findDefaultRoot(defaultRoot) : String(spec.root);
  const output = spec.output === undefined ? "dist" : String(spec.output);
  const base = spec.base === undefined ? "/" : normalizeBase(spec.base);
  
  // 样式配置处理
  const style =
    spec.style === null
      ? null  // 显式禁用样式
      : spec.style !== undefined
      ? {path: String(spec.style)}  // 自定义样式文件
      : {theme: normalizeTheme(spec.theme === undefined ? "default" : spec.theme)};  // 主题配置
  
  // 全局样式表配置
  const globalStylesheets =
    spec.globalStylesheets === undefined
      ? defaultGlobalStylesheets()  // 默认 Google Fonts
      : normalizeGlobalStylesheets(spec.globalStylesheets);
  
  // Markdown 解析器配置
  const md = createMarkdownIt({
    linkify: spec.linkify === undefined ? undefined : Boolean(spec.linkify),
    typographer: spec.typographer === undefined ? undefined : Boolean(spec.typographer),
    quotes: spec.quotes === undefined ? undefined : (spec.quotes as any),
    markdownIt: spec.markdownIt as any
  });
  
  // 站点信息配置
  const title = spec.title === undefined ? undefined : String(spec.title);
  const home = spec.home === undefined ? he.escape(title ?? "Home") : String(spec.home); // eslint-disable-line import/no-named-as-default-member
  
  // 页面和导航配置
  const pages = spec.pages === undefined ? undefined : normalizePages(spec.pages);
  const pager = spec.pager === undefined ? true : Boolean(spec.pager);
  const dynamicPaths = normalizeDynamicPaths(spec.dynamicPaths);
  const toc = normalizeToc(spec.toc as any);
  const sidebar = spec.sidebar === undefined ? undefined : Boolean(spec.sidebar);
  
  // 页面片段配置
  const scripts = spec.scripts === undefined ? [] : normalizeScripts(spec.scripts);
  const head = pageFragment(spec.head === undefined ? "" : spec.head);
  const header = pageFragment(spec.header === undefined ? "" : spec.header);
  const footer = pageFragment(spec.footer === undefined ? defaultFooter() : spec.footer);
  
  // 其他功能配置
  const search = spec.search == null || spec.search === false ? null : normalizeSearch(spec.search as any);
  const interpreters = normalizeInterpreters(spec.interpreters as any);
  const normalizePath = getPathNormalizer(spec);
  const duckdb = normalizeDuckDB(spec.duckdb);

  /**
   * 页面路径标准化函数
   * 
   * 处理页面路径的标准化，包括：
   * - 解析查询参数和锚点
   * - 添加隐式的 /index 后缀
   * - 移除 .html 扩展名
   */
  function normalizePagePath(pathname: string): string {
    ({pathname} = parseRelativeUrl(pathname)); // 忽略查询参数和锚点
    pathname = normalizePath(pathname);
    if (pathname.endsWith("/")) pathname = join(pathname, "index");
    else pathname = pathname.replace(/\.html$/, "");
    return pathname;
  }

  // 创建配置对象
  const config: Config = {
    root,
    output,
    base,
    home,
    title,
    sidebar: sidebar!, // 下面会设置默认值
    pages: pages!, // 下面会设置默认值
    pager,
    /**
     * 页面路径生成器
     * 
     * 生成所有需要构建的页面路径，包括：
     * 1. 静态页面文件（.md 文件）
     * 2. 配置文件中定义的页面
     * 3. 动态路径（可以是固定列表或函数生成）
     * 
     * 使用去重机制确保每个路径只出现一次
     */
    async *paths() {  
      const visited = new Set<string>();
      function* visit(path: string): Generator<string> {
        if (!visited.has((path = normalizePagePath(path)))) {
          visited.add(path);
          yield path;
        }
      }
      // 只扫描页面文件(包含.md文件)，不扫描数据文件
      for (const path of this.loaders.findPagePaths()) {
        yield* visit(path);
      }
      // suchao:配置文件中定义的页面，这里配置的文件会在sidebar中显示
      for (const path of getPagePaths(this)) {
        yield* visit(path);
      }
      // suchao:动态路径，可以是固定格式多个，也可是函数返回多个；和文件按优先级匹配
      for await (const path of dynamicPaths()) {
        yield* visit(path);
      }
    },
    scripts,
    head,
    header,
    footer,
    toc,
    style,
    globalStylesheets,
    search,
    md,
    normalizePath,
    loaders: new LoaderResolver({root, interpreters}),
    watchPath,
    duckdb
  };
  
  // 设置延迟计算的属性
  if (pages === undefined) Object.defineProperty(config, "pages", {get: () => readPages(root, md)});
  if (sidebar === undefined) Object.defineProperty(config, "sidebar", {get: () => config.pages.length > 0});
  
  // 缓存配置对象
  configCache.set(spec, config);
  return config;
}

/**
 * 标准化动态路径配置
 * 
 * 将用户配置转换为统一的异步生成器函数
 * 
 * @param spec 动态路径配置，可以是函数或字符串数组
 * @returns 异步路径生成器
 */
function normalizeDynamicPaths(spec: unknown): Config["paths"] {
  if (typeof spec === "function") return spec as () => AsyncIterable<string>;
  const paths = Array.from((spec ?? []) as ArrayLike<string>, String);
  return async function* () { yield* paths; }; // prettier-ignore
}

/**
 * 标准化清洁 URL 配置（已废弃）
 * 
 * @param spec 清洁 URL 配置
 * @returns 是否使用清洁 URL
 */
function normalizeCleanUrls(spec: unknown): boolean {
  console.warn(`${yellow("Warning:")} the ${bold("cleanUrls")} option is deprecated; use ${bold("preserveIndex")} and ${bold("preserveExtension")} instead.`); // prettier-ignore
  return !spec;
}

/**
 * 获取路径标准化函数
 * 
 * 根据配置创建路径标准化函数，处理：
 * - 文件扩展名的保留或移除
 * - index 文件名的处理
 * - HTML 扩展名的处理
 * 
 * @param spec 配置规范
 * @returns 路径标准化函数
 */
function getPathNormalizer(spec: ConfigSpec): (path: string) => string {
  const preserveIndex = spec.preserveIndex !== undefined ? Boolean(spec.preserveIndex) : false;
  const preserveExtension = spec.preserveExtension !== undefined ? Boolean(spec.preserveExtension) : spec.cleanUrls !== undefined ? normalizeCleanUrls(spec.cleanUrls) : false; // prettier-ignore
  return (path) => {
    const ext = extname(path);
    if (path.endsWith(".")) path += "/";
    if (ext === ".html") path = path.slice(0, -".html".length);
    if (path.endsWith("/index")) path = path.slice(0, -"index".length);
    if (preserveIndex && path.endsWith("/")) path += "index";
    if (!preserveIndex && path === "index") path = ".";
    if (preserveExtension && path && !path.endsWith(".") && !path.endsWith("/") && !extname(path)) path += ".html";
    return path;
  };
}

/**
 * 标准化页面片段配置
 * 
 * 将字符串或函数转换为标准的页面片段格式
 * 
 * @param spec 页面片段配置
 * @returns 标准化后的页面片段
 */
function pageFragment(spec: unknown): PageFragmentFunction | string | null {
  return typeof spec === "function" ? (spec as PageFragmentFunction) : stringOrNull(spec);
}

/**
 * 获取默认全局样式表
 * 
 * @returns 默认样式表 URL 数组
 */
function defaultGlobalStylesheets(): string[] {
  return [
    "https://fonts.googleapis.com/css2?family=Source+Serif+4:ital,opsz,wght@0,8..60,200..900;1,8..60,200..900&display=swap"
  ];
}

/**
 * 生成默认页脚内容
 * 
 * @returns 默认页脚 HTML 字符串
 */
function defaultFooter(): string {
  const date = currentDate ?? new Date();
  return `Built with <a href="https://observablehq.com/" target="_blank">Observable</a> on <a title="${formatIsoDate(
    date
  )}">${formatLocaleDate(date)}</a>.`;
}

/**
 * 查找默认源代码根目录
 * 
 * 按优先级查找项目的源代码目录：
 * 1. 使用提供的默认根目录
 * 2. 如果存在 "docs" 目录则使用 "docs"（向后兼容）
 * 3. 否则使用 "src"（推荐）
 * 
 * @param defaultRoot 提供的默认根目录
 * @returns 确定的根目录路径
 */
function findDefaultRoot(defaultRoot?: string): string {
  if (defaultRoot !== undefined) return defaultRoot;
  const root = existsSync("docs") ? "docs" : "src";
  console.warn(
    wrapAnsi(
      `${yellow("Warning:")} the config file is missing the ${bold(
        "root"
      )} option, which specifies the path to the source root.${
        root === "docs"
          ? ` The recommended source root is ${bold('"src"')}; however, since ${bold(
              "docs"
            )} exists and was previously the default for this option, we will use ${bold('"docs"')}.`
          : ""
      } You can suppress this warning by specifying ${bold(`root: ${JSON.stringify(root)}`)} in the config file.\n`,
      Math.min(80, process.stdout.columns ?? 80)
    )
  );
  return root;
}

/**
 * 标准化数组配置
 * 
 * 通用的数组标准化函数，将任意值转换为数组并应用转换函数
 * 
 * @param spec 配置值
 * @param f 元素转换函数
 * @returns 标准化后的数组
 */
function normalizeArray<T>(spec: unknown, f: (spec: unknown) => T): T[] {
  return spec == null ? [] : Array.from(spec as ArrayLike<unknown>, f);
}

/**
 * 标准化基础路径配置
 * 
 * 确保基础路径以斜杠开头和结尾
 * 
 * @param spec 基础路径配置
 * @returns 标准化后的基础路径
 */
function normalizeBase(spec: unknown): string {
  let base = String(spec);
  if (!base.startsWith("/")) throw new Error(`base must start with slash: ${base}`);
  if (!base.endsWith("/")) base += "/";
  return base;
}

/**
 * 标准化全局样式表配置
 * 
 * @param spec 全局样式表配置
 * @returns 样式表 URL 数组
 */
function normalizeGlobalStylesheets(spec: unknown): string[] {
  return normalizeArray(spec, String);
}

/**
 * 标准化主题配置
 * 
 * 将主题配置转换为主题名称数组，并解析主题依赖
 * 
 * @param spec 主题配置，可以是字符串或字符串数组
 * @returns 解析后的主题名称数组
 */
export function normalizeTheme(spec: unknown): string[] {
  return resolveTheme(typeof spec === "string" ? [spec] : normalizeArray(spec, String));
}

/**
 * 标准化脚本配置（已废弃）
 * 
 * @param spec 脚本配置
 * @returns 标准化后的脚本数组
 */
function normalizeScripts(spec: unknown): Script[] {
  console.warn(`${yellow("Warning:")} the ${bold("scripts")} option is deprecated; use ${bold("head")} instead.`);
  return normalizeArray(spec, normalizeScript);
}

/**
 * 标准化单个脚本配置
 * 
 * @param spec 脚本配置规范
 * @returns 标准化后的脚本对象
 */
function normalizeScript(spec: unknown): Script {
  const script = typeof spec === "string" ? {src: spec} : (spec as ScriptSpec);
  const src = String(script.src);
  const async = script.async === undefined ? false : Boolean(script.async);
  const type = script.type == null ? null : String(script.type);
  return {src, async, type};
}

/**
 * 标准化页面配置
 * 
 * 将页面配置数组标准化，支持页面和分组的混合配置
 * 
 * @param spec 页面配置规范
 * @returns 标准化后的页面配置数组
 */
function normalizePages(spec: unknown): Config["pages"] {
  return normalizeArray(spec, (spec: any) =>
    "pages" in spec ? normalizeSection(spec, normalizePage) : normalizePage(spec)
  );
}

/**
 * 标准化页面分组配置
 * 
 * @param spec 分组配置规范
 * @param normalizePage 页面标准化函数
 * @returns 标准化后的分组对象
 */
function normalizeSection<T>(
  spec: SectionSpec,
  normalizePage: (spec: PageSpec, pager: string | null) => T
): Section<T> {
  const name = String(spec.name);
  const collapsible = spec.collapsible === undefined ? spec.open !== undefined : Boolean(spec.collapsible);
  const open = collapsible ? Boolean(spec.open) : true;
  const pager = spec.pager === undefined ? "main" : stringOrNull(spec.pager);
  const path = spec.path == null ? null : normalizePath(spec.path);
  const pages = normalizeArray(spec.pages, (spec: any) => normalizePage(spec, pager));
  return {name, collapsible, open, path, pager, pages};
}

/**
 * 标准化单个页面配置
 * 
 * @param spec 页面配置规范
 * @param defaultPager 默认分页标识
 * @returns 标准化后的页面对象
 */
function normalizePage(spec: PageSpec, defaultPager: string | null = "main"): Page {
  const name = String(spec.name);
  const path = normalizePath(spec.path);
  const pager = spec.pager === undefined && isAssetPath(path) ? defaultPager : stringOrNull(spec.pager);
  return {name, path, pager};
}

/**
 * 标准化搜索配置
 * 
 * @param spec 搜索配置规范
 * @returns 标准化后的搜索配置
 */
function normalizeSearch(spec: SearchConfigSpec): SearchConfig {
  const index = spec.index == null ? null : (spec.index as SearchConfig["index"]);
  if (index !== null && typeof index !== "function") throw new Error("search.index is not a function");
  return {index};
}

/**
 * 标准化路径配置
 * 
 * 处理资源路径的标准化，包括：
 * - 添加前导斜杠
 * - 移除 .html 扩展名
 * - 处理尾部斜杠和 index
 * 
 * @param spec 路径配置
 * @returns 标准化后的路径
 */
function normalizePath(spec: unknown): string {
  let path = String(spec);
  if (isAssetPath(path)) {
    const u = parseRelativeUrl(join("/", path)); // 添加前导斜杠
    let {pathname} = u;
    pathname = pathname.replace(/\.html$/i, ""); // 移除尾部 .html
    pathname = pathname.replace(/\/$/, "/index"); // 添加尾部 index
    path = pathname + u.search + u.hash;
  }
  return path;
}

/**
 * 标准化解释器配置
 * 
 * 配置各种文件扩展名对应的解释器命令
 * 
 * @param spec 解释器配置规范
 * @returns 标准化后的解释器映射
 */
function normalizeInterpreters(spec: {[key: string]: unknown} = {}): {[key: string]: string[] | null} {
  return Object.fromEntries(
    Object.entries(spec).map(([key, value]): [string, string[] | null] => {
      return [String(key), normalizeArray(value, String)];
    })
  );
}

/**
 * 标准化目录配置
 * 
 * @param spec 目录配置规范
 * @returns 标准化后的目录配置
 */
function normalizeToc(spec: TableOfContentsSpec | boolean = true): TableOfContents {
  const toc = typeof spec === "boolean" ? {show: spec} : (spec as TableOfContentsSpec);
  const label = toc.label === undefined ? "Contents" : String(toc.label);
  const show = toc.show === undefined ? true : Boolean(toc.show);
  return {label, show};
}

/**
 * 合并目录配置
 * 
 * 将部分目录配置与默认配置合并
 * 
 * @param spec 部分目录配置
 * @param toc 默认目录配置
 * @returns 合并后的目录配置
 */
export function mergeToc(spec: Partial<TableOfContents> = {}, toc: TableOfContents): TableOfContents {
  const {label = toc.label, show = toc.show} = spec;
  return {label, show};
}

/**
 * 合并样式配置
 * 
 * 根据页面级别的样式配置和默认样式配置生成最终的样式配置
 * 
 * @param path 当前页面路径
 * @param style 页面级别的样式配置
 * @param theme 页面级别的主题配置
 * @param defaultStyle 默认样式配置
 * @returns 合并后的样式配置
 */
export function mergeStyle(
  path: string,
  style: string | null | undefined,
  theme: string[] | undefined,
  defaultStyle: null | Style
): null | Style {
  return style === undefined && theme === undefined
    ? defaultStyle
    : style === null
    ? null // 禁用样式
    : style !== undefined
    ? {path: resolvePath(path, style)}
    : theme === undefined
    ? defaultStyle
    : {theme};
}

/**
 * 字符串或 null 转换函数
 * 
 * 将配置值转换为字符串或 null
 * 
 * @param spec 配置值
 * @returns 字符串或 null
 */
export function stringOrNull(spec: unknown): string | null {
  return spec == null || spec === false ? null : String(spec);
}

/**
 * 标准化 DuckDB 配置
 * 
 * 处理 DuckDB 数据库的平台和扩展配置
 * 
 * @param spec DuckDB 配置规范
 * @returns 标准化后的 DuckDB 配置
 */
function normalizeDuckDB(spec: unknown): DuckDBConfig {
  const {mvp = true, eh = true} = spec?.["platforms"] ?? {};
  const extensions: {[name: string]: DuckDBExtensionConfig} = {};
  let extspec: Record<string, unknown> = spec?.["extensions"] ?? {};
  
  // 处理数组格式的扩展配置
  if (Array.isArray(extspec)) extspec = Object.fromEntries(extspec.map((name) => [name, {}]));
  
  // 设置默认扩展
  if (extspec.json === undefined) extspec = {...extspec, json: false};
  if (extspec.parquet === undefined) extspec = {...extspec, parquet: false};
  
  // 处理每个扩展配置
  for (let name in extspec) {
    if (!/^\w+$/.test(name)) throw new Error(`invalid extension: ${name}`);
    const vspec = extspec[name];
    if (vspec == null) continue;
    
    // 解析扩展别名
    name = DUCKDB_CORE_ALIASES[name] ?? name;
    
    // 设置扩展默认配置
    const {
      source = name in DUCKDB_CORE_EXTENSIONS ? "core" : "community",
      install = true,
      load = !DUCKDB_CORE_EXTENSIONS[name]
    } = typeof vspec === "boolean"
      ? {load: vspec}
      : typeof vspec === "string"
      ? {source: vspec}
      : (vspec as DuckDBExtensionConfigSpec);
    
    extensions[name] = {
      source: normalizeDuckDBSource(String(source)),
      install: Boolean(install),
      load: Boolean(load)
    };
  }
  
  return {
    platforms: Object.fromEntries(
      [
        ["mvp", mvp],
        ["eh", eh]
      ].filter(([, enabled]) => enabled)
    ),
    extensions
  };
}

/**
 * 标准化 DuckDB 扩展源配置
 * 
 * @param source 扩展源配置
 * @returns 标准化后的扩展源 URL
 */
function normalizeDuckDBSource(source: string): string {
  if (source === "core") return "https://extensions.duckdb.org/";
  if (source === "community") return "https://community-extensions.duckdb.org/";
  const url = new URL(source);
  if (url.protocol !== "https:") throw new Error(`invalid source: ${source}`);
  return String(url);
}

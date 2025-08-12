/**
 * JavaScript 模块分析和依赖解析
 * 
 * 这个模块是 Observable Framework 包依赖解析机制的核心组件。它负责：
 * 
 * ## 📦 包依赖解析流程概览
 * 
 * 1. **模块解析** (`getModuleInfo`): 
 *    - 解析用户的 JavaScript 模块源码
 *    - 识别所有导入语句：import、export、FileAttachment
 *    - 分类导入类型：本地 vs 全局，静态 vs 动态
 * 
 * 2. **依赖分类**:
 *    - `localStaticImports`: "./utils.js" - 本地文件的静态导入
 *    - `localDynamicImports`: import("./utils.js") - 本地文件的动态导入
 *    - `globalStaticImports`: "npm:d3" - 外部包的静态导入 ⭐ 触发包下载
 *    - `globalDynamicImports`: import("npm:d3") - 外部包的动态导入
 *    - `files`: FileAttachment("data.csv") - 数据文件引用
 * 
 * 3. **触发后续流程**:
 *    - globalStaticImports 会触发 npm.ts 中的包下载流程
 *    - 包下载会解析 package.json，递归下载传递依赖
 *    - 最终构建完整的依赖图谱，支撑整个应用的运行
 * 
 * ## 🔄 与其他模块的协作
 * - `src/npm.ts`: 处理 npm 包的下载和依赖解析
 * - `src/resolvers.ts`: 协调整个依赖解析流程
 * - `src/javascript/imports.ts`: 解析 JavaScript 导入语句
 * - `src/javascript/files.ts`: 解析 FileAttachment 引用
 */

import type {Hash} from "node:crypto";
import {createHash} from "node:crypto";
import {accessSync, constants, readFileSync, statSync} from "node:fs";
import {readFile} from "node:fs/promises";
import {extname, join} from "node:path/posix";
import type {Program} from "acorn";
import type {TransformOptions} from "esbuild";
import {transform, transformSync} from "esbuild";
import {currentDate} from "../config.js";
import {resolveJsrImport} from "../jsr.js";
import {resolveNodeImport} from "../node.js";
import {resolveNpmImport} from "../npm.js";
import {resolvePath} from "../path.js";
import {builtins, resolveBuiltin} from "../resolvers.js";
import type {RouteResult} from "../route.js";
import {route} from "../route.js";
import {findFiles} from "./files.js";
import {findImports, parseImports} from "./imports.js";
import {parseProgram} from "./parse.js";

export type FileInfo = {
  /** The last-modified time of the file; used to invalidate the cache. */
  mtimeMs: number;
  /** The size of the file in bytes. */
  size: number;
  /** The SHA-256 content hash of the file contents. */
  hash: string;
};

export type ModuleInfo = {
  /** The last-modified time of the module; used to invalidate the cache. */
  mtimeMs: number;
  /** The SHA-256 content hash of the module contents. */
  hash: string;
  /** The module’s local static imports (paths relative to the module). */
  localStaticImports: Set<string>;
  /** The module’s local dynamic imports (paths relative to the module). */
  localDynamicImports: Set<string>;
  /** The module’s global static imports (typically npm: protocol imports). */
  globalStaticImports: Set<string>;
  /** The module’s global dynamic imports (typically npm: protocol imports). */
  globalDynamicImports: Set<string>;
  /** The module’s attached file paths (relative to the module). */
  files: Set<string>;
  /** The module’s attached file methods. */
  fileMethods: Set<string>;
};

const fileInfoCache = new Map<string, FileInfo>();
const moduleInfoCache = new Map<string, ModuleInfo>();

/**
 * Resolves the (transitive) content hash for the module at the specified path
 * within the given source root. This involves parsing modules to process
 * transitive imports (both static and dynamic). If the module does not exist or
 * has invalid syntax, returns the hash of empty content; likewise ignores any
 * transitive imports or files that are invalid or do not exist.
 */
export function getModuleHash(root: string, path: string, getHash?: (p: string) => string): string {
  return getModuleHashInternal(root, path, getHash).digest("hex");
}

function getModuleHashInternal(root: string, path: string, getHash = (p: string) => getFileHash(root, p)): Hash {
  const hash = createHash("sha256");
  const paths = new Set([path]);
  for (const path of paths) {
    if (path.endsWith(".js")) {
      const info = getModuleInfo(root, path);
      if (!info) continue; // ignore missing file
      hash.update(info.hash);
      for (const i of info.localStaticImports) {
        paths.add(resolvePath(path, i));
      }
      for (const i of info.localDynamicImports) {
        paths.add(resolvePath(path, i));
      }
      for (const i of info.files) {
        hash.update(getHash(resolvePath(path, i)));
      }
    } else {
      hash.update(getHash(path)); // e.g., import.meta.resolve("foo.json")
    }
  }
  return hash;
}

/**
 * Like getModuleHash, but further takes into consideration the resolved exact
 * versions of any npm imports (and their transitive imports). This is needed
 * during build because we want the hash of the built module to change if the
 * version of an imported npm package changes.
 */
export async function getLocalModuleHash(root: string, path: string, getHash?: (p: string) => string): Promise<string> {
  const hash = getModuleHashInternal(root, path, getHash);
  const info = getModuleInfo(root, path);
  if (info) {
    const globalPaths = new Set<string>();
    for (const i of [...info.globalStaticImports, ...info.globalDynamicImports]) {
      if (builtins.has(i) || i.startsWith("observablehq:")) {
        hash.update(`${resolveBuiltin(i)}?version=${process.env.npm_package_version}`); // change hash when Framework changes
      } else if (i.startsWith("npm:")) {
        globalPaths.add(await resolveNpmImport(root, i.slice("npm:".length)));
      } else if (i.startsWith("jsr:")) {
        globalPaths.add(await resolveJsrImport(root, i.slice("jsr:".length)));
      } else if (!/^\w+:/.test(i)) {
        globalPaths.add(await resolveNodeImport(root, i));
      }
    }
    for (const p of globalPaths) {
      hash.update(p);
      for (const i of await parseImports(join(root, ".observablehq", "cache"), p)) {
        if (i.type === "local") {
          globalPaths.add(resolvePath(p, i.name));
        }
      }
    }
  }
  return hash.digest("hex");
}

/**
 * 获取模块信息 - 包依赖解析的起始点
 * 
 * 这是 Observable Framework 包依赖解析机制的入口函数。当用户的 JavaScript 模块
 * 包含 `import d3 from "npm:d3"` 这样的导入时，这个函数会：
 * 
 * 1. **解析模块源码**: 读取并解析 JavaScript 文件
 * 2. **提取导入语句**: 找出所有的 import、export 和 FileAttachment 引用
 * 3. **分类导入类型**: 区分本地导入和全局导入、静态导入和动态导入
 * 4. **缓存解析结果**: 基于文件修改时间的智能缓存
 * 
 * 这个函数的输出会触发后续的包下载和依赖解析流程。
 * 
 * @param root 项目根目录
 * @param path 模块文件路径
 * @returns 模块信息对象，包含所有导入和文件引用的分类结果
 */
export function getModuleInfo(root: string, path: string): ModuleInfo | undefined {
  // 🔍 查找模块文件，支持参数化路径
  const module = findModule(root, path);
  if (!module) return; // TODO delete stale entry?
  
  // 构建完整的文件路径
  const key = join(root, module.path);
  
  // 📅 获取文件修改时间，用于缓存失效判断
  let mtimeMs: number;
  try {
    mtimeMs = Math.floor(statSync(key).mtimeMs);
  } catch {
    moduleInfoCache.delete(key); // delete stale entry
    return; // ignore missing file
  }
  
  // 💾 检查缓存：如果文件未修改，直接返回缓存结果
  let info = moduleInfoCache.get(key);
  if (!info || info.mtimeMs < mtimeMs) {
    // 📄 文件已修改或首次解析，重新分析模块
    let source: string;
    let body: Program;
    try {
      source = readJavaScriptSync(key);
      body = parseProgram(source, module.params);
    } catch {
      moduleInfoCache.delete(key); // delete stale entry
      return; // ignore parse error
    }
    
    // 🔐 计算文件内容哈希，用于构建系统的缓存失效
    const hash = createHash("sha256").update(source).digest("hex");
    
    // 🔍 关键步骤：解析模块的导入和文件引用
    const imports = findImports(body, path, source);  // 找出所有导入语句
    const files = findFiles(body, path, source);      // 找出所有 FileAttachment 引用
    // 📊 创建分类集合：将导入按类型和方法分类
    const localStaticImports = new Set<string>();    // 本地静态导入：如 "./utils.js"
    const localDynamicImports = new Set<string>();   // 本地动态导入：如 import("./utils.js")
    const globalStaticImports = new Set<string>();   // 全局静态导入：如 "npm:d3"
    const globalDynamicImports = new Set<string>();  // 全局动态导入：如 import("npm:d3")
    
    // 🔄 遍历所有导入，按类型分类
    // 这是包依赖解析机制的关键分类步骤
    for (const i of imports) {
      (i.type === "local"           // 本地导入（相对路径）
        ? i.method === "static"     // 静态导入
          ? localStaticImports      // → 本地静态导入集合
          : localDynamicImports     // → 本地动态导入集合
        : i.method === "static"     // 全局导入的静态方式
        ? globalStaticImports       // → 全局静态导入集合（触发包下载）
        : globalDynamicImports      // → 全局动态导入集合
      ).add(i.name);
    }
    moduleInfoCache.set(
      key,
      (info = {
        mtimeMs,
        hash,
        files: new Set(files.map((f) => f.name)),
        fileMethods: new Set(files.map((f) => f.method).filter((m): m is string => m !== undefined)),
        localStaticImports,
        localDynamicImports,
        globalStaticImports,
        globalDynamicImports
      })
    );
  }
  return info;
}

/**
 * Returns the content hash for the specified file within the source root. If
 * the specified file does not exist, returns the hash of empty content. If the
 * referenced file does not exist, we check for the corresponding data loader
 * and return its hash instead.
 */
export function getFileHash(root: string, path: string): string {
  return getFileInfo(root, path)?.hash ?? createHash("sha256").digest("hex");
}

/**
 * Returns the information for the file at the specified path within the source
 * root, or undefined if the file does not exist.
 */
export function getFileInfo(root: string, path: string): FileInfo | undefined {
  const key = join(root, path);
  let mtimeMs: number;
  let size: number;
  try {
    const stat = statSync(key);
    if (!stat.isFile()) return; // ignore non-files
    accessSync(key, constants.R_OK); // verify that file is readable
    mtimeMs = Math.floor((currentDate ?? stat.mtimeMs) as number);
    size = stat.size;
  } catch {
    fileInfoCache.delete(key); // delete stale entry
    return; // ignore missing, non-readable file
  }
  let entry = fileInfoCache.get(key);
  if (!entry || entry.mtimeMs < mtimeMs) {
    const contents = readFileSync(key);
    const hash = createHash("sha256").update(contents).digest("hex");
    fileInfoCache.set(key, (entry = {mtimeMs, size, hash}));
  }
  return entry;
}

// For testing only!
export function clearFileInfo(root: string, path: string): boolean {
  return fileInfoCache.delete(join(root, path));
}

export function findModule(root: string, path: string): RouteResult | undefined {
  const ext = extname(path);
  if (!ext) throw new Error(`empty extension: ${path}`);
  const exts = [ext];
  if (ext === ".js") exts.push(".ts", ".jsx", ".tsx");
  return route(root, path.slice(0, -ext.length), exts);
}

export async function readJavaScript(sourcePath: string): Promise<string> {
  const source = await readFile(sourcePath, "utf-8");
  switch (extname(sourcePath)) {
    case ".ts":
      return transformJavaScript(source, "ts", sourcePath);
    case ".jsx":
      return transformJavaScript(source, "jsx", sourcePath);
    case ".tsx":
      return transformJavaScript(source, "tsx", sourcePath);
  }
  return source;
}

export function readJavaScriptSync(sourcePath: string): string {
  const source = readFileSync(sourcePath, "utf-8");
  switch (extname(sourcePath)) {
    case ".ts":
      return transformJavaScriptSync(source, "ts", sourcePath);
    case ".jsx":
      return transformJavaScriptSync(source, "jsx", sourcePath);
    case ".tsx":
      return transformJavaScriptSync(source, "tsx", sourcePath);
  }
  return source;
}

export async function transformJavaScript(
  source: string,
  loader: "ts" | "jsx" | "tsx",
  sourcePath?: string
): Promise<string> {
  return (await transform(source, getTransformOptions(loader, sourcePath))).code;
}

export function transformJavaScriptSync(source: string, loader: "ts" | "jsx" | "tsx", sourcePath?: string): string {
  return transformSync(source, getTransformOptions(loader, sourcePath)).code;
}

function getTransformOptions(loader: "ts" | "jsx" | "tsx", sourcePath?: string): TransformOptions {
  switch (loader) {
    case "ts":
      return {
        loader,
        sourcefile: sourcePath,
        tsconfigRaw: '{"compilerOptions": {"verbatimModuleSyntax": true}}'
      };
    case "jsx":
      return {
        loader,
        jsx: "automatic",
        jsxImportSource: "npm:react",
        sourcefile: sourcePath
      };
    case "tsx":
      return {
        loader,
        jsx: "automatic",
        jsxImportSource: "npm:react",
        sourcefile: sourcePath,
        tsconfigRaw: '{"compilerOptions": {"verbatimModuleSyntax": true}}'
      };
    default:
      throw new Error(`unknown loader: ${loader}`);
  }
}

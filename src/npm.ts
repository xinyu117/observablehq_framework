import {existsSync} from "node:fs";
import {mkdir, readFile, readdir, writeFile} from "node:fs/promises";
import {dirname, extname, join} from "node:path/posix";
import type {CallExpression} from "acorn";
import {simple} from "acorn-walk";
import {maxSatisfying, rsort, satisfies, validRange} from "semver";
import {DUCKDB_WASM_VERSION} from "./duckdb.js";
import {isEnoent} from "./error.js";
import {annotatePath} from "./javascript/annotate.js";
import type {ExportNode, ImportNode, ImportReference} from "./javascript/imports.js";
import {isImportMetaResolve, parseImports} from "./javascript/imports.js";
import {parseProgram} from "./javascript/parse.js";
import type {StringLiteral} from "./javascript/source.js";
import {getStringLiteralValue, isStringLiteral} from "./javascript/source.js";
import {relativePath} from "./path.js";
import {Sourcemap} from "./sourcemap.js";
import {faint, yellow} from "./tty.js";

export interface NpmSpecifier {
  name: string;
  range?: string;
  path?: string;
}

export function parseNpmSpecifier(specifier: string): NpmSpecifier {
  const parts = specifier.split("/");
  const namerange = specifier.startsWith("@") ? [parts.shift()!, parts.shift()!].join("/") : parts.shift()!;
  const ranged = namerange.indexOf("@", 1);
  return {
    name: ranged > 0 ? namerange.slice(0, ranged) : namerange,
    range: ranged > 0 ? namerange.slice(ranged + 1) : undefined,
    path: parts.length > 0 ? parts.join("/") : undefined
  };
}

export function formatNpmSpecifier({name, range, path}: NpmSpecifier): string {
  return `${name}${range ? `@${range}` : ""}${path ? `/${path}` : ""}`;
}

/** Rewrites /npm/ import specifiers to be relative paths to /_npm/. */
export function rewriteNpmImports(input: string, resolve: (s: string) => string | void = () => undefined): string {
  const body = parseProgram(input);
  const output = new Sourcemap(input);

  simple(body, {
    ImportDeclaration: rewriteImport,
    ImportExpression: rewriteImport,
    ExportAllDeclaration: rewriteImport,
    ExportNamedDeclaration: rewriteImport,
    CallExpression: rewriteImportMetaResolve
  });

  function rewriteImport(node: ImportNode | ExportNode) {
    if (node.source && isStringLiteral(node.source)) {
      rewriteImportSource(node.source);
    }
  }

  function rewriteImportMetaResolve(node: CallExpression) {
    if (isImportMetaResolve(node) && isStringLiteral(node.arguments[0])) {
      rewriteImportSource(node.arguments[0]);
    }
  }

  function rewriteImportSource(source: StringLiteral) {
    const value = getStringLiteralValue(source);
    const resolved = resolve(value);
    if (resolved === undefined || value === resolved) return;
    output.replaceLeft(source.start, source.end, annotatePath(resolved));
  }

  // TODO Preserve the source map, but download it too.
  return String(output).replace(/^\/\/# sourceMappingURL=.*$\n?/m, "");
}

const npmRequests = new Map<string, Promise<string>>();

/** Note: path must start with "/_npm/". */
/**
 * 填充 NPM 缓存 - 包依赖解析的核心函数
 * 
 * 这是 Observable Framework 包依赖解析机制的核心函数。当用户在 JS 模块中使用
 * `import d3 from "npm:d3"` 这样的导入时，这个函数负责：
 * 
 * 1. **下载包文件**: 从 jsDelivr CDN 下载指定的 npm 包
 * 2. **缓存管理**: 将包缓存到 .observablehq/cache/_npm/ 目录
 * 3. **依赖解析**: 解析包的内部导入，构建依赖图谱
 * 4. **路径重写**: 重写包内的导入路径为相对路径
 * 
 * @param root 项目根目录
 * @param path npm 包路径，如 "/_npm/d3@7.8.5/+esm.js"
 * @returns 缓存文件的本地路径
 * 
 * 工作流程：
 * 1. 检查本地缓存，如果存在则直接返回
 * 2. 从 jsDelivr CDN 下载包文件
 * 3. 解析包的源码，找出内部依赖
 * 4. 递归下载和解析传递性依赖
 * 5. 重写导入路径并缓存到本地
 */
export async function populateNpmCache(root: string, path: string): Promise<string> {
  // 验证路径格式，确保是有效的 npm 包路径
  if (!path.startsWith("/_npm/")) throw new Error(`invalid npm path: ${path}`);
  
  // 构建本地缓存路径：.observablehq/cache/_npm/package@version/file.js
  const outputPath = join(root, ".observablehq", "cache", path);
  
  // 如果已经缓存，直接返回（避免重复下载）
  if (existsSync(outputPath)) return outputPath;
  
  // 合并并发请求，避免同时下载同一个包
  let promise = npmRequests.get(outputPath);
  if (promise) return promise; // coalesce concurrent requests
  
  promise = (async () => {
    // 解析 npm 包说明符（如 "d3@7.8.5/+esm"）
    let specifier = extractNpmSpecifier(path);
    const s = parseNpmSpecifier(specifier);
    
    // 特殊处理：sql.js 包的路径修正
    // https://github.com/sql-js/sql.js/issues/284
    if (s.name === "sql.js" && s.path === "+esm") {
      specifier = formatNpmSpecifier({...s, path: "dist/sql-wasm.js"});
    }
    
    // 构建 jsDelivr CDN 下载链接
    const href = `https://cdn.jsdelivr.net/npm/${specifier}`;
    console.log(`npm:${specifier} ${faint("→")} ${outputPath}`);
    
    // 从 CDN 下载包文件
    const response = await fetch(href);
    if (!response.ok) throw new Error(`unable to fetch: ${href}`);
    
    // 创建缓存目录
    await mkdir(dirname(outputPath), {recursive: true});
    
    // 根据文件类型进行不同处理
    if (/^application\/javascript(;|$)/i.test(response.headers.get("content-type")!)) {
      // JavaScript 文件：需要解析依赖并重写导入路径
      let source = await response.text();
      
      // sql.js 特殊处理：添加模块导出
      if (s.name === "sql.js" && s.path === "+esm") {
        source = "var module;\n" + source + "\nexport default initSqlJs;";
      }
      
      // 🔍 关键步骤：获取依赖解析器，这会解析 package.json 和传递依赖
      const resolver = await getDependencyResolver(root, path, source);
      
      // 重写源码中的导入路径，并写入缓存
      await writeFile(outputPath, rewriteNpmImports(source, resolver), "utf-8");
    } else {
      // 非 JavaScript 文件：直接写入二进制数据
      await writeFile(outputPath, Buffer.from(await response.arrayBuffer()));
    }
    
    return outputPath;
  })();
  
  // 清理请求缓存，处理错误情况
  promise.catch(console.error).then(() => npmRequests.delete(outputPath));
  npmRequests.set(outputPath, promise);
  return promise;
}

/**
 * 获取依赖解析器 - package.json 解析的核心函数
 * 
 * 这是 Observable Framework 包依赖解析机制中最关键的函数之一。它负责：
 * 
 * 1. **解析包源码**: 分析下载的 npm 包源码，找出所有内部导入
 * 2. **下载 package.json**: 获取包的依赖声明文件
 * 3. **解析依赖关系**: 从 package.json 中提取 dependencies、devDependencies、peerDependencies
 * 4. **版本解析**: 根据 semver 范围解析具体的依赖版本
 * 5. **递归下载**: 下载所有传递性依赖
 * 6. **路径重写**: 将 /npm/ 路径重写为相对路径
 * 
 * jsDelivr CDN 会"烘焙"第一次构建时的确切版本，当依赖的新版本发布时不会更新。
 * 我们总是希望导入最新版本，以确保不会在不同版本之间加载传递依赖的重复副本。
 * 
 * 示例流程（以 d3 包为例）：
 * 1. 解析 d3 源码，发现导入 "/npm/d3-array@3", "/npm/d3-scale@4" 等
 * 2. 下载 d3 的 package.json，获取依赖版本：{"d3-array": "3", "d3-scale": "4"}
 * 3. 递归下载 d3-array@3.2.4, d3-scale@4.0.2 等具体版本
 * 4. 重写路径："/npm/d3-array@3" → "../../d3-array@3.2.4/+esm.js"
 */
export async function getDependencyResolver(
  root: string,
  path: string,
  input: string
): Promise<(specifier: string) => string> {
  // 解析包源码的 AST，用于查找导入语句
  const body = parseProgram(input);
  const dependencies = new Set<string>();
  const {name, range} = parseNpmSpecifier(extractNpmSpecifier(path));

  // 遍历 AST，查找所有类型的导入语句
  simple(body, {
    ImportDeclaration: findImport,        // import ... from "..."
    ImportExpression: findImport,         // import("...")
    ExportAllDeclaration: findImport,     // export * from "..."
    ExportNamedDeclaration: findImport,   // export { ... } from "..."
    CallExpression: findImportMetaResolve // import.meta.resolve("...")
  });

  function findImport(node: ImportNode | ExportNode) {
    if (node.source && isStringLiteral(node.source)) {
      findImportSource(node.source);
    }
  }

  function findImportMetaResolve(node: CallExpression) {
    if (isImportMetaResolve(node) && isStringLiteral(node.arguments[0])) {
      findImportSource(node.arguments[0]);
    }
  }

  /**
   * 分析导入源，收集需要解析的依赖
   * 只处理 /npm/ 开头的导入（jsDelivr 内部导入格式）//suchao:内部依赖（如 @popperjs/core）会被重写成 /npm/@popperjs/core@2.x/+esm 这样的 URL，无需再手动处理路径。
   */
  function findImportSource(source: StringLiteral) {
    const value = getStringLiteralValue(source);
    if (value.startsWith("/npm/")) {
      const {name: depName, range: depRange} = parseNpmSpecifier(value.slice("/npm/".length));
      if (depName === name) return; // 忽略自引用，如 mermaid 插件
      if (depRange && existsSync(join(root, ".observablehq", "cache", "_npm", `${depName}@${depRange}`))) return; // 已经解析过
      dependencies.add(value);
    }
  }

  const resolutions = new Map<string, string>();

  // 🔍 关键步骤：如果有依赖需要解析，下载并解析 package.json
  if (dependencies.size > 0) {
    // 📄 下载当前包的 package.json 文件
    const pkgPath = await populateNpmCache(root, `/_npm/${name}@${range}/package.json`);
    const pkg = JSON.parse(await readFile(pkgPath, "utf-8"));
    
    // 🔄 遍历每个依赖，从 package.json 中获取版本范围
    for (const dependency of dependencies) {
      const {name: depName, path: depPath = "+esm"} = parseNpmSpecifier(dependency.slice("/npm/".length));
      
      // 📋 从 package.json 的不同字段中查找依赖版本
      const range =
        // 特殊版本强制策略：某些包需要使用特定版本以避免冲突
        (name === "arquero" || name === "@uwdata/mosaic-core" || name === "@duckdb/duckdb-wasm") && depName === "apache-arrow"
          ? "latest" // 强制 Arquero、Mosaic 和 DuckDB-Wasm 使用相同的最新 Arrow 版本
          : name === "@uwdata/mosaic-core" && depName === "@duckdb/duckdb-wasm"
          ? DUCKDB_WASM_VERSION // 强制 Mosaic 使用最新稳定版 DuckDB-Wasm
          // 标准依赖解析：按优先级查找版本范围
          : pkg.dependencies?.[depName] ??           // 生产依赖
            pkg.devDependencies?.[depName] ??        // 开发依赖  
            pkg.peerDependencies?.[depName] ??       // 对等依赖
            void console.warn(yellow(`${depName} is an undeclared dependency of ${name}; resolving latest version`));
      
      // 🔄 递归解析依赖：这会触发新的下载和依赖解析循环
      resolutions.set(dependency, await resolveNpmImport(root, `${depName}${range ? `@${range}` : ""}/${depPath}`));
    }
  }

  // 返回路径解析函数：将 /npm/ 路径转换为相对路径
  return (specifier: string) => {
    if (!specifier.startsWith("/npm/")) return specifier;
    if (resolutions.has(specifier)) specifier = resolutions.get(specifier)!;
    else specifier = fromJsDelivrPath(specifier);
    return relativePath(path, specifier);
  };
}

export async function initializeNpmVersionCache(root: string, dir = "_npm"): Promise<Map<string, string[]>> {
  const cache = new Map<string, string[]>();
  const cacheDir = join(root, ".observablehq", "cache", dir);
  try {
    for (const entry of await readdir(cacheDir)) {
      if (entry.startsWith("@")) {
        for (const subentry of await readdir(join(cacheDir, entry))) {
          const {name, range} = parseNpmSpecifier(`${entry}/${subentry}`);
          const versions = cache.get(name);
          if (versions) versions.push(range!);
          else cache.set(name, [range!]);
        }
      } else {
        const {name, range} = parseNpmSpecifier(entry);
        const versions = cache.get(name);
        if (versions) versions.push(range!);
        else cache.set(name, [range!]);
      }
    }
  } catch (error) {
    if (!isEnoent(error)) throw error;
  }
  for (const [key, value] of cache) {
    cache.set(key, rsort(value));
  }
  return cache;
}

const npmVersionCaches = new Map<string, Promise<Map<string, string[]>>>();
const npmVersionRequests = new Map<string, Promise<string>>();

function getNpmVersionCache(root: string): Promise<Map<string, string[]>> {
  let cache = npmVersionCaches.get(root);
  if (!cache) npmVersionCaches.set(root, (cache = initializeNpmVersionCache(root, "_npm")));
  return cache;
}

/**
 * 解析 NPM 包版本 - 包依赖解析的版本确定阶段
 * 
 * 这个函数是包依赖解析机制中负责版本解析的核心部分。它的工作流程：
 * 
 * 1. **版本缓存检查**: 首先检查本地缓存，避免重复的网络请求
 * 2. **npm registry 查询**: 查询 npm 官方注册表获取包的版本信息
 * 3. **semver 版本匹配**: 根据版本范围（如 "^1.0.0"）找到最佳匹配版本
 * 4. **版本缓存更新**: 将解析结果缓存到本地，提高后续解析速度
 * 
 * @param root 项目根目录
 * @param param1 包说明符，包含包名和版本范围
 * @returns 解析出的具体版本号
 * 
 * 示例流程：
 * 输入: {name: "d3", range: "^7.0.0"}
 * 1. 查询: https://registry.npmjs.org/d3
 * 2. 获取所有版本: ["7.0.0", "7.1.0", "7.8.5", ...]
 * 3. 匹配最佳版本: "7.8.5"（满足 ^7.0.0 的最新版本）
 * 4. 返回: "7.8.5"
 */
async function resolveNpmVersion(root: string, {name, range}: NpmSpecifier): Promise<string> {
  // 如果已经是精确版本（如 "1.2.3"），直接返回
  if (range && /^\d+\.\d+\.\d+([-+].*)?$/.test(range)) return range; // exact version specified
  
  // 检查本地版本缓存，避免重复的网络请求
  const cache = await getNpmVersionCache(root);
  const versions = cache.get(name);
  if (versions) for (const version of versions) if (!range || satisfies(version, range)) return version;
  
  // 如果没有指定范围，默认使用 "latest"
  if (range === undefined) range = "latest";
  
  // 区分版本范围和 dist-tag（如 "latest", "beta"）
  const disttag = validRange(range) ? null : range;
  const href = `https://registry.npmjs.org/${name}${disttag ? `/${disttag}` : ""}`;
  
  // 合并并发请求，避免同时查询同一个包
  let promise = npmVersionRequests.get(href);
  if (promise) return promise; // coalesce concurrent requests
  
  promise = (async function () {
    const input = formatNpmSpecifier({name, range});
    process.stdout.write(`npm:${input} ${faint("→")} `);
    
    // 🌐 查询 npm registry，获取包的版本信息
    const response = await fetch(href, {...(!disttag && {headers: {Accept: "application/vnd.npm.install-v1+json"}})});
    if (!response.ok) throw new Error(`unable to fetch: ${href}`);
    const body = await response.json();
    
    // 📋 解析版本：dist-tag 直接使用，版本范围需要匹配
    const version = disttag ? body.version : maxSatisfying(Object.keys(body.versions), range);
    if (!version) throw new Error(`unable to resolve version: ${input}`);
    
    const output = formatNpmSpecifier({name, range: version});
    process.stdout.write(`npm:${output}\n`);
    
    // 💾 更新版本缓存，并创建磁盘缓存目录
    cache.set(name, versions ? rsort(versions.concat(version)) : [version]);
    mkdir(join(root, ".observablehq", "cache", "_npm", output), {recursive: true}); // disk cache
    return version;
  })();
  
  // 清理请求缓存，处理错误情况
  promise.catch(console.error).then(() => npmVersionRequests.delete(href));
  npmVersionRequests.set(href, promise);
  return promise;
}

/**
 * 解析 NPM 导入 - 包依赖解析的核心协调函数
 * 
 * 这是 Observable Framework 包依赖解析机制的核心协调函数。它负责将用户的
 * npm 导入说明符（如 "d3@^7.0.0" 或 "lodash/debounce"）转换为具体的缓存路径。
 * 
 * 主要功能：
 * 1. **解析包说明符**: 分解包名、版本范围、子路径
 * 2. **版本解析**: 调用 resolveNpmVersion 确定具体版本
 * 3. **路径标准化**: 处理各种路径格式，生成统一的缓存路径
 * 4. **特殊包处理**: 为某些包提供自定义的入口点
 * 
 * 这个函数是传递依赖下载的关键触发点 - 每次调用都可能启动新的包下载流程。
 * 
 * @param root 项目根目录
 * @param specifier npm 包说明符，如 "d3@^7.0.0", "lodash/debounce", "react-dom/client"
 * @returns 解析后的缓存路径，如 "/_npm/d3@7.8.5/_esm.js"
 * 
 * 示例转换：
 * - "d3" → "/_npm/d3@7.8.5/_esm.js"
 * - "lodash/debounce" → "/_npm/lodash@4.17.21/debounce._esm.js"
 * - "react-dom/client" → "/_npm/react-dom@18.2.0/client"
 * - "mermaid" → "/_npm/mermaid@10.6.1/dist/mermaid.esm.min.mjs/_esm.js"
 */
export async function resolveNpmImport(root: string, specifier: string): Promise<string> {
  // 🔍 解析 npm 包说明符，提取包名、版本范围、子路径
  const {
    name,
    // 🎯 特殊版本处理：某些包需要固定版本以确保兼容性
    range = name === "@duckdb/duckdb-wasm" ? DUCKDB_WASM_VERSION : undefined,
    // 🛠️ 特殊路径处理：某些包需要自定义入口点以确保正确加载
    path = name === "mermaid"
      ? "dist/mermaid.esm.min.mjs/+esm"      // Mermaid 使用压缩的 ESM 版本
      : name === "echarts"
      ? "dist/echarts.esm.min.js/+esm"       // ECharts 使用压缩的 ESM 版本
      : name === "jquery-ui"
      ? "dist/jquery-ui.js/+esm"             // jQuery UI 使用 dist 版本
      : name === "deck.gl"
      ? "dist.min.js/+esm"                   // Deck.gl 使用压缩版本
      : name === "react-dom"
      ? "client"                             // React DOM 使用客户端版本
      : "+esm"                               // 默认使用 ESM 版本
  } = parseNpmSpecifier(specifier);
  
  // 🔄 版本解析：这是传递依赖解析的关键步骤
  // 如果这个版本还没有被解析过，会触发 npm registry 查询和包下载
  const version = await resolveNpmVersion(root, {name, range});
  
  // 🏗️ 构建标准化的缓存路径
  // 所有 npm 包都缓存在 /_npm/${name}@${version}/ 目录下
  return `/_npm/${name}@${version}/${
    // 📁 路径处理逻辑：根据不同情况生成正确的文件路径
    extname(path) ||     // 如果已有扩展名：npm:foo/bar.js → bar.js
    path === "" ||       // 如果是空路径：npm:foo/ → ""  
    path.endsWith("/")   // 如果以 / 结尾：npm:foo/bar/ → bar/
      ? path             // 直接使用原路径
      : path === "+esm"  // 如果是 ESM 标记：npm:foo/+esm → _esm.js
      ? "_esm.js"        
      : path.replace(/(?:\/\+esm)?$/, "._esm.js") // 其他情况：npm:foo/bar → bar._esm.js
  }`;
}

/**
 * 解析 NPM 包的直接依赖 - 传递依赖发现的核心函数
 * 
 * 这个函数是传递依赖解析流程中的关键环节。它负责分析已下载的 npm 包，
 * 找出该包直接依赖的其他包，为后续的递归依赖解析提供输入。
 * 
 * 工作流程：
 * 1. **确保包已下载**: 调用 populateNpmCache 确保目标包已经被下载到本地缓存
 * 2. **解析包源码**: 分析包的 JavaScript 源码，找出所有导入语句
 * 3. **返回依赖列表**: 返回该包直接依赖的所有包的引用信息
 * 
 * 这个函数的输出会被 resolvers.ts 中的传递依赖处理逻辑使用，
 * 触发对每个依赖的递归 resolveNpmImport 调用。
 * 
 * @param root 项目根目录
 * @param path npm 包的缓存路径，如 "/_npm/d3@7.8.5/_esm.js"
 * @returns 该包的直接依赖列表，每个依赖包含名称、类型、方法等信息
 * 
 * 示例：
 * 输入: "/_npm/d3@7.8.5/_esm.js"
 * 输出: [
 *   {name: "d3-array", type: "global", method: "static"},
 *   {name: "d3-scale", type: "global", method: "static"},
 *   {name: "d3-selection", type: "global", method: "static"},
 *   // ... 更多 d3 的子模块依赖
 * ]
 * 
 * 这些依赖会触发后续的递归下载：
 * - resolveNpmImport(root, "d3-array@3.2.4")
 * - resolveNpmImport(root, "d3-scale@4.0.2")  
 * - resolveNpmImport(root, "d3-selection@3.0.0")
 */
export async function resolveNpmImports(root: string, path: string): Promise<ImportReference[]> {
  // 验证路径格式
  if (!path.startsWith("/_npm/")) throw new Error(`invalid npm path: ${path}`);
  
  // 🔄 确保目标包已下载：这会触发包的下载、依赖解析、路径重写等完整流程
  await populateNpmCache(root, path);
  
  // 🔍 解析包的源码，提取所有导入引用
  // 这会分析包的实际 JavaScript 代码，找出它使用的所有依赖
  return parseImports(join(root, ".observablehq", "cache"), path);
}

/**
 * Given a local npm path such as "/_npm/d3@7.8.5/_esm.js", returns the
 * corresponding npm specifier such as "d3@7.8.5/+esm". For example:
 *
 * /_npm/mime@4.0.1/_esm.js         → mime@4.0.1/+esm
 * /_npm/mime@4.0.1/lite._esm.js    → mime@4.0.1/lite/+esm
 * /_npm/mime@4.0.1/lite.js._esm.js → mime@4.0.1/lite.js/+esm
 */
export function extractNpmSpecifier(path: string): string {
  if (!path.startsWith("/_npm/")) throw new Error(`invalid npm path: ${path}`);
  const parts = path.split("/"); // ["", "_npm", "mime@4.0.1", "lite.js._esm.js"]
  const i = parts[2].startsWith("@") ? 4 : 3; // test for scoped package
  const namever = parts.slice(2, i).join("/"); // "mime@4.0.1" or "@observablehq/inputs@0.10.6"
  const subpath = parts.slice(i).join("/"); // "_esm.js" or "lite._esm.js" or "lite.js._esm.js"
  return `${namever}/${subpath === "_esm.js" ? "+esm" : subpath.replace(/\._esm\.js$/, "/+esm")}`;
}

/**
 * Given a jsDelivr path such as "/npm/d3@7.8.5/+esm", returns the corresponding
 * local path such as "/_npm/d3@7.8.5/_esm.js". For example:
 *
 * /npm/mime@4.0.1/+esm         → /_npm/mime@4.0.1/_esm.js
 * /npm/mime@4.0.1/lite/+esm    → /_npm/mime@4.0.1/lite._esm.js
 * /npm/mime@4.0.1/lite.js/+esm → /_npm/mime@4.0.1/lite.js._esm.js
 */
export function fromJsDelivrPath(path: string): string {
  if (!path.startsWith("/npm/")) throw new Error(`invalid jsDelivr path: ${path}`);
  const parts = path.split("/"); // e.g. ["", "npm", "mime@4.0.1", "lite", "+esm"]
  const i = parts[2].startsWith("@") ? 4 : 3; // test for scoped package
  const namever = parts.slice(2, i).join("/"); // "mime@4.0.1" or "@observablehq/inputs@0.10.6"
  const subpath = parts.slice(i).join("/"); // "+esm" or "lite/+esm" or "lite.js/+esm"
  return `/_npm/${namever}/${subpath === "+esm" ? "_esm.js" : subpath.replace(/\/\+esm$/, "._esm.js")}`;
}

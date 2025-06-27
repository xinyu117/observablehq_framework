/**
 * Observable Framework 构建系统核心模块
 * 
 * 这个模块负责：
 * 1. 将 Markdown 页面转换为 HTML
 * 2. 处理 JavaScript 模块的转译和打包
 * 3. 复制和优化静态资源文件
 * 4. 生成内容哈希用于缓存破坏
 * 5. 创建完整的静态网站输出
 */

import {createHash} from "node:crypto";
import {existsSync} from "node:fs";
import {copyFile, readFile, rm, stat, writeFile} from "node:fs/promises";
import {basename, dirname, extname, join} from "node:path/posix";
import type {Config} from "./config.js";
import {getDuckDBManifest} from "./duckdb.js";
import {CliError, enoent} from "./error.js";
import {getClientPath, prepareOutput} from "./files.js";
import {findModule, getModuleHash, readJavaScript} from "./javascript/module.js";
import {transpileModule} from "./javascript/transpile.js";
import type {Logger, Writer} from "./logger.js";
import type {MarkdownPage} from "./markdown.js";
import {populateNpmCache, resolveNpmImport, rewriteNpmImports} from "./npm.js";
import {isAssetPath, isPathImport, relativePath, resolvePath, within} from "./path.js";
import {renderModule, renderPage} from "./render.js";
import type {Resolvers} from "./resolvers.js";
import {getModuleResolvers, getResolvers} from "./resolvers.js";
import {resolveStylesheetPath} from "./resolvers.js";
import {bundleStyles, rollupClient} from "./rollup.js";
import {searchIndex} from "./search.js";
import {Telemetry} from "./telemetry.js";
import {tree} from "./tree.js";
import {faint, green, magenta, red, yellow} from "./tty.js";

/**
 * 构建配置选项
 */
export interface BuildOptions {
  /** Observable Framework 配置对象 */
  config: Config;
}

/**
 * 构建效果器接口
 * 
 * 定义了构建过程中需要执行的各种副作用操作，如文件写入、复制等。
 * 这种设计允许在不同环境中使用不同的实现（如本地构建 vs 云构建）。
 */
export interface BuildEffects {
  /** 日志记录器，用于输出构建信息 */
  logger: Logger;
  /** 输出流，用于显示构建进度 */
  output: Writer;

  /**
   * 执行构建前的准备工作
   * 例如清空现有的输出目录
   */
  prepare(): Promise<void>;

  /**
   * 复制文件到输出目录
   * @param sourcePath 源文件的绝对路径
   * @param outputPath 相对于输出根目录的目标路径
   */
  copyFile(sourcePath: string, outputPath: string): Promise<void>;

  /**
   * 将内容写入到输出目录的文件中
   * @param outputPath 相对于输出根目录的文件路径
   * @param contents 要写入的内容（字符串或二进制数据）
   */
  writeFile(outputPath: string, contents: Buffer | string): Promise<void>;

  /**
   * 写入构建清单文件
   * @param buildManifest 包含构建结果信息的清单对象
   */
  writeBuildManifest(buildManifest: BuildManifest): Promise<void>;
}

/**
 * Observable Framework 主构建函数
 * 
 * 执行完整的网站构建流程，包括：
 * 1. 扫描和加载所有页面和模块
 * 2. 解析依赖关系（文件、导入、样式表）
 * 3. 生成客户端 JavaScript 包
 * 4. 复制和哈希化静态资源
 * 5. 渲染页面为 HTML
 * 6. 生成构建清单
 * 
 * @param options 包含 Observable Framework 配置的构建选项
 * @param effects 构建效果器，处理文件操作和日志记录
 * 
 * @example
 * ```typescript
 * import {build} from "./build.js";
 * import {readConfig} from "./config.js";
 * 
 * const config = await readConfig();
 * await build({config});
 * ```
 */
export async function build(
  {config}: BuildOptions,
  effects: BuildEffects = new FileBuildEffects(config.output, join(config.root, ".observablehq", "cache"))
): Promise<void> {
  const {root, loaders, title, duckdb} = config;
  Telemetry.record({event: "build", step: "start"});

  // 准备构建环境（如清空输出目录）
  await effects.prepare();

  // 初始化数据结构用于跟踪构建输出和依赖关系
  const outputs = new Map<string, ({type: "page"; page: MarkdownPage} | {type: "module"}) & {resolvers: Resolvers}>();
  const files = new Set<string>(); // 静态文件，如 "/assets/foo.png"
  const localImports = new Set<string>(); // 本地模块导入，如 "/components/foo.js"
  const globalImports = new Set<string>(); // 全局导入，如 "/_observablehq/search.js"
  const stylesheets = new Set<string>(); // 样式表，如 "/style.css"
  
  // 辅助函数：将依赖项添加到相应的集合中
  const addFile = (path: string, f: string) => files.add(resolvePath(path, f));
  const addLocalImport = (path: string, i: string) => localImports.add(resolvePath(path, i));
  const addGlobalImport = (path: string, i: string) => isPathImport(i) && globalImports.add(resolvePath(path, i));
  const addStylesheet = (path: string, s: string) => stylesheets.add(/^\w+:/.test(s) ? s : resolvePath(path, s));

  // 统计计数器
  let assetCount = 0;
  let pageCount = 0;
  const pagePaths = new Set<string>();

  // 构建清单：记录所有构建输出的元数据
  const buildManifest: BuildManifest = {
    ...(title && {title}),
    config: {root},
    pages: [],
    modules: [],
    files: []
  };

  // 辅助函数：将页面/模块信息添加到构建清单
  const addToManifest = (type: string, file: string, {title, path}: {title?: string | null; path: string}) => {
    buildManifest[type].push({
      path: config.normalizePath(file),
      source: join("/", path),
      ...(title != null && {title})
    });
  };

  // 第一阶段：扫描和加载所有页面和模块
  for await (const path of config.paths()) {
    effects.output.write(`${faint("load")} ${path} `);
    const start = performance.now();
    const options = {path, ...config};
    
    // 处理 JavaScript 模块
    if (path.endsWith(".js")) {
      const module = findModule(root, path);
      if (module) {
        const resolvers = await getModuleResolvers(path, config);
        const elapsed = Math.floor(performance.now() - start);
        // 收集模块的依赖项
        for (const f of resolvers.files) addFile(path, f);
        for (const i of resolvers.localImports) addLocalImport(path, i);
        for (const i of resolvers.globalImports) addGlobalImport(path, resolvers.resolveImport(i));
        for (const s of resolvers.stylesheets) addStylesheet(path, s);
        effects.output.write(`${faint("in")} ${(elapsed >= 100 ? yellow : faint)(`${elapsed}ms`)}\n`);
        outputs.set(path, {type: "module", resolvers});
        ++assetCount;
        addToManifest("modules", path, module);
        continue;
      }
    }
    
    // 处理静态文件
    const file = loaders.find(path);
    if (file) {
      effects.output.write(`${faint("copy")} ${join(root, path)} ${faint("→")} `);
      const sourcePath = join(root, await file.load({useStale: true}, effects));
      await effects.copyFile(sourcePath, path);
      addToManifest("files", path, file);
      ++assetCount;
      continue;
    }
    
    // 处理 Markdown 页面
    const page = await loaders.loadPage(path, options, effects);
    if (page.data.draft) {
      effects.logger.log(faint("(skipped)"));
      continue;
    }
    const resolvers = await getResolvers(page, options);
    const elapsed = Math.floor(performance.now() - start);
    // 收集页面的依赖项
    for (const f of resolvers.assets) addFile(path, f);
    for (const f of resolvers.files) addFile(path, f);
    for (const i of resolvers.localImports) addLocalImport(path, i);
    for (const i of resolvers.globalImports) addGlobalImport(path, resolvers.resolveImport(i));
    for (const s of resolvers.stylesheets) addStylesheet(path, s);
    effects.output.write(`${faint("in")} ${(elapsed >= 100 ? yellow : faint)(`${elapsed}ms`)}\n`);
    pagePaths.add(path);
    outputs.set(path, {type: "page", page, resolvers});
    ++pageCount;
  }

  // 验证至少有一个输出
  const outputCount = pageCount + assetCount;
  if (!outputCount) throw new CliError(`Nothing to build: no pages found in your ${root} directory.`);
  if (pageCount) effects.logger.log(`${faint("built")} ${pageCount} ${faint(`page${pageCount === 1 ? "" : "s"} in`)} ${root}`);
  if (assetCount) effects.logger.log(`${faint("built")} ${assetCount} ${faint(`asset${assetCount === 1 ? "" : "s"} in`)} ${root}`);

  // 第二阶段：缓存破坏 - 为大多数资源重命名以包含内容哈希
  const aliases = new Map<string, string>();
  const cacheRoot = join(root, ".observablehq", "cache");

  // 添加搜索功能包和数据（如果需要）
  if (config.search) {
    globalImports.add("/_observablehq/search.js").add("/_observablehq/minisearch.json");
    const contents = await searchIndex(config, pagePaths, effects);
    effects.output.write(`${faint("index →")} `);
    const cachePath = join(cacheRoot, "_observablehq", "minisearch.json");
    await prepareOutput(cachePath);
    await writeFile(cachePath, contents);
    effects.logger.log(cachePath);
  }

  // 第三阶段：复制 DuckDB 扩展，初始化构建 DuckDB 清单所需的别名
  for (const path of globalImports) {
    if (path.startsWith("/_duckdb/")) {
      const sourcePath = join(cacheRoot, path);
      effects.output.write(`${faint("build")} ${path} ${faint("→")} `);
      const contents = await readFile(sourcePath);
      const hash = createHash("sha256").update(contents).digest("hex").slice(0, 8);
      const [, , , version, bundle, name] = path.split("/");
      const alias = join("/_duckdb/", `${basename(name, ".duckdb_extension.wasm")}-${hash}`, version, bundle, name);
      aliases.set(path, alias);
      await effects.writeFile(alias, contents);
    }
  }

  // 第四阶段：生成客户端 JavaScript 包
  // 这些包最初生成到缓存中，因为我们需要重写任何 npm 和 node 导入为哈希版本
  for (const path of globalImports) {
    if (path.startsWith("/_observablehq/") && path.endsWith(".js")) {
      const cachePath = join(cacheRoot, path);
      effects.output.write(`${faint("bundle")} ${path} ${faint("→")} `);
      const clientPath = getClientPath(path === "/_observablehq/client.js" ? "index.js" : path.slice("/_observablehq/".length));
      const define: {[key: string]: string} = {};
      // 为 DuckDB 模块注入清单数据
      if (path === "/_observablehq/stdlib/duckdb.js") define["DUCKDB_MANIFEST"] = JSON.stringify(await getDuckDBManifest(duckdb, {root, aliases}));
      const contents = await rollupClient(clientPath, root, path, {minify: true, keepNames: true, define});
      await prepareOutput(cachePath);
      await writeFile(cachePath, contents);
      effects.logger.log(cachePath);
    }
  }

  // 第五阶段：复制样式表，累积哈希别名
  for (const specifier of stylesheets) {
    if (specifier.startsWith("observablehq:")) {
      let contents: string;
      const path = `/_observablehq/${specifier.slice("observablehq:".length)}`;
      effects.output.write(`${faint("build")} ${path} ${faint("→")} `);
      if (specifier.startsWith("observablehq:theme-")) {
        // 处理主题样式文件
        const match = /^observablehq:theme-(?<theme>[\w-]+(,[\w-]+)*)?\.css$/.exec(specifier);
        contents = await bundleStyles({theme: match!.groups!.theme?.split(",") ?? [], minify: true});
      } else {
        // 处理标准样式文件
        const clientPath = getClientPath(path.slice("/_observablehq/".length));
        contents = await bundleStyles({path: clientPath, minify: true});
      }
      const hash = createHash("sha256").update(contents).digest("hex").slice(0, 8);
      const alias = applyHash(path, hash);
      aliases.set(path, alias);
      await effects.writeFile(alias, contents);
    } else if (specifier.startsWith("npm:")) {
      // 处理 npm 样式文件
      effects.output.write(`${faint("copy")} ${specifier} ${faint("→")} `);
      const path = await resolveNpmImport(root, specifier.slice("npm:".length));
      const sourcePath = await populateNpmCache(root, path);
      await effects.copyFile(sourcePath, path);
    } else if (!/^\w+:/.test(specifier)) {
      // 处理本地样式文件
      const sourcePath = join(root, specifier);
      effects.output.write(`${faint("build")} ${sourcePath} ${faint("→")} `);
      const contents = await bundleStyles({path: sourcePath, minify: true});
      const hash = createHash("sha256").update(contents).digest("hex").slice(0, 8);
      const alias = applyHash(join("/_import", specifier), hash);
      aliases.set(resolveStylesheetPath(root, specifier), alias);
      await effects.writeFile(alias, contents);
    }
  }

  // 第六阶段：复制引用的文件，累积哈希别名
  for (const file of files) {
    effects.output.write(`${faint("copy")} ${join(root, file)} ${faint("→")} `);
    const path = join("/", file);
    const loader = loaders.find(path);
    if (!loader) throw enoent(path);
    const sourcePath = join(root, await loader.load({useStale: true}, effects));
    const contents = await readFile(sourcePath);
    const hash = createHash("sha256").update(contents).digest("hex").slice(0, 8);
    const alias = applyHash(join("/_file", file), hash);
    aliases.set(loaders.resolveFilePath(file), alias);
    await effects.writeFile(alias, contents);
  }

  // Copy over global assets (e.g., minisearch.json, DuckDB's WebAssembly).
  // Anything in _observablehq also needs a content hash, but anything in _npm
  // or _node does not (because they are already necessarily immutable). We're
  // skipping DuckDB's extensions because they were previously copied above.
  for (const path of globalImports) {
    if (path.endsWith(".js") || path.startsWith("/_duckdb/")) continue;
    const sourcePath = join(cacheRoot, path);
    effects.output.write(`${faint("build")} ${path} ${faint("→")} `);
    if (path.startsWith("/_observablehq/")) {
      const contents = await readFile(sourcePath, "utf-8");
      const hash = createHash("sha256").update(contents).digest("hex").slice(0, 8);
      const alias = applyHash(path, hash);
      aliases.set(path, alias);
      await effects.writeFile(alias, contents);
    } else {
      await effects.copyFile(sourcePath, path);
    }
  }

  // Compute the hashes for global modules. By computing the hash on the file in
  // the cache root, this takes into consideration the resolved exact versions
  // of npm and node imports for transitive dependencies.
  for (const path of globalImports) {
    if (!path.endsWith(".js")) continue;
    const hash = getModuleHash(cacheRoot, path).slice(0, 8);
    const alias = applyHash(path, hash);
    effects.logger.log(`${faint("alias")} ${path} ${faint("→")} ${alias}`);
    aliases.set(path, alias);
  }

  // Copy over global imports, applying aliases. Note that unused standard
  // library imports (say parquet-wasm if you never use FileAttachment.parquet)
  // may not be present in aliases and not included in the output build; these
  // imports therefore will not have associated hashes.
  for (const path of globalImports) {
    if (!path.endsWith(".js")) continue;
    const sourcePath = join(cacheRoot, path);
    effects.output.write(`${faint("build")} ${path} ${faint("→")} `);
    const resolveImport = (i: string) => isPathImport(i) ? relativePath(path, aliases.get((i = resolvePath(path, i))) ?? i) : i; // prettier-ignore
    await effects.writeFile(aliases.get(path)!, rewriteNpmImports(await readFile(sourcePath, "utf-8"), resolveImport));
  }

  // Copy over imported local modules, overriding import resolution so that
  // module hash is incorporated into the file name rather than in the query
  // string. Note that this hash is not of the content of the module itself, but
  // of the transitive closure of the module and its imports and files.
  const resolveLocalImport = async (path: string): Promise<string> => {
    const hash = (await loaders.getLocalModuleHash(path)).slice(0, 8);
    return applyHash(join("/_import", path), hash);
  };
  for (const path of localImports) {
    if (!path.endsWith(".js")) continue;
    const module = findModule(root, path);
    if (!module) throw new Error(`import not found: ${path}`);
    const sourcePath = join(root, module.path);
    const importPath = join("_import", module.path);
    effects.output.write(`${faint("copy")} ${sourcePath} ${faint("→")} `);
    const resolveImport = loaders.getModuleResolver(path);
    const input = await readJavaScript(sourcePath);
    const contents = await transpileModule(input, {
      root,
      path,
      params: module.params,
      resolveFile(name) {
        const resolution = loaders.resolveFilePath(resolvePath(path, name));
        return aliases.get(resolution) ?? resolution;
      },
      resolveFileInfo(name) {
        return loaders.getOutputInfo(resolvePath(path, name));
      },
      async resolveImport(specifier) {
        let resolution: string;
        if (isPathImport(specifier)) {
          resolution = await resolveLocalImport(resolvePath(path, specifier));
        } else {
          resolution = await resolveImport(specifier);
          if (isPathImport(resolution)) {
            resolution = resolvePath(importPath, resolution);
            resolution = aliases.get(resolution) ?? resolution;
          }
        }
        return relativePath(importPath, resolution);
      }
    });
    const alias = await resolveLocalImport(path);
    aliases.set(loaders.resolveImportPath(path), alias);
    await effects.writeFile(alias, contents);
  }

  // Wrap the resolvers to apply content-hashed file names.
  for (const [path, output] of outputs) {
    const {resolvers} = output;
    outputs.set(path, {
      ...output,
      resolvers: {
        ...resolvers,
        resolveFile(specifier) {
          const r = resolvers.resolveFile(specifier);
          const a = aliases.get(resolvePath(path, r));
          return a ? relativePath(path, a) : specifier; // fallback to specifier if enoent
        },
        resolveStylesheet(specifier) {
          const r = resolvers.resolveStylesheet(specifier);
          const a = aliases.get(resolvePath(path, r));
          return a ? relativePath(path, a) : isPathImport(specifier) ? specifier : r; // fallback to specifier if enoent
        },
        resolveImport(specifier) {
          const r = resolvers.resolveImport(specifier);
          const a = aliases.get(resolvePath(path, r));
          return a ? relativePath(path, a) : isPathImport(specifier) ? specifier : r; // fallback to specifier if enoent
        },
        resolveScript(specifier) {
          const r = resolvers.resolveScript(specifier);
          const a = aliases.get(resolvePath(path, r));
          return a ? relativePath(path, a) : specifier; // fallback to specifier if enoent
        }
      }
    });
  }

  // Render pages!
  for (const [path, output] of outputs) {
    effects.output.write(`${faint("render")} ${path} ${faint("→")} `);
    if (output.type === "page") {
      const {page, resolvers} = output;
      const html = await renderPage(page, {...config, path, resolvers});
      await effects.writeFile(`${path}.html`, html);
      addToManifest("pages", path, page);
    } else {
      const {resolvers} = output;
      const source = await renderModule(root, path, resolvers);
      await effects.writeFile(path, source);
    }
  }

  // Write the build manifest.
  await effects.writeBuildManifest(buildManifest);
  // Log page sizes.
  const columnWidth = 12;
  effects.logger.log("");
  for (const [indent, name, description, node] of tree(outputs)) {
    if (node.children) {
      effects.logger.log(
        `${faint(indent)}${name}${faint(description)} ${
          node.depth ? "" : ["Page", "Imports", "Files"].map((name) => name.padStart(columnWidth)).join(" ")
        }`
      );
    } else {
      const [path, {type, resolvers}] = node.data!;
      const resolveOutput = (name: string) => join(config.output, resolvePath(path, name));
      const pageSize = (await stat(join(config.output, type === "page" ? `${path}.html` : path))).size;
      const importSize = await accumulateSize(resolvers.staticImports, resolvers.resolveImport, resolveOutput);
      const fileSize =
        (await accumulateSize(resolvers.files, resolvers.resolveFile, resolveOutput)) +
        (await accumulateSize(resolvers.assets, resolvers.resolveFile, resolveOutput)) +
        (await accumulateSize(resolvers.stylesheets, resolvers.resolveStylesheet, resolveOutput));
      effects.logger.log(
        `${faint(indent)}${name}${description} ${[pageSize, importSize, fileSize]
          .map((size) => formatBytes(size, columnWidth))
          .join(" ")}`
      );
    }
  }
  effects.logger.log("");

  // Check links. TODO Have this break the build, and move this check earlier?
  const [validLinks, brokenLinks] = validateLinks(outputs);
  if (brokenLinks.length) {
    effects.logger.warn(`${yellow("Warning: ")}${brokenLinks.length} broken link${brokenLinks.length === 1 ? "" : "s"} (${validLinks.length + brokenLinks.length} validated)`); // prettier-ignore
    for (const [path, link] of brokenLinks) effects.logger.log(`${faint("↳")} ${path} ${faint("→")} ${red(link)}`);
  } else if (validLinks.length) {
    effects.logger.log(`${green(`${validLinks.length}`)} link${validLinks.length === 1 ? "" : "s"} validated`);
  }

  Telemetry.record({event: "build", step: "finish", pageCount});
}

type Link = [path: string, target: string];

/**
 * 验证页面内部链接的有效性
 * 
 * 检查所有页面中的内部链接是否指向有效的页面或锚点。
 * 这有助于在构建时发现断链，避免在部署后出现 404 错误。
 * 
 * @param outputs 所有页面和模块的输出映射
 * @returns 包含有效链接和断链的数组元组
 */
function validateLinks(outputs: Map<string, {resolvers: Resolvers}>): [valid: Link[], broken: Link[]] {
  // 构建所有有效目标的集合
  const validTargets = new Set<string>(outputs.keys()); // 例如："/this/page#hash"
  
  // 添加所有页面的锚点作为有效目标
  for (const [path, {resolvers}] of outputs) {
    for (const anchor of resolvers.anchors) {
      validTargets.add(`${path}#${encodeURIComponent(anchor)}`);
    }
  }
  
  const valid: Link[] = [];
  const broken: Link[] = [];
  
  // 检查每个页面的本地链接
  for (const [path, {resolvers}] of outputs) {
    for (const target of resolvers.localLinks) {
      (validTargets.has(target) ? valid : broken).push([path, target]);
    }
  }
  
  return [valid, broken];
}

/**
 * 为路径应用内容哈希
 * 
 * 在文件名中插入内容哈希，用于缓存破坏。
 * 例如："/style.css" + "abc123" → "/style.abc123.css"
 * 
 * @param path 原始文件路径
 * @param hash 内容哈希字符串
 * @returns 包含哈希的新路径
 */
function applyHash(path: string, hash: string): string {
  const ext = extname(path);
  let name = basename(path, ext);
  // 允许哈希替换 _esm 后缀
  if (path.endsWith(".js")) name = name.replace(/(^|\.)_esm$/, "");
  return join(dirname(path), `${name && `${name}.`}${hash}${ext}`);
}

/**
 * 累积文件大小统计
 * 
 * 计算指定文件列表的总大小，用于构建报告中的文件大小统计。
 * 
 * @param files 文件名的可迭代对象
 * @param resolveFile 文件路径解析函数
 * @param resolveOutput 输出路径解析函数
 * @returns 总文件大小（字节）
 */
async function accumulateSize(
  files: Iterable<string>,
  resolveFile: (path: string) => string,
  resolveOutput: (path: string) => string
): Promise<number> {
  let size = 0;
  for (const file of files) {
    const fileResolution = resolveFile(file);
    if (isAssetPath(fileResolution)) {
      try {
        size += (await stat(resolveOutput(fileResolution))).size;
      } catch {
        // 忽略缺失的文件
      }
    }
  }
  return size;
}

/**
 * 格式化字节大小为人类可读的字符串
 * 
 * 将字节数转换为带颜色的格式化字符串，用于构建报告。
 * 不同大小使用不同颜色：小文件用绿色，大文件用红色警告。
 * 
 * @param size 文件大小（字节）
 * @param length 输出字符串的目标长度（用于对齐）
 * @param locale 本地化设置
 * @returns 格式化并带颜色的大小字符串
 */
function formatBytes(size: number, length: number, locale: Intl.LocalesArgument = "en-US"): string {
  let color: (text: string) => string;
  let text: string;
  if (size < 1e3) {
    text = "<1 kB";
    color = faint;
  } else if (size < 1e6) {
    text = (size / 1e3).toLocaleString(locale, {maximumFractionDigits: 0}) + " kB";
    color = green;
  } else {
    text = (size / 1e6).toLocaleString(locale, {minimumFractionDigits: 3, maximumFractionDigits: 3}) + " MB";
    color = size < 10e6 ? yellow : size < 50e6 ? magenta : red;
  }
  return color(text.padStart(length));
}

/**
 * 文件构建效果器实现
 * 
 * BuildEffects 接口的具体实现，用于本地文件系统构建。
 * 处理文件复制、写入、目录准备等操作。
 * 
 * 这个类是构建过程与文件系统操作之间的抽象层，
 * 允许在不同环境（本地、云端）中使用不同的实现。
 */
export class FileBuildEffects implements BuildEffects {
  private readonly outputRoot: string;  // 输出根目录路径
  private readonly cacheDir: string;    // 缓存目录路径
  readonly logger: Logger;              // 日志记录器
  readonly output: Writer;              // 输出流
  
  /**
   * 创建文件构建效果器实例
   * 
   * @param outputRoot 构建输出的根目录路径
   * @param cacheDir 缓存文件的目录路径
   * @param options 可选的日志记录器和输出流配置
   */
  constructor(
    outputRoot: string,
    cacheDir: string,
    {logger = console, output = process.stdout}: {logger?: Logger; output?: Writer} = {}
  ) {
    if (!outputRoot) throw new Error("missing outputRoot");
    this.logger = logger;
    this.output = output;
    this.outputRoot = outputRoot;
    this.cacheDir = cacheDir;
  }
  
  /**
   * 准备构建环境
   * 
   * 清空输出目录以确保干净的构建。
   * 为了安全起见，只有当输出目录在当前工作目录内时才会清空。
   */
  async prepare(): Promise<void> {
    if (within(process.cwd(), this.outputRoot)) {
      await rm(this.outputRoot, {recursive: true, force: true});
    } else {
      this.logger.warn(
        `${yellow("Warning:")} the output root ${
          this.outputRoot
        } is not within the current working directory and will not be cleared.`
      );
    }
  }
  
  /**
   * 复制文件到输出目录
   * 
   * @param sourcePath 源文件的绝对路径
   * @param outputPath 相对于输出根目录的目标路径
   */
  async copyFile(sourcePath: string, outputPath: string): Promise<void> {
    const destination = join(this.outputRoot, outputPath);
    this.logger.log(destination);
    await prepareOutput(destination);
    if (existsSync(destination)) throw new Error(`file conflict: ${outputPath}`);
    await copyFile(sourcePath, destination);
  }
  
  /**
   * 写入文件到输出目录
   * 
   * @param outputPath 相对于输出根目录的文件路径
   * @param contents 要写入的内容
   */
  async writeFile(outputPath: string, contents: string | Buffer): Promise<void> {
    const destination = join(this.outputRoot, outputPath);
    this.logger.log(destination);
    await prepareOutput(destination);
    if (existsSync(destination)) throw new Error(`file conflict: ${outputPath}`);
    await writeFile(destination, contents);
  }
  
  /**
   * 写入构建清单文件
   * 
   * 将构建结果的元数据保存到缓存目录中的 JSON 文件。
   * 
   * @param buildManifest 构建清单对象
   */
  async writeBuildManifest(buildManifest: BuildManifest): Promise<void> {
    const destination = join(this.cacheDir, "_build.json");
    await prepareOutput(destination);
    await writeFile(destination, JSON.stringify(buildManifest));
  }
}

/**
 * 构建清单数据结构
 * 
 * 记录构建过程的结果和元数据，包括所有生成的页面、模块和文件。
 * 这些信息可用于增量构建、部署和调试。
 */
export interface BuildManifest {
  /** 站点标题 */
  title?: string;
  /** 配置信息 */
  config: {root: string};
  /** 生成的页面列表 */
  pages: {path: string; title?: string | null; source?: string}[];
  /** 处理的模块列表 */
  modules: {path: string; source?: string}[];
  /** 复制的文件列表 */
  files: {path: string; source?: string}[];
}

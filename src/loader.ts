import {createHash} from "node:crypto";
import type {FSWatcher, WatchListener, WriteStream} from "node:fs";
import {createReadStream, existsSync, statSync, watch} from "node:fs";
import {open, readFile, rename, unlink} from "node:fs/promises";
import {dirname, extname, join} from "node:path/posix";
import {createGunzip} from "node:zlib";
import {spawn} from "cross-spawn";
import JSZip from "jszip";
import {extract} from "tar-stream";
import {enoent} from "./error.js";
import {maybeStat, prepareOutput, visitFiles} from "./files.js";
import {FileWatchers} from "./fileWatchers.js";
import {formatByteSize} from "./format.js";
import type {FileInfo} from "./javascript/module.js";
import {findModule, getFileInfo, getLocalModuleHash, getModuleHash} from "./javascript/module.js";
import type {Logger, Writer} from "./logger.js";
import type {MarkdownPage, ParseOptions} from "./markdown.js";
import {parseMarkdown} from "./markdown.js";
import {getModuleResolver, resolveImportPath} from "./resolvers.js";
import type {Params} from "./route.js";
import {isParameterized, requote, route} from "./route.js";
import {cyan, faint, green, red, yellow} from "./tty.js";

const runningCommands = new Map<string, Promise<string>>();

/**
 * 默认的解释器配置，用于执行不同语言的数据加载脚本
 * 例如：data.csv.js 会用 node 来执行，data.csv.py 会用 python3 来执行
 */
export const defaultInterpreters: Record<string, string[]> = {
  ".js": ["node", "--no-warnings=ExperimentalWarning"],  // JavaScript
  ".ts": ["tsx"],                                       // TypeScript
  ".py": ["python3"],                                   // Python
  ".r": ["Rscript"],                                    // R语言
  ".R": ["Rscript"],
  ".rs": ["rust-script"],                               // Rust
  ".go": ["go", "run"],                                 // Go
  ".java": ["java"],                                    // Java  
  ".jl": ["julia"],                                     // Julia
  ".php": ["php"],                                      // PHP
  ".sh": ["sh"],                                        // Shell
  ".exe": []                                            // 可执行文件
};

export interface LoadEffects {
  logger: Logger;
  output: Writer;
}

const defaultEffects: LoadEffects = {
  logger: console,
  output: process.stdout
};

export interface LoadOptions {
  /** Whether to use a stale cache; true when building. */
  useStale?: boolean;
}

export interface LoaderOptions {
  root: string;
  path: string;
  params?: Params;
  targetPath: string;
}

/**
 * 数据加载器解析器类
 * 负责发现、解析和执行各种类型的数据加载器，包括：
 * 1. 静态文件（如 data.csv）
 * 2. 命令加载器（如 data.csv.js）
 * 3. 存档文件内容（如 data.zip 内的文件）
 */
export class LoaderResolver {
  private readonly root: string;                         // 源代码根目录
  private readonly interpreters: Map<string, string[]>;  // 各种文件类型的解释器

  constructor({root, interpreters}: {root: string; interpreters?: Record<string, string[] | null>}) {
    this.root = root;
    // 合并默认解释器和用户自定义解释器
    this.interpreters = new Map(
      Object.entries({...defaultInterpreters, ...interpreters}).filter(
        (entry): entry is [string, string[]] => entry[1] != null
      )
    );
  }

  /**
   * 加载指定路径的页面内容，返回解析后的Markdown页面对象
   * @param path 页面路径，如 "/index"
   * @param options 加载选项和解析选项
   * @param effects 加载效果（日志记录器、输出流）
   */
  async loadPage(path: string, options: LoadOptions & ParseOptions, effects?: LoadEffects): Promise<MarkdownPage> {
    const loader = this.findPage(path);
    if (!loader) throw enoent(path);
    // 先执行loader获取文件内容，然后解析Markdown
    const input = await readFile(join(this.root, await loader.load(options, effects)), "utf8");
    return parseMarkdown(input, {source: loader.path, params: loader.params, ...options});
  }

  /**
   * 为指定页面路径创建文件监视器，用于开发时的热重载
   * @param path 页面路径
   * @param listener 文件变化监听器
   */
  watchPage(path: string, listener: WatchListener<string>): FSWatcher {
    const loader = this.findPage(path);
    if (!loader) throw enoent(path);
    return watch(join(this.root, loader.path), listener);
  }

  /**
   * 查找所有非参数化的页面路径
   * 用于自动发现项目中的所有页面
   * 支持的页面文件：
   * - index.md（Markdown页面）
   * - weather.md.js（JavaScript生成的页面）
   * - api.md.py（Python生成的页面）
   * 等
   */
  *findPagePaths(): Generator<string> {
    // 创建正则表达式匹配所有支持的页面文件扩展名
    const ext = new RegExp(`\\.md(${["", ...this.interpreters.keys()].map(requote).join("|")})$`);
    for (const file of visitFiles(this.root, (name) => !isParameterized(name))) {
      if (!ext.test(file)) continue;
      // 移除.md后缀得到页面路径
      const path = `/${file.slice(0, file.lastIndexOf(".md"))}`;
      // 如果是.js页面但已存在同名模块，则跳过
      if (extname(path) === ".js" && findModule(this.root, path)) continue;
      yield path;
    }
  }

  /**
   * 查找指定路径的页面加载器
   * @param path 目标页面路径，如 "/index"
   * @returns 对应的页面加载器，如果不存在则返回undefined
   */
  findPage(path: string): Loader | undefined {
    // 如果是.js页面且已存在同名模块，则不使用loader
    if (extname(path) === ".js" && findModule(this.root, path)) return;
    // 查找对应的.md文件或.md.{ext}文件
    return this.find(`${path}.md`);
  }

  /**
   * 查找指定路径的数据加载器
   * 支持两种查找方式：
   * 1. 直接文件查找（包括静态文件和命令加载器）
   * 2. 存档文件内容查找（从zip、tar等文件中提取）
   * 
   * @param path 目标文件路径，如 "/data/sales.csv"
   * @returns 对应的加载器，如果不存在则返回undefined
   */
  find(path: string): Loader | undefined {
    return this.findFile(path) ?? this.findArchive(path);
  }

  /**
   * 查找直接文件加载器，支持以下模式：
   * 静态文件：
   * - /path/to/file.csv
   * 命令加载器：
   * - /path/to/file.csv.js（用JavaScript生成CSV）
   * - /path/to/file.csv.py（用Python生成CSV）
   * 参数化文件：
   * - /path/to/[param].csv
   * - /path/[param]/file.csv
   * - /[param1]/[param2]/file.csv
   * 等各种参数化组合
   */
  private findFile(targetPath: string): Loader | undefined {
    const ext = extname(targetPath);  // 获取目标文件扩展名，如.csv
    // 构建候选扩展名列表：原扩展名 + 所有解释器扩展名的组合
    const exts = ext ? [ext, ...Array.from(this.interpreters.keys(), (iext) => ext + iext)] : [ext];
    // 使用路由系统查找匹配的文件
    const found = route(this.root, ext ? targetPath.slice(0, -ext.length) : targetPath, exts);
    if (!found) return;
    
    const {path, params, ext: fext} = found;
    
    // 如果找到的扩展名就是目标扩展名，说明是静态文件
    if (fext === ext) return new StaticLoader({root: this.root, path, params});
    
    // 否则是命令加载器，需要执行脚本生成文件
    const commandPath = join(this.root, path);
    const [command, ...args] = this.interpreters.get(fext.slice(ext.length))!;
    if (command != null) args.push(commandPath);
    
    return new CommandLoader({
      command: command ?? commandPath,
      args: params ? args.concat(defineParams(params)) : args,
      path,
      params,
      root: this.root,
      targetPath
    });
  }

  /**
   * 查找存档文件内的内容加载器，支持以下模式：
   * 直接存档：
   * - /path/to.zip
   * - /path/to.tgz
   * 命令生成的存档：
   * - /path/to.zip.js（用JavaScript生成ZIP文件）
   * - /path/to.tgz.py（用Python生成TGZ文件）
   * 参数化存档：
   * - /path/[param].zip
   * - /[param]/to.zip
   * 等
   * 
   * 例如：访问 /data/sales/2023.csv，可能从 /data.zip 中提取 sales/2023.csv
   */
  private findArchive(targetPath: string): Loader | undefined {
    const exts = this.getArchiveExtensions();
    
    // 从目标路径向上遍历每个目录层级
    for (let dir = dirname(targetPath), parent: string; (parent = dirname(dir)) !== dir; dir = parent) {
      const found = route(this.root, dir, exts);
      if (!found) continue;
      
      const {path, params, ext: fext} = found;
      const inflatePath = targetPath.slice(dir.length + 1); // 存档内的相对路径
      
      // 如果是直接存档文件
      if (extractors.has(fext)) {
        const Extractor = extractors.get(fext)!;
        return new Extractor({
          preload: async () => path,
          inflatePath,
          path,
          params,
          root: this.root,
          targetPath
        });
      }
      
      // 如果是命令生成的存档文件
      const iext = extname(fext);
      const commandPath = join(this.root, path);
      const [command, ...args] = this.interpreters.get(iext)!;
      if (command != null) args.push(commandPath);
      const eext = fext.slice(0, -iext.length); // 移除解释器扩展名，得到存档扩展名
      
      // 创建命令加载器来生成存档文件
      const loader = new CommandLoader({
        command: command ?? commandPath,
        args: params ? args.concat(defineParams(params)) : args,
        path,
        params,
        root: this.root,
        targetPath: dir + eext
      });
      
      // 然后创建提取器从生成的存档中提取内容
      const Extractor = extractors.get(eext)!;
      return new Extractor({
        preload: async (options, effects) => loader.load(options, effects),
        inflatePath,
        path: loader.path,
        params,
        root: this.root,
        targetPath
      });
    }
  }

  /**
   * 获取所有支持的存档文件扩展名
   * 包括：.zip, .tar, .tgz 以及它们与解释器的组合
   * 如：.zip.js, .tar.py 等
   */
  getArchiveExtensions(): string[] {
    const exts = Array.from(extractors.keys());
    for (const e of extractors.keys()) {
      for (const i of this.interpreters.keys()) {
        exts.push(e + i);
      }
    }
    return exts;
  }

  /**
   * Returns the path to watch, relative to the current working directory, for
   * the specified source path, relative to the source root.
   */
  getWatchPath(path: string): string | undefined {
    const exactPath = join(this.root, path);
    if (existsSync(exactPath)) return exactPath;
    if (exactPath.endsWith(".js")) {
      const module = findModule(this.root, path);
      return module && join(this.root, module.path);
    }
    const foundPath = this.find(path)?.path;
    if (foundPath) return join(this.root, foundPath);
  }

  watchFiles(path: string, watchPaths: Iterable<string>, callback: (name: string) => void) {
    return FileWatchers.of(this, path, watchPaths, callback);
  }

  /**
   * Returns the path to the backing file during preview, relative to the source
   * root, which is the source file for the associated data loader if the file
   * is generated by a loader.
   */
  private getSourceFilePath(path: string): string {
    if (!existsSync(join(this.root, path))) {
      const loader = this.find(path);
      if (loader) return loader.path;
    }
    return path;
  }

  /**
   * Returns the path to the backing file during build, relative to the source
   * root, which is the cached output file if the file is generated by a loader.
   */
  private getOutputFilePath(path: string): string {
    if (!existsSync(join(this.root, path))) {
      const loader = this.find(path);
      if (loader) return join(".observablehq", "cache", path);
    }
    return path;
  }

  /**
   * Returns the hash of the file with the given name within the source root, or
   * if the name refers to a file generated by a data loader, the hash of the
   * corresponding data loader source and its modification time. The latter
   * ensures that if the data loader is "touched" (even without changing its
   * contents) that the data loader will be re-run.
   */
  getSourceFileHash(name: string): string {
    const path = this.getSourceFilePath(name);
    const info = getFileInfo(this.root, path);
    if (!info) return createHash("sha256").digest("hex");
    const {hash} = info;
    return path === name ? hash : createHash("sha256").update(hash).update(String(info.mtimeMs)).digest("hex");
  }

  getOutputFileHash(name: string): string {
    const info = this.getOutputInfo(name);
    if (!info) throw new Error(`output file not found: ${name}`);
    return createHash("sha256").update(info.hash).update(String(info.mtimeMs)).digest("hex");
  }

  getSourceInfo(name: string): FileInfo | undefined {
    return getFileInfo(this.root, this.getSourceFilePath(name));
  }

  getOutputInfo(name: string): FileInfo | undefined {
    return getFileInfo(this.root, this.getOutputFilePath(name));
  }

  getLocalModuleHash(path: string): Promise<string> {
    return getLocalModuleHash(this.root, path, (p) => this.getOutputFileHash(p));
  }

  getModuleHash(path: string): string {
    return getModuleHash(this.root, path, (p) => this.getSourceFileHash(p));
  }

  getModuleResolver(path: string, servePath?: string): (specifier: string) => Promise<string> {
    return getModuleResolver(this.root, path, servePath, (p) => this.getSourceFileHash(p));
  }

  resolveImportPath(path: string): string {
    return resolveImportPath(this.root, path, (p) => this.getSourceFileHash(p));
  }

  resolveFilePath(path: string): string {
    return `/${join("_file", path)}?sha=${this.getSourceFileHash(path)}`;
  }
}

/**
 * 将参数对象转换为命令行参数数组
 * 用于向数据加载器脚本传递参数
 * @param params 参数对象，如 {year: "2023", month: "01"}
 * @returns 命令行参数数组，如 ["--param-year=2023", "--param-month=01"]
 */
function defineParams(params: Params): string[] {
  return Object.entries(params).map(([key, value]) => `--param-${key}=${value}`);
}

/**
 * 数据加载器接口
 * 所有具体的加载器都必须实现这个接口
 */
export interface Loader {
  /** 源代码根目录 */
  readonly root: string;
  /** 加载器脚本的相对路径，用于文件监视 */
  readonly path: string;
  /** 路由参数，用于参数化加载器 */
  readonly params: Params | undefined;
  /**
   * 执行加载器，返回生成文件的相对路径
   * 通常输出到 .observablehq/cache 目录
   */
  load(options?: LoadOptions, effects?: LoadEffects): Promise<string>;
}

/**
 * 静态文件加载器
 * 用于处理已存在的静态文件，如 data.csv
 * 这种加载器不需要执行任何命令，直接返回文件路径
 */
class StaticLoader implements Loader {
  readonly root: string;
  readonly path: string;
  readonly params: Params | undefined;

  constructor({root, path, params}: Omit<LoaderOptions, "targetPath">) {
    this.root = root;
    this.path = path;
    this.params = params;
  }

  async load() {
    return this.path;  // 直接返回静态文件路径
  }
}

/**
 * 抽象加载器基类
 * 提供通用的缓存管理、文件生成和错误处理逻辑
 * 具体的执行逻辑由子类实现
 */
abstract class AbstractLoader implements Loader {
  readonly root: string;
  readonly path: string;
  readonly params: Params | undefined;
  /** 目标文件在输出目录中的路径 */
  readonly targetPath: string;

  constructor({root, path, params, targetPath}: LoaderOptions) {
    this.root = root;
    this.path = path;
    this.params = params;
    this.targetPath = targetPath;
  }

  /**
   * 加载文件的主要方法，包含完整的缓存管理逻辑：
   * 1. 检查缓存是否存在且是最新的
   * 2. 如果需要重新生成，执行加载器命令
   * 3. 将输出写入临时文件，成功后移动到最终位置
   * 4. 处理错误情况，记录错误时间避免频繁重试
   */
  async load({useStale = false}: LoadOptions = {}, effects = defaultEffects): Promise<string> {
    const loaderPath = join(this.root, this.path);
    const key = join(this.root, this.targetPath);
    
    // 检查是否已有相同的加载任务在运行，避免重复执行
    let command = runningCommands.get(key);
    if (!command) {
      command = (async () => {
        const outputPath = join(".observablehq", "cache", this.targetPath);
        const cachePath = join(this.root, outputPath);
        const loaderStat = await maybeStat(loaderPath);
        const cacheStat = await maybeStat(cachePath);
        
        // 缓存新鲜度检查
        if (!cacheStat) {
          effects.output.write(faint("[missing] "));  // 缓存文件不存在
        } else if (cacheStat.mtimeMs < loaderStat!.mtimeMs) {
          if (useStale) {
            // 构建时允许使用过期缓存以提高性能
            return effects.output.write(faint("[using stale] ")), outputPath;
          } else {
            effects.output.write(faint("[stale] "));   // 缓存已过期
          }
        } else {
          return effects.output.write(faint("[fresh] ")), outputPath;  // 缓存是最新的
        }
        
        // 检查最近的错误记录，避免频繁重试失败的加载器
        const tempPath = join(this.root, ".observablehq", "cache", `${this.targetPath}.${process.pid}`);
        const errorPath = tempPath + ".err";
        const errorStat = await maybeStat(errorPath);
        if (errorStat) {
          if (errorStat.mtimeMs > loaderStat!.mtimeMs && errorStat.mtimeMs > -1000 + Date.now()) {
            throw new Error("loader skipped due to recent error");
          } else {
            await unlink(errorPath).catch(() => {});  // 清理过期的错误记录
          }
        }
        
        // 准备输出目录和临时文件
        await prepareOutput(tempPath);
        await prepareOutput(cachePath);
        const tempFd = await open(tempPath, "w");
        
        try {
          // 执行具体的加载器逻辑
          await this.exec(tempFd.createWriteStream({highWaterMark: 1024 * 1024}), {useStale}, effects);
          // 成功后将临时文件移动到最终位置
          await rename(tempPath, cachePath);
        } catch (error) {
          // 失败时记录错误，避免频繁重试
          await rename(tempPath, errorPath);
          throw error;
        } finally {
          await tempFd.close();
        }
        
        return outputPath;
      })();
      
      // 任务完成后清理运行中的命令记录
      command.finally(() => runningCommands.delete(key)).catch(() => {});
      runningCommands.set(key, command);
    }
    
    // 输出加载进度信息
    effects.output.write(`${cyan("load")} ${this.targetPath} ${faint("→")} `);
    const start = performance.now();
    
    // 处理加载结果的日志输出
    command.then(
      (path) => {
        const {size} = statSync(join(this.root, path));
        effects.logger.log(
          `${green("success")} ${size ? cyan(formatByteSize(size)) : yellow("empty output")} ${faint(
            `in ${formatElapsed(start)}`
          )}`
        );
      },
      (error) => {
        effects.logger.log(`${red("error")} ${faint(`in ${formatElapsed(start)}:`)} ${red(error.message)}`);
      }
    );
    
    return command;
  }

  /**
   * 抽象方法：执行具体的加载器逻辑
   * 子类必须实现这个方法来定义如何生成数据
   * @param output 输出流，用于写入生成的数据
   * @param options 加载选项
   * @param effects 加载效果
   */
  abstract exec(output: WriteStream, options?: LoadOptions, effects?: LoadEffects): Promise<void>;
}

/**
 * 命令加载器
 * 用于执行脚本文件来生成数据，如：
 * - data.csv.js：用Node.js执行JavaScript脚本生成CSV
 * - api.json.py：用Python脚本调用API生成JSON
 * - stats.txt.sh：用Shell脚本生成文本文件
 */
class CommandLoader extends AbstractLoader {
  /** 要执行的命令，如 "node", "python3", "sh" */
  private readonly command: string;
  /** 传递给命令的参数，通常包含脚本文件路径 */
  private readonly args: string[];

  constructor({command, args, ...options}: CommandLoaderOptions) {
    super(options);
    this.command = command;
    this.args = args;
  }

  /**
   * 执行命令并将输出写入指定的流
   * 使用子进程执行命令，将标准输出直接管道到输出流
   */
  async exec(output: WriteStream): Promise<void> {
    const subprocess = spawn(this.command, this.args, {
      windowsHide: true,
      stdio: ["ignore", output, "inherit"]  // 忽略标准输入，输出到output，错误到父进程
    });
    
    const code = await new Promise((resolve, reject) => {
      subprocess.on("error", reject);
      subprocess.on("close", resolve);
    });
    
    if (code !== 0) {
      throw new Error(`loader exited with code ${code}`);
    }
  }
}

/**
 * ZIP文件提取器
 * 用于从ZIP存档中提取特定文件
 * 支持从静态ZIP文件或命令生成的ZIP文件中提取内容
 */
class ZipExtractor extends AbstractLoader {
  private readonly preload: Loader["load"];  // 预加载函数，用于获取ZIP文件路径
  private readonly inflatePath: string;       // ZIP内的目标文件路径

  constructor({preload, inflatePath, ...options}: ExtractorOptions) {
    super(options);
    this.preload = preload;
    this.inflatePath = inflatePath;
  }

  /**
   * 从ZIP文件中提取指定文件并写入输出流
   */
  async exec(output: WriteStream, options?: LoadOptions, effects?: LoadEffects): Promise<void> {
    // 首先获取ZIP文件的路径（可能需要先生成）
    const archivePath = join(this.root, await this.preload(options, effects));
    // 加载ZIP文件
    const file = (await JSZip.loadAsync(await readFile(archivePath))).file(this.inflatePath);
    if (!file) throw enoent(this.inflatePath);
    // 将文件内容流式传输到输出
    const pipe = file.nodeStream().pipe(output);
    await new Promise((resolve, reject) => pipe.on("error", reject).on("finish", resolve));
  }
}

/**
 * TAR文件提取器
 * 用于从TAR存档（包括TAR.GZ）中提取特定文件
 */
class TarExtractor extends AbstractLoader {
  private readonly preload: Loader["load"];  // 预加载函数
  private readonly inflatePath: string;       // TAR内的目标文件路径
  private readonly gunzip: boolean;           // 是否需要GZIP解压

  constructor({preload, inflatePath, gunzip = false, ...options}: TarExtractorOptions) {
    super(options);
    this.preload = preload;
    this.inflatePath = inflatePath;
    this.gunzip = gunzip;
  }

  /**
   * 从TAR文件中提取指定文件并写入输出流
   */
  async exec(output: WriteStream, options?: LoadOptions, effects?: LoadEffects): Promise<void> {
    const archivePath = join(this.root, await this.preload(options, effects));
    const tar = extract();
    const input = createReadStream(archivePath);
    
    // 如果需要GZIP解压，先通过gunzip管道
    (this.gunzip ? input.pipe(createGunzip()) : input).pipe(tar);
    
    // 遍历TAR文件中的所有条目
    for await (const entry of tar) {
      if (entry.header.name === this.inflatePath) {
        // 找到目标文件，流式传输到输出
        const pipe = entry.pipe(output);
        await new Promise((resolve, reject) => pipe.on("error", reject).on("finish", resolve));
        return;
      } else {
        entry.resume();  // 跳过其他文件
      }
    }
    
    throw enoent(this.inflatePath);
  }
}

/**
 * TAR.GZ文件提取器
 * 继承自TarExtractor，自动启用GZIP解压
 */
class TarGzExtractor extends TarExtractor {
  constructor(options: TarExtractorOptions) {
    super({...options, gunzip: true});
  }
}

/**
 * 存档文件提取器注册表
 * 根据文件扩展名选择对应的提取器类
 */
const extractors = new Map<string, new (options: ExtractorOptions) => Loader>([
  [".zip", ZipExtractor],
  [".tar", TarExtractor], 
  [".tar.gz", TarGzExtractor],
  [".tgz", TarGzExtractor]
]);

function formatElapsed(start: number): string {
  const elapsed = performance.now() - start;
  return `${Math.floor(elapsed)}ms`;
}

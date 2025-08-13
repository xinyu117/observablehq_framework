/**
 * 文件系统操作工具模块
 * 
 * 这个模块提供了 Observable Framework 中用于文件系统操作的核心工具函数。
 * 主要功能包括：
 * 1. **路径转换**: 处理不同操作系统之间的路径分隔符差异
 * 2. **文件遍历**: 递归遍历目录中的所有文件，支持过滤和循环检测
 * 3. **路径解析**: 获取框架内置模块的相对路径
 * 4. **安全操作**: 提供安全的文件状态检查和目录创建功能
 * 
 * 关键特性：
 * - 跨平台兼容（Windows/Unix 路径处理）
 * - 循环符号链接检测
 * - 错误处理和容错机制
 * - 性能优化的文件遍历
 * 
 * 使用场景：
 * - 构建过程中的文件发现和处理
 * - 开发服务器的文件监控
 * - 静态资源的路径解析
 * - 页面和数据文件的扫描
 */

import type {Stats} from "node:fs";
import {existsSync, readdirSync, statSync} from "node:fs";
import {mkdir, stat} from "node:fs/promises";
import op from "node:path";
import {join, normalize, relative, sep} from "node:path/posix";
import {cwd} from "node:process";
import {fileURLToPath} from "node:url";
import {isEnoent} from "./error.js";

/**
 * 将 POSIX 路径转换为操作系统特定路径
 * 
 * 在 Unix/Linux/macOS 系统上：直接返回原路径（因为都使用 / 作为分隔符）
 * 在 Windows 系统上：将 / 替换为 \ 
 * 
 * @param path POSIX 格式的路径
 * @returns 操作系统特定格式的路径
 * 
 * @example
 * ```typescript
 * // 在 Unix 系统上
 * toOsPath("src/pages/index.md") → "src/pages/index.md"
 * 
 * // 在 Windows 系统上  
 * toOsPath("src/pages/index.md") → "src\\pages\\index.md"
 * toOsPath("dist/assets/style.css") → "dist\\assets\\style.css"
 * ```
 */
export const toOsPath = sep === op.sep ? (path: string) => path : (path: string) => path.split(sep).join(op.sep);

/**
 * 将操作系统特定路径转换为 POSIX 路径
 * 
 * 在 Unix/Linux/macOS 系统上：直接返回原路径
 * 在 Windows 系统上：将 \ 替换为 /
 * 
 * @param path 操作系统特定格式的路径
 * @returns POSIX 格式的路径
 * 
 * @example
 * ```typescript
 * // 在 Unix 系统上
 * fromOsPath("src/pages/index.md") → "src/pages/index.md"
 * 
 * // 在 Windows 系统上
 * fromOsPath("src\\pages\\index.md") → "src/pages/index.md"
 * fromOsPath("C:\\Users\\user\\project\\dist") → "C:/Users/user/project/dist"
 * ```
 */
export const fromOsPath = sep === op.sep ? (path: string) => path : (path: string) => path.split(op.sep).join(sep);

/**
 * 获取框架客户端文件的相对路径
 * 
 * 用于获取 Observable Framework 内置客户端模块（JavaScript/TypeScript）的相对路径。
 * 这些路径通常用于 Rollup 打包内置模块。
 * 
 * 特殊处理：
 * - 在开发环境中，如果 .js 文件不存在但 .ts 文件存在，则返回 .ts 路径
 * - 在生产环境中，TypeScript 已转换为 JavaScript
 * 
 * @param entry 客户端文件名（如 "search.js", "main.js"）
 * @returns 从当前工作目录到客户端文件的相对路径
 * 
 * @example
 * ```typescript
 * // 假设当前工作目录是 /home/user/my-project
 * // Observable Framework 安装在 /home/user/my-project/node_modules/@observablehq/framework
 * 
 * getClientPath("search.js")
 * // 开发环境（存在 search.ts）→ "node_modules/@observablehq/framework/src/client/search.ts"
 * // 生产环境 → "node_modules/@observablehq/framework/src/client/search.js"
 * 
 * getClientPath("main.js") → "node_modules/@observablehq/framework/src/client/main.js"
 * getClientPath("inspect.js") → "node_modules/@observablehq/framework/src/client/inspect.js"
 * ```
 */
export function getClientPath(entry: string): string {
  const path = fromOsPath(op.relative(cwd(), op.join(fileURLToPath(import.meta.url), "..", "client", entry)));
  if (path.endsWith(".js") && !existsSync(path)) {
    const tspath = path.slice(0, -".js".length) + ".ts";
    if (existsSync(tspath)) return tspath;
  }
  return path;
}

/**
 * 获取框架样式文件的相对路径
 * 
 * 用于获取 Observable Framework 内置样式文件的相对路径。
 * 这些路径通常用于 Rollup 打包样式模块。
 * 
 * @param entry 样式文件名（如 "default.css", "theme.css"）
 * @returns 从当前工作目录到样式文件的相对路径
 * 
 * @example
 * ```typescript
 * // 假设当前工作目录是 /home/user/my-project
 * 
 * getStylePath("default.css") → "node_modules/@observablehq/framework/src/style/default.css"
 * getStylePath("theme.css") → "node_modules/@observablehq/framework/src/style/theme.css"
 * getStylePath("card.css") → "node_modules/@observablehq/framework/src/style/card.css"
 * ```
 */
export function getStylePath(entry: string): string {
  return fromOsPath(op.relative(cwd(), op.join(fileURLToPath(import.meta.url), "..", "style", entry)));
}

/**
 * 递归遍历目录中的所有文件
 * 
 * 这是一个生成器函数，递归遍历指定根目录下的所有文件，支持以下特性：
 * 1. **自动跳过**: 忽略 .observablehq 目录（框架内部目录）
 * 2. **循环检测**: 检测并跳过循环符号链接，避免无限递归
 * 3. **可选过滤**: 支持自定义测试函数过滤文件和目录
 * 4. **错误容错**: 忽略不存在的文件/目录错误，继续遍历其他文件
 * 
 * @param root 要遍历的根目录路径
 * @param test 可选的测试函数，用于过滤文件和目录名
 * @yields 相对于根目录的文件路径
 * 
 * @example
 * ```typescript
 * // 基本用法：遍历所有文件
 * for (const file of visitFiles("src")) {
 *   console.log(file);
 * }
 * // 输出示例：
 * // "index.md"
 * // "pages/about.md" 
 * // "data/sales.csv"
 * // "components/Chart.js"
 * 
 * // 带过滤器：只遍历 .md 文件
 * for (const file of visitFiles("src", (name) => name.endsWith(".md"))) {
 *   console.log(file);
 * }
 * // 输出示例：
 * // "index.md"
 * // "pages/about.md"
 * // "blog/post1.md"
 * 
 * // 跳过参数化路径
 * import {isParameterized} from "./route.js";
 * for (const file of visitFiles("src", (name) => !isParameterized(name))) {
 *   console.log(file);
 * }
 * // 会跳过像 "[id].md" 这样的参数化文件
 * 
 * // 实际项目结构示例
 * // src/
 * // ├── index.md              → "index.md"
 * // ├── about.md              → "about.md"  
 * // ├── pages/
 * // │   ├── contact.md        → "pages/contact.md"
 * // │   └── team.md           → "pages/team.md"
 * // ├── data/
 * // │   ├── sales.csv         → "data/sales.csv"
 * // │   └── users.json        → "data/users.json"
 * // ├── .observablehq/        → 被跳过
 * // └── components/
 * //     └── Chart.js          → "components/Chart.js"
 * ```
 */
export function* visitFiles(root: string, test?: (name: string) => boolean): Generator<string> {
  const visited = new Set<number>();  // 用于检测循环符号链接的 inode 集合
  const queue: string[] = [(root = normalize(root))];  // 待处理的路径队列
  
  for (const path of queue) {
    try {
      const status = statSync(path);
      if (status.isDirectory()) {
        // 检测循环符号链接：如果这个 inode 已经访问过，跳过
        if (visited.has(status.ino)) continue;
        visited.add(status.ino);
        
        // 遍历目录中的所有条目
        for (const entry of readdirSync(path)) {
          if (entry === ".observablehq") continue; // 忽略框架内部目录
          if (test !== undefined && !test(entry)) continue; // 应用用户过滤器
          queue.push(join(path, entry)); // 添加到处理队列
        }
      } else {
        // 这是一个文件，生成相对路径
        yield relative(root, path);
      }
    } catch (error) {
      // 忽略文件不存在的错误（ENOENT），但重新抛出其他错误
      if (!isEnoent(error)) throw error;
    }
  }
}

/**
 * 安全的文件状态检查函数
 * 
 * 类似于 fs.stat，但在文件不存在时返回 undefined 而不是抛出 ENOENT 错误。
 * 这在需要检查文件是否存在及其属性时非常有用。
 * 
 * @param path 要检查的文件或目录路径
 * @returns 文件状态对象，如果文件不存在则返回 undefined
 * 
 * @example
 * ```typescript
 * // 检查文件是否存在及其属性
 * const stats = await maybeStat("src/index.md");
 * if (stats) {
 *   console.log(`文件大小: ${stats.size} 字节`);
 *   console.log(`修改时间: ${stats.mtime}`);
 *   console.log(`是否为目录: ${stats.isDirectory()}`);
 * } else {
 *   console.log("文件不存在");
 * }
 * 
 * // 实际使用示例
 * const configStats = await maybeStat("observablehq.config.js");
 * if (configStats) {
 *   console.log("找到配置文件");
 *   // 输出: Stats {size: 1024, mtime: 2023-12-21T10:30:00.000Z, ...}
 * } else {
 *   console.log("配置文件不存在，使用默认配置");
 *   // 输出: undefined
 * }
 * 
 * // 对比传统的 fs.stat（会抛出错误）
 * try {
 *   const stats = await stat("nonexistent.txt");
 * } catch (error) {
 *   // 需要捕获 ENOENT 错误
 * }
 * 
 * // 使用 maybeStat（更简洁）
 * const stats = await maybeStat("nonexistent.txt"); // 直接返回 undefined
 * ```
 */
export async function maybeStat(path: string): Promise<Stats | undefined> {
  try {
    return await stat(path);
  } catch (error) {
    if (!isEnoent(error)) throw error;
  }
}

/**
 * 为输出文件准备父目录
 * 
 * 类似于递归的 mkdir，但专门为指定输出文件的父目录而设计。
 * 如果父目录已存在，则不执行任何操作；如果不存在，则递归创建所有必要的父目录。
 * 
 * @param outputPath 输出文件的完整路径
 * @returns Promise<void>
 * 
 * @example
 * ```typescript
 * // 准备输出文件的目录结构
 * await prepareOutput("dist/assets/js/main.js");
 * // 会创建: dist/ → dist/assets/ → dist/assets/js/
 * // 但不会创建 main.js 文件本身
 * 
 * await prepareOutput("build/pages/blog/post1.html");
 * // 会创建: build/ → build/pages/ → build/pages/blog/
 * 
 * // 如果输出文件在当前目录，不执行任何操作
 * await prepareOutput("index.html");
 * // 父目录是 "."，直接返回
 * 
 * // 实际构建流程中的使用
 * const outputFile = "dist/pages/about.html";
 * await prepareOutput(outputFile);  // 确保 dist/pages/ 目录存在
 * await writeFile(outputFile, htmlContent);  // 写入文件
 * 
 * // 批量文件输出示例
 * const files = [
 *   "dist/index.html",
 *   "dist/pages/about.html", 
 *   "dist/assets/style.css",
 *   "dist/data/sales.json"
 * ];
 * 
 * for (const file of files) {
 *   await prepareOutput(file);  // 为每个文件准备目录
 *   // ... 写入文件内容
 * }
 * ```
 */
export async function prepareOutput(outputPath: string): Promise<void> {
  const outputDir = op.dirname(outputPath);
  if (outputDir === ".") return;  // 如果父目录是当前目录，无需创建
  await mkdir(outputDir, {recursive: true});  // 递归创建所有必要的父目录
}
